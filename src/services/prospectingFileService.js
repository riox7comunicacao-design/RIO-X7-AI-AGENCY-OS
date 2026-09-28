// Prospecting Service sobre os arquivos locais — a peça de composição (mesmo desenho de crmIntegrationFileService.js).
//
//   composição do servidor -> createFileBackedProspectingService({ authorizeProposer, authorizeOperation, queuePath,
//                                                                  crmService, batchPath })
//
// Cria os adapters de arquivo (lote, dossiê, fila) sobre os caminhos escolhidos por QUEM COMPÕE (nunca por uma requisição).
// O CRM Service NÃO é mais construído aqui (etapa 3F, BLOCKER 1 da etapa 3E): antes, recebia um { crmPath } e chamava
// createFileBackedCrmService() por conta própria — um objeto Service à parte do `crmService` que src/server/index.js já
// tinha montado via createConfiguredCrmService(), reaproveitando o MESMO repositório só por causa do cache de
// crmFileService.js (sharedFileCrmRepository), nunca consultando REPOSITORY_MODE. Se o bloqueio de "supabase" caísse
// sem mais nada, a prospecção continuaria silenciosamente no arquivo local. Agora `crmService` é INJETADO — decidido
// UMA VEZ, centralizadamente, por quem compõe — e este arquivo nunca decide qual adapter usar nem lê REPOSITORY_MODE
// ou process.env: só recebe o Service pronto (usa só listRecords()) e o repassa.
// NÃO decide nada — não autoriza (as duas portas são injetadas e o Prospecting Service as chama), não tem regra de
// negócio e não escolhe caminho: a fila não tem padrão escondido aqui, e o lote e o dossiê têm o padrão SEGURO do
// adapter (data/prospecting-batches.json e data/prospecting-dossiers.json, fora do Git).

const { createProspectingService } = require('./prospectingService');
const { createJsonFileBatchRepository } = require('../research-prospector/batchRepository');
const { createJsonFileDossierRepository } = require('../research-prospector/dossierRepository');

function requirePath(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`createFileBackedProspectingService exige { ${name} } (texto não vazio): o caminho é escolhido por quem compõe, nunca por um padrão escondido`);
  }
}

// crmService: o CRM Service JÁ PRONTO (de createConfiguredCrmService/createFileBackedCrmService — nunca construído
// aqui), usado só para leitura (listRecords). A mesma exigência de createProspectingService, antecipada aqui para
// uma mensagem clara e específica desta fábrica de arquivo.
function requireCrmService(crmService) {
  if (!crmService || typeof crmService.listRecords !== 'function') {
    throw new Error('createFileBackedProspectingService exige { crmService } (o CRM Service já pronto, com listRecords() — injetado por quem compõe, nunca um caminho: quem decide o adapter é a composição, uma única vez)');
  }
}

// queuePath pode faltar (o padrão é o da fila); batchPath e dossierPath podem faltar (o padrão é o do adapter: data/prospecting-batches.json e data/prospecting-dossiers.json, fora do Git).
function createFileBackedProspectingService(dependencies) {
  const { authorizeProposer, authorizeOperation, queuePath, crmService, batchPath, dossierPath } = dependencies || {};
  requireCrmService(crmService);
  if (queuePath !== undefined) requirePath(queuePath, 'queuePath');
  if (batchPath !== undefined) requirePath(batchPath, 'batchPath');
  if (dossierPath !== undefined) requirePath(dossierPath, 'dossierPath');
  return createProspectingService({
    authorizeProposer,
    authorizeOperation,
    crmService,
    batchRepository: batchPath === undefined ? createJsonFileBatchRepository() : createJsonFileBatchRepository(batchPath),
    dossierRepository: dossierPath === undefined ? createJsonFileDossierRepository() : createJsonFileDossierRepository(dossierPath),
    queuePath,
  });
}

module.exports = { createFileBackedProspectingService };
