// Testes ESTRUTURAIS/ESTÁTICOS da migration de Funis configuráveis (reestruturação Prospecção/CRM/Funis, Etapa
// "Funis 1") — SEM banco, sem rede, sem Supabase. Só leem o texto de
// supabase/migrations/20260928220000_crm_funnels.sql. Não executam nenhum SQL: a migration continua NÃO
// APLICADA (mesmo espírito de tests/db/crmMigration.test.js e tests/db/crmDeleteAuditMigration.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MIGRATION_FILE = path.join(REPO_ROOT, 'supabase', 'migrations', '20260928220000_crm_funnels.sql');
const SQL = fs.readFileSync(MIGRATION_FILE, 'utf8');
const EXECUTAVEL = SQL.replace(/--[^\n]*/g, '');

test('[MIG-FUN-1] o arquivo existe, segue a convenção de nome do CLI do Supabase, e não está vazio', () => {
  assert.ok(fs.existsSync(MIGRATION_FILE));
  assert.match(path.basename(MIGRATION_FILE), /^\d{14}_[a-z0-9_]+\.sql$/);
  assert.ok(SQL.length > 500);
});

test('[MIG-FUN-2] existem as 4 tabelas do schema completo: crm_funnels, crm_funnel_stages, crm_funnel_cards, crm_funnel_card_moves', () => {
  for (const tabela of ['crm_funnels', 'crm_funnel_stages', 'crm_funnel_cards', 'crm_funnel_card_moves']) {
    assert.match(SQL, new RegExp(`CREATE TABLE public\\.${tabela} `), tabela);
  }
});

test('[MIG-FUN-3] crm_funnels e crm_funnel_stages têm as colunas mínimas exigidas (nome, ordem, ativo, config JSONB)', () => {
  assert.match(SQL, /nome\s+TEXT NOT NULL CHECK \(btrim\(nome\) <> ''\)/);
  assert.match(SQL, /ativo\s+BOOLEAN NOT NULL DEFAULT true/);
  assert.match(SQL, /ordem\s+INTEGER NOT NULL DEFAULT 0/);
  const configs = SQL.match(/config\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb CHECK \(jsonb_typeof\(config\) = 'object'\)/g) || [];
  assert.equal(configs.length, 2, 'crm_funnels e crm_funnel_stages têm, cada um, uma coluna config JSONB');
});

test('[MIG-FUN-4] crm_funnel_stages referencia crm_funnels (funnel_id) — a ÚNICA foreign key desta migration', () => {
  assert.match(SQL, /funnel_id\s+TEXT NOT NULL REFERENCES public\.crm_funnels \(id\)/);
});

test('[MIG-FUN-5] crm_funnel_cards vincula funil + etapa + registro do CRM, com UNIQUE (funnel_id, crm_record_id) — nunca dois cards ativos do mesmo registro no MESMO funil', () => {
  assert.match(SQL, /crm_record_id\s+TEXT NOT NULL REFERENCES public\.crm_records \(id\)/);
  assert.match(SQL, /UNIQUE \(funnel_id, crm_record_id\)/);
});

test('[MIG-FUN-6] PERDIDO (seção 20): crm_funnel_cards tem perdido_em e motivo_perdido — nunca apaga o card, só marca', () => {
  assert.match(SQL, /perdido_em\s+TIMESTAMPTZ/);
  assert.match(SQL, /motivo_perdido\s+TEXT CHECK \(motivo_perdido IS NULL OR btrim\(motivo_perdido\) <> ''\)/);
});

test('[MIG-FUN-7] crm_funnel_card_moves registra a movimentação completa: etapa anterior (nullable), nova etapa, quem (ator) e quando', () => {
  assert.match(SQL, /stage_from\s+TEXT REFERENCES public\.crm_funnel_stages \(id\)/);
  assert.doesNotMatch(SQL, /stage_from\s+TEXT REFERENCES public\.crm_funnel_stages \(id\) NOT NULL/, 'stage_from é opcional — NULL na primeira vinculação');
  assert.match(SQL, /stage_to\s+TEXT NOT NULL REFERENCES public\.crm_funnel_stages \(id\)/);
  for (const coluna of ['moved_by_user_id', 'moved_by_name', 'moved_by_role']) {
    assert.match(SQL, new RegExp(`${coluna}\\s+TEXT NOT NULL CHECK \\(btrim\\(${coluna}\\) <> ''\\)`), coluna);
  }
  assert.match(SQL, /moved_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
});

test('[MIG-FUN-8] RLS LIGADA nas 4 tabelas, e NENHUMA policy foi criada (mesmo padrão D1/D2 de crm_records)', () => {
  const alters = SQL.match(/ALTER TABLE public\.crm_funnel\w* ENABLE ROW LEVEL SECURITY;/g) || [];
  assert.equal(alters.length, 4);
  assert.doesNotMatch(SQL, /CREATE POLICY/i);
  assert.doesNotMatch(SQL, /USING\s*\(\s*true\s*\)/i);
});

test('[MIG-FUN-9] existem as duas funções de exclusão COM GUARDA (funil e etapa), cada uma verificando cards ANTES de apagar', () => {
  for (const fn of ['delete_crm_funnel_if_empty', 'delete_crm_funnel_stage_if_empty']) {
    const bloco = new RegExp(`CREATE FUNCTION public\\.${fn}\\([\\s\\S]*?\\$\\$;`).exec(SQL);
    assert.ok(bloco, `função ${fn} não encontrada no formato esperado`);
    const existsIdx = bloco[0].indexOf('IF EXISTS');
    const deleteIdx = bloco[0].indexOf('DELETE FROM');
    assert.ok(existsIdx >= 0 && deleteIdx >= 0 && existsIdx < deleteIdx, `${fn}: a checagem de cards precisa vir ANTES do DELETE`);
  }
});

test('[MIG-FUN-10] as duas funções de exclusão são SECURITY INVOKER (nunca DEFINER, fora de comentário), com EXECUTE revogado de PUBLIC e concedido só a service_role', () => {
  for (const fn of ['delete_crm_funnel_if_empty', 'delete_crm_funnel_stage_if_empty']) {
    assert.match(SQL, new RegExp(`CREATE FUNCTION public\\.${fn}\\([\\s\\S]*?SECURITY INVOKER`));
    assert.match(SQL, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(TEXT\\) FROM PUBLIC;`));
    assert.match(SQL, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(TEXT\\) TO service_role;`));
  }
  assert.doesNotMatch(EXECUTAVEL, /SECURITY DEFINER/i);
});

test('[MIG-FUN-11] esta migration NÃO toca em crm_records nem em crm_record_deletions (nenhum ALTER TABLE, nenhum trigger novo lá) — a máquina de estados de status existente não é alterada', () => {
  assert.doesNotMatch(EXECUTAVEL, /ALTER TABLE public\.crm_records\b/);
  assert.doesNotMatch(EXECUTAVEL, /ALTER TABLE public\.crm_record_deletions\b/);
});

test('[MIG-FUN-12] nenhuma coluna, tipo ou GRANT lida com senha/token/segredo; e o único GRANT é o EXECUTE das duas funções, para service_role', () => {
  assert.doesNotMatch(EXECUTAVEL, /\b(password|senha|token|secret|segredo)\b/i);
  const grants = EXECUTAVEL.match(/\bGRANT\b[^;]*;/gi) || [];
  assert.equal(grants.length, 2);
  assert.ok(grants.every((g) => /TO service_role/.test(g)));
});

test('[MIG-FUN-13] nada perigoso FORA DE COMENTÁRIOS: sem DROP, sem TRUNCATE, sem SQL dinâmico, sem policy, nenhuma referência a auth.* nem a tabelas de usuário', () => {
  assert.doesNotMatch(EXECUTAVEL, /\bDROP\s+(TABLE|SCHEMA|DATABASE|FUNCTION)\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\bTRUNCATE\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\bEXECUTE\s+format\(/i);
  assert.doesNotMatch(EXECUTAVEL, /\bCREATE POLICY\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\bauth\.\w+/i);
  assert.doesNotMatch(EXECUTAVEL, /\busers\b/i);
});

test('[MIG-FUN-14] o arquivo SQL é sintaticamente equilibrado (parênteses, aspas simples e blocos $$ fechados)', () => {
  const abre = (EXECUTAVEL.match(/\(/g) || []).length;
  const fecha = (EXECUTAVEL.match(/\)/g) || []).length;
  assert.equal(abre, fecha, `parênteses desbalanceados: ${abre} abrindo, ${fecha} fechando`);
  const aspas = (EXECUTAVEL.match(/(?<!')'(?!')/g) || []).length;
  assert.equal(aspas % 2, 0, 'aspas simples em número ímpar');
  const dollarBlocks = (EXECUTAVEL.match(/\$\$/g) || []).length;
  assert.equal(dollarBlocks % 2, 0, 'bloco $$ ... $$ não fechado');
});

test('[MIG-FUN-15] a migration NÃO é executada por nenhum script do projeto — aplicar é sempre uma ação humana', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const script of Object.values(pkg.scripts || {})) {
    assert.doesNotMatch(script, /crm_funnels|crm_funnel_stages|crm_funnel_cards/i, script);
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

test('[MIG-FUN-16] a fábrica de composição (src/server/index.js) só usa o adapter de ARQUIVO para Funis nesta etapa — nenhum código de produção fala com estas tabelas ainda', () => {
  const index = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', 'index.js'), 'utf8');
  assert.match(index, /createFileBackedFunnelService/);
  assert.doesNotMatch(index, /crm_funnels|crm_funnel_stages|crm_funnel_cards/);
});
