// 商品マスタ（M_PRODUCTS）の CRUD API
//
// レスポンス仕様（共通）
//   成功時: { "data": <商品 or 商品配列> }
//   一覧（GET /products, GET /products/alerts）は { "data": [...], "meta": { limit, next_after } }
//     ページングはキーセット方式。?limit=1〜500（既定 100）、?after=<直前ページの meta.next_after>
//     next_after が null なら次のページは無い
//   商品オブジェクト: { product_id, product_name, stock, threshold }
//     threshold（在庫アラートフラグ）: '0' = 在庫10以上 / '1' = 在庫10未満（アラート発生）
//   ※ threshold は常にサーバー側で stock から算出して保存する。
//      POST / PUT の body に threshold が含まれていても無視する（エラーにもしない）。
//
// レスポンス仕様（CSV 出力: GET /products/export.csv）
//   200 / Content-Type: text/csv; charset=utf-8
//   Content-Disposition: attachment; filename="products_YYYYMMDD.csv"（日付は日本時間）
//   本文: UTF-8 BOM 付き、改行 CRLF（RFC 4180）。商品ID昇順で全件（ページングなし・クエリパラメータは無視）
//   ヘッダー行: 商品ID,商品名,在庫数,在庫アラート
//     在庫アラート列: threshold '1' → 「在庫少」 / '0' → 空文字
//   ダブルクォート・カンマ・改行を含む値は "..." で囲む。= + - @ タブ CR で始まる文字列には先頭に ' を付ける
//   エラー: 出力開始前（最初のDB取得失敗など）は通常の JSON エラー応答
//           出力開始後の失敗は接続を切断する（途中までの CSV を正常終了に見せない）

const express = require('express');
const pool = require('../db/pool');
const { ApiError, asyncHandler } = require('../lib/errors');
const {
  PRODUCT_ID_PATTERN,
  calcThreshold,
  assertJsonObject,
  throwIfErrors,
  validateProductName,
  validateNonNegativeInt,
  validateNewProductId,
  assertProductPathId,
  parsePagination,
  buildPage,
} = require('../lib/validation');
const { UTF8_BOM, toCsvRow, formatDateYmd } = require('../lib/csv');

// caseSensitive: true により、'/alerts' は小文字の完全一致だけがアラート一覧になる
// （/products/ALERTS などは '/:id' に進み、予約語として 400 になる）
const router = express.Router({ caseSensitive: true });

// SELECT で返すカラム（全ルートで共通化）
const PRODUCT_COLUMNS = 'product_id, product_name, stock, threshold';

// 商品一覧を1ページ分取得する（商品ID昇順のキーセットページング）
//   conditions: 追加の WHERE 条件（値はプレースホルダで渡す）
async function fetchProductPage(req, conditions, values) {
  const { limit, after } = parsePagination(req.query, PRODUCT_ID_PATTERN);
  const where = [...conditions];
  const params = [...values];
  if (after !== null) {
    params.push(after);
    where.push(`product_id > $${params.length}`);
  }
  // 次のページの有無を判定するため limit + 1 件取得する
  params.push(limit + 1);
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS} FROM m_products${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY product_id LIMIT $${params.length}`,
    params
  );
  return buildPage(rows, limit, 'product_id');
}

// GET /products : 商品一覧を取得する（商品ID昇順）
router.get('/', asyncHandler(async (req, res) => {
  res.json(await fetchProductPage(req, [], []));
}));

// GET /products/alerts : 在庫アラート対象（threshold = '1'）の商品一覧を取得する（商品ID昇順）
// ※ '/:id' より前に定義しないと "alerts" が商品IDとして解釈されるため、定義順に注意
// ※ キーセットページングのため、並び順は在庫数順ではなく商品ID順とする
router.get('/alerts', asyncHandler(async (req, res) => {
  res.json(await fetchProductPage(req, ['threshold = $1'], ['1']));
}));

// ---- CSV 出力 ----

// CSV のヘッダー行（出力カラムはこの4項目のみ。機密情報を出さないようホワイトリストで固定）
const CSV_HEADER = ['商品ID', '商品名', '在庫数', '在庫アラート'];

// 在庫アラート列の表示値（threshold '1' = 在庫少 / '0' = 空文字）
const CSV_ALERT_LABEL = { '1': '在庫少', '0': '' };

// CSV 出力時に1回の SELECT で取得する件数（メモリ使用量を一定に抑えるため）
const CSV_BATCH_SIZE = 1000;

// CSV 用に商品を1ページ分取得する（商品ID昇順のキーセット方式）
//   after: 直前バッチの最後の商品ID（最初のバッチは null）
async function fetchCsvBatch(after) {
  const { rows } = after === null
    ? await pool.query(
      'SELECT product_id, product_name, stock, threshold FROM m_products ORDER BY product_id LIMIT $1',
      [CSV_BATCH_SIZE]
    )
    : await pool.query(
      'SELECT product_id, product_name, stock, threshold FROM m_products WHERE product_id > $1 ORDER BY product_id LIMIT $2',
      [after, CSV_BATCH_SIZE]
    );
  return rows;
}

// 商品の配列を CSV の行文字列にする
function productsToCsv(rows) {
  return rows.map((row) => toCsvRow([
    row.product_id,
    row.product_name,
    row.stock,
    CSV_ALERT_LABEL[row.threshold] ?? '',
  ])).join('');
}

// res.write の戻り値が false（送信バッファが一杯）のときは drain まで待つ（バックプレッシャー）
// ※ 切断済み（destroyed）のレスポンスに write すると false が返るが、close は既に発火済みで
//    drain も来ないため、待つと永久に解決しない。切断済みなら待たずに reject する
// クライアントによる切断（ダウンロードのキャンセル等）を表すエラー
//   異常ではないため、catch 側ではエラーログを出さずに情報ログだけを残す
class ClientClosedError extends Error {
  constructor() {
    super('client closed connection during CSV export');
    this.name = 'ClientClosedError';
  }
}
function clientClosedError() {
  return new ClientClosedError();
}
function writeChunk(res, chunk) {
  if (res.destroyed) return Promise.reject(clientClosedError());
  if (res.write(chunk)) return Promise.resolve();
  if (res.destroyed) return Promise.reject(clientClosedError());
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(clientClosedError()); };
    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}

// GET /products/export.csv : 在庫一覧を CSV でダウンロードする（商品ID昇順で全件）
// ※ '/:id' より前に定義する（"export.csv" は '.' を含むため商品IDの形式にも一致しない）
// ※ クエリパラメータは受け付けない（指定されても無視する）
router.get('/export.csv', asyncHandler(async (req, res) => {
  // 最初のバッチはヘッダー送信前に取得する
  // → ここでの DB エラーは asyncHandler 経由で共通エラーハンドラ（JSON）に渡る
  let rows = await fetchCsvBatch(null);

  res.status(200);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="products_${formatDateYmd()}.csv"`);

  try {
    await writeChunk(res, UTF8_BOM + toCsvRow(CSV_HEADER));
    while (rows.length > 0) {
      await writeChunk(res, productsToCsv(rows));
      // 取得件数がバッチサイズ未満なら最後のバッチ
      if (rows.length < CSV_BATCH_SIZE) break;
      // クライアントが切断済みなら以降の取得をやめる
      if (res.destroyed) throw clientClosedError();
      rows = await fetchCsvBatch(rows[rows.length - 1].product_id);
    }
    res.end();
  } catch (err) {
    if (err instanceof ClientClosedError) {
      // ダウンロードのキャンセル等、クライアント側の切断は正常な操作のためエラー扱いしない
      console.info(`[CSV] ${req.method} ${req.originalUrl} クライアントが切断したため出力を中止しました`);
    } else {
      // 出力開始後はステータスを変更できないため、ログを残して接続を切断する
      // （正常終了させると途中までの CSV が完全なファイルに見えてしまう）
      console.error(`[CSV] ${req.method} ${req.originalUrl} 出力中にエラーが発生したため切断します`, err);
    }
    res.destroy();
  }
}));

// GET /products/:id : 商品詳細を取得する
router.get('/:id', asyncHandler(async (req, res) => {
  assertProductPathId(req.params.id);

  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS} FROM m_products WHERE product_id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) {
    throw new ApiError(404, '商品が見つかりません');
  }
  res.json({ data: rows[0] });
}));

// POST /products : 商品を登録する
//   body: { product_id: string(必須), product_name: string(必須), stock?: integer(省略時 0) }
//   threshold は受け付けず、stock から算出する
//   201: 登録した商品 / 400: バリデーションエラー（予約語 alerts を含む） / 409: 商品ID重複
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body;
  assertJsonObject(body);

  const errors = [];
  validateNewProductId('product_id', body.product_id, errors);
  validateProductName(body.product_name, errors);
  const stock = body.stock === undefined ? 0 : body.stock;
  validateNonNegativeInt('stock', stock, errors);
  throwIfErrors(errors);

  try {
    const { rows } = await pool.query(
      `INSERT INTO m_products (product_id, product_name, stock, threshold)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PRODUCT_COLUMNS}`,
      [body.product_id, body.product_name.trim(), stock, calcThreshold(stock)]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    // 主キー重複は専用メッセージで 409 を返す
    if (err.code === '23505') {
      throw new ApiError(409, 'この商品IDは既に登録されています', [
        { field: 'product_id', message: '既に使用されている商品IDです' },
      ]);
    }
    throw err;
  }
}));

// PUT /products/:id : 商品名・在庫数を部分更新する
//   body: { product_name?: string, stock?: integer }（最低1項目は必須）
//   stock を更新した場合は threshold も再算出して同時に更新する
//   threshold / product_id が body に含まれていても無視する
//   200: 更新後の商品 / 400: バリデーションエラー / 404: 商品なし
router.put('/:id', asyncHandler(async (req, res) => {
  assertProductPathId(req.params.id);
  const body = req.body;
  assertJsonObject(body);

  const hasName = body.product_name !== undefined;
  const hasStock = body.stock !== undefined;

  const errors = [];
  if (!hasName && !hasStock) {
    errors.push({ field: 'body', message: 'product_name または stock のいずれかを指定してください' });
  }
  if (hasName) validateProductName(body.product_name, errors);
  if (hasStock) validateNonNegativeInt('stock', body.stock, errors);
  throwIfErrors(errors);

  // 更新対象カラムは固定のホワイトリストから組み立て、値はすべてプレースホルダで渡す
  const sets = [];
  const values = [];
  if (hasName) {
    values.push(body.product_name.trim());
    sets.push(`product_name = $${values.length}`);
  }
  if (hasStock) {
    values.push(body.stock);
    sets.push(`stock = $${values.length}`);
    values.push(calcThreshold(body.stock));
    sets.push(`threshold = $${values.length}`);
  }
  values.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE m_products SET ${sets.join(', ')}
     WHERE product_id = $${values.length}
     RETURNING ${PRODUCT_COLUMNS}`,
    values
  );
  if (rows.length === 0) {
    throw new ApiError(404, '商品が見つかりません');
  }
  res.json({ data: rows[0] });
}));

// DELETE /products/:id : 商品を削除する
//   204: 削除成功 / 404: 商品なし / 409: 入出庫履歴が存在する（外部キー RESTRICT）
router.delete('/:id', asyncHandler(async (req, res) => {
  assertProductPathId(req.params.id);

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM m_products WHERE product_id = $1',
      [req.params.id]
    );
    if (rowCount === 0) {
      throw new ApiError(404, '商品が見つかりません');
    }
    res.status(204).end();
  } catch (err) {
    // 履歴が参照しているため削除できない（SQLSTATE 23503: 外部キー違反）
    if (err.code === '23503') {
      throw new ApiError(409, '入出庫履歴が存在するため、この商品は削除できません');
    }
    throw err;
  }
}));

module.exports = router;
