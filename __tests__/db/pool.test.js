// DB 接続プールの設定（M-2 タイムアウト / L-6 本番の必須項目と TLS）のテスト
// pg の Pool はモックし、実 DB には接続しない。
jest.mock('pg', () => ({ Pool: jest.fn() }));
// .env の内容に結果が左右されないよう dotenv もモックする
jest.mock('dotenv', () => ({ config: jest.fn() }));

const { Pool } = require('pg');
const {
  buildPoolConfig,
  CONNECTION_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  LOCK_TIMEOUT_MS,
  IDLE_IN_TX_TIMEOUT_MS,
} = require('../../src/db/config');

// 本番で必須の環境変数をすべて設定した env
const PROD_ENV = {
  NODE_ENV: 'production',
  DB_HOST: 'db.example.internal',
  DB_NAME: 'inventory',
  DB_USER: 'inventory_app',
  DB_PASSWORD: 's3cret',
};

describe('buildPoolConfig: 既定値（ローカル開発）', () => {
  test('環境変数が無ければローカル用の既定値とタイムアウト設定を返す', () => {
    const config = buildPoolConfig({});

    expect(config).toEqual({
      host: 'localhost',
      port: 5432,
      database: 'todo_db',
      user: 'todo_user',
      password: '',
      max: 10,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      lock_timeout: LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS,
    });
    // TLS は既定では使わない
    expect(config.ssl).toBeUndefined();
  });

  test('タイムアウト値はすべて 0（無制限）より大きい', () => {
    [CONNECTION_TIMEOUT_MS, IDLE_TIMEOUT_MS, STATEMENT_TIMEOUT_MS, LOCK_TIMEOUT_MS, IDLE_IN_TX_TIMEOUT_MS]
      .forEach((ms) => expect(ms).toBeGreaterThan(0));
    // ロック待ちは SQL 全体の上限より短くし、55P03（409）として区別できるようにする
    expect(LOCK_TIMEOUT_MS).toBeLessThan(STATEMENT_TIMEOUT_MS);
  });

  test('NODE_ENV が production 以外（development / test / 未設定）なら既定値で起動できる', () => {
    expect(() => buildPoolConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => buildPoolConfig({ NODE_ENV: 'test' })).not.toThrow();
  });

  test('環境変数を指定するとその値を使う', () => {
    const config = buildPoolConfig({
      DB_HOST: 'h', DB_PORT: '6543', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p',
    });

    expect(config).toEqual(expect.objectContaining({ host: 'h', port: 6543, database: 'n', user: 'u', password: 'p' }));
  });
});

describe('buildPoolConfig: DB_POOL_MAX', () => {
  test.each([
    ['1', 1],
    ['25', 25],
    ['100', 100],
    ['', 10],
  ])('DB_POOL_MAX=%p なら max=%i', (raw, expected) => {
    expect(buildPoolConfig({ DB_POOL_MAX: raw }).max).toBe(expected);
  });

  test.each(['0', '101', '-1', '1.5', 'abc', ' 5', '1e2'])('DB_POOL_MAX=%p は起動時エラー', (raw) => {
    expect(() => buildPoolConfig({ DB_POOL_MAX: raw })).toThrow('DB_POOL_MAX');
  });

  test.each(['0', '65536', 'abc'])('DB_PORT=%p は起動時エラー', (raw) => {
    expect(() => buildPoolConfig({ DB_PORT: raw })).toThrow('DB_PORT');
  });
});

describe('buildPoolConfig: DB_SSL', () => {
  test('DB_SSL=true なら証明書を検証する TLS 設定になる', () => {
    expect(buildPoolConfig({ DB_SSL: 'true' }).ssl).toEqual({ rejectUnauthorized: true });
  });

  test.each(['false', ''])('DB_SSL=%p なら TLS を使わない', (raw) => {
    expect(buildPoolConfig({ DB_SSL: raw }).ssl).toBeUndefined();
  });

  test.each(['TRUE', 'yes', '1', 'on'])('DB_SSL=%p（true / false 以外）は起動時エラー', (raw) => {
    // 書き間違いで TLS なしのまま起動することを防ぐ
    expect(() => buildPoolConfig({ DB_SSL: raw })).toThrow('DB_SSL');
  });
});

describe('buildPoolConfig: 本番（NODE_ENV=production）の必須項目', () => {
  test('必須の環境変数がそろっていれば起動でき、既定値は使われない', () => {
    const config = buildPoolConfig({ ...PROD_ENV, DB_SSL: 'true' });

    expect(config).toEqual(expect.objectContaining({
      host: 'db.example.internal',
      database: 'inventory',
      user: 'inventory_app',
      password: 's3cret',
      ssl: { rejectUnauthorized: true },
    }));
  });

  test.each(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'])('%s が未設定なら起動時エラー', (name) => {
    const env = { ...PROD_ENV };
    delete env[name];

    expect(() => buildPoolConfig(env)).toThrow(name);
  });

  test('空文字も未設定とみなす（DB_PASSWORD= の書き忘れ）', () => {
    expect(() => buildPoolConfig({ ...PROD_ENV, DB_PASSWORD: '' })).toThrow('DB_PASSWORD');
  });

  test('すべて未設定なら不足している項目をまとめて知らせる', () => {
    expect(() => buildPoolConfig({ NODE_ENV: 'production' }))
      .toThrow('DB_HOST, DB_NAME, DB_USER, DB_PASSWORD');
  });

  test('エラーメッセージにパスワードの値を含めない', () => {
    let message = '';
    try {
      buildPoolConfig({ ...PROD_ENV, DB_HOST: '', DB_PASSWORD: 'should-not-leak' });
    } catch (err) {
      message = err.message;
    }
    expect(message).toContain('DB_HOST');
    expect(message).not.toContain('should-not-leak');
  });
});

describe('pool.js', () => {
  let poolInstance;

  // 環境変数を差し替えて pool.js を新しく読み込む
  function loadPool(env) {
    const saved = { ...process.env };
    Object.keys(process.env).filter((k) => k.startsWith('DB_')).forEach((k) => delete process.env[k]);
    Object.assign(process.env, env);
    try {
      let loaded;
      jest.isolateModules(() => {
        loaded = require('../../src/db/pool');
      });
      return loaded;
    } finally {
      // process.env 自体は差し替えず、キー単位で元に戻す
      Object.keys(process.env).filter((k) => !(k in saved)).forEach((k) => delete process.env[k]);
      Object.assign(process.env, saved);
    }
  }

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    poolInstance = { on: jest.fn(), query: jest.fn() };
    Pool.mockReset();
    // new Pool() の戻り値としてモックのプールを返す
    Pool.mockImplementation(function MockPool() { return poolInstance; });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('buildPoolConfig の設定（タイムアウトを含む）で Pool を生成する', () => {
    const loaded = loadPool({ DB_POOL_MAX: '7' });

    expect(loaded).toBe(poolInstance);
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(Pool.mock.calls[0][0]).toEqual(expect.objectContaining({
      max: 7,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      lock_timeout: LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS,
    }));
  });

  test('本番で必須の環境変数が無ければ読み込み時に例外となり、Pool を生成しない', () => {
    expect(() => loadPool({ NODE_ENV: 'production' })).toThrow('NODE_ENV=production');
    expect(Pool).not.toHaveBeenCalled();
  });

  test('アイドル接続のエラーはログに記録し、プロセスを落とさない', () => {
    loadPool({});
    const [event, handler] = poolInstance.on.mock.calls[0];

    expect(event).toBe('error');
    handler(new Error('terminating connection due to administrator command'));
    expect(console.error).toHaveBeenCalledWith('PostgreSQLアイドル接続エラー:', 'terminating connection due to administrator command');
  });

  test('起動時の接続確認の成功・失敗をログに出す', () => {
    loadPool({});
    const callback = poolInstance.query.mock.calls[0][1];

    callback(null);
    expect(console.log).toHaveBeenCalledWith('PostgreSQL接続成功');
    callback(new Error('ECONNREFUSED'));
    expect(console.error).toHaveBeenCalledWith('PostgreSQL接続エラー:', 'ECONNREFUSED');
  });
});
