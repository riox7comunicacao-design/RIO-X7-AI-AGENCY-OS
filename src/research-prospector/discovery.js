// Fluxo operacional de descoberta (Passo 2):
// INPUT → DISCOVERY → RESEARCH → IDENTIFICATION → CONFIRMATION → NORMALIZATION
// → DUPLICATE CHECK → DO NOT CONTACT CHECK → VALIDATION → OUTPUT
//
// A pesquisa pública em si (as etapas DISCOVERY/RESEARCH) é feita fora deste
// módulo — por um agente humano ou de IA navegando fontes públicas reais — e
// entra aqui já como `rawFindings` (achados brutos, com evidências e fontes).
// Este módulo nunca busca nada sozinho e nunca escreve em nenhum sistema
// externo. A deduplicação e o DO NOT CONTACT reaproveitam integralmente
// duplicateCheck.js e doNotContact.js — nenhum algoritmo paralelo foi criado.

const { createCandidate } = require('./candidate');
const { checkDuplicate } = require('./duplicateCheck');
const { checkDoNotContact } = require('./doNotContact');
const { identityViews, toProspectorRecords } = require('./crmAdapter');
const { INFO_STATUS, DUPLICATE_STATUS } = require('./constants');

const OPERATIONAL_STATE = Object.freeze({
  AGUARDANDO_REVISAO: 'AGUARDANDO_REVISAO',
  DUPLICADO: 'DUPLICADO',
  POSSIVEL_DUPLICADO: 'POSSIVEL_DUPLICADO',
  DNC: 'DNC',
  DADOS_INSUFICIENTES: 'DADOS_INSUFICIENTES',
  VALIDADO_PARA_REVISAO: 'VALIDADO_PARA_REVISAO',
});

const SOURCE_TYPE = Object.freeze({ OFICIAL: 'OFICIAL', SECUNDARIA: 'SECUNDARIA' });

const DNC_STATUS = Object.freeze({
  BLOQUEADO: 'BLOQUEADO',
  NAO_ENCONTRADO: 'NAO_ENCONTRADO',
  NAO_VERIFICADO: 'NAO_VERIFICADO',
});

// Passo 2.1 — identidade (quem é a entidade) e dados (quão completo é o
// registro) são dimensões independentes. Quantidade de campos VALIDADO nunca
// decide sozinha se a identidade está confirmada.
const IDENTITY_STATUS = Object.freeze({ VALIDADA: 'VALIDADA', NAO_VALIDADA: 'NAO_VALIDADA' });

const IDENTITY_REASON = Object.freeze({
  CONFIRMADA: 'CONFIRMADA',
  CONFLITO: 'CONFLITO',
  AMBIGUA: 'AMBIGUA',
  EVIDENCIA_FRACA: 'EVIDENCIA_FRACA',
  SEM_EVIDENCIA: 'SEM_EVIDENCIA',
});

const DATA_STATUS = Object.freeze({
  SUFICIENTES: 'SUFICIENTES',
  PARCIAIS: 'PARCIAIS',
  INSUFICIENTES: 'INSUFICIENTES',
});

// Campos usados como "âncora" de identidade — os mesmos identificadores
// fortes já usados pela deduplicação (site, Instagram, telefone), mais o
// Google/Maps, explicitamente citado no Passo 2.1.
const IDENTITY_ANCHOR_FIELDS = ['site', 'instagram', 'telefone', 'googlePerfil'];

// Campos que aceitam evidências múltiplas/rastreáveis por fonte.
const EVIDENCE_FIELDS = [
  'site', 'instagram', 'facebook', 'linkedin', 'youtube',
  'telefone', 'whatsapp', 'email', 'googlePerfil', 'endereco',
];

// Etapa 1 — INPUT: valida o briefing mínimo. Nunca presume nicho/região/quantidade.
function receiveBriefing(briefing) {
  if (!briefing || !briefing.nicho) {
    throw new Error('briefing inválido: nicho é obrigatório');
  }
  return {
    nicho: briefing.nicho,
    regiao: briefing.regiao || null,
    quantidadeDesejada: briefing.quantidadeDesejada ?? null,
    tipo: briefing.tipo || null,
    exclusoes: (briefing.exclusoes || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean),
  };
}

// Etapa 2 — DISCOVERY (exclusão absoluta): remove, antes de qualquer outro
// processamento, qualquer achado cujo nome corresponda a uma exclusão do
// briefing (comparação por substring, case-insensitive, sem tentar "driblar"
// grafias diferentes por conta própria — exclusão simples e auditável).
function screenExclusions(rawFindings, exclusoes) {
  const incluidos = [];
  const excluidos = [];
  for (const finding of rawFindings) {
    const nome = String(finding.empresa || '').toLowerCase();
    const motivo = exclusoes.find((ex) => ex && nome.includes(ex));
    if (motivo) {
      excluidos.push({ empresa: finding.empresa, motivo: `exclusão absoluta do briefing ("${motivo}")` });
    } else {
      incluidos.push(finding);
    }
  }
  return { incluidos, excluidos };
}

// ORIGEM de uma evidência (unidade de independência entre evidências — decisão M1/H1):
// - com URL https válida: o HOST (hostname em minúsculas, sem "www." inicial, sem porta). Caminho, barra final, query e fragmento não
//   contam: duas páginas do mesmo host são UMA origem (mesma definição de "host" de researchPolicy.bareHost);
// - sem URL (ou com URL que não é https válida): a `fonte` normalizada (sem acento, minúscula, espaços colapsados);
// - sem nenhum dos dois: uma única origem "vazia" (nunca conta como origem distinta).
// Os prefixos separam os dois espaços: um host nunca é igual a um nome de fonte.
function evidenceOrigin(evidence) {
  if (typeof evidence.url === 'string') {
    try {
      const url = new URL(evidence.url.trim());
      if (url.protocol === 'https:' && url.hostname !== '') return `host:${url.hostname.toLowerCase().replace(/^www\./, '')}`;
    } catch {
      // URL inválida: cai para a fonte
    }
  }
  const fonte = typeof evidence.fonte === 'string' ? evidence.fonte.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim() : '';
  return `fonte:${fonte}`;
}

// Decide o status de confiança de UM campo a partir das evidências coletadas.
// - Sem evidência → NAO_VERIFICADO (nunca inventado, nunca inferido de outro campo).
// - Evidências com valores diferentes → HIPOTESE + conflito registrado (nenhuma
//   escolhida silenciosamente; nenhum valor único vira o "valor" do campo).
// - Evidência única de fonte oficial, ou evidências concordando de 2+ ORIGENS distintas
//   (evidenceOrigin; duplicatas e páginas do mesmo host contam como uma) → VALIDADO.
// - Evidência única de fonte secundária, ou várias de uma só origem → HIPOTESE.
function evidenceStatus(evidences) {
  if (!evidences || evidences.length === 0) {
    return { status: INFO_STATUS.NAO_VERIFICADO, valor: null, conflito: false, evidencias: [] };
  }

  const valoresUnicos = [...new Set(evidences.map((e) => e.valor))];
  if (valoresUnicos.length > 1) {
    return { status: INFO_STATUS.HIPOTESE, valor: null, conflito: true, evidencias: evidences };
  }

  const valor = valoresUnicos[0];
  const temFonteOficial = evidences.some((e) => e.tipoFonte === SOURCE_TYPE.OFICIAL);
  const multiplasFontes = new Set(evidences.map(evidenceOrigin)).size > 1;

  if (temFonteOficial || multiplasFontes) {
    return { status: INFO_STATUS.VALIDADO, valor, conflito: false, evidencias: evidences };
  }
  return { status: INFO_STATUS.HIPOTESE, valor, conflito: false, evidencias: evidences };
}

// Etapas 3 e 4 — IDENTIFICATION + CONFIRMATION: aplica evidenceStatus a cada
// campo rastreável do achado bruto.
function identifyAndConfirm(finding) {
  const campos = {};
  for (const campo of EVIDENCE_FIELDS) {
    campos[campo] = evidenceStatus(finding.campos && finding.campos[campo]);
  }
  return { ...finding, camposConfirmados: campos };
}

// Etapa 5 — NORMALIZATION: constrói o candidato no formato já usado pelo
// módulo de deduplicação existente (candidate.js). Para identidade (site,
// telefone, Instagram, e-mail) usa exclusivamente valores já VALIDADOS — um
// campo em conflito ou apenas HIPOTESE nunca alimenta a comparação de
// duplicidade, para não arriscar um falso positivo de "já existe".
function toDedupeCandidate(identifiedFinding) {
  const c = identifiedFinding.camposConfirmados;
  const pick = (campo) => (c[campo].status === INFO_STATUS.VALIDADO ? c[campo].valor : null);
  return createCandidate({
    empresa: identifiedFinding.empresa,
    site: pick('site'),
    instagram: pick('instagram'),
    telefone: pick('telefone'),
    whatsapp: pick('whatsapp'),
    email: pick('email'),
    cidade: identifiedFinding.cidade,
    estado: identifiedFinding.estado,
    nicho: identifiedFinding.nicho,
  });
}

// Etapa 6 — DUPLICATE CHECK: reaproveita checkDuplicate() sem nenhuma alteração. Os registros do CRM passam por
// crmAdapter (que os traduz para o formato das checagens e separa cada número — telefone/WhatsApp — em uma visão), e cada
// visão do CANDIDATO é comparada: assim um número guardado no campo "errado", de qualquer dos dois lados, também é achado.
// Ordem de gravidade do resultado: DUPLICADO, depois POSSIVEL_DUPLICADO, depois NOVO; NAO_VERIFICADO só se nenhum
// critério pôde ser verificado.
function runDuplicateCheck(candidate, crmRecords) {
  const registros = toProspectorRecords(crmRecords);
  const resultados = identityViews(candidate).map((view) => checkDuplicate(view, registros));
  const duplicado = resultados.find((resultado) => resultado.status === DUPLICATE_STATUS.DUPLICADO);
  if (duplicado) return duplicado;
  const possivel = resultados.find((resultado) => resultado.status === DUPLICATE_STATUS.POSSIVEL_DUPLICADO);
  if (possivel) return possivel;
  return resultados.every((resultado) => resultado.status === DUPLICATE_STATUS.NAO_VERIFICADO) ? resultados[0] : resultados.find((resultado) => resultado.status === DUPLICATE_STATUS.NOVO);
}

// Etapa 7 — DO NOT CONTACT CHECK: reaproveita checkDoNotContact() sem alteração.
// Se o CRM não pôde ser lido nesta execução, o status fica NAO_VERIFICADO —
// nunca presumido como liberado para contato.
function runDncCheck(candidate, crmRecords, crmDisponivel) {
  if (!crmDisponivel) {
    return { status: DNC_STATUS.NAO_VERIFICADO };
  }
  // O DNC do CRM (status DO_NOT_CONTACT) só é reconhecido depois da tradução de crmAdapter; cada visão do candidato conta.
  const registros = toProspectorRecords(crmRecords);
  const bloqueado = identityViews(candidate).some((view) => checkDoNotContact(view, registros).doNotContact);
  return { status: bloqueado ? DNC_STATUS.BLOQUEADO : DNC_STATUS.NAO_ENCONTRADO };
}

function countValidatedFields(camposConfirmados) {
  return Object.values(camposConfirmados).filter((c) => c.status === INFO_STATUS.VALIDADO).length;
}

// Identidade: a entidade pesquisada corresponde mesmo ao candidato? Isso é
// julgado pela natureza e coerência das evidências das âncoras fortes
// (site/Instagram/telefone/Google Perfil) — nunca por quantos campos, no
// total, estão preenchidos.
//
// Regra conservadora, nesta ordem:
// 1. Se a etapa de identificação sinalizou ambiguidade explícita (duas
//    entidades possivelmente diferentes sob nomes parecidos) → NÃO validada.
// 2. Se qualquer âncora tem conflito entre fontes → NÃO validada, mesmo que
//    outra âncora esteja confirmada (um conflito de identidade não some só
//    porque outro dado bateu).
// 3. Se pelo menos uma âncora está VALIDADO (fonte oficial, ou múltiplas
//    fontes independentes concordando) → identidade VALIDADA, mesmo que
//    vários outros campos continuem NAO_VERIFICADO.
// 4. Se só há evidência fraca (fonte secundária isolada) nas âncoras →
//    NÃO validada.
// 5. Sem nenhuma evidência nas âncoras → NÃO validada.
function computeIdentityStatus(identifiedFinding) {
  const c = identifiedFinding.camposConfirmados;

  if (identifiedFinding.identidadeAmbigua) {
    return { status: IDENTITY_STATUS.NAO_VALIDADA, motivo: IDENTITY_REASON.AMBIGUA };
  }

  const comConflito = IDENTITY_ANCHOR_FIELDS.filter((campo) => c[campo].conflito);
  if (comConflito.length > 0) {
    return { status: IDENTITY_STATUS.NAO_VALIDADA, motivo: IDENTITY_REASON.CONFLITO };
  }

  const validadas = IDENTITY_ANCHOR_FIELDS.filter((campo) => c[campo].status === INFO_STATUS.VALIDADO);
  if (validadas.length > 0) {
    return { status: IDENTITY_STATUS.VALIDADA, motivo: IDENTITY_REASON.CONFIRMADA };
  }

  const comEvidenciaFraca = IDENTITY_ANCHOR_FIELDS.filter(
    (campo) => c[campo].evidencias && c[campo].evidencias.length > 0
  );
  if (comEvidenciaFraca.length > 0) {
    return { status: IDENTITY_STATUS.NAO_VALIDADA, motivo: IDENTITY_REASON.EVIDENCIA_FRACA };
  }

  return { status: IDENTITY_STATUS.NAO_VALIDADA, motivo: IDENTITY_REASON.SEM_EVIDENCIA };
}

// Dados: só descreve quão completo é o registro (transparência), e nunca,
// sozinho, decide se a identidade está confirmada.
function computeDataStatus(camposConfirmados) {
  const validados = countValidatedFields(camposConfirmados);
  if (validados >= 2) return DATA_STATUS.SUFICIENTES;
  const comAlgumaEvidencia = Object.values(camposConfirmados).filter(
    (c) => c.status !== INFO_STATUS.NAO_VERIFICADO
  ).length;
  return comAlgumaEvidencia > 0 ? DATA_STATUS.PARCIAIS : DATA_STATUS.INSUFICIENTES;
}

// Etapa 8 — VALIDATION: invariantes mínimos antes da saída.
function validateRecord(record) {
  if (!record.empresa) {
    throw new Error('registro inválido: empresa ausente após o pipeline de descoberta');
  }
  return record;
}

// Etapa 9 — OUTPUT: monta o registro final estruturado. Nunca escreve em
// nenhum sistema externo — é sempre um objeto em memória/serializável.
function buildOutputRecord(identifiedFinding, duplicidade, dnc, dataDaPesquisa, prospectId) {
  const c = identifiedFinding.camposConfirmados;
  const identidade = computeIdentityStatus(identifiedFinding);
  const dados = computeDataStatus(c);

  // Nenhum score, nota, ranking ou temperatura comercial é calculado aqui —
  // só estes seis estados operacionais fixos, na mesma ordem de prioridade
  // já usada desde o Passo 2 (DNC e duplicidade sempre vêm antes de
  // qualquer julgamento sobre identidade/completude de dados).
  let estadoOperacional;
  if (dnc.status === DNC_STATUS.BLOQUEADO) {
    estadoOperacional = OPERATIONAL_STATE.DNC;
  } else if (duplicidade.status === DUPLICATE_STATUS.DUPLICADO) {
    estadoOperacional = OPERATIONAL_STATE.DUPLICADO;
  } else if (duplicidade.status === DUPLICATE_STATUS.POSSIVEL_DUPLICADO) {
    estadoOperacional = OPERATIONAL_STATE.POSSIVEL_DUPLICADO;
  } else if (identidade.status !== IDENTITY_STATUS.VALIDADA) {
    // Identidade não confirmada (conflito, ambiguidade, evidência fraca ou
    // ausente) — nunca vai para revisão como se fosse um candidato pronto,
    // mesmo que, por coincidência, vários campos individuais estejam VALIDADO.
    estadoOperacional = OPERATIONAL_STATE.DADOS_INSUFICIENTES;
  } else if (dados === DATA_STATUS.SUFICIENTES) {
    estadoOperacional = OPERATIONAL_STATE.VALIDADO_PARA_REVISAO;
  } else {
    estadoOperacional = OPERATIONAL_STATE.AGUARDANDO_REVISAO;
  }

  const record = {
    prospectId,
    empresa: identifiedFinding.empresa,
    tipo: identifiedFinding.tipo || null,
    cidade: identifiedFinding.cidade || null,
    estadoUf: identifiedFinding.estado || null,
    nicho: identifiedFinding.nicho || null,
    site: c.site.valor,
    instagram: c.instagram.valor,
    facebook: c.facebook.valor,
    linkedin: c.linkedin.valor,
    youtube: c.youtube.valor,
    telefone: c.telefone.valor,
    whatsapp: c.whatsapp.valor,
    email: c.email.valor,
    endereco: c.endereco.valor,
    statusCampos: Object.fromEntries(
      Object.entries(c).map(([campo, info]) => [campo, { status: info.status, conflito: info.conflito }])
    ),
    statusIdentidade: identidade,
    statusDados: dados,
    statusDuplicidade: duplicidade.status,
    matchedOn: duplicidade.matchedOn || [],
    statusDNC: dnc.status,
    fontes: identifiedFinding.fontes || [],
    dataDaPesquisa,
    observacoes: identifiedFinding.observacoesBrutas || null,
    hipoteseDeOportunidade: identifiedFinding.hipoteseDeOportunidade
      ? `HIPOTESE — ${identifiedFinding.hipoteseDeOportunidade}`
      : null,
    proximaAcao: 'Revisar candidato e decidir se avança para aprovação humana',
    estadoOperacional,
  };

  return validateRecord(record);
}

// Orquestra o pipeline completo sobre uma lista de achados brutos já
// pesquisados. Nunca cria, edita ou apaga nada em `crmRecords` — apenas lê.
function runDiscoveryPipeline({ briefing, rawFindings, crmRecords = [], crmDisponivel = true, dataDaPesquisa }) {
  const briefingValidado = receiveBriefing(briefing);
  const { incluidos, excluidos } = screenExclusions(rawFindings, briefingValidado.exclusoes);

  const data = dataDaPesquisa || new Date().toISOString().slice(0, 10);
  let contador = 0;

  const resultados = incluidos.map((finding) => {
    contador += 1;
    const identified = identifyAndConfirm(finding);
    const candidate = toDedupeCandidate(identified);
    const duplicidade = runDuplicateCheck(candidate, crmRecords);
    const dnc = runDncCheck(candidate, crmRecords, crmDisponivel);
    const prospectId = `DISC-${String(contador).padStart(3, '0')}`;
    return buildOutputRecord(identified, duplicidade, dnc, data, prospectId);
  });

  return { briefing: briefingValidado, excluidos, resultados };
}

module.exports = {
  OPERATIONAL_STATE,
  SOURCE_TYPE,
  DNC_STATUS,
  IDENTITY_STATUS,
  IDENTITY_REASON,
  DATA_STATUS,
  EVIDENCE_FIELDS,
  receiveBriefing,
  screenExclusions,
  identifyAndConfirm,
  toDedupeCandidate,
  runDuplicateCheck,
  runDncCheck,
  computeIdentityStatus,
  computeDataStatus,
  buildOutputRecord,
  runDiscoveryPipeline,
};
