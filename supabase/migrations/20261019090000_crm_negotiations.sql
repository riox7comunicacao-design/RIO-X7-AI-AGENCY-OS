-- ============================================================================================================
-- CRM — NEGOCIAÇÕES e a PERSISTÊNCIA OFICIAL de Funis/Cards no Supabase (CRM 5.0, Fase D1.1 — decisão 0029)
-- ============================================================================================================
-- NÃO APLICADA. Este arquivo é só a proposta versionada (ver tests/db/crmNegotiationsMigration.test.js, que só lê este texto). Aplicar é uma
-- ação humana e consciente do proprietário, depois de revisar este arquivo, SÓ na ordem descrita abaixo e numa transação. O estado real do banco
-- NÃO foi consultado por este arquivo nem pelos testes. NUNCA foi exercitada num PostgreSQL real (nenhum estava disponível na fase): os testes leem
-- o texto e exercitam um PostgREST FALSO que emula as mesmas regras; a primeira execução real é a da homologação (supabase/README.md).
--
-- PRÉ-REQUISITOS (o primeiro comando abaixo confere e ABORTA, citando o que falta — nada é criado pela metade):
--   20260927120000_crm_initial_schema.sql           crm_records                         (documentada como APLICADA)
--   20260928220000_crm_funnels.sql                  funis, etapas, cards, movimentos     (sem registro de aplicação: conferir com o ANTES)
--   20260929100000_crm_funnel_cards_funis2.sql      arquivamento de cards (removed_at)   (sem registro de aplicação: conferir com o ANTES)
--   20261012090000_crm_catalogs.sql                 crm_services                          (aplicada na ativação dos catálogos)
--   20261018090000_crm_services_payment_modalities  modalidades do serviço                (aplicada na ativação da C1)
-- As duas de Funis (2.ª e 3.ª) são versionadas e testadas desde as etapas "Funis 1/2" e, se o ANTES mostrar que ainda NÃO existem, são aplicadas
-- ANTES desta, uma de cada vez. Esta migration NÃO as repete nem as substitui.
--
-- O QUE ESTA MIGRATION FAZ (aditiva: nenhuma tabela, coluna, dado ou privilégio existente é removido; crm_records, crm_services, crm_niches,
-- crm_lead_origins e as Exclusões Permanentes NÃO são tocados):
--   1) crm_negotiations         a negociação: UM cliente (crm_records) por UM serviço (crm_services), num funil, com prazo, forma de pagamento,
--                               periodicidade, valor em CENTAVOS (inteiro), situação e previsão de fechamento. O nome do serviço é uma FOTO (o
--                               serviço continua sendo referenciado por id, e crm_services nunca é apagado: a identidade histórica fica).
--   2) crm_negotiation_events   o histórico IMUTÁVEL (append-only: UPDATE e DELETE são recusados por gatilho).
--   3) crm_funnel_cards         + negotiation_id (o card de uma negociação); o índice único "um card ativo por (funil, registro)" passa a valer SÓ
--                               para os cards SEM negociação (um cliente pode ter várias negociações no mesmo funil); gatilho de integridade
--                               (a etapa é do funil do card; funil, registro e negociação de um card nunca mudam).
--   4) crm_funnel_stages        gatilho: o funil de uma etapa nunca muda (nenhuma escrita cruzada entre funis).
--   5) crm_funnel_card_moves    gatilho: histórico IMUTÁVEL.
--   6) FUNÇÕES (só service_role; SECURITY INVOKER; search_path fixo): commit_crm_negotiation_change (a negociação + o histórico + o card + o
--      movimento do card, numa ÚNICA transação), commit_crm_funnel_card_change (idem para cards avulsos) e reorder_crm_funnel_stages.
--   7) RLS ligada, SEM policy, e privilégios de anon/authenticated REVOGADOS: só o servidor (service_role) acessa. O Dashboard nunca fala com estas
--      tabelas: fala com a CRM-API, que autentica e aplica o RBAC (READ/PROPOSE/WRITE:CRM e MANAGE:FUNNELS) ANTES de chegar aqui.
--
-- ATOMICIDADE: a gravação de uma negociação e do seu histórico obrigatório é UMA chamada (uma função PL/pgSQL é uma transação): ou tudo vale, ou
-- nada. Não existe "negociação gravada sem o evento" nem "evento sem a negociação". A função confere, ainda, a concorrência otimista (o
-- `updated_at` esperado), as transições de situação, que a etapa de destino é ATIVA e do mesmo funil, que cliente "Não Contatar", funil inativo e
-- serviço inativo/sem a forma de pagamento escolhida NÃO recebem negociação nova, e que o histórico só cresce (nunca encolhe nem muda).
--
-- DINHEIRO: valor_centavos BIGINT (1 a 1 bilhão de reais). TCV, MRR e equivalente mensal NÃO são gravados: derivam do contrato (prazo, forma,
-- periodicidade, valor) no servidor. Nenhum valor recebido, nenhuma cobrança, nenhum valorProposta/valorTotal legado é lido ou escrito aqui.
--
-- ORDEM SEGURA DE IMPLANTAÇÃO (um servidor local; o painel atual já funciona; a D1 ainda não foi publicada):
--   a) ANTES (somente leitura): quais tabelas/colunas/funções dos pré-requisitos existem (supabase/README.md);
--   b) se faltar uma das migrations de Funis: aplicá-la(s), na ordem, uma de cada vez, e conferir;
--   c) PARAR o servidor atual (assim nada grava entre a migration e a subida do novo);
--   d) aplicar ESTA migration numa transação (BEGIN; ... COMMIT;) — se algo falhar, ROLLBACK e nada muda;
--   e) NOTIFY pgrst, 'reload schema'; (se o PostgREST ainda não enxergar as tabelas/funções novas);
--   f) DEPOIS (somente leitura): estrutura criada, 0 linhas nas tabelas novas, contagens antigas iguais;
--   g) publicar o commit e subir o servidor NOVO (REPOSITORY_MODE=supabase); Ctrl+F5 no painel;
--   h) o ADMIN cria o funil e as etapas pelo painel (nenhum dado de exemplo existe).
-- Subir o servidor NOVO antes desta migration faz o quadro falhar com erro claro (nunca com lista vazia): o PostgREST recusa as tabelas ausentes.
--
-- DESFAZER (fora do arquivo; só se nada comercial real foi gravado ainda — as tabelas novas estão vazias):
--   DROP FUNCTION public.reorder_crm_funnel_stages(TEXT, TEXT[]); DROP FUNCTION public.commit_crm_funnel_card_change(JSONB, JSONB, TEXT);
--   DROP FUNCTION public.commit_crm_negotiation_change(TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ); DROP FUNCTION public.crm_negotiation_service_check(TEXT, TEXT, TEXT, BOOLEAN);
--   ALTER TABLE public.crm_funnel_cards DROP COLUMN negotiation_id; (derruba também o índice e a FK)  DROP TABLE public.crm_negotiation_events, public.crm_negotiations;
--   DROP TRIGGER crm_funnel_card_moves_append_only ON public.crm_funnel_card_moves; DROP TRIGGER crm_funnel_stages_integrity_trigger ON public.crm_funnel_stages;
--   DROP TRIGGER crm_funnel_cards_integrity_trigger ON public.crm_funnel_cards; e recriar crm_funnel_cards_active_unique_idx como em 20260929100000.
-- ============================================================================================================

-- ------------------------------------------------------------------------------------------------------------
-- 0) PRÉ-REQUISITOS — conferidos antes de qualquer criação (fail-closed)
-- ------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.crm_records') IS NULL THEN
    RAISE EXCEPTION 'pré-requisito ausente: crm_records (20260927120000_crm_initial_schema.sql)';
  END IF;
  IF to_regclass('public.crm_funnels') IS NULL OR to_regclass('public.crm_funnel_stages') IS NULL OR to_regclass('public.crm_funnel_cards') IS NULL OR to_regclass('public.crm_funnel_card_moves') IS NULL THEN
    RAISE EXCEPTION 'pré-requisito ausente: funis, etapas, cards e movimentos (20260928220000_crm_funnels.sql)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'crm_funnel_cards' AND column_name = 'removed_at')
     OR to_regclass('public.crm_funnel_cards_active_unique_idx') IS NULL THEN
    RAISE EXCEPTION 'pré-requisito ausente: arquivamento de cards (20260929100000_crm_funnel_cards_funis2.sql)';
  END IF;
  IF to_regclass('public.crm_services') IS NULL THEN
    RAISE EXCEPTION 'pré-requisito ausente: crm_services (20261012090000_crm_catalogs.sql)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'crm_services' AND column_name = 'permite_pagamento_unico')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'crm_services' AND column_name = 'permite_pagamento_recorrente')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'crm_services' AND column_name = 'periodicidades') THEN
    RAISE EXCEPTION 'pré-requisito ausente: modalidades de pagamento do serviço (20261018090000_crm_services_payment_modalities.sql)';
  END IF;
  IF to_regprocedure('public.delete_crm_funnel_if_empty(text)') IS NULL OR to_regprocedure('public.delete_crm_funnel_stage_if_empty(text)') IS NULL THEN
    RAISE EXCEPTION 'pré-requisito ausente: funções de exclusão com guarda (20260928220000_crm_funnels.sql)';
  END IF;
  IF to_regclass('public.crm_negotiations') IS NOT NULL OR to_regclass('public.crm_negotiation_events') IS NOT NULL THEN
    RAISE EXCEPTION 'esta migration já foi aplicada (crm_negotiations existe): nada foi alterado';
  END IF;
END
$$;

-- ------------------------------------------------------------------------------------------------------------
-- 1) NEGOCIAÇÃO
-- ------------------------------------------------------------------------------------------------------------
CREATE TABLE public.crm_negotiations (
  id                   TEXT PRIMARY KEY
                         CHECK (id ~ '^negotiation:[0-9a-f-]{36}$'), -- gerado pela APLICAÇÃO (prefixo:uuid), como crm_records
  crm_record_id        TEXT NOT NULL REFERENCES public.crm_records (id),
  funnel_id            TEXT NOT NULL REFERENCES public.crm_funnels (id),
  card_id              TEXT NOT NULL UNIQUE REFERENCES public.crm_funnel_cards (id) DEFERRABLE INITIALLY DEFERRED,
                         -- o card que a representa no quadro (a ETAPA vive no card). Adiável: o card e a negociação nascem na mesma transação.
  service_id           TEXT NOT NULL REFERENCES public.crm_services (id),
                         -- a identidade do serviço contratado: crm_services nunca é apagado (só desativado), então a referência é permanente.
  servico_nome         TEXT CHECK (servico_nome IS NULL OR btrim(servico_nome) <> ''), -- FOTO do nome na hora da negociação (o histórico não muda se o catálogo mudar)
  responsavel_user_id  TEXT NOT NULL CHECK (btrim(responsavel_user_id) <> ''),
  responsavel_nome     TEXT NOT NULL CHECK (btrim(responsavel_nome) <> ''),
  prazo_meses          INTEGER NOT NULL CHECK (prazo_meses BETWEEN 1 AND 120),
  forma_pagamento      TEXT NOT NULL CHECK (forma_pagamento IN ('UNICO', 'RECORRENTE')),
  periodicidade        TEXT CHECK (periodicidade IS NULL OR periodicidade IN ('MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL')),
  valor_centavos       BIGINT NOT NULL CHECK (valor_centavos BETWEEN 1 AND 100000000000),
                         -- UNICO: o valor TOTAL do contrato; RECORRENTE: o valor de CADA cobrança. Sempre em centavos inteiros.
  previsao_fechamento  DATE,
  situacao             TEXT NOT NULL DEFAULT 'ABERTA' CHECK (situacao IN ('ABERTA', 'GANHA', 'PERDIDA')),
  motivo_perda         TEXT,
  fechado_em           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(), -- definido PELA APLICAÇÃO (é o que a concorrência otimista compara); nenhum gatilho o reescreve
  created_by_user_id   TEXT NOT NULL CHECK (btrim(created_by_user_id) <> ''),
  created_by_name      TEXT NOT NULL CHECK (btrim(created_by_name) <> ''),
  updated_by_user_id   TEXT NOT NULL CHECK (btrim(updated_by_user_id) <> ''),
  updated_by_name      TEXT NOT NULL CHECK (btrim(updated_by_name) <> ''),
  CONSTRAINT crm_negotiations_pagamento_coerente CHECK (
    (forma_pagamento = 'UNICO' AND periodicidade IS NULL)
    OR (forma_pagamento = 'RECORRENTE' AND periodicidade IS NOT NULL
        AND prazo_meses % (CASE periodicidade WHEN 'MENSAL' THEN 1 WHEN 'TRIMESTRAL' THEN 3 WHEN 'SEMESTRAL' THEN 6 ELSE 12 END) = 0)
  ),
  CONSTRAINT crm_negotiations_situacao_coerente CHECK (
    (situacao = 'ABERTA' AND motivo_perda IS NULL AND fechado_em IS NULL)
    OR (situacao = 'GANHA' AND motivo_perda IS NULL AND fechado_em IS NOT NULL)
    OR (situacao = 'PERDIDA' AND motivo_perda IS NOT NULL AND btrim(motivo_perda) <> '' AND fechado_em IS NOT NULL)
  )
);
CREATE INDEX crm_negotiations_crm_record_id_idx ON public.crm_negotiations (crm_record_id);
CREATE INDEX crm_negotiations_funnel_situacao_idx ON public.crm_negotiations (funnel_id, situacao);
CREATE INDEX crm_negotiations_service_id_idx ON public.crm_negotiations (service_id);
CREATE INDEX crm_negotiations_created_at_idx ON public.crm_negotiations (created_at DESC, id);
ALTER TABLE public.crm_negotiations ENABLE ROW LEVEL SECURITY; -- sem policy: só service_role

-- ------------------------------------------------------------------------------------------------------------
-- 2) HISTÓRICO IMUTÁVEL DA NEGOCIAÇÃO
-- ------------------------------------------------------------------------------------------------------------
CREATE TABLE public.crm_negotiation_events (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  negotiation_id  TEXT NOT NULL REFERENCES public.crm_negotiations (id),
  seq             INTEGER NOT NULL CHECK (seq >= 0), -- a posição no histórico (0 = CRIADA); única por negociação
  tipo            TEXT NOT NULL CHECK (tipo IN ('CRIADA', 'ATUALIZADA', 'ETAPA', 'GANHA', 'PERDIDA', 'REABERTA')),
  em              TIMESTAMPTZ NOT NULL,
  por_user_id     TEXT NOT NULL CHECK (btrim(por_user_id) <> ''),
  por_nome        TEXT NOT NULL CHECK (btrim(por_nome) <> ''),
  detalhe         JSONB CHECK (detalhe IS NULL OR jsonb_typeof(detalhe) = 'object'),
  UNIQUE (negotiation_id, seq)
);
ALTER TABLE public.crm_negotiation_events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.crm_history_is_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% é um histórico imutável: % não é permitido', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER crm_negotiation_events_append_only
  BEFORE UPDATE OR DELETE ON public.crm_negotiation_events
  FOR EACH ROW EXECUTE FUNCTION public.crm_history_is_append_only();
CREATE TRIGGER crm_funnel_card_moves_append_only
  BEFORE UPDATE OR DELETE ON public.crm_funnel_card_moves
  FOR EACH ROW EXECUTE FUNCTION public.crm_history_is_append_only();

-- ------------------------------------------------------------------------------------------------------------
-- 3) CARDS: o card da negociação, a unicidade só para os avulsos, a integridade
-- ------------------------------------------------------------------------------------------------------------
ALTER TABLE public.crm_funnel_cards ADD COLUMN negotiation_id TEXT;
ALTER TABLE public.crm_funnel_cards
  ADD CONSTRAINT crm_funnel_cards_negotiation_fk FOREIGN KEY (negotiation_id) REFERENCES public.crm_negotiations (id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX crm_funnel_cards_negotiation_unique_idx ON public.crm_funnel_cards (negotiation_id) WHERE negotiation_id IS NOT NULL;

-- "Um card ATIVO por (funil, registro)" vale só para os cards SEM negociação: um cliente pode ter várias negociações no mesmo funil.
DROP INDEX public.crm_funnel_cards_active_unique_idx;
CREATE UNIQUE INDEX crm_funnel_cards_active_unique_idx
  ON public.crm_funnel_cards (funnel_id, crm_record_id)
  WHERE removed_at IS NULL AND negotiation_id IS NULL;

CREATE FUNCTION public.crm_funnel_cards_integrity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.funnel_id IS DISTINCT FROM OLD.funnel_id OR NEW.crm_record_id IS DISTINCT FROM OLD.crm_record_id OR NEW.negotiation_id IS DISTINCT FROM OLD.negotiation_id THEN
      RAISE EXCEPTION 'crm_funnel_cards_integrity: o funil, o registro do CRM e a negociação de um card nunca mudam' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.crm_funnel_stages s WHERE s.id = NEW.stage_id AND s.funnel_id = NEW.funnel_id) THEN
    RAISE EXCEPTION 'crm_funnel_cards_integrity: a etapa % não pertence ao funil %', NEW.stage_id, NEW.funnel_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_funnel_cards_integrity_trigger
  BEFORE INSERT OR UPDATE ON public.crm_funnel_cards
  FOR EACH ROW EXECUTE FUNCTION public.crm_funnel_cards_integrity();

CREATE FUNCTION public.crm_funnel_stages_integrity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.funnel_id IS DISTINCT FROM OLD.funnel_id THEN
    RAISE EXCEPTION 'crm_funnel_stages_integrity: o funil de uma etapa nunca muda' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_funnel_stages_integrity_trigger
  BEFORE UPDATE ON public.crm_funnel_stages
  FOR EACH ROW EXECUTE FUNCTION public.crm_funnel_stages_integrity();

-- A negociação e o card dela têm de concordar (funil, cliente e a ligação nos dois sentidos) — conferido NO COMMIT (adiável), então o card e a
-- negociação podem nascer na mesma transação em qualquer ordem, mas nenhuma gravação direta deixa uma ligação quebrada.
CREATE FUNCTION public.crm_negotiations_card_consistency() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.crm_funnel_cards c
    WHERE c.id = NEW.card_id AND c.negotiation_id = NEW.id AND c.funnel_id = NEW.funnel_id AND c.crm_record_id = NEW.crm_record_id
  ) THEN
    RAISE EXCEPTION 'crm_negotiations_card_consistency: o card % não corresponde à negociação %', NEW.card_id, NEW.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER crm_negotiations_card_consistency_trigger
  AFTER INSERT OR UPDATE ON public.crm_negotiations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.crm_negotiations_card_consistency();

-- ------------------------------------------------------------------------------------------------------------
-- 4) FUNÇÕES — a conferência do serviço e as três gravações atômicas
-- ------------------------------------------------------------------------------------------------------------
-- O serviço permite a forma de pagamento e a periodicidade escolhidas? (e, para uma negociação NOVA ou uma troca de serviço, está ativo?)
CREATE FUNCTION public.crm_negotiation_service_check(p_service_id TEXT, p_forma TEXT, p_periodicidade TEXT, p_require_active BOOLEAN) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_service public.crm_services%ROWTYPE;
BEGIN
  SELECT * INTO v_service FROM public.crm_services WHERE id = p_service_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'crm_negotiation_service_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF p_require_active AND v_service.ativo IS NOT TRUE THEN
    RAISE EXCEPTION 'crm_negotiation_service_inactive' USING ERRCODE = 'P0001';
  END IF;
  IF p_forma = 'UNICO' AND v_service.permite_pagamento_unico IS NOT TRUE THEN
    RAISE EXCEPTION 'crm_negotiation_service_forbids_payment' USING ERRCODE = 'P0001';
  END IF;
  IF p_forma = 'RECORRENTE' AND (v_service.permite_pagamento_recorrente IS NOT TRUE OR p_periodicidade IS NULL OR NOT (p_periodicidade = ANY (v_service.periodicidades))) THEN
    RAISE EXCEPTION 'crm_negotiation_service_forbids_payment' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Grava UMA negociação e TUDO o que a acompanha, numa única transação.
--   p_mode  'create': insere o card, o primeiro movimento do card, a negociação e o histórico (que tem de ser exatamente [CRIADA]).
--           'update': atualiza a negociação (concorrência otimista por p_expected_updated_at) e ACRESCENTA ao histórico; se p_card vier, move o
--                     card (a etapa de destino tem de ser ATIVA e do mesmo funil) e registra o movimento.
--   p_negotiation  { id, crmRecordId, funnelId, cardId, serviceId, servicoNome, responsavelUserId, responsavelNome, prazoMeses, formaPagamento,
--                    periodicidade, valorCentavos, previsaoFechamento, situacao, motivoPerda, fechadoEm, criadoEm, atualizadoEm, criadoPorUserId,
--                    criadoPorNome, atualizadoPorUserId, atualizadoPorNome, eventos: [{ tipo, em, porUserId, porNome, detalhe? }] }  — o histórico INTEIRO
--   p_card         { id, funnelId, stageId, crmRecordId, negotiationId, criadoEm, updatedAt }   (create: o card novo; update: o card na etapa nova)
--   p_card_move    { cardId, stageFrom, stageTo, movedBy: { userId, name, role }, motivo, movedAt }
-- Códigos (ERRCODE P0001, o texto é o marcador que o adaptador reconhece): crm_negotiation_not_found, crm_negotiation_conflict,
-- crm_negotiation_closed, crm_negotiation_immutable, crm_negotiation_history, crm_negotiation_client_blocked, crm_negotiation_funnel_inactive,
-- crm_negotiation_stage_invalid, crm_negotiation_service_*; violações de CHECK/FK/UNIQUE seguem os códigos normais do Postgres.
CREATE FUNCTION public.commit_crm_negotiation_change(
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
    INSERT INTO public.crm_negotiations (id, crm_record_id, funnel_id, card_id, service_id, servico_nome, responsavel_user_id, responsavel_nome, prazo_meses, forma_pagamento,
                                         periodicidade, valor_centavos, previsao_fechamento, situacao, motivo_perda, fechado_em, created_at, updated_at,
                                         created_by_user_id, created_by_name, updated_by_user_id, updated_by_name)
    VALUES (v_id, p_negotiation->>'crmRecordId', p_negotiation->>'funnelId', p_negotiation->>'cardId', v_service, p_negotiation->>'servicoNome',
            p_negotiation->>'responsavelUserId', p_negotiation->>'responsavelNome', (p_negotiation->>'prazoMeses')::INTEGER, v_forma, v_per, v_valor,
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
CREATE FUNCTION public.commit_crm_funnel_card_change(p_card JSONB, p_card_move JSONB, p_expected_stage_id TEXT) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_card public.crm_funnel_cards%ROWTYPE;
BEGIN
  IF p_card IS NULL OR p_card_move IS NULL OR jsonb_typeof(p_card) <> 'object' OR jsonb_typeof(p_card_move) <> 'object' THEN
    RAISE EXCEPTION 'commit_crm_funnel_card_change: card e movimento são obrigatórios' USING ERRCODE = '22023';
  END IF;
  IF (p_card_move->>'cardId') <> (p_card->>'id') OR (p_card_move->>'stageTo') <> (p_card->>'stageId') THEN
    RAISE EXCEPTION 'commit_crm_funnel_card_change: o movimento não corresponde ao card' USING ERRCODE = '22023';
  END IF;
  IF p_expected_stage_id IS NULL THEN
    IF (p_card_move->>'stageFrom') IS NOT NULL OR (p_card->>'negotiationId') IS NOT NULL THEN
      RAISE EXCEPTION 'commit_crm_funnel_card_change: um card avulso novo não tem etapa anterior nem negociação' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.crm_funnel_cards (id, funnel_id, stage_id, crm_record_id, criado_em, updated_at)
    VALUES (p_card->>'id', p_card->>'funnelId', p_card->>'stageId', p_card->>'crmRecordId', (p_card->>'criadoEm')::TIMESTAMPTZ, (p_card->>'updatedAt')::TIMESTAMPTZ);
  ELSE
    SELECT * INTO v_card FROM public.crm_funnel_cards WHERE id = p_card->>'id' FOR UPDATE;
    IF NOT FOUND OR v_card.negotiation_id IS NOT NULL OR v_card.removed_at IS NOT NULL OR v_card.stage_id <> p_expected_stage_id
       OR (p_card_move->>'stageFrom') IS DISTINCT FROM p_expected_stage_id OR v_card.funnel_id <> (p_card->>'funnelId') THEN
      RAISE EXCEPTION 'crm_funnel_card_conflict' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.crm_funnel_cards SET stage_id = p_card->>'stageId' WHERE id = v_card.id;
  END IF;
  INSERT INTO public.crm_funnel_card_moves (card_id, stage_from, stage_to, moved_by_user_id, moved_by_name, moved_by_role, motivo, moved_at)
  VALUES (p_card_move->>'cardId', p_card_move->>'stageFrom', p_card_move->>'stageTo', p_card_move#>>'{movedBy,userId}', p_card_move#>>'{movedBy,name}', p_card_move#>>'{movedBy,role}',
          NULLIF(p_card_move->>'motivo', ''), (p_card_move->>'movedAt')::TIMESTAMPTZ);
END;
$$;

-- Reordena as etapas de UM funil, atomicamente: a lista tem de conter exatamente as etapas do funil, cada uma uma vez (nada de escrita cruzada).
CREATE FUNCTION public.reorder_crm_funnel_stages(p_funnel_id TEXT, p_ordered_ids TEXT[]) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INTEGER;
  v_i INTEGER;
BEGIN
  IF p_funnel_id IS NULL OR p_ordered_ids IS NULL THEN
    RAISE EXCEPTION 'reorder_crm_funnel_stages: funil e lista são obrigatórios' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.crm_funnels WHERE id = p_funnel_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reorder_crm_funnel_stages: funil inexistente' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_count FROM public.crm_funnel_stages WHERE funnel_id = p_funnel_id;
  IF coalesce(array_length(p_ordered_ids, 1), 0) <> v_count
     OR (SELECT count(DISTINCT x) FROM unnest(p_ordered_ids) AS x) <> v_count
     OR EXISTS (SELECT 1 FROM unnest(p_ordered_ids) AS x WHERE NOT EXISTS (SELECT 1 FROM public.crm_funnel_stages s WHERE s.id = x AND s.funnel_id = p_funnel_id)) THEN
    RAISE EXCEPTION 'reorder_crm_funnel_stages: a lista não confere com as etapas do funil' USING ERRCODE = 'P0001';
  END IF;
  FOR v_i IN 1 .. v_count LOOP
    UPDATE public.crm_funnel_stages SET ordem = v_i - 1 WHERE id = p_ordered_ids[v_i] AND funnel_id = p_funnel_id;
  END LOOP;
END;
$$;

-- ------------------------------------------------------------------------------------------------------------
-- 5) PRIVILÉGIOS: só o servidor (service_role). anon e authenticated não leem nem escrevem nada disto.
-- ------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.crm_negotiations, public.crm_negotiation_events FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.crm_negotiations, public.crm_negotiation_events FROM authenticated;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.crm_negotiation_service_check(TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crm_negotiation_service_check(TEXT, TEXT, TEXT, BOOLEAN) TO service_role;
REVOKE ALL ON FUNCTION public.commit_crm_negotiation_change(TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.commit_crm_negotiation_change(TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ) TO service_role;
REVOKE ALL ON FUNCTION public.commit_crm_funnel_card_change(JSONB, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.commit_crm_funnel_card_change(JSONB, JSONB, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.reorder_crm_funnel_stages(TEXT, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reorder_crm_funnel_stages(TEXT, TEXT[]) TO service_role;

COMMENT ON TABLE public.crm_negotiations IS 'Negociações (CRM 5.0, D1.1): um cliente por um serviço, num funil. Dinheiro em centavos; nunca apagada; escrita só pelas funções commit_*.';
COMMENT ON TABLE public.crm_negotiation_events IS 'Histórico imutável das negociações (append-only por gatilho).';
