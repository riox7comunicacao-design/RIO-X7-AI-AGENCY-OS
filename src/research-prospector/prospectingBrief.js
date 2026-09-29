// BRIEFING de prospecção (Etapa "Prospecção 1 — Workbench Operacional") — o modelo de ENTRADA que o usuário
// preenche no Workbench, ANTES de qualquer pesquisa existir. Módulo PURO (sem I/O, sem rede, sem relógio próprio):
// só validação e algumas funções de apoio (resumo de geografia, id amigável do brief).
//
// POR QUE É UM MODELO NOVO (e não uma extensão do briefing de src/services/prospectingService.js): o briefing já
// existente (`nicho, quantidadeDesejada, regiao, tipo, exclusoes, observacoes`) é a entrada de UMA submissão atômica
// (briefing + achados no mesmo instante) e tem cobertura de teste extensa e específica para essa forma exata
// (tests/services/prospectingService.test.js, [PSV-9]..[PSV-16]). O Workbench precisa de um formulário ANTES de
// haver achados (nicho, SUBNICHO, nível geográfico estruturado — cidade(s)/estado(s)/nacional — e uma quantidade
// mais estrita, 1 a 300) que é preservado integralmente para exibição. Em vez de reabrir aquele contrato (risco de
// regressão num módulo já em produção, sem necessidade real), este módulo valida a entrada RICA do Workbench e,
// na hora de efetivamente enviar para o Prospecting Service existente (prospectingBriefService.js), DERIVA um
// resumo textual de geografia para o campo `regiao` já aceito por ele — nada se perde: o brief completo (com
// cidades/estados/país/subnicho) continua gravado e visível na tela; só a ENTREGA à pesquisa/discovery existente
// usa uma representação compacta.

const GEO_LEVEL = Object.freeze({ CIDADE: 'CIDADE', ESTADO: 'ESTADO', NACIONAL: 'NACIONAL' });
const GEO_LEVELS = Object.freeze(Object.values(GEO_LEVEL));

const BRIEF_STATUS = Object.freeze({
  RASCUNHO: 'RASCUNHO',
  PRONTO_PARA_PESQUISA: 'PRONTO_PARA_PESQUISA',
  PESQUISANDO: 'PESQUISANDO',
  AGUARDANDO_REVISAO: 'AGUARDANDO_REVISAO',
  CONCLUIDO: 'CONCLUIDO',
  CANCELADO: 'CANCELADO',
});

const DEFAULT_PAIS = 'Brasil';

const LIMITS = Object.freeze({
  NICHO: 120,
  SUBNICHO: 120,
  LOCAL: 120,
  PAIS: 60,
  OBSERVACOES: 2000,
  MAX_LOCAIS: 20,
  QUANTIDADE_MIN: 1,
  QUANTIDADE_MAX: 300,
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
const isText = (value) => typeof value === 'string';

function checkText(value, max, { required = false } = {}) {
  if (value === undefined || value === null) return required ? { error: 'CAMPO_OBRIGATORIO' } : { value: undefined };
  if (!isText(value)) return { error: 'VALOR_INVALIDO' };
  const trimmed = value.trim();
  if (required && trimmed.length === 0) return { error: 'CAMPO_OBRIGATORIO' };
  if (trimmed.length > max) return { error: 'TAMANHO_EXCESSIVO' };
  return { value: trimmed.length === 0 ? undefined : trimmed };
}

// "Petrópolis, Teresópolis" -> ['Petrópolis', 'Teresópolis']: separa por vírgula, apara espaços, remove vazios e
// duplicatas (preservando a primeira ocorrência) — nunca inventa uma cidade/estado que não foi digitado.
function splitList(raw) {
  if (!isText(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const parte of raw.split(',')) {
    const valor = parte.trim();
    if (valor === '' || seen.has(valor.toLowerCase())) continue;
    seen.add(valor.toLowerCase());
    out.push(valor);
  }
  return out;
}

const BRIEF_INPUT_KEYS = Object.freeze(['nicho', 'subnicho', 'nivelGeografico', 'cidades', 'estados', 'pais', 'quantidade', 'observacoes']);

// Valida a entrada do formulário "Novo lote" do Workbench. Devolve { ok: true, value } com o brief PRONTO para
// gravar, ou { ok: false, errors } (caminho + código, nunca o valor recusado). Só campos CONHECIDOS são aceitos —
// nada de identidade, decisão, status ou id vindo do cliente (isso é gerado pelo Service, nunca por aqui).
function validateBriefInput(raw) {
  if (!isPlainObject(raw)) return { ok: false, errors: [{ path: '', code: 'NAO_E_OBJETO' }] };
  const unknown = Object.keys(raw).filter((key) => !BRIEF_INPUT_KEYS.includes(key));
  const errors = unknown.map((key) => ({ path: key, code: 'CAMPO_DESCONHECIDO' }));
  const value = {};

  const nicho = checkText(raw.nicho, LIMITS.NICHO, { required: true });
  if (nicho.error) errors.push({ path: 'nicho', code: nicho.error });
  else value.nicho = nicho.value;

  const subnicho = checkText(raw.subnicho, LIMITS.SUBNICHO);
  if (subnicho.error) errors.push({ path: 'subnicho', code: subnicho.error });
  else if (subnicho.value !== undefined) value.subnicho = subnicho.value;

  const nivel = raw.nivelGeografico;
  if (!isText(nivel) || !GEO_LEVELS.includes(nivel)) {
    errors.push({ path: 'nivelGeografico', code: hasOwn(raw, 'nivelGeografico') ? 'VALOR_INVALIDO' : 'CAMPO_OBRIGATORIO' });
  } else {
    value.nivelGeografico = nivel;
  }

  function readLocais(key) {
    if (!hasOwn(raw, key) || raw[key] === undefined || raw[key] === null) return { locais: [] };
    const partes = Array.isArray(raw[key]) ? raw[key] : splitList(raw[key]);
    if (!Array.isArray(partes)) return { error: 'VALOR_INVALIDO' };
    if (partes.length > LIMITS.MAX_LOCAIS) return { error: 'TAMANHO_EXCESSIVO' };
    const locais = [];
    for (const item of partes) {
      const checked = checkText(item, LIMITS.LOCAL, { required: true });
      if (checked.error) return { error: checked.error };
      locais.push(checked.value);
    }
    return { locais };
  }

  if (value.nivelGeografico === GEO_LEVEL.CIDADE) {
    const cidades = readLocais('cidades');
    if (cidades.error) errors.push({ path: 'cidades', code: cidades.error });
    else if (cidades.locais.length === 0) errors.push({ path: 'cidades', code: 'CAMPO_OBRIGATORIO' });
    else value.cidades = cidades.locais;
  } else if (value.nivelGeografico === GEO_LEVEL.ESTADO) {
    const estados = readLocais('estados');
    if (estados.error) errors.push({ path: 'estados', code: estados.error });
    else if (estados.locais.length === 0) errors.push({ path: 'estados', code: 'CAMPO_OBRIGATORIO' });
    else value.estados = estados.locais;
  } else if (value.nivelGeografico === GEO_LEVEL.NACIONAL) {
    const pais = checkText(raw.pais, LIMITS.PAIS);
    if (pais.error) errors.push({ path: 'pais', code: pais.error });
    else value.pais = pais.value || DEFAULT_PAIS;
  }

  const quantidade = raw.quantidade;
  if (typeof quantidade !== 'number' || !Number.isInteger(quantidade) || quantidade < LIMITS.QUANTIDADE_MIN || quantidade > LIMITS.QUANTIDADE_MAX) {
    errors.push({ path: 'quantidade', code: hasOwn(raw, 'quantidade') ? 'VALOR_INVALIDO' : 'CAMPO_OBRIGATORIO' });
  } else {
    value.quantidade = quantidade;
  }

  const observacoes = checkText(raw.observacoes, LIMITS.OBSERVACOES);
  if (observacoes.error) errors.push({ path: 'observacoes', code: observacoes.error });
  else if (observacoes.value !== undefined) value.observacoes = observacoes.value;

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

// Um resumo TEXTUAL da geografia — usado só para preencher `regiao` do briefing já existente
// (src/services/prospectingService.js) na hora de efetivamente pesquisar; nunca substitui os campos estruturados
// do brief (que continuam gravados e são o que a tela mostra).
function summarizeGeografia(brief) {
  if (brief.nivelGeografico === GEO_LEVEL.CIDADE) return `Cidade: ${brief.cidades.join(', ')}`;
  if (brief.nivelGeografico === GEO_LEVEL.ESTADO) return `Estado: ${brief.estados.join(', ')}`;
  return `Nacional: ${brief.pais || DEFAULT_PAIS}`;
}

// PROS-20260929-001 — ano/mês/dia (UTC) + sequência do dia, com 3 dígitos (nunca reaproveita um número: a
// sequência vem de quantos briefs já existem para o mesmo dia, decidido por quem chama — o Service, que já leu o
// repositório).
function buildBriefId(date, sequenceForDay) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const seq = String(sequenceForDay).padStart(3, '0');
  return `PROS-${yyyy}${mm}${dd}-${seq}`;
}

const BRIEF_ID_PATTERN = /^PROS-\d{8}-\d{3}$/;

module.exports = {
  GEO_LEVEL,
  GEO_LEVELS,
  BRIEF_STATUS,
  BRIEF_INPUT_KEYS,
  LIMITS,
  DEFAULT_PAIS,
  BRIEF_ID_PATTERN,
  validateBriefInput,
  summarizeGeografia,
  buildBriefId,
  splitList,
};
