-- ============================================================================================================
-- CRM — esquema PostgreSQL inicial (Fase B.1, decisão 0024 — revisão 1.1 — sobre a decisão 0023, porta
-- assíncrona do CRM).
-- ============================================================================================================
-- NÃO APLICADA. Este arquivo é só a proposta versionada. Ninguém (código, script, CI) a executa automaticamente
-- (ver tests/db/crmMigration.test.js, que só lê este texto). Aplicar é uma ação humana e consciente do proprietário
-- (SQL Editor do Supabase, ou `supabase db push` com o CLI), depois de revisar este arquivo e a decisão 0024.
--
-- ESCOPO: só o CRM (src/crm/, src/services/crmService.js). A Approval Queue, os lotes de prospecção, os dossiês, o
-- Researcher e o Discovery CONTINUAM em data/*.json — nenhuma referência (foreign key) a eles existe aqui.
--
-- DECISÕES JÁ CONFIRMADAS (etapa 1.1, registradas na decisão 0024):
--   D1  o servidor fala com este banco usando a service_role key; ela NUNCA chega ao navegador; o navegador NUNCA
--       acessa este banco diretamente (só HTTP com o servidor, como já é hoje para data/crm.json).
--   D2  RLS fica LIGADA, e esta migration NÃO cria nenhuma policy para anon/authenticated: o acesso é só pelo
--       servidor. Como a service_role IGNORA RLS (comportamento nativo do Postgres/Supabase), a ausência de
--       policy aqui não bloqueia o servidor — ela garante que NENHUM outro caminho (anon/authenticated, se algum
--       dia alguém apontar o SDK do navegador para esta tabela por engano) consiga ler ou escrever.
--   D5  data_de_entrada continua TEXT (ver a coluna abaixo).
--   D-MONEY-SCALE  valor_proposta/valor_total usam NUMERIC(15,2), >= 0 ou NULL.
--   D-CONCURRENCY  concorrência otimista via `version`; ver a nota antes do trigger.
--   IDENTITY INDEX  REMOVIDA desta migration (decisão explícita da etapa 1.1). A deduplicação continua só em
--       JavaScript (research-prospector/normalize.js + duplicateCheck.js), como hoje — nenhuma tabela ou
--       constraint de identidade nesta etapa. Fica para uma etapa própria, com sua própria decisão.
-- ============================================================================================================

-- ------------------------------------------------------------------------------------------------------------
-- TABELA
-- ------------------------------------------------------------------------------------------------------------
-- Cada coluna abaixo é UM dos 31 campos graváveis de CRM_WRITABLE_FIELDS (src/crm/constants.js), na MESMA ordem,
-- convertido de camelCase para snake_case (googlePerfil -> google_perfil, raioXDeNicho -> raio_x_de_nicho, ...).
-- Nenhum campo foi inventado; nenhum foi removido (conferido por tests/db/crmMigration.test.js contra o
-- CRM_WRITABLE_FIELDS real). Todos são opcionais (o domínio só exige "empresa"), exceto os dois numéricos.
--
-- TEXTO EM BRANCO NUNCA É UM VALOR (invariante do domínio — sanitizeWritableInput/trimmedOrNull em crmDomain.js:
-- um texto só de espaços vira `null` antes de gravar, nunca uma string vazia). O CHECK abaixo, repetido por
-- coluna, é a MESMA regra do lado do banco — nunca um "" gravado por um caminho que não seja o domínio de hoje.
CREATE TABLE public.crm_records (
  -- Identidade e ordem -----------------------------------------------------------------------------------------
  id             TEXT PRIMARY KEY
                   CHECK (id ~ '^crm:[0-9a-f-]{36}$'),
                   -- formato "crm:<uuid>", o MESMO de hoje (crmDomain.js: `crm:${crypto.randomUUID()}`). O id
                   -- continua gerado pela APLICAÇÃO (crypto.randomUUID em Node), não pelo banco: nenhuma coluna
                   -- DEFAULT o gera aqui — decisão explícita para não duplicar a fonte da verdade do id.
  seq            BIGINT GENERATED ALWAYS AS IDENTITY,
                   -- só para PRESERVAR A ORDEM ATUAL da listagem (a de inserção, como um objeto JS/arquivo JSON
                   -- entrega hoje): o futuro adapter deve fazer `ORDER BY seq ASC` em list(). Nunca exposta ao
                   -- domínio/JS — é um detalhe de armazenamento, como o id de linha de qualquer banco relacional.

  -- Os 31 campos graváveis (CRM_WRITABLE_FIELDS), na ordem do domínio ------------------------------------------
  empresa               TEXT NOT NULL
                          CHECK (btrim(empresa) <> ''),
                          -- único campo obrigatório do domínio (createRecord exige empresa não vazia).
  contato               TEXT CHECK (contato IS NULL OR btrim(contato) <> ''),
  cargo                 TEXT CHECK (cargo IS NULL OR btrim(cargo) <> ''),
  telefone              TEXT CHECK (telefone IS NULL OR btrim(telefone) <> ''),
  whatsapp              TEXT CHECK (whatsapp IS NULL OR btrim(whatsapp) <> ''),
  email                 TEXT CHECK (email IS NULL OR btrim(email) <> ''),
  site                  TEXT CHECK (site IS NULL OR btrim(site) <> ''),
  instagram             TEXT CHECK (instagram IS NULL OR btrim(instagram) <> ''),
  facebook              TEXT CHECK (facebook IS NULL OR btrim(facebook) <> ''),
  google_perfil         TEXT CHECK (google_perfil IS NULL OR btrim(google_perfil) <> ''),
  cidade                TEXT CHECK (cidade IS NULL OR btrim(cidade) <> ''),
  estado                TEXT CHECK (estado IS NULL OR btrim(estado) <> ''),
  nicho                 TEXT CHECK (nicho IS NULL OR btrim(nicho) <> ''),
  origem                TEXT CHECK (origem IS NULL OR btrim(origem) <> ''),
  temperatura           TEXT CHECK (temperatura IS NULL OR btrim(temperatura) <> ''),
  servico_potencial     TEXT CHECK (servico_potencial IS NULL OR btrim(servico_potencial) <> ''),
  problema_identificado TEXT CHECK (problema_identificado IS NULL OR btrim(problema_identificado) <> ''),
  raio_x_de_nicho       TEXT CHECK (raio_x_de_nicho IS NULL OR btrim(raio_x_de_nicho) <> ''),
  raio_x_personalizado  TEXT CHECK (raio_x_personalizado IS NULL OR btrim(raio_x_personalizado) <> ''),
  status_do_diagnostico TEXT CHECK (status_do_diagnostico IS NULL OR btrim(status_do_diagnostico) <> ''),
  link_do_raio_x        TEXT CHECK (link_do_raio_x IS NULL OR btrim(link_do_raio_x) <> ''),
  -- as quatro "datas" abaixo são TEXTO LIVRE de propósito: o domínio (isValidFieldValue em crmDomain.js) só
  -- exige `typeof valor === 'string'` para estes campos — NUNCA validou formato de data. Uma coluna DATE aqui
  -- recusaria uma entrada que o domínio aceita hoje (ex.: "próxima semana"), o que seria uma mudança de contrato.
  data_da_analise       TEXT CHECK (data_da_analise IS NULL OR btrim(data_da_analise) <> ''),
  data_da_reuniao       TEXT CHECK (data_da_reuniao IS NULL OR btrim(data_da_reuniao) <> ''),
  link_do_meet          TEXT CHECK (link_do_meet IS NULL OR btrim(link_do_meet) <> ''),
  proxima_acao          TEXT CHECK (proxima_acao IS NULL OR btrim(proxima_acao) <> ''),
  data_da_proxima_acao  TEXT CHECK (data_da_proxima_acao IS NULL OR btrim(data_da_proxima_acao) <> ''),
  responsavel           TEXT CHECK (responsavel IS NULL OR btrim(responsavel) <> ''),
  ultima_interacao      TEXT CHECK (ultima_interacao IS NULL OR btrim(ultima_interacao) <> ''),
  -- D-MONEY-SCALE (decidida na etapa 1.1): NUMERIC(15,2), >= 0 ou NULL. O domínio (NUMERIC_FIELDS em
  -- constants.js) só valida Number.isFinite(v) && v >= 0, sem casas decimais fixas — um valor de mais de 2 casas
  -- vindo do domínio (ex.: 1500.999) seria ARREDONDADO pelo Postgres ao gravar. Hoje isso não é um risco real: o
  -- Dashboard só aceita valores monetários com 2 casas (formulário em reais), e nenhum teste grava mais que isso.
  valor_proposta        NUMERIC(15,2) CHECK (valor_proposta IS NULL OR valor_proposta >= 0),
  valor_total           NUMERIC(15,2) CHECK (valor_total IS NULL OR valor_total >= 0),
  observacoes           TEXT CHECK (observacoes IS NULL OR btrim(observacoes) <> ''),

  -- Campos GERENCIADOS pelo domínio (CRM_MANAGED_FIELDS) — nunca aceitos como entrada de escrita direta ---------
  status         TEXT NOT NULL DEFAULT 'PROSPECT'
                   CHECK (status IN (
                     'PROSPECT', 'RESEARCH', 'QUALIFIED_PROSPECT', 'CONTACTED', 'RESPONDED', 'QUALIFICATION',
                     'MEETING_SCHEDULED', 'MEETING_COMPLETED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST',
                     'DO_NOT_CONTACT'
                   )),
                   -- os 13 status oficiais de CRM_STATUS (constants.js), exatamente. CHECK, não um ENUM nativo do
                   -- Postgres: um ENUM exigiria ALTER TYPE (mais cerimônia, e historicamente não-transacional em
                   -- versões antigas do Postgres) para qualquer mudança futura; a lista oficial já vive em código
                   -- (constants.js) e viverá aqui, então CHECK é o formato mais simples de manter em sincronia.
                   -- A MÁQUINA DE ESTADOS (ALLOWED_TRANSITIONS) e a regra "DO_NOT_CONTACT é terminal" continuam
                   -- só no domínio (crmDomain.js) — o banco não impõe transição nenhuma; ela decide antes de
                   -- gravar, como hoje.
  data_de_entrada TEXT NOT NULL,
                   -- D5 (decidida na etapa 1.1): continua TEXT, para preservar EXATAMENTE o contrato atual — o
                   -- domínio gera `new Date().toISOString()` (com "Z" e milissegundos) uma vez, na criação, e essa
                   -- string precisa voltar bit a bit igual (comparações de igualdade exata já existem em testes,
                   -- ex.: tests/crm/crmAsyncPort.test.js). Um TIMESTAMPTZ nativo reformataria a string na leitura,
                   -- conforme o driver — mudança de contrato que a decisão 0024 optou por NÃO fazer nesta etapa.
  historico       JSONB NOT NULL DEFAULT '[]'::jsonb
                   CHECK (jsonb_typeof(historico) = 'array')
                   CHECK (jsonb_array_length(historico) >= 1),
                   -- JSONB, por decisão explícita da 0023 (não uma tabela filha nesta etapa). O domínio SEMPRE
                   -- cria com pelo menos 1 evento (a criação); o segundo CHECK só torna essa garantia explícita
                   -- no banco. O JSONB preserva a ORDEM do array (relevante: a idempotência de promoção depende
                   -- de historico[0], ver crmIntegrationService.js `carriesMarker`) e a forma exata de cada
                   -- evento: { timestamp, from, to, actor, reviewedBy: {userId,name,role} | null, motivo }.

  -- Infraestrutura de CONCORRÊNCIA OTIMISTA (D-CONCURRENCY, decidida na etapa 1.1) -------------------------------
  -- O Postgres/Supabase SUPORTA optimistic concurrency por version a partir destas duas colunas: a atualização
  -- do adapter (Fase B.2, ainda não escrita) deve ter o formato
  --     UPDATE public.crm_records SET <campos...> WHERE id = $1 AND version = $2 RETURNING *;
  -- Se zero linhas voltarem, a versão esperada não bate mais (outra escrita aconteceu no meio) — é um CONFLITO DE
  -- CONCORRÊNCIA, e o adapter deve tratá-lo como erro (nunca sobrescrever silenciosamente). O trigger abaixo
  -- garante que `version` sobe em TODA atualização, mesmo que o autor do UPDATE esqueça de fazê-lo à mão.
  --
  -- EVOLUÇÃO DE CONTRATO NECESSÁRIA (documentada aqui, NÃO feita nesta etapa): a porta atual
  -- (src/crm/crmRepositoryPort.js: `save(record)`) não tem como o domínio informar "a versão que eu li" nem como
  -- o adapter devolver "conflito de versão" de um jeito que o domínio entenda. Para o optimistic concurrency
  -- valer de ponta a ponta (não só dentro do banco), a porta precisaria evoluir — por exemplo, `save(record,
  -- { expectedVersion })` e um erro estável tipo `CRM: conflito de concorrência` que o domínio/Service saibam
  -- repassar. Essa mudança de contrato NÃO foi feita: o domínio (crmDomain.js) e o Service continuam exatamente
  -- como estão. As colunas abaixo só preparam o lado do BANCO; o lado do DOMÍNIO é trabalho de uma etapa futura.
  version        INTEGER NOT NULL DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
                   -- só para o mecanismo de concorrência e para observabilidade/depuração; NÃO é o mesmo campo
                   -- que data_de_entrada (a data de CRIAÇÃO do domínio, imutável). Sem equivalente no domínio, e
                   -- nenhum código de aplicação lê ou grava nela hoje — só o trigger a toca.
);

COMMENT ON TABLE public.crm_records IS
  'CRM operacional (decisões 0012-0014, 0023, 0024). Cada linha é um registro público de src/crm/crmDomain.js. '
  'NÃO aplicada automaticamente — ver docs/decisions/0024-crm-postgres-schema.md antes de rodar esta migration.';

CREATE INDEX crm_records_seq_idx ON public.crm_records (seq);
CREATE INDEX crm_records_status_idx ON public.crm_records (status);

-- Incrementa a versão e marca o instante da escrita em TODA atualização — nunca em INSERT (a linha nasce em v1).
-- NENHUM comportamento OBSERVÁVEL do CRM muda por causa disto: nem o domínio, nem o Service, nem a API, nem o
-- Dashboard leem `version` ou `updated_at` hoje — o trigger só mantém as duas colunas corretas para quando (numa
-- etapa futura) o adapter e a porta passarem a usá-las. Ele não altera nenhum outro campo da linha.
CREATE FUNCTION public.crm_records_bump_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_records_bump_version_trigger
  BEFORE UPDATE ON public.crm_records
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_records_bump_version();

-- ------------------------------------------------------------------------------------------------------------
-- RLS — LIGADA, SEM POLICY (D1 + D2, decididas na etapa 1.1)
-- ------------------------------------------------------------------------------------------------------------
-- O servidor fala com este banco usando a service_role key (D1), que NUNCA chega ao navegador; o navegador nunca
-- acessa este banco diretamente. Com RLS ligada e ZERO policies para anon/authenticated (D2): esses dois papéis
-- não conseguem ler nem escrever NADA aqui — é o padrão do Postgres negar por linha na ausência de uma policy que
-- permita. A service_role IGNORA RLS por completo (comportamento nativo do Postgres/Supabase), então o servidor
-- continua funcionando normalmente; a RLS aqui existe para que NENHUM outro caminho (anon/authenticated, por
-- engano ou por uma chave exposta) consiga tocar o CRM. Nenhuma policy para acesso direto é criada nesta etapa.
ALTER TABLE public.crm_records ENABLE ROW LEVEL SECURITY;
