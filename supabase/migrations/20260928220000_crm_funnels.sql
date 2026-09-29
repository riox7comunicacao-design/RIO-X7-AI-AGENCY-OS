-- ============================================================================================================
-- CRM — Funis configuráveis (reestruturação Prospecção/CRM/Funis, Etapa "Funis 1")
-- ============================================================================================================
-- NÃO APLICADA. Este arquivo é só a proposta versionada (ver tests/db/crmFunnelsMigration.test.js, que só lê
-- este texto). Aplicar é uma ação humana e consciente do proprietário, depois de revisar este arquivo. Soma-se
-- a 20260927120000_crm_initial_schema.sql e 20260928090000_crm_delete_audit.sql (ambas já devem estar
-- aplicadas) — não as substitui nem as repete.
--
-- ESCOPO: um FUNIL não é sinônimo de vendas — é uma estrutura CONFIGURÁVEL de processo (Outbound, Onboarding,
-- Renovação, Churn, Prospecção Fria, ou qualquer outro que o usuário crie). Cada funil tem suas próprias ETAPAS,
-- independentes das etapas de outro funil. Um CARD representa um registro do CRM posicionado numa etapa de um
-- funil — um MESMO registro pode ter, ao mesmo tempo, um card em MAIS DE UM funil (ex.: "Clientes Ativos" e
-- "Renovação" rodando em paralelo perto do fim de um contrato), por isso card é uma entidade PRÓPRIA (tabela de
-- junção), nunca duas colunas soltas em crm_records — e nunca mais de um card ATIVO do mesmo registro no MESMO
-- funil (UNIQUE abaixo).
--
-- ESTA MIGRATION NÃO TOCA em crm_records nem em crm_record_deletions: nenhuma coluna nova, nenhum trigger novo
-- lá. A máquina de estados existente (`status`, ALLOWED_TRANSITIONS) continua exatamente como está — decisão
-- explícita do proprietário de não quebrar compatibilidade nesta etapa. Funil/Etapa é uma camada NOVA e ADITIVA.
--
-- ESCOPO DESTA ETAPA ("Funis 1"): só as tabelas e o schema. O backend desta etapa (src/crm/funnelDomain.js,
-- src/services/funnelService.js, rotas /api/funnels) ainda usa o adapter de ARQUIVO local (data/funnels.json) —
-- um adapter Supabase para estas tabelas é uma etapa futura ("Funis 2", junto com a vinculação de cards e o
-- Kanban). Esta migration já cria o schema completo (inclusive as tabelas de card) para que essa etapa futura
-- não precise de uma migration nova só para os cards.
-- ============================================================================================================

-- ------------------------------------------------------------------------------------------------------------
-- FUNIL
-- ------------------------------------------------------------------------------------------------------------
CREATE TABLE public.crm_funnels (
  id          TEXT PRIMARY KEY
                CHECK (id ~ '^funnel:[0-9a-f-]{36}$'),
                -- mesmo formato "prefixo:<uuid>" de crm_records.id — gerado pela APLICAÇÃO, nunca pelo banco.
  nome        TEXT NOT NULL CHECK (btrim(nome) <> ''),
  descricao   TEXT CHECK (descricao IS NULL OR btrim(descricao) <> ''),
  finalidade  TEXT CHECK (finalidade IS NULL OR btrim(finalidade) <> ''),
  ativo       BOOLEAN NOT NULL DEFAULT true,
  ordem       INTEGER NOT NULL DEFAULT 0,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
                -- configurações/regras PRÓPRIAS do funil (seção 18 da reestruturação) — nunca lido como regra
                -- global do CRM; cada funil interpreta a sua própria config.
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_funnels_ordem_idx ON public.crm_funnels (ordem);
ALTER TABLE public.crm_funnels ENABLE ROW LEVEL SECURITY; -- mesmo padrão D1/D2: sem policy, só service_role.

CREATE FUNCTION public.crm_funnels_bump_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_funnels_bump_updated_at_trigger
  BEFORE UPDATE ON public.crm_funnels
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_funnels_bump_updated_at();

-- ------------------------------------------------------------------------------------------------------------
-- ETAPA (independente entre funis — seção 11 da reestruturação)
-- ------------------------------------------------------------------------------------------------------------
CREATE TABLE public.crm_funnel_stages (
  id          TEXT PRIMARY KEY
                CHECK (id ~ '^stage:[0-9a-f-]{36}$'),
  funnel_id   TEXT NOT NULL REFERENCES public.crm_funnels (id),
                -- ÚNICA foreign key desta migration: uma etapa nunca existe sem o funil dela; excluir o funil
                -- (função abaixo) já exige excluir as etapas primeiro, então isto nunca bloqueia essa exclusão.
  nome        TEXT NOT NULL CHECK (btrim(nome) <> ''),
  ordem       INTEGER NOT NULL DEFAULT 0,
  ativo       BOOLEAN NOT NULL DEFAULT true,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
                -- ex.: o checklist de condições de FINALIZADO do funil comercial (seção 19) — uma lista nomeada
                -- de condições que o card precisa confirmar antes de entrar nesta etapa. Interpretado só pelo
                -- Service/Dashboard; o banco não valida o conteúdo desta config.
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_funnel_stages_funnel_id_idx ON public.crm_funnel_stages (funnel_id);
CREATE INDEX crm_funnel_stages_ordem_idx ON public.crm_funnel_stages (funnel_id, ordem);
ALTER TABLE public.crm_funnel_stages ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER crm_funnel_stages_bump_updated_at_trigger
  BEFORE UPDATE ON public.crm_funnel_stages
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_funnels_bump_updated_at(); -- mesma função genérica acima (só toca updated_at)

-- ------------------------------------------------------------------------------------------------------------
-- CARD (Etapa "Funis 2" — schema já preparado aqui; nenhum código desta etapa cria linhas nestas duas tabelas)
-- ------------------------------------------------------------------------------------------------------------
-- Um card vincula um registro do CRM a UMA etapa de UM funil. UNIQUE (funnel_id, crm_record_id): um registro
-- nunca tem dois cards ATIVOS simultâneos no MESMO funil (evita duas posições divergentes no mesmo Kanban); ele
-- PODE, sim, ter cards em funis DIFERENTES ao mesmo tempo (ver o cabeçalho desta migration).
CREATE TABLE public.crm_funnel_cards (
  id             TEXT PRIMARY KEY
                   CHECK (id ~ '^card:[0-9a-f-]{36}$'),
  funnel_id      TEXT NOT NULL REFERENCES public.crm_funnels (id),
  stage_id       TEXT NOT NULL REFERENCES public.crm_funnel_stages (id),
  crm_record_id  TEXT NOT NULL REFERENCES public.crm_records (id),
  perdido_em     TIMESTAMPTZ,
  motivo_perdido TEXT CHECK (motivo_perdido IS NULL OR btrim(motivo_perdido) <> ''),
                   -- PERDIDO (seção 20) é diferente de DNC/rejeitado/duplicado: o card não é apagado, só marcado.
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (funnel_id, crm_record_id)
);
CREATE INDEX crm_funnel_cards_funnel_id_idx ON public.crm_funnel_cards (funnel_id);
CREATE INDEX crm_funnel_cards_stage_id_idx ON public.crm_funnel_cards (stage_id);
CREATE INDEX crm_funnel_cards_crm_record_id_idx ON public.crm_funnel_cards (crm_record_id);
ALTER TABLE public.crm_funnel_cards ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER crm_funnel_cards_bump_updated_at_trigger
  BEFORE UPDATE ON public.crm_funnel_cards
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_funnels_bump_updated_at();

-- Histórico de movimentação de card entre etapas (seção 14: toda movimentação registra etapa anterior, nova
-- etapa, quem e quando — mesmo espírito do historico JSONB de crm_records, mas em tabela própria porque um card
-- pode se mover muitas vezes e a consulta "todas as movimentações de um funil" é mais natural em linhas).
CREATE TABLE public.crm_funnel_card_moves (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id         TEXT NOT NULL REFERENCES public.crm_funnel_cards (id),
  stage_from      TEXT REFERENCES public.crm_funnel_stages (id), -- NULL na primeira vinculação (card recém-criado)
  stage_to        TEXT NOT NULL REFERENCES public.crm_funnel_stages (id),
  moved_by_user_id TEXT NOT NULL CHECK (btrim(moved_by_user_id) <> ''),
  moved_by_name    TEXT NOT NULL CHECK (btrim(moved_by_name) <> ''),
  moved_by_role    TEXT NOT NULL CHECK (btrim(moved_by_role) <> ''),
  moved_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_funnel_card_moves_card_id_idx ON public.crm_funnel_card_moves (card_id);
ALTER TABLE public.crm_funnel_card_moves ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------------------------------------
-- FUNÇÕES DE EXCLUSÃO COM GUARDA (seções 10/12 da reestruturação — nunca excluir funil/etapa com cards)
-- ------------------------------------------------------------------------------------------------------------
-- Mesma regra que o Service já aplica em JavaScript (funnelDomain.js, via countCardsByFunnel/countCardsByStage);
-- estas duas funções são a MESMA regra do lado do banco, defesa em profundidade — nunca a única camada (a
-- decisão de autorizar quem exclui continua sendo do servidor, MANAGE:FUNNELS, antes de chamar aqui).
CREATE FUNCTION public.delete_crm_funnel_if_empty(p_funnel_id TEXT) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.crm_funnel_cards WHERE funnel_id = p_funnel_id) THEN
    RAISE EXCEPTION 'delete_crm_funnel_if_empty: funil % possui cards vinculados', p_funnel_id USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.crm_funnel_stages WHERE funnel_id = p_funnel_id;
  DELETE FROM public.crm_funnels WHERE id = p_funnel_id;
END;
$$;

CREATE FUNCTION public.delete_crm_funnel_stage_if_empty(p_stage_id TEXT) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.crm_funnel_cards WHERE stage_id = p_stage_id) THEN
    RAISE EXCEPTION 'delete_crm_funnel_stage_if_empty: etapa % possui cards vinculados', p_stage_id USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.crm_funnel_stages WHERE id = p_stage_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_crm_funnel_if_empty(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_crm_funnel_if_empty(TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.delete_crm_funnel_stage_if_empty(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_crm_funnel_stage_if_empty(TEXT) TO service_role;
