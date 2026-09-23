// CRM Domain — o Pipeline Comercial operacional do Rio X7 AI Agency OS (decisão 0012:
// docs/decisions/0012-crm-operational-source-of-truth.md substitui o Notion como fonte de verdade
// deste domínio).
//
// Este módulo é PURO: nenhum I/O, nenhuma dependência de auth, servidor, Notion ou qualquer SDK
// externo. Toda persistência entra por injeção, através de um repositório que satisfaz o contrato
// de crmRepository.js — { list(), getById(id), save(record) }. Trocar o repositório (memória,
// arquivo JSON, futuramente um banco) nunca exige mudar uma linha deste arquivo.
//
// LIMITE HONESTO desta etapa (CRM-DOMAIN): este módulo NÃO decide autorização — não sabe o que é
// um AuthorizationContext, ROLE ou PERMISSION, e não deveria (CRM Domain não pode importar
// src/auth). `actor`/`reviewedBy`/`motivo` são só DADOS que o chamador fornece para o histórico;
// o domínio os registra, mas não os verifica contra nada. Isso é seguro SÓ enquanto o único
// chamador em produção for o futuro CRM Service, que autoriza ANTES de chamar estas funções e
// nunca repassa um valor de reviewedBy vindo do consumidor/rede — exatamente como
// approvalQueueService.js já faz para a Approval Queue. Nenhum consumidor deve chamar este módulo
// diretamente sem essa camada de autorização na frente.
//
// DEDUPLICAÇÃO E DNC: reaproveitados de research-prospector/duplicateCheck.js e
// research-prospector/doNotContact.js, sem reimplementar a lógica de comparação — os registros de
// CRM já usam os mesmos nomes de campo (empresa, site, telefone, whatsapp, instagram, cidade) que
// essas funções esperam.

const crypto = require('node:crypto');

const { checkDuplicate } = require('../research-prospector/duplicateCheck');
const { checkDoNotContact } = require('../research-prospector/doNotContact');
const { DUPLICATE_STATUS } = require('../research-prospector/constants');
const { CRM_STATUS, ALLOWED_TRANSITIONS, ACTOR, CRM_WRITABLE_FIELDS, CRM_MANAGED_FIELDS } = require('./constants');

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Únicos campos com tipo numérico (valores monetários) — todos os demais campos graváveis são
// texto ou null. Nenhum outro campo numérico foi inventado; se um dia precisar de mais, a lista
// muda aqui, de forma explícita.
const NUMERIC_FIELDS = Object.freeze(['valorProposta', 'valorTotal']);
function isValidFieldValue(field, value) {
  if (value === null) return true;
  if (NUMERIC_FIELDS.includes(field)) return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return typeof value === 'string';
}

// Um registro de CRM só existe através de createRecord/moveStatus/updateRecord — nunca aceite um
// objeto solto vindo de fora como se já fosse um registro válido.
function assertRecordShape(record, context) {
  if (!isPlainObject(record) || !isNonEmptyString(record.id)) {
    throw new Error(`CRM: registro inválido em ${context} — esperava um objeto com id`);
  }
}

function requireRepository(repository) {
  if (!repository || typeof repository.list !== 'function' || typeof repository.getById !== 'function' || typeof repository.save !== 'function') {
    throw new Error('CRM: repositório inválido — esperava { list, getById, save }');
  }
  return repository;
}

function requireActor(actor) {
  if (actor !== undefined && !Object.values(ACTOR).includes(actor)) {
    throw new Error(`CRM: actor desconhecido: ${actor}`);
  }
  return actor || ACTOR.HUMAN;
}

function requireRecordId(id) {
  if (!isNonEmptyString(id)) {
    throw new Error('CRM: id deve ser um texto não vazio');
  }
  return id;
}

function requireRecord(repository, id) {
  const record = repository.getById(requireRecordId(id));
  if (!record) {
    throw new Error(`CRM: registro não encontrado: ${id}`);
  }
  assertRecordShape(record, 'requireRecord');
  return record;
}

// Só os campos aceitos (seção "Modelo CRM" da etapa) — qualquer outro é recusado. Nenhum valor é
// adivinhado: campo ausente vira null, nunca um valor inferido (mesmo princípio de candidate.js).
function sanitizeWritableInput(input, { context }) {
  if (!isPlainObject(input)) {
    throw new Error(`CRM: ${context} deve ser um objeto`);
  }
  const unknown = Object.keys(input).filter((key) => !CRM_WRITABLE_FIELDS.includes(key));
  const managed = Object.keys(input).filter((key) => CRM_MANAGED_FIELDS.includes(key));
  if (managed.length > 0) {
    throw new Error(`CRM: ${context} não aceita campos gerenciados pelo domínio: ${managed.join(', ')}`);
  }
  if (unknown.length > 0) {
    throw new Error(`CRM: ${context} tem campos desconhecidos: ${unknown.join(', ')}`);
  }
  const sanitized = {};
  for (const field of CRM_WRITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      const value = input[field];
      if (!isValidFieldValue(field, value)) {
        const esperado = NUMERIC_FIELDS.includes(field) ? 'um número (>= 0) ou null' : 'um texto ou null';
        throw new Error(`CRM: ${context} — campo "${field}" deve ser ${esperado}`);
      }
      sanitized[field] = value === undefined ? null : value;
    }
  }
  return sanitized;
}

// ID estável por identidade, na mesma ordem de prioridade oficial (domínio → telefone →
// Instagram → nome+cidade) usada em duplicateCheck.js/approvalQueue.js — mas só como valor
// LEGÍVEL de depuração dentro de um id opaco; a IDENTIDADE de fato (para decidir duplicidade)
// nunca é o id, é sempre checkDuplicate/checkDoNotContact. Um registro de CRM pode nascer sem
// nenhum critério forte de identidade (ex.: só nome da empresa) — nesse caso o id é só um UUID.
function buildRecordId() {
  return `crm:${crypto.randomUUID()}`;
}

// Cria um registro novo. Recusa (fail closed) se:
//   - já existe um registro BLOQUEADO (status DO_NOT_CONTACT) com a mesma identidade — nunca cria
//     uma entrada nova "por baixo" de um bloqueio existente;
//   - já existe um registro com identidade FORTE idêntica (domínio/telefone/Instagram) — status
//     DUPLICADO do checkDuplicate.
// Um match só por nome+cidade (POSSIVEL_DUPLICADO) NUNCA bloqueia a criação — só é informado no
// retorno, para o chamador (futuro Service/UI) alertar um humano. Preferir falso negativo a falso
// positivo, como pedido explicitamente para este domínio.
function createRecord(repository, input, options = {}) {
  requireRepository(repository);
  const fields = sanitizeWritableInput(input, { context: 'createRecord' });
  if (!isNonEmptyString(fields.empresa)) {
    throw new Error('CRM: createRecord exige "empresa" (texto não vazio)');
  }

  const status = options.status === undefined ? CRM_STATUS.PROSPECT : options.status;
  if (!Object.values(CRM_STATUS).includes(status)) {
    throw new Error(`CRM: status desconhecido: ${status}`);
  }

  const existentes = repository.list();
  const candidato = { empresa: fields.empresa, site: fields.site, telefone: fields.telefone, whatsapp: fields.whatsapp, instagram: fields.instagram, cidade: fields.cidade };

  const dnc = checkDoNotContact(candidato, existentes.map((r) => ({ ...r, doNotContact: r.status === CRM_STATUS.DO_NOT_CONTACT })));
  if (dnc.doNotContact) {
    throw new Error(`CRM: não é possível criar — identidade já bloqueada como DO_NOT_CONTACT (registro existente: ${dnc.matchedRecord.id})`);
  }

  const duplicidade = checkDuplicate(candidato, existentes);
  if (duplicidade.status === DUPLICATE_STATUS.DUPLICADO) {
    throw new Error(
      `CRM: não é possível criar — já existe um registro com a mesma identidade (${duplicidade.matchedOn.join(', ')}): ${duplicidade.matchedRecord.id}`
    );
  }

  const now = new Date().toISOString();
  const record = {
    id: buildRecordId(),
    ...Object.fromEntries(CRM_WRITABLE_FIELDS.map((field) => [field, fields[field] ?? null])),
    status,
    dataDeEntrada: now,
    historico: [{ timestamp: now, from: null, to: status, actor: requireActor(options.actor), reviewedBy: options.reviewedBy || null, motivo: options.motivo || null }],
  };
  repository.save(record);
  return { record: structuredClone(record), duplicidade: duplicidade.status === DUPLICATE_STATUS.POSSIVEL_DUPLICADO ? duplicidade : null };
}

function getRecord(repository, id) {
  requireRepository(repository);
  const record = repository.getById(requireRecordId(id));
  return record ? structuredClone(record) : null;
}

function listRecords(repository) {
  requireRepository(repository);
  return repository.list().map((record) => structuredClone(record));
}

// Atualiza campos comuns (nunca status/id/historico/dataDeEntrada — esses têm suas próprias
// operações). DO_NOT_CONTACT é terminal também para edição de campos: um registro bloqueado não
// deve ser "atualizado" como se o contato comercial continuasse ativo.
function updateRecord(repository, id, patch) {
  requireRepository(repository);
  const record = requireRecord(repository, id);
  if (record.status === CRM_STATUS.DO_NOT_CONTACT) {
    throw new Error(`CRM: registro bloqueado (DO_NOT_CONTACT) não pode ser atualizado: ${id}`);
  }
  const fields = sanitizeWritableInput(patch, { context: 'updateRecord' });
  const updated = { ...record, ...fields };
  repository.save(updated);
  return structuredClone(updated);
}

function assertTransitionAllowed(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`CRM: transição não permitida: ${from} -> ${to}`);
  }
}

// Move o status, sempre pela máquina de estados (nunca aceita um "to" fora do enum, nunca pula a
// checagem de transição permitida). Gera SEMPRE uma entrada de histórico — nenhuma mudança de
// status é silenciosa. `reviewedBy`/`motivo` são dados de auditoria fornecidos pelo chamador (ver
// o limite honesto no cabeçalho do arquivo).
function moveStatus(repository, id, to, meta = {}) {
  requireRepository(repository);
  if (!Object.values(CRM_STATUS).includes(to)) {
    throw new Error(`CRM: status desconhecido: ${to}`);
  }
  const record = requireRecord(repository, id);
  assertTransitionAllowed(record.status, to);

  const timestamp = new Date().toISOString();
  const updated = {
    ...record,
    status: to,
    historico: [...record.historico, { timestamp, from: record.status, to, actor: requireActor(meta.actor), reviewedBy: meta.reviewedBy || null, motivo: meta.motivo || null }],
  };
  repository.save(updated);
  return structuredClone(updated);
}

// Bloqueia um registro como DO_NOT_CONTACT. É deliberadamente só um atalho nomeado sobre
// moveStatus — existe como operação própria para ficar fácil de testar/autorizar
// separadamente no futuro Service (a barreira de contato é uma decisão diferente de mover o
// funil), não porque a máquina de estados precise de um caminho especial: DNC já é alcançável de
// qualquer status de funil, WON e LOST pela mesma tabela de transições.
function markDoNotContact(repository, id, meta = {}) {
  return moveStatus(repository, id, CRM_STATUS.DO_NOT_CONTACT, meta);
}

module.exports = {
  createRecord,
  getRecord,
  listRecords,
  updateRecord,
  moveStatus,
  markDoNotContact,
};
