// 必要なツールを読み込む
const admin = require('firebase-admin');

// サービスアカウントキー（秘密鍵）を使って初期化する
// (GitHub Actions実行時は 'serviceAccountKey.json' が作成される前提)
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- 'name_norm_ngrams' フィールドを削除するメイン関数 ---

async function deleteNgramsField() {
  console.log('`name_norm_ngrams` フィールドの削除処理を開始します...');

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
    // フィールドを削除するための特別なオブジェクト
    const updateData = {
      // FieldValue.delete() を使うと、そのフィールドがドキュメントから削除されます。
      name_norm_ngrams: admin.firestore.FieldValue.delete()
    };

    // バッチに更新（削除）操作を追加
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

  console.log('`name_norm_ngrams` フィールドの削除処理が完了しました！');
}

// スクリプトを実行
deleteNgramsField().catch(err => {
  console.error('エラーが発生しました:', err);
});
