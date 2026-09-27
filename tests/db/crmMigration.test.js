// Testes ESTRUTURAIS/ESTÁTICOS da migration proposta do CRM (decisão 0024) — SEM banco, sem rede, sem Supabase.
// Só leem o texto de supabase/migrations/20260927120000_crm_initial_schema.sql e o comparam com o contrato REAL
// do domínio (src/crm/constants.js), para que os dois nunca divirjam em silêncio. Não executam nenhum SQL: a
// migration continua NÃO APLICADA (nenhum código do projeto a executa — conferido aqui também).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CRM_WRITABLE_FIELDS, CRM_STATUS } = require('../../src/crm/constants');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const MIGRATION_FILE = path.join(MIGRATIONS_DIR, '20260927120000_crm_initial_schema.sql');
const SQL = fs.readFileSync(MIGRATION_FILE, 'utf8');

// camelCase -> snake_case (a mesma conversão mecânica usada para escrever a migration).
const toSnakeCase = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const NUMERIC_FIELDS = new Set(['valorProposta', 'valorTotal']);

test('[MIG-1] o arquivo existe, segue a convenção de nome do CLI do Supabase, e não está vazio', () => {
  assert.ok(fs.existsSync(MIGRATION_FILE));
  assert.match(path.basename(MIGRATION_FILE), /^\d{14}_[a-z0-9_]+\.sql$/);
  assert.ok(SQL.length > 500);
});

test('[MIG-2] cada um dos 31 CRM_WRITABLE_FIELDS vira UMA coluna snake_case na tabela crm_records — nenhum inventado, nenhum esquecido', () => {
  assert.equal(CRM_WRITABLE_FIELDS.length, 31, 'sanidade: o domínio ainda tem 31 campos graváveis (se mudou, esta migration precisa ser revista)');
  for (const field of CRM_WRITABLE_FIELDS) {
    const column = toSnakeCase(field);
    const re = new RegExp(`^\\s*${column}\\s+(TEXT|NUMERIC)\\b`, 'm');
    assert.match(SQL, re, `coluna ausente ou de tipo inesperado para "${field}" (esperava "${column}")`);
  }
});

test('[MIG-3] os campos numéricos do domínio (valorProposta/valorTotal) são NUMERIC(15,2) com CHECK >= 0 (D-MONEY-SCALE); nenhum outro campo gravável é NUMERIC', () => {
  for (const field of CRM_WRITABLE_FIELDS) {
    const column = toSnakeCase(field);
    const isNumeric = new RegExp(`^\\s*${column}\\s+NUMERIC\\b`, 'm').test(SQL);
    assert.equal(isNumeric, NUMERIC_FIELDS.has(field), `${field} -> ${column}: NUMERIC deveria ser ${NUMERIC_FIELDS.has(field)}`);
  }
  assert.match(SQL, /valor_proposta\s+NUMERIC\(15,2\) CHECK\s*\(valor_proposta IS NULL OR valor_proposta >= 0\)/);
  assert.match(SQL, /valor_total\s+NUMERIC\(15,2\) CHECK\s*\(valor_total IS NULL OR valor_total >= 0\)/);
});

test('[MIG-4] os campos de "data" do domínio (só texto livre, sem validação de formato) NÃO viram coluna DATE/TIMESTAMP', () => {
  for (const field of ['dataDaAnalise', 'dataDaReuniao', 'ultimaInteracao', 'dataDaProximaAcao']) {
    const column = toSnakeCase(field);
    assert.match(SQL, new RegExp(`^\\s*${column}\\s+TEXT\\b`, 'm'), field);
    assert.doesNotMatch(SQL, new RegExp(`^\\s*${column}\\s+(DATE|TIMESTAMP)`, 'm'), field);
  }
});

test('[MIG-5] só "empresa" é NOT NULL entre os 31 campos graváveis — todo o resto é opcional, como no domínio', () => {
  for (const field of CRM_WRITABLE_FIELDS) {
    const column = toSnakeCase(field);
    const linha = new RegExp(`^\\s*${column}\\s+(TEXT|NUMERIC(?:\\([0-9,]+\\))?)[^,]*`, 'm').exec(SQL)[0];
    assert.equal(/NOT NULL/.test(linha), field === 'empresa', `${field}: NOT NULL deveria valer só para empresa`);
  }
});

test('[MIG-6] campos de texto opcionais nunca aceitam string em branco — só NULL ou não-vazio (a mesma regra de trimmedOrNull do domínio)', () => {
  const textuais = CRM_WRITABLE_FIELDS.filter((f) => !NUMERIC_FIELDS.has(f) && f !== 'empresa').map(toSnakeCase);
  assert.ok(textuais.length > 20);
  for (const column of textuais) {
    assert.match(SQL, new RegExp(`CHECK\\s*\\(${column} IS NULL OR btrim\\(${column}\\) <> ''\\)`), column);
  }
  assert.match(SQL, /CHECK\s*\(btrim\(empresa\) <> ''\)/, 'empresa: não-vazia (é NOT NULL, então sem "IS NULL OR")');
});

test('[MIG-7] os 13 status oficiais (CRM_STATUS) aparecem, todos e só eles, no CHECK da coluna status', () => {
  const bloco = /status\s+TEXT NOT NULL DEFAULT 'PROSPECT'\s*\n\s*CHECK \(status IN \(([\s\S]*?)\)\)/.exec(SQL);
  assert.ok(bloco, 'CHECK de status não encontrado no formato esperado');
  const listados = bloco[1].match(/'([A-Z_]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(listados.sort(), Object.values(CRM_STATUS).sort());
  assert.equal(listados.length, 13);
});

test('[MIG-8] os campos GERENCIADOS pelo domínio existem com os tipos escolhidos: id (texto "crm:<uuid>"), status, data_de_entrada (texto), historico (jsonb, array não vazio)', () => {
  assert.match(SQL, /id\s+TEXT PRIMARY KEY\s*\n\s*CHECK \(id ~ '\^crm:\[0-9a-f-\]\{36\}\$'\)/);
  assert.match(SQL, /data_de_entrada\s+TEXT NOT NULL/);
  assert.match(SQL, /historico\s+JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(SQL, /CHECK\s*\(jsonb_typeof\(historico\) = 'array'\)/);
  assert.match(SQL, /CHECK\s*\(jsonb_array_length\(historico\) >= 1\)/);
});

test('[MIG-9] RLS está LIGADA em crm_records, e NENHUMA policy foi criada (D1/D2: só o servidor, com service_role, acessa — sem policy para anon/authenticated nesta versão)', () => {
  assert.match(SQL, /ALTER TABLE public\.crm_records ENABLE ROW LEVEL SECURITY;/);
  assert.doesNotMatch(SQL, /CREATE POLICY/i, 'nenhuma policy para anon/authenticated nesta primeira versão (D2)');
  assert.doesNotMatch(SQL, /USING\s*\(\s*true\s*\)/i, 'nunca uma policy permissiva-por-padrão');
  // só uma ALTER TABLE ... ENABLE ROW LEVEL SECURITY nesta migration (a tabela de identidade foi removida)
  const alters = SQL.match(/ENABLE ROW LEVEL SECURITY/g) || [];
  assert.equal(alters.length, 1);
});

test('[MIG-10] a tabela de identidade/deduplicação (crm_identity_index) foi REMOVIDA desta migration — a dedup continua só em JavaScript', () => {
  assert.doesNotMatch(SQL, /crm_identity_index/, 'a tabela de identidade foi removida por decisão explícita da etapa 1.1');
  assert.doesNotMatch(SQL, /normalized_key/);
  // só existe o trigger de versão nesta migration
  const triggers = SQL.match(/CREATE TRIGGER[\s\S]*?;/g) || [];
  assert.equal(triggers.length, 1, 'deveria existir só o trigger de versão nesta migration');
});

test('[MIG-11] concorrência otimista: version (INTEGER, default 1) e updated_at existem, e o trigger as incrementa em UPDATE — nunca em INSERT', () => {
  assert.match(SQL, /version\s+INTEGER NOT NULL DEFAULT 1/);
  assert.match(SQL, /updated_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(SQL, /CREATE TRIGGER crm_records_bump_version_trigger\s*\n\s*BEFORE UPDATE ON public\.crm_records/);
  assert.match(SQL, /NEW\.version := OLD\.version \+ 1;/);
  assert.doesNotMatch(SQL, /BEFORE INSERT ON public\.crm_records/, 'a versão não deveria ser tocada na criação');
});

test('[MIG-12] nenhuma foreign key existe nesta migration — nem para approval_queue/lotes/dossiês (fora do escopo), nem para a tabela de identidade (removida)', () => {
  const fks = SQL.match(/REFERENCES\s+[a-z_.]+/gi) || [];
  assert.deepEqual(fks, []);
});

test('[MIG-13] nada perigoso FORA DE COMENTÁRIOS: sem DROP, sem GRANT, sem SQL dinâmico, sem segredo (comentários podem mencionar "supabase db push" como instrução para o humano, sem que isso seja um comando embutido)', () => {
  const executavel = SQL.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(executavel, /\bDROP\s+(TABLE|SCHEMA|DATABASE)\b/i);
  assert.doesNotMatch(executavel, /\bGRANT\b/i);
  assert.doesNotMatch(executavel, /\bEXECUTE\s+format\(/i, 'sem SQL dinâmico (mais difícil de auditar por leitura)');
  assert.doesNotMatch(SQL, /eyJ[A-Za-z0-9_-]{20,}|sb_secret_|service_role["'\s]*[:=]\s*['"][^'"]/i);
});

test('[MIG-14] o arquivo SQL é sintaticamente equilibrado (parênteses, aspas simples e blocos $$ fechados) — não prova validade Postgres, só que não há erro grosseiro de digitação', () => {
  const semComentarios = SQL.replace(/--[^\n]*/g, '');
  const abre = (semComentarios.match(/\(/g) || []).length;
  const fecha = (semComentarios.match(/\)/g) || []).length;
  assert.equal(abre, fecha, `parênteses desbalanceados: ${abre} abrindo, ${fecha} fechando`);
  const aspas = (semComentarios.match(/(?<!')'(?!')/g) || []).length;
  assert.equal(aspas % 2, 0, 'aspas simples em número ímpar');
  const dollarBlocks = (semComentarios.match(/\$\$/g) || []).length;
  assert.equal(dollarBlocks % 2, 0, 'bloco $$ ... $$ não fechado');
});

test('[MIG-15] a migration NÃO é executada por nenhum script do projeto (nem em teste, nem em produção) — aplicar é sempre uma ação humana', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const script of Object.values(pkg.scripts || {})) {
    assert.doesNotMatch(script, /supabase|crm_initial_schema|migrations/i, script);
  }
  // nenhum arquivo de src/ ou scripts/ lê o diretório de migrations em tempo de execução
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

test('[MIG-16] README de supabase/ existe, deixa claro que nada foi aplicado, e nomeia a decisão 0024', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'README.md'), 'utf8');
  assert.match(readme, /não aplicad[ao]/i);
  assert.match(readme, /0024/);
});
