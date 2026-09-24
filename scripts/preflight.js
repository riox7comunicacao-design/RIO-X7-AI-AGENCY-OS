// PREFLIGHT — verificação estrutural para retomar o projeto num computador novo.
//
//   node --env-file-if-exists=.env scripts/preflight.js
//
// Só verifica CONFIGURAÇÃO/ESTRUTURA — nunca faz login, nunca lê nem imprime o conteúdo de
// nenhum segredo. Para cada variável de ambiente sensível, o resultado é sempre só
// "PRESENTE"/"AUSENTE" — nunca o valor. Para data/users.json, só a contagem de usuários e as
// roles — nunca nome, e-mail ou authUserId. Reaproveita as mesmas funções que o servidor real usa
// (isSupabaseConfigured, loadUsers, checkConnectivity) em vez de reimplementar a checagem.
//
// Saída: cada verificação imprime OK ou FALHA (ou AVISO, quando é só uma recomendação, não um
// bloqueio). Termina com exit code 0 se nada FALHOU, 1 caso contrário — utilizável em CI/scripts.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const results = [];
function ok(label, detail) {
  results.push({ status: 'OK', label, detail });
}
function fail(label, detail) {
  results.push({ status: 'FALHA', label, detail });
}
function warn(label, detail) {
  results.push({ status: 'AVISO', label, detail });
}

function checkNodeVersion() {
  const required = (() => {
    try {
      return require(path.join(ROOT, 'package.json')).engines?.node || null;
    } catch {
      return null;
    }
  })();
  const atual = process.version;
  const major = Number(atual.slice(1).split('.')[0]);
  if (!required) {
    warn('Versão do Node', `${atual} — package.json não declara "engines.node"`);
    return;
  }
  const minimoMajor = Number((required.match(/(\d+)/) || [])[1] || 0);
  if (major >= minimoMajor) ok('Versão do Node', `${atual} (exigido: ${required})`);
  else fail('Versão do Node', `${atual} é menor que o exigido (${required})`);
}

function checkNpmDependencies() {
  let declared;
  try {
    declared = Object.keys(require(path.join(ROOT, 'package.json')).dependencies || {});
  } catch (err) {
    fail('package.json', `não foi possível ler: ${err.message}`);
    return;
  }
  if (declared.length === 0) {
    ok('Dependências declaradas', 'nenhuma');
    return;
  }
  const faltando = declared.filter((nome) => !fs.existsSync(path.join(ROOT, 'node_modules', ...nome.split('/'))));
  if (faltando.length === 0) ok('Dependências instaladas', declared.join(', '));
  else fail('Dependências instaladas', `faltando: ${faltando.join(', ')} — rode "npm install"`);
}

function checkDirectoryStructure() {
  const esperados = [
    'src/server/index.js',
    'src/server/app.js',
    'src/auth/index.js',
    'src/crm/index.js',
    'dashboard/index.html',
    'dashboard/app.mjs',
    '.env.example',
    '.gitignore',
  ];
  const faltando = esperados.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  if (faltando.length === 0) ok('Estrutura de diretórios', `${esperados.length} arquivos essenciais presentes`);
  else fail('Estrutura de diretórios', `ausentes: ${faltando.join(', ')}`);
}

function checkEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) ok('.env', 'PRESENTE');
  else fail('.env', 'AUSENTE — copie .env.example para .env e preencha (nunca versionado)');
}

function checkSupabaseEnvVars() {
  let SUPABASE_ENV_VARS;
  let isSupabaseConfigured;
  try {
    ({ SUPABASE_ENV_VARS, isSupabaseConfigured } = require(path.join(ROOT, 'src', 'auth')));
  } catch (err) {
    fail('Variáveis do Supabase', `não foi possível carregar src/auth: ${err.message}`);
    return;
  }
  for (const nome of SUPABASE_ENV_VARS) {
    const presente = Boolean(process.env[nome] && String(process.env[nome]).trim());
    (presente ? ok : fail)(`Variável ${nome}`, presente ? 'PRESENTE' : 'AUSENTE (rode com --env-file-if-exists=.env)');
  }
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    warn('SUPABASE_SERVICE_ROLE_KEY', 'está definida no ambiente — este projeto nunca a usa; considere removê-la deste ambiente');
  }
  return isSupabaseConfigured(process.env);
}

function checkOptionalEnvVars() {
  for (const nome of ['PORT', 'HOST', 'RIO_X7_USERS_FILE', 'RIO_X7_QUEUE_PATH', 'RIO_X7_CRM_PATH']) {
    const presente = Boolean(process.env[nome] && String(process.env[nome]).trim());
    ok(`Variável ${nome} (opcional)`, presente ? 'PRESENTE (usando valor customizado)' : 'AUSENTE (usando o padrão)');
  }
}

function checkUsersFile() {
  const usersFile = process.env.RIO_X7_USERS_FILE ? path.resolve(ROOT, process.env.RIO_X7_USERS_FILE) : path.join(ROOT, 'data', 'users.json');
  if (!fs.existsSync(usersFile)) {
    fail('data/users.json', `AUSENTE (${usersFile}) — crie antes de "npm start"; nenhum usuário é criado automaticamente`);
    return;
  }
  try {
    const { loadUsers } = require(path.join(ROOT, 'src', 'server', 'index.js'));
    const usuarios = loadUsers(usersFile);
    const porRole = {};
    for (const usuario of usuarios) porRole[usuario.role] = (porRole[usuario.role] || 0) + 1;
    ok('data/users.json', `válido — ${usuarios.length} usuário(s) (${Object.entries(porRole).map(([role, n]) => `${role}: ${n}`).join(', ')})`);
  } catch (err) {
    fail('data/users.json', `arquivo presente mas inválido: ${err.message}`);
  }
}

function checkGitignoreCoverage() {
  let conteudo;
  try {
    conteudo = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  } catch (err) {
    fail('.gitignore', `não foi possível ler: ${err.message}`);
    return;
  }
  const precisaCobrir = [
    ['.env', /(^|\n)\.env(\r?\n|$)/],
    ['data/*.json', /(^|\n)data\/\*\.json(\r?\n|$)/],
  ];
  const faltando = precisaCobrir.filter(([, padrao]) => !padrao.test(conteudo)).map(([nome]) => nome);
  if (faltando.length === 0) ok('.gitignore cobre dados sensíveis', '.env e data/*.json');
  else fail('.gitignore', `regra ausente para: ${faltando.join(', ')}`);
}

// Só executa se as variáveis já estiverem presentes — nunca tenta adivinhar/gerar credencial, e
// nunca autentica ninguém (checkConnectivity é uma checagem pública, sem login, já usada desde a
// decisão 0011).
async function checkSupabaseConnectivity(supabaseConfigurado) {
  if (!supabaseConfigurado) {
    warn('Conectividade com o Supabase', 'pulada — configure SUPABASE_URL/SUPABASE_ANON_KEY primeiro');
    return;
  }
  try {
    const { createSupabaseAuthAdapter } = require(path.join(ROOT, 'src', 'auth'));
    const adapter = createSupabaseAuthAdapter(process.env);
    const resultado = await adapter.checkConnectivity();
    if (resultado.status === 'OK') ok('Conectividade com o Supabase', 'OK (rede real, sem login)');
    else fail('Conectividade com o Supabase', `${resultado.status}${resultado.detail ? ` — ${resultado.detail}` : ''}`);
  } catch (err) {
    fail('Conectividade com o Supabase', err.message);
  }
}

async function main() {
  checkNodeVersion();
  checkNpmDependencies();
  checkDirectoryStructure();
  checkGitignoreCoverage();
  checkEnvFile();
  const supabaseConfigurado = checkSupabaseEnvVars();
  checkOptionalEnvVars();
  checkUsersFile();
  await checkSupabaseConnectivity(supabaseConfigurado);

  console.log('\n=== Preflight — Rio X7 AI Agency OS ===\n');
  for (const { status, label, detail } of results) {
    const marca = status === 'OK' ? '✔' : status === 'AVISO' ? '⚠' : '✖';
    console.log(`${marca} [${status}] ${label}: ${detail}`);
  }
  const falhas = results.filter((r) => r.status === 'FALHA').length;
  const avisos = results.filter((r) => r.status === 'AVISO').length;
  console.log(`\n${results.length} verificações — ${falhas} falha(s), ${avisos} aviso(s).`);
  process.exitCode = falhas > 0 ? 1 : 0;
}

if (module.id === '.') main();

module.exports = { main };
