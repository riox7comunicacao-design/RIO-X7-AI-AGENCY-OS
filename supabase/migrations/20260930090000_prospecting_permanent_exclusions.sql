-- ============================================================================================================
-- Prospecção — Exclusões Permanentes (Workbench, Etapa 2)
-- ============================================================================================================
-- NÃO APLICADA. Este arquivo é só a proposta versionada (ver tests/db/prospectingPermanentExclusionsMigration.
-- test.js, que só lê este texto). Aplicar é uma ação humana e consciente do proprietário, depois de revisar este
-- arquivo. Não altera nenhuma tabela já existente (crm_records, crm_funnels, crm_funnel_cards, etc.) — é uma
-- tabela nova e independente.
--
-- OBJETIVO: impedir que uma empresa marcada como exclusão permanente (ex.: "Força Digital", Petrópolis/RJ) volte
-- a avançar pelo fluxo de prospecção — nunca pesquisada para contato, nunca enviada à Approval Queue, nunca
-- promovida ao CRM, nunca com Card criado. A checagem (matchesExclusion, src/research-prospector/
-- permanentExclusion.js) roda ANTES de um achado (finding) ser aceito para revisão — ver
-- src/services/prospectingBriefService.js#ingestFindings.
--
-- "EXCLUIR" = DESATIVAR (nunca DELETE físico): esta migration não cria nenhuma função/rota de exclusão física; o
-- Service (prospectingExclusionService.js) só expõe create/update/deactivate/activate. Histórico preservado.
--
-- CADASTRO INICIAL: esta migration NÃO insere nenhuma linha de negócio (nem "Força Digital"). O primeiro registro
-- deve ser cadastrado pelo painel ADMIN ("Exclusões Permanentes"), depois que esta migration for aplicada —
-- nunca hardcoded em código ou em migration (o comando desta etapa proíbe isso explicitamente).
--
-- MODO OFICIAL: Supabase (nunca um arquivo JSON local para esta funcionalidade — decisão explícita do
-- proprietário). Sem REPOSITORY_MODE=supabase configurado, a funcionalidade simplesmente não existe no servidor
-- (rotas administrativas ausentes, checagem sempre "não excluído") — ver o cabeçalho de
-- src/services/prospectingExclusionRepositoryFactory.js.
-- ============================================================================================================

CREATE TABLE public.prospecting_permanent_exclusions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                              -- a APLICAÇÃO gera o id (crypto.randomUUID(), mesma convenção do resto do projeto);
                              -- o DEFAULT é só uma rede de segurança para um insert direto sem id.
  empresa_nome              TEXT NOT NULL CHECK (btrim(empresa_nome) <> ''),
                              -- o nome como foi digitado (exibido ao humano) — NUNCA usado para comparação.
  empresa_nome_normalizado  TEXT NOT NULL CHECK (btrim(empresa_nome_normalizado) <> ''),
                              -- calculado pela aplicação (normalizeCompanyName: minúsculas, sem acento, sem
                              -- pontuação, espaços colapsados) — é o campo usado na comparação de exclusão.
  cidade                    TEXT,
  estado                    TEXT,
  pais                      TEXT NOT NULL DEFAULT 'Brasil',
  dominio                   TEXT,
                              -- domínio normalizado (ex.: "forcadigital.com.br") — critério de exclusão
                              -- INDEPENDENTE do nome (seção 4 do comando).
  motivo                    TEXT NOT NULL CHECK (btrim(motivo) <> ''),
  ativo                     BOOLEAN NOT NULL DEFAULT TRUE,
                              -- "excluir" administrativamente = ativo = false (nunca DELETE físico).
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id        UUID,
  created_by_name           TEXT
);

-- Consulta de exclusão: por nome normalizado (só entre as ATIVAS — uma exclusão desativada nunca deveria pesar
-- nesta busca) e por domínio (idem). Duas consultas separadas em vez de um índice composto: os dois critérios são
-- INDEPENDENTES (seção 4 — domínio sozinho já basta), então um índice por critério serve melhor a cada consulta.
CREATE INDEX prospecting_permanent_exclusions_nome_norm_idx
  ON public.prospecting_permanent_exclusions (empresa_nome_normalizado)
  WHERE ativo;
CREATE INDEX prospecting_permanent_exclusions_dominio_idx
  ON public.prospecting_permanent_exclusions (dominio)
  WHERE ativo AND dominio IS NOT NULL;

ALTER TABLE public.prospecting_permanent_exclusions ENABLE ROW LEVEL SECURITY;
-- Mesmo padrão de segurança já usado em todas as tabelas do CRM/Funis: RLS ligado, SEM nenhuma policy — só a
-- service_role (que ignora RLS) lê/escreve. Nenhum cliente do navegador acessa esta tabela diretamente; tudo
-- passa pelo backend (src/services/prospectingExclusionService.js), que autoriza MANAGE:PROSPECTING_EXCLUSIONS
-- (só ADMIN) antes de qualquer leitura/escrita administrativa.

-- updated_at automático — função PRÓPRIA desta tabela (nunca reaproveita crm_funnels_bump_updated_at(): aquela
-- função pertence a uma migration DIFERENTE, ainda não aplicada — esta migration precisa ficar completa e
-- independente por si só).
CREATE FUNCTION public.prospecting_permanent_exclusions_bump_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER prospecting_permanent_exclusions_bump_updated_at_trigger
  BEFORE UPDATE ON public.prospecting_permanent_exclusions
  FOR EACH ROW
  EXECUTE FUNCTION public.prospecting_permanent_exclusions_bump_updated_at();
