// Prospecting Service sobre os arquivos locais — a peça de composição (mesmo desenho de crmIntegrationFileService.js).
//
//   (futuro) composição do servidor -> createFileBackedProspectingService({ authorizeProposer, authorizeOperation, queuePath,
//                                                                          crmPath, batchPath })
//
// Cria os Services e adapters existentes sobre os arquivos escolhidos por QUEM COMPÕE (nunca por uma requisição): o CRM Service de
// arquivo (só leitura é usada), o repositório de lotes de arquivo e o caminho da fila. NÃO decide nada — não autoriza (as duas portas
// são injetadas e o Prospecting Service as chama), não tem regra de negócio e não escolhe caminho: o CRM e a fila não têm padrão
// escondido aqui, e o lote e o dossiê têm o padrão SEGURO do adapter (data/prospecting-batches.json e data/prospecting-dossiers.json, fora do Git).

const { createProspectingService } = require('./prospectingService');
const { createFileBackedCrmService } = require('./crmFileService');
const { createJsonFileBatchRepository } = require('../research-prospector/batchRepository');
const { createJsonFileDossierRepository } = require('../research-prospector/dossierRepository');

function requirePath(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`createFileBackedProspectingService exige { ${name} } (texto não vazio): o caminho é escolhido por quem compõe, nunca por um padrão escondido`);
  }
}

// queuePath pode faltar (o padrão é o da fila); batchPath e dossierPath podem faltar (o padrão é o do adapter: data/prospecting-batches.json e data/prospecting-dossiers.json, fora do Git); crmPath é sempre explícito.
function createFileBackedProspectingService(dependencies) {
  const { authorizeProposer, authorizeOperation, queuePath, crmPath, batchPath, dossierPath } = dependencies || {};
  requirePath(crmPath, 'crmPath');
  if (queuePath !== undefined) requirePath(queuePath, 'queuePath');
  if (batchPath !== undefined) requirePath(batchPath, 'batchPath');
  if (dossierPath !== undefined) requirePath(dossierPath, 'dossierPath');
  return createProspectingService({
    authorizeProposer,
    authorizeOperation,
    crmService: createFileBackedCrmService({ authorizeOperation, filePath: crmPath }),
    batchRepository: batchPath === undefined ? createJsonFileBatchRepository() : createJsonFileBatchRepository(batchPath),
    dossierRepository: dossierPath === undefined ? createJsonFileDossierRepository() : createJsonFileDossierRepository(dossierPath),
    queuePath,
  });
}

module.exports = { createFileBackedProspectingService };
