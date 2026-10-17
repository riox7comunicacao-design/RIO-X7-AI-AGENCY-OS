// Testes ESTRUTURAIS/ESTÁTICOS da migration dos catálogos do CRM (CRM 5.0, Fase 2B-1 — decisão 0026) — SEM banco, sem rede, sem Supabase. Só
// leem o texto de supabase/migrations/20261012090000_crm_catalogs.sql e o CRUZAM com o código (as colunas do adapter, a paleta, as listas
// fechadas, os limites e o nome do RPC): se um lado mudar sem o outro, estes testes falham. Não executam nenhum SQL — a migration
// continua NÃO APLICADA, e um teste confere que nada no projeto a executa.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CATALOG_TABLES, COMMON_COLUMNS, REORDER_RPC } = require('../../src/crm-adapters/crmSupabaseCatalogRepository');
const { CATALOG_DEFINITIONS, CATALOG_KEYS, NICHE_COLOR_KEYS, LEAD_CHANNELS, BILLING_TYPES, RECURRENCES, LIMITS } = require('../../src/crm/catalogConstants');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const MIGRATION_FILE = path.join(MIGRATIONS_DIR, '20261012090000_crm_catalogs.sql');
const SQL = fs.readFileSync(MIGRATION_FILE, 'utf8').replace(/\r\n/g, '\n');
const EXECUTAVEL = SQL.replace(/--[^\n]*/g, ''); // sem os comentários

const MODALITY_COLUMNS = ['permite_pagamento_unico', 'permite_pagamento_recorrente', 'periodicidades'];
const TABELAS = Object.fromEntries(CATALOG_KEYS.map((key) => [key, CATALOG_DEFINITIONS[key].table]));

// O corpo de cada CREATE TABLE: { nome: texto entre parênteses }.
function corposDasTabelas() {
  const corpos = {};
  for (const match of EXECUTAVEL.matchAll(/CREATE TABLE public\.(\w+) \(([\s\S]*?)\n\);/g)) corpos[match[1]] = match[2];
  return corpos;
}
const CORPOS = corposDasTabelas();
const colunasDe = (corpo) => [...corpo.matchAll(/^  ([a-z_]+)\s+(?:TEXT|BOOLEAN|INTEGER|NUMERIC|TIMESTAMPTZ)\b/gm)].map((m) => m[1]);
const listaDe = (texto) => [...texto.matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('[MIG-CAT-1] o arquivo existe, segue a convenção de nome do CLI do Supabase, vem DEPOIS das outras migrations e se declara expressamente NÃO APLICADA', () => {
  assert.ok(fs.existsSync(MIGRATION_FILE));
  assert.match(path.basename(MIGRATION_FILE), /^\d{14}_[a-z0-9_]+\.sql$/);
  const todas = fs.readdirSync(MIGRATIONS_DIR).filter((nome) => nome.endsWith('.sql')).sort();
  // Era "a mais nova" até a Fase 2B-3.2B-H2, que acrescentou uma migration CORRETIVA posterior (created_by_user_id das Exclusões): o que
  // importa continua valendo — as cinco migrations anteriores, e só elas, vêm antes desta.
  assert.equal(todas.indexOf(path.basename(MIGRATION_FILE)), 5, 'exatamente as cinco migrations anteriores vêm antes');
  // Depois dela, só três, nesta ordem: a corretiva das Exclusões Permanentes (H2), a das modalidades de pagamento dos Serviços (C1, que ACRESCENTA colunas a crm_services sem editar esta) e a das Negociações (D1.1, que só REFERENCIA crm_services).
  assert.deepEqual(todas.slice(6), ['20261017090000_prospecting_permanent_exclusions_created_by_text.sql', '20261018090000_crm_services_payment_modalities.sql', '20261019090000_crm_negotiations.sql'], 'as únicas posteriores: H2 (Exclusões), C1 (modalidades dos Serviços) e D1.1 (Negociações)');
  assert.match(SQL.split('\n').slice(0, 14).join('\n'), /NÃO APLICADA\./, 'o cabeçalho diz que NÃO foi aplicada');
  assert.match(SQL, /decisão 0026/);
  assert.match(SQL, /Aplicar é uma ação humana e consciente do proprietário/i);
});

test('[MIG-CAT-2] cria EXATAMENTE as três tabelas aprovadas (crm_services, crm_niches, crm_lead_origins) — nenhuma outra — com os mesmos nomes que o domínio e o adapter usam', () => {
  assert.deepEqual(Object.keys(CORPOS).sort(), ['crm_lead_origins', 'crm_niches', 'crm_services']);
  assert.deepEqual(TABELAS, { servicos: 'crm_services', nichos: 'crm_niches', origens: 'crm_lead_origins' });
  for (const key of CATALOG_KEYS) assert.equal(CATALOG_TABLES[key].table, TABELAS[key], `${key}: a tabela do adapter é a da migration`);
  assert.equal((EXECUTAVEL.match(/CREATE TABLE/g) || []).length, 3);
});

test('[MIG-CAT-3] as COLUNAS de cada tabela são exatamente as que o adapter lê e grava: os campos comuns (12) mais os específicos de cada catálogo — nenhuma a mais, nenhuma a menos', () => {
  const comuns = Object.values(COMMON_COLUMNS);
  assert.equal(comuns.length, 12);
  for (const key of CATALOG_KEYS) {
    // As colunas das modalidades de pagamento (Fase C1) nascem na migration 20261018090000, não nesta: esta, já aplicada, não é editada — ver crmServicesPaymentModalitiesMigration.test.js. As colunas LEGADAS (tipo_cobranca, recorrencia) continuam aqui e o adapter só as LÊ.
    const esperadas = [...comuns, ...Object.values(CATALOG_TABLES[key].specific).filter((coluna) => !MODALITY_COLUMNS.includes(coluna)), ...Object.values(CATALOG_TABLES[key].legacy || {})].sort();
    assert.deepEqual(colunasDe(CORPOS[TABELAS[key]]).sort(), esperadas, `${TABELAS[key]}`);
  }
  // tipos e padrões das colunas comuns
  for (const tabela of Object.values(TABELAS)) {
    const corpo = CORPOS[tabela];
    assert.match(corpo, /\bid\s+TEXT PRIMARY KEY/);
    assert.match(corpo, /\bnome\s+TEXT NOT NULL/);
    assert.match(corpo, /\bnome_normalizado\s+TEXT NOT NULL/);
    assert.match(corpo, /\bativo\s+BOOLEAN NOT NULL DEFAULT true/);
    assert.match(corpo, /\bordem\s+INTEGER NOT NULL DEFAULT 0/);
    assert.match(corpo, /\bcreated_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    assert.match(corpo, /\bupdated_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    for (const auditoria of ['created_by_user_id', 'created_by_name', 'updated_by_user_id', 'updated_by_name']) assert.match(corpo, new RegExp(`\\b${auditoria}\\s+TEXT CHECK \\(${auditoria} IS NULL OR btrim\\(${auditoria}\\) <> ''\\)`));
  }
  assert.match(CORPOS.crm_services, /\bpreco_referencia\s+NUMERIC\(15,2\)/);
});

test('[MIG-CAT-4] IDENTIFICADOR ESTÁVEL: a chave primária é um id TEXT com prefixo próprio (service:/niche:/origin:) e formato de UUID — gerado pela aplicação, independente do nome', () => {
  for (const key of CATALOG_KEYS) {
    const { idPrefix } = CATALOG_DEFINITIONS[key];
    assert.match(CORPOS[TABELAS[key]], new RegExp(`CHECK \\(id ~ '\\^${idPrefix}:\\[0-9a-f-\\]\\{36\\}\\$'\\)`), `${TABELAS[key]}: prefixo ${idPrefix}`);
  }
  assert.doesNotMatch(EXECUTAVEL, /gen_random_uuid|uuid_generate|SERIAL|IDENTITY|DEFAULT nextval/i, 'o id nunca é gerado pelo banco nem sequencial');
});

test('[MIG-CAT-5] UNICIDADE do nome normalizado: UMA restrição UNIQUE por tabela, sem filtro de ativo (vale para DESATIVADOS), com o nome que o adapter reconhece (contém "nome_normalizado")', () => {
  for (const tabela of Object.values(TABELAS)) {
    const nome = `${tabela}_nome_normalizado_key`;
    assert.match(CORPOS[tabela], new RegExp(`CONSTRAINT ${nome} UNIQUE \\(nome_normalizado\\)`), tabela);
    assert.match(nome, /nome_normalizado/, 'é por este texto que o adapter classifica DUPLICATE_NAME');
  }
  assert.doesNotMatch(EXECUTAVEL, /UNIQUE[^;]*WHERE/i, 'nenhuma unicidade parcial (que deixaria os desativados de fora)');
  assert.doesNotMatch(EXECUTAVEL, /CREATE UNIQUE INDEX[^;]*WHERE/i);
  assert.equal((EXECUTAVEL.match(/UNIQUE \(/g) || []).length, 3);
});

test('[MIG-CAT-6] as LISTAS FECHADAS do banco são idênticas às do código: as 20 chaves de cor, os canais de origem, o tipo de cobrança e a recorrência', () => {
  const cor = /cor\s+TEXT\s+CHECK \(cor IS NULL OR cor IN \(([\s\S]*?)\)\)/.exec(CORPOS.crm_niches);
  assert.ok(cor, 'CHECK de cor');
  assert.deepEqual(listaDe(cor[1]), [...NICHE_COLOR_KEYS], 'a paleta do banco = a paleta do código (mesma ordem)');
  assert.equal(listaDe(cor[1]).length, 20);
  const canal = /canal\s+TEXT\s+CHECK \(canal IS NULL OR canal IN \(([^)]*)\)\)/.exec(CORPOS.crm_lead_origins);
  assert.deepEqual(listaDe(canal[1]), [...LEAD_CHANNELS]);
  const cobranca = /tipo_cobranca\s+TEXT\s+CHECK \(tipo_cobranca IS NULL OR tipo_cobranca IN \(([^)]*)\)\)/.exec(CORPOS.crm_services);
  assert.deepEqual(listaDe(cobranca[1]), [...BILLING_TYPES]);
  const recorrencia = /recorrencia\s+TEXT\s+CHECK \(recorrencia IS NULL OR recorrencia IN \(([^)]*)\)\)/.exec(CORPOS.crm_services);
  assert.deepEqual(listaDe(recorrencia[1]), [...RECURRENCES]);
  // a regra de coerência do domínio também está no banco
  assert.match(CORPOS.crm_services, /CONSTRAINT crm_services_cobranca_coerente CHECK \(\(tipo_cobranca IS NOT DISTINCT FROM 'RECORRENTE'\) = \(recorrencia IS NOT NULL\)\)/);
  // a cor só existe em nichos, o canal só em origens, o preço só em serviços
  assert.doesNotMatch(CORPOS.crm_services + CORPOS.crm_lead_origins, /\bcor\s+TEXT/);
  assert.doesNotMatch(CORPOS.crm_services + CORPOS.crm_niches, /\bcanal\s+TEXT/);
  assert.doesNotMatch(CORPOS.crm_niches + CORPOS.crm_lead_origins, /preco_referencia|tipo_cobranca|recorrencia|categoria/);
  // nenhum valor de cor (hex, rgb) é guardado
  assert.doesNotMatch(EXECUTAVEL, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
});

test('[MIG-CAT-7] os LIMITES do banco são os do domínio: nome 80, descrição 500, categoria 60, preço de 0 a 1 bilhão em NUMERIC(15,2)', () => {
  for (const tabela of Object.values(TABELAS)) {
    assert.match(CORPOS[tabela], new RegExp(`CHECK \\(btrim\\(nome\\) <> '' AND char_length\\(nome\\) <= ${LIMITS.NOME}\\)`), `${tabela}: nome`);
    assert.match(CORPOS[tabela], new RegExp(`CHECK \\(btrim\\(nome_normalizado\\) <> '' AND char_length\\(nome_normalizado\\) <= ${LIMITS.NOME}\\)`), `${tabela}: nome_normalizado`);
    assert.match(CORPOS[tabela], new RegExp(`char_length\\(descricao\\) <= ${LIMITS.DESCRICAO}`), `${tabela}: descrição`);
    assert.match(CORPOS[tabela], /CHECK \(ordem >= 0\)/);
  }
  assert.match(CORPOS.crm_services, new RegExp(`char_length\\(categoria\\) <= ${LIMITS.CATEGORIA}`));
  assert.match(CORPOS.crm_services, new RegExp(`preco_referencia >= 0 AND preco_referencia <= ${LIMITS.PRECO_REFERENCIA_MAXIMO}`));
});

test('[MIG-CAT-8] RLS ligada nas três tabelas e NENHUMA policy (o mesmo padrão D1/D2 do projeto); nenhuma concessão a anon, authenticated ou PUBLIC nas tabelas', () => {
  for (const tabela of Object.values(TABELAS)) assert.match(EXECUTAVEL, new RegExp(`ALTER TABLE public\\.${tabela} ENABLE ROW LEVEL SECURITY;`), tabela);
  assert.doesNotMatch(EXECUTAVEL, /CREATE POLICY/i);
  assert.doesNotMatch(EXECUTAVEL, /GRANT\s+[A-Z, ]+\s+ON\s+(?:TABLE\s+)?public\.crm_/i, 'nenhum GRANT em tabela');
  assert.doesNotMatch(EXECUTAVEL, /\b(anon|authenticated)\b/i);
  assert.doesNotMatch(EXECUTAVEL, /DISABLE ROW LEVEL SECURITY|NO FORCE|BYPASSRLS/i);
});

test('[MIG-CAT-9] updated_at automático por uma função/trigger PRÓPRIA desta migration (nunca reaproveita a de outra, que pode não estar aplicada), em cada uma das três tabelas', () => {
  assert.match(EXECUTAVEL, /CREATE FUNCTION public\.crm_catalogs_bump_updated_at\(\) RETURNS trigger/);
  for (const tabela of Object.values(TABELAS)) {
    assert.match(EXECUTAVEL, new RegExp(`CREATE TRIGGER ${tabela}_bump_updated_at_trigger\\s+BEFORE UPDATE ON public\\.${tabela}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.crm_catalogs_bump_updated_at\\(\\);`), tabela);
  }
  assert.doesNotMatch(EXECUTAVEL, /crm_funnels_bump_updated_at|crm_records_bump_version|prospecting_permanent_exclusions_bump/);
  assert.equal((EXECUTAVEL.match(/CREATE TRIGGER/g) || []).length, 3);
});

test('[MIG-CAT-10] o RPC de reordenação bate com o adapter: mesmo nome, mesmos parâmetros, os três ramos por chave de catálogo, as mensagens que o adapter classifica ("inexistente", P0001), só a service_role executa', () => {
  assert.match(EXECUTAVEL, new RegExp(`CREATE FUNCTION public\\.${REORDER_RPC}\\(`));
  const assinatura = new RegExp(`CREATE FUNCTION public\\.${REORDER_RPC}\\(\\s*p_catalog TEXT,\\s*p_ordered_ids TEXT\\[\\],\\s*p_actor_user_id TEXT,\\s*p_actor_name TEXT\\s*\\) RETURNS void`);
  assert.match(EXECUTAVEL, assinatura);
  for (const parametro of ['p_catalog', 'p_ordered_ids', 'p_actor_user_id', 'p_actor_name']) assert.match(EXECUTAVEL, new RegExp(`\\b${parametro}\\b`));
  for (const key of CATALOG_KEYS) assert.match(EXECUTAVEL, new RegExp(`p_catalog = '${key}'`), `ramo de ${key}`);
  assert.match(EXECUTAVEL, /SECURITY INVOKER/);
  assert.doesNotMatch(EXECUTAVEL, /SECURITY DEFINER/i);
  assert.match(EXECUTAVEL, /SET search_path = pg_catalog, public/);
  assert.match(EXECUTAVEL, /RAISE EXCEPTION 'reorder_crm_catalog: item inexistente' USING ERRCODE = 'P0001'/);
  for (const recusa of ['lista de ids vazia', 'ids repetidos', 'catálogo desconhecido', 'item inexistente']) assert.match(EXECUTAVEL, new RegExp(`reorder_crm_catalog: ${recusa}`), recusa);
  // só as linhas cuja ordem muda são atualizadas
  assert.equal((EXECUTAVEL.match(/IS DISTINCT FROM \(t\.pos - 1\)::INTEGER/g) || []).length, 3);
  assert.match(EXECUTAVEL, new RegExp(`REVOKE ALL ON FUNCTION public\\.${REORDER_RPC}\\(TEXT, TEXT\\[\\], TEXT, TEXT\\) FROM PUBLIC;`));
  assert.match(EXECUTAVEL, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${REORDER_RPC}\\(TEXT, TEXT\\[\\], TEXT, TEXT\\) TO service_role;`));
  assert.equal((EXECUTAVEL.match(/GRANT /g) || []).length, 1, 'a única concessão é a do RPC, para a service_role');
});

test('[MIG-CAT-11] ADITIVA: não altera, não lê e não referencia crm_records, crm_record_deletions, funis, exclusões nem nenhuma outra tabela existente; sem foreign keys; sem DROP/TRUNCATE/DELETE/INSERT; o único UPDATE é a reordenação das próprias três tabelas', () => {
  assert.doesNotMatch(EXECUTAVEL, /crm_records|crm_record_deletions|crm_funnel|prospecting_|auth\.users|storage\./i);
  assert.doesNotMatch(EXECUTAVEL, /\bREFERENCES\b/i, 'nenhuma foreign key (nem apontando para estas tabelas ainda)');
  assert.doesNotMatch(EXECUTAVEL, /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|COPY|CREATE EXTENSION|CREATE SCHEMA|CREATE ROLE|ALTER ROLE)\b/i);
  assert.doesNotMatch(EXECUTAVEL, /ALTER TABLE public\.(?!crm_services|crm_niches|crm_lead_origins)/i);
  const alteracoes = [...EXECUTAVEL.matchAll(/ALTER TABLE ([\w.]+) ([A-Z ]+);/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(alteracoes.sort(), ['public.crm_lead_origins ENABLE ROW LEVEL SECURITY', 'public.crm_niches ENABLE ROW LEVEL SECURITY', 'public.crm_services ENABLE ROW LEVEL SECURITY']);
  const updates = [...EXECUTAVEL.matchAll(/UPDATE (public\.\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(updates, ['public.crm_lead_origins', 'public.crm_niches', 'public.crm_services']);
  assert.match(SQL, /ADITIVA/);
});

test('[MIG-CAT-12] SEM CARGA INICIAL e SEM EXCLUSÃO FÍSICA: nenhuma linha de negócio é inserida (nem serviços, nichos ou origens de exemplo) e não há função ou política de DELETE', () => {
  assert.doesNotMatch(EXECUTAVEL, /\bINSERT\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\bDELETE\b/i);
  assert.doesNotMatch(EXECUTAVEL, /Psicologia|Estética|Escritórios|Indicação|Meta Ads|Google Ads|WhatsApp/i, 'nenhum valor de negócio no SQL executável');
  assert.match(SQL, /NENHUMA linha de negócio é inserida/);
  assert.match(SQL, /SEM EXCLUSÃO FÍSICA/);
});

test('[MIG-CAT-13] NADA EXECUTA a migration: nenhum arquivo de src/ ou scripts/ a lê ou a cita, e o package.json não tem script de migration; só testes a leem', () => {
  const lerArvore = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
      const caminho = path.join(dir, entrada.name);
      return entrada.isDirectory() ? lerArvore(caminho) : [caminho];
    });
  // Só o CÓDIGO conta: um comentário que cita o nome do arquivo não executa nada.
  const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const arquivo of [...lerArvore(path.join(REPO_ROOT, 'src')), ...lerArvore(path.join(REPO_ROOT, 'scripts'))].filter((f) => /\.(js|mjs|json)$/.test(f))) {
    const texto = semComentarios(fs.readFileSync(arquivo, 'utf8'));
    assert.doesNotMatch(texto, /20261012090000|crm_catalogs\.sql/, `${path.relative(REPO_ROOT, arquivo)} não pode referenciar o arquivo da migration`);
    assert.doesNotMatch(texto, /supabase[\\/]+migrations/, `${path.relative(REPO_ROOT, arquivo)} não lê a pasta de migrations`);
  }
  const pacote = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pacote.scripts).sort(), ['dev', 'smoke:researcher', 'start', 'test', 'test:integration']); // test:integration = só os testes de rede externa, sob autorização explícita (Fase 2B-2)
  assert.equal(JSON.stringify(pacote).includes('db push') || JSON.stringify(pacote).includes('migrate'), false);
});

test('[MIG-CAT-14] o supabase/README.md descreve as migrations existentes SEM afirmar aplicação não verificada, e marca a dos catálogos como NÃO APLICADA', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'README.md'), 'utf8');
  const arquivos = fs.readdirSync(MIGRATIONS_DIR).filter((nome) => nome.endsWith('.sql'));
  for (const arquivo of arquivos) assert.ok(readme.includes(arquivo), `o README cita ${arquivo}`);
  const trecho = readme.slice(readme.indexOf('20261012090000_crm_catalogs.sql'));
  assert.match(trecho.slice(0, 900), /NÃO APLICADA/);
  assert.match(readme, /não foi verificad/i, 'o README diz que o estado real no banco não foi verificado');
  assert.doesNotMatch(readme, /src\/crm\/crmSupabase/, 'o caminho antigo (src/crm/...) foi corrigido para src/crm-adapters/');
});
