// CSV 出力ヘルパー（src/lib/csv.js）のユニットテスト
// DB には依存しないため、モックは不要

const {
  UTF8_BOM,
  CRLF,
  neutralizeFormula,
  escapeCsvValue,
  toCsvRow,
  formatDateYmd,
} = require('../../src/lib/csv');

describe('定数', () => {
  test('UTF8_BOM は U+FEFF の1文字で、UTF-8 では EF BB BF になる', () => {
    expect(UTF8_BOM).toBe('﻿');
    expect(Buffer.from(UTF8_BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  test('CRLF は \\r\\n', () => {
    expect(CRLF).toBe('\r\n');
  });
});

describe('neutralizeFormula（数式インジェクション対策）', () => {
  test.each([
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@SUM(A1:A2)', "'@SUM(A1:A2)"],
    ['\tTAB', "'\tTAB"],
    ['\rCR', "'\rCR"],
    ['=HYPERLINK("http://evil.example","x")', '\'=HYPERLINK("http://evil.example","x")'],
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
  ])('%j で始まる文字列の先頭に \' を付ける', (input, expected) => {
    expect(neutralizeFormula(input)).toBe(expected);
  });

  test.each([
    'ボールペン',
    'A=1',          // 途中の = は対象外
    'P-001',        // 途中の - は対象外
    'mail@example', // 途中の @ は対象外
    '',
    ' =1',          // 先頭が空白なら対象外（仕様: = + - @ タブ CR 始まりのみ）
    "'=1",          // 既に ' 始まり
  ])('%j はそのまま返す', (input) => {
    expect(neutralizeFormula(input)).toBe(input);
  });

  test('文字列以外（数値・null・undefined）はそのまま返す', () => {
    expect(neutralizeFormula(-5)).toBe(-5);
    expect(neutralizeFormula(0)).toBe(0);
    expect(neutralizeFormula(null)).toBeNull();
    expect(neutralizeFormula(undefined)).toBeUndefined();
  });
});

describe('escapeCsvValue（RFC 4180 エスケープ）', () => {
  test('null / undefined は空文字', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
  });

  test('数値は文字列化する（負の数値は数式対策の対象外）', () => {
    expect(escapeCsvValue(0)).toBe('0');
    expect(escapeCsvValue(123)).toBe('123');
    expect(escapeCsvValue(-5)).toBe('-5');
  });

  test('特殊文字を含まない文字列（日本語を含む）はそのまま', () => {
    expect(escapeCsvValue('ボールペン')).toBe('ボールペン');
    expect(escapeCsvValue('P001')).toBe('P001');
    expect(escapeCsvValue('')).toBe('');
  });

  test.each([
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['"', '""""'],
    ['line1\nline2', '"line1\nline2"'],
    ['line1\r\nline2', '"line1\r\nline2"'],
  ])('%j はダブルクォートで囲み、内部の " は "" にする', (input, expected) => {
    expect(escapeCsvValue(input)).toBe(expected);
  });

  test('数式対策を先に行い、その後にクォート処理をする', () => {
    expect(escapeCsvValue('=1,2')).toBe('"\'=1,2"');
    expect(escapeCsvValue('=A1&"x"')).toBe('"\'=A1&""x"""');
    // CR 始まりは ' 付与後、CR を含むためクォートされる
    expect(escapeCsvValue('\rX')).toBe('"\'\rX"');
    // タブ始まりはクォート不要（タブは区切り文字ではない）
    expect(escapeCsvValue('\tX')).toBe("'\tX");
  });
});

describe('toCsvRow', () => {
  test('セルをカンマで連結し、末尾に CRLF を付ける', () => {
    expect(toCsvRow(['P001', 'ボールペン', 20, '在庫少'])).toBe('P001,ボールペン,20,在庫少\r\n');
  });

  test('各セルをエスケープする', () => {
    expect(toCsvRow(['-P1', 'a,"b"', null, ''])).toBe('\'-P1,"a,""b""",,\r\n');
  });

  test('空配列は CRLF のみ', () => {
    expect(toCsvRow([])).toBe('\r\n');
  });

  test('1セルだけの場合も区切り文字を付けない', () => {
    expect(toCsvRow(['x'])).toBe('x\r\n');
  });
});

describe('formatDateYmd（日本時間の YYYYMMDD）', () => {
  test('UTC 15:00 以降は日本時間では翌日になる', () => {
    expect(formatDateYmd(new Date('2026-01-31T14:59:59Z'))).toBe('20260131');
    expect(formatDateYmd(new Date('2026-01-31T15:00:00Z'))).toBe('20260201');
  });

  test('年末年始の境界', () => {
    expect(formatDateYmd(new Date('2025-12-31T15:00:00Z'))).toBe('20260101');
  });

  test('月・日を2桁にゼロ埋めする', () => {
    expect(formatDateYmd(new Date('2026-03-04T00:00:00Z'))).toBe('20260304');
  });

  test('引数省略時は現在日時を使い、8桁の数字を返す', () => {
    expect(formatDateYmd()).toMatch(/^\d{8}$/);
    expect(formatDateYmd()).toBe(formatDateYmd(new Date()));
  });
});
