// O painel inteiro (dashboard/main.mjs): login, sessão, logout, proteção das rotas, navegação (Visão Geral, CRM, Aprovações,
// Sair) e a coexistência do CRM com a fila de aprovação — rodando sobre o DOM de teste, um SDK do Supabase falso e um
// `fetch` roteado. O que muda do navegador de verdade para cá é só o que vem de fora: o SDK, o fetch e o window.
//
// Nenhuma credencial real: o e-mail, a senha e o token abaixo são placeholders óbvios que só existem no SDK falso.

const test = require('node:test');
const assert = require('node:assert/strict');

const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');

const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const me = (role, name) => ({ userId: `user-${name.toLowerCase()}`, name, role, permissions: [...authConstants.getRolePermissions(role)], status: 'ACTIVE' });
const ME_ADMIN = me('ADMIN', 'Breno');
const ME_CLOSER = me('COMMERCIAL_CLOSER', 'Rafael');
const NEGADO = { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Esta conta não possui acesso a esta área.' } } };
const NAO_AUTENTICADO = { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Sessão ausente, inválida ou expirada. Entre novamente.' } } };

async function iniciar({ session = null, routes = {}, hash = '', sdkOptions = {}, semSdk = false } = {}) {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, scriptedFetch, FAKE_SESSION } = await loadFixtures();
  const browser = createBrowser({ hash });
  const sdk = createFakeSdk({ session: session === true ? FAKE_SESSION : session, ...sdkOptions });
  const fetchImpl = scriptedFetch({ 'GET /config.json': CONFIG, ...routes });
  const navigation = browserNavigation(browser.window);
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk: semSdk ? undefined : sdk, navigation });
  await browser.flush();
  return { browser, sdk, fetchImpl, navigation, FAKE_SESSION };
}

const textoDaTela = (browser) => {
  const texto = browser.root.textContent.replace(/\s+/g, ' ');
  assert.doesNotMatch(texto, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');
  return texto;
};
const chamadasDeApi = (fetchImpl) => fetchImpl.calls.filter((chamada) => chamada.path.startsWith('/api/'));
const linksDoMenu = (browser) => browser.by.tag(browser.by.tag(browser.root, 'nav')[0], 'a');
const ativo = (browser) => linksDoMenu(browser).filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.textContent);

async function entrarPeloFormulario(t, email = 'usuario-teste@example.test', senha = 'senha-de-teste-nao-real') {
  t.browser.type(t.browser.by.label(t.browser.root, 'E-mail'), email);
  t.browser.type(t.browser.by.label(t.browser.root, 'Senha'), senha);
  t.browser.click(t.browser.by.button(t.browser.root, 'Entrar'));
  await t.browser.flush();
}

// As rotas de um painel logado como `perfil`, com o CRM e a fila de aprovação de exemplo.
async function rotasLogado(perfil = ME_ADMIN, extras = {}) {
  const { crmRecord } = await loadFixtures();
  const itens = [
    crmRecord({ id: 'crm:a', empresa: 'Clínica Alfa', status: 'CONTACTED', nicho: 'Psicologia', dataDeEntrada: '2026-09-12T10:00:00.000Z' }),
    crmRecord({ id: 'crm:b', empresa: 'Odonto Beta', status: 'WON', nicho: 'Odontologia', dataDeEntrada: '2026-09-14T10:00:00.000Z' }),
  ];
  return {
    'GET /api/me': perfil,
    'GET /api/crm': { items: itens },
    'GET /api/crm/crm%3Aa': { item: itens[0] },
    'GET /api/crm/crm%3Aa/history': { historico: itens[0].historico },
    'GET /api/approvals': { estado: 'AGUARDANDO_REVISAO', items: [{ prospectId: 'id:x', empresa: 'Prospect X', estado: 'AGUARDANDO_REVISAO', discoverySnapshot: { cidade: 'Petrópolis', estadoUf: 'RJ' }, historico: [] }] },
    ...extras,
  };
}

// ===========================================================================
// LOGIN e PROTEÇÃO
// ===========================================================================
test('[DASH-SHELL-1] sem sessão só existe a tela de login — qualquer # (mesmo #/crm) leva a ela, e nenhuma chamada de API é feita', async () => {
  const t = await iniciar({ session: null, hash: '#/crm', routes: await rotasLogado() });
  assert.ok(t.browser.by.label(t.browser.root, 'E-mail'), 'o formulário de login está na tela');
  assert.ok(t.browser.by.label(t.browser.root, 'Senha'));
  assert.equal(t.browser.by.tag(t.browser.root, 'nav').length, 0, 'sem menu');
  assert.doesNotMatch(textoDaTela(t.browser), /CRM|Clínica|Aprovações/);
  assert.deepEqual(chamadasDeApi(t.fetchImpl), [], 'nenhuma chamada de API sem sessão');
  assert.equal(t.browser.document.title, 'Rio X7 AI Agency OS');

  t.browser.window.location.hash = '#/crm/registro/crm%3Aa';
  await t.browser.flush();
  assert.ok(t.browser.by.label(t.browser.root, 'E-mail'), 'mudar o # não abre nada sem sessão');
  assert.deepEqual(chamadasDeApi(t.fetchImpl), []);
});

test('[DASH-SHELL-2] o SDK é criado com a URL e a chave PÚBLICA de /config.json e a sessão persistente de sempre (o comportamento do login não mudou)', async () => {
  const t = await iniciar({ session: null });
  assert.deepEqual(t.sdk.calls.createClient, { url: CONFIG.supabaseUrl, key: CONFIG.supabaseAnonKey, options: { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } } });
  assert.deepEqual(t.fetchImpl.calls.map((chamada) => chamada.path), ['/config.json']);
  assert.equal(t.fetchImpl.calls[0].headers['cache-control'], undefined);
});

test('[DASH-SHELL-3] login: o e-mail e a senha digitados vão SÓ para o SDK; depois o painel abre com o menu (Visão Geral, CRM, Nova Prospecção, Histórico, Fila de Aprovação, Leads Reprovados), o nome, a role em português e o botão Sair — e /api/me leva o token da sessão', async () => {
  const t = await iniciar({ session: null, routes: await rotasLogado() });
  await entrarPeloFormulario(t);
  assert.deepEqual(t.sdk.calls.signIn, [{ email: 'usuario-teste@example.test', password: 'senha-de-teste-nao-real' }]);

  assert.deepEqual(linksDoMenu(t.browser).map((link) => link.textContent), ['Visão Geral', 'CRM', 'Dashboard Comercial', 'Clientes', 'Funis de Vendas', 'Metas e Indicadores', 'Configurações do CRM', 'Serviços', 'Nichos e Cores', 'Gestão de Funis e Etapas', 'Origens dos Leads', 'Nova Prospecção', 'Histórico', 'Fila de Aprovação', 'Leads Reprovados', 'Central de Agentes', 'Exclusões Permanentes']);
  assert.deepEqual(linksDoMenu(t.browser).map((link) => link.href), ['#/', '#/crm/dashboard', '#/crm/dashboard', '#/crm/clientes', '#/funis', '#/crm/metas', '#/crm/configuracoes', '#/crm/configuracoes/servicos', '#/crm/configuracoes/nichos', '#/crm/configuracoes/funis', '#/crm/configuracoes/origens', '#/prospeccao', '#/prospeccao/historico', '#/aprovacoes', '#/prospeccao/leads-reprovados', '#/agentes', '#/exclusoes-permanentes']);
  assert.ok(t.browser.by.button(t.browser.root, 'Sair'));
  const texto = textoDaTela(t.browser);
  assert.match(texto, /Breno/);
  assert.match(texto, /Administrador/);
  assert.deepEqual(ativo(t.browser), ['Visão Geral'], 'entra na Visão Geral');
  assert.equal(t.browser.document.title, 'Visão Geral — Rio X7 AI Agency OS');

  const chamadaMe = chamadasDeApi(t.fetchImpl).find((chamada) => chamada.path === '/api/me');
  assert.equal(chamadaMe.headers.authorization, `Bearer ${t.FAKE_SESSION.access_token}`);
  const somenteApi = chamadasDeApi(t.fetchImpl);
  for (const chamada of somenteApi) assert.deepEqual(Object.keys(chamada.headers).sort().filter((nome) => nome !== 'content-type'), ['accept', 'authorization'], 'a identidade é só o token');
  assert.ok(!texto.includes('senha-de-teste'), 'a senha nunca aparece na tela');
});

test('[DASH-SHELL-4] login recusado: a tela mostra a frase de sempre (sem repetir o erro do SDK), continua no login, libera o botão e não chama a API', async () => {
  const t = await iniciar({ session: null, routes: await rotasLogado(), sdkOptions: { loginError: new Error('Invalid login credentials — detalhe do provedor') } });
  await entrarPeloFormulario(t);
  const texto = textoDaTela(t.browser);
  assert.match(texto, /Não foi possível entrar\. Confira o e-mail e a senha e tente novamente\./);
  assert.doesNotMatch(texto, /Invalid login|provedor|senha-de-teste/);
  assert.equal(t.browser.by.button(t.browser.root, 'Entrar').disabled, false);
  assert.deepEqual(chamadasDeApi(t.fetchImpl), []);
  assert.equal(t.browser.by.tag(t.browser.root, 'nav').length, 0);
});

test('[DASH-SHELL-5] e-mail ou senha vazios: pede os dois e nem chama o SDK', async () => {
  const t = await iniciar({ session: null });
  t.browser.click(t.browser.by.button(t.browser.root, 'Entrar'));
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Informe e-mail e senha\./);
  t.browser.type(t.browser.by.label(t.browser.root, 'E-mail'), 'usuario-teste@example.test');
  t.browser.click(t.browser.by.button(t.browser.root, 'Entrar'));
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Informe e-mail e senha\./);
  assert.deepEqual(t.sdk.calls.signIn, []);
});

test('[DASH-SHELL-6] com sessão já existente o painel abre direto, sem passar pelo login', async () => {
  const t = await iniciar({ session: true, routes: await rotasLogado() });
  assert.equal(t.browser.by.tag(t.browser.root, 'form').length, 0);
  assert.deepEqual(linksDoMenu(t.browser).map((link) => link.textContent), ['Visão Geral', 'CRM', 'Dashboard Comercial', 'Clientes', 'Funis de Vendas', 'Metas e Indicadores', 'Configurações do CRM', 'Serviços', 'Nichos e Cores', 'Gestão de Funis e Etapas', 'Origens dos Leads', 'Nova Prospecção', 'Histórico', 'Fila de Aprovação', 'Leads Reprovados', 'Central de Agentes', 'Exclusões Permanentes']);
  assert.deepEqual(t.sdk.calls.signIn, []);
});

// ===========================================================================
// LOGOUT e SESSÃO EXPIRADA
// ===========================================================================
test('[DASH-SHELL-7] logout: "Sair" encerra a sessão no SDK, volta ao login, não deixa NENHUM dado do CRM na página, para o roteamento e restaura o título — e um novo login abre um painel limpo', async () => {
  const t = await iniciar({ session: true, routes: await rotasLogado(), hash: '#/crm' });
  assert.match(textoDaTela(t.browser), /Clínica Alfa/);
  assert.equal(t.browser.window._listeners.size, 1, 'um ouvinte de rotas enquanto o painel está aberto');

  t.browser.click(t.browser.by.button(t.browser.root, 'Sair'));
  await t.browser.flush();
  assert.equal(t.sdk.calls.signOut.length >= 1, true, 'o SDK foi avisado');
  assert.ok(t.browser.by.label(t.browser.root, 'E-mail'), 'voltou ao login');
  const texto = textoDaTela(t.browser);
  for (const sobra of ['Clínica Alfa', 'Odonto Beta', 'Breno', 'Administrador', 'Prospect X']) assert.ok(!texto.includes(sobra), `"${sobra}" não pode sobrar na tela depois do logout`);
  assert.equal(t.browser.window._listeners.size, 0, 'o roteamento parou');
  assert.equal(t.browser.document.title, 'Rio X7 AI Agency OS');

  const antes = chamadasDeApi(t.fetchImpl).length;
  t.browser.window.location.hash = '#/aprovacoes';
  await t.browser.flush();
  assert.ok(t.browser.by.label(t.browser.root, 'E-mail'), 'mudar o # depois de sair não abre nada');
  assert.equal(chamadasDeApi(t.fetchImpl).length, antes, 'nenhuma chamada nova de API');

  await entrarPeloFormulario(t);
  assert.deepEqual(linksDoMenu(t.browser).map((link) => link.textContent), ['Visão Geral', 'CRM', 'Dashboard Comercial', 'Clientes', 'Funis de Vendas', 'Metas e Indicadores', 'Configurações do CRM', 'Serviços', 'Nichos e Cores', 'Gestão de Funis e Etapas', 'Origens dos Leads', 'Nova Prospecção', 'Histórico', 'Fila de Aprovação', 'Leads Reprovados', 'Central de Agentes', 'Exclusões Permanentes']);
  assert.equal(t.browser.window._listeners.size, 1, 'um único ouvinte de rotas de novo (nada vazou)');
});

test('[DASH-SHELL-8] sessão expirada no meio do uso: o servidor devolve 401, a renovação falha, e o painel volta ao login com o aviso — limpando a sessão local e sem deixar dado na página', async () => {
  const t = await iniciar({
    session: true,
    routes: await rotasLogado(ME_ADMIN, { 'GET /api/crm': NAO_AUTENTICADO }),
    sdkOptions: { refreshSession: { data: { session: null }, error: new Error('refresh recusado') } },
  });
  t.browser.window.location.hash = '#/crm';
  await t.browser.flush();
  assert.ok(t.browser.by.label(t.browser.root, 'E-mail'), 'voltou ao login');
  assert.match(textoDaTela(t.browser), /Sua sessão expirou\. Entre novamente\./);
  assert.deepEqual(t.sdk.calls.signOut, [{ scope: 'local' }], 'só a sessão local foi limpa');
  assert.equal(t.sdk.calls.refresh, 1, 'a renovação foi tentada UMA vez');
  assert.doesNotMatch(textoDaTela(t.browser), /Clínica|Breno/);
  assert.equal(t.browser.window._listeners.size, 0);
});

test('[DASH-SHELL-9] se o token renovado funciona, o painel continua sem pedir login (401 -> renova uma vez -> repete)', async () => {
  let tentativas = 0;
  const routes = await rotasLogado(ME_ADMIN, {
    'GET /api/crm': (chamada) => {
      tentativas += 1;
      return chamada.headers.authorization === 'Bearer token-renovado-de-teste' ? { items: [] } : NAO_AUTENTICADO;
    },
  });
  const t = await iniciar({ session: true, routes, hash: '#/crm', sdkOptions: { refreshSession: { data: { session: { access_token: 'token-renovado-de-teste' } }, error: null } } });
  assert.equal(tentativas, 2, 'uma chamada com o token velho e uma com o renovado');
  assert.equal(t.sdk.calls.refresh, 1);
  assert.ok(!t.browser.by.label(t.browser.root, 'E-mail'), 'continua no painel');
  assert.match(textoDaTela(t.browser), /Nenhum registro no CRM ainda\./);
});

test('[DASH-SHELL-10] o SDK avisar SIGNED_OUT (sessão encerrada em outra aba) leva ao login', async () => {
  const t = await iniciar({ session: true, routes: await rotasLogado() });
  t.sdk.setSession(null);
  t.sdk.emit('SIGNED_OUT');
  await t.browser.flush();
  assert.ok(t.browser.by.label(t.browser.root, 'E-mail'));
  assert.equal(t.browser.by.tag(t.browser.root, 'nav').length, 0);
});

test('[DASH-SHELL-10b] um SIGNED_OUT que chega com o login JÁ visível (a sessão acabou aqui, ou saiu-se em outra aba) não reconstrói a tela: o aviso "Sua sessão expirou" e o e-mail digitado continuam lá', async () => {
  const t = await iniciar({
    session: true,
    routes: await rotasLogado(ME_ADMIN, { 'GET /api/crm': NAO_AUTENTICADO }),
    sdkOptions: { refreshSession: { data: { session: null }, error: new Error('refresh recusado') } },
  });
  t.browser.window.location.hash = '#/crm';
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Sua sessão expirou\. Entre novamente\./);
  const email = t.browser.by.label(t.browser.root, 'E-mail');
  t.browser.type(email, 'digitado-antes@example.test');

  t.sdk.emit('SIGNED_OUT');
  t.sdk.emit('SIGNED_OUT');
  await t.browser.flush();
  assert.equal(t.browser.by.label(t.browser.root, 'E-mail'), email, 'o formulário não foi refeito');
  assert.equal(email.value, 'digitado-antes@example.test', 'o que foi digitado continua');
  assert.match(textoDaTela(t.browser), /Sua sessão expirou\. Entre novamente\./, 'o aviso continua');
});

test('[DASH-SHELL-11] falhas ao abrir o painel: /api/me 401 volta ao login; 403 mostra "sem acesso" e nenhum menu; 500 e rede fora mostram uma frase genérica', async () => {
  const semAcesso = await iniciar({ session: true, routes: { 'GET /api/me': NEGADO } });
  assert.match(textoDaTela(semAcesso.browser), /Esta conta não possui acesso a esta área\./);
  assert.equal(semAcesso.browser.by.tag(semAcesso.browser.root, 'nav').length, 0, 'sem menu');
  assert.ok(semAcesso.browser.by.button(semAcesso.browser.root, 'Sair'), 'mas dá para sair');

  const erro = await iniciar({ session: true, routes: { 'GET /api/me': { status: 500, body: { error: { code: 'INTERNAL', message: 'detalhe interno C:\\segredo' } } } } });
  assert.match(textoDaTela(erro.browser), /Não foi possível carregar o painel agora/);
  assert.doesNotMatch(textoDaTela(erro.browser), /segredo|detalhe interno/);

  const expirou = await iniciar({ session: true, routes: { 'GET /api/me': NAO_AUTENTICADO }, sdkOptions: { refreshSession: { data: { session: null }, error: new Error('x') } } });
  assert.ok(expirou.browser.by.label(expirou.browser.root, 'E-mail'));
  assert.match(textoDaTela(expirou.browser), /Sua sessão expirou/);

  const semRede = await iniciar({ session: true, routes: { 'GET /api/me': () => { throw new TypeError('Failed to fetch'); } } });
  assert.match(textoDaTela(semRede.browser), /Não foi possível carregar o painel agora/);
});

test('[DASH-SHELL-12] sem /config.json (ou sem o SDK) o painel diz que não conseguiu carregar e não desenha mais nada', async () => {
  const semConfig = await iniciar({ session: null, routes: { 'GET /config.json': { status: 500, body: {} } } });
  assert.match(textoDaTela(semConfig.browser), /Não foi possível carregar o Dashboard\. Recarregue a página\./);
  assert.equal(semConfig.browser.by.tag(semConfig.browser.root, 'form').length, 0);

  const configRuim = await iniciar({ session: null, routes: { 'GET /config.json': { supabaseUrl: 42 } } });
  assert.match(textoDaTela(configRuim.browser), /Não foi possível carregar o Dashboard/);

  const semSdk = await iniciar({ session: null, semSdk: true });
  assert.match(textoDaTela(semSdk.browser), /Não foi possível carregar o Dashboard/);
});

// ===========================================================================
// NAVEGAÇÃO
// ===========================================================================
test('[DASH-SHELL-13] navegação: cada item do menu abre a sua tela e fica marcado como página atual; o título da aba acompanha; um endereço que não existe mostra uma página amigável', async () => {
  const t = await iniciar({ session: true, routes: await rotasLogado() });
  assert.deepEqual(ativo(t.browser), ['Visão Geral']);
  assert.match(textoDaTela(t.browser), /Visão Geral/);
  const indicadores = Object.fromEntries(t.browser.by.cls(t.browser.root, 'kpi').map((cartao) => [t.browser.by.tag(cartao, 'h3')[0].textContent, (t.browser.by.cls(cartao, 'stat')[0] || {}).textContent]));
  assert.deepEqual(indicadores, { 'Leads no CRM': '2', 'Leads em Prospecção': '0', 'Aprovações pendentes': '1', 'Reuniões': '0', 'Propostas': '0', 'Negociações': '0' }, 'a Visão Geral mostra o total do CRM (de GET /api/crm), a fila (de GET /api/approvals) e as etapas do CRM');
  assert.match(textoDaTela(t.browser), /registros no CRM/);
  assert.match(textoDaTela(t.browser), /lead aguardando revisão/);
  const pipeline = Object.fromEntries(t.browser.by.cls(t.browser.root, 'pipeline-row').map((linha) => [t.browser.by.cls(linha, 'badge')[0].textContent, t.browser.by.cls(linha, 'pipeline-count')[0].textContent]));
  assert.equal(pipeline.Contatado, '1');
  assert.equal(pipeline.Fechada, '1');

  t.browser.click(t.browser.by.link(t.browser.root, 'CRM'));
  await t.browser.flush();
  assert.deepEqual(ativo(t.browser), ['Dashboard Comercial'], 'o texto "CRM" abre o Dashboard Comercial');
  assert.equal(t.browser.document.title, 'Dashboard Comercial — Rio X7 AI Agency OS');
  assert.match(textoDaTela(t.browser), /EM DESENVOLVIMENTO/);
  assert.equal(t.browser.by.tag(t.browser.root, 'table').length, 0, 'nenhum dado simulado');
  t.browser.click(t.browser.by.link(t.browser.root, 'Clientes'));
  await t.browser.flush();
  assert.deepEqual(ativo(t.browser), ['Clientes']);
  assert.equal(t.browser.document.title, 'Clientes · CRM — Rio X7 AI Agency OS');
  assert.match(textoDaTela(t.browser), /Odonto Beta/);
  assert.equal(t.browser.by.tag(t.browser.root, 'table').length, 1);

  t.browser.click(t.browser.by.button(t.browser.root, 'Prospecção')); // o grupo está recolhido: a pessoa o abre pela seta/texto
  t.browser.click(t.browser.by.link(t.browser.root, 'Fila de Aprovação'));
  await t.browser.flush();
  assert.deepEqual(ativo(t.browser), ['Fila de Aprovação']);
  assert.equal(t.browser.document.title, 'Fila de Aprovação — Rio X7 AI Agency OS');
  assert.match(textoDaTela(t.browser), /Prospect X/);
  assert.equal(t.browser.by.tag(t.browser.root, 'table').length, 1);
  assert.doesNotMatch(textoDaTela(t.browser), /Odonto Beta/, 'a tela anterior saiu');

  t.browser.click(t.browser.by.button(t.browser.root, 'Agentes IA'));
  t.browser.click(t.browser.by.link(t.browser.root, 'Central de Agentes'));
  await t.browser.flush();
  assert.deepEqual(ativo(t.browser), ['Central de Agentes']);
  assert.equal(t.browser.document.title, 'Agentes IA — Rio X7 AI Agency OS');
  assert.match(textoDaTela(t.browser), /Especialistas digitais da operação Rio X7\./);

  t.browser.click(t.browser.by.link(t.browser.root, 'Visão Geral'));
  await t.browser.flush();
  assert.deepEqual(ativo(t.browser), ['Visão Geral']);

  t.browser.window.location.hash = '#/nao-existe';
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Página não encontrada/);
  assert.deepEqual(ativo(t.browser), []);
  t.browser.click(t.browser.by.link(t.browser.root, 'Ir para a Visão Geral'));
  await t.browser.flush();
  assert.deepEqual(ativo(t.browser), ['Visão Geral']);
});

test('[DASH-SHELL-14] link direto: abrir o painel já em #/crm/registro/<id> mostra a ficha numa gaveta por cima da lista; fechar leva à lista, que mantém a busca que a pessoa fez', async () => {
  const t = await iniciar({ session: true, routes: await rotasLogado(), hash: '#/crm/registro/crm%3Aa' });
  assert.deepEqual(ativo(t.browser), ['Clientes']);
  const gaveta = () => t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className));
  assert.equal(t.browser.by.cls(t.browser.root, 'overlay-title')[0].textContent, 'Clínica Alfa');
  assert.ok(t.browser.find(gaveta(), (el) => el.getAttribute('role') === 'tab' && el.textContent === 'Histórico'), 'a ficha tem a aba Histórico');
  assert.equal(t.browser.by.tag(t.browser.root, 'tbody')[0].children.length, 2, 'a lista foi carregada por baixo da ficha');

  t.browser.click(t.browser.find(gaveta(), (el) => el.getAttribute('data-action') === 'close'));
  await t.browser.flush();
  assert.equal(gaveta(), null);
  assert.equal(t.browser.window.location.hash, '#/crm', 'fechar leva à lista');
  const busca = t.browser.by.label(t.browser.root, 'Buscar');
  t.browser.type(busca, 'odonto');
  assert.equal(t.browser.by.tag(t.browser.root, 'tbody')[0].children.length, 1);
  t.browser.click(t.browser.by.button(t.browser.root, 'Odonto Beta'));
  await t.browser.flush();
  assert.ok(gaveta(), 'abrir um registro pela lista');
  t.browser.window.location.hash = '#/crm';
  await t.browser.flush();
  assert.equal(gaveta(), null, 'a rota da lista fecha a gaveta');
  assert.equal(t.browser.by.label(t.browser.root, 'Buscar').value, 'odonto', 'a busca foi mantida');
  assert.equal(t.browser.by.tag(t.browser.root, 'tbody')[0].children.length, 1);
});

test('[DASH-SHELL-14b] o CRM é PERSISTENTE no painel: com a ficha aberta, trocar de módulo fecha a gaveta; ao voltar ao CRM a busca e a lista continuam (já prontas, sem "carregando") e a lista se atualiza em silêncio uma vez', async () => {
  const t = await iniciar({ session: true, routes: await rotasLogado(), hash: '#/crm' });
  const gaveta = () => t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className));
  const cargasDoCrm = () => chamadasDeApi(t.fetchImpl).filter((chamada) => chamada.method === 'GET' && chamada.path === '/api/crm').length;
  t.browser.type(t.browser.by.label(t.browser.root, 'Buscar'), 'odonto');
  assert.equal(t.browser.by.tag(t.browser.root, 'tbody')[0].children.length, 1);
  t.browser.click(t.browser.by.button(t.browser.root, 'Odonto Beta'));
  await t.browser.flush();
  assert.ok(gaveta(), 'a ficha abriu por cima da lista');
  assert.equal(t.browser.window.location.hash, '#/crm/registro/crm%3Ab');

  t.browser.window.location.hash = '#/aprovacoes';
  await t.browser.flush();
  assert.equal(gaveta(), null, 'trocar de módulo fecha a gaveta');
  assert.deepEqual(ativo(t.browser), ['Fila de Aprovação']);
  assert.equal(t.browser.window.location.hash, '#/aprovacoes', 'e o endereço é o do módulo novo (nada foi desfeito)');
  const antes = cargasDoCrm();

  t.browser.window.location.hash = '#/crm';
  await t.browser.flush();
  assert.deepEqual(ativo(t.browser), ['Clientes']);
  assert.equal(t.browser.by.label(t.browser.root, 'Buscar').value, 'odonto', 'a busca ficou');
  assert.equal(t.browser.by.tag(t.browser.root, 'tbody')[0].children.length, 1);
  assert.equal(t.browser.by.cls(t.browser.root, 'skeleton').length, 0, 'já pronta, sem "carregando"');
  assert.equal(cargasDoCrm(), antes + 1, 'uma atualização silenciosa ao voltar');
  assert.equal(gaveta(), null);
});

test('[DASH-SHELL-14c] TROCA DE MÓDULO com edição não salva no CRM: nada muda até a pessoa decidir; "Continuar editando" devolve o endereço da ficha sem empilhar entradas; "Descartar alterações" segue para o módulo pedido; sem alteração a troca é livre', async () => {
  const { crmRecord } = await loadFixtures();
  const itens = [crmRecord({ id: 'crm:a', empresa: 'Clínica Alfa', status: 'CONTACTED', cidade: 'Petrópolis', dataDeEntrada: '2026-09-12T10:00:00.000Z' })];
  const t = await iniciar({ session: true, routes: await rotasLogado(ME_ADMIN, { 'GET /api/crm': { items: itens }, 'GET /api/crm/crm%3Aa': { item: itens[0] }, 'GET /api/crm/crm%3Aa/history': { historico: itens[0].historico } }), hash: '#/crm' });
  const win = t.browser.window;
  const gaveta = () => t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className));
  const pergunta = () => t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'alertdialog');
  const escritas = () => chamadasDeApi(t.fetchImpl).filter((chamada) => chamada.method !== 'GET');

  t.browser.click(t.browser.by.button(t.browser.root, 'Clínica Alfa'));
  await t.browser.flush(10);
  t.browser.click(t.browser.by.button(gaveta(), 'Editar'));
  await t.browser.flush(6);
  win.location.hash = '#/aprovacoes'; // sem digitar nada: a troca é livre (nem a edição aberta, sem alteração, pergunta)
  await t.browser.flush(10);
  assert.equal(pergunta(), null);
  assert.deepEqual(ativo(t.browser), ['Fila de Aprovação']);

  win.location.hash = '#/crm/registro/crm%3Aa';
  await t.browser.flush(10);
  t.browser.click(t.browser.by.button(gaveta(), 'Editar'));
  await t.browser.flush(6);
  t.browser.type(t.browser.by.label(gaveta(), 'Cidade'), 'Rascunho');
  const entradas = [...win._entries];

  win.location.hash = '#/aprovacoes';
  await t.browser.flush(10);
  assert.ok(pergunta(), 'perguntou');
  assert.deepEqual(ativo(t.browser), ['Clientes'], 'o menu e a tela continuam no CRM');
  assert.ok(gaveta(), 'a gaveta com a edição continua aberta');
  assert.equal(t.browser.document.title.startsWith('Registro'), true, 'o título da página também não mudou');

  t.browser.click(t.browser.by.button(pergunta(), 'Continuar editando'));
  await t.browser.flush(10);
  assert.equal(win.location.hash, '#/crm/registro/crm%3Aa', 'o endereço voltou à ficha');
  assert.equal(win.history.length, entradas.length + 1, 'só a entrada que a própria pessoa criou ao ir para as aprovações — nenhuma a mais');
  assert.equal(t.browser.by.label(gaveta(), 'Cidade').value, 'Rascunho', 'o rascunho continua');
  assert.deepEqual(ativo(t.browser), ['Clientes']);

  win.location.hash = '#/aprovacoes';
  await t.browser.flush(10);
  t.browser.click(t.browser.by.button(pergunta(), 'Descartar alterações'));
  await t.browser.flush(10);
  assert.deepEqual(ativo(t.browser), ['Fila de Aprovação'], 'descartou e foi para onde pediu');
  assert.equal(gaveta(), null);
  assert.equal(win.location.hash, '#/aprovacoes');
  assert.deepEqual(escritas(), [], 'nada foi gravado');

  win.location.hash = '#/crm';
  await t.browser.flush(10);
  assert.deepEqual(ativo(t.browser), ['Clientes']);
  assert.equal(win.fireBeforeUnload().prevented, false, 'sem rascunho, atualizar a página não pede nada');
});

test('[DASH-SHELL-14d] SALVANDO, sair do CRM é recusado (o endereço volta e a pessoa é avisada); terminado o salvamento a troca é livre', async () => {
  const { crmRecord } = await loadFixtures();
  const itens = [crmRecord({ id: 'crm:a', empresa: 'Clínica Alfa', status: 'CONTACTED', cidade: 'Petrópolis', dataDeEntrada: '2026-09-12T10:00:00.000Z' })];
  let liberar;
  const espera = new Promise((resolve) => { liberar = resolve; });
  const t = await iniciar({
    session: true,
    routes: await rotasLogado(ME_ADMIN, {
      'GET /api/crm': { items: itens },
      'GET /api/crm/crm%3Aa': { item: itens[0] },
      'GET /api/crm/crm%3Aa/history': { historico: itens[0].historico },
      'PATCH /api/crm/crm%3Aa': async () => { await espera; return { item: { ...itens[0], cidade: 'Teresópolis' } }; },
    }),
    hash: '#/crm/registro/crm%3Aa',
  });
  const win = t.browser.window;
  const gaveta = () => t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className));
  t.browser.click(t.browser.by.button(gaveta(), 'Editar'));
  await t.browser.flush(6);
  t.browser.type(t.browser.by.label(gaveta(), 'Cidade'), 'Teresópolis');
  t.browser.click(t.browser.by.button(gaveta(), 'Salvar alterações'));
  await t.browser.flush(6);
  assert.equal(win.fireBeforeUnload().prevented, true, 'fechar a aba durante o salvamento pede o aviso');

  win.location.hash = '#/aprovacoes';
  await t.browser.flush(10);
  assert.deepEqual(ativo(t.browser), ['Clientes'], 'não saiu');
  assert.equal(win.location.hash, '#/crm/registro/crm%3Aa', 'o endereço voltou');
  assert.match(textoDaTela(t.browser), /Aguarde o salvamento terminar antes de sair\./);

  liberar();
  await t.browser.flush(14);
  assert.match(textoDaTela(t.browser), /Alterações salvas\./);
  win.location.hash = '#/aprovacoes';
  await t.browser.flush(10);
  assert.deepEqual(ativo(t.browser), ['Fila de Aprovação'], 'depois de salvar a troca é livre');
});

// ===========================================================================
// PERMISSÕES na interface
// ===========================================================================
test('[DASH-SHELL-15] COMMERCIAL_CLOSER no painel: vê o menu, a lista e a ficha, mas não tem nenhum botão de escrita — e uma tentativa de criar por link direto mostra que a conta não pode', async () => {
  const t = await iniciar({ session: true, routes: await rotasLogado(ME_CLOSER) });
  assert.match(textoDaTela(t.browser), /Vendedor/);
  // COMMERCIAL_CLOSER não tem PROPOSE:LEAD_APPROVAL (mesma decisão já vigente do Prospecting Service): "Prospecção"
  // não aparece — diferente de "Funis" (READ:CRM, que o closer tem).
  assert.deepEqual(linksDoMenu(t.browser).map((link) => link.textContent), ['Visão Geral', 'CRM', 'Dashboard Comercial', 'Clientes', 'Funis de Vendas', 'Metas e Indicadores', 'Configurações do CRM', 'Serviços', 'Nichos e Cores', 'Gestão de Funis e Etapas', 'Origens dos Leads', 'Fila de Aprovação', 'Leads Reprovados', 'Central de Agentes']);
  t.browser.window.location.hash = '#/crm';
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Odonto Beta/);
  assert.equal(t.browser.by.link(t.browser.root, 'Novo registro'), null);
  t.browser.window.location.hash = '#/crm/registro/crm%3Aa';
  await t.browser.flush();
  for (const botao of ['Editar', 'Mudar status', 'Marcar como Não Contatar']) assert.equal(t.browser.by.button(t.browser.root, botao), null, botao);
  t.browser.window.location.hash = '#/crm/novo';
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Sua conta não pode criar registros no CRM\./);
  assert.equal(t.browser.by.tag(t.browser.root, 'form').length, 0);
  const escritas = chamadasDeApi(t.fetchImpl).filter((chamada) => chamada.method !== 'GET');
  assert.deepEqual(escritas, [], 'nenhuma escrita foi tentada');
});

test('[DASH-SHELL-16] uma conta sem READ:CRM não vê o item CRM no menu, e o link direto mostra "sem acesso" SEM chamar a API do CRM', async () => {
  const semCrm = { ...ME_ADMIN, permissions: ['APPROVE:LEAD_APPROVAL'] };
  const t = await iniciar({ session: true, routes: await rotasLogado(semCrm), hash: '#/crm' });
  assert.deepEqual(linksDoMenu(t.browser).map((link) => link.textContent), ['Visão Geral', 'Fila de Aprovação', 'Leads Reprovados', 'Central de Agentes']);
  assert.match(textoDaTela(t.browser), /Esta conta não possui acesso a esta área\./);
  assert.equal(chamadasDeApi(t.fetchImpl).filter((chamada) => chamada.path.startsWith('/api/crm')).length, 0);

  t.browser.window.location.hash = '#/';
  await t.browser.flush();
  assert.doesNotMatch(textoDaTela(t.browser), /registros no CRM/, 'a Visão Geral também não mostra o cartão do CRM');
  assert.match(textoDaTela(t.browser), /lead aguardando revisão/);
});

test('[DASH-SHELL-17] o servidor tem a última palavra: uma conta que a interface deixou ver mas o servidor recusa (403 na lista) mostra a frase de permissão, sem quebrar o painel', async () => {
  const t = await iniciar({ session: true, routes: await rotasLogado(ME_ADMIN, { 'GET /api/crm': NEGADO }), hash: '#/crm' });
  assert.match(textoDaTela(t.browser), /Sua conta não tem permissão para esta ação\./);
  assert.ok(t.browser.by.button(t.browser.root, 'Sair'), 'o painel continua de pé');
  assert.deepEqual(t.sdk.calls.signOut, [], '403 não encerra a sessão');
  assert.equal(t.sdk.calls.refresh, 0, '403 nunca tenta renovar a sessão');
});

// ===========================================================================
// A FILA DE APROVAÇÃO continua funcionando ao lado do CRM
// ===========================================================================
test('[DASH-SHELL-18] a fila de aprovação segue igual: abrir, selecionar um prospect, aprovar com confirmação — enviando SÓ { reason } — e a lista recarrega; nada disso toca no CRM', async () => {
  let pendentes = [{ prospectId: 'id:x', empresa: 'Prospect X', estado: 'AGUARDANDO_REVISAO', discoverySnapshot: { cidade: 'Petrópolis', estadoUf: 'RJ', nicho: 'Psicologia' }, historico: [] }];
  const routes = await rotasLogado(ME_ADMIN, {
    'GET /api/approvals': () => ({ estado: 'AGUARDANDO_REVISAO', items: pendentes }),
    'POST /api/approvals/id%3Ax/approve': () => {
      pendentes = [];
      return { item: { prospectId: 'id:x', estado: 'APROVADO_PARA_CRM' } };
    },
  });
  const t = await iniciar({ session: true, routes, hash: '#/aprovacoes' });
  assert.match(textoDaTela(t.browser), /1 pendente/);
  t.browser.click(t.browser.by.button(t.browser.root, 'Prospect X'));
  t.browser.click(t.browser.by.button(t.browser.root, 'Aprovar'));
  t.browser.type(t.browser.by.label(t.browser.root, 'Motivo (opcional)'), 'Bom fit');
  t.browser.click(t.browser.by.button(t.browser.root, 'Confirmar aprovação'));
  await t.browser.flush();
  const aprovacao = chamadasDeApi(t.fetchImpl).find((chamada) => chamada.method === 'POST');
  assert.deepEqual(aprovacao.body, { reason: 'Bom fit' });
  assert.match(textoDaTela(t.browser), /Lead aprovado\./);
  assert.match(textoDaTela(t.browser), /0 pendentes/);
  assert.equal(chamadasDeApi(t.fetchImpl).filter((chamada) => chamada.path.startsWith('/api/crm')).length, 0, 'a fila não chama o CRM');
});

// ===========================================================================
// SEGREDOS NA INTERFACE
// ===========================================================================
test('[DASH-SHELL-19] o access token, o refresh token e o authUserId da sessão NUNCA aparecem na interface — em nenhuma tela, nem no título da aba', async () => {
  const t = await iniciar({ session: null, routes: await rotasLogado() });
  await entrarPeloFormulario(t);
  const segredos = [t.FAKE_SESSION.access_token, t.FAKE_SESSION.refresh_token, t.FAKE_SESSION.user.id, 'chave-anon-de-teste-nao-real', 'senha-de-teste-nao-real'];
  const conferir = (rotulo) => {
    const texto = t.browser.root.textContent + t.browser.document.title;
    for (const segredo of segredos) assert.ok(!texto.includes(segredo), `${rotulo}: "${segredo}" não pode aparecer`);
    for (const elemento of t.browser.findAll(t.browser.root, () => true)) {
      for (const valor of elemento.attributes.values()) for (const segredo of segredos) assert.ok(!valor.includes(segredo), `${rotulo}: "${segredo}" num atributo`);
    }
  };
  conferir('visão geral');
  for (const hash of ['#/crm', '#/crm/registro/crm%3Aa', '#/crm/novo', '#/aprovacoes', '#/nao-existe']) {
    t.browser.window.location.hash = hash;
    await t.browser.flush();
    conferir(hash);
  }
});
test('[DASH-SHELL-20] a Visão Geral que saiu da página está encerrada: trocar de tela ou sair não deixa uma resposta tardia redesenhá-la', async () => {
  const segurar = () => {
    let liberar;
    const espera = new Promise((resolve) => {
      liberar = resolve;
    });
    return { espera, liberar };
  };

  // trocar de tela com a Visão Geral ainda carregando
  const um = segurar();
  const t = await iniciar({ session: true, routes: await rotasLogado(ME_ADMIN, { 'GET /api/crm': async () => { await um.espera; return { items: [] }; } }) });
  const visaoGeral = t.browser.by.cls(t.browser.root, 'content')[0].children[0];
  assert.match(visaoGeral.textContent, /Carregando…/, 'o cartão do CRM ainda espera a resposta');
  t.browser.window.location.hash = '#/aprovacoes';
  await t.browser.flush();
  const congelado = visaoGeral.textContent;
  um.liberar();
  await t.browser.flush();
  assert.equal(visaoGeral.textContent, congelado, 'trocar de tela encerrou a Visão Geral: a resposta tardia não a redesenhou');
  assert.doesNotMatch(textoDaTela(t.browser), /registros no CRM/);

  // sair (logout) com a Visão Geral ainda carregando
  const dois = segurar();
  const t2 = await iniciar({ session: true, routes: await rotasLogado(ME_ADMIN, { 'GET /api/crm': async () => { await dois.espera; return { items: [] }; } }) });
  const visaoGeral2 = t2.browser.by.cls(t2.browser.root, 'content')[0].children[0];
  t2.browser.click(t2.browser.by.button(t2.browser.root, 'Sair'));
  await t2.browser.flush();
  const congelado2 = visaoGeral2.textContent;
  dois.liberar();
  await t2.browser.flush();
  assert.equal(visaoGeral2.textContent, congelado2, 'sair encerrou a Visão Geral: a resposta tardia não a redesenhou');
  assert.doesNotMatch(textoDaTela(t2.browser), /registros no CRM/);
});
