// Adapters de DESENVOLVIMENTO/TESTE da porta de Funis (Etapa "Funis 1": funil/etapa; Etapa "Funis 2": card) — mesmo
// par de sempre (memória, arquivo JSON local), mesmo desenho de crmRepository.js. `createJsonFileFunnelRepository`
// grava um ÚNICO arquivo (`{ funnels, stages, cards, cardMoves }`, escrita atômica).
//
// CARD: `archiveCard(id)` nunca apaga a linha — só marca `removedAt` (Etapa "Funis 2", decisão do proprietário: o
// histórico de movimentação nunca pode ficar orfão nem ser perdido). `countCardsByFunnel`/`countCardsByStage`/
// `listCardsByFunnel`/`getCardByFunnelAndRecord`/`countActiveCardsByCrmRecord` só enxergam cards ATIVOS
// (`removedAt` ausente) — um card arquivado nunca bloqueia excluir o funil/etapa, recriar o card, nem excluir o
// registro do CRM (Etapa "Funis 2 — correção de integridade CRM ↔ Card"). `getCard`/`listCardMoves` enxergam
// cards arquivados também (histórico e detalhe continuam consultáveis).
//
// O adapter de produção (Supabase) desta porta é uma etapa futura — ver a migration de Funis (schema completo).

const fs = require('node:fs');
const path = require('node:path');

const { REQUIRED_FUNNEL_REPOSITORY_METHODS, assertValidFunnelRepository } = require('./funnelRepositoryPort');

const clone = (value) => (value === undefined ? value : structuredClone(value));

// Mesma defesa de crmRepository.js: uma chave "__proto__"/"constructor"/"prototype" nunca é um id de armazenamento.
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
function assertSafeId(id, label) {
  if (UNSAFE_IDS.has(id)) throw new Error(`Funil: id de ${label} não permitido: ${id}`);
}
const isAtiva = (card) => card.removedAt === null || card.removedAt === undefined;

function createInMemoryFunnelRepository() {
  const funnels = new Map();
  const stages = new Map();
  const cards = new Map();
  const cardMoves = []; // append-only

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
    countCardsByFunnel(funnelId) {
      return [...cards.values()].filter((card) => card.funnelId === funnelId && isAtiva(card)).length;
    },
    countCardsByStage(stageId) {
      return [...cards.values()].filter((card) => card.stageId === stageId && isAtiva(card)).length;
    },
    listCardsByFunnel(funnelId) {
      return [...cards.values()].filter((card) => card.funnelId === funnelId && isAtiva(card)).map(clone);
    },
    getCardByFunnelAndRecord(funnelId, crmRecordId) {
      const card = [...cards.values()].find((c) => c.funnelId === funnelId && c.crmRecordId === crmRecordId && isAtiva(c));
      return card ? clone(card) : null;
    },
    getCard(id) {
      const card = cards.get(id);
      return card ? clone(card) : null;
    },
    saveCard(card) {
      if (!card || typeof card.id !== 'string' || !card.id) throw new Error('Funil: saveCard() exige um card com id');
      assertSafeId(card.id, 'card');
      cards.set(card.id, clone(card));
    },
    archiveCard(id) {
      if (typeof id !== 'string' || !id) throw new Error('Funil: archiveCard() exige um id (texto não vazio)');
      const card = cards.get(id);
      if (card) cards.set(id, { ...card, removedAt: new Date().toISOString() });
    },
    listCardMoves(cardId) {
      return cardMoves.filter((move) => move.cardId === cardId).map(clone);
    },
    saveCardMove(move) {
      if (!move || typeof move.cardId !== 'string' || !move.cardId) throw new Error('Funil: saveCardMove() exige um move com cardId');
      cardMoves.push(clone(move));
    },
    countActiveCardsByCrmRecord(crmRecordId) {
      return [...cards.values()].filter((card) => card.crmRecordId === crmRecordId && isAtiva(card)).length;
    },
  };
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { funnels: Object.create(null), stages: Object.create(null), cards: Object.create(null), cardMoves: [] };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Funil: arquivo de dados corrompido (JSON inválido) em ${filePath}: ${err.message}`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof parsed.funnels !== 'object' ||
    typeof parsed.stages !== 'object' ||
    typeof parsed.cards !== 'object' ||
    !Array.isArray(parsed.cardMoves)
  ) {
    throw new Error(`Funil: arquivo de dados corrompido (estrutura inválida, esperava { funnels, stages, cards, cardMoves }) em ${filePath}`);
  }
  const safe = (source) => {
    const out = Object.create(null);
    for (const key of Object.keys(source)) out[key] = source[key];
    return out;
  };
  return { funnels: safe(parsed.funnels), stages: safe(parsed.stages), cards: safe(parsed.cards), cardMoves: parsed.cardMoves.map(clone) };
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
    countCardsByFunnel(funnelId) {
      return Object.values(readJsonFile(filePath).cards).filter((card) => card.funnelId === funnelId && isAtiva(card)).length;
    },
    countCardsByStage(stageId) {
      return Object.values(readJsonFile(filePath).cards).filter((card) => card.stageId === stageId && isAtiva(card)).length;
    },
    listCardsByFunnel(funnelId) {
      return Object.values(readJsonFile(filePath).cards)
        .filter((card) => card.funnelId === funnelId && isAtiva(card))
        .map(clone);
    },
    getCardByFunnelAndRecord(funnelId, crmRecordId) {
      const card = Object.values(readJsonFile(filePath).cards).find((c) => c.funnelId === funnelId && c.crmRecordId === crmRecordId && isAtiva(c));
      return card ? clone(card) : null;
    },
    getCard(id) {
      const data = readJsonFile(filePath);
      return Object.prototype.hasOwnProperty.call(data.cards, id) ? clone(data.cards[id]) : null;
    },
    saveCard(card) {
      if (!card || typeof card.id !== 'string' || !card.id) throw new Error('Funil: saveCard() exige um card com id');
      assertSafeId(card.id, 'card');
      const data = readJsonFile(filePath);
      data.cards[card.id] = clone(card);
      writeJsonFileAtomic(filePath, data);
    },
    archiveCard(id) {
      if (typeof id !== 'string' || !id) throw new Error('Funil: archiveCard() exige um id (texto não vazio)');
      const data = readJsonFile(filePath);
      if (Object.prototype.hasOwnProperty.call(data.cards, id)) {
        data.cards[id] = { ...data.cards[id], removedAt: new Date().toISOString() };
        writeJsonFileAtomic(filePath, data);
      }
    },
    listCardMoves(cardId) {
      return readJsonFile(filePath).cardMoves.filter((move) => move.cardId === cardId).map(clone);
    },
    saveCardMove(move) {
      if (!move || typeof move.cardId !== 'string' || !move.cardId) throw new Error('Funil: saveCardMove() exige um move com cardId');
      const data = readJsonFile(filePath);
      data.cardMoves.push(clone(move));
      writeJsonFileAtomic(filePath, data);
    },
    countActiveCardsByCrmRecord(crmRecordId) {
      return Object.values(readJsonFile(filePath).cards).filter((card) => card.crmRecordId === crmRecordId && isAtiva(card)).length;
    },
  };
}

module.exports = {
  REQUIRED_FUNNEL_REPOSITORY_METHODS,
  assertValidFunnelRepository,
  createInMemoryFunnelRepository,
  createJsonFileFunnelRepository,
};
