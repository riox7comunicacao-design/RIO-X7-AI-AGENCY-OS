// Domínio dos CATÁLOGOS do CRM — Serviços, Nichos e Origens dos Leads (CRM 5.0, Fase 2B-1, decisão 0026). Regras de negócio PURAS
// sobre um repositório injetado (catalogRepositoryPort.js): nunca conhece autorização, HTTP, Supabase ou arquivo — mesmo princípio de
// crmDomain.js e funnelDomain.js. Quem autoriza é o Catalog Service (src/services/catalogService.js), a ÚNICA camada de autorização
// (regra R12: só src/services importa src/crm). `operator` ({ userId, name }) é só DADO de auditoria que o chamador fornece.
//
// O QUE ESTE DOMÍNIO GARANTE:
//   - IDENTIFICADOR ESTÁVEL: `service:<uuid>` / `niche:<uuid>` / `origin:<uuid>`, gerado aqui, nunca derivado do nome e nunca alterado;
//   - NOME NORMALIZADO ÚNICO: dois itens do MESMO catálogo nunca têm o mesmo `nomeNormalizado` (minúsculas, sem acento, sem pontuação,
//     espaços colapsados) — ATIVOS OU DESATIVADOS. Reativar um item nunca pode colidir com outro;
//   - ATUALIZAÇÃO SEGURA: um PATCH só toca os campos enviados; um valor igual ao atual não grava nada nem muda `atualizadoEm`; `ativo`
//     e `ordem` NUNCA mudam por edição de campos (têm operações próprias: ativar/desativar e reordenar); id, nomes normalizados,
//     datas e responsáveis nunca vêm do chamador;
//   - SEM EXCLUSÃO FÍSICA: não existe operação de apagar (decisão D4). Desativar preserva o item e as referências a ele;
//   - RENOMEAR é recusado enquanto o item for USADO pelo CRM legado (opção `nameLocked`, calculada pelo Service): os campos `nicho`,
//     `origem` e `servicoPotencial` do registro guardam o NOME como texto, e renomear soltaria esses registros do item. É uma restrição
//     TEMPORÁRIA desta fase (decisão D3): quando Clientes e Negociações referenciarem o catálogo por identificador, o nome poderá
//     mudar livremente;
//   - O PREÇO DE REFERÊNCIA (serviços) é só informativo: nenhuma função daqui nem de outro módulo o copia para o valor de uma proposta.
//
// CONCORRÊNCIA: as ESCRITAS de um mesmo repositório rodam UMA POR VEZ dentro do processo (como em crmDomain.js — decisão 0023). A
// proteção entre processos é do armazenamento: no Postgres, um índice ÚNICO em `nome_normalizado` por tabela.

const crypto = require('node:crypto');

const { assertValidCatalogRepository, CATALOG_REPOSITORY_ERROR } = require('./catalogRepositoryPort');
const { CATALOG, CATALOG_DEFINITIONS, LIMITS, BILLING_TYPES, RECURRENCES, LEAD_CHANNELS, NICHE_COLOR_KEYS, CATALOG_ERROR } = require('./catalogConstants');

class CatalogError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const clone = (value) => structuredClone(value);

// ---------------------------------------------------------------------------------------------------------------------------------
// NORMALIZAÇÃO — a chave de unicidade. Minúsculas, sem acento, qualquer sequência fora de [a-z0-9] vira UM espaço, sem espaços nas
// pontas: "Instituições  de Ensino" e "instituicoes de ensino" são o MESMO nome. Limite honesto: letras que não são latinas e símbolos
// não contam (um nome só de símbolos normaliza para vazio e é recusado) e "C#" e "C++" normalizam igual a "C".
// ---------------------------------------------------------------------------------------------------------------------------------
function normalizeCatalogName(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// VALIDAÇÃO — pura; devolve { ok, value, errors } onde errors = [{ path, code }] (só CAMINHO e CÓDIGO, nunca o valor recusado: a
// API devolve esta lista ao navegador, e o Dashboard a traduz em mensagens por campo).
// ---------------------------------------------------------------------------------------------------------------------------------
const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;
const lengthOf = (text) => Array.from(text).length;

// Campos que o chamador NUNCA envia (o domínio os define) — recusados com um código próprio, para a mensagem ser clara.
const NON_EDITABLE_FIELDS = Object.freeze(['id', 'nomeNormalizado', 'ativo', 'ordem', 'criadoEm', 'atualizadoEm', 'criadoPorUserId', 'criadoPorNome', 'atualizadoPorUserId', 'atualizadoPorNome']);
const SAFE_PATH = /^[A-Za-z0-9_]{1,40}$/;

function checkText(value, { max, multiline = false }) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, code: 'TIPO_INVALIDO' };
  const unified = value.replace(/\r\n?/g, '\n');
  const cleaned = multiline ? unified.trim() : unified.replace(/\s+/g, ' ').trim();
  if (cleaned === '') return { ok: true, value: null };
  if (FORBIDDEN_CHARACTERS.test(multiline ? cleaned.replace(/[\n\t]/g, '') : cleaned)) return { ok: false, code: 'CARACTERE_INVALIDO' };
  if (lengthOf(cleaned) > max) return { ok: false, code: 'MUITO_LONGO' };
  return { ok: true, value: cleaned };
}

function checkName(value) {
  if (value === null || value === undefined) return { ok: false, code: 'OBRIGATORIO' };
  if (typeof value !== 'string') return { ok: false, code: 'TIPO_INVALIDO' };
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned === '') return { ok: false, code: 'OBRIGATORIO' };
  if (FORBIDDEN_CHARACTERS.test(cleaned)) return { ok: false, code: 'CARACTERE_INVALIDO' };
  if (lengthOf(cleaned) > LIMITS.NOME) return { ok: false, code: 'MUITO_LONGO' };
  if (normalizeCatalogName(cleaned) === '') return { ok: false, code: 'NOME_SEM_LETRAS' };
  return { ok: true, value: cleaned };
}

function checkEnum(value, allowed) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, code: 'TIPO_INVALIDO' };
  return allowed.includes(value) ? { ok: true, value } : { ok: false, code: 'VALOR_INVALIDO' };
}

// Preço de referência: número >= 0, até o teto, com no MÁXIMO 2 casas (a coluna é NUMERIC(15,2): mais casas seriam arredondadas em
// silêncio). Informativo — nunca vira o valor de uma proposta.
function checkPrice(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, code: 'TIPO_INVALIDO' };
  if (value < 0 || value > LIMITS.PRECO_REFERENCIA_MAXIMO) return { ok: false, code: 'VALOR_FORA_DO_LIMITE' };
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) return { ok: false, code: 'MAIS_DE_DUAS_CASAS' };
  return { ok: true, value: cents / 100 + 0 };
}

const FIELD_CHECKS = Object.freeze({
  nome: checkName,
  descricao: (value) => checkText(value, { max: LIMITS.DESCRICAO, multiline: true }),
  categoria: (value) => checkText(value, { max: LIMITS.CATEGORIA }),
  precoReferencia: checkPrice,
  tipoCobranca: (value) => checkEnum(value, BILLING_TYPES),
  recorrencia: (value) => checkEnum(value, RECURRENCES),
  cor: (value) => checkEnum(value, NICHE_COLOR_KEYS),
  canal: (value) => checkEnum(value, LEAD_CHANNELS),
});

function definitionOf(catalog) {
  if (typeof catalog !== 'string' || !hasOwn(CATALOG_DEFINITIONS, catalog)) {
    throw new CatalogError(CATALOG_ERROR.INVALID_INPUT, 'Cadastro: catálogo desconhecido.', { errors: [{ path: 'catalogo', code: 'CATALOGO_INVALIDO' }] });
  }
  return CATALOG_DEFINITIONS[catalog];
}

// Lê os campos de `input`: só os do catálogo (nome, descricao e os específicos). Devolve { value (sem protótipo), errors }.
function readFields(definition, input, { requireName }) {
  const errors = [];
  const value = Object.create(null);
  if (!isPlainObject(input)) return { value, errors: [{ path: '', code: 'TIPO_INVALIDO' }] };
  const allowed = ['nome', 'descricao', ...definition.specificFields];
  for (const key of Object.keys(input)) {
    if (allowed.includes(key)) continue;
    errors.push({ path: SAFE_PATH.test(key) ? key : '', code: NON_EDITABLE_FIELDS.includes(key) ? 'CAMPO_NAO_EDITAVEL' : 'CAMPO_DESCONHECIDO' });
  }
  for (const key of allowed) {
    if (!hasOwn(input, key)) {
      if (key === 'nome' && requireName) errors.push({ path: 'nome', code: 'OBRIGATORIO' });
      continue;
    }
    const checked = FIELD_CHECKS[key](input[key]);
    if (checked.ok) value[key] = checked.value;
    else errors.push({ path: key, code: checked.code });
  }
  return { value, errors };
}

// Coerência de cobrança dos SERVIÇOS: RECORRENTE exige uma recorrência; UNICA (ou sem tipo) não pode ter uma.
function billingErrors(state) {
  const recurrent = state.tipoCobranca === 'RECORRENTE';
  const hasRecurrence = state.recorrencia !== null && state.recorrencia !== undefined;
  if (recurrent && !hasRecurrence) return [{ path: 'recorrencia', code: 'RECORRENCIA_OBRIGATORIA' }];
  if (!recurrent && hasRecurrence) return [{ path: 'recorrencia', code: 'RECORRENCIA_NAO_PERMITIDA' }];
  return [];
}

// A entrada de CRIAÇÃO: `nome` obrigatório; todo campo opcional ausente vira null. Devolve { ok, value, errors }.
function validateCreateInput(catalog, input) {
  const definition = definitionOf(catalog);
  const { value, errors } = readFields(definition, input, { requireName: true });
  const complete = { nome: value.nome, descricao: value.descricao ?? null };
  for (const field of definition.specificFields) complete[field] = value[field] ?? null;
  if (errors.length === 0 && definition.key === CATALOG.SERVICOS) errors.push(...billingErrors(complete));
  return { ok: errors.length === 0, value: complete, errors };
}

// A entrada de EDIÇÃO (parcial): só os campos enviados; a coerência de cobrança vale para o estado RESULTANTE (o item atual +
// o que foi enviado) — nunca apaga uma recorrência em silêncio. `current` é o item atual.
function validatePatch(catalog, patch, current) {
  const definition = definitionOf(catalog);
  const { value, errors } = readFields(definition, patch, { requireName: false });
  if (errors.length === 0 && Object.keys(value).length === 0) errors.push({ path: '', code: 'NADA_A_ALTERAR' });
  if (errors.length === 0 && definition.key === CATALOG.SERVICOS) {
    const base = isPlainObject(current) ? { tipoCobranca: current.tipoCobranca ?? null, recorrencia: current.recorrencia ?? null } : { tipoCobranca: null, recorrencia: null };
    errors.push(...billingErrors({ ...base, ...value }));
  }
  return { ok: errors.length === 0, value, errors };
}

function invalidInput(errors) {
  const resumo = errors
    .slice(0, 5)
    .map((error) => (error.path ? `${error.path}: ${error.code}` : error.code))
    .join(', ');
  return new CatalogError(CATALOG_ERROR.INVALID_INPUT, `Cadastro: dados inválidos (${resumo}).`, { errors: errors.slice(0, 50) });
}

const notFound = () => new CatalogError(CATALOG_ERROR.NOT_FOUND, 'Cadastro: item não encontrado.');
const duplicateName = () => new CatalogError(CATALOG_ERROR.DUPLICATE_NAME, 'Cadastro: já existe um item com este nome (mesmo desativado).');

// ---------------------------------------------------------------------------------------------------------------------------------
// ACESSO AO REPOSITÓRIO — toda chamada passa por aqui: os códigos do contrato viram erros do domínio e QUALQUER outra falha (rede,
// arquivo corrompido, permissão) vira um erro de armazenamento com mensagem fixa — nunca o texto original, que poderia ecoar
// detalhes de infraestrutura. A causa fica em `cause` (só para o log do servidor; a API nunca a devolve).
// ---------------------------------------------------------------------------------------------------------------------------------
async function viaRepository(task) {
  try {
    return await task();
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code === CATALOG_REPOSITORY_ERROR.DUPLICATE_NAME) throw duplicateName();
    if (code === CATALOG_REPOSITORY_ERROR.NOT_FOUND) throw notFound();
    const failure = new CatalogError(CATALOG_ERROR.PERSISTENCE, 'Cadastro: não foi possível ler ou gravar os dados.');
    failure.cause = error;
    throw failure;
  }
}

function persistenceFailure(message) {
  return new CatalogError(CATALOG_ERROR.PERSISTENCE, `Cadastro: ${message}`);
}

// Um item que o armazenamento devolveu deve ter a forma mínima; senão o armazenamento está corrompido — falha fechada.
function assertItemShape(item, context) {
  if (!isPlainObject(item) || !isNonEmptyString(item.id) || typeof item.nomeNormalizado !== 'string') {
    throw persistenceFailure(`item inválido devolvido pelo armazenamento (${context}).`);
  }
  return item;
}

async function readAll(repository, catalog) {
  const items = await viaRepository(() => repository.list(catalog));
  if (!Array.isArray(items)) throw persistenceFailure('lista inválida devolvida pelo armazenamento.');
  return items.map((item) => assertItemShape(item, 'list'));
}

async function readOne(repository, catalog, id) {
  const item = await viaRepository(() => repository.getById(catalog, id));
  if (item === null || item === undefined) return null;
  return assertItemShape(item, 'getById');
}

// Ordem de exibição: `ordem`, depois o nome normalizado, depois o id (desempate estável, igual para todos os adapters).
function sortItems(items) {
  return [...items].sort((a, b) => {
    const ordemA = Number.isInteger(a.ordem) ? a.ordem : Number.MAX_SAFE_INTEGER;
    const ordemB = Number.isInteger(b.ordem) ? b.ordem : Number.MAX_SAFE_INTEGER;
    if (ordemA !== ordemB) return ordemA - ordemB;
    if (a.nomeNormalizado !== b.nomeNormalizado) return a.nomeNormalizado < b.nomeNormalizado ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function requireOperator(operator) {
  if (!isPlainObject(operator) || !isNonEmptyString(operator.userId) || !isNonEmptyString(operator.name)) {
    throw new Error('Cadastro: operador inválido — esperava { userId, name } (texto não vazio)');
  }
  return { userId: operator.userId.trim(), name: operator.name.trim() };
}

function requireId(id) {
  if (typeof id !== 'string' || id.trim() === '' || id.length > 200) {
    throw new CatalogError(CATALOG_ERROR.INVALID_INPUT, 'Cadastro: identificador inválido.', { errors: [{ path: 'id', code: 'ID_INVALIDO' }] });
  }
  return id;
}

const nowIso = (options) => {
  const now = options && typeof options.now === 'function' ? options.now() : new Date();
  return now.toISOString();
};

// ---------------------------------------------------------------------------------------------------------------------------------
// SERIALIZAÇÃO das ESCRITAS de um mesmo repositório (mesmo mecanismo de crmDomain.js, decisão 0023). Leituras não esperam.
// ---------------------------------------------------------------------------------------------------------------------------------
const writeTails = new WeakMap();
function serialized(repository, task) {
  const run = (writeTails.get(repository) || Promise.resolve()).then(task);
  writeTails.set(
    repository,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// OPERAÇÕES
// ---------------------------------------------------------------------------------------------------------------------------------

// Lista os itens do catálogo na ordem de exibição. `onlyActive`: só os ATIVOS (o que um formulário oferece).
async function listItems(repository, catalog, options = {}) {
  assertValidCatalogRepository(repository);
  definitionOf(catalog);
  const items = sortItems(await readAll(repository, catalog));
  return items.filter((item) => options.onlyActive !== true || item.ativo === true).map(clone);
}

async function getItem(repository, catalog, id) {
  assertValidCatalogRepository(repository);
  definitionOf(catalog);
  const item = await readOne(repository, catalog, requireId(id));
  return item ? clone(item) : null;
}

async function createItemUnlocked(repository, catalog, input, operator, options) {
  const definition = definitionOf(catalog);
  const author = requireOperator(operator);
  const checked = validateCreateInput(catalog, input);
  if (!checked.ok) throw invalidInput(checked.errors);

  const nomeNormalizado = normalizeCatalogName(checked.value.nome);
  const existing = await readAll(repository, catalog);
  if (existing.some((item) => item.nomeNormalizado === nomeNormalizado)) throw duplicateName();
  const ordem = existing.reduce((highest, item) => (Number.isInteger(item.ordem) && item.ordem > highest ? item.ordem : highest), -1) + 1;

  const at = nowIso(options);
  const item = {
    id: `${definition.idPrefix}:${crypto.randomUUID()}`,
    nome: checked.value.nome,
    nomeNormalizado,
    descricao: checked.value.descricao,
    ativo: true,
    ordem,
    ...Object.fromEntries(definition.specificFields.map((field) => [field, checked.value[field]])),
    criadoEm: at,
    atualizadoEm: at,
    criadoPorUserId: author.userId,
    criadoPorNome: author.name,
    atualizadoPorUserId: author.userId,
    atualizadoPorNome: author.name,
  };
  const saved = await viaRepository(() => repository.insert(catalog, item));
  return clone(isPlainObject(saved) ? saved : item);
}

// Edita SÓ os campos enviados em `patch`. options.nameLocked (calculado pelo Service: o item é usado pelo CRM legado) recusa uma
// mudança de `nome`. Um patch cujos valores são iguais aos atuais devolve o item sem gravar.
async function updateItemUnlocked(repository, catalog, id, patch, operator, options) {
  definitionOf(catalog);
  const author = requireOperator(operator);
  const current = await readOne(repository, catalog, requireId(id));
  if (!current) throw notFound();
  const checked = validatePatch(catalog, patch, current);
  if (!checked.ok) throw invalidInput(checked.errors);

  const changes = {};
  for (const [field, value] of Object.entries(checked.value)) {
    if (!Object.is(current[field] ?? null, value)) changes[field] = value;
  }
  if (Object.keys(changes).length === 0) return clone(current);

  if (hasOwn(changes, 'nome')) {
    if (options && options.nameLocked === true) {
      throw new CatalogError(CATALOG_ERROR.NAME_IN_USE, 'Cadastro: este item já é usado em registros do CRM e o nome não pode ser alterado nesta fase.');
    }
    const nomeNormalizado = normalizeCatalogName(changes.nome);
    if (nomeNormalizado !== current.nomeNormalizado) {
      const others = (await readAll(repository, catalog)).filter((item) => item.id !== current.id);
      if (others.some((item) => item.nomeNormalizado === nomeNormalizado)) throw duplicateName();
    }
    changes.nomeNormalizado = nomeNormalizado;
  }

  Object.assign(changes, { atualizadoEm: nowIso(options), atualizadoPorUserId: author.userId, atualizadoPorNome: author.name });
  const updated = await viaRepository(() => repository.update(catalog, current.id, changes));
  if (!isPlainObject(updated)) throw notFound();
  return clone(updated);
}

// Ativa ou desativa. Idempotente: pedir o estado que o item já tem devolve o item sem gravar. Desativar NUNCA mexe nos registros
// do CRM que usam o item — só tira o item das listas de escolha.
async function setItemActiveUnlocked(repository, catalog, id, ativo, operator, options) {
  definitionOf(catalog);
  const author = requireOperator(operator);
  if (typeof ativo !== 'boolean') throw new Error('Cadastro: setItemActive exige um booleano');
  const current = await readOne(repository, catalog, requireId(id));
  if (!current) throw notFound();
  if (current.ativo === ativo) return clone(current);
  const updated = await viaRepository(() =>
    repository.update(catalog, current.id, { ativo, atualizadoEm: nowIso(options), atualizadoPorUserId: author.userId, atualizadoPorNome: author.name })
  );
  if (!isPlainObject(updated)) throw notFound();
  return clone(updated);
}

// Reordena: `orderedIds` precisa ter EXATAMENTE os itens existentes (ativos e desativados), cada um uma vez. A nova ordem é a posição
// na lista (0, 1, 2...).
async function reorderItemsUnlocked(repository, catalog, orderedIds, operator, options) {
  definitionOf(catalog);
  const author = requireOperator(operator);
  const invalidList = () => invalidInput([{ path: 'orderedIds', code: 'LISTA_INVALIDA' }]);
  if (!Array.isArray(orderedIds) || orderedIds.length > 1000 || orderedIds.some((id) => typeof id !== 'string' || id === '' || id.length > 200)) throw invalidList();

  const items = sortItems(await readAll(repository, catalog));
  const wanted = new Set(orderedIds);
  if (wanted.size !== orderedIds.length || orderedIds.length !== items.length || !items.every((item) => wanted.has(item.id))) throw invalidList();

  const unchanged = items.every((item, position) => item.id === orderedIds[position] && item.ordem === position);
  if (!unchanged) {
    await viaRepository(() =>
      repository.reorder(catalog, [...orderedIds], { atualizadoEm: nowIso(options), atualizadoPorUserId: author.userId, atualizadoPorNome: author.name })
    );
  }
  return listItems(repository, catalog);
}

async function createItem(repository, catalog, input, operator, options = {}) {
  assertValidCatalogRepository(repository);
  return serialized(repository, () => createItemUnlocked(repository, catalog, input, operator, options));
}

async function updateItem(repository, catalog, id, patch, operator, options = {}) {
  assertValidCatalogRepository(repository);
  return serialized(repository, () => updateItemUnlocked(repository, catalog, id, patch, operator, options));
}

async function setItemActive(repository, catalog, id, ativo, operator, options = {}) {
  assertValidCatalogRepository(repository);
  return serialized(repository, () => setItemActiveUnlocked(repository, catalog, id, ativo, operator, options));
}

async function reorderItems(repository, catalog, orderedIds, operator, options = {}) {
  assertValidCatalogRepository(repository);
  return serialized(repository, () => reorderItemsUnlocked(repository, catalog, orderedIds, operator, options));
}

module.exports = {
  CatalogError,
  normalizeCatalogName,
  validateCreateInput,
  validatePatch,
  listItems,
  getItem,
  createItem,
  updateItem,
  setItemActive,
  reorderItems,
};
