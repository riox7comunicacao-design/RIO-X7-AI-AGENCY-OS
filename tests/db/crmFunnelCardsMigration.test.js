// Testes ESTRUTURAIS/ESTÁTICOS da migration complementar de Cards (reestruturação Prospecção/CRM/Funis, Etapa
// "Funis 2") — SEM banco, sem rede, sem Supabase. Só leem o texto de
// supabase/migrations/20260929100000_crm_funnel_cards_funis2.sql. Não executam nenhum SQL: a migration continua
// NÃO APLICADA. Mesmo espírito de tests/db/crmFunnelsMigration.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MIGRATION_FILE = path.join(REPO_ROOT, 'supabase', 'migrations', '20260929100000_crm_funnel_cards_funis2.sql');
const SQL = fs.readFileSync(MIGRATION_FILE, 'utf8');
const EXECUTAVEL = SQL.replace(/--[^\n]*/g, '');
const ANTERIOR = fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', '20260928220000_crm_funnels.sql'), 'utf8');

test('[MIG-CARD-1] o arquivo existe, segue a convenção de nome do CLI do Supabase, e não está vazio', () => {
  assert.ok(fs.existsSync(MIGRATION_FILE));
  assert.match(path.basename(MIGRATION_FILE), /^\d{14}_[a-z0-9_]+\.sql$/);
  assert.ok(SQL.length > 300);
});

test('[MIG-CARD-2] esta migration é POSTERIOR à de Funis 1 (timestamp maior) e não a repete (nenhum CREATE TABLE crm_funnel_cards/crm_funnel_card_moves aqui — só ALTER TABLE)', () => {
  const tsAnterior = path.basename(ANTERIOR ? path.join(REPO_ROOT, 'supabase', 'migrations', '20260928220000_crm_funnels.sql') : '').match(/^\d{14}/);
  const tsEsta = path.basename(MIGRATION_FILE).match(/^\d{14}/);
  assert.ok(Number(tsEsta[0]) > Number('20260928220000'));
  assert.doesNotMatch(EXECUTAVEL, /CREATE TABLE public\.crm_funnel_cards\b/);
  assert.doesNotMatch(EXECUTAVEL, /CREATE TABLE public\.crm_funnel_card_moves\b/);
});

test('[MIG-CARD-3] adiciona removed_at (nullable) em crm_funnel_cards — arquivamento, nunca exclusão física', () => {
  assert.match(SQL, /ALTER TABLE public\.crm_funnel_cards ADD COLUMN removed_at TIMESTAMPTZ;/);
});

test('[MIG-CARD-4] substitui a UNIQUE simples (funnel_id, crm_record_id) por um índice único PARCIAL (só WHERE removed_at IS NULL) — permite recriar um card depois de arquivar o anterior', () => {
  assert.match(SQL, /DROP CONSTRAINT crm_funnel_cards_funnel_id_crm_record_id_key;/);
  assert.match(SQL, /CREATE UNIQUE INDEX crm_funnel_cards_active_unique_idx\s*\n\s*ON public\.crm_funnel_cards \(funnel_id, crm_record_id\)\s*\n\s*WHERE removed_at IS NULL;/);
});

test('[MIG-CARD-5] adiciona motivo (opcional, nunca em branco quando presente) em crm_funnel_card_moves', () => {
  assert.match(SQL, /ALTER TABLE public\.crm_funnel_card_moves ADD COLUMN motivo TEXT CHECK \(motivo IS NULL OR btrim\(motivo\) <> ''\);/);
});

test('[MIG-CARD-6] esta migration NÃO toca em crm_records, crm_record_deletions, crm_funnels nem crm_funnel_stages — só as duas tabelas de card', () => {
  for (const tabela of ['crm_records', 'crm_record_deletions', 'crm_funnels', 'crm_funnel_stages']) {
    assert.doesNotMatch(EXECUTAVEL, new RegExp(`ALTER TABLE public\\.${tabela}\\b`));
  }
});

test('[MIG-CARD-7] nada perigoso FORA DE COMENTÁRIOS: sem DROP TABLE, sem TRUNCATE, sem SQL dinâmico, sem policy, sem GRANT, sem segredo', () => {
  assert.doesNotMatch(EXECUTAVEL, /\bDROP\s+(TABLE|SCHEMA|DATABASE|FUNCTION)\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\bTRUNCATE\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\bEXECUTE\s+format\(/i);
  assert.doesNotMatch(EXECUTAVEL, /\bCREATE POLICY\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\bGRANT\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\b(password|senha|token|secret|segredo)\b/i);
});

test('[MIG-CARD-8] o arquivo SQL é sintaticamente equilibrado (parênteses e aspas simples)', () => {
  const abre = (EXECUTAVEL.match(/\(/g) || []).length;
  const fecha = (EXECUTAVEL.match(/\)/g) || []).length;
  assert.equal(abre, fecha, `parênteses desbalanceados: ${abre} abrindo, ${fecha} fechando`);
  const aspas = (EXECUTAVEL.match(/(?<!')'(?!')/g) || []).length;
  assert.equal(aspas % 2, 0, 'aspas simples em número ímpar');
});

test('[MIG-CARD-9] a migration NÃO é executada por nenhum script do projeto — aplicar é sempre uma ação humana', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const script of Object.values(pkg.scripts || {})) {
    assert.doesNotMatch(script, /crm_funnel_cards_funis2/i, script);
  }
  const buscar = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { buscar(full); continue; }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      const conteudo = fs.readFileSync(full, 'utf8');
      assert.doesNotMatch(conteudo, /supabase[/\\]migrations/, full);
    }
  };
  buscar(path.join(REPO_ROOT, 'src'));
  buscar(path.join(REPO_ROOT, 'scripts'));
});
