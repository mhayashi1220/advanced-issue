// CSV 出力 API（GET /products/export.csv）のユニットテスト
// DB（src/db/pool）は jest.mock でモックし、実 DB には接続しない（products.test.js と同じ方式）
jest.mock('../../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
  end: jest.fn(),
}));
jest.mock('pg', () => ({ Pool: jest.fn() }));

const http = require('http');
const request = require('supertest');
const pool = require('../../src/db/pool');
const app = require('../../src/index');
const { formatDateYmd } = require('../../src/lib/csv');

const EXPORT_PATH = '/products/export.csv';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const HEADER_LINE = '商品ID,商品名,在庫数,在庫アラート';

const productA = { product_id: 'P001', product_name: 'ボールペン', stock: 20, threshold: '0' };
const productB = { product_id: 'P002', product_name: 'ノート', stock: 3, threshold: '1' };

// レスポンス本文を加工せずに Buffer で受け取る（BOM の有無を正確に検証するため）
function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function getCsv(path = EXPORT_PATH) {
  return request(app).get(path).buffer(true).parse(binaryParser);
}

// BOM を除いた本文を CRLF で行に分割する（末尾の空要素は除く）
function csvLines(body) {
  const text = body.subarray(BOM.length).toString('utf8');
  expect(text.endsWith('\r\n')).toBe(true);
  return text.slice(0, -2).split('\r\n');
}

// n 件の商品を生成する（商品ID昇順）
function makeProducts(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => {
    const num = offset + i + 1;
    return {
      product_id: `P${String(num).padStart(5, '0')}`,
      product_name: `商品${num}`,
      stock: num % 20,
      threshold: num % 20 < 10 ? '1' : '0',
    };
  });
}

function expectErrorShape(res, status) {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({
    error: { message: expect.any(String), details: expect.any(Array) },
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /products/export.csv（正常系）', () => {
  test('200・text/csv・attachment で BOM 付き CSV を返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productA, productB], rowCount: 2 });

    const res = await getCsv();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="products_\d{8}\.csv"$/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="products_${formatDateYmd()}.csv"`);
    // 先頭が UTF-8 BOM
    expect(res.body.subarray(0, 3)).toEqual(BOM);
    // BOM は1つだけ
    expect(res.body.subarray(3, 6)).not.toEqual(BOM);
  });

  test('ヘッダー行とデータ行を CRLF 区切りで出力し、threshold 1 は「在庫少」・0 は空にする', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productA, productB], rowCount: 2 });

    const res = await getCsv();
    const lines = csvLines(res.body);

    expect(lines).toEqual([
      HEADER_LINE,
      'P001,ボールペン,20,',
      'P002,ノート,3,在庫少',
    ]);
    // 改行は CRLF のみ（単独の LF が無い）
    const text = res.body.toString('utf8');
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  test('日本語が UTF-8 のバイト列として正しく出力される（文字化けしない）', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...productA, product_name: '日本語テスト＿①髙﨑' }], rowCount: 1 });

    const res = await getCsv();

    expect(res.body.includes(Buffer.from('日本語テスト＿①髙﨑', 'utf8'))).toBe(true);
    expect(res.body.includes(Buffer.from(HEADER_LINE, 'utf8'))).toBe(true);
    expect(csvLines(res.body)[1]).toBe('P001,日本語テスト＿①髙﨑,20,');
  });

  test('0件のときはヘッダー行のみを 200 で返す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await getCsv();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.body).toEqual(Buffer.concat([BOM, Buffer.from(`${HEADER_LINE}\r\n`, 'utf8')]));
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('想定外の threshold 値（null 等）は在庫アラート列を空にする', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ ...productA, threshold: null }, { ...productB, threshold: 'X' }],
      rowCount: 2,
    });

    const lines = csvLines((await getCsv()).body);

    expect(lines[1]).toBe('P001,ボールペン,20,');
    expect(lines[2]).toBe('P002,ノート,3,');
  });

  test('カンマ・ダブルクォート・改行を含む商品名は RFC 4180 でエスケープする', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ ...productA, product_name: 'A,"B"\r\nC' }],
      rowCount: 1,
    });

    const text = (await getCsv()).body.subarray(3).toString('utf8');

    expect(text).toBe(`${HEADER_LINE}\r\nP001,"A,""B""\r\nC",20,\r\n`);
  });

  test.each([
    ['=1+1', "'=1+1"],
    ['+SUM(A1)', "'+SUM(A1)"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tX', "'\tX"],
    ['=HYPERLINK("http://evil.example")', '"\'=HYPERLINK(""http://evil.example"")"'],
  ])('数式として解釈されうる商品名 %j は無害化して出力する', async (name, expected) => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...productA, product_name: name }], rowCount: 1 });

    const lines = csvLines((await getCsv()).body);

    expect(lines[1]).toBe(`P001,${expected},20,`);
  });

  test('商品IDが - で始まる場合も無害化する（商品IDの形式は先頭 - を許容するため）', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...productA, product_id: '-1+1' }], rowCount: 1 });

    const lines = csvLines((await getCsv()).body);

    expect(lines[1]).toBe("'-1+1,ボールペン,20,");
  });

  test('出力カラムは4項目のみ（DB が余計なカラムを返しても出力しない）', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        ...productA,
        password: 'SECRET_PASSWORD',
        cost_price: 99999,
        created_by: 'admin@example.com',
      }],
      rowCount: 1,
    });

    const res = await getCsv();
    const text = res.body.toString('utf8');
    const lines = csvLines(res.body);

    expect(text).not.toContain('SECRET_PASSWORD');
    expect(text).not.toContain('99999');
    expect(text).not.toContain('admin@example.com');
    lines.forEach((line) => expect(line.split(',')).toHaveLength(4));
    expect(lines[1]).toBe('P001,ボールペン,20,');
  });

  test('SQL は取得カラムを明示し（SELECT * でない）、値はプレースホルダで渡す', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productA], rowCount: 1 });

    await getCsv();

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(sql).toMatch(/SELECT\s+product_id,\s*product_name,\s*stock,\s*threshold\s+FROM\s+m_products/i);
    expect(sql).toMatch(/ORDER BY product_id/);
    expect(sql).toMatch(/LIMIT \$1/);
    expect(params).toEqual([1000]);
  });

  test('クエリパラメータは無視し、SQL にも埋め込まない', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productA], rowCount: 1 });
    const injection = "' OR 1=1; DROP TABLE m_products;--";

    const res = await getCsv(`${EXPORT_PATH}?limit=abc&after=${encodeURIComponent(injection)}&threshold=1`);

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('DROP');
    expect(sql).not.toContain('OR 1=1');
    expect(params).toEqual([1000]);
  });
});

describe('GET /products/export.csv（ページング）', () => {
  test('1000件ちょうどのときは次のバッチを取得し、0件で終了する', async () => {
    const batch1 = makeProducts(1000);
    pool.query
      .mockResolvedValueOnce({ rows: batch1, rowCount: 1000 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await getCsv();
    const lines = csvLines(res.body);

    expect(res.status).toBe(200);
    expect(lines).toHaveLength(1 + 1000);
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [sql2, params2] = pool.query.mock.calls[1];
    expect(sql2).toMatch(/WHERE product_id > \$1 ORDER BY product_id LIMIT \$2/);
    expect(params2).toEqual(['P01000', 1000]);
  });

  test('1000件を超えるとキーセットで続きを取得し、全件を順に出力する（2500件）', async () => {
    const all = makeProducts(2500);
    pool.query
      .mockResolvedValueOnce({ rows: all.slice(0, 1000), rowCount: 1000 })
      .mockResolvedValueOnce({ rows: all.slice(1000, 2000), rowCount: 1000 })
      .mockResolvedValueOnce({ rows: all.slice(2000), rowCount: 500 });

    const res = await getCsv();
    const lines = csvLines(res.body);

    expect(res.status).toBe(200);
    expect(lines).toHaveLength(1 + 2500);
    expect(lines[0]).toBe(HEADER_LINE);
    expect(lines[1]).toBe('P00001,商品1,1,在庫少');
    expect(lines[1000]).toBe('P01000,商品1000,0,在庫少');
    expect(lines[1001]).toBe('P01001,商品1001,1,在庫少');
    expect(lines[2500]).toBe('P02500,商品2500,0,在庫少');
    // 重複・欠落がない
    const ids = lines.slice(1).map((l) => l.split(',')[0]);
    expect(new Set(ids).size).toBe(2500);

    // 最後のバッチが 1000 件未満のため 3 回で終了する
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query.mock.calls[0][1]).toEqual([1000]);
    expect(pool.query.mock.calls[1][1]).toEqual(['P01000', 1000]);
    expect(pool.query.mock.calls[2][1]).toEqual(['P02000', 1000]);
    // 2回目以降も直前バッチ最後の ID をプレースホルダで渡す（SQL に値を埋め込まない）
    pool.query.mock.calls.slice(1).forEach(([sql]) => {
      expect(sql).not.toContain('P0');
      expect(sql).toMatch(/product_id > \$1/);
    });
  });
});

describe('GET /products/export.csv（異常系）', () => {
  test('最初の DB 取得で失敗した場合は共通の JSON エラー（500）を返し、内部情報を含めない', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused: secret-host:5432 password=xxx'));

    const res = await request(app).get(EXPORT_PATH);

    expectErrorShape(res, 500);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body.error.message).toBe('サーバー内部でエラーが発生しました');
    expect(res.body.error.details).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host|password|connection refused/);
  });

  test('最初の DB 取得が statement_timeout（57014）の場合は 503 を JSON で返す', async () => {
    pool.query.mockRejectedValueOnce(Object.assign(new Error('canceling statement'), { code: '57014' }));

    const res = await request(app).get(EXPORT_PATH);

    expectErrorShape(res, 503);
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  test('出力開始後の DB エラーでは接続を切断する（途中までの CSV を正常終了させない）', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: makeProducts(1000), rowCount: 1000 })
      .mockRejectedValueOnce(new Error('boom'));

    await expect(getCsv()).rejects.toThrow();
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[CSV] GET /products/export.csv'),
      expect.any(Error)
    );
  });

  test.each([
    '/products/EXPORT.CSV',
    '/products/Export.csv',
    '/products/export.CSV',
  ])('%s は CSV 出力にならず、商品IDの形式エラー（400）になる（DB に問い合わせない）', async (path) => {
    const res = await request(app).get(path);

    expectErrorShape(res, 400);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('/products/export は商品ID "export" の詳細取得として扱われる（CSV にならない）', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/products/export');

    expectErrorShape(res, 404);
    expect(pool.query.mock.calls[0][1]).toEqual(['export']);
  });

  test.each(['post', 'put', 'delete'])('%s /products/export.csv は CSV を返さない', async (method) => {
    const res = await request(app)[method](EXPORT_PATH).send({ stock: 1 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    // POST は該当ルートなし（404）、PUT/DELETE は商品IDの形式エラー（400）となり、DB 更新は発生しない
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('GET /products/export.csv（セキュリティヘッダー）', () => {
  test('Cache-Control: no-store・nosniff・CSP・レート制限ヘッダーが付く', async () => {
    pool.query.mockResolvedValueOnce({ rows: [productA], rowCount: 1 });

    const res = await getCsv();

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toEqual(expect.stringContaining("default-src 'self'"));
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers.ratelimit).toEqual(expect.stringContaining('limit='));
  });
});

describe('GET /products/export.csv（クライアント切断）', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  // console.info に [CSV] の切断ログが出る（= ハンドラが終了した）まで待つ
  function waitForCsvLog(timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const found = console.info.mock.calls.some(([msg]) => typeof msg === 'string' && msg.startsWith('[CSV]'));
        if (found) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error('CSV handler did not finish (hang)'));
        }
      }, 10);
    });
  }

  test('次バッチ取得中にクライアントが切断しても、ハンドラがハングせずに終了する', async () => {
    let resolveSecond;
    const secondBatch = new Promise((resolve) => { resolveSecond = resolve; });
    pool.query
      .mockResolvedValueOnce({ rows: makeProducts(1000), rowCount: 1000 })
      .mockReturnValueOnce(secondBatch)
      .mockResolvedValue({ rows: [], rowCount: 0 });

    await new Promise((resolve) => {
      const req = http.get(`${baseUrl}${EXPORT_PATH}`, (res) => {
        res.once('data', () => {
          // 1バッチ目を受信したら切断し、その後で2バッチ目の取得を完了させる
          req.destroy();
          setTimeout(() => {
            resolveSecond({ rows: makeProducts(1000, 1000), rowCount: 1000 });
            resolve();
          }, 50);
        });
      });
      req.on('error', () => {});
    });

    await waitForCsvLog();
    // 切断後はそれ以上 DB に問い合わせない
    expect(pool.query).toHaveBeenCalledTimes(2);
    // ダウンロードのキャンセル（クライアント切断）はエラーとして記録しない
    expect(console.error).not.toHaveBeenCalled();
  });

  test('送信バッファが一杯（drain 待ち）の間にクライアントが切断しても、ハンドラが終了する', async () => {
    // 1行が大きい商品を返し、書き込みがバックプレッシャーで待ちになるようにする
    const big = 'あ'.repeat(3000);
    const rows = makeProducts(1000).map((p) => ({ ...p, product_name: big }));
    pool.query
      .mockResolvedValueOnce({ rows, rowCount: 1000 })
      .mockResolvedValue({ rows, rowCount: 1000 });

    await new Promise((resolve) => {
      const req = http.get(`${baseUrl}${EXPORT_PATH}`, (res) => {
        // 読み取りを止めてバッファを溢れさせてから切断する
        res.pause();
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 100);
      });
      req.on('error', () => {});
    });

    await waitForCsvLog();
    // ダウンロードのキャンセル（クライアント切断）はエラーとして記録しない
    expect(console.error).not.toHaveBeenCalled();
  });
});
