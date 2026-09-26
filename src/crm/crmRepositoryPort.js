// A PORTA de persistência do CRM — só o CONTRATO, nunca uma implementação (decisões 0012 e 0013).
//
//   list()          -> array de registros (cópias; nunca o objeto interno do repositório)
//   getById(id)      -> um registro (cópia) ou null
//   save(record)     -> grava (insere ou substitui, por `record.id`); não devolve nada
//
// Fica num arquivo próprio, sem `fs` nem qualquer adapter, para que quem só precisa DO CONTRATO (o CRM Service
// valida o repositório que recebe) dependa só dele — nunca do código de um adapter específico. As implementações
// (memória, arquivo JSON) vivem em crmRepository.js, que reexporta estes dois nomes.
//
// A porta ACEITA implementações síncronas E assíncronas (decisão 0023): o domínio faz `await` de cada chamada, e `await` de um valor que
// não é uma Promise devolve o próprio valor — então o adapter de arquivo e o de memória continuam síncronos, sem mudar, e um adapter
// remoto (Supabase/Postgres — candidato registrado em 0012, NÃO implementado) pode devolver Promises. O contrato dos dados é o mesmo:
//   list()      -> array de registros (ou Promise dele), na ordem estável do armazenamento;
//   getById(id) -> um registro ou null (ou Promise);
//   save(record)-> insere ou substitui por `record.id`; o que devolver é ignorado (ou Promise que resolve quando gravou).
// O domínio serializa as ESCRITAS de um mesmo repositório dentro do processo (crmDomain.js); a proteção entre processos/servidores
// (transação, restrição única, RPC) é responsabilidade da persistência remota e NÃO existe aqui — ver a decisão 0023.

const REQUIRED_REPOSITORY_METHODS = Object.freeze(['list', 'getById', 'save']);

// Falha cedo e com uma mensagem clara se o objeto injetado não for um repositório válido — nunca falha no meio de
// uma operação de domínio por um método faltando.
function assertValidRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('CRM: repositório inválido — esperava um objeto com { list, getById, save }');
  }
  for (const method of REQUIRED_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new Error(`CRM: repositório inválido — falta o método ${method}()`);
    }
  }
  return repository;
}

module.exports = { REQUIRED_REPOSITORY_METHODS, assertValidRepository };
