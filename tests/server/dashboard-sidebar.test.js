// O MENU LATERAL (CRM 5.0, Fase 2A): a árvore e as permissões (nav.mjs), o componente (ui/sidebar.mjs) — expandir/recolher, submenus de dois níveis, clique no texto × seta, dicas, destaque da
// seção ativa, teclado, menu do celular —, a preferência visual guardada (preferences.mjs, a única exceção de armazenamento) e as rotas novas e antigas (router.mjs). DOM de teste:
// nenhum navegador, nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBrowser } = require('../helpers/fakeDom');
const { DASHBOARD_ROOT } = require('./testEnv');

const loadNav = () => import('../../dashboard/nav.mjs');
const loadSidebar = () => import('../../dashboard/ui/sidebar.mjs');
const loadPrefs = () => import('../../dashboard/preferences.mjs');
const loadRouter = () => import('../../dashboard/router.mjs');
const loadDom = () => import('../../dashboard/dom.mjs');

const TUDO = Object.freeze({ canReadCrm: true, canWriteCrm: true, canReview: true, canProposeLead: true, canManageProspectingExclusions: true, canManageCrmCatalogs: true, canManageFunnels: true });
const VENDEDOR = Object.freeze({ canReadCrm: true, canWriteCrm: false, canReview: true, canProposeLead: false, canManageProspectingExclusions: false, canManageCrmCatalogs: false, canManageFunnels: false });
const SO_FILA = Object.freeze({ canReadCrm: false, canWriteCrm: false, canReview: false, canProposeLead: false, canManageProspectingExclusions: false, canManageCrmCatalogs: false, canManageFunnels: false });

const memoria = () => {
  const dados = new Map();
  const chamadas = [];
  return { dados, chamadas, getItem: (k) => (dados.has(k) ? dados.get(k) : null), setItem: (k, v) => { chamadas.push([k, v]); dados.set(k, String(v)); } };
};
const viewportFalso = (mobile = false) => {
  const ouvintes = new Set();
  return {
    mobile,
    isMobile() { return this.mobile; },
    subscribe(fn) { ouvintes.add(fn); return () => ouvintes.delete(fn); },
    mudar(valor) { this.mobile = valor; for (const fn of [...ouvintes]) fn(); },
    ouvintes: () => ouvintes.size,
  };
};

async function montar({ permissions = TUDO, preferences = null, viewport = null, ativo = null } = {}) {
  const { NAV_TREE, visibleTree } = await loadNav();
  const { createSidebar } = await loadSidebar();
  const { buildHash } = await loadRouter();
  const { h } = await loadDom();
  const browser = createBrowser();
  const sair = h(browser.document, 'button', { type: 'button', className: 'btn secondary logout', text: 'Sair' });
  const sidebar = createSidebar({
    document: browser.document,
    tree: visibleTree(NAV_TREE, permissions),
    brand: () => h(browser.document, 'div', { className: 'brand-block' }, h(browser.document, 'span', { className: 'brand-name', text: 'RIO X7' })),
    footer: h(browser.document, 'div', { className: 'who' }, sair),
    preferences,
    viewport,
  });
  sidebar.build((rota) => buildHash(rota));
  const main = h(browser.document, 'main', { className: 'content', id: 'main' }, h(browser.document, 'button', { type: 'button', id: 'conteudo', text: 'Conteúdo' }));
  const shell = h(browser.document, 'div', { className: 'shell' }, sidebar.topbar, sidebar.backdrop, sidebar.aside, main);
  sidebar.bindShell(shell, main);
  browser.root.append(shell);
  if (ativo) sidebar.setActive(ativo);
  const nav = browser.by.tag(sidebar.aside, 'nav')[0];
  const s = { browser, sidebar, shell, nav, main, sair, viewport };
  s.item = (id) => browser.find(nav, (el) => el.localName === 'li' && el.getAttribute('data-item') === id);
  s.link = (id) => sidebar.link(id);
  s.seta = (id) => sidebar.arrow(id);
  s.rotulos = () => browser.by.tag(nav, 'a').map((a) => a.textContent);
  s.nivel0 = () => browser.by.cls(nav, 'nav-item').filter((li) => li.className.includes('depth-0')).map((li) => browser.by.cls(li, 'nav-label')[0].textContent);
  return s;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A estrutura e as permissões
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[SIDE-1] a HIERARQUIA definitiva: Visão Geral, CRM (5 filhos, o último com 4 filhos de segundo nível), Prospecção, Agentes IA e Gestão — no máximo dois níveis de submenu e nada além disso', async () => {
  const { NAV_TREE, flattenTree, MAX_NAV_DEPTH } = await loadNav();
  const mostrar = (itens, recuo = '') => itens.flatMap((item) => [`${recuo}${item.label}`, ...(item.children ? mostrar(item.children, `${recuo}  `) : [])]);
  assert.deepEqual(mostrar(NAV_TREE), [
    'Visão Geral',
    'CRM', '  Dashboard Comercial', '  Clientes', '  Funis de Vendas', '  Metas e Indicadores', '  Configurações do CRM', '    Serviços', '    Nichos e Cores', '    Gestão de Funis e Etapas', '    Origens dos Leads',
    'Prospecção', '  Nova Prospecção', '  Histórico', '  Fila de Aprovação', '  Leads Reprovados',
    'Agentes IA', '  Central de Agentes',
    'Gestão', '  Exclusões Permanentes', '  Agenda', '  Conversas', '  Reuniões', '  Propostas', '  Relatórios', '  Configurações gerais',
  ]);
  assert.equal(MAX_NAV_DEPTH, 2);
  assert.equal(Math.max(...flattenTree(NAV_TREE).map(({ depth }) => depth)), 2, 'nenhum terceiro nível');
  const ids = flattenTree(NAV_TREE).map(({ item }) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'os ids são únicos');
});

test('[SIDE-2] PERMISSÕES: cada entrada some quando a permissão falta (e os pais ficam sem filhos); o vendedor e a conta só com a fila enxergam menus parciais; a árvore original nunca é alterada', async () => {
  const { NAV_TREE, visibleTree, flattenTree } = await loadNav();
  const rotulos = (arvore) => flattenTree(arvore).map(({ item }) => item.label);
  const copia = JSON.stringify(NAV_TREE);

  assert.equal(rotulos(visibleTree(NAV_TREE, TUDO)).length, flattenTree(NAV_TREE).length, 'quem pode tudo vê tudo');
  const vendedor = rotulos(visibleTree(NAV_TREE, VENDEDOR));
  assert.ok(vendedor.includes('CRM') && vendedor.includes('Clientes') && vendedor.includes('Fila de Aprovação') && vendedor.includes('Leads Reprovados'));
  for (const sumiu of ['Nova Prospecção', 'Histórico', 'Exclusões Permanentes']) assert.equal(vendedor.includes(sumiu), false, sumiu);
  assert.ok(vendedor.includes('Prospecção'), 'o grupo fica porque ainda tem filhos');
  // Configurações do CRM é administrativa (Fase 2B-2): sem MANAGE:CRM_CATALOGS e sem MANAGE:FUNNELS nenhum item dela aparece, e o pai some junto
  for (const sumiu of ['Configurações do CRM', 'Serviços', 'Nichos e Cores', 'Origens dos Leads', 'Gestão de Funis e Etapas']) assert.equal(vendedor.includes(sumiu), false, sumiu);
  const soCatalogos = rotulos(visibleTree(NAV_TREE, { ...VENDEDOR, canManageCrmCatalogs: true }));
  for (const aparece of ['Configurações do CRM', 'Serviços', 'Nichos e Cores', 'Origens dos Leads']) assert.ok(soCatalogos.includes(aparece), aparece);
  assert.equal(soCatalogos.includes('Gestão de Funis e Etapas'), false, 'a gestão de funis pede MANAGE:FUNNELS, não a permissão dos catálogos');
  const soFunis = rotulos(visibleTree(NAV_TREE, { ...VENDEDOR, canManageFunnels: true }));
  assert.ok(soFunis.includes('Gestão de Funis e Etapas') && soFunis.includes('Configurações do CRM'));
  for (const sumiu of ['Serviços', 'Nichos e Cores', 'Origens dos Leads']) assert.equal(soFunis.includes(sumiu), false, `${sumiu}: pede MANAGE:CRM_CATALOGS`);

  const soFila = rotulos(visibleTree(NAV_TREE, SO_FILA));
  assert.equal(soFila.includes('CRM'), false, 'sem READ:CRM o CRM e tudo dentro dele somem');
  for (const sumiu of ['Clientes', 'Dashboard Comercial', 'Serviços', 'Funis de Vendas', 'Leads Reprovados', 'Nova Prospecção']) assert.equal(soFila.includes(sumiu), false, sumiu);
  assert.deepEqual(soFila, ['Visão Geral', 'Prospecção', 'Fila de Aprovação', 'Agentes IA', 'Central de Agentes', 'Gestão', 'Relatórios', 'Configurações gerais'], 'sem READ:CRM somem também as referências comerciais (Agenda, Conversas, Reuniões, Propostas)');
  for (const comercial of ['Agenda', 'Conversas', 'Reuniões', 'Propostas']) assert.ok(vendedor.includes(comercial), `${comercial} aparece para quem lê o CRM`);

  assert.deepEqual(visibleTree(NAV_TREE, null).map((item) => item.label), ['Visão Geral', 'Prospecção', 'Agentes IA', 'Gestão'], 'sem permissões nenhuma: só o que não pede permissão');
  assert.equal(JSON.stringify(NAV_TREE), copia, 'a árvore original não foi alterada');
});

test('[SIDE-3] menuItemOf: cada rota acende uma entrada — as rotas ANTIGAS do CRM (#/crm, ficha, novo registro) acendem "Clientes", e uma rota desconhecida não acende nada', async () => {
  const { menuItemOf, ancestorsOf, NAV_TREE } = await loadNav();
  const casos = {
    overview: 'overview', 'crm-dashboard': 'crm-dashboard', 'crm-list': 'crm-clients', 'crm-clients': 'crm-clients', 'crm-new': 'crm-clients', 'crm-record': 'crm-clients', funnels: 'funnels',
    'crm-goals': 'crm-goals', 'crm-settings': 'crm-settings', 'crm-settings-services': 'crm-settings-services', 'crm-settings-niches': 'crm-settings-niches', 'crm-settings-funnels': 'crm-settings-funnels', 'crm-settings-origins': 'crm-settings-origins',
    prospecting: 'prospecting', 'prospecting-run': 'prospecting', 'prospecting-brief': 'prospecting', 'prospecting-history': 'prospecting-history', 'prospecting-job': 'prospecting-history',
    approvals: 'approvals', 'approval-lead': 'approvals', 'rejected-leads': 'rejected-leads', 'rejected-lead': 'rejected-leads', agents: 'agents', 'prospecting-exclusions': 'prospecting-exclusions',
  };
  for (const [rota, id] of Object.entries(casos)) assert.equal(menuItemOf({ name: rota }), id, rota);
  assert.equal(menuItemOf({ name: 'not-found' }), null);
  assert.equal(menuItemOf(null), null);
  assert.deepEqual(ancestorsOf(NAV_TREE, 'crm-settings-niches'), ['crm-settings', 'crm']);
  assert.deepEqual(ancestorsOf(NAV_TREE, 'overview'), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// O componente
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[SIDE-4] a estrutura do menu: nav com nome, lista, itens por nível, CRM com TEXTO (link) e SETA (botão) separados, grupos sem página como botão único, e áreas inexistentes desabilitadas', async () => {
  const s = await montar();
  assert.equal(s.nav.getAttribute('aria-label'), 'Navegação principal');
  assert.deepEqual(s.nivel0(), ['Visão Geral', 'CRM', 'Prospecção', 'Agentes IA', 'Gestão']);

  const crm = s.link('crm');
  assert.equal(crm.localName, 'a');
  assert.equal(crm.href, '#/crm/dashboard', 'o texto CRM abre o Dashboard Comercial');
  const seta = s.seta('crm');
  assert.equal(seta.localName, 'button');
  assert.equal(seta.getAttribute('aria-expanded'), 'false');
  assert.equal(seta.getAttribute('aria-controls'), 'nav-sub-crm');
  assert.equal(seta.getAttribute('aria-label'), 'Expandir CRM');
  assert.notEqual(seta, crm, 'texto e seta são controles diferentes');
  assert.equal(s.browser.by.id(s.nav, 'nav-sub-crm').hidden, true);

  const prospeccao = s.link('prospecting-group');
  assert.equal(prospeccao.localName, 'button', 'um grupo sem página própria é um botão só');
  assert.equal(s.seta('prospecting-group'), null);
  assert.equal(prospeccao.getAttribute('aria-expanded'), 'false');

  assert.equal(s.browser.by.cls(s.nav, 'depth-1').length > 0, true);
  assert.equal(s.browser.find(s.item('crm-settings'), (el) => el.className.includes('depth-2')) !== null, true, 'o segundo nível existe dentro de Configurações do CRM');
  assert.equal(s.browser.findAll(s.nav, (el) => /\bdepth-3\b/.test(el.className)).length, 0, 'e não há terceiro');
  for (const id of ['agenda', 'conversations', 'meetings', 'proposals', 'reports', 'settings']) {
    const parado = s.link(id);
    assert.equal(parado.localName, 'span');
    assert.equal(parado.getAttribute('aria-disabled'), 'true');
    assert.equal(parado.getAttribute('href'), null);
    assert.match(parado.textContent, /Em desenvolvimento/);
  }
  assert.equal(s.link('crm-goals').getAttribute('data-soon'), 'true', 'uma página futura é marcada');
  assert.equal(s.link('crm-goals').getAttribute('aria-description'), 'em desenvolvimento');
  assert.equal(s.link('crm-clients').getAttribute('data-soon'), null, 'uma tela que existe não é marcada');
});

test('[SIDE-5] CLIQUE NO TEXTO × SETA: o texto "CRM" só navega (o submenu não muda); a seta só expande/recolhe (o endereço não muda); grupos sem página alternam pelo próprio texto; submenu de segundo nível idem', async () => {
  const s = await montar();
  const win = s.browser.window;
  const hash0 = win.location.hash;
  s.browser.click(s.seta('crm'));
  assert.equal(win.location.hash, hash0, 'a seta não navega');
  assert.equal(s.sidebar.isExpanded('crm'), true);
  assert.equal(s.seta('crm').getAttribute('aria-expanded'), 'true');
  assert.equal(s.seta('crm').getAttribute('aria-label'), 'Recolher CRM');
  assert.equal(s.browser.by.id(s.nav, 'nav-sub-crm').hidden, false);

  s.browser.click(s.link('crm'));
  await s.browser.flush();
  assert.equal(win.location.hash, '#/crm/dashboard', 'o texto navega para o Dashboard Comercial');
  assert.equal(s.sidebar.isExpanded('crm'), true, 'e não mexe na expansão');

  s.browser.click(s.seta('crm'));
  assert.equal(s.sidebar.isExpanded('crm'), false);
  assert.equal(win.location.hash, '#/crm/dashboard');
  assert.equal(s.browser.by.id(s.nav, 'nav-sub-crm').hidden, true);

  s.browser.click(s.link('prospecting-group'));
  assert.equal(s.sidebar.isExpanded('prospecting-group'), true, 'o texto de um grupo sem página alterna');
  assert.equal(win.location.hash, '#/crm/dashboard', 'sem navegar');
  s.browser.click(s.link('prospecting-group'));
  assert.equal(s.sidebar.isExpanded('prospecting-group'), false);

  // segundo nível
  s.sidebar.toggleBranch('crm');
  s.browser.click(s.seta('crm-settings'));
  assert.equal(s.sidebar.isExpanded('crm-settings'), true);
  assert.equal(s.browser.by.id(s.nav, 'nav-sub-crm-settings').hidden, false);
  s.browser.click(s.link('crm-settings-niches'));
  await s.browser.flush();
  assert.equal(win.location.hash, '#/crm/configuracoes/nichos');
});

test('[SIDE-6] EXPANDIR e RECOLHER o menu todo: botão com nome e estado, atributo na moldura, os nomes continuam no DOM (leitor de tela) e ganham a dica; clicar num grupo com o menu recolhido expande o menu e abre o grupo', async () => {
  const prefs = memoria();
  const { createVisualPreferences } = await loadPrefs();
  const s = await montar({ preferences: createVisualPreferences({ localStorage: prefs }) });
  const botao = s.browser.by.cls(s.sidebar.aside, 'sidebar-toggle')[0];
  assert.equal(s.shell.getAttribute('data-sidebar'), 'expanded');
  assert.equal(botao.getAttribute('aria-label'), 'Recolher menu');
  assert.equal(botao.getAttribute('aria-expanded'), 'true');
  assert.equal(botao.getAttribute('aria-controls'), 'nav-main');

  s.browser.click(botao);
  assert.equal(s.sidebar.isCollapsed(), true);
  assert.equal(s.shell.getAttribute('data-sidebar'), 'collapsed');
  assert.equal(botao.getAttribute('aria-label'), 'Expandir menu');
  assert.equal(botao.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(prefs.chamadas, [['riox7.sidebar.collapsed', '1']]);
  // recolhido: cada entrada da raiz continua com seu NOME (acessível) e tem a DICA com o mesmo nome
  for (const [id, nome] of [['overview', 'Visão Geral'], ['crm', 'CRM'], ['prospecting-group', 'Prospecção'], ['agents-group', 'Agentes IA'], ['management', 'Gestão']]) {
    assert.equal(s.link(id).getAttribute('data-tip'), nome, `dica de ${nome}`);
    assert.equal(s.browser.by.cls(s.link(id), 'nav-label')[0].textContent, nome, `nome acessível de ${nome}`);
  }
  assert.equal(botao.getAttribute('data-tip'), 'Expandir menu');

  s.browser.click(s.link('prospecting-group')); // grupo com o menu recolhido: expande o menu
  assert.equal(s.sidebar.isCollapsed(), false);
  assert.equal(s.sidebar.isExpanded('prospecting-group'), true);
  assert.equal(s.shell.getAttribute('data-sidebar'), 'expanded');
  assert.deepEqual(prefs.chamadas.at(-1), ['riox7.sidebar.collapsed', '0']);

  s.sidebar.toggleCollapsed();
  s.sidebar.toggleCollapsed();
  assert.equal(s.sidebar.isCollapsed(), false);
});

test('[SIDE-7] a SEÇÃO ATIVA: só a entrada da rota fica marcada (aria-current); os ancestrais abrem sozinhos e ficam destacados como ramo ativo; trocar de rota move a marca; sem rota conhecida, nada é marcado', async () => {
  const s = await montar();
  const marcados = () => s.browser.findAll(s.nav, (el) => el.getAttribute('aria-current') === 'page').map((el) => el.textContent);
  s.sidebar.setActive('crm-settings-niches');
  assert.deepEqual(marcados(), ['Nichos e Cores']);
  assert.equal(s.sidebar.isExpanded('crm'), true);
  assert.equal(s.sidebar.isExpanded('crm-settings'), true);
  assert.match(s.item('crm').className, /\bis-branch-active\b/);
  assert.match(s.item('crm-settings').className, /\bis-branch-active\b/);
  assert.doesNotMatch(s.item('prospecting-group').className, /is-branch-active/);

  s.sidebar.setActive('approvals');
  assert.deepEqual(marcados(), ['Fila de Aprovação']);
  assert.equal(s.sidebar.isExpanded('prospecting-group'), true);
  assert.doesNotMatch(s.item('crm').className, /is-branch-active/, 'o ramo anterior deixou de ser o ativo');

  s.sidebar.setActive(null);
  assert.deepEqual(marcados(), []);
  s.sidebar.setActive('um-id-que-nao-existe');
  assert.deepEqual(marcados(), []);
});

test('[SIDE-8] a CONTAGEM de pendentes: aparece na Fila de Aprovação com nome acessível e SOMA no grupo Prospecção (não fica escondida com o grupo recolhido); some quando zera', async () => {
  const s = await montar();
  s.sidebar.setBadge('approvals', 3);
  assert.equal(s.link('approvals').getAttribute('data-count'), '3');
  assert.equal(s.link('approvals').getAttribute('aria-label'), 'Fila de Aprovação, 3 pendentes');
  assert.equal(s.link('prospecting-group').getAttribute('data-count'), '3', 'o grupo mostra o total dos filhos');
  assert.equal(s.link('crm').getAttribute('data-count'), null);
  s.sidebar.setBadge('approvals', 1);
  assert.equal(s.link('approvals').getAttribute('aria-label'), 'Fila de Aprovação, 1 pendente');
  for (const invalido of [0, -2, null, undefined, 'abc', 2.5]) {
    s.sidebar.setBadge('approvals', invalido);
    assert.equal(s.link('approvals').getAttribute('data-count'), null, String(invalido));
    assert.equal(s.link('approvals').getAttribute('aria-label'), null);
    assert.equal(s.link('prospecting-group').getAttribute('data-count'), null);
  }
});

test('[SIDE-9] TECLADO: ↑/↓ andam pelas entradas visíveis (nunca pelas escondidas nem pelas desabilitadas), Home/End vão às pontas, → expande e entra no submenu, ← recolhe ou volta ao pai; Enter e Espaço acionam botões; Tab alcança tudo', async () => {
  const s = await montar();
  const foco = () => s.browser.document.activeElement;
  s.link('overview').focus();
  s.browser.press('ArrowDown');
  assert.equal(foco(), s.link('crm'));
  s.browser.press('ArrowDown');
  assert.equal(foco(), s.link('prospecting-group'), 'o CRM está recolhido: pula os filhos escondidos');
  s.browser.press('ArrowUp');
  assert.equal(foco(), s.link('crm'));

  s.browser.press('ArrowRight'); // expande o CRM
  assert.equal(s.sidebar.isExpanded('crm'), true);
  assert.equal(foco(), s.link('crm'));
  s.browser.press('ArrowRight'); // entra no submenu
  assert.equal(foco(), s.link('crm-dashboard'));
  s.browser.press('ArrowDown');
  s.browser.press('ArrowDown');
  s.browser.press('ArrowDown');
  s.browser.press('ArrowDown');
  assert.equal(foco(), s.link('crm-settings'), 'Dashboard → Clientes → Funis → Metas → Configurações do CRM');
  s.browser.press('ArrowRight');
  s.browser.press('ArrowRight');
  assert.equal(foco(), s.link('crm-settings-services'), 'o segundo nível também');
  s.browser.press('ArrowLeft'); // volta ao pai
  assert.equal(foco(), s.link('crm-settings'));
  s.browser.press('ArrowLeft'); // recolhe
  assert.equal(s.sidebar.isExpanded('crm-settings'), false);
  s.browser.press('ArrowLeft'); // volta ao CRM
  assert.equal(foco(), s.link('crm'));
  s.browser.press('ArrowLeft'); // recolhe o CRM
  assert.equal(s.sidebar.isExpanded('crm'), false);

  s.browser.press('End');
  assert.equal(foco(), s.link('management'), 'o último foco possível: os itens desabilitados não recebem foco');
  s.browser.press('Home');
  assert.equal(foco(), s.link('overview'));

  s.link('prospecting-group').focus();
  s.browser.press('Enter');
  assert.equal(s.sidebar.isExpanded('prospecting-group'), true, 'Enter aciona o botão do grupo');
  s.browser.press(' ');
  assert.equal(s.sidebar.isExpanded('prospecting-group'), false, 'Espaço também');

  s.seta('crm').focus();
  s.browser.press('Enter');
  assert.equal(s.sidebar.isExpanded('crm'), true, 'a seta é focável e aciona com o teclado');
  // Tab: a ordem natural alcança o link e a seta do CRM
  s.link('overview').focus();
  const visitados = [];
  for (let i = 0; i < 6; i += 1) {
    s.browser.press('Tab');
    visitados.push(foco());
  }
  assert.ok(visitados.includes(s.link('crm')) && visitados.includes(s.seta('crm')) && visitados.includes(s.link('crm-dashboard')));
  assert.equal(s.browser.findAll(s.nav, (el) => el.getAttribute('aria-disabled') === 'true' && el.getAttribute('tabindex') !== null).length, 0);
});

test('[SIDE-10] com o menu RECOLHIDO o teclado só anda pela raiz (os submenus não aparecem) e → não expande submenus escondidos', async () => {
  const s = await montar();
  s.sidebar.setCollapsed(true);
  s.link('overview').focus();
  s.browser.press('ArrowDown');
  s.browser.press('ArrowDown');
  assert.equal(s.browser.document.activeElement, s.link('prospecting-group'));
  s.browser.press('End');
  assert.equal(s.browser.document.activeElement, s.link('management'));
  s.link('crm').focus();
  s.browser.press('ArrowRight');
  assert.equal(s.sidebar.isExpanded('crm'), false, 'recolhido: → não abre o submenu');
});

test('[SIDE-11] MENU DO CELULAR: fora da tela o menu fica inerte (o teclado não o alcança); o botão do topo abre e fecha; ao abrir o foco entra no menu e o conteúdo fica inerte; ESC, o fundo, o botão "Fechar menu" e escolher um destino fecham; o foco volta ao botão', async () => {
  const vp = viewportFalso(true);
  const s = await montar({ viewport: vp });
  const topo = s.browser.by.cls(s.sidebar.topbar, 'topbar-menu')[0];
  const fechar = s.browser.by.cls(s.sidebar.aside, 'sidebar-close')[0];
  assert.equal(s.sidebar.aside.hasAttribute('inert'), true, 'fechado no celular: inerte');
  assert.equal(topo.getAttribute('aria-label'), 'Abrir menu');
  assert.equal(topo.getAttribute('aria-expanded'), 'false');
  assert.equal(topo.getAttribute('aria-controls'), 'sidebar');
  assert.equal(s.shell.getAttribute('data-nav-open'), 'false');

  s.browser.click(topo);
  assert.equal(s.sidebar.isMobileOpen(), true);
  assert.equal(s.shell.getAttribute('data-nav-open'), 'true');
  assert.equal(s.sidebar.aside.hasAttribute('inert'), false);
  assert.equal(s.main.hasAttribute('inert'), true, 'o conteúdo fica inerte enquanto o menu está aberto');
  assert.equal(topo.getAttribute('aria-expanded'), 'true');
  assert.equal(topo.getAttribute('aria-label'), 'Fechar menu');
  assert.equal(s.browser.document.activeElement, s.link('overview'), 'o foco entra no menu');

  s.browser.press('Escape');
  assert.equal(s.sidebar.isMobileOpen(), false, 'ESC fecha');
  assert.equal(s.sidebar.aside.hasAttribute('inert'), true);
  assert.equal(s.main.hasAttribute('inert'), false);
  assert.equal(s.browser.document.activeElement, topo, 'e o foco volta ao botão do topo');
  assert.equal(s.browser.document.listenerCount('keydown'), 0, 'o ouvinte de ESC é removido ao fechar');

  s.browser.click(topo);
  s.browser.click(s.sidebar.backdrop);
  assert.equal(s.sidebar.isMobileOpen(), false, 'o fundo fecha');

  s.browser.click(topo);
  s.browser.click(fechar);
  assert.equal(s.sidebar.isMobileOpen(), false, 'o botão de fechar fecha');

  s.browser.click(topo);
  s.browser.click(s.link('overview'));
  await s.browser.flush();
  assert.equal(s.sidebar.isMobileOpen(), false, 'escolher um destino fecha');
  assert.equal(s.browser.window.location.hash, '#/');

  // com uma camada aberta (painel lateral/confirmação) o ESC é DELA, não do menu
  s.browser.click(topo);
  s.browser.document.body.setAttribute('data-overlay-open', '');
  s.browser.press('Escape');
  assert.equal(s.sidebar.isMobileOpen(), true, 'o menu não fecha por baixo de uma camada aberta');
  s.browser.document.body.removeAttribute('data-overlay-open');
  s.browser.press('Escape');
  assert.equal(s.sidebar.isMobileOpen(), false);

  // virar desktop com o menu aberto fecha o menu e tira a inércia
  s.browser.click(topo);
  vp.mudar(false);
  assert.equal(s.sidebar.isMobileOpen(), false);
  assert.equal(s.sidebar.aside.hasAttribute('inert'), false);
  assert.equal(s.main.hasAttribute('inert'), false);
  vp.mudar(true);
  assert.equal(s.sidebar.aside.hasAttribute('inert'), true, 'de volta ao celular: fechado e inerte');

  s.sidebar.destroy();
  assert.equal(vp.ouvintes(), 0, 'destroy() solta a assinatura do tamanho da tela');
});

test('[SIDE-12] no celular o recolhimento do desktop não vale: o menu aberto mostra ícones e nomes, e a preferência não é gravada por abrir/fechar o menu do celular', async () => {
  const prefs = memoria();
  const { createVisualPreferences } = await loadPrefs();
  const vp = viewportFalso(true);
  const s = await montar({ viewport: vp, preferences: createVisualPreferences({ localStorage: prefs }) });
  s.browser.click(s.browser.by.cls(s.sidebar.topbar, 'topbar-menu')[0]);
  s.browser.click(s.browser.by.cls(s.sidebar.aside, 'sidebar-close')[0]);
  assert.deepEqual(prefs.chamadas, [], 'abrir e fechar o menu do celular não grava nada');
  // clicar num grupo no celular alterna o grupo (não "expande o menu todo")
  s.sidebar.setCollapsed(true);
  prefs.chamadas.length = 0;
  s.browser.click(s.browser.by.cls(s.sidebar.topbar, 'topbar-menu')[0]); // abre o menu do celular
  s.browser.click(s.link('prospecting-group'));
  assert.equal(s.sidebar.isExpanded('prospecting-group'), true);
  assert.equal(s.sidebar.isCollapsed(), true, 'no celular o grupo só abre; a preferência do desktop fica como está');
  assert.deepEqual(prefs.chamadas, []);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A preferência visual (a única exceção de armazenamento)
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[SIDE-13] a PREFERÊNCIA: guarda só "1"/"0" numa única chave; lê de volta; ignora valores estranhos; nunca guarda outra coisa; um menu novo nasce com a preferência salva', async () => {
  const { createVisualPreferences, SIDEBAR_COLLAPSED_KEY } = await loadPrefs();
  assert.equal(SIDEBAR_COLLAPSED_KEY, 'riox7.sidebar.collapsed');
  const prefs = memoria();
  const p = createVisualPreferences({ localStorage: prefs });
  assert.equal(p.getSidebarCollapsed(), false, 'sem nada guardado: expandido');
  p.setSidebarCollapsed(true);
  p.setSidebarCollapsed(false);
  p.setSidebarCollapsed(1);
  p.setSidebarCollapsed('qualquer coisa');
  p.setSidebarCollapsed(0);
  assert.deepEqual(prefs.chamadas, [['riox7.sidebar.collapsed', '1'], ['riox7.sidebar.collapsed', '0'], ['riox7.sidebar.collapsed', '1'], ['riox7.sidebar.collapsed', '1'], ['riox7.sidebar.collapsed', '0']], 'só a chave e só "1"/"0"');
  assert.deepEqual([...prefs.dados.keys()], ['riox7.sidebar.collapsed']);
  p.setSidebarCollapsed(true);
  assert.equal(createVisualPreferences({ localStorage: prefs }).getSidebarCollapsed(), true, 'outra "visita" lê o valor guardado');
  for (const estranho of ['true', 'sim', '2', '', '{"a":1}', '<script>']) {
    prefs.dados.set('riox7.sidebar.collapsed', estranho);
    assert.equal(createVisualPreferences({ localStorage: prefs }).getSidebarCollapsed(), false, `valor estranho "${estranho}" é ignorado`);
  }

  // o menu usa a preferência: um menu novo já nasce recolhido; recolher/expandir grava
  prefs.dados.set('riox7.sidebar.collapsed', '1');
  const nascido = await montar({ preferences: createVisualPreferences({ localStorage: prefs }) });
  assert.equal(nascido.sidebar.isCollapsed(), true);
  assert.equal(nascido.shell.getAttribute('data-sidebar'), 'collapsed');
  nascido.browser.click(nascido.browser.by.cls(nascido.sidebar.aside, 'sidebar-toggle')[0]);
  assert.equal(prefs.dados.get('riox7.sidebar.collapsed'), '0');
});

test('[SIDE-14] FALHA DO ARMAZENAMENTO nunca quebra o menu: localStorage ausente, que lança ao ser ACESSADO, que lança ao ler, que lança ao gravar (cota cheia) ou sem getItem — a preferência vale só na página e o menu segue funcionando', async () => {
  const { createVisualPreferences } = await loadPrefs();
  const cenarios = {
    'sem armazenamento': null,
    'sem localStorage': {},
    'acessar lança (site bloqueado)': { get localStorage() { throw new Error('SecurityError'); } },
    'ler lança': { localStorage: { getItem() { throw new Error('boom'); }, setItem() {} } },
    'gravar lança (cota cheia)': { localStorage: { getItem: () => null, setItem() { throw new Error('QuotaExceededError'); } } },
    'sem métodos': { localStorage: { foo: 1 } },
    'localStorage nulo': { localStorage: null },
  };
  for (const [nome, global] of Object.entries(cenarios)) {
    const p = createVisualPreferences(global);
    assert.doesNotThrow(() => p.getSidebarCollapsed(), nome);
    assert.doesNotThrow(() => p.setSidebarCollapsed(true), nome);
    // vale na memória da página, mesmo sem armazenamento
    assert.equal(p.getSidebarCollapsed(), true, `${nome}: lembra durante a página`);
    const s = await montar({ preferences: p });
    s.browser.click(s.browser.by.cls(s.sidebar.aside, 'sidebar-toggle')[0]);
    assert.doesNotThrow(() => s.browser.click(s.browser.by.cls(s.sidebar.aside, 'sidebar-toggle')[0]), nome);
    assert.equal(typeof s.sidebar.isCollapsed(), 'boolean', nome);
    s.browser.click(s.link('crm'));
    assert.equal(s.browser.window.location.hash, '#/crm/dashboard', `${nome}: o menu continua navegando`);
  }
  // sem preferências nenhuma (testes, ambientes sem armazenamento) o menu também funciona
  const sem = await montar({ preferences: null });
  sem.sidebar.toggleCollapsed();
  assert.equal(sem.sidebar.isCollapsed(), true);
});

test('[SIDE-15] nada além da preferência é guardado: nem a expansão dos submenus, nem a seção ativa, nem a contagem, nem permissões — só a chave do menu recolhido, com "1" ou "0"', async () => {
  const { createVisualPreferences } = await loadPrefs();
  const prefs = memoria();
  const s = await montar({ preferences: createVisualPreferences({ localStorage: prefs }) });
  s.sidebar.toggleBranch('crm');
  s.sidebar.setActive('crm-settings-origins');
  s.sidebar.setBadge('approvals', 7);
  s.browser.click(s.link('crm-clients'));
  assert.deepEqual(prefs.chamadas, [], 'expandir submenus, navegar e contar pendentes não gravam nada');
  s.sidebar.toggleCollapsed();
  assert.deepEqual(prefs.chamadas, [['riox7.sidebar.collapsed', '1']]);
  const gravado = JSON.stringify([...prefs.dados.entries()]);
  for (const proibido of ['permissions', 'canReadCrm', 'token', 'user', 'crm:', 'approvals', 'pendente', '7']) assert.doesNotMatch(gravado.replace('riox7.sidebar.collapsed', ''), new RegExp(proibido.replace(/[:]/g, '\\$&')));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Ícones e CSS
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[SIDE-16] ÍCONES: o menu copia os ícones que estão em index.html (nenhum carregado de fora, nenhum com id duplicado); sem eles, um espaço vazio (nunca texto); a cópia não repete o id', async () => {
  const { ICON_NAMES, flattenTree, NAV_TREE } = await loadNav();
  const { iconNode } = await loadSidebar();
  const html = fs.readFileSync(path.join(DASHBOARD_ROOT, 'index.html'), 'utf8');
  for (const nome of ICON_NAMES) assert.match(html, new RegExp(`<svg id="rx7-icon-${nome}" class="icon"`), `falta o ícone ${nome} em index.html`);
  const ids = [...html.matchAll(/id="(rx7-icon-[a-z]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'sem ids duplicados');
  assert.equal(ids.length, ICON_NAMES.length, 'e nenhum ícone sobrando sem uso');
  for (const { item } of flattenTree(NAV_TREE)) if (item.icon) assert.ok(ICON_NAMES.includes(item.icon), `o ícone ${item.icon} do menu existe`);
  assert.doesNotMatch(html.slice(html.indexOf('rx7-icons')), /(src|href|xlink:href)=["'](https?:)?\/\//i, 'nenhum ícone vem de fora');
  assert.match(html, /<div id="rx7-icons" hidden>/);

  const { createBrowser: criar } = require('../helpers/fakeDom');
  const b = criar();
  const vazio = iconNode(b.document, 'home');
  assert.match(vazio.className, /icon-missing/);
  assert.equal(vazio.textContent, '', 'sem o conjunto de ícones: espaço vazio, nunca texto');
  // com o conjunto: uma cópia, sem o id
  const original = b.document.createElement('svg');
  original.setAttribute('id', 'rx7-icon-home');
  original.className = 'icon';
  const documento = { getElementById: (id) => (id === 'rx7-icon-home' ? original : null), createElement: (tag) => b.document.createElement(tag) };
  documento.getElementById = (id) => (id === 'rx7-icon-home' ? Object.assign(original, { cloneNode: () => { const c = b.document.createElement('svg'); c.setAttribute('id', 'rx7-icon-home'); c.className = 'icon'; return c; } }) : null);
  const copia = iconNode(documento, 'home');
  assert.equal(copia.getAttribute('id'), null, 'a cópia não repete o id');
  assert.equal(copia.className, 'icon');
});

test('[SIDE-17] o CSS traz o menu recolhido (largura própria, nomes fora da tela e não escondidos do leitor de tela, dicas por data-tip), a hierarquia (indentação por nível) e o menu do celular (fora da tela, abre por cima, com fundo) — sem url(), sem estilo inline', () => {
  const css = fs.readFileSync(path.join(DASHBOARD_ROOT, 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(css, /--sidebar-w-collapsed:\s*\d+px/);
  assert.match(css, /\.shell\[data-sidebar="collapsed"\]\s*\{\s*grid-template-columns:\s*var\(--sidebar-w-collapsed\)/);
  assert.match(css, /\[data-sidebar="collapsed"\] \.nav-label[^{]*\{[^}]*clip:\s*rect\(0 0 0 0\)/, 'o nome sai da tela mas continua para o leitor de tela');
  assert.doesNotMatch(css, /\[data-sidebar="collapsed"\] \.nav-label[^{]*\{[^}]*display:\s*none/, 'display:none esconderia o nome do leitor de tela');
  assert.match(css, /\[data-tip\]:hover::before[\s\S]*content:\s*attr\(data-tip\)/, 'a dica vem do atributo');
  assert.match(css, /\[data-tip\]:focus-visible::before/, 'e também no foco do teclado');
  assert.match(css, /\.nav-sub \{[^}]*margin:[^}]*padding-left:/, 'cada nível entra mais para dentro');
  assert.match(css, /\.nav-sub \.nav-sub \{[^}]*margin-left:/, 'e o segundo nível mais ainda');
  assert.match(css, /\.nav-arrow\[aria-expanded="true"\] \.icon \{[^}]*rotate\(90deg\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.sidebar \{[\s\S]*position: fixed[\s\S]*transform: translateX\(-100%\)/, 'no celular o menu sai da tela');
  assert.match(css, /\.shell\[data-nav-open="true"\] \.sidebar \{ transform: none/);
  assert.match(css, /\.shell\[data-nav-open="true"\] \.nav-backdrop/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  // com muitos itens (grupo Gestão aberto) só a navegação rola e o rodapé com o usuário e o Sair não é coberto; recolhido no desktop a rolagem sai para as dicas não serem cortadas
  assert.match(css, /\n\.nav \{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/, 'a navegação rola sozinha');
  assert.match(css, /\.shell\[data-sidebar="collapsed"\] \.nav \{\s*overflow:\s*visible/, 'recolhido: sem rolagem, para a dica aparecer fora do menu');
  // no celular o topo tem a altura do conteúdo (a grade não reparte o espaço livre entre as linhas)
  assert.match(css, /\.shell, \.shell\[data-sidebar="collapsed"\] \{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  // a referência "em desenvolvimento" põe o nome e o selo em duas linhas, sempre do mesmo jeito
  assert.match(css, /\.nav-link\.soon \{[^}]*flex-direction:\s*column/);
  assert.doesNotMatch(css, /url\(/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// As rotas: novas e antigas
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[SIDE-18] ROTAS: as novas existem (dashboard, clientes, metas, configurações e os 4 cadastros) com ida e volta; as ANTIGAS continuam exatamente como eram (#/crm, novo, ficha, aprovações, funis, prospecção...); sectionOf separa a tela do destaque do menu', async () => {
  const { parseRoute, buildHash, sectionOf } = await loadRouter();
  const novas = {
    '#/crm/dashboard': 'crm-dashboard', '#/crm/clientes': 'crm-clients', '#/crm/metas': 'crm-goals', '#/crm/configuracoes': 'crm-settings',
    '#/crm/configuracoes/servicos': 'crm-settings-services', '#/crm/configuracoes/nichos': 'crm-settings-niches', '#/crm/configuracoes/funis': 'crm-settings-funnels', '#/crm/configuracoes/origens': 'crm-settings-origins',
  };
  for (const [hash, nome] of Object.entries(novas)) {
    assert.deepEqual(parseRoute(hash), { name: nome }, hash);
    assert.equal(buildHash({ name: nome }), hash);
    assert.deepEqual(parseRoute(`${hash}/`), { name: nome }, `${hash}/ com barra no fim`);
  }
  const antigas = [
    ['#/', { name: 'overview' }], ['#/crm', { name: 'crm-list' }], ['#/crm/novo', { name: 'crm-new' }], ['#/crm/registro/crm%3Aa', { name: 'crm-record', id: 'crm:a' }],
    ['#/aprovacoes', { name: 'approvals' }], ['#/aprovacoes/id%3Ax', { name: 'approval-lead', id: 'id:x' }], ['#/agentes', { name: 'agents' }], ['#/funis', { name: 'funnels' }],
    ['#/prospeccao', { name: 'prospecting' }], ['#/prospeccao/historico', { name: 'prospecting-history' }], ['#/prospeccao/historico/JOB-1', { name: 'prospecting-job', id: 'JOB-1' }],
    ['#/prospeccao/leads-reprovados', { name: 'rejected-leads' }], ['#/prospeccao/leads-reprovados/id%3Ax', { name: 'rejected-lead', id: 'id:x' }], ['#/exclusoes-permanentes', { name: 'prospecting-exclusions' }],
    ['#/prospeccao/briefing/PROS-1', { name: 'prospecting-brief', id: 'PROS-1' }], ['#/prospeccao/execucao/JOB-1', { name: 'prospecting-run', id: 'JOB-1' }],
  ];
  for (const [hash, rota] of antigas) {
    assert.deepEqual(parseRoute(hash), rota, hash);
    assert.equal(buildHash(rota), hash === '#/' ? '#/' : hash.replace('JOB-1', 'JOB-1'), `ida e volta de ${hash}`);
  }
  // endereços que não existem seguem "não encontrado" (nada é remapeado em silêncio)
  for (const hash of ['#/crm/configuracoes/outra', '#/crm/dashboard/x', '#/crm/clientes/x', '#/crm/metas/x', '#/crm/configuracoes/__proto__', '#/crm/configuracoes/constructor', '#/crm/registro/', '#/crm/pf', '#/clientes']) {
    assert.deepEqual(parseRoute(hash), { name: 'not-found' }, hash);
  }
  // as referências "em desenvolvimento" do grupo Gestão NÃO têm rota: nenhum endereço falso foi criado para elas
  for (const hash of ['#/agenda', '#/conversas', '#/reunioes', '#/propostas', '#/relatorios', '#/configuracoes', '#/leads', '#/gestao']) {
    assert.deepEqual(parseRoute(hash), { name: 'not-found' }, hash);
  }
  // a TELA: #/crm e #/crm/clientes mostram a mesma; as páginas futuras são outra
  assert.equal(sectionOf({ name: 'crm-list' }), 'crm');
  assert.equal(sectionOf({ name: 'crm-clients' }), 'crm');
  assert.equal(sectionOf({ name: 'crm-record' }), 'crm');
  for (const nome of ['crm-dashboard', 'crm-goals', 'crm-settings-funnels']) assert.equal(sectionOf({ name: nome }), 'crm-future', nome);
  // Configurações do CRM é uma página real (os acessos aos cadastros): tem a sua própria seção
  assert.equal(sectionOf({ name: 'crm-settings' }), 'crm-settings');
  // os três catálogos (Fase 2B-2) são telas reais, com o painel de novo item e o de edição na mesma seção
  for (const nome of ['crm-settings-services', 'crm-settings-niches', 'crm-settings-origins']) assert.equal(sectionOf({ name: nome }), 'crm-catalogs', nome);
  assert.equal(sectionOf({ name: 'crm-catalog-new', catalog: 'servicos' }), 'crm-catalogs');
  assert.equal(sectionOf({ name: 'crm-catalog-item', catalog: 'nichos', id: 'niche:x' }), 'crm-catalogs');
  assert.equal(sectionOf({ name: 'crm-catalog-item', catalog: 'desconhecido', id: 'x' }), null, 'um catálogo desconhecido não é uma tela');
  assert.equal(sectionOf({ name: 'funnels' }), 'funnels');
  assert.equal(sectionOf({ name: 'approvals' }), 'approvals');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// As referências dos módulos antigos ainda inexistentes (grupo Gestão)
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[SIDE-19] GESTÃO guarda a referência dos módulos antigos que ainda não existem (Agenda, Conversas, Reuniões, Propostas, Relatórios, Configurações gerais): desabilitados, sem rota, sem link nem botão, respeitando a permissão — e "Leads" NÃO é repetido porque já existe acesso real', async () => {
  const { NAV_TREE, visibleTree, flattenTree } = await loadNav();
  const gestao = NAV_TREE.find((item) => item.id === 'management');
  assert.deepEqual(gestao.children.map((item) => item.id), ['prospecting-exclusions', 'agenda', 'conversations', 'meetings', 'proposals', 'reports', 'settings']);
  const futuros = gestao.children.filter((item) => item.id !== 'prospecting-exclusions');
  assert.deepEqual(futuros.map((item) => item.label), ['Agenda', 'Conversas', 'Reuniões', 'Propostas', 'Relatórios', 'Configurações gerais']);
  for (const item of futuros) {
    assert.equal(item.route, undefined, `${item.label}: sem rota`);
    assert.equal(item.children, undefined, `${item.label}: sem filhos`);
  }
  assert.ok(gestao.children[0].route, 'Exclusões Permanentes continua sendo a única entrada funcional do grupo');

  // nada duplicado: os rótulos da árvore são únicos e "Leads" (que já tem acesso real em Clientes, Fila de Aprovação e Leads Reprovados) não ganhou item desabilitado
  const rotulos = flattenTree(NAV_TREE).map(({ item }) => item.label);
  assert.equal(new Set(rotulos).size, rotulos.length, 'nenhum rótulo repetido no menu');
  assert.equal(rotulos.includes('Leads'), false);
  assert.equal(rotulos.includes('Configurações'), false, 'o nome curto ficaria confuso ao lado de "Configurações do CRM"');

  // PERMISSÃO: as quatro referências comerciais pedem READ:CRM; Relatórios e Configurações gerais seguem sem permissão, como no menu antigo
  assert.deepEqual(futuros.map((item) => item.needs || null), ['canReadCrm', 'canReadCrm', 'canReadCrm', 'canReadCrm', null, null]);
  const filhosDeGestao = (permissions) => visibleTree(NAV_TREE, permissions).find((item) => item.id === 'management').children.map((item) => item.label);
  assert.deepEqual(filhosDeGestao(TUDO), ['Exclusões Permanentes', 'Agenda', 'Conversas', 'Reuniões', 'Propostas', 'Relatórios', 'Configurações gerais']);
  assert.deepEqual(filhosDeGestao(VENDEDOR), ['Agenda', 'Conversas', 'Reuniões', 'Propostas', 'Relatórios', 'Configurações gerais']);
  assert.deepEqual(filhosDeGestao(SO_FILA), ['Relatórios', 'Configurações gerais']);

  // NO MENU DESENHADO: texto simples desabilitado e marcado, fora do teclado, sem nenhum link para uma rota falsa
  const s = await montar();
  assert.equal(s.nivel0().includes('Gestão'), true);
  const links = s.rotulos();
  for (const nome of ['Agenda', 'Conversas', 'Reuniões', 'Propostas', 'Relatórios', 'Configurações gerais', 'Leads']) assert.equal(links.includes(nome), false, `${nome} não é link`);
  for (const id of ['agenda', 'conversations', 'meetings', 'proposals', 'reports', 'settings']) {
    const parado = s.link(id);
    assert.equal(parado.localName, 'span', id);
    assert.equal(parado.getAttribute('aria-disabled'), 'true', id);
    assert.equal(parado.getAttribute('href'), null, id);
    assert.equal(parado.getAttribute('tabindex'), null, `${id}: fora da ordem do teclado`);
    assert.match(parado.textContent, /Em desenvolvimento/, id);
  }
  for (const nome of ['Agenda', 'Conversas', 'Reuniões', 'Propostas', 'Relatórios', 'Configurações gerais']) assert.ok(!s.browser.by.button(s.nav, nome), `${nome} não é botão`);

  // com a conta sem READ:CRM o menu desenhado mostra só as duas sem permissão
  const parcial = await montar({ permissions: SO_FILA });
  assert.equal(parcial.link('agenda'), null);
  assert.equal(parcial.link('proposals'), null);
  assert.ok(parcial.link('reports') && parcial.link('settings'));
});
