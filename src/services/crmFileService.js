// CRM Service sobre o adapter de ARQUIVO local — a peça de composição que liga o CRM à raiz de composição
// (src/server/index.js) sem que o servidor importe src/crm (decisão 0015).
//
//   src/server/index.js -> createFileBackedCrmService({ authorizeOperation, filePath }) -> createCrmService({ ..., repository })
//
// POR QUE EXISTE: o CRM Service (crmService.js) recebe o repositório e nunca conhece um adapter (decisão 0014), e a
// regra R12 de tests/auth/architecture-boundaries.test.js só deixa src/services importar o domínio (src/crm) — o servidor
// não pode. Alguém precisa transformar "um caminho de arquivo" no adapter de arquivo, e esse alguém tem de estar em
// src/services. É o mesmo desenho da Approval Queue: o servidor passa só um CAMINHO (RIO_X7_QUEUE_PATH /
// RIO_X7_CRM_PATH), nunca um adapter nem o domínio.
//
// NÃO DECIDE NADA: não autoriza (o autorizador é injetado e o CRM Service continua sendo a única camada que o chama),
// não tem regra de negócio e não escolhe caminho — sem padrão escondido: quem compõe resolve o caminho e o passa
// explícito. O arquivo só é lido/escrito quando uma operação roda (o adapter é preguiçoso): um arquivo corrompido
// aparece no primeiro uso, como erro do CRM, sem derrubar o resto do servidor. Trocar a persistência (Supabase/Postgres
// — candidato, não decidido) é criar outro módulo como este; o Service não muda (a porta aceita
// métodos assíncronos desde a decisão 0023).
//
// INSTÂNCIA ÚNICA por caminho (etapa 2.3, decisão 0023): a raiz de composição (src/server/index.js) chama esta
// fábrica (direta ou indiretamente, via crmRepositoryFactory.js/crmIntegrationFileService.js/
// prospectingFileService.js) MAIS DE UMA VEZ para o MESMO arquivo — uma para o CRM Service direto, outra para a
// promoção, outra para a prospecção. A serialização de escrita de crmDomain.js é por OBJETO repositório
// (WeakMap): se cada chamada construísse um createJsonFileCrmRepository NOVO, as três teriam filas de escrita
// INDEPENDENTES sobre o MESMO arquivo — o risco exato registrado em docs/decisions/0024, seção 11, e DEMONSTRADO
// (não só teórico) em tests/services/crmFileService.test.js ([CRM-FILE-8], confirmado por mutação: sem este
// cache, o mesmo cenário cria DUAS cópias em 30 de 30 tentativas): duas escritas concorrentes sobre o MESMO
// arquivo, por dois repositórios DIFERENTES, criam DUAS cópias do mesmo registro (a checagem de duplicidade de
// uma nunca vê a escrita da outra a tempo). Por isso o REPOSITÓRIO (nunca
// o Service, que continua sendo construído com o autorizador de CADA chamador) é reaproveitado por caminho,
// dentro deste processo, em sharedFileCrmRepository(). Isto NUNCA muda o que qualquer teste observa em outros
// aspectos: o adapter de arquivo não tem estado em memória (cada list/getById/save já relê o disco na hora — ver
// crmRepository.js) — só faz duas chamadas para o MESMO caminho caírem na MESMA fila de escrita, em vez de duas
// filas cegas uma para a outra. createJsonFileCrmRepository() chamado DIRETO (fora desta fábrica) continua sem
// cache nenhum, como sempre — ver tests/crm/crmDomain.test.js e tests/services/crmService.test.js ([CRM-SVC-45]).
const { createCrmService } = require('./crmService');
const { createJsonFileCrmRepository } = require('../crm/crmRepository');

const repositoriesByPath = new Map();
function sharedFileCrmRepository(filePath) {
  let repository = repositoriesByPath.get(filePath);
  if (!repository) {
    repository = createJsonFileCrmRepository(filePath);
    repositoriesByPath.set(filePath, repository);
  }
  return repository;
}

// authorizeOperation: a porta de autorização (em produção, authorizeCrmOperation de src/auth) — o Service a valida.
// filePath: o arquivo JSON do CRM (dados locais, fora do Git).
function createFileBackedCrmService(dependencies) {
  const { authorizeOperation, filePath } = dependencies || {};
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('createFileBackedCrmService exige { filePath } (texto não vazio): o caminho do arquivo do CRM é escolhido por quem compõe, nunca por um padrão escondido');
  }
  return createCrmService({ authorizeOperation, repository: sharedFileCrmRepository(filePath) });
}

module.exports = { createFileBackedCrmService, sharedFileCrmRepository };
