# 0019 — Integração do dossiê ao Prospecting Service (ingestão)

## Status

Implementado em 2026-09-25, sobre o commit 98a000e. O `submitProspecting` existente passou a criar os **dossiês** ([0018](./0018-prospecting-dossier-signals.md)) dos candidatos elegíveis, ao lado do lote e da fila. **Nenhuma rota nova** (a rota `POST /api/prospecting/submit` continua só transportando), **nenhuma permissão nova**, **nenhum CRM write**, nenhuma alteração na Approval Queue (modelo, estados, schema dos itens), no Promotion Service ou no CRM. Sem pesquisa web, IA, Dashboard, score, ranking, temperatura ou prioridade.

## Decisões tomadas (com o dono do projeto)

1. **Origem dos fatos: derivar só do que o achado já traz.** O `rawFinding` não tem onde trazer postagens do Instagram, CTAs, formulário nem anúncios, e o contrato `{ briefing, rawFindings }` não muda. A tradução é a função pura `factsFromFinding` (`src/research-prospector/dossierFromFinding.js`), com mapeamento fixo (abaixo). Estender o achado com um bloco de fatos é o **próximo passo natural**, mas é uma mudança de contrato que exige decisão própria.
2. **Quem ganha dossiê: só os elegíveis** (os mesmos que entram na fila: `VALIDADO_PARA_REVISAO`, `AGUARDANDO_REVISAO`, `POSSIVEL_DUPLICADO`). DNC, duplicado e dados insuficientes **não** ganham dossiê — não se guarda pesquisa de quem não pode ser contatado nem de quem não entra na fila; o resultado da Discovery deles fica no relatório do lote, como antes. Um candidato repetido na mesma submissão tem **um** dossiê. Um elegível que já estava na fila também ganha o dossiê da nova execução (o dossiê registra a pesquisa desta execução). Sem fatos derivados, não há dossiê (`dossierId: null`).
3. **Ordem de gravação: dossiês → fila → lote.**

## Fluxo e ordem (determinística)

1. Autorização (`PROPOSE:LEAD_APPROVAL` e `READ:CRM`) — antes de qualquer outra coisa (nem o CRM é lido se falhar).
2. Forma da submissão (exatamente `{ briefing, rawFindings }`), briefing e achados (`rawFindingSchema`, tudo ou nada).
3. Leitura do CRM (só `listRecords`); CRM ilegível recusa tudo.
4. Discovery existente (identidade, dados, duplicidade, DNC).
5. O `loteId` é **derivado** pelo serviço (nunca do cliente) e conferido.
6. Para cada candidato (uma vez por `prospectId` estável): se elegível, a proposta é montada **em memória** na fila e o dossiê é construído por `buildDossier({ prospectId, loteId, fatos })`.
7. Contabilidade do lote por `computeBatchAccounting` (função existente, sem lógica nova); o lote é montado em memória.
8. **Gravação, sem transação:** cada dossiê (`dossierRepository.save`) → a fila (uma gravação, só se algo entrou) → o lote (`batchRepository.add`, o **registro final**).
9. Relatório.

Tudo o que pode falhar por conteúdo (validação, CRM, candidato, dossiê inválido, id de lote inválido) acontece **antes** de qualquer gravação: falha ali = nada mudou.

## Associação

Só por identificadores: o dossiê guarda `prospectId` (o id estável do item da fila) e `loteId`; o lote guarda `dossierIds` (e cada `resultados[]` traz o `dossierId` ou `null`); a fila **não** ganha `loteId` nem `dossierId` nem o dossiê (testado). O relatório do `submitProspecting` cresceu apenas com `dossierIds` e `resultados[].dossierId` (ids operacionais seguros; nenhum caminho, token, `authUserId` ou dado interno de repositório).

## Tradução achado → fatos (`factsFromFinding`)

| Campo do achado | Fato |
|---|---|
| `site`, `instagram`, `facebook`, `linkedin`, `youtube`, `googlePerfil` | `<campo>.url` |
| `whatsapp` | `whatsapp.publico` (valor `true`) |
| `telefone`, `email`, `endereco` | nenhum (identidade/contato não é fato do dossiê) |

Um fato é **DADO** só com, ao mesmo tempo: valor que é URL https (ou um domínio sem esquema, que ganha apenas o `https://` — `@usuario`, telefone e texto solto **não** viram URL), a **URL https da fonte** e a **`dataConsulta`**; a fonte do fato é `{ url, tipo (o tipoFonte), observadoEm (a dataConsulta), nome (a fonte) }`. Sem isso o fato é **NAO_VERIFICADO** de valor nulo — nunca uma URL, data ou fonte inventada. Campo sem evidência: sem fato. Havendo evidência verificável só os fatos DADO ficam (no máximo 5 por campo); senão, um único NAO_VERIFICADO. O `buildDossier` revalida tudo. Sinais que nascem: existência (site, Instagram, Facebook, LinkedIn, YouTube, Google) e WhatsApp público; **não** nascem `INSTAGRAM_ATIVIDADE`, CTA, formulário nem anúncios, e não há análises/hipóteses (o achado não tem de onde trazê-los).

## Contagens

Usam `computeBatchAccounting` sem alteração: quantidade solicitada, válidos, aguardando revisão, possíveis duplicados, DNC, duplicados, insuficientes, principal, reserva, falta, excedente. Só os estados definidos pelo modelo contam como válidos; repetidos na submissão não contam.

## O que entra na fila e o que não entra

Entra: candidato elegível, como `AGUARDANDO_REVISAO` (semântica existente de `addProspect`, autoria `SYSTEM`, nunca `APROVADO_PARA_CRM` nem `REJEITADO`). Não entra: DNC, duplicado, dados insuficientes. A aprovação continua exclusivamente humana; `approveProspect`/`promoteProspect` nunca são chamados na ingestão.

## Ausência de transação e recuperação

**Não há transação** entre os três arquivos, e os adapters existentes não permitem desfazer com segurança (não há `delete` em nenhuma porta, e um rollback manual sobre arquivos seria frágil): não se fingiu atomicidade. Comportamento por ponto de falha (nada é apagado ou sobrescrito, sem duplicatas):

| Falha em | Estado que fica | Erro |
|---|---|---|
| antes de gravar (validação, CRM, candidato, dossiê inválido) | nada mudou | o erro estável de sempre |
| k-ésimo dossiê | os k−1 dossiês já gravados ficam (órfãos: sem lote) | `PROSPECTING_PERSISTENCE` com `details { loteId, dossierIds (gravados) }` |
| fila | todos os dossiês ficam (órfãos); fila intacta; sem lote | `PROSPECTING_PERSISTENCE` com `{ loteId, dossierIds }` |
| lote | dossiês e fila gravados; sem lote | `PROSPECTING_PERSISTENCE` com `{ loteId, dossierIds, prospectIds }`; conflito de lote continua `PROSPECTING_CONFLICT` |

Recuperação: **repetir a submissão é seguro** — é uma nova execução (novo `loteId`, novos `dossierId`), a fila não duplica itens (regra existente de reentrada) e o repositório de dossiês continua recusando ids existentes. O dossiê **órfão** é detectável (aponta para um `loteId` sem lote) e inofensivo: a fila e o Dashboard não o leem. Uma limpeza/expurgo de órfãos não existe (sem exclusão persistente) — decisão futura. Os `details` de falha de persistência só saem do serviço; a API os omite (só o 400 leva `details`), então nada disso vaza por HTTP. Sem trava entre processos (um servidor por pasta de dados).

## Outros limites

Sem dossiê para bloqueados; sem `INSTAGRAM_ATIVIDADE`/CTA/anúncios/análises até o achado poder trazê-los (decisão de contrato futura); um lote por submissão; o CRM lido é o de agora; **um servidor já em execução precisa ser reiniciado** para gravar dossiês (`data/prospecting-dossiers.json`, fora do Git, criado na primeira submissão com dossiê).

## Testes

`tests/services/prospectingDossierIntegration.test.js` (15; serviços e arquivos reais em diretório temporário — lote, dossiê, loteId/prospectId, sinais, só elegíveis, DNC/duplicado/insuficiente, possível duplicidade, sem aprovação/promoção/CRM write, contagens, segunda submissão, ids do cliente recusados, ordem, falhas dos três repositórios, autorização antes do CRM, CLOSER/ADMIN, coerência física entre os arquivos) e `tests/research-prospector/dossierFromFinding.test.js` (9). Total do projeto: 1100 testes (1098 passam e 2 pulados com `.env`; 1093 e 7 pulados sem `.env`; 0 falhas). Os testes do serviço e do servidor foram ajustados só para injetar o repositório de dossiês. Mutação: 62 mutantes (ordem, autorização, associação lote/dossiê/prospect, elegibilidade, persistência, ausência de aprovação/promoção/CRM write, tradução e composição); 9 sobreviveram na primeira rodada — 7 lacunas reais (fatos do achado errado, dossiê inválido ignorado, dossiê sem fatos, repositório de dossiês não exigido, precedência de datas, `dossierPath`), corrigidas com testes e todas agora detectadas; 2 equivalentes/inalcançáveis: o autor vindo de `context.user` (o autorizador devolve a mesma identidade) e o valor de `whatsapp` como URL (o esquema do achado só aceita telefone nesse campo).
