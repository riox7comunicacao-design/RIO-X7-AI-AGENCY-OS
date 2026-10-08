// Ambiente compartilhado dos testes de tests/server/*.test.js — NÃO é um arquivo de teste (sem tests/*.test.js
// aqui: node --test não o executa sozinho).
//
// Constrói o app (src/server/app.js) sobre peças REAIS: o domínio da fila (arquivo temporário), o Approval Queue
// Service real, a ponte de autorização real, e o adapter REAL do Supabase (createSupabaseAuthAdapter) rodando
// contra um `fetch` falso (o mesmo helper de tests/helpers/authFixtures.js usado desde a Fase B/C) — nunca uma
// identidade fabricada à mão. O único "double" é esse fetch falso, na borda de rede.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const domain = require('../../src/research-prospector/approvalQueue');
const { runDiscoveryPipeline, SOURCE_TYPE } = require('../../src/research-prospector/discovery');
const { createApprovalQueueService } = require('../../src/services/approvalQueueService');
const { createFileBackedCrmService, sharedFileCrmRepository } = require('../../src/services/crmFileService');
const { createFileBackedCrmIntegrationService } = require('../../src/services/crmIntegrationFileService');
const { createFileBackedProspectingService } = require('../../src/services/prospectingFileService');
const { createFileBackedProspectingBriefService } = require('../../src/services/prospectingBriefFileService');
const { createProspectingExclusionService } = require('../../src/services/prospectingExclusionService');
const { createInMemoryPermanentExclusionRepository } = require('../../src/research-prospector/permanentExclusionRepository');
const { createLeadReconsiderationService } = require('../../src/services/leadReconsiderationService');
const { createInMemoryLeadProfileRepository } = require('../../src/research-prospector/leadProfileRepository');
const { createFileBackedFunnelService, createFileBackedActiveFunnelCardsChecker } = require('../../src/services/funnelFileService');
const {
  defineUser,
  createUserStore,
  ROLE,
  USER_STATUS,
  authorizeReviewerForApprovalQueue,
  authorizeCrmOperation,
  authorizeProposerForLeadApproval,
  authorizeFunnelOperation,
  authorizeProspectingExclusionOperation,
  createSupabaseAuthAdapter,
} = require('../../src/auth');
const { createApp } = require('../../src/server/app');
const { FAKE_ENV, fakeAccessToken, installFakeSupabaseAuth, supabaseUserBody } = require('../helpers/authFixtures');

const DASHBOARD_ROOT = path.join(__dirname, '..', '..', 'dashboard');
const SUPABASE_BUNDLE = path.join(__dirname, '..', '..', 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');

const BRENO = Object.freeze({ userId: 'user-breno', authUserId: 'auth-breno', name: 'Breno Bento', email: 'breno-teste@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE });
const RAFAEL = Object.freeze({
  userId: 'user-rafael',
  authUserId: 'auth-rafael',
  name: 'Rafael Closer',
  email: 'rafael-teste@example.test',
  role: ROLE.COMMERCIAL_CLOSER,
  status: USER_STATUS.ACTIVE,
});
const EX_COLABORADOR = Object.freeze({
  userId: 'user-ex',
  authUserId: 'auth-ex',
  name: 'Ex Colaborador',
  email: 'ex-teste@example.test',
  role: ROLE.ADMIN,
  status: USER_STATUS.INACTIVE,
});

function achado(empresa, site) {
  return {
    empresa,
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Psicologia',
    campos: { site: [{ valor: site, fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] },
    fontes: [{ fonte: 'Site oficial', url: `https://${site}`, dataConsulta: '2026-01-01T00:00:00Z', campo: 'site' }],
  };
}

function descoberta(rawFinding, crmRecords = []) {
  return runDiscoveryPipeline({ briefing: { nicho: 'Psicologia' }, rawFindings: [rawFinding], crmRecords }).resultados[0];
}

// Uma fila REAL em arquivo temporário: alfa e beta aguardam revisão; bloqueado é DNC.
function novaFila(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'approval-queue.json');
  const queue = domain.createEmptyQueue();
  const alfa = domain.addProspect(queue, descoberta(achado('Consultório Alfa', 'consultorio-alfa.example.test')));
  const beta = domain.addProspect(queue, descoberta(achado('Consultório Beta', 'consultorio-beta.example.test')));
  const bloqueado = domain.addProspect(
    queue,
    descoberta(achado('Clínica Bloqueada', 'clinica-bloqueada.example.test'), [{ empresa: 'Bloqueada', site: 'https://clinica-bloqueada.example.test', doNotContact: true }])
  );
  domain.saveQueueToDisk(queue, filePath);
  return { filePath, ids: { alfa: alfa.prospectId, beta: beta.prospectId, bloqueado: bloqueado.prospectId } };
}

// Um caminho de arquivo do CRM em diretório temporário (o arquivo só passa a existir na primeira escrita).
function novoArquivoCrm(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-crm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'crm.json');
}

// Idem, para Funis (Etapa "Funis 1").
function novoArquivoFunnels(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-funnels-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'funnels.json');
}

// Idem, para o Workbench de Prospecção (Etapa "Prospecção 1").
function novoArquivoBriefs(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-briefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'prospecting-briefs.json');
}

// Monta { app, ids, filePath, tokenFor, logs }. `usuarios`: specs de defineUser() (padrão: Breno e Rafael ativos).
// `queue`: reaproveita uma fila já criada (senão cria uma nova). `staticFiles`: por padrão, inclui o bundle real do
// supabase-js em /lib/supabase.js, como faz src/server/index.js.
// CRM (opcional — por padrão o app NÃO tem rotas /api/crm, como antes): `crm: true` liga o CRM Service REAL (a mesma
// fábrica que a composição usa, com a ponte de autorização real) sobre um arquivo temporário, devolvido em
// `crmFilePath`; `crmService` injeta um Service já pronto (um double), no lugar.
function montarAmbiente(
  t,
  {
    usuarios = [BRENO, RAFAEL],
    queue,
    authTimeoutMs,
    staticFiles,
    log,
    crm = false,
    crmFilePath,
    crmService: crmServiceInjetado,
    integracao = false,
    crmIntegrationService: integracaoInjetada,
    prospeccao = false,
    prospectingService: prospeccaoInjetada,
    prospectingBrief = false,
    prospectingBriefFilePath,
    prospectingBriefService: prospectingBriefInjetado,
    prospectingJobService: prospectingJobInjetado,
    prospectingJob: prospectingJobFactory,
    prospectingExclusion = false,
    prospectingExclusionService: prospectingExclusionInjetado,
    leadReconsideration = false,
    leadProfiles,
    funnels = false,
    funnelFilePath,
    funnelService: funnelServiceInjetado,
  } = {}
) {
  const { filePath, ids } = queue || novaFila(t);
  const tokensPorUsuario = {};
  const corposSupabase = {};
  usuarios.forEach((usuario, indice) => {
    const token = fakeAccessToken(`srv-${usuario.userId}-${indice}`);
    tokensPorUsuario[usuario.userId] = token;
    corposSupabase[token] = supabaseUserBody({ authUserId: usuario.authUserId, email: usuario.email });
  });
  const fakeAuth = installFakeSupabaseAuth(t, corposSupabase);
  const authAdapter = createSupabaseAuthAdapter({ ...FAKE_ENV });
  const userStore = createUserStore(usuarios.map((usuario) => defineUser(usuario)));
  const approvalQueueService = createApprovalQueueService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: filePath });
  const arquivoCrm = crm ? crmFilePath || novoArquivoCrm(t) : undefined;
  // Funnel Service (opcional): `funnels: true` liga a fábrica REAL de produção — funil/etapa sobre um arquivo
  // temporário PRÓPRIO (independente do CRM); card (Etapa "Funis 2") exige `crm: true` (o mesmo `crmRepository`/
  // `crmService` do CRM acima, nunca uma segunda instância — `sharedFileCrmRepository` é o MESMO cache que
  // `createFileBackedCrmService` usa por baixo). O caminho é resolvido AQUI (antes do crmService, logo abaixo) —
  // Etapa "Funis 2 — correção final de integridade CRM ↔ Card": quando `funnels: true`, o CRM Service de teste já
  // nasce com a MESMA checagem de produção (ver src/server/index.js/funnelFileService.js), sobre o MESMO arquivo
  // que o Funnel Service usará (o adapter é sem estado — isso nunca diverge). `funnelService` injeta um double no
  // lugar de tudo isto.
  if (funnels && !arquivoCrm) throw new Error('montarAmbiente: funnels exige crm: true (as operações de card precisam do CRM)');
  const arquivoFunnels = funnels ? funnelFilePath || novoArquivoFunnels(t) : undefined;
  const hasActiveFunnelCards = arquivoFunnels ? createFileBackedActiveFunnelCardsChecker({ filePath: arquivoFunnels }) : undefined;
  const crmService = crmServiceInjetado || (crm ? createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: arquivoCrm, hasActiveFunnelCards }) : undefined);
  // Promoção Approval Queue → CRM (opcional): `integracao: true` liga a fábrica REAL de produção sobre a MESMA fila e o MESMO
  // arquivo do CRM (exige `crm: true`); `crmIntegrationService` injeta um double no lugar.
  if (integracao && !arquivoCrm) throw new Error('montarAmbiente: integracao exige crm: true');
  const crmIntegrationService =
    integracaoInjetada ||
    (integracao
      ? createFileBackedCrmIntegrationService({ authorizeReviewer: authorizeReviewerForApprovalQueue, authorizeOperation: authorizeCrmOperation, queuePath: filePath, crmService })
      : undefined);
  // Prospecting Service (opcional): `prospeccao: true` liga a fábrica REAL de produção sobre a MESMA fila e o MESMO CRM (exige
  // `crm: true`), com o arquivo dos lotes em diretório temporário (`batchPath`); `prospectingService` injeta um double.
  if (prospeccao && !arquivoCrm) throw new Error('montarAmbiente: prospeccao exige crm: true');
  const batchPath = path.join(path.dirname(filePath), 'prospecting-batches.json');
  const dossierPath = path.join(path.dirname(filePath), 'prospecting-dossiers.json');
  const prospectingService =
    prospeccaoInjetada ||
    (prospeccao
      ? createFileBackedProspectingService({ authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, queuePath: filePath, crmService, batchPath, dossierPath })
      : undefined);
  // Prospecting Permanent Exclusion Service (Workbench, Etapa 2): `prospectingExclusion: true` liga o Service REAL
  // sobre um repositório de MEMÓRIA (esta funcionalidade não tem adapter de arquivo — só Supabase/produção e
  // memória/teste, ver o cabeçalho de permanentExclusionRepository.js).
  const prospectingExclusionService = prospectingExclusionInjetado || (prospectingExclusion ? createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository: createInMemoryPermanentExclusionRepository() }) : undefined);

  // Prospecting Brief Service (Workbench, Etapa "Prospecção 1"): `prospectingBrief: true` liga a fábrica REAL sobre
  // o MESMO `prospectingService` acima (exige `prospeccao: true` — nunca reconstrói o Prospecting Service).
  // `checkPermanentExclusion` é o MESMO `isExcluded` do Service acima quando `prospectingExclusion: true` também.
  if (prospectingBrief && !prospeccao) throw new Error('montarAmbiente: prospectingBrief exige prospeccao: true');
  const arquivoBriefs = prospectingBrief ? prospectingBriefFilePath || novoArquivoBriefs(t) : undefined;
  const prospectingBriefService =
    prospectingBriefInjetado ||
    (prospectingBrief
      ? createFileBackedProspectingBriefService({
          authorizeProposer: authorizeProposerForLeadApproval,
          prospectingService,
          filePath: arquivoBriefs,
          checkPermanentExclusion: prospectingExclusionService ? (finding) => prospectingExclusionService.isExcluded(finding) : undefined,
        })
      : undefined);
  // Prospecting Job Service (Fase 2): `prospectingJobService` injeta um pronto; `prospectingJob` é uma FÁBRICA que recebe as peças reais desta
  // composição (o Brief Service, o Prospecting Service, o CRM e as exclusões) — o Service de job precisa do Brief Service, que só existe aqui.
  const prospectingJobService = prospectingJobInjetado || (prospectingJobFactory ? prospectingJobFactory({ prospectingBriefService, prospectingService, crmService, prospectingExclusionService, dir: path.dirname(filePath) }) : undefined);
  const funnelService =
    funnelServiceInjetado ||
    (funnels
      ? createFileBackedFunnelService({
          authorizeOperation: authorizeFunnelOperation,
          authorizeCrmOperation,
          filePath: arquivoFunnels,
          crmRepository: sharedFileCrmRepository(arquivoCrm),
          crmService,
        })
      : undefined);
  // Lead Reconsideration Service (Implementação 3.0): `leadReconsideration: true` liga o Service REAL sobre a MESMA fila, o MESMO CRM e um repositório de perfis em memória.
  const perfisDeLeads = leadProfiles || createInMemoryLeadProfileRepository();
  const leadReconsiderationService = leadReconsideration ? createLeadReconsiderationService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: filePath, crmService, profileRepository: perfisDeLeads }) : undefined;
  const logs = [];
  const publicConfig = { supabaseUrl: FAKE_ENV.SUPABASE_URL, supabaseAnonKey: FAKE_ENV.SUPABASE_ANON_KEY };
  const resolvedStaticFiles = staticFiles === undefined ? (fs.existsSync(SUPABASE_BUNDLE) ? { '/lib/supabase.js': SUPABASE_BUNDLE } : {}) : staticFiles;
  const app = createApp({
    verifyAccessToken: authAdapter.verifyAccessToken,
    userStore,
    approvalQueueService,
    crmService,
    crmIntegrationService,
    prospectingService,
    prospectingBriefService,
    prospectingJobService,
    prospectingExclusionService,
    leadReconsiderationService,
    funnelService,
    publicConfig,
    staticRoot: DASHBOARD_ROOT,
    staticFiles: resolvedStaticFiles,
    log: log || ((line) => logs.push(line)),
    authTimeoutMs,
  });
  return {
    app,
    ids,
    filePath,
    tokenFor: (userId) => tokensPorUsuario[userId],
    logs,
    userStore,
    approvalQueueService,
    crmService,
    crmIntegrationService,
    prospectingService,
    prospectingBriefService,
    prospectingJobService,
    prospectingExclusionService,
    leadReconsiderationService,
    perfisDeLeads,
    batchPath,
    crmFilePath: arquivoCrm,
    prospectingBriefFilePath: arquivoBriefs,
    funnelService,
    funnelFilePath: arquivoFunnels,
    fakeAuth,
    // Expostos para testes que montam uma VARIANTE do app (ex.: trocando só o Service por um double, para
    // provar o mapeamento de erro) reaproveitando a MESMA autenticação real já configurada aqui.
    verifyAccessToken: authAdapter.verifyAccessToken,
    publicConfig,
    staticRoot: DASHBOARD_ROOT,
    staticFiles: resolvedStaticFiles,
  };
}

module.exports = { montarAmbiente, novaFila, novoArquivoCrm, novoArquivoFunnels, novoArquivoBriefs, achado, descoberta, BRENO, RAFAEL, EX_COLABORADOR, DASHBOARD_ROOT, SUPABASE_BUNDLE };
