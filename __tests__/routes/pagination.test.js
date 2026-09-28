// 一覧 API のページング（M-1）のテスト
//   対象: GET /products, GET /products/alerts, GET /stock-transactions
//   レスポンス: { data: [...], meta: { limit, next_after } }
//   limit : 1〜500 の整数（既定 100）。文字列 /^[0-9]{1,3}$/ に一致するものだけ受け付ける
//   after : 直前のページ末尾のキー（/products 系は商品ID、/stock-transactions は履歴ID）
// DB（src/db/pool）は jest.mock でモックし、実 DB には接続しない。
jest.mock('../../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
  end: jest.fn(),
}));
jest.mock('pg', () => ({ Pool: jest.fn() }));

const request = require('supertest');
const pool = require('../../src/db/pool');
const app = require('../../src/index');

// エラーレスポンスの共通形式を検証するヘルパー
function expectErrorShape(res, status) {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({
    error: { message: expect.any(String), details: expect.any(Array) },
  });
}

// details に含まれる field の一覧
function detailFields(res) {
  return res.body.error.details.map((d) => d.field);
}

// n 件の商品行を生成する（商品ID: P0001, P0002, ...）
function makeProducts(n, start = 1) {
  return Array.from({ length: n }, (_, i) => {
    const no = String(start + i).padStart(4, '0');
    return { product_id: `P${no}`, product_name: `商品${no}`, stock: 5, threshold: '1' };
  });
}

// n 件の履歴行を生成する（履歴ID: R000000001, ...）
function makeTransactions(n, start = 1) {
  return Array.from({ length: n }, (_, i) => ({
    rireki_id: `R${String(start + i).padStart(9, '0')}`,
    product_id: 'P001',
    transaction_type: '0',
    quantity: 1,
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// 3つの一覧 API の共通設定
//   extraParams: limit / after より前に渡る SQL パラメータ
//   makeRows   : テスト用の行を生成する関数
//   key        : キーセットに使う列名
//   validAfter / invalidAfter: after の妥当な値・不正な値
const endpoints = [
  {
    name: 'GET /products',
    path: '/products',
    extraParams: [],
    makeRows: makeProducts,
    key: 'product_id',
    validAfter: 'P0100',
    afterSql: 'product_id > $1',
    otherKeyFormat: 'R000000001x', // 11文字（商品IDの形式外）
  },
  {
    name: 'GET /products/alerts',
    path: '/products/alerts',
    extraParams: ['1'],
    makeRows: makeProducts,
    key: 'product_id',
    validAfter: 'P0100',
    afterSql: 'threshold = $1 AND product_id > $2',
    otherKeyFormat: 'P.01',
  },
  {
    name: 'GET /stock-transactions',
    path: '/stock-transactions',
    extraParams: [],
    makeRows: makeTransactions,
    key: 'rireki_id',
    validAfter: 'R000000100',
    afterSql: 'rireki_id > $1',
    otherKeyFormat: 'P001', // 商品IDの形式は履歴IDとしては不正
  },
];

describe.each(endpoints)('$name のページング', (ep) => {
  describe('limit', () => {
    test('省略時は limit=100 とし、次ページ判定のため 101 件を要求する', async () => {
      pool.query.mockResolvedValueOnce({ rows: ep.makeRows(3), rowCount: 3 });

      const res = await request(app).get(ep.path);

      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ limit: 100, next_after: null });
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toEqual(expect.stringMatching(/LIMIT \$\d+\s*$/));
      expect(params).toEqual([...ep.extraParams, 101]);
    });

    test.each([
      ['1', 1],
      ['500', 500],
      ['007', 7],
      ['100', 100],
    ])('limit=%s（受け付ける値）は limit=%i として扱う', async (raw, expected) => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app).get(`${ep.path}?limit=${raw}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], meta: { limit: expected, next_after: null } });
      expect(pool.query.mock.calls[0][1]).toEqual([...ep.extraParams, expected + 1]);
    });

    test.each([
      ['0（下限未満）', 'limit=0'],
      ['501（上限超過）', 'limit=501'],
      ['999', 'limit=999'],
      ['4桁（1000）', 'limit=1000'],
      ['4桁のゼロ埋め（0100）', 'limit=0100'],
      ['負数', 'limit=-1'],
      ['小数', 'limit=1.5'],
      ['指数表記', 'limit=1e2'],
      ['英字', 'limit=abc'],
      ['空文字', 'limit='],
      ['前後に空白', 'limit=%2010'],
      ['全角数字', `limit=${encodeURIComponent('１０')}`],
      ['配列（パラメータ汚染）', 'limit=10&limit=20'],
      ['配列（[] 記法）', 'limit[]=10'],
      ['オブジェクト', 'limit[a]=10'],
    ])('limit が不正（%s）なら 400 を返し、DB に問い合わせない', async (_label, qs) => {
      const res = await request(app).get(`${ep.path}?${qs}`);

      expectErrorShape(res, 400);
      expect(detailFields(res)).toContain('limit');
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe('after', () => {
    test('after を指定すると、そのキーより後ろ（キーの昇順）を取得する', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app).get(`${ep.path}?after=${ep.validAfter}&limit=10`);

      expect(res.status).toBe(200);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toEqual(expect.stringContaining(`WHERE ${ep.afterSql}`));
      expect(sql).toEqual(expect.stringContaining(`ORDER BY ${ep.key}`));
      // after の値は SQL に埋め込まず、プレースホルダで渡す
      expect(sql).not.toContain(ep.validAfter);
      expect(params).toEqual([...ep.extraParams, ep.validAfter, 11]);
    });

    test.each([
      ['空文字', 'after='],
      ['形式外の値', `after=${ep.otherKeyFormat}`],
      ['SQL を含む', `after=${encodeURIComponent("P001' OR '1'='1")}`],
      ['配列（パラメータ汚染）', `after=${ep.validAfter}&after=${ep.validAfter}`],
      ['配列（[] 記法）', `after[]=${ep.validAfter}`],
      ['オブジェクト', `after[gt]=${ep.validAfter}`],
    ])('after が不正（%s）なら 400 を返し、DB に問い合わせない', async (_label, qs) => {
      const res = await request(app).get(`${ep.path}?${qs}`);

      expectErrorShape(res, 400);
      expect(detailFields(res)).toContain('after');
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('limit と after が両方不正なら、両方のエラーを返す', async () => {
      const res = await request(app).get(`${ep.path}?limit=0&after=`);

      expectErrorShape(res, 400);
      expect(detailFields(res)).toEqual(expect.arrayContaining(['limit', 'after']));
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe('meta.next_after', () => {
    test('limit + 1 件取得できた場合は limit 件だけ返し、next_after に末尾のキーを入れる', async () => {
      const rows = ep.makeRows(4); // limit=3 に対して 4 件
      pool.query.mockResolvedValueOnce({ rows, rowCount: 4 });

      const res = await request(app).get(`${ep.path}?limit=3`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(rows.slice(0, 3));
      expect(res.body.meta).toEqual({ limit: 3, next_after: rows[2][ep.key] });
    });

    test('ちょうど limit 件の場合は次のページが無いので next_after は null', async () => {
      const rows = ep.makeRows(3);
      pool.query.mockResolvedValueOnce({ rows, rowCount: 3 });

      const res = await request(app).get(`${ep.path}?limit=3`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(rows);
      expect(res.body.meta).toEqual({ limit: 3, next_after: null });
    });

    test('limit 未満の場合も next_after は null', async () => {
      const rows = ep.makeRows(1);
      pool.query.mockResolvedValueOnce({ rows, rowCount: 1 });

      const res = await request(app).get(`${ep.path}?limit=3`);

      expect(res.body.data).toEqual(rows);
      expect(res.body.meta.next_after).toBeNull();
    });

    test('0 件の場合は data が空配列で next_after は null', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app).get(ep.path);

      expect(res.body).toEqual({ data: [], meta: { limit: 100, next_after: null } });
    });

    test('上限 limit=500 で 501 件取得できた場合は 500 件と next_after を返す', async () => {
      const rows = ep.makeRows(501);
      pool.query.mockResolvedValueOnce({ rows, rowCount: 501 });

      const res = await request(app).get(`${ep.path}?limit=500`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(500);
      expect(res.body.meta).toEqual({ limit: 500, next_after: rows[499][ep.key] });
    });

    test('next_after を after に渡すと続きのページを取得でき、最後のページでは null になる', async () => {
      const all = ep.makeRows(5);
      // 1ページ目: limit=2 で 3 件（次あり）、2ページ目: 3 件（次あり）、3ページ目: 1 件（最後）
      pool.query
        .mockResolvedValueOnce({ rows: all.slice(0, 3) })
        .mockResolvedValueOnce({ rows: all.slice(2, 5) })
        .mockResolvedValueOnce({ rows: all.slice(4, 5) });

      const page1 = await request(app).get(`${ep.path}?limit=2`);
      const page2 = await request(app).get(`${ep.path}?limit=2&after=${page1.body.meta.next_after}`);
      const page3 = await request(app).get(`${ep.path}?limit=2&after=${page2.body.meta.next_after}`);

      expect(page1.body.data).toEqual(all.slice(0, 2));
      expect(page1.body.meta.next_after).toBe(all[1][ep.key]);
      expect(page2.body.data).toEqual(all.slice(2, 4));
      expect(page2.body.meta.next_after).toBe(all[3][ep.key]);
      expect(page3.body.data).toEqual(all.slice(4, 5));
      expect(page3.body.meta.next_after).toBeNull();
      // 2・3ページ目は直前のページ末尾のキーが after として SQL に渡る
      expect(pool.query.mock.calls[1][1]).toEqual([...ep.extraParams, all[1][ep.key], 3]);
      expect(pool.query.mock.calls[2][1]).toEqual([...ep.extraParams, all[3][ep.key], 3]);
    });
  });
});

describe('GET /stock-transactions の product_id とページングの組み合わせ', () => {
  test('product_id と after を同時に指定すると AND で絞り込む', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/stock-transactions?product_id=P001&after=R000000010&limit=50');

    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toEqual(expect.stringContaining('WHERE product_id = $1 AND rireki_id > $2'));
    expect(sql).toEqual(expect.stringContaining('LIMIT $3'));
    expect(params).toEqual(['P001', 'R000000010', 51]);
  });

  test('product_id が不正なら limit / after の検証より前に 400 を返す', async () => {
    const res = await request(app).get('/stock-transactions?product_id=P%3B01&limit=10');

    expectErrorShape(res, 400);
    expect(detailFields(res)).toEqual(['product_id']);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
