// Fábrica do REPOSITÓRIO/Service dos CATÁLOGOS do CRM POR REPOSITORY_MODE (CRM 5.0, Fase 2B-1, decisão 0026) — mesmo papel de
// crmRepositoryFactory.js, e a MESMA variável REPOSITORY_MODE (nunca uma segunda para a mesma decisão):
//
//   ausente ou "file"  -> o adapter de ARQUIVO local (src/crm/catalogRepository.js), em { filePath }. Os catálogos precisam existir em
//                         desenvolvimento e nos testes (o formulário do CRM vai depender deles), por isso — diferente das Exclusões
//                         Permanentes — aqui há um adapter local. NÃO exige nenhuma credencial.
//   "supabase"         -> o adapter Postgres/Supabase (src/crm-adapters/crmSupabaseCatalogRepository.js), com SUPABASE_URL e
//                         SUPABASE_SERVICE_ROLE_KEY (as MESMAS do CRM; lança citando só o NOME da que faltar). Se a configuração faltar
//                         ou for inválida, a fábrica FALHA — nunca cai para "file" em silêncio (seria o fallback silencioso proibido).
//   outro valor        -> erro claro.
//
// NENHUMA chamada de rede acontece só por CONFIGURAR (os dois adapters são preguiçosos), e nenhuma tabela é criada: as tabelas do modo
// "supabase" vêm de uma migration NÃO APLICADA, que só o proprietário aplica. Em "file" o arquivo só nasce na primeira escrita.
//
// INSTÂNCIA ÚNICA: a serialização das escritas do domínio é por OBJETO repositório (WeakMap). Duas chamadas a esta fábrica para o
// MESMO armazenamento devem devolver o MESMO repositório — por caminho (file) ou por configuração (supabase; chaveada por url + um
// HASH da chave, nunca a chave em texto), o mesmo cuidado de crmRepositoryFactory.js.
//
// Só esta fábrica (e a de CRM) conhece os dois adapters: decidir ENTRE adapters é composição, não responsabilidade de um adapter nem
// do servidor (que nunca importa src/crm nem src/crm-adapters).

const crypto = require('node:crypto');

const { readRepositoryMode, REPOSITORY_MODE } = require('./crmRepositoryFactory');
const { createCatalogService } = require('./catalogService');
const { createJsonFileCatalogRepository } = require('../crm/catalogRepository');
const { createSupabaseCatalogRepository } = require('../crm-adapters/crmSupabaseCatalogRepository');
const { readSupabaseCrmConfig } = require('../crm-adapters/crmSupabaseConfig');

const fileRepositoriesByPath = new Map();
function sharedFileCatalogRepository(filePath) {
  let repository = fileRepositoriesByPath.get(filePath);
  if (!repository) {
    repository = createJsonFileCatalogRepository(filePath);
    fileRepositoriesByPath.set(filePath, repository);
  }
  return repository;
}

const supabaseRepositoriesByConfig = new Map();
function sharedSupabaseCatalogRepository(config) {
  const keyHash = crypto.createHash('sha256').update(config.serviceRoleKey).digest('hex');
  const cacheKey = `${config.url}\u0000${keyHash}`;
  let repository = supabaseRepositoriesByConfig.get(cacheKey);
  if (!repository) {
    repository = createSupabaseCatalogRepository({ url: config.url, serviceRoleKey: config.serviceRoleKey });
    supabaseRepositoriesByConfig.set(cacheKey, repository);
  }
  return repository;
}

// { env } (padrão process.env). { filePath }: obrigatório SÓ no modo "file" (escolhido por quem compõe, sem padrão escondido).
function createConfiguredCatalogRepository({ env = process.env, filePath } = {}) {
  const mode = readRepositoryMode(env);
  if (mode === REPOSITORY_MODE.SUPABASE) return sharedSupabaseCatalogRepository(readSupabaseCrmConfig(env));
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('createConfiguredCatalogRepository (REPOSITORY_MODE=file) exige { filePath } (texto não vazio): o caminho é escolhido por quem compõe.');
  }
  return sharedFileCatalogRepository(filePath);
}

// Como acima, mas devolve o Catalog Service já autorizado. countUsage: a função que conta o uso pelo CRM legado (ver catalogUsage.js).
function createConfiguredCatalogService({ env = process.env, authorizeOperation, filePath, countUsage } = {}) {
  const repository = createConfiguredCatalogRepository({ env, filePath });
  return createCatalogService({ authorizeOperation, repository, countUsage });
}

module.exports = { createConfiguredCatalogRepository, createConfiguredCatalogService, sharedFileCatalogRepository, sharedSupabaseCatalogRepository };
