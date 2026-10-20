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
//   RIO_X7_FUNNELS_PATH               o arquivo de Funis/Etapas/Cards — SÓ no modo REPOSITORY_MODE=file (padrão: data/funnels.json); em "supabase" não é usado (decisão 0029)
//   RIO_X7_NEGOTIATIONS_PATH          o arquivo das Negociações — SÓ no modo REPOSITORY_MODE=file (padrão: data/negotiations.json; só nasce na PRIMEIRA gravação); em "supabase" não é usado (decisão 0029)
//   RIO_X7_CRM_CATALOGS_PATH          o arquivo dos catálogos do CRM — Serviços, Nichos, Origens dos Leads (padrão:
//                                     data/crm-catalogs.json; só no modo "file"; criado quando um ADMIN cria o 1º item)
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
// IMPLANTAÇÃO HOSPEDADA (Fase WEB 1, decisão 0033; deployment.js) — variáveis ADICIONAIS, todas opcionais no modo local:
//   RIO_X7_DEPLOYMENT_MODE   "local" (padrão) ou "crm-only". Em "crm-only" SÓ o CRM Comercial é composto: nenhum repositório de arquivo da Approval Queue/prospecção é criado, nenhum job é recuperado,
//                            nenhum arquivo de data/ é lido ou escrito (a instância roda em disco efêmero). Exige REPOSITORY_MODE=supabase, RIO_X7_PUBLIC_URL e uma fonte de usuários explícita.
//   RIO_X7_PUBLIC_URL        (crm-only) a origem https pública do site, usada no redirecionamento HTTP -> HTTPS.
//   RIO_X7_TRUST_PROXY       (crm-only) 1 = o limitador de falhas usa o último valor de X-Forwarded-For (o do proxy da plataforma); padrão 0.
//   RIO_X7_USERS_JSON        os usuários da aplicação por variável de ambiente (no lugar do arquivo): a lista JSON no mesmo formato de data/users.json, ou esse texto em base64. Não se combina com
//                            RIO_X7_USERS_FILE. Em "crm-only" não existe arquivo padrão: a fonte precisa ser uma destas duas.
// Ponto de entrada da hospedagem: server.js (na raiz) — chama main() deste arquivo; `npm start` continua valendo.
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
  authorizeCatalogOperation,
} = require('../auth');
const { createApprovalQueueService } = require('../services/approvalQueueService');
// Funnel Service (reestruturação Prospecção/CRM/Funis, Etapa "Funis 1") — só o adapter de arquivo local existe
// ainda (ver o cabeçalho de src/crm/funnelRepository.js); um adapter Supabase é uma etapa futura.
const { createConfiguredFunnelService, createConfiguredNegotiationService, createConfiguredActiveFunnelCardsChecker } = require('../services/commercialRepositoryFactory');
// Negotiation Service (CRM 5.0, Fase D1, decisão 0028) — adapter de arquivo local (o de produção no Supabase é uma decisão e uma fase próprias).
// createConfiguredCrmService (etapas 2.3/3H, decisão 0024): decide REPOSITORY_MODE (file ou supabase — ver o
// cabeçalho de crmRepositoryFactory.js) antes de montar o CRM Service. Substitui o import direto de
// createFileBackedCrmService: agora só a fábrica sabe qual adapter usar, e nunca um caminho escondido. Este
// servidor continua sem REPOSITORY_MODE no seu ambiente — continua em "file" — e ativar "supabase" em produção
// é uma decisão própria, futura, do proprietário (mudar .env), não desta preparação de código.
const { createConfiguredCrmService, createConfiguredCrmRepository, readRepositoryMode, REPOSITORY_MODE } = require('../services/crmRepositoryFactory');
const { createFileBackedCrmIntegrationService } = require('../services/crmIntegrationFileService');
const { createFileBackedProspectingService } = require('../services/prospectingFileService');
// Prospecting Permanent Exclusion Service (Workbench, Etapa 2) — mesma REPOSITORY_MODE do CRM; só existe em
// "supabase" (nunca um terceiro adapter local — ver o cabeçalho de prospectingExclusionRepositoryFactory.js).
const { createConfiguredProspectingExclusionService, createConfiguredPermanentExclusionGuard } = require('../services/prospectingExclusionRepositoryFactory');
// A guarda das Exclusões Permanentes da promoção (Fase 2B-3.2B): o aviso da inicialização quando o modo não tem o serviço.
const { GUARD_MODE, FILE_MODE_WARNING } = require('../services/permanentExclusionGuard');
// Catalog Service (CRM 5.0, Fase 2B-1 — Serviços, Nichos e Origens dos Leads): mesma REPOSITORY_MODE do CRM ("file" por padrão, com um
// arquivo local; "supabase" exige as tabelas da migration NÃO APLICADA). O contador de uso lê o MESMO repositório bruto do CRM.
const { createConfiguredCatalogService } = require('../services/catalogRepositoryFactory');
const { createCrmCatalogUsageCounter } = require('../services/catalogUsage');
// Prospecting Brief Service (Etapa "Prospecção 1" — Workbench): a camada ANTES da submissão — nunca reconstrói o
// Prospecting Service, só o recebe pronto (ver o cabeçalho de prospectingBriefFileService.js).
const { createFileBackedProspectingBriefService } = require('../services/prospectingBriefFileService');
// Prospecting Job Service (Fase 2 — "INICIAR PROSPECÇÃO"): a execução automática por cima do Brief Service (descoberta + validação + UMA ingestão
// pelo caminho oficial). Arquivo próprio (data/prospecting-jobs.json, fora do Git); nenhuma tabela, nenhuma API paga.
const { createFileBackedProspectingJobService, createFileBackedLeadReconsiderationService, createFileBackedLeadEnrichmentService } = require('../services/prospectingJobFileService');
const { createApp } = require('./app');
const { readDeploymentConfig, DEPLOYMENT_MODE, AUTH_FAILURE_LIMIT } = require('./deployment');
const { createFailureLimiter } = require('./failureLimiter');

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
// Negociações (Fase D1): o arquivo só passa a existir quando alguém cria a primeira negociação — nada é criado na subida.
const DEFAULT_NEGOTIATIONS_FILE = path.join(ROOT, 'data', 'negotiations.json');
// Catálogos do CRM (modo "file"): o arquivo só passa a existir quando um ADMIN cria o primeiro item — nada é criado na subida.
const DEFAULT_CRM_CATALOGS_FILE = path.join(ROOT, 'data', 'crm-catalogs.json');

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

  return buildUsers(entries, filePath);
}

// As entradas já lidas (de um arquivo ou da variável de ambiente) -> USERs de defineUser(). `source` só entra nas mensagens (o caminho do arquivo ou o NOME da variável — nunca o conteúdo).
function buildUsers(entries, source) {
  return entries.map((entry, index) => {
    const label = `usuário #${index + 1} de ${source}`;
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

const USERS_ENV = 'RIO_X7_USERS_JSON';
const hasText = (value) => typeof value === 'string' && value.trim() !== '';

// Os usuários vindos da variável de ambiente (hospedagem sem disco persistente): a lista JSON, ou esse JSON em base64 (evita problemas de aspas ao colar no painel da hospedagem). Mesmas regras de
// campos e de papéis do arquivo; qualquer defeito derruba a subida. As mensagens de JSON/base64 inválidos não repetem o conteúdo recebido; as de campo ou papel citam só o nome do campo e o
// valor recusado do papel, como já faz o arquivo.
function parseUsersEnv(raw) {
  const text = String(raw).trim();
  let json = text;
  if (!text.startsWith('[')) {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) throw new Error(`${USERS_ENV} inválida: informe a lista JSON dos usuários ou esse mesmo texto em base64.`);
    json = Buffer.from(text, 'base64').toString('utf8');
  }
  let entries;
  try {
    entries = JSON.parse(json.replace(/^﻿/, ''));
  } catch {
    throw new Error(`${USERS_ENV} inválida: o valor não é um JSON válido (confira se foi colado inteiro).`);
  }
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${USERS_ENV} inválida: deve conter uma lista com pelo menos um usuário.`);
  return buildUsers(entries, USERS_ENV);
}

// A FONTE dos usuários: a variável (RIO_X7_USERS_JSON) ou um arquivo (RIO_X7_USERS_FILE, ou data/users.json no modo local) — nunca as duas. Em "crm-only" não existe arquivo padrão.
function loadConfiguredUsers(env, { crmOnly }) {
  const fromEnv = hasText(env[USERS_ENV]);
  const explicitFile = hasText(env.RIO_X7_USERS_FILE);
  if (fromEnv && explicitFile) throw new Error(`configure só UMA fonte de usuários: ${USERS_ENV} ou RIO_X7_USERS_FILE, nunca as duas.`);
  if (fromEnv) return { users: parseUsersEnv(env[USERS_ENV]), where: USERS_ENV };
  if (crmOnly && !explicitFile) throw new Error(`RIO_X7_DEPLOYMENT_MODE=crm-only exige ${USERS_ENV} (a lista JSON dos usuários, ou esse texto em base64): não existe arquivo de usuários padrão nesta instalação.`);
  const usersFile = resolveFile(env.RIO_X7_USERS_FILE, DEFAULT_USERS_FILE);
  return { users: loadUsers(usersFile), where: usersFile };
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
  // O modo de implantação (decisão 0033). "crm-only": só o CRM Comercial é composto, sobre o Supabase — nunca sobre arquivos locais (a hospedagem tem disco efêmero).
  const deployment = readDeploymentConfig(env);
  const crmOnly = deployment.mode === DEPLOYMENT_MODE.CRM_ONLY;
  if (crmOnly && readRepositoryMode(env) !== REPOSITORY_MODE.SUPABASE) {
    throw new Error('RIO_X7_DEPLOYMENT_MODE=crm-only exige REPOSITORY_MODE=supabase: a instância hospedada nunca usa arquivos locais como persistência.');
  }

  if (!fs.existsSync(path.join(DASHBOARD_ROOT, 'index.html'))) throw new Error(`dashboard não encontrado em ${DASHBOARD_ROOT}.`);
  if (!fs.existsSync(SUPABASE_BUNDLE)) throw new Error('bundle do supabase-js para o navegador não encontrado: rode "npm install".');

  const { users, where: usersSource } = loadConfiguredUsers(env, { crmOnly });
  let userStore;
  try {
    userStore = createUserStore(users);
  } catch (error) {
    throw new Error(`${usersSource === USERS_ENV ? 'usuários inválidos' : 'arquivo de usuários inválido'}: ${usersSource}: ${error.message}`);
  }

  const supabaseUrl = env.SUPABASE_URL.trim();
  const supabaseAnonKey = env.SUPABASE_ANON_KEY.trim();
  // O adapter recebe SÓ as duas variáveis do Supabase, nunca o ambiente inteiro.
  const authAdapter = createSupabaseAuthAdapter({ SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: supabaseAnonKey });
  // Os módulos que guardam estado em ARQUIVO local (Approval Queue, promoção, prospecção, briefs, jobs, perfis, exclusões): só existem no modo "local". Em "crm-only" ficam todos `undefined` —
  // nenhum repositório de arquivo é criado, nenhum job é recuperado, nenhum arquivo de data/ é tocado — e createApp recusa recebê-los.
  let approvalQueueService;
  let prospectingExclusionService;
  let permanentExclusions;
  let crmIntegrationService;
  let prospectingService;
  let prospectingBriefService;
  let prospectingJobService;
  let leadEnrichmentService;
  let leadReconsiderationService;
  const crmFilePath = resolveFile(env.RIO_X7_CRM_PATH, DEFAULT_CRM_FILE);
  // As entidades COMERCIAIS (funis, etapas, cards e negociações) seguem REPOSITORY_MODE como o CRM e os catálogos (decisão 0029): em "supabase" os caminhos de arquivo abaixo NÃO são usados e não há
  // fallback para o arquivo; em "file" (desenvolvimento isolado e testes) valem os dois caminhos.
  const funnelsFilePath = resolveFile(env.RIO_X7_FUNNELS_PATH, DEFAULT_FUNNELS_FILE);
  const negotiationsFilePath = resolveFile(env.RIO_X7_NEGOTIATIONS_PATH, DEFAULT_NEGOTIATIONS_FILE);
  // A checagem de integridade CRM ↔ Card (Etapa "Funis 2 — correção final"): uma FUNÇÃO só (nunca o repositório
  // de Funil inteiro — ver o cabeçalho de funnelFileService.js), injetada no CRM Service abaixo para recusar
  // excluir um registro do CRM enquanto ele tiver Cards ativos. Não é o mesmo objeto que o Funnel Service usa por
  // baixo, mas lê o MESMO arquivo (RIO_X7_FUNNELS_PATH) — o adapter é sem estado, então isso nunca diverge.
  const hasActiveFunnelCards = createConfiguredActiveFunnelCardsChecker({ env, funnelsFilePath });
  const crmService = createConfiguredCrmService({ env, authorizeOperation: authorizeCrmOperation, filePath: crmFilePath, hasActiveFunnelCards });
  // O repositório BRUTO do CRM (Etapa "Funis 2"): a MESMA instância que `crmService` usa por baixo (o cache de
  // createConfiguredCrmRepository/sharedFileCrmRepository é por `filePath`) — o Funnel Service o usa só para
  // confirmar que um registro existe antes de criar um card; ele NUNCA autoriza nem decide nada sozinho.
  const crmRepository = createConfiguredCrmRepository({ env, filePath: crmFilePath });

  if (!crmOnly) {
    approvalQueueService = createApprovalQueueService({
      authorizeReviewer: authorizeReviewerForApprovalQueue,
      queuePath: resolveFile(env.RIO_X7_QUEUE_PATH, undefined),
    });
    // Prospecting Permanent Exclusion Service (Workbench, Etapa 2): OPCIONAL — só existe quando REPOSITORY_MODE=
    // supabase (a fábrica devolve `undefined` em "file", nunca um terceiro adapter local — ver o cabeçalho de
    // prospectingExclusionRepositoryFactory.js). Sem ele, o Prospecting Brief Service abaixo simplesmente não
    // recebe `checkPermanentExclusion` — o padrão de sempre ("nunca excluir por este motivo") continua valendo.
    // (Criado ANTES da promoção desde a Fase 2B-3.2B: a promoção depende dele.)
    prospectingExclusionService = createConfiguredProspectingExclusionService({ env, authorizeOperation: authorizeProspectingExclusionOperation });

    // A GUARDA das Exclusões Permanentes da promoção (Fase 2B-3.2B) — OBRIGATÓRIA, nunca omitida em silêncio: com o serviço acima (Supabase)
    // a promoção CONFERE a lista inteira antes de criar um registro; em REPOSITORY_MODE=file (sem o serviço) é o MARCADOR explícito de que
    // este modo não tem a funcionalidade — o servidor avisa na inicialização e uma promoção aqui não comprova a ausência de exclusões. Em
    // REPOSITORY_MODE=supabase sem o serviço a composição FALHA: o marcador do modo arquivo nunca vale ali, e não existe opção que o ligue.
    permanentExclusions = createConfiguredPermanentExclusionGuard({ env, exclusionService: prospectingExclusionService });

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
    crmIntegrationService = createFileBackedCrmIntegrationService({
      authorizeReviewer: authorizeReviewerForApprovalQueue,
      authorizeOperation: authorizeCrmOperation,
      queuePath: resolveFile(env.RIO_X7_QUEUE_PATH, undefined),
      crmService,
      permanentExclusions,
    });

    // O Prospecting Service (submissão de prospecção): a MESMA fila e o MESMO `crmService` e as pontes de PROPOSE:LEAD_APPROVAL e do
    // CRM (READ:CRM). O arquivo dos lotes usa o caminho padrão e seguro do adapter (data/prospecting-batches.json, fora do Git).
    prospectingService = createFileBackedProspectingService({
      authorizeProposer: authorizeProposerForLeadApproval,
      authorizeOperation: authorizeCrmOperation,
      queuePath: resolveFile(env.RIO_X7_QUEUE_PATH, undefined),
      crmService,
    });

    // Prospecting Brief Service (Workbench, Etapa "Prospecção 1"; exclusões permanentes desde a Etapa 2): o MESMO
    // `prospectingService` acima, injetado — nunca reconstruído. Arquivo próprio (data/prospecting-briefs.json,
    // fora do Git). `checkPermanentExclusion` é o MESMO `isExcluded` do Service acima quando ele existe (Supabase
    // configurado) — nunca uma segunda instância nem uma cópia da lista.
    prospectingBriefService = createFileBackedProspectingBriefService({
      authorizeProposer: authorizeProposerForLeadApproval,
      prospectingService,
      filePath: resolveFile(env.RIO_X7_PROSPECTING_BRIEFS_PATH, undefined),
      checkPermanentExclusion: prospectingExclusionService ? (finding) => prospectingExclusionService.isExcluded(finding) : undefined,
    });

    // Prospecting Job Service (Fase 2): o MESMO `prospectingBriefService` acima (o caminho oficial de ingestão), as MESMAS exclusões permanentes
    // e o ambiente só para o motor de descoberta, que repassa ao processo filho apenas uma lista mínima de variáveis. Um job que estava rodando
    // quando o servidor caiu é marcado como INTERROMPIDO na subida (nunca finge ter concluído). Arquivo: RIO_X7_PROSPECTING_JOBS_PATH
    // (padrão data/prospecting-jobs.json, fora do Git).
    prospectingJobService = createFileBackedProspectingJobService({
      authorizeProposer: authorizeProposerForLeadApproval,
      briefService: prospectingBriefService,
      filePath: resolveFile(env.RIO_X7_PROSPECTING_JOBS_PATH, undefined),
      profilesPath: resolveFile(env.RIO_X7_PROSPECTING_PROFILES_PATH, undefined),
      queuePath: resolveFile(env.RIO_X7_QUEUE_PATH, undefined),
      crmService,
      checkPermanentExclusion: prospectingExclusionService ? (finding) => prospectingExclusionService.isExcluded(finding) : undefined,
      env,
    });
    prospectingJobService.recoverInterruptedJobs();

    // Leads reprovados e reaprovação (Implementação 3.0): a MESMA fila e o MESMO CRM Service (só leitura), o MESMO arquivo de perfis do job (RIO_X7_PROSPECTING_PROFILES_PATH,
    // padrão data/prospecting-profiles.json, fora do Git). A reaprovação é decisão humana: só confere CRM e duplicidade (nada de exclusões nem DNC).
    // COMPLETAR PESQUISA (3.0.2): o enriquecimento comercial aprofundado, sob demanda, de UM lead — a MESMA fila (só leitura) e o MESMO arquivo de perfis; o `claude -p` real só nasce aqui.
    leadEnrichmentService = createFileBackedLeadEnrichmentService({
      authorizeReviewer: authorizeReviewerForApprovalQueue,
      queuePath: resolveFile(env.RIO_X7_QUEUE_PATH, undefined),
      profilesPath: resolveFile(env.RIO_X7_PROSPECTING_PROFILES_PATH, undefined),
      env,
    });
    leadReconsiderationService = createFileBackedLeadReconsiderationService({
      authorizeReviewer: authorizeReviewerForApprovalQueue,
      crmService,
      queuePath: resolveFile(env.RIO_X7_QUEUE_PATH, undefined),
      profilesPath: resolveFile(env.RIO_X7_PROSPECTING_PROFILES_PATH, undefined),
    });
  }

  // Funnel Service (Etapa "Funis 1": funil/etapa, arquivo próprio, RIO_X7_FUNNELS_PATH; Etapa "Funis 2": card,
  // sobre o MESMO crmRepository/crmService que REPOSITORY_MODE decidiu para o CRM acima — nunca uma segunda
  // instância, mesmo princípio já aplicado à promoção e à prospecção).
  const funnelService = createConfiguredFunnelService({
    env,
    authorizeOperation: authorizeFunnelOperation,
    authorizeCrmOperation,
    funnelsFilePath,
    crmRepository,
    crmService,
  });

  // Catalog Service (Fase 2B-1): administrar (MANAGE:CRM_CATALOGS, só ADMIN) e consultar os itens ativos (READ:CRM) os catálogos de
  // Serviços, Nichos e Origens dos Leads. NÃO liga nada ao CRM: os campos nicho/origem/servicoPotencial seguem texto livre. O contador
  // de uso lê o MESMO `crmRepository` acima (nunca autoriza nem grava) só para recusar renomear um item que algum registro usa.
  const crmCatalogService = createConfiguredCatalogService({
    env,
    authorizeOperation: authorizeCatalogOperation,
    filePath: resolveFile(env.RIO_X7_CRM_CATALOGS_PATH, DEFAULT_CRM_CATALOGS_FILE),
    countUsage: createCrmCatalogUsageCounter({ crmRepository }),
  });

  // Negotiation Service (Fase D1, decisão 0028): a oportunidade de UM cliente por UM serviço do catálogo, num funil. Usa o MESMO crmRepository/crmService (o que REPOSITORY_MODE decidiu), o MESMO
  // arquivo de funis (o card da negociação vive nele) e o MESMO Catalog Service (só leitura: o que o serviço permite). Nada é gravado no catálogo nem nos campos legados do CRM.
  const negotiationService = createConfiguredNegotiationService({
    env,
    authorizeCrmOperation,
    funnelsFilePath,
    negotiationsFilePath,
    crmRepository,
    crmService,
    catalogService: crmCatalogService,
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
    leadEnrichmentService,
    prospectingExclusionService,
    funnelService,
    negotiationService,
    crmCatalogService,
    publicConfig: { supabaseUrl, supabaseAnonKey },
    staticRoot: DASHBOARD_ROOT,
    staticFiles: { '/lib/supabase.js': SUPABASE_BUNDLE },
    log: options.log,
    authTimeoutMs: options.authTimeoutMs,
    // Só na instância hospedada (crm-only): o modo, a origem pública (redirecionamento HTTPS) e o limitador de falhas de autenticação. No modo local nada disto é passado.
    ...(crmOnly
      ? {
          deploymentMode: deployment.mode,
          publicOrigin: deployment.publicOrigin,
          trustProxy: deployment.trustProxy,
          authFailureLimiter: createFailureLimiter({ ...AUTH_FAILURE_LIMIT, now: options.now }),
        }
      : {}),
  });
  return {
    server: http.createServer(app.listener),
    app,
    host,
    port,
    usersCount: userStore.all().length,
    permanentExclusionsMode: permanentExclusions ? permanentExclusions.mode : undefined,
    deploymentMode: deployment.mode,
  };
}

async function start(env = process.env, options = {}) {
  const { server, host, port, usersCount, permanentExclusionsMode, deploymentMode } = createServer(env, options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { server, host, port: server.address().port, usersCount, permanentExclusionsMode, deploymentMode };
}

// Uma única subida por processo: um segundo main() (um arranque duplicado pela plataforma ou por um wrapper) devolve a MESMA promessa, nunca um segundo servidor.
let mainPromise = null;

function main() {
  if (mainPromise !== null) return mainPromise;
  mainPromise = start(process.env, { log: (line) => console.log(line) }).then(
    ({ server, host, port, usersCount, permanentExclusionsMode, deploymentMode }) => {
      const shown = host.includes(':') ? `[${host}]` : host;
      const hosted = deploymentMode === DEPLOYMENT_MODE.CRM_ONLY;
      console.log(`Rio X7 AI Agency OS${hosted ? ' (CRM — instância hospedada)' : ''} — Dashboard em http://${shown}:${port} (${usersCount} usuário(s) carregado(s))`);
      // O aviso das Exclusões Permanentes é do modo local (a promoção); na instância hospedada não há promoção.
      if (!hosted && permanentExclusionsMode !== GUARD_MODE.ENFORCED) console.warn(FILE_MODE_WARNING);
      if (!hosted && host !== DEFAULT_HOST && host !== 'localhost' && host !== '::1') {
        console.warn('Atenção: o servidor fala HTTP puro e não está limitado ao computador local — coloque um proxy HTTPS na frente antes de expor.');
      }
      const stop = () => server.close(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return server;
    },
    (error) => {
      console.error(`Não foi possível iniciar o servidor: ${error.message}`);
      process.exitCode = 1;
      return null;
    }
  );
  return mainPromise;
}

// `module.id` é '.' só no programa principal (node src/server/index.js). Não uso `require.main`: a regra R6 de
// tests/auth/architecture-boundaries.test.js proíbe `require` como valor (esconderia carregamentos da análise).
// A hospedagem executa server.js (na raiz), que chama main() explicitamente — por isso main é exportada.
if (module.id === '.') main();

module.exports = { loadUsers, parseUsersEnv, createServer, start, main, DEFAULT_HOST, DEFAULT_PORT };
