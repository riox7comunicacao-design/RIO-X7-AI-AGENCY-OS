// A migration das Negociações (supabase/migrations/20261019090000_crm_negotiations.sql — Fase D1.1, decisão 0029). NÃO há PostgreSQL nesta fase: estes testes só LEEM o texto do arquivo e o confrontam com o código
// (os adapters e o PostgREST falso). O que garantem: é ADITIVA (não derruba nem altera dado existente), aborta se faltar um pré-requisito, dá RLS e privilégios mínimos, protege o histórico, impõe as regras
// financeiras e de situação NO banco, e os nomes das funções e dos parâmetros são EXATAMENTE os que os adapters chamam. A primeira execução num Postgres real é a homologação (supabase/README.md) — nenhum
// destes testes a substitui. Nada toca o banco; nada lê credencial.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const NOME = '20261019090000_crm_negotiations.sql';
const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', NOME), 'utf8').replace(/\r\n/g, '\n');
// o texto SEM comentários de linha (o que de fato executa)
const codigo = sql.replace(/^\s*--.*$/gm, '').replace(/\s--[^\n]*$/gm, '');
const norm = (texto) => texto.replace(/\s+/g, ' ').trim();
const corpoDe = (nomeFuncao) => {
  const inicio = codigo.indexOf(`CREATE FUNCTION public.${nomeFuncao}(`);
  assert.ok(inicio >= 0, nomeFuncao);
  const fim = codigo.indexOf('\n$$;', codigo.indexOf('AS $$', inicio));
  return codigo.slice(inicio, fim + 4);
};

test('[MIG-NEG-1] A migration é só uma proposta versionada: o cabeçalho diz NÃO APLICADA e "nunca exercitada num PostgreSQL real", lista os pré-requisitos e a ordem de implantação; e nada em src/ ou scripts/ a aplica', () => {
  assert.match(sql, /NÃO APLICADA/);
  assert.match(sql, /NUNCA foi exercitada num PostgreSQL real/);
  for (const prerequisito of ['20260927120000_crm_initial_schema', '20260928220000_crm_funnels', '20260929100000_crm_funnel_cards_funis2', '20261012090000_crm_catalogs', '20261018090000_crm_services_payment_modalities']) assert.match(sql, new RegExp(prerequisito));
  assert.match(sql, /ORDEM SEGURA DE IMPLANTAÇÃO/);
  assert.match(sql, /DESFAZER/);
  const buscar = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) buscar(completo);
      else if (/\.(js|mjs)$/.test(entrada.name)) assert.doesNotMatch(fs.readFileSync(completo, 'utf8'), /supabase[/\\]migrations/, completo);
    }
  };
  buscar(path.join(ROOT, 'src'));
  buscar(path.join(ROOT, 'scripts'));
});

test('[MIG-NEG-2] FAIL-CLOSED: o primeiro comando confere TODOS os pré-requisitos e ABORTA com a causa (nada é criado pela metade) — inclusive a re-aplicação por engano', () => {
  const primeiro = norm(codigo.slice(0, codigo.indexOf('CREATE TABLE')));
  assert.match(primeiro, /^DO \$\$ BEGIN/);
  for (const exigido of ['crm_records', 'crm_funnels', 'crm_funnel_stages', 'crm_funnel_cards', 'crm_funnel_card_moves', "column_name = 'removed_at'", 'crm_funnel_cards_active_unique_idx', 'crm_services', "column_name = 'permite_pagamento_unico'",
    "column_name = 'permite_pagamento_recorrente'", "column_name = 'periodicidades'", 'delete_crm_funnel_if_empty', 'delete_crm_funnel_stage_if_empty', 'crm_negotiations']) {
    assert.ok(primeiro.includes(exigido), `o bloco inicial confere ${exigido}`);
  }
  assert.ok((primeiro.match(/RAISE EXCEPTION/g) || []).length >= 7);
  assert.match(primeiro, /esta migration já foi aplicada/);
});

test('[MIG-NEG-3] ADITIVA: nenhuma tabela ou coluna existente é removida, nenhuma linha é lida/alterada/apagada/inserida fora das funções, e crm_records, crm_services, crm_niches, crm_lead_origins, crm_record_deletions e as Exclusões Permanentes não são tocados', () => {
  assert.doesNotMatch(codigo, /\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bTRUNCATE\b|\bDROP\s+SCHEMA\b|\bDROP\s+TYPE\b/i);
  const drops = [...codigo.matchAll(/\bDROP\s+(\w+)\s+([\w.]+)/gi)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(drops, ['INDEX public.crm_funnel_cards_active_unique_idx'], 'o ÚNICO drop é o do índice único dos cards avulsos, recriado logo em seguida');
  assert.match(codigo, /CREATE UNIQUE INDEX crm_funnel_cards_active_unique_idx\s+ON public\.crm_funnel_cards \(funnel_id, crm_record_id\)\s+WHERE removed_at IS NULL AND negotiation_id IS NULL;/);
  for (const alheia of ['crm_records', 'crm_services', 'crm_niches', 'crm_lead_origins', 'crm_record_deletions', 'prospecting_permanent_exclusions']) {
    assert.doesNotMatch(codigo, new RegExp(`ALTER\\s+TABLE\\s+(ONLY\\s+)?public\\.${alheia}\\b`, 'i'), alheia);
    assert.doesNotMatch(codigo, new RegExp(`(UPDATE|DELETE\\s+FROM|INSERT\\s+INTO)\\s+public\\.${alheia}\\b`, 'i'), alheia);
  }
  const alteradas = [...codigo.matchAll(/ALTER\s+TABLE\s+public\.(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(alteradas)].sort(), ['crm_funnel_cards', 'crm_negotiation_events', 'crm_negotiations'], 'só a tabela de cards (coluna nova e FK) e as duas novas (RLS)');
  // nenhuma linha é inserida/alterada/apagada FORA do corpo das funções (a migration não cria funis de exemplo nem nenhum dado comercial)
  const foraDasFuncoes = codigo.replace(/CREATE FUNCTION[\s\S]*?\n\$\$;/g, '');
  assert.doesNotMatch(foraDasFuncoes, /\bINSERT\s+INTO\b|\bUPDATE\s+public\.\w+\s+SET\b|\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(codigo, /\bcrm_funnel_cards\b[^;]*\bDROP\s+NOT\s+NULL/i);
});

test('[MIG-NEG-4] NEGOCIAÇÃO: chaves e relacionamentos (cliente, funil, card único, serviço), dinheiro em CENTAVOS (BIGINT, 1 a 1 bilhão de reais), prazo 1–120, formas e periodicidades fechadas, coerência pagamento × periodicidade × prazo e situação × motivo × fechamento, auditoria e índices', () => {
  const tabela = norm(codigo.slice(codigo.indexOf('CREATE TABLE public.crm_negotiations'), codigo.indexOf('CREATE INDEX crm_negotiations_crm_record_id_idx')));
  for (const trecho of [
    "id TEXT PRIMARY KEY CHECK (id ~ '^negotiation:[0-9a-f-]{36}$')",
    'crm_record_id TEXT NOT NULL REFERENCES public.crm_records (id)',
    'funnel_id TEXT NOT NULL REFERENCES public.crm_funnels (id)',
    'card_id TEXT NOT NULL UNIQUE REFERENCES public.crm_funnel_cards (id) DEFERRABLE INITIALLY DEFERRED',
    'service_id TEXT NOT NULL REFERENCES public.crm_services (id)',
    'valor_centavos BIGINT NOT NULL CHECK (valor_centavos BETWEEN 1 AND 100000000000)',
    'prazo_meses INTEGER NOT NULL CHECK (prazo_meses BETWEEN 1 AND 120)',
    "forma_pagamento TEXT NOT NULL CHECK (forma_pagamento IN ('UNICO', 'RECORRENTE'))",
    "periodicidade TEXT CHECK (periodicidade IS NULL OR periodicidade IN ('MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL'))",
    "situacao TEXT NOT NULL DEFAULT 'ABERTA' CHECK (situacao IN ('ABERTA', 'GANHA', 'PERDIDA'))",
    'created_by_user_id TEXT NOT NULL', 'updated_by_user_id TEXT NOT NULL', 'created_at TIMESTAMPTZ NOT NULL', 'updated_at TIMESTAMPTZ NOT NULL',
    "(forma_pagamento = 'UNICO' AND periodicidade IS NULL)",
    "prazo_meses % (CASE periodicidade WHEN 'MENSAL' THEN 1 WHEN 'TRIMESTRAL' THEN 3 WHEN 'SEMESTRAL' THEN 6 ELSE 12 END) = 0",
    "(situacao = 'ABERTA' AND motivo_perda IS NULL AND fechado_em IS NULL)",
    "(situacao = 'GANHA' AND motivo_perda IS NULL AND fechado_em IS NOT NULL)",
    "(situacao = 'PERDIDA' AND motivo_perda IS NOT NULL AND btrim(motivo_perda) <> '' AND fechado_em IS NOT NULL)",
  ]) assert.ok(tabela.includes(trecho), trecho);
  // dinheiro: nenhuma coluna monetária fora de centavos; nada de valor recebido, TCV ou MRR gravados; nenhum campo legado do CRM
  assert.doesNotMatch(tabela, /NUMERIC|DECIMAL|FLOAT|DOUBLE|\bMONEY\b|\btcv\b|\bmrr\b|valor_recebido|valor_proposta|valor_total/i);
  for (const indice of ['crm_negotiations_crm_record_id_idx', 'crm_negotiations_funnel_situacao_idx', 'crm_negotiations_service_id_idx', 'crm_negotiations_created_at_idx']) assert.match(codigo, new RegExp(indice));
  // o card guarda a negociação, e o índice único por negociação existe
  assert.match(codigo, /ADD COLUMN negotiation_id TEXT;/);
  assert.match(codigo, /FOREIGN KEY \(negotiation_id\) REFERENCES public\.crm_negotiations \(id\) DEFERRABLE INITIALLY DEFERRED/);
  assert.match(codigo, /CREATE UNIQUE INDEX crm_funnel_cards_negotiation_unique_idx ON public\.crm_funnel_cards \(negotiation_id\) WHERE negotiation_id IS NOT NULL;/);
});

test('[MIG-NEG-5] HISTÓRICO IMUTÁVEL E INTEGRIDADE: eventos com sequência única por negociação e tipos fechados; UPDATE/DELETE recusados por gatilho nos eventos E nos movimentos de card; a etapa é sempre do funil do card; funil/registro/negociação de um card e o funil de uma etapa nunca mudam; a ligação negociação ↔ card é conferida no COMMIT', () => {
  const eventos = norm(codigo.slice(codigo.indexOf('CREATE TABLE public.crm_negotiation_events'), codigo.indexOf('ALTER TABLE public.crm_negotiation_events')));
  assert.ok(eventos.includes('negotiation_id TEXT NOT NULL REFERENCES public.crm_negotiations (id)'));
  assert.ok(eventos.includes('UNIQUE (negotiation_id, seq)'));
  assert.ok(eventos.includes("tipo TEXT NOT NULL CHECK (tipo IN ('CRIADA', 'ATUALIZADA', 'ETAPA', 'GANHA', 'PERDIDA', 'REABERTA'))"));
  assert.match(codigo, /CREATE TRIGGER crm_negotiation_events_append_only\s+BEFORE UPDATE OR DELETE ON public\.crm_negotiation_events\s+FOR EACH ROW EXECUTE FUNCTION public\.crm_history_is_append_only\(\);/);
  assert.match(codigo, /CREATE TRIGGER crm_funnel_card_moves_append_only\s+BEFORE UPDATE OR DELETE ON public\.crm_funnel_card_moves\s+FOR EACH ROW EXECUTE FUNCTION public\.crm_history_is_append_only\(\);/);
  assert.match(corpoDe('crm_history_is_append_only'), /RAISE EXCEPTION '% é um histórico imutável: % não é permitido', TG_TABLE_NAME, TG_OP/);
  assert.match(codigo, /CREATE TRIGGER crm_funnel_cards_integrity_trigger\s+BEFORE INSERT OR UPDATE ON public\.crm_funnel_cards/);
  const integridade = norm(corpoDe('crm_funnel_cards_integrity'));
  assert.ok(integridade.includes('NEW.funnel_id IS DISTINCT FROM OLD.funnel_id') && integridade.includes('NEW.crm_record_id IS DISTINCT FROM OLD.crm_record_id') && integridade.includes('NEW.negotiation_id IS DISTINCT FROM OLD.negotiation_id'));
  assert.ok(integridade.includes('s.id = NEW.stage_id AND s.funnel_id = NEW.funnel_id'));
  assert.match(codigo, /CREATE TRIGGER crm_funnel_stages_integrity_trigger\s+BEFORE UPDATE ON public\.crm_funnel_stages/);
  assert.match(norm(corpoDe('crm_funnel_stages_integrity')), /NEW\.funnel_id IS DISTINCT FROM OLD\.funnel_id/);
  assert.match(codigo, /CREATE CONSTRAINT TRIGGER crm_negotiations_card_consistency_trigger\s+AFTER INSERT OR UPDATE ON public\.crm_negotiations\s+DEFERRABLE INITIALLY DEFERRED/);
  assert.ok(norm(corpoDe('crm_negotiations_card_consistency')).includes('c.negotiation_id = NEW.id AND c.funnel_id = NEW.funnel_id AND c.crm_record_id = NEW.crm_record_id'));
});

test('[MIG-NEG-6] ATOMICIDADE E FAIL-CLOSED NAS FUNÇÕES: uma função PL/pgSQL (uma transação) grava negociação + histórico + card + movimento; confere concorrência otimista, transições, etapa ativa do mesmo funil, cliente/funil/serviço, histórico que só cresce e que toda alteração acrescenta um evento; sem SECURITY DEFINER e com search_path fixo', () => {
  const principal = norm(corpoDe('commit_crm_negotiation_change'));
  for (const trecho of [
    "p_mode NOT IN ('create', 'update')",
    "RAISE EXCEPTION 'crm_negotiation_history: a negociação não traz o histórico obrigatório'",
    'FOR UPDATE', "RAISE EXCEPTION 'crm_negotiation_not_found'", "RAISE EXCEPTION 'crm_negotiation_conflict'", "date_trunc('milliseconds', v_cur.updated_at) <> date_trunc('milliseconds', p_expected_updated_at)",
    "RAISE EXCEPTION 'crm_negotiation_closed'", "RAISE EXCEPTION 'crm_negotiation_client_blocked'", "v_status = 'DO_NOT_CONTACT'", "RAISE EXCEPTION 'crm_negotiation_funnel_inactive'", "RAISE EXCEPTION 'crm_negotiation_stage_invalid'",
    'PERFORM public.crm_negotiation_service_check(', "RAISE EXCEPTION 'crm_negotiation_history: o histórico não pode encolher'", "RAISE EXCEPTION 'crm_negotiation_history: um evento já gravado não pode mudar'",
    "RAISE EXCEPTION 'crm_negotiation_history: toda alteração acrescenta um evento ao histórico'", 'INSERT INTO public.crm_funnel_cards', 'INSERT INTO public.crm_funnel_card_moves', 'INSERT INTO public.crm_negotiations', 'INSERT INTO public.crm_negotiation_events',
    'UPDATE public.crm_funnel_cards SET stage_id', 'AND ativo)',
  ]) assert.ok(principal.includes(trecho), trecho);
  for (const funcao of ['commit_crm_negotiation_change', 'commit_crm_funnel_card_change', 'reorder_crm_funnel_stages', 'crm_negotiation_service_check']) {
    const cabeca = norm(corpoDe(funcao));
    assert.ok(cabeca.includes('SET search_path = public, pg_temp'), `${funcao} fixa o search_path`);
    assert.doesNotMatch(cabeca, /SECURITY DEFINER/i, `${funcao} não eleva privilégios`);
  }
  // nenhum dado é apagado pelas funções (a negociação e o histórico nunca saem)
  assert.doesNotMatch(codigo, /DELETE\s+FROM/i);
  // o card avulso: criar ou mover com a concorrência da etapa esperada; só avulsos
  const card = norm(corpoDe('commit_crm_funnel_card_change'));
  assert.ok(card.includes("RAISE EXCEPTION 'crm_funnel_card_conflict'") && card.includes('v_card.negotiation_id IS NOT NULL') && card.includes('v_card.stage_id <> p_expected_stage_id'));
  const reordem = norm(corpoDe('reorder_crm_funnel_stages'));
  assert.ok(reordem.includes('a lista não confere com as etapas do funil') && reordem.includes('FOR UPDATE'));
});

test('[MIG-NEG-7] RLS E PRIVILÉGIOS MÍNIMOS: RLS ligada nas duas tabelas novas SEM policy; anon e authenticated sem acesso; as funções só para service_role (revogadas de PUBLIC); nenhuma policy, nenhum GRANT a anon/authenticated/PUBLIC', () => {
  for (const tabela of ['crm_negotiations', 'crm_negotiation_events']) assert.match(codigo, new RegExp(`ALTER TABLE public\\.${tabela} ENABLE ROW LEVEL SECURITY;`));
  assert.doesNotMatch(codigo, /CREATE\s+POLICY/i);
  assert.match(codigo, /REVOKE ALL ON TABLE public\.crm_negotiations, public\.crm_negotiation_events FROM anon;/);
  assert.match(codigo, /REVOKE ALL ON TABLE public\.crm_negotiations, public\.crm_negotiation_events FROM authenticated;/);
  const concessoes = [...codigo.matchAll(/GRANT\s+([^;]+?)\s+TO\s+([^;]+);/gi)].map((m) => `${norm(m[1])} -> ${norm(m[2])}`);
  assert.ok(concessoes.length === 4 && concessoes.every((c) => /^EXECUTE ON FUNCTION public\.\w+\([^)]*\) -> service_role$/.test(c)), concessoes.join(' | '));
  assert.doesNotMatch(codigo, /GRANT[^;]*\sTO\s[^;]*\b(anon|authenticated|PUBLIC)\b/); // (PUBLIC em maiúsculas: o schema `public` não conta)
  const revogadas = [...codigo.matchAll(/REVOKE ALL ON FUNCTION public\.(\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(revogadas, ['commit_crm_funnel_card_change', 'commit_crm_negotiation_change', 'crm_negotiation_service_check', 'reorder_crm_funnel_stages']);
});

test('[MIG-NEG-8] PARIDADE COM O CÓDIGO: os nomes das funções e dos parâmetros que os adapters chamam existem EXATAMENTE assim na migration; os marcadores de erro que os adapters reconhecem são os que a migration lança; a conta de centavos e os limites coincidem com o domínio', () => {
  const negociacao = fs.readFileSync(path.join(ROOT, 'src', 'crm-adapters', 'crmSupabaseNegotiationRepository.js'), 'utf8');
  const funil = fs.readFileSync(path.join(ROOT, 'src', 'crm-adapters', 'crmSupabaseFunnelRepository.js'), 'utf8');
  assert.match(negociacao, /COMMIT_RPC = 'commit_crm_negotiation_change'/);
  for (const parametro of ['p_mode', 'p_negotiation', 'p_card', 'p_card_move', 'p_expected_updated_at']) {
    assert.match(negociacao, new RegExp(`\\b${parametro}\\b`), `o adapter envia ${parametro}`);
    assert.match(norm(corpoDe('commit_crm_negotiation_change')).slice(0, 400), new RegExp(`\\b${parametro}\\b`), `a função declara ${parametro}`);
  }
  assert.match(funil, /card: 'commit_crm_funnel_card_change', reorder: 'reorder_crm_funnel_stages', deleteFunnel: 'delete_crm_funnel_if_empty', deleteStage: 'delete_crm_funnel_stage_if_empty'/);
  for (const parametro of ['p_card', 'p_card_move', 'p_expected_stage_id', 'p_funnel_id', 'p_ordered_ids', 'p_stage_id']) assert.match(funil, new RegExp(`\\b${parametro}\\b`), parametro);
  assert.match(norm(corpoDe('commit_crm_funnel_card_change')).slice(0, 300), /p_card JSONB, p_card_move JSONB, p_expected_stage_id TEXT/);
  assert.match(norm(corpoDe('reorder_crm_funnel_stages')).slice(0, 200), /p_funnel_id TEXT, p_ordered_ids TEXT\[\]/);
  // os campos do payload que o adapter monta são os que a função lê
  for (const campo of ['id', 'crmRecordId', 'funnelId', 'cardId', 'serviceId', 'servicoNome', 'responsavelUserId', 'responsavelNome', 'prazoMeses', 'formaPagamento', 'periodicidade', 'valorCentavos', 'previsaoFechamento', 'situacao', 'motivoPerda', 'fechadoEm',
    'criadoEm', 'atualizadoEm', 'criadoPorUserId', 'criadoPorNome', 'atualizadoPorUserId', 'atualizadoPorNome', 'eventos']) {
    assert.match(negociacao, new RegExp(`\\b${campo}\\b`), `o adapter envia ${campo}`);
    assert.ok(codigo.includes(`->>'${campo}'`) || codigo.includes(`->'${campo}'`), `a função lê ${campo}`);
  }
  // os marcadores de erro: cada classificação do adapter corresponde a um RAISE da migration
  for (const marcador of ['crm_negotiation_not_found', 'crm_negotiation_conflict', 'crm_negotiation_closed']) {
    assert.ok(negociacao.includes(marcador) && codigo.includes(`'${marcador}'`), marcador);
  }
  assert.ok(funil.includes('crm_funnel_card_conflict') && codigo.includes("'crm_funnel_card_conflict'"));
  assert.ok(funil.includes('crm_funnel_cards_integrity: a etapa') && codigo.includes('crm_funnel_cards_integrity: a etapa %'));
  for (const marcador of ['crm_negotiation_client_blocked', 'crm_negotiation_funnel_inactive', 'crm_negotiation_stage_invalid', 'crm_negotiation_service_inactive', 'crm_negotiation_service_forbids_payment', 'crm_negotiation_service_not_found']) assert.ok(codigo.includes(`'${marcador}'`), marcador);
  // limites idênticos ao domínio (centavos e prazo)
  const { LIMITS } = require('../../src/crm/negotiationFinance');
  assert.ok(codigo.includes(`BETWEEN 1 AND ${LIMITS.VALOR_MAXIMO_CENTAVOS}`));
  assert.ok(codigo.includes(`BETWEEN ${LIMITS.PRAZO_MINIMO} AND ${LIMITS.PRAZO_MAXIMO}`));
  assert.match(negociacao, /MAX_CENTS = 100_000_000_000/);
});
