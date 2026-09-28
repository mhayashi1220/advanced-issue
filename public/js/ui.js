// 画面共通の表示・入力チェック処理
//
// XSS 対策のため、API から受け取った値は必ず textContent / createElement で表示する。
// innerHTML・insertAdjacentHTML・HTML 文字列の組み立ては使用しない。
(function () {
  'use strict';

  // ---- 定数（サーバー側 src/lib/validation.js と同じ規則） ----
  const INT_MAX = 2147483647;
  const ALERT_STOCK_LIMIT = 10;
  const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,10}$/;
  const PRODUCT_NAME_MAX = 100;
  // 商品IDとして使えない予約語（大文字小文字を区別しない）
  const RESERVED_PRODUCT_IDS = ['alerts'];
  // 商品名に使えない文字（制御文字 \p{Cc} と、ゼロ幅文字・文字方向の制御文字などの書式文字 \p{Cf}）
  const PRODUCT_NAME_FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}]/u;

  // 取引種別コードと表示名
  const TRANSACTION_TYPE_LABELS = { '0': '入庫', '1': '出庫' };

  // ---- DOM 生成 ----

  /**
   * 要素を生成する（文字列は textContent として設定されるため HTML として解釈されない）
   * @param {string} tag
   * @param {{className?: string, text?: string|number, attrs?: object}} [opts]
   * @param {Array<Node|string>} [children]
   */
  function el(tag, opts, children) {
    const node = document.createElement(tag);
    const o = opts || {};
    if (o.className) node.className = o.className;
    if (o.text !== undefined && o.text !== null) node.textContent = String(o.text);
    if (o.attrs) {
      Object.keys(o.attrs).forEach((key) => node.setAttribute(key, o.attrs[key]));
    }
    (children || []).forEach((child) => {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  // 子要素をすべて削除する
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // 在庫アラートのバッジを生成する（threshold '1' = 在庫少）
  function alertBadge(threshold) {
    if (threshold === '1') {
      return el('span', { className: 'badge badge-alert', text: '在庫少' });
    }
    return el('span', { className: 'badge badge-ok', text: '正常' });
  }

  // 取引種別コードを表示名に変換する
  function transactionTypeLabel(type) {
    return TRANSACTION_TYPE_LABELS[type] || `不明（${type}）`;
  }

  // 数値を 3 桁区切りで表示する
  function formatNumber(n) {
    return typeof n === 'number' ? n.toLocaleString('ja-JP') : String(n);
  }

  // 詳細画面・入出庫フォームへの URL（ID は必ずエンコードする）
  function detailUrl(productId) {
    return `detail.html?id=${encodeURIComponent(productId)}`;
  }
  function transactionFormUrl(productId) {
    return `form.html?product_id=${encodeURIComponent(productId)}`;
  }

  /**
   * 商品一覧表の1行を生成する（一覧画面・フォーム画面の在庫一覧で共通）
   * 列: 商品ID / 商品名（詳細へのリンク） / 在庫数 / アラート / 操作
   * @param {{product_id: string, product_name: string, stock: number, threshold: string}} product
   */
  function productRow(product) {
    const nameLink = el('a', { text: product.product_name, attrs: { href: detailUrl(product.product_id) } });
    const actions = el('div', { className: 'row-actions' }, [
      el('a', { className: 'btn btn-small btn-secondary', text: '詳細', attrs: { href: detailUrl(product.product_id) } }),
      el('a', { className: 'btn btn-small btn-secondary', text: '入出庫', attrs: { href: transactionFormUrl(product.product_id) } }),
    ]);
    const tr = el('tr', {}, [
      el('td', { className: 'mono', text: product.product_id }),
      el('td', {}, [nameLink]),
      el('td', { className: 'num', text: formatNumber(product.stock) }),
      el('td', {}, [alertBadge(product.threshold)]),
      el('td', {}, [actions]),
    ]);
    if (product.threshold === '1') tr.className = 'row-alert';
    return tr;
  }

  // ---- メッセージ表示 ----

  /**
   * メッセージ領域に表示する
   * @param {HTMLElement} box   表示先（role="alert" / "status" を付けた要素）
   * @param {'error'|'success'|'info'} type
   * @param {string} message
   * @param {string[]} [lines] 箇条書きで添える補足
   */
  function showMessage(box, type, message, lines) {
    clear(box);
    box.className = `message message-${type}`;
    box.appendChild(el('p', { text: message }));
    if (lines && lines.length > 0) {
      box.appendChild(el('ul', {}, lines.map((line) => el('li', { text: line }))));
    }
    box.hidden = false;
  }

  function hideMessage(box) {
    clear(box);
    box.className = 'message';
    box.hidden = true;
  }

  // ---- 項目ごとのエラー表示 ----
  // フォーム内の <p class="field-error" data-error-for="項目名"> にメッセージを出し、
  // 対応する入力欄（name 属性が同じもの）に aria-invalid を付ける。

  function clearFieldErrors(form) {
    form.querySelectorAll('.field-error').forEach((p) => {
      p.textContent = '';
      p.hidden = true;
    });
    form.querySelectorAll('[aria-invalid="true"]').forEach((input) => {
      input.removeAttribute('aria-invalid');
    });
  }

  /**
   * 項目ごとのエラーを表示する
   * @param {HTMLFormElement} form
   * @param {Array<{field?: string, message: string}>} details
   * @param {object} [labels] 項目名 → 表示名（項目の近くに出せなかったエラーの見出し用）
   * @returns {string[]} 項目の近くに表示できなかったエラー（フォーム上部に表示する用）
   */
  function showFieldErrors(form, details, labels) {
    const rest = [];
    let firstInvalid = null;
    (details || []).forEach((d) => {
      if (!d || typeof d.message !== 'string') return;
      const field = typeof d.field === 'string' ? d.field : '';
      const slot = field ? form.querySelector(`.field-error[data-error-for="${CSS.escape(field)}"]`) : null;
      if (slot) {
        slot.textContent = slot.textContent ? `${slot.textContent} / ${d.message}` : d.message;
        slot.hidden = false;
        const input = form.elements.namedItem(field);
        if (input && typeof input.setAttribute === 'function') {
          input.setAttribute('aria-invalid', 'true');
          if (!firstInvalid) firstInvalid = input;
        }
      } else {
        const label = labels && labels[field] ? `${labels[field]}：` : '';
        rest.push(`${label}${d.message}`);
      }
    });
    if (firstInvalid && typeof firstInvalid.focus === 'function') firstInvalid.focus();
    return rest;
  }

  /**
   * API エラー（または入力チェックのエラー）をフォームに表示する
   * @param {HTMLFormElement} form
   * @param {HTMLElement} box  フォーム上部のメッセージ領域
   * @param {Error} err        Api.ApiError など
   * @param {object} [labels]
   */
  function showFormError(form, box, err, labels) {
    const details = err && Array.isArray(err.details) ? err.details : [];
    const rest = showFieldErrors(form, details, labels);
    const message = err && err.message ? err.message : '処理に失敗しました。';
    showMessage(box, 'error', message, rest);
  }

  // ---- 送信中の二重送信防止 ----

  /**
   * 送信処理を実行する間、フォーム内のボタンを無効化する
   * 実行中に再度呼ばれた場合は何もしない（二重送信防止）
   * @param {HTMLFormElement|HTMLElement} container
   * @param {() => Promise<void>} task
   */
  async function whileSubmitting(container, task) {
    if (container.dataset.submitting === 'true') return;
    container.dataset.submitting = 'true';
    const buttons = Array.from(container.querySelectorAll('button'));
    const prevDisabled = buttons.map((b) => b.disabled);
    buttons.forEach((b) => { b.disabled = true; });
    container.setAttribute('aria-busy', 'true');
    try {
      await task();
    } finally {
      buttons.forEach((b, i) => { b.disabled = prevDisabled[i]; });
      container.removeAttribute('aria-busy');
      delete container.dataset.submitting;
    }
  }

  // ---- 入力チェック（サーバーと同じ規則。結果は [{ field, message }] に追加する） ----

  // 商品IDが予約語（alerts など）かどうか
  function isReservedProductId(value) {
    return RESERVED_PRODUCT_IDS.includes(String(value).toLowerCase());
  }

  function validateProductId(field, value, errors) {
    if (value === '') {
      errors.push({ field, message: '商品IDを入力してください' });
    } else if (!PRODUCT_ID_PATTERN.test(value)) {
      errors.push({ field, message: '英数字・ハイフン・アンダースコアのみ、1〜10文字で入力してください' });
    } else if (isReservedProductId(value)) {
      errors.push({ field, message: `「${value}」はシステムで使用しているため商品IDに使用できません` });
    }
  }

  function validateProductName(field, value, errors) {
    // サーバーと同様に、前後の空白を除く前の値で制御文字・書式文字を確認する
    if (PRODUCT_NAME_FORBIDDEN_CHARS.test(value)) {
      errors.push({ field, message: '商品名に改行・タブなどの制御文字や、ゼロ幅文字などの特殊な書式文字は使用できません' });
      return;
    }
    // サーバーと同様に、前後の空白を除いた文字数（サロゲートペアは1文字）で数える
    const len = [...value.trim()].length;
    if (len === 0) {
      errors.push({ field, message: '商品名を入力してください' });
    } else if (len > PRODUCT_NAME_MAX) {
      errors.push({ field, message: `商品名は${PRODUCT_NAME_MAX}文字以内で入力してください（現在 ${len} 文字）` });
    }
  }

  /**
   * 整数の入力値を検証し、Number に変換して返す（不正な場合は null）
   * "10" のような文字列はサーバーが拒否するため、必ずこの関数で数値に変換して送る
   * @param {string} field
   * @param {string} raw     入力欄の値
   * @param {number} min     最小値（0 または 1）
   * @param {string} label   項目の表示名
   * @param {Array} errors
   */
  function parseIntegerField(field, raw, min, label, errors) {
    const value = String(raw).trim();
    if (value === '') {
      errors.push({ field, message: `${label}を入力してください` });
      return null;
    }
    if (!/^[0-9]+$/.test(value)) {
      errors.push({ field, message: `${label}は${min}以上の整数（半角数字）で入力してください` });
      return null;
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > INT_MAX) {
      errors.push({ field, message: `${label}は${min}以上${formatNumber(INT_MAX)}以下で入力してください` });
      return null;
    }
    return n;
  }

  /**
   * 数値入力欄（type=number）から整数を読み取る
   * ブラウザが数値として解釈できない入力（例: 「1e」）は value が空になるため、
   * validity.badInput を見て「未入力」と区別する
   */
  function integerFromInput(input, field, min, label, errors) {
    if (input.validity && input.validity.badInput) {
      errors.push({ field, message: `${label}は${min}以上の整数（半角数字）で入力してください` });
      return null;
    }
    return parseIntegerField(field, input.value, min, label, errors);
  }

  // 入力チェックのエラーを ApiError と同じ形で扱えるようにする
  function validationError(details) {
    return { message: '入力内容に誤りがあります。各項目のメッセージを確認してください。', details };
  }

  window.Ui = {
    INT_MAX,
    ALERT_STOCK_LIMIT,
    PRODUCT_ID_PATTERN,
    el,
    clear,
    alertBadge,
    transactionTypeLabel,
    formatNumber,
    detailUrl,
    transactionFormUrl,
    productRow,
    showMessage,
    hideMessage,
    clearFieldErrors,
    showFieldErrors,
    showFormError,
    whileSubmitting,
    isReservedProductId,
    validateProductId,
    validateProductName,
    parseIntegerField,
    integerFromInput,
    validationError,
  };
})();
