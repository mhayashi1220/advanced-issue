// 商品一覧画面（index.html）
//   - GET /products（全件）または GET /products/alerts（アラート対象のみ）を表示する
//   - 一覧はページング（1ページ 100 件、商品ID順）。続きは「さらに読み込む」で取得する
//   - 画面表示時・bfcache からの復帰時・更新ボタン押下時に先頭から再取得する
//   - 在庫アラートバナー: GET /products/alerts を全件取得し、在庫10未満の商品を画面上部に表示する
//   - CSV ダウンロード: GET /products/export.csv を fetch で取得し、<a download> で保存させる
//     （失敗時は画面遷移せず、#csv-message にエラーメッセージを表示する。取得中はボタンを無効化する）
(function () {
  'use strict';

  // 1回に取得する件数
  const PAGE_SIZE = 100;

  const alertOnly = document.getElementById('alert-only');
  const reloadButton = document.getElementById('reload-button');
  const loadMoreButton = document.getElementById('load-more-button');
  const listMessage = document.getElementById('list-message');
  const table = document.getElementById('product-table');
  const tbody = document.getElementById('product-tbody');
  const listCount = document.getElementById('list-count');

  // 連続して再取得した場合に、古いレスポンスで表示を上書きしないための連番
  let requestSeq = 0;
  // 表示中の一覧の状態（先頭から読み込み直すたびに初期化する）
  let loaded = [];
  let nextAfter = null;
  let currentOnlyAlerts = false;

  function listPath(onlyAlerts) {
    return onlyAlerts ? '/products/alerts' : '/products';
  }

  // 先頭のページから読み込み直す
  async function loadProducts() {
    const seq = ++requestSeq;
    const onlyAlerts = alertOnly.checked;

    Ui.showMessage(listMessage, 'info', '読み込み中です…');
    reloadButton.disabled = true;
    // 続きの読み込み中に再取得した場合でもボタンが無効のまま残らないようにする
    loadMoreButton.hidden = true;
    loadMoreButton.disabled = false;

    try {
      const page = await Api.getPage(listPath(onlyAlerts), { limit: PAGE_SIZE });
      if (seq !== requestSeq) return;
      loaded = page.data;
      nextAfter = page.nextAfter;
      currentOnlyAlerts = onlyAlerts;
      Ui.clear(tbody);
      render(page.data);
    } catch (err) {
      if (seq !== requestSeq) return;
      loaded = [];
      nextAfter = null;
      table.hidden = true;
      listCount.hidden = true;
      Ui.showMessage(listMessage, 'error', `商品一覧を取得できませんでした。${err.message}`);
    } finally {
      if (seq === requestSeq) reloadButton.disabled = false;
    }
  }

  // 続きのページを読み込んで表の末尾に追加する
  async function loadMore() {
    if (nextAfter === null) return;
    const seq = ++requestSeq;
    loadMoreButton.disabled = true;
    reloadButton.disabled = true;
    try {
      const page = await Api.getPage(listPath(currentOnlyAlerts), { limit: PAGE_SIZE, after: nextAfter });
      if (seq !== requestSeq) return;
      loaded = loaded.concat(page.data);
      nextAfter = page.nextAfter;
      render(page.data);
    } catch (err) {
      if (seq !== requestSeq) return;
      // 読み込み済みの行は残したまま、エラーだけを表示する（ボタンで再試行できる）
      Ui.showMessage(listMessage, 'error', `続きを取得できませんでした。${err.message}`);
    } finally {
      if (seq === requestSeq) {
        loadMoreButton.disabled = false;
        reloadButton.disabled = false;
      }
    }
  }

  // 取得した行を表に追加し、件数表示と「さらに読み込む」ボタンを更新する
  function render(rows) {
    if (loaded.length === 0) {
      table.hidden = true;
      listCount.hidden = true;
      loadMoreButton.hidden = true;
      Ui.showMessage(
        listMessage,
        'info',
        currentOnlyAlerts ? '在庫アラート対象の商品はありません。' : '商品が登録されていません。「商品登録／入出庫」から登録してください。'
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    rows.forEach((product) => fragment.appendChild(Ui.productRow(product)));
    tbody.appendChild(fragment);

    Ui.hideMessage(listMessage);
    table.hidden = false;
    const more = nextAfter !== null ? '。続きがあります' : '';
    listCount.textContent = currentOnlyAlerts
      ? `アラート対象 ${loaded.length} 件を表示中${more}`
      : `${loaded.length} 件を表示中（うち在庫少 ${loaded.filter((p) => p.threshold === '1').length} 件）${more}`;
    listCount.hidden = false;
    loadMoreButton.hidden = nextAfter === null;
  }

  // ---- 在庫アラートバナー ----

  // バナーに商品名を並べる最大件数（超えた分は「ほか N 件」と表示する）
  const ALERT_BANNER_MAX_ITEMS = 10;

  // バナーの表示先（role="status" のライブリージョン）
  // ※ hidden にすると読み上げが行われない支援技術があるため、領域は常に表示したまま中身だけを差し替える
  const alertBanner = document.getElementById('alert-banner');
  // 連続して再取得した場合に、古いレスポンスでバナーを上書きしないための連番
  let bannerSeq = 0;

  // アラート対象の商品を全件取得してバナーを更新する
  // ※ 取得に失敗しても一覧の表示は妨げない（バナー内に控えめにエラーを出すだけ）
  // ※ 取得中は前回の表示を残す（更新のたびにバナーがちらつかないようにする）
  async function loadAlertBanner() {
    const seq = ++bannerSeq;
    try {
      const alerts = await Api.getAll('/products/alerts');
      if (seq !== bannerSeq) return;
      renderAlertBanner(alerts);
    } catch (err) {
      if (seq !== bannerSeq) return;
      renderAlertBannerError(err);
    }
  }

  // バナーを描画する（0 件なら中身を空にする。空の領域は高さを持たないため表示上は隠れる）
  // XSS 対策のため、API の値は Ui.el（textContent / createElement）でのみ表示する
  function renderAlertBanner(alerts) {
    Ui.clear(alertBanner);
    if (alerts.length === 0) {
      return;
    }

    const shown = alerts.slice(0, ALERT_BANNER_MAX_ITEMS);
    // 商品名は詳細画面へのリンクにする（ID は Ui.detailUrl 内で encodeURIComponent される）
    const items = shown.map((product) => Ui.el('li', {}, [
      Ui.el('a', { text: product.product_name, attrs: { href: Ui.detailUrl(product.product_id) } }),
      Ui.el('span', { className: 'alert-banner-stock', text: `在庫 ${Ui.formatNumber(product.stock)}` }),
    ]));

    const children = [
      Ui.el('p', {
        className: 'alert-banner-title',
        text: `在庫アラート: ${Ui.formatNumber(alerts.length)} 件の商品が在庫${Ui.ALERT_STOCK_LIMIT}未満です`,
      }),
      Ui.el('ul', { className: 'alert-banner-list' }, items),
    ];
    const rest = alerts.length - shown.length;
    if (rest > 0) {
      children.push(Ui.el('p', {
        className: 'alert-banner-more',
        text: `ほか ${Ui.formatNumber(rest)} 件（「アラート対象のみ表示」で全件を確認できます）`,
      }));
    }

    alertBanner.appendChild(Ui.el('div', { className: 'alert-banner' }, children));
  }

  // 取得失敗時は控えめなエラー表示にとどめる（一覧側のエラー表示とは独立させる）
  function renderAlertBannerError(err) {
    Ui.clear(alertBanner);
    const detail = err && err.message ? err.message : '';
    alertBanner.appendChild(Ui.el('div', { className: 'alert-banner alert-banner-error' }, [
      Ui.el('p', { text: `在庫アラートを取得できませんでした。${detail}` }),
    ]));
  }

  // ---- CSV ダウンロード ----

  // CSV 出力 API のパス
  // ※ api.js の API_BASE と同じく接頭辞なし。将来 /api 配下に移す場合は API_BASE と合わせてこの定数も変更する
  const CSV_EXPORT_PATH = '/products/export.csv';

  // Content-Disposition が無い・想定外の形式の場合に使うファイル名
  const CSV_DEFAULT_FILENAME = 'products.csv';
  // ダウンロード開始後、Blob URL を解放するまでの待ち時間（ミリ秒）
  // ※ click 直後に解放するとダウンロードが始まらないブラウザがあるため少し遅らせる
  const REVOKE_DELAY_MS = 1000;
  const CSV_BUTTON_BUSY_LABEL = 'CSV 作成中…';

  const csvDownloadButton = document.getElementById('csv-download-button');
  const csvMessage = document.getElementById('csv-message');
  const csvButtonLabel = csvDownloadButton.textContent;

  // Content-Disposition の filename="..." からファイル名を取り出す
  // ※ 保存名に使うため、ASCII の英数字・_・-・. だけで構成された値のみ受け付ける
  function filenameFrom(headers) {
    const disposition = headers.get('Content-Disposition') || '';
    const match = /filename="([A-Za-z0-9_.-]+)"/.exec(disposition);
    return match ? match[1] : CSV_DEFAULT_FILENAME;
  }

  // Blob を一時的な <a download> 経由で保存させる（blob: URL へは画面遷移しない）
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }

  async function downloadCsv() {
    // 取得中の二重クリックを防ぐ
    if (csvDownloadButton.disabled) return;
    csvDownloadButton.disabled = true;
    csvDownloadButton.textContent = CSV_BUTTON_BUSY_LABEL;
    Ui.hideMessage(csvMessage);

    try {
      const { blob, headers } = await Api.getBlob(CSV_EXPORT_PATH, 'text/csv');
      saveBlob(blob, filenameFrom(headers));
    } catch (err) {
      // ApiError の message はサーバーの error.message か既定メッセージ（ネットワークエラー含む）
      const detail = err instanceof Api.ApiError ? err.message : '';
      Ui.showMessage(csvMessage, 'error', `CSV をダウンロードできませんでした。${detail}`);
    } finally {
      csvDownloadButton.disabled = false;
      csvDownloadButton.textContent = csvButtonLabel;
    }
  }

  // ---- イベント ----

  // 一覧とバナーをまとめて最新化する
  function refreshAll() {
    loadProducts();
    loadAlertBanner();
  }

  // 表示の絞り込みを変えただけではアラート件数は変わらないため、一覧だけを再取得する
  alertOnly.addEventListener('change', loadProducts);
  reloadButton.addEventListener('click', refreshAll);
  loadMoreButton.addEventListener('click', loadMore);
  csvDownloadButton.addEventListener('click', downloadCsv);

  // 初回表示
  document.addEventListener('DOMContentLoaded', refreshAll);

  // form.html などから「戻る」で戻ってきた場合（bfcache から復元された場合）も最新化する
  // ※ 通常の読み込みでも pageshow は発生するため、二重取得を避けて persisted のときだけ取得する
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) refreshAll();
  });
})();
