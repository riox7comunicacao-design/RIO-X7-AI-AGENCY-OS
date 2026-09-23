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
// A porta é SÍNCRONA nesta versão, como o Approval Queue e o Service que já existem: cada operação de domínio lê,
// decide e grava dentro de um único turno do processo, e isso é o que a torna indivisível sem trava. Um adapter que
// fale com uma rede (Supabase/Postgres — candidato registrado em 0012, NÃO decidido) é assíncrono; usá-lo exige
// tornar o domínio e o Service `async` — uma mudança mecânica de assinatura, a fazer junto da decisão desse adapter
// (ver decisão 0014). Até lá, um repositório declarado `async` é recusado aqui com uma mensagem clara, em vez de
// falhar no meio de uma operação com um erro opaco (o domínio receberia uma Promise no lugar de um registro).
// A checagem só enxerga funções declaradas `async`: uma função comum que devolve uma Promise não é detectável antes
// da chamada — limite conhecido, documentado.

const REQUIRED_REPOSITORY_METHODS = Object.freeze(['list', 'getById', 'save']);

const isAsyncFunction = (fn) => Object.prototype.toString.call(fn) === '[object AsyncFunction]';

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
  for (const method of REQUIRED_REPOSITORY_METHODS) {
    if (isAsyncFunction(repository[method])) {
      throw new Error(`CRM: repositório inválido — ${method}() é assíncrono, mas a porta de persistência é síncrona nesta versão (decisão 0014)`);
    }
  }
  return repository;
}

module.exports = { REQUIRED_REPOSITORY_METHODS, assertValidRepository };
