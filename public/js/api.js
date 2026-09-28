// API 通信の共通処理（fetch ラッパー）
//
// サーバーのレスポンス仕様
//   成功時: { data: ... }
//   一覧の成功時: { data: [...], meta: { limit, next_after } }（next_after が null なら最後のページ）
//   失敗時: { error: { message, details: [{ field, message }] } }
//   DELETE 成功時は 204（ボディなし）
//
// 画面側では Api.request() / Api.get() などを呼び、
// 失敗時は ApiError（status, message, details を持つ）を catch して表示する。
// CSV などのファイル取得は Api.getBlob() を使う（成功時は Blob、失敗時は同じく ApiError）。
(function () {
  'use strict';

  // API の接頭辞（将来 /api 配下に移す場合はこの1行だけを変更する）
  const API_BASE = '';

  // ネットワークエラー時に表示するメッセージ
  const NETWORK_ERROR_MESSAGE = 'サーバーに接続できません。サーバーが起動しているか、ネットワーク接続を確認してください。';

  // API 呼び出しの失敗を表すエラー
  //   status  : HTTP ステータス（ネットワークエラー時は 0）
  //   message : 画面に表示するメッセージ
  //   details : 項目ごとのエラー [{ field, message }]
  class ApiError extends Error {
    constructor(status, message, details) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.details = Array.isArray(details) ? details : [];
    }
  }

  // レスポンスボディを安全に読み取る（204・空ボディ・JSON 以外にも対応する）
  async function readBody(res) {
    if (res.status === 204 || res.status === 205) {
      return null;
    }
    const text = await res.text();
    if (text === '') {
      return null;
    }
    const contentType = res.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(text);
      } catch (e) {
        // JSON と宣言されていても解析できない場合は本文なしとして扱う
        return null;
      }
    }
    // JSON 以外（HTML のエラーページなど）は画面に出さない
    return null;
  }

  // HTTP ステータスに応じた既定のエラーメッセージ（サーバーがメッセージを返さなかった場合に使う）
  function defaultErrorMessage(status) {
    if (status >= 500) return `サーバーでエラーが発生しました（HTTP ${status}）。時間をおいて再度お試しください。`;
    if (status === 404) return '対象のデータが見つかりません（HTTP 404）。';
    return `リクエストが失敗しました（HTTP ${status}）。`;
  }

  // 一覧 API の1回あたりの取得件数の上限（サーバーと同じ値）
  const PAGE_LIMIT_MAX = 500;
  // getAll() で繰り返し取得するページ数の上限（サーバーの不具合等で無限に続くことを防ぐ）
  const MAX_PAGES = 200;

  /**
   * API を呼び出し、成功時はレスポンスの JSON 全体を返す（204 の場合は null）
   * @param {string} method HTTP メソッド
   * @param {string} path   '/products' のような API パス（ID は呼び出し側で encodeURIComponent 済みであること）
   * @param {object} [body] 送信する JSON オブジェクト
   * @returns {Promise<any>} レスポンスの JSON
   * @throws {ApiError}
   */
  async function requestJson(method, path, body) {
    const options = {
      method,
      headers: { Accept: 'application/json' },
    };
    if (body !== undefined) {
      // POST / PUT はサーバー側で Content-Type: application/json が必須
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, options);
    } catch (e) {
      // サーバー停止・ネットワーク断など、レスポンス自体が得られなかった場合
      throw new ApiError(0, NETWORK_ERROR_MESSAGE);
    }

    let json;
    try {
      json = await readBody(res);
    } catch (e) {
      // ボディ受信中に接続が切れた場合
      throw new ApiError(0, NETWORK_ERROR_MESSAGE);
    }

    if (!res.ok) {
      throw errorFromBody(res.status, json);
    }

    return json;
  }

  // 失敗レスポンスのボディ（readBody の結果）から ApiError を作る
  function errorFromBody(status, json) {
    const err = json && json.error ? json.error : null;
    const message = err && typeof err.message === 'string' && err.message !== ''
      ? err.message
      : defaultErrorMessage(status);
    return new ApiError(status, message, err ? err.details : []);
  }

  /**
   * ファイル（CSV など）を GET で取得し、成功時は Blob とレスポンスヘッダーを返す
   * 失敗時は JSON の error.message を ApiError として投げる（JSON 以外のボディは画面に出さない）
   * @param {string} path   '/products/export.csv' のような API パス
   * @param {string} accept Accept ヘッダーの値（例: 'text/csv'）
   * @returns {Promise<{blob: Blob, headers: Headers}>}
   * @throws {ApiError}
   */
  async function getBlob(path, accept) {
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, { method: 'GET', headers: { Accept: accept } });
    } catch (e) {
      // サーバー停止・ネットワーク断など、レスポンス自体が得られなかった場合
      throw new ApiError(0, NETWORK_ERROR_MESSAGE);
    }

    if (!res.ok) {
      let json;
      try {
        json = await readBody(res);
      } catch (e) {
        throw new ApiError(0, NETWORK_ERROR_MESSAGE);
      }
      throw errorFromBody(res.status, json);
    }

    try {
      const blob = await res.blob();
      return { blob, headers: res.headers };
    } catch (e) {
      // ボディ受信中に接続が切れた場合
      throw new ApiError(0, NETWORK_ERROR_MESSAGE);
    }
  }

  /**
   * API を呼び出し、成功時は data の中身を返す
   * @returns {Promise<any>} レスポンスの data（204 の場合は null）
   * @throws {ApiError}
   */
  async function request(method, path, body) {
    const json = await requestJson(method, path, body);
    return json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : null;
  }

  // パスにクエリパラメータを追加する（既存のクエリがあれば & でつなぐ）
  function withQuery(path, params) {
    const qs = new URLSearchParams();
    Object.keys(params).forEach((key) => {
      if (params[key] !== undefined && params[key] !== null) qs.set(key, String(params[key]));
    });
    const query = qs.toString();
    if (query === '') return path;
    return `${path}${path.includes('?') ? '&' : '?'}${query}`;
  }

  /**
   * 一覧 API を1ページ分取得する
   * @param {string} path  '/products' など（クエリ付きでもよい）
   * @param {{limit?: number, after?: string|null}} [opts]
   * @returns {Promise<{data: Array, nextAfter: string|null}>}
   */
  async function getPage(path, opts) {
    const o = opts || {};
    const json = await requestJson('GET', withQuery(path, { limit: o.limit, after: o.after }));
    const data = json && Array.isArray(json.data) ? json.data : [];
    const meta = json && json.meta ? json.meta : null;
    const nextAfter = meta && typeof meta.next_after === 'string' && meta.next_after !== '' ? meta.next_after : null;
    return { data, nextAfter };
  }

  /**
   * 一覧 API を next_after が null になるまで繰り返し取得し、全件を返す（1回あたり最大 500 件）
   * @param {string} path
   * @returns {Promise<Array>}
   */
  async function getAll(path) {
    const all = [];
    let after = null;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const page = await getPage(path, { limit: PAGE_LIMIT_MAX, after });
      all.push(...page.data);
      // 次のページが無い、またはキーが進まない（異常）場合は終了する
      if (page.nextAfter === null || page.nextAfter === after) return all;
      after = page.nextAfter;
    }
    throw new ApiError(0, `件数が多すぎるため全件を取得できませんでした（${MAX_PAGES * PAGE_LIMIT_MAX}件まで）。`);
  }

  // 公開する関数（グローバル変数 Api として各画面の JS から利用する）
  window.Api = {
    ApiError,
    request,
    get: (path) => request('GET', path),
    getPage,
    getAll,
    getBlob,
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
  };
})();
