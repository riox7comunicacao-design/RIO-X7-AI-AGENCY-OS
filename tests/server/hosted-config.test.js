// A CONFIGURAÇÃO DA IMPLANTAÇÃO HOSPEDADA (Fase WEB 1, decisão 0033): o modo (local | crm-only), a origem pública https, o limitador de falhas de autenticação, a leitura dos usuários por
// variável de ambiente (RIO_X7_USERS_JSON) e o script que gera esse valor. Funções puras e composição — nenhum Supabase real, nenhuma rede, nenhum arquivo de data/. Só dados fictícios.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEPLOYMENT_MODE,
  readDeploymentMode,
  readDeploymentConfig,
  readPublicOrigin,
  readTrustProxy,
  isDisabledInCrmOnly,
  forwardedProto,
  clientKey,
  AUTH_FAILURE_LIMIT,
} = require('../../src/server/deployment');
const { createFailureLimiter } = require('../../src/server/failureLimiter');
const { parseUsersEnv, loadUsers } = require('../../src/server/index');
const { run: exportUsersEnv } = require('../../scripts/export-users-env');

const USUARIOS = [
  { userId: 'user-teste-a', authUserId: '00000000-0000-4000-8000-00000000000a', name: 'Pessoa Teste A', email: 'a-teste@example.test', role: 'ADMIN', status: 'ACTIVE' },
  { userId: 'user-teste-b', authUserId: '00000000-0000-4000-8000-00000000000b', name: 'Pessoa Teste B', email: 'b-teste@example.test', role: 'COMMERCIAL_CLOSER', status: 'ACTIVE' },
];
const emBase64 = (valor) => Buffer.from(typeof valor === 'string' ? valor : JSON.stringify(valor), 'utf8').toString('base64');

// ===========================================================================
// O modo de implantação
// ===========================================================================
test('[HOST-CFG-1] o modo é "local" quando a variável falta, é vazia ou só tem espaços; "local" e "crm-only" são os únicos valores aceitos', () => {
  for (const env of [{}, { RIO_X7_DEPLOYMENT_MODE: '' }, { RIO_X7_DEPLOYMENT_MODE: '   ' }, { RIO_X7_DEPLOYMENT_MODE: 'local' }, { RIO_X7_DEPLOYMENT_MODE: ' local ' }]) {
    assert.equal(readDeploymentMode(env), DEPLOYMENT_MODE.LOCAL, JSON.stringify(env));
    const config = readDeploymentConfig(env);
    assert.deepEqual({ ...config }, { mode: 'local', hosted: false, publicOrigin: null, trustProxy: false });
  }
  assert.equal(readDeploymentMode({ RIO_X7_DEPLOYMENT_MODE: 'crm-only' }), DEPLOYMENT_MODE.CRM_ONLY);
  assert.equal(Object.isFrozen(readDeploymentConfig({})), true);
});

test('[HOST-CFG-2] qualquer outro valor derruba a subida — nunca cai para "local" por engano — e a mensagem não repete o valor recebido', () => {
  for (const valor of ['CRM-ONLY', 'crm_only', 'crmonly', 'hosted', 'prod', 'true', '1', 'local;crm-only']) {
    assert.throws(() => readDeploymentMode({ RIO_X7_DEPLOYMENT_MODE: valor }), (erro) => /RIO_X7_DEPLOYMENT_MODE inválido/.test(erro.message) && !erro.message.includes(valor === 'local;crm-only' ? 'local;' : valor), valor);
  }
});

test('[HOST-CFG-3] com "crm-only" a origem pública https é OBRIGATÓRIA e só é aceita como origem pura (sem caminho, consulta, usuário nem http)', () => {
  assert.throws(() => readDeploymentConfig({ RIO_X7_DEPLOYMENT_MODE: 'crm-only' }), /RIO_X7_PUBLIC_URL é obrigatória/);
  for (const invalido of ['', '   ', 'crm.exemplo.test', 'http://crm.exemplo.test', 'ftp://crm.exemplo.test', 'https://crm.exemplo.test/app', 'https://crm.exemplo.test/?a=1', 'https://crm.exemplo.test/#x', 'https://usuario:senha-secreta@crm.exemplo.test', 'https://', 'javascript:alert(1)']) {
    assert.throws(
      () => readPublicOrigin({ RIO_X7_PUBLIC_URL: invalido }),
      (erro) => /RIO_X7_PUBLIC_URL/.test(erro.message) && !erro.message.includes('senha-secreta'),
      invalido
    );
  }
  assert.equal(readPublicOrigin({ RIO_X7_PUBLIC_URL: 'https://crm.exemplo.test' }), 'https://crm.exemplo.test');
  assert.equal(readPublicOrigin({ RIO_X7_PUBLIC_URL: ' https://crm.exemplo.test/ ' }), 'https://crm.exemplo.test');
  assert.equal(readPublicOrigin({ RIO_X7_PUBLIC_URL: 'https://CRM.Exemplo.test:8443' }), 'https://crm.exemplo.test:8443');
  const config = readDeploymentConfig({ RIO_X7_DEPLOYMENT_MODE: 'crm-only', RIO_X7_PUBLIC_URL: 'https://crm.exemplo.test' });
  assert.deepEqual({ ...config }, { mode: 'crm-only', hosted: true, publicOrigin: 'https://crm.exemplo.test', trustProxy: false });
});

test('[HOST-CFG-4] RIO_X7_TRUST_PROXY: 0 (padrão) ou 1; qualquer outro valor é recusado', () => {
  assert.equal(readTrustProxy({}), false);
  assert.equal(readTrustProxy({ RIO_X7_TRUST_PROXY: '' }), false);
  assert.equal(readTrustProxy({ RIO_X7_TRUST_PROXY: '0' }), false);
  assert.equal(readTrustProxy({ RIO_X7_TRUST_PROXY: '1' }), true);
  for (const invalido of ['true', 'yes', '2', 'on']) assert.throws(() => readTrustProxy({ RIO_X7_TRUST_PROXY: invalido }), /RIO_X7_TRUST_PROXY inválido/);
  // no modo local as variáveis hospedadas são ignoradas (nada muda para quem não configurou nada)
  assert.equal(readDeploymentConfig({ RIO_X7_PUBLIC_URL: 'lixo', RIO_X7_TRUST_PROXY: 'lixo' }).hosted, false);
});

test('[HOST-CFG-5] os prefixos desativados: aprovações, prospecção e leads (e só eles), em qualquer profundidade', () => {
  for (const caminho of ['/api/approvals', '/api/approvals/x/approve', '/api/approvals/x/promote', '/api/prospecting', '/api/prospecting/submit', '/api/prospecting/briefs/b1/ready', '/api/prospecting/jobs', '/api/prospecting/exclusions/e1/activate', '/api/leads', '/api/leads/reprovados', '/api/leads/l1/completar-pesquisa']) {
    assert.equal(isDisabledInCrmOnly(caminho), true, caminho);
  }
  for (const caminho of ['/', '/api', '/api/me', '/api/crm', '/api/crm/x/history', '/api/crm-catalogs/servicos', '/api/funnels', '/api/funnel-board', '/api/funnel-cards/c1', '/api/negotiations/summary', '/api/approvalsx', '/api/leadsx', '/api/prospectingx', '/healthz', '/config.json']) {
    assert.equal(isDisabledInCrmOnly(caminho), false, caminho);
  }
});

test('[HOST-CFG-6] forwardedProto usa o ÚLTIMO valor (o do proxy mais próximo); clientKey só confia em X-Forwarded-For com RIO_X7_TRUST_PROXY=1 e usa o ÚLTIMO endereço', () => {
  const req = (headers = {}, remoteAddress) => ({ headers, socket: remoteAddress ? { remoteAddress } : undefined });
  assert.equal(forwardedProto(req()), null);
  assert.equal(forwardedProto(req({ 'x-forwarded-proto': 'http' })), 'http');
  assert.equal(forwardedProto(req({ 'x-forwarded-proto': 'HTTPS' })), 'https');
  assert.equal(forwardedProto(req({ 'x-forwarded-proto': 'https, http' })), 'http');
  assert.equal(forwardedProto(req({ 'x-forwarded-proto': 'http,https' })), 'https');
  assert.equal(forwardedProto(req({ 'x-forwarded-proto': ' , ' })), null);

  assert.equal(clientKey(req({ 'x-forwarded-for': '203.0.113.9' }, '10.0.0.1'), false), '10.0.0.1', 'sem confiança no proxy: o endereço do socket');
  assert.equal(clientKey(req({ 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }, '10.0.0.1'), true), '203.0.113.9', 'com confiança: o último (acrescentado pelo proxy); o que o cliente mandou vem antes e é ignorado');
  assert.equal(clientKey(req({ 'x-forwarded-for': '2001:db8::1' }, '10.0.0.1'), true), '2001:db8::1');
  assert.equal(clientKey(req({ 'x-forwarded-for': 'não-é-ip<script>' }, '10.0.0.1'), true), '10.0.0.1', 'valor que não parece um endereço: volta ao socket');
  assert.equal(clientKey(req({}, undefined), true), 'desconhecido');
  assert.equal(clientKey(req({ 'x-forwarded-for': ['a', 'b'] }, '10.0.0.1'), true), '10.0.0.1', 'cabeçalho repetido (lista): ignorado');
});

// ===========================================================================
// O limitador de falhas
// ===========================================================================
test('[HOST-LIM-1] bloqueia ao atingir o limite DENTRO da janela, devolve o tempo de espera e libera depois do bloqueio', () => {
  let agora = 1_000_000;
  const limitador = createFailureLimiter({ maxFailures: 3, windowMs: 60_000, blockMs: 120_000, now: () => agora });
  assert.deepEqual(limitador.check('a'), { blocked: false });
  limitador.fail('a');
  limitador.fail('a');
  assert.deepEqual(limitador.check('a'), { blocked: false }, 'ainda abaixo do limite');
  limitador.fail('a');
  assert.deepEqual(limitador.check('a'), { blocked: true, retryAfterSeconds: 120 });
  agora += 30_000;
  assert.deepEqual(limitador.check('a'), { blocked: true, retryAfterSeconds: 90 });
  agora += 90_000;
  assert.deepEqual(limitador.check('a'), { blocked: false }, 'passado o bloqueio, volta a valer');
  limitador.fail('a');
  limitador.fail('a');
  assert.deepEqual(limitador.check('a'), { blocked: false }, 'o contador recomeça do zero depois de um bloqueio');
});

test('[HOST-LIM-2] falhas fora da janela não somam; clientes diferentes não se afetam; um acerto não existe (só se registram falhas)', () => {
  let agora = 5_000;
  const limitador = createFailureLimiter({ maxFailures: 3, windowMs: 10_000, blockMs: 60_000, now: () => agora });
  limitador.fail('a');
  limitador.fail('a');
  agora += 10_001;
  limitador.fail('a');
  assert.deepEqual(limitador.check('a'), { blocked: false }, 'as duas primeiras já saíram da janela');
  limitador.fail('b');
  limitador.fail('b');
  limitador.fail('b');
  assert.equal(limitador.check('b').blocked, true);
  assert.equal(limitador.check('a').blocked, false, 'o bloqueio de b não alcança a');
  assert.equal(limitador.check('c').blocked, false);
});

test('[HOST-LIM-3] a memória tem teto: com chaves demais descarta as expiradas e, se preciso, as mais antigas', () => {
  let agora = 1;
  const limitador = createFailureLimiter({ maxFailures: 5, windowMs: 1_000, blockMs: 1_000, maxKeys: 50, now: () => agora });
  for (let i = 0; i < 500; i += 1) {
    agora += 1;
    limitador.fail(`ip-${i}`);
  }
  assert.ok(limitador.size() <= 50, `tamanho ${limitador.size()}`);
  agora += 5_000;
  limitador.fail('novo');
  assert.ok(limitador.size() <= 50);
});

test('[HOST-LIM-4] argumentos inválidos são recusados na criação; os limites padrão são os documentados', () => {
  for (const ruim of [{ maxFailures: 0 }, { windowMs: -1 }, { blockMs: 1.5 }, { maxKeys: 0 }, { now: 'x' }]) {
    assert.throws(() => createFailureLimiter({ maxFailures: 3, windowMs: 1000, blockMs: 1000, ...ruim }), /createFailureLimiter/);
  }
  assert.deepEqual({ ...AUTH_FAILURE_LIMIT }, { maxFailures: 30, windowMs: 600_000, blockMs: 600_000 });
});

// ===========================================================================
// Usuários por variável de ambiente
// ===========================================================================
test('[HOST-USR-1] RIO_X7_USERS_JSON aceita a lista JSON e o mesmo JSON em base64 (inclusive base64url), com os mesmos usuários do arquivo', () => {
  const porJson = parseUsersEnv(JSON.stringify(USUARIOS));
  const porBase64 = parseUsersEnv(emBase64(USUARIOS));
  const porUrl = parseUsersEnv(emBase64(USUARIOS).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  for (const lista of [porJson, porBase64, porUrl]) {
    assert.equal(lista.length, 2);
    assert.deepEqual(lista.map((u) => [u.userId, u.authUserId, u.role, u.status]), USUARIOS.map((u) => [u.userId, u.authUserId, u.role, u.status]));
  }
  assert.deepEqual(parseUsersEnv(`  \n${JSON.stringify(USUARIOS)}\n `).map((u) => u.userId), ['user-teste-a', 'user-teste-b'], 'espaços e quebras de linha em volta são ignorados');
});

test('[HOST-USR-2] o MESMO formato e as MESMAS regras do arquivo: campo desconhecido, papel inválido, lista vazia e item que não é objeto derrubam a subida', () => {
  assert.throws(() => parseUsersEnv(JSON.stringify([{ ...USUARIOS[0], permissions: ['x'] }])), /campos não permitidos: permissions/);
  assert.throws(() => parseUsersEnv(JSON.stringify([{ ...USUARIOS[0], role: 'SUPERUSUARIO' }])), /role desconhecida/);
  assert.throws(() => parseUsersEnv(JSON.stringify([{ ...USUARIOS[0], email: 'sem-formato' }])), /email/);
  assert.throws(() => parseUsersEnv('[]'), /pelo menos um usuário/);
  assert.throws(() => parseUsersEnv(emBase64('[]')), /pelo menos um usuário/);
  assert.throws(() => parseUsersEnv('[1]'), /deve ser um objeto/);
  assert.throws(() => parseUsersEnv(emBase64(JSON.stringify({ userId: 'x' }))), /pelo menos um usuário/, 'um objeto solto não é uma lista');
});

test('[HOST-USR-3] valor truncado, corrompido ou que não é JSON/base64 é recusado SEM repetir o conteúdo recebido', () => {
  const completo = JSON.stringify(USUARIOS);
  for (const ruim of [completo.slice(0, 80), emBase64(completo).slice(0, 60), 'isto não é nada', '{"userId":"x"}', '%%%%', emBase64('lixo que não é json')]) {
    assert.throws(
      () => parseUsersEnv(ruim),
      (erro) => /RIO_X7_USERS_JSON inválida/.test(erro.message) && !erro.message.includes('example.test') && !erro.message.includes('user-teste') && !erro.message.includes('Pessoa Teste'),
      ruim.slice(0, 20)
    );
  }
});

test('[HOST-USR-3b] a causa é dita com clareza: JSON cortado/ilegível diz "não é um JSON válido"; texto que não é base64 diz como informar o valor', () => {
  const completo = JSON.stringify(USUARIOS);
  assert.throws(() => parseUsersEnv(completo.slice(0, 80)), /RIO_X7_USERS_JSON inválida: o valor não é um JSON válido/);
  assert.throws(() => parseUsersEnv(emBase64(completo).slice(0, 61)), /RIO_X7_USERS_JSON inválida: o valor não é um JSON válido/);
  assert.throws(() => parseUsersEnv(emBase64('lixo que não é json')), /RIO_X7_USERS_JSON inválida: o valor não é um JSON válido/);
  assert.throws(() => parseUsersEnv('%%%%'), /RIO_X7_USERS_JSON inválida: informe a lista JSON dos usuários ou esse mesmo texto em base64/);
});

test('[HOST-USR-4] scripts/export-users-env.js: gera o valor a partir do arquivo (mesmo conteúdo), a confirmação não traz dado pessoal e um arquivo inválido termina com erro sem repetir o conteúdo', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-usersenv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivo = path.join(dir, 'users.json');
  fs.writeFileSync(arquivo, JSON.stringify(USUARIOS, null, 2));
  const antes = fs.readFileSync(arquivo, 'utf8');

  const ok = exportUsersEnv([arquivo]);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(Buffer.from(ok.stdout.trim(), 'base64').toString('utf8')), USUARIOS, 'o valor decodificado é EXATAMENTE o conteúdo do arquivo');
  assert.deepEqual(parseUsersEnv(ok.stdout.trim()).map((u) => u.userId), USUARIOS.map((u) => u.userId), 'e o servidor o lê');
  assert.match(ok.stderr, /^2 usuário\(s\) validado\(s\)/);
  assert.doesNotMatch(ok.stderr, /example\.test|user-teste|Pessoa Teste/);
  assert.equal(fs.readFileSync(arquivo, 'utf8'), antes, 'o arquivo não é alterado');
  assert.deepEqual(fs.readdirSync(dir), ['users.json'], 'nada novo é gravado em disco');

  const invalido = path.join(dir, 'invalido.json');
  fs.writeFileSync(invalido, '[{"userId": "x", "senha": "segredo-que-nao-deve-aparecer"}]');
  const falha = exportUsersEnv([invalido]);
  assert.equal(falha.code, 1);
  assert.equal(falha.stdout, undefined, 'nenhuma saída de valor quando há defeito');
  assert.doesNotMatch(falha.stderr, /segredo-que-nao-deve-aparecer/);
  const ausente = exportUsersEnv([path.join(dir, 'nao-existe.json')]);
  assert.equal(ausente.code, 1);
  assert.equal(ausente.stdout, undefined);
  // loadUsers (arquivo) segue sendo o mesmo caminho do modo local
  assert.equal(loadUsers(arquivo).length, 2);
});
