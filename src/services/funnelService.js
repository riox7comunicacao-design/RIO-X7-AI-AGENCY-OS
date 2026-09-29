// Funnel Service — a fronteira de APLICAÇÃO dos Funis configuráveis (reestruturação Prospecção/CRM/Funis, Etapa
// "Funis 1"). Mesmo desenho de crmService.js: o domínio (src/crm/funnelDomain.js) continua dono das regras
// (guardas de exclusão, cópia, reordenação); o Service SÓ autoriza (MANAGE:FUNNELS, pela ponte injetada —
// src/auth/funnelBridge.js) e valida a entrada de aplicação antes de chamar o domínio.
//
// UMA CAMADA DE AUTORIZAÇÃO: o domínio de funil não tem autorizador injetado — mesmo princípio do CRM (decisão
// 0013/0014). Por isso só src/services pode importar src/crm (regra R12, reaproveitada aqui de propósito: funil
// mora dentro de src/crm/ para não precisar de uma regra de arquitetura nova).
//
// Card (vincular um registro do CRM a um funil/etapa, mover, marcar perdido) é a Etapa "Funis 2" — este Service
// ainda não tem essas operações.

const funnelDomainDefault = require('../crm/funnelDomain');
const { assertValidFunnelRepository } = require('../crm/funnelRepositoryPort');
const { PERMISSION } = require('../auth');

const MANAGE = PERMISSION.MANAGE_FUNNELS;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const FUNNEL_FIELD_KEYS = Object.freeze(['nome', 'descricao', 'finalidade', 'ativo', 'config']);
const STAGE_FIELD_KEYS = Object.freeze(['nome', 'ativo', 'config']);

function pickKnown(input, allowedKeys, label) {
  if (!isPlainObject(input)) throw new Error(`Funil: ${label} deve ser um objeto simples`);
  const unknown = Object.keys(input).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) throw new Error(`Funil: ${label} tem campos desconhecidos: ${unknown.join(', ')}`);
  const picked = {};
  for (const key of allowedKeys) if (hasOwn(input, key)) picked[key] = input[key];
  return picked;
}

// authorizeOperation: a porta de autorização (produção: authorizeFunnelOperation de src/auth). repository: a porta
// de persistência de funil (produção: adapter de arquivo hoje — ver o cabeçalho de funnelRepository.js sobre o
// adapter Supabase, ainda não escrito).
function createFunnelService(dependencies) {
  const { funnel = funnelDomainDefault, authorizeOperation, repository } = dependencies || {};

  if (typeof authorizeOperation !== 'function') {
    throw new Error('createFunnelService exige { authorizeOperation } (função): sem autorizador injetado o Service não existe');
  }
  if (repository === undefined || repository === null) {
    throw new Error('createFunnelService exige { repository } (a porta de persistência de funil)');
  }
  assertValidFunnelRepository(repository);
  if (typeof funnel !== 'object' || funnel === null) {
    throw new Error('createFunnelService: a dependência funnel deve ser o domínio de Funis');
  }
  for (const name of ['listFunnels', 'getFunnel', 'createFunnel', 'updateFunnel', 'deleteFunnel', 'copyFunnel', 'reorderFunnels', 'listStages', 'createStage', 'updateStage', 'deleteStage', 'reorderStages']) {
    if (typeof funnel[name] !== 'function') throw new Error(`createFunnelService: a dependência funnel não tem a função ${name}()`);
  }

  const domainListFunnels = funnel.listFunnels;
  const domainGetFunnel = funnel.getFunnel;
  const domainCreateFunnel = funnel.createFunnel;
  const domainUpdateFunnel = funnel.updateFunnel;
  const domainDeleteFunnel = funnel.deleteFunnel;
  const domainCopyFunnel = funnel.copyFunnel;
  const domainReorderFunnels = funnel.reorderFunnels;
  const domainListStages = funnel.listStages;
  const domainCreateStage = funnel.createStage;
  const domainUpdateStage = funnel.updateStage;
  const domainDeleteStage = funnel.deleteStage;
  const domainReorderStages = funnel.reorderStages;

  function authorize(context) {
    authorizeOperation(context, MANAGE);
  }

  async function listFunnels(context) {
    authorize(context);
    return domainListFunnels(repository);
  }

  async function getFunnel(context, id) {
    authorize(context);
    return domainGetFunnel(repository, id);
  }

  async function createFunnel(context, fields) {
    authorize(context);
    return domainCreateFunnel(repository, pickKnown(fields, FUNNEL_FIELD_KEYS, 'criar um funil'));
  }

  async function updateFunnel(context, id, patch) {
    authorize(context);
    return domainUpdateFunnel(repository, id, pickKnown(patch, FUNNEL_FIELD_KEYS, 'editar um funil'));
  }

  async function deleteFunnel(context, id) {
    authorize(context);
    await domainDeleteFunnel(repository, id);
    return { id };
  }

  async function copyFunnel(context, id, options) {
    authorize(context);
    const picked = pickKnown(options ?? {}, ['nome'], 'copiar um funil');
    return domainCopyFunnel(repository, id, hasOwn(picked, 'nome') ? picked.nome : undefined);
  }

  async function reorderFunnels(context, orderedIds) {
    authorize(context);
    return domainReorderFunnels(repository, orderedIds);
  }

  async function listStages(context, funnelId) {
    authorize(context);
    return domainListStages(repository, funnelId);
  }

  async function createStage(context, funnelId, fields) {
    authorize(context);
    return domainCreateStage(repository, funnelId, pickKnown(fields, STAGE_FIELD_KEYS, 'criar uma etapa'));
  }

  async function updateStage(context, id, patch) {
    authorize(context);
    return domainUpdateStage(repository, id, pickKnown(patch, STAGE_FIELD_KEYS, 'editar uma etapa'));
  }

  async function deleteStage(context, id) {
    authorize(context);
    await domainDeleteStage(repository, id);
    return { id };
  }

  async function reorderStages(context, funnelId, orderedIds) {
    authorize(context);
    return domainReorderStages(repository, funnelId, orderedIds);
  }

  return Object.freeze({
    listFunnels,
    getFunnel,
    createFunnel,
    updateFunnel,
    deleteFunnel,
    copyFunnel,
    reorderFunnels,
    listStages,
    createStage,
    updateStage,
    deleteStage,
    reorderStages,
  });
}

module.exports = { createFunnelService };
