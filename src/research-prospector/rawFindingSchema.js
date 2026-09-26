// Esquema validado dos RAW FINDINGS (achados brutos) que entram no discovery.
//
// UM ACHADO BRUTO É DADO NÃO CONFIÁVEL: vem de pesquisa externa — web, IA ou uma pessoa — e pode ter qualquer tipo, tamanho ou
// forma, inclusive de propósito. Este módulo só VALIDA e COPIA dados já fornecidos:
//   - nunca busca uma URL, nunca faz rede, nunca lê arquivo, nunca interpreta HTML nem JavaScript;
//   - nunca confia nos tipos ("string" tem de ser string; um número não vira texto);
//   - só aceita as chaves conhecidas (qualquer chave desconhecida é recusada — em especial qualquer status ou decisão que o
//     próprio achado tente trazer: status, confianca, statusIdentidade, estadoOperacional, doNotContact, statusDNC,
//     statusDuplicidade, prospectId... Quem decide isso é o discovery, a partir das EVIDÊNCIAS, nunca o achado);
//   - devolve uma CÓPIA nova, só com o que foi validado (nunca o objeto original, nunca uma referência a ele);
//   - só aceita URL https (sem usuário/senha, sem porta, sem IP nem host local): protocolos como javascript:, data:, file:,
//     http:, ftp: e "//host" são recusados.
//
// VOCABULÁRIO: nenhum termo novo. O formato é o que discovery.js já consome — `campos: { <campo>: [{ valor, fonte,
// tipoFonte }] }` com tipoFonte OFICIAL | SECUNDARIA (discovery.SOURCE_TYPE) e os campos de discovery.EVIDENCE_FIELDS;
// `fontes`, `identidadeAmbigua`, `observacoesBrutas`, `hipoteseDeOportunidade`, `dataConsulta` (nas fontes) e
// `dataDaPesquisa` (o mesmo nome que o discovery usa). Os estados VALIDADO / HIPOTESE / NAO_VERIFICADO NÃO entram no achado:
// são a SAÍDA do discovery (evidenceStatus) e continuam sendo calculados por ele.
//
// O erro nunca repete o valor recusado (nem o trunca): só o caminho (formado por chaves conhecidas e índices) e um código.

const { SOURCE_TYPE, EVIDENCE_FIELDS } = require('./discovery');

const LIMITS = Object.freeze({
  MAX_DEPTH: 5, // achado -> campos -> lista -> evidência -> valor = 4; uma margem
  MAX_NODES: 2000, // objetos + listas + valores, contando tudo o que o achado traz
  EMPRESA: 200,
  TEXTO_CURTO: 120, // tipo, cidade, estado, nicho
  OBSERVACOES: 4000,
  HIPOTESE: 1000,
  VALOR: 300,
  URL: 2048,
  FONTE_NOME: 200,
  OBSERVACAO_FONTE: 500,
  EVIDENCIAS_POR_CAMPO: 10,
  FONTES: 50,
  ACHADOS_POR_LOTE: 500,
  MAX_ERRORS: 50,
});

const ERROR = Object.freeze({
  NAO_E_OBJETO: 'NAO_E_OBJETO',
  NAO_E_LISTA: 'NAO_E_LISTA',
  ESTRUTURA_INVALIDA: 'ESTRUTURA_INVALIDA',
  PROFUNDIDADE_EXCESSIVA: 'PROFUNDIDADE_EXCESSIVA',
  TAMANHO_EXCESSIVO: 'TAMANHO_EXCESSIVO',
  CAMPO_DESCONHECIDO: 'CAMPO_DESCONHECIDO',
  CAMPO_OBRIGATORIO: 'CAMPO_OBRIGATORIO',
  TIPO_INVALIDO: 'TIPO_INVALIDO',
  TEXTO_VAZIO: 'TEXTO_VAZIO',
  TEXTO_LONGO: 'TEXTO_LONGO',
  CARACTERE_INVALIDO: 'CARACTERE_INVALIDO',
  URL_INVALIDA: 'URL_INVALIDA',
  PROTOCOLO_PROIBIDO: 'PROTOCOLO_PROIBIDO',
  VALOR_INVALIDO: 'VALOR_INVALIDO',
  TIPO_FONTE_INVALIDO: 'TIPO_FONTE_INVALIDO',
  DATA_INVALIDA: 'DATA_INVALIDA',
  EVIDENCIAS_EXCESSIVAS: 'EVIDENCIAS_EXCESSIVAS',
  FONTES_EXCESSIVAS: 'FONTES_EXCESSIVAS',
  LOTE_EXCESSIVO: 'LOTE_EXCESSIVO',
});

const MESSAGES = Object.freeze({
  NAO_E_OBJETO: 'esperava um objeto simples',
  NAO_E_LISTA: 'esperava uma lista',
  ESTRUTURA_INVALIDA: 'estrutura não aceita (propriedade especial, método, valor que não é dado puro ou lista com lacunas)',
  PROFUNDIDADE_EXCESSIVA: 'estrutura aninhada demais',
  TAMANHO_EXCESSIVO: 'dados demais no achado',
  CAMPO_DESCONHECIDO: 'campo desconhecido',
  CAMPO_OBRIGATORIO: 'campo obrigatório ausente',
  TIPO_INVALIDO: 'tipo inválido',
  TEXTO_VAZIO: 'texto vazio',
  TEXTO_LONGO: 'texto acima do limite',
  CARACTERE_INVALIDO: 'caractere de controle ou de direção de texto não permitido',
  URL_INVALIDA: 'URL inválida (só https, com domínio público, sem usuário, senha ou porta)',
  PROTOCOLO_PROIBIDO: 'protocolo não permitido (só https)',
  VALOR_INVALIDO: 'valor com formato inválido para este campo',
  TIPO_FONTE_INVALIDO: 'tipo de fonte desconhecido',
  DATA_INVALIDA: 'data inválida (esperava AAAA-MM-DD ou data e hora ISO 8601 real, não futura)',
  EVIDENCIAS_EXCESSIVAS: 'evidências demais para o campo',
  FONTES_EXCESSIVAS: 'fontes demais',
  LOTE_EXCESSIVO: 'achados demais no lote',
});

const FINDING_KEYS = Object.freeze(['empresa', 'tipo', 'cidade', 'estado', 'nicho', 'campos', 'fontes', 'identidadeAmbigua', 'observacoesBrutas', 'hipoteseDeOportunidade', 'dataDaPesquisa']);
const EVIDENCE_KEYS = Object.freeze(['valor', 'fonte', 'tipoFonte', 'url', 'dataConsulta', 'observacao']);
const SOURCE_KEYS = Object.freeze(['fonte', 'url', 'dataConsulta', 'campo', 'tipoFonte', 'observacao']);
const SOURCE_TYPES = Object.freeze(Object.values(SOURCE_TYPE));

// O formato do valor por campo. Os "de link" aceitam um domínio ou @usuario sem esquema, ou uma URL https completa.
const LINK_FIELDS = Object.freeze(['site', 'instagram', 'facebook', 'linkedin', 'youtube', 'googlePerfil']);
const PHONE_FIELDS = Object.freeze(['telefone', 'whatsapp']);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
// Uma chave só entra num caminho de erro se for curta e só de letras (o erro nunca repete conteúdo do achado).
const safeKey = (key) => (key.length <= 40 && /^[A-Za-z]+$/.test(key) ? key : '?');
const CONTROL = /[\u0000-\u001F\u007F]/;
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const BIDI_AND_INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const BARE_LINK = /^@?[A-Za-z0-9][A-Za-z0-9._\-/%+~]*$/;
const EMAIL = /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/;
const PHONE = /^\+?[0-9()\s.\-]+$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// As entradas PRÓPRIAS de um objeto simples, só se todas forem propriedades de dado enumeráveis com chave de texto (uma
// propriedade com getter/setter, uma chave Symbol ou uma propriedade oculta é recusada — poderia executar código ou esconder
// valor). Devolve null se a estrutura não é aceita.
function ownEntries(object) {
  const entries = [];
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

// Uma lista de verdade (sem lacunas, sem propriedades extras). Devolve os itens ou null.
function ownItems(list) {
  if (Object.getPrototypeOf(list) !== Array.prototype) return null;
  const keys = Reflect.ownKeys(list);
  if (keys.length !== list.length + 1) return null; // índices 0..n-1 + "length"
  const items = [];
  for (let index = 0; index < list.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
    if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    items.push(descriptor.value);
  }
  return items;
}

// Mede a profundidade e a quantidade de nós ANTES de qualquer outra coisa, sem recursão (um achado circular ou gigante
// nunca estoura a pilha nem trava). Só desce em objetos e listas; ciclos batem no limite de profundidade.
function measure(root) {
  const stack = [[root, 1]];
  let nodes = 0;
  while (stack.length > 0) {
    const [value, depth] = stack.pop();
    nodes += 1;
    if (nodes > LIMITS.MAX_NODES) return ERROR.TAMANHO_EXCESSIVO;
    if (typeof value !== 'object' || value === null) continue;
    if (depth > LIMITS.MAX_DEPTH) return ERROR.PROFUNDIDADE_EXCESSIVA;
    let children;
    try {
      if (Array.isArray(value)) {
        if (value.length > LIMITS.MAX_NODES) return ERROR.TAMANHO_EXCESSIVO;
        children = Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)));
        children = children.map((descriptor) => (descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined));
      } else {
        children = Reflect.ownKeys(value).map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined;
        });
      }
    } catch {
      return ERROR.ESTRUTURA_INVALIDA;
    }
    for (const child of children) stack.push([child, depth + 1]);
  }
  return null;
}

// Um texto: tipo string, limite (no texto bruto, antes de qualquer processamento), sem caracteres de controle nem de direção
// de texto (spoofing), e não vazio depois do trim.
function checkText(value, max, { allowNewlines = false } = {}) {
  if (typeof value !== 'string') return { error: ERROR.TIPO_INVALIDO };
  if (value.length > max) return { error: ERROR.TEXTO_LONGO };
  if ((allowNewlines ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(value) || BIDI_AND_INVISIBLE.test(value)) return { error: ERROR.CARACTERE_INVALIDO };
  const trimmed = value.trim();
  if (trimmed === '') return { error: ERROR.TEXTO_VAZIO };
  return { value: trimmed };
}

// Uma URL de fonte pública: https, domínio público (com ponto), sem usuário/senha, sem porta, sem IP nem host local. Não busca nada.
function checkUrl(value) {
  const text = checkText(value, LIMITS.URL);
  if (text.error) return text;
  if (/\s/.test(text.value)) return { error: ERROR.URL_INVALIDA };
  if (text.value.startsWith('//') || (SCHEME.test(text.value) && !/^https:/i.test(text.value))) return { error: ERROR.PROTOCOLO_PROIBIDO };
  let url;
  try {
    url = new URL(text.value);
  } catch {
    return { error: ERROR.URL_INVALIDA };
  }
  if (url.protocol !== 'https:') return { error: ERROR.PROTOCOLO_PROIBIDO };
  const host = url.hostname.toLowerCase();
  if (url.username !== '' || url.password !== '' || url.port !== '') return { error: ERROR.URL_INVALIDA };
  if (host === '' || !host.includes('.') || host.includes(':') || host.startsWith('[') || IPV4.test(host)) return { error: ERROR.URL_INVALIDA };
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) return { error: ERROR.URL_INVALIDA };
  return { value: text.value };
}

// Data ISO 8601 REAL (calendário e relógio), entre 2000 e "agora + 1 dia" (nunca uma data futura).
function checkDate(value, now) {
  const text = checkText(value, 40);
  if (text.error) return { error: text.error === ERROR.TIPO_INVALIDO ? ERROR.TIPO_INVALIDO : ERROR.DATA_INVALIDA };
  const dateOnly = ISO_DATE.exec(text.value);
  const dateTime = ISO_DATETIME.exec(text.value);
  const match = dateOnly || dateTime;
  if (!match) return { error: ERROR.DATA_INVALIDA };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return { error: ERROR.DATA_INVALIDA };
  if (dateTime) {
    const [hour, minute, second] = [Number(dateTime[4]), Number(dateTime[5]), dateTime[6] === undefined ? 0 : Number(dateTime[6])];
    if (hour > 23 || minute > 59 || second > 59) return { error: ERROR.DATA_INVALIDA };
    const offset = dateTime[7];
    if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return { error: ERROR.DATA_INVALIDA };
  }
  const instant = dateTime ? new Date(text.value).getTime() : probe.getTime();
  if (Number.isNaN(instant) || instant > now.getTime() + 24 * 60 * 60 * 1000) return { error: ERROR.DATA_INVALIDA };
  return { value: text.value };
}

// O valor de uma evidência, pelo tipo do campo. O formato é conservador: recusa o que não reconhece em vez de "consertar".
function checkFieldValue(field, value) {
  if (LINK_FIELDS.includes(field)) {
    const text = checkText(value, LIMITS.URL);
    if (text.error) return text;
    if (text.value.startsWith('//') || SCHEME.test(text.value)) return checkUrl(text.value);
    if (text.value.length > LIMITS.VALOR || !BARE_LINK.test(text.value)) return { error: ERROR.VALOR_INVALIDO };
    return text;
  }
  const text = checkText(value, LIMITS.VALOR);
  if (text.error) return text;
  if (PHONE_FIELDS.includes(field)) {
    const digits = text.value.replace(/\D/g, '').length;
    if (!PHONE.test(text.value) || digits < 8 || digits > 15) return { error: ERROR.VALOR_INVALIDO };
  } else if (field === 'email') {
    if (text.value.length > 254 || !EMAIL.test(text.value)) return { error: ERROR.VALOR_INVALIDO };
  }
  return text; // endereco: texto livre (no limite)
}

function createCollector() {
  const errors = [];
  return {
    errors,
    add(path, code) {
      if (errors.length < LIMITS.MAX_ERRORS) errors.push({ path, code, message: MESSAGES[code] });
    },
  };
}

// Valida UM achado bruto. Nunca lança (nem para entrada hostil): devolve { ok, value } ou { ok, errors }.
// `now`: para os testes fixarem "hoje" (padrão: a hora do sistema).
function validateRawFinding(raw, { now = new Date() } = {}) {
  const collector = createCollector();
  const fail = (path, code) => collector.add(path, code);

  if (!isPlainObject(raw)) {
    fail('', ERROR.NAO_E_OBJETO);
    return { ok: false, errors: collector.errors };
  }
  const structure = measure(raw);
  if (structure) {
    fail('', structure);
    return { ok: false, errors: collector.errors };
  }
  const entries = ownEntries(raw);
  if (entries === null) {
    fail('', ERROR.ESTRUTURA_INVALIDA);
    return { ok: false, errors: collector.errors };
  }

  const value = {};
  const present = new Map(entries.filter(([, v]) => v !== undefined));
  for (const [key] of present) if (!FINDING_KEYS.includes(key)) fail(safeKey(key), ERROR.CAMPO_DESCONHECIDO);

  const optional = (key) => (present.has(key) && present.get(key) !== null ? present.get(key) : undefined);

  // empresa (obrigatória)
  if (!present.has('empresa') || present.get('empresa') === null) fail('empresa', ERROR.CAMPO_OBRIGATORIO);
  else {
    const empresa = checkText(present.get('empresa'), LIMITS.EMPRESA);
    if (empresa.error) fail('empresa', empresa.error);
    else value.empresa = empresa.value;
  }

  for (const key of ['tipo', 'cidade', 'estado', 'nicho']) {
    if (optional(key) === undefined) continue;
    const text = checkText(optional(key), LIMITS.TEXTO_CURTO);
    if (text.error) fail(key, text.error);
    else value[key] = text.value;
  }
  for (const [key, max] of [['observacoesBrutas', LIMITS.OBSERVACOES], ['hipoteseDeOportunidade', LIMITS.HIPOTESE]]) {
    if (optional(key) === undefined) continue;
    const text = checkText(optional(key), max, { allowNewlines: true });
    if (text.error) fail(key, text.error);
    else value[key] = text.value;
  }
  if (optional('identidadeAmbigua') !== undefined) {
    if (typeof optional('identidadeAmbigua') !== 'boolean') fail('identidadeAmbigua', ERROR.TIPO_INVALIDO);
    else value.identidadeAmbigua = optional('identidadeAmbigua');
  }
  if (optional('dataDaPesquisa') !== undefined) {
    const date = checkDate(optional('dataDaPesquisa'), now);
    if (date.error) fail('dataDaPesquisa', date.error);
    else value.dataDaPesquisa = date.value;
  }

  // campos: { <campo>: [evidência, ...] }
  if (optional('campos') !== undefined) {
    const campos = optional('campos');
    if (!isPlainObject(campos)) fail('campos', ERROR.NAO_E_OBJETO);
    else {
      const validCampos = {};
      const camposEntries = ownEntries(campos);
      if (camposEntries === null) fail('campos', ERROR.ESTRUTURA_INVALIDA);
      for (const [field, list] of (camposEntries || []).filter(([, v]) => v !== undefined)) {
        if (!EVIDENCE_FIELDS.includes(field)) {
          fail(`campos.${safeKey(field)}`, ERROR.CAMPO_DESCONHECIDO);
          continue;
        }
        const path = `campos.${field}`;
        if (!Array.isArray(list)) {
          fail(path, ERROR.NAO_E_LISTA);
          continue;
        }
        const items = ownItems(list);
        if (items === null) {
          fail(path, ERROR.ESTRUTURA_INVALIDA);
          continue;
        }
        if (items.length > LIMITS.EVIDENCIAS_POR_CAMPO) {
          fail(path, ERROR.EVIDENCIAS_EXCESSIVAS);
          continue;
        }
        const evidences = [];
        items.forEach((item, index) => {
          const evidence = checkEvidence(field, item, `${path}[${index}]`, fail, now);
          if (evidence) evidences.push(evidence);
        });
        validCampos[field] = evidences;
      }
      value.campos = validCampos;
    }
  }

  // fontes: [texto | objeto, ...]
  if (optional('fontes') !== undefined) {
    const fontes = optional('fontes');
    if (!Array.isArray(fontes)) fail('fontes', ERROR.NAO_E_LISTA);
    else {
      const items = ownItems(fontes);
      if (items === null) fail('fontes', ERROR.ESTRUTURA_INVALIDA);
      else if (items.length > LIMITS.FONTES) fail('fontes', ERROR.FONTES_EXCESSIVAS);
      else {
        const sources = [];
        items.forEach((item, index) => {
          const source = checkSource(item, `fontes[${index}]`, fail, now);
          if (source !== undefined) sources.push(source);
        });
        value.fontes = sources;
      }
    }
  }

  if (collector.errors.length > 0) return { ok: false, errors: collector.errors };
  return { ok: true, value };
}

function checkEvidence(field, item, path, fail, now) {
  if (!isPlainObject(item)) {
    fail(path, ERROR.NAO_E_OBJETO);
    return null;
  }
  const entries = ownEntries(item);
  if (entries === null) {
    fail(path, ERROR.ESTRUTURA_INVALIDA);
    return null;
  }
  const present = new Map(entries.filter(([, v]) => v !== undefined));
  let ok = true;
  for (const [key] of present) {
    if (!EVIDENCE_KEYS.includes(key)) {
      fail(`${path}.${safeKey(key)}`, ERROR.CAMPO_DESCONHECIDO);
      ok = false;
    }
  }
  const evidence = {};
  const required = (key, check) => {
    if (!present.has(key) || present.get(key) === null) {
      fail(`${path}.${key}`, ERROR.CAMPO_OBRIGATORIO);
      ok = false;
      return;
    }
    const result = check(present.get(key));
    if (result.error) {
      fail(`${path}.${key}`, result.error);
      ok = false;
    } else evidence[key] = result.value;
  };
  const optionalKey = (key, check) => {
    if (!present.has(key) || present.get(key) === null) return;
    const result = check(present.get(key));
    if (result.error) {
      fail(`${path}.${key}`, result.error);
      ok = false;
    } else evidence[key] = result.value;
  };
  required('valor', (v) => checkFieldValue(field, v));
  required('fonte', (v) => checkText(v, LIMITS.FONTE_NOME));
  required('tipoFonte', checkSourceType);
  optionalKey('url', checkUrl);
  optionalKey('dataConsulta', (v) => checkDate(v, now));
  optionalKey('observacao', (v) => checkText(v, LIMITS.OBSERVACAO_FONTE, { allowNewlines: true }));
  return ok ? evidence : null;
}

function checkSourceType(value) {
  if (typeof value !== 'string') return { error: ERROR.TIPO_INVALIDO };
  return SOURCE_TYPES.includes(value) ? { value } : { error: ERROR.TIPO_FONTE_INVALIDO };
}

function checkSource(item, path, fail, now) {
  if (typeof item === 'string') {
    const text = checkText(item, LIMITS.URL);
    if (text.error) {
      fail(path, text.error);
      return undefined;
    }
    if (text.value.startsWith('//') || SCHEME.test(text.value)) {
      const url = checkUrl(text.value);
      if (url.error) {
        fail(path, url.error);
        return undefined;
      }
      return url.value;
    }
    if (text.value.length > LIMITS.FONTE_NOME) {
      fail(path, ERROR.TEXTO_LONGO);
      return undefined;
    }
    return text.value;
  }
  if (!isPlainObject(item)) {
    fail(path, ERROR.TIPO_INVALIDO);
    return undefined;
  }
  const entries = ownEntries(item);
  if (entries === null) {
    fail(path, ERROR.ESTRUTURA_INVALIDA);
    return undefined;
  }
  const present = new Map(entries.filter(([, v]) => v !== undefined));
  let ok = true;
  for (const [key] of present) {
    if (!SOURCE_KEYS.includes(key)) {
      fail(`${path}.${safeKey(key)}`, ERROR.CAMPO_DESCONHECIDO);
      ok = false;
    }
  }
  const source = {};
  const optionalKey = (key, check) => {
    if (!present.has(key) || present.get(key) === null) return;
    const result = check(present.get(key));
    if (result.error) {
      fail(`${path}.${key}`, result.error);
      ok = false;
    } else source[key] = result.value;
  };
  optionalKey('fonte', (v) => checkText(v, LIMITS.FONTE_NOME));
  optionalKey('url', checkUrl);
  optionalKey('dataConsulta', (v) => checkDate(v, now));
  optionalKey('campo', (v) => (typeof v === 'string' && EVIDENCE_FIELDS.includes(v) ? { value: v } : { error: typeof v === 'string' ? ERROR.VALOR_INVALIDO : ERROR.TIPO_INVALIDO }));
  optionalKey('tipoFonte', checkSourceType);
  optionalKey('observacao', (v) => checkText(v, LIMITS.OBSERVACAO_FONTE, { allowNewlines: true }));
  if (ok && source.fonte === undefined && source.url === undefined) {
    fail(path, ERROR.CAMPO_OBRIGATORIO);
    ok = false;
  }
  return ok ? source : undefined;
}

// Valida uma LISTA de achados (um lote). Cada achado é validado por si só: um achado ruim não derruba os bons. Nunca lança.
// Devolve { ok, items: [{ index, ok, value | errors }], validos: [valores], errors }.
function validateRawFindings(list, { now = new Date() } = {}) {
  if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype) {
    return { ok: false, items: [], validos: [], errors: [{ path: '', code: ERROR.NAO_E_LISTA, message: MESSAGES.NAO_E_LISTA }] };
  }
  if (list.length > LIMITS.ACHADOS_POR_LOTE) {
    return { ok: false, items: [], validos: [], errors: [{ path: '', code: ERROR.LOTE_EXCESSIVO, message: MESSAGES.LOTE_EXCESSIVO }] };
  }
  const items = [];
  for (let index = 0; index < list.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
    const raw = descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    items.push({ index, ...validateRawFinding(raw, { now }) });
  }
  return { ok: items.every((item) => item.ok), items, validos: items.filter((item) => item.ok).map((item) => item.value), errors: [] };
}

// checkText e MESSAGES também são usados por quem valida o BRIEFING (Prospecting Service): os mesmos limites e as mesmas frases, sem
// uma segunda implementação de "texto seguro".
// Os primitivos de validação também são usados pelo esquema do DOSSIÊ (signalSchema.js / dossier.js): a mesma definição de "texto
// seguro", "URL pública https", "data ISO real" e "estrutura de dado puro" — nenhuma segunda implementação.
module.exports = { LIMITS, ERROR, MESSAGES, SOURCE_TYPES, isPlainObject, ownEntries, ownItems, measure, checkText, checkUrl, checkDate, validateRawFinding, validateRawFindings };
