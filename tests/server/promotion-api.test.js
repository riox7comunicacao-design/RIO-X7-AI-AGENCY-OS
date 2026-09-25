// Testes da rota de promoção Approval Queue -> CRM (POST /api/approvals/:id/promote de src/server/app.js — decisão 0016):
// a camada HTTP FINA sobre promoteProspect().
//
// O que estes testes protegem: a rota autentica pelo fluxo que já existe (Bearer -> verifyAccessToken real, contra um
// Supabase falso só na borda de rede -> AuthorizationContext) e entrega ao serviço de promoção SÓ o contexto e o id do
// prospect (o da URL). Nada que o navegador manda — corpo, query, cabeçalho — decide a promoção; a autorização e a
// aprovação humana são consultadas pelos Services sobre a fila REAL; e os erros viram HTTP com mensagem FIXA.
//
// A maioria roda sobre peças REAIS (fila, CRM, Services, ponte de autorização, em arquivos temporários). Os testes que
// provam a DELEGAÇÃO e o 500 usam um double do serviço. Nenhum dado real: tudo fictício (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { createApp, mapErrorToHttp } = require('../../src/server/app');
const { createFileBackedCrmIntegrationService } = require('../../src/services/crmIntegrationFileService');
const { authorizeReviewerForApprovalQueue, authorizeCrmOperation } = require('../../src/auth');
const { PROMOTION_ERROR } = require('../../src/services/crmIntegrationService');
const { isIssuedAuthorizationContext } = require('../helpers/authFixtures');
const { montarAmbiente, BRENO, RAFAEL, EX_COLABORADOR } = require('./testEnv');

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

const rotaPromover = (id) => `/api/approvals/${encodeURIComponent(id)}/promote`;
const promover = (env, usuario, id, extra = {}) => chamar(env, usuario, { method: 'POST', url: rotaPromover(id), body: {}, ...extra });
const aprovar = (env, usuario, id) => chamar(env, usuario, { method: 'POST', url: `/api/approvals/${encodeURIComponent(id)}/approve`, body: {} });
const rejeitar = (env, usuario, id) => chamar(env, usuario, { method: 'POST', url: `/api/approvals/${encodeURIComponent(id)}/reject`, body: { reason: 'Sem fit' } });

const ambiente = (t, opcoes = {}) => montarAmbiente(t, { crm: true, integracao: true, ...opcoes });
const registrosDoCrm = async (env) => (await chamar(env, BRENO, { url: '/api/crm' })).json().items;
const itemDaFila = async (env, estado, id) => (await chamar(env, BRENO, { url: `/api/approvals?estado=${estado}` })).json().items.find((item) => item.prospectId === id);

const ERRO_INTERNO = 'Erro interno. Tente novamente em instantes.';

test('[PROMO-API-1] sem autenticação: 401 e nada é criado; o serviço nem é chamado', async (t) => {
  const env = ambiente(t);
  await aprovar(env, RAFAEL, env.ids.alfa);
  const semToken = await promover(env, null, env.ids.alfa);
  assert.equal(semToken.status, 401);
  const tokenLixo = await promover(env, null, env.ids.alfa, { headers: { Authorization: 'Bearer token-invalido' } });
  assert.equal(tokenLixo.status, 401);
  assert.deepEqual(await registrosDoCrm(env), []);
});

test('[PROMO-API-2] o ADMIN promove um prospect aprovado: 200, CRIADO, o id do registro, e o registro existe no CRM', async (t) => {
  const env = ambiente(t);
  assert.equal((await aprovar(env, RAFAEL, env.ids.alfa)).status, 200);
  const resposta = await promover(env, BRENO, env.ids.alfa);
  assert.equal(resposta.status, 200);
  const corpo = resposta.json();
  assert.deepEqual(Object.keys(corpo).sort(), ['crmRecordId', 'outcome', 'possivelDuplicidade', 'prospectId']);
  assert.equal(corpo.outcome, 'CRIADO');
  assert.equal(corpo.prospectId, env.ids.alfa);
  assert.equal(corpo.possivelDuplicidade, false);
  assert.match(corpo.crmRecordId, /^crm:/);

  const noCrm = await chamar(env, BRENO, { url: `/api/crm/${encodeURIComponent(corpo.crmRecordId)}` });
  assert.equal(noCrm.status, 200);
  assert.equal(noCrm.json().item.empresa, 'Consultório Alfa');
  assert.equal((await registrosDoCrm(env)).length, 1);
});

test('[PROMO-API-3] a promoção não muda o estado da fila (continua APROVADO_PARA_CRM) e deixa a auditoria em item.promocao', async (t) => {
  const env = ambiente(t);
  await aprovar(env, RAFAEL, env.ids.alfa);
  const { crmRecordId } = (await promover(env, BRENO, env.ids.alfa)).json();
  const item = await itemDaFila(env, 'APROVADO_PARA_CRM', env.ids.alfa);
  assert.equal(item.estado, 'APROVADO_PARA_CRM');
  assert.equal(item.promocao.crmRecordId, crmRecordId);
  assert.equal(item.promocao.promovidoPor.userId, BRENO.userId, 'quem promoveu vem do token, não do corpo');
});

test('[PROMO-API-4] repetir a promoção: 200 JA_PROMOVIDO com o MESMO id, e nenhum registro novo', async (t) => {
  const env = ambiente(t);
  await aprovar(env, RAFAEL, env.ids.alfa);
  const primeira = (await promover(env, BRENO, env.ids.alfa)).json();
  const segunda = await promover(env, BRENO, env.ids.alfa);
  assert.equal(segunda.status, 200);
  assert.equal(segunda.json().outcome, 'JA_PROMOVIDO');
  assert.equal(segunda.json().crmRecordId, primeira.crmRecordId);
  assert.equal((await registrosDoCrm(env)).length, 1);
});

test('[PROMO-API-5] duplo clique (duas requisições ao mesmo tempo): um único registro no CRM', async (t) => {
  const env = ambiente(t);
  await aprovar(env, RAFAEL, env.ids.alfa);
  const [a, b] = await Promise.all([promover(env, BRENO, env.ids.alfa), promover(env, BRENO, env.ids.alfa)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual([a.json().outcome, b.json().outcome].sort(), ['CRIADO', 'JA_PROMOVIDO']);
  assert.equal(a.json().crmRecordId, b.json().crmRecordId);
  assert.equal((await registrosDoCrm(env)).length, 1);
});

test('[PROMO-API-6] o closer (sem WRITE:CRM) recebe 403 com a mensagem fixa e nada é criado — mesmo com o item aprovado', async (t) => {
  const env = ambiente(t);
  await aprovar(env, RAFAEL, env.ids.alfa);
  const resposta = await promover(env, RAFAEL, env.ids.alfa);
  assert.equal(resposta.status, 403);
  assert.deepEqual(resposta.json(), { error: { code: 'FORBIDDEN', message: 'Esta conta não possui acesso a esta área.' } });
  assert.deepEqual(await registrosDoCrm(env), []);
  assert.equal((await itemDaFila(env, 'APROVADO_PARA_CRM', env.ids.alfa)).promocao, undefined);
});

test('[PROMO-API-7] usuário inativo e usuário desconhecido: 403', async (t) => {
  const env = ambiente(t, { usuarios: [BRENO, RAFAEL, EX_COLABORADOR] });
  await aprovar(env, RAFAEL, env.ids.alfa);
  assert.equal((await promover(env, EX_COLABORADOR, env.ids.alfa)).status, 403);
  assert.deepEqual(await registrosDoCrm(env), []);
});

test('[PROMO-API-8] pendente, rejeitado e bloqueado (DNC) nunca são promovidos: 409 com mensagem fixa', async (t) => {
  const env = ambiente(t);
  await rejeitar(env, RAFAEL, env.ids.beta);
  for (const id of [env.ids.alfa, env.ids.beta, env.ids.bloqueado]) {
    const resposta = await promover(env, BRENO, id);
    assert.equal(resposta.status, 409, id);
    assert.deepEqual(resposta.json(), { error: { code: 'PROMOTION_NOT_APPROVED', message: 'Este prospect não está aprovado para o CRM.' } });
  }
  assert.deepEqual(await registrosDoCrm(env), []);
});

test('[PROMO-API-9] duplicidade no CRM: 409 claro, sem criar nada e sem vazar o outro registro', async (t) => {
  const env = ambiente(t);
  const existente = await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { empresa: 'Outra Empresa', site: 'consultorio-alfa.example.test' } });
  assert.equal(existente.status, 201);
  await aprovar(env, RAFAEL, env.ids.alfa);
  const resposta = await promover(env, BRENO, env.ids.alfa);
  assert.equal(resposta.status, 409);
  assert.equal(resposta.json().error.code, 'PROMOTION_BLOCKED_DUPLICATE');
  assert.equal(resposta.json().error.message, 'Este prospect parece já existir no CRM. A promoção foi bloqueada para não duplicar o registro.');
  assert.equal(resposta.text.includes(existente.json().item.id), false);
  assert.equal((await registrosDoCrm(env)).length, 1);
});

test('[PROMO-API-10] DNC no CRM: 409 dizendo que a promoção foi bloqueada por restrição de contato; nada é criado', async (t) => {
  const env = ambiente(t);
  const existente = await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { empresa: 'Bloqueada', site: 'consultorio-alfa.example.test' } });
  const idExistente = existente.json().item.id;
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: `/api/crm/${encodeURIComponent(idExistente)}/dnc`, body: {} })).status, 200);
  await aprovar(env, RAFAEL, env.ids.alfa);
  const resposta = await promover(env, BRENO, env.ids.alfa);
  assert.equal(resposta.status, 409);
  assert.equal(resposta.json().error.code, 'PROMOTION_BLOCKED_DNC');
  assert.match(resposta.json().error.message, /Promoção bloqueada: existe uma restrição de contato/);
  assert.equal((await registrosDoCrm(env)).length, 1);
  assert.equal((await registrosDoCrm(env))[0].id, idExistente);
});

test('[PROMO-API-11] campos forjados no corpo (estado, approvalId, actor, reviewedBy, userId, role, permissions...): 400 e nada é criado', async (t) => {
  const env = ambiente(t);
  await aprovar(env, RAFAEL, env.ids.alfa);
  const forjados = [
    { estado: 'APROVADO_PARA_CRM' },
    { state: 'APROVADO_PARA_CRM' },
    { approvalId: 'x' },
    { aprovacao: { por: { userId: 'user-breno' } } },
    { actor: 'HUMAN' },
    { reviewedBy: { userId: 'user-breno', name: 'x', role: 'ADMIN' } },
    { userId: BRENO.userId },
    { role: 'ADMIN' },
    { permissions: ['WRITE:CRM'] },
    { prospectId: env.ids.beta },
    { reason: 'motivo' },
  ];
  for (const corpo of forjados) {
    const resposta = await chamar(env, BRENO, { method: 'POST', url: rotaPromover(env.ids.alfa), body: corpo });
    assert.equal(resposta.status, 400, JSON.stringify(corpo));
    assert.deepEqual(resposta.json(), { error: { code: 'INVALID_REQUEST', message: 'Campos não permitidos na requisição.' } });
  }
  assert.deepEqual(await registrosDoCrm(env), []);
});

test('[PROMO-API-12] corpo inválido (não objeto, JSON quebrado, sem Content-Type) e query string: recusados; __proto__ não polui nada', async (t) => {
  const env = ambiente(t);
  await aprovar(env, RAFAEL, env.ids.alfa);
  const rota = rotaPromover(env.ids.alfa);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: rota, body: '[]' })).status, 400);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: rota, body: '{' })).status, 400);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: rota, body: 'null' })).status, 400);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: rota, body: {}, contentType: null })).status, 415);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: rota, body: {}, contentType: 'text/plain' })).status, 415);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: `${rota}?estado=APROVADO_PARA_CRM`, body: {} })).status, 400);
  const poluido = await chamar(env, BRENO, { method: 'POST', url: rota, body: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}' });
  assert.equal(poluido.status, 400);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(await registrosDoCrm(env), []);
});

test('[PROMO-API-13] ids perigosos ou inexistentes: 400/404 com mensagem fixa, nunca 500, e nada é criado', async (t) => {
  const env = ambiente(t);
  await aprovar(env, RAFAEL, env.ids.alfa);
  for (const id of ['../../etc/passwd', '..', '__proto__', 'constructor', 'toString', 'x'.repeat(5000), 'prospect:inexistente', '<script>alert(1)</script>', '%00', 'a b']) {
    const resposta = await promover(env, BRENO, id);
    assert.ok([400, 404].includes(resposta.status), `${id.slice(0, 20)} -> ${resposta.status}`);
    assert.equal(resposta.text.includes('script'), false);
  }
  const malformado = await chamar(env, BRENO, { method: 'POST', url: '/api/approvals/%E0%A4%A/promote', body: {} });
  assert.equal(malformado.status, 400);
  const inexistente = await promover(env, BRENO, 'prospect:nao-existe');
  assert.deepEqual(inexistente.json(), { error: { code: 'NOT_FOUND', message: 'Item não encontrado.' } });
  assert.deepEqual(await registrosDoCrm(env), []);
});

test('[PROMO-API-14] só POST: os outros métodos recebem 405 com Allow: POST', async (t) => {
  const env = ambiente(t);
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    const resposta = await chamar(env, BRENO, { method, url: rotaPromover(env.ids.alfa) });
    assert.equal(resposta.status, 405, method);
    assert.equal(resposta.headers.Allow, 'POST');
  }
});

test('[PROMO-API-15] sem o serviço de promoção injetado a rota NÃO existe (404), como antes', async (t) => {
  const env = montarAmbiente(t, { crm: true });
  await aprovar(env, RAFAEL, env.ids.alfa);
  const resposta = await promover(env, BRENO, env.ids.alfa);
  assert.equal(resposta.status, 404);
  assert.deepEqual(await registrosDoCrm(env), []);
});

test('[PROMO-API-16] a fábrica do app recusa um serviço de promoção inválido (falha fechada)', (t) => {
  const env = montarAmbiente(t, { crm: true });
  const base = { verifyAccessToken: env.verifyAccessToken, userStore: env.userStore, approvalQueueService: env.approvalQueueService, crmService: env.crmService, publicConfig: env.publicConfig, staticRoot: env.staticRoot, staticFiles: env.staticFiles };
  for (const invalido of [null, {}, { promoteProspect: 'x' }, 42]) {
    assert.throws(() => createApp({ ...base, crmIntegrationService: invalido }), /crmIntegrationService/);
  }
});

test('[PROMO-API-17] delegação: o serviço recebe SÓ (contexto emitido, id da URL) — nada do corpo, da query ou de cabeçalhos', async (t) => {
  const chamadas = [];
  const duplo = { promoteProspect: (...args) => (chamadas.push(args), { outcome: 'CRIADO', prospectId: args[1], crmRecordId: 'crm:11111111-1111-1111-1111-111111111111', possivelDuplicidade: null, record: { segredo: 'x' }, aprovacao: { por: 'y' } }) };
  const env = ambiente(t, { crmIntegrationService: duplo, integracao: false });
  const resposta = await chamar(env, BRENO, { method: 'POST', url: rotaPromover('Prospect:AbC-123'), body: {}, headers: { 'x-user-id': 'user-x', 'x-role': 'ADMIN' } });
  assert.equal(resposta.status, 200);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].length, 2);
  assert.equal(isIssuedAuthorizationContext(chamadas[0][0]), true);
  assert.equal(chamadas[0][0].userId, BRENO.userId);
  assert.equal(chamadas[0][0].role, BRENO.role);
  assert.equal(chamadas[0][1], 'Prospect:AbC-123', 'o id chega exatamente como veio na URL (sem mudar caixa nem espaços)');
  assert.equal(resposta.text.includes('segredo'), false, 'o registro e a aprovação não saem na resposta');
  assert.deepEqual(Object.keys(resposta.json()).sort(), ['crmRecordId', 'outcome', 'possivelDuplicidade', 'prospectId']);
});

test('[PROMO-API-18] possivelDuplicidade sai só como booleano (o detalhe da outra identidade não sai)', async (t) => {
  const duplo = { promoteProspect: () => ({ outcome: 'CRIADO', prospectId: 'p', crmRecordId: 'crm:1', possivelDuplicidade: { crmRecordId: 'crm:outro', empresa: 'Outra' } }) };
  const env = ambiente(t, { crmIntegrationService: duplo, integracao: false });
  const resposta = await promover(env, BRENO, 'p');
  assert.equal(resposta.json().possivelDuplicidade, true);
  assert.equal(resposta.text.includes('crm:outro'), false);
  assert.equal(resposta.text.includes('Outra'), false);
});

test('[PROMO-API-19] falha inesperada do serviço: 500 com mensagem fixa — sem stack, caminho, token, authUserId nem texto do erro', async (t) => {
  const segredo = 'ENOENT: C:\\dados\\crm.json token=abc123 authUserId=auth-breno';
  const duplo = {
    promoteProspect: () => {
      throw new Error(segredo);
    },
  };
  const env = ambiente(t, { crmIntegrationService: duplo, integracao: false });
  const resposta = await promover(env, BRENO, 'p');
  assert.equal(resposta.status, 500);
  assert.deepEqual(resposta.json(), { error: { code: 'INTERNAL', message: ERRO_INTERNO } });
  for (const trecho of ['ENOENT', 'crm.json', 'abc123', 'auth-breno', 'at ']) assert.equal(resposta.text.includes(trecho), false, trecho);
  assert.equal(env.logs.join('\n').includes(env.tokenFor(BRENO.userId)), false, 'o token da sessão nunca vai para o log');
  assert.match(env.logs.join('\n'), /erro 500 em POST \/api\/approvals\/:id\/promote/);
});

test('[PROMO-API-20] um code desconhecido, ou herdado do protótipo, é 500 — e cada code do serviço tem um mapeamento (a lista não diverge de PROMOTION_ERROR)', () => {
  for (const code of ['__proto__', 'constructor', 'toString', 'PROMOTION_INVENTADO']) {
    const erro = Object.assign(new Error('x'), { code });
    assert.equal(mapErrorToHttp(erro).status, 500, code);
    assert.equal(mapErrorToHttp(erro).code, 'INTERNAL', code);
  }
  const conflitos = Object.values(PROMOTION_ERROR).map((code) => mapErrorToHttp(Object.assign(new Error('Promoção: texto interno com /caminho e site.example.test'), { code })));
  assert.equal(conflitos.length, 9);
  for (const falha of conflitos) {
    assert.notEqual(falha.status, 500, falha.code);
    assert.equal(falha.message.includes('texto interno'), false);
  }
  assert.deepEqual(
    Object.values(PROMOTION_ERROR).map((code) => mapErrorToHttp(Object.assign(new Error('x'), { code })).status).sort(),
    [400, 404, 409, 409, 409, 409, 409, 409, 409]
  );
});

test('[PROMO-API-21] a fábrica de arquivos exige o caminho do CRM (sem padrão escondido), aceita a fila sem caminho (o padrão do domínio) e devolve só promoteProspect', (t) => {
  const env = ambiente(t);
  const base = { authorizeReviewer: authorizeReviewerForApprovalQueue, authorizeOperation: authorizeCrmOperation, queuePath: env.filePath, crmPath: env.crmFilePath };
  for (const invalido of [undefined, '', '   ', 42, null]) {
    assert.throws(() => createFileBackedCrmIntegrationService({ ...base, crmPath: invalido }), /crmPath/);
  }
  assert.throws(() => createFileBackedCrmIntegrationService({ ...base, queuePath: '' }), /queuePath/);
  assert.throws(() => createFileBackedCrmIntegrationService(undefined), /crmPath/);
  assert.throws(() => createFileBackedCrmIntegrationService({ ...base, authorizeOperation: undefined }));
  const servico = createFileBackedCrmIntegrationService({ ...base, queuePath: undefined });
  assert.deepEqual(Object.keys(servico), ['promoteProspect']);
});
