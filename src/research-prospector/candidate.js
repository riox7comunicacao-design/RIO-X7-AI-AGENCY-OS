const { INFO_STATUS, VALIDATION_STATUS, CONFIDENCE_FIELDS } = require('./constants');

const VALID_INFO_STATUS = new Set(Object.values(INFO_STATUS));

// Constrói o modelo de dados de um candidato pesquisado (seção 3 de 0003).
// Nunca inventa valor para um campo ausente — campo ausente vira `null`,
// nunca um valor "adivinhado", e sua confiança vira NAO_VERIFICADO.
function createCandidate(raw = {}) {
  if (!raw.empresa || typeof raw.empresa !== 'string' || !raw.empresa.trim()) {
    throw new Error('empresa é obrigatória para criar um candidato');
  }

  const rawConfianca = raw.confianca || {};
  for (const [campo, status] of Object.entries(rawConfianca)) {
    if (!VALID_INFO_STATUS.has(status)) {
      throw new Error(`status de confiança inválido para "${campo}": ${status}`);
    }
  }

  const candidate = {
    empresa: raw.empresa.trim(),
    contato: raw.contato ?? null,
    cargo: raw.cargo ?? null,
    telefone: raw.telefone ?? null,
    whatsapp: raw.whatsapp ?? null,
    email: raw.email ?? null,
    site: raw.site ?? null,
    instagram: raw.instagram ?? null,
    googlePerfil: raw.googlePerfil ?? null,
    cidade: raw.cidade ?? null,
    estado: raw.estado ?? null,
    nicho: raw.nicho ?? null,
    origem: raw.origem ?? null,
    problemaOportunidade: raw.problemaOportunidade ?? null,
    fontesConsultadas: Array.isArray(raw.fontesConsultadas) ? raw.fontesConsultadas : [],
    dataPesquisa: raw.dataPesquisa || new Date().toISOString(),
    observacoes: raw.observacoes ?? null,
    // Preenchidos pelas etapas seguintes do pipeline — nunca pelo input bruto.
    confianca: {},
    duplicidade: null,
    doNotContact: false,
    bloqueadoParaContato: false,
    statusValidacao: VALIDATION_STATUS.NAO_REVISADO,
  };

  // Confiança: respeita override explícito do input (ex.: pesquisa incerta
  // sobre um dado presente); caso contrário, presente = VALIDADO,
  // ausente = NAO_VERIFICADO. Nunca "ausente vira verdadeiro por padrão".
  for (const campo of CONFIDENCE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(rawConfianca, campo)) {
      candidate.confianca[campo] = rawConfianca[campo];
    } else {
      candidate.confianca[campo] = candidate[campo] !== null
        ? INFO_STATUS.VALIDADO
        : INFO_STATUS.NAO_VERIFICADO;
    }
  }

  return candidate;
}

module.exports = { createCandidate };
