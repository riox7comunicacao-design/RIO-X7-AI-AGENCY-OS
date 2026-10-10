// API do COMPLETAR PESQUISA (rotas /api/leads/:id/completar-pesquisa de src/server/app.js — Implementação 3.0.2). Peças REAIS (fila, Service de enriquecimento, perfil, ponte de autorização) em
// diretório temporário; o motor de enriquecimento e a leitura de página são FAKES. Nenhuma rede, nenhum `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return req;
}
async function chamar(env, usuario, { method = 'GET', url, body } = {}) {
  const headers = {};
  if (usuario) headers.Authorization = `Bearer ${env.tokenFor(usuario.userId)}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await env.app.handle(makeRequest({ method, url, headers, body }));
  return { status: response.status, text: response.body, json: () => JSON.parse(response.body) };
}

function motorComPortao() {
  const chamadas = [];
  let liberar = () => {};
  const portao = new Promise((resolve) => { liberar = resolve; });
  return { chamadas, liberar: () => liberar(), enrich: async (pedido) => { chamadas.push(pedido); await portao; return { ok: true, custoUsd: 0.07, resultados: [{ nome: pedido.leads[0].nome, emails: [{ email: 'contato@clinica-alfa.com.br', origem: 'https://clinica-alfa.example.test/contato' }] }] }; } };
}
const ambiente = (t, enrichmentEngine) => montar(t, enrichmentEngine);
const montar = (t, enrichmentEngine) => montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, leadReconsideration: true, leadEnrichment: enrichmentEngine === undefined ? {} : { enrichmentEngine } });
const url = (id) => `/api/leads/${encodeURIComponent(id)}/completar-pesquisa`;

test('[ENRICHAPI-1] fluxo HTTP: GET estado -> POST inicia (202, EM_ANDAMENTO) -> segunda tentativa 409 -> GET durante a pesquisa -> INCOMPLETO (só e-mail achado, o resto NÃO VERIFICADO) com custo e fontes; a fila NÃO muda', async (t) => {
  const motor = motorComPortao();
  const env = ambiente(t, motor);
  const id = env.ids.alfa;
  const filaAntes = fs.readFileSync(env.filePath, 'utf8');

  const antes = await chamar(env, BRENO, { url: url(id) });
  assert.equal(antes.status, 200);
  assert.deepEqual([antes.json().item.status, antes.json().item.podeCompletar, antes.json().item.disponivel], ['NAO_EXECUTADO', true, true]);
  assert.ok(antes.json().item.camposPendentes.includes('emails'));

  const inicio = await chamar(env, BRENO, { method: 'POST', url: url(id), body: {} });
  assert.equal(inicio.status, 202);
  assert.equal(inicio.json().item.status, 'EM_ANDAMENTO');

  const segunda = await chamar(env, RAFAEL, { method: 'POST', url: url(id), body: {} });
  assert.equal(segunda.status, 409);
  assert.equal(segunda.json().error.code, 'ENRICH_ALREADY_RUNNING');
  assert.equal(motor.chamadas.length, 1, 'a segunda tentativa não disparou outra pesquisa');

  const durante = await chamar(env, BRENO, { url: url(id) });
  assert.equal(durante.json().item.status, 'EM_ANDAMENTO');
  assert.equal(durante.json().item.podeCompletar, false);
  const perfilDuranteALeitura = await chamar(env, BRENO, { url: `/api/leads/${encodeURIComponent(id)}/perfil` });
  assert.equal(perfilDuranteALeitura.status, 200, 'o perfil continua legível durante a pesquisa');

  motor.liberar();
  await env.leadEnrichmentService.waitFor(id);
  const depois = (await chamar(env, BRENO, { url: url(id) })).json().item;
  assert.equal(depois.status, 'INCOMPLETO', 'uma execução sem erro NÃO é uma pesquisa completa: os campos omitidos seguem NÃO VERIFICADOS');
  assert.equal(depois.podeCompletar, true);
  assert.equal(depois.resolucao.emails.status, 'ENCONTRADO');
  assert.equal(depois.resolucao.atividadeRecente.status, 'NAO_VERIFICADO');
  assert.equal(depois.custoUsd, 0.07);
  assert.ok(depois.ultimaExecucao.fontes.includes('https://clinica-alfa.example.test/contato'));
  const perfil = (await chamar(env, BRENO, { url: `/api/leads/${encodeURIComponent(id)}/perfil` })).json().item;
  assert.deepEqual(perfil.emails.map((e) => e.email), ['contato@clinica-alfa.com.br']);
  assert.equal(perfil.enriquecimento.status, 'INCOMPLETO');
  assert.equal(fs.readFileSync(env.filePath, 'utf8'), filaAntes, 'a Approval Queue ficou byte a byte igual');
});

test('[ENRICHAPI-2] erros estáveis: sem login 401; lead inexistente 404; corpo com campo 400; método errado 405; Claude indisponível (sem motor) 503; sem o Service as rotas não existem 404', async (t) => {
  const env = ambiente(t, motorComPortao());
  assert.equal((await chamar(env, null, { url: url(env.ids.alfa) })).status, 401);
  const inexistente = await chamar(env, BRENO, { url: url('nao-existe') });
  assert.equal(inexistente.status, 404);
  assert.equal(inexistente.json().error.code, 'ENRICH_NOT_FOUND');
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: url(env.ids.alfa), body: { resolucao: ['x'] } })).status, 400);
  assert.equal((await chamar(env, BRENO, { method: 'DELETE', url: url(env.ids.alfa) })).status, 405);

  const semMotor = ambiente(t);
  const indisponivel = await chamar(semMotor, BRENO, { method: 'POST', url: url(semMotor.ids.alfa), body: {} });
  assert.equal(indisponivel.status, 503);
  assert.equal(indisponivel.json().error.code, 'ENRICH_UNAVAILABLE');
  assert.equal((await chamar(semMotor, BRENO, { url: url(semMotor.ids.alfa) })).json().item.disponivel, false);

  const semServico = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  assert.equal((await chamar(semServico, BRENO, { url: url(semServico.ids.alfa) })).status, 404);
});
