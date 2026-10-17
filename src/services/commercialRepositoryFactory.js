// Fábrica dos REPOSITÓRIOS e Services das entidades COMERCIAIS por REPOSITORY_MODE (CRM 5.0, Fase D1.1, decisão 0029): Funis, Etapas, Cards e Negociações (com o histórico). Mesmo papel e a MESMA
// variável de crmRepositoryFactory.js e catalogRepositoryFactory.js — nunca uma segunda variável para a mesma decisão:
//
//   ausente ou "file"  -> os adapters de ARQUIVO (src/crm/funnelRepository.js e negotiationRepository.js), em { funnelsFilePath } e { negotiationsFilePath }. Só para desenvolvimento isolado, testes
//                         e compatibilidade.
//   "supabase"         -> os adapters Postgres/Supabase (src/crm-adapters/crmSupabaseFunnelRepository.js e crmSupabaseNegotiationRepository.js), com SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY
//                         (as MESMAS do CRM; lança citando só o NOME da que faltar). Nesse modo os caminhos de arquivo NÃO são usados e NÃO existe nenhum fallback para o arquivo: se a configuração
//                         faltar ou for inválida a fábrica FALHA, e se a tabela ainda não existir a leitura FALHA (nunca devolve "lista vazia").
//   outro valor        -> erro claro (readRepositoryMode).
//
// UM SÓ ARMAZENAMENTO PARA TODAS AS ENTIDADES COMERCIAIS: no modo "supabase" o repositório de funis e o de negociações saem do MESMO par (a mesma configuração), nunca de fontes diferentes. Não
// existe, por construção, "negociação no arquivo e funil no Supabase" nem "card em outro armazenamento": a negociação e o card dela são gravados juntos, numa transação, e só se estiverem no
// mesmo banco. Um serviço de negociações recebe o repositório de funis da MESMA decisão.
//
// NENHUMA chamada de rede acontece só por CONFIGURAR (os adapters são preguiçosos) e nenhuma tabela é criada: as tabelas e funções do modo "supabase" vêm de migrations NÃO APLICADAS que só o
// proprietário aplica. Em "file" o arquivo só nasce na primeira escrita.
//
// INSTÂNCIA ÚNICA: a serialização das escritas do domínio é por OBJETO repositório (WeakMap). Duas chamadas para o MESMO armazenamento devolvem o MESMO repositório — por caminho (file) ou por
// configuração (supabase; chaveada por url + um HASH da chave, nunca a chave em texto), o mesmo cuidado das outras fábricas.

const crypto = require('node:crypto');

const { readRepositoryMode, REPOSITORY_MODE } = require('./crmRepositoryFactory');
const { createFunnelService } = require('./funnelService');
const { createNegotiationService } = require('./negotiationService');
const { createJsonFileFunnelRepository } = require('../crm/funnelRepository');
const { createJsonFileNegotiationRepository } = require('../crm/negotiationRepository');
const { createSupabaseFunnelRepository } = require('../crm-adapters/crmSupabaseFunnelRepository');
const { createSupabaseNegotiationRepository } = require('../crm-adapters/crmSupabaseNegotiationRepository');
const { readSupabaseCrmConfig } = require('../crm-adapters/crmSupabaseConfig');

const supabasePairs = new Map();
const fileFunnelRepositories = new Map();
const fileNegotiationRepositories = new Map();

function requireFilePath(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`REPOSITORY_MODE=file exige { ${label} } (texto não vazio): o caminho é escolhido por quem compõe.`);
  }
  return value;
}

function sharedSupabasePair(env) {
  const config = readSupabaseCrmConfig(env);
  const cacheKey = `${config.url}\u0000${crypto.createHash('sha256').update(config.serviceRoleKey).digest('hex')}`;
  let pair = supabasePairs.get(cacheKey);
  if (!pair) {
    pair = {
      funnelRepository: createSupabaseFunnelRepository({ url: config.url, serviceRoleKey: config.serviceRoleKey }),
      negotiationRepository: createSupabaseNegotiationRepository({ url: config.url, serviceRoleKey: config.serviceRoleKey }),
    };
    supabasePairs.set(cacheKey, pair);
  }
  return pair;
}

// { env } (padrão process.env). { funnelsFilePath }: obrigatório SÓ no modo "file".
function createConfiguredFunnelRepository({ env = process.env, funnelsFilePath } = {}) {
  if (readRepositoryMode(env) === REPOSITORY_MODE.SUPABASE) return sharedSupabasePair(env).funnelRepository;
  const key = requireFilePath(funnelsFilePath, 'funnelsFilePath');
  if (!fileFunnelRepositories.has(key)) fileFunnelRepositories.set(key, createJsonFileFunnelRepository(key));
  return fileFunnelRepositories.get(key);
}

// { env } (padrão process.env). { negotiationsFilePath }: obrigatório SÓ no modo "file".
function createConfiguredNegotiationRepository({ env = process.env, negotiationsFilePath } = {}) {
  if (readRepositoryMode(env) === REPOSITORY_MODE.SUPABASE) return sharedSupabasePair(env).negotiationRepository;
  const key = requireFilePath(negotiationsFilePath, 'negotiationsFilePath');
  if (!fileNegotiationRepositories.has(key)) fileNegotiationRepositories.set(key, createJsonFileNegotiationRepository(key));
  return fileNegotiationRepositories.get(key);
}

// A ABSTRAÇÃO que o CRM Service usa (por injeção, `hasActiveFunnelCards`) para recusar excluir um registro do CRM que ainda tenha Cards: uma FUNÇÃO `(crmRecordId) => número de cards`, nunca o repositório.
function createConfiguredActiveFunnelCardsChecker(options = {}) {
  const funnelRepository = createConfiguredFunnelRepository(options);
  return (crmRecordId) => funnelRepository.countActiveCardsByCrmRecord(crmRecordId);
}

function createConfiguredFunnelService({ authorizeOperation, authorizeCrmOperation, crmRepository, crmService, ...storage } = {}) {
  return createFunnelService({ authorizeOperation, authorizeCrmOperation, repository: createConfiguredFunnelRepository(storage), crmRepository, crmService });
}

function createConfiguredNegotiationService({ authorizeCrmOperation, crmRepository, crmService, catalogService, ...storage } = {}) {
  return createNegotiationService({
    authorizeCrmOperation,
    repository: createConfiguredNegotiationRepository(storage),
    funnelRepository: createConfiguredFunnelRepository(storage),
    crmRepository,
    crmService,
    catalogService,
  });
}

module.exports = { createConfiguredFunnelRepository, createConfiguredNegotiationRepository, createConfiguredActiveFunnelCardsChecker, createConfiguredFunnelService, createConfiguredNegotiationService };
