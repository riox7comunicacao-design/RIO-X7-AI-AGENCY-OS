# 0006 — Identidade Confirmada Não É Sinônimo de Contagem de Campos

## Status

Implementado. Registrado em 2026-09-17, corrigindo uma fragilidade real encontrada logo após o Passo 2.

## Contexto

O pipeline operacional de descoberta (Passo 2, [src/research-prospector/discovery.js](../../src/research-prospector/discovery.js)) decidia se um candidato estava "pronto para revisão" com um critério puramente numérico: `>= 2 campos VALIDADO`. Isso tratava contagem de campos como se fosse, por si só, uma medida de qualidade de identificação — o que não é verdade: dois campos VALIDADO podem vir de uma identidade ainda ambígua ou conflitante, e um único campo (um site oficial, por exemplo) pode bastar para confirmar com segurança quem é a entidade.

## Problema

Um limiar numérico não distingue "sabemos com segurança quem é essa entidade, mas temos poucos dados sobre ela" de "temos vários dados, mas não está claro se pertencem à mesma entidade". Tratar as duas situações da mesma forma poderia empurrar para a fila de revisão candidatos cuja identidade não estava de fato resolvida.

## Decisão

Separar o julgamento em duas dimensões independentes, nenhuma delas um score:

## 1. Identidade (`statusIdentidade`)

Responde: **esta entidade pesquisada realmente corresponde ao candidato?** Julgada pela natureza e coerência das evidências nas âncoras fortes (`site`, `instagram`, `telefone`, `googlePerfil` — os mesmos identificadores fortes já usados pela deduplicação), nunca pela quantidade total de campos preenchidos.

Valores: `VALIDADA` ou `NAO_VALIDADA`, com um `motivo`:

| Motivo | Quando ocorre |
|---|---|
| `CONFIRMADA` | Pelo menos uma âncora está VALIDADO (fonte oficial, ou múltiplas fontes independentes concordando), e nenhuma âncora está em conflito |
| `CONFLITO` | Qualquer âncora tem evidências divergentes — **mesmo que outra âncora esteja confirmada**, o conflito não desaparece |
| `AMBIGUA` | A etapa de identificação sinalizou explicitamente (`identidadeAmbigua: true`) que duas entidades possivelmente diferentes aparecem sob nomes/listagens parecidos |
| `EVIDENCIA_FRACA` | Só há evidência de fonte secundária isolada nas âncoras, nunca oficial nem múltipla |
| `SEM_EVIDENCIA` | Nenhuma âncora tem qualquer evidência |

**Regra conservadora central:** conflito ou ambiguidade sempre bloqueiam a confirmação, mesmo na presença de outra âncora validada — a identidade não fica "mais confirmada" só porque outro dado bateu.

## 2. Dados (`statusDados`)

Responde apenas: **quão completo é o registro?** — uma medida de transparência, nunca um critério de decisão sobre identidade.

Valores: `SUFICIENTES` (2+ campos VALIDADO), `PARCIAIS` (alguma evidência, mas abaixo do limiar), `INSUFICIENTES` (nenhuma evidência em nenhum campo).

## Estado operacional resultante

A fila de revisão (`estadoOperacional`) combina as duas dimensões nesta ordem de prioridade (a mesma hierarquia do Passo 2, agora refinada apenas no ponto que dependia de contagem):

1. `DNC` — bloqueio por DO NOT CONTACT (inalterado)
2. `DUPLICADO` — identificador forte já existe no CRM (inalterado)
3. `POSSIVEL_DUPLICADO` — nome+cidade coincide (inalterado)
4. **`DADOS_INSUFICIENTES`** — identidade **não** VALIDADA (conflito, ambiguidade, evidência fraca ou ausente) — independentemente de quantos campos estejam preenchidos
5. **`VALIDADO_PARA_REVISAO`** — identidade VALIDADA **e** dados SUFICIENTES
6. **`AGUARDANDO_REVISAO`** — identidade VALIDADA, mas dados apenas PARCIAIS/INSUFICIENTES

Isso dá finalmente um uso real aos dois estados que já existiam na lista fixa desde o Passo 2 mas nunca haviam sido diferenciados na prática (`AGUARDANDO_REVISAO` e `VALIDADO_PARA_REVISAO`).

## Exemplos

```
Site oficial confirma a empresa, resto não pesquisado ainda:
  IDENTIDADE: VALIDADA (CONFIRMADA)
  DADOS: PARCIAIS
  ESTADO: AGUARDANDO_REVISAO

Site + Instagram + telefone, todos oficiais, sem conflito:
  IDENTIDADE: VALIDADA (CONFIRMADA)
  DADOS: SUFICIENTES
  ESTADO: VALIDADO_PARA_REVISAO

Instagram validado, mas telefone com 2 fontes divergentes:
  IDENTIDADE: NAO_VALIDADA (CONFLITO)
  DADOS: SUFICIENTES (teria 2+ campos com alguma evidência)
  ESTADO: DADOS_INSUFICIENTES  ← identidade não confirmada vence, mesmo com "dados" tecnicamente numerosos
```

Nenhum score, nota, ranking ou temperatura comercial foi criado — apenas estas classificações categóricas, testadas em [tests/research-prospector/discovery.test.js](../../tests/research-prospector/discovery.test.js) (`[2.1-F]`).

## Impacto no teste real do Passo 2

Reexecutando a mesma análise local dos 10 candidatos (sem nova pesquisa, sem escrita no CRM):

| Candidato | Antes (Passo 2) | Depois (Passo 2.1) | Motivo |
|---|---|---|---|
| Candidato 01 | DUPLICADO | DUPLICADO | Inalterado — duplicidade tem prioridade sobre identidade |
| Candidato 02 | DUPLICADO | DUPLICADO | Inalterado |
| Candidato 03 | AGUARDANDO_REVISAO | **DADOS_INSUFICIENTES** | Telefone em conflito é uma âncora — agora bloqueia a confirmação de identidade, mesmo com Instagram validado |
| Candidato 04 | AGUARDANDO_REVISAO | **VALIDADO_PARA_REVISAO** | Site+telefone validados, sem conflito → identidade confirmada + dados suficientes |
| Candidato 05 | AGUARDANDO_REVISAO | **VALIDADO_PARA_REVISAO** | Mesmo motivo |
| Candidato 06 | AGUARDANDO_REVISAO | **DADOS_INSUFICIENTES** | Telefone em conflito (site institucional × listagem pessoal) bloqueia identidade |
| Candidato 07 | DADOS_INSUFICIENTES | DADOS_INSUFICIENTES | Inalterado (já era o pior caso; telefone em conflito confirma o motivo) |
| Candidato 08 | AGUARDANDO_REVISAO | **VALIDADO_PARA_REVISAO** | Instagram+telefone+Google Perfil, sem conflito |
| Candidato 09 | AGUARDANDO_REVISAO | **VALIDADO_PARA_REVISAO** | Mesmo motivo |
| Candidato 10 | AGUARDANDO_REVISAO | **VALIDADO_PARA_REVISAO** | Ver detalhe abaixo |

### Caso Candidato 10

- **Antes:** `AGUARDANDO_REVISAO`, unicamente porque `2 campos VALIDADO >= 2` (Instagram + telefone).
- **Depois:** `VALIDADO_PARA_REVISAO` — mas agora pelo motivo certo: Instagram e telefone vêm ambos da própria bio dele no Instagram (uma fonte primária coerente e coesa, sem conflito com nenhuma outra fonte), e nenhuma ambiguidade foi sinalizada. `statusIdentidade = VALIDADA (CONFIRMADA)`; `statusDados = SUFICIENTES`.
- **Motivo da mudança:** o resultado prático é parecido, mas a **justificativa** mudou de "por acaso bateu 2" para "identidade coerente confirmada por evidência de primeira mão + dados suficientes" — exatamente o problema que este passo corrige. Se o telefone dele viesse de uma fonte conflitante (como aconteceu com Larissa e Angélica), o resultado teria sido `DADOS_INSUFICIENTES` apesar dos mesmos 2 campos VALIDADO — prova de que a contagem deixou de ser determinante sozinha.

## Consequências

- Larissa e Angélica passam a ficar em `DADOS_INSUFICIENTES` em vez de `AGUARDANDO_REVISAO` — uma mudança mais conservadora (identidade com conflito não confirmado não deveria ter sido tratada como "pronta para revisão").
- Candidato 04, Candidato 05, Candidato 08 e Candidato 09 sobem para `VALIDADO_PARA_REVISAO`, refletindo que sua identidade é solidamente confirmada e os dados já são suficientes — informação que antes não existia (só havia "AGUARDANDO_REVISAO" genérico para todos os NOVOs com 2+ campos).
- O sinalizador `identidadeAmbigua` é opcional e não usado automaticamente por nenhuma heurística — só entra em jogo se a etapa de identificação (humana ou de IA) o definir explicitamente, mantendo a decisão longe de qualquer fuzzy matching.

## Alternativas consideradas

- **Manter o limiar numérico, só ajustando o número (ex.: exigir 3 em vez de 2).** Rejeitada: qualquer número continuaria sendo uma proxy indireta para "identidade confirmada", sujeita ao mesmo problema de fundo — dois campos ruins nunca deveriam valer mais que um campo forte e coerente.
- **Calcular um score de confiança combinando identidade e dados.** Rejeitada: violaria explicitamente a proibição de score/ranking/temperatura comercial já fixada desde o Passo 2.
- **Detectar ambiguidade automaticamente comparando nomes/endereços por heurística.** Rejeitada: introduziria fuzzy matching implícito, o que a Regra 1 do RULES.md e o princípio de "falso negativo antes de falso positivo" (0005) já desaconselham — a ambiguidade só é reconhecida quando alguém (ou alguma etapa anterior) a sinaliza explicitamente.
