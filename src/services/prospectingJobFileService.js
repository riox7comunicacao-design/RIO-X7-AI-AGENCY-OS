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
const { createHttpsTransport } = require('../research-adapters/httpsTransport');
const { createPublicWeb } = require('../research-adapters/publicWeb');

const USER_AGENT = 'RioX7ResearcherV1/1.0 (pesquisa publica controlada)';
// até 40 candidatos x (robots.txt + página + perfil do Instagram e o robots.txt dele) cabem folgadamente; é o teto do adaptador
const MAX_REQUESTS_PER_JOB = 500;

function createFileBackedProspectingJobService(dependencies) {
  const { authorizeProposer, briefService, filePath, checkPermanentExclusion, env, discoveryEngine, createFetchPage, limits, now } = dependencies || {};
  if (filePath !== undefined && (typeof filePath !== 'string' || filePath.trim().length === 0)) {
    throw new Error('createFileBackedProspectingJobService: filePath, se informado, deve ser um texto não vazio');
  }
  return createProspectingJobService({
    authorizeProposer,
    briefService,
    repository: filePath === undefined ? createJsonFileJobRepository() : createJsonFileJobRepository(filePath),
    discoveryEngine: discoveryEngine || createClaudeDiscoveryEngine({ env }),
    createFetchPage: createFetchPage || (() => createPublicWeb({ transport: createHttpsTransport(), userAgent: USER_AGENT, maxRequests: MAX_REQUESTS_PER_JOB }).fetchPage),
    checkPermanentExclusion,
    ...(limits ? { limits } : {}),
    ...(now ? { now } : {}),
  });
}

module.exports = { createFileBackedProspectingJobService, USER_AGENT, MAX_REQUESTS_PER_JOB };
