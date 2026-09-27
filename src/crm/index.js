// Barrel do domínio de CRM (decisão 0012). Mesmo padrão de src/research-prospector/index.js.
//
// Este barrel NUNCA importa src/crm-adapters/ (regra R15, tests/auth/architecture-boundaries.test.js): o domínio
// do CRM é independente de qualquer tecnologia de persistência remota — mesmo princípio já aplicado ao par
// research-prospector/research-adapters (decisão 0022). Quem precisar do adapter Postgres/Supabase importa
// src/crm-adapters/ diretamente (hoje, ninguém em produção/dev — ver decisão 0024, etapa 2.1).
const { createRecord, getRecord, listRecords, updateRecord, moveStatus, markDoNotContact } = require('./crmDomain');
const { assertValidRepository, createInMemoryCrmRepository, createJsonFileCrmRepository, REQUIRED_REPOSITORY_METHODS } = require('./crmRepository');
const { CRM_STATUS, CRM_STATUS_LABEL, PIPELINE_STATUSES, ALLOWED_TRANSITIONS, ACTOR, CRM_WRITABLE_FIELDS, CRM_MANAGED_FIELDS } = require('./constants');

module.exports = {
  createRecord,
  getRecord,
  listRecords,
  updateRecord,
  moveStatus,
  markDoNotContact,
  assertValidRepository,
  createInMemoryCrmRepository,
  createJsonFileCrmRepository,
  REQUIRED_REPOSITORY_METHODS,
  CRM_STATUS,
  CRM_STATUS_LABEL,
  PIPELINE_STATUSES,
  ALLOWED_TRANSITIONS,
  ACTOR,
  CRM_WRITABLE_FIELDS,
  CRM_MANAGED_FIELDS,
};
