// Testes da API do Workbench de Prospecção (rotas /api/prospecting/briefs e /api/prospecting/batches de
// src/server/app.js — Etapa "Prospecção 1"). Sobre peças REAIS (Service real, ponte de autorização real, adapters
// de arquivo reais em diretório temporário — mesmo espírito de funnel-api.test.js/crm-api.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

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

const briefInput = (extra = {}) => ({ nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis, Teresópolis', quantidade: 50, ...extra });

const achado = (empresa, slug) => ({
  empresa,
  tipo: 'clínica',
  cidade: 'Petrópolis',
  estado: 'RJ',
  nicho: 'Psicologia',
  campos: { site: [{ valor: `${slug}.example.test`, fonte: 'Fonte de teste', tipoFonte: 'OFICIAL' }] },
  fontes: [`https://${slug}.example.test`],
});

function ambiente(t, extra = {}) {
  return montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, prospeccao: true, prospectingBrief: true, ...extra });
}

test('[BRIEF-API-1] sem Authorization -> 401; ADMIN cria (201), lista (200) e detalha (200) um brief', async (t) => {
  const env = ambiente(t);
  const semAuth = await chamar(env, null, { url: '/api/prospecting/briefs' });
  assert.equal(semAuth.status, 401);

  const criado = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/briefs', body: briefInput() });
  assert.equal(criado.status, 201);
  const brief = criado.json().item;
  assert.match(brief.id, /^PROS-\d{8}-\d{3}$/);
  assert.equal(brief.status, 'RASCUNHO');

  const lista = await chamar(env, BRENO, { url: '/api/prospecting/briefs' });
  assert.equal(lista.status, 200);
  assert.equal(lista.json().items.length, 1);

  const detalhe = await chamar(env, BRENO, { url: `/api/prospecting/briefs/${encodeURIComponent(brief.id)}` });
  assert.equal(detalhe.status, 200);
  assert.equal(detalhe.json().item.id, brief.id);
});

test('[BRIEF-API-2] COMMERCIAL_CLOSER (sem PROPOSE:LEAD_APPROVAL) recebe 403 em toda rota do Workbench', async (t) => {
  const env = ambiente(t);
  const criado = (await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/briefs', body: briefInput() })).json().item;

  for (const requisicao of [
    { method: 'GET', url: '/api/prospecting/briefs' },
    { method: 'POST', url: '/api/prospecting/briefs', body: briefInput() },
    { method: 'GET', url: `/api/prospecting/briefs/${criado.id}` },
    { method: 'POST', url: `/api/prospecting/briefs/${criado.id}/ready`, body: {} },
    { method: 'POST', url: `/api/prospecting/briefs/${criado.id}/package`, body: {} },
    { method: 'POST', url: `/api/prospecting/briefs/${criado.id}/findings`, body: { rawFindings: [] } },
    { method: 'POST', url: `/api/prospecting/briefs/${criado.id}/cancel`, body: {} },
  ]) {
    const resposta = await chamar(env, RAFAEL, requisicao);
    assert.equal(resposta.status, 403, `${requisicao.method} ${requisicao.url}`);
    assert.equal(resposta.json().error.code, 'FORBIDDEN');
  }
});

test('[BRIEF-API-3] fluxo completo: criar -> pronto -> gerar pacote -> ingerir achados -> AGUARDANDO_REVISAO com loteRealId, e o lote fica acessível em /api/prospecting/batches/:id', async (t) => {
  const env = ambiente(t);
  const brief = (await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/briefs', body: briefInput() })).json().item;

  const pronto = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${brief.id}/ready`, body: {} });
  assert.equal(pronto.status, 200);
  assert.equal(pronto.json().item.status, 'PRONTO_PARA_PESQUISA');

  const pacote = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${brief.id}/package`, body: {} });
  assert.equal(pacote.status, 200);
  assert.equal(pacote.json().item.status, 'PESQUISANDO');
  assert.equal(pacote.json().item.pacotePesquisa.nicho, 'Clínicas de estética');

  const ingest = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${brief.id}/findings`, body: { rawFindings: [achado('Clínica Fluxo Completo', 'fluxo-completo')] } });
  assert.equal(ingest.status, 200);
  assert.equal(ingest.json().brief.status, 'AGUARDANDO_REVISAO');
  const loteId = ingest.json().brief.loteRealId;
  assert.match(loteId, /^lote:/);

  const lote = await chamar(env, BRENO, { url: `/api/prospecting/batches/${encodeURIComponent(loteId)}` });
  assert.equal(lote.status, 200);
  assert.equal(lote.json().item.loteId, loteId);
  assert.equal(lote.json().item.resultados.some((r) => r.empresa === 'Clínica Fluxo Completo'), true);

  const listaLotes = await chamar(env, BRENO, { url: '/api/prospecting/batches' });
  assert.equal(listaLotes.status, 200);
  assert.equal(listaLotes.json().items.length, 1);
});

test('[BRIEF-API-4] erros: 404 (brief inexistente), 409 (ação fora do estado — gerar pacote em RASCUNHO), 400 (brief inválido, corpo de findings fora do formato)', async (t) => {
  const env = ambiente(t);
  assert.equal((await chamar(env, BRENO, { url: '/api/prospecting/briefs/PROS-20260101-999' })).status, 404);

  const brief = (await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/briefs', body: briefInput() })).json().item;
  const pacoteCedo = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${brief.id}/package`, body: {} });
  assert.equal(pacoteCedo.status, 409);
  assert.equal(pacoteCedo.json().error.code, 'BRIEF_INVALID_STATE');

  const invalido = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/briefs', body: { nicho: '' } });
  assert.equal(invalido.status, 400);
  assert.equal(invalido.json().error.code, 'BRIEF_INVALID_INPUT');

  const corpoErrado = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${brief.id}/findings`, body: { rawFindings: [], extra: 1 } });
  assert.equal(corpoErrado.status, 400);
});

test('[BRIEF-API-5] cancelar um brief (de qualquer estado não final); concluir só depois de AGUARDANDO_REVISAO', async (t) => {
  const env = ambiente(t);
  const brief = (await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/briefs', body: briefInput() })).json().item;

  const concluirCedo = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${brief.id}/conclude`, body: {} });
  assert.equal(concluirCedo.status, 409);

  const cancelado = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${brief.id}/cancel`, body: {} });
  assert.equal(cancelado.status, 200);
  assert.equal(cancelado.json().item.status, 'CANCELADO');
});

test('[BRIEF-API-6] sem prospectingBrief injetado, as rotas do Workbench não existem (404) — mesmo padrão de Funis/CRM opcionais', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true, prospeccao: true });
  const resposta = await chamar(env, BRENO, { url: '/api/prospecting/briefs' });
  assert.equal(resposta.status, 404);
});
