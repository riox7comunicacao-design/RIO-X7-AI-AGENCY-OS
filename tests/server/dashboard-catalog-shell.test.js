// As telas dos catálogos DENTRO do painel inteiro (CRM 5.0, Fase 2B-2): menu lateral por permissão, rotas diretas, título da aba, proteção de rascunho ao trocar de módulo pelo menu, tela
// guardada ao voltar, logout sem sobras e compatibilidade com o CRM e a Prospecção. Painel real (dashboard/main.mjs) sobre o DOM de teste, SDK falso e fetch roteado — nenhuma credencial
// real, nenhuma rede, nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');

const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');
const H = require('../helpers/catalogHarness');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const me = (role, name) => ({ userId: `user-${name.toLowerCase()}`, name, role, permissions: [...authConstants.getRolePermissions(role)], status: 'ACTIVE' });
const ME_ADMIN = me('ADMIN', 'Breno');
const ME_CLOSER = me('COMMERCIAL_CLOSER', 'Rafael');

// O servidor "de mentira" dos catálogos, com estado: as chamadas de leitura devolvem a lista atual.
function catalogosFalsos() {
  const mem = { servicos: [H.servico(1, { nome: 'Gestão de redes' }), H.servico(2, { nome: 'Criação de site' })], nichos: [H.nicho(1, { nome: 'Estética', cor: 'rosa' })], origens: [H.origem(1, { nome: 'Indicação' })] };
  const lista = (c) => () => ({ items: JSON.parse(JSON.stringify(mem[c])) });
  return {
    mem,
    rotas: {
      'GET /api/crm-catalogs/servicos': lista('servicos'),
      'GET /api/crm-catalogs/nichos': lista('nichos'),
      'GET /api/crm-catalogs/origens': lista('origens'),
      'POST /api/crm-catalogs/servicos': (call) => {
        const item = { ...H.servico(mem.servicos.length + 1, { nome: call.body.nome, ordem: mem.servicos.length }), ...call.body };
        mem.servicos.push(item);
        return { status: 201, body: { item } };
      },
    },
  };
}

async function iniciar({ perfil = ME_ADMIN, hash = '', extras = {}, viewport } = {}) {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, scriptedFetch, FAKE_SESSION, crmRecord } = await loadFixtures();
  const catalogos = catalogosFalsos();
  const itens = [crmRecord({ id: 'crm:a', empresa: 'Clínica Alfa', status: 'CONTACTED', nicho: 'Psicologia', dataDeEntrada: '2026-09-12T10:00:00.000Z' })];
  const routes = {
    'GET /api/me': perfil,
    'GET /api/crm': { items: itens },
    'GET /api/approvals': { estado: 'AGUARDANDO_REVISAO', items: [] },
    ...catalogos.rotas,
    ...extras,
  };
  const browser = createBrowser({ hash });
  const sdk = createFakeSdk({ session: FAKE_SESSION });
  const fetchImpl = scriptedFetch({ 'GET /config.json': CONFIG, ...routes });
  const navigation = browserNavigation(browser.window);
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk, navigation, ...(viewport ? { viewport } : {}) });
  await browser.flush(10);
  return { browser, fetchImpl, navigation, win: browser.window, catalogos, sdk };
}

const texto = (t) => t.browser.root.textContent.replace(/\s+/g, ' ');
const nav = (t) => t.browser.by.tag(t.browser.root, 'nav')[0];
const links = (t) => t.browser.by.tag(nav(t), 'a');
const rotulosDoMenu = (t) => links(t).map((a) => a.textContent);
const marcados = (t) => links(t).filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent);
const apiDeCatalogo = (t) => t.fetchImpl.calls.filter((c) => c.path.startsWith('/api/crm-catalogs')).map((c) => `${c.method} ${c.path}`);
const ir = async (t, hash) => {
  t.win.location.hash = hash;
  await t.browser.flush(10);
};
const clicar = async (t, el) => {
  t.browser.click(el);
  await t.browser.flush(10);
};
const gaveta = (t) => t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const pergunta = (t) => t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'alertdialog');
const botao = (t, rotulo, escopo) => t.browser.by.button(escopo || t.browser.root, rotulo);
const porRotulo = (t, rotulo) => t.browser.find(t.browser.root, (el) => el.localName === 'button' && el.getAttribute('aria-label') === rotulo);
// o submenu recolhido esconde os links (e um clique num link escondido não faz nada): abre CRM e Configurações do CRM
const expandirConfiguracoes = async (t) => {
  for (const rotulo of ['Expandir CRM', 'Expandir Configurações do CRM']) {
    const seta = porRotulo(t, rotulo);
    if (seta) await clicar(t, seta);
  }
};
const titulo = (t) => t.browser.document.title;
const principal = (t) => t.browser.by.id(t.browser.root, 'main');
const NO_ACCESS = /Esta conta não possui acesso a esta área\./;

test('[CATSHELL-1] O ADMINISTRADOR vê "Configurações do CRM" com Serviços, Nichos e Cores, Origens dos Leads e Gestão de Funis e Etapas; cada item abre a sua tela REAL, acende só a sua entrada e põe o título na aba', async () => {
  const t = await iniciar();
  for (const rotulo of ['Configurações do CRM', 'Serviços', 'Nichos e Cores', 'Origens dos Leads', 'Gestão de Funis e Etapas']) assert.ok(rotulosDoMenu(t).includes(rotulo), rotulo);
  assert.equal(t.browser.by.link(nav(t), 'Serviços').getAttribute('data-soon'), null, 'Serviços não é mais "em desenvolvimento"');
  assert.equal(t.browser.by.link(nav(t), 'Gestão de Funis e Etapas').getAttribute('data-soon'), null, 'a Gestão de Funis e Etapas (Fase D1) é uma tela real');

  await expandirConfiguracoes(t);
  const casos = [
    ['Serviços', '#/crm/configuracoes/servicos', 'Serviços', 'Serviços · Configurações do CRM', /Gestão de redes/],
    ['Nichos e Cores', '#/crm/configuracoes/nichos', 'Nichos e Cores', 'Nichos e Cores · Configurações do CRM', /Estética/],
    ['Origens dos Leads', '#/crm/configuracoes/origens', 'Origens dos Leads', 'Origens dos Leads · Configurações do CRM', /Indicação/],
  ];
  for (const [rotulo, rota, h2, aba, conteudo] of casos) {
    await clicar(t, t.browser.by.link(nav(t), rotulo));
    assert.equal(t.win.location.hash, rota);
    assert.equal(t.browser.by.tag(principal(t), 'h2')[0].textContent, h2);
    assert.match(principal(t).textContent, conteudo);
    assert.doesNotMatch(principal(t).textContent, /EM DESENVOLVIMENTO/);
    assert.deepEqual(marcados(t), [rotulo], 'acende só a sua entrada');
    assert.equal(titulo(t), `${aba} — Rio X7 AI Agency OS`);
  }
  // o painel de novo item: mesmo menu aceso, título da aba da lista
  await ir(t, '#/crm/configuracoes/servicos/novo');
  assert.ok(gaveta(t));
  assert.deepEqual(marcados(t), ['Serviços']);
  assert.equal(titulo(t), 'Serviços · Configurações do CRM — Rio X7 AI Agency OS');
  // as leituras são só de catálogo e só com `todos=1`
  assert.ok(apiDeCatalogo(t).every((c) => c.startsWith('GET /api/crm-catalogs/') && c.endsWith('?todos=1')), apiDeCatalogo(t).join(' | '));
});

test('[CATSHELL-2] O VENDEDOR (COMMERCIAL_CLOSER) não vê NENHUM item administrativo; links diretos, inclusive os de painel, mostram "sem acesso" e NENHUMA chamada de catálogo é feita', async () => {
  const t = await iniciar({ perfil: ME_CLOSER });
  for (const rotulo of ['Configurações do CRM', 'Serviços', 'Nichos e Cores', 'Origens dos Leads', 'Gestão de Funis e Etapas']) assert.ok(!rotulosDoMenu(t).includes(rotulo), `${rotulo} não aparece`);
  assert.ok(rotulosDoMenu(t).includes('Clientes') && rotulosDoMenu(t).includes('Funis de Vendas'), 'o resto do CRM continua à vista');
  for (const hash of ['#/crm/configuracoes/servicos', '#/crm/configuracoes/nichos', '#/crm/configuracoes/origens', '#/crm/configuracoes/servicos/novo', '#/crm/configuracoes/nichos/niche%3A1', '#/crm/configuracoes/origens/novo']) {
    await ir(t, hash);
    assert.match(principal(t).textContent, NO_ACCESS, hash);
    assert.equal(gaveta(t), null, hash);
    assert.equal(botao(t, 'Novo Serviço'), null, hash);
    assert.equal(botao(t, 'Novo Nicho'), null, hash);
  }
  assert.deepEqual(apiDeCatalogo(t), [], 'nem uma chamada à API dos catálogos');
  // a página "Configurações do CRM" só existe para quem administra alguma configuração: o vendedor também recebe "sem acesso", sem nenhum link de cadastro
  await ir(t, '#/crm/configuracoes');
  assert.match(principal(t).textContent, NO_ACCESS);
  assert.equal(t.browser.by.tag(principal(t), 'a').length, 0);
  // a Gestão de Funis e Etapas (Fase D1) exige MANAGE:FUNNELS: o vendedor, por link direto, recebe "sem acesso" e nada é chamado
  await ir(t, '#/crm/configuracoes/funis');
  assert.match(principal(t).textContent, NO_ACCESS);
  assert.deepEqual(apiDeCatalogo(t), []);
});

test('[CATSHELL-3] TROCAR DE MÓDULO com alteração não salva: o menu fica inerte com o painel aberto, então a saída é pelo endereço (Voltar, Avançar, digitar): pergunta; "Continuar editando" devolve o endereço e o rascunho; "Descartar" segue; sem alteração, navega livre', async () => {
  const t = await iniciar({ hash: '#/crm/configuracoes/servicos/novo' });
  assert.ok(gaveta(t));
  const clientes = t.browser.by.link(nav(t), 'Clientes');
  await clicar(t, clientes);
  assert.equal(t.win.location.hash, '#/crm/configuracoes/servicos/novo', 'com o painel aberto o menu está inerte (nem foco, nem clique)');
  // sem alteração: o endereço navega direto
  await ir(t, '#/crm/clientes');
  assert.equal(t.win.location.hash, '#/crm/clientes');
  assert.equal(pergunta(t), null, 'painel limpo: sem pergunta');
  assert.equal(gaveta(t), null, 'e o painel foi fechado ao sair');
  assert.equal(titulo(t), 'Clientes · CRM — Rio X7 AI Agency OS');

  // com alteração
  await ir(t, '#/crm/configuracoes/servicos/novo');
  t.browser.type(t.browser.by.id(t.browser.root, 'catalog-field-nome'), 'Rascunho do menu');
  await t.browser.flush(2);
  await ir(t, '#/funis');
  assert.ok(pergunta(t), 'pergunta antes de sair');
  assert.equal(t.browser.by.tag(principal(t), 'h2')[0].textContent, 'Serviços', 'a tela de Serviços continua à vista');
  await clicar(t, botao(t, 'Continuar editando', pergunta(t)));
  assert.equal(t.win.location.hash, '#/crm/configuracoes/servicos/novo', 'o endereço voltou');
  assert.equal(t.browser.by.id(t.browser.root, 'catalog-field-nome').value, 'Rascunho do menu');
  assert.equal(pergunta(t), null);

  await ir(t, '#/funis');
  await clicar(t, botao(t, 'Descartar alterações', pergunta(t)));
  assert.equal(t.win.location.hash, '#/funis');
  assert.equal(gaveta(t), null);
  assert.equal(pergunta(t), null);
  assert.equal(t.catalogos.mem.servicos.length, 2, 'nada foi criado');
  assert.equal(t.fetchImpl.calls.filter((c) => c.method === 'POST').length, 0, 'nenhuma escrita');
});

test('[CATSHELL-4] A TELA É GUARDADA: busca e catálogo sobrevivem a trocar de módulo; ao voltar a lista é atualizada em silêncio; criar um item mostra-o sem F5', async () => {
  const t = await iniciar({ hash: '#/crm/configuracoes/servicos' });
  const busca = t.browser.by.id(t.browser.root, 'catalog-search-servicos');
  t.browser.type(busca, 'site');
  await t.browser.flush(2);
  assert.match(principal(t).textContent, /1 no filtro/);
  await clicar(t, t.browser.by.link(nav(t), 'Clientes'));
  assert.doesNotMatch(principal(t).textContent, /Gestão de redes|Criação de site/, 'a lista de catálogo não aparece no CRM');
  const antes = apiDeCatalogo(t).length;
  await clicar(t, t.browser.by.link(nav(t), 'Serviços'));
  assert.equal(t.browser.by.id(t.browser.root, 'catalog-search-servicos').value, 'site', 'a busca está lá');
  assert.match(principal(t).textContent, /Criação de site/);
  assert.doesNotMatch(principal(t).textContent, /Gestão de redes/);
  assert.equal(apiDeCatalogo(t).length, antes + 1, 'uma leitura em silêncio ao voltar');

  // criar pelo painel (o servidor falso confirma) e ver o item na hora
  t.browser.type(t.browser.by.id(t.browser.root, 'catalog-search-servicos'), '');
  await clicar(t, botao(t, 'Novo Serviço'));
  t.browser.type(t.browser.by.id(t.browser.root, 'catalog-field-nome'), 'Tráfego pago');
  t.browser.check(t.browser.by.id(t.browser.root, 'catalog-field-permitePagamentoUnico'));
  await clicar(t, botao(t, 'Salvar', gaveta(t)));
  assert.match(principal(t).textContent, /Tráfego pago/);
  assert.match(principal(t).textContent, /Serviço criado\./);
  assert.equal(t.win.location.hash, '#/crm/configuracoes/servicos');
  assert.equal(t.fetchImpl.calls.filter((c) => c.method === 'POST').length, 1);
});

test('[CATSHELL-5] SAIR da conta: as telas dos catálogos são destruídas e nada delas sobra na página de login', async () => {
  const t = await iniciar({ hash: '#/crm/configuracoes/servicos' });
  assert.match(texto(t), /Gestão de redes/);
  await clicar(t, botao(t, 'Sair'));
  assert.match(texto(t), /Entrar/);
  assert.doesNotMatch(texto(t), /Gestão de redes|Criação de site|Serviços|Nichos|Origens dos Leads/, 'nenhum dado de catálogo na página de login');
  assert.equal(t.win.listenerCount('beforeunload'), 0, 'nenhum guarda de saída fica para trás');
});

test('[CATSHELL-6] COMPATIBILIDADE: as rotas antigas e as páginas EM DESENVOLVIMENTO (Metas) continuam como eram (CRM, Prospecção, Funis); os 3 catálogos, o Dashboard Comercial e a Gestão de Funis e Etapas são telas reais', async () => {
  const t = await iniciar();
  const esperado = {
    '#/crm': /Clínica Alfa/,
    '#/crm/clientes': /Clínica Alfa/,
    '#/crm/dashboard': /Dashboard Comercial/,
    '#/crm/metas': /EM DESENVOLVIMENTO/,
    '#/crm/configuracoes': /Os cadastros que organizam o CRM/,
    '#/crm/configuracoes/funis': /Gestão de Funis e Etapas/,
    '#/prospeccao': /Nova Prospecção/,
    '#/aprovacoes': /Revise cada lead/,
    '#/crm/configuracoes/clientes': /Página não encontrada/,
    '#/crm/configuracoes/funis/novo': /Página não encontrada/,
    '#/crm/configuracoes/servicos/%E0%A4%A': /Página não encontrada/,
  };
  for (const [hash, esperadoTexto] of Object.entries(esperado)) {
    await ir(t, hash);
    assert.match(principal(t).textContent, esperadoTexto, hash);
  }
  // os catálogos só foram consultados quando uma tela de catálogo foi aberta
  assert.deepEqual(apiDeCatalogo(t), []);
});
