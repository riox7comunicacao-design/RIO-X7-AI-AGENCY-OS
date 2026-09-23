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

// Lê uma opção/meta SÓ se for propriedade PRÓPRIA do objeto. Ler `options.status` direto também lê o que estiver
// no protótipo: com um Object.prototype poluído (por um bug em qualquer outra parte do processo), status inicial,
// actor, reviewedBy e motivo — a trilha de AUDITORIA — seriam escolhidos por quem poluiu. Aqui nada herdado conta.
const ownOption = (options, key) => (isPlainObject(options) && Object.prototype.hasOwnProperty.call(options, key) ? options[key] : undefined);

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
  // Um registro sem histórico (armazenamento adulterado) nunca é "consertado" em silêncio com um histórico novo:
  // isso apagaria a auditoria. Falha fechada.
  if (!Array.isArray(record.historico)) {
    throw new Error(`CRM: registro corrompido em ${context} — histórico ausente ou inválido`);
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
  // SEM protótipo: ler um campo que o chamador não enviou (`fields.telefone`) devolve undefined, nunca o que um
  // Object.prototype poluído tenha definido com esse nome.
  const sanitized = Object.create(null);
  for (const field of CRM_WRITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      const value = input[field];
      if (!isValidFieldValue(field, value)) {
        const esperado = NUMERIC_FIELDS.includes(field) ? 'um número (>= 0) ou null' : 'um texto ou null';
        throw new Error(`CRM: ${context} — campo "${field}" deve ser ${esperado}`);
      }
      sanitized[field] = typeof value === 'string' ? trimmedOrNull(value) : value;
    }
  }
  return sanitized;
}

// Espaços nas pontas de um texto nunca são dado: "  site.example.test  " guardado assim NÃO seria reconhecido
// como o mesmo site (a normalização de domínio falha com espaços) e contornaria deduplicação e DO NOT CONTACT.
// Só as pontas são removidas — o conteúdo do texto não é alterado — e um texto que fica vazio vira null, o mesmo
// valor de "campo ausente" (é assim que se limpa um campo).
function trimmedOrNull(value) {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Os campos que entram nas chaves de identidade (research-prospector/normalize.js, identityKeys): mudar qualquer
// um deles muda QUEM o registro é, para efeito de duplicidade e de DO NOT CONTACT.
const IDENTITY_FIELDS = Object.freeze(['empresa', 'site', 'telefone', 'whatsapp', 'instagram', 'cidade']);

// Um registro pode ter DOIS números (telefone e whatsapp), mas identityKeys() considera só um deles
// (`telefone || whatsapp`): o mesmo número guardado no campo "errado" passaria despercebido — inclusive num DO NOT
// CONTACT ("trocar de canal" nunca pode contornar o bloqueio). Aqui cada número vira uma "visão" própria do
// registro, e as funções compartilhadas (checkDuplicate/checkDoNotContact) comparam cada visão. A lógica de
// COMPARAÇÃO continua sendo a delas, sem cópia: este módulo só decide o que apresentar a elas.
function identityViews(record) {
  const base = { empresa: record.empresa, site: record.site, instagram: record.instagram, cidade: record.cidade };
  const numeros = [...new Set([record.telefone, record.whatsapp].filter((numero) => typeof numero === 'string' && numero.trim() !== ''))];
  if (numeros.length === 0) return [{ ...base, telefone: null, whatsapp: null }];
  return numeros.map((numero) => ({ ...base, telefone: numero, whatsapp: null }));
}

// Compara a identidade de `candidate` com a de cada registro de `others`. Devolve
//   { dnc: <registro bloqueado que casa> | null, duplicidade: { status, matchedOn, matchedRecord } | null }
// onde `duplicidade` é DUPLICADO (identidade forte idêntica), POSSIVEL_DUPLICADO (só nome+cidade) ou null.
// matchedRecord é sempre o registro ORIGINAL de `others`, nunca uma visão.
function checkIdentity(candidate, others) {
  const views = others.flatMap((record) =>
    identityViews(record).map((view) => ({ ...view, id: record.id, doNotContact: record.status === CRM_STATUS.DO_NOT_CONTACT }))
  );
  const originalOf = (view) => others.find((record) => record.id === view.id);

  for (const candidateView of identityViews(candidate)) {
    const dnc = checkDoNotContact(candidateView, views);
    if (dnc.doNotContact) return { dnc: originalOf(dnc.matchedRecord), duplicidade: null };
  }
  let possivel = null;
  for (const candidateView of identityViews(candidate)) {
    const found = checkDuplicate(candidateView, views);
    if (found.status === DUPLICATE_STATUS.DUPLICADO) {
      return { dnc: null, duplicidade: { status: found.status, matchedOn: found.matchedOn, matchedRecord: originalOf(found.matchedRecord) } };
    }
    if (found.status === DUPLICATE_STATUS.POSSIVEL_DUPLICADO && possivel === null) {
      possivel = { status: found.status, matchedOn: found.matchedOn, matchedRecord: originalOf(found.matchedRecord) };
    }
  }
  return { dnc: null, duplicidade: possivel };
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

  const requestedStatus = ownOption(options, 'status');
  const status = requestedStatus === undefined ? CRM_STATUS.PROSPECT : requestedStatus;
  if (!Object.values(CRM_STATUS).includes(status)) {
    throw new Error(`CRM: status desconhecido: ${status}`);
  }

  const { dnc, duplicidade } = checkIdentity(fields, repository.list());
  if (dnc) {
    throw new Error(`CRM: não é possível criar — identidade já bloqueada como DO_NOT_CONTACT (registro existente: ${dnc.id})`);
  }
  if (duplicidade && duplicidade.status === DUPLICATE_STATUS.DUPLICADO) {
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
    historico: [{ timestamp: now, from: null, to: status, actor: requireActor(ownOption(options, 'actor')), reviewedBy: ownOption(options, 'reviewedBy') || null, motivo: ownOption(options, 'motivo') || null }],
  };
  repository.save(record);
  return { record: structuredClone(record), duplicidade: duplicidade && duplicidade.status === DUPLICATE_STATUS.POSSIVEL_DUPLICADO ? duplicidade : null };
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
//
// EDITAR A IDENTIDADE também é entrar no CRM: se a atualização muda um campo de identidade (empresa, site,
// telefone, whatsapp, instagram, cidade), as MESMAS regras da criação valem — a nova identidade não pode coincidir
// com a de um registro bloqueado (DO_NOT_CONTACT) nem com a de outro registro (identidade forte idêntica). Sem isso,
// bastaria editar o site de um lead ativo para o de um bloqueado para contornar a barreira. Um match só por
// nome+cidade (POSSIVEL_DUPLICADO) não bloqueia, como na criação. `empresa` nunca fica vazia.
function updateRecord(repository, id, patch) {
  requireRepository(repository);
  const record = requireRecord(repository, id);
  if (record.status === CRM_STATUS.DO_NOT_CONTACT) {
    throw new Error(`CRM: registro bloqueado (DO_NOT_CONTACT) não pode ser atualizado: ${id}`);
  }
  const fields = sanitizeWritableInput(patch, { context: 'updateRecord' });
  const updated = { ...record, ...fields };
  if (!isNonEmptyString(updated.empresa)) {
    throw new Error('CRM: updateRecord não pode deixar "empresa" vazia');
  }
  const identityChanged = IDENTITY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(fields, field) && fields[field] !== record[field]);
  if (identityChanged) {
    const { dnc, duplicidade } = checkIdentity(updated, repository.list().filter((other) => other.id !== record.id));
    if (dnc) {
      throw new Error(`CRM: não é possível atualizar — a nova identidade coincide com a de um registro bloqueado como DO_NOT_CONTACT (registro existente: ${dnc.id})`);
    }
    if (duplicidade && duplicidade.status === DUPLICATE_STATUS.DUPLICADO) {
      throw new Error(
        `CRM: não é possível atualizar — a nova identidade coincide com a de outro registro (${duplicidade.matchedOn.join(', ')}): ${duplicidade.matchedRecord.id}`
      );
    }
  }
  repository.save(updated);
  return structuredClone(updated);
}

// Só uma transição que a tabela de fato lista, para um status que é PROPRIEDADE PRÓPRIA dela: um status herdado do
// protótipo do Object ("constructor", "__proto__", "toString"), vindo de um registro adulterado no armazenamento,
// nunca é tratado como uma entrada da tabela — é só uma transição não permitida, com a mensagem de sempre.
function assertTransitionAllowed(from, to) {
  const allowed = Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, from) ? ALLOWED_TRANSITIONS[from] : [];
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
    historico: [...record.historico, { timestamp, from: record.status, to, actor: requireActor(ownOption(meta, 'actor')), reviewedBy: ownOption(meta, 'reviewedBy') || null, motivo: ownOption(meta, 'motivo') || null }],
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
