// 商品登録／入出庫フォーム画面（form.html）
//   - 商品登録: POST /products
//   - 入出庫  : POST /stock-transactions
//   - 現在の在庫一覧と商品セレクトボックス: GET /products（送信成功後に自動で再取得する）
//       在庫一覧   : 1ページ 100 件。続きは「さらに読み込む」で取得する
//       セレクト   : next_after が null になるまで 500 件ずつ繰り返し取得し、全商品を選択肢にする
(function () {
  'use strict';

  // 在庫一覧の1回あたりの取得件数
  const PAGE_SIZE = 100;

  // 項目名 → 表示名（項目の近くに表示できないエラーの見出しに使う）
  const FIELD_LABELS = {
    product_id: '商品ID',
    product_name: '商品名',
    stock: '在庫数',
    transaction_type: '取引種別',
    quantity: '数量',
  };

  const productForm = document.getElementById('product-form');
  const productMessage = document.getElementById('product-message');
  const txForm = document.getElementById('transaction-form');
  const txMessage = document.getElementById('transaction-message');
  const txSelect = document.getElementById('tx_product_id');
  const reloadButton = document.getElementById('reload-button');
  const loadMoreButton = document.getElementById('load-more-button');
  const listMessage = document.getElementById('list-message');
  const table = document.getElementById('product-table');
  const tbody = document.getElementById('product-tbody');

  // ?product_id= で指定された商品（最初の読み込み時だけ選択に使う）
  let initialProductId = new URLSearchParams(location.search).get('product_id');

  // 在庫一覧・セレクトボックスそれぞれで、古いレスポンスで表示を上書きしないための連番
  let tableSeq = 0;
  let selectSeq = 0;
  // 在庫一覧の次のページのキー（null なら続きなし）
  let nextAfter = null;
  let tableRowCount = 0;

  // ---- 商品一覧（在庫一覧表とセレクトボックス）の取得 ----

  // 在庫一覧（先頭ページ）とセレクトボックス（全件）を並行して読み込み直す
  // 実行中の再読み込みの数（連続して呼ばれても、すべて終わるまで更新ボタンを無効にしておく）
  let reloading = 0;

  async function loadProducts() {
    reloading += 1;
    reloadButton.disabled = true;
    try {
      await Promise.all([loadTable(), loadSelect()]);
    } finally {
      reloading -= 1;
      reloadButton.disabled = reloading > 0;
    }
  }

  async function loadTable() {
    const seq = ++tableSeq;
    Ui.showMessage(listMessage, 'info', '読み込み中です…');
    loadMoreButton.hidden = true;
    loadMoreButton.disabled = false;
    try {
      const page = await Api.getPage('/products', { limit: PAGE_SIZE });
      if (seq !== tableSeq) return;
      Ui.clear(tbody);
      tableRowCount = 0;
      nextAfter = page.nextAfter;
      appendTableRows(page.data);
    } catch (err) {
      if (seq !== tableSeq) return;
      nextAfter = null;
      table.hidden = true;
      Ui.showMessage(listMessage, 'error', `商品一覧を取得できませんでした。${err.message}`);
    }
  }

  // 在庫一覧の続きを読み込んで末尾に追加する
  async function loadMoreTable() {
    if (nextAfter === null) return;
    const seq = ++tableSeq;
    loadMoreButton.disabled = true;
    try {
      const page = await Api.getPage('/products', { limit: PAGE_SIZE, after: nextAfter });
      if (seq !== tableSeq) return;
      nextAfter = page.nextAfter;
      appendTableRows(page.data);
    } catch (err) {
      if (seq !== tableSeq) return;
      // 読み込み済みの行は残し、エラーだけを表示する（ボタンで再試行できる）
      Ui.showMessage(listMessage, 'error', `続きを取得できませんでした。${err.message}`);
    } finally {
      if (seq === tableSeq) loadMoreButton.disabled = false;
    }
  }

  async function loadSelect() {
    const seq = ++selectSeq;
    try {
      const products = await Api.getAll('/products');
      if (seq !== selectSeq) return;
      renderSelect(products);
    } catch (err) {
      if (seq !== selectSeq) return;
      renderSelectError();
      Ui.showMessage(txMessage, 'error', `商品の選択肢を取得できませんでした。${err.message}`);
    }
  }

  function appendTableRows(products) {
    tableRowCount += products.length;
    if (tableRowCount === 0) {
      table.hidden = true;
      loadMoreButton.hidden = true;
      Ui.showMessage(listMessage, 'info', '商品が登録されていません。');
      return;
    }
    const fragment = document.createDocumentFragment();
    products.forEach((p) => fragment.appendChild(Ui.productRow(p)));
    tbody.appendChild(fragment);
    Ui.hideMessage(listMessage);
    table.hidden = false;
    loadMoreButton.hidden = nextAfter === null;
  }

  // セレクトボックスを作り直す（選択中の商品は再取得後も維持する）
  function renderSelect(products) {
    const previous = initialProductId !== null ? initialProductId : txSelect.value;
    Ui.clear(txSelect);

    txSelect.appendChild(Ui.el('option', {
      text: products.length === 0 ? '商品が登録されていません' : '商品を選択してください',
      attrs: { value: '' },
    }));
    products.forEach((p) => {
      const label = `${p.product_id}：${p.product_name}（在庫 ${Ui.formatNumber(p.stock)}${p.threshold === '1' ? '・在庫少' : ''}）`;
      // option の value / textContent への代入は HTML として解釈されない
      const option = Ui.el('option', { text: label });
      option.value = p.product_id;
      txSelect.appendChild(option);
    });

    const exists = products.some((p) => p.product_id === previous);
    txSelect.value = exists ? previous : '';

    // クエリで指定された商品が存在しない場合は知らせる（初回のみ）
    if (initialProductId !== null && initialProductId !== '' && !exists) {
      Ui.showMessage(txMessage, 'error', `指定された商品（${initialProductId}）が見つかりません。一覧から選択してください。`);
    }
    initialProductId = null;
  }

  function renderSelectError() {
    Ui.clear(txSelect);
    txSelect.appendChild(Ui.el('option', { text: '商品を取得できませんでした', attrs: { value: '' } }));
  }

  // ---- 商品登録 ----

  // 入力チェック（HTML の属性と同じ規則を JS でも確認する）。問題なければ送信用オブジェクトを返す
  function buildProductBody(errors) {
    const els = productForm.elements;
    const productId = els.product_id.value.trim();
    const productName = els.product_name.value;

    Ui.validateProductId('product_id', productId, errors);
    Ui.validateProductName('product_name', productName, errors);
    const stock = Ui.integerFromInput(els.stock, 'stock', 0, '初期在庫', errors);

    // threshold はサーバーが在庫数から自動算出するため送らない
    // stock は文字列ではなく数値で送る（"10" はサーバーが拒否する）
    return { product_id: productId, product_name: productName.trim(), stock };
  }

  async function submitProduct(event) {
    event.preventDefault();
    await Ui.whileSubmitting(productForm, async () => {
      Ui.hideMessage(productMessage);
      Ui.clearFieldErrors(productForm);

      const errors = [];
      const body = buildProductBody(errors);
      if (errors.length > 0) {
        Ui.showFormError(productForm, productMessage, Ui.validationError(errors), FIELD_LABELS);
        return;
      }

      try {
        const product = await Api.post('/products', body);
        productForm.reset();
        Ui.showMessage(
          productMessage,
          'success',
          `商品「${product.product_name}」（${product.product_id}）を登録しました。在庫数: ${Ui.formatNumber(product.stock)}${product.threshold === '1' ? '（在庫少）' : ''}`
        );
        await loadProducts();
      } catch (err) {
        Ui.showFormError(productForm, productMessage, err, FIELD_LABELS);
      }
    });
  }

  // ---- 入出庫 ----

  function buildTransactionBody(errors) {
    const els = txForm.elements;
    const productId = txSelect.value;
    const typeInput = txForm.querySelector('input[name="transaction_type"]:checked');
    const type = typeInput ? typeInput.value : '';

    if (productId === '') {
      errors.push({ field: 'product_id', message: '商品を選択してください' });
    } else {
      Ui.validateProductId('product_id', productId, errors);
    }
    if (type !== '0' && type !== '1') {
      errors.push({ field: 'transaction_type', message: '入庫または出庫を選択してください' });
    }
    const quantity = Ui.integerFromInput(els.quantity, 'quantity', 1, '数量', errors);

    return { product_id: productId, transaction_type: type, quantity };
  }

  async function submitTransaction(event) {
    event.preventDefault();
    await Ui.whileSubmitting(txForm, async () => {
      Ui.hideMessage(txMessage);
      Ui.clearFieldErrors(txForm);

      const errors = [];
      const body = buildTransactionBody(errors);
      if (errors.length > 0) {
        Ui.showFormError(txForm, txMessage, Ui.validationError(errors), FIELD_LABELS);
        return;
      }

      try {
        const result = await Api.post('/stock-transactions', body);
        const tx = result.transaction;
        const product = result.product;
        const selected = txSelect.value;
        txForm.reset();
        // 続けて同じ商品を記録しやすいよう、商品の選択だけは残す
        txSelect.value = selected;
        Ui.showMessage(
          txMessage,
          'success',
          `${Ui.transactionTypeLabel(tx.transaction_type)}を記録しました（履歴ID: ${tx.rireki_id}）。` +
            `「${product.product_name}」の在庫数は ${Ui.formatNumber(product.stock)} です${product.threshold === '1' ? '（在庫少）' : ''}。`
        );
        await loadProducts();
      } catch (err) {
        // 在庫不足（409）の場合もサーバーのメッセージ（例: 在庫が不足しているため出庫できません）と
        // details（例: 現在の在庫数は 3 です）をそのまま表示する
        Ui.showFormError(txForm, txMessage, err, FIELD_LABELS);
      }
    });
  }

  productForm.addEventListener('submit', submitProduct);
  txForm.addEventListener('submit', submitTransaction);
  reloadButton.addEventListener('click', loadProducts);
  loadMoreButton.addEventListener('click', loadMoreTable);

  document.addEventListener('DOMContentLoaded', loadProducts);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) loadProducts();
  });
})();
