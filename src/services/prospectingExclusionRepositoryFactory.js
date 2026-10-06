// Fábrica do REPOSITÓRIO/Service de Exclusões Permanentes de Prospecção POR REPOSITORY_MODE (Workbench, Etapa
// 2) — mesmo papel de crmRepositoryFactory.js, reaproveitando a MESMA variável REPOSITORY_MODE que já decide o
// modo do CRM (nunca uma segunda variável de ambiente para a mesma decisão).
//
// REPOSITORY_MODE=supabase -> o adapter Supabase REAL (oficial desta funcionalidade — decisão explícita do
//   proprietário: nunca um arquivo local). Exige SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, mesma checagem do CRM.
// REPOSITORY_MODE ausente ou "file" (o padrão local/dev/teste) -> esta funcionalidade NÃO existe: a fábrica
//   devolve `undefined` — nunca inventa um terceiro adapter (arquivo local), que a seção 6 do comando proíbe
//   explicitamente. Consequência HONESTA e documentada (ver o relatório da etapa): em REPOSITORY_MODE=file, o
//   checker de exclusão permanente passado ao Prospecting Brief Service continua sendo o padrão "nunca exclui"
//   (nenhuma regressão — é o comportamento de sempre); e as rotas administrativas /api/prospecting/exclusions
//   simplesmente não existem (mesmo padrão de crmService/funnelService opcionais em src/server/app.js).
//   Ativar esta funcionalidade em produção é o MESMO passo que já liga o CRM ao Supabase.
//
// NENHUMA chamada de rede acontece só por CONFIGURAR: o adapter é preguiçoso, como o do CRM.

const { readRepositoryMode, REPOSITORY_MODE } = require('./crmRepositoryFactory');
const { createProspectingExclusionService } = require('./prospectingExclusionService');
const { createSupabaseProspectingExclusionRepository } = require('../prospecting-adapters/prospectingExclusionSupabaseRepository');

// { env } (padrão process.env). Devolve o repositório puro, ou `undefined` fora do modo "supabase".
function createConfiguredProspectingExclusionRepository({ env = process.env } = {}) {
  const modo = readRepositoryMode(env);
  if (modo !== REPOSITORY_MODE.SUPABASE) return undefined;
  return createSupabaseProspectingExclusionRepository({ env });
}

// Como acima, mas devolve o Service já autorizado — ou `undefined` fora do modo "supabase" (nunca meio-montado).
function createConfiguredProspectingExclusionService({ env = process.env, authorizeOperation } = {}) {
  const repository = createConfiguredProspectingExclusionRepository({ env });
  if (repository === undefined) return undefined;
  return createProspectingExclusionService({ authorizeOperation, repository });
}

module.exports = { createConfiguredProspectingExclusionRepository, createConfiguredProspectingExclusionService };
