// Configuração do futuro adapter Postgres/Supabase do CRM (decisão 0024, etapa 2) — SEM rede, SEM banco. Só
// confere: validação da URL/chave, mensagens de erro sem segredo, e que nada aqui jamais loga nada.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readSupabaseCrmConfig, isSupabaseCrmConfigured } = require('../../src/crm-adapters/crmSupabaseConfig');

const CHAVE_DE_TESTE = 'service-role-de-teste-nao-real';
const URL_DE_TESTE = 'https://projeto-de-teste.supabase.co';

function semLogar(fn) {
  const chamadas = [];
  const originais = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const nome of Object.keys(originais)) console[nome] = (...args) => chamadas.push([nome, args]);
  try {
    fn();
  } finally {
    for (const [nome, original] of Object.entries(originais)) console[nome] = original;
  }
  return chamadas;
}

test('[CFG-1] SUPABASE_URL ausente: recusa, e a mensagem não inclui nenhum valor (não há o que vazar)', () => {
  assert.throws(() => readSupabaseCrmConfig({}), /SUPABASE_URL não está configurada/);
  assert.throws(() => readSupabaseCrmConfig({ SUPABASE_URL: '   ' }), /SUPABASE_URL não está configurada/);
  assert.equal(isSupabaseCrmConfigured({}), false);
});

test('[CFG-2] SUPABASE_URL inválida ou não-https: recusa com mensagem específica', () => {
  assert.throws(() => readSupabaseCrmConfig({ SUPABASE_URL: 'não é uma url', SUPABASE_SERVICE_ROLE_KEY: CHAVE_DE_TESTE }), /não é uma URL válida/);
  assert.throws(() => readSupabaseCrmConfig({ SUPABASE_URL: 'http://projeto.supabase.co', SUPABASE_SERVICE_ROLE_KEY: CHAVE_DE_TESTE }), /deve ser https/);
});

test('[CFG-3] SUPABASE_SERVICE_ROLE_KEY ausente (mesmo com URL válida): recusa — necessária SÓ para o adapter Postgres, nunca para o CRM local', () => {
  assert.throws(() => readSupabaseCrmConfig({ SUPABASE_URL: URL_DE_TESTE }), /SUPABASE_SERVICE_ROLE_KEY não está configurada/);
  assert.throws(() => readSupabaseCrmConfig({ SUPABASE_URL: URL_DE_TESTE, SUPABASE_SERVICE_ROLE_KEY: '   ' }), /SUPABASE_SERVICE_ROLE_KEY não está configurada/);
  assert.equal(isSupabaseCrmConfigured({ SUPABASE_URL: URL_DE_TESTE }), false);
});

test('[CFG-4] com as duas variáveis presentes: devolve { url, serviceRoleKey } exatos, sem barra final, congelado', () => {
  const config = readSupabaseCrmConfig({ SUPABASE_URL: `${URL_DE_TESTE}/`, SUPABASE_SERVICE_ROLE_KEY: CHAVE_DE_TESTE });
  assert.deepEqual(config, { url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE });
  assert.ok(Object.isFrozen(config));
  assert.equal(isSupabaseCrmConfigured({ SUPABASE_URL: URL_DE_TESTE, SUPABASE_SERVICE_ROLE_KEY: CHAVE_DE_TESTE }), true);
});

test('[CFG-5] nenhuma chamada (válida, inválida ou isSupabaseCrmConfigured) jamais loga nada — nem a chave de teste, nem qualquer outra coisa', () => {
  const chamadas = semLogar(() => {
    try { readSupabaseCrmConfig({}); } catch { /* esperado */ }
    try { readSupabaseCrmConfig({ SUPABASE_URL: URL_DE_TESTE }); } catch { /* esperado */ }
    readSupabaseCrmConfig({ SUPABASE_URL: URL_DE_TESTE, SUPABASE_SERVICE_ROLE_KEY: CHAVE_DE_TESTE });
    isSupabaseCrmConfigured({});
    isSupabaseCrmConfigured({ SUPABASE_URL: URL_DE_TESTE, SUPABASE_SERVICE_ROLE_KEY: CHAVE_DE_TESTE });
  });
  assert.deepEqual(chamadas, []);
});

test('[CFG-6] a chave de teste nunca aparece na mensagem de nenhum erro lançado', () => {
  for (const env of [{}, { SUPABASE_URL: URL_DE_TESTE }, { SUPABASE_URL: 'não é uma url', SUPABASE_SERVICE_ROLE_KEY: CHAVE_DE_TESTE }]) {
    try {
      readSupabaseCrmConfig(env);
      assert.fail('deveria ter lançado');
    } catch (erro) {
      assert.doesNotMatch(erro.message, new RegExp(CHAVE_DE_TESTE));
    }
  }
});

test('[CFG-7] estático: o próprio arquivo de configuração nunca chama console.* (garantia estrutural, não só de comportamento)', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'crm-adapters', 'crmSupabaseConfig.js'), 'utf8');
  assert.doesNotMatch(fonte.replace(/\/\/[^\n]*/g, ''), /\bconsole\s*\./);
});
