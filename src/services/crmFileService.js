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
// — candidato, não decidido) é criar outro módulo como este; o Service não muda (sujeito à ressalva de sincronia da
// porta, decisão 0014).

const { createCrmService } = require('./crmService');
const { createJsonFileCrmRepository } = require('../crm/crmRepository');

// authorizeOperation: a porta de autorização (em produção, authorizeCrmOperation de src/auth) — o Service a valida.
// filePath: o arquivo JSON do CRM (dados locais, fora do Git).
function createFileBackedCrmService(dependencies) {
  const { authorizeOperation, filePath } = dependencies || {};
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('createFileBackedCrmService exige { filePath } (texto não vazio): o caminho do arquivo do CRM é escolhido por quem compõe, nunca por um padrão escondido');
  }
  return createCrmService({ authorizeOperation, repository: createJsonFileCrmRepository(filePath) });
}

module.exports = { createFileBackedCrmService };
