// レート制限の設定値（M-3）のテスト
// テスト時だけ上限を緩める仕組みが、本番では効かないことを確認する。
const {
  isTestRuntime,
  resolveRateLimitConfig,
  createRateLimiters,
  DEFAULT_GLOBAL_MAX,
  DEFAULT_WRITE_MAX,
  TEST_RUNTIME_MAX,
  WINDOW_MS,
} = require('../../src/lib/rateLimit');

describe('既定の上限値', () => {
  test('全体 300 / 書き込み 60（1分あたり）', () => {
    expect(DEFAULT_GLOBAL_MAX).toBe(300);
    expect(DEFAULT_WRITE_MAX).toBe(60);
    expect(WINDOW_MS).toBe(60 * 1000);
  });
});

describe('isTestRuntime', () => {
  test('NODE_ENV=test かつ JEST_WORKER_ID があるときだけ true', () => {
    expect(isTestRuntime({ NODE_ENV: 'test', JEST_WORKER_ID: '1' })).toBe(true);
  });

  test.each([
    ['本番', { NODE_ENV: 'production', JEST_WORKER_ID: '1' }],
    ['NODE_ENV 未設定', { JEST_WORKER_ID: '1' }],
    ['NODE_ENV=test でも jest 以外のプロセス（誤設定の本番）', { NODE_ENV: 'test' }],
    ['JEST_WORKER_ID が空文字', { NODE_ENV: 'test', JEST_WORKER_ID: '' }],
    ['大文字の TEST', { NODE_ENV: 'TEST', JEST_WORKER_ID: '1' }],
  ])('%s では false', (_label, env) => {
    expect(isTestRuntime(env)).toBe(false);
  });

  test('このテスト自体は jest 上で NODE_ENV=test として動いている', () => {
    expect(isTestRuntime(process.env)).toBe(true);
  });
});

describe('resolveRateLimitConfig', () => {
  test('本番（NODE_ENV=production）では既定値 300 / 60 を使う', () => {
    expect(resolveRateLimitConfig({ NODE_ENV: 'production' })).toEqual({
      windowMs: WINDOW_MS, globalMax: 300, writeMax: 60,
    });
  });

  test('NODE_ENV=test を誤って本番に設定しても、jest 以外では緩和されない', () => {
    expect(resolveRateLimitConfig({ NODE_ENV: 'test' })).toEqual({
      windowMs: WINDOW_MS, globalMax: 300, writeMax: 60,
    });
  });

  test('jest のテスト実行中は上限を大きくする', () => {
    expect(resolveRateLimitConfig({ NODE_ENV: 'test', JEST_WORKER_ID: '3' })).toEqual({
      windowMs: WINDOW_MS, globalMax: TEST_RUNTIME_MAX, writeMax: TEST_RUNTIME_MAX,
    });
  });

  test('環境変数で上限値を指定するとその値を使う（テスト実行中でも優先する）', () => {
    expect(resolveRateLimitConfig({ RATE_LIMIT_GLOBAL_MAX: '1000', RATE_LIMIT_WRITE_MAX: '120' }))
      .toEqual({ windowMs: WINDOW_MS, globalMax: 1000, writeMax: 120 });
    expect(resolveRateLimitConfig({ NODE_ENV: 'test', JEST_WORKER_ID: '1', RATE_LIMIT_WRITE_MAX: '5' }))
      .toEqual({ windowMs: WINDOW_MS, globalMax: TEST_RUNTIME_MAX, writeMax: 5 });
  });

  test('空文字は未設定として既定値を使う', () => {
    expect(resolveRateLimitConfig({ RATE_LIMIT_GLOBAL_MAX: '', RATE_LIMIT_WRITE_MAX: '' }).globalMax).toBe(300);
  });

  test.each(['0', '-1', 'abc', '1.5', '10000000', ' 60'])('上限値 %p は起動時エラー', (raw) => {
    expect(() => resolveRateLimitConfig({ RATE_LIMIT_GLOBAL_MAX: raw })).toThrow('RATE_LIMIT_GLOBAL_MAX');
    expect(() => resolveRateLimitConfig({ RATE_LIMIT_WRITE_MAX: raw })).toThrow('RATE_LIMIT_WRITE_MAX');
  });
});

describe('createRateLimiters', () => {
  test('全体用・書き込み用のミドルウェアと設定値を返す', () => {
    const { globalLimiter, writeLimiter, config } = createRateLimiters({ NODE_ENV: 'production' });

    expect(typeof globalLimiter).toBe('function');
    expect(typeof writeLimiter).toBe('function');
    expect(config).toEqual({ windowMs: WINDOW_MS, globalMax: 300, writeMax: 60 });
  });
});
