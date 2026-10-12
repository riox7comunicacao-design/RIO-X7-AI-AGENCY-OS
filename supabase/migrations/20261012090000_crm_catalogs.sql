-- ============================================================================================================
-- CRM — Catálogos: Serviços, Nichos e Origens dos Leads (CRM 5.0, Fase 2B-1 — decisão 0026)
-- ============================================================================================================
-- NÃO APLICADA. Este arquivo é só a proposta versionada (ver tests/db/crmCatalogsMigration.test.js, que só lê este texto).
-- Ninguém (código, script, teste, CI) a executa: aplicar é uma ação humana e consciente do proprietário, depois de revisar este
-- arquivo e a decisão 0026 (SQL Editor do Supabase, ou `supabase db push`). Até lá, REPOSITORY_MODE=supabase NÃO tem estas tabelas, e
-- as rotas /api/crm-catalogs responderiam 503 nesse modo; em REPOSITORY_MODE=file (o padrão) os catálogos usam um arquivo local.
--
-- ADITIVA: só cria tabelas, índices, restrições, um gatilho e uma função NOVOS. NÃO altera crm_records, crm_record_deletions nem
-- nenhuma outra tabela existente, e não lê nem escreve em nenhuma delas (os 31 campos do CRM — inclusive `nicho`, `origem` e
-- `servico_potencial`, que continuam TEXTO LIVRE — ficam exatamente como estão). NENHUMA linha de negócio é inserida: a carga inicial
-- (quais serviços, nichos e origens existem) é decisão do proprietário, feita depois pela interface ou por um script revisado.
--
-- TRÊS ENTIDADES INDEPENDENTES (decisão D1): crm_services, crm_niches, crm_lead_origins. Cada uma tem um IDENTIFICADOR ESTÁVEL
-- (`service:<uuid>`, `niche:<uuid>`, `origin:<uuid>`), gerado pela APLICAÇÃO e independente do nome — para que, numa fase futura,
-- Clientes e Negociações referenciem o catálogo por id, e um nome possa mudar sem soltar as referências. Nenhuma foreign key aponta
-- para estas tabelas ainda.
--
-- UNICIDADE (decisão D4/qualidade): `nome_normalizado` (minúsculas, sem acento, sem pontuação, espaços colapsados — calculado pela
-- aplicação, src/crm/catalogDomain.js#normalizeCatalogName) é ÚNICO por tabela, contando também os itens DESATIVADOS: reativar um item
-- nunca colide com outro. É também a proteção contra duas criações CONCORRENTES (mesmo entre processos): a segunda falha com
-- unique_violation (23505), que o adapter traduz em "nome duplicado". O banco não consegue conferir que `nome_normalizado` vem de
-- `nome` (isso exigiria a extensão unaccent); essa consistência é da aplicação.
--
-- SEM EXCLUSÃO FÍSICA (decisão D4): nenhuma função, rota ou política de DELETE. "Excluir" = DESATIVAR (ativo = false).
--
-- COR DE NICHO: `cor` guarda só a CHAVE de uma paleta fixa de 20 cores (src/crm/catalogConstants.js#NICHE_COLORS); o banco repete a
-- lista num CHECK (defesa em profundidade) e um teste confere que as duas listas são idênticas. Trocar a paleta exige uma migration.
-- Nenhum valor de cor (hex) é guardado: a interface o resolve por classes de CSS (CSP style-src 'self').
--
-- PREÇO DE REFERÊNCIA (serviços): só INFORMATIVO. Nada neste esquema ou no código o copia para o valor de uma proposta.
--
-- RLS: LIGADA e SEM nenhuma policy, o mesmo padrão D1/D2 de todas as tabelas do projeto — o servidor usa a service_role (que ignora
-- RLS); anon/authenticated não leem nem escrevem nada aqui.

-- ------------------------------------------------------------------------------------------------------------
-- SERVIÇOS
-- ------------------------------------------------------------------------------------------------------------
CREATE TABLE public.crm_services (
  id                  TEXT PRIMARY KEY
                        CHECK (id ~ '^service:[0-9a-f-]{36}$'),
  nome                TEXT NOT NULL
                        CHECK (btrim(nome) <> '' AND char_length(nome) <= 80),
  nome_normalizado    TEXT NOT NULL
                        CHECK (btrim(nome_normalizado) <> '' AND char_length(nome_normalizado) <= 80),
  descricao           TEXT
                        CHECK (descricao IS NULL OR (btrim(descricao) <> '' AND char_length(descricao) <= 500)),
  ativo               BOOLEAN NOT NULL DEFAULT true,
  ordem               INTEGER NOT NULL DEFAULT 0
                        CHECK (ordem >= 0),
  categoria           TEXT
                        CHECK (categoria IS NULL OR (btrim(categoria) <> '' AND char_length(categoria) <= 60)),
  preco_referencia    NUMERIC(15,2)
                        CHECK (preco_referencia IS NULL OR (preco_referencia >= 0 AND preco_referencia <= 1000000000)),
  tipo_cobranca       TEXT
                        CHECK (tipo_cobranca IS NULL OR tipo_cobranca IN ('UNICA', 'RECORRENTE')),
  recorrencia         TEXT
                        CHECK (recorrencia IS NULL OR recorrencia IN ('MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id  TEXT CHECK (created_by_user_id IS NULL OR btrim(created_by_user_id) <> ''),
  created_by_name     TEXT CHECK (created_by_name IS NULL OR btrim(created_by_name) <> ''),
  updated_by_user_id  TEXT CHECK (updated_by_user_id IS NULL OR btrim(updated_by_user_id) <> ''),
  updated_by_name     TEXT CHECK (updated_by_name IS NULL OR btrim(updated_by_name) <> ''),
  CONSTRAINT crm_services_nome_normalizado_key UNIQUE (nome_normalizado),
  -- RECORRENTE exige uma recorrência, e só ele a tem (a mesma regra de src/crm/catalogDomain.js).
  CONSTRAINT crm_services_cobranca_coerente CHECK ((tipo_cobranca IS NOT DISTINCT FROM 'RECORRENTE') = (recorrencia IS NOT NULL))
);
CREATE INDEX crm_services_ordem_idx ON public.crm_services (ordem, nome_normalizado);

-- ------------------------------------------------------------------------------------------------------------
-- NICHOS
-- ------------------------------------------------------------------------------------------------------------
CREATE TABLE public.crm_niches (
  id                  TEXT PRIMARY KEY
                        CHECK (id ~ '^niche:[0-9a-f-]{36}$'),
  nome                TEXT NOT NULL
                        CHECK (btrim(nome) <> '' AND char_length(nome) <= 80),
  nome_normalizado    TEXT NOT NULL
                        CHECK (btrim(nome_normalizado) <> '' AND char_length(nome_normalizado) <= 80),
  descricao           TEXT
                        CHECK (descricao IS NULL OR (btrim(descricao) <> '' AND char_length(descricao) <= 500)),
  ativo               BOOLEAN NOT NULL DEFAULT true,
  ordem               INTEGER NOT NULL DEFAULT 0
                        CHECK (ordem >= 0),
  cor                 TEXT
                        CHECK (cor IS NULL OR cor IN (
                          'vermelho', 'laranja', 'ambar', 'amarelo', 'lima', 'verde', 'esmeralda', 'turquesa', 'ciano', 'celeste',
                          'azul', 'indigo', 'violeta', 'roxo', 'orquidea', 'magenta', 'rosa', 'carmim', 'marrom', 'ardosia'
                        )),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id  TEXT CHECK (created_by_user_id IS NULL OR btrim(created_by_user_id) <> ''),
  created_by_name     TEXT CHECK (created_by_name IS NULL OR btrim(created_by_name) <> ''),
  updated_by_user_id  TEXT CHECK (updated_by_user_id IS NULL OR btrim(updated_by_user_id) <> ''),
  updated_by_name     TEXT CHECK (updated_by_name IS NULL OR btrim(updated_by_name) <> ''),
  CONSTRAINT crm_niches_nome_normalizado_key UNIQUE (nome_normalizado)
);
CREATE INDEX crm_niches_ordem_idx ON public.crm_niches (ordem, nome_normalizado);

-- ------------------------------------------------------------------------------------------------------------
-- ORIGENS DOS LEADS (a origem COMERCIAL do lead — por onde ele chegou — e não a URL de fonte da Prospecção)
-- ------------------------------------------------------------------------------------------------------------
CREATE TABLE public.crm_lead_origins (
  id                  TEXT PRIMARY KEY
                        CHECK (id ~ '^origin:[0-9a-f-]{36}$'),
  nome                TEXT NOT NULL
                        CHECK (btrim(nome) <> '' AND char_length(nome) <= 80),
  nome_normalizado    TEXT NOT NULL
                        CHECK (btrim(nome_normalizado) <> '' AND char_length(nome_normalizado) <= 80),
  descricao           TEXT
                        CHECK (descricao IS NULL OR (btrim(descricao) <> '' AND char_length(descricao) <= 500)),
  ativo               BOOLEAN NOT NULL DEFAULT true,
  ordem               INTEGER NOT NULL DEFAULT 0
                        CHECK (ordem >= 0),
  canal               TEXT
                        CHECK (canal IS NULL OR canal IN ('PROSPECCAO_ATIVA', 'ANUNCIO_PAGO', 'INDICACAO', 'ORGANICO', 'PARCERIA', 'OUTRO')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id  TEXT CHECK (created_by_user_id IS NULL OR btrim(created_by_user_id) <> ''),
  created_by_name     TEXT CHECK (created_by_name IS NULL OR btrim(created_by_name) <> ''),
  updated_by_user_id  TEXT CHECK (updated_by_user_id IS NULL OR btrim(updated_by_user_id) <> ''),
  updated_by_name     TEXT CHECK (updated_by_name IS NULL OR btrim(updated_by_name) <> ''),
  CONSTRAINT crm_lead_origins_nome_normalizado_key UNIQUE (nome_normalizado)
);
CREATE INDEX crm_lead_origins_ordem_idx ON public.crm_lead_origins (ordem, nome_normalizado);

-- ------------------------------------------------------------------------------------------------------------
-- RLS — LIGADA, SEM POLICY (o mesmo padrão D1/D2 do projeto)
-- ------------------------------------------------------------------------------------------------------------
ALTER TABLE public.crm_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_niches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_lead_origins ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------------------------------------
-- updated_at AUTOMÁTICO — uma função própria desta migration (nunca reaproveita a de outra migration, que pode não estar aplicada).
-- ------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.crm_catalogs_bump_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_services_bump_updated_at_trigger
  BEFORE UPDATE ON public.crm_services
  FOR EACH ROW EXECUTE FUNCTION public.crm_catalogs_bump_updated_at();
CREATE TRIGGER crm_niches_bump_updated_at_trigger
  BEFORE UPDATE ON public.crm_niches
  FOR EACH ROW EXECUTE FUNCTION public.crm_catalogs_bump_updated_at();
CREATE TRIGGER crm_lead_origins_bump_updated_at_trigger
  BEFORE UPDATE ON public.crm_lead_origins
  FOR EACH ROW EXECUTE FUNCTION public.crm_catalogs_bump_updated_at();

-- ------------------------------------------------------------------------------------------------------------
-- REORDENAÇÃO ATÔMICA (chamada por RPC pelo adapter — src/crm-adapters/crmSupabaseCatalogRepository.js)
-- ------------------------------------------------------------------------------------------------------------
-- Grava ordem = posição (0, 1, 2...) em cada id da lista, numa ÚNICA transação (uma função PL/pgSQL nunca deixa a ordem pela
-- metade). Só as linhas cuja ordem MUDA são atualizadas (e só elas ganham o responsável e o novo updated_at). Recusa lista vazia,
-- ids repetidos, catálogo desconhecido e id inexistente — nada é gravado nesses casos. Quem exige que a lista contenha TODOS os
-- itens é o domínio (catalogDomain.js); aqui basta a lista ser coerente. SECURITY INVOKER + só a service_role executa.
CREATE FUNCTION public.reorder_crm_catalog(
  p_catalog TEXT,
  p_ordered_ids TEXT[],
  p_actor_user_id TEXT,
  p_actor_name TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_expected INTEGER;
  v_found INTEGER;
BEGIN
  v_expected := coalesce(array_length(p_ordered_ids, 1), 0);
  IF v_expected = 0 THEN
    RAISE EXCEPTION 'reorder_crm_catalog: lista de ids vazia' USING ERRCODE = 'P0001';
  END IF;
  IF v_expected <> (SELECT count(DISTINCT x) FROM unnest(p_ordered_ids) AS x) THEN
    RAISE EXCEPTION 'reorder_crm_catalog: ids repetidos' USING ERRCODE = 'P0001';
  END IF;

  IF p_catalog = 'servicos' THEN
    SELECT count(*) INTO v_found FROM public.crm_services WHERE id = ANY (p_ordered_ids);
  ELSIF p_catalog = 'nichos' THEN
    SELECT count(*) INTO v_found FROM public.crm_niches WHERE id = ANY (p_ordered_ids);
  ELSIF p_catalog = 'origens' THEN
    SELECT count(*) INTO v_found FROM public.crm_lead_origins WHERE id = ANY (p_ordered_ids);
  ELSE
    RAISE EXCEPTION 'reorder_crm_catalog: catálogo desconhecido' USING ERRCODE = 'P0001';
  END IF;
  IF v_found <> v_expected THEN
    RAISE EXCEPTION 'reorder_crm_catalog: item inexistente' USING ERRCODE = 'P0001';
  END IF;

  IF p_catalog = 'servicos' THEN
    UPDATE public.crm_services s
       SET ordem = (t.pos - 1)::INTEGER, updated_by_user_id = p_actor_user_id, updated_by_name = p_actor_name
      FROM unnest(p_ordered_ids) WITH ORDINALITY AS t(item_id, pos)
     WHERE s.id = t.item_id AND s.ordem IS DISTINCT FROM (t.pos - 1)::INTEGER;
  ELSIF p_catalog = 'nichos' THEN
    UPDATE public.crm_niches s
       SET ordem = (t.pos - 1)::INTEGER, updated_by_user_id = p_actor_user_id, updated_by_name = p_actor_name
      FROM unnest(p_ordered_ids) WITH ORDINALITY AS t(item_id, pos)
     WHERE s.id = t.item_id AND s.ordem IS DISTINCT FROM (t.pos - 1)::INTEGER;
  ELSE
    UPDATE public.crm_lead_origins s
       SET ordem = (t.pos - 1)::INTEGER, updated_by_user_id = p_actor_user_id, updated_by_name = p_actor_name
      FROM unnest(p_ordered_ids) WITH ORDINALITY AS t(item_id, pos)
     WHERE s.id = t.item_id AND s.ordem IS DISTINCT FROM (t.pos - 1)::INTEGER;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_crm_catalog(TEXT, TEXT[], TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reorder_crm_catalog(TEXT, TEXT[], TEXT, TEXT) TO service_role;

COMMENT ON TABLE public.crm_services IS 'Catálogo de Serviços do CRM (decisão 0026). NÃO aplicada automaticamente — ver supabase/README.md.';
COMMENT ON TABLE public.crm_niches IS 'Catálogo de Nichos do CRM (decisão 0026). NÃO aplicada automaticamente — ver supabase/README.md.';
COMMENT ON TABLE public.crm_lead_origins IS 'Catálogo de Origens dos Leads do CRM (decisão 0026). NÃO aplicada automaticamente — ver supabase/README.md.';
