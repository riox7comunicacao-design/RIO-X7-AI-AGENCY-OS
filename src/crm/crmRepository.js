// Adapters do repositório do CRM — as implementações de DESENVOLVIMENTO/TESTE da PORTA de persistência (decisão 0012,
// seção "princípio de persistência desacoplada"). O contrato — { list, getById, save } e a checagem
// assertValidRepository — vive em crmRepositoryPort.js, sem `fs` e sem nenhum adapter; este arquivo o reexporta
// para quem já importa daqui. O domínio (crmDomain.js) nunca importa `fs` nem qualquer SDK de banco: ele só chama
// os três métodos, em QUALQUER repositório que os implemente. Uma implementação futura sobre Supabase/Postgres (NÃO
// decidida, NÃO implementada — ver decisões 0012 e 0014) precisa satisfazer o mesmo contrato, que é síncrono nesta
// versão (ver o cabeçalho de crmRepositoryPort.js).
//
// As duas implementações abaixo são as ÚNICAS, ambas de desenvolvimento/teste:
//   - createInMemoryCrmRepository(): só memória, para testes — nunca toca em disco.
//   - createJsonFileCrmRepository(filePath): um arquivo JSON local, mesmo padrão de escrita
//     atômica de approvalQueue.js (arquivo temporário no mesmo diretório + fsync + rename), para
//     que uma interrupção do processo nunca deixe o arquivo truncado. NÃO é a persistência
//     definitiva de produção (decisão 0012) — é o adapter de desenvolvimento local.

const fs = require('node:fs');
const path = require('node:path');

const { REQUIRED_REPOSITORY_METHODS, assertValidRepository } = require('./crmRepositoryPort');

const clone = (value) => (value === undefined ? value : structuredClone(value));

// Nomes que nunca podem ser um id de registro: num objeto comum, "__proto__" como CHAVE não cria
// uma propriedade própria — reatribui o protótipo do objeto (o mesmo tipo de risco já documentado
// para queue.items[id] em approvalQueue.js). Bloqueado explicitamente aqui, e o armazenamento em
// disco usa um objeto SEM protótipo (Object.create(null)) como segunda camada de defesa.
const UNSAFE_RECORD_IDS = new Set(['__proto__', 'constructor', 'prototype']);
function assertSafeRecordId(id) {
  if (UNSAFE_RECORD_IDS.has(id)) {
    throw new Error(`CRM: id de registro não permitido: ${id}`);
  }
}

// Repositório em memória — para testes (e, futuramente, qualquer chamador que não precise de
// persistência entre processos). Nunca escreve em disco. Devolve e recebe sempre CÓPIAS: quem
// consome não pode mutar o estado interno do repositório sem passar por save().
function createInMemoryCrmRepository(initialRecords = []) {
  const records = new Map();
  for (const record of initialRecords) {
    if (!record || typeof record.id !== 'string' || !record.id) {
      throw new Error('CRM: registro inicial inválido — esperava um objeto com id');
    }
    records.set(record.id, clone(record));
  }
  return {
    list() {
      return [...records.values()].map(clone);
    },
    getById(id) {
      const record = records.get(id);
      return record ? clone(record) : null;
    },
    save(record) {
      if (!record || typeof record.id !== 'string' || !record.id) {
        throw new Error('CRM: save() exige um registro com id');
      }
      assertSafeRecordId(record.id);
      records.set(record.id, clone(record));
    },
  };
}

function readJsonFile(filePath) {
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
    throw new Error(`CRM: arquivo de dados corrompido (JSON inválido) em ${filePath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`CRM: arquivo de dados corrompido (estrutura inválida, esperava um objeto) em ${filePath}`);
  }
  // Objeto SEM protótipo: uma chave "__proto__" vinda do arquivo (ou escrita a seguir) fica como
  // propriedade própria comum, nunca reatribui o protótipo deste objeto de trabalho.
  const safe = Object.create(null);
  for (const key of Object.keys(parsed)) safe[key] = parsed[key];
  return safe;
}

// Escrita atômica: arquivo temporário no mesmo diretório, fsync, e só então rename — mesmo
// padrão de approvalQueue.saveQueueToDisk (uma interrupção no meio nunca deixa o arquivo final
// truncado ou parcialmente escrito).
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
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // arquivo temporário pode nunca ter sido criado — nada a limpar.
    }
    throw err;
  }
}

// Repositório em arquivo JSON local — o adapter de desenvolvimento. `filePath` ausente vira fila
// vazia (ENOENT), nunca um erro; um arquivo existente e corrompido sempre lança (nunca mascara
// corrupção como "vazio"). Cada operação relê e regrava o arquivo inteiro — aceitável para o
// volume de dados desta etapa; não é a persistência de produção (ver cabeçalho e decisão 0012).
function createJsonFileCrmRepository(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('CRM: createJsonFileCrmRepository exige um filePath (texto não vazio)');
  }
  return {
    list() {
      return Object.values(readJsonFile(filePath)).map(clone);
    },
    getById(id) {
      const data = readJsonFile(filePath);
      return Object.prototype.hasOwnProperty.call(data, id) ? clone(data[id]) : null;
    },
    save(record) {
      if (!record || typeof record.id !== 'string' || !record.id) {
        throw new Error('CRM: save() exige um registro com id');
      }
      assertSafeRecordId(record.id);
      const data = readJsonFile(filePath);
      data[record.id] = clone(record);
      writeJsonFileAtomic(filePath, data);
    },
  };
}

module.exports = {
  REQUIRED_REPOSITORY_METHODS,
  assertValidRepository,
  createInMemoryCrmRepository,
  createJsonFileCrmRepository,
};
