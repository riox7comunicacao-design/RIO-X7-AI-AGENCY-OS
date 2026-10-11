// O MENU LATERAL do Dashboard (CRM 5.0, Fase 2A): hierárquico (até dois níveis de submenu), recolhível para só ícones, com dicas, destaque da seção ativa, teclado, e uma
// versão para celular que abre e fecha sem ocupar a tela.
//
// Recebe a ÁRVORE já filtrada pelas permissões (nav.mjs → visibleTree) e desenha. Não sabe de rotas, de API nem de permissões: o clique num link é só um endereço (#/...), e quem
// reage ao endereço é main.mjs. O estado "recolhido" é uma preferência VISUAL guardada por `preferences` (preferences.mjs — a única exceção autorizada de armazenamento no navegador).
//
// COMPORTAMENTO
//   - Linha COM rota e filhos (ex.: CRM): o TEXTO é um link e a SETA é um botão à parte que só expande/recolhe. Linha SEM rota e com filhos (ex.: Prospecção): é um botão só.
//   - Expandido: ícone + nome. Recolhido (desktop): só o ícone, com a dica (data-tip) do nome no mouse e no foco; os submenus não aparecem, e clicar num grupo recolhido expande o menu.
//   - No celular (largura pequena) o menu fica fora da tela, abre pelo botão do topo, fecha com ESC, com o fundo, com o botão "Fechar menu" e ao escolher um destino.
//   - Teclado: Tab percorre tudo; as setas ↑/↓ andam pelas entradas visíveis, Home/End vão ao início/fim, → expande (ou entra no submenu), ← recolhe (ou volta ao pai).
//   - A expansão dos submenus vale só enquanto a página está aberta; só "recolhido/expandido" do menu todo é lembrado (preferences).
//   - Nunca usa estilo inline (CSP): tudo é classe e atributo; o CSS está em styles.css.

import { h } from '../dom.mjs';
import { flattenTree, ancestorsOf } from '../nav.mjs';
import { SHELL_TEXT } from '../i18n/pt-BR.mjs';

const ICON_PREFIX = 'rx7-icon-';

// Uma cópia do ícone que está em index.html. Sem ele (testes, página sem o conjunto), um espaço vazio do mesmo tamanho — nunca texto (o nome acessível é o do rótulo).
export function iconNode(document, name) {
  const source = document && typeof document.getElementById === 'function' ? document.getElementById(`${ICON_PREFIX}${name}`) : null;
  if (source && typeof source.cloneNode === 'function') {
    const copy = source.cloneNode(true);
    copy.removeAttribute('id');
    return copy;
  }
  return h(document, 'span', { className: `icon icon-missing icon-${name}`, 'aria-hidden': 'true' });
}

// A largura que decide "celular": { isMobile(), subscribe(fn) -> cancelar }. Sem matchMedia (ambiente de teste), nunca é celular.
export function browserViewport(win, query = '(max-width: 900px)') {
  const media = win && typeof win.matchMedia === 'function' ? win.matchMedia(query) : null;
  return {
    isMobile: () => Boolean(media && media.matches),
    subscribe(listener) {
      if (!media) return () => {};
      const handler = () => listener();
      if (typeof media.addEventListener === 'function') media.addEventListener('change', handler);
      else if (typeof media.addListener === 'function') media.addListener(handler);
      return () => {
        if (typeof media.removeEventListener === 'function') media.removeEventListener('change', handler);
        else if (typeof media.removeListener === 'function') media.removeListener(handler);
      };
    },
  };
}

// tree: a árvore visível. brand(): devolve um bloco de marca novo (o menu e a barra do celular têm cada um o seu). footer: o bloco de baixo (quem está logado e "Sair").
export function createSidebar({ document, tree, brand, footer = null, preferences = null, viewport = null }) {
  const view = viewport || { isMobile: () => false, subscribe: () => () => {} };
  const flat = flattenTree(tree);
  const byId = new Map();
  const state = {
    collapsed: Boolean(preferences && preferences.getSidebarCollapsed()),
    mobileOpen: false,
    activeId: null,
    expanded: new Set(),
    counts: new Map(),
  };
  let shellEl = null;
  let mainEl = null; // a área de conteúdo: fica inerte enquanto o menu do celular está aberto
  let escapeListener = null;
  let destroyed = false;

  // ---- construção ------------------------------------------------------------

  const label = (item) => item.label;

  function badgeAttrs(item) {
    return item.soon ? { 'data-soon': 'true', 'aria-description': SHELL_TEXT.soonSuffix } : {};
  }

  function buildLinkContent(item, depth) {
    return [
      depth === 0 ? h(document, 'span', { className: 'nav-icon', 'aria-hidden': 'true' }, item.icon ? iconNode(document, item.icon) : null) : null,
      h(document, 'span', { className: 'nav-label', text: label(item) }),
    ];
  }

  function buildItem(item, depth, parentId) {
    const hasChildren = Array.isArray(item.children) && item.children.length > 0;
    const li = h(document, 'li', { className: `nav-item depth-${depth}${hasChildren ? ' has-children' : ''}`, 'data-item': item.id });
    const entry = { item, depth, parentId, li, control: null, arrow: null, sub: null, hasChildren };
    byId.set(item.id, entry);

    if (!item.route && !hasChildren) {
      // área que ainda não existe: desabilitada e marcada, sem link
      entry.control = h(document, 'span', { className: 'nav-link soon', 'aria-disabled': 'true', 'data-tip': label(item) }, ...buildLinkContent(item, depth), h(document, 'span', { className: 'nav-soon', text: 'Em desenvolvimento' }));
      li.append(entry.control);
      return li;
    }

    const row = h(document, 'div', { className: 'nav-row' });
    if (item.route) {
      entry.control = h(document, 'a', { className: `nav-link${item.soon ? ' is-soon' : ''}`, href: item.href, 'data-tip': label(item), ...badgeAttrs(item), onclick: () => onLinkClick() }, ...buildLinkContent(item, depth));
      row.append(entry.control);
      if (hasChildren) {
        entry.arrow = h(document, 'button', { type: 'button', className: 'nav-arrow', 'aria-expanded': 'false', onclick: () => toggleBranch(item.id) }, iconNode(document, 'chevron'));
        row.append(entry.arrow);
      }
    } else {
      // grupo sem página própria: o texto inteiro é o botão de expandir
      entry.control = h(
        document,
        'button',
        { type: 'button', className: 'nav-link nav-toggle', 'aria-expanded': 'false', 'data-tip': label(item), onclick: () => onGroupClick(item.id) },
        ...buildLinkContent(item, depth),
        h(document, 'span', { className: 'nav-chevron', 'aria-hidden': 'true' }, iconNode(document, 'chevron'))
      );
      row.append(entry.control);
    }
    li.append(row);

    if (hasChildren) {
      const subId = `nav-sub-${item.id}`;
      entry.sub = h(document, 'ul', { className: `nav-sub depth-${depth + 1}`, id: subId, role: 'list', hidden: true }, ...item.children.map((child) => buildItem(child, depth + 1, item.id)));
      (entry.arrow || entry.control).setAttribute('aria-controls', subId);
      li.append(entry.sub);
    }
    return li;
  }

  // O endereço de cada entrada vem da rota; main.mjs entrega `href` já montado (o menu não conhece o router).
  function prepare(items, hrefOf) {
    for (const item of items) {
      if (item.route) item.href = hrefOf(item.route);
      if (item.children) prepare(item.children, hrefOf);
    }
  }

  let navEl = null;
  let aside = null;
  let topbar = null;
  let backdrop = null;
  let collapseButton = null;
  let mobileButton = null;
  let mobileClose = null;

  function build(hrefOf) {
    const clone = structuredClone(tree);
    prepare(clone, hrefOf);
    byId.clear();
    const list = h(document, 'ul', { className: 'nav-list', role: 'list' }, ...clone.map((item) => buildItem(item, 0, null)));
    navEl = h(document, 'nav', { className: 'nav', id: 'nav-main', 'aria-label': SHELL_TEXT.navLabel, onkeydown: onKeydown }, list);

    collapseButton = h(document, 'button', { type: 'button', className: 'sidebar-toggle', 'aria-controls': 'nav-main', onclick: () => setCollapsed(!state.collapsed) }, iconNode(document, 'collapse'));
    mobileClose = h(document, 'button', { type: 'button', className: 'sidebar-close', 'aria-label': SHELL_TEXT.closeMenu, onclick: () => setMobileOpen(false) }, iconNode(document, 'close'));
    aside = h(
      document,
      'aside',
      { className: 'sidebar', id: 'sidebar' },
      h(document, 'div', { className: 'sidebar-head' }, brand(), collapseButton, mobileClose),
      navEl,
      footer
    );
    mobileButton = h(document, 'button', { type: 'button', className: 'topbar-menu', 'aria-controls': 'sidebar', 'aria-expanded': 'false', 'aria-label': SHELL_TEXT.openMenu, onclick: () => setMobileOpen(!state.mobileOpen) }, iconNode(document, 'menu'));
    topbar = h(document, 'header', { className: 'topbar' }, mobileButton, brand());
    backdrop = h(document, 'div', { className: 'nav-backdrop', 'aria-hidden': 'true', onclick: () => setMobileOpen(false) });
    paint();
  }

  // ---- estado → DOM ---------------------------------------------------------

  const isExpanded = (id) => state.expanded.has(id);

  function paint() {
    if (!aside) return;
    // o botão de recolher (desktop)
    collapseButton.setAttribute('aria-expanded', state.collapsed ? 'false' : 'true');
    collapseButton.setAttribute('aria-label', state.collapsed ? SHELL_TEXT.expand : SHELL_TEXT.collapse);
    collapseButton.setAttribute('data-tip', state.collapsed ? SHELL_TEXT.expand : SHELL_TEXT.collapse);
    if (shellEl) {
      shellEl.setAttribute('data-sidebar', state.collapsed ? 'collapsed' : 'expanded');
      shellEl.setAttribute('data-nav-open', state.mobileOpen ? 'true' : 'false');
    }
    mobileButton.setAttribute('aria-expanded', state.mobileOpen ? 'true' : 'false');
    if (mainEl) {
      if (view.isMobile() && state.mobileOpen) mainEl.setAttribute('inert', '');
      else mainEl.removeAttribute('inert');
    }
    mobileButton.setAttribute('aria-label', state.mobileOpen ? SHELL_TEXT.closeMenu : SHELL_TEXT.openMenu);
    // fora da tela no celular, o menu não pode ser alcançado pelo teclado
    if (view.isMobile() && !state.mobileOpen) aside.setAttribute('inert', '');
    else aside.removeAttribute('inert');

    for (const entry of byId.values()) {
      const { item } = entry;
      if (entry.hasChildren) {
        const open = isExpanded(item.id);
        entry.sub.hidden = !open;
        (entry.arrow || entry.control).setAttribute('aria-expanded', open ? 'true' : 'false');
        if (entry.arrow) entry.arrow.setAttribute('aria-label', open ? SHELL_TEXT.collapseBranch(item.label) : SHELL_TEXT.expandBranch(item.label));
        entry.li.className = `nav-item depth-${entry.depth} has-children${open ? ' is-open' : ''}${isBranchActive(item.id) ? ' is-branch-active' : ''}`;
      }
      if (entry.control && entry.control.localName === 'a') {
        if (state.activeId === item.id) entry.control.setAttribute('aria-current', 'page');
        else entry.control.removeAttribute('aria-current');
      }
    }
    paintBadges();
  }

  const isBranchActive = (id) => state.activeId !== null && ancestorsOf(tree, state.activeId).includes(id);

  function paintBadges() {
    // a contagem de uma entrada = a dela + a das filhas (para o grupo recolhido não esconder um pendente)
    const total = (id) => {
      const entry = byId.get(id);
      let sum = state.counts.get(id) || 0;
      if (entry && entry.hasChildren) for (const child of entry.item.children) sum += total(child.id);
      return sum;
    };
    for (const entry of byId.values()) {
      const target = entry.control;
      if (!target) continue;
      const count = total(entry.item.id);
      if (count > 0) {
        target.setAttribute('data-count', String(count));
        target.setAttribute('aria-label', `${entry.item.label}, ${count} ${count === 1 ? 'pendente' : 'pendentes'}`);
      } else {
        target.removeAttribute('data-count');
        target.removeAttribute('aria-label');
      }
    }
  }

  // ---- ações ------------------------------------------------------------------

  function setCollapsed(value) {
    state.collapsed = Boolean(value);
    if (preferences) preferences.setSidebarCollapsed(state.collapsed);
    paint();
  }

  function toggleBranch(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    paint();
  }

  // Um grupo sem página própria: com o menu recolhido, o clique expande o menu (e abre o grupo); expandido, só alterna o grupo.
  function onGroupClick(id) {
    if (state.collapsed && !view.isMobile()) {
      state.expanded.add(id);
      setCollapsed(false);
      return;
    }
    toggleBranch(id);
  }

  function onLinkClick() {
    if (state.mobileOpen) setMobileOpen(false, { restoreFocus: false });
  }

  function setMobileOpen(open, { restoreFocus = true } = {}) {
    const next = Boolean(open);
    if (next === state.mobileOpen) return;
    state.mobileOpen = next;
    if (next) {
      escapeListener = (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        // com uma camada aberta (gaveta/confirmação) o ESC é dela
        if (document.body && typeof document.body.hasAttribute === 'function' && document.body.hasAttribute('data-overlay-open')) return;
        event.preventDefault();
        setMobileOpen(false);
      };
      if (typeof document.addEventListener === 'function') document.addEventListener('keydown', escapeListener);
    } else if (escapeListener) {
      if (typeof document.removeEventListener === 'function') document.removeEventListener('keydown', escapeListener);
      escapeListener = null;
    }
    paint();
    if (next) {
      const first = visibleControls()[0];
      if (first) first.focus();
    } else if (restoreFocus && view.isMobile()) {
      mobileButton.focus();
    }
  }

  // ---- teclado ----------------------------------------------------------------

  // As entradas que a pessoa enxerga agora, na ordem do menu: [{ entry, control }]. Com o menu recolhido (desktop) só a raiz aparece.
  function visibleEntries() {
    const rootOnly = state.collapsed && !view.isMobile();
    const out = [];
    for (const { item, depth } of flat) {
      const entry = byId.get(item.id);
      if (!entry || !entry.control || entry.control.getAttribute('aria-disabled') === 'true') continue;
      if (rootOnly && depth > 0) continue;
      let visible = true;
      for (let parent = entry.parentId; parent !== null && parent !== undefined; parent = byId.get(parent).parentId) {
        if (!isExpanded(parent)) {
          visible = false;
          break;
        }
      }
      if (visible) out.push(entry);
    }
    return out;
  }

  const visibleControls = () => visibleEntries().map((entry) => entry.control);

  function entryOfFocus() {
    const active = document.activeElement;
    if (!active) return null;
    for (const entry of byId.values()) if (entry.control === active || entry.arrow === active) return entry;
    return null;
  }

  function onKeydown(event) {
    const key = event.key;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(key)) return;
    const entry = entryOfFocus();
    if (!entry) return;
    const visible = visibleEntries();
    const at = visible.indexOf(entry);
    let target = null;
    if (key === 'ArrowDown') target = visible[Math.min(visible.length - 1, at + 1)];
    else if (key === 'ArrowUp') target = visible[Math.max(0, at - 1)];
    else if (key === 'Home') target = visible[0];
    else if (key === 'End') target = visible[visible.length - 1];
    else if (key === 'ArrowRight') {
      if (!entry.hasChildren || (state.collapsed && !view.isMobile())) return;
      event.preventDefault();
      if (!isExpanded(entry.item.id)) {
        toggleBranch(entry.item.id);
        return;
      }
      target = visible[at + 1] && visible[at + 1].parentId === entry.item.id ? visible[at + 1] : null; // o primeiro filho que dá para focar
    } else if (key === 'ArrowLeft') {
      if (entry.hasChildren && isExpanded(entry.item.id)) {
        event.preventDefault();
        toggleBranch(entry.item.id);
        return;
      }
      if (entry.parentId) {
        event.preventDefault();
        byId.get(entry.parentId).control.focus();
      }
      return;
    }
    if (target) {
      event.preventDefault();
      target.control.focus();
    }
  }

  // ---- API --------------------------------------------------------------------

  const stopViewport = view.subscribe(() => {
    if (destroyed) return;
    if (!view.isMobile() && state.mobileOpen) setMobileOpen(false, { restoreFocus: false });
    else paint();
  });

  return {
    // hrefOf(route) -> '#/...'. Chamar UMA vez, antes de usar os elementos.
    build,
    get aside() {
      return aside;
    },
    get topbar() {
      return topbar;
    },
    get backdrop() {
      return backdrop;
    },
    // O elemento da moldura que recebe data-sidebar e data-nav-open (o CSS lê daqui).
    bindShell(element, main = null) {
      shellEl = element;
      mainEl = main;
      paint();
    },
    setActive(id) {
      state.activeId = id || null;
      if (state.activeId) for (const ancestor of ancestorsOf(tree, state.activeId)) state.expanded.add(ancestor);
      paint();
    },
    setBadge(id, count) {
      if (Number.isInteger(count) && count > 0) state.counts.set(id, count);
      else state.counts.delete(id);
      paintBadges();
    },
    toggleCollapsed: () => setCollapsed(!state.collapsed),
    setCollapsed,
    openMobile: () => setMobileOpen(true),
    closeMobile: () => setMobileOpen(false),
    toggleBranch,
    isCollapsed: () => state.collapsed,
    isMobileOpen: () => state.mobileOpen,
    isExpanded,
    link: (id) => (byId.get(id) ? byId.get(id).control : null),
    arrow: (id) => (byId.get(id) ? byId.get(id).arrow : null),
    destroy() {
      destroyed = true;
      stopViewport();
      if (escapeListener && typeof document.removeEventListener === 'function') document.removeEventListener('keydown', escapeListener);
      escapeListener = null;
    },
  };
}
