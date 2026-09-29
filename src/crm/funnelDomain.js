// Domínio de FUNIS configuráveis (Etapa "Funis 1" da reestruturação Prospecção/CRM/Funis). Regras de negócio
// puras sobre um repositório injetado (funnelRepositoryPort.js) — nunca conhece autorização, HTTP ou um adapter
// específico, mesmo princípio de crmDomain.js. NÃO toca em `status`/`ALLOWED_TRANSITIONS` do CRM (crmDomain.js) —
// Funil é uma camada NOVA e aditiva; a máquina de estados existente continua exatamente como está (decisão da
// etapa: "não quebrar compatibilidade sem necessidade").
//
// UM FUNIL NÃO É SINÔNIMO DE VENDAS: é uma estrutura configurável de processo (Outbound, Onboarding, Renovação,
// Churn, ou qualquer outro que o usuário crie) — nada aqui hardcoda nomes de etapa nem finalidade.
//
// CARDS (vincular um registro do CRM a um funil/etapa, mover, marcar perdido) são a Etapa "Funis 2", ainda não
// implementada: os dois guardas de exclusão abaixo (deleteFunnel/deleteStage) já chamam countCardsByFunnel/
// countCardsByStage do repositório — hoje sempre 0 (ver funnelRepository.js) — para que a etapa seguinte não
// precise mudar esta função, só o resultado da contagem passa a ser real.

const crypto = require('node:crypto');
const { assertValidFunnelRepository } = require('./funnelRepositoryPort');

const isText = (value) => typeof value === 'string';
const trimmedOrNull = (value) => (isText(value) && value.trim() !== '' ? value.trim() : null);

function requireRepository(repository) {
  return assertValidFunnelRepository(repository);
}

function requireId(id, label) {
  if (!isText(id) || id.trim() === '') throw new Error(`Funil: id de ${label} deve ser um texto não vazio`);
  return id;
}

async function requireFunnel(repository, id) {
  const funnel = await repository.getFunnel(requireId(id, 'funil'));
  if (!funnel || typeof funnel !== 'object' || funnel.id !== id) throw new Error(`Funil: funil não encontrado: ${id}`);
  return funnel;
}

async function requireStage(repository, id) {
  const stage = await repository.getStage(requireId(id, 'etapa'));
  if (!stage || typeof stage !== 'object' || stage.id !== id) throw new Error(`Funil: etapa não encontrada: ${id}`);
  return stage;
}

function requireName(name, label) {
  const trimmed = trimmedOrNull(name);
  if (trimmed === null) throw new Error(`Funil: ${label} exige "nome" (texto não vazio)`);
  return trimmed;
}

// ---------------------------------------------------------------------------
// FUNIL
// ---------------------------------------------------------------------------
async function listFunnels(repository) {
  requireRepository(repository);
  const funnels = await repository.listFunnels();
  return [...funnels].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
}

async function getFunnel(repository, id) {
  requireRepository(repository);
  return (await repository.getFunnel(requireId(id, 'funil'))) ?? null;
}

async function createFunnel(repository, fields = {}) {
  requireRepository(repository);
  const nome = requireName(fields.nome, 'criar um funil');
  const existentes = await repository.listFunnels();
  const funnel = {
    id: `funnel:${crypto.randomUUID()}`,
    nome,
    descricao: trimmedOrNull(fields.descricao),
    finalidade: trimmedOrNull(fields.finalidade),
    ativo: true,
    ordem: existentes.length,
    config: fields.config && typeof fields.config === 'object' && !Array.isArray(fields.config) ? structuredClone(fields.config) : {},
    criadoEm: new Date().toISOString(),
  };
  await repository.saveFunnel(funnel);
  return structuredClone(funnel);
}

async function updateFunnel(repository, id, patch = {}) {
  requireRepository(repository);
  const funnel = await requireFunnel(repository, id);
  const next = { ...funnel };
  if (Object.prototype.hasOwnProperty.call(patch, 'nome')) next.nome = requireName(patch.nome, 'editar um funil');
  if (Object.prototype.hasOwnProperty.call(patch, 'descricao')) next.descricao = trimmedOrNull(patch.descricao);
  if (Object.prototype.hasOwnProperty.call(patch, 'finalidade')) next.finalidade = trimmedOrNull(patch.finalidade);
  if (Object.prototype.hasOwnProperty.call(patch, 'ativo')) next.ativo = Boolean(patch.ativo);
  if (Object.prototype.hasOwnProperty.call(patch, 'config') && patch.config && typeof patch.config === 'object' && !Array.isArray(patch.config)) {
    next.config = structuredClone(patch.config);
  }
  await repository.saveFunnel(next);
  return structuredClone(next);
}

// REGRA CRÍTICA (seção 10 do comando de reestruturação): nunca excluir um funil com cards vinculados.
async function deleteFunnel(repository, id) {
  requireRepository(repository);
  const funnel = await requireFunnel(repository, id);
  const cards = await repository.countCardsByFunnel(id);
  if (cards > 0) {
    const err = new Error('Funil: este funil possui cards vinculados e não pode ser excluído');
    err.code = 'FUNNEL_HAS_CARDS';
    throw err;
  }
  for (const stage of await repository.listStages(id)) {
    await repository.deleteStage(stage.id);
  }
  await repository.deleteFunnel(id);
  return structuredClone(funnel);
}

// Clona funil + etapas (novos ids); NUNCA copia cards nem histórico (seção 13) — o novo funil nasce vazio.
async function copyFunnel(repository, id, novoNome) {
  requireRepository(repository);
  const original = await requireFunnel(repository, id);
  const originalStages = await repository.listStages(id);
  const existentes = await repository.listFunnels();
  const copia = {
    id: `funnel:${crypto.randomUUID()}`,
    nome: novoNome !== undefined ? requireName(novoNome, 'copiar um funil') : `${original.nome} (cópia)`,
    descricao: original.descricao,
    finalidade: original.finalidade,
    ativo: true,
    ordem: existentes.length,
    config: structuredClone(original.config ?? {}),
    criadoEm: new Date().toISOString(),
  };
  await repository.saveFunnel(copia);
  const ordenadas = [...originalStages].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
  for (const stage of ordenadas) {
    await repository.saveStage({
      id: `stage:${crypto.randomUUID()}`,
      funnelId: copia.id,
      nome: stage.nome,
      ordem: stage.ordem,
      ativo: stage.ativo,
      config: structuredClone(stage.config ?? {}),
      criadoEm: new Date().toISOString(),
    });
  }
  return structuredClone(copia);
}

async function reorderFunnels(repository, orderedIds) {
  requireRepository(repository);
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => !isText(id))) {
    throw new Error('Funil: reordenar funis exige uma lista de ids (texto)');
  }
  const existentes = await repository.listFunnels();
  const porId = new Map(existentes.map((funnel) => [funnel.id, funnel]));
  if (orderedIds.length !== existentes.length || orderedIds.some((id) => !porId.has(id))) {
    throw new Error('Funil: a lista de reordenação precisa conter exatamente os funis existentes, cada um uma vez');
  }
  for (let ordem = 0; ordem < orderedIds.length; ordem += 1) {
    await repository.saveFunnel({ ...porId.get(orderedIds[ordem]), ordem });
  }
  return listFunnels(repository);
}

// ---------------------------------------------------------------------------
// ETAPA
// ---------------------------------------------------------------------------
async function listStages(repository, funnelId) {
  requireRepository(repository);
  await requireFunnel(repository, funnelId);
  const stages = await repository.listStages(funnelId);
  return [...stages].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
}

async function createStage(repository, funnelId, fields = {}) {
  requireRepository(repository);
  await requireFunnel(repository, funnelId);
  const nome = requireName(fields.nome, 'criar uma etapa');
  const existentes = await repository.listStages(funnelId);
  const stage = {
    id: `stage:${crypto.randomUUID()}`,
    funnelId,
    nome,
    ordem: existentes.length,
    ativo: true,
    config: fields.config && typeof fields.config === 'object' && !Array.isArray(fields.config) ? structuredClone(fields.config) : {},
    criadoEm: new Date().toISOString(),
  };
  await repository.saveStage(stage);
  return structuredClone(stage);
}

async function updateStage(repository, id, patch = {}) {
  requireRepository(repository);
  const stage = await requireStage(repository, id);
  const next = { ...stage };
  if (Object.prototype.hasOwnProperty.call(patch, 'nome')) next.nome = requireName(patch.nome, 'editar uma etapa');
  if (Object.prototype.hasOwnProperty.call(patch, 'ativo')) next.ativo = Boolean(patch.ativo);
  if (Object.prototype.hasOwnProperty.call(patch, 'config') && patch.config && typeof patch.config === 'object' && !Array.isArray(patch.config)) {
    next.config = structuredClone(patch.config);
  }
  await repository.saveStage(next);
  return structuredClone(next);
}

// REGRA CRÍTICA (seção 12): nunca excluir uma etapa com cards vinculados.
async function deleteStage(repository, id) {
  requireRepository(repository);
  const stage = await requireStage(repository, id);
  const cards = await repository.countCardsByStage(id);
  if (cards > 0) {
    const err = new Error('Funil: esta etapa possui cards vinculados e não pode ser excluída');
    err.code = 'STAGE_HAS_CARDS';
    throw err;
  }
  await repository.deleteStage(id);
  return structuredClone(stage);
}

// As etapas são independentes entre funis (seção 11): reordenar só afeta as etapas do MESMO funil informado.
async function reorderStages(repository, funnelId, orderedIds) {
  requireRepository(repository);
  await requireFunnel(repository, funnelId);
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => !isText(id))) {
    throw new Error('Funil: reordenar etapas exige uma lista de ids (texto)');
  }
  const existentes = await repository.listStages(funnelId);
  const porId = new Map(existentes.map((stage) => [stage.id, stage]));
  if (orderedIds.length !== existentes.length || orderedIds.some((id) => !porId.has(id))) {
    throw new Error('Funil: a lista de reordenação precisa conter exatamente as etapas deste funil, cada uma uma vez');
  }
  for (let ordem = 0; ordem < orderedIds.length; ordem += 1) {
    await repository.saveStage({ ...porId.get(orderedIds[ordem]), ordem });
  }
  return listStages(repository, funnelId);
}

module.exports = {
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
};
