// レート制限（express-rate-limit）の設定
//
//   全体      : 1分あたり 300 リクエスト（API のみ。静的ファイルは対象外）
//   書き込み  : 1分あたり 60 リクエスト（POST / PUT / DELETE）
//   超過時    : 共通のエラー形式で 429 を返す
//
// 上限値は環境変数 RATE_LIMIT_GLOBAL_MAX / RATE_LIMIT_WRITE_MAX で変更できる。
//
// テスト時の扱い:
//   jest のテストは同じプロセスから短時間に大量のリクエストを送るため、既定の上限では 429 になってしまう。
//   そこで「NODE_ENV=test かつ jest のワーカー上（JEST_WORKER_ID あり）」の両方を満たすときだけ、
//   既定の上限を十分大きな値にする。
//   本番で NODE_ENV を誤って test にしても、jest 以外のプロセスには JEST_WORKER_ID が無いため緩和されない。
//   また、環境変数で上限値を明示した場合はテスト時でもその値を使う（429 のテストで利用する）。

const { rateLimit } = require('express-rate-limit');
const { ApiError } = require('./errors');

const WINDOW_MS = 60 * 1000;
const DEFAULT_GLOBAL_MAX = 300;
const DEFAULT_WRITE_MAX = 60;
// テスト時に使う上限値（テスト全体のリクエスト数より十分大きい値）
const TEST_RUNTIME_MAX = 1000000;
// 環境変数で指定できる上限値
const ENV_MAX_LIMIT = 1000000;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const RATE_LIMIT_MESSAGE = 'リクエストが多すぎます。しばらく待ってから再度実行してください';

// jest のテスト実行中かどうか（両方の条件を満たす場合のみ true）
function isTestRuntime(env) {
  return env.NODE_ENV === 'test' && typeof env.JEST_WORKER_ID === 'string' && env.JEST_WORKER_ID !== '';
}

// 上限値の環境変数を読み取る（未設定なら null、不正なら起動時に例外）
function readMaxEnv(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  const n = /^[0-9]{1,7}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > ENV_MAX_LIMIT) {
    throw new Error(`環境変数 ${name} は 1〜${ENV_MAX_LIMIT} の整数で指定してください`);
  }
  return n;
}

/**
 * 環境変数からレート制限の上限値を決める
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ windowMs: number, globalMax: number, writeMax: number }}
 */
function resolveRateLimitConfig(env) {
  const relaxed = isTestRuntime(env);
  const globalEnv = readMaxEnv(env, 'RATE_LIMIT_GLOBAL_MAX');
  const writeEnv = readMaxEnv(env, 'RATE_LIMIT_WRITE_MAX');
  return {
    windowMs: WINDOW_MS,
    globalMax: globalEnv !== null ? globalEnv : (relaxed ? TEST_RUNTIME_MAX : DEFAULT_GLOBAL_MAX),
    writeMax: writeEnv !== null ? writeEnv : (relaxed ? TEST_RUNTIME_MAX : DEFAULT_WRITE_MAX),
  };
}

// 上限超過時は共通エラーハンドラに 429 を渡す（レスポンス形式を他のエラーと揃える）
function onLimitReached(req, res, next) {
  next(new ApiError(429, RATE_LIMIT_MESSAGE));
}

/**
 * レート制限のミドルウェアを生成する
 * ※ カウンタはプロセス内のメモリに保持する（複数台構成では台ごとのカウントになる）
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ globalLimiter: Function, writeLimiter: Function, config: object }}
 */
function createRateLimiters(env) {
  const config = resolveRateLimitConfig(env);
  const common = {
    windowMs: config.windowMs,
    standardHeaders: 'draft-7', // RateLimit / RateLimit-Policy ヘッダを返す
    legacyHeaders: false,       // X-RateLimit-* ヘッダは返さない
    handler: onLimitReached,
  };
  const globalLimiter = rateLimit({ ...common, limit: config.globalMax });
  const writeLimiter = rateLimit({
    ...common,
    limit: config.writeMax,
    // 読み取り系のメソッドは書き込み用の制限の対象外（カウントもしない）
    skip: (req) => !WRITE_METHODS.has(req.method),
  });
  return { globalLimiter, writeLimiter, config };
}

module.exports = {
  WINDOW_MS,
  DEFAULT_GLOBAL_MAX,
  DEFAULT_WRITE_MAX,
  TEST_RUNTIME_MAX,
  RATE_LIMIT_MESSAGE,
  isTestRuntime,
  resolveRateLimitConfig,
  createRateLimiters,
};
