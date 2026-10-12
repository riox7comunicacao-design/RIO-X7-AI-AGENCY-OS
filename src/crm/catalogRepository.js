// Adapters de DESENVOLVIMENTO/TESTE da porta de catálogos (catalogRepositoryPort.js): memória e arquivo JSON local — o mesmo par de
// crmRepository.js e funnelRepository.js. O adapter de PRODUÇÃO é o Postgres/Supabase (src/crm-adapters/crmSupabaseCatalogRepository.js);
// quem decide entre os dois é a fábrica src/services/catalogRepositoryFactory.js, por REPOSITORY_MODE.
//
// Os dois compartilham a MESMA lógica (createCatalogRepositoryOver) sobre um "armazém" { load, save }: o de memória guarda o objeto
// na própria instância; o de arquivo relê o disco a cada operação e grava de forma ATÔMICA (arquivo temporário, fsync, rename).
//
// FORMATO DO ARQUIVO: { "version": 1, "servicos": { "<id>": item }, "nichos": { ... }, "origens": { ... } }. Um arquivo ausente é um
// armazém vazio; um arquivo que não é JSON, ou cuja estrutura não é essa, FALHA FECHADO (nunca é "consertado" em silêncio).
//
// A unicidade de `nomeNormalizado` (ativos e desativados) é imposta AQUI também — o mesmo contrato do índice único do Postgres —,
// então o domínio se comporta igual sobre qualquer adapter. Dentro de um processo, as escritas são serializadas pelo domínio; entre
// processos o arquivo não tem trava (limite já documentado para o CRM local).

const fs = require('node:fs');
const path = require('node:path');

const { CATALOG_KEYS, CATALOG_DEFINITIONS } = require('./catalogConstants');
const { CATALOG_REPOSITORY_ERROR, COMMON_UPDATABLE_FIELDS, assertValidCatalogRepository, repositoryError, REQUIRED_CATALOG_REPOSITORY_METHODS } = require('./catalogRepositoryPort');

const clone = (value) => structuredClone(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// A mesma defesa de crmRepository.js: um id herdado do protótipo do Object nunca é um id de armazenamento.
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function emptyData() {
  return { version: 1, servicos: Object.create(null), nichos: Object.create(null), origens: Object.create(null) };
}

function requireCatalog(catalog) {
  if (typeof catalog !== 'string' || !CATALOG_KEYS.includes(catalog)) throw new Error(`Cadastro: catálogo desconhecido: ${String(catalog)}`);
  return CATALOG_DEFINITIONS[catalog];
}

function requireId(id) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('Cadastro: id deve ser um texto não vazio');
  if (UNSAFE_IDS.has(id)) throw new Error(`Cadastro: id não permitido: ${id}`);
  return id;
}

// A lógica comum. `load()` devolve os dados (um objeto { servicos, nichos, origens } de objetos sem protótipo) e `save(data)` os
// persiste; operações de leitura só chamam load().
function createCatalogRepositoryOver({ load, save }) {
  const hasName = (group, nomeNormalizado, exceptId) => Object.values(group).some((item) => item.nomeNormalizado === nomeNormalizado && item.id !== exceptId);

  return {
    list(catalog) {
      requireCatalog(catalog);
      return Object.values(load()[catalog]).map(clone);
    },
    getById(catalog, id) {
      requireCatalog(catalog);
      requireId(id);
      const group = load()[catalog];
      return hasOwn(group, id) ? clone(group[id]) : null;
    },
    insert(catalog, item) {
      const definition = requireCatalog(catalog);
      if (!isPlainObject(item)) throw new Error('Cadastro: insert() exige um item (objeto)');
      requireId(item.id);
      if (!item.id.startsWith(`${definition.idPrefix}:`)) throw new Error(`Cadastro: o id de um item de ${catalog} deve começar com "${definition.idPrefix}:"`);
      if (typeof item.nomeNormalizado !== 'string' || item.nomeNormalizado.trim() === '') throw new Error('Cadastro: insert() exige nomeNormalizado (texto não vazio)');
      const data = load();
      if (hasOwn(data[catalog], item.id)) throw new Error('Cadastro: já existe um item com este id');
      if (hasName(data[catalog], item.nomeNormalizado, null)) {
        throw repositoryError(CATALOG_REPOSITORY_ERROR.DUPLICATE_NAME, 'Cadastro: já existe um item com este nome (mesmo desativado).');
      }
      data[catalog][item.id] = clone(item);
      save(data);
      return clone(item);
    },
    update(catalog, id, patch) {
      const definition = requireCatalog(catalog);
      requireId(id);
      if (!isPlainObject(patch)) throw new Error('Cadastro: update() exige um patch (objeto)');
      const updatable = [...COMMON_UPDATABLE_FIELDS, ...definition.specificFields];
      const unknown = Object.keys(patch).filter((key) => !updatable.includes(key));
      if (unknown.length > 0) throw new Error(`Cadastro: update() recebeu campos que não podem ser alterados: ${unknown.join(', ')}`);
      const data = load();
      if (!hasOwn(data[catalog], id)) return null;
      if (hasOwn(patch, 'nomeNormalizado') && hasName(data[catalog], patch.nomeNormalizado, id)) {
        throw repositoryError(CATALOG_REPOSITORY_ERROR.DUPLICATE_NAME, 'Cadastro: já existe um item com este nome (mesmo desativado).');
      }
      data[catalog][id] = { ...data[catalog][id], ...clone(patch) };
      save(data);
      return clone(data[catalog][id]);
    },
    reorder(catalog, orderedIds, meta) {
      requireCatalog(catalog);
      if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) throw new Error('Cadastro: reorder() exige uma lista de ids (texto)');
      const data = load();
      if (orderedIds.some((id) => UNSAFE_IDS.has(id) || !hasOwn(data[catalog], id))) {
        throw repositoryError(CATALOG_REPOSITORY_ERROR.NOT_FOUND, 'Cadastro: item não encontrado na reordenação.');
      }
      let changed = false;
      orderedIds.forEach((id, position) => {
        if (data[catalog][id].ordem === position) return;
        data[catalog][id] = { ...data[catalog][id], ordem: position, ...(isPlainObject(meta) ? clone(meta) : {}) };
        changed = true;
      });
      if (changed) save(data);
    },
  };
}

function createInMemoryCatalogRepository() {
  const data = emptyData();
  return createCatalogRepositoryOver({ load: () => data, save: () => {} });
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyData();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cadastro: arquivo de dados corrompido (JSON inválido) em ${filePath}: ${error.message}`);
  }
  if (!isPlainObject(parsed) || !CATALOG_KEYS.every((key) => isPlainObject(parsed[key]))) {
    throw new Error(`Cadastro: arquivo de dados corrompido (estrutura inválida, esperava { servicos, nichos, origens }) em ${filePath}`);
  }
  const data = emptyData();
  for (const key of CATALOG_KEYS) {
    for (const id of Object.keys(parsed[key])) {
      if (UNSAFE_IDS.has(id) || !isPlainObject(parsed[key][id])) throw new Error(`Cadastro: arquivo de dados corrompido (item inválido em ${key}) em ${filePath}`);
      data[key][id] = parsed[key][id];
    }
  }
  return data;
}

// Mesmo padrão de escrita atômica de crmRepository.js/funnelRepository.js: arquivo temporário no mesmo diretório, fsync, rename.
function writeJsonFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(data, null, 2);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // o temporário pode nunca ter sido criado — nada a limpar.
    }
    throw error;
  }
}

function createJsonFileCatalogRepository(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('Cadastro: createJsonFileCatalogRepository exige um filePath (texto não vazio)');
  }
  return createCatalogRepositoryOver({ load: () => readJsonFile(filePath), save: (data) => writeJsonFileAtomic(filePath, data) });
}

module.exports = { REQUIRED_CATALOG_REPOSITORY_METHODS, assertValidCatalogRepository, createInMemoryCatalogRepository, createJsonFileCatalogRepository };
