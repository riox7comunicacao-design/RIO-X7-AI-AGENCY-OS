'use strict';

// Fase 2B-3.2B — a ROTA de promoção (POST /api/approvals/:id/promote) com as Exclusões Permanentes: o contrato de erros que o Dashboard recebe,
// ponta a ponta sobre a composição de teste (app real, Services reais, fila e CRM em arquivos temporários, exclusões em memória). A
// verificação é do SERVIDOR: estes testes não usam botão nem validação do Dashboard. Dados fictícios; nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { mapErrorToHttp } = require('../../src/server/app');
const { PROMOTION_ERROR } = require('../../src/services/crmIntegrationService');
const { createProspectingExclusionService } = require('../../src/services/prospectingExclusionService');
const { createInMemoryPermanentExclusionRepository } = require('../../src/research-prospector/permanentExclusionRepository');
const { authorizeProspectingExclusionOperation } = require('../../src/auth');
const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

const MOTIVO_PRIVADO = 'MOTIVO-PRIVADO-DA-EXCLUSAO-api-77c1';

function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return req;
}
async function chamar(env, usuario, { method = 'GET', url, body } = {}) {
  const base = {};
  if (usuario) base.Authorization = `Bearer ${env.tokenFor(usuario.userId)}`;
  if (body !== undefined) base['content-type'] = 'application/json';
  const response = await env.app.handle(makeRequest({ method, url, headers: base, body }));
  return { status: response.status, text: response.body, json: () => JSON.parse(response.body) };
}
const promover = (env, usuario, id) => chamar(env, usuario, { method: 'POST', url: `/api/approvals/${encodeURIComponent(id)}/promote`, body: {} });
const aprovar = (env, usuario, id) => chamar(env, usuario, { method: 'POST', url: `/api/approvals/${encodeURIComponent(id)}/approve`, body: {} });
const excluir = (env, dados) => chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/exclusions', body: { motivo: MOTIVO_PRIVADO, ...dados } });
const registrosDoCrm = async (env) => (await chamar(env, BRENO, { url: '/api/crm' })).json().items;
const ambiente = (t, opcoes = {}) => montarAmbiente(t, { crm: true, integracao: true, prospectingExclusion: true, ...opcoes });

test('[EXCL-PROMO-API-1] exclusão confirmada: 409 PROMOTION_BLOCKED_EXCLUSION com a mensagem FIXA em português — sem o nome, o motivo nem o id da exclusão — e nenhum registro no CRM', async (t) => {
  const env = ambiente(t);
  const criada = await excluir(env, { empresa: 'Consultório Alfa' });
  assert.equal(criada.status, 201);
  assert.equal((await aprovar(env, RAFAEL, env.ids.alfa)).status, 200);

  const resposta = await promover(env, BRENO, env.ids.alfa);
  assert.equal(resposta.status, 409);
  const erro = resposta.json().error;
  assert.equal(erro.code, 'PROMOTION_BLOCKED_EXCLUSION');
  assert.equal(erro.message, 'Promoção bloqueada: esta empresa consta nas Exclusões Permanentes de Prospecção.');
  for (const privado of [MOTIVO_PRIVADO, criada.json().item.id, 'Consultório Alfa']) assert.equal(resposta.text.includes(privado), false, `a resposta não traz "${privado}"`);
  assert.deepEqual(await registrosDoCrm(env), []);
});

test('[EXCL-PROMO-API-2] exclusão cadastrada DEPOIS da aprovação (pela mesma API): bloqueia; desativada pela API, a mesma aprovação é promovida — 200 CRIADO', async (t) => {
  const env = ambiente(t);
  await aprovar(env, RAFAEL, env.ids.alfa);
  const criada = (await excluir(env, { empresa: 'consultorio alfa' })).json().item;
  assert.equal((await promover(env, BRENO, env.ids.alfa)).status, 409);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/exclusions/${criada.id}/deactivate`, body: {} })).status, 200);
  const liberada = await promover(env, BRENO, env.ids.alfa);
  assert.equal(liberada.status, 200);
  assert.equal(liberada.json().outcome, 'CRIADO');
  assert.deepEqual(Object.keys(liberada.json()).sort(), ['crmRecordId', 'outcome', 'possivelDuplicidade', 'prospectId'], 'o corpo de sucesso não mudou');
  assert.equal((await registrosDoCrm(env)).length, 1);
});

test('[EXCL-PROMO-API-3] consulta INDISPONÍVEL: 503 PROMOTION_EXCLUSION_CHECK_UNAVAILABLE com mensagem fixa e nada criado — o erro interno do repositório nunca chega ao cliente', async (t) => {
  const quebrado = createProspectingExclusionService({
    authorizeOperation: authorizeProspectingExclusionOperation,
    repository: { ...createInMemoryPermanentExclusionRepository(), list: () => { throw new Error('relation "prospecting_permanent_exclusions" does not exist — SEGREDO-INTERNO'); } },
  });
  const env = ambiente(t, { prospectingExclusionService: quebrado });
  await aprovar(env, RAFAEL, env.ids.alfa);
  const resposta = await promover(env, BRENO, env.ids.alfa);
  assert.equal(resposta.status, 503);
  assert.equal(resposta.json().error.code, 'PROMOTION_EXCLUSION_CHECK_UNAVAILABLE');
  assert.equal(resposta.json().error.message, 'Não foi possível verificar as Exclusões Permanentes agora. Por segurança a promoção foi bloqueada e nenhum registro foi criado. Tente novamente em instantes.');
  for (const interno of ['relation', 'prospecting_permanent_exclusions', 'SEGREDO-INTERNO', 'does not exist']) assert.equal(resposta.text.includes(interno), false, interno);
  assert.deepEqual(await registrosDoCrm(env), []);
});

test('[EXCL-PROMO-API-4] sem nenhuma exclusão: a promoção segue como sempre (200 CRIADO) — e o closer continua sem poder promover, com 403, SEM que a lista de exclusões seja consultada', async (t) => {
  let consultas = 0;
  const repositorio = createInMemoryPermanentExclusionRepository();
  const observado = { ...repositorio, list: () => ((consultas += 1), repositorio.list()) };
  const servico = createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository: observado });
  const env = ambiente(t, { prospectingExclusionService: servico });
  await aprovar(env, RAFAEL, env.ids.alfa);
  const negado = await promover(env, RAFAEL, env.ids.alfa);
  assert.equal(negado.status, 403, 'o closer não tem WRITE:CRM');
  assert.equal(consultas, 0, 'quem não pode promover não consegue sondar as exclusões');
  const ok = await promover(env, BRENO, env.ids.alfa);
  assert.equal(ok.status, 200);
  assert.equal(consultas, 1);
});

test('[EXCL-PROMO-API-5] MODO ARQUIVO (sem o serviço de exclusões, como em REPOSITORY_MODE=file): a rota funciona como sempre — o contrato de sucesso é o mesmo', async (t) => {
  const env = montarAmbiente(t, { crm: true, integracao: true });
  await aprovar(env, RAFAEL, env.ids.alfa);
  const resposta = await promover(env, BRENO, env.ids.alfa);
  assert.equal(resposta.status, 200);
  assert.equal(resposta.json().outcome, 'CRIADO');
});

test('[EXCL-PROMO-API-6] o catálogo HTTP cobre os quatro códigos novos com status e mensagem fixos, sem repassar o texto interno do erro', () => {
  const esperado = {
    PROMOTION_BLOCKED_EXCLUSION: [409, /Exclusões Permanentes de Prospecção/],
    PROMOTION_EXCLUSION_AMBIGUOUS: [409, /revisão humana/],
    PROMOTION_EXCLUSION_IDENTITY_INSUFFICIENT: [409, /dados suficientes/],
    PROMOTION_EXCLUSION_CHECK_UNAVAILABLE: [503, /nenhum registro foi criado/],
  };
  assert.deepEqual(Object.keys(esperado).sort(), Object.values(PROMOTION_ERROR).filter((c) => /EXCLUSION/.test(c)).sort());
  for (const [code, [status, mensagem]] of Object.entries(esperado)) {
    const falha = mapErrorToHttp(Object.assign(new Error('Promoção: texto interno com site.example.test e MOTIVO-PRIVADO'), { code }));
    assert.equal(falha.status, status, code);
    assert.equal(falha.code, code);
    assert.match(falha.message, mensagem, code);
    assert.equal(/texto interno|MOTIVO-PRIVADO|example\.test/.test(falha.message), false, code);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Auditoria final (pré-checkpoint): o que o Dashboard mostra e os leitores do histórico
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-PROMO-API-7] o Dashboard (sem nenhuma mudança) mostra a mensagem FIXA dos três 409 de exclusão e a mensagem genérica e segura do 503 — nada interno, e a decisão continua sendo do servidor', async () => {
  const { ApiError } = await import('../../dashboard/api.mjs');
  const { promotionMessageForError } = await import('../../dashboard/views/approvals.mjs');
  const do409 = {
    PROMOTION_BLOCKED_EXCLUSION: 'Promoção bloqueada: esta empresa consta nas Exclusões Permanentes de Prospecção.',
    PROMOTION_EXCLUSION_AMBIGUOUS: 'Promoção suspensa: há uma Exclusão Permanente com o mesmo nome e a localização deste prospect não permite confirmar se é a mesma empresa. É necessária uma revisão humana.',
    PROMOTION_EXCLUSION_IDENTITY_INSUFFICIENT: 'Promoção bloqueada: este prospect não tem dados suficientes para conferir as Exclusões Permanentes.',
  };
  for (const [code, texto] of Object.entries(do409)) assert.equal(promotionMessageForError(new ApiError(409, code, texto)), texto, code);
  const indisponivel = promotionMessageForError(new ApiError(503, 'PROMOTION_EXCLUSION_CHECK_UNAVAILABLE', 'Não foi possível verificar as Exclusões Permanentes agora. Por segurança a promoção foi bloqueada e nenhum registro foi criado. Tente novamente em instantes.'));
  assert.equal(indisponivel, 'Não foi possível concluir a operação agora. Tente novamente em instantes.');
  assert.equal(promotionMessageForError(new ApiError(409, 'OUTRO', 'texto interno /caminho/segredo')), 'A promoção foi bloqueada.', 'um 409 que não é de promoção não repassa o texto');
});

test('[EXCL-PROMO-API-8] os leitores existentes da fila (API de Aprovações) leem o histórico com as linhas novas: uma só linha de bloqueio com o contador, o item continua aprovado e a aprovação humana está intacta', async (t) => {
  const env = ambiente(t);
  await aprovar(env, RAFAEL, env.ids.alfa);
  const antes = (await chamar(env, BRENO, { url: '/api/approvals?estado=APROVADO_PARA_CRM' })).json().items.find((i) => i.prospectId === env.ids.alfa);
  await excluir(env, { empresa: 'Consultório Alfa' });
  for (let i = 0; i < 3; i += 1) assert.equal((await promover(env, BRENO, env.ids.alfa)).status, 409);
  const depois = (await chamar(env, BRENO, { url: '/api/approvals?estado=APROVADO_PARA_CRM' })).json().items.find((i) => i.prospectId === env.ids.alfa);
  assert.equal(depois.estado, 'APROVADO_PARA_CRM');
  assert.equal(depois.promocao, undefined);
  assert.deepEqual(depois.discoverySnapshot, antes.discoverySnapshot, 'o snapshot aprovado não mudou');
  assert.deepEqual(depois.historico.slice(0, antes.historico.length), antes.historico, 'a aprovação humana e todo o histórico anterior estão intactos');
  const novas = depois.historico.slice(antes.historico.length);
  assert.equal(novas.length, 1, 'três tentativas, uma linha');
  assert.equal(novas[0].promocao.tentativas, 3);
  assert.match(novas[0].motivo, /\(3 tentativas\)$/);
  assert.equal(JSON.stringify(novas).includes(MOTIVO_PRIVADO), false);
  // depois de desativar a exclusão a MESMA aprovação é promovida: o leitor da promoção (findApproval) segue achando a aprovação humana
  const exclusao = (await chamar(env, BRENO, { url: '/api/prospecting/exclusions' })).json().items[0];
  await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/exclusions/${exclusao.id}/deactivate`, body: {} });
  assert.equal((await promover(env, BRENO, env.ids.alfa)).status, 200);
});

test('[EXCL-PROMO-API-9] pela rota: a identidade AMBÍGUA e os DADOS INSUFICIENTES respondem 409 com os seus próprios códigos e mensagens fixas — nunca o código da exclusão confirmada — e nada é criado', async (t) => {
  const fs = require('node:fs');
  const { novaFila } = require('./testEnv');
  const fila = novaFila(t);
  const conteudo = JSON.parse(fs.readFileSync(fila.filePath, 'utf8'));
  conteudo.items[fila.ids.beta].discoverySnapshot.cidade = null; // sem geografia: ambíguo contra uma exclusão que a exige
  conteudo.items[fila.ids.beta].discoverySnapshot.estadoUf = null;
  conteudo.items[fila.ids.alfa].empresa = '!!!'; // sem um nome verificável
  conteudo.items[fila.ids.alfa].discoverySnapshot.empresa = '!!!';
  fs.writeFileSync(fila.filePath, JSON.stringify(conteudo, null, 2), 'utf8');

  const env = ambiente(t, { queue: fila });
  await aprovar(env, RAFAEL, env.ids.alfa);
  await aprovar(env, RAFAEL, env.ids.beta);
  const criada = await excluir(env, { empresa: 'Consultório Beta', cidade: 'Petrópolis', estado: 'RJ' });
  assert.equal(criada.status, 201);

  const ambigua = await promover(env, BRENO, env.ids.beta);
  assert.equal(ambigua.status, 409);
  assert.equal(ambigua.json().error.code, 'PROMOTION_EXCLUSION_AMBIGUOUS');
  assert.match(ambigua.json().error.message, /revisão humana/);

  const insuficiente = await promover(env, BRENO, env.ids.alfa);
  assert.equal(insuficiente.status, 409);
  assert.equal(insuficiente.json().error.code, 'PROMOTION_EXCLUSION_IDENTITY_INSUFFICIENT');
  assert.match(insuficiente.json().error.message, /dados suficientes/);

  for (const resposta of [ambigua, insuficiente]) {
    for (const privado of [MOTIVO_PRIVADO, criada.json().item.id, 'Consultório Beta', 'Petrópolis']) assert.equal(resposta.text.includes(privado), false, `a resposta não traz "${privado}"`);
  }
  assert.deepEqual(await registrosDoCrm(env), []);
  // a revisão humana: o ADMIN desativa a exclusão e o ambíguo é promovido (o sem-nome continua bloqueado: dados da fila, não da exclusão)
  await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/exclusions/${criada.json().item.id}/deactivate`, body: {} });
  assert.equal((await promover(env, BRENO, env.ids.beta)).status, 200);
  assert.equal((await promover(env, BRENO, env.ids.alfa)).json().error.code, 'PROMOTION_EXCLUSION_IDENTITY_INSUFFICIENT');
});
