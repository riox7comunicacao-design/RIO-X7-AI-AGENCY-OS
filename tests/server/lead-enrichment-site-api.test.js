// API do REVER SITE OFICIAL e as travas do COMPLETAR PESQUISA (Implementação 3.0.2, decisões finais): uma pesquisa por vez, um lead por chamada, nada em DNC, nunca altera a Approval Queue.
// Peças REAIS (fila, Service, perfil, autorização); motor e leitura de página FAKES. Nenhuma rede, nenhum `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const { montarAmbiente, BRENO, RAFAEL, EX_COLABORADOR } = require('./testEnv');

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
  return { chamadas, liberar: () => liberar(), enrich: async (pedido) => { chamadas.push(pedido); await portao; return { ok: true, custoUsd: 0.03, resultados: [{ nome: pedido.leads[0].nome }] }; } };
}
const montar = (t, motor) => montarAmbiente(t, { usuarios: [BRENO, RAFAEL, EX_COLABORADOR], crm: true, leadReconsideration: true, leadEnrichment: motor ? { enrichmentEngine: motor } : {} });
const completar = (id) => `/api/leads/${encodeURIComponent(id)}/completar-pesquisa`;
const reverSite = (id) => `/api/leads/${encodeURIComponent(id)}/rever-site`;

test('[SITEAPI-1] POST /rever-site: 202 na hora (REVISAO_SITE), uma pesquisa por vez (409 ENRICH_BUSY para outro lead, 409 para o mesmo), leitura do estado durante a revisão, site preservado sem comprovação, fila intacta', async (t) => {
  const motor = motorComPortao();
  const env = montar(t, motor);
  const { alfa, beta } = env.ids;
  const filaAntes = fs.readFileSync(env.filePath, 'utf8');

  const inicio = await chamar(env, BRENO, { method: 'POST', url: reverSite(alfa), body: {} });
  assert.equal(inicio.status, 202);
  assert.deepEqual([inicio.json().item.status, inicio.json().item.tipo], ['EM_ANDAMENTO', 'REVISAO_SITE']);

  const mesmo = await chamar(env, RAFAEL, { method: 'POST', url: reverSite(alfa), body: {} });
  assert.equal(mesmo.status, 409);
  assert.equal(mesmo.json().error.code, 'ENRICH_ALREADY_RUNNING');
  const outro = await chamar(env, BRENO, { method: 'POST', url: completar(beta), body: {} });
  assert.equal(outro.status, 409);
  assert.equal(outro.json().error.code, 'ENRICH_BUSY', 'sem paralelo nem lote: outro lead só depois');
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: reverSite(beta), body: {} })).json().error.code, 'ENRICH_BUSY');
  assert.equal(motor.chamadas.length, 1);

  const durante = (await chamar(env, BRENO, { url: completar(alfa) })).json().item;
  assert.deepEqual([durante.status, durante.tipo, durante.podeRever], ['EM_ANDAMENTO', 'REVISAO_SITE', false]);
  assert.equal((await chamar(env, BRENO, { url: `/api/leads/${encodeURIComponent(alfa)}/perfil` })).status, 200, 'o perfil continua legível');
  assert.equal((await chamar(env, BRENO, { url: completar(beta) })).json().item.podeCompletar, false, 'o outro lead também não pode enquanto uma pesquisa roda');

  motor.liberar();
  await env.leadEnrichmentService.waitFor(alfa);
  const depois = (await chamar(env, BRENO, { url: completar(alfa) })).json().item;
  assert.equal(depois.status, 'NAO_EXECUTADO', 'a revisão do site não mexe no estado da pesquisa geral');
  assert.equal(depois.revisaoSite.status, 'CONCLUIDA');
  assert.equal(depois.revisaoSite.ultimaRevisao.resultado, 'SEM_COMPROVACAO', 'sem leitura de página nem candidato não há prova: nada muda');
  assert.equal(depois.podeRever, true);
  const perfil = (await chamar(env, BRENO, { url: `/api/leads/${encodeURIComponent(alfa)}/perfil` })).json().item;
  assert.equal(perfil.siteOficial.status, 'ENCONTRADO', 'o site confirmado foi preservado');
  assert.equal(fs.readFileSync(env.filePath, 'utf8'), filaAntes, 'Approval Queue byte a byte igual');
});

test('[SITEAPI-2] DNC: 409 ENRICH_NOT_ALLOWED nas duas ações e o estado informa o bloqueio; nada é chamado', async (t) => {
  const motor = motorComPortao();
  const env = montar(t, motor);
  const dnc = env.ids.bloqueado;
  for (const url of [completar(dnc), reverSite(dnc)]) {
    const r = await chamar(env, BRENO, { method: 'POST', url, body: {} });
    assert.equal(r.status, 409, url);
    assert.equal(r.json().error.code, 'ENRICH_NOT_ALLOWED', url);
  }
  const status = (await chamar(env, BRENO, { url: completar(dnc) })).json().item;
  assert.deepEqual([status.bloqueio, status.podeCompletar, status.podeRever], ['DNC', false, false]);
  assert.equal(motor.chamadas.length, 0);
});

test('[SITEAPI-3] segurança dos endpoints: 401 sem login, 403 para conta inativa, 405 em método errado, 400 com corpo, 404 para lead inexistente, e NÃO existe rota de lote nem rota sem id', async (t) => {
  const motor = motorComPortao();
  const env = montar(t, motor);
  const { alfa } = env.ids;
  for (const [method, url] of [['GET', completar(alfa)], ['POST', completar(alfa)], ['POST', reverSite(alfa)]]) {
    assert.equal((await chamar(env, null, { method, url, body: method === 'POST' ? {} : undefined })).status, 401, `${method} ${url}`);
    assert.ok([401, 403].includes((await chamar(env, EX_COLABORADOR, { method, url, body: method === 'POST' ? {} : undefined })).status), 'conta inativa');
  }
  assert.equal((await chamar(env, BRENO, { url: reverSite(alfa) })).status, 405);
  assert.equal((await chamar(env, BRENO, { method: 'DELETE', url: reverSite(alfa) })).status, 405);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: reverSite(alfa), body: { ids: ['a', 'b'] } })).status, 400);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: reverSite('nao-existe'), body: {} })).status, 404);
  for (const url of ['/api/leads/completar-pesquisa', '/api/leads/rever-site', '/api/leads/lote/completar-pesquisa/extra', '/api/leads/completar-pesquisa/lote']) {
    const r = await chamar(env, BRENO, { method: 'POST', url, body: {} });
    assert.ok([404].includes(r.status), `${url} -> ${r.status}`);
  }
  assert.equal(motor.chamadas.length, 0, 'nenhuma entrada recusada disparou pesquisa');
  assert.equal(JSON.stringify((await chamar(env, BRENO, { url: completar(alfa) })).json()).includes('Bearer'), false);
});
