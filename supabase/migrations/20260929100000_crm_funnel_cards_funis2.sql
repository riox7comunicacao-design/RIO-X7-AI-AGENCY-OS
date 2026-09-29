-- ============================================================================================================
-- CRM — Funis: Cards (reestruturação Prospecção/CRM/Funis, Etapa "Funis 2")
-- ============================================================================================================
-- NÃO APLICADA (ver tests/db/crmFunnelCardsMigration.test.js, que só lê este texto). Soma-se a
-- 20260928220000_crm_funnels.sql (que já deve estar aplicada) — NÃO a substitui nem repete o que já existe lá
-- (crm_funnel_cards e crm_funnel_card_moves já foram criadas naquela migration, com o schema completo). Esta
-- migration só COMPLEMENTA essas duas tabelas com o que a etapa "Funis 2" exige e a primeira versão não previa —
-- por decisão explícita do proprietário, nunca alterando um arquivo de migration já versionado.
--
-- DECISÃO DO PROPRIETÁRIO (Etapa "Funis 2"): excluir um Card é ARQUIVAMENTO (soft delete), nunca exclusão física.
-- O CRM Record referenciado continua existindo sempre; o HISTÓRICO de movimentação (crm_funnel_card_moves) nunca
-- pode ser perdido — e a FK `card_id` de crm_funnel_card_moves não tem ON DELETE CASCADE (decisão 0025/Funis 1),
-- então um DELETE físico de um card com histórico seria REJEITADO pelo banco. Arquivar em vez de apagar resolve
-- os dois pontos ao mesmo tempo, sem tocar na FK.
-- ============================================================================================================

-- `removed_at` NULL = card ATIVO (aparece no Kanban); preenchido = arquivado (some das listagens ativas, mas a
-- linha e todo o histórico dela continuam no banco, para sempre consultáveis).
ALTER TABLE public.crm_funnel_cards ADD COLUMN removed_at TIMESTAMPTZ;

-- A regra "1 CRM Record + 1 Funil = no máximo 1 Card" (seção 3 da Etapa "Funis 2") vale só entre cards ATIVOS:
-- depois de arquivar um card, o mesmo par (funil, registro) precisa poder ganhar um card novo. A UNIQUE simples
-- de crm_funnel_cards (criada em 20260928220000) bloquearia isso — por isso ela é substituída aqui por um índice
-- único PARCIAL, que só considera as linhas com removed_at IS NULL.
ALTER TABLE public.crm_funnel_cards DROP CONSTRAINT crm_funnel_cards_funnel_id_crm_record_id_key;
CREATE UNIQUE INDEX crm_funnel_cards_active_unique_idx
  ON public.crm_funnel_cards (funnel_id, crm_record_id)
  WHERE removed_at IS NULL;

-- Motivo da movimentação (seção 6 da Etapa "Funis 2": "motivo, quando informado") — opcional, nunca em branco
-- quando presente. A tabela crm_funnel_card_moves (20260928220000) não previa este campo.
ALTER TABLE public.crm_funnel_card_moves ADD COLUMN motivo TEXT CHECK (motivo IS NULL OR btrim(motivo) <> '');

COMMENT ON COLUMN public.crm_funnel_cards.removed_at IS
  'Arquivamento (soft delete) do card — NULL = ativo. Nunca é uma exclusão física: o histórico de movimentação '
  '(crm_funnel_card_moves) e o CRM Record referenciado nunca são afetados por isto.';
