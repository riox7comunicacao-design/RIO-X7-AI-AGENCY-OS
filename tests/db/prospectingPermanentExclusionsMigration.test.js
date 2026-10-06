// Testes ESTRUTURAIS/ESTÁTICOS da migration de Exclusões Permanentes de Prospecção (Workbench, Etapa 2) — SEM
// banco, sem rede, sem Supabase. Só leem o texto de
// supabase/migrations/20260930090000_prospecting_permanent_exclusions.sql. Não executam nenhum SQL: a migration
// continua NÃO APLICADA. Mesmo espírito de tests/db/crmFunnelsMigration.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MIGRATION_FILE = path.join(REPO_ROOT, 'supabase', 'migrations', '20260930090000_prospecting_permanent_exclusions.sql');
const SQL = fs.readFileSync(MIGRATION_FILE, 'utf8');
const EXECUTAVEL = SQL.replace(/--[^\n]*/g, '');

test('[MIG-EXCL-1] o arquivo existe, segue a convenção de nome do CLI do Supabase, e não está vazio', () => {
  assert.ok(fs.existsSync(MIGRATION_FILE));
  assert.match(path.basename(MIGRATION_FILE), /^\d{14}_[a-z0-9_]+\.sql$/);
  assert.ok(SQL.length > 300);
});

test('[MIG-EXCL-2] cria a tabela prospecting_permanent_exclusions com os campos mínimos exigidos', () => {
  assert.match(EXECUTAVEL, /CREATE TABLE public\.prospecting_permanent_exclusions/);
  for (const coluna of [
    'id\\s+UUID PRIMARY KEY',
    'empresa_nome\\s+TEXT NOT NULL',
    'empresa_nome_normalizado\\s+TEXT NOT NULL',
    'cidade\\s+TEXT',
    'estado\\s+TEXT',
    "pais\\s+TEXT NOT NULL DEFAULT 'Brasil'",
    'dominio\\s+TEXT',
    'motivo\\s+TEXT NOT NULL',
    'ativo\\s+BOOLEAN NOT NULL DEFAULT TRUE',
    'created_at\\s+TIMESTAMPTZ NOT NULL DEFAULT now\\(\\)',
    'updated_at\\s+TIMESTAMPTZ NOT NULL DEFAULT now\\(\\)',
    'created_by_user_id\\s+UUID',
    'created_by_name\\s+TEXT',
  ]) {
    assert.match(EXECUTAVEL, new RegExp(coluna), coluna);
  }
});

test('[MIG-EXCL-3] índices adequados para a consulta de exclusão: nome normalizado e domínio, só entre os ATIVOS', () => {
  assert.match(EXECUTAVEL, /CREATE INDEX prospecting_permanent_exclusions_nome_norm_idx\s*\n\s*ON public\.prospecting_permanent_exclusions \(empresa_nome_normalizado\)\s*\n\s*WHERE ativo;/);
  assert.match(
    EXECUTAVEL,
    /CREATE INDEX prospecting_permanent_exclusions_dominio_idx\s*\n\s*ON public\.prospecting_permanent_exclusions \(dominio\)\s*\n\s*WHERE ativo AND dominio IS NOT NULL;/
  );
});

test('[MIG-EXCL-4] RLS ligado, sem nenhuma policy (mesmo padrão de todas as tabelas do CRM/Funis — só service_role acessa)', () => {
  assert.match(EXECUTAVEL, /ALTER TABLE public\.prospecting_permanent_exclusions ENABLE ROW LEVEL SECURITY;/);
  assert.doesNotMatch(EXECUTAVEL, /CREATE POLICY/i);
});

test('[MIG-EXCL-5] updated_at automático por uma função/trigger PRÓPRIA desta tabela — nunca reaproveita uma função de outra migration ainda não aplicada', () => {
  assert.match(EXECUTAVEL, /CREATE FUNCTION public\.prospecting_permanent_exclusions_bump_updated_at\(\)/);
  assert.match(EXECUTAVEL, /CREATE TRIGGER prospecting_permanent_exclusions_bump_updated_at_trigger/);
  assert.doesNotMatch(EXECUTAVEL, /crm_funnels_bump_updated_at/);
});

test('[MIG-EXCL-6] nenhum DELETE físico é possível a partir desta migration: nenhuma função de exclusão, nenhum DROP TABLE, nenhum TRUNCATE', () => {
  assert.doesNotMatch(EXECUTAVEL, /\bDELETE FROM\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\bDROP TABLE\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\bTRUNCATE\b/i);
});

test('[MIG-EXCL-7] NENHUM dado de negócio é inserido (nem "Força Digital", nem qualquer outro registro) — o cadastro inicial é feito pelo painel ADMIN, não pela migration; "Força Digital" só aparece em COMENTÁRIO, como exemplo', () => {
  assert.doesNotMatch(EXECUTAVEL, /\bINSERT INTO\b/i);
  assert.doesNotMatch(EXECUTAVEL, /força digital/i, 'fora de comentários, nem como exemplo');
});

test('[MIG-EXCL-8] esta migration NÃO toca em nenhuma tabela já existente (crm_records, crm_funnels, crm_funnel_cards, crm_funnel_stages, crm_record_deletions) — é uma tabela nova e independente', () => {
  assert.doesNotMatch(EXECUTAVEL, /ALTER TABLE public\.crm_/);
  for (const tabela of ['crm_records', 'crm_funnels', 'crm_funnel_cards', 'crm_funnel_stages', 'crm_record_deletions']) {
    assert.doesNotMatch(EXECUTAVEL, new RegExp(`CREATE TABLE public\\.${tabela}\\b`));
  }
});

test('[MIG-EXCL-9] nada perigoso fora de comentários: sem GRANT amplo, sem segredo, sem SQL dinâmico', () => {
  assert.doesNotMatch(EXECUTAVEL, /GRANT ALL/i);
  assert.doesNotMatch(EXECUTAVEL, /service_role.{0,20}key/i);
  assert.doesNotMatch(EXECUTAVEL, /EXECUTE\s+'/i);
});

test('[MIG-EXCL-10] este arquivo nunca é executado por nenhum script do projeto (só o CLI do Supabase, manualmente)', () => {
  const raiz = REPO_ROOT;
  function * arquivosJs(dir) {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entrada.name === 'node_modules' || entrada.name === '.git') continue;
      const full = path.join(dir, entrada.name);
      if (entrada.isDirectory()) yield* arquivosJs(full);
      else if (entrada.name.endsWith('.js') || entrada.name.endsWith('.mjs')) yield full;
    }
  }
  for (const arquivo of arquivosJs(path.join(raiz, 'src'))) {
    const conteudo = fs.readFileSync(arquivo, 'utf8');
    assert.doesNotMatch(conteudo, /20260930090000_prospecting_permanent_exclusions/, arquivo);
  }
});
