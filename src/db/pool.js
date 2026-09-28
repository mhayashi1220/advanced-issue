// PostgreSQLへの接続プールを管理するモジュール
// Poolを使うことで毎回接続・切断を繰り返さずにパフォーマンスを向上させる
const { Pool } = require('pg');
require('dotenv').config();
const { buildPoolConfig } = require('./config');

// 環境変数から接続情報・タイムアウト・TLS 設定を組み立てる
// 本番で必須の環境変数が無い、または値が不正な場合はここで例外となり、起動を中止する
const pool = new Pool(buildPoolConfig(process.env));

// アイドル中のクライアントで発生したエラー（DB再起動・ネットワーク切断など）を捕捉する
// このハンドラが無いと未処理の 'error' イベントとなり、プロセスが異常終了する
pool.on('error', (err) => {
  console.error('PostgreSQLアイドル接続エラー:', err.message);
});

// 起動時に接続確認を行う
pool.query('SELECT NOW()', (err) => {
  if (err) {
    console.error('PostgreSQL接続エラー:', err.message);
  } else {
    console.log('PostgreSQL接続成功');
  }
});

module.exports = pool;
