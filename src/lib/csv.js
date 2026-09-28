// CSV 出力用のヘルパー（RFC 4180 準拠 + CSV インジェクション対策）
// ルートから切り出し、DB に依存せずユニットテストできるようにする

// Excel で UTF-8 の日本語が文字化けしないよう、本文の先頭に付ける BOM
const UTF8_BOM = '﻿';

// 行区切り（RFC 4180 では CRLF）
const CRLF = '\r\n';

// 数式として解釈されうる先頭文字（= + - @ タブ CR）
// Excel 等で開いたときに数式が実行される「CSV（数式）インジェクション」を防ぐため、
// これらで始まる文字列セルは先頭に ' を付けて文字列として扱わせる
const FORMULA_PREFIX_PATTERN = /^[=+\-@\t\r]/;

// ダブルクォートで囲む必要がある文字（ダブルクォート・カンマ・改行）
const NEEDS_QUOTE_PATTERN = /[",\r\n]/;

// 文字列セルを数式インジェクション対策で無害化する（文字列以外はそのまま返す）
function neutralizeFormula(value) {
  if (typeof value === 'string' && FORMULA_PREFIX_PATTERN.test(value)) {
    return `'${value}`;
  }
  return value;
}

// 1セル分の値を CSV 用にエスケープする
//   null / undefined は空文字、数値等は文字列化する
//   文字列は数式インジェクション対策を先に行い、その後に RFC 4180 のクォート処理を行う
function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(neutralizeFormula(value));
  if (NEEDS_QUOTE_PATTERN.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// 1行分（セルの配列）を CSV の行文字列（末尾 CRLF 付き）にする
function toCsvRow(values) {
  return values.map(escapeCsvValue).join(',') + CRLF;
}

// ダウンロード用ファイル名の日付部分（YYYYMMDD）を返す
//   サーバーの TZ 設定に左右されないよう、業務日付として日本時間（Asia/Tokyo）で算出する
function formatDateYmd(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

module.exports = {
  UTF8_BOM,
  CRLF,
  neutralizeFormula,
  escapeCsvValue,
  toCsvRow,
  formatDateYmd,
};
