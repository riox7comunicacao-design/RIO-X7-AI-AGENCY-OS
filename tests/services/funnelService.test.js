// Testes do Funnel Service (src/services/funnelService.js) — reestruturação Prospecção/CRM/Funis (Etapas "Funis
// 1" e "Funis 2"). O que protegem: MANAGE:FUNNELS é a ÚNICA permissão que autoriza administrar a ESTRUTURA
// (funil/etapa), decidida pela ponte REAL de src/auth/funnelBridge.js; operações de CARD usam a ponte REAL do
// CRM (READ:CRM para ler, PROPOSE:CRM para criar/mover — ADMIN e COMMERCIAL_CLOSER têm as duas —, WRITE:CRM
// para arquivar, só ADMIN); o Service só aceita os campos conhecidos (nunca role/permissions/userId no corpo);
// e o domínio real decide as regras (guardas de exclusão, cópia, reordenação, identidade de card, movimentação).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFunnelService } = require('../../src/services/funnelService');
const { createInMemoryFunnelRepository } = require('../../src/crm/funnelRepository');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
const { createCrmService } = require('../../src/services/crmService');
const { ROLE, USER_STATUS, defineUser, authorizeFunnelOperation, authorizeCrmOperation } = require('../../src/auth');
const { createAuthorizationContext } = require('../helpers/authFixtures');

const ADMIN_USER = { userId: 'user-admin-funnel', authUserId: 'auth-admin-funnel', name: 'Admin Funil', email: 'admin-funnel@example.test', role: ROLE.ADMIN };
const CLOSER_USER = { userId: 'user-closer-funnel', authUserId: 'auth-closer-funnel', name: 'Closer Funil', email: 'closer-funnel@example.test', role: ROLE.COMMERCIAL_CLOSER };
const usuario = (base, overrides = {}) => defineUser({ ...base, status: USER_STATUS.ACTIVE, ...overrides });
const admin = () => createAuthorizationContext(usuario(ADMIN_USER));
const closer = () => createAuthorizationContext(usuario(CLOSER_USER));

// Monta um Funnel Service REAL sobre um CRM Service REAL (repositório em memória) — nunca um double: as operações
// de card confirmam a existência de verdade do registro do CRM, e a projeção é enriquecida pelo CRM Service real.
function criarServico({ funnelRepository = createInMemoryFunnelRepository(), crmRepository = createInMemoryCrmRepository(), extras = {} } = {}) {
  const crmService = createCrmService({ authorizeOperation: authorizeCrmOperation, repository: crmRepository });
  return createFunnelService({
    authorizeOperation: authorizeFunnelOperation,
    authorizeCrmOperation,
    repository: funnelRepository,
    crmRepository,
    crmService,
    ...extras,
  });
}

async function erroDe(fn) {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  return null;
}

test('[FUNNEL-SVC-1] o Service expõe exatamente as 18 operações (12 de funil/etapa + 6 de card), congelado', () => {
  const servico = criarServico();
  assert.deepEqual(Object.keys(servico).sort(), [
    'copyFunnel', 'createCard', 'createFunnel', 'createStage', 'deleteCard', 'deleteFunnel', 'deleteStage',
    'getCard', 'getCardHistory', 'getFunnel', 'listCardsByFunnel', 'listFunnels', 'listStages', 'moveCard',
    'reorderFunnels', 'reorderStages', 'updateFunnel', 'updateStage',
  ]);
  assert.ok(Object.isFrozen(servico));
});

test('[FUNNEL-SVC-2] sem autorizador de funil, sem ponte do CRM, sem repositório, sem crmRepository ou sem crmService o Service não existe', () => {
  const funnelRepository = createInMemoryFunnelRepository();
  const crmRepository = createInMemoryCrmRepository();
  const crmService = createCrmService({ authorizeOperation: authorizeCrmOperation, repository: crmRepository });
  const base = { authorizeOperation: authorizeFunnelOperation, authorizeCrmOperation, repository: funnelRepository, crmRepository, crmService };
  assert.throws(() => createFunnelService({ ...base, authorizeOperation: undefined }), /exige \{ authorizeOperation \}/);
  assert.throws(() => createFunnelService({ ...base, authorizeCrmOperation: undefined }), /exige \{ authorizeCrmOperation \}/);
  assert.throws(() => createFunnelService({ ...base, repository: undefined }), /exige \{ repository \}/);
  assert.throws(() => createFunnelService({ ...base, repository: { listFunnels: () => [] } }), /repositório inválido/);
  assert.throws(() => createFunnelService({ ...base, crmRepository: undefined }), /exige \{ crmRepository \}/);
  assert.throws(() => createFunnelService({ ...base, crmService: undefined }), /exige \{ crmService \}/);
});

test('[FUNNEL-SVC-3] ADMIN (MANAGE:FUNNELS) executa todas as operações de estrutura; COMMERCIAL_CLOSER (sem a permissão) é recusado em TODAS, citando MANAGE:FUNNELS', async () => {
  const servico = criarServico();
  const funnel = await servico.createFunnel(admin(), { nome: 'Outbound' });
  assert.match(funnel.id, /^funnel:/);
  const stage = await servico.createStage(admin(), funnel.id, { nome: 'Etapa 1' });
  assert.equal((await servico.listFunnels(admin())).length, 1);
  assert.equal((await servico.getFunnel(admin(), funnel.id)).nome, 'Outbound');
  assert.equal((await servico.updateFunnel(admin(), funnel.id, { nome: 'Renomeado' })).nome, 'Renomeado');
  assert.equal((await servico.listStages(admin(), funnel.id)).length, 1);
  await servico.updateStage(admin(), stage.id, { ativo: false });
  await servico.reorderFunnels(admin(), [funnel.id]);
  await servico.reorderStages(admin(), funnel.id, [stage.id]);
  const copia = await servico.copyFunnel(admin(), funnel.id, { nome: 'Cópia' });
  assert.notEqual(copia.id, funnel.id);
  await servico.deleteStage(admin(), stage.id);
  const deletado = await servico.deleteFunnel(admin(), funnel.id);
  assert.deepEqual(deletado, { id: funnel.id });

  const chamadas = [
    () => servico.listFunnels(closer()),
    () => servico.getFunnel(closer(), 'funnel:x'),
    () => servico.createFunnel(closer(), { nome: 'x' }),
    () => servico.updateFunnel(closer(), 'funnel:x', {}),
    () => servico.deleteFunnel(closer(), 'funnel:x'),
    () => servico.copyFunnel(closer(), 'funnel:x'),
    () => servico.reorderFunnels(closer(), []),
    () => servico.listStages(closer(), 'funnel:x'),
    () => servico.createStage(closer(), 'funnel:x', { nome: 'x' }),
    () => servico.updateStage(closer(), 'stage:x', {}),
    () => servico.deleteStage(closer(), 'stage:x'),
    () => servico.reorderStages(closer(), 'funnel:x', []),
  ];
  for (const chamada of chamadas) {
    const erro = await erroDe(chamada);
    assert.ok(erro, 'deveria recusar');
    assert.match(erro.message, /acesso negado/);
    assert.match(erro.message, /MANAGE:FUNNELS/);
  }
});

test('[FUNNEL-SVC-4] um usuário INACTIVE (mesmo ADMIN) é recusado', async () => {
  const servico = criarServico();
  const inativo = createAuthorizationContext(usuario(ADMIN_USER, { status: USER_STATUS.INACTIVE }));
  const erro = await erroDe(() => servico.listFunnels(inativo));
  assert.match(erro.message, /inativo/);
});

test('[FUNNEL-SVC-5] campos desconhecidos no corpo são recusados ANTES de tocar o repositório — inclusive tentativas de forjar id/ordem/criadoEm', async () => {
  const servico = criarServico();
  for (const campo of ['id', 'ordem', 'criadoEm', 'userId', 'role', 'permissions']) {
    const erro = await erroDe(() => servico.createFunnel(admin(), { nome: 'x', [campo]: 'forjado' }));
    assert.match(erro.message, /campos desconhecidos/, campo);
  }
  assert.equal((await servico.listFunnels(admin())).length, 0, 'nada foi gravado');

  const funnel = await servico.createFunnel(admin(), { nome: 'F' });
  const erroStage = await erroDe(() => servico.createStage(admin(), funnel.id, { nome: 'x', funnelId: 'forjado' }));
  assert.match(erroStage.message, /campos desconhecidos/);
});

test('[FUNNEL-SVC-6] deleteFunnel/deleteStage propagam o código FUNNEL_HAS_CARDS/STAGE_HAS_CARDS do domínio, intacto', async () => {
  const funnelRepository = createInMemoryFunnelRepository();
  funnelRepository.countCardsByFunnel = () => 1;
  funnelRepository.countCardsByStage = () => 1;
  const servico = criarServico({ funnelRepository });
  const funnel = await servico.createFunnel(admin(), { nome: 'F' });
  const stage = await servico.createStage(admin(), funnel.id, { nome: 'S' });

  const erroFunil = await erroDe(() => servico.deleteFunnel(admin(), funnel.id));
  assert.equal(erroFunil.code, 'FUNNEL_HAS_CARDS');
  const erroEtapa = await erroDe(() => servico.deleteStage(admin(), stage.id));
  assert.equal(erroEtapa.code, 'STAGE_HAS_CARDS');
});

// ===========================================================================
// CARD (Etapa "Funis 2")
// ===========================================================================
test('[FUNNEL-SVC-7] createCard/moveCard: ADMIN e COMMERCIAL_CLOSER (ambos com PROPOSE:CRM) conseguem; a projeção vem enriquecida com dados do CRM (nunca duplicados no card)', async () => {
  const crmRepository = createInMemoryCrmRepository();
  const servico = criarServico({ crmRepository });
  const crmService = createCrmService({ authorizeOperation: authorizeCrmOperation, repository: crmRepository });
  const { record } = await crmService.createRecord(admin(), { empresa: 'Clínica Alfa', responsavel: 'Ana' });

  const funnel = await servico.createFunnel(admin(), { nome: 'Outbound' });
  const s1 = await servico.createStage(admin(), funnel.id, { nome: 'Sem contato' });
  const s2 = await servico.createStage(admin(), funnel.id, { nome: 'Contatado' });

  const card = await servico.createCard(closer(), funnel.id, { crmRecordId: record.id });
  assert.equal(card.funnelId, funnel.id);
  assert.equal(card.stageId, s1.id);
  assert.equal(card.crmRecordId, record.id);
  assert.equal(card.crm.empresa, 'Clínica Alfa');
  assert.equal(card.crm.responsavel, 'Ana');
  assert.equal(Object.prototype.hasOwnProperty.call(card, 'nicho'), false, 'o card não duplica campos do CRM além dos projetados');

  const movido = await servico.moveCard(admin(), card.id, { stageId: s2.id, reason: 'avançou' });
  assert.equal(movido.stageId, s2.id);

  const historico = await servico.getCardHistory(admin(), card.id);
  assert.equal(historico.length, 2);
  assert.equal(historico[1].motivo, 'avançou');
});

test('[FUNNEL-SVC-8] listCardsByFunnel/getCard exigem só READ:CRM (ambas as roles); createCard/moveCard exigem PROPOSE:CRM; deleteCard exige WRITE:CRM (só ADMIN)', async () => {
  const crmRepository = createInMemoryCrmRepository();
  const servico = criarServico({ crmRepository });
  const crmService = createCrmService({ authorizeOperation: authorizeCrmOperation, repository: crmRepository });
  const { record } = await crmService.createRecord(admin(), { empresa: 'Clínica Beta' });
  const funnel = await servico.createFunnel(admin(), { nome: 'F' });
  await servico.createStage(admin(), funnel.id, { nome: 'S1' });
  const card = await servico.createCard(admin(), funnel.id, { crmRecordId: record.id });

  // READ:CRM: ambos conseguem.
  assert.equal((await servico.listCardsByFunnel(closer(), funnel.id)).length, 1);
  assert.equal((await servico.getCard(closer(), card.id)).id, card.id);

  // deleteCard exige WRITE:CRM — CLOSER não tem.
  const erroCloser = await erroDe(() => servico.deleteCard(closer(), card.id));
  assert.match(erroCloser.message, /acesso negado/);
  assert.match(erroCloser.message, /WRITE:CRM/);

  // ADMIN (com WRITE:CRM) consegue arquivar.
  const arquivado = await servico.deleteCard(admin(), card.id);
  assert.deepEqual(arquivado, { id: card.id });
  assert.equal((await servico.listCardsByFunnel(admin(), funnel.id)).length, 0, 'arquivado some da listagem ativa');
});

test('[FUNNEL-SVC-9] createCard/moveCard propagam os códigos do domínio intactos: FUNNEL_CARD_DUPLICATE, FUNNEL_STAGE_MISMATCH, FUNNEL_HAS_NO_STAGES', async () => {
  const crmRepository = createInMemoryCrmRepository();
  const servico = criarServico({ crmRepository });
  const crmService = createCrmService({ authorizeOperation: authorizeCrmOperation, repository: crmRepository });
  const { record } = await crmService.createRecord(admin(), { empresa: 'Clínica Gama' });

  const semEtapas = await servico.createFunnel(admin(), { nome: 'Vazio' });
  const erroSemEtapas = await erroDe(() => servico.createCard(admin(), semEtapas.id, { crmRecordId: record.id }));
  assert.equal(erroSemEtapas.code, 'FUNNEL_HAS_NO_STAGES');

  const funnelA = await servico.createFunnel(admin(), { nome: 'A' });
  await servico.createStage(admin(), funnelA.id, { nome: 'A1' });
  const funnelB = await servico.createFunnel(admin(), { nome: 'B' });
  const stageB = await servico.createStage(admin(), funnelB.id, { nome: 'B1' });

  const card = await servico.createCard(admin(), funnelA.id, { crmRecordId: record.id });
  const erroDuplicado = await erroDe(() => servico.createCard(admin(), funnelA.id, { crmRecordId: record.id }));
  assert.equal(erroDuplicado.code, 'FUNNEL_CARD_DUPLICATE');

  const erroMismatch = await erroDe(() => servico.moveCard(admin(), card.id, { stageId: stageB.id }));
  assert.equal(erroMismatch.code, 'FUNNEL_STAGE_MISMATCH');
});

test('[FUNNEL-SVC-10] createCard recusa um crmRecordId inexistente; campos desconhecidos no corpo (userId/role/permissions) são recusados ANTES de tocar o domínio', async () => {
  const crmRepository = createInMemoryCrmRepository();
  const servico = criarServico({ crmRepository });
  const funnel = await servico.createFunnel(admin(), { nome: 'F' });
  await servico.createStage(admin(), funnel.id, { nome: 'S1' });

  await assert.rejects(() => servico.createCard(admin(), funnel.id, { crmRecordId: 'crm:nao-existe' }), /registro do CRM não encontrado/);

  for (const campo of ['userId', 'role', 'permissions', 'funnelId', 'stageId']) {
    const erro = await erroDe(() => servico.createCard(admin(), funnel.id, { crmRecordId: 'crm:x', [campo]: 'forjado' }));
    assert.match(erro.message, /campos desconhecidos/, campo);
  }
});

test('[FUNNEL-SVC-11] um registro do CRM excluído depois de o card existir: a projeção devolve crm: null (nunca inventa dado, nunca quebra)', async () => {
  const crmRepository = createInMemoryCrmRepository();
  const servico = criarServico({ crmRepository });
  const crmService = createCrmService({ authorizeOperation: authorizeCrmOperation, repository: crmRepository });
  const { record } = await crmService.createRecord(admin(), { empresa: 'Clínica Delta' });
  const funnel = await servico.createFunnel(admin(), { nome: 'F' });
  await servico.createStage(admin(), funnel.id, { nome: 'S1' });
  const card = await servico.createCard(admin(), funnel.id, { crmRecordId: record.id });

  await crmService.deleteRecord(admin(), record.id, { reason: 'teste' });

  const lido = await servico.getCard(admin(), card.id);
  assert.equal(lido.crm, null);
  assert.equal(lido.crmRecordId, record.id, 'a referência ao id continua — só a projeção enriquecida é que falta');
});
