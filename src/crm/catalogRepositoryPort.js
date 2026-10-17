// A PORTA de persistência dos CATÁLOGOS do CRM (Serviços, Nichos, Origens dos Leads — decisão 0026). Só o CONTRATO, nunca uma
// implementação — mesmo desenho de crmRepositoryPort.js e funnelRepositoryPort.js. As implementações são o adapter de memória/arquivo
// (catalogRepository.js, aqui em src/crm/) e o adapter Postgres/Supabase (src/crm-adapters/crmSupabaseCatalogRepository.js).
//
// Os três catálogos compartilham UMA porta; o primeiro argumento de cada método é a chave do catálogo ('servicos' | 'nichos' |
// 'origens'). Métodos síncronos ou assíncronos (o domínio faz `await` de tudo):
//
//   list(catalog)               -> array de itens (cópias), em QUALQUER ordem — quem ordena é o domínio;
//   getById(catalog, id)        -> um item (cópia) ou null;
//   insert(catalog, item)       -> grava um item NOVO e devolve o item gravado. Falha com `code` DUPLICATE_NAME se já existir outro
//                                  item (ATIVO OU DESATIVADO) com o mesmo `nomeNormalizado` — a unicidade vale para os desativados;
//   update(catalog, id, patch)  -> aplica SÓ os campos de `patch` e devolve o item atualizado, ou null se `id` não existe. Falha com
//                                  `code` DUPLICATE_NAME se o novo `nomeNormalizado` colidir com o de OUTRO item. Um campo que não é
//                                  atualizável NESTE catálogo (COMMON_UPDATABLE_FIELDS + os específicos dele — um `cor` num serviço, por
//                                  exemplo, ou `id`/`criadoEm`) é um erro de programação (Error simples, sem `code`);
//   reorder(catalog, orderedIds, meta) -> grava `ordem = posição` (0, 1, 2...) em cada id da lista, numa operação atômica. Só os itens
//                                  cuja ordem MUDA recebem `meta` ({ atualizadoEm, atualizadoPorUserId, atualizadoPorNome }). Falha com
//                                  `code` NOT_FOUND se algum id não existir (nada é gravado).
//
// ERROS: o contrato comum entre adapters é uma propriedade PLANA e estável `code` (uma das CATALOG_REPOSITORY_ERROR abaixo) — nunca
// `instanceof` de uma classe de outro módulo (os adapters de src/crm-adapters/ não podem importar src/crm/ — regra R16 — então guardam
// uma cópia literal destes dois valores; tests/crm-adapters/crmSupabaseCatalogRepository.test.js confere que não divergem). Qualquer
// outra falha (rede, arquivo corrompido, permissão) sai SEM `code`, e o domínio a trata como falha de armazenamento.
//
// `atualizadoEm`: quem o define é a PERSISTÊNCIA OU o domínio — o Postgres tem um gatilho que o atualiza a cada UPDATE (então o valor
// devolvido pode diferir de `meta.atualizadoEm` em milissegundos); o adapter de arquivo grava o que o domínio mandou. O contrato é só
// "string ISO 8601 em UTC, nunca anterior à anterior".

const CATALOG_REPOSITORY_ERROR = Object.freeze({
  DUPLICATE_NAME: 'CRM_CATALOG_REPOSITORY_DUPLICATE_NAME',
  NOT_FOUND: 'CRM_CATALOG_REPOSITORY_NOT_FOUND',
});

const REQUIRED_CATALOG_REPOSITORY_METHODS = Object.freeze(['list', 'getById', 'insert', 'update', 'reorder']);

// Os campos COMUNS que `update()` aceita em qualquer catálogo (o resto — id, criadoEm, criadoPor* — nunca muda depois da criação). Os
// campos ESPECÍFICOS (categoria, cor, canal...) só valem no catálogo a que pertencem: um `cor` num serviço é um erro de programação.
const COMMON_UPDATABLE_FIELDS = Object.freeze(['nome', 'nomeNormalizado', 'descricao', 'ativo', 'ordem', 'atualizadoEm', 'atualizadoPorUserId', 'atualizadoPorNome']);
// A união de todos (comuns + específicos dos três catálogos) — só para conferência em teste.
const UPDATABLE_FIELDS = Object.freeze([...COMMON_UPDATABLE_FIELDS, 'categoria', 'precoReferencia', 'permitePagamentoUnico', 'permitePagamentoRecorrente', 'periodicidades', 'cor', 'canal']);

function assertValidCatalogRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('Cadastro: repositório inválido — esperava um objeto com { list, getById, insert, update, reorder }');
  }
  for (const method of REQUIRED_CATALOG_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw new Error(`Cadastro: repositório inválido — falta o método ${method}()`);
  }
  return repository;
}

// Cria um erro com o `code` estável do contrato (usado pelos adapters de src/crm/).
function repositoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = { CATALOG_REPOSITORY_ERROR, REQUIRED_CATALOG_REPOSITORY_METHODS, COMMON_UPDATABLE_FIELDS, UPDATABLE_FIELDS, assertValidCatalogRepository, repositoryError };
