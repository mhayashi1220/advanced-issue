// 入出庫履歴 API（/stock-transactions）のユニットテスト
// DB（src/db/pool）は jest.mock でモックし、実 DB には接続しない。
// トランザクションで使う client（pool.connect() の戻り値）の query / release もモックする。
//
// 注意: pool.js は require 時に pool.query('SELECT NOW()') を実行するため、
// 実モジュールを読み込まないようファクトリ付きでモックしている。
jest.mock('../../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
  end: jest.fn(),
}));
// 念のため pg 自体もモックし、万一 pool.js の実体が読み込まれても接続しないようにする
jest.mock('pg', () => ({ Pool: jest.fn() }));

const request = require('supertest');
const pool = require('../../src/db/pool');
const app = require('../../src/index');
const { INT_MAX } = require('../../src/lib/validation');

// トランザクション用クライアントのモック
let client;

// エラーレスポンスの共通形式を検証するヘルパー
function expectErrorShape(res, status) {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({
    error: { message: expect.any(String), details: expect.any(Array) },
  });
}

// details に指定フィールドのエラーが含まれることを検証するヘルパー
function expectDetailField(res, field) {
  expect(res.body.error.details).toEqual(
    expect.arrayContaining([expect.objectContaining({ field })])
  );
}

// client.query に渡された SQL（第1引数）の一覧
function executedSql() {
  return client.query.mock.calls.map((call) => call[0]);
}

// client.query の呼び出しのうち、SQL に指定文字列を含むものを返す
function findCall(fragment) {
  return client.query.mock.calls.find((call) => call[0].includes(fragment));
}

// 正常系のトランザクション応答を順番に仕込む
//   BEGIN → SELECT ... FOR UPDATE → UPDATE → INSERT → COMMIT
function mockSuccessfulTransaction({ currentStock, updatedProduct, insertedTx }) {
  client.query
    .mockResolvedValueOnce({}) // BEGIN
    .mockResolvedValueOnce({ rows: [{ product_id: updatedProduct.product_id, stock: currentStock }], rowCount: 1 }) // SELECT FOR UPDATE
    .mockResolvedValueOnce({ rows: [updatedProduct], rowCount: 1 }) // UPDATE
    .mockResolvedValueOnce({ rows: [insertedTx], rowCount: 1 }) // INSERT
    .mockResolvedValueOnce({}); // COMMIT
}

beforeEach(() => {
  // 各テストの前にモックの呼び出し履歴と実装をリセットする
  jest.resetAllMocks();
  // on / removeListener はトランザクション中の接続エラー用リスナーの登録・解除に使われる
  client = { query: jest.fn(), release: jest.fn(), on: jest.fn(), removeListener: jest.fn() };
  pool.connect.mockResolvedValue(client);
  // エラーハンドラのログ出力でテスト結果が見づらくならないよう抑止する
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /stock-transactions（入出庫登録）', () => {
  describe('正常系', () => {
    test('入庫すると 201 を返し、在庫が加算される', async () => {
      const updatedProduct = { product_id: 'P001', product_name: 'ボールペン', stock: 25, threshold: '0' };
      const insertedTx = { rireki_id: 'R000000001', product_id: 'P001', transaction_type: '0', quantity: 20 };
      mockSuccessfulTransaction({ currentStock: 5, updatedProduct, insertedTx });

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '0', quantity: 20 });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ data: { transaction: insertedTx, product: updatedProduct } });

      // 在庫 5 + 20 = 25、threshold は 10 以上なので '0'
      expect(findCall('UPDATE m_products')[1]).toEqual([25, '0', 'P001']);
      expect(findCall('INSERT INTO t_stock_transactions')[1]).toEqual(['P001', '0', 20]);
    });

    test('出庫すると 201 を返し、在庫が減算されて threshold が再計算される', async () => {
      const updatedProduct = { product_id: 'P001', product_name: 'ボールペン', stock: 8, threshold: '1' };
      const insertedTx = { rireki_id: 'R000000002', product_id: 'P001', transaction_type: '1', quantity: 12 };
      mockSuccessfulTransaction({ currentStock: 20, updatedProduct, insertedTx });

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '1', quantity: 12 });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({ transaction: insertedTx, product: updatedProduct });
      // 在庫 20 - 12 = 8、10 未満なので threshold = '1'
      expect(findCall('UPDATE m_products')[1]).toEqual([8, '1', 'P001']);
      expect(findCall('INSERT INTO t_stock_transactions')[1]).toEqual(['P001', '1', 12]);
    });

    test('在庫と同数の出庫は許可され、在庫 0 になる（境界値）', async () => {
      mockSuccessfulTransaction({
        currentStock: 7,
        updatedProduct: { product_id: 'P001', product_name: 'A', stock: 0, threshold: '1' },
        insertedTx: { rireki_id: 'R000000003', product_id: 'P001', transaction_type: '1', quantity: 7 },
      });

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '1', quantity: 7 });

      expect(res.status).toBe(201);
      expect(findCall('UPDATE m_products')[1]).toEqual([0, '1', 'P001']);
    });

    test('入庫後の在庫がちょうど INT_MAX なら許可される（境界値）', async () => {
      mockSuccessfulTransaction({
        currentStock: INT_MAX - 1,
        updatedProduct: { product_id: 'P001', product_name: 'A', stock: INT_MAX, threshold: '0' },
        insertedTx: { rireki_id: 'R000000004', product_id: 'P001', transaction_type: '0', quantity: 1 },
      });

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

      expect(res.status).toBe(201);
      expect(findCall('UPDATE m_products')[1]).toEqual([INT_MAX, '0', 'P001']);
    });

    test('BEGIN → SELECT ... FOR UPDATE → UPDATE → INSERT → COMMIT の順に実行し、release する', async () => {
      mockSuccessfulTransaction({
        currentStock: 10,
        updatedProduct: { product_id: 'P001', product_name: 'A', stock: 13, threshold: '0' },
        insertedTx: { rireki_id: 'R000000005', product_id: 'P001', transaction_type: '0', quantity: 3 },
      });

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '0', quantity: 3 });

      expect(res.status).toBe(201);
      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenCalledTimes(5);

      const sql = executedSql();
      expect(sql[0]).toBe('BEGIN');
      expect(sql[1]).toEqual(expect.stringContaining('FOR UPDATE'));
      expect(sql[1]).toEqual(expect.stringContaining('m_products'));
      expect(client.query.mock.calls[1][1]).toEqual(['P001']);
      expect(sql[2]).toEqual(expect.stringContaining('UPDATE m_products'));
      expect(sql[3]).toEqual(expect.stringContaining('INSERT INTO t_stock_transactions'));
      expect(sql[3]).toEqual(expect.stringContaining("nextval('seq_rireki_id')"));
      expect(sql[4]).toBe('COMMIT');
      expect(sql).not.toContain('ROLLBACK');

      // 接続は1回だけ、エラー引数なしでプールへ返却される
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith();
      // トランザクション処理は pool.query ではなく client.query で行う
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe('業務エラー（ROLLBACK される）', () => {
    test('在庫不足の出庫は 409 を返し、ROLLBACK と release が呼ばれる', async () => {
      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ product_id: 'P001', stock: 5 }], rowCount: 1 }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}); // ROLLBACK

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '1', quantity: 6 });

      expectErrorShape(res, 409);
      expect(res.body.error.message).toBe('在庫が不足しているため出庫できません');
      expectDetailField(res, 'quantity');
      expect(res.body.error.details[0].message).toEqual(expect.stringContaining('5'));

      const sql = executedSql();
      expect(sql).toEqual(['BEGIN', expect.stringContaining('FOR UPDATE'), 'ROLLBACK']);
      // 在庫をマイナスにする UPDATE や履歴 INSERT、COMMIT は実行されない
      expect(findCall('UPDATE m_products')).toBeUndefined();
      expect(findCall('INSERT INTO')).toBeUndefined();
      expect(sql).not.toContain('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    test('在庫 0 の商品からの出庫は 409 を返す', async () => {
      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ product_id: 'P001', stock: 0 }], rowCount: 1 })
        .mockResolvedValueOnce({});

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '1', quantity: 1 });

      expectErrorShape(res, 409);
      expect(executedSql()).toContain('ROLLBACK');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    test('入庫後の在庫が INT_MAX を超える場合は 409 を返し、ROLLBACK する', async () => {
      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ product_id: 'P001', stock: INT_MAX }], rowCount: 1 })
        .mockResolvedValueOnce({});

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

      expectErrorShape(res, 409);
      expect(res.body.error.message).toBe('在庫数が上限を超えるため入庫できません');
      expectDetailField(res, 'quantity');
      expect(findCall('UPDATE m_products')).toBeUndefined();
      expect(executedSql()).toContain('ROLLBACK');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    test('商品が存在しない場合は 404 を返し、ROLLBACK と release が呼ばれる', async () => {
      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT FOR UPDATE（該当なし）
        .mockResolvedValueOnce({}); // ROLLBACK

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'NOPE', transaction_type: '0', quantity: 1 });

      expectErrorShape(res, 404);
      expect(res.body.error.message).toBe('商品が見つかりません');
      expectDetailField(res, 'product_id');
      expect(executedSql()).toEqual(['BEGIN', expect.stringContaining('FOR UPDATE'), 'ROLLBACK']);
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('DB エラー', () => {
    test('INSERT で DB エラーが起きると 500 を返し、ROLLBACK と release が呼ばれる', async () => {
      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ product_id: 'P001', stock: 10 }], rowCount: 1 }) // SELECT
        .mockResolvedValueOnce({ rows: [{ product_id: 'P001', stock: 11 }], rowCount: 1 }) // UPDATE
        .mockRejectedValueOnce(Object.assign(new Error('sequence "seq_rireki_id" does not exist'), { code: '42P01' })) // INSERT
        .mockResolvedValueOnce({}); // ROLLBACK

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

      expectErrorShape(res, 500);
      expect(res.body.error.message).toBe('サーバー内部でエラーが発生しました');
      expect(res.body.error.details).toEqual([]);
      // 内部エラーの詳細（SQL・オブジェクト名・SQLSTATE）はレスポンスに含めない
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('seq_rireki_id');
      expect(raw).not.toContain('42P01');

      const sql = executedSql();
      expect(sql[sql.length - 1]).toBe('ROLLBACK');
      expect(sql).not.toContain('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith();
      expect(console.error).toHaveBeenCalled();
    });

    test('UPDATE で DB エラーが起きると 500 を返し、INSERT は実行されない', async () => {
      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ product_id: 'P001', stock: 10 }], rowCount: 1 })
        .mockRejectedValueOnce(new Error('internal update failure'))
        .mockResolvedValueOnce({});

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '1', quantity: 1 });

      expectErrorShape(res, 500);
      expect(JSON.stringify(res.body)).not.toContain('internal update failure');
      expect(findCall('INSERT INTO')).toBeUndefined();
      expect(executedSql()).toContain('ROLLBACK');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    test('BEGIN で DB エラーが起きても ROLLBACK と release が呼ばれる', async () => {
      client.query
        .mockRejectedValueOnce(new Error('begin failed'))
        .mockResolvedValueOnce({});

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

      expectErrorShape(res, 500);
      expect(executedSql()).toEqual(['BEGIN', 'ROLLBACK']);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    test('COMMIT で DB エラーが起きると 500 を返し、ROLLBACK と release が呼ばれる', async () => {
      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ product_id: 'P001', stock: 10 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
        .mockRejectedValueOnce(new Error('commit failed'))
        .mockResolvedValueOnce({});

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

      expectErrorShape(res, 500);
      expect(executedSql().slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    test('デッドロック（40P01）は 409 に変換され、ROLLBACK と release が呼ばれる', async () => {
      client.query
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
        .mockResolvedValueOnce({});

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '1', quantity: 1 });

      expectErrorShape(res, 409);
      expect(res.body.error.message).toBe('同時更新が競合しました。再度実行してください');
      expect(executedSql()).toContain('ROLLBACK');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    test('ROLLBACK 自体が失敗した場合は release にエラーを渡して接続を破棄する（二重 release しない）', async () => {
      const rollbackErr = new Error('rollback failed');
      client.query
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('select failed'))
        .mockRejectedValueOnce(rollbackErr);

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

      expectErrorShape(res, 500);
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(rollbackErr);
    });

    test('pool.connect が失敗した場合は 500 を返す（client は取得されていないため release しない）', async () => {
      pool.connect.mockRejectedValueOnce(new Error('too many clients already'));

      const res = await request(app)
        .post('/stock-transactions')
        .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

      expectErrorShape(res, 500);
      expect(JSON.stringify(res.body)).not.toContain('too many clients');
      expect(client.query).not.toHaveBeenCalled();
      expect(client.release).not.toHaveBeenCalled();
    });
  });

  describe('バリデーションエラー（400）', () => {
    test.each([
      ['product_id が未指定', { transaction_type: '0', quantity: 1 }, 'product_id'],
      ['product_id が数値', { product_id: 1, transaction_type: '0', quantity: 1 }, 'product_id'],
      ['product_id が 11 文字', { product_id: 'ABCDEFGHIJK', transaction_type: '0', quantity: 1 }, 'product_id'],
      ['product_id に記号', { product_id: 'P;01', transaction_type: '0', quantity: 1 }, 'product_id'],
      ['transaction_type が未指定', { product_id: 'P001', quantity: 1 }, 'transaction_type'],
      ['transaction_type が数値の 0', { product_id: 'P001', transaction_type: 0, quantity: 1 }, 'transaction_type'],
      ['transaction_type が数値の 1', { product_id: 'P001', transaction_type: 1, quantity: 1 }, 'transaction_type'],
      ['transaction_type が範囲外の文字列', { product_id: 'P001', transaction_type: '2', quantity: 1 }, 'transaction_type'],
      ['transaction_type が "in"', { product_id: 'P001', transaction_type: 'in', quantity: 1 }, 'transaction_type'],
      ['quantity が未指定', { product_id: 'P001', transaction_type: '0' }, 'quantity'],
      ['quantity が 0（境界値）', { product_id: 'P001', transaction_type: '0', quantity: 0 }, 'quantity'],
      ['quantity が負数', { product_id: 'P001', transaction_type: '1', quantity: -5 }, 'quantity'],
      ['quantity が小数', { product_id: 'P001', transaction_type: '0', quantity: 1.5 }, 'quantity'],
      ['quantity が文字列', { product_id: 'P001', transaction_type: '0', quantity: '5' }, 'quantity'],
      ['quantity が INT_MAX 超過', { product_id: 'P001', transaction_type: '0', quantity: INT_MAX + 1 }, 'quantity'],
      ['quantity が null', { product_id: 'P001', transaction_type: '0', quantity: null }, 'quantity'],
    ])('%s', async (_label, body, field) => {
      const res = await request(app).post('/stock-transactions').send(body);

      expectErrorShape(res, 400);
      expect(res.body.error.message).toBe('入力内容に誤りがあります');
      expectDetailField(res, field);
      // バリデーションエラー時は DB 接続を取得しない
      expect(pool.connect).not.toHaveBeenCalled();
    });

    test('{} を送ると全項目がエラーになる', async () => {
      const res = await request(app).post('/stock-transactions').send({});

      expectErrorShape(res, 400);
      const fields = res.body.error.details.map((d) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['product_id', 'transaction_type', 'quantity']));
      expect(pool.connect).not.toHaveBeenCalled();
    });

    test('body が配列なら 400 を返す', async () => {
      const res = await request(app).post('/stock-transactions').send([]);

      expectErrorShape(res, 400);
      expectDetailField(res, 'body');
      expect(pool.connect).not.toHaveBeenCalled();
    });

    test('壊れた JSON は 400 を返す', async () => {
      const res = await request(app)
        .post('/stock-transactions')
        .set('Content-Type', 'application/json')
        .send('{"product_id":"P001",}');

      expectErrorShape(res, 400);
      expect(res.body.error.message).toBe('リクエストボディの JSON が不正です');
      expect(pool.connect).not.toHaveBeenCalled();
    });

    test('Content-Type が application/json でなければ 400 を返す', async () => {
      const res = await request(app)
        .post('/stock-transactions')
        .type('form')
        .send('product_id=P001&transaction_type=0&quantity=1');

      expectErrorShape(res, 400);
      expect(pool.connect).not.toHaveBeenCalled();
    });
  });
});

describe('GET /stock-transactions（入出庫履歴一覧）', () => {
  const tx1 = { rireki_id: 'R000000001', product_id: 'P001', transaction_type: '0', quantity: 10 };
  const tx2 = { rireki_id: 'R000000002', product_id: 'P002', transaction_type: '1', quantity: 3 };

  const DEFAULT_META = { limit: 100, next_after: null };

  test('1ページ目を { data: [...], meta } 形式で返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [tx1, tx2], rowCount: 2 });

    const res = await request(app).get('/stock-transactions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [tx1, tx2], meta: DEFAULT_META });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toEqual(expect.stringContaining('FROM t_stock_transactions'));
    expect(sql).toEqual(expect.stringContaining('ORDER BY rireki_id'));
    expect(sql).not.toEqual(expect.stringContaining('WHERE'));
    // 既定の limit=100 に対し、次ページ判定用に 101 件を要求する
    expect(sql).toEqual(expect.stringContaining('LIMIT $1'));
    expect(params).toEqual([101]);
  });

  test('?product_id= で絞り込み、値はプレースホルダで渡す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [tx1], rowCount: 1 });

    const res = await request(app).get('/stock-transactions').query({ product_id: 'P001' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [tx1], meta: DEFAULT_META });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE product_id = $1'), ['P001', 101]);
  });

  test('該当履歴がなければ空配列を返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/stock-transactions?product_id=P999');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], meta: DEFAULT_META });
  });

  test.each([
    ['空文字', '?product_id='],
    ['11 文字', '?product_id=ABCDEFGHIJK'],
    ['記号を含む', "?product_id=P001'--"],
    ['配列指定', '?product_id=P001&product_id=P002'],
    ['オブジェクト形式', '?product_id[a]=P001'],
  ])('product_id の形式が不正（%s）なら 400 を返し、DB に問い合わせない', async (_label, qs) => {
    const res = await request(app).get(`/stock-transactions${qs}`);

    expectErrorShape(res, 400);
    expectDetailField(res, 'product_id');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('DB エラー時は 500 を返し、詳細を含めない', async () => {
    pool.query.mockRejectedValueOnce(new Error('relation "t_stock_transactions" does not exist'));

    const res = await request(app).get('/stock-transactions');

    expectErrorShape(res, 500);
    expect(JSON.stringify(res.body)).not.toContain('t_stock_transactions');
  });
});

describe('GET /stock-transactions/:id（入出庫履歴詳細）', () => {
  const tx = { rireki_id: 'R000000001', product_id: 'P001', transaction_type: '0', quantity: 10 };

  test('履歴が存在すれば 200 で返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [tx], rowCount: 1 });

    const res = await request(app).get('/stock-transactions/R000000001');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: tx });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE rireki_id = $1'), ['R000000001']);
  });

  test('履歴が存在しなければ 404 を返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/stock-transactions/R999999999');

    expectErrorShape(res, 404);
    expect(res.body.error.message).toBe('入出庫履歴が見つかりません');
  });

  test.each([
    ['桁数不足', 'R00000001'],
    ['桁数超過', 'R0000000001'],
    ['先頭が小文字', 'r000000001'],
    ['数字以外を含む', 'R00000000A'],
    ['先頭が R 以外', 'X000000001'],
  ])('履歴ID の形式が不正（%s）なら 400 を返し、DB に問い合わせない', async (_label, id) => {
    const res = await request(app).get(`/stock-transactions/${id}`);

    expectErrorShape(res, 400);
    expectDetailField(res, 'id');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('DB エラー時は 500 を返す', async () => {
    pool.query.mockRejectedValueOnce(new Error('boom'));

    const res = await request(app).get('/stock-transactions/R000000001');

    expectErrorShape(res, 500);
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });
});

describe('未定義のメソッド', () => {
  test('PUT /stock-transactions/:id は存在しないため 404 を返す（履歴は更新不可）', async () => {
    const res = await request(app).put('/stock-transactions/R000000001').send({ quantity: 1 });

    expectErrorShape(res, 404);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('DELETE /stock-transactions/:id は存在しないため 404 を返す', async () => {
    const res = await request(app).delete('/stock-transactions/R000000001');

    expectErrorShape(res, 404);
  });
});

describe('トランザクション中の接続エラーリスナー（L-5）', () => {
  // client.on('error', fn) で登録されたリスナーを取り出す
  function registeredErrorListener() {
    const call = client.on.mock.calls.find((c) => c[0] === 'error');
    return call ? call[1] : undefined;
  }

  test('正常終了時: error リスナーを登録し、release の前に同じ関数を外す', async () => {
    mockSuccessfulTransaction({
      currentStock: 10,
      updatedProduct: { product_id: 'P001', product_name: 'A', stock: 11, threshold: '0' },
      insertedTx: { rireki_id: 'R000000001', product_id: 'P001', transaction_type: '0', quantity: 1 },
    });

    const res = await request(app)
      .post('/stock-transactions')
      .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

    expect(res.status).toBe(201);
    const listener = registeredErrorListener();
    expect(typeof listener).toBe('function');
    expect(client.removeListener).toHaveBeenCalledTimes(1);
    expect(client.removeListener).toHaveBeenCalledWith('error', listener);
    // リスナーは BEGIN より前に登録し、プールへ返却する前に外す
    expect(client.on.mock.invocationCallOrder[0]).toBeLessThan(client.query.mock.invocationCallOrder[0]);
    expect(client.removeListener.mock.invocationCallOrder[0]).toBeLessThan(client.release.mock.invocationCallOrder[0]);
  });

  test('業務エラー（在庫不足）時もリスナーを外してから release する', async () => {
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ product_id: 'P001', stock: 0 }], rowCount: 1 })
      .mockResolvedValueOnce({});

    const res = await request(app)
      .post('/stock-transactions')
      .send({ product_id: 'P001', transaction_type: '1', quantity: 1 });

    expect(res.status).toBe(409);
    expect(client.removeListener).toHaveBeenCalledWith('error', registeredErrorListener());
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('ROLLBACK 失敗で接続を破棄する場合もリスナーを外す', async () => {
    client.query
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('select failed'))
      .mockRejectedValueOnce(new Error('rollback failed'));

    const res = await request(app)
      .post('/stock-transactions')
      .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

    expect(res.status).toBe(500);
    expect(client.removeListener).toHaveBeenCalledWith('error', registeredErrorListener());
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('接続エラーが発生してもリスナーがログに記録し、応答は 500 の固定メッセージになる', async () => {
    // 1つ目のクエリ（BEGIN）の実行中に接続が切れた状況を再現する
    client.query
      .mockImplementationOnce(() => {
        registeredErrorListener()(new Error('Connection terminated unexpectedly'));
        return Promise.reject(new Error('Connection terminated unexpectedly'));
      })
      .mockResolvedValueOnce({});

    const res = await request(app)
      .post('/stock-transactions')
      .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

    expectErrorShape(res, 500);
    expect(console.error).toHaveBeenCalledWith(
      'トランザクション中のPostgreSQL接続エラー:',
      'Connection terminated unexpectedly'
    );
    expect(JSON.stringify(res.body)).not.toContain('Connection terminated');
    expect(client.removeListener).toHaveBeenCalledTimes(1);
  });
});

describe('DB のタイムアウト・競合エラーの変換（M-2）', () => {
  // BEGIN の直後の SELECT ... FOR UPDATE で指定のエラーを発生させる
  async function postWithSelectError(err) {
    client.query
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({});
    return request(app)
      .post('/stock-transactions')
      .send({ product_id: 'P001', transaction_type: '1', quantity: 1 });
  }

  test('lock_timeout（55P03）は 409「他の処理と競合しました」を返し、ROLLBACK する', async () => {
    const res = await postWithSelectError(Object.assign(
      new Error('canceling statement due to lock timeout'), { code: '55P03' }
    ));

    expectErrorShape(res, 409);
    expect(res.body.error.message).toBe('他の処理と競合しました。再度実行してください');
    expect(JSON.stringify(res.body)).not.toContain('lock timeout');
    expect(executedSql()).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('statement_timeout（57014）は 503 を返し、内部情報を含めない', async () => {
    const res = await postWithSelectError(Object.assign(
      new Error('canceling statement due to statement timeout'), { code: '57014' }
    ));

    expectErrorShape(res, 503);
    expect(res.body.error.details).toEqual([]);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('statement timeout');
    expect(raw).not.toContain('57014');
    // 5xx はサーバーログに記録される（index.js の status >= 500 の分岐）
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[503]'), expect.any(Error));
  });

  test('履歴IDのシーケンス枯渇（2200H）は 503 を返し、シーケンス名を含めない', async () => {
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ product_id: 'P001', stock: 10 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockRejectedValueOnce(Object.assign(
        new Error('nextval: reached maximum value of sequence "seq_rireki_id" (999999999)'), { code: '2200H' }
      ))
      .mockResolvedValueOnce({});

    const res = await request(app)
      .post('/stock-transactions')
      .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

    expectErrorShape(res, 503);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('seq_rireki_id');
    expect(raw).not.toContain('2200H');
    expect(executedSql()).toContain('ROLLBACK');
    expect(executedSql()).not.toContain('COMMIT');
  });

  test.each([
    'timeout exceeded when trying to connect',
    'Connection terminated due to connection timeout',
  ])('pool.connect のタイムアウト（%s）は 503 を返す', async (message) => {
    pool.connect.mockRejectedValueOnce(new Error(message));

    const res = await request(app)
      .post('/stock-transactions')
      .send({ product_id: 'P001', transaction_type: '0', quantity: 1 });

    expectErrorShape(res, 503);
    expect(res.body.error.message).toBe('現在処理が混み合っています。しばらく待ってから再度実行してください');
    expect(JSON.stringify(res.body)).not.toContain('timeout');
    expect(client.release).not.toHaveBeenCalled();
  });

  test('pool.query（一覧取得）の接続タイムアウトも 503 を返す', async () => {
    pool.query.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));

    const res = await request(app).get('/stock-transactions');

    expectErrorShape(res, 503);
  });

  test('SQLSTATE の無い想定外のエラーは従来どおり 500 を返す', async () => {
    pool.query.mockRejectedValueOnce(new Error('something else'));

    const res = await request(app).get('/stock-transactions');

    expectErrorShape(res, 500);
  });
});
