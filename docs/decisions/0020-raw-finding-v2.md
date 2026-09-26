# 0020 — rawFinding V2 (bloco opcional `dossie`)

## Status

Implementado em 2026-09-25, sobre o commit 73e434a. O achado bruto passa a poder trazer **observações** e **análises** para o dossiê, **sem pesquisa web** (que continua não existindo: o achado vem de fora, como sempre). Sem rota nova, sem permissão nova, sem CRM write, sem alteração no discovery, na Approval Queue, no `batchAccounting`, no Promotion Service ou no CRM. Contrato da submissão inalterado: exatamente `{ briefing, rawFindings }`.

## Decisões aprovadas

1. **`campos` continua sendo a fonte da identidade e da presença dos canais.** O bloco `dossie` registra **observações** sobre esses canais. Não há duas fontes de verdade: um fato de identidade/presença (`*.url`, `whatsapp.publico`) no bloco é **recusado** (`CAMPO_DE_IDENTIDADE`). Uma observação de um canal exige o canal em `campos` (`OBSERVACAO_SEM_CANAL`). Um conflito de identidade fica **preservado como conflito** (dois fatos, sinal `NAO_VERIFICADO`), nunca resolvido em silêncio.
2. **Sem `SITE_NAO_ENCONTRADO`.** Presença confirmada gera sinal positivo; ausência fica `NAO_VERIFICADO`, com `motivo` quando aplicável. A negativa de existência será reavaliada depois da pesquisa web real.
3. **Análises do agente** podem ser guardadas no dossiê, separadas dos fatos: nunca DADO, sempre com `baseadoEm`; `ANALISE` exige base factual `DADO`; `HIPOTESE` pode ser uma interpretação não confirmada. Nenhuma análise gera `problemaIdentificado`, temperatura, score, ranking, urgência ou decisão — elas nem saem do dossiê (não vão à fila, ao lote nem ao discovery; testado).
4. **Tamanho:** a rota de prospecção aceita **4 MiB** (era 2; as outras rotas continuam 16 KiB) e uma submissão tem **no máximo 150 achados** (era 500) — o modelo de ~100 leads pedidos + até 50 de reserva. Sem paginação nem múltiplos lotes.
5. **Nunca cortar em silêncio.** Excesso de evidências, fatos, postagens ou análises é **recusado** com código estável, sem devolver o conteúdo. `campos` aceita no máximo 5 evidências por campo (era 10; = fatos por campo do dossiê) e a tradução gera **um fato por evidência**, sem descartar nenhuma (antes cortava em 5 e descartava evidências não verificáveis quando havia verificáveis).
6. **`motivo`** (fato `NAO_VERIFICADO` apenas): vocabulário fechado `SITE_FORA_DO_AR`, `PERFIL_PRIVADO`, `BLOQUEADO`, `SEM_RESULTADO`, `PAGINA_REMOVIDA`, `DESATUALIZADA`, `NAO_CONSULTADO` (as limitações da 0004 §10).
7. **Os dois vocabulários de status continuam separados:** a confiança dos campos de identidade (VALIDADO/HIPOTESE/NAO_VERIFICADO) é calculada pelo discovery; o dossiê usa DADO/ANALISE/HIPOTESE/NAO_VERIFICADO. `hipoteseDeOportunidade` (V1) continua como está; `dossie.analises` é o caminho estruturado.

## Contrato

```
rawFinding V2 = rawFinding V1 (inalterado) +
  dossie?: {
    fatos?:    [ { campo, valor, status: DADO|NAO_VERIFICADO, fonte?, observadoEm, motivo? } ],   // até 25
    analises?: [ { tipo, texto, baseadoEm: [{ fato: <campo> } | { sinal: <TIPO> }], status: ANALISE|HIPOTESE } ]   // até 10
  }
```

`null`/`undefined` valem como ausente; um achado V1 é válido e idêntico ao de antes (compatível, sem campo de versão). O bloco aceita **só** `fatos` e `analises`: `sinais`, `dossierId`, `loteId`, `score` etc. são recusados.

### Campos de observação (os únicos aceitos em `dossie.fatos`)

| Campo | Valor | Canal exigido em `campos` |
|---|---|---|
| `instagram.ultimaPostagemEm` | data | `instagram` |
| `instagram.postagensObservadas` | 2 a 30 datas | `instagram` |
| `instagram.cta` | texto ≤ 200 | `instagram` |
| `site.ctaWhatsapp`, `site.ctaAgendamento`, `site.formularioContato` | só `true` | `site` |
| `anuncios.meta`, `anuncios.google` | `IDENTIFICADO` \| `NAO_ENCONTRADO_NA_VERIFICACAO` | — |

Fatos DADO carregam a própria fonte `{ url https, tipo OFICIAL|SECUNDARIA, observadoEm (igual à do fato), nome? }`. Ausência/bloqueio = fato `NAO_VERIFICADO` de valor nulo, com `motivo`. Nunca "não anuncia", "inativo" ou `false`.

### Sinais que passam a poder nascer

`INSTAGRAM_ATIVIDADE` (data da observação, última postagem, dias desde ela, se postou nos últimos 15 dias, frequência aparente só com ≥ 3 datas, CTA, URL do fato de identidade), `CTA_WHATSAPP`, `CTA_AGENDAMENTO`, `FORMULARIO_CONTATO`, `ANUNCIO_META` e `ANUNCIO_GOOGLE` (três estados). Nenhum sinal novo foi criado; o `deriveSignals` não mudou.

## Como é validado (sem duplicar, sem dependência circular)

`src/research-prospector/rawFindingV2.js` separa o bloco do achado; o achado passa pelo `rawFindingSchema` (V1, inalterado — só os limites 150 e 5 mudaram); o bloco é validado **executando o `buildDossier`** (o único validador de fatos, fontes, sinais e análises) sobre os fatos derivados de `campos` + os do bloco + as análises: a validação é **antecipada** — uma recusa é da submissão inteira, com `rawFindings[i].dossie...` no caminho, **antes** de ler o CRM ou gravar qualquer coisa. O `rawFindingSchema` não importa o dossiê (o dossiê já usa os primitivos dele); por isso o bloco é validado num módulo à parte, evitando o ciclo. O `dossie` **não chega ao discovery** (o serviço o separa antes): ele não decide identidade, duplicidade, DNC nem elegibilidade, e o `batchAccounting` continua contando só o `estadoOperacional`.

## Limites

| Item | Limite |
|---|---|
| achados por submissão | 150 |
| corpo da rota de prospecção | 4 MiB (demais rotas 16 KiB) |
| evidências por campo de `campos` | 5 |
| fatos em `dossie` | 25 (os 60 do dossiê − até 35 derivados de `campos`) |
| fatos por campo | 5 |
| análises em `dossie` | 10 (o dossiê aceita 20) |
| postagens observadas | 2 a 30 |
| CTA | 200 |
| texto da análise | 600 |
| referências por análise | 10 |
| profundidade/nós do bloco | 5 / 2000 |

## O que NÃO foi implementado

Pesquisa web, navegador, IA, existência negativa de canal, fatos numéricos (seguidores, avaliações), texto/mídia de anúncios, paginação ou múltiplos lotes, e qualquer uso das análises fora do dossiê. Um servidor em execução precisa ser reiniciado (limite da rota).

## Testes e mutação

17 testes novos: `tests/research-prospector/rawFindingV2.test.js` (11: compatibilidade V1, bloco válido, identidade recusada, canal exigido, estrutura hostil, limites sem truncar, lote de 150, `motivo`, análises, coerência do Instagram, arquitetura sem ciclo) e 6 de integração no serviço (`PDI-16..21`: o bloco chega ao dossiê e não à fila/lote/discovery, bloco inválido recusa antes do CRM, conflito preservado, DNC sem dossiê, 150/151 achados, cada achado com o seu bloco). Total do projeto: 1117 (1115 passam e 2 pulados com `.env`; 1110 e 7 pulados sem `.env`). Mutação: 55 mutantes (limites, identidade/canal, estrutura, validação antecipada, `motivo`, tradução, serviço, rota); 7 sobreviveram na primeira rodada — 4 lacunas reais corrigidas (campo desconhecido tratado como identidade, última postagem sem canal, bloco de achado já inválido, bloco de outro achado) e 3 equivalentes/inalcançáveis: a medição antecipada do bloco (o `buildDossier` recusa igual), o caminho de erro de um fato derivado de `campos` (a tradução só gera fatos válidos) e o `dossie` chegando ao discovery (que ignora chaves que não lê; o serviço o separa por defesa em profundidade).
