// Teste de CONTRATO do mapeamento de erro -> HTTP (decisão D5): src/server/app.js reconhece os erros do domínio,
// do Service e do auth PELO TEXTO da mensagem (eles não têm código) — o Service não foi alterado para ganhar um.
// Este arquivo PRODUZ cada erro real, com os módulos reais (nunca digita a mensagem à mão), e prova que
// mapErrorToHttp() os traduz para o status esperado. Se um dia a mensagem de origem mudar, é aqui que quebra —
// de propósito: o app.js pararia de reconhecer o erro e devolveria 500 em vez do status correto.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const domain = require('../../src/research-prospector/approvalQueue');
const { runDiscoveryPipeline, SOURCE_TYPE } = require('../../src/research-prospector/discovery');
const { createApprovalQueueService } = require('../../src/services/approvalQueueService');
const { authorizeReviewerForApprovalQueue, PERMISSION, SupabaseAdapterError, CONNECTIVITY_ERROR, UserResolutionError, USER_RESOLUTION_ERROR } = require('../../src/auth');
const constants = require('../../src/auth/constants');
const { createAuthorizationContext } = require('../helpers/authFixtures');
const { defineUser, ROLE, USER_STATUS } = require('../../src/auth');
const { mapErrorToHttp } = require('../../src/server/app');

function erroDe(fn) {
  try {
    fn();
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava que a função lançasse, e ela não lançou');
}

function novoServico(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-errmap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'approval-queue.json');
  const queue = domain.createEmptyQueue();
  const alfa = domain.addProspect(
    queue,
    runDiscoveryPipeline({
      briefing: { nicho: 'Psicologia' },
      rawFindings: [{ empresa: 'Alfa', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', campos: { site: [{ valor: 'alfa.example.test', fonte: 'Site', tipoFonte: SOURCE_TYPE.OFICIAL }] } }],
    }).resultados[0]
  );
  const bloqueado = domain.addProspect(
    queue,
    runDiscoveryPipeline({
      briefing: { nicho: 'Psicologia' },
      rawFindings: [{ empresa: 'Bloqueada', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', campos: { site: [{ valor: 'bloqueada.example.test', fonte: 'Site', tipoFonte: SOURCE_TYPE.OFICIAL }] } }],
      crmRecords: [{ empresa: 'Bloqueada', site: 'https://bloqueada.example.test', doNotContact: true }],
    }).resultados[0]
  );
  domain.saveQueueToDisk(queue, filePath);
  const service = createApprovalQueueService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: filePath });
  const ctx = createAuthorizationContext(defineUser({ userId: 'u1', authUserId: 'a1', name: 'Um', email: 'um-teste@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE }));
  return { service, ctx, ids: { alfa: alfa.prospectId, bloqueado: bloqueado.prospectId } };
}

test('[ERRMAP-1] "usuário inativo" (auth) -> 403 INACTIVE', () => {
  const inativo = createAuthorizationContext(
    defineUser({ userId: 'u2', authUserId: 'a2', name: 'Dois', email: 'dois-teste@example.test', role: ROLE.ADMIN, status: USER_STATUS.INACTIVE })
  );
  const erro = erroDe(() => authorizeReviewerForApprovalQueue(inativo, PERMISSION.APPROVE_LEAD_APPROVAL));
  assert.deepEqual(mapErrorToHttp(erro), { status: 403, code: 'INACTIVE', message: 'Esta conta não possui acesso a esta área.', headers: undefined });
});

test('[ERRMAP-2] "acesso negado" (auth, contexto emitido sem a permissão) -> 403 FORBIDDEN', (t) => {
  const derivacao = t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.READ_CRM]));
  const semPermissao = createAuthorizationContext(defineUser({ userId: 'u3', authUserId: 'a3', name: 'Três', email: 'tres-teste@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE }));
  derivacao.mock.restore();
  const erro = erroDe(() => authorizeReviewerForApprovalQueue(semPermissao, PERMISSION.APPROVE_LEAD_APPROVAL));
  const mapeado = mapErrorToHttp(erro);
  assert.equal(mapeado.status, 403);
  assert.equal(mapeado.code, 'FORBIDDEN');
});

test('[ERRMAP-3] "prospect não encontrado na fila" (domínio) -> 404 NOT_FOUND', (t) => {
  const { service, ctx } = novoServico(t);
  const erro = erroDe(() => service.getHistory(ctx, 'id:inexistente'));
  assert.equal(mapErrorToHttp(erro).status, 404);
  assert.equal(mapErrorToHttp(erro).code, 'NOT_FOUND');
});

test('[ERRMAP-4] "transição não permitida" (domínio, decisão duplicada) -> 409 ALREADY_DECIDED', (t) => {
  const { service, ctx, ids } = novoServico(t);
  service.approveProspect(ctx, ids.alfa, { reason: 'ok' });
  const erro = erroDe(() => service.approveProspect(ctx, ids.alfa, { reason: 'de novo' }));
  assert.equal(mapErrorToHttp(erro).status, 409);
  assert.equal(mapErrorToHttp(erro).code, 'ALREADY_DECIDED');

  const dnc = erroDe(() => service.approveProspect(ctx, ids.bloqueado, { reason: 'ok' }));
  assert.equal(mapErrorToHttp(dnc).status, 409, 'transição bloqueada por DNC também é "já decidido" do ponto de vista HTTP');
});

test('[ERRMAP-5] "rejeição exige um motivo" (domínio) -> 400 com mensagem amigável', (t) => {
  const { service, ctx, ids } = novoServico(t);
  const erro = erroDe(() => service.rejectProspect(ctx, ids.alfa, {}));
  const mapeado = mapErrorToHttp(erro);
  assert.equal(mapeado.status, 400);
  assert.equal(mapeado.code, 'INVALID_REQUEST');
  assert.equal(mapeado.message, 'Informe o motivo da rejeição.');
});

test('[ERRMAP-6] "reason deve ser um texto" (Service) -> 400', (t) => {
  const { service, ctx, ids } = novoServico(t);
  const erro = erroDe(() => service.approveProspect(ctx, ids.alfa, { reason: 42 }));
  assert.equal(mapErrorToHttp(erro).status, 400);
});

test('[ERRMAP-7] "opções não reconhecidas" (Service) -> 400', (t) => {
  const { service, ctx } = novoServico(t);
  const erro = erroDe(() => service.listQueue(ctx, { estado: 'AGUARDANDO_REVISAO', bogus: 1 }));
  assert.equal(mapErrorToHttp(erro).status, 400);
});

test('[ERRMAP-8] "as opções devem ser um objeto" (Service) -> 400', (t) => {
  const { service, ctx } = novoServico(t);
  const erro = erroDe(() => service.listQueue(ctx, 'nao-e-um-objeto'));
  assert.equal(mapErrorToHttp(erro).status, 400);
});

test('[ERRMAP-9] "estado desconhecido" (Service) -> 400', (t) => {
  const { service, ctx } = novoServico(t);
  const erro = erroDe(() => service.listQueue(ctx, { estado: 'ESTADO_QUE_NAO_EXISTE' }));
  assert.equal(mapErrorToHttp(erro).status, 400);
});

test('[ERRMAP-10] "prospectId deve ser um texto não vazio" (Service) -> 400', (t) => {
  const { service, ctx } = novoServico(t);
  const erro = erroDe(() => service.approveProspect(ctx, '', { reason: 'ok' }));
  assert.equal(mapErrorToHttp(erro).status, 400);
});

test('[ERRMAP-11] SupabaseAdapterError(AUTH) -> 401; as demais categorias -> 503 (falha fechada, nunca 200)', () => {
  const auth = mapErrorToHttp(new SupabaseAdapterError(CONNECTIVITY_ERROR.AUTH, 'token rejeitado'));
  assert.equal(auth.status, 401);
  assert.equal(auth.code, 'UNAUTHENTICATED');
  for (const categoria of [CONNECTIVITY_ERROR.NETWORK, CONNECTIVITY_ERROR.CONFIGURACAO, CONNECTIVITY_ERROR.SDK, CONNECTIVITY_ERROR.UNKNOWN, CONNECTIVITY_ERROR.PERMISSION]) {
    const mapeado = mapErrorToHttp(new SupabaseAdapterError(categoria, 'indisponível'));
    assert.equal(mapeado.status, 503, categoria);
    assert.equal(mapeado.code, 'AUTH_UNAVAILABLE', categoria);
  }
});

test('[ERRMAP-12] UserResolutionError(USER_NOT_FOUND) -> 403; qualquer outro código -> 500 (nunca inventa um status de sucesso)', () => {
  const semUsuario = mapErrorToHttp(new UserResolutionError(USER_RESOLUTION_ERROR.USER_NOT_FOUND, 'usuário não encontrado'));
  assert.equal(semUsuario.status, 403);
  assert.equal(semUsuario.code, 'NO_ACCESS');
  const outroCodigo = mapErrorToHttp(new UserResolutionError(USER_RESOLUTION_ERROR.IDENTITY_NOT_VERIFIED, 'identidade não verificada'));
  assert.equal(outroCodigo.status, 500);
});

test('[ERRMAP-13] um erro desconhecido (qualquer Error comum, ou algo que nem é um Error) -> 500 genérico, sem repetir a mensagem original', () => {
  for (const entrada of [new Error('detalhe interno bem específico do servidor'), new TypeError('x'), 'um texto solto', undefined, null, 42, {}]) {
    const mapeado = mapErrorToHttp(entrada);
    assert.equal(mapeado.status, 500, String(entrada));
    assert.equal(mapeado.code, 'INTERNAL', String(entrada));
    assert.equal(mapeado.message, 'Erro interno. Tente novamente em instantes.', String(entrada));
  }
});

test('[ERRMAP-14] nenhum erro real — do domínio, do Service ou do auth, produzidos nos testes acima — mapeia para um status de SUCESSO (>= 400 sempre)', (t) => {
  const { service, ctx, ids } = novoServico(t);
  const inativo = createAuthorizationContext(
    defineUser({ userId: 'u4', authUserId: 'a4', name: 'Quatro', email: 'quatro-teste@example.test', role: ROLE.ADMIN, status: USER_STATUS.INACTIVE })
  );
  const erros = [
    erroDe(() => authorizeReviewerForApprovalQueue(inativo, PERMISSION.APPROVE_LEAD_APPROVAL)),
    erroDe(() => service.getHistory(ctx, 'id:inexistente')),
    erroDe(() => service.rejectProspect(ctx, ids.alfa, {})),
    erroDe(() => service.listQueue(ctx, { estado: 'invalido' })),
    new SupabaseAdapterError(CONNECTIVITY_ERROR.NETWORK, 'x'),
    new UserResolutionError(USER_RESOLUTION_ERROR.USER_NOT_FOUND, 'x'),
    new Error('qualquer coisa não catalogada'),
  ];
  for (const erro of erros) assert.ok(mapErrorToHttp(erro).status >= 400, erro.message);
});
