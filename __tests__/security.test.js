// セキュリティ関連の共通挙動のテスト
//   - セキュリティヘッダーと CSP（L-2）
//   - Cache-Control: no-store は API にだけ付け、静的ファイルには付けない（L-2）
//   - 画面の HTML・JS・CSS が CSP（'unsafe-inline' なし）で動く書き方になっていること（L-2）
//   - 不正なパーセントエンコードは 400（L-1）
//   - レート制限の 429（M-3）
// DB（src/db/pool）は jest.mock でモックし、実 DB には接続しない。
jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
  end: jest.fn(),
}));
jest.mock('pg', () => ({ Pool: jest.fn() }));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const pool = require('../src/db/pool');
const app = require('../src/index');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const EXPECTED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join(';');

// 画面ファイルと期待する Content-Type
const STATIC_FILES = [
  ['/', 'text/html'],
  ['/index.html', 'text/html'],
  ['/form.html', 'text/html'],
  ['/detail.html', 'text/html'],
  ['/style.css', 'text/css'],
  ['/js/api.js', 'javascript'],
  ['/js/ui.js', 'javascript'],
  ['/js/index.js', 'javascript'],
  ['/js/form.js', 'javascript'],
  ['/js/detail.js', 'javascript'],
];

function expectErrorShape(res, status) {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({
    error: { message: expect.any(String), details: expect.any(Array) },
  });
}

// 共通のセキュリティヘッダーを検証する
function expectSecurityHeaders(res) {
  expect(res.headers['content-security-policy']).toBe(EXPECTED_CSP);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['x-powered-by']).toBeUndefined();
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('セキュリティヘッダー（L-2）', () => {
  test('API の成功レスポンスに CSP・nosniff・Referrer-Policy・no-store が付く', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/products');

    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('CSP に unsafe-inline / unsafe-eval / upgrade-insecure-requests を含めない', async () => {
    const res = await request(app).get('/index.html');

    const csp = res.headers['content-security-policy'];
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    // HTTP で公開した場合に画面の読み込みが壊れないよう、自動 HTTPS 化は指定しない
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  test.each([
    ['400（バリデーションエラー）', (r) => r.post('/products').send({})],
    ['404（存在しないパス）', (r) => r.get('/no-such-api')],
    ['404（商品なし）', (r) => r.delete('/products/NOPE')],
  ])('API のエラーレスポンス %s にもセキュリティヘッダーと no-store が付く', async (_label, send) => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await send(request(app));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expectSecurityHeaders(res);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('500 エラーにもセキュリティヘッダーと no-store が付き、内部情報を含めない', async () => {
    pool.query.mockRejectedValueOnce(new Error('internal secret'));

    const res = await request(app).get('/products');

    expectErrorShape(res, 500);
    expectSecurityHeaders(res);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toContain('internal secret');
  });
});

describe('静的ファイル（画面）の配信', () => {
  test.each(STATIC_FILES)('%s は 200 で返り、セキュリティヘッダーが付き、no-store は付かない', async (file, type) => {
    const res = await request(app).get(file);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toEqual(expect.stringContaining(type));
    expectSecurityHeaders(res);
    expect(res.headers['cache-control'] || '').not.toContain('no-store');
    // 静的ファイルはレート制限の対象外（RateLimit ヘッダーが付かない）
    expect(res.headers.ratelimit).toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('API のレスポンスにはレート制限のヘッダーが付く', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/products');

    expect(res.headers.ratelimit).toEqual(expect.stringContaining('limit='));
  });
});

describe('画面ファイルが CSP（インライン禁止）に適合していること（L-2）', () => {
  const htmlFiles = ['index.html', 'form.html', 'detail.html'];
  const jsFiles = ['api.js', 'ui.js', 'index.js', 'form.js', 'detail.js'].map((f) => path.join('js', f));

  test.each(htmlFiles)('%s にインラインの script / style / style 属性 / イベント属性が無い', (file) => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

    // <script> は src 付きの外部ファイルだけ（本文を持つ <script> が無い）
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
    expect(scripts.length).toBeGreaterThan(0);
    scripts.forEach((tag) => {
      expect(tag).toMatch(/^<script\b[^>]*\bsrc="[^"]+"[^>]*><\/script>$/i);
    });
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    // 外部ドメインのリソースを読み込んでいない（default-src 'self'）
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//i);
  });

  test.each(jsFiles)('%s が eval 系・innerHTML・style 属性の文字列設定を使っていない', (file) => {
    // コメント行は除いて検査する
    const code = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/new\s+Function\s*\(/);
    expect(code).not.toMatch(/set(Timeout|Interval)\s*\(\s*['"`]/);
    expect(code).not.toMatch(/\.innerHTML\b|insertAdjacentHTML|document\.write/);
    // setAttribute('style', ...) は CSP の style-src で拒否されるため使わない
    expect(code).not.toMatch(/setAttribute\(\s*['"]style['"]/);
    expect(code).not.toMatch(/\.style\.cssText/);
  });

  test('style.css が外部リソースを読み込んでいない', () => {
    const css = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');

    expect(css).not.toMatch(/@import/i);
    expect(css).not.toMatch(/url\(\s*['"]?(https?:)?\/\//i);
  });
});

describe('不正なパーセントエンコード（L-1）', () => {
  test.each([
    ['GET', '/products/%E0'],
    ['GET', '/products/%'],
    ['GET', '/products/%ZZ'],
    ['PUT', '/products/%E0'],
    ['DELETE', '/products/%C0%AF'],
    ['GET', '/stock-transactions/%E0'],
  ])('%s %s は 500 ではなく 400 を返す', async (method, url) => {
    const req = request(app)[method.toLowerCase()](url);
    const res = method === 'PUT' ? await req.send({ stock: 1 }) : await req;

    expectErrorShape(res, 400);
    expect(res.body.error.message).toBe('URL の形式が不正です');
    expect(JSON.stringify(res.body)).not.toContain('%E0');
    expect(JSON.stringify(res.body)).not.toContain('decode');
    expect(pool.query).not.toHaveBeenCalled();
    // 想定外のエラー（500）としてログに出ないこと
    expect(console.error).not.toHaveBeenCalled();
  });

  test('正しくエンコードされた ID は従来どおり処理される', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/products/P%30%30%31'); // P001

    expect(res.status).toBe(404);
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ['P001']);
  });

  test('静的ファイル側の不正なエンコード（/%E0）は 404 になる（500 にならない）', async () => {
    const res = await request(app).get('/%E0');

    expectErrorShape(res, 404);
  });
});

describe('レート制限（M-3）', () => {
  // 上限値を小さくしたアプリを別インスタンスとして読み込む
  // （環境変数で上限値を明示した場合はテスト時の緩和よりも優先される）
  function loadAppWithLimits(env) {
    const saved = {};
    Object.keys(env).forEach((key) => {
      saved[key] = process.env[key];
      process.env[key] = env[key];
    });
    const loaded = {};
    try {
      // 同じ隔離レジストリ内の pool モックを取得する（外側の pool とは別インスタンスになる）
      jest.isolateModules(() => {
        loaded.app = require('../src/index');
        loaded.pool = require('../src/db/pool');
      });
    } finally {
      Object.keys(env).forEach((key) => {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      });
    }
    return loaded;
  }

  test('書き込み（POST/PUT/DELETE）が上限を超えると 429 を共通のエラー形式で返す', async () => {
    const { app: limitedApp, pool: limitedPool } = loadAppWithLimits({ RATE_LIMIT_WRITE_MAX: '2', RATE_LIMIT_GLOBAL_MAX: '100' });

    // 上限（2回）までは通常どおり処理される（ここではバリデーションエラーの 400）
    const r1 = await request(limitedApp).post('/products').send({});
    const r2 = await request(limitedApp).put('/products/P001').send({});
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);

    // 3回目の書き込みは 429
    const r3 = await request(limitedApp).delete('/products/P001');
    expectErrorShape(r3, 429);
    expect(r3.body.error.message).toBe('リクエストが多すぎます。しばらく待ってから再度実行してください');
    expect(r3.headers['retry-after']).toBeDefined();
    expect(r3.headers['cache-control']).toBe('no-store');
    expect(r3.headers['content-security-policy']).toBe(EXPECTED_CSP);
    // 429 のときはルートに到達せず、DB にも問い合わせない
    expect(limitedPool.query).not.toHaveBeenCalled();

    // 読み取り（GET）は書き込みの上限の対象外
    limitedPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r4 = await request(limitedApp).get('/products');
    expect(r4.status).toBe(200);
  });

  test('全体の上限を超えると GET も 429 になるが、静的ファイルは制限されない', async () => {
    const { app: limitedApp, pool: limitedPool } = loadAppWithLimits({ RATE_LIMIT_GLOBAL_MAX: '2' });
    limitedPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    expect((await request(limitedApp).get('/products')).status).toBe(200);
    expect((await request(limitedApp).get('/stock-transactions')).status).toBe(200);
    const blocked = await request(limitedApp).get('/products/alerts');
    expectErrorShape(blocked, 429);

    // 静的ファイルはレート制限より前で配信されるため、上限を超えていても 200
    const page = await request(limitedApp).get('/index.html');
    expect(page.status).toBe(200);
    const script = await request(limitedApp).get('/js/api.js');
    expect(script.status).toBe(200);
  });

  test('テスト実行中（NODE_ENV=test かつ jest ワーカー）の既定値では、多数のリクエストでも 429 にならない', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const results = [];
    for (let i = 0; i < 70; i += 1) {
      results.push((await request(app).post('/products').send({})).status);
    }

    // 本番の書き込み上限（60）を超えても 429 にならない
    expect(results).not.toContain(429);
  });
});
