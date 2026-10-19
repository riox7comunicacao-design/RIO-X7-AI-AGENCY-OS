# 0032 — Contratos recorrentes por prazo indeterminado (CRM 5.0, Fase D3)

**Estado:** implementado localmente. **A migration `20261021090000_crm_negotiation_indefinite_term.sql` está NÃO APLICADA** (só o proprietário a aplica, na ordem descrita abaixo). Nenhum acesso ao Supabase principal foi feito nesta fase e nenhuma negociação real foi alterada.

## Contexto
- A D1.1 (decisão 0028/0029) exige que **toda** negociação tenha um prazo em meses (`prazo_meses NOT NULL`, 1 a 120) e calcula o TCV como `valor × número de cobranças`. O prazo e a periodicidade eram independentes, mas o prazo era sempre obrigatório.
- O caso real: **Gestão de Tráfego Pago**, pagamento recorrente, cobrança mensal de **R$ 1.350,00**, **contrato por prazo indeterminado**, cancelável com **aviso prévio de 30 dias**. O formulário obrigou a escolher 12 meses e mostrou um TCV de R$ 16.200,00, que não corresponde ao contrato.
- A negociação real já está salva (com 12 meses). Esta fase **não a toca**.

## Causa raiz
O modelo tratava "prazo" como duração contratual obrigatória em quatro camadas ao mesmo tempo: o formulário (padrão 12 meses e sem opção "indeterminado"), o domínio (`prazoMeses` inteiro obrigatório, TCV sempre numérico), o cálculo (`TCV = valor × cobranças`, que não existe sem número de cobranças) e o banco (`prazo_meses NOT NULL` e a restrição `crm_negotiations_pagamento_coerente`). Os indicadores somavam o TCV como número em toda negociação.

## Modelo escolhido
Dois campos novos na negociação, ambos opcionais para quem já existe:

| Campo (API / banco) | Valores | Significado |
|---|---|---|
| `duracao` / `duracao_tipo` | `DEFINIDA` (padrão) ou `INDETERMINADA` | Se o contrato tem prazo final. Uma negociação anterior à D3 não traz o campo e **vale como `DEFINIDA`**, sem nenhuma alteração. |
| `avisoPrevioDias` / `aviso_previo_dias` | inteiro de 1 a 365, ou `null` | **Só** no contrato indeterminado. É uma **condição do contrato**: não é duração, não é período mínimo obrigatório e não gera cobrança adicional. Não entra em nenhum cálculo. |

Regras:
- **`DEFINIDA`:** tudo como era — `prazoMeses` obrigatório (1 a 120; múltiplo da periodicidade na recorrência), pagamento único com prazo aplicável, TCV = valor × cobranças. Um aviso prévio num contrato definido é recusado (`AVISO_PREVIO_NAO_PERMITIDO`): as condições dele não mudaram.
- **`INDETERMINADA`:** só **recorrente**; `prazoMeses` é `null` (informar um prazo é recusado); a periodicidade continua obrigatória e vale a do serviço. Pagamento único + indeterminado é recusado (`DURACAO_INDETERMINADA_EXIGE_RECORRENCIA`).
- A duração indeterminada é uma **escolha explícita**: a ausência do prazo numa duração definida continua sendo erro (`OBRIGATORIO`/`PRAZO_INVALIDO`) — nunca vira indeterminado em silêncio.
- Ao **editar**: passar para indeterminado sem enviar o prazo tira o prazo; voltar para definido sem enviar o aviso tira o aviso (o que deixou de valer não fica para trás).

## TCV, MRR e equivalente mensal
- **TCV indeterminado = `null`** (`financeiro.tcv === null` e `financeiro.tcvIndeterminado === true`). **Nunca zero** (seria um contrato de valor zero) e **nunca uma estimativa de 12 meses**. O cronograma não tem número de cobranças (`cobrancas: null`): só o valor de cada cobrança e de quanto em quanto tempo.
- **MRR** = o valor de cada cobrança, só para a recorrência **mensal** (a regra da 0028 não muda): contrato mensal indeterminado de R$ 1.350,00 → **MRR R$ 1.350,00**. Trimestral, semestral e anual continuam tendo o **equivalente mensal** (valor ÷ meses do período, arredondado uma vez, meio centavo sobe), separado do MRR e só para comparar — não é o que entra no caixa. O valor **recebido** continua não existindo aqui (ganhar é decisão comercial, não pagamento).
- **Indicadores** (`summarizeNegotiations`, quadro e Dashboard Comercial): `tcv` passa a ser o **TCV conhecido** (soma só dos contratos com TCV determinado); os de TCV indeterminado são contados à parte (`tcvIndeterminado`, quantidade; por etapa `tcvIndeterminadas`) e o **MRR deles entra normalmente**. O quadro leva `tcvEmJogo` (conhecido), `tcvIndeterminadas` e `mrrEmJogo` por etapa. Nada é somado como zero nem estimado, e a tela diz quantos contratos ficaram fora do total.

## Telas
- **Nova negociação / Editar:** "Duração do contrato" com **Prazo indeterminado**, 3, 6, 12 meses e **Outro prazo definido** (o padrão continua 12 meses). No indeterminado aparece **"Aviso prévio para cancelamento (dias)"** (opcional, com a explicação de que não é duração nem cobrança). A **prévia** mostra o MRR em destaque, o TCV **"Indeterminado (contrato sem prazo final)"**, o cronograma sem número de parcelas e o aviso. Pagamento único + indeterminado e aviso fora de 1–365 são recusados na tela, antes de enviar; o servidor repete tudo.
- **Corpo enviado:** o definido segue idêntico ao de sempre; o indeterminado envia `duracao` (e o aviso) e **não envia prazo**; editar leva só o que mudou — a correção do caso real envia exatamente `{ "duracao": "INDETERMINADA", "prazoMeses": null, "avisoPrevioDias": 30 }`.
- **Cartão do Kanban:** "MRR R$ 1.350,00 · TCV indeterminado" (ou "Equivalente mensal … · TCV indeterminado"); o total da coluna vira "TCV conhecido · MRR · N contratos com TCV indeterminado" **só** quando há indeterminados (sem eles o texto é o de sempre).
- **Detalhes:** "Prazo do contrato: Prazo indeterminado", "Aviso prévio de cancelamento", MRR primeiro e TCV "Indeterminado". **Histórico:** a correção aparece como "Atualizada — Prazo: de 12 meses para sem prazo (indeterminado); Duração do contrato: de Prazo definido para Prazo indeterminado; Aviso prévio: de sem aviso prévio para 30 dias."
- **Dashboard Comercial:** com indeterminados o grupo mostra **"TCV conhecido (contratos com prazo definido)"** e uma nota com a quantidade que ficou de fora; sem eles, o rótulo de sempre.

## Persistência (migration aditiva — NÃO APLICADA)
`supabase/migrations/20261021090000_crm_negotiation_indefinite_term.sql`: duas colunas (`duracao_tipo` NOT NULL padrão `DEFINIDA`; `aviso_previo_dias`), `prazo_meses` deixa de ser `NOT NULL`, a restrição `crm_negotiations_pagamento_coerente` é substituída por uma que vale para as duas durações (todas as linhas existentes a satisfazem; sem armadilha de NULL), e `commit_crm_negotiation_change` é recriada com a mesma assinatura (o corpo é o da D1.1 fora de 11 linhas, provado por teste) com o `REVOKE`/`GRANT` nominal refeitos. **Não toca** em linhas, eventos, FKs, RLS, policies, funis, cards, catálogos, `crm_records`, nem na auditoria; o histórico continua imutável e a concorrência otimista, igual.

Compatibilidade entre código e banco:
- Servidor **novo** + banco **sem** a D3: lê tudo (as colunas ausentes valem como `DEFINIDA`) e continua criando/editando contratos de prazo definido; gravar um indeterminado é **recusado pelo banco** (erro de armazenamento, nada gravado) — nunca grava errado.
- Servidor **antigo** + banco **com** a D3: continua funcionando para os contratos definidos; não mostra a duração indeterminada.
- Ordem recomendada: **migration primeiro** (servidor parado), depois o servidor novo.

## Procedimento — corrigir a negociação real pela interface (feito pelo administrador, depois da migration D3)
Nada disto foi executado. A negociação **não** é apagada, recriada nem recalculada por script: o administrador edita pela tela e o sistema acrescenta o evento de auditoria.
1. **Pré-condições:** a migration D3 aplicada e conferida (ANTES/DEPOIS), o servidor novo no ar e o painel recarregado (Ctrl+F5). Sem a migration, o salvamento é recusado (nada muda).
2. **Confirmar a situação real:** Funis de Vendas → abrir o cartão do cliente → em "Detalhes da negociação", ler a **Situação** (Aberta, Ganha ou Perdida) e as condições atuais (12 meses, TCV R$ 16.200,00). Não se presume que esteja ganha, fechada ou faturada.
3. **Se estiver ABERTA:** **Editar** → em "Duração do contrato" escolher **Prazo indeterminado** → em "Aviso prévio para cancelamento (dias)" digitar **30** → conferir que o valor continua **1.350,00**, a forma **recorrente** e a periodicidade **mensal** → a prévia deve mostrar **MRR R$ 1.350,00** e **TCV Indeterminado** → **Salvar**.
4. **Se estiver GANHA ou PERDIDA:** o sistema não deixa editar uma negociação fechada. O ADMIN usa **Reabrir** (só ele tem essa permissão) → **Editar** como no passo 3 → **Ganhar** de novo (ou **Perder**, com o motivo), se for o caso. O histórico guarda tudo (reaberta, atualizada, ganha), e a data de fechamento passa a ser a do novo fechamento — decisão do administrador.
5. **Conferir:** o cartão mostra "Prazo indeterminado" e "MRR R$ 1.350,00 · TCV indeterminado"; os detalhes mostram o aviso de 30 dias; o histórico traz "Atualizada — Prazo: de 12 meses para sem prazo (indeterminado)…"; o ID e o cartão são os mesmos; o Dashboard Comercial mostra o MRR e a nota de TCV indeterminado.
6. **Se algo sair errado:** editar de novo pela interface (voltar a "12 meses" restaura o TCV calculado); o histórico registra as duas alterações.

## Riscos de implantação
- **Migration nunca executada num PostgreSQL real:** a sintaxe PL/pgSQL da função recriada e o `ALTER TABLE` só se provam na homologação (ANTES/DEPOIS, como nas fases anteriores). O `ALTER TABLE` pede um bloqueio exclusivo curto em `crm_negotiations`: aplicar com o servidor parado.
- **Edição só enquanto ABERTA:** se a negociação real estiver fechada, o caminho exige Reabrir (e fechar de novo), o que muda a data de fechamento; foi uma decisão deliberada manter a regra "só a aberta se edita" (0028).
- **Equivalente mensal ≠ MRR:** nas periodicidades trimestral/semestral/anual indeterminadas não há MRR (a regra da 0028 reserva o MRR à recorrência mensal); só o equivalente mensal, para comparação.
- **Servidor antigo no ar depois da migration:** não mostra a duração indeterminada (mostraria o prazo vazio como erro de leitura em algumas telas); suba o servidor novo logo após a migration.

## Testes
`tests/crm/negotiationFinanceIndefinite.test.js`, `negotiationIndefiniteTerm(.supabase).test.js` (os mesmos testes no modo arquivo e no modo Supabase), `negotiationIndefiniteTermLegacyDb.test.js` (o código novo sobre o banco **sem** a D3), `tests/server/negotiation-indefinite-api(.supabase).test.js`, `dashboard-indefinite-term-model.test.js`, `dashboard-indefinite-term-ui.test.js` e `tests/db/crmNegotiationIndefiniteTermMigration.test.js` (lê o texto da migration e prova a paridade da restrição com o domínio).

## Fora do escopo
Valor recebido/cobranças reais, data de início e de término do contrato, renovação automática, multa por cancelamento e cálculo de aviso prévio como cobrança.
