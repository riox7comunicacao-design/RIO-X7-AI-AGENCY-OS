// rawFinding V2 — o achado bruto com o bloco OPCIONAL `dossie` (decisão 0020).
//
// Um achado V2 é o achado V1 (rawFindingSchema.js, INALTERADO) + `dossie?: { fatos?, analises? }`:
//   - `campos` continua sendo a fonte da IDENTIDADE e da PRESENÇA dos canais (site, Instagram, Facebook, LinkedIn, YouTube, Google, WhatsApp);
//   - `dossie.fatos` traz só OBSERVAÇÕES sobre esses canais e sobre anúncios (o catálogo de observação de signalSchema.OBSERVATION_FIELDS:
//     data da última postagem, datas de postagens, CTA do Instagram, CTA de WhatsApp/agendamento e formulário do site, anúncios Meta/Google);
//     um fato de identidade (`*.url`, `whatsapp.publico`) é RECUSADO aqui (CAMPO_DE_IDENTIDADE): nunca há duas fontes de verdade para a
//     identidade, e um conflito de identidade fica preservado como conflito (o dossiê o mostra), nunca resolvido em silêncio;
//   - uma observação de um canal exige o canal em `campos` (OBSERVACAO_SEM_CANAL);
//   - `dossie.analises` traz análises e hipóteses do agente, SEPARADAS dos fatos, sempre com `baseadoEm` (nunca DADO, nunca decisão).
//
// Por que um módulo à parte (e não dentro do rawFindingSchema): o esquema do dossiê já USA os primitivos do rawFindingSchema; validar o
// bloco lá criaria uma dependência circular. Aqui o bloco é separado do achado, o achado é validado pelo rawFindingSchema (sem nenhuma
// duplicação) e o bloco é validado EXECUTANDO o buildDossier — o único validador de fatos, fontes, sinais e análises — sobre os fatos
// derivados de `campos` + os fatos do bloco (validação antecipada: uma recusa aqui é uma recusa da submissão inteira, antes do CRM).
//
// NUNCA se corta nada em silêncio: o excesso de evidências, de fatos, de postagens ou de análises é RECUSADO com um código estável
// (EVIDENCIAS_EXCESSIVAS, FATOS_EXCESSIVOS, FATOS_DO_CAMPO_EXCESSIVOS, ANALISES_EXCESSIVAS...), sem devolver o conteúdo recusado.
// Função pura: sem CRM, sem disco, sem rede; o relógio é injetado.

const { validateRawFindings, isPlainObject, ownEntries, ownItems, measure, ERROR: SCHEMA_ERROR, LIMITS: SCHEMA_LIMITS } = require('./rawFindingSchema');
const { buildDossier, MESSAGES: DOSSIER_MESSAGES } = require('./dossier');
const { factsFromFinding } = require('./dossierFromFinding');
const { FACT_CATALOG, OBSERVATION_FIELDS } = require('./signalSchema');

// Fatos do bloco: 25 = os 60 do dossiê menos os até 35 derivados de `campos` (7 campos x 5 evidências): nunca estoura o dossiê.
const LIMITS = Object.freeze({ FATOS: 25, ANALISES: 10 });

const ERROR = Object.freeze({
  CAMPO_DE_IDENTIDADE: 'CAMPO_DE_IDENTIDADE',
  OBSERVACAO_SEM_CANAL: 'OBSERVACAO_SEM_CANAL',
});

const MESSAGES = Object.freeze({
  ...DOSSIER_MESSAGES,
  CAMPO_DE_IDENTIDADE: 'a identidade e a presença dos canais vêm de `campos`; o bloco dossie só traz observações',
  OBSERVACAO_SEM_CANAL: 'a observação de um canal exige o canal informado em `campos`',
});

const BLOCK_KEYS = Object.freeze(['fatos', 'analises']);
const TRIAL_ID = 'dossie:00000000-0000-4000-8000-000000000000';
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const safeKey = (key) => (/^[A-Za-z]{1,40}$/.test(key) ? key : '?');
const withMessage = (path, code) => ({ path, code, message: MESSAGES[code] });

// O caminho de um erro do buildDossier (fatos derivados de `campos` + fatos do bloco, na ordem) vira o caminho no achado.
function mapPath(path, derived) {
  const fact = /^fatos\[(\d+)\](.*)$/.exec(path);
  if (fact) return Number(fact[1]) >= derived ? `dossie.fatos[${Number(fact[1]) - derived}]${fact[2]}` : 'campos';
  if (path === 'fatos' || path.startsWith('fatos.') || path.startsWith('analises')) return `dossie.${path}`;
  return 'dossie';
}

// Valida o bloco de UM achado (já validado pelo rawFindingSchema). Devolve { ok: true, value: { fatos, analises } } (cópias) ou { ok: false, errors }.
function validateDossieBlock(block, finding, { now = new Date() } = {}) {
  if (!isPlainObject(block)) return { ok: false, errors: [withMessage('dossie', SCHEMA_ERROR.NAO_E_OBJETO)] };
  const structure = measure(block);
  if (structure) return { ok: false, errors: [withMessage('dossie', structure)] };
  const entries = ownEntries(block);
  if (entries === null) return { ok: false, errors: [withMessage('dossie', SCHEMA_ERROR.ESTRUTURA_INVALIDA)] };

  const errors = [];
  const present = new Map(entries.filter(([, v]) => v !== undefined && v !== null));
  for (const [key] of entries) if (!BLOCK_KEYS.includes(key)) errors.push(withMessage(`dossie.${safeKey(key)}`, SCHEMA_ERROR.CAMPO_DESCONHECIDO));

  const lists = {};
  for (const [key, max, code] of [['fatos', LIMITS.FATOS, 'FATOS_EXCESSIVOS'], ['analises', LIMITS.ANALISES, 'ANALISES_EXCESSIVAS']]) {
    if (!present.has(key)) {
      lists[key] = [];
      continue;
    }
    const raw = present.get(key);
    const items = Array.isArray(raw) ? ownItems(raw) : null;
    if (!Array.isArray(raw)) errors.push(withMessage(`dossie.${key}`, SCHEMA_ERROR.NAO_E_LISTA));
    else if (items === null) errors.push(withMessage(`dossie.${key}`, SCHEMA_ERROR.ESTRUTURA_INVALIDA));
    else if (items.length > max) errors.push(withMessage(`dossie.${key}`, code));
    else lists[key] = items;
  }

  // Só observações, e só de canais informados em `campos`.
  const campos = finding && isPlainObject(finding.campos) ? finding.campos : {};
  (lists.fatos || []).forEach((item, index) => {
    const fields = isPlainObject(item) ? ownEntries(item) : null;
    const campo = fields === null ? undefined : (fields.find(([key]) => key === 'campo') || [])[1];
    if (typeof campo !== 'string' || !hasOwn(FACT_CATALOG, campo)) return; // o buildDossier recusa (campo desconhecido, estrutura...)
    if (!hasOwn(OBSERVATION_FIELDS, campo)) errors.push(withMessage(`dossie.fatos[${index}].campo`, ERROR.CAMPO_DE_IDENTIDADE));
    else if (OBSERVATION_FIELDS[campo] !== null && !(hasOwn(campos, OBSERVATION_FIELDS[campo]) && Array.isArray(campos[OBSERVATION_FIELDS[campo]]) && campos[OBSERVATION_FIELDS[campo]].length > 0)) {
      errors.push(withMessage(`dossie.fatos[${index}].campo`, ERROR.OBSERVACAO_SEM_CANAL));
    }
  });
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, SCHEMA_LIMITS.MAX_ERRORS) };

  // Validação antecipada: o buildDossier (o único validador) sobre os fatos de `campos` + os do bloco + as análises.
  const derived = factsFromFinding(finding, now.toISOString().slice(0, 10));
  const built = buildDossier({ prospectId: 'validacao', fatos: [...derived, ...lists.fatos], analises: lists.analises }, { now, newId: () => TRIAL_ID });
  if (!built.ok) {
    const mapped = built.errors.map((error) => withMessage(mapPath(error.path, derived.length), error.code));
    return { ok: false, errors: mapped.slice(0, SCHEMA_LIMITS.MAX_ERRORS) };
  }
  return { ok: true, value: { fatos: structuredClone(lists.fatos), analises: structuredClone(lists.analises) } };
}

// Valida uma LISTA de achados V2 (o bloco `dossie` é opcional em cada um). Mesma forma de retorno de validateRawFindings; um achado válido com
// bloco traz `value.dossie = { fatos, analises }` (o resto do achado é exatamente o do V1). Tudo ou nada é decisão de quem chama.
function validateRawFindingsV2(list, { now = new Date() } = {}) {
  if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype || list.length > SCHEMA_LIMITS.ACHADOS_POR_LOTE) return validateRawFindings(list, { now });

  const stripped = [];
  const blocks = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
    const raw = descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    const entries = isPlainObject(raw) ? ownEntries(raw) : null;
    const at = entries === null ? -1 : entries.findIndex(([key]) => key === 'dossie');
    if (at >= 0) {
      if (entries[at][1] !== undefined && entries[at][1] !== null) blocks.set(index, entries[at][1]);
      stripped.push(Object.fromEntries(entries.filter((_, position) => position !== at)));
    } else stripped.push(raw);
  }

  const v1 = validateRawFindings(stripped, { now });
  const items = v1.items.map((item) => {
    if (!item.ok || !blocks.has(item.index)) return item;
    const checked = validateDossieBlock(blocks.get(item.index), item.value, { now });
    return checked.ok ? { ...item, value: { ...item.value, dossie: checked.value } } : { index: item.index, ok: false, errors: checked.errors };
  });
  return { ok: items.every((item) => item.ok), items, validos: items.filter((item) => item.ok).map((item) => item.value), errors: [] };
}

module.exports = { LIMITS, ERROR, MESSAGES, validateDossieBlock, validateRawFindingsV2 };
