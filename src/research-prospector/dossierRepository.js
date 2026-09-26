// Repositório de DOSSIÊS de pesquisa — a PORTA de persistência e dois adapters de desenvolvimento (decisão 0018).
//
// Mesmo padrão de batchRepository.js (e de src/crm/crmRepository.js): o serviço/consumidor só chama os métodos da porta, em QUALQUER
// repositório que os implemente; trocar a persistência (Supabase/Postgres — candidato, NÃO decidido) é criar outro adapter.
//
// PORTA (síncrona, como as demais desta versão):
//   list()        -> [dossiê, ...]            (cópias, na ordem de gravação)
//   getById(id)   -> dossiê | null            (cópia)
//   save(dossiê)  -> void                     (INSERE: recusa um dossierId que já existe com DOSSIER_CONFLICT — nunca sobrescreve nada)
//
// O dossiê guardado é sempre uma CÓPIA; quem consome nunca muta o estado interno. O dossierId é gerado pelo domínio (dossie:<uuid>); qualquer
// outra forma — inclusive "__proto__", "constructor" ou um caminho — nunca é gravada, nunca vira chave de arquivo e nunca é usada como caminho
// (o único caminho é o do arquivo, escolhido por quem compõe). Adapter de arquivo: um JSON local (data/prospecting-dossiers.json por padrão,
// fora do Git), escrita ATÔMICA (temporário no mesmo diretório + fsync + rename), ENOENT é coleção vazia, arquivo existente e inválido LANÇA
// (nunca mascara corrupção como "vazio"), objeto SEM protótipo ao ler (uma chave "__proto__" do arquivo é dado comum). SEM trava entre
// processos (mesmo limite da fila, do CRM e dos lotes: um servidor por pasta de dados).
//
// Este módulo NÃO importa o CRM, a fila nem o serviço de prospecção: o dossiê é independente.

const fs = require('node:fs');
const path = require('node:path');

const { DOSSIER_ID_PATTERN } = require('./dossier');

const DEFAULT_DOSSIER_PATH = path.join(__dirname, '..', '..', 'data', 'prospecting-dossiers.json');
const REQUIRED_DOSSIER_REPOSITORY_METHODS = Object.freeze(['list', 'getById', 'save']);

const clone = (value) => structuredClone(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const isDossierId = (id) => typeof id === 'string' && DOSSIER_ID_PATTERN.test(id);

function dossierError(message, code) {
  const error = new Error(`Dossiê: ${message}`);
  if (code) error.code = code;
  return error;
}

function assertValidDossierRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new Error('repositório de dossiês inválido: esperava um objeto');
  for (const method of REQUIRED_DOSSIER_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw new Error(`repositório de dossiês inválido: falta o método ${method}()`);
  }
}

function assertDossierToStore(dossier) {
  if (!dossier || typeof dossier !== 'object' || Array.isArray(dossier)) throw dossierError('save() exige um dossiê (objeto)');
  if (typeof dossier.dossierId !== 'string' || !DOSSIER_ID_PATTERN.test(dossier.dossierId)) throw dossierError('save() exige um dossiê com dossierId no formato dossie:<uuid>');
}

function createInMemoryDossierRepository(initialDossiers = []) {
  const dossiers = new Map();
  for (const dossier of initialDossiers) {
    assertDossierToStore(dossier);
    dossiers.set(dossier.dossierId, clone(dossier));
  }
  return {
    list() {
      return [...dossiers.values()].map(clone);
    },
    getById(id) {
      const dossier = isDossierId(id) ? dossiers.get(id) : undefined;
      return dossier ? clone(dossier) : null;
    },
    save(dossier) {
      assertDossierToStore(dossier);
      if (dossiers.has(dossier.dossierId)) throw dossierError(`o dossiê ${dossier.dossierId} já existe`, 'DOSSIER_CONFLICT');
      dossiers.set(dossier.dossierId, clone(dossier));
    },
  };
}

function readDossierFile(filePath) {
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
    throw dossierError(`arquivo de dossiês corrompido (JSON inválido) em ${filePath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw dossierError(`arquivo de dossiês corrompido (estrutura inválida, esperava um objeto) em ${filePath}`);
  }
  const safe = Object.create(null);
  for (const key of Object.keys(parsed)) safe[key] = parsed[key];
  return safe;
}

function writeDossierFileAtomic(filePath, data) {
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

// filePath: o arquivo JSON dos dossiês — escolhido por quem compõe (nunca por uma requisição nem por um dado do dossiê).
function createJsonFileDossierRepository(filePath = DEFAULT_DOSSIER_PATH) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw dossierError('createJsonFileDossierRepository exige um filePath (texto não vazio)');
  }
  return {
    list() {
      return Object.values(readDossierFile(filePath)).map(clone);
    },
    getById(id) {
      const data = readDossierFile(filePath);
      return isDossierId(id) && hasOwn(data, id) ? clone(data[id]) : null;
    },
    save(dossier) {
      assertDossierToStore(dossier);
      const data = readDossierFile(filePath);
      if (hasOwn(data, dossier.dossierId)) throw dossierError(`o dossiê ${dossier.dossierId} já existe`, 'DOSSIER_CONFLICT');
      data[dossier.dossierId] = clone(dossier);
      writeDossierFileAtomic(filePath, data);
    },
  };
}

module.exports = {
  DEFAULT_DOSSIER_PATH,
  REQUIRED_DOSSIER_REPOSITORY_METHODS,
  assertValidDossierRepository,
  createInMemoryDossierRepository,
  createJsonFileDossierRepository,
};
