// DOSSIÊ DE PESQUISA do Prospector — a entidade que guarda FATOS, SINAIS e ANÁLISES de um prospect (decisão 0018).
//
// SEPARAÇÃO RÍGIDA (a razão de existir deste módulo):
//   A) identidade e contato do prospect  -> Approval Queue / CRM  (NÃO está aqui)
//   B) fatos da pesquisa                 -> dossiê (status DADO | NAO_VERIFICADO, sempre com data e, quando DADO, com fonte)
//   C) sinais derivados                  -> dossiê (derivados por regras fixas dos fatos; o consumidor nunca envia um sinal)
//   D) análises e hipóteses              -> dossiê (status ANALISE | HIPOTESE, sempre apoiadas em fatos/sinais do próprio dossiê)
// Nada daqui vira automaticamente problemaIdentificado, temperatura, score, ranking, prioridade comercial ou decisão de aprovação —
// este módulo NÃO calcula nenhuma dessas coisas e NÃO conhece o CRM (não importa src/crm, nem serviço, nem API): o dossiê é independente.
// O dossiê também NÃO altera a Approval Queue: ele tem identidade própria (dossierId) e só GUARDA o prospectId (e, se houver, o loteId).
//
// buildDossier(entrada, { now, newId }) valida a entrada (dado NÃO CONFIÁVEL: tudo pelos primitivos de rawFindingSchema — texto seguro,
// URL https pública, data ISO real, estrutura de dado puro, limites de tamanho, quantidade e profundidade) e DERIVA tudo o que é do sistema:
// dossierId, criadoEm, dataDaPesquisa (a data mais recente observada nos fatos; sem fatos, a de agora), factId de cada fato, os sinais,
// analiseId de cada análise e a lista de fontes. A entrada aceita EXATAMENTE { prospectId, loteId?, fatos, analises? }: qualquer campo
// derivado (dossierId, criadoEm, dataDaPesquisa, sinais, fontes, status de sinal...) é recusado — nunca é autoridade externa.
//
// Devolve { ok: true, value } ou { ok: false, errors: [{ path, code, message }] }; nunca lança por conteúdo do dado, e o erro nunca repete o valor
// recusado. Função pura (só usa o relógio e o gerador de id INJETADOS; os padrões são Date e crypto.randomUUID).

const crypto = require('node:crypto');

const { ERROR: SCHEMA_ERROR, MESSAGES: SCHEMA_MESSAGES, isPlainObject, ownEntries, ownItems, measure, checkText, LIMITS: SCHEMA_LIMITS } = require('./rawFindingSchema');
const { BATCH_ID_PATTERN } = require('./batchRepository');
const { ANALYSIS_STATUS, FACT_STATUS, SIGNAL_STATUS, SIGNAL_TYPE, validateFact, deriveSignals, DATE_PART } = require('./signalSchema');

const DOSSIER_ID_PATTERN = /^dossie:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LIMITS = Object.freeze({
  PROSPECT_ID: 200,
  FATOS: 60,
  FATOS_POR_CAMPO: 5,
  ANALISES: 20,
  TEXTO_ANALISE: 600,
  BASE_POR_ANALISE: 10,
});

// Os tipos de análise: vocabulário FECHADO e pequeno (o consumidor não inventa categorias).
const ANALYSIS_TYPE = Object.freeze({
  PRESENCA_DIGITAL: 'PRESENCA_DIGITAL',
  ATIVIDADE_SOCIAL: 'ATIVIDADE_SOCIAL',
  CONVERSAO: 'CONVERSAO',
  ANUNCIOS: 'ANUNCIOS',
  OUTRO: 'OUTRO',
});

const DOSSIER_ERROR = Object.freeze({
  STATUS_INVALIDO: 'STATUS_INVALIDO',
  DATA_DIVERGENTE: 'DATA_DIVERGENTE',
  VALOR_EM_FATO_NAO_VERIFICADO: 'VALOR_EM_FATO_NAO_VERIFICADO',
  FATOS_EXCESSIVOS: 'FATOS_EXCESSIVOS',
  FATOS_DO_CAMPO_EXCESSIVOS: 'FATOS_DO_CAMPO_EXCESSIVOS',
  ANALISES_EXCESSIVAS: 'ANALISES_EXCESSIVAS',
  BASE_EXCESSIVA: 'BASE_EXCESSIVA',
  REFERENCIA_INVALIDA: 'REFERENCIA_INVALIDA',
  ANALISE_SEM_BASE: 'ANALISE_SEM_BASE',
  ANALISE_SEM_EVIDENCIA: 'ANALISE_SEM_EVIDENCIA',
  TEXTO_PROIBIDO: 'TEXTO_PROIBIDO',
  POSTAGEM_APOS_OBSERVACAO: 'POSTAGEM_APOS_OBSERVACAO',
  POSTAGENS_INCONSISTENTES: 'POSTAGENS_INCONSISTENTES',
  ID_INVALIDO: 'ID_INVALIDO',
});

const MESSAGES = Object.freeze({
  ...SCHEMA_MESSAGES,
  STATUS_INVALIDO: 'status desconhecido para este tipo de item',
  DATA_DIVERGENTE: 'a data da fonte difere da data da observação do fato',
  VALOR_EM_FATO_NAO_VERIFICADO: 'um fato NAO_VERIFICADO não tem valor (a pesquisa não confirmou nada)',
  FATOS_EXCESSIVOS: 'fatos demais no dossiê',
  FATOS_DO_CAMPO_EXCESSIVOS: 'fatos demais para o mesmo campo',
  ANALISES_EXCESSIVAS: 'análises demais no dossiê',
  BASE_EXCESSIVA: 'referências demais na base da análise',
  REFERENCIA_INVALIDA: 'a análise cita um fato ou sinal que não existe neste dossiê',
  ANALISE_SEM_BASE: 'toda análise ou hipótese precisa citar ao menos um fato ou sinal do dossiê',
  ANALISE_SEM_EVIDENCIA: 'uma ANALISE precisa se apoiar em ao menos um fato ou sinal DADO (sem isso só pode ser HIPOTESE)',
  TEXTO_PROIBIDO: 'o texto tem promessa de resultado, urgência artificial ou afirmação negativa sobre anúncios',
  POSTAGEM_APOS_OBSERVACAO: 'uma postagem não pode ser posterior à data da observação',
  POSTAGENS_INCONSISTENTES: 'a última postagem não coincide com a mais recente das postagens observadas',
  ID_INVALIDO: 'identificador com formato inválido',
});

// Texto de análise que NÃO passa: promessa de resultado, urgência artificial e a afirmação negativa que a pesquisa nunca pode fazer
// ("não anuncia" — o máximo é "não encontrado na verificação"). É uma trava DETERMINÍSTICA e conservadora, não uma prova de tom.
const FORBIDDEN_TEXT = [
  /\bgarant\w*/i,
  /\bresultado\s+(certo|assegurado)/i,
  /\burg[eê]nci\w*|\burgente\b/i,
  /\b[uú]ltima\s+chance\b/i,
  /\bimperd[ií]vel\b/i,
  /\bs[oó]\s+hoje\b/i,
  /\b(dobrar|triplicar|multiplicar)\b/i,
  /\bvai\s+(aumentar|dobrar|triplicar|crescer)\b/i,
  /\bn[ãa]o\s+(anuncia|faz\s+an[úu]ncios?|investe\s+em\s+an[úu]ncios?|tem\s+an[úu]ncios?|possui\s+an[úu]ncios?)\b/i,
];

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const safeKey = (key) => (/^[A-Za-z]{1,40}$/.test(key) ? key : '?');
const TOP_KEYS = Object.freeze(['prospectId', 'loteId', 'fatos', 'analises']);
const ANALYSIS_KEYS = Object.freeze(['tipo', 'texto', 'baseadoEm', 'status']);

function createCollector() {
  const errors = [];
  return {
    errors,
    add(path, code) {
      if (errors.length < SCHEMA_LIMITS.MAX_ERRORS) errors.push({ path, code, message: MESSAGES[code] });
    },
    addAll(list) {
      for (const item of list) this.add(item.path, item.code);
    },
  };
}

// Lista de dado puro (sem lacunas, sem propriedades extras) ou null.
const listOf = (value) => (Array.isArray(value) ? ownItems(value) : null);

function checkAnalyses(rawList, path, fatos, sinais, fail) {
  const items = listOf(rawList);
  if (items === null) {
    fail(path, Array.isArray(rawList) ? SCHEMA_ERROR.ESTRUTURA_INVALIDA : SCHEMA_ERROR.NAO_E_LISTA);
    return [];
  }
  if (items.length > LIMITS.ANALISES) {
    fail(path, DOSSIER_ERROR.ANALISES_EXCESSIVAS);
    return [];
  }
  const factsByField = new Map();
  for (const fato of fatos) {
    if (!factsByField.has(fato.campo)) factsByField.set(fato.campo, []);
    factsByField.get(fato.campo).push(fato);
  }
  const signalByType = new Map(sinais.map((sinal) => [sinal.tipo, sinal]));
  const analyses = [];

  items.forEach((item, index) => {
    const at = `${path}[${index}]`;
    if (!isPlainObject(item)) return fail(at, SCHEMA_ERROR.NAO_E_OBJETO);
    const entries = ownEntries(item);
    if (entries === null) return fail(at, SCHEMA_ERROR.ESTRUTURA_INVALIDA);
    const present = new Map(entries.filter(([, v]) => v !== undefined));
    let ok = true;
    for (const [key] of present) {
      if (!ANALYSIS_KEYS.includes(key)) {
        fail(`${at}.${safeKey(key)}`, SCHEMA_ERROR.CAMPO_DESCONHECIDO);
        ok = false;
      }
    }
    const analysis = {};

    const tipo = present.get('tipo');
    if (typeof tipo !== 'string' || !hasOwn(ANALYSIS_TYPE, tipo)) {
      fail(`${at}.tipo`, tipo === undefined || tipo === null ? SCHEMA_ERROR.CAMPO_OBRIGATORIO : typeof tipo === 'string' ? SCHEMA_ERROR.VALOR_INVALIDO : SCHEMA_ERROR.TIPO_INVALIDO);
      ok = false;
    } else analysis.tipo = tipo;

    const status = present.get('status');
    // Só ANALISE ou HIPOTESE: um item de análise nunca é DADO (nem VALIDADO, nem NAO_VERIFICADO) e uma hipótese nunca vira fato.
    if (status === undefined || status === null) {
      fail(`${at}.status`, SCHEMA_ERROR.CAMPO_OBRIGATORIO);
      ok = false;
    } else if (typeof status !== 'string') {
      fail(`${at}.status`, SCHEMA_ERROR.TIPO_INVALIDO);
      ok = false;
    } else if (!hasOwn(ANALYSIS_STATUS, status)) {
      fail(`${at}.status`, DOSSIER_ERROR.STATUS_INVALIDO);
      ok = false;
    } else analysis.status = status;

    if (!present.has('texto') || present.get('texto') === null) {
      fail(`${at}.texto`, SCHEMA_ERROR.CAMPO_OBRIGATORIO);
      ok = false;
    } else {
      const texto = checkText(present.get('texto'), LIMITS.TEXTO_ANALISE, { allowNewlines: true });
      if (texto.error) {
        fail(`${at}.texto`, texto.error);
        ok = false;
      } else if (FORBIDDEN_TEXT.some((rule) => rule.test(texto.value))) {
        fail(`${at}.texto`, DOSSIER_ERROR.TEXTO_PROIBIDO);
        ok = false;
      } else analysis.texto = texto.value;
    }

    // baseadoEm: 1 a 10 referências { fato: <campo> } ou { sinal: <tipo> }, resolvidas para ids do PRÓPRIO dossiê.
    const baseRaw = present.get('baseadoEm');
    const baseItems = baseRaw === undefined || baseRaw === null ? [] : listOf(baseRaw);
    if (baseItems === null) {
      fail(`${at}.baseadoEm`, Array.isArray(baseRaw) ? SCHEMA_ERROR.ESTRUTURA_INVALIDA : SCHEMA_ERROR.NAO_E_LISTA);
      ok = false;
    } else if (baseItems.length === 0) {
      fail(`${at}.baseadoEm`, DOSSIER_ERROR.ANALISE_SEM_BASE);
      ok = false;
    } else if (baseItems.length > LIMITS.BASE_POR_ANALISE) {
      fail(`${at}.baseadoEm`, DOSSIER_ERROR.BASE_EXCESSIVA);
      ok = false;
    } else {
      const resolved = [];
      let hasEvidence = false;
      baseItems.forEach((ref, refIndex) => {
        const refAt = `${at}.baseadoEm[${refIndex}]`;
        const refEntries = isPlainObject(ref) ? ownEntries(ref) : null;
        if (refEntries === null || refEntries.length !== 1 || !['fato', 'sinal'].includes(refEntries[0][0]) || typeof refEntries[0][1] !== 'string') {
          fail(refAt, SCHEMA_ERROR.ESTRUTURA_INVALIDA);
          ok = false;
          return;
        }
        const [kind, name] = refEntries[0];
        if (kind === 'fato') {
          const found = factsByField.get(name) || null;
          if (!found) {
            fail(refAt, DOSSIER_ERROR.REFERENCIA_INVALIDA);
            ok = false;
            return;
          }
          for (const fato of found) {
            resolved.push(fato.factId);
            if (fato.status === FACT_STATUS.DADO) hasEvidence = true;
          }
        } else {
          const sinal = signalByType.get(name);
          if (!sinal) {
            fail(refAt, DOSSIER_ERROR.REFERENCIA_INVALIDA);
            ok = false;
            return;
          }
          resolved.push(sinal.sinalId);
          if (sinal.status === SIGNAL_STATUS.DADO) hasEvidence = true;
        }
      });
      if (ok && analysis.status === ANALYSIS_STATUS.ANALISE && !hasEvidence) {
        fail(`${at}.status`, DOSSIER_ERROR.ANALISE_SEM_EVIDENCIA);
        ok = false;
      }
      analysis.baseadoEm = [...new Set(resolved)];
    }
    if (ok) analyses.push({ analiseId: `analise:${String(analyses.length + 1).padStart(3, '0')}`, tipo: analysis.tipo, texto: analysis.texto, baseadoEm: analysis.baseadoEm, status: analysis.status });
    return undefined;
  });
  return analyses;
}

// As fontes do dossiê são DERIVADAS dos fatos (uma por combinação url + tipo + data), na ordem de aparição — nunca vêm de fora.
function deriveSources(fatos) {
  const seen = new Set();
  const sources = [];
  for (const fato of fatos) {
    if (!fato.fonte) continue;
    const key = `${fato.fonte.url}|${fato.fonte.tipo}|${DATE_PART(fato.fonte.observadoEm)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ ...fato.fonte });
  }
  return sources;
}

// Coerência dos fatos do Instagram: nenhuma postagem é posterior à observação, e a última postagem é a mais recente das observadas.
function checkInstagramConsistency(fatos, fail) {
  const ultima = fatos.find((fato) => fato.campo === 'instagram.ultimaPostagemEm' && fato.status === FACT_STATUS.DADO);
  const postagens = fatos.find((fato) => fato.campo === 'instagram.postagensObservadas' && fato.status === FACT_STATUS.DADO);
  for (const fato of [ultima, postagens]) {
    if (!fato) continue;
    const datas = Array.isArray(fato.valor) ? fato.valor : [DATE_PART(fato.valor)];
    if (datas.some((data) => data > DATE_PART(fato.observadoEm))) fail(`fatos.${fato.campo}`, DOSSIER_ERROR.POSTAGEM_APOS_OBSERVACAO);
  }
  if (ultima && postagens && DATE_PART(ultima.valor) !== postagens.valor[postagens.valor.length - 1]) fail('fatos.instagram.ultimaPostagemEm', DOSSIER_ERROR.POSTAGENS_INCONSISTENTES);
}

function buildDossier(input, { now = new Date(), newId = () => `dossie:${crypto.randomUUID()}` } = {}) {
  const collector = createCollector();
  const fail = (path, code) => collector.add(path, code);

  if (!isPlainObject(input)) {
    fail('', SCHEMA_ERROR.NAO_E_OBJETO);
    return { ok: false, errors: collector.errors };
  }
  const structure = measure(input);
  if (structure) {
    fail('', structure);
    return { ok: false, errors: collector.errors };
  }
  const entries = ownEntries(input);
  if (entries === null) {
    fail('', SCHEMA_ERROR.ESTRUTURA_INVALIDA);
    return { ok: false, errors: collector.errors };
  }
  const present = new Map(entries.filter(([, v]) => v !== undefined));
  for (const [key] of present) if (!TOP_KEYS.includes(key)) fail(safeKey(key), SCHEMA_ERROR.CAMPO_DESCONHECIDO);

  let prospectId;
  if (!present.has('prospectId') || present.get('prospectId') === null) fail('prospectId', SCHEMA_ERROR.CAMPO_OBRIGATORIO);
  else {
    const checked = checkText(present.get('prospectId'), LIMITS.PROSPECT_ID);
    if (checked.error) fail('prospectId', checked.error);
    else prospectId = checked.value;
  }

  let loteId = null;
  if (present.has('loteId') && present.get('loteId') !== null) {
    const raw = present.get('loteId');
    if (typeof raw !== 'string') fail('loteId', SCHEMA_ERROR.TIPO_INVALIDO);
    else if (!BATCH_ID_PATTERN.test(raw)) fail('loteId', DOSSIER_ERROR.ID_INVALIDO);
    else loteId = raw;
  }

  // fatos
  const fatos = [];
  if (!present.has('fatos') || present.get('fatos') === null) fail('fatos', SCHEMA_ERROR.CAMPO_OBRIGATORIO);
  else {
    const items = listOf(present.get('fatos'));
    if (items === null) fail('fatos', Array.isArray(present.get('fatos')) ? SCHEMA_ERROR.ESTRUTURA_INVALIDA : SCHEMA_ERROR.NAO_E_LISTA);
    else if (items.length > LIMITS.FATOS) fail('fatos', DOSSIER_ERROR.FATOS_EXCESSIVOS);
    else {
      const perField = new Map();
      items.forEach((item, index) => {
        const checked = validateFact(item, `fatos[${index}]`, now);
        if (checked.errors) return collector.addAll(checked.errors);
        const count = (perField.get(checked.value.campo) || 0) + 1;
        perField.set(checked.value.campo, count);
        if (count > LIMITS.FATOS_POR_CAMPO) return fail(`fatos[${index}]`, DOSSIER_ERROR.FATOS_DO_CAMPO_EXCESSIVOS);
        fatos.push({ factId: count === 1 ? `fato:${checked.value.campo}` : `fato:${checked.value.campo}#${count}`, ...checked.value });
        return undefined;
      });
    }
  }
  if (collector.errors.length === 0) checkInstagramConsistency(fatos, fail);

  // sinais (derivados) e análises (validadas contra fatos e sinais)
  const derivadoEm = now.toISOString();
  const sinais = collector.errors.length === 0 ? deriveSignals(fatos, derivadoEm) : [];
  let analises = [];
  if (present.has('analises') && present.get('analises') !== null) analises = checkAnalyses(present.get('analises'), 'analises', fatos, sinais, fail);

  const dossierId = newId();
  if (typeof dossierId !== 'string' || !DOSSIER_ID_PATTERN.test(dossierId)) fail('', DOSSIER_ERROR.ID_INVALIDO);

  if (collector.errors.length > 0) return { ok: false, errors: collector.errors };
  const datas = fatos.map((fato) => DATE_PART(fato.observadoEm)).sort();
  return {
    ok: true,
    value: {
      dossierId,
      prospectId,
      loteId,
      criadoEm: derivadoEm,
      dataDaPesquisa: datas.length > 0 ? datas[datas.length - 1] : derivadoEm.slice(0, 10),
      fatos,
      sinais,
      analises,
      fontes: deriveSources(fatos),
    },
  };
}

module.exports = { DOSSIER_ID_PATTERN, LIMITS, ANALYSIS_TYPE, DOSSIER_ERROR, MESSAGES, FORBIDDEN_TEXT, SIGNAL_TYPE, buildDossier };
