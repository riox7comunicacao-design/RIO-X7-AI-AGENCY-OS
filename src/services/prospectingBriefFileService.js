// Prospecting Brief Service sobre o adapter de ARQUIVO local — peça de composição (mesmo desenho de
// prospectingFileService.js/funnelFileService.js). O servidor passa só um CAMINHO, nunca um adapter; o
// `prospectingService` vem PRONTO de quem compõe (nunca reconstruído aqui — mesmo princípio já aplicado a todas as
// fábricas de arquivo desta etapa).
const { createProspectingBriefService } = require('./prospectingBriefService');
const { createJsonFileBriefRepository } = require('../research-prospector/briefRepository');

function createFileBackedProspectingBriefService(dependencies) {
  const { authorizeProposer, prospectingService, filePath, researchProvider, checkPermanentExclusion } = dependencies || {};
  if (filePath !== undefined && (typeof filePath !== 'string' || filePath.trim().length === 0)) {
    throw new Error('createFileBackedProspectingBriefService: filePath, se informado, deve ser um texto não vazio');
  }
  return createProspectingBriefService({
    authorizeProposer,
    prospectingService,
    repository: filePath === undefined ? createJsonFileBriefRepository() : createJsonFileBriefRepository(filePath),
    researchProvider,
    checkPermanentExclusion,
  });
}

module.exports = { createFileBackedProspectingBriefService };
