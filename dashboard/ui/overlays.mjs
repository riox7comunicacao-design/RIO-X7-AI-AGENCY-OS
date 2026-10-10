// Camadas sobrepostas do Dashboard (UX 4.0): MODAL, DRAWER (painel lateral) e DIÁLOGO DE CONFIRMAÇÃO — um só gerenciador, uma pilha.
//
// O que o gerenciador garante (por código, não por convenção de cada tela):
//   - ABRE na tela atual: nada recarrega; quem abriu mantém a lista, os filtros, a busca e a posição de rolagem por baixo;
//   - ESC fecha SÓ a camada do topo; o botão X (e, quando a camada permite, o clique no fundo) também fecham;
//   - ALTERAÇÕES NÃO SALVAS: se a camada declara `isDirty()` e há algo a perder, fechar por ESC / X / fundo pergunta antes de descartar;
//   - FOCO: ao abrir, o foco vai para dentro da camada e Tab/Shift+Tab ficam presos nela; o conteúdo de trás fica `inert` (nem foco, nem clique)
//     e `aria-hidden`; ao fechar, o foco volta ao elemento que abriu (ou ao `getReturnFocus()` se ele saiu da tela);
//   - ACESSIBILIDADE: role="dialog" (ou "alertdialog" nas confirmações perigosas), aria-modal, aria-labelledby/aria-describedby;
//   - SEM VAZAMENTO: há UM ouvinte de teclado no document, criado ao abrir a primeira camada e removido ao fechar a última;
//   - SEM DUPLICAÇÃO: abrir de novo uma camada com a mesma `key` devolve a que já está aberta (clique duplo não empilha duas);
//   - SEM FECHAR NO MEIO DE UMA OPERAÇÃO: uma camada `busy` (enviando) não fecha por ESC/X/fundo.
//
// Todo texto entra no DOM por dom.mjs (textContent): o conteúdo vem de dados não confiáveis. O CSS está em styles.css (classes, nenhum estilo inline).

import { h } from '../dom.mjs';

const FOCUSABLE_TAGS = new Set(['button', 'select', 'textarea', 'input', 'a']);

function* elementsIn(container) {
  for (const child of container.childNodes || []) {
    if (child.nodeType === 1) {
      yield child;
      yield* elementsIn(child);
    }
  }
}

// Os elementos que o teclado alcança dentro de `container`, na ordem do documento (ativos, visíveis, fora de áreas inert).
export function focusableIn(container) {
  const out = [];
  for (const element of elementsIn(container)) {
    if (element.disabled || element.hidden || element.hasAttribute('inert')) continue;
    let blocked = false;
    for (let parent = element.parentNode; parent && parent !== container; parent = parent.parentNode) {
      if (parent.hidden || (parent.hasAttribute && parent.hasAttribute('inert'))) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const tabindex = element.getAttribute('tabindex');
    if (tabindex !== null) {
      if (Number(tabindex) >= 0) out.push(element);
    } else if (element.localName === 'a') {
      if (element.hasAttribute('href')) out.push(element);
    } else if (element.localName === 'input' && element.getAttribute('type') === 'hidden') {
      continue;
    } else if (FOCUSABLE_TAGS.has(element.localName)) {
      out.push(element);
    }
  }
  return out;
}

let overlaySequence = 0;

// document: o document (do navegador ou do teste). host: o elemento onde as camadas são desenhadas (fora do conteúdo que vira inert).
// getInertTargets(): os elementos do app que ficam inertes enquanto houver camada (ex.: o menu e a área principal).
export function createOverlayManager({ document, host, getInertTargets = () => [] }) {
  const stack = [];
  let keyListener = null;
  let destroyed = false;
  const closedLayers = new WeakSet(); // camadas já removidas: nada dentro delas recebe o foco de volta

  const body = () => document.body || null;
  const topEntry = () => (stack.length > 0 ? stack[stack.length - 1] : null);

  function setInert(element, on) {
    if (!element || typeof element.setAttribute !== 'function') return;
    if (on) {
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    } else {
      element.removeAttribute('inert');
      element.removeAttribute('aria-hidden');
    }
  }

  // Só a camada do topo está viva: as de baixo e o conteúdo do app ficam inertes e escondidos da leitura de tela.
  function applyInert() {
    const active = topEntry();
    for (const target of getInertTargets()) setInert(target, active !== null);
    for (const entry of stack) setInert(entry.layer, entry !== active);
  }

  function onKeydown(event) {
    const top = topEntry();
    if (!top) return;
    if (event.key === 'Escape') {
      if (top.closeOnEscape === false) return;
      event.preventDefault();
      requestClose(top, 'escape');
      return;
    }
    if (event.key === 'Tab') {
      const items = focusableIn(top.dialog);
      const active = document.activeElement;
      if (items.length === 0) {
        event.preventDefault();
        top.dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = active && top.dialog.contains(active);
      if (event.shiftKey && (!inside || active === first || active === top.dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function ensureListener() {
    if (keyListener || typeof document.addEventListener !== 'function') return;
    keyListener = onKeydown;
    document.addEventListener('keydown', keyListener);
  }

  function dropListener() {
    if (!keyListener) return;
    document.removeEventListener('keydown', keyListener);
    keyListener = null;
  }

  function finishClose(entry, reason) {
    const at = stack.indexOf(entry);
    if (at < 0) return false;
    stack.splice(at, 1);
    entry.open = false;
    entry.layer.remove();
    applyInert();
    closedLayers.add(entry.layer);
    if (stack.length === 0) {
      dropListener();
      if (body()) body().removeAttribute('data-overlay-open');
    }
    restoreFocus(entry);
    if (typeof entry.onClose === 'function') entry.onClose(reason);
    return true;
  }

  function restoreFocus(entry) {
    const candidates = [typeof entry.getReturnFocus === 'function' ? entry.getReturnFocus() : null, entry.opener];
    const insideClosed = (node) => {
      for (let current = node; current; current = current.parentNode) if (closedLayers.has(current)) return true;
      return false;
    };
    for (const candidate of candidates) {
      if (candidate && typeof candidate.focus === 'function' && candidate.isConnected !== false && !insideClosed(candidate)) {
        candidate.focus();
        if (document.activeElement === candidate) return;
      }
    }
    const below = topEntry();
    if (below) below.dialog.focus();
  }

  // Fecha a camada (ou pergunta antes, se há alteração a perder). Devolve se fechou agora.
  function requestClose(entry, reason = 'api', { force = false } = {}) {
    if (!entry.open) return false;
    if (entry.busy) return false;
    if (!force && typeof entry.isDirty === 'function' && entry.isDirty()) {
      askDiscard(entry, reason);
      return false;
    }
    return finishClose(entry, reason);
  }

  function askDiscard(entry, reason) {
    openConfirm({
      key: `discard:${entry.id}`,
      title: 'Descartar alterações?',
      message: 'Há alterações que ainda não foram salvas. Se você fechar agora, elas serão perdidas.',
      tone: 'danger',
      confirmLabel: 'Descartar',
      cancelLabel: 'Continuar editando',
      cancelFirst: true,
      onConfirm: async () => {
        finishClose(entry, reason);
      },
    });
  }

  function titleBlock(entry, title, subtitle, closeButton) {
    entry.titleEl = h(document, 'h2', { id: entry.titleId, className: 'overlay-title', text: title });
    return h(document, 'header', { className: 'overlay-head' }, h(document, 'div', { className: 'overlay-titles' }, entry.titleEl, subtitle ? h(document, 'p', { className: 'overlay-subtitle muted', text: subtitle }) : null), closeButton);
  }

  function buildEntry(kind, options) {
    overlaySequence += 1;
    const entry = {
      id: `ov${overlaySequence}`,
      key: options.key || null,
      kind,
      open: true,
      busy: false,
      isDirty: options.isDirty || null,
      onClose: options.onClose || null,
      getReturnFocus: options.getReturnFocus || null,
      closeOnBackdrop: options.closeOnBackdrop !== false,
      closeOnEscape: options.closeOnEscape !== false,
      opener: document.activeElement || null,
    };
    entry.titleId = `${entry.id}-title`;
    const closeButton = h(document, 'button', { type: 'button', className: 'overlay-close', 'aria-label': 'Fechar', 'data-action': 'close', text: '×', onclick: () => requestClose(entry, 'button') });
    const backdrop = h(document, 'div', { className: 'overlay-backdrop', 'aria-hidden': 'true', onclick: () => entry.closeOnBackdrop && requestClose(entry, 'backdrop') });
    const bodyEl = h(document, 'div', { className: 'overlay-body' });
    const footerEl = h(document, 'footer', { className: 'overlay-footer', hidden: true });
    const dialog = h(
      document,
      'div',
      {
        className: `overlay-dialog ${kind === 'drawer' ? 'drawer' : 'modal'}${options.size ? ` size-${options.size}` : ''}`,
        role: options.role || 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': entry.titleId,
        ...(options.describedBy ? { 'aria-describedby': options.describedBy } : {}),
        tabindex: '-1',
      },
      titleBlock(entry, options.title || '', options.subtitle || '', closeButton),
      bodyEl,
      footerEl
    );
    const layer = h(document, 'div', { className: `overlay overlay-${kind}`, 'data-overlay': kind }, backdrop, dialog);
    Object.assign(entry, { layer, dialog, bodyEl, footerEl, closeButton });
    return entry;
  }

  function place(entry, options) {
    if (options.content) entry.bodyEl.append(options.content);
    if (options.footer) {
      entry.footerEl.hidden = false;
      entry.footerEl.append(options.footer);
    }
    host.append(entry.layer);
    stack.push(entry);
    ensureListener();
    if (body()) body().setAttribute('data-overlay-open', '');
    applyInert();
    const target = typeof options.initialFocus === 'function' ? options.initialFocus() : null;
    (target || entry.dialog).focus();
  }

  function handleOf(entry) {
    return {
      get element() {
        return entry.dialog;
      },
      get body() {
        return entry.bodyEl;
      },
      get isOpen() {
        return entry.open;
      },
      close: (reason = 'api', options) => requestClose(entry, reason, options),
      setTitle(text) {
        entry.titleEl.textContent = String(text || '');
      },
      // Troca o conteúdo mantendo a posição de rolagem e o foco (se o foco estava no que saiu, ele volta para a camada).
      setContent(node) {
        const scroll = entry.bodyEl.scrollTop || 0;
        const hadFocus = document.activeElement && entry.bodyEl.contains(document.activeElement);
        entry.bodyEl.replaceChildren(...(node ? [node] : []));
        entry.bodyEl.scrollTop = scroll;
        if (hadFocus && !(document.activeElement && entry.dialog.contains(document.activeElement))) entry.dialog.focus();
      },
      setFooter(node) {
        entry.footerEl.replaceChildren(...(node ? [node] : []));
        entry.footerEl.hidden = !node;
      },
      setBusy(value) {
        entry.busy = Boolean(value);
        entry.dialog.setAttribute('aria-busy', entry.busy ? 'true' : 'false');
        entry.closeButton.disabled = entry.busy;
      },
    };
  }

  function open(kind, options = {}) {
    if (destroyed) throw new Error('overlay: o gerenciador foi destruído');
    if (options.key) {
      const existing = stack.find((entry) => entry.key === options.key && entry.open);
      if (existing) return handleOf(existing);
    }
    const entry = buildEntry(kind, options);
    place(entry, options);
    return handleOf(entry);
  }

  const openModal = (options) => open('modal', options);
  const openDrawer = (options) => open('drawer', options);

  // Confirmação humana: título, mensagem, campo opcional (motivo) e dois botões. `onConfirm(valor)` é assíncrono: enquanto pende, os botões
  // ficam desabilitados (um segundo clique não envia de novo); se resolver, a camada fecha; se rejeitar, o erro aparece AQUI, o texto digitado
  // fica e a camada continua aberta (a menos que o erro traga `closeDialog: true`).
  function openConfirm(options = {}) {
    if (options.key) {
      const existing = stack.find((entry) => entry.key === options.key && entry.open);
      if (existing) return withExtras(handleOf(existing), () => {}, () => '');
    }
    const field = options.field || null;
    let input = null;
    let errorLine = null;
    let confirmButton = null;
    let cancelButton = null;
    let submitted = false;
    let entryRef = null;
    const message = options.message ? h(document, 'p', { id: `${options.key || 'confirm'}-msg`.replace(/[^A-Za-z0-9_-]/g, '-'), className: 'confirm-message', text: options.message }) : null;
    errorLine = h(document, 'p', { className: 'confirm-error', role: 'alert', hidden: true });
    if (field) {
      input = h(document, 'textarea', { id: field.id || 'confirm-input', rows: String(field.rows || 3), maxlength: String(field.maxlength || 2000), 'aria-required': field.required ? 'true' : 'false' });
    }
    const showError = (text) => {
      errorLine.textContent = text || '';
      errorLine.hidden = !text;
    };
    const valueOf = () => (input ? String(input.value || '').trim() : '');
    async function submit() {
      if (!entryRef || entryRef.busy) return;
      const value = valueOf();
      if (field && field.required && value === '') {
        showError(field.requiredMessage || 'Preencha o campo obrigatório.');
        if (input) {
          input.setAttribute('aria-invalid', 'true');
          input.focus();
        }
        return;
      }
      showError('');
      if (input) input.removeAttribute('aria-invalid');
      handle.setBusy(true);
      confirmButton.disabled = true;
      cancelButton.disabled = true;
      if (input) input.disabled = true;
      const idleLabel = confirmButton.textContent;
      confirmButton.textContent = options.busyLabel || 'Enviando…';
      try {
        await options.onConfirm(value);
        submitted = true;
        handle.setBusy(false);
        finishClose(entryRef, 'confirmed');
      } catch (error) {
        handle.setBusy(false);
        if (error && error.closeDialog === true) {
          showError('');
          finishClose(entryRef, 'error');
          return;
        }
        confirmButton.disabled = false;
        cancelButton.disabled = false;
        if (input) input.disabled = false;
        confirmButton.textContent = idleLabel;
        showError(error && typeof error.message === 'string' && error.message !== '' ? error.message : 'Não foi possível concluir a operação agora. Tente novamente em instantes.');
        if (input) input.focus();
      }
    }
    confirmButton = h(document, 'button', { type: 'button', className: `btn ${options.tone === 'danger' ? 'danger' : 'primary'}`, 'data-action': 'confirm', text: options.confirmLabel || 'Confirmar', onclick: submit });
    cancelButton = h(document, 'button', { type: 'button', className: 'btn secondary', 'data-action': 'cancel', text: options.cancelLabel || 'Cancelar', onclick: () => entryRef && requestClose(entryRef, 'cancel', { force: true }) });
    const content = h(
      document,
      'div',
      { className: 'confirm-body' },
      message,
      options.body || null, // um nó opcional (ex.: o resumo do que será feito), entre a mensagem e os detalhes
      ...[].concat(options.detail || []).filter(Boolean).map((line) => h(document, 'p', { className: 'muted', text: line })), // detail: um texto ou vários (um parágrafo cada)
      field ? h(document, 'label', { for: field.id || 'confirm-input', text: field.label || '' }) : null,
      input,
      field && field.hint ? h(document, 'p', { className: 'hint', text: field.hint }) : null,
      errorLine
    );
    const footer = h(document, 'div', { className: 'actions' }, ...(options.cancelFirst ? [cancelButton, confirmButton] : [confirmButton, cancelButton]));
    const handle = open('modal', {
      key: options.key,
      title: options.title,
      role: options.tone === 'danger' ? 'alertdialog' : 'dialog',
      size: 'sm',
      describedBy: message ? message.getAttribute('id') : undefined,
      content,
      footer,
      isDirty: () => !submitted && Boolean(input) && valueOf() !== '',
      onClose: options.onClose,
      getReturnFocus: options.getReturnFocus,
      initialFocus: () => input || (options.cancelFirst ? cancelButton : confirmButton),
      closeOnBackdrop: options.closeOnBackdrop,
    });
    entryRef = stack.find((entry) => entry.dialog === handle.element) || null;
    return withExtras(handle, showError, valueOf);
  }

  // O handle de uma confirmação = o handle da camada (com os getters AO VIVO: isOpen/element/body) + setError e value. `Object.create` preserva os getters; um spread os congelaria.
  function withExtras(handle, setError, valueOf) {
    const out = Object.create(handle);
    out.setError = setError;
    Object.defineProperty(out, 'value', { get: valueOf });
    return out;
  }

  return {
    openModal,
    openDrawer,
    openConfirm,
    closeTop(reason = 'api') {
      const top = topEntry();
      return top ? requestClose(top, reason) : false;
    },
    closeAll() {
      while (stack.length > 0) finishClose(stack[stack.length - 1], 'close-all');
    },
    depth: () => stack.length,
    isOpen: (key) => stack.some((entry) => entry.key === key && entry.open),
    destroy() {
      destroyed = true;
      while (stack.length > 0) finishClose(stack[stack.length - 1], 'destroy');
      dropListener();
    },
  };
}
