// 必要なツールを読み込む
const admin = require('firebase-admin');

// サービスアカウントキー（秘密鍵）を使って初期化する
// (GitHub Actions実行時は 'serviceAccountKey.json' が作成される前提)
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- 正規化関数 (ご提示の基準をJavaScriptで再現) ------------------

/**
 * ひらがなをカタカナに変換するヘルパー関数
 * @param {string} str 変換する文字列
 * @returns {string} カタカナに変換された文字列
 */
function hiraToKata(str) {
  // \u3041-\u3096 は「ぁ」から「ゎ」までのひらがな
  return str.replace(/[\u3041-\u3096]/g, function(match) {
    const chr = match.charCodeAt(0) + 0x60; // 0x60 (96) を足すと対応するカタカナになる
    return String.fromCharCode(chr);
  });
}

/**
 * 検索用に文字列を正規化する (CatalogService.normalizeForSearch相当)
 * 1. ひらがな -> カタカナ (要件)
 * 2. アクセント除去 (diacriticInsensitive相当)
 * 3. 全角/半角統一 (widthInsensitive相当) - NFKC使用
 * 4. 小文字化 (caseInsensitive相当)
 * @param {string} inputStr 正規化する元の文字列
 * @returns {string} 正規化された文字列
 */
function normalizeForSearch(inputStr) {
  if (typeof inputStr !== 'string' || !inputStr) {
    return "";
  }

  let str = inputStr;

  // 1. ひらがな -> カタカナ
  str = hiraToKata(str);

  // 2. アクセント除去 (NFDで分解し、アクセント記号を除去)
  // 例: "Pränayāma" -> "Pranayama"
  str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // 3. 全角/半角統一 (NFKCで正規化)
  // Swiftの .widthInsensitive に近い動作。
  // 例: "Ｐｒａｎａｙａｍａ" -> "Pranayama", "ﾌﾟﾗﾅﾔﾏ" -> "プラナヤマ"
  str = str.normalize('NFKC');

  // 4. 小文字化
  // 例: "Pranayama" -> "pranayama", "プラナヤマ" -> "プラナヤマ"
  str = str.toLowerCase();

  return str;
}

// <--- NEW: N-gram (2文字, 3文字) を生成する関数 ---
/**
 * 文字列からN-gramのセットを生成する (2-gram, 3-gram)
 * @param {string} text N-gramを生成する元の文字列
 * @param {number[]} nValues N-gramの文字数 (例: [2, 3])
 * @returns {string[]} N-gramの（重複排除された）配列
 */
function createNgrams(text, nValues = [2, 3]) {
  const ngrams = new Set();
  if (typeof text !== 'string' || !text) {
    return [];
  }
  
  nValues.forEach(n => {
    for (let i = 0; i < text.length - n + 1; i++) {
      ngrams.add(text.substring(i, i + n));
    }
  });
  return Array.from(ngrams);
}
// <--- NEW: N-gram関数ここまで ---


// --- 正規化処理を実行するメイン関数 ---------------------

async function migrateData() {
  console.log('N-gramを含む正規化処理を開始します...');

  const appsRef = db.collection('apps');
  const snapshot = await appsRef.get();

  if (snapshot.empty) {
    console.log('対象ドキュメントが見つかりませんでした。');
    return;
  }

  // バッチ処理の準備 (一度に500件まで)
  const batchArray = [];
  batchArray.push(db.batch());
  let operationCounter = 0;
  let batchIndex = 0;

  console.log(`${snapshot.size} 件のドキュメントを処理します。`);

  snapshot.forEach(doc => {
    const data = doc.data();
    const updateData = {}; // このドキュメントで更新するデータ

    // --- 1. name_norm と name_norm_ngrams の処理 ---
    // ルール: name["en"] ?? name.first?.value ?? ""
    let baseName = "";
    if (data.name && typeof data.name === 'object') {
      if (data.name.en && typeof data.name.en === 'string') {
        baseName = data.name.en; // 英語表記 (en) を最優先
      } else {
        // 英語がなく、nameがマップの場合、最初のエントリにフォールバック
        const firstValue = Object.values(data.name)[0];
        if (firstValue && typeof firstValue === 'string') {
          baseName = firstValue;
        }
      }
    }
    
    // 正規化して 'name_norm' を作成
    updateData.name_norm = normalizeForSearch(baseName);
    
    // <--- NEW: 'name_norm' から 'name_norm_ngrams' を作成 ---
    updateData.name_norm_ngrams = createNgrams(updateData.name_norm);
    // <--- NEW: 変更ここまで ---

    // --- 2. aliases_norm の処理 ---
    // (これは前回から変更なし)
    if (Array.isArray(data.aliases)) {
      // aliases配列の各要素を正規化
      updateData.aliases_norm = data.aliases
        .filter(alias => typeof alias === 'string') // 文字列のみを対象
        .map(alias => normalizeForSearch(alias)); // 各エイリアスを正規化
    } else if (!data.aliases_norm) { // 既に存在しない場合のみ
      // aliasesフィールドが存在しない場合も、空の配列で 'aliases_norm' を作成
      updateData.aliases_norm = [];
    }

    // 更新データがあればバッチに追加
    batchArray[batchIndex].update(doc.ref, updateData);
    operationCounter++;

    // 1バッチが500件に達したら新しいバッチを用意
    if (operationCounter === 500) {
      batchArray.push(db.batch());
      batchIndex++;
      operationCounter = 0;
    }
  });

  // すべてのバッチ処理を実行（コミット）
  console.log(`合計 ${batchArray.length} 個のバッチ処理を実行中...`);
  await Promise.all(batchArray.map(batch => batch.commit()));

  console.log('正規化処理（N-gram含む）が完了しました！');
}

// スクリプトを実行
migrateData().catch(err => {
  console.error('エラーが発生しました:', err);
});
