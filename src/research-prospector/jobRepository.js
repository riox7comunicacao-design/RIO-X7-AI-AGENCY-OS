// Repositório de JOBS de prospecção (Fase 2) — mesmo desenho de briefRepository.js: só a PORTA e dois adapters de desenvolvimento
// (memória, arquivo JSON local em data/, fora do Git). Nenhuma tabela do Supabase.
//
// PORTA (síncrona):
//   list()        -> [job, ...]   (cópias)
//   getById(id)   -> job | null   (cópia)
//   save(job)     -> void         (upsert por id — o Service decide criar x atualizar)
//
// O arquivo é lido e reescrito por inteiro de forma ATÔMICA (arquivo temporário + rename) a cada save; num único processo as
// operações são síncronas, então nunca se perde uma atualização por intercalação.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_JOB_PATH = path.join(__dirname, '..', '..', 'data', 'prospecting-jobs.json');
const REQUIRED_JOB_REPOSITORY_METHODS = Object.freeze(['list', 'getById', 'save']);

const clone = (value) => structuredClone(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

const jobError = (message) => new Error(`Job de prospecção: ${message}`);

function assertValidJobRepository(repository) {
  if (!repository || typeof repository !== 'object') throw jobError('repositório inválido: esperava um objeto');
  for (const method of REQUIRED_JOB_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw jobError(`repositório inválido: falta o método ${method}()`);
  }
}

function assertJobToStore(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw jobError('save() exige um job (objeto)');
  if (typeof job.id !== 'string' || job.id.trim() === '') throw jobError('save() exige um job com id');
  if (UNSAFE_IDS.has(job.id)) throw jobError(`id não permitido: ${job.id}`);
}

function createInMemoryJobRepository(initialJobs = []) {
  const jobs = new Map();
  for (const job of initialJobs) {
    assertJobToStore(job);
    jobs.set(job.id, clone(job));
  }
  return {
    list() {
      return [...jobs.values()].map(clone);
    },
    getById(id) {
      const job = typeof id === 'string' ? jobs.get(id) : undefined;
      return job ? clone(job) : null;
    },
    save(job) {
      assertJobToStore(job);
      jobs.set(job.id, clone(job));
    },
  };
}

function readJobFile(filePath) {
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
    throw jobError(`arquivo de jobs corrompido (JSON inválido) em ${filePath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw jobError(`arquivo de jobs corrompido (estrutura inválida, esperava um objeto) em ${filePath}`);
  const safe = Object.create(null);
  for (const key of Object.keys(parsed)) safe[key] = parsed[key];
  return safe;
}

function writeJobFileAtomic(filePath, data) {
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

function createJsonFileJobRepository(filePath = DEFAULT_JOB_PATH) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) throw jobError('createJsonFileJobRepository exige um filePath (texto não vazio)');
  return {
    list() {
      return Object.values(readJobFile(filePath)).map(clone);
    },
    getById(id) {
      const data = readJobFile(filePath);
      return typeof id === 'string' && hasOwn(data, id) ? clone(data[id]) : null;
    },
    save(job) {
      assertJobToStore(job);
      const data = readJobFile(filePath);
      data[job.id] = clone(job);
      writeJobFileAtomic(filePath, data);
    },
  };
}

module.exports = { DEFAULT_JOB_PATH, REQUIRED_JOB_REPOSITORY_METHODS, assertValidJobRepository, createInMemoryJobRepository, createJsonFileJobRepository };
