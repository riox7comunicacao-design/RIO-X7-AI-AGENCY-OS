// Testes ESTRUTURAIS/ESTÁTICOS da migration das modalidades de pagamento dos Serviços (CRM 5.0, Fase C1 — decisão 0027) — SEM banco, sem rede,
// sem Supabase. Só leem o texto de supabase/migrations/20261018090000_crm_services_payment_modalities.sql e o CRUZAM com o código (as colunas do
// adapter, a lista de periodicidades, as regras do domínio): se um lado mudar sem o outro, estes testes falham. Não executam nenhum SQL — a
// migration continua NÃO APLICADA, e um teste confere que nada no projeto a executa. O preenchimento (UPDATE) é provado de duas formas: pelo
// TEXTO (só toca as três colunas novas, só as linhas certas) e por um SIMULADOR no PostgREST falso (tests/helpers/fakePostgrestCatalogs.js) que
// aplica a mesma regra sobre linhas semeadas. Não é um Postgres: o limite está dito no supabase/README.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CATALOG_TABLES, createSupabaseCatalogRepository } = require('../../src/crm-adapters/crmSupabaseCatalogRepository');
const { RECURRENCES, PAYMENT_MODALITY_FIELDS, CATALOG_DEFINITIONS } = require('../../src/crm/catalogConstants');
const { validateCreateInput } = require('../../src/crm/catalogDomain');
const { createFakePostgrestCatalogs } = require('../helpers/fakePostgrestCatalogs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const FILE_NAME = '20261018090000_crm_services_payment_modalities.sql';
const SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, FILE_NAME), 'utf8').replace(/\r\n/g, '\n');
const EXECUTAVEL = SQL.replace(/--[^\n]*/g, ''); // sem os comentários
const SQL_PLANO = EXECUTAVEL.replace(/\s+/g, ' ').trim(); // uma linha só, para conferir expressões
const COLUNAS_NOVAS = Object.freeze(['permite_pagamento_unico', 'permite_pagamento_recorrente', 'periodicidades']);
const lista = (texto) => [...texto.matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('[MIGMOD-1] o arquivo existe, segue a convenção de nome do CLI do Supabase, é a ÚLTIMA migration e se declara expressamente NÃO APLICADA', () => {
  assert.match(FILE_NAME, /^\d{14}_[a-z0-9_]+\.sql$/);
  const todas = fs.readdirSync(MIGRATIONS_DIR).filter((nome) => nome.endsWith('.sql')).sort();
  // Era a mais nova até a Fase D1.1, que acrescentou a migration das Negociações DEPOIS dela (só referencia crm_services; esta não foi editada — o hash dos testes dela continua valendo); a D2 (Clientes PF/PJ) veio depois.
  assert.equal(todas.at(-3), FILE_NAME, 'é a antepenúltima: só a das Negociações (D1.1) e a dos Clientes PF/PJ (D2) vêm depois');
  assert.equal(todas.at(-2), '20261019090000_crm_negotiations.sql');
  assert.equal(todas.at(-1), '20261020090000_crm_client_person_type.sql');
  assert.equal(todas.at(-4), '20261017090000_prospecting_permanent_exclusions_created_by_text.sql', 'vem logo depois da corretiva das Exclusões');
  assert.ok(todas.includes('20261012090000_crm_catalogs.sql'), 'a dos catálogos continua lá, sem ser editada');
  assert.match(SQL.split('\n').slice(0, 8).join('\n'), /NÃO APLICADA/, 'o cabeçalho diz que NÃO foi aplicada');
  assert.match(SQL, /decisão 0027/);
  assert.match(SQL, /Aplicar é uma ação humana e consciente do proprietário/i);
  assert.match(SQL, /real do banco NÃO foi consultado/);
});

test('[MIGMOD-2] ADITIVA e SÓ em crm_services: três ADD COLUMN com padrão (nenhuma linha existente fica inválida), os mesmos nomes que o adapter usa; sem DROP/TRUNCATE/DELETE/INSERT/CREATE', () => {
  const alter = /ALTER TABLE public\.crm_services ADD COLUMN permite_pagamento_unico BOOLEAN NOT NULL DEFAULT false, ADD COLUMN permite_pagamento_recorrente BOOLEAN NOT NULL DEFAULT false, ADD COLUMN periodicidades TEXT\[\] NOT NULL DEFAULT '\{\}';/;
  assert.match(SQL_PLANO, alter);
  // os nomes das colunas do adapter são exatamente estes (e o mapa continua na ordem do contrato)
  assert.deepEqual(Object.values(CATALOG_TABLES.servicos.specific).filter((coluna) => COLUNAS_NOVAS.includes(coluna)), [...COLUNAS_NOVAS]);
  assert.deepEqual(Object.keys(CATALOG_TABLES.servicos.specific).filter((campo) => PAYMENT_MODALITY_FIELDS.includes(campo)), [...PAYMENT_MODALITY_FIELDS]);
  // nenhuma outra tabela, nenhum comando destrutivo ou de carga
  assert.deepEqual([...new Set([...EXECUTAVEL.matchAll(/\bpublic\.([a-z_]+)/g)].map((m) => m[1]))], ['crm_services']);
  assert.doesNotMatch(EXECUTAVEL, /\b(DROP|TRUNCATE|DELETE|INSERT|CREATE|GRANT|REVOKE|DISABLE|ENABLE|REFERENCES|FOREIGN)\b/i);
  assert.doesNotMatch(EXECUTAVEL, /\bALTER COLUMN\b|\bRENAME\b|\bDROP COLUMN\b/i, 'nada existente é alterado nem renomeado');
  // as colunas antigas continuam: este arquivo nem as redefine
  assert.doesNotMatch(EXECUTAVEL, /ADD COLUMN\s+(tipo_cobranca|recorrencia|preco_referencia|nome)\b/);
  assert.deepEqual(CATALOG_DEFINITIONS.servicos.legacyFields, ['tipoCobranca', 'recorrencia']);
  assert.deepEqual(CATALOG_TABLES.servicos.legacy, { tipoCobranca: 'tipo_cobranca', recorrencia: 'recorrencia' }, 'o adapter ainda as lê (só lê)');
  // o arquivo de catálogos já aplicado NÃO é editado por esta fase: nada de modalidade nele
  const original = fs.readFileSync(path.join(MIGRATIONS_DIR, '20261012090000_crm_catalogs.sql'), 'utf8');
  for (const coluna of COLUNAS_NOVAS) assert.ok(!original.includes(coluna), `${coluna} não está na migration já aplicada`);
});

test('[MIGMOD-3] as QUATRO restrições estão no texto exato esperado, e a lista de valores é a do código (mesma ordem)', () => {
  const nomes = ['crm_services_periodicidades_validas', 'crm_services_periodicidades_sem_repeticao', 'crm_services_recorrente_exige_periodicidade', 'crm_services_nao_recorrente_sem_periodicidade'];
  assert.deepEqual([...SQL_PLANO.matchAll(/ADD CONSTRAINT ([a-z_]+)/g)].map((m) => m[1]), nomes);
  const validas = /ADD CONSTRAINT crm_services_periodicidades_validas CHECK \(periodicidades <@ ARRAY\[([^\]]*)\]::TEXT\[\]\)/.exec(SQL_PLANO);
  assert.ok(validas, 'valores permitidos');
  assert.deepEqual(lista(validas[1]), [...RECURRENCES], 'MENSAL, TRIMESTRAL, SEMESTRAL, ANUAL: as do código');
  // sem repetição: sem subconsulta (um CHECK não pode ter), a soma de "contém cada valor" tem de igualar o tamanho — e cobre TODOS os valores
  const semRepeticao = /ADD CONSTRAINT crm_services_periodicidades_sem_repeticao CHECK \(cardinality\(periodicidades\) = \((.*?)\)\),/.exec(SQL_PLANO);
  assert.ok(semRepeticao, 'unicidade dentro da lista');
  assert.deepEqual([...semRepeticao[1].matchAll(/\(periodicidades @> ARRAY\['([A-Z]+)'\]::TEXT\[\]\)::INTEGER/g)].map((m) => m[1]), [...RECURRENCES], 'um termo por periodicidade, na mesma ordem');
  assert.equal(semRepeticao[1].split('+').length, RECURRENCES.length, 'e nenhum termo a mais');
  assert.match(SQL_PLANO, /ADD CONSTRAINT crm_services_recorrente_exige_periodicidade CHECK \(NOT permite_pagamento_recorrente OR cardinality\(periodicidades\) > 0\)/);
  assert.match(SQL_PLANO, /ADD CONSTRAINT crm_services_nao_recorrente_sem_periodicidade CHECK \(permite_pagamento_recorrente OR cardinality\(periodicidades\) = 0\)/);
  assert.doesNotMatch(SQL_PLANO, /SELECT\b[^;]*\bFROM\b[^;]*CHECK|CHECK \([^)]*\bSELECT\b/i, 'nenhuma subconsulta dentro de CHECK');
  // NÃO existe restrição que exija ao menos uma modalidade: o serviço LEGADO sem nenhuma continua válido
  assert.doesNotMatch(SQL_PLANO, /permite_pagamento_unico OR permite_pagamento_recorrente/);
  assert.doesNotMatch(SQL_PLANO, /ADD CONSTRAINT[^;]*permite_pagamento_unico[^;]*CHECK/i);
});

// As quatro restrições, escritas à mão aqui (e travadas ao texto do SQL pelo teste acima), contra o domínio: para TODAS as combinações de permissões e de
// listas (vazia, uma, duas, repetidas, valor inválido), o que o domínio aceita num cadastro novo é aceito pelo banco; e o único caso que o banco aceita e o
// domínio recusa num cadastro novo é "nenhuma modalidade" (o serviço LEGADO), de propósito.
const bancoAceita = ({ unico, recorrente, periodicidades }) => {
  if (typeof unico !== 'boolean' || typeof recorrente !== 'boolean') return false;
  const validas = periodicidades.every((valor) => RECURRENCES.includes(valor));
  if (!validas) return false;
  const soma = RECURRENCES.reduce((total, valor) => total + (periodicidades.includes(valor) ? 1 : 0), 0);
  if (periodicidades.length !== soma) return false; // repetição
  if (recorrente && periodicidades.length === 0) return false;
  if (!recorrente && periodicidades.length > 0) return false;
  return true;
};

test('[MIGMOD-4] PARIDADE com o domínio: todas as combinações de modalidades e periodicidades — o domínio e as restrições do banco concordam (a única diferença é o serviço legado sem nenhuma modalidade)', () => {
  const valores = [...RECURRENCES, 'QUINZENAL'];
  const listas = [[]];
  for (const a of valores) {
    listas.push([a]);
    for (const b of valores) {
      listas.push([a, b]);
      for (const c of valores) listas.push([a, b, c]);
    }
  }
  let comparadas = 0;
  let soOBanco = 0;
  for (const unico of [true, false]) {
    for (const recorrente of [true, false]) {
      for (const periodicidades of listas) {
        const dominio = validateCreateInput('servicos', { nome: 'X', permitePagamentoUnico: unico, permitePagamentoRecorrente: recorrente, periodicidades }).ok;
        const banco = bancoAceita({ unico, recorrente, periodicidades });
        const legadoSemNenhuma = !unico && !recorrente && periodicidades.length === 0;
        const rotulo = JSON.stringify({ unico, recorrente, periodicidades });
        if (legadoSemNenhuma) {
          assert.equal(banco, true, `o banco aceita o legado sem modalidade: ${rotulo}`);
          assert.equal(dominio, false, `o domínio recusa um cadastro NOVO sem modalidade: ${rotulo}`);
          soOBanco += 1;
        } else {
          // a lista pode vir com repetição ou valor fora da lista: o domínio recusa pelo mesmo motivo que o banco
          assert.equal(dominio, banco, rotulo);
        }
        comparadas += 1;
      }
    }
  }
  assert.equal(soOBanco, 1);
  assert.equal(comparadas, 4 * (1 + 5 + 25 + 125), `todas as combinações: 2 x 2 permissões x 156 listas`);
});

test('[MIGMOD-5] O PREENCHIMENTO toca SÓ as três colunas novas, SÓ as linhas com tipo_cobranca informado e ainda sem modalidade, sem inferir nada do que não existe; um único UPDATE', () => {
  const updates = [...SQL_PLANO.matchAll(/\bUPDATE\b/g)];
  assert.equal(updates.length, 1, 'um único UPDATE');
  const update = /UPDATE public\.crm_services SET (.*?) WHERE (.*?);/.exec(SQL_PLANO);
  assert.ok(update, 'o UPDATE');
  const definidas = [...update[1].matchAll(/(?:^|, )([a-z_]+) = /g)].map((m) => m[1]);
  assert.deepEqual(definidas, [...COLUNAS_NOVAS], 'só as colunas novas, e nenhuma outra (nome, preço, ordem, ativo, auditoria, legado ficam)');
  assert.match(update[1], /permite_pagamento_unico = \(tipo_cobranca = 'UNICA'\)/);
  assert.match(update[1], /permite_pagamento_recorrente = \(tipo_cobranca = 'RECORRENTE'\)/);
  assert.match(update[1], /periodicidades = CASE WHEN tipo_cobranca = 'RECORRENTE' THEN ARRAY\[recorrencia\]::TEXT\[\] ELSE ARRAY\[\]::TEXT\[\] END/);
  // as guardas: só linhas com o contrato antigo informado e ainda sem modalidade nova (repetir não sobrescreve o que o ADMIN completou; sem tipo, não toca)
  assert.match(update[2], /tipo_cobranca IS NOT NULL/);
  assert.match(update[2], /permite_pagamento_unico = false/);
  assert.match(update[2], /permite_pagamento_recorrente = false/);
  assert.match(update[2], /cardinality\(periodicidades\) = 0/);
  assert.equal(update[2].split(' AND ').length, 4, 'exatamente estas quatro guardas');
  // o texto não presume nada além dos dois valores do contrato antigo
  assert.deepEqual([...new Set(lista(update[1]).filter((valor) => /^[A-Z_]+$/.test(valor)))].sort(), ['RECORRENTE', 'UNICA']);
});

test('[MIGMOD-6] O PREENCHIMENTO, simulado sobre linhas reais do formato antigo: UNICA, cada RECORRENTE, sem tipo (legado) — preserva ids, nomes, preços, legado e ordem; toca só quem tem tipo; é repetível e nunca desfaz o que o ADMIN completou', async () => {
  const fake = createFakePostgrestCatalogs();
  const repo = createSupabaseCatalogRepository({ url: fake.url, serviceRoleKey: fake.serviceRoleKey, fetchImpl: fake.fetchImpl });
  const T = '2026-10-10T10:00:00.000Z';
  const linha = (n, extras) => ({ id: `service:00000000-0000-4000-8000-00000000000${n}`, nome: `Serviço ${n}`, nome_normalizado: `servico ${n}`, descricao: null, ativo: true, ordem: n - 1, categoria: null, preco_referencia: null, tipo_cobranca: null, recorrencia: null, created_at: T, updated_at: T, created_by_user_id: 'u', created_by_name: 'Admin', updated_by_user_id: 'u', updated_by_name: 'Admin', ...extras });
  const antes = [
    linha(1, { tipo_cobranca: 'UNICA', preco_referencia: 4800.5 }),
    linha(2, { tipo_cobranca: 'RECORRENTE', recorrencia: 'MENSAL', preco_referencia: 1500 }),
    linha(3, { tipo_cobranca: 'RECORRENTE', recorrencia: 'TRIMESTRAL' }),
    linha(4, { tipo_cobranca: 'RECORRENTE', recorrencia: 'SEMESTRAL' }),
    linha(5, { tipo_cobranca: 'RECORRENTE', recorrencia: 'ANUAL', ativo: false }),
    linha(6, { preco_referencia: 900 }), // LEGADO: sem tipo_cobranca
  ];
  for (const row of antes) fake.tables.crm_services.set(row.id, structuredClone(row)); // como estavam no banco (o gatilho não roda na carga)
  const fotoDoLegado = () => [...fake.tables.crm_services.values()].map(({ id, nome, nome_normalizado, descricao, ativo, ordem, categoria, preco_referencia, tipo_cobranca, recorrencia, created_at, created_by_user_id, created_by_name, updated_by_user_id, updated_by_name }) => ({ id, nome, nome_normalizado, descricao, ativo, ordem, categoria, preco_referencia, tipo_cobranca, recorrencia, created_at, created_by_user_id, created_by_name, updated_by_user_id, updated_by_name }));
  const legadoAntes = JSON.stringify(fotoDoLegado());

  assert.equal(fake.applyModalitiesMigration(), 5, 'toca as cinco linhas com tipo_cobranca; a sexta (sem tipo) fica');
  assert.equal(JSON.stringify(fotoDoLegado()), legadoAntes, 'nada além das três colunas novas (e updated_at) mudou: ids, nomes, preços, ordem, ativo, legado, auditoria');

  const lidos = await repo.list('servicos');
  assert.deepEqual(lidos.map((i) => [i.id.slice(-1), i.permitePagamentoUnico, i.permitePagamentoRecorrente, i.periodicidades]), [
    ['1', true, false, []],
    ['2', false, true, ['MENSAL']],
    ['3', false, true, ['TRIMESTRAL']],
    ['4', false, true, ['SEMESTRAL']],
    ['5', false, true, ['ANUAL']],
    ['6', false, false, []],
  ], 'UNICA → único; RECORRENTE + X → recorrente com X; sem tipo → nada é inferido');
  assert.deepEqual(lidos.map((i) => [i.tipoCobranca, i.recorrencia]), [['UNICA', null], ['RECORRENTE', 'MENSAL'], ['RECORRENTE', 'TRIMESTRAL'], ['RECORRENTE', 'SEMESTRAL'], ['RECORRENTE', 'ANUAL'], [null, null]], 'o legado continua legível, intacto');
  assert.deepEqual(lidos.map((i) => i.precoReferencia), [4800.5, 1500, null, null, null, 900], 'os preços de referência intactos');
  // o gatilho de updated_at: só as linhas tocadas mudam; a sem tipo não
  const atualizados = [...fake.tables.crm_services.values()].map((row) => row.updated_at !== T);
  assert.deepEqual(atualizados, [true, true, true, true, true, false], 'updated_at muda só nas linhas que o UPDATE tocou');

  // o ADMIN completa o serviço legado (6) pela tela: único + recorrente anual — e repetir o preenchimento não desfaz nada
  const completado = await repo.update('servicos', lidos[5].id, { permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['ANUAL'] });
  assert.deepEqual([completado.permitePagamentoUnico, completado.permitePagamentoRecorrente, completado.periodicidades], [true, true, ['ANUAL']]);
  const e2 = await repo.update('servicos', lidos[1].id, { permitePagamentoUnico: true, periodicidades: ['MENSAL', 'ANUAL'] });
  assert.deepEqual([e2.permitePagamentoUnico, e2.permitePagamentoRecorrente, e2.periodicidades], [true, true, ['MENSAL', 'ANUAL']]);
  const fotoDepois = JSON.stringify((await repo.list('servicos')).map((i) => [i.permitePagamentoUnico, i.permitePagamentoRecorrente, i.periodicidades]));
  assert.equal(fake.applyModalitiesMigration(), 0, 'repetir não toca nada: só preenche o que ainda está vazio');
  assert.equal(JSON.stringify((await repo.list('servicos')).map((i) => [i.permitePagamentoUnico, i.permitePagamentoRecorrente, i.periodicidades])), fotoDepois, 'e nunca sobrescreve o que o ADMIN completou');
  // um serviço criado por um servidor ANTIGO na janela (só colunas antigas) é pego pela repetição
  fake.tables.crm_services.set('service:00000000-0000-4000-8000-000000000007', { ...linha(7, { tipo_cobranca: 'UNICA' }), permite_pagamento_unico: false, permite_pagamento_recorrente: false, periodicidades: [] });
  assert.equal(fake.applyModalitiesMigration(), 1);
  assert.equal((await repo.getById('servicos', 'service:00000000-0000-4000-8000-000000000007')).permitePagamentoUnico, true);
});

test('[MIGMOD-7] TRANSIÇÃO: o servidor novo sobre o esquema ANTIGO lê tudo (sem modalidade, nada inferido) e FALHA FECHADO ao criar/editar serviço, sem gravar nada e sem mexer em nichos e origens', async () => {
  const fake = createFakePostgrestCatalogs({ schema: 'antigo' });
  const repo = createSupabaseCatalogRepository({ url: fake.url, serviceRoleKey: fake.serviceRoleKey, fetchImpl: fake.fetchImpl });
  const T = '2026-10-10T10:00:00.000Z';
  fake.tables.crm_services.set('service:00000000-0000-4000-8000-000000000001', { id: 'service:00000000-0000-4000-8000-000000000001', nome: 'Antigo', nome_normalizado: 'antigo', descricao: null, ativo: true, ordem: 0, categoria: null, preco_referencia: 500, tipo_cobranca: 'UNICA', recorrencia: null, created_at: T, updated_at: T });
  const [lido] = await repo.list('servicos');
  assert.deepEqual([lido.nome, lido.precoReferencia, lido.tipoCobranca, lido.permitePagamentoUnico, lido.permitePagamentoRecorrente, lido.periodicidades], ['Antigo', 500, 'UNICA', false, false, []], 'o legado é lido; as modalidades ficam vazias — nada é inferido do tipo antigo');
  const novo = { id: 'service:00000000-0000-4000-8000-000000000002', nome: 'Novo', nomeNormalizado: 'novo', descricao: null, ativo: true, ordem: 1, categoria: null, precoReferencia: null, permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [], tipoCobranca: null, recorrencia: null, criadoEm: T, atualizadoEm: T, criadoPorId: null, criadoPorNome: null, atualizadoPorId: null, atualizadoPorNome: null };
  await assert.rejects(() => repo.insert('servicos', novo));
  await assert.rejects(() => repo.update('servicos', lido.id, { permitePagamentoUnico: true }));
  assert.equal(fake.tables.crm_services.size, 1, 'nada foi criado');
  assert.equal(fake.tables.crm_services.get(lido.id).tipo_cobranca, 'UNICA', 'nada foi alterado');
  // editar só o nome continua funcionando no esquema antigo (não toca nas colunas novas)
  const renomeado = await repo.update('servicos', lido.id, { nome: 'Antigo renomeado', nomeNormalizado: 'antigo renomeado' });
  assert.equal(renomeado.nome, 'Antigo renomeado');
});

test('[MIGMOD-8] o README documenta a migration como NÃO APLICADA, com a ordem segura (parar o servidor, migration, conferir, subir o novo) e as conferências ANTES/DEPOIS sem nomes nem preços', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(readme.includes(FILE_NAME));
  const secao = readme.slice(readme.indexOf('### A migration das modalidades de pagamento dos Serviços'), readme.indexOf('## Código dos adaptadores'));
  assert.ok(secao.length > 1000, 'a seção existe');
  assert.match(readme.slice(readme.indexOf(`| \`${FILE_NAME}\``)).split('\n')[0], /NÃO APLICADA/);
  assert.match(secao, /Ordem segura de implantação/);
  assert.match(secao, /Pare o servidor[\s\S]*Aplique esta migration numa transação[\s\S]*Confira "DEPOIS"[\s\S]*Suba o servidor novo[\s\S]*Repetir o `UPDATE` só tem sentido se "pendentes" > 0/i);
  assert.match(secao, /NOTIFY pgrst/);
  assert.match(secao, /select count\(\*\) as pendentes/);
  assert.match(secao, /Conferência ANTES/);
  assert.match(secao, /Conferência DEPOIS/);
  assert.match(secao, /updated_at/);
  assert.match(secao, /LEGADO/);
  // as consultas de conferência nunca selecionam nome, descrição, categoria, preço nem auditoria
  const consultas = [...secao.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
  assert.ok(consultas.includes('select'), 'há consultas');
  const colunasSelecionadas = [...consultas.matchAll(/\bselect\b([\s\S]*?)\bfrom\b/gi)].map((m) => m[1]).join(' ');
  assert.doesNotMatch(colunasSelecionadas, /\b(nome|nome_normalizado|descricao|categoria|preco_referencia|created_by|updated_by|id)\b/);
  assert.doesNotMatch(consultas, /\b(insert|update|delete|drop|alter|truncate)\b/i, 'conferência é só leitura');
});

test('[MIGMOD-9] NADA EXECUTA a migration: nenhum arquivo de src/ ou scripts/ a lê ou a cita, e o package.json não tem script de migration', () => {
  const lerArvore = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
      const caminho = path.join(dir, entrada.name);
      return entrada.isDirectory() ? lerArvore(caminho) : [caminho];
    });
  const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const arquivo of [...lerArvore(path.join(REPO_ROOT, 'src')), ...lerArvore(path.join(REPO_ROOT, 'scripts'))].filter((f) => /\.(js|mjs|json)$/.test(f))) {
    const texto = semComentarios(fs.readFileSync(arquivo, 'utf8'));
    assert.doesNotMatch(texto, /20261018090000|crm_services_payment_modalities/, `${path.relative(REPO_ROOT, arquivo)} não pode referenciar o arquivo da migration`);
  }
  const pacote = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(JSON.stringify(pacote).includes('db push') || JSON.stringify(pacote).includes('migrate'), false);
});
