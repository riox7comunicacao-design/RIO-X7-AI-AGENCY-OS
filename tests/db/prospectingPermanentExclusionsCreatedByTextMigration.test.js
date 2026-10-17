'use strict';

// Fase 2B-3.2B-H2 — a migration CORRETIVA do tipo de created_by_user_id (UUID -> TEXT) das Exclusões Permanentes de Prospecção.
// Testes ESTÁTICOS: só leem o texto das migrations em supabase/migrations/ e as aplicam a um SIMULADOR de esquema em memória
// (tests/helpers/migrationSchemaSimulator.js). SEM banco, sem rede, sem Supabase, sem credencial. Não provam o estado do banco
// operacional — que NÃO foi consultado — só o CONTRATO versionado e a compatibilidade entre as duas migrations, na ordem em que o
// proprietário as aplicaria. A migration continua NÃO APLICADA.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { SchemaError, MIGRATIONS_DIR, newSchema, applyMigrations, insertRow, statementsOf } = require('../helpers/migrationSchemaSimulator');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ORIGINAL = '20260930090000_prospecting_permanent_exclusions.sql';
const CORRETIVA = '20261017090000_prospecting_permanent_exclusions_created_by_text.sql';
const CATALOGOS = '20261012090000_crm_catalogs.sql';
const TABELA = 'prospecting_permanent_exclusions';
// A restrição de "não vazio" que uma versão anterior desta migration propunha e que foi DESCARTADA (a validação já existe na aplicação):
// o nome só é usado para provar que ela não voltou.
const RESTRICAO_DESCARTADA = 'prospecting_permanent_exclusions_created_by_user_id_check';

const le = (arquivo) => fs.readFileSync(path.join(MIGRATIONS_DIR, arquivo), 'utf8').replace(/\r\n/g, '\n');
const SQL = le(CORRETIVA);
const EXECUTAVEL = SQL.replace(/--[^\n]*/g, '');
const normaliza = (texto) => texto.replace(/\s+/g, ' ').trim();

const UUID_V4 = '3f2b8c1e-9d4a-4e6b-8a7c-5d1e2f3a4b5c';
const linhaBase = (extra = {}) => ({
  id: crypto.randomUUID(),
  empresa_nome: 'Empresa Fictícia Exemplo',
  empresa_nome_normalizado: 'empresa ficticia exemplo',
  motivo: 'motivo fictício',
  ...extra,
});

function codigoDe(fn) {
  try {
    fn();
  } catch (erro) {
    return erro instanceof SchemaError ? erro.code : `outro:${erro.message}`;
  }
  return null;
}

test('[MIG-EXCL-TXT-1] o arquivo existe, segue a convenção do CLI do Supabase, vem DEPOIS da original e da dos catálogos, e se declara NÃO APLICADA e sem consulta ao banco', () => {
  assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, CORRETIVA)));
  assert.match(CORRETIVA, /^\d{14}_[a-z0-9_]+\.sql$/);
  const todas = fs.readdirSync(MIGRATIONS_DIR).filter((nome) => nome.endsWith('.sql')).sort();
  assert.ok(todas.indexOf(CORRETIVA) > todas.indexOf(ORIGINAL), 'posterior à original');
  assert.ok(todas.indexOf(CORRETIVA) > todas.indexOf(CATALOGOS), 'posterior também à dos catálogos: o CLI nunca a trata como fora de ordem, qualquer que seja o estado do banco');
  const cabecalho = SQL.split('\n').slice(0, 12).join('\n');
  assert.match(cabecalho, /NÃO APLICADA\./);
  assert.match(SQL, /20260930090000/, 'cita a migration que corrige');
  assert.match(SQL, /O estado real do banco NÃO foi consultado/);
  assert.match(SQL, /Aplicar é uma ação humana e consciente do proprietário/i);
});

test('[MIG-EXCL-TXT-2] altera SÓ o TIPO da coluna created_by_user_id: exatamente UM comando (TEXT, com o cast do valor) — nenhuma restrição, nenhuma regra nova', () => {
  const comandos = statementsOf(SQL).map(normaliza);
  assert.deepEqual(comandos, [`ALTER TABLE public.${TABELA} ALTER COLUMN created_by_user_id TYPE TEXT USING created_by_user_id::TEXT`]);
});

test('[MIG-EXCL-TXT-3] a AUSÊNCIA da tabela continua identificável: nada cria a tabela, nada engole o erro — aplicada sozinha num banco sem a tabela, falha com "relation does not exist" (42P01)', () => {
  assert.doesNotMatch(EXECUTAVEL, /\bIF\s+(NOT\s+)?EXISTS\b/i, 'sem IF [NOT] EXISTS');
  assert.doesNotMatch(EXECUTAVEL, /\bCREATE\s+(OR\s+REPLACE\s+)?(TABLE|FUNCTION|VIEW|TRIGGER|INDEX)\b/i, 'não cria nada');
  assert.doesNotMatch(EXECUTAVEL, /\b(DO|BEGIN|EXCEPTION|EXECUTE|PERFORM|RAISE|LOOP)\b/i, 'sem bloco procedural que engula o erro, sem SQL dinâmico');
  assert.equal(codigoDe(() => applyMigrations([CORRETIVA])), '42P01', 'sem a original, o erro é "a tabela não existe"');
  // …e o erro nomeia a tabela, para o proprietário saber o que falta aplicar primeiro
  assert.throws(() => applyMigrations([CORRETIVA]), new RegExp(TABELA));
});

test('[MIG-EXCL-TXT-4] NADA destrutivo e NADA além: sem DROP, DELETE, TRUNCATE, INSERT, UPDATE, GRANT/REVOKE, policy, índice, gatilho, RLS, restrição criada ou removida, nem outra coluna ou tabela', () => {
  for (const proibido of [/\bDROP\b/i, /\bDELETE\b/i, /\bTRUNCATE\b/i, /\bINSERT\b/i, /\bUPDATE\b/i, /\bGRANT\b/i, /\bREVOKE\b/i, /\bPOLICY\b/i, /\bINDEX\b/i, /\bTRIGGER\b/i, /\bROW\s+LEVEL\b/i, /\bSET\s+NOT\s+NULL\b/i, /\bSET\s+DEFAULT\b/i, /\bRENAME\b/i, /\bADD\s+COLUMN\b/i, /\bNOT\s+VALID\b/i, /\bCONSTRAINT\b/i, /\bCHECK\b/i, /\bNOT\s+NULL\b/i, /\bUNIQUE\b/i, /\bPRIMARY\b/i, /\bREFERENCES\b/i, /\bDEFAULT\b/i]) {
    assert.doesNotMatch(EXECUTAVEL, proibido, String(proibido));
  }
  assert.equal(SQL.includes(RESTRICAO_DESCARTADA), false, 'a restrição descartada não voltou (nem em comentário)');
  const tabelas = [...EXECUTAVEL.matchAll(/\bpublic\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tabelas)], [TABELA], 'só esta tabela');
  for (const outra of ['id', 'empresa_nome', 'empresa_nome_normalizado', 'cidade', 'estado', 'pais', 'dominio', 'motivo', 'ativo', 'created_at', 'updated_at', 'created_by_name', 'crm_records', 'crm_funnels', 'crm_services']) {
    assert.doesNotMatch(EXECUTAVEL, new RegExp(`\\b${outra}\\b`), `${outra} não é tocado`);
  }
});

test('[MIG-EXCL-TXT-5] a migration HISTÓRICA não foi modificada (SHA-256, fim de linha normalizado) e continua declarando UUID: quem corrige é a migration nova', () => {
  const hash = crypto.createHash('sha256').update(le(ORIGINAL)).digest('hex');
  assert.equal(hash, 'f5ce7a919c65bc7bc013306a1790bff30e4e33fe419086806a979df60ead600c', 'a original foi alterada');
  assert.match(le(ORIGINAL).replace(/--[^\n]*/g, ''), /created_by_user_id\s+UUID/);
  assert.equal(le(ORIGINAL).includes(RESTRICAO_DESCARTADA), false);
});

test('[MIG-EXCL-TXT-6] ORDEM A: a original e depois a corretiva, em sequência (tabela vazia): o tipo efetivo vira TEXT e TUDO o mais fica exatamente como a original deixou — colunas, tipos, nulidade, índices, RLS, policies, gatilho', () => {
  const antes = applyMigrations([ORIGINAL]).tables.get(TABELA);
  const depois = applyMigrations([ORIGINAL, CORRETIVA]).tables.get(TABELA);
  assert.equal(antes.columns.get('created_by_user_id').type, 'UUID');
  assert.equal(depois.columns.get('created_by_user_id').type, 'TEXT');
  assert.equal(depois.columns.get('created_by_user_id').notNull, false, 'continua opcional (uma exclusão antiga pode não ter autor)');
  assert.equal(depois.columns.get('created_by_user_id').nonBlank, false, 'e SEM nenhuma regra nova de banco');

  // Tudo, inclusive as propriedades da própria coluna alterada (nulidade, default, regra), é idêntico — menos o TIPO dela.
  const foto = (tabela) => ({
    colunas: [...tabela.columns.values()].map(({ name, type, notNull, hasDefault, defaultValue, nonBlank }) => ({ name, type: name === 'created_by_user_id' ? '(único que muda)' : type, notNull, hasDefault, defaultValue, nonBlank })),
    ordem: [...tabela.columns.keys()],
    restricoes: tabela.constraints,
    indices: tabela.indexes,
    rls: tabela.rls,
    policies: tabela.policies,
    gatilhos: tabela.triggers,
  });
  assert.deepEqual(foto(depois), foto(antes));
  assert.equal(depois.rls, true, 'a RLS continua ligada');
  assert.deepEqual(depois.policies, [], 'e continua SEM nenhuma policy');
  assert.deepEqual(depois.indexes, ['prospecting_permanent_exclusions_nome_norm_idx', 'prospecting_permanent_exclusions_dominio_idx']);
  assert.deepEqual(depois.triggers, ['prospecting_permanent_exclusions_bump_updated_at_trigger']);
  assert.deepEqual(depois.constraints, [], 'nenhuma restrição foi criada nem removida');
});

test('[MIG-EXCL-TXT-7] ORDEM B: a original JÁ aplicada e COM linhas — a corretiva preserva TODAS (mesmos ids, mesmos valores, mesma autoria, mesmo updated_at) e não perde identidade', () => {
  const schema = applyMigrations([ORIGINAL]);
  const gravadas = [
    insertRow(schema, TABELA, linhaBase({ created_by_user_id: UUID_V4, created_by_name: 'Admin Fictício A' })),
    insertRow(schema, TABELA, linhaBase({ created_by_user_id: UUID_V4.toUpperCase(), created_by_name: 'Admin Fictício B', ativo: false })),
    insertRow(schema, TABELA, linhaBase()), // sem autor
  ];
  const copiaAntes = JSON.parse(JSON.stringify(schema.tables.get(TABELA).rows));
  applyMigrations([CORRETIVA], schema);
  const linhas = schema.tables.get(TABELA).rows;
  assert.deepEqual(linhas, copiaAntes, 'nenhuma linha mudou');
  assert.equal(linhas.length, 3);
  assert.deepEqual(linhas.map((l) => l.id), gravadas.map((l) => l.id), 'os ids são os mesmos');
  assert.deepEqual(linhas.map((l) => l.updated_at), gravadas.map((l) => l.updated_at), 'updated_at intacto (o DDL não dispara o gatilho)');
  assert.deepEqual(linhas.map((l) => l.created_by_user_id), [UUID_V4, UUID_V4, null], 'o UUID virou o seu texto canônico; a ausência de autor continua ausente');
  assert.ok(linhas.every((l) => typeof l.created_by_user_id === 'string' || l.created_by_user_id === null));
});

test('[MIG-EXCL-TXT-8] o CONTRATO de cada ordem: só com a original, um userId textual é RECUSADO (a incompatibilidade confirmada) e um UUID passa; com a corretiva, TEXTO, UUID (qualquer caixa) e ausência de autor passam, guardados exatamente como vieram', () => {
  const soOriginal = applyMigrations([ORIGINAL]);
  assert.equal(codigoDe(() => insertRow(soOriginal, TABELA, linhaBase({ created_by_user_id: 'user-breno' }))), '22P02', 'texto não é UUID: invalid_text_representation');
  assert.equal(codigoDe(() => insertRow(soOriginal, TABELA, linhaBase({ created_by_user_id: UUID_V4 }))), null);

  const corrigido = applyMigrations([ORIGINAL, CORRETIVA]);
  for (const userId of ['user-breno', 'breno', UUID_V4, UUID_V4.toUpperCase(), 'user:com espaços e acento ã']) {
    const guardada = insertRow(corrigido, TABELA, linhaBase({ created_by_user_id: userId }));
    assert.equal(guardada.created_by_user_id, userId, `${userId}: guardado EXATAMENTE como veio (identidade preservada, sem normalizar a caixa)`);
  }
  assert.equal(codigoDe(() => insertRow(corrigido, TABELA, linhaBase({ created_by_user_id: null }))), null);
});

test('[MIG-EXCL-TXT-9] NENHUMA regra nova de banco e dados históricos preservados: a corretiva nunca recusa uma linha existente (mesmo com valores incomuns, como um em branco) e o banco não passa a recusar nada que a original aceitava; "userId não vazio" é regra da aplicação', () => {
  const schema = applyMigrations([ORIGINAL, CORRETIVA]);
  const tabela = schema.tables.get(TABELA);
  // dados históricos incomuns (hipótese: gravados por fora da aplicação, com a coluna já em TEXT): a corretiva repetida não os valida nem os altera
  const incomuns = ['', '   ', 'Breno', 'texto muito longo '.repeat(50)];
  for (const valor of incomuns) insertRow(schema, TABELA, linhaBase({ created_by_user_id: valor }));
  const antes = JSON.parse(JSON.stringify(tabela.rows));
  assert.equal(codigoDe(() => applyMigrations([CORRETIVA], schema)), null, 'a corretiva não recusa nenhuma linha existente');
  assert.deepEqual(tabela.rows, antes, 'e não altera nenhuma');
  assert.equal(tabela.rows.length, incomuns.length);
});

test('[MIG-EXCL-TXT-10] reaplicar a corretiva depois de aplicada é INOFENSIVO (a coluna já é TEXT: nada muda, nada falha); a original continua não reaplicável (42P07), como antes', () => {
  const uma = applyMigrations([ORIGINAL, CORRETIVA]);
  const duas = applyMigrations([ORIGINAL, CORRETIVA, CORRETIVA]);
  assert.equal(duas.tables.get(TABELA).columns.get('created_by_user_id').type, 'TEXT');
  assert.deepEqual([...duas.tables.get(TABELA).columns.entries()], [...uma.tables.get(TABELA).columns.entries()]);
  assert.deepEqual(duas.tables.get(TABELA).constraints, []);
  assert.equal(codigoDe(() => applyMigrations([ORIGINAL, ORIGINAL])), '42P07');
});

test('[MIG-EXCL-TXT-11] nada no projeto executa esta migration (nem src, nem scripts, nem package.json): aplicar é uma ação humana', () => {
  function * arquivos(dir) {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entrada.name === 'node_modules' || entrada.name === '.git') continue;
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) yield* arquivos(completo);
      else if (/\.(js|mjs|json)$/.test(entrada.name)) yield completo;
    }
  }
  for (const pasta of ['src', 'scripts']) {
    for (const arquivo of arquivos(path.join(REPO_ROOT, pasta))) {
      assert.doesNotMatch(fs.readFileSync(arquivo, 'utf8'), /20261017090000|created_by_text/, arquivo);
    }
  }
  const pacote = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  assert.doesNotMatch(pacote, /20261017090000|db push|migrate/);
});

test('[MIG-EXCL-TXT-12] o supabase/README.md descreve a corretiva como NÃO APLICADA e NÃO VERIFICADA, na ordem certa (depois da original), e diz que a tabela ausente continua identificável', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(readme.includes(CORRETIVA), 'o README cita a migration');
  const trecho = readme.slice(readme.indexOf(CORRETIVA));
  assert.match(trecho.slice(0, 1400), /NÃO APLICADA/);
  assert.match(trecho.slice(0, 1400), /NÃO VERIFICAD/);
  assert.match(readme, /depois da `20260930090000_prospecting_permanent_exclusions\.sql`/);
  assert.match(readme, /relation .* does not exist|a tabela não existe|42P01/i, 'o erro de tabela ausente está descrito');
  // o README descreve a corretiva como SÓ a mudança de tipo — sem restrição nem regra nova de banco
  const secao = readme.slice(readme.indexOf('### A migration corretiva das Exclusões Permanentes'), readme.indexOf('## Código dos adaptadores'));
  assert.ok(secao.length > 500, 'a seção da corretiva existe');
  assert.match(secao, /só o tipo|apenas o tipo|somente o tipo/i);
  const RESTRICAO = /ADD CONSTRAINT|CHECK\b|restrição de "?não vazio"?|acrescenta a restrição/i;
  assert.doesNotMatch(secao, RESTRICAO, 'a restrição descartada não é mais descrita como parte da corretiva');
  assert.doesNotMatch(trecho.slice(0, 1400), RESTRICAO);
  assert.match(secao, /não cria nenhuma restrição nem regra nova de banco/i, 'e o README diz expressamente que não há regra nova');
});
