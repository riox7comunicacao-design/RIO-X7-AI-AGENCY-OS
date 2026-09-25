// Repositório de LOTES de prospecção — a PORTA de persistência e dois adapters de desenvolvimento.
//
// O lote é uma entidade SEPARADA da Approval Queue: a fila guarda os prospects (um item por identidade); o lote guarda o resultado
// de UMA submissão de prospecção (o briefing, quem submeteu, as contagens e os ids dos prospects). Nenhum campo de lote entra no
// schema dos itens da fila. Mesmo padrão de src/crm/crmRepository.js: o serviço só chama os métodos da porta, em QUALQUER
// repositório que os implemente; trocar a persistência (Supabase/Postgres — candidato, NÃO decidido) é criar outro adapter.
//
// PORTA (síncrona, como as demais desta versão):
//   list()        -> [lote, ...]           (cópias)
//   getById(id)   -> lote | null           (cópia)
//   add(lote)     -> void                  (recusa um loteId que já existe: nunca sobrescreve — erro com code BATCH_CONFLICT)
//
// O lote guardado é sempre uma CÓPIA (quem consome nunca muta o estado interno). Adapter de arquivo: um JSON local
// (data/prospecting-batches.json por padrão, fora do Git), escrita ATÔMICA no mesmo padrão de approvalQueue.saveQueueToDisk
// (arquivo temporário no mesmo diretório + fsync + rename); ENOENT é coleção vazia; arquivo existente e inválido LANÇA (nunca
// mascara corrupção como "vazio"); o caminho é escolhido por quem compõe — nunca por uma requisição. SEM trava entre processos
// (mesmo limite da fila e do CRM: um servidor por pasta de dados).

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BATCH_PATH = path.join(__dirname, '..', '..', 'data', 'prospecting-batches.json');
const REQUIRED_BATCH_REPOSITORY_METHODS = Object.freeze(['list', 'getById', 'add']);
const BATCH_ID_PATTERN = /^lote:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const clone = (value) => structuredClone(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function batchError(message, code) {
  const error = new Error(`Lote: ${message}`);
  if (code) error.code = code;
  return error;
}

// O contrato do repositório é verificado na CRIAÇÃO do serviço (falha fechada: uma dependência incompleta falha logo).
function assertValidBatchRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new Error('repositório de lotes inválido: esperava um objeto');
  for (const method of REQUIRED_BATCH_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw new Error(`repositório de lotes inválido: falta o método ${method}()`);
  }
}

// O id do lote é um valor que o SERVIÇO gera (lote:<uuid>). Qualquer outra forma — inclusive "__proto__" — nunca é gravada.
function assertBatchToStore(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) throw batchError('add() exige um lote (objeto)');
  if (typeof batch.loteId !== 'string' || !BATCH_ID_PATTERN.test(batch.loteId)) throw batchError('add() exige um lote com loteId no formato lote:<uuid>');
}

function createInMemoryBatchRepository(initialBatches = []) {
  const batches = new Map();
  for (const batch of initialBatches) {
    assertBatchToStore(batch);
    batches.set(batch.loteId, clone(batch));
  }
  return {
    list() {
      return [...batches.values()].map(clone);
    },
    getById(id) {
      const batch = typeof id === 'string' ? batches.get(id) : undefined;
      return batch ? clone(batch) : null;
    },
    add(batch) {
      assertBatchToStore(batch);
      if (batches.has(batch.loteId)) throw batchError(`o lote ${batch.loteId} já existe`, 'BATCH_CONFLICT');
      batches.set(batch.loteId, clone(batch));
    },
  };
}

function readBatchFile(filePath) {
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
    throw batchError(`arquivo de lotes corrompido (JSON inválido) em ${filePath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw batchError(`arquivo de lotes corrompido (estrutura inválida, esperava um objeto) em ${filePath}`);
  }
  // Objeto SEM protótipo: uma chave "__proto__" vinda do arquivo fica como propriedade própria comum.
  const safe = Object.create(null);
  for (const key of Object.keys(parsed)) safe[key] = parsed[key];
  return safe;
}

// Escrita atômica (mesmo padrão de approvalQueue.saveQueueToDisk e de crmRepository): temporário + fsync + rename.
function writeBatchFileAtomic(filePath, data) {
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

// filePath: o arquivo JSON dos lotes — escolhido por quem compõe (a composição), nunca por uma requisição.
function createJsonFileBatchRepository(filePath = DEFAULT_BATCH_PATH) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw batchError('createJsonFileBatchRepository exige um filePath (texto não vazio)');
  }
  return {
    list() {
      return Object.values(readBatchFile(filePath)).map(clone);
    },
    getById(id) {
      const data = readBatchFile(filePath);
      return typeof id === 'string' && hasOwn(data, id) ? clone(data[id]) : null;
    },
    add(batch) {
      assertBatchToStore(batch);
      const data = readBatchFile(filePath);
      if (hasOwn(data, batch.loteId)) throw batchError(`o lote ${batch.loteId} já existe`, 'BATCH_CONFLICT');
      data[batch.loteId] = clone(batch);
      writeBatchFileAtomic(filePath, data);
    },
  };
}

module.exports = {
  DEFAULT_BATCH_PATH,
  BATCH_ID_PATTERN,
  REQUIRED_BATCH_REPOSITORY_METHODS,
  assertValidBatchRepository,
  createInMemoryBatchRepository,
  createJsonFileBatchRepository,
};
