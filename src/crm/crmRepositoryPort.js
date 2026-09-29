// A PORTA de persistência do CRM — só o CONTRATO, nunca uma implementação (decisões 0012, 0013 e 0025).
//
//   list()             -> array de registros (cópias; nunca o objeto interno do repositório)
//   getById(id)         -> um registro (cópia) ou null
//   save(record)        -> grava (insere ou substitui, por `record.id`); não devolve nada
//   delete(id, meta)     -> apaga por `record.id`; não devolve nada (decisão 0025)
//
// Fica num arquivo próprio, sem `fs` nem qualquer adapter, para que quem só precisa DO CONTRATO (o CRM Service
// valida o repositório que recebe) dependa só dele — nunca do código de um adapter específico. As implementações
// (memória, arquivo JSON) vivem em crmRepository.js, que reexporta estes dois nomes.
//
// A porta ACEITA implementações síncronas E assíncronas (decisão 0023): o domínio faz `await` de cada chamada, e `await` de um valor que
// não é uma Promise devolve o próprio valor — então o adapter de arquivo e o de memória continuam síncronos, sem mudar, e um adapter
// remoto (Supabase/Postgres) pode devolver Promises. O contrato dos dados é o mesmo:
//   list()          -> array de registros (ou Promise dele), na ordem estável do armazenamento;
//   getById(id)     -> um registro ou null (ou Promise);
//   save(record)    -> insere ou substitui por `record.id`; o que devolver é ignorado (ou Promise que resolve quando gravou);
//   delete(id, meta)-> apaga o registro de `id`; `meta` é { reviewedBy, motivo } — a MESMA forma que save()/moveStatus() já
//                      recebem por meta, usada só pelos adapters que precisam registrar QUEM apagou e POR QUÊ fora do próprio
//                      registro (ele deixa de existir) — o adapter de arquivo/memória pode ignorar `meta` livremente.
// `delete` é OBRIGATÓRIO desde a decisão 0025 (exclusão administrativa do CRM): um repositório sem ele nunca passa por
// assertValidRepository — não há mais um Repository Port "parcial" para o CRM.
// O domínio serializa as ESCRITAS (inclusive exclusões) de um mesmo repositório dentro do processo (crmDomain.js); a proteção
// entre processos/servidores (transação, restrição única, RPC) é responsabilidade da persistência remota e NÃO existe aqui —
// ver a decisão 0023.

const REQUIRED_REPOSITORY_METHODS = Object.freeze(['list', 'getById', 'save', 'delete']);

// Falha cedo e com uma mensagem clara se o objeto injetado não for um repositório válido — nunca falha no meio de
// uma operação de domínio por um método faltando.
function assertValidRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('CRM: repositório inválido — esperava um objeto com { list, getById, save, delete }');
  }
  for (const method of REQUIRED_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new Error(`CRM: repositório inválido — falta o método ${method}()`);
    }
  }
  return repository;
}

module.exports = { REQUIRED_REPOSITORY_METHODS, assertValidRepository };
