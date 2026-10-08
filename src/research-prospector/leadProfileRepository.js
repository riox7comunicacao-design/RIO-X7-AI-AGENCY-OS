// Repositório do PERFIL COMERCIAL dos leads (Implementação 3.0), chaveado por prospectId. Mesmo desenho do repositório de jobs (porta síncrona
// list/getById/save + memória + arquivo JSON atômico em data/, fora do Git): o perfil é o ENRIQUECIMENTO do lead e vive ao lado da Approval Queue —
// o item da fila, o CRM e o dossiê não mudam de forma. Nenhuma tabela do Supabase.
//
//   getById(prospectId) -> perfil | null     save(prospectId, perfil) -> void (upsert)     list() -> [perfil, ...]
const path = require('node:path');
const { createInMemoryJobRepository, createJsonFileJobRepository } = require('./jobRepository');

const DEFAULT_PROFILE_PATH = path.join(__dirname, '..', '..', 'data', 'prospecting-profiles.json');
const REQUIRED_PROFILE_REPOSITORY_METHODS = Object.freeze(['list', 'getById', 'save']);

function assertValidLeadProfileRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new Error('Perfil do lead: repositório inválido: esperava um objeto');
  for (const method of REQUIRED_PROFILE_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw new Error(`Perfil do lead: repositório inválido: falta o método ${method}()`);
  }
}

function wrap(store) {
  return {
    list: () => store.list().map(({ id, ...profile }) => ({ prospectId: id, ...profile })),
    getById(prospectId) {
      const found = store.getById(prospectId);
      if (found === null) return null;
      const { id, ...profile } = found;
      return { prospectId: id, ...profile };
    },
    save(prospectId, profile) {
      if (typeof prospectId !== 'string' || prospectId.trim() === '') throw new Error('Perfil do lead: save() exige o prospectId');
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Perfil do lead: save() exige o perfil (objeto)');
      const { prospectId: ignored, ...rest } = profile;
      store.save({ ...rest, id: prospectId });
    },
  };
}

const createInMemoryLeadProfileRepository = (initial = []) => wrap(createInMemoryJobRepository(initial.map(({ prospectId, ...rest }) => ({ ...rest, id: prospectId }))));
const createJsonFileLeadProfileRepository = (filePath = DEFAULT_PROFILE_PATH) => wrap(createJsonFileJobRepository(filePath));

module.exports = { createInMemoryLeadProfileRepository, createJsonFileLeadProfileRepository, assertValidLeadProfileRepository, DEFAULT_PROFILE_PATH };
