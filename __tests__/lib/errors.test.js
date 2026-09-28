// fromPgError（DB エラー → HTTP ステータスの変換）の単体テスト
const { fromPgError, ApiError, MSG_DB_BUSY } = require('../../src/lib/errors');

describe('fromPgError', () => {
  test.each([
    ['55P03', 409, '他の処理と競合しました。再度実行してください'],
    ['57014', 503, MSG_DB_BUSY],
    ['2200H', 503, '現在この処理を受け付けられません。管理者に連絡してください'],
    ['40P01', 409, '同時更新が競合しました。再度実行してください'],
  ])('SQLSTATE %s は %i に変換される', (code, status, message) => {
    const result = fromPgError(Object.assign(new Error('internal'), { code }));

    expect(result).toBeInstanceOf(ApiError);
    expect(result.status).toBe(status);
    expect(result.message).toBe(message);
    expect(result.details).toEqual([]);
  });

  test('接続取得のタイムアウトは 503 に変換される', () => {
    expect(fromPgError(new Error('timeout exceeded when trying to connect')).status).toBe(503);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['対応表に無い SQLSTATE', Object.assign(new Error('x'), { code: '42P01' })],
    ['SQLSTATE もタイムアウトのメッセージも無いエラー', new Error('other')],
    ['message が文字列でないオブジェクト', { message: 123 }],
    ['タイムアウトの文言を含むだけの別のメッセージ', new Error('xx timeout exceeded when trying to connect xx')],
  ])('%s は null（500 扱い）', (_label, err) => {
    expect(fromPgError(err)).toBeNull();
  });
});
