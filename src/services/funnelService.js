// Funnel Service — a fronteira de APLICAÇÃO dos Funis configuráveis (reestruturação Prospecção/CRM/Funis).
// Mesmo desenho de crmService.js: o domínio (src/crm/funnelDomain.js) continua dono das regras (guardas de
// exclusão, cópia, reordenação, identidade de card, movimentação); o Service SÓ autoriza e valida a entrada de
// aplicação antes de chamar o domínio.
//
// DUAS PORTAS DE AUTORIZAÇÃO, para duas coisas DIFERENTES (Etapa "Funis 2"):
//   authorizeOperation(context, MANAGE:FUNNELS)  — administrar a ESTRUTURA (funil/etapa): só ADMIN
//     (src/auth/funnelBridge.js).
//   authorizeCrmOperation(context, permissão)    — trabalhar num CARD (é uma ação COMERCIAL sobre um registro
//     do CRM, não uma mudança de estrutura): READ:CRM para ler, PROPOSE:CRM para criar/mover (ADMIN e
//     COMMERCIAL_CLOSER têm as duas — decisão explícita da Etapa "Funis 2": PROPOSE:CRM já existe na matriz e
//     não tinha nenhuma operação real até agora; reaproveitá-la evita criar uma permissão nova só para isto),
//     WRITE:CRM para arquivar um card (só ADMIN — mesmo padrão de "só ADMIN remove cards").
//
// UMA CAMADA DE AUTORIZAÇÃO: o domínio de funil não tem autorizador injetado — mesmo princípio do CRM. Por isso
// só src/services pode importar src/crm (regra R12, reaproveitada de propósito: funil mora dentro de src/crm/).
//
// CARD NUNCA DUPLICA DADOS DO CRM (seção 2 da Etapa "Funis 2"): este Service enriquece cada card com uma
// PROJEÇÃO do registro do CRM (via `crmService.getRecord`, que já autoriza e já sanitiza a saída) só na hora de
// devolver ao consumidor — nunca grava nada do CRM no card. `crmRepository` (a porta bruta, só `getById`) é
// usado só pelo DOMÍNIO, para confirmar que o registro existe antes de criar um card.
const funnelDomainDefault = require('../crm/funnelDomain');
const { assertValidFunnelRepository } = require('../crm/funnelRepositoryPort');
const { PERMISSION } = require('../auth');

const MANAGE = PERMISSION.MANAGE_FUNNELS;
const READ_CRM = PERMISSION.READ_CRM;
const PROPOSE_CRM = PERMISSION.PROPOSE_CRM;
const WRITE_CRM = PERMISSION.WRITE_CRM;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const FUNNEL_FIELD_KEYS = Object.freeze(['nome', 'descricao', 'finalidade', 'ativo', 'config']);
const STAGE_FIELD_KEYS = Object.freeze(['nome', 'ativo', 'config']);
const CREATE_CARD_KEYS = Object.freeze(['crmRecordId', 'reason']);
const MOVE_CARD_KEYS = Object.freeze(['stageId', 'reason']);
// Só os campos comerciais pedidos pela seção 9 da Etapa "Funis 2" — nunca o registro inteiro do CRM.
const CARD_CRM_FIELDS = Object.freeze(['empresa', 'contato', 'status', 'responsavel', 'ultimaInteracao', 'proximaAcao', 'valorProposta', 'valorTotal']);

function pickKnown(input, allowedKeys, label) {
  if (!isPlainObject(input)) throw new Error(`Funil: ${label} deve ser um objeto simples`);
  const unknown = Object.keys(input).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) throw new Error(`Funil: ${label} tem campos desconhecidos: ${unknown.join(', ')}`);
  const picked = {};
  for (const key of allowedKeys) if (hasOwn(input, key)) picked[key] = input[key];
  return picked;
}

function readReason(options) {
  const reason = hasOwn(options, 'reason') ? options.reason : undefined;
  if (reason !== undefined && reason !== null && typeof reason !== 'string') throw new Error('Funil: reason deve ser um texto');
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

// A projeção comercial de um card para exibição (Kanban/detalhe): o card + só os campos do CRM pedidos pela
// seção 9. `crmRecord` pode ser `null` (o registro foi excluído do CRM depois de o card existir — decisão 0025
// permite excluir um registro mesmo com cards ativos; os adapters locais não impedem isso, só a FK do Supabase
// impediria, quando aplicada) — a projeção então devolve `crm: null`, nunca inventa um valor.
function toPublicCard(card, crmRecord) {
  const crm = crmRecord
    ? CARD_CRM_FIELDS.reduce((out, field) => {
        out[field] = hasOwn(crmRecord, field) ? crmRecord[field] : null;
        return out;
      }, {})
    : null;
  return {
    id: card.id,
    funnelId: card.funnelId,
    stageId: card.stageId,
    crmRecordId: card.crmRecordId,
    removedAt: card.removedAt ?? null,
    criadoEm: card.criadoEm,
    updatedAt: card.updatedAt,
    crm,
  };
}

// funnel: o domínio (por padrão, o real). authorizeOperation: MANAGE:FUNNELS (produção: src/auth/funnelBridge.js).
// authorizeCrmOperation: READ/PROPOSE/WRITE:CRM (produção: src/auth/crmBridge.js — a MESMA ponte do CRM Service).
// repository: a porta de persistência de funil. crmRepository: a porta BRUTA do CRM (só getById — usada pelo
// domínio para confirmar que um registro existe antes de criar um card). crmService: o CRM Service já pronto
// (usado só para ENRIQUECER a projeção de um card com dados do registro — nunca para autorizar nada aqui).
function createFunnelService(dependencies) {
  const { funnel = funnelDomainDefault, authorizeOperation, authorizeCrmOperation, repository, crmRepository, crmService } = dependencies || {};

  if (typeof authorizeOperation !== 'function') {
    throw new Error('createFunnelService exige { authorizeOperation } (função): sem autorizador injetado o Service não existe');
  }
  if (typeof authorizeCrmOperation !== 'function') {
    throw new Error('createFunnelService exige { authorizeCrmOperation } (função): operações de card exigem a ponte do CRM');
  }
  if (repository === undefined || repository === null) {
    throw new Error('createFunnelService exige { repository } (a porta de persistência de funil)');
  }
  assertValidFunnelRepository(repository);
  if (typeof funnel !== 'object' || funnel === null) {
    throw new Error('createFunnelService: a dependência funnel deve ser o domínio de Funis');
  }
  for (const name of [
    'listFunnels', 'getFunnel', 'createFunnel', 'updateFunnel', 'deleteFunnel', 'copyFunnel', 'reorderFunnels',
    'listStages', 'createStage', 'updateStage', 'deleteStage', 'reorderStages',
    'createCard', 'getCard', 'listCardsByFunnel', 'moveCard', 'getCardHistory', 'deleteCard',
  ]) {
    if (typeof funnel[name] !== 'function') throw new Error(`createFunnelService: a dependência funnel não tem a função ${name}()`);
  }
  if (!crmRepository || typeof crmRepository.getById !== 'function') {
    throw new Error('createFunnelService exige { crmRepository } (com getById): operações de card confirmam que o registro do CRM existe');
  }
  if (!crmService || typeof crmService.getRecord !== 'function') {
    throw new Error('createFunnelService exige { crmService } (com getRecord): a projeção de um card é enriquecida com dados do CRM');
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
  const domainCreateCard = funnel.createCard;
  const domainGetCard = funnel.getCard;
  const domainListCardsByFunnel = funnel.listCardsByFunnel;
  const domainMoveCard = funnel.moveCard;
  const domainGetCardHistory = funnel.getCardHistory;
  const domainDeleteCard = funnel.deleteCard;

  function authorize(context) {
    authorizeOperation(context, MANAGE);
  }
  // Devolve { userId, name, role } — a MESMA identidade mínima que crmBridge.js já devolve ao CRM Service.
  function authorizeCrm(context, permission) {
    return authorizeCrmOperation(context, permission);
  }

  // Enriquece com o registro do CRM lido pelo MESMO `context` (a identidade autenticada de quem chamou) — nunca
  // uma identidade forjada: se o contexto não pudesse ler o CRM, já teria sido recusado por authorizeCrm() acima,
  // antes de chegar aqui.
  async function enrich(context, card) {
    const record = await crmService.getRecord(context, card.crmRecordId).catch(() => null);
    return toPublicCard(card, record);
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

  // ---- card (Etapa "Funis 2") -----------------------------------------------------------------------------
  async function listCardsByFunnel(context, funnelId) {
    authorizeCrm(context, READ_CRM);
    const cards = await domainListCardsByFunnel(repository, funnelId);
    return Promise.all(cards.map((card) => enrich(context, card)));
  }

  async function getCard(context, id) {
    authorizeCrm(context, READ_CRM);
    const card = await domainGetCard(repository, id);
    return card === null ? null : enrich(context, card);
  }

  async function getCardHistory(context, id) {
    authorizeCrm(context, READ_CRM);
    return domainGetCardHistory(repository, id);
  }

  async function createCard(context, funnelId, options) {
    const operator = authorizeCrm(context, PROPOSE_CRM);
    const picked = pickKnown(options, CREATE_CARD_KEYS, 'criar um card');
    if (!hasOwn(picked, 'crmRecordId')) throw new Error('Funil: criar um card exige "crmRecordId"');
    const card = await domainCreateCard(repository, crmRepository, { funnelId, crmRecordId: picked.crmRecordId }, { reviewedBy: operator, motivo: readReason(picked) });
    return enrich(context, card);
  }

  async function moveCard(context, id, options) {
    const operator = authorizeCrm(context, PROPOSE_CRM);
    const picked = pickKnown(options, MOVE_CARD_KEYS, 'mover um card');
    if (!hasOwn(picked, 'stageId')) throw new Error('Funil: mover um card exige "stageId"');
    const card = await domainMoveCard(repository, id, picked.stageId, { reviewedBy: operator, motivo: readReason(picked) });
    return enrich(context, card);
  }

  // Arquivar (nunca excluir fisicamente — ver funnelDomain.js) é reservado a quem tem WRITE:CRM (hoje só ADMIN),
  // igual à exigência explícita da Etapa "Funis 2": "ADMIN: pode remover cards" (a seção não concede isto ao
  // COMMERCIAL_CLOSER, diferente de criar/mover, que são PROPOSE:CRM).
  async function deleteCard(context, id) {
    authorizeCrm(context, WRITE_CRM);
    await domainDeleteCard(repository, id);
    return { id };
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
    listCardsByFunnel,
    getCard,
    getCardHistory,
    createCard,
    moveCard,
    deleteCard,
  });
}

module.exports = { createFunnelService };
