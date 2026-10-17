'use strict';

// Simulador ESTÁTICO de esquema — USO SOMENTE EM TESTES (src/ nunca importa este arquivo). Fase 2B-3.2B-H2.
//
// NÃO é um Postgres. Lê o TEXTO das migrations versionadas e aplica, em ordem de nome de arquivo, só o que as migrations de Exclusões
// Permanentes usam: CREATE TABLE (colunas, tipo, NOT NULL, DEFAULT, "não vazio"), ALTER COLUMN ... TYPE, ADD CONSTRAINT ... CHECK, ENABLE ROW
// LEVEL SECURITY, CREATE INDEX, CREATE POLICY e CREATE TRIGGER (só para conferir que NADA disso muda). Tudo o mais é ignorado.
// Com ele um teste prova o CONTRATO VERSIONADO (o que o SQL declara) — nunca o estado do banco operacional, que NÃO FOI CONSULTADO.
// Nenhuma rede, nenhum banco, nenhuma credencial.
//
// Também há um PostgREST FALSO tipado (`postgrestTipado`): um `fetch` em memória que valida cada linha gravada contra o esquema simulado, como o
// Postgres validaria (uuid inválido → 22P02, NOT NULL → 23502, "não vazio" → 23514) e devolve o status HTTP que o PostgREST usa.

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');

class SchemaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchemaError';
    this.code = code;
  }
}

// Sem comentários, sem o corpo das funções ($$ ... $$) e sem fim de linha do Windows.
function executable(sql) {
  return sql.replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, () => '$$$$');
}
const statementsOf = (sql) => executable(sql).split(';').map((s) => s.trim()).filter(Boolean);

// Divide por vírgulas de FORA de parênteses.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const NON_BLANK = /btrim\(\s*(\w+)\s*\)\s*<>\s*''/i;
const UUID_INPUT = /^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/i; // a regra de entrada do tipo uuid

function newSchema() {
  return { tables: new Map() };
}

function table(schema, name) {
  const found = schema.tables.get(name);
  if (!found) throw new SchemaError('42P01', `relation "public.${name}" does not exist`);
  return found;
}

function parseColumn(definition) {
  const found = /^(\w+)\s+(\w+)\b([\s\S]*)$/.exec(definition);
  if (!found || /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)$/i.test(found[1])) return null;
  const [, name, type, rest] = found;
  const nonBlankChecks = [...rest.matchAll(/CHECK\s*\(([\s\S]*)\)/gi)].some((c) => NON_BLANK.test(c[1]) && NON_BLANK.exec(c[1])[1] === name);
  return {
    name,
    type: type.toUpperCase(),
    notNull: /\bNOT NULL\b/i.test(rest) || /\bPRIMARY KEY\b/i.test(rest),
    hasDefault: /\bDEFAULT\b/i.test(rest),
    defaultValue: /DEFAULT\s+'([^']*)'/i.exec(rest)?.[1] ?? (/DEFAULT\s+(TRUE|FALSE)\b/i.exec(rest) ? /DEFAULT\s+TRUE\b/i.test(rest) : undefined),
    nonBlank: nonBlankChecks,
    constraints: [],
  };
}

function canonicalUuid(value) {
  const found = UUID_INPUT.exec(String(value));
  return found ? found.slice(1).join('-').toLowerCase() : null;
}

function applyStatement(schema, statement) {
  let found;
  if ((found = /^CREATE TABLE public\.(\w+)\s*\(([\s\S]*)\)$/i.exec(statement))) {
    if (schema.tables.has(found[1])) throw new SchemaError('42P07', `relation "${found[1]}" already exists`);
    const columns = new Map();
    for (const definition of splitTopLevel(found[2])) {
      const column = parseColumn(definition);
      if (column) columns.set(column.name, column);
    }
    schema.tables.set(found[1], { name: found[1], columns, rows: [], rls: false, policies: [], indexes: [], triggers: [], functions: [], constraints: [] });
    return;
  }
  if ((found = /^ALTER TABLE public\.(\w+)\s+ENABLE ROW LEVEL SECURITY$/i.exec(statement))) {
    table(schema, found[1]).rls = true;
    return;
  }
  if ((found = /^ALTER TABLE public\.(\w+)\s+ALTER COLUMN\s+(\w+)\s+TYPE\s+(\w+)\b/i.exec(statement))) {
    const target = table(schema, found[1]);
    const column = target.columns.get(found[2]);
    if (!column) throw new SchemaError('42703', `column "${found[2]}" does not exist`);
    const novoTipo = found[3].toUpperCase();
    // Só o cast simples (USING <coluna>::<novo tipo>) é entendido: qualquer outra expressão poderia ALTERAR os valores, e o simulador não a
    // avalia — recusar é mais seguro do que fingir que os valores ficaram iguais.
    const usando = /\bUSING\s+([\s\S]+)$/i.exec(statement);
    if (usando && usando[1].trim().toUpperCase() !== `${found[2]}::${novoTipo}`.toUpperCase()) {
      throw new SchemaError('0A000', 'o simulador só entende USING <coluna>::<novo tipo> (cast simples); outra expressão poderia alterar os valores');
    }
    if (column.type === 'UUID' && novoTipo === 'TEXT') {
      for (const row of target.rows) if (row[column.name] !== null && row[column.name] !== undefined) row[column.name] = String(row[column.name]);
    }
    column.type = novoTipo;
    return;
  }
  if ((found = /^ALTER TABLE public\.(\w+)\s+ADD CONSTRAINT\s+(\w+)\s+CHECK\s*\(([\s\S]*)\)$/i.exec(statement))) {
    const target = table(schema, found[1]);
    if (target.constraints.includes(found[2])) throw new SchemaError('42710', `constraint "${found[2]}" already exists`);
    const blank = NON_BLANK.exec(found[3]);
    const column = blank ? target.columns.get(blank[1]) : null;
    if (column) {
      for (const row of target.rows) {
        const valor = row[column.name];
        if (valor !== null && valor !== undefined && String(valor).trim() === '') throw new SchemaError('23514', `check constraint "${found[2]}" is violated by some row`);
      }
      column.nonBlank = true;
    }
    target.constraints.push(found[2]);
    return;
  }
  if ((found = /^CREATE (?:UNIQUE )?INDEX\s+(\w+)\s+ON public\.(\w+)/i.exec(statement))) {
    table(schema, found[2]).indexes.push(found[1]);
    return;
  }
  if ((found = /^CREATE POLICY\s+(\w+)\s+ON public\.(\w+)/i.exec(statement))) {
    table(schema, found[2]).policies.push(found[1]);
    return;
  }
  if ((found = /^CREATE TRIGGER\s+(\w+)[\s\S]*?\sON public\.(\w+)/i.exec(statement))) {
    table(schema, found[2]).triggers.push(found[1]);
    return;
  }
  // CREATE FUNCTION e o resto: irrelevantes para o contrato de tipos.
}

// Aplica os arquivos de migration (nomes dentro de supabase/migrations) NA ORDEM em que foram dados.
function applyMigrations(arquivos, schema = newSchema()) {
  for (const arquivo of arquivos) {
    for (const statement of statementsOf(fs.readFileSync(path.join(MIGRATIONS_DIR, arquivo), 'utf8'))) applyStatement(schema, statement);
  }
  return schema;
}

// Valida e grava uma linha como o Postgres faria. Lança SchemaError com o SQLSTATE; devolve a linha gravada.
function insertRow(schema, tableName, input, { now = '2026-10-17T00:00:00.000Z' } = {}) {
  const target = table(schema, tableName);
  for (const key of Object.keys(input)) {
    if (!target.columns.has(key)) throw new SchemaError('PGRST204', `column "${key}" does not exist`);
  }
  const stored = {};
  for (const column of target.columns.values()) {
    let value = Object.prototype.hasOwnProperty.call(input, column.name) ? input[column.name] : undefined;
    if (value === undefined) {
      if (column.type === 'TIMESTAMPTZ' && column.hasDefault) value = now;
      else if (column.name === 'id' && column.type === 'UUID' && column.hasDefault) value = '00000000-0000-4000-8000-000000000000';
      else if (column.hasDefault && column.defaultValue !== undefined) value = column.defaultValue;
      else value = null;
    }
    if (value === null) {
      if (column.notNull) throw new SchemaError('23502', `null value in column "${column.name}" violates not-null constraint`);
      stored[column.name] = null;
      continue;
    }
    if (column.type === 'UUID') {
      const canonico = canonicalUuid(value);
      if (canonico === null) throw new SchemaError('22P02', `invalid input syntax for type uuid: "${String(value).slice(0, 40)}"`);
      value = canonico;
    } else if (column.type === 'BOOLEAN') {
      if (typeof value !== 'boolean') throw new SchemaError('22P02', `invalid input syntax for type boolean`);
    } else if (column.type === 'TEXT') {
      if (typeof value !== 'string') throw new SchemaError('22P02', `invalid input syntax for type text`);
    }
    if (column.nonBlank && typeof value === 'string' && value.trim() === '') throw new SchemaError('23514', `check constraint on "${column.name}" is violated`);
    stored[column.name] = value;
  }
  target.rows.push(stored);
  return { ...stored };
}

const HTTP_STATUS = Object.freeze({ '22P02': 400, '23502': 400, '23514': 400, PGRST204: 400, '42P01': 404, '42703': 400 });
function resposta(status, corpo, cabecalhos = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (nome) => cabecalhos[String(nome).toLowerCase()] ?? null },
    text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)),
  };
}

// Um PostgREST falso sobre o esquema simulado, só com o que o adapter das Exclusões usa: POST (return=representation), GET paginado com
// Content-Range, GET por id e PATCH por id. `pedidos` guarda cada requisição (para os testes olharem o corpo enviado).
function postgrestTipado({ schema, tableName = 'prospecting_permanent_exclusions' }) {
  const pedidos = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    pedidos.push({ metodo: init.method, url: u, corpo: init.body ? JSON.parse(init.body) : undefined });
    if (u.pathname !== `/rest/v1/${tableName}`) return resposta(404, { code: 'PGRST125' });
    let target;
    try {
      target = table(schema, tableName);
    } catch (erro) {
      return resposta(404, { code: 'PGRST205', message: erro.message });
    }
    try {
      if (init.method === 'POST') {
        const corpo = JSON.parse(init.body);
        const gravadas = corpo.map((linha) => insertRow(schema, tableName, linha));
        return resposta(201, gravadas);
      }
      if (init.method === 'PATCH') {
        const id = String(u.searchParams.get('id') || '').replace(/^eq\./, '');
        const alvo = target.rows.find((linha) => linha.id === id);
        if (!alvo) return resposta(200, []);
        const corpo = JSON.parse(init.body);
        const candidata = { ...alvo, ...corpo };
        target.rows.splice(target.rows.indexOf(alvo), 1);
        try {
          const gravada = insertRow(schema, tableName, candidata);
          target.rows.splice(target.rows.length - 1, 1, gravada);
          return resposta(200, [gravada]);
        } catch (erro) {
          target.rows.push(alvo);
          throw erro;
        }
      }
      if (init.method === 'GET') {
        const idParam = u.searchParams.get('id');
        if (idParam) return resposta(200, target.rows.filter((linha) => linha.id === idParam.replace(/^eq\./, '')));
        const limit = Number(u.searchParams.get('limit'));
        const offset = Number(u.searchParams.get('offset'));
        const total = target.rows.length;
        const fatia = target.rows.slice(offset, offset + limit);
        const faixa = fatia.length === 0 ? `*/${total}` : `${offset}-${offset + fatia.length - 1}/${total}`;
        return resposta(fatia.length < total - offset ? 206 : 200, fatia, { 'content-range': faixa });
      }
    } catch (erro) {
      if (erro instanceof SchemaError) return resposta(HTTP_STATUS[erro.code] || 400, { code: erro.code });
      throw erro;
    }
    return resposta(405, {});
  };
  return { fetchImpl, pedidos };
}

module.exports = { SchemaError, MIGRATIONS_DIR, newSchema, applyMigrations, insertRow, postgrestTipado, executable, statementsOf, canonicalUuid };
