// Vocabulários, catálogo de fatos e derivação de SINAIS do DOSSIÊ DE PESQUISA (decisão 0018).
//
// O dossiê guarda o que a pesquisa OBSERVOU (fatos), o que o código DERIVA desses fatos (sinais) e o que uma pessoa ou IA CONCLUI
// (análises e hipóteses) — separado de tudo o que é identidade e contato do prospect (Approval Queue / CRM). Este módulo é PURO: sem
// filesystem, sem rede, sem CRM, sem autorização. Nunca pesquisa nada; só valida o que já foi observado e deriva sinais por regras fixas.
//
// VOCABULÁRIOS (nenhum status novo além do esquema DADO/ANALISE/HIPOTESE/NAO_VERIFICADO já documentado em 0003, seção 7; o esquema
// VALIDADO/HIPOTESE/NAO_VERIFICADO do discovery continua sendo o da CONFIANÇA DOS CAMPOS DO PROSPECT e não é usado aqui):
//   FACT_STATUS      DADO | NAO_VERIFICADO           (só isto é um FATO; uma hipótese ou análise nunca é armazenada como fato)
//   ANALYSIS_STATUS  ANALISE | HIPOTESE              (só isto é uma análise)
//   SIGNAL_STATUS    DADO | NAO_VERIFICADO           (um sinal é DADO só quando deriva de fatos DADO sem conflito)
// Ausência de evidência NUNCA vira afirmação negativa: um fato que a pesquisa não conseguiu confirmar é NAO_VERIFICADO (valor nulo),
// e a única "negativa" que existe é a de uma VERIFICAÇÃO FEITA — "NAO_ENCONTRADO_NA_VERIFICACAO" nos anúncios, sempre com fonte e data.
// Um fato de presença só existe como `true` (`false` é recusado): "a página não tem formulário" não é observável assim.
//
// FONTE: { url (https, pública), tipo (OFICIAL | SECUNDARIA — o vocabulário de discovery.SOURCE_TYPE), observadoEm (data ISO real) } e,
// opcionalmente, um `nome`. As regras de URL, data e texto são AS de rawFindingSchema (importadas, não copiadas).

const {
  ERROR: SCHEMA_ERROR,
  SOURCE_TYPES,
  isPlainObject,
  ownEntries,
  checkText,
  checkUrl,
  checkDate,
} = require('./rawFindingSchema');

const FACT_STATUS = Object.freeze({ DADO: 'DADO', NAO_VERIFICADO: 'NAO_VERIFICADO' });
const ANALYSIS_STATUS = Object.freeze({ ANALISE: 'ANALISE', HIPOTESE: 'HIPOTESE' });
const SIGNAL_STATUS = Object.freeze({ DADO: 'DADO', NAO_VERIFICADO: 'NAO_VERIFICADO' });

// Os estados de uma verificação de anúncios. "Não encontrado" é o resultado de uma verificação FEITA, nunca "não anuncia";
// "não verificável" é um fato NAO_VERIFICADO.
const ADS_STATE = Object.freeze({
  IDENTIFICADO: 'IDENTIFICADO',
  NAO_ENCONTRADO_NA_VERIFICACAO: 'NAO_ENCONTRADO_NA_VERIFICACAO',
  NAO_VERIFICAVEL: 'NAO_VERIFICAVEL',
});

const LIMITS = Object.freeze({
  TEXTO_CTA: 200,
  DATAS_POSTAGENS: 30,
  FONTE_NOME: 200,
});

// O CATÁLOGO FECHADO de fatos: só estes campos existem, cada um com o seu formato de valor.
//   url       texto https público (rawFindingSchema.checkUrl)
//   date      data ISO real, não futura
//   dates     de 2 a 30 datas ISO reais
//   text      texto seguro, curto
//   presence  exatamente `true` (presença observada); a ausência nunca é um valor
//   ads       IDENTIFICADO | NAO_ENCONTRADO_NA_VERIFICACAO
const FACT_CATALOG = Object.freeze({
  'instagram.url': 'url',
  'instagram.ultimaPostagemEm': 'date',
  'instagram.postagensObservadas': 'dates',
  'instagram.cta': 'text',
  'site.url': 'url',
  'googlePerfil.url': 'url',
  'facebook.url': 'url',
  'linkedin.url': 'url',
  'youtube.url': 'url',
  'whatsapp.publico': 'presence',
  'site.ctaWhatsapp': 'presence',
  'site.ctaAgendamento': 'presence',
  'site.formularioContato': 'presence',
  'anuncios.meta': 'ads',
  'anuncios.google': 'ads',
});

// O CATÁLOGO FECHADO de sinais e de onde cada um deriva. O consumidor NUNCA envia um sinal (nem o nome): os sinais são derivados aqui.
const SIGNAL_TYPE = Object.freeze({
  INSTAGRAM_EXISTENTE: 'INSTAGRAM_EXISTENTE',
  INSTAGRAM_ATIVIDADE: 'INSTAGRAM_ATIVIDADE',
  SITE_EXISTENTE: 'SITE_EXISTENTE',
  GOOGLE_PERFIL_EXISTENTE: 'GOOGLE_PERFIL_EXISTENTE',
  FACEBOOK_EXISTENTE: 'FACEBOOK_EXISTENTE',
  LINKEDIN_EXISTENTE: 'LINKEDIN_EXISTENTE',
  YOUTUBE_EXISTENTE: 'YOUTUBE_EXISTENTE',
  WHATSAPP_PUBLICO: 'WHATSAPP_PUBLICO',
  CTA_WHATSAPP: 'CTA_WHATSAPP',
  CTA_AGENDAMENTO: 'CTA_AGENDAMENTO',
  FORMULARIO_CONTATO: 'FORMULARIO_CONTATO',
  ANUNCIO_META: 'ANUNCIO_META',
  ANUNCIO_GOOGLE: 'ANUNCIO_GOOGLE',
});

// Sinais de PRESENÇA: nascem de um único campo, e o valor é uma constante ('PRESENTE' para um canal ou contato, 'OBSERVADO' para uma
// chamada ou formulário na página).
const PRESENCE_SIGNALS = Object.freeze({
  [SIGNAL_TYPE.INSTAGRAM_EXISTENTE]: ['instagram.url', 'PRESENTE'],
  [SIGNAL_TYPE.SITE_EXISTENTE]: ['site.url', 'PRESENTE'],
  [SIGNAL_TYPE.GOOGLE_PERFIL_EXISTENTE]: ['googlePerfil.url', 'PRESENTE'],
  [SIGNAL_TYPE.FACEBOOK_EXISTENTE]: ['facebook.url', 'PRESENTE'],
  [SIGNAL_TYPE.LINKEDIN_EXISTENTE]: ['linkedin.url', 'PRESENTE'],
  [SIGNAL_TYPE.YOUTUBE_EXISTENTE]: ['youtube.url', 'PRESENTE'],
  [SIGNAL_TYPE.WHATSAPP_PUBLICO]: ['whatsapp.publico', 'PRESENTE'],
  [SIGNAL_TYPE.CTA_WHATSAPP]: ['site.ctaWhatsapp', 'OBSERVADO'],
  [SIGNAL_TYPE.CTA_AGENDAMENTO]: ['site.ctaAgendamento', 'OBSERVADO'],
  [SIGNAL_TYPE.FORMULARIO_CONTATO]: ['site.formularioContato', 'OBSERVADO'],
});
const ADS_SIGNALS = Object.freeze({ [SIGNAL_TYPE.ANUNCIO_META]: 'anuncios.meta', [SIGNAL_TYPE.ANUNCIO_GOOGLE]: 'anuncios.google' });

const RECENT_POST_DAYS = 15;
const MIN_POSTS_FOR_FREQUENCY = 3;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const DATE_PART = (value) => String(value).slice(0, 10);
const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (isoDate) => Math.round(Date.parse(`${DATE_PART(isoDate)}T00:00:00Z`) / DAY_MS);

const FACT_KEYS = Object.freeze(['campo', 'valor', 'status', 'fonte', 'observadoEm', 'motivo']);

// Por que um fato ficou NAO_VERIFICADO — vocabulário FECHADO (as limitações da decisão 0004, seção 10). Só existe em fato NAO_VERIFICADO.
const MOTIVO = Object.freeze({
  SITE_FORA_DO_AR: 'SITE_FORA_DO_AR',
  PERFIL_PRIVADO: 'PERFIL_PRIVADO',
  BLOQUEADO: 'BLOQUEADO',
  SEM_RESULTADO: 'SEM_RESULTADO',
  PAGINA_REMOVIDA: 'PAGINA_REMOVIDA',
  DESATUALIZADA: 'DESATUALIZADA',
  NAO_CONSULTADO: 'NAO_CONSULTADO',
});

// Campos de OBSERVAÇÃO (o que a pesquisa viu sobre um canal ou sobre anúncios) e o canal de `campos` de que dependem. Os demais campos do
// catálogo (`*.url`, `whatsapp.publico`) são IDENTIDADE/PRESENÇA de canal: quem os informa é `campos` do achado, e o bloco `dossie` do
// achado NÃO os repete (uma só fonte de verdade — decisão 0020).
const OBSERVATION_FIELDS = Object.freeze({
  'instagram.ultimaPostagemEm': 'instagram',
  'instagram.postagensObservadas': 'instagram',
  'instagram.cta': 'instagram',
  'site.ctaWhatsapp': 'site',
  'site.ctaAgendamento': 'site',
  'site.formularioContato': 'site',
  'anuncios.meta': null,
  'anuncios.google': null,
});
const SOURCE_KEYS = Object.freeze(['url', 'tipo', 'observadoEm', 'nome']);

// A fonte de um fato: só as quatro chaves, url https pública, tipo do domínio, data real, nome opcional. Devolve { value } ou { errors }.
function checkSource(raw, path, now) {
  const errors = [];
  if (!isPlainObject(raw)) return { errors: [{ path, code: SCHEMA_ERROR.NAO_E_OBJETO }] };
  const entries = ownEntries(raw);
  if (entries === null) return { errors: [{ path, code: SCHEMA_ERROR.ESTRUTURA_INVALIDA }] };
  const present = new Map(entries.filter(([, v]) => v !== undefined));
  for (const [key] of present) if (!SOURCE_KEYS.includes(key)) errors.push({ path: `${path}.${/^[A-Za-z]{1,40}$/.test(key) ? key : '?'}`, code: SCHEMA_ERROR.CAMPO_DESCONHECIDO });
  const value = {};
  const need = (key, check) => {
    if (!present.has(key) || present.get(key) === null) return errors.push({ path: `${path}.${key}`, code: SCHEMA_ERROR.CAMPO_OBRIGATORIO });
    const result = check(present.get(key));
    if (result.error) return errors.push({ path: `${path}.${key}`, code: result.error });
    value[key] = result.value;
    return undefined;
  };
  need('url', checkUrl);
  need('tipo', (v) => (typeof v !== 'string' ? { error: SCHEMA_ERROR.TIPO_INVALIDO } : SOURCE_TYPES.includes(v) ? { value: v } : { error: SCHEMA_ERROR.TIPO_FONTE_INVALIDO }));
  need('observadoEm', (v) => checkDate(v, now));
  if (present.has('nome') && present.get('nome') !== null) {
    const nome = checkText(present.get('nome'), LIMITS.FONTE_NOME);
    if (nome.error) errors.push({ path: `${path}.nome`, code: nome.error });
    else value.nome = nome.value;
  }
  return errors.length > 0 ? { errors } : { value };
}

// O valor de um fato, pelo formato do campo. Devolve { value } ou { error }.
function checkFactValue(kind, valor, now) {
  if (kind === 'url') return checkUrl(valor);
  if (kind === 'date') return checkDate(valor, now);
  if (kind === 'text') return checkText(valor, LIMITS.TEXTO_CTA);
  if (kind === 'presence') return valor === true ? { value: true } : { error: SCHEMA_ERROR.VALOR_INVALIDO };
  if (kind === 'ads') {
    if (typeof valor !== 'string') return { error: SCHEMA_ERROR.TIPO_INVALIDO };
    return valor === ADS_STATE.IDENTIFICADO || valor === ADS_STATE.NAO_ENCONTRADO_NA_VERIFICACAO ? { value: valor } : { error: SCHEMA_ERROR.VALOR_INVALIDO };
  }
  if (kind === 'dates') {
    if (!Array.isArray(valor) || Object.getPrototypeOf(valor) !== Array.prototype) return { error: SCHEMA_ERROR.NAO_E_LISTA };
    if (valor.length < 2 || valor.length > LIMITS.DATAS_POSTAGENS) return { error: valor.length > LIMITS.DATAS_POSTAGENS ? SCHEMA_ERROR.TAMANHO_EXCESSIVO : SCHEMA_ERROR.VALOR_INVALIDO };
    if (Reflect.ownKeys(valor).length !== valor.length + 1) return { error: SCHEMA_ERROR.ESTRUTURA_INVALIDA };
    const datas = [];
    for (let index = 0; index < valor.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(valor, String(index));
      if (!descriptor || !hasOwn(descriptor, 'value')) return { error: SCHEMA_ERROR.ESTRUTURA_INVALIDA };
      const data = checkDate(descriptor.value, now);
      if (data.error) return { error: data.error };
      datas.push(DATE_PART(data.value));
    }
    return { value: [...new Set(datas)].sort() };
  }
  return { error: SCHEMA_ERROR.VALOR_INVALIDO };
}

// Valida UM fato de entrada. Devolve { value } (o fato normalizado, SEM id) ou { errors }.
//   campo (do catálogo), valor, status (DADO | NAO_VERIFICADO), fonte ({url,tipo,observadoEm,nome?} ou null), observadoEm (data ISO real).
// DADO exige valor válido para o campo E fonte; NAO_VERIFICADO exige valor nulo (a pesquisa não confirmou), e a fonte é opcional.
function validateFact(raw, path, now) {
  if (!isPlainObject(raw)) return { errors: [{ path, code: SCHEMA_ERROR.NAO_E_OBJETO }] };
  const entries = ownEntries(raw);
  if (entries === null) return { errors: [{ path, code: SCHEMA_ERROR.ESTRUTURA_INVALIDA }] };
  const present = new Map(entries.filter(([, v]) => v !== undefined));
  const errors = [];
  for (const [key] of present) if (!FACT_KEYS.includes(key)) errors.push({ path: `${path}.${/^[A-Za-z]{1,40}$/.test(key) ? key : '?'}`, code: SCHEMA_ERROR.CAMPO_DESCONHECIDO });

  const campo = present.get('campo');
  const status = present.get('status');
  const value = {};
  let kind = null;
  if (typeof campo !== 'string' || !hasOwn(FACT_CATALOG, campo)) errors.push({ path: `${path}.campo`, code: campo === undefined ? SCHEMA_ERROR.CAMPO_OBRIGATORIO : SCHEMA_ERROR.VALOR_INVALIDO });
  else {
    kind = FACT_CATALOG[campo];
    value.campo = campo;
  }
  if (status === undefined || status === null) errors.push({ path: `${path}.status`, code: SCHEMA_ERROR.CAMPO_OBRIGATORIO });
  else if (typeof status !== 'string') errors.push({ path: `${path}.status`, code: SCHEMA_ERROR.TIPO_INVALIDO });
  else if (!hasOwn(FACT_STATUS, status)) errors.push({ path: `${path}.status`, code: 'STATUS_INVALIDO' });
  else value.status = status;

  const motivo = present.get('motivo');
  if (motivo !== undefined && motivo !== null) {
    if (value.status === FACT_STATUS.DADO) errors.push({ path: `${path}.motivo`, code: 'MOTIVO_EM_FATO_DADO' });
    else if (typeof motivo !== 'string') errors.push({ path: `${path}.motivo`, code: SCHEMA_ERROR.TIPO_INVALIDO });
    else if (!hasOwn(MOTIVO, motivo)) errors.push({ path: `${path}.motivo`, code: SCHEMA_ERROR.VALOR_INVALIDO });
    else value.motivo = motivo;
  }

  let observadoEm;
  if (!present.has('observadoEm') || present.get('observadoEm') === null) errors.push({ path: `${path}.observadoEm`, code: SCHEMA_ERROR.CAMPO_OBRIGATORIO });
  else {
    const data = checkDate(present.get('observadoEm'), now);
    if (data.error) errors.push({ path: `${path}.observadoEm`, code: data.error });
    else {
      observadoEm = data.value;
      value.observadoEm = data.value;
    }
  }

  let fonte = null;
  if (present.has('fonte') && present.get('fonte') !== null) {
    const source = checkSource(present.get('fonte'), `${path}.fonte`, now);
    if (source.errors) errors.push(...source.errors);
    else {
      fonte = source.value;
      if (observadoEm !== undefined && DATE_PART(fonte.observadoEm) !== DATE_PART(observadoEm)) errors.push({ path: `${path}.fonte.observadoEm`, code: 'DATA_DIVERGENTE' });
    }
  }
  value.fonte = fonte;

  if (kind !== null && value.status === FACT_STATUS.DADO) {
    if (!present.has('valor') || present.get('valor') === null) errors.push({ path: `${path}.valor`, code: SCHEMA_ERROR.CAMPO_OBRIGATORIO });
    else {
      const checked = checkFactValue(kind, present.get('valor'), now);
      if (checked.error) errors.push({ path: `${path}.valor`, code: checked.error });
      else value.valor = checked.value;
    }
    if (fonte === null && !errors.some((e) => e.path === `${path}.fonte` || e.path.startsWith(`${path}.fonte.`))) errors.push({ path: `${path}.fonte`, code: SCHEMA_ERROR.CAMPO_OBRIGATORIO });
  } else if (value.status === FACT_STATUS.NAO_VERIFICADO) {
    if (present.has('valor') && present.get('valor') !== null) errors.push({ path: `${path}.valor`, code: 'VALOR_EM_FATO_NAO_VERIFICADO' });
    else value.valor = null;
  }
  return errors.length > 0 ? { errors } : { value };
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Agrupa os fatos (já com id) por campo e diz, por campo: os fatos, os DADO, e se há CONFLITO (dois valores DADO diferentes).
function groupByField(fatos) {
  const groups = new Map();
  for (const fato of fatos) {
    if (!groups.has(fato.campo)) groups.set(fato.campo, { fatos: [], dados: [], conflito: false });
    const group = groups.get(fato.campo);
    group.fatos.push(fato);
    if (fato.status === FACT_STATUS.DADO) {
      if (group.dados.length > 0 && !sameValue(group.dados[0].valor, fato.valor)) group.conflito = true;
      group.dados.push(fato);
    }
  }
  return groups;
}

const ids = (fatos) => fatos.map((fato) => fato.factId);

// Deriva os SINAIS dos fatos (função pura e determinística: os mesmos fatos dão sempre os mesmos sinais, em ordem fixa). Cada sinal:
//   { sinalId: 'sinal:<TIPO>', tipo, valor, status, evidencias: [factId...], derivadoEm }
// Regras:
//   - só há sinal para um campo que tem pelo menos um fato; sem fato, sem sinal (ausência de sinal NÃO é ausência da coisa);
//   - status DADO só com fatos DADO e sem conflito; conflito (dois valores DADO diferentes) ou só fatos NAO_VERIFICADO dão NAO_VERIFICADO
//     com valor nulo (anúncios: valor 'NAO_VERIFICAVEL' quando não verificado);
//   - anúncios: IDENTIFICADO prevalece sobre NAO_ENCONTRADO_NA_VERIFICACAO (um anúncio identificado é evidência positiva; um "não
//     encontrado" em outra fonte não a desfaz) — e "não encontrado" nunca vira "não anuncia";
//   - INSTAGRAM_ATIVIDADE nunca diz "ativo": guarda a data da observação, a última postagem, os dias desde ela, se foi nos últimos
//     15 dias, a frequência aparente (só com pelo menos 3 datas observadas), a CTA e a URL.
function deriveSignals(fatos, derivadoEm) {
  const groups = groupByField(fatos);
  const signals = [];
  const push = (tipo, valor, status, evidencias) => signals.push({ sinalId: `sinal:${tipo}`, tipo, valor, status, evidencias, derivadoEm });

  for (const [tipo, [campo, constante]] of Object.entries(PRESENCE_SIGNALS)) {
    const group = groups.get(campo);
    if (!group) continue;
    if (group.dados.length > 0 && !group.conflito) push(tipo, constante, SIGNAL_STATUS.DADO, ids(group.dados));
    else push(tipo, null, SIGNAL_STATUS.NAO_VERIFICADO, ids(group.fatos));
  }

  for (const [tipo, campo] of Object.entries(ADS_SIGNALS)) {
    const group = groups.get(campo);
    if (!group) continue;
    if (group.dados.length === 0) push(tipo, ADS_STATE.NAO_VERIFICAVEL, SIGNAL_STATUS.NAO_VERIFICADO, ids(group.fatos));
    else {
      const identificado = group.dados.filter((fato) => fato.valor === ADS_STATE.IDENTIFICADO);
      if (identificado.length > 0) push(tipo, ADS_STATE.IDENTIFICADO, SIGNAL_STATUS.DADO, ids(identificado));
      else push(tipo, ADS_STATE.NAO_ENCONTRADO_NA_VERIFICACAO, SIGNAL_STATUS.DADO, ids(group.dados));
    }
  }

  const ultima = groups.get('instagram.ultimaPostagemEm');
  const postagens = groups.get('instagram.postagensObservadas');
  if (ultima || postagens) {
    const base = [...(ultima ? ultima.fatos : []), ...(postagens ? postagens.fatos : [])];
    const conflito = Boolean((ultima && ultima.conflito) || (postagens && postagens.conflito));
    const dadoUltima = ultima && ultima.dados[0];
    const dadoPostagens = postagens && postagens.dados[0];
    if (conflito || (!dadoUltima && !dadoPostagens)) {
      push(SIGNAL_TYPE.INSTAGRAM_ATIVIDADE, null, SIGNAL_STATUS.NAO_VERIFICADO, ids(base));
    } else {
      const ultimaPostagemEm = dadoUltima ? DATE_PART(dadoUltima.valor) : dadoPostagens.valor[dadoPostagens.valor.length - 1];
      const observacao = DATE_PART((dadoUltima || dadoPostagens).observadoEm);
      const dias = dayNumber(observacao) - dayNumber(ultimaPostagemEm);
      const datas = dadoPostagens ? dadoPostagens.valor : null;
      const frequencia =
        datas && datas.length >= MIN_POSTS_FOR_FREQUENCY
          ? { postagensObservadas: datas.length, intervaloMedioDias: Math.round(((dayNumber(datas[datas.length - 1]) - dayNumber(datas[0])) / (datas.length - 1)) * 10) / 10 }
          : null;
      const cta = groups.get('instagram.cta');
      const url = groups.get('instagram.url');
      const evidencias = [...(dadoUltima ? [dadoUltima] : []), ...(dadoPostagens ? [dadoPostagens] : []), ...(cta && !cta.conflito ? cta.dados.slice(0, 1) : []), ...(url && !url.conflito ? url.dados.slice(0, 1) : [])];
      push(
        SIGNAL_TYPE.INSTAGRAM_ATIVIDADE,
        {
          dataDaObservacao: observacao,
          ultimaPostagemEm,
          diasDesdeUltimaPostagem: dias,
          postouNosUltimos15Dias: dias <= RECENT_POST_DAYS,
          frequenciaAparente: frequencia,
          cta: cta && !cta.conflito && cta.dados.length > 0 ? cta.dados[0].valor : null,
          url: url && !url.conflito && url.dados.length > 0 ? url.dados[0].valor : null,
        },
        SIGNAL_STATUS.DADO,
        ids(evidencias)
      );
    }
  }
  return signals;
}

module.exports = {
  FACT_STATUS,
  ANALYSIS_STATUS,
  SIGNAL_STATUS,
  SIGNAL_TYPE,
  ADS_STATE,
  FACT_CATALOG,
  MOTIVO,
  OBSERVATION_FIELDS,
  LIMITS,
  RECENT_POST_DAYS,
  MIN_POSTS_FOR_FREQUENCY,
  validateFact,
  deriveSignals,
  groupByField,
  DATE_PART,
  dayNumber,
};
