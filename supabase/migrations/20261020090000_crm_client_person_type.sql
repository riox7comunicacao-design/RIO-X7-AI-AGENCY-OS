-- ============================================================================================================
-- CRM — CLIENTES PESSOA FÍSICA / PESSOA JURÍDICA (CRM 5.0, Fase D2, decisão 0030)
-- ============================================================================================================
-- NÃO APLICADA. Este arquivo é só a proposta versionada (ver tests/db/crmClientPersonTypeMigration.test.js, que só lê este texto).
-- Aplicar é uma ação humana e consciente do proprietário, depois de revisar este arquivo, na ordem descrita abaixo e numa transação.
-- O estado real do banco NÃO foi consultado por este arquivo nem pelos testes. NUNCA foi exercitada num PostgreSQL real.
--
-- PRÉ-REQUISITOS (o primeiro comando abaixo confere e ABORTA, citando o que falta):
--   20260927120000_crm_initial_schema.sql   crm_records                      (APLICADA)
--   20260928090000_crm_delete_audit.sql     crm_record_deletions e delete_crm_record_with_audit (APLICADA)
--
-- O QUE ESTA MIGRATION FAZ (ADITIVA: nenhum dado existente é alterado ou apagado; as colunas novas nascem NULL):
--   1) crm_records ganha QUATRO colunas: tipo_pessoa ('PF' | 'PJ' | NULL), nome_completo, cpf e cnpj. Os 31 campos legados seguem como estavam.
--   2) crm_records.empresa deixa de ser NOT NULL: uma Pessoa Física se identifica por nome_completo, e `empresa` NÃO guarda o nome de uma pessoa
--      (nenhum nome artificial num campo errado). Em troca, uma restrição de COERÊNCIA exige: PJ e registro SEM tipo -> empresa preenchida;
--      PF -> nome_completo preenchido. Todo registro que existe hoje (tem empresa, não tem tipo) satisfaz a restrição sem nenhuma alteração.
--   3) Formato de CPF (11 dígitos) e de CNPJ (12 caracteres 0-9/A-Z + 2 dígitos; o CNPJ alfanumérico da Receita convive com o numérico). Os
--      DÍGITOS VERIFICADORES são conferidos pela aplicação (src/crm/clientIdentity.js), não pelo banco: o banco garante só o formato guardado.
--   4) delete_crm_record_with_audit passa a gravar na auditoria o NOME DE EXIBIÇÃO (empresa, ou nome_completo quando a Pessoa Física não tem
--      empresa): sem isto, excluir uma PF faria o INSERT de auditoria violar o NOT NULL de crm_record_deletions.empresa e a exclusão falharia.
--      A auditoria continua guardando o registro COMPLETO em record_snapshot (as colunas novas entram sozinhas, via to_jsonb). O corpo da função é o
--      de sempre; só a expressão do nome muda. O EXECUTE é restabelecido NOMINALMENTE (PUBLIC, anon e authenticated revogados; só service_role).
--   5) PRIVILÉGIOS (correção de segurança): no Supabase, toda tabela nova do schema public nasce com SELECT/INSERT/UPDATE/DELETE concedidos a `anon` e `authenticated` (a RLS ligada e
--      SEM policy é a única barreira hoje: o banco real confirmou essas concessões em crm_records). Esta migration REVOGA, NOMINALMENTE, todo privilégio direto de PUBLIC, anon e
--      authenticated sobre crm_records e sobre crm_record_deletions (a auditoria guarda o registro completo, inclusive CPF/CNPJ e nome), sobre as duas sequências de identidade e sobre a
--      função de gatilho crm_records_bump_version(), e RESTABELECE só para service_role o que o servidor usa. O backend acessa o CRM SÓ pelo PostgREST com a chave service_role
--      (src/crm-adapters/*); a chave anon do navegador serve apenas para autenticar (login/getUser) e nunca lê estas tabelas. Mantém a RLS ligada e ZERO policies; nenhuma linha muda.
--
-- O QUE NÃO FAZ: não cria nem altera nenhuma linha de dados; não infere o tipo de nenhum registro antigo (todos ficam com tipo NULL até uma pessoa
-- definir pela tela); não cria índice único em cpf/cnpj (a duplicidade é decidida pelo domínio, como a de site e telefone — a proteção entre processos
-- continua sendo o limite já registrado); não toca em funis, negociações, catálogos nem prospecção.
--
-- ORDEM SEGURA DE IMPLANTAÇÃO:
--   a) PARAR o servidor operacional (nenhuma escrita no CRM durante a migration);
--   b) rodar o ANTES, aplicar ESTA migration numa transação (BEGIN; ... COMMIT;) — se algo falhar, ROLLBACK e nada muda;
--   c) NOTIFY pgrst, 'reload schema'; (se o PostgREST ainda não enxergar as colunas novas) e rodar o DEPOIS;
--   d) SÓ ENTÃO atualizar o código (git pull) e subir o servidor novo. O código novo grava as quatro colunas em TODO registro: sem a migration, toda
--      escrita no CRM seria recusada pelo PostgREST. O servidor ANTIGO continua compatível com o banco migrado (ignora as colunas novas).
--
-- (Os REVOKE de privilégios da seção 5 são correções de segurança e NÃO são desfeitos: nenhum caminho legítimo depende de anon/authenticated nestas tabelas.)
-- DESFAZER (só ENQUANTO NENHUMA Pessoa Física tiver sido cadastrada — com PF gravada, `empresa` é NULL nela e o NOT NULL não volta; nesse caso NÃO desfaça):
--   a) ALTER TABLE public.crm_records DROP CONSTRAINT crm_records_identificacao_check, DROP CONSTRAINT crm_records_tipo_pessoa_check,
--        DROP CONSTRAINT crm_records_nome_completo_check, DROP CONSTRAINT crm_records_cpf_check, DROP CONSTRAINT crm_records_cnpj_check;
--   b) ALTER TABLE public.crm_records ALTER COLUMN empresa SET NOT NULL;
--   c) ALTER TABLE public.crm_records DROP COLUMN tipo_pessoa, DROP COLUMN nome_completo, DROP COLUMN cpf, DROP COLUMN cnpj;
--   d) recriar delete_crm_record_with_audit com `v_row.empresa` no INSERT (o corpo original está em 20260928090000_crm_delete_audit.sql) e reaplicar o EXECUTE.
-- ============================================================================================================

-- ------------------------------------------------------------------------------------------------------------
-- 0) PRÉ-REQUISITOS — aborta citando o que falta, ou se esta migration já foi aplicada. Nada é alterado se aqui falhar.
-- ------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.crm_records') IS NULL THEN
    RAISE EXCEPTION 'pré-requisito ausente: crm_records (20260927120000_crm_initial_schema.sql)';
  END IF;
  IF to_regclass('public.crm_record_deletions') IS NULL OR to_regprocedure('public.delete_crm_record_with_audit(text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'pré-requisito ausente: auditoria de exclusão do CRM (20260928090000_crm_delete_audit.sql)';
  END IF;
  IF to_regclass('public.crm_records_seq_seq') IS NULL OR to_regclass('public.crm_record_deletions_id_seq') IS NULL OR to_regprocedure('public.crm_records_bump_version()') IS NULL THEN
    RAISE EXCEPTION 'pré-requisito ausente: as sequências de identidade de crm_records/crm_record_deletions ou a função crm_records_bump_version() (a seção de privilégios as nomeia)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'crm_records' AND column_name IN ('tipo_pessoa', 'nome_completo', 'cpf', 'cnpj')
  ) THEN
    RAISE EXCEPTION 'esta migration já foi aplicada (crm_records tem tipo_pessoa/nome_completo/cpf/cnpj): nada foi alterado';
  END IF;
END
$$;

-- ------------------------------------------------------------------------------------------------------------
-- 1) COLUNAS NOVAS (todas opcionais: os registros que existem nascem com NULL, isto é, "sem tipo definido")
-- ------------------------------------------------------------------------------------------------------------
ALTER TABLE public.crm_records
  ADD COLUMN tipo_pessoa   TEXT,
  ADD COLUMN nome_completo TEXT,
  ADD COLUMN cpf           TEXT,
  ADD COLUMN cnpj          TEXT;

ALTER TABLE public.crm_records
  ADD CONSTRAINT crm_records_tipo_pessoa_check   CHECK (tipo_pessoa IS NULL OR tipo_pessoa IN ('PF', 'PJ')),
  ADD CONSTRAINT crm_records_nome_completo_check CHECK (nome_completo IS NULL OR btrim(nome_completo) <> ''),
  ADD CONSTRAINT crm_records_cpf_check           CHECK (cpf IS NULL OR cpf ~ '^[0-9]{11}$'),
  ADD CONSTRAINT crm_records_cnpj_check          CHECK (cnpj IS NULL OR cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$');

-- ------------------------------------------------------------------------------------------------------------
-- 2) `empresa` deixa de ser NOT NULL — e a COERÊNCIA da identificação passa a ser uma restrição do banco
--    (a restrição CHECK de formato de `empresa`, `btrim(empresa) <> ''`, continua valendo: NULL ou texto não vazio)
-- ------------------------------------------------------------------------------------------------------------
ALTER TABLE public.crm_records ALTER COLUMN empresa DROP NOT NULL;

ALTER TABLE public.crm_records
  ADD CONSTRAINT crm_records_identificacao_check CHECK (
    -- registro ANTIGO, sem tipo: exatamente o contrato legado (empresa obrigatória) e nada dos campos novos
    (tipo_pessoa IS NULL AND empresa IS NOT NULL AND nome_completo IS NULL AND cpf IS NULL AND cnpj IS NULL)
    -- (IS NOT DISTINCT FROM em vez de =: com tipo NULL, `NULL = 'PF'` seria desconhecido e um CHECK desconhecido APROVA a linha — um registro sem tipo, com nome completo e sem empresa passaria)
    -- Pessoa Física: nome completo obrigatório, sem CNPJ; `empresa` é opcional (um registro antigo convertido mantém a que tinha)
    OR (tipo_pessoa IS NOT DISTINCT FROM 'PF' AND nome_completo IS NOT NULL AND cnpj IS NULL)
    -- Pessoa Jurídica: empresa obrigatória, sem nome completo e sem CPF
    OR (tipo_pessoa IS NOT DISTINCT FROM 'PJ' AND empresa IS NOT NULL AND nome_completo IS NULL AND cpf IS NULL)
  );

COMMENT ON COLUMN public.crm_records.tipo_pessoa IS 'PF (Pessoa Física), PJ (Pessoa Jurídica) ou NULL (registro antigo, ainda sem tipo definido — nunca inferido).';
COMMENT ON COLUMN public.crm_records.nome_completo IS 'Nome da Pessoa Física. A Pessoa Jurídica usa `empresa`; o nome de uma pessoa nunca é guardado em `empresa`.';
COMMENT ON COLUMN public.crm_records.cpf IS 'CPF só com os 11 dígitos (sem pontuação). Opcional; só para Pessoa Física. Dígitos verificadores conferidos pela aplicação.';
COMMENT ON COLUMN public.crm_records.cnpj IS 'CNPJ só com os 14 caracteres (12 de 0-9/A-Z + 2 dígitos, sem pontuação). Opcional; só para Pessoa Jurídica. Dígitos verificadores conferidos pela aplicação.';

-- ------------------------------------------------------------------------------------------------------------
-- 3) AUDITORIA DA EXCLUSÃO: o nome de exibição (empresa, ou nome_completo da Pessoa Física sem empresa) — o resto do corpo é o de sempre
-- ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_crm_record_with_audit(
  p_id TEXT,
  p_deleted_by_user_id TEXT,
  p_deleted_by_name TEXT,
  p_deleted_by_role TEXT,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER -- explícito: o padrão do Postgres, e o correto aqui (ver a nota no cabeçalho de 20260928090000_crm_delete_audit.sql).
AS $$
DECLARE
  v_row     public.crm_records;
  v_snapshot JSONB;
BEGIN
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

  SELECT * INTO v_row FROM public.crm_records WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delete_crm_record_with_audit: registro % não encontrado', p_id USING ERRCODE = 'P0002';
  END IF;

  v_snapshot := to_jsonb(v_row);

  INSERT INTO public.crm_record_deletions (
    crm_record_id, empresa, record_snapshot,
    deleted_by_user_id, deleted_by_name, deleted_by_role, reason
  ) VALUES (
    v_row.id, COALESCE(v_row.empresa, v_row.nome_completo), v_snapshot,
    p_deleted_by_user_id, p_deleted_by_name, p_deleted_by_role, p_reason
  );

  DELETE FROM public.crm_records WHERE id = p_id;

  RETURN jsonb_build_object('deleted_id', p_id);
END;
$$;

COMMENT ON FUNCTION public.delete_crm_record_with_audit IS
  'Único caminho para excluir um registro do CRM (decisão 0025): localiza, grava a auditoria em '
  'crm_record_deletions (com o nome de exibição: empresa ou, na Pessoa Física sem empresa, o nome completo) e apaga de crm_records, '
  'tudo numa única transação (RAISE EXCEPTION desfaz os dois passos). Não confere autorização — isso é do servidor, antes de chamar esta função.';

-- EXECUTE nominal: no Supabase, REVOKE FROM PUBLIC sozinho NÃO retira os EXECUTE explícitos de anon e authenticated.
REVOKE ALL ON FUNCTION public.delete_crm_record_with_audit(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_crm_record_with_audit(TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------------------------------------------------------
-- 4) PRIVILÉGIOS: nenhum acesso direto de PUBLIC, anon ou authenticated; só service_role (o backend). RLS segue ligada, sem policy.
--    REVOKE ALL ao nível da tabela também retira qualquer privilégio de COLUNA que exista. O que o servidor usa de crm_records e da auditoria é restabelecido só para service_role.
-- ------------------------------------------------------------------------------------------------------------
REVOKE ALL ON TABLE public.crm_records FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_records TO service_role;
REVOKE ALL ON TABLE public.crm_record_deletions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.crm_record_deletions TO service_role;
REVOKE ALL ON SEQUENCE public.crm_records_seq_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.crm_records_seq_seq TO service_role;
REVOKE ALL ON SEQUENCE public.crm_record_deletions_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.crm_record_deletions_id_seq TO service_role;
REVOKE ALL ON FUNCTION public.crm_records_bump_version() FROM PUBLIC, anon, authenticated;
