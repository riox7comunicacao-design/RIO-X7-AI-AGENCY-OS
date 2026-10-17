// Adapters de DESENVOLVIMENTO/OPERAÇÃO LOCAL da porta de Negociações (CRM 5.0, Fase D1, decisão 0028): memória e um arquivo JSON local. O adapter de PRODUÇÃO no Supabase é
// uma decisão e uma fase própria (ver a decisão 0028: hoje Funis também só têm adapter de arquivo). `createJsonFileNegotiationRepository` grava UM arquivo
// ({ version, negotiations: { <id>: negociação } }), com escrita atômica (arquivo temporário, fsync e rename) — o mesmo padrão dos demais adapters de arquivo.
// O arquivo só passa a existir na PRIMEIRA gravação: ler nunca o cria.

const fs = require('node:fs');
const path = require('node:path');

const { REQUIRED_NEGOTIATION_REPOSITORY_METHODS, assertValidNegotiationRepository } = require('./negotiationRepositoryPort');

const clone = (value) => (value === undefined ? value : structuredClone(value));
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function assertSavable(negotiation) {
  if (!negotiation || typeof negotiation !== 'object' || Array.isArray(negotiation) || typeof negotiation.id !== 'string' || negotiation.id === '') {
    throw new Error('Negociação: save() exige uma negociação com id');
  }
  if (UNSAFE_IDS.has(negotiation.id)) throw new Error(`Negociação: id não permitido: ${negotiation.id}`);
}

function createInMemoryNegotiationRepository() {
  const items = new Map();
  return {
    list: () => [...items.values()].map(clone),
    getById: (id) => (items.has(id) ? clone(items.get(id)) : null),
    save(negotiation) {
      assertSavable(negotiation);
      items.set(negotiation.id, clone(negotiation));
      return clone(negotiation);
    },
  };
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, negotiations: Object.create(null) };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Negociação: arquivo de dados corrompido (JSON inválido) em ${filePath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.negotiations || typeof parsed.negotiations !== 'object' || Array.isArray(parsed.negotiations)) {
    throw new Error(`Negociação: arquivo de dados corrompido (estrutura inválida, esperava { version, negotiations }) em ${filePath}`);
  }
  const safe = Object.create(null);
  for (const key of Object.keys(parsed.negotiations)) safe[key] = parsed.negotiations[key];
  return { version: 1, negotiations: safe };
}

function writeJsonFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // o arquivo temporário pode nunca ter sido criado
    }
    throw error;
  }
}

function createJsonFileNegotiationRepository(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) throw new Error('Negociação: createJsonFileNegotiationRepository exige um filePath (texto não vazio)');
  return {
    list: () => Object.values(readJsonFile(filePath).negotiations).map(clone),
    getById(id) {
      const data = readJsonFile(filePath);
      return hasOwn(data.negotiations, id) ? clone(data.negotiations[id]) : null;
    },
    save(negotiation) {
      assertSavable(negotiation);
      const data = readJsonFile(filePath);
      data.negotiations[negotiation.id] = clone(negotiation);
      writeJsonFileAtomic(filePath, data);
      return clone(negotiation);
    },
  };
}

module.exports = { REQUIRED_NEGOTIATION_REPOSITORY_METHODS, assertValidNegotiationRepository, createInMemoryNegotiationRepository, createJsonFileNegotiationRepository };
