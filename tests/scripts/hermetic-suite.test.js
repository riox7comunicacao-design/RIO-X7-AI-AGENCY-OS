// A SUÍTE COMUM É HERMÉTICA (CRM 5.0, Fase 2B-2): `npm test` nunca fala com um serviço real, nunca inicia o Claude deste computador e nunca depende das credenciais do desenvolvedor.
// O guarda (tests/setup/hermetic.js) é carregado por `node --require` em cada processo de teste; estes testes provam que ele está ATIVO, que BLOQUEIA o que é externo, que deixa o computador
// local livre e que a separação dos testes de integração externa (tests/integration/) não regride. Nenhum acesso externo é feito: as tentativas é que são bloqueadas.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const path = require('node:path');
const childProcess = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
// De propósito NÃO se faz require('../setup/hermetic.js') aqui: isso instalaria o guarda dentro do próprio teste e o HERM-1 passaria sem o `--require` do npm test. As constantes são repetidas
// (e conferidas contra o código do guarda no HERM-1).
const BLOCKED = 'ERR_TEST_NETWORK_BLOCKED';
const EXTERNAL_ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'RIO_X7_TEST_ACCESS_TOKEN'];

const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const listar = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = path.join(dir, entrada.name);
    return entrada.isDirectory() ? listar(caminho) : [caminho];
  });

test('[HERM-1] o guarda está ATIVO neste processo de teste e as credenciais externas não existem no ambiente', () => {
  assert.equal(globalThis.__RIO_X7_HERMETIC__, true, 'o npm test carrega tests/setup/hermetic.js com --require');
  for (const chave of EXTERNAL_ENV_KEYS) assert.equal(process.env[chave], undefined, `${chave} não pode existir na suíte comum`);
  // as constantes deste teste são as do guarda (lidas do código dele, sem executá-lo)
  const guarda = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'setup', 'hermetic.js'), 'utf8');
  assert.ok(guarda.includes(`'${BLOCKED}'`));
  for (const chave of EXTERNAL_ENV_KEYS) assert.ok(guarda.includes(`'${chave}'`), chave);
});

// As tentativas dos testes abaixo são PROPOSITAIS (provam que o guarda bloqueia): elas não entram no log do guarda (NETGUARD_LOG), que fica como evidência de que NENHUM outro teste tentou sair.
const proposital = async (corpo) => {
  globalThis.__RIO_X7_HERMETIC_SELFTEST__ = true;
  try {
    return await corpo();
  } finally {
    globalThis.__RIO_X7_HERMETIC_SELFTEST__ = false;
  }
};

test('[HERM-2] uma conexão de socket a um host externo (nome ou IP) é BLOQUEADA com ERR_TEST_NETWORK_BLOCKED, sem sair do computador', async () => {
  for (const host of ['exemplo-externo.invalid', '203.0.113.10', 'projeto.supabase.co']) {
    const erro = await proposital(
      () =>
        new Promise((resolve) => {
          const socket = net.connect({ host, port: 443 });
          socket.once('error', resolve);
          socket.once('connect', () => resolve(null));
        })
    );
    assert.ok(erro, `${host}: a conexão não pode ter sido estabelecida`);
    assert.equal(erro.code, BLOCKED, host);
  }
});

test('[HERM-3] a resolução de nomes (DNS) de um host externo é BLOQUEADA, por callback e por promessa', async () => {
  const porCallback = await proposital(() => new Promise((resolve) => dns.lookup('exemplo-externo.invalid', (erro) => resolve(erro))));
  assert.equal(porCallback.code, BLOCKED);
  await proposital(() => assert.rejects(() => dns.promises.lookup('projeto.supabase.co'), (erro) => erro.code === BLOCKED));
});

test('[HERM-4] fetch para um endereço externo falha por causa do guarda (a causa é o bloqueio, não a rede)', async () => {
  await proposital(() =>
    assert.rejects(
      () => fetch('https://projeto-inexistente.supabase.co/auth/v1/settings'),
      (erro) => {
        let causa = erro;
        for (let nivel = 0; causa && nivel < 5; nivel += 1) {
          if (causa.code === BLOCKED) return true;
          causa = causa.cause;
        }
        return false;
      }
    )
  );
});

test('[HERM-5] o computador LOCAL continua livre: um servidor em 127.0.0.1 e o fetch até ele funcionam', async () => {
  const servidor = http.createServer((req, res) => res.end('ok-local'));
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = servidor.address();
    const resposta = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await resposta.text(), 'ok-local');
    const viaNome = await fetch(`http://localhost:${port}/`).then((r) => r.text()).catch(() => 'ipv6-indisponivel');
    assert.ok(viaNome === 'ok-local' || viaNome === 'ipv6-indisponivel');
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
  }
});

test('[HERM-6] iniciar um processo "claude" (a pesquisa web usa o Claude deste computador) é BLOQUEADO; outros processos locais seguem livres', () => {
  for (const chamada of [() => childProcess.spawn('claude', ['--version']), () => childProcess.spawnSync('claude', ['-p', 'x']), () => childProcess.execFileSync('claude', ['--help']), () => childProcess.execSync('claude --version')]) {
    globalThis.__RIO_X7_HERMETIC_SELFTEST__ = true;
    try {
      assert.throws(chamada, (erro) => erro.code === BLOCKED);
    } finally {
      globalThis.__RIO_X7_HERMETIC_SELFTEST__ = false;
    }
  }
  assert.equal(childProcess.spawnSync(process.execPath, ['-e', 'process.exit(0)']).status, 0);
});

test('[HERM-7] o package.json separa os dois mundos: `test` carrega o guarda, NÃO carrega o .env e NÃO inclui tests/integration; `test:integration` é só a integração externa', () => {
  const pacote = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const comum = pacote.scripts.test;
  assert.match(comum, /--require \.\/tests\/setup\/hermetic\.js/);
  assert.doesNotMatch(comum, /--env-file/, 'a suíte comum não carrega o .env do desenvolvedor');
  assert.doesNotMatch(comum, /integration/);
  const integracao = pacote.scripts['test:integration'];
  assert.match(integracao, /tests\/integration\/\*\.test\.js/);
  assert.doesNotMatch(integracao, /hermetic/, 'a integração externa roda SEM o guarda (é o objetivo dela), mas só sob autorização explícita');
});

test('[HERM-8] todo teste de tests/integration/ exige autorização explícita (RIO_X7_RUN_EXTERNAL_TESTS=1) antes de qualquer outra coisa — e há algum', () => {
  const arquivos = listar(path.join(REPO_ROOT, 'tests', 'integration')).filter((f) => f.endsWith('.test.js'));
  assert.ok(arquivos.length >= 1);
  for (const arquivo of arquivos) {
    const codigo = semComentarios(fs.readFileSync(arquivo, 'utf8'));
    assert.match(codigo, /process\.env\.RIO_X7_RUN_EXTERNAL_TESTS === '1'/, path.basename(arquivo));
    const testes = [...codigo.matchAll(/^test\(/gm)].length;
    const portoes = [...codigo.matchAll(/if \(!autorizado\(t\)\) return;/g)].length;
    assert.ok(testes > 0);
    assert.equal(portoes, testes, `${path.basename(arquivo)}: cada teste começa com o portão de autorização`);
  }
});

test('[HERM-9] REGRESSÃO: nenhum teste da suíte comum cria o adapter do Supabase com o process.env real nem lê o token de teste — isso só vive em tests/integration/', () => {
  const arquivos = listar(path.join(REPO_ROOT, 'tests')).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  const ignorados = [path.join('tests', 'integration'), path.join('tests', 'setup'), path.join('tests', 'scripts', 'hermetic-suite.test.js')];
  let verificados = 0;
  for (const arquivo of arquivos) {
    const relativo = path.relative(REPO_ROOT, arquivo);
    if (ignorados.some((parte) => relativo.startsWith(parte))) continue;
    const codigo = semComentarios(fs.readFileSync(arquivo, 'utf8'));
    verificados += 1;
    assert.doesNotMatch(codigo, /createSupabaseAuthAdapter\(\s*process\.env\s*\)/, `${relativo}: usaria o ambiente real`);
    assert.doesNotMatch(codigo, /RIO_X7_TEST_ACCESS_TOKEN/, `${relativo}: o token de teste real só é lido na integração`);
  }
  assert.ok(verificados > 50, 'a varredura cobre a suíte inteira');
});

test('[HERM-10] O GUARDA SÓ AFETA TESTES: nenhum arquivo de src/, scripts/ ou dashboard/ o conhece, e os scripts de produção (`start` e `dev`) continuam carregando o .env e sem o guarda', () => {
  const marcas = /hermetic|NETGUARD|__RIO_X7_HERMETIC__|RIO_X7_RUN_EXTERNAL_TESTS|ERR_TEST_NETWORK_BLOCKED|tests\/setup/;
  let verificados = 0;
  for (const raiz of ['src', 'scripts', 'dashboard']) {
    for (const arquivo of listar(path.join(REPO_ROOT, raiz)).filter((f) => /\.(js|mjs|cjs|json|html|css)$/.test(f))) {
      verificados += 1;
      assert.doesNotMatch(fs.readFileSync(arquivo, 'utf8'), marcas, `${path.relative(REPO_ROOT, arquivo)} não pode depender do guarda dos testes`);
    }
  }
  assert.ok(verificados > 40, 'a varredura cobre a produção inteira');
  const pacote = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pacote.scripts.start, 'node --env-file-if-exists=.env src/server/index.js');
  assert.equal(pacote.scripts.dev, 'node --watch --env-file-if-exists=.env src/server/index.js');
  assert.equal(pacote.scripts['smoke:researcher'], 'node scripts/smoke-researcher.js');
  // só o `npm test` carrega o guarda, e só por --require (nenhum teste o importa: o HERM-1 depende disso)
  for (const [nome, comando] of Object.entries(pacote.scripts)) assert.equal(/tests\/setup\/hermetic\.js/.test(comando), nome === 'test', nome);
  const testes = listar(path.join(REPO_ROOT, 'tests')).filter((f) => /\.(js|mjs)$/.test(f) && !f.endsWith(path.join('setup', 'hermetic.js')));
  for (const arquivo of testes) {
    const codigo = semComentarios(fs.readFileSync(arquivo, 'utf8'));
    assert.doesNotMatch(codigo, /require\(\s*['"][^'"]*setup\/hermetic(\.js)?['"]\s*\)|import\s[^;]*setup\/hermetic/, `${path.relative(REPO_ROOT, arquivo)} não pode importar o guarda`);
  }
});
