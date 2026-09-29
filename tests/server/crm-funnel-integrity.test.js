// Integridade CRM ↔ Card (Etapa "Funis 2 — correção final") — teste de PONTA A PONTA, pela API real: DELETE
// /api/crm/:id (decisão 0025) recusa excluir um registro que ainda tenha Cards ATIVOS (removedAt ausente) em
// QUALQUER funil; um Card ARQUIVADO nunca bloqueia. Sobre a composição REAL de testEnv.js (montarAmbiente com
// `crm: true, funnels: true`) — o MESMO caminho que src/server/index.js usa em produção
// (createFileBackedActiveFunnelCardsChecker), nunca um double da checagem.
//
// Os 8 casos abaixo são exatamente os da "FUNIS 2 — CORREÇÃO FINAL DE INTEGRIDADE CRM ↔ CARD" (seção 6).

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

const rota = (id) => `/api/crm/${encodeURIComponent(id)}`;

async function criarRegistro(env, usuario, empresa = 'Clínica Teste') {
  return (await chamar(env, usuario, { method: 'POST', url: '/api/crm', body: { empresa } })).json().item;
}

async function criarFunilComEtapa(env, usuario, nome = 'Outbound') {
  const funnel = (await chamar(env, usuario, { method: 'POST', url: '/api/funnels', body: { nome } })).json().item;
  const etapa = (await chamar(env, usuario, { method: 'POST', url: `/api/funnels/${funnel.id}/stages`, body: { nome: 'Etapa 1' } })).json().item;
  return { funnel, etapa };
}

async function criarCard(env, usuario, funnelId, crmRecordId) {
  const resposta = await chamar(env, usuario, { method: 'POST', url: `/api/funnels/${funnelId}/cards`, body: { crmRecordId } });
  assert.equal(resposta.status, 201, 'sanidade: o card deveria ter sido criado');
  return resposta.json().item;
}

async function arquivarCard(env, usuario, cardId) {
  const resposta = await chamar(env, usuario, { method: 'DELETE', url: `/api/funnel-cards/${cardId}` });
  assert.equal(resposta.status, 200, 'sanidade: o card deveria ter sido arquivado');
  return resposta.json();
}

const excluir = (env, usuario, id, reason = 'motivo de teste') => chamar(env, usuario, { method: 'DELETE', url: rota(id), body: { reason } });

const MENSAGEM_BLOQUEIO = 'Este registro não pode ser excluído enquanto possuir Cards ativos em funis. Arquive os Cards primeiro.';

test('[CRM-FUNNEL-INTEGRITY-1] CASO 1 — CRM sem nenhum Card: DELETE /api/crm/:id funciona normalmente (200), e o registro realmente some', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true, funnels: true });
  const registro = await criarRegistro(env, BRENO, 'Sem Cards Ltda');

  const resposta = await excluir(env, BRENO, registro.id);
  assert.equal(resposta.status, 200);
  assert.deepEqual(resposta.json(), { deleted: true, id: registro.id });

  const depois = await chamar(env, BRENO, { url: rota(registro.id) });
  assert.equal(depois.status, 404);
});

test('[CRM-FUNNEL-INTEGRITY-2] CASO 2 — CRM com 1 Card ATIVO: DELETE é bloqueado (409 CRM_HAS_ACTIVE_FUNNEL_CARDS, mensagem fixa); o CRM e o Card continuam existindo depois da tentativa', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true, funnels: true });
  const registro = await criarRegistro(env, BRENO, 'Com Um Card Ativo');
  const { funnel } = await criarFunilComEtapa(env, BRENO);
  const card = await criarCard(env, BRENO, funnel.id, registro.id);

  const bloqueado = await excluir(env, BRENO, registro.id);
  assert.equal(bloqueado.status, 409);
  assert.equal(bloqueado.json().error.code, 'CRM_HAS_ACTIVE_FUNNEL_CARDS');
  assert.equal(bloqueado.json().error.message, MENSAGEM_BLOQUEIO);

  const registroDepois = await chamar(env, BRENO, { url: rota(registro.id) });
  assert.equal(registroDepois.status, 200, 'o registro do CRM continua existindo');
  assert.equal(registroDepois.json().item.empresa, 'Com Um Card Ativo');

  const cardDepois = await chamar(env, BRENO, { url: `/api/funnel-cards/${card.id}` });
  assert.equal(cardDepois.status, 200, 'o card continua existindo, sem nenhuma alteração');
  assert.equal(cardDepois.json().item.removedAt, null);
});

test('[CRM-FUNNEL-INTEGRITY-3] CASO 3 — CRM com Cards ativos em VÁRIOS funis (o mesmo registro comercial em dois funis diferentes, ao mesmo tempo — seção 3 da Etapa "Funis 2"): DELETE continua bloqueado (409)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true, funnels: true });
  const registro = await criarRegistro(env, BRENO, 'Em Dois Funis');
  const { funnel: outbound } = await criarFunilComEtapa(env, BRENO, 'Outbound');
  const { funnel: renovacao } = await criarFunilComEtapa(env, BRENO, 'Renovação');
  await criarCard(env, BRENO, outbound.id, registro.id);
  await criarCard(env, BRENO, renovacao.id, registro.id);

  const bloqueado = await excluir(env, BRENO, registro.id);
  assert.equal(bloqueado.status, 409);
  assert.equal(bloqueado.json().error.code, 'CRM_HAS_ACTIVE_FUNNEL_CARDS');
});

test('[CRM-FUNNEL-INTEGRITY-4] CASO 4 — CRM só com Cards ARQUIVADOS: DELETE volta a ser permitido (200)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true, funnels: true });
  const registro = await criarRegistro(env, BRENO, 'Só Arquivados');
  const { funnel } = await criarFunilComEtapa(env, BRENO);
  const card = await criarCard(env, BRENO, funnel.id, registro.id);
  await arquivarCard(env, BRENO, card.id);

  const resposta = await excluir(env, BRENO, registro.id);
  assert.equal(resposta.status, 200);
  assert.deepEqual(resposta.json(), { deleted: true, id: registro.id });
});

test('[CRM-FUNNEL-INTEGRITY-5] CASO 5 — CRM com Cards ativos E arquivados ao mesmo tempo: DELETE continua bloqueado pelo(s) ativo(s)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true, funnels: true });
  const registro = await criarRegistro(env, BRENO, 'Ativo e Arquivado');
  const { funnel: a } = await criarFunilComEtapa(env, BRENO, 'Funil A');
  const { funnel: b } = await criarFunilComEtapa(env, BRENO, 'Funil B');
  const cardArquivado = await criarCard(env, BRENO, a.id, registro.id);
  await arquivarCard(env, BRENO, cardArquivado.id);
  await criarCard(env, BRENO, b.id, registro.id); // este fica ativo

  const bloqueado = await excluir(env, BRENO, registro.id);
  assert.equal(bloqueado.status, 409);
  assert.equal(bloqueado.json().error.code, 'CRM_HAS_ACTIVE_FUNNEL_CARDS');
});

test('[CRM-FUNNEL-INTEGRITY-6] CASO 6 — COMMERCIAL_CLOSER (sem DELETE:CRM) tentando excluir: 403, independentemente de o registro ter Cards ativos ou não', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, funnels: true });
  const semCards = await criarRegistro(env, BRENO, 'Closer, Sem Cards');
  const recusa1 = await excluir(env, RAFAEL, semCards.id);
  assert.equal(recusa1.status, 403);
  assert.equal(recusa1.json().error.code, 'FORBIDDEN');

  const comCards = await criarRegistro(env, BRENO, 'Closer, Com Cards');
  const { funnel } = await criarFunilComEtapa(env, BRENO);
  await criarCard(env, BRENO, funnel.id, comCards.id);
  const recusa2 = await excluir(env, RAFAEL, comCards.id);
  assert.equal(recusa2.status, 403);
  assert.equal(recusa2.json().error.code, 'FORBIDDEN', 'a recusa é de AUTORIZAÇÃO, nunca CRM_HAS_ACTIVE_FUNNEL_CARDS, para quem não tem DELETE:CRM');

  // sanidade: os dois registros continuam intactos — nada foi tocado pela tentativa recusada.
  assert.equal((await chamar(env, BRENO, { url: rota(semCards.id) })).status, 200);
  assert.equal((await chamar(env, BRENO, { url: rota(comCards.id) })).status, 200);
});

test('[CRM-FUNNEL-INTEGRITY-7] CASO 7 — arquivar um Card: removedAt preenchido, some da listagem ativa do Kanban (GET /api/funnels/:id/cards), mas o histórico de movimentação continua acessível por inteiro', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true, funnels: true });
  const registro = await criarRegistro(env, BRENO, 'Card A Arquivar');
  const { funnel } = await criarFunilComEtapa(env, BRENO);
  const card = await criarCard(env, BRENO, funnel.id, registro.id);

  const antes = await chamar(env, BRENO, { url: `/api/funnels/${funnel.id}/cards` });
  assert.equal(antes.json().items.length, 1, 'o card aparece no Kanban ativo antes de arquivar');

  await arquivarCard(env, BRENO, card.id);

  const detalhe = await chamar(env, BRENO, { url: `/api/funnel-cards/${card.id}` });
  assert.equal(detalhe.status, 200, 'a linha do card continua existindo (arquivamento, nunca exclusão física)');
  assert.notEqual(detalhe.json().item.removedAt, null, 'removedAt foi preenchido');

  const depois = await chamar(env, BRENO, { url: `/api/funnels/${funnel.id}/cards` });
  assert.deepEqual(depois.json().items, [], 'some do Kanban ativo');

  const historico = await chamar(env, BRENO, { url: `/api/funnel-cards/${card.id}/history` });
  assert.equal(historico.status, 200);
  assert.equal(historico.json().historico.length, 1, 'a criação continua no histórico — arquivar não apaga nada');
});

test('[CRM-FUNNEL-INTEGRITY-8] CASO 8 — depois de arquivar o ÚLTIMO Card ativo de um registro, a exclusão do CRM passa a ser permitida', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true, funnels: true });
  const registro = await criarRegistro(env, BRENO, 'Último Card');
  const { funnel } = await criarFunilComEtapa(env, BRENO);
  const card = await criarCard(env, BRENO, funnel.id, registro.id);

  const bloqueado = await excluir(env, BRENO, registro.id);
  assert.equal(bloqueado.status, 409, 'sanidade: ainda bloqueado com o card ativo');

  await arquivarCard(env, BRENO, card.id);

  const permitido = await excluir(env, BRENO, registro.id);
  assert.equal(permitido.status, 200);
  assert.deepEqual(permitido.json(), { deleted: true, id: registro.id });
});
