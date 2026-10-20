'use strict';

// Fase 2B-3.2B — a composição REAL do servidor (src/server/index.js createServer) com a guarda das Exclusões Permanentes da promoção, nos dois
// modos. Arquivos temporários, usuários e credenciais FICTÍCIOS, autenticação por fetch falso na borda (como o resto da suíte de servidor):
// nenhuma rede real, nenhum Supabase real. Em modo supabase só a CONSTRUÇÃO é exercitada (preguiçosa por desenho: nada fala com a rede).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../../src/server/index');
const { FILE_MODE_WARNING } = require('../../src/services/permanentExclusionGuard');
const { FAKE_ENV, fakeAccessToken, installFakeSupabaseAuth, supabaseUserBody } = require('../helpers/authFixtures');
const { BRENO, RAFAEL } = require('./testEnv');

function ambienteDeProducao(t, envExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-exclusoes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const usersFile = path.join(dir, 'users.json');
  const usuarios = [BRENO, RAFAEL];
  fs.writeFileSync(usersFile, JSON.stringify(usuarios.map(({ userId, authUserId, name, email, role, status }) => ({ userId, authUserId, name, email, role, status }))));
  const corpos = {};
  usuarios.forEach((u, i) => {
    corpos[fakeAccessToken(`excl-${i}`)] = supabaseUserBody({ authUserId: u.authUserId, email: u.email });
  });
  installFakeSupabaseAuth(t, corpos);
  const env = { ...FAKE_ENV, RIO_X7_USERS_FILE: usersFile, RIO_X7_QUEUE_PATH: path.join(dir, 'approval-queue.json'), RIO_X7_CRM_PATH: path.join(dir, 'crm.json'), ...envExtra };
  return { dir, env };
}

test('[EXCL-COMPOSE-1] MODO ARQUIVO (o padrão): o servidor sobe e declara que NÃO tem a verificação — o modo vem no retorno, para o aviso da inicialização', (t) => {
  const a = ambienteDeProducao(t);
  const { server, permanentExclusionsMode } = createServer(a.env);
  server.close();
  assert.equal(permanentExclusionsMode, 'FILE_MODE_UNVERIFIED');
  const b = ambienteDeProducao(t, { REPOSITORY_MODE: 'file' });
  const criado = createServer(b.env);
  criado.server.close();
  assert.equal(criado.permanentExclusionsMode, 'FILE_MODE_UNVERIFIED');
});

test('[EXCL-COMPOSE-2] MODO SUPABASE (configuração SINTÉTICA): a guarda é ENFORCED — a verificação existe; nenhum arquivo local do CRM é tocado e nada fala com a rede na construção', (t) => {
  const a = ambienteDeProducao(t, { REPOSITORY_MODE: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'service-role-de-teste-nao-real' });
  const { server, permanentExclusionsMode } = createServer(a.env);
  server.close();
  assert.equal(permanentExclusionsMode, 'ENFORCED');
  assert.equal(fs.existsSync(path.join(a.dir, 'crm.json')), false);
});

test('[EXCL-COMPOSE-3] nenhuma chave de ambiente nem opção do servidor liga o modo arquivo dentro do modo Supabase', (t) => {
  for (const extra of [{ RIO_X7_SKIP_EXCLUSION_CHECK: '1' }, { SKIP_EXCLUSIONS: 'true' }, { PERMANENT_EXCLUSIONS: 'off' }]) {
    const a = ambienteDeProducao(t, { REPOSITORY_MODE: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'service-role-de-teste-nao-real', ...extra });
    const { server, permanentExclusionsMode } = createServer(a.env, { permitirModoArquivo: true, skipExclusions: true });
    server.close();
    assert.equal(permanentExclusionsMode, 'ENFORCED', JSON.stringify(extra));
  }
});

test('[EXCL-COMPOSE-4] a raiz de composição liga a guarda de forma explícita e avisa na inicialização quando o modo não a tem (fonte)', () => {
  const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server', 'index.js'), 'utf8');
  assert.match(codigo, /createConfiguredPermanentExclusionGuard\(\{ env, exclusionService: prospectingExclusionService \}\)/, 'a guarda nasce da MESMA função de composição e do MESMO serviço de exclusões');
  assert.match(codigo, /createFileBackedCrmIntegrationService\(\{[^}]*permanentExclusions,\s*\}\)/, 'e é passada à promoção');
  // (desde a Fase WEB 1 estas peças são criadas dentro de `if (!crmOnly)`: atribuições, não `const`)
  assert.ok(codigo.indexOf('permanentExclusions = createConfiguredPermanentExclusionGuard') < codigo.indexOf('createFileBackedCrmIntegrationService({'), 'criada ANTES da promoção');
  assert.ok(codigo.indexOf('prospectingExclusionService = createConfiguredProspectingExclusionService') < codigo.indexOf('permanentExclusions = createConfiguredPermanentExclusionGuard'), 'e depois do serviço de exclusões');
  assert.match(codigo, /if \(!hosted && permanentExclusionsMode !== GUARD_MODE\.ENFORCED\) console\.warn\(FILE_MODE_WARNING\)/, 'o aviso sai no console da inicialização (do modo local)');
  assert.doesNotMatch(codigo, /FILE_MODE_UNVERIFIED\b/, 'a raiz de composição nunca referencia o marcador diretamente');
  assert.ok(FILE_MODE_WARNING.length > 100);
});
