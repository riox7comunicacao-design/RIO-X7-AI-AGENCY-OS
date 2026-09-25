// Prospecting Service sobre os arquivos locais — a peça de composição (mesmo desenho de crmIntegrationFileService.js).
//
//   (futuro) composição do servidor -> createFileBackedProspectingService({ authorizeProposer, authorizeOperation, queuePath,
//                                                                          crmPath, batchPath })
//
// Cria os Services e adapters existentes sobre os arquivos escolhidos por QUEM COMPÕE (nunca por uma requisição): o CRM Service de
// arquivo (só leitura é usada), o repositório de lotes de arquivo e o caminho da fila. NÃO decide nada — não autoriza (as duas portas
// são injetadas e o Prospecting Service as chama), não tem regra de negócio e não escolhe caminho: o CRM e a fila não têm padrão
// escondido aqui, e o lote tem o padrão SEGURO do adapter (data/prospecting-batches.json, fora do Git). Nenhuma rota usa isto ainda.

const { createProspectingService } = require('./prospectingService');
const { createFileBackedCrmService } = require('./crmFileService');
const { createJsonFileBatchRepository } = require('../research-prospector/batchRepository');

function requirePath(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`createFileBackedProspectingService exige { ${name} } (texto não vazio): o caminho é escolhido por quem compõe, nunca por um padrão escondido`);
  }
}

// queuePath pode faltar (o padrão é o da fila); batchPath pode faltar (o padrão é o do adapter de lotes); crmPath é sempre explícito.
function createFileBackedProspectingService(dependencies) {
  const { authorizeProposer, authorizeOperation, queuePath, crmPath, batchPath } = dependencies || {};
  requirePath(crmPath, 'crmPath');
  if (queuePath !== undefined) requirePath(queuePath, 'queuePath');
  if (batchPath !== undefined) requirePath(batchPath, 'batchPath');
  return createProspectingService({
    authorizeProposer,
    authorizeOperation,
    crmService: createFileBackedCrmService({ authorizeOperation, filePath: crmPath }),
    batchRepository: batchPath === undefined ? createJsonFileBatchRepository() : createJsonFileBatchRepository(batchPath),
    queuePath,
  });
}

module.exports = { createFileBackedProspectingService };
