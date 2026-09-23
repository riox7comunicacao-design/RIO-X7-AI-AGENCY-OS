// Barrel do domínio de CRM (decisão 0012). Mesmo padrão de src/research-prospector/index.js.
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
