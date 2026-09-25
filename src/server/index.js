// Servidor do Dashboard — a raiz de composição (composition root) da aplicação.
//
//   npm start  |  npm run dev          (node --env-file-if-exists=.env src/server/index.js)
//
// É AQUI, e só aqui, que as peças são ligadas: o adapter de autenticação do Supabase (verifica o access token),
// o store de USERs (data/users.json, via defineUser + createUserStore), o Approval Queue Service e o CRM Service (cada
// um com a sua ponte de autorização de src/auth como autorizador injetado) e o adaptador HTTP (app.js). Este arquivo
// só importa os pontos PÚBLICOS: o barrel de src/auth e os módulos dos Services — nunca um domínio (nem o da fila,
// nem o do CRM: a regra R12 só deixa src/services importar src/crm) nem arquivos internos de auth. O CRM entra por
// createFileBackedCrmService (src/services/crmFileService.js): o servidor passa só o CAMINHO do arquivo, como faz com a fila.
//
// CONFIGURAÇÃO — o servidor lê SÓ estas variáveis de ambiente, e nenhuma é segredo:
//   SUPABASE_URL, SUPABASE_ANON_KEY   o projeto Supabase (a chave anon é pública por desenho)
//   PORT (3000), HOST (127.0.0.1)     onde escutar
//   RIO_X7_USERS_FILE                 o arquivo de usuários (padrão: data/users.json)
//   RIO_X7_QUEUE_PATH                 o arquivo da fila (padrão: o do domínio, data/approval-queue.json)
//   RIO_X7_CRM_PATH                   o arquivo do CRM (padrão: data/crm.json; criado no primeiro registro)
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
} = require('../auth');
const { createApprovalQueueService } = require('../services/approvalQueueService');
const { createFileBackedCrmService } = require('../services/crmFileService');
const { createFileBackedCrmIntegrationService } = require('../services/crmIntegrationFileService');
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
  const crmService = createFileBackedCrmService({
    authorizeOperation: authorizeCrmOperation,
    filePath: resolveFile(env.RIO_X7_CRM_PATH, DEFAULT_CRM_FILE),
  });

  // A promoção Approval Queue → CRM (decisão 0016): os MESMOS dois arquivos e as MESMAS portas de autorização.
  const crmIntegrationService = createFileBackedCrmIntegrationService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    authorizeOperation: authorizeCrmOperation,
    queuePath: resolveFile(env.RIO_X7_QUEUE_PATH, undefined),
    crmPath: resolveFile(env.RIO_X7_CRM_PATH, DEFAULT_CRM_FILE),
  });

  const app = createApp({
    verifyAccessToken: authAdapter.verifyAccessToken,
    userStore,
    approvalQueueService,
    crmService,
    crmIntegrationService,
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
