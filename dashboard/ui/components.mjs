// Componentes visuais reutilizáveis do Dashboard (UX 4.0): selo de status, estado vazio, carregamento/esqueleto, abas, campo de busca,
// filtro (select), paginação, cabeçalho de página e lista de pares rótulo/valor.
//
// Regras (as mesmas do resto do Dashboard):
//   - todo texto entra por dom.mjs (textContent): os dados são NÃO CONFIÁVEIS; nenhum HTML dinâmico, nenhum estilo inline;
//   - cada componente recebe `document` por parâmetro (roda igual no navegador e no DOM de teste) e devolve elementos prontos;
//   - nenhum componente sabe de regra de negócio: recebem rótulos e tons já decididos por quem os usa.
// O visual (cores Rio X7, espaçamentos, estados de foco) está em styles.css.

import { h } from '../dom.mjs';

const TONES = Object.freeze(['ok', 'warn', 'bad', 'neutral', 'info', 'brand']);

// Selo de status: o texto SEMPRE aparece (a cor sozinha nunca é a informação).
export function statusBadge(document, text, tone = 'neutral') {
  return h(document, 'span', { className: `badge ${TONES.includes(tone) ? tone : 'neutral'}`, text });
}

// Estado vazio: título, explicação e, se houver, uma ação (um botão já pronto).
export function emptyState(document, { title, text = '', action = null, className = '' } = {}) {
  return h(document, 'div', { className: `empty-state${className ? ` ${className}` : ''}`, role: 'status' }, title ? h(document, 'strong', { className: 'empty-title', text: title }) : null, text ? h(document, 'p', { className: 'empty-text', text }) : null, action);
}

// Carregando: uma linha de texto anunciada pelo leitor de tela. Esqueleto: blocos cinza no lugar do conteúdo (escondidos do leitor).
export function loadingState(document, text = 'Carregando…') {
  return h(document, 'p', { className: 'muted loading-line', role: 'status', text });
}

export function skeleton(document, { rows = 4, label = 'Carregando…' } = {}) {
  const lines = Array.from({ length: Math.max(1, Math.min(12, rows)) }, (_, index) => h(document, 'span', { className: `skeleton-line${index % 3 === 2 ? ' short' : ''}`, 'aria-hidden': 'true' }));
  return h(document, 'div', { className: 'skeleton', role: 'status', 'aria-busy': 'true' }, h(document, 'span', { className: 'visually-hidden', text: label }), ...lines);
}

// Cabeçalho de página: título (h2), subtítulo opcional e ações à direita.
export function pageHeader(document, { title, subtitle = '', titleId = null, actions = [] } = {}) {
  return h(document, 'header', { className: 'page-title-row' }, h(document, 'div', { className: 'page-title-block' }, h(document, 'h2', { ...(titleId ? { id: titleId } : {}), text: title }), subtitle ? h(document, 'p', { className: 'muted page-subtitle', text: subtitle }) : null), actions.length > 0 ? h(document, 'div', { className: 'page-actions' }, ...actions) : null);
}

// Lista de pares rótulo/valor (<dl>); linhas sem conteúdo (null) não aparecem.
export function kvList(document, rows, { className = 'fields' } = {}) {
  const items = rows.filter(([, content]) => content !== null && content !== undefined && content !== false);
  return h(document, 'dl', { className }, ...items.flatMap(([label, content]) => [h(document, 'dt', { text: label }), h(document, 'dd', {}, content)]));
}

// Bloco com título (uma "seção" de um painel).
export function section(document, title, ...children) {
  return h(document, 'section', { className: 'panel-section' }, h(document, 'h3', { className: 'panel-section-title', text: title }), ...children);
}

// Campo de formulário: rótulo (com marca de obrigatório), o controle, uma ajuda curta e a mensagem de erro (anunciada). O controle é criado por quem usa e NUNCA é
// recriado: o foco e o texto digitado ficam. setError(texto|null) mostra/limpa o erro e marca aria-invalid; hint = texto de ajuda fixo.
export function formField(document, { id, label, control, help = '', required = false, className = '' } = {}) {
  const helpEl = help ? h(document, 'p', { className: 'field-help muted', id: `${id}-help`, text: help }) : null;
  const errorEl = h(document, 'p', { className: 'field-error', id: `${id}-error`, role: 'alert', hidden: true });
  control.setAttribute('aria-describedby', [helpEl ? `${id}-help` : '', `${id}-error`].filter(Boolean).join(' '));
  if (required) control.setAttribute('aria-required', 'true');
  const element = h(document, 'div', { className: `field form-field${className ? ` ${className}` : ''}` }, h(document, 'label', { for: id, className: required ? 'required' : '', text: label }), control, helpEl, errorEl);
  return {
    element,
    control,
    setError(text) {
      errorEl.textContent = text || '';
      errorEl.hidden = !text;
      if (text) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    },
    setHidden(value) {
      element.hidden = Boolean(value);
    },
  };
}

// Campo de busca: rótulo + input type=search. onInput(valor) a cada digitação; o campo NUNCA é recriado (o foco e o texto digitado ficam).
export function searchField(document, { id, label = 'Buscar', placeholder = '', value = '', onInput = () => {} } = {}) {
  const input = h(document, 'input', { id, type: 'search', autocomplete: 'off', placeholder, ...(value ? { value } : {}), oninput: () => onInput(String(input.value || '')) });
  const element = h(document, 'div', { className: 'field search-field' }, h(document, 'label', { for: id, text: label }), input);
  return { element, input, setValue(next) { input.value = next; } };
}

// Filtro de lista: rótulo + select com opções { value, label }. onChange(valor).
export function selectField(document, { id, label, options, value, onChange = () => {} } = {}) {
  const select = h(document, 'select', { id, onchange: () => onChange(String(select.value || '')) }, ...options.map((option) => h(document, 'option', { value: option.value, text: option.label, ...(option.value === value ? { selected: 'selected' } : {}) })));
  if (value !== undefined) select.value = value;
  return { element: h(document, 'div', { className: 'field select-field' }, h(document, 'label', { for: id, text: label }), select), select };
}

// Paginação: "Anterior / Página X de Y / Próxima". Some quando há uma página só.
export function pagination(document, { page, pageCount, total, pageSize, onPage }) {
  if (!(pageCount > 1)) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return h(
    document,
    'nav',
    { className: 'pagination', 'aria-label': 'Paginação' },
    h(document, 'button', { type: 'button', className: 'btn secondary small', text: 'Anterior', disabled: page <= 1, onclick: () => onPage(page - 1) }),
    h(document, 'span', { className: 'page-info muted', text: `Página ${page} de ${pageCount} · ${from}–${to} de ${total}` }),
    h(document, 'button', { type: 'button', className: 'btn secondary small', text: 'Próxima', disabled: page >= pageCount, onclick: () => onPage(page + 1) })
  );
}

// Abas (WAI-ARIA): role=tablist/tab/tabpanel, setas/Home/End movem entre as abas, só a ativa está no tab order. Os painéis ficam TODOS no DOM
// (os inativos `hidden`): trocar de aba não perde o que foi digitado nem recarrega nada.
//   tabs: [{ key, label, content: Node, badge?: string }]
export function createTabs(document, { idPrefix, label, tabs, active, onChange = () => {} }) {
  let current = tabs.some((tab) => tab.key === active) ? active : tabs[0].key;
  const buttons = new Map();
  const panels = new Map();
  const badges = new Map();
  const tabId = (key) => `${idPrefix}-tab-${key}`;
  const panelId = (key) => `${idPrefix}-panel-${key}`;

  function paint() {
    for (const tab of tabs) {
      const selected = tab.key === current;
      const button = buttons.get(tab.key);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.setAttribute('tabindex', selected ? '0' : '-1');
      panels.get(tab.key).hidden = !selected;
    }
  }

  function select(key, { focus = false, notify = true } = {}) {
    if (!buttons.has(key)) return;
    const changed = key !== current;
    current = key;
    paint();
    if (focus) buttons.get(key).focus();
    if (changed && notify) onChange(key);
  }

  function onKey(event) {
    const order = tabs.map((tab) => tab.key);
    const at = order.indexOf(current);
    let next = null;
    if (event.key === 'ArrowRight') next = order[(at + 1) % order.length];
    else if (event.key === 'ArrowLeft') next = order[(at - 1 + order.length) % order.length];
    else if (event.key === 'Home') next = order[0];
    else if (event.key === 'End') next = order[order.length - 1];
    if (next === null) return;
    event.preventDefault();
    select(next, { focus: true });
  }

  const list = h(document, 'div', { className: 'tab-list', role: 'tablist', 'aria-label': label, onkeydown: onKey });
  for (const tab of tabs) {
    const badge = tab.badge ? h(document, 'span', { className: 'tab-badge', text: tab.badge }) : null;
    badges.set(tab.key, badge);
    const button = h(document, 'button', { type: 'button', className: 'tab', role: 'tab', id: tabId(tab.key), 'aria-controls': panelId(tab.key), 'data-tab': tab.key, onclick: () => select(tab.key) }, h(document, 'span', { text: tab.label }), badge);
    buttons.set(tab.key, button);
    list.append(button);
  }
  const panelHost = h(document, 'div', { className: 'tab-panels' });
  for (const tab of tabs) {
    const panel = h(document, 'div', { className: 'tab-panel', role: 'tabpanel', id: panelId(tab.key), 'aria-labelledby': tabId(tab.key) }, tab.content);
    panels.set(tab.key, panel);
    panelHost.append(panel);
  }
  paint();

  return {
    element: h(document, 'div', { className: 'tabs' }, list, panelHost),
    select,
    get active() {
      return current;
    },
    panel: (key) => panels.get(key),
    setPanel(key, node) {
      const panel = panels.get(key);
      if (panel) panel.replaceChildren(...(node ? [node] : []));
    },
    setBadge(key, text) {
      const button = buttons.get(key);
      if (!button) return;
      let badge = badges.get(key);
      if (!text) {
        if (badge) badge.remove();
        badges.set(key, null);
        return;
      }
      if (!badge) {
        badge = h(document, 'span', { className: 'tab-badge' });
        button.append(badge);
        badges.set(key, badge);
      }
      badge.textContent = text;
    },
  };
}
