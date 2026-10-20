// O PAINEL NA INSTÂNCIA HOSPEDADA (Fase WEB 1, decisão 0033): /config.json traz `modo: "crm-only"` e o painel (a) tira do menu a Prospecção, a Fila de Aprovação, os Leads Reprovados e as Exclusões
// Permanentes, (b) mostra "Módulo indisponível" num endereço digitado à mão — SEM chamar a API —, (c) não pergunta pela fila na Visão Geral. É conforto: quem recusa de verdade é o servidor
// (MODULE_DISABLED, testado em hosted-crm-only.test.js). Sem `modo` (o painel local) nada muda. A recuperação de senha pede o link com a origem pública do site.
//
// DOM de teste, SDK falso e fetch roteado — nenhuma credencial real, nenhuma rede, nenhum registro real.

const test = require('node:test');
const assert = require('node:assert/strict');

const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const ME_ADMIN = { userId: 'user-breno', name: 'Breno', role: 'ADMIN', permissions: [...authConstants.getRolePermissions('ADMIN')], status: 'ACTIVE' };
const ENDERECOS_DESATIVADOS = ['#/aprovacoes', '#/aprovacoes/id%3Ax', '#/prospeccao', '#/prospeccao/briefing/b1', '#/prospeccao/execucao/j1', '#/prospeccao/historico', '#/prospeccao/historico/j1', '#/prospeccao/leads-reprovados', '#/prospeccao/leads-reprovados/l1', '#/exclusoes-permanentes'];
const ROTULOS_DESATIVADOS = ['Prospecção', 'Nova Prospecção', 'Histórico de prospecções', 'Fila de Aprovação', 'Leads Reprovados', 'Exclusões Permanentes'];

async function iniciar({ config = CONFIG, hash = '', origin } = {}) {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, scriptedFetch, FAKE_SESSION, crmRecord } = await loadFixtures();
  const itens = [crmRecord({ id: 'crm:a', empresa: 'Clínica Alfa', status: 'CONTACTED', nicho: 'Psicologia', dataDeEntrada: '2026-09-12T10:00:00.000Z' })];
  const rotas = {
    'GET /config.json': config,
    'GET /api/me': ME_ADMIN,
    'GET /api/crm': { items: itens },
    'GET /api/approvals': { estado: 'AGUARDANDO_REVISAO', items: [] },
    'GET /api/prospecting/briefs': { items: [] },
    'GET /api/prospecting/jobs': { items: [] },
    'GET /api/leads/reprovados': { items: [] },
    'GET /api/prospecting/exclusions': { items: [] },
    'GET /api/funnels': { items: [] },
    'GET /api/funnel-board': { quadro: { funis: [], etapas: [], cards: [], totais: [] } },
  };
  const browser = createBrowser({ hash });
  if (origin) browser.window.location.origin = origin;
  const sdk = createFakeSdk({ session: FAKE_SESSION });
  const fetchImpl = scriptedFetch(rotas);
  const navigation = browserNavigation(browser.window);
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk, navigation });
  await browser.flush(8);
  return { browser, fetchImpl, sdk, win: browser.window };
}

const texto = (t) => t.browser.root.textContent.replace(/\s+/g, ' ');
const chamadasApi = (t) => t.fetchImpl.calls.filter((c) => c.path.startsWith('/api/')).map((c) => `${c.method} ${c.path}`);
const proibidas = (t) => chamadasApi(t).filter((c) => /\/api\/(approvals|prospecting|leads)/.test(c));
const ir = async (t, hash) => {
  t.win.location.hash = hash;
  await t.browser.flush(10);
};
const menu = (t) => t.browser.by.tag(t.browser.root, 'nav')[0];
const rotulosDoMenu = (t) => menu(t).textContent.replace(/\s+/g, ' ');

test('[HOSTCRM-1] com modo "crm-only" o menu NÃO tem os módulos desativados e mantém o CRM (Clientes, Funis, Configurações)', async () => {
  const t = await iniciar({ config: { ...CONFIG, modo: 'crm-only' } });
  const m = rotulosDoMenu(t);
  for (const rotulo of ROTULOS_DESATIVADOS) assert.ok(!m.includes(rotulo), `o menu não pode ter "${rotulo}"`);
  for (const rotulo of ['Visão Geral', 'CRM', 'Clientes', 'Funis']) assert.ok(m.includes(rotulo), `o menu tem "${rotulo}"`);
});

test('[HOSTCRM-2] a Visão Geral hospedada carrega só o CRM: nenhuma chamada à fila de aprovação (nem a qualquer rota desativada)', async () => {
  const t = await iniciar({ config: { ...CONFIG, modo: 'crm-only' } });
  assert.ok(chamadasApi(t).includes('GET /api/crm'), 'a Visão Geral mostra o CRM');
  assert.deepEqual(proibidas(t), []);
  assert.doesNotMatch(texto(t), /aprovaç|fila de aprova/i, 'sem cartão da fila de aprovação');
  assert.match(texto(t), /Leads no CRM/);
});

test('[HOSTCRM-3] endereços dos módulos desativados digitados à mão mostram "Módulo indisponível" e NÃO chamam a API; o painel segue navegável', async () => {
  const t = await iniciar({ config: { ...CONFIG, modo: 'crm-only' } });
  for (const endereco of ENDERECOS_DESATIVADOS) {
    await ir(t, endereco);
    assert.match(texto(t), /Módulo indisponível/, endereco);
    assert.match(texto(t), /não está disponível nesta instalação online/, endereco);
    assert.deepEqual(proibidas(t), [], `${endereco} chamou a API desativada`);
  }
  await ir(t, '#/crm/clientes');
  assert.doesNotMatch(texto(t), /Módulo indisponível/, 'o CRM continua abrindo');
  assert.deepEqual(proibidas(t), []);
  await ir(t, '#/funis');
  assert.doesNotMatch(texto(t), /Módulo indisponível/);
});

test('[HOSTCRM-4] controle: sem `modo` (o painel local) tudo continua como era — o menu tem a Prospecção e a Fila, e as telas chamam a API', async () => {
  const t = await iniciar({ config: CONFIG });
  const m = rotulosDoMenu(t);
  for (const rotulo of ['Prospecção', 'Fila de Aprovação', 'Leads Reprovados', 'Exclusões Permanentes']) assert.ok(m.includes(rotulo), `o menu local tem "${rotulo}"`);
  assert.ok(chamadasApi(t).includes('GET /api/approvals'), 'a Visão Geral local consulta a fila');
  await ir(t, '#/aprovacoes');
  assert.doesNotMatch(texto(t), /Módulo indisponível/);
  await ir(t, '#/prospeccao/historico');
  assert.doesNotMatch(texto(t), /Módulo indisponível/);
  // um valor de `modo` desconhecido NÃO liga o modo hospedado (só "crm-only" liga)
  const outro = await iniciar({ config: { ...CONFIG, modo: 'hospedado' } });
  assert.ok(rotulosDoMenu(outro).includes('Fila de Aprovação'));
});

test('[HOSTCRM-5] recuperação de senha na instância hospedada: o link é pedido com a ORIGEM PÚBLICA do site como retorno (sem # nem ?)', async () => {
  const t = await iniciar({ config: { ...CONFIG, modo: 'crm-only' }, origin: 'https://crm.exemplo.test' });
  // o painel já abriu com sessão; sair leva ao login, de onde se pede a recuperação
  const sair = t.browser.find(t.browser.root, (el) => el.localName === 'button' && /Sair/.test(el.getAttribute('aria-label') || el.textContent || ''));
  assert.ok(sair, 'há um botão Sair');
  t.browser.click(sair);
  await t.browser.flush(10);
  const esqueci = t.browser.by.button(t.browser.root, 'Esqueci minha senha?');
  assert.ok(esqueci, 'o login oferece "Esqueci minha senha?"');
  t.browser.click(esqueci);
  await t.browser.flush(10);
  t.browser.type(t.browser.by.label(t.browser.root, 'E-mail'), 'pessoa-de-teste@example.test');
  t.browser.click(t.browser.by.button(t.browser.root, 'Enviar link de recuperação'));
  await t.browser.flush(10);
  assert.deepEqual(t.sdk.calls.resetPassword, [{ email: 'pessoa-de-teste@example.test', options: { redirectTo: 'https://crm.exemplo.test/' } }]);
});
