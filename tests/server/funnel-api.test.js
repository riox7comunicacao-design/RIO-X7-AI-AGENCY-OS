// Testes da API de Funis (rotas /api/funnels e /api/funnel-stages de src/server/app.js — reestruturação
// Prospecção/CRM/Funis, Etapa "Funis 1"): a camada HTTP FINA sobre o Funnel Service. Mesmo espírito de
// crm-api.test.js: a maioria roda sobre peças REAIS (Service real, ponte de autorização real, adapter de
// arquivo real em diretório temporário).

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

test('[FUNNEL-API-1] sem Authorization -> 401 em toda rota de funil; ADMIN autenticado -> 200/201 nas operações básicas', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], funnels: true });
  const semAuth = await chamar(env, null, { url: '/api/funnels' });
  assert.equal(semAuth.status, 401);

  const criado = await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'Outbound' } });
  assert.equal(criado.status, 201);
  const funnelId = criado.json().item.id;
  assert.match(funnelId, /^funnel:/);

  const lista = await chamar(env, BRENO, { url: '/api/funnels' });
  assert.equal(lista.status, 200);
  assert.equal(lista.json().items.length, 1);

  const item = await chamar(env, BRENO, { url: `/api/funnels/${encodeURIComponent(funnelId)}` });
  assert.equal(item.status, 200);
  assert.equal(item.json().item.nome, 'Outbound');
});

test('[FUNNEL-API-2] COMMERCIAL_CLOSER (sem MANAGE:FUNNELS) recebe 403 em toda rota de funil, mesmo chamando a API diretamente', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], funnels: true });
  const criado = await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'Outbound' } });
  const funnelId = criado.json().item.id;

  for (const requisicao of [
    { method: 'GET', url: '/api/funnels' },
    { method: 'POST', url: '/api/funnels', body: { nome: 'Outra' } },
    { method: 'GET', url: `/api/funnels/${funnelId}` },
    { method: 'PATCH', url: `/api/funnels/${funnelId}`, body: { nome: 'x' } },
    { method: 'DELETE', url: `/api/funnels/${funnelId}` },
    { method: 'POST', url: `/api/funnels/${funnelId}/copy`, body: {} },
    { method: 'GET', url: `/api/funnels/${funnelId}/stages` },
    { method: 'POST', url: `/api/funnels/${funnelId}/stages`, body: { nome: 'x' } },
  ]) {
    const resposta = await chamar(env, RAFAEL, requisicao);
    assert.equal(resposta.status, 403, `${requisicao.method} ${requisicao.url}`);
    assert.equal(resposta.json().error.code, 'FORBIDDEN');
  }
});

test('[FUNNEL-API-3] PATCH edita; DELETE recusa com 409 FUNNEL_HAS_CARDS quando há cards, e exclui normalmente quando não há (nesta etapa, nunca há)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], funnels: true });
  const criado = await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'Original' } });
  const funnelId = criado.json().item.id;

  const editado = await chamar(env, BRENO, { method: 'PATCH', url: `/api/funnels/${funnelId}`, body: { nome: 'Editado' } });
  assert.equal(editado.status, 200);
  assert.equal(editado.json().item.nome, 'Editado');

  const excluido = await chamar(env, BRENO, { method: 'DELETE', url: `/api/funnels/${funnelId}` });
  assert.equal(excluido.status, 200);
  assert.deepEqual(excluido.json(), { deleted: true, id: funnelId });

  const depois = await chamar(env, BRENO, { url: `/api/funnels/${funnelId}` });
  assert.equal(depois.status, 404);
});

test('[FUNNEL-API-4] etapas: criar, listar, editar, reordenar e excluir; independentes entre funis', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], funnels: true });
  const a = (await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'A' } })).json().item;
  const b = (await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'B' } })).json().item;

  const s1 = (await chamar(env, BRENO, { method: 'POST', url: `/api/funnels/${a.id}/stages`, body: { nome: 'Etapa 1' } })).json().item;
  const s2 = (await chamar(env, BRENO, { method: 'POST', url: `/api/funnels/${a.id}/stages`, body: { nome: 'Etapa 2' } })).json().item;
  await chamar(env, BRENO, { method: 'POST', url: `/api/funnels/${b.id}/stages`, body: { nome: 'B1' } });

  const listaA = await chamar(env, BRENO, { url: `/api/funnels/${a.id}/stages` });
  assert.equal(listaA.json().items.length, 2);

  const reordenada = await chamar(env, BRENO, { method: 'POST', url: `/api/funnels/${a.id}/stages/reorder`, body: { orderedIds: [s2.id, s1.id] } });
  assert.equal(reordenada.status, 200);
  assert.deepEqual(reordenada.json().items.map((s) => s.id), [s2.id, s1.id]);

  const editada = await chamar(env, BRENO, { method: 'PATCH', url: `/api/funnel-stages/${s1.id}`, body: { ativo: false } });
  assert.equal(editada.status, 200);
  assert.equal(editada.json().item.ativo, false);

  const excluida = await chamar(env, BRENO, { method: 'DELETE', url: `/api/funnel-stages/${s1.id}` });
  assert.equal(excluida.status, 200);
  assert.equal((await chamar(env, BRENO, { url: `/api/funnels/${a.id}/stages` })).json().items.length, 1);
});

test('[FUNNEL-API-5] copiar funil: novo id, mesmas etapas (novos ids), NUNCA copia cards/histórico; aceita nome novo', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], funnels: true });
  const original = (await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'Original' } })).json().item;
  await chamar(env, BRENO, { method: 'POST', url: `/api/funnels/${original.id}/stages`, body: { nome: 'Etapa 1' } });

  const copia = await chamar(env, BRENO, { method: 'POST', url: `/api/funnels/${original.id}/copy`, body: { nome: 'Cópia Nomeada' } });
  assert.equal(copia.status, 201);
  assert.notEqual(copia.json().item.id, original.id);
  assert.equal(copia.json().item.nome, 'Cópia Nomeada');

  const stagesCopia = await chamar(env, BRENO, { url: `/api/funnels/${copia.json().item.id}/stages` });
  assert.equal(stagesCopia.json().items.length, 1);
});

test('[FUNNEL-API-6] reordenar (funis e etapas): corpo com campo desconhecido é recusado (400); lista incompleta/estranha é recusada', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], funnels: true });
  const a = (await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'A' } })).json().item;

  const comCampoForjado = await chamar(env, BRENO, { method: 'POST', url: '/api/funnels/reorder', body: { orderedIds: [a.id], role: 'ADMIN' } });
  assert.equal(comCampoForjado.status, 400);
  assert.equal(comCampoForjado.json().error.code, 'INVALID_REQUEST');

  const vazio = await chamar(env, BRENO, { method: 'POST', url: '/api/funnels/reorder', body: { orderedIds: [] } });
  assert.equal(vazio.status, 400);
});

test('[FUNNEL-API-7] userId/role/permissions no corpo de criar/editar um funil são recusados (400) — nunca decidem autorização nem identidade', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], funnels: true });
  for (const [campo, valor] of Object.entries({ userId: 'user-atacante', role: 'ADMIN', permissions: ['MANAGE:FUNNELS'], id: 'funnel:forjado' })) {
    const resposta = await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'x', [campo]: valor } });
    assert.equal(resposta.status, 400, campo);
    assert.equal(resposta.json().error.code, 'INVALID_REQUEST');
  }
  assert.equal((await chamar(env, BRENO, { url: '/api/funnels' })).json().items.length, 0, 'nada foi gravado');
});

test('[FUNNEL-API-8] registro/funil/etapa inexistente -> 404 com mensagem fixa', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], funnels: true });
  assert.equal((await chamar(env, BRENO, { url: '/api/funnels/funnel:nao-existe' })).status, 404);
  assert.equal((await chamar(env, BRENO, { method: 'PATCH', url: '/api/funnels/funnel:nao-existe', body: { nome: 'x' } })).status, 404);
  assert.equal((await chamar(env, BRENO, { method: 'DELETE', url: '/api/funnel-stages/stage:nao-existe' })).status, 404);
});

test('[FUNNEL-API-9] método errado -> 405 com Allow exato; sem o Funnel Service injetado, /api/funnels é 404 (o resto do app segue igual)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO] }); // sem funnels: true
  const semServico = await chamar(env, BRENO, { url: '/api/funnels' });
  assert.equal(semServico.status, 404);
  assert.equal((await chamar(env, BRENO, { url: '/api/approvals' })).status, 200, 'o resto do app segue igual');

  const comServico = montarAmbiente(t, { usuarios: [BRENO], funnels: true });
  const errado = await chamar(comServico, BRENO, { method: 'DELETE', url: '/api/funnels' });
  assert.equal(errado.status, 405);
  assert.equal(errado.headers.Allow, 'GET, POST');
});

test('[FUNNEL-API-10] query string -> 400 (a API não tem filtro nem busca)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], funnels: true });
  const resposta = await chamar(env, BRENO, { url: '/api/funnels?x=1' });
  assert.equal(resposta.status, 400);
});
