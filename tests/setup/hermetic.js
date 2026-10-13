// GUARDA HERMÉTICO da suíte comum (`npm test`) — carregado por `node --require ./tests/setup/hermetic.js --test ...` em CADA processo de teste.
//
// POR QUE EXISTE: a suíte comum precisa ser segura de rodar em qualquer máquina e a qualquer hora: nunca pode falar com um serviço real (Supabase Auth, Supabase PostgREST, internet) nem
// iniciar o Claude deste computador, e nunca pode depender das credenciais do desenvolvedor. Antes, o `npm test` carregava o `.env` e dois testes antigos de autenticação consultavam o
// Supabase Auth REAL (somente leitura). Agora:
//   1. as credenciais externas são REMOVIDAS do ambiente do processo de teste (mesmo que o terminal as tenha exportadas) — o `npm test` também não carrega mais o `.env`;
//   2. qualquer tentativa de conexão a um host que NÃO seja o próprio computador (socket, DNS — o que cobre `fetch`, `http` e `https`) é BLOQUEADA com o erro ERR_TEST_NETWORK_BLOCKED,
//      e a tentativa fica registrada (se NETGUARD_LOG apontar para um arquivo: uma linha por tentativa — um log VAZIO é a evidência de que nada tentou sair);
//   3. iniciar um processo `claude` (a pesquisa web usa o Claude deste computador) é BLOQUEADO do mesmo modo.
// Conexões locais (localhost, 127.x, ::1 e sockets de arquivo) continuam livres: vários testes sobem servidores locais.
//
// O QUE ESTE ARQUIVO NÃO FAZ: não enfraquece nenhum teste nem toca a autenticação de produção. Os testes que PRECISAM de um serviço real (somente leitura) vivem em tests/integration/ e só
// executam sob autorização explícita: `npm run test:integration` com RIO_X7_RUN_EXTERNAL_TESTS=1 e as credenciais próprias — sem este guarda.

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const childProcess = require('node:child_process');

const BLOCKED = 'ERR_TEST_NETWORK_BLOCKED';
const EXTERNAL_ENV_KEYS = Object.freeze(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'RIO_X7_TEST_ACCESS_TOKEN']);

if (!globalThis.__RIO_X7_HERMETIC__) {
  globalThis.__RIO_X7_HERMETIC__ = true;

  for (const key of EXTERNAL_ENV_KEYS) delete process.env[key];

  const logFile = process.env.NETGUARD_LOG;
  const script = (process.argv[1] || '').replace(/\\/g, '/').split('/').slice(-2).join('/');
  const record = (origin, target) => {
    try {
      // as tentativas PROPOSITAIS do próprio teste do guarda (tests/scripts/hermetic-suite.test.js) não entram no log: ele é a evidência de que nenhum OUTRO teste tentou sair
      if (logFile && globalThis.__RIO_X7_HERMETIC_SELFTEST__ !== true) fs.appendFileSync(logFile, `${process.pid} | ${script} | ${origin} | ${target}\n`);
    } catch {
      // o guarda nunca derruba um teste por não conseguir registrar
    }
  };
  const blocked = (origin, target) => {
    record(origin, target);
    return Object.assign(new Error(`Teste bloqueado: tentativa de acesso externo (${origin}: ${target}). A suíte comum não fala com serviços reais — use tests/integration/ sob autorização explícita.`), { code: BLOCKED });
  };

  const LOCAL = /^(localhost|\[?::1\]?|0\.0\.0\.0|::ffff:127\.0\.0\.1|127(\.\d{1,3}){3})$/i;
  const isLocal = (host) => typeof host !== 'string' || host === '' || LOCAL.test(host);

  // net.Socket#connect: connect(options[, cb]) | connect(port[, host][, cb]) | connect(path[, cb]) | a forma interna normalizada [options, cb]
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    let host = null;
    let port = null;
    if (first && typeof first === 'object') {
      host = first.path ? null : first.host || 'localhost';
      port = first.port;
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      host = typeof args[1] === 'string' ? args[1] : 'localhost';
      port = first;
    }
    if (host !== null && !isLocal(host)) {
      const error = blocked('socket', `${host}:${port}`);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return originalConnect.apply(this, args);
  };

  const originalLookup = dns.lookup;
  dns.lookup = function lookup(hostname, ...rest) {
    if (typeof hostname === 'string' && !isLocal(hostname)) {
      const callback = rest.find((value) => typeof value === 'function');
      const error = blocked('dns', hostname);
      if (callback) {
        process.nextTick(() => callback(error));
        return {};
      }
      throw error;
    }
    return originalLookup.call(this, hostname, ...rest);
  };
  if (dns.promises && typeof dns.promises.lookup === 'function') {
    const originalLookupPromise = dns.promises.lookup;
    dns.promises.lookup = function lookup(hostname, ...rest) {
      if (typeof hostname === 'string' && !isLocal(hostname)) return Promise.reject(blocked('dns', hostname));
      return originalLookupPromise.call(this, hostname, ...rest);
    };
  }

  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = childProcess[name];
    childProcess[name] = function guarded(command, ...rest) {
      const text = `${command} ${Array.isArray(rest[0]) ? rest[0].join(' ') : ''}`;
      if (/\bclaude\b/i.test(text)) throw blocked('processo', text.slice(0, 120));
      return original.call(this, command, ...rest);
    };
  }
}

module.exports = { BLOCKED, EXTERNAL_ENV_KEYS };
