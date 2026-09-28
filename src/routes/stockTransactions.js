// 入出庫履歴（T_STOCK_TRANSACTIONS）の API
//
// レスポンス仕様
//   履歴オブジェクト: { rireki_id, product_id, transaction_type, quantity }
//     rireki_id       : サーバー採番（'R' + 9桁ゼロ埋め、例: R000000001）
//     transaction_type: '0' = 入庫 / '1' = 出庫
//   一覧（GET /stock-transactions）は { "data": [...], "meta": { limit, next_after } }
//     ページングはキーセット方式。?limit=1〜500（既定 100）、?after=<直前ページの meta.next_after（履歴ID）>

const express = require('express');
const pool = require('../db/pool');
const { ApiError, asyncHandler } = require('../lib/errors');
const {
  INT_MAX,
  RIREKI_ID_PATTERN,
  calcThreshold,
  assertJsonObject,
  throwIfErrors,
  validatePositiveInt,
  validateProductIdFormat,
  assertPathId,
  parsePagination,
  buildPage,
} = require('../lib/validation');

const router = express.Router();

// 取引種別のコード値
const TYPE_IN = '0';  // 入庫
const TYPE_OUT = '1'; // 出庫

const TX_COLUMNS = 'rireki_id, product_id, transaction_type, quantity';

// POST /stock-transactions : 入庫・出庫を記録する
//   body: { product_id: string, transaction_type: '0'|'1', quantity: integer(1以上) }
//   1トランザクション内で「商品行ロック → 在庫検証 → 在庫・threshold 更新 → 履歴 INSERT」を行う
//   201: { data: { transaction, product } }
//   400: バリデーションエラー / 404: 商品なし / 409: 在庫不足・在庫上限超過
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body;
  assertJsonObject(body);

  const errors = [];
  validateProductIdFormat('product_id', body.product_id, errors);
  if (body.transaction_type !== TYPE_IN && body.transaction_type !== TYPE_OUT) {
    errors.push({ field: 'transaction_type', message: "'0'（入庫）または '1'（出庫）の文字列で指定してください" });
  }
  validatePositiveInt('quantity', body.quantity, errors);
  throwIfErrors(errors);

  const { product_id: productId, transaction_type: type, quantity } = body;

  const client = await pool.connect();
  let released = false;

  // トランザクション中に接続が切れた場合（DB 再起動・ネットワーク断・
  // idle_in_transaction_session_timeout による切断など）、client は 'error' イベントを発行する。
  // リスナーが無いと未処理の 'error' イベントとしてプロセスが異常終了するため、ログに記録して握りつぶす。
  // （実行中のクエリは reject されるため、エラー応答は catch 側で行われる）
  const onClientError = (clientErr) => {
    console.error('トランザクション中のPostgreSQL接続エラー:', clientErr.message);
  };
  client.on('error', onClientError);

  try {
    await client.query('BEGIN');

    // 同一商品への同時入出庫で在庫数が食い違わないよう、商品行を排他ロックする
    const locked = await client.query(
      'SELECT product_id, stock FROM m_products WHERE product_id = $1 FOR UPDATE',
      [productId]
    );
    if (locked.rows.length === 0) {
      throw new ApiError(404, '商品が見つかりません', [
        { field: 'product_id', message: '指定された商品は存在しません' },
      ]);
    }

    const currentStock = locked.rows[0].stock;
    let newStock;
    if (type === TYPE_OUT) {
      // 在庫数はマイナス不可：出庫数が現在庫を超える場合は拒否する
      if (quantity > currentStock) {
        throw new ApiError(409, '在庫が不足しているため出庫できません', [
          { field: 'quantity', message: `現在の在庫数は ${currentStock} です` },
        ]);
      }
      newStock = currentStock - quantity;
    } else {
      // INTEGER の上限を超える入庫は拒否する（DB の範囲外エラーを事前に防ぐ）
      if (currentStock + quantity > INT_MAX) {
        throw new ApiError(409, '在庫数が上限を超えるため入庫できません', [
          { field: 'quantity', message: `入庫可能な数量は ${INT_MAX - currentStock} 以下です` },
        ]);
      }
      newStock = currentStock + quantity;
    }

    // 在庫数と在庫アラートフラグを更新する
    const updated = await client.query(
      `UPDATE m_products SET stock = $1, threshold = $2
       WHERE product_id = $3
       RETURNING product_id, product_name, stock, threshold`,
      [newStock, calcThreshold(newStock), productId]
    );

    // 履歴を登録する（履歴IDはシーケンスから 'R' + 9桁ゼロ埋めで採番）
    const inserted = await client.query(
      `INSERT INTO t_stock_transactions (rireki_id, product_id, transaction_type, quantity)
       VALUES ('R' || LPAD(nextval('seq_rireki_id')::text, 9, '0'), $1, $2, $3)
       RETURNING ${TX_COLUMNS}`,
      [productId, type, quantity]
    );

    await client.query('COMMIT');
    res.status(201).json({
      data: { transaction: inserted.rows[0], product: updated.rows[0] },
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // ロールバックに失敗した接続は状態が不明なため、プールに戻さず破棄する
      console.error('ROLLBACK失敗:', rollbackErr.message);
      client.release(rollbackErr);
      released = true;
    }
    throw err;
  } finally {
    // プールに戻した後は他のリクエストが使うため、このリクエスト用のリスナーは必ず外す
    client.removeListener('error', onClientError);
    if (!released) client.release();
  }
}));

// GET /stock-transactions : 入出庫履歴一覧を取得する（履歴ID昇順）
//   query: product_id（任意）… 指定時はその商品の履歴のみ返す
//          limit（任意）/ after（任意）… ページング（履歴IDのキーセット）
router.get('/', asyncHandler(async (req, res) => {
  const { product_id: productId } = req.query;

  const where = [];
  const params = [];
  if (productId !== undefined) {
    // ?product_id=a&product_id=b のような配列指定も形式エラーとして扱う
    const errors = [];
    validateProductIdFormat('product_id', productId, errors);
    throwIfErrors(errors);
    params.push(productId);
    where.push(`product_id = $${params.length}`);
  }

  const { limit, after } = parsePagination(req.query, RIREKI_ID_PATTERN);
  if (after !== null) {
    // 履歴IDは 'R' + 9桁ゼロ埋めの固定長のため、文字列の大小と採番順が一致する
    params.push(after);
    where.push(`rireki_id > $${params.length}`);
  }
  // 次のページの有無を判定するため limit + 1 件取得する
  params.push(limit + 1);

  const { rows } = await pool.query(
    `SELECT ${TX_COLUMNS} FROM t_stock_transactions${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY rireki_id LIMIT $${params.length}`,
    params
  );
  res.json(buildPage(rows, limit, 'rireki_id'));
}));

// GET /stock-transactions/:id : 入出庫履歴詳細を取得する
router.get('/:id', asyncHandler(async (req, res) => {
  assertPathId(req.params.id, RIREKI_ID_PATTERN, '履歴ID');

  const { rows } = await pool.query(
    `SELECT ${TX_COLUMNS} FROM t_stock_transactions WHERE rireki_id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) {
    throw new ApiError(404, '入出庫履歴が見つかりません');
  }
  res.json({ data: rows[0] });
}));

module.exports = router;
