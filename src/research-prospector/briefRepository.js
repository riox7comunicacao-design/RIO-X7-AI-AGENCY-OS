// Repositório de BRIEFS de prospecção (Etapa "Prospecção 1") — mesmo desenho de batchRepository.js/funnelRepository.js:
// só a PORTA e dois adapters de desenvolvimento (memória, arquivo JSON local). O brief é o RASCUNHO/workbench de
// ANTES da pesquisa (id amigável PROS-YYYYMMDD-NNN); o LOTE real (lote:<uuid>, com achados e contagens) continua
// sendo o de src/research-prospector/batchRepository.js — o brief só guarda uma referência (`loteRealId`) depois
// que a ingestão de achados cria o lote de verdade. Nenhum dado de CRM, fila ou lote é duplicado aqui.
//
// PORTA (síncrona):
//   list()        -> [brief, ...]   (cópias)
//   getById(id)   -> brief | null   (cópia)
//   save(brief)   -> void           (upsert por id — nunca recusa por já existir: o Service é quem decide criar x atualizar)

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BRIEF_PATH = path.join(__dirname, '..', '..', 'data', 'prospecting-briefs.json');
const REQUIRED_BRIEF_REPOSITORY_METHODS = Object.freeze(['list', 'getById', 'save']);

const clone = (value) => structuredClone(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function briefError(message) {
  return new Error(`Brief: ${message}`);
}

function assertValidBriefRepository(repository) {
  if (!repository || typeof repository !== 'object') throw briefError('repositório inválido: esperava um objeto');
  for (const method of REQUIRED_BRIEF_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw briefError(`repositório inválido: falta o método ${method}()`);
  }
}

function assertBriefToStore(brief) {
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) throw briefError('save() exige um brief (objeto)');
  if (typeof brief.id !== 'string' || brief.id.trim() === '') throw briefError('save() exige um brief com id');
  if (UNSAFE_IDS.has(brief.id)) throw briefError(`id não permitido: ${brief.id}`);
}

function createInMemoryBriefRepository(initialBriefs = []) {
  const briefs = new Map();
  for (const brief of initialBriefs) {
    assertBriefToStore(brief);
    briefs.set(brief.id, clone(brief));
  }
  return {
    list() {
      return [...briefs.values()].map(clone);
    },
    getById(id) {
      const brief = typeof id === 'string' ? briefs.get(id) : undefined;
      return brief ? clone(brief) : null;
    },
    save(brief) {
      assertBriefToStore(brief);
      briefs.set(brief.id, clone(brief));
    },
  };
}

function readBriefFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return Object.create(null);
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw briefError(`arquivo de briefs corrompido (JSON inválido) em ${filePath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw briefError(`arquivo de briefs corrompido (estrutura inválida, esperava um objeto) em ${filePath}`);
  }
  const safe = Object.create(null);
  for (const key of Object.keys(parsed)) safe[key] = parsed[key];
  return safe;
}

function writeBriefFileAtomic(filePath, data) {
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
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // o temporário pode nunca ter sido criado — nada a limpar.
    }
    throw err;
  }
}

function createJsonFileBriefRepository(filePath = DEFAULT_BRIEF_PATH) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) throw briefError('createJsonFileBriefRepository exige um filePath (texto não vazio)');
  return {
    list() {
      return Object.values(readBriefFile(filePath)).map(clone);
    },
    getById(id) {
      const data = readBriefFile(filePath);
      return typeof id === 'string' && hasOwn(data, id) ? clone(data[id]) : null;
    },
    save(brief) {
      assertBriefToStore(brief);
      const data = readBriefFile(filePath);
      data[brief.id] = clone(brief);
      writeBriefFileAtomic(filePath, data);
    },
  };
}

module.exports = {
  DEFAULT_BRIEF_PATH,
  REQUIRED_BRIEF_REPOSITORY_METHODS,
  assertValidBriefRepository,
  createInMemoryBriefRepository,
  createJsonFileBriefRepository,
};
