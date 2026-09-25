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
const { createFileBackedCrmService } = require('../../src/services/crmFileService');
const { createFileBackedCrmIntegrationService } = require('../../src/services/crmIntegrationFileService');
const { defineUser, createUserStore, ROLE, USER_STATUS, authorizeReviewerForApprovalQueue, authorizeCrmOperation, createSupabaseAuthAdapter } = require('../../src/auth');
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

// Monta { app, ids, filePath, tokenFor, logs }. `usuarios`: specs de defineUser() (padrão: Breno e Rafael ativos).
// `queue`: reaproveita uma fila já criada (senão cria uma nova). `staticFiles`: por padrão, inclui o bundle real do
// supabase-js em /lib/supabase.js, como faz src/server/index.js.
// CRM (opcional — por padrão o app NÃO tem rotas /api/crm, como antes): `crm: true` liga o CRM Service REAL (a mesma
// fábrica que a composição usa, com a ponte de autorização real) sobre um arquivo temporário, devolvido em
// `crmFilePath`; `crmService` injeta um Service já pronto (um double), no lugar.
function montarAmbiente(t, { usuarios = [BRENO, RAFAEL], queue, authTimeoutMs, staticFiles, log, crm = false, crmFilePath, crmService: crmServiceInjetado, integracao = false, crmIntegrationService: integracaoInjetada } = {}) {
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
  const crmService = crmServiceInjetado || (crm ? createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: arquivoCrm }) : undefined);
  // Promoção Approval Queue → CRM (opcional): `integracao: true` liga a fábrica REAL de produção sobre a MESMA fila e o MESMO
  // arquivo do CRM (exige `crm: true`); `crmIntegrationService` injeta um double no lugar.
  if (integracao && !arquivoCrm) throw new Error('montarAmbiente: integracao exige crm: true');
  const crmIntegrationService =
    integracaoInjetada ||
    (integracao
      ? createFileBackedCrmIntegrationService({ authorizeReviewer: authorizeReviewerForApprovalQueue, authorizeOperation: authorizeCrmOperation, queuePath: filePath, crmPath: arquivoCrm })
      : undefined);
  const logs = [];
  const publicConfig = { supabaseUrl: FAKE_ENV.SUPABASE_URL, supabaseAnonKey: FAKE_ENV.SUPABASE_ANON_KEY };
  const resolvedStaticFiles = staticFiles === undefined ? (fs.existsSync(SUPABASE_BUNDLE) ? { '/lib/supabase.js': SUPABASE_BUNDLE } : {}) : staticFiles;
  const app = createApp({
    verifyAccessToken: authAdapter.verifyAccessToken,
    userStore,
    approvalQueueService,
    crmService,
    crmIntegrationService,
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
    crmFilePath: arquivoCrm,
    fakeAuth,
    // Expostos para testes que montam uma VARIANTE do app (ex.: trocando só o Service por um double, para
    // provar o mapeamento de erro) reaproveitando a MESMA autenticação real já configurada aqui.
    verifyAccessToken: authAdapter.verifyAccessToken,
    publicConfig,
    staticRoot: DASHBOARD_ROOT,
    staticFiles: resolvedStaticFiles,
  };
}

module.exports = { montarAmbiente, novaFila, novoArquivoCrm, achado, descoberta, BRENO, RAFAEL, EX_COLABORADOR, DASHBOARD_ROOT, SUPABASE_BUNDLE };
