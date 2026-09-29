// A PORTA de persistência de FUNIS (Etapa "Funis 1" — reestruturação Prospecção/CRM/Funis). Só o CONTRATO, nunca
// uma implementação — mesmo desenho de crmRepositoryPort.js (decisões 0012/0025), reaproveitado aqui de propósito
// em vez de inventar um mecanismo novo.
//
//   listFunnels()            -> array de funis (cópias), na ordem estável do armazenamento
//   getFunnel(id)            -> um funil (cópia) ou null
//   saveFunnel(funnel)       -> insere ou substitui por `funnel.id`; não devolve nada
//   deleteFunnel(id)         -> apaga por id; não devolve nada
//   listStages(funnelId)     -> array de etapas (cópias) daquele funil, na ordem estável do armazenamento
//   getStage(id)             -> uma etapa (cópia) ou null
//   saveStage(stage)         -> insere ou substitui por `stage.id`; não devolve nada
//   deleteStage(id)          -> apaga por id; não devolve nada
//   countCardsByFunnel(id)   -> quantos cards (registros do CRM vinculados) existem hoje naquele funil
//   countCardsByStage(id)    -> quantos cards existem hoje naquela etapa
//
// Os dois `count*` existem SÓ para os guardas de exclusão (regras 10/12 do comando de reestruturação: nunca excluir
// funil/etapa com cards vinculados) — nesta etapa nenhum card ainda é criado (isso é a próxima etapa, "Funis 2":
// vincular um registro do CRM a um funil/etapa e o Kanban), então os dois sempre devolvem 0 hoje. O contrato já
// nasce com o método certo para que a etapa seguinte NÃO precise mudar esta porta nem os adapters já escritos —
// só passa a devolver uma contagem real.
//
// A porta aceita implementações síncronas E assíncronas (mesmo desenho da decisão 0023 do CRM): o domínio faz
// `await` de cada chamada, e `await` de um valor que não é Promise devolve o próprio valor.

const REQUIRED_FUNNEL_REPOSITORY_METHODS = Object.freeze([
  'listFunnels',
  'getFunnel',
  'saveFunnel',
  'deleteFunnel',
  'listStages',
  'getStage',
  'saveStage',
  'deleteStage',
  'countCardsByFunnel',
  'countCardsByStage',
]);

function assertValidFunnelRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('Funil: repositório inválido — esperava um objeto com os métodos de funil/etapa');
  }
  for (const method of REQUIRED_FUNNEL_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new Error(`Funil: repositório inválido — falta o método ${method}()`);
    }
  }
  return repository;
}

module.exports = { REQUIRED_FUNNEL_REPOSITORY_METHODS, assertValidFunnelRepository };
