// Testes ESTRUTURAIS/ESTÁTICOS da migration de auditoria de exclusão do CRM (decisão 0025) — SEM banco, sem rede,
// sem Supabase. Só leem o texto de supabase/migrations/20260928090000_crm_delete_audit.sql. Não executam nenhum
// SQL: a migration continua NÃO APLICADA (nenhum código do projeto a executa — conferido aqui também, no mesmo
// espírito de tests/db/crmMigration.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const MIGRATION_FILE = path.join(MIGRATIONS_DIR, '20260928090000_crm_delete_audit.sql');
const SQL = fs.readFileSync(MIGRATION_FILE, 'utf8');
const EXECUTAVEL = SQL.replace(/--[^\n]*/g, '');

test('[MIG-DEL-1] o arquivo existe, segue a convenção de nome do CLI do Supabase, e não está vazio', () => {
  assert.ok(fs.existsSync(MIGRATION_FILE));
  assert.match(path.basename(MIGRATION_FILE), /^\d{14}_[a-z0-9_]+\.sql$/);
  assert.ok(SQL.length > 500);
});

test('[MIG-DEL-2] a tabela crm_record_deletions preserva, no mínimo, tudo que a decisão 0025 exige: id próprio, id original, empresa, snapshot COMPLETO, ator (userId/nome/role), motivo e timestamp', () => {
  assert.match(SQL, /CREATE TABLE public\.crm_record_deletions/);
  assert.match(SQL, /id\s+BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
  assert.match(SQL, /crm_record_id\s+TEXT NOT NULL/);
  assert.match(SQL, /empresa\s+TEXT NOT NULL/);
  assert.match(SQL, /record_snapshot\s+JSONB NOT NULL/);
  assert.match(SQL, /deleted_by_user_id\s+TEXT NOT NULL/);
  assert.match(SQL, /deleted_by_name\s+TEXT NOT NULL/);
  assert.match(SQL, /deleted_by_role\s+TEXT NOT NULL/);
  assert.match(SQL, /reason\s+TEXT NOT NULL/);
  assert.match(SQL, /deleted_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  // Revisão 3O.5: não existe mais uma coluna separada para o histórico — ele vive DENTRO de record_snapshot
  // (que agora é o registro COMPLETO, sem nenhuma subtração). Ver MIG-DEL-4 e MIG-DEL-10.
  assert.doesNotMatch(SQL, /record_historico/, 'record_historico foi removida: o histórico agora vem embutido no snapshot completo');
});

test('[MIG-DEL-3] nenhuma coluna de auditoria (exceto crm_record_id, que tem sua própria checagem de formato — MIG-DEL-4) aceita vazio: todo TEXT NOT NULL tem um CHECK btrim(...) <> \'\' (o motivo nunca é opcional aqui)', () => {
  for (const column of ['empresa', 'deleted_by_user_id', 'deleted_by_name', 'deleted_by_role', 'reason']) {
    assert.match(SQL, new RegExp(`CHECK\\s*\\(btrim\\(${column}\\) <> ''\\)`), column);
  }
});

test('[MIG-DEL-4] crm_record_id segue o mesmo formato "crm:<uuid>" da tabela crm_records, e record_snapshot tem o tipo JSONB certo garantido por CHECK', () => {
  assert.match(SQL, /crm_record_id\s+TEXT NOT NULL\s*\n\s*CHECK \(crm_record_id ~ '\^crm:\[0-9a-f-\]\{36\}\$'\)/);
  assert.match(SQL, /CHECK\s*\(jsonb_typeof\(record_snapshot\) = 'object'\)/);
});

test('[MIG-DEL-5] nenhuma coluna, tipo, GRANT ou valor executável (fora de comentário) desta migration lida com senha/token/segredo', () => {
  assert.doesNotMatch(EXECUTAVEL, /\b(password|senha|token|secret|segredo)\b/i);
});

test('[MIG-DEL-6] RLS está LIGADA em crm_record_deletions, e NENHUMA policy foi criada (mesmo padrão D1/D2 de crm_records: só o servidor, com service_role, acessa)', () => {
  assert.match(SQL, /ALTER TABLE public\.crm_record_deletions ENABLE ROW LEVEL SECURITY;/);
  assert.doesNotMatch(SQL, /CREATE POLICY/i);
  assert.doesNotMatch(SQL, /USING\s*\(\s*true\s*\)/i);
});

test('[MIG-DEL-7] existe UMA função transacional (delete_crm_record_with_audit) que localiza, insere a auditoria e apaga o registro, nessa ordem, dentro do mesmo corpo — nunca dois passos independentes', () => {
  const fn = /CREATE FUNCTION public\.delete_crm_record_with_audit\([\s\S]*?\$\$;/.exec(SQL);
  assert.ok(fn, 'função delete_crm_record_with_audit não encontrada no formato esperado');
  const body = fn[0];
  const selectIdx = body.indexOf('SELECT * INTO v_row FROM public.crm_records');
  const insertIdx = body.indexOf('INSERT INTO public.crm_record_deletions');
  const deleteIdx = body.indexOf('DELETE FROM public.crm_records');
  assert.ok(selectIdx >= 0 && insertIdx >= 0 && deleteIdx >= 0, 'a função precisa localizar, inserir a auditoria e apagar');
  assert.ok(selectIdx < insertIdx && insertIdx < deleteIdx, 'ordem esperada: localizar -> auditar -> apagar');
  // só esta função no arquivo inteiro faz DELETE em crm_records — nenhum outro caminho de exclusão nesta migration.
  const deletesEmCrmRecords = (SQL.match(/DELETE FROM public\.crm_records/g) || []).length;
  assert.equal(deletesEmCrmRecords, 1);
});

test('[MIG-DEL-8] a função trava a linha (FOR UPDATE) antes de apagar, e lança (RAISE EXCEPTION) se o registro já não existir — nunca segue em frente silenciosamente', () => {
  assert.match(SQL, /SELECT \* INTO v_row FROM public\.crm_records WHERE id = p_id FOR UPDATE;/);
  assert.match(SQL, /IF NOT FOUND THEN\s*\n[\s\S]*?RAISE EXCEPTION[\s\S]*?USING ERRCODE = 'P0002';/);
});

test('[MIG-DEL-9] a função valida id, ator (userId/nome/role) e motivo ANTES de tocar em qualquer tabela — nunca confia no chamador, mesmo sendo só service_role quem chama', () => {
  const fn = /CREATE FUNCTION public\.delete_crm_record_with_audit\([\s\S]*?\$\$;/.exec(SQL)[0];
  const firstTouch = Math.min(
    ...['SELECT * INTO v_row', 'INSERT INTO public.crm_record_deletions', 'DELETE FROM public.crm_records'].map((s) => fn.indexOf(s)).filter((i) => i >= 0)
  );
  const raises = [...fn.matchAll(/RAISE EXCEPTION[^;]*USING ERRCODE = '22023';/g)];
  assert.ok(raises.length >= 3, 'esperava pelo menos 3 validações de entrada (id, ator, motivo) com ERRCODE 22023');
  for (const raise of raises) assert.ok(fn.indexOf(raise[0]) < firstTouch, 'toda validação de entrada deve vir antes de tocar em crm_records/crm_record_deletions');
});

test('[MIG-DEL-10] SNAPSHOT COMPLETO (correção 3O.5): record_snapshot é gravado como to_jsonb(v_row) SEM nenhuma subtração de campo — historico, seq, version e updated_at continuam no snapshot, cada um garantido por um CHECK próprio na tabela; nada é removido, e nunca há senha/token', () => {
  // A função grava o registro INTEIRO — nenhum operador `-` (remoção de chave JSONB) depois de to_jsonb(v_row).
  assert.match(SQL, /v_snapshot := to_jsonb\(v_row\);/);
  assert.doesNotMatch(SQL, /to_jsonb\(v_row\)\s*-\s*'/, 'nenhuma chave é subtraída do snapshot — ele precisa ser o registro completo');
  // As três garantias explícitas, no nível do BANCO, de que o snapshot preserva historico/version/updated_at.
  assert.match(SQL, /CHECK\s*\(record_snapshot\s*\?\s*'historico'\)/);
  assert.match(SQL, /CHECK\s*\(record_snapshot\s*\?\s*'version'\)/);
  assert.match(SQL, /CHECK\s*\(record_snapshot\s*\?\s*'updated_at'\)/);
  // Sanidade: nenhuma chave de segredo (o registro do CRM nunca teve — CRM_WRITABLE_FIELDS não inclui nenhuma).
  assert.doesNotMatch(EXECUTAVEL, /\b(password|senha|token|secret|segredo)\b/i);
});

test('[MIG-DEL-11] a função é SECURITY INVOKER explícito (nunca SECURITY DEFINER FORA de comentário — o único chamador, service_role, já ignora RLS; SECURITY DEFINER seria um risco de escalonamento sem necessidade)', () => {
  assert.match(SQL, /CREATE FUNCTION public\.delete_crm_record_with_audit[\s\S]*?SECURITY INVOKER/);
  assert.doesNotMatch(EXECUTAVEL, /SECURITY DEFINER/i);
});

test('[MIG-DEL-12] EXECUTE na função é revogado de PUBLIC e concedido só a service_role — sem isto, o Postgres concederia EXECUTE a PUBLIC por padrão, expondo o RPC destrutivo a anon/authenticated via PostgREST', () => {
  assert.match(SQL, /REVOKE ALL ON FUNCTION public\.delete_crm_record_with_audit\([^)]*\) FROM PUBLIC;/);
  assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.delete_crm_record_with_audit\([^)]*\) TO service_role;/);
  const revokeIdx = SQL.indexOf('REVOKE ALL ON FUNCTION public.delete_crm_record_with_audit');
  const grantIdx = SQL.indexOf('GRANT EXECUTE ON FUNCTION public.delete_crm_record_with_audit');
  assert.ok(revokeIdx >= 0 && grantIdx > revokeIdx, 'REVOKE deve vir antes do GRANT');
});

test('[MIG-DEL-13] nenhuma foreign key existe nesta migration (o registro do CRM já deixou de existir quando a linha de auditoria nasce)', () => {
  const fks = SQL.match(/REFERENCES\s+[a-z_.]+/gi) || [];
  assert.deepEqual(fks, []);
});

test('[MIG-DEL-14] nada perigoso FORA DE COMENTÁRIOS: sem DROP, sem SQL dinâmico, sem segredo; o único GRANT é o EXECUTE explícito da função, para service_role', () => {
  assert.doesNotMatch(EXECUTAVEL, /\bDROP\s+(TABLE|SCHEMA|DATABASE|FUNCTION)\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\bEXECUTE\s+format\(/i, 'sem SQL dinâmico (mais difícil de auditar por leitura)');
  assert.doesNotMatch(SQL, /eyJ[A-Za-z0-9_-]{20,}|sb_secret_|service_role["'\s]*[:=]\s*['"][^'"]/i);
  const grants = EXECUTAVEL.match(/\bGRANT\b[^;]*;/gi) || [];
  assert.equal(grants.length, 1);
  assert.match(grants[0], /GRANT EXECUTE ON FUNCTION public\.delete_crm_record_with_audit/);
});

test('[MIG-DEL-15] o arquivo SQL é sintaticamente equilibrado (parênteses, aspas simples e blocos $$ fechados) — não prova validade Postgres, só que não há erro grosseiro de digitação', () => {
  const abre = (EXECUTAVEL.match(/\(/g) || []).length;
  const fecha = (EXECUTAVEL.match(/\)/g) || []).length;
  assert.equal(abre, fecha, `parênteses desbalanceados: ${abre} abrindo, ${fecha} fechando`);
  const aspas = (EXECUTAVEL.match(/(?<!')'(?!')/g) || []).length;
  assert.equal(aspas % 2, 0, 'aspas simples em número ímpar');
  const dollarBlocks = (EXECUTAVEL.match(/\$\$/g) || []).length;
  assert.equal(dollarBlocks % 2, 0, 'bloco $$ ... $$ não fechado');
});

test('[MIG-DEL-16] a migration NÃO é executada por nenhum script do projeto (nem em teste, nem em produção) — aplicar é sempre uma ação humana', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const script of Object.values(pkg.scripts || {})) {
    assert.doesNotMatch(script, /supabase|crm_delete_audit|delete_crm_record_with_audit|migrations/i, script);
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

test('[MIG-DEL-17] a única chamada do adapter Supabase a este RPC usa o mesmo nome de função desta migration', () => {
  const adapter = fs.readFileSync(path.join(REPO_ROOT, 'src', 'crm-adapters', 'crmSupabaseRepository.js'), 'utf8');
  assert.match(SQL, /CREATE FUNCTION public\.delete_crm_record_with_audit/);
  assert.match(adapter, /delete_crm_record_with_audit/);
});
