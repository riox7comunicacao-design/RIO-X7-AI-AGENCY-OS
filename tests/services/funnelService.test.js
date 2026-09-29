// Testes do Funnel Service (src/services/funnelService.js) — Etapa "Funis 1" da reestruturação Prospecção/CRM/
// Funis. O que protegem: MANAGE:FUNNELS é a ÚNICA permissão que autoriza qualquer operação (decidida pela ponte
// REAL de src/auth/funnelBridge.js); o Service só aceita os campos conhecidos (nunca role/permissions/userId no
// corpo); e o domínio real decide as regras (guardas de exclusão, cópia, reordenação).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFunnelService } = require('../../src/services/funnelService');
const { createInMemoryFunnelRepository } = require('../../src/crm/funnelRepository');
const { ROLE, USER_STATUS, defineUser, authorizeFunnelOperation } = require('../../src/auth');
const { createAuthorizationContext } = require('../helpers/authFixtures');

const ADMIN_USER = { userId: 'user-admin-funnel', authUserId: 'auth-admin-funnel', name: 'Admin Funil', email: 'admin-funnel@example.test', role: ROLE.ADMIN };
const CLOSER_USER = { userId: 'user-closer-funnel', authUserId: 'auth-closer-funnel', name: 'Closer Funil', email: 'closer-funnel@example.test', role: ROLE.COMMERCIAL_CLOSER };
const usuario = (base, overrides = {}) => defineUser({ ...base, status: USER_STATUS.ACTIVE, ...overrides });
const admin = () => createAuthorizationContext(usuario(ADMIN_USER));
const closer = () => createAuthorizationContext(usuario(CLOSER_USER));

const criarServico = (repository = createInMemoryFunnelRepository(), extras = {}) =>
  createFunnelService({ authorizeOperation: authorizeFunnelOperation, repository, ...extras });

async function erroDe(fn) {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  return null;
}

test('[FUNNEL-SVC-1] o Service expõe exatamente as 12 operações, congelado', () => {
  const servico = criarServico();
  assert.deepEqual(Object.keys(servico).sort(), [
    'copyFunnel', 'createFunnel', 'createStage', 'deleteFunnel', 'deleteStage', 'getFunnel',
    'listFunnels', 'listStages', 'reorderFunnels', 'reorderStages', 'updateFunnel', 'updateStage',
  ]);
  assert.ok(Object.isFrozen(servico));
});

test('[FUNNEL-SVC-2] sem autorizador ou sem repositório o Service não existe', () => {
  assert.throws(() => createFunnelService({ repository: createInMemoryFunnelRepository() }), /exige \{ authorizeOperation \}/);
  assert.throws(() => createFunnelService({ authorizeOperation: authorizeFunnelOperation }), /exige \{ repository \}/);
  assert.throws(() => createFunnelService({ authorizeOperation: authorizeFunnelOperation, repository: { listFunnels: () => [] } }), /repositório inválido/);
});

test('[FUNNEL-SVC-3] ADMIN (MANAGE:FUNNELS) executa todas as operações; COMMERCIAL_CLOSER (sem a permissão) é recusado em TODAS, citando MANAGE:FUNNELS', async () => {
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
  const repo = createInMemoryFunnelRepository();
  repo.countCardsByFunnel = () => 1;
  repo.countCardsByStage = () => 1;
  const servico = criarServico(repo);
  const funnel = await servico.createFunnel(admin(), { nome: 'F' });
  const stage = await servico.createStage(admin(), funnel.id, { nome: 'S' });

  const erroFunil = await erroDe(() => servico.deleteFunnel(admin(), funnel.id));
  assert.equal(erroFunil.code, 'FUNNEL_HAS_CARDS');
  const erroEtapa = await erroDe(() => servico.deleteStage(admin(), stage.id));
  assert.equal(erroEtapa.code, 'STAGE_HAS_CARDS');
});
