// Enums compartilhados pelo módulo RESEARCH + PROSPECTOR.
// Ver docs/decisions/0003-research-prospector-module.md para a especificação completa.

const INFO_STATUS = Object.freeze({
  VALIDADO: 'VALIDADO',
  HIPOTESE: 'HIPOTESE',
  NAO_VERIFICADO: 'NAO_VERIFICADO',
});

const DUPLICATE_STATUS = Object.freeze({
  DUPLICADO: 'DUPLICADO',
  POSSIVEL_DUPLICADO: 'POSSIVEL_DUPLICADO',
  NAO_VERIFICADO: 'NAO_VERIFICADO',
  NOVO: 'NOVO',
});

const VALIDATION_STATUS = Object.freeze({
  NAO_REVISADO: 'NAO_REVISADO',
  REVISADO_POR_HUMANO: 'REVISADO_POR_HUMANO',
});

// Campos do candidato que recebem uma tag de confiança individual
// (seção 8 de 0003 — "Confiança dos dados, por campo relevante").
const CONFIDENCE_FIELDS = Object.freeze([
  'empresa',
  'contato',
  'cargo',
  'telefone',
  'whatsapp',
  'email',
  'site',
  'instagram',
  'googlePerfil',
  'cidade',
  'estado',
  'nicho',
  'origem',
  'problemaOportunidade',
]);

module.exports = {
  INFO_STATUS,
  DUPLICATE_STATUS,
  VALIDATION_STATUS,
  CONFIDENCE_FIELDS,
};
