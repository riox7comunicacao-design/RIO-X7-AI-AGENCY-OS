// Regressão do bug "Envie exatamente { briefId }" ao clicar em INICIAR PROSPECÇÃO: a tela REAL (dashboard/views/prospecting.mjs) + o cliente de API REAL
// (dashboard/api.mjs) falando com o servidor REAL (src/server/app.js, Service de job, Brief Service, ponte de autorização) — só o motor de descoberta, a leitura de página
// e o `fetch` (ligado direto ao app, sem rede) são fakes. Prova o PAYLOAD de ponta a ponta: o POST /api/prospecting/jobs leva { briefId, maxCandidates }.
//
// CAUSA do erro observado no navegador: o servidor que respondia (processo iniciado ANTES da Implementação 3.0) ainda tinha o contrato antigo da rota — "Envie exatamente
// { briefId }." — e recusava a chave `maxCandidates`, enquanto os arquivos do dashboard (servidos do disco a cada requisição) já eram os novos. Com o servidor atual
// o contrato é { briefId, maxCandidates? }; este teste garante que tela e servidor atuais concordam.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { createBrowser } = require('../helpers/fakeDom');
const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');
const { authorizeProposerForLeadApproval } = require('../../src/auth');
const { createProspectingJobService } = require('../../src/services/prospectingJobService');
const { createInMemoryJobRepository } = require('../../src/research-prospector/jobRepository');

const { admin } = require('../helpers/promotionFixtures');
const contextoDe = async () => admin();
const siteDe = (slug) => `https://${slug}.com.br/`;
const pagina = (nome, slug) => ({ ok: true, urlFinal: siteDe(slug), links: [], temFormularioContato: false, texto: `${nome}\nClínica de estética e harmonização\nRua das Flores, 10 - Petrópolis - RJ`, identidade: `${nome} | Clínica` });

function ambiente(t) {
  const nomes = [['Clínica Alfa', 'alfa'], ['Clínica Beta', 'beta'], ['Clínica Gama', 'gama']];
  const candidatos = nomes.map(([nome, slug]) => ({ nome, siteOficial: siteDe(slug), fontesDescoberta: [], presencaDigital: {} }));
  const paginas = Object.fromEntries(nomes.map(([nome, slug]) => [siteDe(slug), pagina(nome, slug)]));
  const pedidosAoMotor = [];
  const env = montarAmbiente(t, {
    usuarios: [BRENO, RAFAEL],
    crm: true,
    prospeccao: true,
    prospectingBrief: true,
    prospectingJob: ({ prospectingBriefService }) =>
      createProspectingJobService({
        authorizeProposer: authorizeProposerForLeadApproval,
        briefService: prospectingBriefService,
        repository: createInMemoryJobRepository(),
        discoveryEngine: { discover: async (pedido) => { pedidosAoMotor.push(pedido); return { ok: true, candidatos, invalidos: 0 }; } },
        createFetchPage: () => async (url) => paginas[url] || { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' },
      }),
  });
  env.pedidosAoMotor = pedidosAoMotor;
  return env;
}

// O `fetch` do navegador ligado direto ao app, registrando cada requisição (método, caminho e corpo JÁ interpretado).
function fetchLigadoAoApp(env, requisicoes) {
  return async (path, init) => {
    const corpo = init.body === undefined ? undefined : JSON.parse(init.body);
    requisicoes.push({ method: init.method, path, body: corpo });
    const req = init.body === undefined ? Readable.from([]) : Readable.from([Buffer.from(init.body)]);
    req.method = init.method;
    req.url = path;
    req.headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const resposta = await env.app.handle(req);
    return { ok: resposta.status >= 200 && resposta.status < 300, status: resposta.status, json: async () => JSON.parse(resposta.body) };
  };
}

async function montarTela(t) {
  const { createProspectingView } = await import('../../dashboard/views/prospecting.mjs');
  const { createApiClient } = await import('../../dashboard/api.mjs');
  const env = ambiente(t);
  const requisicoes = [];
  const api = createApiClient({ getAccessToken: async () => env.tokenFor(BRENO.userId), refreshAccessToken: async () => null, onSessionLost: () => assert.fail('a sessão não deveria cair'), fetchImpl: fetchLigadoAoApp(env, requisicoes) });
  const browser = createBrowser();
  const agendadas = [];
  const view = createProspectingView({ document: browser.document, root: browser.root, api, permissions: { canProposeLead: true }, schedule: (fn, ms) => { const tarefa = { fn, ms }; agendadas.push(tarefa); return () => { tarefa.cancelada = true; }; } });
  await view.load();
  await browser.flush();
  return { env, browser, requisicoes, agendadas, tela: () => browser.root.textContent.replace(/\s+/g, ' ') };
}

async function criarLote(x, { quantidade, maximo }) {
  const raiz = x.browser.root;
  x.browser.type(x.browser.by.id(raiz, 'pros-nicho'), 'Clínicas de estética');
  x.browser.type(x.browser.by.id(raiz, 'pros-locais'), 'Petrópolis');
  x.browser.type(x.browser.by.id(raiz, 'pros-quantidade'), String(quantidade));
  if (maximo !== undefined) x.browser.type(x.browser.by.id(raiz, 'pros-max-candidates'), String(maximo));
  x.browser.click(x.browser.by.text(raiz, 'Criar briefing', 'button'));
  await x.browser.flush(12);
}

async function loteProntoEIniciar(x, opcoes) {
  await criarLote(x, opcoes);
  // o lote nasce RASCUNHO no servidor real: o botão da própria tela o marca como pronto para pesquisa
  x.browser.click(x.browser.by.text(x.browser.root, 'Marcar pronto para pesquisa', 'button'));
  await x.browser.flush(12);
  assert.match(x.tela(), /Pronto para pesquisa/);
  const iniciar = x.browser.by.id(x.browser.root, 'pros-start-job');
  assert.ok(iniciar, 'o botão "Iniciar prospecção" aparece');
  x.browser.click(iniciar);
  await x.browser.flush(4);
  assert.equal(x.requisicoes.filter((r) => r.method === 'POST' && r.path === '/api/prospecting/jobs').length, 0, 'abrir a confirmação não inicia a prospecção');
  x.browser.click(x.browser.find(x.browser.root, (el) => el.getAttribute('data-action') === 'confirm'));
  await x.browser.flush(12);
}

test('[JOBSTART-1] briefing criado (quantidade 3, máximo 10) -> Iniciar prospecção (com confirmação): o POST /api/prospecting/jobs leva { briefId, maxCandidates: 10 }, é aceito (202) e a mensagem "Envie exatamente" NÃO aparece', async (t) => {
  const x = await montarTela(t);
  await loteProntoEIniciar(x, { quantidade: 3, maximo: 10 });

  // 1) a criação do BRIEF: quantidade 3 e NENHUM maxCandidates (o briefing não guarda o limite operacional)
  const criacao = x.requisicoes.find((r) => r.method === 'POST' && r.path === '/api/prospecting/briefs');
  assert.ok(criacao);
  assert.equal(criacao.body.quantidade, 3);
  assert.equal('maxCandidates' in criacao.body, false, 'maxCandidates NÃO vai para a criação do Brief');

  // 2) o início do JOB: exatamente { briefId, maxCandidates: 10 }, com o id do brief criado
  const inicios = x.requisicoes.filter((r) => r.method === 'POST' && r.path === '/api/prospecting/jobs');
  assert.equal(inicios.length, 1);
  const [{ body }] = inicios;
  assert.deepEqual(Object.keys(body).sort(), ['briefId', 'maxCandidates']);
  assert.match(body.briefId, /^PROS-\d{8}-\d{3}$/);
  assert.equal(body.maxCandidates, 10);
  assert.equal(typeof body.maxCandidates, 'number');

  // 3) o servidor aceitou: o job existe com o limite 10 e a quantidade desejada 3 (que continua sendo a do brief)
  const jobs = await x.env.prospectingJobService.listJobs(await contextoDe(x.env), {});
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].briefId, body.briefId);
  assert.equal(jobs[0].limits.maxCandidates, 10);
  assert.equal(jobs[0].requestedQuantity, 3);
  const aceito = x.requisicoes.length;
  assert.ok(aceito > 0);

  // 4) a tela NÃO mostra o erro do contrato antigo
  assert.doesNotMatch(x.tela(), /Envie exatamente/);
  assert.doesNotMatch(x.tela(), /\{brief/);
  assert.match(x.tela(), /Em execução|Descobrindo|Validando|PROSPECÇÃO/);
  await x.env.prospectingJobService.waitFor(jobs[0].id);
  assert.equal(x.env.pedidosAoMotor[0].limit <= 10, true, 'o motor nunca é pedido além do máximo de candidatos');
});

test('[JOBSTART-2] sem mexer no campo, o padrão 50 chega ao endpoint; e o contrato do servidor continua exato: chave desconhecida recusada, briefId obrigatório', async (t) => {
  const x = await montarTela(t);
  await loteProntoEIniciar(x, { quantidade: 3 });
  const inicio = x.requisicoes.find((r) => r.method === 'POST' && r.path === '/api/prospecting/jobs');
  assert.deepEqual(inicio.body.maxCandidates, 50);
  assert.doesNotMatch(x.tela(), /Envie exatamente/);
  await x.env.prospectingJobService.waitFor((await x.env.prospectingJobService.listJobs(await contextoDe(x.env), {}))[0].id);

  const chamar = (body) => fetchLigadoAoApp(x.env, [])('/api/prospecting/jobs', { method: 'POST', headers: { Authorization: `Bearer ${x.env.tokenFor(BRENO.userId)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await chamar({ briefId: 'PROS-20261008-777', extra: 1 })).status, 400, 'chave desconhecida');
  assert.equal((await chamar({ maxCandidates: 10 })).status, 400, 'sem briefId');
  assert.equal((await chamar({ briefId: 'PROS-20261008-777', maxCandidates: 10 })).status, 404, 'payload válido: o brief inexistente é 404, nunca 400 de contrato');
});
