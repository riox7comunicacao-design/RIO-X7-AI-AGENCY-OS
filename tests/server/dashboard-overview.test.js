// A Visão Geral (dashboard/views/overview.mjs) e o utilitário fill() de dom.mjs.
//
// A Visão Geral só mostra números que as rotas existentes devolvem (GET /api/crm e GET /api/approvals): o total do CRM, a
// contagem por status e os prospects aguardando revisão. Cada cartão só existe se a conta tem a área (permissões de
// /api/me); uma falha vira uma frase e uma nova tentativa, nunca uma tela quebrada.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowser } = require('../helpers/fakeDom');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const TUDO = Object.freeze({ canReadCrm: true, canWriteCrm: true, canReview: true });

// 12:00Z = 09:00 em Brasília (UTC-3), logo Bom dia
const MANHA = () => new Date('2026-09-25T12:00:00Z');

// Os indicadores da tela, por título: { 'Leads no CRM': '4', ... } (um cartão sem número, como o de erro, fica de fora).
const indicadores = (browser) =>
  Object.fromEntries(
    browser.by
      .cls(browser.root, 'kpi')
      .filter((cartao) => browser.by.cls(cartao, 'stat').length > 0)
      .map((cartao) => [browser.by.tag(cartao, 'h3')[0].textContent, browser.by.cls(cartao, 'stat')[0].textContent])
  );
const ZEROS = Object.freeze({ 'Leads no CRM': '0', 'Prospects no pipeline': '0', 'Aprovações pendentes': '0', 'Reuniões': '0', 'Propostas': '0', 'Negociações': '0' });

async function montar({ permissions = TUDO, items = [], approvals = [], me = { name: 'Breno Bento' }, now = MANHA } = {}) {
  const { createOverviewView } = await import('../../dashboard/views/overview.mjs');
  const { createFakeApi } = await loadFixtures();
  const browser = createBrowser();
  const api = createFakeApi({ items, approvals });
  const view = createOverviewView({ document: browser.document, root: browser.root, api, me, permissions, now });
  return { browser, api, view, async abrir() { await view.load(); await browser.flush(); } };
}

const texto = (browser) => {
  const conteudo = browser.root.textContent.replace(/\s+/g, ' ');
  assert.doesNotMatch(conteudo, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/);
  return conteudo;
};

test('[DASH-OVERVIEW-1] mostra o total do CRM, a contagem só dos status que existem (na ordem do funil) e os prospects aguardando revisão, com o caminho para cada área', async () => {
  const { crmRecord } = await loadFixtures();
  const itens = [crmRecord({ status: 'CONTACTED' }), crmRecord({ status: 'PROSPECT' }), crmRecord({ status: 'CONTACTED' }), crmRecord({ status: 'WON' })];
  const t = await montar({ items: itens, approvals: [{ prospectId: 'a' }, { prospectId: 'b' }] });
  await t.abrir();

  assert.deepEqual(indicadores(t.browser), { 'Leads no CRM': '4', 'Prospects no pipeline': '1', 'Aprovações pendentes': '2', 'Reuniões': '0', 'Propostas': '0', 'Negociações': '0' });
  const linhas = t.browser.by.cls(t.browser.root, 'pipeline-row').map((li) => [t.browser.by.cls(li, 'badge')[0].textContent, t.browser.by.cls(li, 'pipeline-count')[0].textContent]);
  assert.equal(linhas.length, 13, 'o pipeline mostra os 13 status REAIS do domínio, na ordem do funil');
  assert.deepEqual(linhas.map(([nome]) => nome), ['Prospecção', 'Pesquisa', 'Prospect Qualificado', 'Contatado', 'Respondeu', 'Qualificação', 'Reunião Agendada', 'Reunião Realizada', 'Proposta', 'Negociação', 'Ganho', 'Perdido', 'Não Contatar']);
  assert.deepEqual(Object.fromEntries(linhas.filter(([, n]) => n !== '0')), { 'Prospecção': '1', Contatado: '2', Ganho: '1' });
  assert.match(texto(t.browser), /Bom dia, Breno Bento/);
  assert.match(texto(t.browser), /Central operacional da Rio X7\./);
  assert.match(texto(t.browser), /registros no CRM/);
  assert.match(texto(t.browser), /prospects aguardando revisão/);
  assert.equal(t.browser.by.link(t.browser.root, 'Abrir CRM').href, '#/crm');
  assert.equal(t.browser.by.link(t.browser.root, 'Abrir aprovações').href, '#/aprovacoes');
  assert.equal(t.api.callsOf('listCrm').length, 1);
  assert.equal(t.api.callsOf('listApprovals').length, 1);
});

test('[DASH-OVERVIEW-2] singular e vazio: "1 registro no CRM", "1 prospect aguardando revisão"; sem registros diz que ainda não há', async () => {
  const { crmRecord } = await loadFixtures();
  const um = await montar({ items: [crmRecord({ status: 'WON' })], approvals: [{ prospectId: 'a' }] });
  await um.abrir();
  assert.match(texto(um.browser), /registro no CRM/);
  assert.doesNotMatch(texto(um.browser), /registros no CRM/);
  assert.match(texto(um.browser), /prospect aguardando revisão/);
  assert.doesNotMatch(texto(um.browser), /prospects aguardando/);

  const vazio = await montar({ items: [], approvals: [] });
  await vazio.abrir();
  assert.deepEqual(indicadores(vazio.browser), ZEROS, 'sem dados os indicadores são 0 — nenhum número inventado');
  assert.match(texto(vazio.browser), /Ainda não há registros\./);
  assert.match(texto(vazio.browser), /Nenhuma atividade registrada ainda\./);
  assert.equal(vazio.browser.by.cls(vazio.browser.root, 'pipeline-row').length, 0);
});

test('[DASH-OVERVIEW-3] cada cartão só existe se a conta tem a área: sem READ:CRM não há cartão do CRM (e a API do CRM nem é chamada); sem a permissão de revisão não há cartão da fila; sem nenhuma, uma frase', async () => {
  const semCrm = await montar({ permissions: { canReadCrm: false, canWriteCrm: false, canReview: true } });
  await semCrm.abrir();
  assert.equal(semCrm.api.callsOf('listCrm').length, 0);
  assert.doesNotMatch(texto(semCrm.browser), /no CRM/);
  assert.match(texto(semCrm.browser), /aguardando revisão/);

  const semFila = await montar({ permissions: { canReadCrm: true, canWriteCrm: false, canReview: false } });
  await semFila.abrir();
  assert.equal(semFila.api.callsOf('listApprovals').length, 0);
  assert.match(texto(semFila.browser), /no CRM/);
  assert.doesNotMatch(texto(semFila.browser), /aguardando revisão/);

  const nenhuma = await montar({ permissions: { canReadCrm: false, canWriteCrm: false, canReview: false } });
  await nenhuma.abrir();
  assert.match(texto(nenhuma.browser), /Esta conta ainda não tem nenhuma área disponível\./);
  assert.equal(nenhuma.browser.by.cls(nenhuma.browser.root, 'card').length, 0);
});

test('[DASH-OVERVIEW-4] uma falha só derruba o cartão que falhou: 500 mostra a frase genérica (sem o detalhe do servidor) com "Tentar novamente", 403 diz que falta permissão, e o outro cartão segue funcionando', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar({ items: [], approvals: [{ prospectId: 'a' }] });
  t.api.failNext('listCrm', new ApiError(500, 'INTERNAL', 'detalhe interno C:\\segredo\\crm.json'));
  await t.abrir();
  assert.match(texto(t.browser), /Não foi possível concluir a operação agora/);
  assert.doesNotMatch(texto(t.browser), /segredo|crm\.json/);
  assert.deepEqual(indicadores(t.browser), { 'Aprovações pendentes': '1' }, 'o cartão da fila carregou; o do CRM virou um cartão de erro');

  t.browser.click(t.browser.by.button(t.browser.root, 'Tentar novamente'));
  await t.browser.flush();
  assert.deepEqual(indicadores(t.browser), { ...ZEROS, 'Aprovações pendentes': '1' });

  t.api.failNext('listApprovals', new ApiError(403, 'FORBIDDEN', 'Esta conta não possui acesso a esta área.'));
  await t.view.load();
  await t.browser.flush();
  assert.match(texto(t.browser), /Sua conta não tem permissão para esta ação\./);
});

test('[DASH-OVERVIEW-5] uma resposta malformada (itens que não são lista) vira zero, nunca uma exceção; destroy() para de desenhar', async () => {
  const t = await montar();
  t.api.listCrm = async () => ({ items: 'não é lista' });
  t.api.listApprovals = async () => ({ items: { a: 1 } });
  await t.abrir();
  assert.deepEqual(indicadores(t.browser), ZEROS);

  t.view.destroy();
  const antes = t.browser.root.textContent;
  t.view.render();
  assert.equal(t.browser.root.textContent, antes, 'depois de destroy() nada é redesenhado');
});

// ===========================================================================
// fill() — o único jeito de trocar filhos que as telas usam
// ===========================================================================
test('[DASH-OVERVIEW-6] fill(): ignora null, undefined e false (o replaceChildren do navegador escreveria "null" na tela) e troca os filhos como replaceChildren', async () => {
  const { h, fill } = await import('../../dashboard/dom.mjs');
  const browser = createBrowser();
  const lista = h(browser.document, 'ul', {}, h(browser.document, 'li', { text: 'velho' }));
  fill(lista, null, h(browser.document, 'li', { text: 'novo' }), undefined, false, h(browser.document, 'li', { text: 'outro' }));
  assert.deepEqual(lista.children.map((li) => li.textContent), ['novo', 'outro']);
  assert.equal(lista.textContent, 'novooutro', 'nenhum texto "null", "undefined" ou "false" sobrou');
  fill(lista);
  assert.equal(lista.children.length, 0);

  // O DOM de teste imita o navegador: replaceChildren com algo que não é nó escreve TEXTO — exatamente o erro que fill() evita.
  lista.replaceChildren(null, undefined);
  assert.equal(lista.textContent, 'nullundefined');
});

test('[DASH-OVERVIEW-7] os nomes em português dos status valem só na Visão Geral: cobrem exatamente os 13 status do domínio (identificadores intactos), um status desconhecido cai no rótulo do CRM, e o CRM segue com os rótulos de sempre', async () => {
  const { OVERVIEW_STATUS_LABELS, overviewStatusLabel } = await import('../../dashboard/views/overview.mjs');
  const { CRM_STATUSES, statusLabel } = await import('../../dashboard/crm-model.mjs');
  assert.deepEqual(Object.keys(OVERVIEW_STATUS_LABELS), CRM_STATUSES.map((status) => status.value), 'mesmos identificadores, mesma ordem do funil');
  assert.deepEqual(Object.values(OVERVIEW_STATUS_LABELS), ['Prospecção', 'Pesquisa', 'Prospect Qualificado', 'Contatado', 'Respondeu', 'Qualificação', 'Reunião Agendada', 'Reunião Realizada', 'Proposta', 'Negociação', 'Ganho', 'Perdido', 'Não Contatar']);
  assert.equal(overviewStatusLabel('STATUS_NOVO'), statusLabel('STATUS_NOVO'));
  assert.equal(overviewStatusLabel('constructor'), statusLabel('constructor'), 'nada herdado do protótipo vira rótulo');
  assert.equal(statusLabel('PROSPECT'), 'Prospect', 'o rótulo do CRM não mudou');

  const t = await montar({ items: [], approvals: [] });
  await t.abrir();
  const cartao = t.browser.by.cls(t.browser.root, 'kpi').find((c) => t.browser.by.tag(c, 'h3')[0].textContent === 'Prospects no pipeline');
  assert.ok(cartao, 'o cartão se chama "Prospects no pipeline"');
  assert.equal(t.browser.by.cls(cartao, 'kpi-sub')[0].textContent, 'registros no status Prospecção');
  assert.doesNotMatch(texto(t.browser), /Novos prospects/);
});
