// Adapters de DESENVOLVIMENTO/TESTE da porta de Funis (Etapa "Funis 1") — mesmo par de sempre (memória, arquivo
// JSON local), mesmo desenho de crmRepository.js. `createJsonFileFunnelRepository(filePath)` grava um ÚNICO
// arquivo (`{ funnels: {...}, stages: {...} }`, escrita atômica) — os cards ainda não existem (Etapa "Funis 2"),
// então `countCardsByFunnel`/`countCardsByStage` sempre devolvem 0 aqui: nenhum destes dois adapters cria card.
// O adapter de produção (Supabase) desta porta é uma etapa futura, documentada mas não escrita ainda — ver a
// migration de Funis (schema completo, incluindo as tabelas de card, para que a etapa seguinte não precise de
// uma migration nova só para os cards).

const fs = require('node:fs');
const path = require('node:path');

const { REQUIRED_FUNNEL_REPOSITORY_METHODS, assertValidFunnelRepository } = require('./funnelRepositoryPort');

const clone = (value) => (value === undefined ? value : structuredClone(value));

// Mesma defesa de crmRepository.js: uma chave "__proto__"/"constructor"/"prototype" nunca é um id de armazenamento.
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
function assertSafeId(id, label) {
  if (UNSAFE_IDS.has(id)) throw new Error(`Funil: id de ${label} não permitido: ${id}`);
}

function createInMemoryFunnelRepository() {
  const funnels = new Map();
  const stages = new Map();
  return {
    listFunnels() {
      return [...funnels.values()].map(clone);
    },
    getFunnel(id) {
      const funnel = funnels.get(id);
      return funnel ? clone(funnel) : null;
    },
    saveFunnel(funnel) {
      if (!funnel || typeof funnel.id !== 'string' || !funnel.id) throw new Error('Funil: saveFunnel() exige um funil com id');
      assertSafeId(funnel.id, 'funil');
      funnels.set(funnel.id, clone(funnel));
    },
    deleteFunnel(id) {
      if (typeof id !== 'string' || !id) throw new Error('Funil: deleteFunnel() exige um id (texto não vazio)');
      assertSafeId(id, 'funil');
      funnels.delete(id);
    },
    listStages(funnelId) {
      return [...stages.values()].filter((stage) => stage.funnelId === funnelId).map(clone);
    },
    getStage(id) {
      const stage = stages.get(id);
      return stage ? clone(stage) : null;
    },
    saveStage(stage) {
      if (!stage || typeof stage.id !== 'string' || !stage.id) throw new Error('Funil: saveStage() exige uma etapa com id');
      assertSafeId(stage.id, 'etapa');
      stages.set(stage.id, clone(stage));
    },
    deleteStage(id) {
      if (typeof id !== 'string' || !id) throw new Error('Funil: deleteStage() exige um id (texto não vazio)');
      assertSafeId(id, 'etapa');
      stages.delete(id);
    },
    // Nenhum card existe ainda (Etapa "Funis 2") — sempre 0 neste adapter.
    countCardsByFunnel() {
      return 0;
    },
    countCardsByStage() {
      return 0;
    },
  };
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { funnels: Object.create(null), stages: Object.create(null) };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Funil: arquivo de dados corrompido (JSON inválido) em ${filePath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.funnels !== 'object' || typeof parsed.stages !== 'object') {
    throw new Error(`Funil: arquivo de dados corrompido (estrutura inválida, esperava { funnels, stages }) em ${filePath}`);
  }
  const safe = (source) => {
    const out = Object.create(null);
    for (const key of Object.keys(source)) out[key] = source[key];
    return out;
  };
  return { funnels: safe(parsed.funnels), stages: safe(parsed.stages) };
}

// Mesmo padrão de escrita atômica de crmRepository.js/approvalQueue.js: arquivo temporário no mesmo diretório,
// fsync, e só então rename.
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

function createJsonFileFunnelRepository(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('Funil: createJsonFileFunnelRepository exige um filePath (texto não vazio)');
  }
  return {
    listFunnels() {
      return Object.values(readJsonFile(filePath).funnels).map(clone);
    },
    getFunnel(id) {
      const data = readJsonFile(filePath);
      return Object.prototype.hasOwnProperty.call(data.funnels, id) ? clone(data.funnels[id]) : null;
    },
    saveFunnel(funnel) {
      if (!funnel || typeof funnel.id !== 'string' || !funnel.id) throw new Error('Funil: saveFunnel() exige um funil com id');
      assertSafeId(funnel.id, 'funil');
      const data = readJsonFile(filePath);
      data.funnels[funnel.id] = clone(funnel);
      writeJsonFileAtomic(filePath, data);
    },
    deleteFunnel(id) {
      if (typeof id !== 'string' || !id) throw new Error('Funil: deleteFunnel() exige um id (texto não vazio)');
      assertSafeId(id, 'funil');
      const data = readJsonFile(filePath);
      if (Object.prototype.hasOwnProperty.call(data.funnels, id)) {
        delete data.funnels[id];
        writeJsonFileAtomic(filePath, data);
      }
    },
    listStages(funnelId) {
      return Object.values(readJsonFile(filePath).stages)
        .filter((stage) => stage.funnelId === funnelId)
        .map(clone);
    },
    getStage(id) {
      const data = readJsonFile(filePath);
      return Object.prototype.hasOwnProperty.call(data.stages, id) ? clone(data.stages[id]) : null;
    },
    saveStage(stage) {
      if (!stage || typeof stage.id !== 'string' || !stage.id) throw new Error('Funil: saveStage() exige uma etapa com id');
      assertSafeId(stage.id, 'etapa');
      const data = readJsonFile(filePath);
      data.stages[stage.id] = clone(stage);
      writeJsonFileAtomic(filePath, data);
    },
    deleteStage(id) {
      if (typeof id !== 'string' || !id) throw new Error('Funil: deleteStage() exige um id (texto não vazio)');
      assertSafeId(id, 'etapa');
      const data = readJsonFile(filePath);
      if (Object.prototype.hasOwnProperty.call(data.stages, id)) {
        delete data.stages[id];
        writeJsonFileAtomic(filePath, data);
      }
    },
    countCardsByFunnel() {
      return 0;
    },
    countCardsByStage() {
      return 0;
    },
  };
}

module.exports = {
  REQUIRED_FUNNEL_REPOSITORY_METHODS,
  assertValidFunnelRepository,
  createInMemoryFunnelRepository,
  createJsonFileFunnelRepository,
};
