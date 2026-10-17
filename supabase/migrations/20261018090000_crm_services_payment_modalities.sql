-- ============================================================================================================
-- CRM — Serviços: MODALIDADES DE PAGAMENTO múltiplas (CRM 5.0, Fase C1 — decisão 0027)
-- ============================================================================================================
-- NÃO APLICADA. Este arquivo é só a proposta versionada (ver tests/db/crmServicesPaymentModalitiesMigration.test.js, que só lê este
-- texto). Aplicar é uma ação humana e consciente do proprietário, depois de revisar este arquivo, e SÓ na ordem descrita abaixo. O estado
-- real do banco NÃO foi consultado por este arquivo nem pelos testes.
--
-- POR QUÊ: até aqui um serviço só podia ter UMA modalidade (`tipo_cobranca` UNICA ou RECORRENTE, com uma `recorrencia`). A regra de negócio é
-- outra: UM MESMO serviço pode oferecer ao mesmo tempo o pagamento ÚNICO (pelo valor total do contrato) e o RECORRENTE (mensal, trimestral,
-- semestral, anual). O prazo contratado, o TCV, o MRR e o valor recebido NÃO são do serviço: são da negociação (decisão 0027, fase futura).
--
-- O QUE ESTA MIGRATION FAZ — e só isso, na tabela crm_services:
--   1) ADICIONA três colunas, todas com padrão, então nenhuma linha existente fica inválida:
--        permite_pagamento_unico      BOOLEAN NOT NULL DEFAULT false
--        permite_pagamento_recorrente BOOLEAN NOT NULL DEFAULT false
--        periodicidades               TEXT[]  NOT NULL DEFAULT '{}'
--   2) ADICIONA quatro restrições: só os valores MENSAL/TRIMESTRAL/SEMESTRAL/ANUAL; nenhuma periodicidade repetida; recorrente permitido exige
--      ao menos uma periodicidade; recorrente não permitido exige a lista vazia.
--   3) PREENCHE as colunas novas a partir do contrato antigo, com um UPDATE que toca EXCLUSIVAMENTE as três colunas novas, EXCLUSIVAMENTE nas
--      linhas que têm `tipo_cobranca` informado E ainda não têm nenhuma modalidade nova: UNICA -> único permitido; RECORRENTE + recorrencia ->
--      recorrente permitido com aquela periodicidade; sem `tipo_cobranca` -> a linha NÃO é tocada (continua sem modalidade, como serviço LEGADO:
--      nada é inferido). É repetível sem estragar nada (repetir só preenche o que ainda está vazio e nunca sobrescreve o que o ADMIN completou).
--   4) COMENTA as duas colunas antigas como LEGADO (só metadado).
--
-- O QUE NÃO MUDA: `tipo_cobranca` e `recorrencia` continuam existindo, com os valores e com as restrições antigas (inclusive
-- crm_services_cobranca_coerente); nenhuma coluna, índice, gatilho, política ou privilégio é removido ou alterado; ids, nomes, descrições,
-- categorias, PREÇOS DE REFERÊNCIA, ordem, ativo e a auditoria (created_*/updated_*) ficam como estão; a RLS continua ligada e sem policy; nada
-- é inserido ou apagado; nenhuma outra tabela é tocada. A aplicação deixa de GRAVAR as colunas antigas (só as lê, como legado).
--
-- updated_at: o gatilho que já existe (crm_services_bump_updated_at_trigger, BEFORE UPDATE) vai atualizar `updated_at` das linhas que o UPDATE do
-- item 3 tocar — só isso; `updated_by_*` não muda. Se isso for indesejado, as alternativas são não preencher (e o ADMIN definir as modalidades
-- pela tela) ou desligar o gatilho só durante a migration (uma decisão do proprietário, não feita aqui).
--
-- ORDEM SEGURA DE IMPLANTAÇÃO (a leitura funciona com os dois esquemas; a GRAVAÇÃO de serviço só com o novo). Com um único servidor local:
--   a) antes: conferir a contagem por modalidade (supabase/README.md; somente leitura);
--   b) PARAR o servidor (o antigo): assim ninguém cria ou edita serviço entre a migration e a subida do novo — nenhuma janela de divergência;
--   c) aplicar ESTA migration numa transação (BEGIN; ... COMMIT;). Se algo falhar, ROLLBACK: nada muda;
--   d) conferir DEPOIS (README): totais iguais, colunas antigas iguais, modalidades preenchidas, "pendentes" = 0;
--   e) subir o servidor NOVO (lê as colunas novas e só LÊ as antigas) e recarregar (Ctrl+F5) toda aba aberta do Dashboard: uma aba antiga que tente
--      gravar tipoCobranca/recorrencia recebe um erro claro (campo não editável) em vez de gravar algo divergente;
--   f) repetir o UPDATE abaixo SÓ SE a conferência "pendentes" do README for maior que zero (só acontece se um servidor antigo gravou serviços depois
--      de (c)). A repetição é segura: o UPDATE só alcança linhas com tipo_cobranca informado e SEM nenhuma modalidade — e nenhuma linha que o ADMIN
--      completou, nem um serviço criado pelo servidor novo (tipo_cobranca nulo), satisfaz isso.
-- Não suba o servidor NOVO antes desta migration: ler funciona, mas criar ou editar um serviço falha (o PostgREST recusa as colunas que ainda não
-- existem) e a tela mostra o erro genérico de gravação. Se o PostgREST ainda não enxergar as colunas novas logo depois de (c), recarregue o esquema:
-- NOTIFY pgrst, 'reload schema';
--
-- DESFAZER (não faz parte do arquivo; só se algo der errado e antes de o ADMIN completar modalidades que se queira manter):
--   ALTER TABLE public.crm_services DROP CONSTRAINT crm_services_nao_recorrente_sem_periodicidade, DROP CONSTRAINT crm_services_recorrente_exige_periodicidade,
--     DROP CONSTRAINT crm_services_periodicidades_sem_repeticao, DROP CONSTRAINT crm_services_periodicidades_validas,
--     DROP COLUMN periodicidades, DROP COLUMN permite_pagamento_recorrente, DROP COLUMN permite_pagamento_unico;
-- O contrato antigo (tipo_cobranca, recorrencia) continua intacto e basta.
-- ============================================================================================================

ALTER TABLE public.crm_services
  ADD COLUMN permite_pagamento_unico      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN permite_pagamento_recorrente BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN periodicidades               TEXT[]  NOT NULL DEFAULT '{}';

ALTER TABLE public.crm_services
  ADD CONSTRAINT crm_services_periodicidades_validas
    CHECK (periodicidades <@ ARRAY['MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL']::TEXT[]),
  -- sem repetição: com só os quatro valores permitidos, o número de itens tem de ser igual à soma de "contém cada valor"
  ADD CONSTRAINT crm_services_periodicidades_sem_repeticao
    CHECK (cardinality(periodicidades) = (
        (periodicidades @> ARRAY['MENSAL']::TEXT[])::INTEGER
      + (periodicidades @> ARRAY['TRIMESTRAL']::TEXT[])::INTEGER
      + (periodicidades @> ARRAY['SEMESTRAL']::TEXT[])::INTEGER
      + (periodicidades @> ARRAY['ANUAL']::TEXT[])::INTEGER)),
  ADD CONSTRAINT crm_services_recorrente_exige_periodicidade
    CHECK (NOT permite_pagamento_recorrente OR cardinality(periodicidades) > 0),
  ADD CONSTRAINT crm_services_nao_recorrente_sem_periodicidade
    CHECK (permite_pagamento_recorrente OR cardinality(periodicidades) = 0);

-- Preenchimento a partir do contrato antigo (ver o item 3 do cabeçalho). Só as colunas NOVAS, só as linhas com tipo_cobranca e ainda sem modalidade.
UPDATE public.crm_services
   SET permite_pagamento_unico      = (tipo_cobranca = 'UNICA'),
       permite_pagamento_recorrente = (tipo_cobranca = 'RECORRENTE'),
       periodicidades               = CASE WHEN tipo_cobranca = 'RECORRENTE' THEN ARRAY[recorrencia]::TEXT[] ELSE ARRAY[]::TEXT[] END
 WHERE tipo_cobranca IS NOT NULL
   AND permite_pagamento_unico = false
   AND permite_pagamento_recorrente = false
   AND cardinality(periodicidades) = 0;

COMMENT ON COLUMN public.crm_services.tipo_cobranca IS 'LEGADO (Fase C1): a modalidade única antiga. Só leitura; a aplicação usa permite_pagamento_unico/permite_pagamento_recorrente/periodicidades.';
COMMENT ON COLUMN public.crm_services.recorrencia IS 'LEGADO (Fase C1): a periodicidade única antiga. Só leitura; a aplicação usa periodicidades.';
