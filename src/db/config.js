// PostgreSQL 接続プールの設定を組み立てるモジュール
// pool.js から分離しているのは、実 DB に接続せずに設定内容を単体テストできるようにするため。

// 接続プールのタイムアウト設定（ミリ秒）
//   CONNECTION_TIMEOUT_MS : プールから接続を取得するまでの待ち時間の上限（超過で 503）
//   IDLE_TIMEOUT_MS       : 使われていない接続を閉じるまでの時間
//   STATEMENT_TIMEOUT_MS  : 1つの SQL の実行時間の上限（超過で SQLSTATE 57014 → 503）
//   LOCK_TIMEOUT_MS       : 行ロック等の待ち時間の上限（超過で SQLSTATE 55P03 → 409）
//   IDLE_IN_TX_TIMEOUT_MS : トランザクション中に何もしない状態の上限（ロックの握りっぱなしを防ぐ）
const CONNECTION_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 10000;
const STATEMENT_TIMEOUT_MS = 10000;
const LOCK_TIMEOUT_MS = 3000;
const IDLE_IN_TX_TIMEOUT_MS = 15000;

// プールの最大接続数（DB_POOL_MAX 未設定時の既定値と、指定できる上限）
const DEFAULT_POOL_MAX = 10;
const POOL_MAX_LIMIT = 100;

// 本番（NODE_ENV=production）で必須とする環境変数
// ローカル開発用の既定値（localhost / todo_db / todo_user / パスワードなし）で
// 本番が誤って起動しないようにするため
const REQUIRED_IN_PRODUCTION = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];

// 1〜max の整数文字列を数値に変換する（未設定なら既定値、不正なら例外）
function parseIntEnv(env, name, defaultValue, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return defaultValue;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`環境変数 ${name} は ${min}〜${max} の整数で指定してください`);
  }
  const n = Number(raw);
  if (n < min || n > max) {
    throw new Error(`環境変数 ${name} は ${min}〜${max} の整数で指定してください`);
  }
  return n;
}

// DB_SSL の値を真偽値に変換する（'true' / 'false' / 未設定 のみ受け付ける）
function parseSslEnv(env) {
  const raw = env.DB_SSL;
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error('環境変数 DB_SSL は true または false で指定してください');
}

/**
 * 環境変数から pg.Pool の設定を組み立てる
 * @param {NodeJS.ProcessEnv} env 環境変数（通常は process.env）
 * @returns {import('pg').PoolConfig}
 * @throws {Error} 本番で必須の環境変数が不足している場合、値の形式が不正な場合
 */
function buildPoolConfig(env) {
  if (env.NODE_ENV === 'production') {
    // 空文字も未設定とみなす（DB_PASSWORD= のような書き忘れを検出する）
    const missing = REQUIRED_IN_PRODUCTION.filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new Error(`本番環境（NODE_ENV=production）では環境変数 ${missing.join(', ')} の設定が必須です`);
    }
  }

  const config = {
    // ローカル開発用の既定値（本番では上のチェックにより必ず環境変数の値が使われる）
    host: env.DB_HOST || 'localhost',
    port: parseIntEnv(env, 'DB_PORT', 5432, 1, 65535),
    database: env.DB_NAME || 'todo_db',
    user: env.DB_USER || 'todo_user',
    password: env.DB_PASSWORD || '',

    max: parseIntEnv(env, 'DB_POOL_MAX', DEFAULT_POOL_MAX, 1, POOL_MAX_LIMIT),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,

    // 接続ごとにサーバー側のセッション設定として送られる
    statement_timeout: STATEMENT_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS,
  };

  // DB_SSL=true のときは TLS で接続し、サーバー証明書を必ず検証する
  if (parseSslEnv(env)) {
    config.ssl = { rejectUnauthorized: true };
  }

  return config;
}

module.exports = {
  CONNECTION_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  LOCK_TIMEOUT_MS,
  IDLE_IN_TX_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  REQUIRED_IN_PRODUCTION,
  buildPoolConfig,
};
