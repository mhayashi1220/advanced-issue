// 商品マスタ API（/products）のユニットテスト
// DB（src/db/pool）は jest.mock でモックし、実 DB には接続しない。
//
// 注意: pool.js は require 時に new Pool() と pool.query('SELECT NOW()') を実行するため、
// 自動モック（ファクトリなしの jest.mock）だと形状解析のために実モジュールが読み込まれてしまう。
// そのためファクトリを渡して、実モジュールを一切読み込まないようにしている。
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

// テスト用の商品データ
const productA = { product_id: 'P001', product_name: 'ボールペン', stock: 20, threshold: '0' };
const productB = { product_id: 'P002', product_name: 'ノート', stock: 3, threshold: '1' };

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

// ページングの既定値（次のページなし）の meta
const DEFAULT_META = { limit: 100, next_after: null };

beforeEach(() => {
  // 各テストの前にモックの呼び出し履歴と実装をリセットする
  jest.resetAllMocks();
  // エラーハンドラのログ出力でテスト結果が見づらくならないよう抑止する
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /products（商品一覧）', () => {
  test('商品一覧を { data: [...], meta } 形式で 200 で返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productA, productB], rowCount: 2 });

    const res = await request(app).get('/products');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [productA, productB], meta: DEFAULT_META });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toEqual(expect.stringContaining('FROM m_products'));
    expect(sql).toEqual(expect.stringContaining('ORDER BY product_id'));
    // 既定の limit=100 に対し、次ページ判定用に 101 件を要求する
    expect(sql).toEqual(expect.stringContaining('LIMIT $1'));
    expect(params).toEqual([101]);
  });

  test('商品が0件のときは空配列を返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/products');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], meta: DEFAULT_META });
  });

  test('DB エラー時は 500 を返し、内部エラーの詳細をレスポンスに含めない', async () => {
    const dbError = new Error('connection terminated: SELECT secret FROM m_products');
    dbError.code = 'XX000';
    pool.query.mockRejectedValueOnce(dbError);

    const res = await request(app).get('/products');

    expectErrorShape(res, 500);
    expect(res.body.error.message).toBe('サーバー内部でエラーが発生しました');
    expect(res.body.error.details).toEqual([]);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('connection terminated');
    expect(raw).not.toContain('m_products');
    expect(raw).not.toContain('XX000');
    expect(raw).not.toContain('stack');
    // 詳細はサーバーログにのみ出力される
    expect(console.error).toHaveBeenCalled();
  });
});

describe('GET /products/alerts（在庫アラート一覧）', () => {
  test('threshold = 1 の商品を返し、/products/:id として扱われない', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productB], rowCount: 1 });

    const res = await request(app).get('/products/alerts');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [productB], meta: DEFAULT_META });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toEqual(expect.stringContaining('threshold = $1'));
    // 詳細取得（WHERE product_id = $1）ではないこと
    expect(sql).not.toEqual(expect.stringContaining('product_id = $1'));
    // キーセットページングのため商品ID順で並べる
    expect(sql).toEqual(expect.stringContaining('ORDER BY product_id'));
    expect(sql).not.toEqual(expect.stringContaining('ORDER BY stock'));
    expect(params).toEqual(['1', 101]);
  });

  test('アラート対象が0件のときは空配列を返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/products/alerts');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], meta: DEFAULT_META });
  });

  test.each(['ALERTS', 'Alerts', 'aLeRtS'])(
    '/products/%s はアラート一覧にならず、予約語の商品IDとして 400 を返す（DB に問い合わせない）',
    async (id) => {
      // 以前は Router が大文字小文字を区別しなかったため /products/ALERTS もアラート一覧になっていた。
      // alerts を予約語にしたことで、小文字の /products/alerts 以外は商品IDとして検証され 400 になる。
      const res = await request(app).get(`/products/${id}`);

      expectErrorShape(res, 400);
      expectDetailField(res, 'id');
      expect(pool.query).not.toHaveBeenCalled();
    }
  );

  test('DB エラー時は 500 を返す', async () => {
    pool.query.mockRejectedValueOnce(new Error('boom'));

    const res = await request(app).get('/products/alerts');

    expectErrorShape(res, 500);
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });
});

describe('GET /products/:id（商品詳細）', () => {
  test('商品が存在すれば 200 で返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productA], rowCount: 1 });

    const res = await request(app).get('/products/P001');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: productA });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE product_id = $1'), ['P001']);
  });

  test('商品が存在しなければ 404 を返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/products/NOPE');

    expectErrorShape(res, 404);
    expect(res.body.error.message).toBe('商品が見つかりません');
  });

  test('ID が 10 文字ちょうどなら DB に問い合わせる（境界値）', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/products/ABCDEFGHIJ');

    expect(res.status).toBe(404);
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ['ABCDEFGHIJ']);
  });

  test.each([
    ['11文字', 'ABCDEFGHIJK'],
    ['記号を含む', 'P%2B01'], // P+01
    ['ドットを含む', 'P.01'],
    ['日本語', encodeURIComponent('商品')],
  ])('ID の形式が不正（%s）なら 400 を返し、DB に問い合わせない', async (_label, id) => {
    const res = await request(app).get(`/products/${id}`);

    expectErrorShape(res, 400);
    expectDetailField(res, 'id');
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('POST /products（商品登録）', () => {
  test('商品を登録して 201 を返す（stock から threshold を算出）', async () => {
    const created = { product_id: 'P010', product_name: '消しゴム', stock: 15, threshold: '0' };
    pool.query.mockResolvedValueOnce({ rows: [created], rowCount: 1 });

    const res = await request(app)
      .post('/products')
      .send({ product_id: 'P010', product_name: '消しゴム', stock: 15 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: created });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO m_products'),
      ['P010', '消しゴム', 15, '0']
    );
  });

  test('stock を省略すると 0 で登録され、threshold は 1 になる', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ product_id: 'P011', product_name: '定規', stock: 0, threshold: '1' }],
      rowCount: 1,
    });

    const res = await request(app)
      .post('/products')
      .send({ product_id: 'P011', product_name: '定規' });

    expect(res.status).toBe(201);
    expect(pool.query.mock.calls[0][1]).toEqual(['P011', '定規', 0, '1']);
  });

  test('body で threshold を送っても無視され、stock から算出される', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ product_id: 'P012', product_name: 'のり', stock: 100, threshold: '0' }],
      rowCount: 1,
    });

    const res = await request(app)
      .post('/products')
      .send({ product_id: 'P012', product_name: 'のり', stock: 100, threshold: '1' });

    expect(res.status).toBe(201);
    // クライアント指定の '1' ではなく、stock=100 から算出した '0' が渡る
    expect(pool.query.mock.calls[0][1]).toEqual(['P012', 'のり', 100, '0']);
  });

  test.each([
    [9, '1'],
    [10, '0'],
  ])('stock=%i のとき threshold は %s（アラート基準の境界値）', async (stock, threshold) => {
    pool.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    const res = await request(app)
      .post('/products')
      .send({ product_id: 'P013', product_name: 'はさみ', stock });

    expect(res.status).toBe(201);
    expect(pool.query.mock.calls[0][1]).toEqual(['P013', 'はさみ', stock, threshold]);
  });

  test('商品名の前後の空白は除去して登録する', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    const res = await request(app)
      .post('/products')
      .send({ product_id: 'P014', product_name: '  ホチキス  ', stock: 1 });

    expect(res.status).toBe(201);
    expect(pool.query.mock.calls[0][1][1]).toBe('ホチキス');
  });

  test('境界値（ID 10文字、商品名 100文字、stock = INT_MAX）は登録できる', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    const name = 'あ'.repeat(100);

    const res = await request(app)
      .post('/products')
      .send({ product_id: 'A_b-C12345', product_name: name, stock: INT_MAX });

    expect(res.status).toBe(201);
    expect(pool.query.mock.calls[0][1]).toEqual(['A_b-C12345', name, INT_MAX, '0']);
  });

  test('サロゲートペアの文字も1文字として数える（100文字は許可）', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    const res = await request(app)
      .post('/products')
      .send({ product_id: 'P015', product_name: '𠮷'.repeat(100) });

    expect(res.status).toBe(201);
  });

  describe('バリデーションエラー（400）', () => {
    test.each([
      ['product_id が数値', { product_id: 1, product_name: 'A' }, 'product_id'],
      ['product_id が未指定', { product_name: 'A' }, 'product_id'],
      ['product_id が空文字', { product_id: '', product_name: 'A' }, 'product_id'],
      ['product_id が 11 文字', { product_id: 'ABCDEFGHIJK', product_name: 'A' }, 'product_id'],
      ['product_id に記号', { product_id: 'P 01', product_name: 'A' }, 'product_id'],
      ['product_name が数値', { product_id: 'P1', product_name: 123 }, 'product_name'],
      ['product_name が未指定', { product_id: 'P1' }, 'product_name'],
      ['product_name が空白のみ', { product_id: 'P1', product_name: '   ' }, 'product_name'],
      ['product_name が 101 文字', { product_id: 'P1', product_name: 'あ'.repeat(101) }, 'product_name'],
      ['product_name が null', { product_id: 'P1', product_name: null }, 'product_name'],
      ['stock が文字列', { product_id: 'P1', product_name: 'A', stock: '10' }, 'stock'],
      ['stock が小数', { product_id: 'P1', product_name: 'A', stock: 1.5 }, 'stock'],
      ['stock が負数', { product_id: 'P1', product_name: 'A', stock: -1 }, 'stock'],
      ['stock が INT_MAX 超過', { product_id: 'P1', product_name: 'A', stock: INT_MAX + 1 }, 'stock'],
      ['stock が null', { product_id: 'P1', product_name: 'A', stock: null }, 'stock'],
      ['stock が真偽値', { product_id: 'P1', product_name: 'A', stock: true }, 'stock'],
    ])('%s', async (_label, body, field) => {
      const res = await request(app).post('/products').send(body);

      expectErrorShape(res, 400);
      expect(res.body.error.message).toBe('入力内容に誤りがあります');
      expectDetailField(res, field);
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('{} を送ると product_id と product_name の両方がエラーになる', async () => {
      const res = await request(app).post('/products').send({});

      expectErrorShape(res, 400);
      const fields = res.body.error.details.map((d) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['product_id', 'product_name']));
      expect(fields).not.toContain('stock');
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('body が配列なら 400 を返す', async () => {
      const res = await request(app).post('/products').send([{ product_id: 'P1' }]);

      expectErrorShape(res, 400);
      expectDetailField(res, 'body');
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('壊れた JSON は 400 を返す', async () => {
      const res = await request(app)
        .post('/products')
        .set('Content-Type', 'application/json')
        .send('{"product_id": "P1", ');

      expectErrorShape(res, 400);
      expect(res.body.error.message).toBe('リクエストボディの JSON が不正です');
      expectDetailField(res, 'body');
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('トップレベルが文字列の JSON は 400 を返す（strict モード）', async () => {
      const res = await request(app)
        .post('/products')
        .set('Content-Type', 'application/json')
        .send('"P001"');

      expectErrorShape(res, 400);
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('Content-Type が application/json でなければ 400 を返す', async () => {
      const res = await request(app)
        .post('/products')
        .set('Content-Type', 'text/plain')
        .send('product_id=P1');

      expectErrorShape(res, 400);
      expectDetailField(res, 'body');
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  test('未対応の文字コード（charset=foo）は 415 を返し、メッセージに入力値を含めない', async () => {
    const res = await request(app)
      .post('/products')
      .set('Content-Type', 'application/json; charset=foo-evil')
      .send('{"product_id":"P1","product_name":"A"}');

    expectErrorShape(res, 415);
    expect(res.body.error.message).toBe('対応していない文字コードまたは圧縮形式です。UTF-8 の JSON を送信してください');
    // body-parser の err.message（unsupported charset "FOO-EVIL"）をそのまま返さない
    const raw = JSON.stringify(res.body).toLowerCase();
    expect(raw).not.toContain('foo');
    expect(raw).not.toContain('unsupported');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('解析できない Content-Type は 400 を返し、メッセージにヘッダーの値を含めない', async () => {
    const res = await request(app)
      .post('/products')
      .set('Content-Type', 'application/json; charset=<script>')
      .send('{"product_id":"P1","product_name":"A"}');

    expectErrorShape(res, 400);
    expect(JSON.stringify(res.body)).not.toContain('script');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('未対応の Content-Encoding も 415 を固定メッセージで返す', async () => {
    const res = await request(app)
      .post('/products')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'x-evil')
      .send('{"product_id":"P1","product_name":"A"}');

    expectErrorShape(res, 415);
    expect(JSON.stringify(res.body)).not.toContain('x-evil');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('ボディが 10kb を超えると 413 を返す', async () => {
    const res = await request(app)
      .post('/products')
      .send({ product_id: 'P1', product_name: 'x'.repeat(11 * 1024) });

    expectErrorShape(res, 413);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('商品ID が重複（23505）なら 409 を返す', async () => {
    const dupError = Object.assign(new Error('duplicate key value violates unique constraint "m_products_pkey"'), {
      code: '23505',
      constraint: 'm_products_pkey',
    });
    pool.query.mockRejectedValueOnce(dupError);

    const res = await request(app)
      .post('/products')
      .send({ product_id: 'P001', product_name: 'ボールペン' });

    expectErrorShape(res, 409);
    expect(res.body.error.message).toBe('この商品IDは既に登録されています');
    expectDetailField(res, 'product_id');
    // 制約名などスキーマ内部の情報は返さない
    expect(JSON.stringify(res.body)).not.toContain('m_products_pkey');
  });

  test('対応表にある DB エラー（23514 チェック制約違反）は 400 に変換される', async () => {
    pool.query.mockRejectedValueOnce(Object.assign(new Error('check violation'), {
      code: '23514',
      constraint: 'chk_stock',
    }));

    const res = await request(app)
      .post('/products')
      .send({ product_id: 'P001', product_name: 'ボールペン' });

    expectErrorShape(res, 400);
    expect(JSON.stringify(res.body)).not.toContain('chk_stock');
    expect(console.warn).toHaveBeenCalled();
  });

  test('想定外の DB エラーは 500 を返し、詳細を含めない', async () => {
    pool.query.mockRejectedValueOnce(Object.assign(new Error('relation "m_products" does not exist'), {
      code: '42P01',
    }));

    const res = await request(app)
      .post('/products')
      .send({ product_id: 'P001', product_name: 'ボールペン' });

    expectErrorShape(res, 500);
    expect(res.body.error.message).toBe('サーバー内部でエラーが発生しました');
    expect(JSON.stringify(res.body)).not.toContain('relation');
    expect(JSON.stringify(res.body)).not.toContain('42P01');
  });
});

describe('PUT /products/:id（商品更新）', () => {
  test('商品名のみの部分更新では stock / threshold を更新しない', async () => {
    const updated = { ...productA, product_name: '赤ボールペン' };
    pool.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const res = await request(app).put('/products/P001').send({ product_name: ' 赤ボールペン ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: updated });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toEqual(expect.stringContaining('UPDATE m_products'));
    expect(sql).toEqual(expect.stringContaining('product_name = $1'));
    expect(sql).not.toEqual(expect.stringContaining('stock ='));
    expect(sql).not.toEqual(expect.stringContaining('threshold ='));
    expect(params).toEqual(['赤ボールペン', 'P001']);
  });

  test('stock のみ更新すると threshold も再計算される（10未満 → 1）', async () => {
    const updated = { ...productA, stock: 5, threshold: '1' };
    pool.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const res = await request(app).put('/products/P001').send({ stock: 5 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: updated });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toEqual(expect.stringContaining('threshold = $2'));
    expect(params).toEqual([5, '1', 'P001']);
  });

  test('stock を 10 以上に更新すると threshold は 0 になる', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productA], rowCount: 1 });

    const res = await request(app).put('/products/P002').send({ stock: 10 });

    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual([10, '0', 'P002']);
  });

  test('商品名と stock を同時に更新できる', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productA], rowCount: 1 });

    const res = await request(app).put('/products/P001').send({ product_name: '新名称', stock: 0 });

    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual(['新名称', 0, '1', 'P001']);
  });

  test('body の threshold と product_id は無視される', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productA], rowCount: 1 });

    const res = await request(app)
      .put('/products/P001')
      .send({ stock: 50, threshold: '1', product_id: 'HACK' });

    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[0];
    expect(params).toEqual([50, '0', 'P001']);
    expect(params).not.toContain('HACK');
    // SET 句に product_id が含まれないこと（WHERE 句の product_id は除く）
    expect(sql.split('WHERE')[0]).not.toContain('product_id');
  });

  test('商品が存在しなければ 404 を返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).put('/products/NOPE').send({ stock: 1 });

    expectErrorShape(res, 404);
    expect(res.body.error.message).toBe('商品が見つかりません');
  });

  describe('バリデーションエラー（400）', () => {
    test('{} を送ると 400 を返す（更新項目が1つもない）', async () => {
      const res = await request(app).put('/products/P001').send({});

      expectErrorShape(res, 400);
      expectDetailField(res, 'body');
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('threshold のみを送っても更新項目なしとして 400 を返す', async () => {
      const res = await request(app).put('/products/P001').send({ threshold: '1' });

      expectErrorShape(res, 400);
      expectDetailField(res, 'body');
      expect(pool.query).not.toHaveBeenCalled();
    });

    test.each([
      ['stock が文字列', { stock: '5' }, 'stock'],
      ['stock が負数', { stock: -1 }, 'stock'],
      ['stock が小数', { stock: 0.5 }, 'stock'],
      ['stock が INT_MAX 超過', { stock: INT_MAX + 1 }, 'stock'],
      ['stock が null', { stock: null }, 'stock'],
      ['product_name が空文字', { product_name: '' }, 'product_name'],
      ['product_name が 101 文字', { product_name: 'a'.repeat(101) }, 'product_name'],
      ['product_name が配列', { product_name: ['a'] }, 'product_name'],
    ])('%s', async (_label, body, field) => {
      const res = await request(app).put('/products/P001').send(body);

      expectErrorShape(res, 400);
      expectDetailField(res, field);
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('ID の形式が不正なら 400 を返す', async () => {
      const res = await request(app).put('/products/ABCDEFGHIJK').send({ stock: 1 });

      expectErrorShape(res, 400);
      expectDetailField(res, 'id');
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('壊れた JSON は 400 を返す', async () => {
      const res = await request(app)
        .put('/products/P001')
        .set('Content-Type', 'application/json')
        .send('{stock: 1}');

      expectErrorShape(res, 400);
      expect(res.body.error.message).toBe('リクエストボディの JSON が不正です');
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('body が配列なら 400 を返す', async () => {
      const res = await request(app).put('/products/P001').send([]);

      expectErrorShape(res, 400);
      expectDetailField(res, 'body');
    });
  });

  test('DB エラー時は 500 を返し、詳細を含めない', async () => {
    pool.query.mockRejectedValueOnce(new Error('deadlock internal detail'));

    const res = await request(app).put('/products/P001').send({ stock: 1 });

    expectErrorShape(res, 500);
    expect(JSON.stringify(res.body)).not.toContain('deadlock internal detail');
  });
});

describe('DELETE /products/:id（商品削除）', () => {
  test('削除に成功すると 204 を返し、ボディは空', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete('/products/P001');

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM m_products'), ['P001']);
  });

  test('商品が存在しなければ 404 を返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete('/products/NOPE');

    expectErrorShape(res, 404);
    expect(res.body.error.message).toBe('商品が見つかりません');
  });

  test('入出庫履歴がある商品（23503）は 409 を返す', async () => {
    pool.query.mockRejectedValueOnce(Object.assign(new Error('violates foreign key constraint "fk_tx_product"'), {
      code: '23503',
      constraint: 'fk_tx_product',
    }));

    const res = await request(app).delete('/products/P001');

    expectErrorShape(res, 409);
    expect(res.body.error.message).toBe('入出庫履歴が存在するため、この商品は削除できません');
    expect(JSON.stringify(res.body)).not.toContain('fk_tx_product');
  });

  test('ID の形式が不正なら 400 を返し、DB に問い合わせない', async () => {
    const res = await request(app).delete('/products/P-01!');

    expectErrorShape(res, 400);
    expectDetailField(res, 'id');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('DB エラー時は 500 を返し、詳細を含めない', async () => {
    pool.query.mockRejectedValueOnce(new Error('disk full at /var/lib/postgresql'));

    const res = await request(app).delete('/products/P001');

    expectErrorShape(res, 500);
    expect(JSON.stringify(res.body)).not.toContain('/var/lib/postgresql');
  });
});

describe('共通の挙動', () => {
  test('存在しないパスは 404 を共通形式で返し、メッセージにパスやメソッドを含めない', async () => {
    const res = await request(app).get('/unknown-path-xyz');

    expectErrorShape(res, 404);
    expect(res.body.error.message).toBe('リソースが見つかりません');
    expect(JSON.stringify(res.body)).not.toContain('unknown-path-xyz');
    expect(JSON.stringify(res.body)).not.toContain('GET');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('X-Powered-By ヘッダを返さない', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/products');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('pool.js をモックしているため pg の Pool は生成されず、実 DB に接続しない', () => {
    expect(jest.isMockFunction(pool.query)).toBe(true);
    expect(jest.isMockFunction(pool.connect)).toBe(true);
    // 実モジュールが読み込まれていれば new Pool() が呼ばれている
    expect(require('pg').Pool).not.toHaveBeenCalled();
  });

});

describe('予約語 alerts を商品IDに使えないこと', () => {
  test.each(['alerts', 'ALERTS', 'Alerts', 'aLeRtS'])(
    'POST /products の product_id "%s" は 400 を返し、DB に登録しない',
    async (productId) => {
      const res = await request(app)
        .post('/products')
        .send({ product_id: productId, product_name: 'テスト', stock: 1 });

      expectErrorShape(res, 400);
      expect(res.body.error.message).toBe('入力内容に誤りがあります');
      expectDetailField(res, 'product_id');
      expect(res.body.error.details[0].message).toEqual(expect.stringContaining('予約語'));
      expect(pool.query).not.toHaveBeenCalled();
    }
  );

  test('alerts を含むだけの商品ID（alerts1 / my-alerts）は登録できる', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    const res1 = await request(app).post('/products').send({ product_id: 'alerts1', product_name: 'A' });
    const res2 = await request(app).post('/products').send({ product_id: 'my-alerts', product_name: 'B' });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(pool.query.mock.calls[0][1][0]).toBe('alerts1');
    expect(pool.query.mock.calls[1][1][0]).toBe('my-alerts');
  });

  test.each([
    ['PUT', 'alerts'],
    ['PUT', 'ALERTS'],
    ['DELETE', 'alerts'],
    ['DELETE', 'Alerts'],
  ])('%s /products/%s は 400 を返し、DB に問い合わせない', async (method, id) => {
    const req = request(app)[method.toLowerCase()](`/products/${id}`);
    const res = method === 'PUT' ? await req.send({ stock: 1 }) : await req;

    expectErrorShape(res, 400);
    expectDetailField(res, 'id');
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('商品名の制御文字・書式文字（L-3）', () => {
  // 拒否する文字（\p{Cc}: 制御文字、\p{Cf}: 書式文字）
  const forbidden = [
    ['改行（LF）', 'ボール\nペン'],
    ['復帰（CR）', 'ボール\rペン'],
    ['タブ', 'ボール\tペン'],
    ['NUL', 'ボール\u0000ペン'],
    ['DEL', 'ボール\u007Fペン'],
    ['C1 制御文字（U+0085）', 'ボール\u0085ペン'],
    ['右から左への上書き（U+202E, Bidi 制御）', 'abc‮txt.exe'],
    ['Bidi 分離（U+2066）', 'abc⁦def'],
    ['ゼロ幅スペース（U+200B）', 'ボール​ペン'],
    ['ゼロ幅接合子（U+200D）', 'ボール‍ペン'],
    ['BOM（U+FEFF）を先頭に含む', '﻿ボールペン'],
    ['末尾の改行（trim で消える位置でも拒否する）', 'ボールペン\n'],
    ['ソフトハイフン（U+00AD）', 'ボール­ペン'],
  ];

  test.each(forbidden)('POST: %s を含む商品名は 400 を返す', async (_label, name) => {
    const res = await request(app).post('/products').send({ product_id: 'P100', product_name: name });

    expectErrorShape(res, 400);
    expectDetailField(res, 'product_name');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test.each(forbidden)('PUT: %s を含む商品名は 400 を返す', async (_label, name) => {
    const res = await request(app).put('/products/P001').send({ product_name: name });

    expectErrorShape(res, 400);
    expectDetailField(res, 'product_name');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test.each([
    ['全角スペースを含む', 'ボール　ペン'],
    ['半角スペースを含む', 'Ball Pen'],
    ['絵文字（サロゲートペア）', 'ペン✏️🖊'],
    ['記号', 'A&B <C> "D" \'E\''],
  ])('POST: 通常の文字（%s）は登録できる', async (_label, name) => {
    pool.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

    const res = await request(app).post('/products').send({ product_id: 'P101', product_name: name });

    expect(res.status).toBe(201);
    expect(pool.query.mock.calls[0][1][1]).toBe(name.trim());
  });

  test('PUT: 通常の商品名は更新できる', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productA], rowCount: 1 });

    const res = await request(app).put('/products/P001').send({ product_name: '新しい　名前' });

    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual(['新しい　名前', 'P001']);
  });
});
