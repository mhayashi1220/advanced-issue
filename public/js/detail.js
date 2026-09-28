// 商品詳細・入出庫履歴画面（detail.html?id=商品ID）
//   - 商品詳細      : GET    /products/:id
//   - 入出庫履歴    : GET    /stock-transactions?product_id=（1ページ 100 件。続きは「さらに読み込む」）
//   - 入出庫の記録  : POST   /stock-transactions
//   - 商品情報の編集: PUT    /products/:id（変更した項目だけを送る）
//   - 商品の削除    : DELETE /products/:id（画面内で確認してから実行する）
(function () {
  'use strict';

  const FIELD_LABELS = {
    product_id: '商品ID',
    product_name: '商品名',
    stock: '在庫数',
    transaction_type: '取引種別',
    quantity: '数量',
    body: '入力内容',
    id: '商品ID',
  };

  const $ = (id) => document.getElementById(id);

  const pageMessage = $('page-message');
  const content = $('detail-content');
  const reloadButton = $('reload-button');

  const txForm = $('tx-form');
  const txMessage = $('tx-message');
  const editForm = $('edit-form');
  const editMessage = $('edit-message');
  const historyMessage = $('history-message');
  const historyTable = $('history-table');
  const historyTbody = $('history-tbody');
  const historyMoreButton = $('history-more-button');

  // 入出庫履歴の1回あたりの取得件数
  const HISTORY_PAGE_SIZE = 100;

  const deleteArea = $('delete-area');
  const deleteMessage = $('delete-message');
  const deleteButton = $('delete-button');
  const deleteConfirm = $('delete-confirm');
  const deleteConfirmText = $('delete-confirm-text');
  const deleteConfirmButton = $('delete-confirm-button');
  const deleteCancelButton = $('delete-cancel-button');

  const productId = new URLSearchParams(location.search).get('id');
  // URL に埋め込む商品ID（必ずエンコードする）
  const productPath = productId !== null ? `/products/${encodeURIComponent(productId)}` : '';

  // 最後に取得した商品情報（編集フォームの差分判定に使う）
  let currentProduct = null;
  let requestSeq = 0;
  // 入出庫履歴の次のページのキー（null なら続きなし）と、表示中の件数
  let historyNextAfter = null;
  let historyCount = 0;
  const historyPath = `/stock-transactions?product_id=${encodeURIComponent(productId)}`;

  // 画面全体のエラー表示（詳細を隠し、一覧への戻りリンクを添える）
  function showPageError(message) {
    content.hidden = true;
    Ui.clear(pageMessage);
    pageMessage.className = 'message message-error';
    pageMessage.appendChild(Ui.el('p', { text: message }));
    pageMessage.appendChild(Ui.el('p', {}, [
      Ui.el('a', { text: '商品一覧へ戻る', attrs: { href: 'index.html' } }),
    ]));
    pageMessage.hidden = false;
  }

  // ---- 読み込み ----

  async function loadAll() {
    const seq = ++requestSeq;
    reloadButton.disabled = true;
    if (!currentProduct) {
      Ui.showMessage(pageMessage, 'info', '読み込み中です…');
    }
    Ui.showMessage(historyMessage, 'info', '履歴を読み込み中です…');
    historyMoreButton.hidden = true;
    historyMoreButton.disabled = false;

    const [productResult, historyResult] = await Promise.allSettled([
      Api.get(productPath),
      Api.getPage(historyPath, { limit: HISTORY_PAGE_SIZE }),
    ]);
    if (seq !== requestSeq) return;
    reloadButton.disabled = false;

    if (productResult.status === 'rejected') {
      const err = productResult.reason;
      currentProduct = null;
      if (err.status === 404) {
        showPageError(`商品が見つかりません（商品ID: ${productId}）。削除された可能性があります。`);
      } else {
        showPageError(`商品情報を取得できませんでした。${err.message}`);
      }
      return;
    }

    currentProduct = productResult.value;
    Ui.hideMessage(pageMessage);
    renderProduct(currentProduct);
    content.hidden = false;

    Ui.clear(historyTbody);
    historyCount = 0;
    if (historyResult.status === 'rejected') {
      historyNextAfter = null;
      historyTable.hidden = true;
      Ui.showMessage(historyMessage, 'error', `入出庫履歴を取得できませんでした。${historyResult.reason.message}`);
    } else {
      historyNextAfter = historyResult.value.nextAfter;
      renderHistory(historyResult.value.data);
    }
  }

  // 入出庫履歴の続きを読み込んで末尾に追加する
  async function loadMoreHistory() {
    if (historyNextAfter === null) return;
    const seq = ++requestSeq;
    historyMoreButton.disabled = true;
    reloadButton.disabled = true;
    try {
      const page = await Api.getPage(historyPath, { limit: HISTORY_PAGE_SIZE, after: historyNextAfter });
      if (seq !== requestSeq) return;
      historyNextAfter = page.nextAfter;
      renderHistory(page.data);
    } catch (err) {
      if (seq !== requestSeq) return;
      // 読み込み済みの履歴は残し、エラーだけを表示する（ボタンで再試行できる）
      Ui.showMessage(historyMessage, 'error', `続きの入出庫履歴を取得できませんでした。${err.message}`);
    } finally {
      if (seq === requestSeq) {
        historyMoreButton.disabled = false;
        reloadButton.disabled = false;
      }
    }
  }

  function renderProduct(p) {
    document.title = `${p.product_name} | 商品詳細 | 在庫管理`;
    $('d-product-id').textContent = p.product_id;
    $('d-product-name').textContent = p.product_name;
    $('d-stock').textContent = Ui.formatNumber(p.stock);
    const alertCell = $('d-alert');
    Ui.clear(alertCell);
    alertCell.appendChild(Ui.alertBadge(p.threshold));
    alertCell.appendChild(document.createTextNode(
      p.threshold === '1' ? ` 在庫が${Ui.ALERT_STOCK_LIMIT}未満です` : ` 在庫は${Ui.ALERT_STOCK_LIMIT}以上あります`
    ));

    // 編集フォームには最新の値を入れておく
    editForm.elements.product_name.value = p.product_name;
    editForm.elements.stock.value = String(p.stock);
  }

  // 取得した履歴を表の末尾に追加する
  function renderHistory(rows) {
    historyCount += rows.length;
    if (historyCount === 0) {
      historyTable.hidden = true;
      historyMoreButton.hidden = true;
      Ui.showMessage(historyMessage, 'info', '入出庫履歴はありません。');
      return;
    }
    const fragment = document.createDocumentFragment();
    rows.forEach((tx) => {
      const typeClass = tx.transaction_type === '1' ? 'badge badge-out' : 'badge badge-in';
      fragment.appendChild(Ui.el('tr', {}, [
        Ui.el('td', { className: 'mono', text: tx.rireki_id }),
        Ui.el('td', {}, [Ui.el('span', { className: typeClass, text: Ui.transactionTypeLabel(tx.transaction_type) })]),
        Ui.el('td', { className: 'num', text: Ui.formatNumber(tx.quantity) }),
      ]));
    });
    historyTbody.appendChild(fragment);
    Ui.hideMessage(historyMessage);
    historyTable.hidden = false;
    historyMoreButton.hidden = historyNextAfter === null;
  }

  // ---- 入出庫の記録 ----

  async function submitTransaction(event) {
    event.preventDefault();
    await Ui.whileSubmitting(txForm, async () => {
      Ui.hideMessage(txMessage);
      Ui.clearFieldErrors(txForm);

      const errors = [];
      const typeInput = txForm.querySelector('input[name="transaction_type"]:checked');
      const type = typeInput ? typeInput.value : '';
      if (type !== '0' && type !== '1') {
        errors.push({ field: 'transaction_type', message: '入庫または出庫を選択してください' });
      }
      const quantity = Ui.integerFromInput(txForm.elements.quantity, 'quantity', 1, '数量', errors);
      if (errors.length > 0) {
        Ui.showFormError(txForm, txMessage, Ui.validationError(errors), FIELD_LABELS);
        return;
      }

      try {
        const result = await Api.post('/stock-transactions', {
          product_id: productId,
          transaction_type: type,
          quantity,
        });
        txForm.reset();
        Ui.showMessage(
          txMessage,
          'success',
          `${Ui.transactionTypeLabel(result.transaction.transaction_type)}を記録しました（履歴ID: ${result.transaction.rireki_id}）。` +
            `在庫数は ${Ui.formatNumber(result.product.stock)} になりました${result.product.threshold === '1' ? '（在庫少）' : ''}。`
        );
        await loadAll();
      } catch (err) {
        // 在庫不足（409）などはサーバーのメッセージと details をそのまま表示する
        Ui.showFormError(txForm, txMessage, err, FIELD_LABELS);
      }
    });
  }

  // ---- 商品情報の編集 ----

  async function submitEdit(event) {
    event.preventDefault();
    await Ui.whileSubmitting(editForm, async () => {
      Ui.hideMessage(editMessage);
      Ui.clearFieldErrors(editForm);
      if (!currentProduct) return;

      const errors = [];
      const body = {};

      // 商品名: 前後の空白を除いた値が現在値と異なる場合だけ送る
      const name = editForm.elements.product_name.value;
      if (name.trim() !== currentProduct.product_name) {
        Ui.validateProductName('product_name', name, errors);
        body.product_name = name.trim();
      }

      // 在庫数: 数値に変換して現在値と異なる場合だけ送る
      const stockInput = editForm.elements.stock;
      if (stockInput.value.trim() !== String(currentProduct.stock) || stockInput.validity.badInput) {
        const stock = Ui.integerFromInput(stockInput, 'stock', 0, '在庫数', errors);
        if (stock !== null && stock !== currentProduct.stock) body.stock = stock;
      }

      if (errors.length > 0) {
        Ui.showFormError(editForm, editMessage, Ui.validationError(errors), FIELD_LABELS);
        return;
      }
      if (Object.keys(body).length === 0) {
        Ui.showMessage(editMessage, 'info', '変更された項目がありません。');
        return;
      }

      try {
        const updated = await Api.put(productPath, body);
        const changed = [];
        if (body.product_name !== undefined) changed.push('商品名');
        if (body.stock !== undefined) changed.push('在庫数');
        Ui.showMessage(
          editMessage,
          'success',
          `${changed.join('・')}を更新しました。${updated.threshold === '1' ? '現在「在庫少」の状態です。' : ''}`
        );
        await loadAll();
      } catch (err) {
        if (err.status === 404) {
          showPageError('商品が見つかりません。削除された可能性があります。');
          return;
        }
        Ui.showFormError(editForm, editMessage, err, FIELD_LABELS);
      }
    });
  }

  // ---- 商品の削除（画面内で確認する） ----

  function openDeleteConfirm() {
    if (!currentProduct) return;
    Ui.hideMessage(deleteMessage);
    deleteConfirmText.textContent =
      `商品「${currentProduct.product_name}」（${currentProduct.product_id}）を削除します。この操作は取り消せません。よろしいですか？`;
    deleteButton.hidden = true;
    deleteConfirm.hidden = false;
    deleteCancelButton.focus();
  }

  function closeDeleteConfirm() {
    deleteConfirm.hidden = true;
    deleteButton.hidden = false;
  }

  async function executeDelete() {
    await Ui.whileSubmitting(deleteArea, async () => {
      Ui.hideMessage(deleteMessage);
      try {
        await Api.del(productPath);
        // 削除成功: 一覧画面へ移動する
        location.href = 'index.html';
      } catch (err) {
        closeDeleteConfirm();
        if (err.status === 404) {
          showPageError('商品が見つかりません。既に削除されている可能性があります。');
          return;
        }
        // 履歴がある場合（409）は「入出庫履歴が存在するため、この商品は削除できません」が返る
        Ui.showMessage(deleteMessage, 'error', err.message);
      }
    });
  }

  // ---- 初期化 ----

  function init() {
    if (productId === null || productId === '') {
      showPageError('商品IDが指定されていません。商品一覧から商品を選択してください。');
      return;
    }
    if (!Ui.PRODUCT_ID_PATTERN.test(productId) || Ui.isReservedProductId(productId)) {
      showPageError('商品IDの形式が不正です。商品一覧から商品を選択してください。');
      return;
    }

    txForm.addEventListener('submit', submitTransaction);
    editForm.addEventListener('submit', submitEdit);
    reloadButton.addEventListener('click', loadAll);
    historyMoreButton.addEventListener('click', loadMoreHistory);
    deleteButton.addEventListener('click', openDeleteConfirm);
    deleteCancelButton.addEventListener('click', closeDeleteConfirm);
    deleteConfirmButton.addEventListener('click', executeDelete);
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) loadAll();
    });

    loadAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
