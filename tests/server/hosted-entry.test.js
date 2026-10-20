// O PONTO DE ENTRADA DA HOSPEDAGEM (Fase WEB 1, decisão 0033): `node server.js`, como a Hostinger Web Apps o executa (arquivo de entrada), num PROCESSO de verdade — com o ambiente que o painel
// da hospedagem daria (sem arquivo .env, sem data/users.json, HOST e PORT vindos do ambiente).
//
// Prova: sobe UM servidor, na porta pedida pelo ambiente; responde /healthz, recusa módulos desativados, redireciona HTTP; não sobe duplicado quando main() é chamada duas vezes; e uma
// configuração inválida derruba o processo com código 1 e uma mensagem sem segredo. O filho NÃO conversa com a rede (nenhuma rota usada precisa do Supabase) e roda sem o `.env` (o servidor
// hospedado lê só o ambiente: `npm start` é que usa --env-file-if-exists). Dados fictícios; credenciais falsas; sem arquivos de data/.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const CHAVE = 'chave-de-servico-falsa-so-para-teste-entrada';
const USUARIOS = JSON.stringify([{ userId: 'user-admin-teste', authUserId: 'auth-admin-teste', name: 'Admin Teste', email: 'admin-teste@example.test', role: 'ADMIN', status: 'ACTIVE' }]);

const ambiente = (extra = {}) => ({
  ...process.env,
  SUPABASE_URL: 'https://exemplo.supabase.co',
  SUPABASE_ANON_KEY: 'chave-anon-de-teste-nao-real',
  SUPABASE_SERVICE_ROLE_KEY: CHAVE,
  REPOSITORY_MODE: 'supabase',
  RIO_X7_DEPLOYMENT_MODE: 'crm-only',
  RIO_X7_PUBLIC_URL: 'https://crm.exemplo.test',
  RIO_X7_USERS_JSON: USUARIOS,
  HOST: '127.0.0.1',
  PORT: '0',
  ...extra,
});

// Roda `node <args>` no repositório e junta a saída. `aoLinha(linha, filho)` pode agir quando uma linha aparece (e devolver true para encerrar a espera).
function executar(args, env, { aoLinha, limiteMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const filho = spawn(process.execPath, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let saida = '';
    let erro = '';
    let encerrado = false;
    const fim = (resultado) => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(limite);
      resolve(resultado);
    };
    const limite = setTimeout(() => {
      filho.kill();
      fim({ saida, erro, codigo: 'TEMPO', filho });
    }, limiteMs);
    filho.on('error', (e) => {
      clearTimeout(limite);
      if (!encerrado) reject(e);
    });
    let aguardando = false;
    filho.stdout.on('data', (pedaco) => {
      saida += pedaco.toString('utf8');
      // a linha de subida chegou: espera um instante para a saída de erro (os avisos de console.warn) chegar também
      if (!aguardando && aoLinha && saida.split('\n').some((linha) => aoLinha(linha, filho))) {
        aguardando = true;
        setTimeout(() => fim({ saida, erro, codigo: null, filho }), 400);
      }
    });
    filho.stderr.on('data', (pedaco) => {
      erro += pedaco.toString('utf8');
    });
    filho.on('close', (codigo) => fim({ saida, erro, codigo, filho }));
  });
}

const pedir = (port, caminho, { method = 'GET', headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: caminho, method, headers, agent: false }, (res) => {
      let corpo = '';
      res.on('data', (p) => (corpo += p));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo }));
    });
    req.on('error', reject);
    req.end();
  });

test('[HOSTED-ENTRY-1] `node server.js` com o ambiente do painel: sobe UM servidor na porta pedida, atende /healthz, recusa módulos desativados, redireciona HTTP e fala HSTS', async (t) => {
  let port = null;
  const resultado = await executar(['server.js'], ambiente(), {
    aoLinha: (linha) => {
      const m = /Dashboard em http:\/\/127\.0\.0\.1:(\d+) \((\d+) usuário/.exec(linha);
      if (m) port = Number(m[1]);
      return m !== null;
    },
  });
  t.after(() => resultado.filho.kill());
  assert.ok(port > 0, `o servidor anunciou a porta (saída: ${resultado.saida.slice(0, 300)} | erro: ${resultado.erro.slice(0, 300)})`);
  assert.match(resultado.saida, /\(CRM — instância hospedada\)/);
  assert.match(resultado.saida, /\(1 usuário\(s\) carregado\(s\)\)/);
  assert.doesNotMatch(resultado.saida + resultado.erro, /Atenção: o servidor fala HTTP puro/, 'na instância hospedada o HTTPS é do proxy da plataforma');
  assert.doesNotMatch(resultado.saida + resultado.erro, new RegExp(CHAVE), 'nada de segredo na saída');

  const saude = await pedir(port, '/healthz');
  assert.equal(saude.status, 200);
  assert.deepEqual(JSON.parse(saude.corpo), { status: 'ok' });
  assert.equal(saude.headers['strict-transport-security'], 'max-age=31536000');
  const desativado = await pedir(port, '/api/approvals');
  assert.equal(desativado.status, 404);
  assert.equal(JSON.parse(desativado.corpo).error.code, 'MODULE_DISABLED');
  assert.equal((await pedir(port, '/api/me')).status, 401, 'o CRM segue protegido por sessão');
  const redireciona = await pedir(port, '/', { headers: { 'x-forwarded-proto': 'http', host: 'atacante.example.test' } });
  assert.equal(redireciona.status, 308);
  assert.equal(redireciona.headers.location, 'https://crm.exemplo.test/');
  assert.equal((await pedir(port, '/')).status, 200, 'a página do painel é entregue');
  assert.match((await pedir(port, '/config.json')).corpo, /"modo":"crm-only"/);
});

test('[HOSTED-ENTRY-2] main() chamada duas vezes devolve a MESMA promessa e sobe um único servidor (nada de arranque duplicado); o servidor encerra limpo', async () => {
  const codigo = [
    "const { main } = require('./src/server/index');",
    'const a = main();',
    'const b = main();',
    'a.then((servidor) => {',
    "  console.log('SONDA ' + JSON.stringify({ mesmaPromessa: a === b, ouvindo: servidor.listening, porta: servidor.address().port > 0 }));",
    '  servidor.close(() => process.exit(0));',
    '});',
  ].join(' ');
  const r = await executar(['-e', codigo], ambiente());
  assert.equal(r.codigo, 0, `${r.saida}\n${r.erro}`);
  const sonda = JSON.parse(/SONDA (.*)/.exec(r.saida)[1]);
  assert.deepEqual(sonda, { mesmaPromessa: true, ouvindo: true, porta: true });
  assert.equal((r.saida.match(/Dashboard em http/g) || []).length, 1, 'a mensagem de subida aparece uma única vez');
});

test('[HOSTED-ENTRY-3] configuração inválida: o processo termina com código 1 e uma mensagem clara SEM segredo; nenhuma porta fica aberta', async () => {
  for (const [extra, padrao] of [
    [{ RIO_X7_USERS_JSON: '[{"userId":' }, /RIO_X7_USERS_JSON inválida/],
    [{ RIO_X7_USERS_JSON: '' }, /crm-only exige RIO_X7_USERS_JSON/],
    [{ REPOSITORY_MODE: 'file' }, /crm-only exige REPOSITORY_MODE=supabase/],
    [{ RIO_X7_PUBLIC_URL: 'http://crm.exemplo.test' }, /RIO_X7_PUBLIC_URL inválida/],
    [{ RIO_X7_DEPLOYMENT_MODE: 'producao' }, /RIO_X7_DEPLOYMENT_MODE inválido/],
    [{ SUPABASE_SERVICE_ROLE_KEY: '' }, /SUPABASE_SERVICE_ROLE_KEY/],
    [{ PORT: 'abc' }, /PORT inválida/],
  ]) {
    const r = await executar(['server.js'], ambiente(extra));
    assert.equal(r.codigo, 1, JSON.stringify(extra));
    assert.match(r.erro, /Não foi possível iniciar o servidor:/);
    assert.match(r.erro, padrao, JSON.stringify(extra));
    assert.doesNotMatch(r.saida + r.erro, new RegExp(CHAVE));
    assert.doesNotMatch(r.saida + r.erro, /admin-teste@example\.test/);
    assert.doesNotMatch(r.saida, /Dashboard em/);
  }
});

test('[HOSTED-ENTRY-5] o aviso de "HTTP puro" é do modo LOCAL: a instância hospedada (HOST fora do loopback padrão, atrás do proxy da plataforma) não o emite; o modo local o emite (controle)', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const anunciou = (linha) => /Dashboard em http:\/\/127\.0\.0\.2:(\d+)/.test(linha);
  const hospedado = await executar(['server.js'], ambiente({ HOST: '127.0.0.2' }), { aoLinha: anunciou });
  t.after(() => hospedado.filho.kill());
  assert.match(hospedado.saida, /Dashboard em http:\/\/127\.0\.0\.2:\d+/, `${hospedado.saida}\n${hospedado.erro}`);
  assert.doesNotMatch(hospedado.saida + hospedado.erro, /fala HTTP puro/, 'o HTTPS é do proxy da plataforma');

  // controle: o MESMO HOST no modo local (tudo em arquivos TEMPORÁRIOS — nunca os de data/) emite o aviso
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-entry-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const caminho = (nome) => path.join(dir, nome);
  const local = await executar(['server.js'], ambiente({
    HOST: '127.0.0.2',
    RIO_X7_DEPLOYMENT_MODE: '',
    REPOSITORY_MODE: '',
    RIO_X7_QUEUE_PATH: caminho('fila.json'),
    RIO_X7_CRM_PATH: caminho('crm.json'),
    RIO_X7_FUNNELS_PATH: caminho('funis.json'),
    RIO_X7_NEGOTIATIONS_PATH: caminho('negociacoes.json'),
    RIO_X7_CRM_CATALOGS_PATH: caminho('catalogos.json'),
    RIO_X7_PROSPECTING_BRIEFS_PATH: caminho('briefs.json'),
    RIO_X7_PROSPECTING_JOBS_PATH: caminho('jobs.json'),
    RIO_X7_PROSPECTING_PROFILES_PATH: caminho('perfis.json'),
  }), { aoLinha: anunciou });
  t.after(() => local.filho.kill());
  assert.match(local.saida + local.erro, /fala HTTP puro/, `${local.saida}\n${local.erro}`);
  assert.doesNotMatch(local.saida, /instância hospedada/);
});

test('[HOSTED-ENTRY-4] o arquivo de entrada não tem lógica: só carrega o servidor e chama main() (sem rotina de teste, de dados ou de migração) — e o npm start continua apontando para o mesmo servidor', () => {
  const fs = require('node:fs');
  const entrada = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l) && l.trim() !== '').join('\n');
  assert.equal(entrada, "const { main } = require('./src/server/index');\nmain();");
  const pacote = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pacote.scripts.start, 'node --env-file-if-exists=.env src/server/index.js', 'o uso local não mudou');
  assert.equal(pacote.scripts.build, undefined, 'não há etapa de build (a Hostinger roda só a instalação e o arquivo de entrada)');
  assert.match(pacote.engines.node, />=22/);
});
