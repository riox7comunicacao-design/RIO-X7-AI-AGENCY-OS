// A "Central Operacional" (Dashboard V1 visual): o menu lateral agrupado, os itens ainda não implementados, a Central de
// Agentes IA, a saudação e a atividade recente da Visão Geral.
//
// O que estes testes protegem: nada aqui finge funcionar — uma área que não existe aparece desabilitada e marcada "Em
// desenvolvimento" (sem link e sem rota); a Central de Agentes é só estrutura visual (nenhuma chamada de API, nenhum número,
// nenhum botão de execução); os números da Visão Geral vêm de dados reais e a atividade recente são os eventos REAIS do
// histórico; e nenhum dado sensível (token, authUserId) chega à tela. As telas de CRM e Aprovações têm os seus próprios testes.

const test = require('node:test');
const assert = require('node:assert/strict');

const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const ME_ADMIN = { userId: 'user-breno', name: 'Breno Bento', role: 'ADMIN', permissions: [...authConstants.getRolePermissions('ADMIN')], status: 'ACTIVE' };

async function iniciar({ hash = '', me = ME_ADMIN, itens } = {}) {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, scriptedFetch, FAKE_SESSION, crmRecord } = await loadFixtures();
  const browser = createBrowser({ hash });
  const registros = itens || [crmRecord({ id: 'crm:a', empresa: 'Clínica Alfa', status: 'CONTACTED' })];
  const fetchImpl = scriptedFetch({
    'GET /config.json': CONFIG,
    'GET /api/me': me,
    'GET /api/crm': { items: registros },
    'GET /api/approvals': { estado: 'AGUARDANDO_REVISAO', items: [] },
  });
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk: createFakeSdk({ session: FAKE_SESSION }), navigation: browserNavigation(browser.window) });
  await browser.flush();
  return { browser, fetchImpl, FAKE_SESSION };
}

const apiCalls = (t) => t.fetchImpl.calls.filter((chamada) => chamada.path.startsWith('/api/')).map((chamada) => `${chamada.method || 'GET'} ${chamada.path}`);
const tela = (browser) => browser.root.textContent.replace(/\s+/g, ' ');

test('[DASH-CENTRAL-1] o menu lateral é agrupado (Operacional, Comercial, Agentes IA, Gestão), leva a marca e o usuário, e só as áreas que existem são links', async () => {
  const t = await iniciar();
  const lateral = t.browser.by.tag(t.browser.root, 'aside')[0];
  assert.ok(lateral, 'existe um menu lateral');
  assert.equal(t.browser.by.cls(lateral, 'brand-name')[0].textContent, 'RIO X7');
  assert.equal(t.browser.by.cls(lateral, 'brand-sub')[0].textContent, 'AI AGENCY OS');
  assert.deepEqual(
    t.browser.by.cls(lateral, 'nav-title').map((el) => el.textContent),
    ['Operacional', 'Comercial', 'Agentes IA', 'Gestão']
  );

  const nav = t.browser.by.tag(lateral, 'nav')[0];
  assert.deepEqual(t.browser.by.tag(nav, 'a').map((link) => link.textContent), ['Visão Geral', 'CRM', 'Aprovações', 'Central de Agentes']);

  // as áreas ainda não implementadas: desabilitadas, marcadas, sem link e sem rota
  const emBreve = t.browser.by.cls(nav, 'soon');
  assert.deepEqual(
    emBreve.map((el) => el.children[0].textContent),
    ['Agenda', 'Prospecção', 'Leads', 'Conversas', 'Reuniões', 'Propostas', 'Relatórios', 'Configurações']
  );
  for (const item of emBreve) {
    assert.equal(item.localName, 'span', 'não é um link');
    assert.equal(item.getAttribute('aria-disabled'), 'true');
    assert.equal(item.getAttribute('href'), null);
    assert.equal(t.browser.by.cls(item, 'nav-soon')[0].textContent, 'Em desenvolvimento');
  }

  // o usuário fica no menu: nome, função e Sair
  assert.equal(t.browser.by.cls(lateral, 'who-name')[0].textContent, 'Breno Bento');
  assert.match(lateral.textContent, /Administrador/);
  assert.ok(t.browser.by.button(lateral, 'Sair'));

  // clicar num item em desenvolvimento não navega
  const antes = t.browser.window.location.hash;
  t.browser.click(emBreve[0]);
  await t.browser.flush();
  assert.equal(t.browser.window.location.hash, antes);
  assert.equal(t.browser.by.cls(t.browser.root, 'agent-card').length, 0);
});

test('[DASH-CENTRAL-2] a Central de Agentes mostra os 14 especialistas, todos "Em desenvolvimento", sem executar nada: nenhuma chamada de API, nenhum número, nenhum botão de ação', async () => {
  const t = await iniciar({ hash: '#/agentes' });
  assert.equal(t.browser.document.title, 'Agentes IA — Rio X7 AI Agency OS');
  assert.equal(t.browser.by.tag(t.browser.root, 'h2')[0].textContent, 'Agentes IA');
  assert.match(tela(t.browser), /Especialistas digitais da operação Rio X7\./);

  const cartoes = t.browser.by.cls(t.browser.root, 'agent-card');
  assert.deepEqual(
    cartoes.map((cartao) => t.browser.by.tag(cartao, 'h3')[0].textContent),
    ['Prospector', 'SDR', 'Raio-X Digital', 'Closer', 'Gestor de Tráfego', 'Copywriter', 'Designer', 'Editor de Vídeo', 'Web Developer', 'Administrativo', 'Financeiro', 'Jurídico', 'Customer Success', 'COO / Orquestrador']
  );
  for (const cartao of cartoes) {
    assert.equal(t.browser.by.cls(cartao, 'badge')[0].textContent, 'Em desenvolvimento');
    assert.equal(t.browser.by.tag(cartao, 'button').length, 0, 'nenhum botão de execução');
    assert.equal(t.browser.by.tag(cartao, 'a').length, 0);
  }
  assert.equal(t.browser.by.cls(t.browser.root, 'stat').length, 0, 'nenhuma métrica inventada');
  assert.deepEqual(apiCalls(t), ['GET /api/me'], 'a Central de Agentes não chama nenhuma API além de quem é o usuário');
});

test('[DASH-CENTRAL-3] a saudação acompanha a hora de Brasília e a Visão Geral mostra o subtítulo da central', async () => {
  const { greetingFor } = await import('../../dashboard/views/overview.mjs');
  assert.deepEqual([0, 4, 5, 11, 12, 17, 18, 23].map(greetingFor), ['Boa noite', 'Boa noite', 'Bom dia', 'Bom dia', 'Boa tarde', 'Boa tarde', 'Boa noite', 'Boa noite']);
  assert.equal(greetingFor(NaN), 'Olá');
  assert.equal(greetingFor(undefined), 'Olá');

  const t = await iniciar();
  assert.match(t.browser.by.tag(t.browser.root, 'h2')[0].textContent, /^(Bom dia|Boa tarde|Boa noite), Breno Bento$/);
  assert.match(tela(t.browser), /Central operacional da Rio X7\./);
});

test('[DASH-CENTRAL-4] a atividade recente são os eventos REAIS do histórico dos registros, do mais novo para o mais antigo (no máximo 8); eventos malformados são ignorados', async () => {
  const { recentActivity } = await import('../../dashboard/views/overview.mjs');
  const evento = (timestamp, from, to) => ({ timestamp, from, to, actor: 'HUMAN', reviewedBy: { userId: 'u', name: 'Breno Bento', role: 'ADMIN' }, motivo: null });
  const registros = [
    { id: 'crm:1', empresa: 'Um', historico: [evento('2026-09-10T10:00:00.000Z', null, 'PROSPECT'), evento('2026-09-12T10:00:00.000Z', 'PROSPECT', 'CONTACTED')] },
    { id: 'crm:2', empresa: 'Dois', historico: [evento('2026-09-11T10:00:00.000Z', null, 'PROSPECT'), evento('data inválida', null, 'PROSPECT'), null, 42, {}] },
    { id: 'crm:3', empresa: 'Três', historico: 'não é lista' },
    null,
    'texto',
  ];
  const eventos = recentActivity(registros);
  assert.deepEqual(eventos.map((entry) => `${entry.record.empresa}:${entry.entry.to}`), ['Um:CONTACTED', 'Dois:PROSPECT', 'Um:PROSPECT']);
  assert.deepEqual(recentActivity('não é lista'), []);
  const muitos = [{ id: 'crm:m', empresa: 'Muitos', historico: Array.from({ length: 20 }, (_, i) => evento(`2026-09-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`, null, 'PROSPECT')) }];
  assert.equal(recentActivity(muitos).length, 8);
  assert.equal(recentActivity(muitos)[0].entry.timestamp, '2026-09-20T10:00:00.000Z');

  // na tela: o nome da empresa é o link para o registro e a linha diz o que mudou e quem mudou
  const { crmRecord } = await loadFixtures();
  const t = await iniciar({
    itens: [
      crmRecord({ id: 'crm:z', empresa: 'Clínica Zeta', status: 'CONTACTED', historico: [evento('2026-09-10T10:00:00.000Z', null, 'PROSPECT'), evento('2026-09-12T10:00:00.000Z', 'PROSPECT', 'CONTACTED')] }),
    ],
  });
  const linhas = t.browser.by.cls(t.browser.root, 'activity-row');
  assert.equal(linhas.length, 2);
  assert.equal(t.browser.by.tag(linhas[0], 'a')[0].href, '#/crm/registro/crm%3Az');
  assert.match(linhas[0].textContent, /Clínica Zeta/);
  assert.match(linhas[0].textContent, /Prospect → Contacted/);
  assert.match(linhas[0].textContent, /Breno Bento/);
  assert.match(linhas[1].textContent, /Registro criado como Prospect/);
});

test('[DASH-CENTRAL-5] nenhum dado sensível na tela: nem o token da sessão, nem o authUserId, nem chaves — no painel inteiro e na Central de Agentes', async () => {
  for (const hash of ['', '#/agentes', '#/crm', '#/aprovacoes']) {
    const t = await iniciar({ hash });
    const conteudo = t.browser.root.textContent;
    assert.equal(conteudo.includes(t.FAKE_SESSION.access_token), false, `${hash}: token na tela`);
    assert.doesNotMatch(conteudo, /authUserId|access_token|refresh_token|service_role|eyJ[A-Za-z0-9_-]{10,}/, `${hash}: dado sensível na tela`);
  }
});

test('[DASH-CENTRAL-6] o login mostra a marca e a descrição da central, e nenhum menu', async () => {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, scriptedFetch } = await loadFixtures();
  const browser = createBrowser();
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl: scriptedFetch({ 'GET /config.json': CONFIG }), sdk: createFakeSdk({ session: null }), navigation: browserNavigation(browser.window) });
  await browser.flush();
  assert.equal(browser.by.cls(browser.root, 'brand-name')[0].textContent, 'RIO X7');
  assert.equal(browser.by.cls(browser.root, 'brand-sub')[0].textContent, 'AI AGENCY OS');
  assert.match(tela(browser), /Central operacional da Rio X7 Comunicação\./);
  assert.ok(browser.by.button(browser.root, 'Entrar'));
  assert.equal(browser.by.tag(browser.root, 'nav').length, 0);
  assert.equal(browser.by.tag(browser.root, 'aside').length, 0);
});
