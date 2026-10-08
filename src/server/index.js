// Servidor do Dashboard — a raiz de composição (composition root) da aplicação.
//
//   npm start  |  npm run dev          (node --env-file-if-exists=.env src/server/index.js)
//
// É AQUI, e só aqui, que as peças são ligadas: o adapter de autenticação do Supabase (verifica o access token),
// o store de USERs (data/users.json, via defineUser + createUserStore), o Approval Queue Service e o CRM Service (cada
// um com a sua ponte de autorização de src/auth como autorizador injetado) e o adaptador HTTP (app.js). Este arquivo
// só importa os pontos PÚBLICOS: o barrel de src/auth e os módulos dos Services — nunca um domínio (nem o da fila,
// nem o do CRM: a regra R12 só deixa src/services importar src/crm, e a regra R15/R16 fazem o mesmo para
// src/crm-adapters) nem arquivos internos de auth. O CRM entra por createConfiguredCrmService
// (src/services/crmRepositoryFactory.js, etapa 2.3): o servidor passa o CAMINHO do arquivo e o ambiente (para
// REPOSITORY_MODE), nunca um repositório ou um adapter escolhido aqui. Esse `crmService`, único, é depois INJETADO
// (etapa 3F) em createFileBackedCrmIntegrationService/createFileBackedProspectingService — a promoção e a
// prospecção não montam mais o CRM por conta própria: os três consumidores sempre recebem a MESMA instância que
// REPOSITORY_MODE decidiu, aqui, uma única vez.
//
// CONFIGURAÇÃO — o servidor lê SÓ estas variáveis de ambiente, e nenhuma é segredo:
//   SUPABASE_URL, SUPABASE_ANON_KEY   o projeto Supabase (a chave anon é pública por desenho)
//   PORT (3000), HOST (127.0.0.1)     onde escutar
//   RIO_X7_USERS_FILE                 o arquivo de usuários (padrão: data/users.json)
//   RIO_X7_QUEUE_PATH                 o arquivo da fila (padrão: o do domínio, data/approval-queue.json)
//   RIO_X7_CRM_PATH                   o arquivo do CRM (padrão: data/crm.json; criado no primeiro registro)
//   RIO_X7_FUNNELS_PATH               o arquivo de Funis/Etapas (padrão: data/funnels.json; Etapa "Funis 1")
//   RIO_X7_PROSPECTING_BRIEFS_PATH     o arquivo de Briefs do Workbench (padrão: data/prospecting-briefs.json;
//                                     Etapa "Prospecção 1")
//   REPOSITORY_MODE (etapas 2.3/3H)   "file" (padrão, não exige nenhuma credencial nova) ou "supabase" (exige a
//                                     variável própria da service_role — ver crmRepositoryFactory.js/
//                                     crmSupabaseConfig.js; falha claro se faltar, nunca cai para "file" em
//                                     silêncio). NENHUM valor deste servidor foi mudado nesta preparação: em
//                                     produção este arquivo continua sem REPOSITORY_MODE configurado, então
//                                     continua em "file", como sempre.
// Nada além disso é lido do ambiente, e o adapter de auth recebe só as duas variáveis do Supabase — a service_role
// nunca é lida nem repassada. Um valor que falte ou seja inválido derruba a subida com uma mensagem clara.
//
// FALHA NA SUBIDA (por desenho): sem SUPABASE_URL/ANON_KEY, sem o arquivo de usuários, com um arquivo de usuários
// inválido, ou sem o bundle do supabase-js, o servidor NÃO sobe. Nenhum usuário é criado automaticamente: o arquivo
// de usuários é escrito à mão por quem administra o sistema.
//
// Importar este módulo não sobe nada: só executá-lo como programa (node src/server/index.js) chama main().

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  defineUser,
  createUserStore,
  createSupabaseAuthAdapter,
  isSupabaseConfigured,
  authorizeReviewerForApprovalQueue,
  authorizeCrmOperation,
  authorizeProposerForLeadApproval,
  authorizeFunnelOperation,
  authorizeProspectingExclusionOperation,
} = require('../auth');
const { createApprovalQueueService } = require('../services/approvalQueueService');
// Funnel Service (reestruturação Prospecção/CRM/Funis, Etapa "Funis 1") — só o adapter de arquivo local existe
// ainda (ver o cabeçalho de src/crm/funnelRepository.js); um adapter Supabase é uma etapa futura.
const { createFileBackedFunnelService, createFileBackedActiveFunnelCardsChecker } = require('../services/funnelFileService');
// createConfiguredCrmService (etapas 2.3/3H, decisão 0024): decide REPOSITORY_MODE (file ou supabase — ver o
// cabeçalho de crmRepositoryFactory.js) antes de montar o CRM Service. Substitui o import direto de
// createFileBackedCrmService: agora só a fábrica sabe qual adapter usar, e nunca um caminho escondido. Este
// servidor continua sem REPOSITORY_MODE no seu ambiente — continua em "file" — e ativar "supabase" em produção
// é uma decisão própria, futura, do proprietário (mudar .env), não desta preparação de código.
const { createConfiguredCrmService, createConfiguredCrmRepository } = require('../services/crmRepositoryFactory');
const { createFileBackedCrmIntegrationService } = require('../services/crmIntegrationFileService');
const { createFileBackedProspectingService } = require('../services/prospectingFileService');
// Prospecting Permanent Exclusion Service (Workbench, Etapa 2) — mesma REPOSITORY_MODE do CRM; só existe em
// "supabase" (nunca um terceiro adapter local — ver o cabeçalho de prospectingExclusionRepositoryFactory.js).
const { createConfiguredProspectingExclusionService } = require('../services/prospectingExclusionRepositoryFactory');
// Prospecting Brief Service (Etapa "Prospecção 1" — Workbench): a camada ANTES da submissão — nunca reconstrói o
// Prospecting Service, só o recebe pronto (ver o cabeçalho de prospectingBriefFileService.js).
const { createFileBackedProspectingBriefService } = require('../services/prospectingBriefFileService');
// Prospecting Job Service (Fase 2 — "INICIAR PROSPECÇÃO"): a execução automática por cima do Brief Service (descoberta + validação + UMA ingestão
// pelo caminho oficial). Arquivo próprio (data/prospecting-jobs.json, fora do Git); nenhuma tabela, nenhuma API paga.
const { createFileBackedProspectingJobService, createFileBackedLeadReconsiderationService } = require('../services/prospectingJobFileService');
const { createApp } = require('./app');

const ROOT = path.join(__dirname, '..', '..');
const DASHBOARD_ROOT = path.join(ROOT, 'dashboard');
// O bundle do supabase-js para o navegador que já vem instalado com a dependência (nenhum CDN). É servido como
// arquivo em /lib/supabase.js — não é um import, e por isso não passa por src/auth (que continua sendo o único
// módulo de src/ que importa o SDK).
const SUPABASE_BUNDLE = path.join(ROOT, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
const DEFAULT_USERS_FILE = path.join(ROOT, 'data', 'users.json');
// Dados do CRM: um arquivo local em data/ (o .gitignore exclui data/*.json — são dados pessoais de prospects).
const DEFAULT_CRM_FILE = path.join(ROOT, 'data', 'crm.json');
const DEFAULT_FUNNELS_FILE = path.join(ROOT, 'data', 'funnels.json');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

// Os campos mínimos de um usuário no arquivo — os de defineUser(), sem permissions (elas vêm da role).
const USER_FIELDS = Object.freeze(['userId', 'authUserId', 'name', 'email', 'role', 'status']);

function loadUsers(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(
        `arquivo de usuários não encontrado: ${filePath}. Crie-o antes de iniciar o servidor (o formato está no .env.example); nenhum usuário é criado automaticamente.`
      );
    }
    throw new Error(`não foi possível ler o arquivo de usuários ${filePath} (${(error && error.code) || 'erro de leitura'}).`);
  }

  let entries;
  try {
    entries = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    throw new Error(`arquivo de usuários inválido: ${filePath} não é um JSON válido.`);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`arquivo de usuários inválido: ${filePath} deve conter uma lista com pelo menos um usuário.`);
  }

  return entries.map((entry, index) => {
    const label = `usuário #${index + 1} de ${filePath}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label}: deve ser um objeto.`);
    const unknown = Object.keys(entry).filter((key) => !USER_FIELDS.includes(key));
    if (unknown.length > 0) {
      throw new Error(`${label}: campos não permitidos: ${unknown.join(', ')} (permitidos: ${USER_FIELDS.join(', ')}).`);
    }
    try {
      return defineUser(entry);
    } catch (error) {
      throw new Error(`${label}: ${error.message}`);
    }
  });
}

function readPort(env) {
  if (env.PORT === undefined || env.PORT === '') return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(env.PORT) || Number(env.PORT) > 65535) throw new Error('PORT inválida: use um número de 0 a 65535.');
  return Number(env.PORT);
}

function readHost(env) {
  if (env.HOST === undefined || env.HOST === '') return DEFAULT_HOST;
  if (/\s/.test(env.HOST)) throw new Error('HOST inválido.');
  return env.HOST;
}

const resolveFile = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? path.resolve(process.cwd(), value.trim()) : fallback);

// Monta o servidor (sem começar a escutar). Lança, com uma mensagem clara, se algo essencial faltar.
function createServer(env = process.env, options = {}) {
  if (!isSupabaseConfigured(env)) {
    throw new Error('SUPABASE_URL e SUPABASE_ANON_KEY não estão configuradas: preencha o .env (o formato está no .env.example).');
  }
  const host = readHost(env);
  const port = readPort(env);

  if (!fs.existsSync(path.join(DASHBOARD_ROOT, 'index.html'))) throw new Error(`dashboard não encontrado em ${DASHBOARD_ROOT}.`);
  if (!fs.existsSync(SUPABASE_BUNDLE)) throw new Error('bundle do supabase-js para o navegador não encontrado: rode "npm install".');

  const usersFile = resolveFile(env.RIO_X7_USERS_FILE, DEFAULT_USERS_FILE);
  const users = loadUsers(usersFile);
  let userStore;
  try {
    userStore = createUserStore(users);
  } catch (error) {
    throw new Error(`arquivo de usuários inválido: ${usersFile}: ${error.message}`);
  }

  const supabaseUrl = env.SUPABASE_URL.trim();
  const supabaseAnonKey = env.SUPABASE_ANON_KEY.trim();
  // O adapter recebe SÓ as duas variáveis do Supabase, nunca o ambiente inteiro.
  const authAdapter = createSupabaseAuthAdapter({ SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: supabaseAnonKey });
  const approvalQueueService = createApprovalQueueService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    queuePath: resolveFile(env.RIO_X7_QUEUE_PATH, undefined),
  });
  const crmFilePath = resolveFile(env.RIO_X7_CRM_PATH, DEFAULT_CRM_FILE);
  const funnelsFilePath = resolveFile(env.RIO_X7_FUNNELS_PATH, DEFAULT_FUNNELS_FILE);
  // A checagem de integridade CRM ↔ Card (Etapa "Funis 2 — correção final"): uma FUNÇÃO só (nunca o repositório
  // de Funil inteiro — ver o cabeçalho de funnelFileService.js), injetada no CRM Service abaixo para recusar
  // excluir um registro do CRM enquanto ele tiver Cards ativos. Não é o mesmo objeto que o Funnel Service usa por
  // baixo, mas lê o MESMO arquivo (RIO_X7_FUNNELS_PATH) — o adapter é sem estado, então isso nunca diverge.
  const hasActiveFunnelCards = createFileBackedActiveFunnelCardsChecker({ filePath: funnelsFilePath });
  const crmService = createConfiguredCrmService({ env, authorizeOperation: authorizeCrmOperation, filePath: crmFilePath, hasActiveFunnelCards });
  // O repositório BRUTO do CRM (Etapa "Funis 2"): a MESMA instância que `crmService` usa por baixo (o cache de
  // createConfiguredCrmRepository/sharedFileCrmRepository é por `filePath`) — o Funnel Service o usa só para
  // confirmar que um registro existe antes de criar um card; ele NUNCA autoriza nem decide nada sozinho.
  const crmRepository = createConfiguredCrmRepository({ env, filePath: crmFilePath });

  // A promoção Approval Queue → CRM (decisão 0016) e a prospecção: as MESMAS portas de autorização e o MESMO
  // OBJETO `crmService` acima — INJETADO, nunca reconstruído (etapa 3F, corrige o BLOCKER 1 da etapa 3E). Antes,
  // estas duas fábricas recebiam só um { crmPath } e montavam CADA UMA o seu próprio CRM Service por trás; o
  // repositório era reaproveitado (cache de crmFileService.js), mas os três Services eram objetos distintos, e
  // nenhum dos dois consultava REPOSITORY_MODE — se REPOSITORY_MODE=supabase fosse configurado sem essa correção,
  // promoção e prospecção continuariam silenciosamente no arquivo local enquanto o CRM direto iria para o
  // Supabase. Passar o MESMO `crmService` aqui elimina esse risco por construção: os três consumidores sempre
  // operam sobre a instância IDÊNTICA que REPOSITORY_MODE decidiu, UMA VEZ, acima — em qualquer modo (etapa 3H:
  // "supabase" agora tem um caminho de código real na fábrica, mas continua exigindo REPOSITORY_MODE=supabase
  // configurado explicitamente — este servidor não o tem, então continua em "file").
  const crmIntegrationService = createFileBackedCrmIntegrationService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    authorizeOperation: authorizeCrmOperation,
    queuePath: resolveFile(env.RIO_X7_QUEUE_PATH, undefined),
    crmService,
  });

  // O Prospecting Service (submissão de prospecção): a MESMA fila e o MESMO `crmService` e as pontes de PROPOSE:LEAD_APPROVAL e do
  // CRM (READ:CRM). O arquivo dos lotes usa o caminho padrão e seguro do adapter (data/prospecting-batches.json, fora do Git).
  const prospectingService = createFileBackedProspectingService({
    authorizeProposer: authorizeProposerForLeadApproval,
    authorizeOperation: authorizeCrmOperation,
    queuePath: resolveFile(env.RIO_X7_QUEUE_PATH, undefined),
    crmService,
  });

  // Prospecting Permanent Exclusion Service (Workbench, Etapa 2): OPCIONAL — só existe quando REPOSITORY_MODE=
  // supabase (a fábrica devolve `undefined` em "file", nunca um terceiro adapter local — ver o cabeçalho de
  // prospectingExclusionRepositoryFactory.js). Sem ele, o Prospecting Brief Service abaixo simplesmente não
  // recebe `checkPermanentExclusion` — o padrão de sempre ("nunca excluir por este motivo") continua valendo.
  const prospectingExclusionService = createConfiguredProspectingExclusionService({ env, authorizeOperation: authorizeProspectingExclusionOperation });

  // Prospecting Brief Service (Workbench, Etapa "Prospecção 1"; exclusões permanentes desde a Etapa 2): o MESMO
  // `prospectingService` acima, injetado — nunca reconstruído. Arquivo próprio (data/prospecting-briefs.json,
  // fora do Git). `checkPermanentExclusion` é o MESMO `isExcluded` do Service acima quando ele existe (Supabase
  // configurado) — nunca uma segunda instância nem uma cópia da lista.
  const prospectingBriefService = createFileBackedProspectingBriefService({
    authorizeProposer: authorizeProposerForLeadApproval,
    prospectingService,
    filePath: resolveFile(env.RIO_X7_PROSPECTING_BRIEFS_PATH, undefined),
    checkPermanentExclusion: prospectingExclusionService ? (finding) => prospectingExclusionService.isExcluded(finding) : undefined,
  });

  // Prospecting Job Service (Fase 2): o MESMO `prospectingBriefService` acima (o caminho oficial de ingestão), as MESMAS exclusões permanentes
  // e o ambiente só para o motor de descoberta, que repassa ao processo filho apenas uma lista mínima de variáveis. Um job que estava rodando
  // quando o servidor caiu é marcado como INTERROMPIDO na subida (nunca finge ter concluído). Arquivo: RIO_X7_PROSPECTING_JOBS_PATH
  // (padrão data/prospecting-jobs.json, fora do Git).
  const prospectingJobService = createFileBackedProspectingJobService({
    authorizeProposer: authorizeProposerForLeadApproval,
    briefService: prospectingBriefService,
    filePath: resolveFile(env.RIO_X7_PROSPECTING_JOBS_PATH, undefined),
    profilesPath: resolveFile(env.RIO_X7_PROSPECTING_PROFILES_PATH, undefined),
    checkPermanentExclusion: prospectingExclusionService ? (finding) => prospectingExclusionService.isExcluded(finding) : undefined,
    env,
  });
  prospectingJobService.recoverInterruptedJobs();

  // Leads reprovados e reaprovação (Implementação 3.0): a MESMA fila e o MESMO CRM Service (só leitura), o MESMO arquivo de perfis do job (RIO_X7_PROSPECTING_PROFILES_PATH,
  // padrão data/prospecting-profiles.json, fora do Git). A reaprovação é decisão humana: só confere CRM e duplicidade (nada de exclusões nem DNC).
  const leadReconsiderationService = createFileBackedLeadReconsiderationService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    crmService,
    queuePath: resolveFile(env.RIO_X7_QUEUE_PATH, undefined),
    profilesPath: resolveFile(env.RIO_X7_PROSPECTING_PROFILES_PATH, undefined),
  });

  // Funnel Service (Etapa "Funis 1": funil/etapa, arquivo próprio, RIO_X7_FUNNELS_PATH; Etapa "Funis 2": card,
  // sobre o MESMO crmRepository/crmService que REPOSITORY_MODE decidiu para o CRM acima — nunca uma segunda
  // instância, mesmo princípio já aplicado à promoção e à prospecção).
  const funnelService = createFileBackedFunnelService({
    authorizeOperation: authorizeFunnelOperation,
    authorizeCrmOperation,
    filePath: funnelsFilePath,
    crmRepository,
    crmService,
  });

  const app = createApp({
    verifyAccessToken: authAdapter.verifyAccessToken,
    userStore,
    approvalQueueService,
    crmService,
    crmIntegrationService,
    prospectingService,
    prospectingBriefService,
    prospectingJobService,
    leadReconsiderationService,
    prospectingExclusionService,
    funnelService,
    publicConfig: { supabaseUrl, supabaseAnonKey },
    staticRoot: DASHBOARD_ROOT,
    staticFiles: { '/lib/supabase.js': SUPABASE_BUNDLE },
    log: options.log,
    authTimeoutMs: options.authTimeoutMs,
  });
  return { server: http.createServer(app.listener), app, host, port, usersCount: userStore.all().length };
}

async function start(env = process.env, options = {}) {
  const { server, host, port, usersCount } = createServer(env, options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { server, host, port: server.address().port, usersCount };
}

function main() {
  start(process.env, { log: (line) => console.log(line) }).then(
    ({ server, host, port, usersCount }) => {
      const shown = host.includes(':') ? `[${host}]` : host;
      console.log(`Rio X7 AI Agency OS — Dashboard em http://${shown}:${port} (${usersCount} usuário(s) carregado(s))`);
      if (host !== DEFAULT_HOST && host !== 'localhost' && host !== '::1') {
        console.warn('Atenção: o servidor fala HTTP puro e não está limitado ao computador local — coloque um proxy HTTPS na frente antes de expor.');
      }
      const stop = () => server.close(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    },
    (error) => {
      console.error(`Não foi possível iniciar o servidor: ${error.message}`);
      process.exitCode = 1;
    }
  );
}

// `module.id` é '.' só no programa principal (node src/server/index.js). Não uso `require.main`: a regra R6 de
// tests/auth/architecture-boundaries.test.js proíbe `require` como valor (esconderia carregamentos da análise).
if (module.id === '.') main();

module.exports = { loadUsers, createServer, start, DEFAULT_HOST, DEFAULT_PORT };
