// Catalog Service — a fronteira de APLICAÇÃO dos catálogos do CRM: Serviços, Nichos e Origens dos Leads (CRM 5.0, Fase 2B-1,
// decisão 0026). Mesmo desenho de crmService.js e funnelService.js: o domínio (src/crm/catalogDomain.js) continua dono das regras
// (normalização, unicidade, validação, ordem, ativação); o Service SÓ autoriza, escolhe a visão de cada papel e traz a única
// informação que o domínio não tem — se um item é USADO pelo CRM legado.
//
// AUTORIZAÇÃO — por operação, decidida pelo autorizador INJETADO (produção: src/auth/catalogBridge.js) e em nenhum outro lugar
// (tabela PERMISSION_FOR abaixo). SEMPRE ANTES de validar a entrada ou tocar a persistência:
//   READ:CRM             list (só ativos), get (só ativos)           — ADMIN e COMMERCIAL_CLOSER
//   MANAGE:CRM_CATALOGS  create, update, activate, deactivate, reorder, list com inativos (listInactive), get de inativo + `emUso` — só ADMIN
// Quem só tem READ nunca vê um item DESATIVADO (para ele, não existe: 404) nem os campos de auditoria (quem criou/alterou).
//
// UMA CAMADA DE AUTORIZAÇÃO: o domínio não tem autorizador (mesmo princípio do CRM) — por isso só src/services o importa (R12).
//
// RESTRIÇÃO TEMPORÁRIA DE RENOMEAÇÃO (decisão D3): os campos `nicho`, `origem` e `servicoPotencial` do registro do CRM continuam
// TEXTO (estrutura legada) e guardam o NOME do item. Renomear um item que algum registro usa soltaria esses registros dele — então o
// Service pergunta, por `countUsage(catalogo, item)`, quantos registros usam o item e, se houver algum, o domínio recusa a mudança do
// nome (as demais edições, a ativação e a ordem seguem livres). `countUsage` é uma FUNÇÃO injetada (nunca o CRM Service nem o
// repositório inteiro: este módulo não conhece o CRM — mesmo desenho de `hasActiveFunnelCards` em crmService.js), obrigatória: sem
// ela o Service não existe. Se a contagem FALHAR, a renomeação é recusada (falha fechada — nunca "na dúvida, deixa").
//
// NADA DISTO LIGA OS CATÁLOGOS AO CRM: este Service nunca lê nem grava um registro do CRM, e o CRM Service, a promoção e a
// prospecção nunca o chamam.

const catalogDomainDefault = require('../crm/catalogDomain');
const { CatalogError } = require('../crm/catalogDomain');
const { assertValidCatalogRepository } = require('../crm/catalogRepositoryPort');
const { CATALOG_DEFINITIONS, COMMON_ITEM_FIELDS, CATALOG_ERROR } = require('../crm/catalogConstants');
const { PERMISSION } = require('../auth');

const READ = PERMISSION.READ_CRM;
const MANAGE = PERMISSION.MANAGE_CRM_CATALOGS;

// A permissão exigida por cada operação — decidida aqui e em nenhum outro lugar.
const PERMISSION_FOR = Object.freeze({
  list: READ,
  listInactive: MANAGE,
  get: READ,
  create: MANAGE,
  update: MANAGE,
  activate: MANAGE,
  deactivate: MANAGE,
  reorder: MANAGE,
});

// Os campos de AUDITORIA (quem criou/alterou): só quem administra os vê.
const AUDIT_FIELDS = Object.freeze(['criadoPorUserId', 'criadoPorNome', 'atualizadoPorUserId', 'atualizadoPorNome']);

const REQUIRED_DOMAIN_FUNCTIONS = Object.freeze(['listItems', 'getItem', 'createItem', 'updateItem', 'setItemActive', 'reorderItems']);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// A identidade que o autorizador devolve: exatamente { userId, name, role }, textos não vazios, síncrona (nunca uma Promise).
function assertIdentity(identity) {
  if (!isPlainObject(identity) || typeof identity.then === 'function') {
    throw new Error('autorização recusada: o autorizador (catálogos do CRM) não devolveu a identidade do usuário');
  }
  const keys = Object.keys(identity);
  if (keys.length !== 3 || !['userId', 'name', 'role'].every((key) => typeof identity[key] === 'string' && identity[key].trim() !== '')) {
    throw new Error('autorização recusada: o autorizador (catálogos do CRM) devolveu uma identidade inválida');
  }
  return { userId: identity.userId.trim(), name: identity.name.trim(), role: identity.role.trim() };
}

function requireCatalogKey(catalogKey) {
  if (typeof catalogKey !== 'string' || !hasOwn(CATALOG_DEFINITIONS, catalogKey)) {
    throw new CatalogError(CATALOG_ERROR.INVALID_INPUT, 'Cadastro: catálogo desconhecido.', { errors: [{ path: 'catalogo', code: 'CATALOGO_INVALIDO' }] });
  }
  return catalogKey;
}

// A projeção de um item para o consumidor: só os campos conhecidos do catálogo, nunca um objeto vivo do armazenamento. Quem não
// administra não recebe os campos de auditoria.
function project(catalogKey, item, { manager, emUso }) {
  const fields = [...COMMON_ITEM_FIELDS, ...CATALOG_DEFINITIONS[catalogKey].specificFields].filter((field) => manager || !AUDIT_FIELDS.includes(field));
  const projected = {};
  for (const field of fields) projected[field] = hasOwn(item, field) && item[field] !== undefined ? item[field] : null;
  if (emUso !== undefined) projected.emUso = emUso;
  return projected;
}

// dependencies:
//   authorizeOperation(context, permission) -> { userId, name, role } — OBRIGATÓRIA (produção: authorizeCatalogOperation).
//   repository — OBRIGATÓRIA: a porta de src/crm/catalogRepositoryPort.js.
//   countUsage(catalogo, item) -> número de registros do CRM que usam o item (síncrona ou assíncrona) — OBRIGATÓRIA.
//   catalog — o domínio (padrão: o real). now — relógio injetável (testes).
function createCatalogService(dependencies) {
  const { catalog = catalogDomainDefault, authorizeOperation, repository, countUsage, now } = dependencies || {};

  if (typeof authorizeOperation !== 'function') {
    throw new Error('createCatalogService exige { authorizeOperation } (função): sem autorizador injetado o Service não existe');
  }
  if (repository === undefined || repository === null) throw new Error('createCatalogService exige { repository } (a porta de persistência dos catálogos)');
  assertValidCatalogRepository(repository);
  if (typeof countUsage !== 'function') {
    throw new Error('createCatalogService exige { countUsage } (função): a renomeação de um item usado pelo CRM legado é recusada');
  }
  if (typeof catalog !== 'object' || catalog === null) throw new Error('createCatalogService: a dependência catalog deve ser o domínio dos catálogos');
  for (const name of REQUIRED_DOMAIN_FUNCTIONS) {
    if (typeof catalog[name] !== 'function') throw new Error(`createCatalogService: a dependência catalog não tem a função ${name}()`);
  }
  if (now !== undefined && typeof now !== 'function') throw new Error('createCatalogService: now deve ser uma função');
  const options = now === undefined ? {} : { now };

  function authorize(context, operation) {
    return assertIdentity(authorizeOperation(context, PERMISSION_FOR[operation]));
  }

  // Esta conta também administra? (usado para escolher a visão; a autorização de uma operação de ESCRITA nunca passa por aqui.)
  function canManage(context) {
    try {
      authorizeOperation(context, MANAGE);
      return true;
    } catch {
      return false;
    }
  }

  // Quantos registros do CRM usam o item. Falha fechada: uma contagem que falha ou volta estranha é uma falha de armazenamento.
  async function usageOf(catalogKey, item) {
    let count;
    try {
      count = await countUsage(catalogKey, structuredClone(item));
    } catch {
      throw new CatalogError(CATALOG_ERROR.PERSISTENCE, 'Cadastro: não foi possível verificar o uso do item.');
    }
    if (!Number.isInteger(count) || count < 0) throw new CatalogError(CATALOG_ERROR.PERSISTENCE, 'Cadastro: não foi possível verificar o uso do item.');
    return count;
  }

  // Lista os itens. Padrão: só os ATIVOS (READ:CRM). { incluirInativos: true } exige MANAGE:CRM_CATALOGS.
  async function list(context, catalogKey, listOptions) {
    authorize(context, 'list');
    let includeInactive = false;
    if (listOptions !== undefined && listOptions !== null) {
      if (!isPlainObject(listOptions) || Object.keys(listOptions).some((key) => key !== 'incluirInativos')) {
        throw new CatalogError(CATALOG_ERROR.INVALID_INPUT, 'Cadastro: opções de listagem inválidas.', { errors: [{ path: 'opcoes', code: 'CAMPO_DESCONHECIDO' }] });
      }
      if (hasOwn(listOptions, 'incluirInativos')) {
        if (typeof listOptions.incluirInativos !== 'boolean') {
          throw new CatalogError(CATALOG_ERROR.INVALID_INPUT, 'Cadastro: opções de listagem inválidas.', { errors: [{ path: 'incluirInativos', code: 'TIPO_INVALIDO' }] });
        }
        includeInactive = listOptions.incluirInativos;
      }
    }
    if (includeInactive) authorize(context, 'listInactive'); // ver os desativados é uma visão administrativa
    const key = requireCatalogKey(catalogKey);
    const items = await catalog.listItems(repository, key, { onlyActive: !includeInactive });
    const manager = includeInactive || canManage(context);
    return items.map((item) => project(key, item, { manager }));
  }

  // Um item. Para quem só lê, um item desativado "não existe". Quem administra recebe também `emUso`.
  async function get(context, catalogKey, id) {
    authorize(context, 'get');
    const key = requireCatalogKey(catalogKey);
    const item = await catalog.getItem(repository, key, id);
    const manager = canManage(context);
    if (!item || (item.ativo !== true && !manager)) throw new CatalogError(CATALOG_ERROR.NOT_FOUND, 'Cadastro: item não encontrado.');
    let emUso;
    if (manager) {
      try {
        emUso = await usageOf(key, item);
      } catch {
        emUso = null; // desconhecido (nunca um 0 inventado): a consulta continua útil
      }
    }
    return project(key, item, { manager, emUso });
  }

  async function create(context, catalogKey, input) {
    const operator = authorize(context, 'create');
    const key = requireCatalogKey(catalogKey);
    const created = await catalog.createItem(repository, key, input, operator, options);
    return project(key, created, { manager: true });
  }

  async function update(context, catalogKey, id, patch) {
    const operator = authorize(context, 'update');
    const key = requireCatalogKey(catalogKey);
    // Só se pergunta o uso quando a edição PODE mudar o nome (o domínio ignora um nome igual ao atual).
    let nameLocked = false;
    if (isPlainObject(patch) && hasOwn(patch, 'nome') && typeof patch.nome === 'string') {
      const current = await catalog.getItem(repository, key, id);
      if (current) nameLocked = (await usageOf(key, current)) > 0;
    }
    const updated = await catalog.updateItem(repository, key, id, patch, operator, { ...options, nameLocked });
    return project(key, updated, { manager: true });
  }

  async function setActive(context, operation, catalogKey, id, ativo) {
    const operator = authorize(context, operation);
    const key = requireCatalogKey(catalogKey);
    const updated = await catalog.setItemActive(repository, key, id, ativo, operator, options);
    return project(key, updated, { manager: true });
  }

  const activate = (context, catalogKey, id) => setActive(context, 'activate', catalogKey, id, true);
  const deactivate = (context, catalogKey, id) => setActive(context, 'deactivate', catalogKey, id, false);

  async function reorder(context, catalogKey, orderedIds) {
    const operator = authorize(context, 'reorder');
    const key = requireCatalogKey(catalogKey);
    const items = await catalog.reorderItems(repository, key, orderedIds, operator, options);
    return items.map((item) => project(key, item, { manager: true }));
  }

  return Object.freeze({ list, get, create, update, activate, deactivate, reorder });
}

module.exports = { createCatalogService, PERMISSION_FOR, AUDIT_FIELDS };
