const { createCandidate } = require('./candidate');
const { checkDuplicate } = require('./duplicateCheck');
const { checkDoNotContact } = require('./doNotContact');
const { runPipeline } = require('./pipeline');
const normalize = require('./normalize');
const { INFO_STATUS, DUPLICATE_STATUS, VALIDATION_STATUS, CONFIDENCE_FIELDS } = require('./constants');
const discovery = require('./discovery');
const approvalQueue = require('./approvalQueue');

module.exports = {
  createCandidate,
  checkDuplicate,
  checkDoNotContact,
  runPipeline,
  normalize,
  discovery,
  approvalQueue,
  INFO_STATUS,
  DUPLICATE_STATUS,
  VALIDATION_STATUS,
  CONFIDENCE_FIELDS,
};
