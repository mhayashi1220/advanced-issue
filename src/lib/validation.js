// 入力バリデーション
// 各関数はエラー配列 [{ field, message }] を返す（空配列なら妥当）

const { ApiError } = require('./errors');

// PostgreSQL の INTEGER 型の上限値
const INT_MAX = 2147483647;

// 在庫アラートの基準値（在庫がこの値未満でアラート発生）
const ALERT_STOCK_LIMIT = 10;

// 商品ID: 英数字・ハイフン・アンダースコアのみ、1〜10文字
const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,10}$/;

// 履歴ID: 'R' + 9桁の数字（例: R000000001）
const RIREKI_ID_PATTERN = /^R[0-9]{9}$/;

// 商品IDとして使えない予約語（大文字小文字を区別しない）
// GET /products/alerts（在庫アラート一覧）と商品詳細 GET /products/:id が衝突するため
const RESERVED_PRODUCT_IDS = ['alerts'];

// 商品名に含めてはいけない文字
//   \p{Cc}: 制御文字（改行・タブ・NUL など）
//   \p{Cf}: 書式文字（Bidi 制御 U+202E・ゼロ幅スペース U+200B・BOM U+FEFF など）
// 画面上で見た目と実際の文字列が食い違う（なりすまし・表示崩れ）ことを防ぐ
const PRODUCT_NAME_FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}]/u;

// 一覧 API のページング
//   limit: 1〜500 の整数（既定 100）。文字列として /^[0-9]{1,3}$/ に一致するものだけ受け付ける
const PAGE_LIMIT_DEFAULT = 100;
const PAGE_LIMIT_MAX = 500;
const PAGE_LIMIT_PATTERN = /^[0-9]{1,3}$/;

// 在庫数から在庫アラートフラグ（threshold）を算出する
//   '0' = 在庫10以上（アラートなし） / '1' = 在庫10未満（アラート発生）
// threshold は必ずこの関数でサーバー側算出し、クライアント指定値は使わない
function calcThreshold(stock) {
  return stock < ALERT_STOCK_LIMIT ? '1' : '0';
}

// リクエスト body が JSON オブジェクト（配列・null 以外）であることを確認する
function assertJsonObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'リクエストボディは JSON オブジェクトで指定してください', [
      { field: 'body', message: 'JSON オブジェクトである必要があります' },
    ]);
  }
}

// バリデーションエラーがあれば 400 を送出する
function throwIfErrors(errors) {
  if (errors.length > 0) {
    throw new ApiError(400, '入力内容に誤りがあります', errors);
  }
}

// 商品名: 文字列、前後の空白を除いて 1〜100 文字
// VARCHAR(100) は文字（コードポイント）数で数えるため、サロゲートペアも1文字として数える
function validateProductName(value, errors) {
  if (typeof value !== 'string') {
    errors.push({ field: 'product_name', message: '文字列で指定してください' });
    return;
  }
  // 前後の空白除去より先に判定する（先頭・末尾の改行や BOM も拒否するため）
  if (PRODUCT_NAME_FORBIDDEN_CHARS.test(value)) {
    errors.push({ field: 'product_name', message: '制御文字（改行・タブ等）や書式文字（ゼロ幅文字・文字方向の制御文字等）は使用できません' });
    return;
  }
  const len = [...value.trim()].length;
  if (len < 1 || len > 100) {
    errors.push({ field: 'product_name', message: '前後の空白を除いて1〜100文字で指定してください' });
  }
}

// 0 以上の整数（INTEGER の範囲内）。"10" や 1.5 は拒否する
function validateNonNegativeInt(field, value, errors) {
  if (!Number.isInteger(value) || value < 0 || value > INT_MAX) {
    errors.push({ field, message: `0以上${INT_MAX}以下の整数で指定してください` });
  }
}

// 1 以上の整数（INTEGER の範囲内）
function validatePositiveInt(field, value, errors) {
  if (!Number.isInteger(value) || value < 1 || value > INT_MAX) {
    errors.push({ field, message: `1以上${INT_MAX}以下の整数で指定してください` });
  }
}

// 商品IDの形式チェック（body・クエリ用）
function validateProductIdFormat(field, value, errors) {
  if (typeof value !== 'string' || !PRODUCT_ID_PATTERN.test(value)) {
    errors.push({ field, message: '英数字・ハイフン・アンダースコアのみ、1〜10文字で指定してください' });
  }
}

// 商品IDが予約語（alerts など）かどうか（大文字小文字を区別しない）
function isReservedProductId(value) {
  return typeof value === 'string' && RESERVED_PRODUCT_IDS.includes(value.toLowerCase());
}

// 新規登録する商品IDのチェック（形式 + 予約語）。POST /products で使う
function validateNewProductId(field, value, errors) {
  const before = errors.length;
  validateProductIdFormat(field, value, errors);
  if (errors.length === before && isReservedProductId(value)) {
    errors.push({ field, message: `「${value}」は予約語のため商品IDに使用できません` });
  }
}

// パスパラメータ :id の形式チェック（不正なら 400）
function assertPathId(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ApiError(400, `${label}の形式が不正です`, [
      { field: 'id', message: `${label}の形式が不正です` },
    ]);
  }
}

// パスパラメータの商品ID（/products/:id）のチェック（形式 + 予約語。不正なら 400）
function assertProductPathId(value) {
  assertPathId(value, PRODUCT_ID_PATTERN, '商品ID');
  if (isReservedProductId(value)) {
    throw new ApiError(400, '商品IDの形式が不正です', [
      { field: 'id', message: `「${value}」は予約語のため商品IDとして使用できません` },
    ]);
  }
}

/**
 * 一覧 API のページング用クエリ（limit / after）を検証して返す
 * 配列（?limit=1&limit=2）やオブジェクト（?after[a]=x）で渡された場合も 400 とする
 * @param {object} query        req.query
 * @param {RegExp} afterPattern after（直前のページ末尾のキー）の形式
 * @returns {{ limit: number, after: string|null }}
 * @throws {ApiError} 400
 */
function parsePagination(query, afterPattern) {
  const errors = [];
  let limit = PAGE_LIMIT_DEFAULT;
  let after = null;

  if (query.limit !== undefined) {
    const raw = query.limit;
    const n = typeof raw === 'string' && PAGE_LIMIT_PATTERN.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > PAGE_LIMIT_MAX) {
      errors.push({ field: 'limit', message: `1〜${PAGE_LIMIT_MAX}の整数で指定してください` });
    } else {
      limit = n;
    }
  }

  if (query.after !== undefined) {
    if (typeof query.after !== 'string' || !afterPattern.test(query.after)) {
      errors.push({ field: 'after', message: '直前のページの meta.next_after の値を指定してください' });
    } else {
      after = query.after;
    }
  }

  throwIfErrors(errors);
  return { limit, after };
}

/**
 * limit + 1 件取得した結果から、返すデータと次ページのキーを求める
 * @param {Array<object>} rows  limit + 1 件を上限に取得した行
 * @param {number} limit
 * @param {string} keyColumn    キーセットに使う列名
 * @returns {{ data: Array<object>, meta: { limit: number, next_after: string|null } }}
 */
function buildPage(rows, limit, keyColumn) {
  const hasNext = rows.length > limit;
  const data = hasNext ? rows.slice(0, limit) : rows;
  return {
    data,
    meta: { limit, next_after: hasNext ? data[data.length - 1][keyColumn] : null },
  };
}

module.exports = {
  INT_MAX,
  ALERT_STOCK_LIMIT,
  PRODUCT_ID_PATTERN,
  RIREKI_ID_PATTERN,
  RESERVED_PRODUCT_IDS,
  PRODUCT_NAME_FORBIDDEN_CHARS,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  calcThreshold,
  assertJsonObject,
  throwIfErrors,
  validateProductName,
  validateNonNegativeInt,
  validatePositiveInt,
  validateProductIdFormat,
  assertPathId,
  isReservedProductId,
  validateNewProductId,
  assertProductPathId,
  parsePagination,
  buildPage,
};
