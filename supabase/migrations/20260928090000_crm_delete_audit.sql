-- ============================================================================================================
-- CRM — auditoria de exclusão administrativa (decisão 0025)
-- ============================================================================================================
-- NÃO APLICADA. Este arquivo é só a proposta versionada. Ninguém (código, script, CI) a executa automaticamente
-- (ver tests/db/crmDeleteAuditMigration.test.js, que só lê este texto). Aplicar é uma ação humana e consciente do
-- proprietário (SQL Editor do Supabase, ou `supabase db push` com o CLI), depois de revisar este arquivo e a
-- decisão 0025 (docs/decisions/0025-crm-admin-delete.md).
--
-- ESCOPO: exclusivamente a EXCLUSÃO ADMINISTRATIVA e IRREVERSÍVEL de um registro do CRM (src/crm/crmDomain.js
-- `deleteRecord`, src/services/crmService.js `deleteRecord`, DELETE /api/crm/:id). Nenhuma outra operação do CRM
-- muda. Esta migration soma-se a 20260927120000_crm_initial_schema.sql (que já deve estar aplicada) — ela não a
-- substitui nem a repete.
--
-- POR QUE UMA TABELA + UMA FUNÇÃO, E NÃO SÓ UM DELETE:
--   - a exclusão é HARD DELETE (decisão 0025, opção F2 — não soft delete, não log local): o registro realmente
--     deixa de existir em public.crm_records. Sem uma cópia do que existia, a exclusão não deixaria rastro
--     nenhum — nem para auditoria, nem para investigar um erro humano.
--   - a tabela public.crm_record_deletions abaixo é essa cópia: quem, quando, por quê, e o registro (com seu
--     histórico) exatamente como estava um instante antes de deixar de existir.
--   - a função public.delete_crm_record_with_audit(...) é o ÚNICO caminho para preencher essa tabela E apagar o
--     registro: as duas coisas acontecem na MESMA transação implícita de uma função PL/pgSQL — ou as duas
--     acontecem, ou nenhuma (ver a seção ATOMICIDADE abaixo). O adapter (src/crm-adapters/crmSupabaseRepository.js)
--     NUNCA faz um DELETE direto em crm_records para esta operação; ele só chama este RPC.
--
-- ATOMICIDADE (ponto crítico da decisão 0025): esta função nunca deixa uma exclusão sem auditoria, nem uma
-- auditoria de uma exclusão que não aconteceu. Uma função PL/pgSQL executa dentro da transação de quem a chama;
-- um RAISE EXCEPTION em qualquer ponto desfaz TUDO que a função já tinha feito (o INSERT em
-- crm_record_deletions, se já tivesse rodado, seria desfeito junto). Não há como esta função inserir a auditoria
-- e falhar ao apagar (ou vice-versa) sem que o Postgres desfaça os dois passos inteiros.
--
-- QUEM PODE CHAMAR: só service_role (ver GRANT/REVOKE ao final). O servidor (o único a falar com este banco, D1
-- da decisão 0024) é quem decide SE uma exclusão pode acontecer — DELETE:CRM, só ADMIN (src/auth/constants.js,
-- src/auth/crmBridge.js) — ANTES de chamar este RPC; esta função não conhece usuário, permissão nem sessão: ela
-- só recebe os dados já autorizados (id, quem, por quê) e os executa atomicamente. SECURITY INVOKER (o padrão do
-- Postgres, mantido explícito abaixo) é suficiente e mais seguro que SECURITY DEFINER: o único chamador
-- (service_role) já ignora RLS por natureza, então não há privilégio a elevar — SECURITY DEFINER seria um risco
-- de escalonamento sem nenhum benefício aqui.
-- ============================================================================================================

-- ------------------------------------------------------------------------------------------------------------
-- TABELA DE AUDITORIA — só para auditoria; NUNCA usada pelo funcionamento normal do CRM (não é lida por
-- listRecords/getRecord/getHistory, nem por nenhuma rota da API hoje).
-- ------------------------------------------------------------------------------------------------------------
CREATE TABLE public.crm_record_deletions (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                        -- id PRÓPRIO da linha de auditoria — nada a ver com o id do registro excluído (guardado
                        -- abaixo, em crm_record_id). Nunca reutilizado, nunca exposto ao domínio do CRM.

  -- O QUE foi excluído --------------------------------------------------------------------------------------
  crm_record_id       TEXT NOT NULL
                        CHECK (crm_record_id ~ '^crm:[0-9a-f-]{36}$'),
                        -- o id que o registro tinha em public.crm_records (mesmo formato "crm:<uuid>" da
                        -- migration inicial). A linha do CRM já não existe mais quando esta consulta roda — não
                        -- há FOREIGN KEY para crm_records de propósito (o registro referenciado deixou de
                        -- existir no mesmo instante em que esta linha nasce; uma FK exigiria a ordem inversa).
  empresa              TEXT NOT NULL
                        CHECK (btrim(empresa) <> ''),
                        -- cópia do nome da empresa, SÓ para permitir localizar/filtrar uma exclusão sem abrir o
                        -- JSONB (record_snapshot já traz o mesmo valor; esta coluna existe por conveniência de
                        -- consulta, exigida explicitamente pela decisão 0025 ("preservar, no mínimo: ... a
                        -- empresa")).
  record_snapshot      JSONB NOT NULL
                        CHECK (jsonb_typeof(record_snapshot) = 'object')
                        -- Snapshot COMPLETO (revisão da decisão 0025, correção 3O.5): o registro INTEIRO como
                        -- estava um instante antes da exclusão — TODOS os CRM_WRITABLE_FIELDS, os campos
                        -- gerenciados (id, status, data_de_entrada) e TAMBÉM historico, seq, version e updated_at.
                        -- NADA é removido do snapshot: `to_jsonb(linha)` sem subtração nenhuma (ver a função
                        -- abaixo). Os três CHECKs seguintes só tornam essa garantia explícita no banco — uma
                        -- futura alteração da função que voltasse a podar o snapshot quebraria a gravação, nunca
                        -- passaria em silêncio.
                        CHECK (record_snapshot ? 'historico')
                        CHECK (record_snapshot ? 'version')
                        CHECK (record_snapshot ? 'updated_at'),
                        -- NUNCA contém senha, token nem nenhum segredo: o registro do CRM em si nunca teve esses
                        -- campos (CRM_WRITABLE_FIELDS, src/crm/constants.js) — a função abaixo só copia o que já
                        -- existia na linha, e a linha nunca teve um campo de credencial.

  -- QUEM excluiu e POR QUÊ ------------------------------------------------------------------------------------
  deleted_by_user_id   TEXT NOT NULL CHECK (btrim(deleted_by_user_id) <> ''),
                        -- o userId do AuthorizationContext de quem excluiu (nunca algo vindo do corpo da
                        -- requisição — ver src/services/crmService.js `deleteRecord`).
  deleted_by_name      TEXT NOT NULL CHECK (btrim(deleted_by_name) <> ''),
  deleted_by_role      TEXT NOT NULL CHECK (btrim(deleted_by_role) <> ''),
                        -- os três acima são o "ator autenticado" e o "papel do ator" que a decisão 0025 exige
                        -- preservar; nenhum é um segredo (nunca senha, token nem authUserId do Supabase Auth).
  reason               TEXT NOT NULL CHECK (btrim(reason) <> ''),
                        -- o motivo informado — OBRIGATÓRIO (decisão 0025, regra 5): esta coluna NUNCA aceita
                        -- vazio; o Service já recusa (400) antes de chegar aqui, e este CHECK é a segunda camada
                        -- de defesa, do lado do banco.

  -- QUANDO ---------------------------------------------------------------------------------------------------
  deleted_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.crm_record_deletions IS
  'Auditoria da exclusão ADMINISTRATIVA e IRREVERSÍVEL de registros do CRM (decisão 0025). record_snapshot é o '
  'registro COMPLETO (incluindo historico, seq, version e updated_at) um instante antes da exclusão. Só é '
  'preenchida pela função public.delete_crm_record_with_audit, atomicamente com o DELETE do registro. Nunca é '
  'usada pelo funcionamento normal do CRM — existe só para auditoria.';

CREATE INDEX crm_record_deletions_crm_record_id_idx ON public.crm_record_deletions (crm_record_id);
CREATE INDEX crm_record_deletions_deleted_at_idx ON public.crm_record_deletions (deleted_at);

-- RLS — LIGADA, SEM POLICY (mesmo padrão D1/D2 de crm_records, decisão 0024): só o servidor, com service_role,
-- acessa esta tabela; a service_role ignora RLS por natureza, então isso não bloqueia a função abaixo.
ALTER TABLE public.crm_record_deletions ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------------------------------------
-- FUNÇÃO TRANSACIONAL — localiza, audita e apaga, atomicamente
-- ------------------------------------------------------------------------------------------------------------
-- p_id: o id do registro (formato "crm:<uuid>"). p_deleted_by_*: o ator autenticado (já autorizado pelo Service —
-- esta função não confere DELETE:CRM nem nenhuma permissão, ela SÓ executa o que já foi decidido). p_reason: o
-- motivo (obrigatório). Devolve um pequeno JSONB de confirmação; nunca o registro inteiro de volta.
CREATE FUNCTION public.delete_crm_record_with_audit(
  p_id TEXT,
  p_deleted_by_user_id TEXT,
  p_deleted_by_name TEXT,
  p_deleted_by_role TEXT,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER -- explícito: o padrão do Postgres, e o correto aqui (ver a nota no cabeçalho do arquivo).
AS $$
DECLARE
  v_row     public.crm_records;
  v_snapshot JSONB;
BEGIN
  -- Validação de entrada: nunca confia no chamador (defesa em profundidade — o Service já valida tudo isto antes
  -- de chegar aqui). ERRCODE 22023 (invalid_parameter_value) é reconhecido como erro de validação pelo adapter
  -- (src/crm-adapters/crmSupabaseRepository.js, POSTGRES_VALIDATION_CODES).
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RAISE EXCEPTION 'delete_crm_record_with_audit: p_id é obrigatório' USING ERRCODE = '22023';
  END IF;
  IF p_deleted_by_user_id IS NULL OR btrim(p_deleted_by_user_id) = ''
     OR p_deleted_by_name IS NULL OR btrim(p_deleted_by_name) = ''
     OR p_deleted_by_role IS NULL OR btrim(p_deleted_by_role) = '' THEN
    RAISE EXCEPTION 'delete_crm_record_with_audit: p_deleted_by_user_id/p_deleted_by_name/p_deleted_by_role são obrigatórios' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'delete_crm_record_with_audit: p_reason é obrigatório' USING ERRCODE = '22023';
  END IF;

  -- Localiza e TRAVA a linha (FOR UPDATE): defesa contra uma corrida entre o requireRecord() do domínio (que já
  -- confirmou que o registro existe, um instante antes) e esta função — se outra transação apagou o registro
  -- nesse meio-tempo, FOR UPDATE espera e então não encontra nada, caindo no "not found" abaixo, nunca num
  -- comportamento indefinido.
  SELECT * INTO v_row FROM public.crm_records WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Não deveria acontecer em uso normal (o domínio já confirmou existência antes de chamar o repositório) — é
    -- só uma rede de segurança contra a janela de corrida acima. Deixa cair no 500 genérico do lado do
    -- adapter/API: não é um "404 esperado" (esse já foi tratado por requireRecord no domínio).
    RAISE EXCEPTION 'delete_crm_record_with_audit: registro % não encontrado', p_id USING ERRCODE = 'P0002';
  END IF;

  -- O snapshot é o registro INTEIRO, SEM NENHUMA subtração (revisão da decisão 0025, correção 3O.5): inclui
  -- historico, seq, version e updated_at, além de todos os campos graváveis e gerenciados — nunca inclui senha,
  -- token nem nenhum segredo: o registro do CRM nunca teve esses campos.
  v_snapshot := to_jsonb(v_row);

  INSERT INTO public.crm_record_deletions (
    crm_record_id, empresa, record_snapshot,
    deleted_by_user_id, deleted_by_name, deleted_by_role, reason
  ) VALUES (
    v_row.id, v_row.empresa, v_snapshot,
    p_deleted_by_user_id, p_deleted_by_name, p_deleted_by_role, p_reason
  );

  DELETE FROM public.crm_records WHERE id = p_id;

  RETURN jsonb_build_object('deleted_id', p_id);
END;
$$;

COMMENT ON FUNCTION public.delete_crm_record_with_audit IS
  'Único caminho para excluir um registro do CRM (decisão 0025): localiza, grava a auditoria em '
  'crm_record_deletions e apaga de crm_records, tudo numa única transação (RAISE EXCEPTION desfaz os dois '
  'passos). Não confere autorização — isso é do servidor, antes de chamar esta função.';

-- SEGURANÇA CRÍTICA: o Postgres concede EXECUTE em uma função nova a PUBLIC por padrão. Sem o REVOKE abaixo, o
-- PostgREST exporia este RPC destrutivo (POST /rest/v1/rpc/delete_crm_record_with_audit) para os papéis
-- `anon`/`authenticated` do Supabase — que hoje não têm NENHUM acesso a crm_records (D1/D2, decisão 0024). Só
-- service_role (o servidor) pode chamar esta função.
REVOKE ALL ON FUNCTION public.delete_crm_record_with_audit(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_crm_record_with_audit(TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
