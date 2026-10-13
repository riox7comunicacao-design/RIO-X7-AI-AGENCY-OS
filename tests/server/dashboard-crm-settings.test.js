// A página CONFIGURAÇÕES DO CRM (CRM 5.0, Fase 2B-2, refinamento): #/crm/configuracoes deixou de ser "EM DESENVOLVIMENTO" e virou a porta de entrada dos cadastros — cartões para Serviços, Nichos e
// Cores e Origens dos Leads (rotas reais) e a Gestão de Funis e Etapas como cartão desabilitado EM DESENVOLVIMENTO. Permissões, ausência de dados simulados, navegação entre a página e as telas.
// DOM de teste, SDK falso e fetch roteado — nenhuma credencial real, nenhuma rede, nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');

const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');
const H = require('../helpers/catalogHarness');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const loadView = () => import('../../dashboard/views/crmSettings.mjs');
const loadRouter = () => import('../../dashboard/router.mjs');
const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const me = (role, name, extras = {}) => ({ userId: `user-${name.toLowerCase()}`, name, role, permissions: [...authConstants.getRolePermissions(role)], status: 'ACTIVE', ...extras });
const ME_ADMIN = me('ADMIN', 'Breno');
const ME_CLOSER = me('COMMERCIAL_CLOSER', 'Rafael');
const SEM_FUNIS = { ...ME_ADMIN, permissions: ME_ADMIN.permissions.filter((p) => p !== 'MANAGE:FUNNELS') };
const SO_FUNIS = { ...ME_ADMIN, permissions: ME_ADMIN.permissions.filter((p) => p !== 'MANAGE:CRM_CATALOGS') };
const NO_ACCESS = /Esta conta não possui acesso a esta área\./;

const ROTAS_DOS_CARTOES = { servicos: '#/crm/configuracoes/servicos', nichos: '#/crm/configuracoes/nichos', origens: '#/crm/configuracoes/origens' };

// ---------------------------------------------------------------------------------------------------------------------------------------------
// a página sozinha
// ---------------------------------------------------------------------------------------------------------------------------------------------

async function montar(permissions) {
  const { createCrmSettingsView } = await loadView();
  const browser = createBrowser();
  const view = createCrmSettingsView({ document: browser.document, root: browser.root, permissions });
  view.render();
  return { browser, view };
}
const ehCartao = (el) => el.className.split(/\s+/).includes('settings-card'); // o token inteiro: "settings-card-title" não é um cartão
const cartoes = (s) => s.browser.findAll(s.browser.root, ehCartao);

test('[CRMSET-1] OS ACESSOS por permissão: os três cadastros pedem MANAGE:CRM_CATALOGS e a Gestão de Funis e Etapas pede MANAGE:FUNNELS; só o booleano verdadeiro vale; as rotas dos cartões são as REAIS do roteador', async () => {
  const { visibleSettingsEntries, SETTINGS_ENTRIES } = await loadView();
  const { parseRoute, buildHash, CATALOG_LIST_ROUTES } = await loadRouter();
  const ids = (permissions) => visibleSettingsEntries(permissions).map((e) => e.id);
  assert.deepEqual(ids({ canManageCrmCatalogs: true, canManageFunnels: true }), ['servicos', 'nichos', 'origens', 'funis']);
  assert.deepEqual(ids({ canManageCrmCatalogs: true, canManageFunnels: false }), ['servicos', 'nichos', 'origens']);
  assert.deepEqual(ids({ canManageCrmCatalogs: false, canManageFunnels: true }), ['funis']);
  for (const nenhuma of [null, undefined, {}, { canReadCrm: true }, { canManageCrmCatalogs: 'true', canManageFunnels: 1 }, { canManageCrmCatalogs: false, canManageFunnels: false }]) assert.deepEqual(ids(nenhuma), [], JSON.stringify(nenhuma));
  assert.deepEqual(SETTINGS_ENTRIES.map((e) => e.needs), ['canManageCrmCatalogs', 'canManageCrmCatalogs', 'canManageCrmCatalogs', 'canManageFunnels']);
  // cada cartão funcional abre uma rota que existe e leva à tela do catálogo; a que ainda não existe não tem rota
  const funcionais = SETTINGS_ENTRIES.filter((e) => e.route);
  assert.deepEqual(funcionais.map((e) => e.route.name), [CATALOG_LIST_ROUTES.servicos, CATALOG_LIST_ROUTES.nichos, CATALOG_LIST_ROUTES.origens]);
  for (const entrada of funcionais) assert.deepEqual(parseRoute(buildHash(entrada.route)), entrada.route);
  assert.equal(SETTINGS_ENTRIES.find((e) => e.id === 'funis').route, null);
  assert.ok(Object.isFrozen(SETTINGS_ENTRIES) && SETTINGS_ENTRIES.every((e) => Object.isFrozen(e)));
});

test('[CRMSET-2] A PÁGINA do administrador: título, texto objetivo, três cartões-link para as rotas reais e a Gestão de Funis e Etapas como cartão desabilitado EM DESENVOLVIMENTO; nada simulado', async () => {
  const s = await montar({ canManageCrmCatalogs: true, canManageFunnels: true });
  const raiz = s.browser.root;
  assert.equal(s.browser.by.tag(raiz, 'h2')[0].textContent, 'Configurações do CRM');
  assert.match(raiz.textContent, /Os cadastros que organizam o CRM\. Escolha o que você quer administrar\./);
  const todos = cartoes(s);
  assert.deepEqual(todos.map((c) => c.getAttribute('data-entry')), ['servicos', 'nichos', 'origens', 'funis']);
  assert.deepEqual(todos.map((c) => c.localName), ['a', 'a', 'a', 'div']);
  for (const [id, href] of Object.entries(ROTAS_DOS_CARTOES)) {
    const cartao = todos.find((c) => c.getAttribute('data-entry') === id);
    assert.equal(cartao.getAttribute('href'), href, id);
    assert.match(cartao.textContent, /Abrir →/);
    assert.equal(s.browser.find(cartao, (el) => el.className.includes('settings-card-go')).getAttribute('aria-hidden'), 'true', 'a seta é decorativa');
  }
  assert.deepEqual(todos.slice(0, 3).map((c) => s.browser.find(c, (el) => el.className === 'settings-card-title').textContent), ['Serviços', 'Nichos e Cores', 'Origens dos Leads']);
  assert.match(todos[0].textContent, /O catálogo de serviços que a agência oferece, com o preço de referência de cada um\./);
  assert.match(todos[1].textContent, /Os nichos de atuação dos clientes e a cor que identifica cada um\./);
  assert.match(todos[2].textContent, /De onde os leads chegam: prospecção ativa, anúncio, indicação e outros canais\./);

  const funis = todos[3];
  assert.equal(s.browser.find(funis, (el) => el.className === 'settings-card-title').textContent, 'Gestão de Funis e Etapas');
  assert.match(funis.textContent, /EM DESENVOLVIMENTO/);
  assert.equal(funis.getAttribute('aria-disabled'), 'true');
  assert.equal(funis.getAttribute('href'), null, 'não é link: não existe ainda');
  assert.equal(s.browser.by.tag(funis, 'a').length, 0);
  assert.equal(s.browser.by.tag(raiz, 'a').length, 3, 'só os três acessos funcionais são links');

  // nenhuma informação simulada: sem contagens, números, tabelas, formulários, botões de ação ou campos
  for (const tag of ['table', 'form', 'input', 'button', 'select', 'textarea', 'ul', 'li']) assert.equal(s.browser.by.tag(raiz, tag).length, 0, tag);
  assert.doesNotMatch(raiz.textContent, /\d/, 'nenhum número na página (nada de contagem inventada)');
  assert.doesNotMatch(raiz.textContent, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/);
  assert.equal(s.browser.findAll(raiz, (el) => el.hasAttribute('style')).length, 0, 'nenhum estilo inline');
  assert.equal(s.browser.findAll(raiz, (el) => el.localName === 'a' && /^https?:/i.test(el.getAttribute('href') || '')).length, 0);
});

test('[CRMSET-3] SÓ O QUE A CONTA PODE: sem MANAGE:FUNNELS não há o cartão de funis; sem MANAGE:CRM_CATALOGS não há links de cadastro; sem nenhuma, a página diz que não há o que administrar (e não mostra link algum)', async () => {
  const semFunis = await montar({ canManageCrmCatalogs: true, canManageFunnels: false });
  assert.deepEqual(cartoes(semFunis).map((c) => c.getAttribute('data-entry')), ['servicos', 'nichos', 'origens']);
  assert.doesNotMatch(semFunis.browser.root.textContent, /Funis|EM DESENVOLVIMENTO/);

  const soFunis = await montar({ canManageCrmCatalogs: false, canManageFunnels: true });
  assert.deepEqual(cartoes(soFunis).map((c) => c.getAttribute('data-entry')), ['funis']);
  assert.equal(soFunis.browser.by.tag(soFunis.browser.root, 'a').length, 0, 'nenhum link de cadastro');
  assert.doesNotMatch(soFunis.browser.root.textContent, /Serviços|Nichos|Origens/);

  for (const permissions of [{ canManageCrmCatalogs: false, canManageFunnels: false }, {}, null]) {
    const nada = await montar(permissions);
    assert.equal(cartoes(nada).length, 0);
    assert.equal(nada.browser.by.tag(nada.browser.root, 'a').length, 0);
    assert.match(nada.browser.root.textContent, /Sua conta não tem nenhuma configuração para administrar\./);
  }
  const s = await montar({ canManageCrmCatalogs: true, canManageFunnels: true });
  s.view.destroy();
  assert.equal(s.browser.root.childNodes.length, 0, 'destruir limpa a página');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// dentro do painel inteiro
// ---------------------------------------------------------------------------------------------------------------------------------------------

async function iniciar({ perfil = ME_ADMIN, hash = '' } = {}) {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await loadRouter();
  const { createFakeSdk, scriptedFetch, FAKE_SESSION, crmRecord } = await loadFixtures();
  const itens = [crmRecord({ id: 'crm:a', empresa: 'Clínica Alfa', status: 'CONTACTED', nicho: 'Psicologia', dataDeEntrada: '2026-09-12T10:00:00.000Z' })];
  const lista = (c) => () => ({ items: [c === 'servicos' ? H.servico(1, { nome: 'Gestão de redes' }) : c === 'nichos' ? H.nicho(1, { nome: 'Estética' }) : H.origem(1, { nome: 'Indicação' })] });
  const browser = createBrowser({ hash });
  const sdk = createFakeSdk({ session: FAKE_SESSION });
  const fetchImpl = scriptedFetch({
    'GET /config.json': CONFIG,
    'GET /api/me': perfil,
    'GET /api/crm': { items: itens },
    'GET /api/approvals': { estado: 'AGUARDANDO_REVISAO', items: [] },
    'GET /api/crm-catalogs/servicos': lista('servicos'),
    'GET /api/crm-catalogs/nichos': lista('nichos'),
    'GET /api/crm-catalogs/origens': lista('origens'),
  });
  const navigation = browserNavigation(browser.window);
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk, navigation });
  await browser.flush(10);
  return { browser, fetchImpl, win: browser.window };
}
const principal = (t) => t.browser.by.id(t.browser.root, 'main');
const nav = (t) => t.browser.by.tag(t.browser.root, 'nav')[0];
const links = (t) => t.browser.by.tag(nav(t), 'a');
const marcados = (t) => links(t).filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent);
const apiDeCatalogo = (t) => t.fetchImpl.calls.filter((c) => c.path.startsWith('/api/crm-catalogs')).map((c) => `${c.method} ${c.path}`);
const porRotulo = (t, rotulo) => t.browser.find(t.browser.root, (el) => el.localName === 'button' && el.getAttribute('aria-label') === rotulo);
const ir = async (t, hash) => {
  t.win.location.hash = hash;
  await t.browser.flush(10);
};
const clicar = async (t, el) => {
  t.browser.click(el);
  await t.browser.flush(10);
};
const cartaoDe = (t, id) => t.browser.find(principal(t), (el) => ehCartao(el) && el.getAttribute('data-entry') === id);
const migalha = (t) => t.browser.find(principal(t), (el) => el.localName === 'nav' && el.className === 'breadcrumb');

test('[CRMSET-4] NO PAINEL, o administrador abre "Configurações do CRM" pelo menu: a página real (não "em desenvolvimento"), título da aba, entrada acesa, nenhuma chamada à API; cada cartão abre a tela real e o caminho de volta funciona', async () => {
  const t = await iniciar();
  await clicar(t, porRotulo(t, 'Expandir CRM'));
  const entrada = t.browser.by.link(nav(t), 'Configurações do CRM');
  assert.equal(entrada.href, '#/crm/configuracoes');
  assert.equal(entrada.getAttribute('data-soon'), null, 'o item do menu não é mais "em desenvolvimento"');
  assert.ok(!/\bis-soon\b/.test(entrada.className));
  const antes = t.fetchImpl.calls.length;
  await clicar(t, entrada);
  assert.equal(t.win.location.hash, '#/crm/configuracoes');
  assert.equal(t.browser.by.tag(principal(t), 'h2')[0].textContent, 'Configurações do CRM');
  assert.match(principal(t).textContent, /Os cadastros que organizam o CRM/);
  assert.equal(t.browser.document.title, 'Configurações do CRM — Rio X7 AI Agency OS');
  assert.deepEqual(marcados(t), ['Configurações do CRM']);
  assert.deepEqual(t.fetchImpl.calls.slice(antes), [], 'a página não chama a API');
  assert.equal(apiDeCatalogo(t).length, 0);
  assert.deepEqual(t.browser.by.cls(principal(t), 'settings-card').map((c) => c.getAttribute('data-entry')), ['servicos', 'nichos', 'origens', 'funis']);

  // cada cartão abre a SUA tela real
  for (const [id, hash, h2, conteudo] of [['servicos', '#/crm/configuracoes/servicos', 'Serviços', /Gestão de redes/], ['nichos', '#/crm/configuracoes/nichos', 'Nichos e Cores', /Estética/], ['origens', '#/crm/configuracoes/origens', 'Origens dos Leads', /Indicação/]]) {
    await clicar(t, cartaoDe(t, id));
    assert.equal(t.win.location.hash, hash, id);
    assert.equal(t.browser.by.tag(principal(t), 'h2')[0].textContent, h2);
    assert.match(principal(t).textContent, conteudo);
    assert.doesNotMatch(principal(t).textContent, /EM DESENVOLVIMENTO/);
    // o caminho de volta: a migalha e o Voltar do navegador
    const caminho = migalha(t);
    assert.equal(caminho.getAttribute('aria-label'), 'Você está em');
    assert.equal(t.browser.by.tag(caminho, 'a')[0].textContent, 'Configurações do CRM');
    assert.equal(t.browser.by.tag(caminho, 'a')[0].getAttribute('href'), '#/crm/configuracoes');
    assert.equal(t.browser.find(caminho, (el) => el.getAttribute('aria-current') === 'page').textContent, h2);
    await clicar(t, t.browser.by.tag(caminho, 'a')[0]);
    assert.equal(t.win.location.hash, '#/crm/configuracoes');
    assert.match(principal(t).textContent, /Os cadastros que organizam o CRM/);
  }
  t.win.history.back();
  await t.browser.flush(10);
  assert.equal(t.win.location.hash, '#/crm/configuracoes/origens', 'Voltar do navegador leva à tela anterior');
  assert.equal(t.browser.by.tag(principal(t), 'h2')[0].textContent, 'Origens dos Leads');
});

test('[CRMSET-5] O VENDEDOR não vê o item no menu e, por link direto, recebe "sem acesso" — sem nenhum link administrativo; quem só administra cadastros (ou só funis) vê só os seus cartões', async () => {
  const vendedor = await iniciar({ perfil: ME_CLOSER });
  assert.ok(!links(vendedor).map((a) => a.textContent).includes('Configurações do CRM'));
  await ir(vendedor, '#/crm/configuracoes');
  assert.match(principal(vendedor).textContent, NO_ACCESS);
  assert.equal(vendedor.browser.by.tag(principal(vendedor), 'a').length, 0);
  assert.equal(cartaoDe(vendedor, 'servicos'), null);
  assert.deepEqual(apiDeCatalogo(vendedor), []);

  const semFunis = await iniciar({ perfil: SEM_FUNIS, hash: '#/crm/configuracoes' });
  assert.deepEqual(semFunis.browser.by.cls(principal(semFunis), 'settings-card').map((c) => c.getAttribute('data-entry')), ['servicos', 'nichos', 'origens']);
  assert.ok(!links(semFunis).map((a) => a.textContent).includes('Gestão de Funis e Etapas'));

  const soFunis = await iniciar({ perfil: SO_FUNIS, hash: '#/crm/configuracoes' });
  assert.deepEqual(soFunis.browser.by.cls(principal(soFunis), 'settings-card').map((c) => c.getAttribute('data-entry')), ['funis']);
  assert.equal(soFunis.browser.by.tag(principal(soFunis), 'a').length, 0, 'sem MANAGE:CRM_CATALOGS nenhum link de cadastro');
  assert.ok(!links(soFunis).map((a) => a.textContent).some((r) => ['Serviços', 'Nichos e Cores', 'Origens dos Leads'].includes(r)));
  assert.ok(links(soFunis).map((a) => a.textContent).includes('Gestão de Funis e Etapas'), 'o item de menu da gestão de funis aparece para quem tem MANAGE:FUNNELS');
  assert.deepEqual(apiDeCatalogo(soFunis), []);
});

test('[CRMSET-6] COMPATIBILIDADE: a Gestão de Funis e Etapas continua uma página EM DESENVOLVIMENTO por link; os links antigos e o endereço da página com barra no fim funcionam', async () => {
  const t = await iniciar();
  await ir(t, '#/crm/configuracoes/funis');
  assert.match(principal(t).textContent, /EM DESENVOLVIMENTO/);
  assert.equal(t.browser.by.tag(principal(t), 'h2')[0].textContent, 'Gestão de Funis e Etapas');
  await ir(t, '#/crm/configuracoes/');
  assert.equal(t.browser.by.tag(principal(t), 'h2')[0].textContent, 'Configurações do CRM');
  for (const [hash, texto] of [['#/crm/clientes', /Clínica Alfa/], ['#/crm', /Clínica Alfa/], ['#/crm/dashboard', /EM DESENVOLVIMENTO/], ['#/crm/metas', /EM DESENVOLVIMENTO/], ['#/aprovacoes', /Revise cada lead/]]) {
    await ir(t, hash);
    assert.match(principal(t).textContent, texto, hash);
  }
  assert.equal(apiDeCatalogo(t).length, 0);
});
