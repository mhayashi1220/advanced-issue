// API 共通のエラー定義とユーティリティ
// エラーレスポンスは { "error": { "message": "...", "details": [...] } } に統一する

// HTTP ステータスと詳細情報を持つアプリケーションエラー
class ApiError extends Error {
  /**
   * @param {number} status  HTTP ステータスコード
   * @param {string} message クライアントに返すメッセージ
   * @param {Array<{field?: string, message: string}>} [details] フィールドごとのエラー
   */
  constructor(status, message, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

// DB が混み合っている・時間切れのときのメッセージ（503 用）
const MSG_DB_BUSY = '現在処理が混み合っています。しばらく待ってから再度実行してください';

// PostgreSQL の SQLSTATE を HTTP ステータスとメッセージに変換する対応表
// ここに無いコードは 500（内部エラー）として扱う
const PG_ERROR_MAP = {
  '23505': { status: 409, message: '一意制約に違反しています（データが重複しています）' },
  '23503': { status: 409, message: '関連するデータが存在するため処理できません' },
  '23514': { status: 400, message: '値が制約を満たしていません' },
  '23502': { status: 400, message: '必須項目が不足しています' },
  '22001': { status: 400, message: '文字列が長すぎます' },
  '22003': { status: 400, message: '数値が範囲外です' },
  '22P02': { status: 400, message: '値の形式が不正です' },
  '40001': { status: 409, message: '同時更新が競合しました。再度実行してください' },
  '40P01': { status: 409, message: '同時更新が競合しました。再度実行してください' },
  // lock_timeout によるロック待ちの打ち切り
  '55P03': { status: 409, message: '他の処理と競合しました。再度実行してください' },
  // statement_timeout による SQL の打ち切り（query_canceled）
  '57014': { status: 503, message: MSG_DB_BUSY },
  // シーケンスの上限到達（履歴IDの採番枯渇）。運用対応が必要なため 503 とする
  '2200H': { status: 503, message: '現在この処理を受け付けられません。管理者に連絡してください' },
};

// pg-pool / pg が接続取得のタイムアウト時に投げるエラーのメッセージ
// （SQLSTATE を持たないため、メッセージで判定する）
const CONNECT_TIMEOUT_MESSAGES = [
  'timeout exceeded when trying to connect',          // pg-pool: プールの空き待ちで connectionTimeoutMillis 超過
  'Connection terminated due to connection timeout',  // pg: 新規接続の確立で connectionTimeoutMillis 超過
];

// 接続取得のタイムアウトかどうか
function isConnectTimeout(err) {
  return typeof err.message === 'string' && CONNECT_TIMEOUT_MESSAGES.includes(err.message);
}

// pg のエラーを ApiError に変換する（対応表に無ければ null）
function fromPgError(err) {
  if (!err) return null;
  if (typeof err.code !== 'string') {
    return isConnectTimeout(err) ? new ApiError(503, MSG_DB_BUSY) : null;
  }
  const mapped = PG_ERROR_MAP[err.code];
  if (!mapped) return null;
  // 制約名はスキーマの内部情報のため、クライアントには返さない
  return new ApiError(mapped.status, mapped.message);
}

// async ルートハンドラの例外を next() に渡すラッパー
// Express 4 は Promise の reject を自動で捕捉しないため必須
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { ApiError, fromPgError, asyncHandler, MSG_DB_BUSY };
