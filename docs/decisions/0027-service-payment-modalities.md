# 0027 — Serviços: modalidades de pagamento múltiplas (e o que NÃO é do serviço)

## Status

**Fase C1 — PUBLICADA no checkpoint C1 (um único commit), com a migration NÃO APLICADA e a ativação operacional pendente.** Nada foi aplicado ao Supabase e o servidor operacional não foi reiniciado; o banco real **não foi consultado**; os cinco serviços reais já cadastrados **não foram lidos, alterados nem recriados**. Quem decide aplicar a migration, e quando, é o proprietário (ordem segura na seção 6 e em `supabase/README.md`).

Complementa a decisão [0026](0026-crm-catalogs.md) (catálogos): substitui, **só para Serviços**, o par `tipoCobranca`/`recorrencia` pelo modelo abaixo.

## 1. A regra de negócio

Um **mesmo serviço** pode oferecer, ao mesmo tempo, o **pagamento único** (pelo valor total do contrato) e o **pagamento recorrente** (mensal, trimestral, semestral, anual). O modelo antigo — uma única modalidade (`UNICA` *ou* `RECORRENTE`) com uma única recorrência — não consegue dizer isso.

Cada serviço passa a ter três campos:

| Campo | Tipo | Significado |
|---|---|---|
| `permitePagamentoUnico` | booleano | o serviço pode ser vendido em pagamento único |
| `permitePagamentoRecorrente` | booleano | o serviço pode ser vendido em pagamento recorrente |
| `periodicidades` | lista de `MENSAL`, `TRIMESTRAL`, `SEMESTRAL`, `ANUAL` | as periodicidades que o recorrente aceita (sem repetição; ordem canônica) |

Combinações válidas: **só único**; **só recorrente** com **ao menos uma** periodicidade; **os dois** (único + recorrente com ≥ 1 periodicidade). Periodicidade sem recorrente é inválida; recorrente sem periodicidade é inválido.

- **Cadastro novo:** exige **ao menos uma** forma de pagamento; recorrente exige ≥ 1 periodicidade. A ausência de uma permissão é "não permitido" (falso) e a de periodicidades é lista vazia — mas **nunca** `null` em silêncio (`null` ou não-booleano é erro `TIPO_INVALIDO`).
- **Serviço LEGADO** (cadastrado antes): pode continuar **sem nenhuma modalidade**. **Nada é inferido** do `tipoCobranca` antigo — nem na tela, nem na API, nem no domínio. O ADMIN completa pela edição quando quiser. Na edição, a coerência é conferida sobre o **estado resultante** e só quando o PATCH toca uma modalidade; o que não foi enviado é **preservado**; um serviço que **já tinha** modalidade nunca pode ficar sem nenhuma (`MODALIDADE_OBRIGATORIA`).
- **PATCH parcial nunca apaga:** editar nome, descrição, categoria ou preço não envia modalidades (nem o Dashboard envia, nem a API as zera). O Dashboard, ao mudar **uma** modalidade, envia as **três** juntas (a coerência é do estado final).
- **Campos antigos viram somente leitura (`legacyFields`):** `tipoCobranca` e `recorrencia` continuam sendo **lidos e devolvidos** (nulos num serviço novo), mas **nunca gravados**. Enviá-los é `CAMPO_NAO_EDITAVEL` — uma aba antiga do Dashboard recebe um erro claro em vez de gravar algo divergente (falha fechada).
- Códigos de erro novos (com o caminho do campo): `MODALIDADE_OBRIGATORIA` (`modalidades`), `PERIODICIDADE_OBRIGATORIA`, `PERIODICIDADE_NAO_PERMITIDA`, `PERIODICIDADE_REPETIDA` (`periodicidades`); valor fora da lista continua `VALOR_INVALIDO`.

## 2. O preço de referência

Continua existindo, com os mesmos valores, **opcional e apenas informativo**. **Nunca** é interpretado como TCV, como valor mensal ou como valor recebido; **nunca** alimenta `valorProposta`, `valorTotal` nem qualquer cálculo; as modalidades **não** o recalculam, e ele **não** depende delas. Os 31 campos do CRM não mudam. Testes: `CATMOD-4` (independência), `CATMOD-5` (varredura estática: o código dos catálogos não toca campos comerciais e o CRM não toca o catálogo) e `CATCOMPAT-3`.

## 3. A migration (NÃO APLICADA)

`supabase/migrations/20261018090000_crm_services_payment_modalities.sql` — **aditiva**, só em `crm_services`:

1. `ADD COLUMN` ×3 com padrão constante: `permite_pagamento_unico BOOLEAN NOT NULL DEFAULT false`, `permite_pagamento_recorrente BOOLEAN NOT NULL DEFAULT false`, `periodicidades TEXT[] NOT NULL DEFAULT '{}'` (metadado; nenhuma linha fica inválida).
2. Quatro restrições: valores permitidos (`<@`), **sem repetição** (um `CHECK` não aceita subconsulta; a igualdade `cardinality = soma de "contém cada valor"` resolve), recorrente ⇒ lista não vazia, não recorrente ⇒ lista vazia. **Não** há restrição que exija uma modalidade: o legado sem nenhuma continua válido.
3. Um `UPDATE` que toca **somente as três colunas novas**, **somente** nas linhas com `tipo_cobranca` informado e ainda sem modalidade: `UNICA` → único; `RECORRENTE` + `recorrencia` → recorrente com aquela periodicidade; sem `tipo_cobranca` → a linha **não é tocada**. É **repetível** (só preenche o que está vazio; nunca sobrescreve o que o ADMIN completou).
4. Dois `COMMENT ON COLUMN` marcando as colunas antigas como legado.

Não muda: `tipo_cobranca`/`recorrencia` (valores e restrições antigas, inclusive `crm_services_cobranca_coerente`), ids, nomes, preços, ordem, ativo, auditoria, RLS, índices, gatilhos, privilégios; nada é inserido nem apagado. **Efeito colateral documentado:** o gatilho existente `crm_services_bump_updated_at_trigger` atualiza `updated_at` **só** das linhas que o `UPDATE` tocar (`updated_by_*` não muda); se isso for indesejado, o proprietário decide entre não preencher ou desligar o gatilho só durante a migration.

## 4. Armazenamento, adaptadores e transição

- **Modo arquivo e memória:** o item guarda as três propriedades novas; um item antigo (sem elas) é lido com os padrões `false/false/[]` — **sem** inferir do legado — e o legado passa intacto.
- **Modo Supabase:** a leitura usa `select=*` (funciona com o esquema antigo **ou** o novo; coluna ausente → `false/[]`); a gravação envia **só** as colunas novas e **nunca** `tipo_cobranca`/`recorrencia`. O servidor novo sobre o esquema antigo **falha fechado** ao criar/editar serviço (o PostgREST recusa a coluna inexistente; nada é gravado) e continua lendo tudo; editar só nome/preço (sem tocar modalidades) segue funcionando.
- **Servidor antigo sobre o esquema novo:** funciona (ignora as colunas novas, só grava as antigas); o `UPDATE` repetido depois pega o que ele criar nessa janela.

## 5. Interface (Serviços)

"Novo/Editar Serviço": um grupo "Formas de pagamento permitidas" com as caixas **Permitir pagamento único** e **Permitir pagamento recorrente**; ao marcar o recorrente aparecem as quatro periodicidades (**multisseleção**: Mensal, Trimestral, Semestral, Anual); desmarcar o recorrente as esconde **e as limpa**. Validações em português junto do grupo (obrigatório no cadastro novo; sem asterisco na edição de um legado, com a explicação de que **nada é preenchido automaticamente**). A **lista** mostra todas as modalidades **numa só linha** do serviço ("Pagamento único + Pagamento recorrente (mensal, trimestral)"; "Modalidades de pagamento não informadas" para o legado), sem duplicar o serviço. Painel lateral, rodapé fixo, foco, `aria-*` e responsividade mantidos; sem estilos inline e sem cores fixas nas regras novas.

## 6. Ordem segura de implantação (decisão e ação do proprietário; um único servidor local)

1. **Antes:** a conferência "ANTES" de `supabase/README.md` (somente leitura, sem nomes nem preços).
2. **Parar o servidor** (o antigo): nenhuma janela de divergência entre a migration e a subida do novo. O código antigo funciona com o esquema atual e o novo; o código da C1 lê os dois, mas só grava serviço com o novo.
3. **Aplicar a migration numa transação** (`BEGIN;` … `COMMIT;`; erro → `ROLLBACK;`).
4. **Conferir "DEPOIS"** (totais e colunas antigas iguais, "pendentes" = 0); se errado, não subir o novo e usar o "Desfazer" do arquivo.
5. **Subir o servidor novo** e **recarregar (Ctrl+F5) cada aba do Dashboard** (uma aba antiga recebe erro claro, nunca grava divergente); se o PostgREST não enxergar as colunas, `NOTIFY pgrst, 'reload schema';`.
6. **Verificar os serviços** pela tela, sem editar.
7. **Repetir o `UPDATE` só se "pendentes" > 0** — o que só ocorre se um servidor antigo gravou serviços depois do passo 3; com o servidor parado, não é necessário. É seguro porque só alcança linhas com `tipo_cobranca` e **sem nenhuma** modalidade (o ADMIN completou → já tem; serviço do servidor novo → `tipo_cobranca` nulo; a aplicação nunca deixa um serviço com modalidade ficar sem nenhuma). Subir o servidor novo **antes** da migration não corrompe nada, mas criar/editar serviço falha até ela ser aplicada.

## 7. Contratos FUTUROS (documentados; **nada disto está implementado nem iniciado**)

O módulo de **Negociações/Propostas** (Fases 4 e 5) **não** foi iniciado. Quando existir, valem estes contratos:

- **O prazo contratado é independente da periodicidade.** A periodicidade diz *como se cobra* (a cada mês, trimestre…); o prazo diz *por quanto tempo* o contrato vale. Um contrato de 12 meses pode ser cobrado mensal, trimestral, semestral ou anual.
- **Único ou recorrente é escolhido por negociação**, entre as formas que o serviço permite; o serviço só define o que é possível.
- **TCV** (*total contract value*) é o valor total do contrato **mesmo que seja pago em parcelas**.
- **MRR** é a receita mensal recorrente da recorrência **mensal**. Para trimestral, semestral e anual calcula-se o **equivalente mensal**, que é **distinto do recebimento em caixa**.
- **Valor recebido** vem dos **eventos de pagamento** (não de uma conta sobre o TCV nem do preço de referência).
- **Preço e condições são negociados por cliente**; o preço de referência do catálogo é só ponto de partida informativo.
- **Os 31 campos legados do CRM** (inclusive `valorProposta` e `valorTotal`) **não mudam**: nada nesta fase os lê, calcula ou preenche.

## 8. Limites conhecidos

- Os testes não usam um Postgres: o texto da migration é conferido contra o código (paridade exaustiva das combinações com o domínio) e o preenchimento é simulado no PostgREST falso; o comportamento real das restrições e do gatilho só se confirma aplicando.
- O servidor **não** valida `servicoPotencial` do CRM contra o catálogo (como na decisão 0026); esta fase não muda isso.
- Verificação visual num navegador real, com login, **não** foi feita nesta fase (DOM de teste apenas).
