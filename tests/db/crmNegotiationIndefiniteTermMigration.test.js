// A migration dos contratos por PRAZO INDETERMINADO (supabase/migrations/20261021090000_crm_negotiation_indefinite_term.sql — CRM 5.0, Fase D3, decisão 0032). NÃO há PostgreSQL nesta fase: estes testes só LEEM o
// texto do arquivo e o confrontam com o contrato REAL do domínio (src/crm) e com a migration D1.1. A restrição de coerência do BANCO é traduzida do próprio texto para JavaScript e comparada, combinação a
// combinação, com a regra do DOMÍNIO. Nenhuma rede, nenhum banco, nenhum dado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { computeFinance, LIMITS } = require('../../src/crm/negotiationFinance');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const NOME = '20261021090000_crm_negotiation_indefinite_term.sql';
const SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, NOME), 'utf8').replace(/\r\n/g, '\n');
const D11 = fs.readFileSync(path.join(MIGRATIONS_DIR, '20261019090000_crm_negotiations.sql'), 'utf8').replace(/\r\n/g, '\n');
const read = (...partes) => fs.readFileSync(path.join(ROOT, ...partes), 'utf8');

const semComentarios = (texto) => texto.split('\n').map((linha) => linha.replace(/--.*$/, '')).join('\n');
const comandos = (texto) => semComentarios(texto).replace(/\$\$[\s\S]*?\$\$/g, '$$$$'); // sem comentários e sem o corpo das funções
const funcaoDe = (texto, abertura) => {
  const inicio = texto.indexOf(abertura);
  const fim = texto.indexOf('\n$$;', inicio);
  assert.ok(inicio >= 0 && fim > inicio, `função não encontrada: ${abertura}`);
  return texto.slice(inicio, fim + 4);
};
const FUNCAO_NOVA = funcaoDe(SQL, 'CREATE OR REPLACE FUNCTION public.commit_crm_negotiation_change(');
const FUNCAO_D11 = funcaoDe(D11, 'CREATE FUNCTION public.commit_crm_negotiation_change(');

test('[MIGD3-1] o arquivo existe, segue a convenção do CLI do Supabase, é a ÚLTIMA migration, vem depois da D2 e se declara NÃO APLICADA, com a ordem segura, o desfazer e o pré-requisito (D1.1)', () => {
  assert.match(NOME, /^\d{14}_[a-z0-9_]+\.sql$/);
  const todas = fs.readdirSync(MIGRATIONS_DIR).filter((nome) => nome.endsWith('.sql')).sort();
  assert.equal(todas.at(-1), NOME, 'a mais nova');
  assert.equal(todas.at(-2), '20261020090000_crm_client_person_type.sql', 'logo depois dos Clientes PF/PJ (D2)');
  assert.equal(todas.at(-3), '20261019090000_crm_negotiations.sql');
  assert.match(SQL.split('\n').slice(0, 8).join('\n'), /NÃO APLICADA/);
  assert.match(SQL, /decisão 0032/);
  assert.match(SQL, /Aplicar é uma ação humana e consciente do proprietário/);
  assert.match(SQL, /ORDEM SEGURA DE IMPLANTAÇÃO/);
  assert.match(SQL, /PARAR o servidor/);
  assert.match(SQL, /DESFAZER/);
  assert.match(SQL, /prazo_meses NOT NULL, 1 a 120/, 'explica o motivo');
  assert.match(SQL, /COMPATIBILIDADE:/);
  assert.match(SQL, /nunca por zero/i, 'TCV indeterminado nunca é zero');
});

test('[MIGD3-2] o PRIMEIRO comando confere os pré-requisitos e ABORTA (negociações, eventos e a função) — ou se a migration já foi aplicada — antes de qualquer alteração', () => {
  const corpo = comandos(SQL);
  assert.match(corpo.trimStart(), /^DO \$\$/, 'o primeiro comando é a conferência');
  const doBloco = /DO \$\$([\s\S]*?)\n\$\$;/.exec(semComentarios(SQL))[1];
  for (const trecho of ["to_regclass('public.crm_negotiations') IS NULL", "to_regclass('public.crm_negotiation_events') IS NULL", "to_regprocedure('public.commit_crm_negotiation_change(text,jsonb,jsonb,jsonb,timestamptz)') IS NULL", "column_name IN ('duracao_tipo', 'aviso_previo_dias')"]) {
    assert.ok(doBloco.includes(trecho), trecho);
  }
  assert.equal((doBloco.match(/RAISE EXCEPTION/g) || []).length, 3);
  assert.ok(semComentarios(SQL).indexOf('DO $$') < semComentarios(SQL).indexOf('ALTER TABLE'), 'a conferência vem antes do primeiro ALTER');
});

test('[MIGD3-3] ADITIVA: só duas colunas novas, o prazo opcional, a coerência substituída, a função recriada e os privilégios — nenhum DROP de tabela/coluna, nenhum TRUNCATE/DELETE/UPDATE/INSERT fora do corpo da função, nenhum COMMIT/NOTIFY, nenhuma sequência', () => {
  const corpo = comandos(SQL);
  const instrucoes = corpo.split(';').map((trecho) => trecho.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const tipos = instrucoes.map((instrucao) => instrucao.split(' ').slice(0, 3).join(' '));
  assert.deepEqual([...new Set(tipos)].sort(), ['ALTER TABLE public.crm_negotiations', 'COMMENT ON COLUMN', 'CREATE OR REPLACE', 'DO $$', 'GRANT EXECUTE ON', 'REVOKE ALL ON'].sort());
  for (const proibido of [/\bDROP\s+(TABLE|COLUMN|FUNCTION|TRIGGER|INDEX|SCHEMA)\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+public\./i, /\bINSERT\s+INTO\b/i, /\bCOMMIT\b/i, /\bNOTIFY\b/i, /\bCREATE\s+(TABLE|INDEX|TRIGGER|POLICY)\b/i, /\bnextval\b|\bsetval\b/i, /DISABLE\s+ROW\s+LEVEL/i]) {
    assert.doesNotMatch(corpo, proibido, String(proibido));
  }
  // os dois únicos DROP são o NOT NULL do prazo e a restrição que é substituída
  assert.deepEqual([...corpo.matchAll(/\bDROP\s+(\w+(?:\s+\w+)?)/gi)].map((m) => m[1].toUpperCase()), ['NOT NULL', 'CONSTRAINT CRM_NEGOTIATIONS_PAGAMENTO_COERENTE']);
  assert.match(corpo, /ALTER COLUMN prazo_meses DROP NOT NULL/);
  assert.match(corpo, /DROP CONSTRAINT crm_negotiations_pagamento_coerente;/);
  // a função recriada é a ÚNICA a ter INSERT/UPDATE (dentro do corpo, como na D1.1)
  assert.ok(/INSERT INTO public\.crm_negotiations/.test(FUNCAO_NOVA) && /UPDATE public\.crm_negotiations SET/.test(FUNCAO_NOVA));
});

test('[MIGD3-4] AS COLUNAS: duracao_tipo (NOT NULL, padrão DEFINIDA, só DEFINIDA/INDETERMINADA) e aviso_previo_dias (INTEGER, NULL ou 1–365 = os limites do domínio) — com os MESMOS nomes que o adapter do Supabase lê e grava', () => {
  const corpo = semComentarios(SQL);
  assert.match(corpo, /ADD COLUMN duracao_tipo\s+TEXT NOT NULL DEFAULT 'DEFINIDA' CHECK \(duracao_tipo IN \('DEFINIDA', 'INDETERMINADA'\)\)/);
  const aviso = /ADD COLUMN aviso_previo_dias INTEGER CHECK \(aviso_previo_dias IS NULL OR aviso_previo_dias BETWEEN (\d+) AND (\d+)\)/.exec(corpo);
  assert.ok(aviso, 'a coluna do aviso prévio');
  assert.deepEqual([Number(aviso[1]), Number(aviso[2])], [LIMITS.AVISO_PREVIO_MINIMO, LIMITS.AVISO_PREVIO_MAXIMO], 'os limites do banco são os do domínio');
  const adapter = read('src', 'crm-adapters', 'crmSupabaseNegotiationRepository.js');
  for (const trecho of ['row.duracao_tipo', 'row.aviso_previo_dias', 'duracao: negotiation.duracao', 'avisoPrevioDias: negotiation.avisoPrevioDias']) assert.ok(adapter.includes(trecho), trecho);
  for (const coluna of ['duracao_tipo', 'aviso_previo_dias']) assert.ok(FUNCAO_NOVA.includes(coluna), `a função grava ${coluna}`);
  assert.ok(FUNCAO_NOVA.includes("p_negotiation->>'duracao'") && FUNCAO_NOVA.includes("p_negotiation->>'avisoPrevioDias'"), 'as chaves do JSON são as do adapter');
});

// ---- a restrição de coerência, traduzida do TEXTO para JavaScript e comparada com o DOMÍNIO ----------------------------------------------------------------------------------------------------
function restricaoComoFuncao() {
  const corpo = semComentarios(SQL);
  const inicio = corpo.indexOf('ADD CONSTRAINT crm_negotiations_pagamento_coerente CHECK (');
  assert.ok(inicio >= 0);
  let nivel = 0;
  let fim = -1;
  for (let i = corpo.indexOf('CHECK (', inicio) + 6; i < corpo.length; i += 1) {
    if (corpo[i] === '(') nivel += 1;
    if (corpo[i] === ')') {
      nivel -= 1;
      if (nivel === 0) { fim = i; break; }
    }
  }
  let expressao = corpo.slice(corpo.indexOf('CHECK (', inicio) + 7, fim).replace(/\s+/g, ' ').trim();
  expressao = expressao.replace(/\b(duracao_tipo|prazo_meses|aviso_previo_dias|forma_pagamento|periodicidade)\b/g, 'r.$1');
  expressao = expressao.replace(/CASE r\.periodicidade WHEN 'MENSAL' THEN 1 WHEN 'TRIMESTRAL' THEN 3 WHEN 'SEMESTRAL' THEN 6 ELSE 12 END/, "(r.periodicidade === 'MENSAL' ? 1 : r.periodicidade === 'TRIMESTRAL' ? 3 : r.periodicidade === 'SEMESTRAL' ? 6 : 12)");
  expressao = expressao.replace(/IS NOT NULL/g, '!== null').replace(/IS NULL/g, '=== null').replace(/ = (?=')/g, ' === ').replace(/\) = 0/g, ') === 0').replace(/\bAND\b/g, '&&').replace(/\bOR\b/g, '||');
  assert.doesNotMatch(expressao, /\b(CASE|WHEN|THEN|ELSE|END|IN|BETWEEN|IS|NOT|DISTINCT)\b/, `o tradutor não cobre todo o texto da restrição: ${expressao}`);
  return new Function('r', `return (${expressao});`);
}
const PERIODICIDADES = [null, 'MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL'];

test('[MIGD3-5] PARIDADE banco x domínio: a restrição de coerência (traduzida do texto) aceita EXATAMENTE as combinações (duração, prazo, forma, periodicidade, aviso prévio) que o domínio aceita, em todas as combinações', () => {
  const aceita = restricaoComoFuncao();
  let comparadas = 0;
  let aceitas = 0;
  for (const duracao_tipo of ['DEFINIDA', 'INDETERMINADA']) for (const prazo_meses of [null, 1, 3, 6, 10, 12, 24, 36, 120]) for (const forma_pagamento of ['UNICO', 'RECORRENTE']) for (const periodicidade of PERIODICIDADES) for (const aviso_previo_dias of [null, 1, 30, 365]) {
    const linha = { duracao_tipo, prazo_meses, forma_pagamento, periodicidade, aviso_previo_dias };
    // as OUTRAS restrições do banco (prazo 1–120 ou NULL; aviso 1–365 ou NULL; duração válida) valem junto
    const outras = (prazo_meses === null || (prazo_meses >= 1 && prazo_meses <= 120)) && (aviso_previo_dias === null || (aviso_previo_dias >= 1 && aviso_previo_dias <= 365));
    const banco = outras && aceita(linha) === true;
    const financeiro = computeFinance({ duracao: duracao_tipo, formaPagamento: forma_pagamento, periodicidade, prazoMeses: prazo_meses, valorNegociado: 1350 });
    const avisoOk = aviso_previo_dias === null || (duracao_tipo === 'INDETERMINADA' && aviso_previo_dias >= LIMITS.AVISO_PREVIO_MINIMO && aviso_previo_dias <= LIMITS.AVISO_PREVIO_MAXIMO);
    const dominio = financeiro.ok && avisoOk;
    assert.equal(banco, dominio, JSON.stringify(linha));
    comparadas += 1;
    if (banco) aceitas += 1;
  }
  assert.ok(comparadas > 500);
  assert.ok(aceitas > 20, 'a regra não é vazia');
});

test('[MIGD3-6] TODA negociação que já existe (duração DEFINIDA, com prazo, sem aviso prévio, válida na D1.1) continua válida: a restrição nova não recusa nenhuma linha existente — e NULL não passa em falso (as colunas comparadas são NOT NULL ou guardadas por IS [NOT] NULL)', () => {
  const aceita = restricaoComoFuncao();
  const meses = { MENSAL: 1, TRIMESTRAL: 3, SEMESTRAL: 6, ANUAL: 12 };
  let existentes = 0;
  for (let prazo = 1; prazo <= 120; prazo += 1) {
    assert.equal(aceita({ duracao_tipo: 'DEFINIDA', prazo_meses: prazo, forma_pagamento: 'UNICO', periodicidade: null, aviso_previo_dias: null }), true, `único ${prazo}`);
    existentes += 1;
    for (const [periodicidade, passo] of Object.entries(meses)) {
      const valida = prazo % passo === 0;
      assert.equal(aceita({ duracao_tipo: 'DEFINIDA', prazo_meses: prazo, forma_pagamento: 'RECORRENTE', periodicidade, aviso_previo_dias: null }), valida, `${periodicidade} ${prazo}`);
      if (valida) existentes += 1;
    }
  }
  assert.ok(existentes > 200);
  // a armadilha do NULL: um prazo ausente numa duração DEFINIDA NÃO pode passar (a comparação com NULL seria "desconhecida", e um CHECK desconhecido aprova)
  for (const forma_pagamento of ['UNICO', 'RECORRENTE']) for (const periodicidade of [null, 'MENSAL']) {
    assert.equal(aceita({ duracao_tipo: 'DEFINIDA', prazo_meses: null, forma_pagamento, periodicidade, aviso_previo_dias: null }), false, `DEFINIDA sem prazo: ${forma_pagamento}/${periodicidade}`);
  }
  assert.match(semComentarios(SQL), /prazo_meses IS NOT NULL AND aviso_previo_dias IS NULL/);
  assert.match(semComentarios(SQL), /duracao_tipo = 'INDETERMINADA' AND prazo_meses IS NULL AND forma_pagamento = 'RECORRENTE' AND periodicidade IS NOT NULL/);
});

test('[MIGD3-7] a FUNÇÃO TRANSACIONAL é a da D1.1: mesma assinatura, SECURITY INVOKER, search_path fixo e o corpo igual fora dos trechos da duração (só 11 linhas novas/alteradas, todas conhecidas) — o histórico imutável, a concorrência e as transições não mudam', () => {
  const linhas = (texto) => texto.split('\n');
  const antigas = linhas(FUNCAO_D11);
  const novas = linhas(FUNCAO_NOVA);
  const conjuntoAntigo = new Set(antigas);
  const conjuntoNovo = new Set(novas);
  const acrescentadas = novas.filter((linha) => !conjuntoAntigo.has(linha));
  const removidas = antigas.filter((linha) => !conjuntoNovo.has(linha));
  assert.equal(removidas.length, 3);
  assert.deepEqual(removidas.map((l) => ['CREATE FUNCTION public.commit_crm_negotiation_change(', 'INSERT INTO public.crm_negotiations (', "p_negotiation->>'responsavelUserId'"].find((inicio) => l.trim().startsWith(inicio))), ['CREATE FUNCTION public.commit_crm_negotiation_change(', 'INSERT INTO public.crm_negotiations (', "p_negotiation->>'responsavelUserId'"], 'só estas três linhas foram trocadas');
  assert.equal(acrescentadas.length, 11, acrescentadas.map((l) => l.trim().slice(0, 60)).join('\n'));
  for (const linha of acrescentadas) assert.ok(/duracao|CREATE OR REPLACE|prazoMeses|avisoPrevioDias|aviso_previo|RAISE EXCEPTION 'crm_negotiation_invalid_term|INSERT INTO public\.crm_negotiations|v_duracao|END IF;|^\s+OR \(v_duracao|^\s+IF v_duracao|p_negotiation->>'responsavelUserId'/.test(linha), `linha acrescentada inesperada: ${linha}`);
  assert.equal(antigas.length + 9, novas.length, 'nove linhas a mais: a variável, a conferência da duração (7 linhas, com o RAISE) e as duas colunas do UPDATE');
  const assinatura = (texto) => /\(\n([\s\S]*?)\n\) RETURNS void\nLANGUAGE plpgsql\nSECURITY INVOKER\nSET search_path = public, pg_temp/.exec(texto)[1];
  assert.equal(assinatura(FUNCAO_NOVA), assinatura(FUNCAO_D11), 'mesma assinatura, SECURITY INVOKER e search_path fixo');
  // o que protege o histórico e a concorrência continua lá, literalmente
  for (const trecho of ["crm_negotiation_history: o histórico não pode encolher", 'crm_negotiation_conflict', 'crm_negotiation_immutable', "toda alteração acrescenta um evento ao histórico", 'FOR UPDATE']) assert.ok(FUNCAO_NOVA.includes(trecho), trecho);
});

test('[MIGD3-8] a função NOVA recusa a duração incoerente ANTES de gravar (crm_negotiation_invalid_term, reconhecido pelo adapter) e o INSERT e o UPDATE gravam as duas colunas; a carga sem os campos novos (cliente anterior) vale como DEFINIDA', () => {
  assert.match(FUNCAO_NOVA, /v_duracao := COALESCE\(p_negotiation->>'duracao', 'DEFINIDA'\)/);
  assert.match(FUNCAO_NOVA, /\n {2}IF v_duracao NOT IN \('DEFINIDA', 'INDETERMINADA'\)\n/, 'a conferência é incondicional (nenhuma condição extra na frente)');
  assert.match(FUNCAO_NOVA, /v_duracao = 'INDETERMINADA' AND \(\(p_negotiation->>'prazoMeses'\) IS NOT NULL OR v_forma IS DISTINCT FROM 'RECORRENTE' OR v_per IS NULL\)/);
  assert.match(FUNCAO_NOVA, /v_duracao = 'DEFINIDA' AND \(\(p_negotiation->>'prazoMeses'\) IS NULL OR \(p_negotiation->>'avisoPrevioDias'\) IS NOT NULL\)/);
  assert.match(FUNCAO_NOVA, /RAISE EXCEPTION 'crm_negotiation_invalid_term: [^']+' USING ERRCODE = 'P0001'/);
  assert.match(FUNCAO_NOVA, /prazo_meses, duracao_tipo, aviso_previo_dias, forma_pagamento/);
  assert.match(FUNCAO_NOVA, /duracao_tipo = v_duracao,\n\s+aviso_previo_dias = \(p_negotiation->>'avisoPrevioDias'\)::INTEGER,/);
  // a validação vem antes de qualquer escrita
  assert.ok(FUNCAO_NOVA.indexOf('crm_negotiation_invalid_term') < FUNCAO_NOVA.indexOf('INSERT INTO public.crm_funnel_cards'));
  assert.ok(FUNCAO_NOVA.indexOf('crm_negotiation_invalid_term') < FUNCAO_NOVA.indexOf('UPDATE public.crm_negotiations'));
  // o adapter classifica o marcador como "banco recusou" (409 inválido), nunca como falha genérica
  const adapter = read('src', 'crm-adapters', 'crmSupabaseNegotiationRepository.js');
  assert.match(adapter, /crm_negotiation_\|crm_funnel_cards_integrity/);
});

test('[MIGD3-9] PRIVILÉGIOS: o REVOKE nominal (PUBLIC, anon, authenticated) e o GRANT só para service_role da função recriada, com a MESMA assinatura da D1.1; as tabelas, RLS e policies não são tocadas', () => {
  const corpo = comandos(SQL);
  assert.match(corpo, /REVOKE ALL ON FUNCTION public\.commit_crm_negotiation_change\(TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ\) FROM PUBLIC, anon, authenticated;/);
  assert.match(corpo, /GRANT EXECUTE ON FUNCTION public\.commit_crm_negotiation_change\(TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ\) TO service_role;/);
  assert.ok(D11.includes('REVOKE ALL ON FUNCTION public.commit_crm_negotiation_change(TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;'), 'a assinatura é a da D1.1');
  assert.equal((corpo.match(/\bGRANT\b/g) || []).length, 1, 'um único GRANT: nenhum privilégio novo a ninguém além de service_role');
  assert.doesNotMatch(corpo, /\bPOLICY\b|ENABLE ROW LEVEL|DISABLE ROW LEVEL|GRANT .* TO (anon|authenticated|PUBLIC)/i);
});

test('[MIGD3-10] NADA EXECUTA a migration: nenhum arquivo de src/ ou scripts/ a lê ou a cita, e o package.json não tem script de migration', () => {
  const citam = [];
  const varrer = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const caminho = path.join(dir, entrada.name);
      if (entrada.isDirectory()) varrer(caminho);
      else if (/\.(js|mjs|json|sh|ps1)$/.test(entrada.name) && fs.readFileSync(caminho, 'utf8').includes(NOME)) citam.push(path.relative(ROOT, caminho));
    }
  };
  for (const dir of ['src', 'scripts', 'dashboard']) if (fs.existsSync(path.join(ROOT, dir))) varrer(path.join(ROOT, dir));
  assert.deepEqual(citam, []);
  const pacote = JSON.parse(read('package.json'));
  assert.equal(Object.keys(pacote.scripts).some((nome) => /migrat/i.test(nome)), false);
  assert.equal(JSON.stringify(pacote.scripts).includes(NOME), false);
});

test('[MIGD3-11] a decisão 0032 e o README descrevem a migration como NÃO APLICADA e registram a escolha (TCV null, aviso prévio que não é duração, ordem segura e o procedimento da negociação real)', () => {
  const decisao = read('docs', 'decisions', '0032-indefinite-term-contracts.md');
  assert.match(decisao, /NÃO APLICADA/);
  assert.match(decisao, /20261021090000_crm_negotiation_indefinite_term\.sql/);
  assert.match(decisao, /TCV[^.]*indeterminado/i);
  assert.match(decisao, /aviso prévio/i);
  assert.match(decisao, /Procedimento[^\n]*negociação real/i);
  const readme = read('supabase', 'README.md');
  assert.ok(readme.includes(NOME));
  const trecho = readme.slice(readme.indexOf(NOME));
  assert.match(trecho.slice(0, 1600), /NÃO APLICADA/);
});
