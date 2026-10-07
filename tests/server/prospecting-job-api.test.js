// API do job de prospecção automática (rotas /api/prospecting/jobs de src/server/app.js — Fase 2). Peças REAIS (Service de job, Brief Service,
// Prospecting Service, ponte de autorização) em diretório temporário; só o motor de descoberta e a leitura de página são FAKES.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');
const { authorizeProposerForLeadApproval } = require('../../src/auth');
const { createProspectingJobService } = require('../../src/services/prospectingJobService');
const { createInMemoryJobRepository } = require('../../src/research-prospector/jobRepository');

function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return req;
}

async function chamar(env, usuario, { method = 'GET', url, body, headers = {}, contentType = 'application/json' } = {}) {
  const base = {};
  if (usuario) base.Authorization = `Bearer ${env.tokenFor(usuario.userId)}`;
  if (body !== undefined && contentType !== null) base['content-type'] = contentType;
  const response = await env.app.handle(makeRequest({ method, url, headers: { ...base, ...headers }, body }));
  return { status: response.status, headers: response.headers, text: response.body, json: () => JSON.parse(response.body) };
}

const siteDe = (slug) => `https://${slug}.com.br/`;
const pagina = (nome, slug) => ({ ok: true, urlFinal: siteDe(slug), links: [], temFormularioContato: false, texto: `${nome}\nClínica de estética e harmonização\nRua das Flores, 10 - Petrópolis - RJ`, identidade: `${nome} | Clínica` });

function ambiente(t, { esperar } = {}) {
  const candidatos = [['Clínica Alfa', 'alfa'], ['Clínica Beta', 'beta'], ['Clínica Gama', 'gama']].map(([nome, slug]) => ({ nome, siteOficial: siteDe(slug), fontesDescoberta: [], presencaDigital: {} }));
  const paginas = Object.fromEntries(candidatos.map((c, i) => [c.siteOficial, pagina(c.nome, ['alfa', 'beta', 'gama'][i])]));
  let pedidos = 0;
  const motor = {
    discover: async ({ signal }) => {
      pedidos += 1;
      if (esperar) {
        const abortado = await esperar(signal);
        if (abortado) return { ok: false, code: 'ABORTED' };
      }
      return { ok: true, candidatos, invalidos: 0, custoUsd: 0.25 };
    },
  };
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
        discoveryEngine: motor,
        createFetchPage: () => async (url) => paginas[url] || { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' },
      }),
  });
  env.pedidos = () => pedidos;
  return env;
}

async function briefPronto(env, quantidade = 3) {
  const criado = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/briefs', body: { nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis/RJ', quantidade } });
  const brief = criado.json().item;
  await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${encodeURIComponent(brief.id)}/ready`, body: {} });
  return brief;
}

const esperarJob = async (env, id) => {
  for (let i = 0; i < 400; i += 1) {
    const r = await chamar(env, BRENO, { url: `/api/prospecting/jobs/${encodeURIComponent(id)}/status` });
    if (!['CRIADO', 'EXECUTANDO', 'CANCELAMENTO_SOLICITADO'].includes(r.json().item.status)) return r.json().item;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('o job não terminou');
};

test('[JOB-API-1] sem Authorization -> 401; sem o Service de job injetado as rotas não existem (404)', async (t) => {
  const env = ambiente(t);
  assert.equal((await chamar(env, null, { url: '/api/prospecting/jobs' })).status, 401);
  assert.equal((await chamar(env, null, { method: 'POST', url: '/api/prospecting/jobs', body: { briefId: 'x' } })).status, 401);
  const sem = montarAmbiente(t, { usuarios: [BRENO], crm: true, prospeccao: true, prospectingBrief: true });
  assert.equal((await chamar(sem, BRENO, { url: '/api/prospecting/jobs' })).status, 404);
});

test('[JOB-API-2] POST /jobs devolve 202 e o job NA HORA; GET /status acompanha; ao terminar, CONCLUIDO com o lote; o brief foi a AGUARDANDO_REVISAO e nada foi ao CRM', async (t) => {
  const env = ambiente(t);
  const brief = await briefPronto(env);
  const filaAntes = (await chamar(env, BRENO, { url: '/api/approvals' })).json().items.length; // a fila do ambiente já traz itens de exemplo
  const inicio = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/jobs', body: { briefId: brief.id } });
  assert.equal(inicio.status, 202);
  const job = inicio.json().item;
  assert.match(job.id, /^JOB-\d{8}-\d{3}$/);
  assert.equal(job.briefId, brief.id);
  assert.equal('achadosValidados' in job, false);
  assert.equal(inicio.headers['Cache-Control'], 'no-store');

  const fim = await esperarJob(env, job.id);
  assert.equal(fim.status, 'CONCLUIDO');
  assert.deepEqual([fim.candidatesDiscovered, fim.candidatesValidated], [3, 3]);
  assert.match(fim.lote.loteId, /^lote:/);

  const depois = await chamar(env, BRENO, { url: `/api/prospecting/briefs/${encodeURIComponent(brief.id)}` });
  assert.equal(depois.json().item.status, 'AGUARDANDO_REVISAO');
  const fila = await chamar(env, BRENO, { url: '/api/approvals' });
  assert.equal(fila.json().items.length - filaAntes, 3, 'os 3 aguardam a revisão humana na Approval Queue');
  assert.equal((await chamar(env, BRENO, { url: '/api/crm' })).json().items.length, 0, 'nada foi promovido ao CRM');

  const lista = await chamar(env, BRENO, { url: `/api/prospecting/jobs?briefId=${encodeURIComponent(brief.id)}` });
  assert.deepEqual(lista.json().items.map((j) => j.id), [job.id], 'o job é recuperável por brief (refresh da página)');
  assert.equal((await chamar(env, BRENO, { url: '/api/prospecting/jobs' })).json().items.length, 1);
});

test('[JOB-API-3] POST /jobs/:id/cancel: marca e termina CANCELADO sem ingestão; depois de terminar, 409; job inexistente, 404', async (t) => {
  let abrir;
  const env = ambiente(t, {
    esperar: (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(true), { once: true });
        abrir = () => resolve(false);
      }),
  });
  const brief = await briefPronto(env);
  const filaAntes = (await chamar(env, BRENO, { url: '/api/approvals' })).json().items.length;
  const job = (await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/jobs', body: { briefId: brief.id } })).json().item;
  const cancel = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/jobs/${encodeURIComponent(job.id)}/cancel`, body: {} });
  assert.equal(cancel.status, 200);
  assert.deepEqual([cancel.json().item.status, cancel.json().item.cancelRequested], ['CANCELAMENTO_SOLICITADO', true]);
  const fim = await esperarJob(env, job.id);
  assert.equal(fim.status, 'CANCELADO');
  assert.equal((await chamar(env, BRENO, { url: '/api/approvals' })).json().items.length, filaAntes, 'nenhuma ingestão parcial: a fila não mudou');
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/jobs/${encodeURIComponent(job.id)}/cancel`, body: {} })).status, 409);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/jobs/JOB-20261006-099/cancel', body: {} })).status, 404);
  assert.equal(typeof abrir, 'function');
});

test('[JOB-API-4] erros: corpo inválido 400, brief inexistente 404, brief em RASCUNHO 409, outra prospecção ativa 409, brief de várias cidades 400, método errado 405, id malformado 400', async (t) => {
  let abrir;
  const env = ambiente(t, { esperar: () => new Promise((resolve) => { abrir = () => resolve(false); }) });
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/jobs', body: {} })).status, 400);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/jobs', body: { briefId: 'PROS-20261006-009' } })).status, 404);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/jobs', body: { briefId: 'PROS-20261006-009', modo: 'forcar' } })).status, 400, 'nenhum campo além de briefId');
  const rascunho = (await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/briefs', body: { nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis/RJ', quantidade: 3 } })).json().item;
  const r409 = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/jobs', body: { briefId: rascunho.id } });
  assert.equal(r409.status, 409);
  assert.equal(r409.json().error.code, 'JOB_INVALID_STATE');
  const duas = (await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/briefs', body: { nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis, Teresópolis', quantidade: 3 } })).json().item;
  await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${encodeURIComponent(duas.id)}/ready`, body: {} });
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/jobs', body: { briefId: duas.id } })).json().error.code, 'JOB_BRIEF_UNSUPPORTED');

  const pronto = await briefPronto(env);
  const ativo = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/jobs', body: { briefId: pronto.id } });
  assert.equal(ativo.status, 202);
  const outro = await briefPronto(env);
  const conflito = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/jobs', body: { briefId: outro.id } });
  assert.deepEqual([conflito.status, conflito.json().error.code], [409, 'JOB_ALREADY_RUNNING']);

  assert.equal((await chamar(env, BRENO, { method: 'DELETE', url: '/api/prospecting/jobs' })).status, 405);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/jobs/${ativo.json().item.id}/status`, body: {} })).status, 405);
  assert.equal((await chamar(env, BRENO, { url: '/api/prospecting/jobs/%E0%A4%A/status' })).status, 400);
  assert.equal((await chamar(env, BRENO, { url: '/api/prospecting/jobs/x/status' })).status, 400);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/jobs/${ativo.json().item.id}/cancel`, body: { motivo: 'x' } })).status, 400);
  abrir();
  await esperarJob(env, ativo.json().item.id);
});

test('[JOB-API-5] permissões: um COMMERCIAL_CLOSER (sem PROPOSE:LEAD_APPROVAL) recebe 403 em todas as rotas de job — nenhuma permissão foi criada ou alterada', async (t) => {
  const env = ambiente(t);
  const brief = await briefPronto(env);
  for (const req of [{ url: '/api/prospecting/jobs' }, { method: 'POST', url: '/api/prospecting/jobs', body: { briefId: brief.id } }, { url: '/api/prospecting/jobs/JOB-20261006-001/status' }, { method: 'POST', url: '/api/prospecting/jobs/JOB-20261006-001/cancel', body: {} }]) {
    const r = await chamar(env, RAFAEL, req);
    assert.equal(r.status, 403, `${req.method || 'GET'} ${req.url}`);
  }
  assert.equal(env.pedidos(), 0, 'o motor nunca foi chamado');
});

test('[JOB-API-6] o corpo da resposta do job nunca carrega achados, texto de página, prompt nem identificadores internos de autenticação', async (t) => {
  const env = ambiente(t);
  const brief = await briefPronto(env);
  const job = (await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/jobs', body: { briefId: brief.id } })).json().item;
  const fim = await esperarJob(env, job.id);
  const texto = JSON.stringify(fim);
  assert.doesNotMatch(texto, /achadosValidados|authUserId|access_token|service_role|prompt/i);
  // só trechos curtos de evidência (o endereço inteiro e o texto da página não vão junto)
  assert.doesNotMatch(texto, /Clínica de estética e harmonização\\nRua/);
  for (const candidato of fim.candidatos) for (const evidencia of Object.values(candidato.evidencias || {})) assert.ok(evidencia.trecho.length <= 80);
  assert.deepEqual(Object.keys(fim.criadoPor).sort(), ['name', 'role', 'userId']);
});
