// Prospecting Permanent Exclusion Service (Workbench de Prospecção, Etapa 2) —
// src/services/prospectingExclusionService.js. Peças REAIS: contextos emitidos, a ponte real de
// MANAGE:PROSPECTING_EXCLUSIONS, o repositório de memória.

const test = require('node:test');
const assert = require('node:assert/strict');

const { authorizeProspectingExclusionOperation } = require('../../src/auth');
const { createProspectingExclusionService, ProspectingExclusionError } = require('../../src/services/prospectingExclusionService');
const { createInMemoryPermanentExclusionRepository } = require('../../src/research-prospector/permanentExclusionRepository');
const { admin, closer, inativo } = require('../helpers/promotionFixtures');

const AGORA = new Date('2026-09-30T12:00:00.000Z');

function criarServico(repository = createInMemoryPermanentExclusionRepository()) {
  return createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository, now: () => AGORA });
}

async function erroDe(fn) {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava que a função lançasse, e ela não lançou');
}

const forcaDigital = { empresa: 'Força Digital', motivo: 'Exclusão permanente de prospecção', cidade: 'Petrópolis', estado: 'RJ' };

test('[EXCL-SVC-1] o Service expõe exatamente as 7 operações, congelado', () => {
  const servico = criarServico();
  assert.deepEqual(Object.keys(servico).sort(), ['activate', 'create', 'deactivate', 'getById', 'isExcluded', 'list', 'update']);
  assert.ok(Object.isFrozen(servico));
});

test('[EXCL-SVC-2] dependências obrigatórias: sem authorizeOperation, sem repositório válido, o Service não existe', async () => {
  const repo = createInMemoryPermanentExclusionRepository();
  assert.match((await erroDe(() => createProspectingExclusionService({ repository: repo }))).message, /authorizeOperation/);
  assert.match((await erroDe(() => createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation }))).message, /repositório inválido/);
  assert.ok(criarServico(), 'com tudo certo, o Service existe');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Autorização (server-side, ADMIN só)
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-SVC-3] ADMIN cria/lista/edita/desativa/ativa; COMMERCIAL_CLOSER (sem MANAGE:PROSPECTING_EXCLUSIONS) é recusado em toda operação de gestão', async () => {
  const repo = createInMemoryPermanentExclusionRepository();
  const servico = criarServico(repo);
  const criado = await servico.create(admin(), forcaDigital);
  for (const chamada of [
    () => servico.list(closer()),
    () => servico.getById(closer(), criado.id),
    () => servico.create(closer(), forcaDigital),
    () => servico.update(closer(), criado.id, { cidade: 'x' }),
    () => servico.deactivate(closer(), criado.id),
    () => servico.activate(closer(), criado.id),
  ]) {
    const erro = await erroDe(chamada);
    assert.match(erro.message, /acesso negado/);
  }
});

test('[EXCL-SVC-4] um usuário INACTIVE (mesmo ADMIN) é recusado, sem tocar o repositório', async () => {
  const repo = createInMemoryPermanentExclusionRepository();
  const servico = criarServico(repo);
  const erro = await erroDe(() => servico.create(inativo(), forcaDigital));
  assert.match(erro.message, /usuário inativo/);
  assert.deepEqual(repo.list(), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// CRUD (nunca DELETE físico)
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-SVC-5] create (ADMIN): grava ativa, com empresaNomeNormalizado calculado e criadoPor/criadoEm vindos SÓ do autorizador', async () => {
  const servico = criarServico();
  const criado = await servico.create(admin(), forcaDigital);
  assert.equal(criado.ativo, true);
  assert.equal(criado.empresaNomeNormalizado, 'forca digital');
  assert.equal(criado.criadoPorUserId, 'user-admin-promo');
  assert.equal(criado.criadoEm, AGORA.toISOString());
  assert.match(criado.id, /^[0-9a-f-]{36}$/);
});

test('[EXCL-SVC-6] create com entrada inválida recusa ANTES de gravar', async () => {
  const repo = createInMemoryPermanentExclusionRepository();
  const servico = criarServico(repo);
  const erro = await erroDe(() => servico.create(admin(), { empresa: '' }));
  assert.equal(erro.code, 'EXCLUSION_INVALID_INPUT');
  assert.deepEqual(repo.list(), []);
});

test('[EXCL-SVC-7] create: created_by_user_id NUNCA vem do cliente — mesmo enviado explicitamente, é ignorado (campo desconhecido, recusado)', async () => {
  const servico = criarServico();
  const erro = await erroDe(() => servico.create(admin(), { ...forcaDigital, criadoPorUserId: 'forjado' }));
  assert.equal(erro.code, 'EXCLUSION_INVALID_INPUT');
});

test('[EXCL-SVC-8] list: devolve todas as exclusões (ativas e inativas)', async () => {
  const servico = criarServico();
  await servico.create(admin(), forcaDigital);
  await servico.create(admin(), { empresa: 'Outra', motivo: 'x' });
  const lista = await servico.list(admin());
  assert.equal(lista.length, 2);
});

test('[EXCL-SVC-9] getById: devolve a exclusão; id inexistente -> EXCLUSION_NOT_FOUND; id vazio -> EXCLUSION_INVALID_INPUT', async () => {
  const servico = criarServico();
  const criado = await servico.create(admin(), forcaDigital);
  assert.equal((await servico.getById(admin(), criado.id)).id, criado.id);
  assert.equal((await erroDe(() => servico.getById(admin(), 'nao-existe'))).code, 'EXCLUSION_NOT_FOUND');
  assert.equal((await erroDe(() => servico.getById(admin(), ''))).code, 'EXCLUSION_INVALID_INPUT');
});

test('[EXCL-SVC-10] update: edita campos (cidade/estado/pais/dominio/motivo/empresa) — recalcula empresaNomeNormalizado quando a empresa muda; nunca aceita `ativo` (campo desconhecido no update parcial)', async () => {
  const servico = criarServico();
  const criado = await servico.create(admin(), forcaDigital);
  const editado = await servico.update(admin(), criado.id, { cidade: 'Teresópolis', empresa: 'Força Digital Renomeada' });
  assert.equal(editado.cidade, 'Teresópolis');
  assert.equal(editado.empresaNomeNormalizado, 'forca digital renomeada');
  const erro = await erroDe(() => servico.update(admin(), criado.id, { ativo: false }));
  assert.equal(erro.code, 'EXCLUSION_INVALID_INPUT', 'ativo não é um campo de update — só deactivate/activate mudam isso');
});

test('[EXCL-SVC-11] update de um id inexistente -> EXCLUSION_NOT_FOUND', async () => {
  const servico = criarServico();
  const erro = await erroDe(() => servico.update(admin(), 'nao-existe', { cidade: 'x' }));
  assert.equal(erro.code, 'EXCLUSION_NOT_FOUND');
});

test('[EXCL-SVC-12] deactivate/activate: NUNCA apagam a linha — reativar preserva criadoEm/criadoPor (histórico)', async () => {
  const servico = criarServico();
  const criado = await servico.create(admin(), forcaDigital);
  const desativado = await servico.deactivate(admin(), criado.id);
  assert.equal(desativado.ativo, false);
  const reativado = await servico.activate(admin(), criado.id);
  assert.equal(reativado.ativo, true);
  assert.equal(reativado.criadoEm, criado.criadoEm);
  assert.equal(reativado.criadoPorUserId, criado.criadoPorUserId);
});

test('[EXCL-SVC-13] deactivate/activate de um id inexistente -> EXCLUSION_NOT_FOUND', async () => {
  const servico = criarServico();
  assert.equal((await erroDe(() => servico.deactivate(admin(), 'nao-existe'))).code, 'EXCLUSION_NOT_FOUND');
  assert.equal((await erroDe(() => servico.activate(admin(), 'nao-existe'))).code, 'EXCLUSION_NOT_FOUND');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// isExcluded — a checagem AUTOMÁTICA (sem autorização própria)
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-SVC-14] isExcluded NÃO exige nenhum AuthorizationContext (checagem interna de sistema) — devolve a exclusão que bateu, com o motivo', async () => {
  const servico = criarServico();
  await servico.create(admin(), forcaDigital);
  const resultado = await servico.isExcluded({ empresa: 'força digital', cidade: 'Petrópolis', estado: 'RJ' });
  assert.notEqual(resultado, false);
  assert.equal(resultado.motivo, 'Exclusão permanente de prospecção');
});

test('[EXCL-SVC-15] isExcluded: empresa DIFERENTE não é bloqueada; nenhuma correspondência -> false (nunca "liberado" gravado em lugar nenhum)', async () => {
  const servico = criarServico();
  await servico.create(admin(), forcaDigital);
  assert.equal(await servico.isExcluded({ empresa: 'Clínica Alfa', cidade: 'Petrópolis', estado: 'RJ' }), false);
});

test('[EXCL-SVC-16] isExcluded: uma exclusão DESATIVADA nunca bloqueia', async () => {
  const servico = criarServico();
  const criado = await servico.create(admin(), forcaDigital);
  await servico.deactivate(admin(), criado.id);
  assert.equal(await servico.isExcluded({ empresa: 'Força Digital', cidade: 'Petrópolis', estado: 'RJ' }), false);
});

test('[EXCL-SVC-17] isExcluded: nenhuma exclusão cadastrada -> false, sem lançar', async () => {
  const servico = criarServico();
  assert.equal(await servico.isExcluded({ empresa: 'Qualquer Empresa' }), false);
});
