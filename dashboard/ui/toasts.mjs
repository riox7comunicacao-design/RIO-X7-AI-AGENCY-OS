// Notificações (toasts) do Dashboard (UX 4.0): sucesso, erro e aviso, no canto da tela, sem tirar o foco de quem está trabalhando.
//
//   - uma região de avisos (`aria-live`) por app; cada toast é `role="status"` (sucesso/info/aviso) ou `role="alert"` (erro);
//   - some sozinho (sucesso 5 s, aviso 8 s, erro 10 s) pelo agendador injetado — e o botão "Fechar notificação" fecha na hora;
//   - no máximo 4 ao mesmo tempo (o mais antigo sai); a mesma `key` SUBSTITUI o toast anterior (nada de pilha de avisos repetidos);
//   - "sucesso" só é mostrado pela tela DEPOIS da confirmação do servidor — este componente só desenha o que a tela mandar.
//
// Todo texto entra por dom.mjs (textContent). O CSS está em styles.css (classes; nenhum estilo inline).

import { h } from '../dom.mjs';

const DURATIONS = Object.freeze({ success: 5000, info: 5000, warning: 8000, error: 10000 });
const KINDS = Object.freeze(['success', 'info', 'warning', 'error']);
const MAX_VISIBLE = 4;

const defaultSchedule = (fn, ms) => {
  const timer = globalThis.setTimeout(fn, ms);
  return () => globalThis.clearTimeout(timer);
};

export function createToaster({ document, host, schedule = defaultSchedule }) {
  const region = h(document, 'div', { className: 'toast-region', role: 'region', 'aria-label': 'Notificações' });
  host.append(region);
  const live = new Map(); // elemento -> { key, cancel }

  function dismissElement(element) {
    const entry = live.get(element);
    if (!entry) return;
    entry.cancel();
    live.delete(element);
    element.remove();
  }

  function show({ kind = 'info', text, title = null, key = null, duration } = {}) {
    const tone = KINDS.includes(kind) ? kind : 'info';
    const message = typeof text === 'string' ? text.trim() : '';
    if (message === '') return { dismiss() {} };
    if (key) for (const [element, entry] of live) if (entry.key === key) dismissElement(element);
    while (live.size >= MAX_VISIBLE) dismissElement(live.keys().next().value);
    const element = h(
      document,
      'div',
      { className: `toast toast-${tone}`, role: tone === 'error' ? 'alert' : 'status', 'data-kind': tone },
      h(document, 'div', { className: 'toast-text' }, title ? h(document, 'strong', { className: 'toast-title', text: title }) : null, h(document, 'span', { className: 'toast-message', text: message })),
      h(document, 'button', { type: 'button', className: 'toast-close', 'aria-label': 'Fechar notificação', text: '×', onclick: () => dismissElement(element) })
    );
    region.append(element);
    const cancel = schedule(() => dismissElement(element), duration === undefined ? DURATIONS[tone] : duration);
    live.set(element, { key, cancel });
    return { dismiss: () => dismissElement(element), element };
  }

  return {
    show,
    success: (text, options = {}) => show({ ...options, kind: 'success', text }),
    error: (text, options = {}) => show({ ...options, kind: 'error', text }),
    warning: (text, options = {}) => show({ ...options, kind: 'warning', text }),
    info: (text, options = {}) => show({ ...options, kind: 'info', text }),
    count: () => live.size,
    clear() {
      for (const element of [...live.keys()]) dismissElement(element);
    },
    destroy() {
      for (const element of [...live.keys()]) dismissElement(element);
      region.remove();
    },
    element: region,
  };
}
