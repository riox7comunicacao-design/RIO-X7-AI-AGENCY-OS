-- ============================================================================================================
-- CRM — CONTRATOS RECORRENTES POR PRAZO INDETERMINADO (CRM 5.0, Fase D3 — decisão 0032)
-- ============================================================================================================
-- NÃO APLICADA. Este arquivo é só a proposta versionada (ver tests/db/crmNegotiationIndefiniteTermMigration.test.js, que só lê este texto).
-- Aplicar é uma ação humana e consciente do proprietário, depois de revisar este arquivo, SÓ na ordem descrita abaixo e numa transação.
-- O estado real do banco NÃO foi consultado por este arquivo nem pelos testes. NUNCA foi exercitada num PostgreSQL real: os testes leem o texto e exercitam um PostgREST FALSO
-- que emula as mesmas regras; a primeira execução real é a homologação (supabase/README.md).
--
-- POR QUÊ: a D1.1 obriga todo contrato a ter um prazo em meses (prazo_meses NOT NULL, 1 a 120) e calcula o TCV como valor x número de cobranças. Um contrato recorrente SEM prazo final (por exemplo,
-- cobrança mensal de R$ 1.350,00, cancelável com aviso prévio de 30 dias) não cabe: o formulário obrigava a escolher 12 meses e mostrava um TCV fictício de R$ 16.200,00.
--
-- PRÉ-REQUISITO (o primeiro comando abaixo confere e ABORTA, citando o que falta): a D1.1 (20261019090000_crm_negotiations.sql) aplicada — a tabela crm_negotiations e a função commit_crm_negotiation_change.
--
-- O QUE ESTA MIGRATION FAZ (aditiva: nenhuma tabela, coluna, linha, privilégio ou evento existente é removido ou alterado; nenhum dado é reescrito):
--   1) crm_negotiations + duracao_tipo        'DEFINIDA' (o padrão: toda negociação que já existe) ou 'INDETERMINADA'.
--   2) crm_negotiations + aviso_previo_dias   inteiro de 1 a 365, opcional, SÓ no contrato indeterminado. É uma condição do contrato: NÃO é duração, período mínimo nem cobrança adicional.
--   3) crm_negotiations.prazo_meses           deixa de ser NOT NULL (o contrato indeterminado não tem prazo). O CHECK 1..120 continua valendo para todo valor informado.
--   4) crm_negotiations_pagamento_coerente    é SUBSTITUÍDA por uma regra que cobre as duas durações: DEFINIDA = prazo informado, sem aviso prévio e a coerência de sempre (único sem periodicidade; recorrente
--                                             com prazo múltiplo da periodicidade); INDETERMINADA = sem prazo, SÓ recorrente, com periodicidade. Todas as linhas existentes satisfazem a regra nova.
--   5) commit_crm_negotiation_change          é recriada (CREATE OR REPLACE, mesma assinatura): grava e atualiza duracao_tipo e aviso_previo_dias e recusa uma duração incoerente (crm_negotiation_invalid_term).
--                                             O restante do corpo é o da D1.1, sem alteração (concorrência otimista, histórico que só cresce, transições, etapa, serviço). Os privilégios são refeitos nominalmente.
-- O TCV, o MRR e o equivalente mensal continuam NÃO sendo gravados: derivam do contrato no servidor. TCV indeterminado é representado pela AUSÊNCIA de prazo (nunca por zero).
-- crm_records, crm_services, funis, etapas, cards, catálogos e Exclusões Permanentes NÃO são tocados.
--
-- COMPATIBILIDADE: o servidor NOVO lê um banco SEM esta migration (as colunas ausentes valem como DEFINIDA, sem aviso) e continua gravando contratos de prazo definido; gravar um contrato indeterminado nele
-- é recusado pelo banco antigo (prazo_meses NOT NULL) e o painel mostra erro — nunca grava errado. O servidor ANTIGO lê um banco COM esta migration, mas não mostra a duração indeterminada.
--
-- ORDEM SEGURA DE IMPLANTAÇÃO:
--   a) ANTES (somente leitura): a D1.1 existe e a coluna duracao_tipo ainda NÃO existe;
--   b) PARAR o servidor (o ALTER TABLE pede um bloqueio exclusivo curto em crm_negotiations; assim nada grava no meio);
--   c) aplicar ESTA migration numa transação (BEGIN; ... COMMIT;) — se algo falhar, ROLLBACK e nada muda;
--   d) NOTIFY pgrst, 'reload schema'; (se o PostgREST ainda não enxergar as colunas novas);
--   e) DEPOIS (somente leitura): colunas, restrição, função e privilégios; contagens e conteúdo das negociações e dos eventos IGUAIS ao ANTES;
--   f) subir o servidor NOVO e, pela interface, o ADMIN corrige a negociação real (docs/decisions/0032-indefinite-term-contracts.md).
--
-- DESFAZER (fora do arquivo; só enquanto NENHUM contrato indeterminado existir — com um, o NOT NULL de prazo_meses não volta e a negociação perderia a informação):
--   ALTER TABLE public.crm_negotiations DROP CONSTRAINT crm_negotiations_pagamento_coerente;  e recriar a regra da D1.1 (20261019090000);  ALTER TABLE public.crm_negotiations ALTER COLUMN prazo_meses SET NOT NULL;
--   ALTER TABLE public.crm_negotiations DROP COLUMN aviso_previo_dias, DROP COLUMN duracao_tipo;  e recriar commit_crm_negotiation_change com o texto da D1.1 (e refazer o REVOKE/GRANT nominal).
-- ============================================================================================================

-- ------------------------------------------------------------------------------------------------------------
-- 0) PRÉ-REQUISITOS — aborta citando o que falta, ou se esta migration já foi aplicada. Nada é alterado se aqui falhar.
-- ------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.crm_negotiations') IS NULL OR to_regclass('public.crm_negotiation_events') IS NULL THEN
    RAISE EXCEPTION 'pré-requisito ausente: negociações (20261019090000_crm_negotiations.sql)';
  END IF;
  IF to_regprocedure('public.commit_crm_negotiation_change(text,jsonb,jsonb,jsonb,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'pré-requisito ausente: a função commit_crm_negotiation_change (20261019090000_crm_negotiations.sql)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'crm_negotiations' AND column_name IN ('duracao_tipo', 'aviso_previo_dias')
  ) THEN
    RAISE EXCEPTION 'esta migration já foi aplicada (crm_negotiations tem duracao_tipo/aviso_previo_dias): nada foi alterado';
  END IF;
END
$$;

-- ------------------------------------------------------------------------------------------------------------
-- 1) COLUNAS NOVAS e o prazo opcional
-- ------------------------------------------------------------------------------------------------------------
ALTER TABLE public.crm_negotiations
  ADD COLUMN duracao_tipo      TEXT NOT NULL DEFAULT 'DEFINIDA' CHECK (duracao_tipo IN ('DEFINIDA', 'INDETERMINADA')),
  ADD COLUMN aviso_previo_dias INTEGER CHECK (aviso_previo_dias IS NULL OR aviso_previo_dias BETWEEN 1 AND 365);

ALTER TABLE public.crm_negotiations ALTER COLUMN prazo_meses DROP NOT NULL;

-- ------------------------------------------------------------------------------------------------------------
-- 2) A COERÊNCIA do contrato, agora para as duas durações (substitui a da D1.1; as linhas existentes — todas DEFINIDA, com prazo e sem aviso prévio — a satisfazem)
--    Todas as colunas lidas são NOT NULL, menos prazo_meses/periodicidade/aviso_previo_dias, que sempre aparecem dentro de IS [NOT] NULL: nenhuma comparação vira "desconhecido" e passa em falso.
-- ------------------------------------------------------------------------------------------------------------
ALTER TABLE public.crm_negotiations DROP CONSTRAINT crm_negotiations_pagamento_coerente;
ALTER TABLE public.crm_negotiations
  ADD CONSTRAINT crm_negotiations_pagamento_coerente CHECK (
    -- duração DEFINIDA: o prazo existe, não há aviso prévio e vale a coerência de sempre
    (duracao_tipo = 'DEFINIDA' AND prazo_meses IS NOT NULL AND aviso_previo_dias IS NULL AND (
      (forma_pagamento = 'UNICO' AND periodicidade IS NULL)
      OR (forma_pagamento = 'RECORRENTE' AND periodicidade IS NOT NULL
          AND prazo_meses % (CASE periodicidade WHEN 'MENSAL' THEN 1 WHEN 'TRIMESTRAL' THEN 3 WHEN 'SEMESTRAL' THEN 6 ELSE 12 END) = 0)
    ))
    -- duração INDETERMINADA: sem prazo, só recorrente, com periodicidade (o aviso prévio é opcional)
    OR (duracao_tipo = 'INDETERMINADA' AND prazo_meses IS NULL AND forma_pagamento = 'RECORRENTE' AND periodicidade IS NOT NULL)
  );

COMMENT ON COLUMN public.crm_negotiations.duracao_tipo IS 'DEFINIDA (prazo em meses) ou INDETERMINADA (sem prazo final: recorrente, até alguém cancelar). TCV indeterminado = sem prazo, nunca zero.';
COMMENT ON COLUMN public.crm_negotiations.aviso_previo_dias IS 'Aviso prévio de cancelamento, em dias (1 a 365), só no contrato indeterminado. Condição do contrato: não é duração, período mínimo nem cobrança adicional.';
COMMENT ON COLUMN public.crm_negotiations.prazo_meses IS 'Prazo do contrato em meses (1 a 120). NULL só na duração INDETERMINADA.';

-- ------------------------------------------------------------------------------------------------------------
-- 3) A FUNÇÃO TRANSACIONAL (D1.1) com a duração e o aviso prévio — corpo igual ao da D1.1 fora dos trechos da duração
-- ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.commit_crm_negotiation_change(
  p_mode TEXT,
  p_negotiation JSONB,
  p_card JSONB,
  p_card_move JSONB,
  p_expected_updated_at TIMESTAMPTZ
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id TEXT;
  v_cur public.crm_negotiations%ROWTYPE;
  v_card public.crm_funnel_cards%ROWTYPE;
  v_sit TEXT;
  v_given INTEGER;
  v_stored INTEGER;
  v_ev JSONB;
  v_i INTEGER;
  v_row public.crm_negotiation_events%ROWTYPE;
  v_valor BIGINT;
  v_forma TEXT;
  v_per TEXT;
  v_service TEXT;
  v_funnel public.crm_funnels%ROWTYPE;
  v_status TEXT;
  v_duracao TEXT;
BEGIN
  IF p_card = 'null'::JSONB THEN p_card := NULL; END IF; -- (um JSON null vale como ausente)
  IF p_card_move = 'null'::JSONB THEN p_card_move := NULL; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('create', 'update') THEN
    RAISE EXCEPTION 'commit_crm_negotiation_change: modo inválido' USING ERRCODE = '22023';
  END IF;
  IF p_negotiation IS NULL OR jsonb_typeof(p_negotiation) <> 'object' OR (p_negotiation->>'id') IS NULL THEN
    RAISE EXCEPTION 'commit_crm_negotiation_change: negociação inválida' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_negotiation->'eventos') IS DISTINCT FROM 'array' OR jsonb_array_length(p_negotiation->'eventos') = 0 THEN
    RAISE EXCEPTION 'crm_negotiation_history: a negociação não traz o histórico obrigatório' USING ERRCODE = 'P0001';
  END IF;
  IF (p_card IS NULL) <> (p_card_move IS NULL) THEN
    RAISE EXCEPTION 'commit_crm_negotiation_change: o card e o movimento do card vêm juntos' USING ERRCODE = '22023';
  END IF;
  v_id := p_negotiation->>'id';
  v_given := jsonb_array_length(p_negotiation->'eventos');
  v_sit := p_negotiation->>'situacao';
  v_valor := (p_negotiation->>'valorCentavos')::BIGINT;
  v_forma := p_negotiation->>'formaPagamento';
  v_per := p_negotiation->>'periodicidade';
  v_service := p_negotiation->>'serviceId';
  v_duracao := COALESCE(p_negotiation->>'duracao', 'DEFINIDA'); -- uma carga sem o campo (cliente anterior à D3) vale como DEFINIDA
  IF v_duracao NOT IN ('DEFINIDA', 'INDETERMINADA')
     OR (v_duracao = 'INDETERMINADA' AND ((p_negotiation->>'prazoMeses') IS NOT NULL OR v_forma IS DISTINCT FROM 'RECORRENTE' OR v_per IS NULL))
     OR (v_duracao = 'DEFINIDA' AND ((p_negotiation->>'prazoMeses') IS NULL OR (p_negotiation->>'avisoPrevioDias') IS NOT NULL)) THEN
    RAISE EXCEPTION 'crm_negotiation_invalid_term: a duração do contrato não é coerente com o prazo, o aviso prévio e a forma de pagamento' USING ERRCODE = 'P0001';
  END IF;

  IF p_mode = 'create' THEN
    IF p_card IS NULL THEN
      RAISE EXCEPTION 'commit_crm_negotiation_change: criar exige o card e o primeiro movimento' USING ERRCODE = '22023';
    END IF;
    IF v_sit <> 'ABERTA' OR v_given <> 1 OR (p_negotiation->'eventos'->0->>'tipo') <> 'CRIADA' THEN
      RAISE EXCEPTION 'crm_negotiation_history: uma negociação nasce ABERTA com o histórico [CRIADA]' USING ERRCODE = 'P0001';
    END IF;
    IF (p_card->>'negotiationId') <> v_id OR (p_card->>'id') <> (p_negotiation->>'cardId') OR (p_card->>'funnelId') <> (p_negotiation->>'funnelId')
       OR (p_card->>'crmRecordId') <> (p_negotiation->>'crmRecordId') OR (p_card_move->>'cardId') <> (p_card->>'id') OR (p_card_move->>'stageTo') <> (p_card->>'stageId')
       OR (p_card_move->>'stageFrom') IS NOT NULL THEN
      RAISE EXCEPTION 'crm_negotiation_immutable: o card não corresponde à negociação' USING ERRCODE = 'P0001';
    END IF;
    -- as referências: cliente que aceita negociação, funil ativo, etapa ativa do funil, serviço ativo que permite a forma de pagamento
    SELECT status INTO v_status FROM public.crm_records WHERE id = p_negotiation->>'crmRecordId';
    IF NOT FOUND OR v_status = 'DO_NOT_CONTACT' THEN
      RAISE EXCEPTION 'crm_negotiation_client_blocked' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_funnel FROM public.crm_funnels WHERE id = p_negotiation->>'funnelId';
    IF NOT FOUND OR v_funnel.ativo IS NOT TRUE THEN
      RAISE EXCEPTION 'crm_negotiation_funnel_inactive' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.crm_funnel_stages WHERE id = p_card->>'stageId' AND funnel_id = p_negotiation->>'funnelId' AND ativo) THEN
      RAISE EXCEPTION 'crm_negotiation_stage_invalid' USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.crm_negotiation_service_check(v_service, v_forma, v_per, true);

    INSERT INTO public.crm_funnel_cards (id, funnel_id, stage_id, crm_record_id, negotiation_id, criado_em, updated_at)
    VALUES (p_card->>'id', p_card->>'funnelId', p_card->>'stageId', p_card->>'crmRecordId', v_id, (p_card->>'criadoEm')::TIMESTAMPTZ, (p_card->>'updatedAt')::TIMESTAMPTZ);
    INSERT INTO public.crm_funnel_card_moves (card_id, stage_from, stage_to, moved_by_user_id, moved_by_name, moved_by_role, motivo, moved_at)
    VALUES (p_card_move->>'cardId', NULL, p_card_move->>'stageTo', p_card_move#>>'{movedBy,userId}', p_card_move#>>'{movedBy,name}', p_card_move#>>'{movedBy,role}',
            NULLIF(p_card_move->>'motivo', ''), (p_card_move->>'movedAt')::TIMESTAMPTZ);
    INSERT INTO public.crm_negotiations (id, crm_record_id, funnel_id, card_id, service_id, servico_nome, responsavel_user_id, responsavel_nome, prazo_meses, duracao_tipo, aviso_previo_dias, forma_pagamento,
                                         periodicidade, valor_centavos, previsao_fechamento, situacao, motivo_perda, fechado_em, created_at, updated_at,
                                         created_by_user_id, created_by_name, updated_by_user_id, updated_by_name)
    VALUES (v_id, p_negotiation->>'crmRecordId', p_negotiation->>'funnelId', p_negotiation->>'cardId', v_service, p_negotiation->>'servicoNome',
            p_negotiation->>'responsavelUserId', p_negotiation->>'responsavelNome', (p_negotiation->>'prazoMeses')::INTEGER, v_duracao, (p_negotiation->>'avisoPrevioDias')::INTEGER, v_forma, v_per, v_valor,
            (p_negotiation->>'previsaoFechamento')::DATE, v_sit, p_negotiation->>'motivoPerda', (p_negotiation->>'fechadoEm')::TIMESTAMPTZ,
            (p_negotiation->>'criadoEm')::TIMESTAMPTZ, (p_negotiation->>'atualizadoEm')::TIMESTAMPTZ,
            p_negotiation->>'criadoPorUserId', p_negotiation->>'criadoPorNome', p_negotiation->>'atualizadoPorUserId', p_negotiation->>'atualizadoPorNome');
    v_ev := p_negotiation->'eventos'->0;
    INSERT INTO public.crm_negotiation_events (negotiation_id, seq, tipo, em, por_user_id, por_nome, detalhe)
    VALUES (v_id, 0, v_ev->>'tipo', (v_ev->>'em')::TIMESTAMPTZ, v_ev->>'porUserId', v_ev->>'porNome', v_ev->'detalhe');
    RETURN;
  END IF;

  -- ---- update ----
  SELECT * INTO v_cur FROM public.crm_negotiations WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'crm_negotiation_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_updated_at IS NULL OR date_trunc('milliseconds', v_cur.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) THEN
    RAISE EXCEPTION 'crm_negotiation_conflict' USING ERRCODE = 'P0001';
  END IF;
  IF v_cur.crm_record_id <> (p_negotiation->>'crmRecordId') OR v_cur.funnel_id <> (p_negotiation->>'funnelId') OR v_cur.card_id <> (p_negotiation->>'cardId')
     OR v_cur.created_by_user_id <> (p_negotiation->>'criadoPorUserId')
     OR date_trunc('milliseconds', v_cur.created_at) <> date_trunc('milliseconds', (p_negotiation->>'criadoEm')::TIMESTAMPTZ) THEN
    RAISE EXCEPTION 'crm_negotiation_immutable: cliente, funil, card e autoria da criação nunca mudam' USING ERRCODE = 'P0001';
  END IF;
  IF v_cur.situacao <> 'ABERTA' AND v_sit <> 'ABERTA' THEN
    RAISE EXCEPTION 'crm_negotiation_closed' USING ERRCODE = 'P0001'; -- uma negociação fechada só muda por REABRIR
  END IF;
  IF p_card IS NOT NULL AND (v_cur.situacao <> 'ABERTA' OR v_sit <> 'ABERTA') THEN
    RAISE EXCEPTION 'crm_negotiation_closed' USING ERRCODE = 'P0001'; -- só uma negociação aberta muda de etapa
  END IF;
  IF v_service <> v_cur.service_id OR v_forma <> v_cur.forma_pagamento OR v_per IS DISTINCT FROM v_cur.periodicidade THEN
    PERFORM public.crm_negotiation_service_check(v_service, v_forma, v_per, v_service <> v_cur.service_id);
  END IF;

  -- o histórico só CRESCE: nenhum evento some e nenhum evento já gravado muda
  SELECT count(*) INTO v_stored FROM public.crm_negotiation_events WHERE negotiation_id = v_id;
  IF v_given < v_stored THEN
    RAISE EXCEPTION 'crm_negotiation_history: o histórico não pode encolher' USING ERRCODE = 'P0001';
  END IF;
  FOR v_i IN 0 .. v_stored - 1 LOOP
    v_ev := p_negotiation->'eventos'->v_i;
    SELECT * INTO v_row FROM public.crm_negotiation_events WHERE negotiation_id = v_id AND seq = v_i;
    IF NOT FOUND OR v_row.tipo <> (v_ev->>'tipo') OR v_row.por_user_id <> (v_ev->>'porUserId') OR v_row.por_nome <> (v_ev->>'porNome')
       OR date_trunc('milliseconds', v_row.em) <> date_trunc('milliseconds', (v_ev->>'em')::TIMESTAMPTZ) OR v_row.detalhe IS DISTINCT FROM (v_ev->'detalhe') THEN
      RAISE EXCEPTION 'crm_negotiation_history: um evento já gravado não pode mudar' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- uma gravação que muda a negociação TEM de acrescentar ao histórico (o evento obrigatório): nada de update "silencioso"
  IF v_given = v_stored THEN
    RAISE EXCEPTION 'crm_negotiation_history: toda alteração acrescenta um evento ao histórico' USING ERRCODE = 'P0001';
  END IF;

  IF p_card IS NOT NULL THEN
    SELECT * INTO v_card FROM public.crm_funnel_cards WHERE id = v_cur.card_id FOR UPDATE;
    IF NOT FOUND OR v_card.negotiation_id IS DISTINCT FROM v_id OR v_card.removed_at IS NOT NULL OR (p_card->>'id') <> v_cur.card_id
       OR (p_card_move->>'cardId') <> v_cur.card_id OR (p_card_move->>'stageFrom') IS DISTINCT FROM v_card.stage_id OR (p_card_move->>'stageTo') <> (p_card->>'stageId')
       OR (p_card->>'stageId') = v_card.stage_id THEN
      RAISE EXCEPTION 'crm_negotiation_stage_invalid: o card não confere com a mudança de etapa' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.crm_funnel_stages WHERE id = p_card->>'stageId' AND funnel_id = v_cur.funnel_id AND ativo) THEN
      RAISE EXCEPTION 'crm_negotiation_stage_invalid' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.crm_funnel_cards SET stage_id = p_card->>'stageId' WHERE id = v_cur.card_id;
    INSERT INTO public.crm_funnel_card_moves (card_id, stage_from, stage_to, moved_by_user_id, moved_by_name, moved_by_role, motivo, moved_at)
    VALUES (v_cur.card_id, v_card.stage_id, p_card_move->>'stageTo', p_card_move#>>'{movedBy,userId}', p_card_move#>>'{movedBy,name}', p_card_move#>>'{movedBy,role}',
            NULLIF(p_card_move->>'motivo', ''), (p_card_move->>'movedAt')::TIMESTAMPTZ);
  END IF;

  UPDATE public.crm_negotiations SET
    service_id = v_service,
    servico_nome = p_negotiation->>'servicoNome',
    prazo_meses = (p_negotiation->>'prazoMeses')::INTEGER,
    duracao_tipo = v_duracao,
    aviso_previo_dias = (p_negotiation->>'avisoPrevioDias')::INTEGER,
    forma_pagamento = v_forma,
    periodicidade = v_per,
    valor_centavos = v_valor,
    previsao_fechamento = (p_negotiation->>'previsaoFechamento')::DATE,
    situacao = v_sit,
    motivo_perda = p_negotiation->>'motivoPerda',
    fechado_em = (p_negotiation->>'fechadoEm')::TIMESTAMPTZ,
    updated_at = (p_negotiation->>'atualizadoEm')::TIMESTAMPTZ,
    updated_by_user_id = p_negotiation->>'atualizadoPorUserId',
    updated_by_name = p_negotiation->>'atualizadoPorNome'
  WHERE id = v_id;
  FOR v_i IN v_stored .. v_given - 1 LOOP
    v_ev := p_negotiation->'eventos'->v_i;
    INSERT INTO public.crm_negotiation_events (negotiation_id, seq, tipo, em, por_user_id, por_nome, detalhe)
    VALUES (v_id, v_i, v_ev->>'tipo', (v_ev->>'em')::TIMESTAMPTZ, v_ev->>'porUserId', v_ev->>'porNome', v_ev->'detalhe');
  END LOOP;
END;
$$;

-- Cards AVULSOS (sem negociação): criar (card + primeiro movimento) ou mover (card + movimento), numa única transação.
--   p_card         { id, funnelId, stageId, crmRecordId, criadoEm, updatedAt }
--   p_card_move    { cardId, stageFrom, stageTo, movedBy: { userId, name, role }, motivo, movedAt }
--   p_expected_stage_id  NULL = criar; senão, mover: o card tem de estar AGORA nessa etapa (concorrência) e não ter negociação.

-- ------------------------------------------------------------------------------------------------------------
-- 4) PRIVILÉGIOS: o CREATE OR REPLACE preserva os existentes, mas a revogação é refeita NOMINALMENTE (PUBLIC, anon e authenticated) e o EXECUTE volta só para service_role
-- ------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.commit_crm_negotiation_change(TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_crm_negotiation_change(TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ) TO service_role;
