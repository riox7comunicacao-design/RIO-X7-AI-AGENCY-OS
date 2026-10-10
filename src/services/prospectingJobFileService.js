// Prospecting Job Service sobre o adapter de ARQUIVO local e os motores REAIS — peça de composição (mesmo desenho de
// prospectingBriefFileService.js). O servidor passa só um CAMINHO e o ambiente; o `briefService` vem PRONTO de quem compõe (nunca
// reconstruído aqui).
//
//   - jobs: data/prospecting-jobs.json (fora do Git; nenhuma tabela do Supabase);
//   - descoberta: `claude -p` só com WebSearch/WebFetch, em diretório temporário e com ambiente mínimo (claudeDiscoveryEngine.js);
//   - leitura de página: o fetchPage REAL do projeto (robots.txt, limites, nenhuma credencial), uma instância NOVA por job — o orçamento de
//     requisições e o cache de robots.txt são de cada prospecção. Nenhuma busca por Nominatim: a descoberta é só do motor acima.
const { createProspectingJobService } = require('./prospectingJobService');
const { createJsonFileJobRepository } = require('../research-prospector/jobRepository');
const { createClaudeDiscoveryEngine } = require('../prospecting-adapters/claudeDiscoveryEngine');
const { createClaudeEnrichmentEngine } = require('../prospecting-adapters/claudeEnrichmentEngine');
const { createJsonFileLeadProfileRepository } = require('../research-prospector/leadProfileRepository');
const { createLeadReconsiderationService } = require('./leadReconsiderationService');
const { createLeadEnrichmentService } = require('./leadEnrichmentService');
const { createKnownLeadIdentities } = require('./knownLeadIdentities');
const approvalQueueDomain = require('../research-prospector/approvalQueue');
const { createHttpsTransport } = require('../research-adapters/httpsTransport');
const { createPublicWeb } = require('../research-adapters/publicWeb');

const USER_AGENT = 'RioX7ResearcherV1/1.0 (pesquisa publica controlada)';
// até 40 candidatos x (robots.txt + página + perfil do Instagram e o robots.txt dele) cabem folgadamente; é o teto do adaptador
const MAX_REQUESTS_PER_JOB = 500;
// COMPLETAR PESQUISA — LIMITES de leitura de página por execução (padrões CONSERVADORES; configuráveis por variável de ambiente, valores inválidos voltam ao padrão):
//   RIO_X7_ENRICHMENT_MAX_REQUESTS  teto de requisições HTTP do leitor público (cada página, o robots.txt de cada domínio e os redirecionamentos contam) — padrão 16, aceito de 8 a 60
//   RIO_X7_ENRICHMENT_MAX_READS     páginas DISTINTAS lidas só para conferir as fontes de campos não encontrados — padrão 4, aceito de 0 a 10 (0 = não verifica: nada é documentado)
// Além delas: ao máximo 2 fontes por campo e a leitura PARA na primeira fonte pertinente; a validação do site sugerido e da página do responsável (2 páginas) não entram no orçamento de verificação.
const ENRICHMENT_MAX_REQUESTS = 16;
const ENRICHMENT_MAX_READS = 4;

function integerFromEnv(env, name, fallback, min, max) {
  const raw = env && typeof env === 'object' ? env[name] : undefined;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return value >= min && value <= max ? value : fallback;
}

function createFileBackedProspectingJobService(dependencies) {
  const { authorizeProposer, briefService, filePath, profilesPath, queuePath, crmService, knownIdentities, checkPermanentExclusion, env, discoveryEngine, createFetchPage, limits, now } = dependencies || {};
  if (filePath !== undefined && (typeof filePath !== 'string' || filePath.trim().length === 0)) {
    throw new Error('createFileBackedProspectingJobService: filePath, se informado, deve ser um texto não vazio');
  }
  return createProspectingJobService({
    authorizeProposer,
    briefService,
    repository: filePath === undefined ? createJsonFileJobRepository() : createJsonFileJobRepository(filePath),
    discoveryEngine: discoveryEngine || createClaudeDiscoveryEngine({ env }),
    // (3.0.2) o job NÃO enriquece com IA: o aprofundamento é sob demanda (createFileBackedLeadEnrichmentService, botão COMPLETAR PESQUISA)
    profileRepository: profilesPath === undefined ? createJsonFileLeadProfileRepository() : createJsonFileLeadProfileRepository(profilesPath),
    // as identidades JÁ CONHECIDAS (Approval Queue + CRM) que a descoberta recebe para não reencontrá-las (3.0.1); sem CRM injetado, o job funciona como antes
    ...(knownIdentities ? { knownIdentities } : crmService ? { knownIdentities: createKnownLeadIdentities({ queuePath: queuePath === undefined ? approvalQueueDomain.DEFAULT_QUEUE_PATH : queuePath, crmService }) } : {}),
    createFetchPage: createFetchPage || (() => createPublicWeb({ transport: createHttpsTransport(), userAgent: USER_AGENT, maxRequests: MAX_REQUESTS_PER_JOB }).fetchPage),
    checkPermanentExclusion,
    ...(limits ? { limits } : {}),
    ...(now ? { now } : {}),
  });
}

// Leads reprovados e reaprovação (Implementação 3.0) sobre a MESMA fila (queuePath), o MESMO CRM Service (só leitura) e o MESMO arquivo de perfis do job.
function createFileBackedLeadReconsiderationService(dependencies) {
  const { authorizeReviewer, crmService, queuePath, profilesPath } = dependencies || {};
  if (profilesPath !== undefined && (typeof profilesPath !== 'string' || profilesPath.trim().length === 0)) {
    throw new Error('createFileBackedLeadReconsiderationService: profilesPath, se informado, deve ser um texto não vazio');
  }
  return createLeadReconsiderationService({
    authorizeReviewer,
    crmService,
    ...(queuePath === undefined ? {} : { queuePath }),
    profileRepository: profilesPath === undefined ? createJsonFileLeadProfileRepository() : createJsonFileLeadProfileRepository(profilesPath),
  });
}

// COMPLETAR PESQUISA (3.0.2): o enriquecimento comercial sob demanda de UM lead, sobre a MESMA fila (só leitura do snapshot) e o MESMO arquivo de perfis. O motor real (`claude -p`) só é criado
// quando nenhum motor é injetado — um teste que injeta o seu nunca dispara um `claude` sem querer.
function createFileBackedLeadEnrichmentService(dependencies) {
  const { authorizeReviewer, queuePath, profilesPath, env, enrichmentEngine, createFetchPage, now, timeoutMs } = dependencies || {};
  if (profilesPath !== undefined && (typeof profilesPath !== 'string' || profilesPath.trim().length === 0)) {
    throw new Error('createFileBackedLeadEnrichmentService: profilesPath, se informado, deve ser um texto não vazio');
  }
  return createLeadEnrichmentService({
    authorizeReviewer,
    ...(queuePath === undefined ? {} : { queuePath }),
    profileRepository: profilesPath === undefined ? createJsonFileLeadProfileRepository() : createJsonFileLeadProfileRepository(profilesPath),
    enrichmentEngine: enrichmentEngine === undefined ? createClaudeEnrichmentEngine({ env }) : enrichmentEngine,
    createFetchPage: createFetchPage || (() => createPublicWeb({ transport: createHttpsTransport(), userAgent: USER_AGENT, maxRequests: integerFromEnv(env, 'RIO_X7_ENRICHMENT_MAX_REQUESTS', ENRICHMENT_MAX_REQUESTS, 8, 60) }).fetchPage),
    maxVerificationReads: integerFromEnv(env, 'RIO_X7_ENRICHMENT_MAX_READS', ENRICHMENT_MAX_READS, 0, 10),
    ...(now ? { now } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

module.exports = { createFileBackedProspectingJobService, createFileBackedLeadReconsiderationService, createFileBackedLeadEnrichmentService, USER_AGENT, MAX_REQUESTS_PER_JOB, ENRICHMENT_MAX_REQUESTS, ENRICHMENT_MAX_READS, integerFromEnv };
