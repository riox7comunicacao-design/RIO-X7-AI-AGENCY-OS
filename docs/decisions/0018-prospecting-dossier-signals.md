# 0018 — Prospecting Dossier + Signals V1

## Status

Implementado em 2026-09-25, sobre o commit f65b394. Só o **modelo determinístico** do dossiê de pesquisa, dos sinais e a persistência local. **Não** foi integrado ao `submitProspecting`, e não há rota, Dashboard, pesquisa web, IA, navegador, SDR, automação, publicação, CRM write adicional, alteração da Approval Queue nem do Promotion Service. Nenhuma dependência, migração ou permissão nova.

## Objetivo

Dar um lugar próprio, auditável e sem invenção para o que a pesquisa **observa** sobre um prospect. O que antes só cabia em campos soltos do candidato passa a ter estrutura: fato (o que foi visto, onde e quando), sinal (o que se deriva do fato por regra fixa) e análise/hipótese (interpretação, sempre separada e sempre apoiada em evidência).

## Separação: identidade/contato × dossiê

| Camada | Onde vive | O que é |
|---|---|---|
| A) Identidade e contato | Prospect / Approval Queue / CRM | Quem é e como falar. **Não muda** nesta etapa. |
| B) Fatos | dossiê (`fatos`) | Observações com campo, valor, status (`DADO` \| `NAO_VERIFICADO`), fonte e data. |
| C) Sinais | dossiê (`sinais`) | Derivados dos fatos por regras fixas; o consumidor nunca envia um sinal. |
| D) Análises e hipóteses | dossiê (`analises`) | Texto interpretativo com `baseadoEm`; status `ANALISE` ou `HIPOTESE`. |

O dossiê tem **identidade própria** (`dossierId`, `dossie:<uuid>`) e só guarda o `prospectId` e o `loteId` (opcional). Nada dele vira `problemaIdentificado`, temperatura, score, ranking, prioridade ou decisão de aprovação — esses conceitos não existem no modelo. O dossiê **não importa `src/crm`**, não chama o CRM Service e não escreve no CRM; a Approval Queue e o discovery não o conhecem (testado).

## Modelo

`buildDossier({ prospectId, loteId?, fatos, analises? }, { now, newId })` → `{ ok: true, value }` ou `{ ok: false, errors: [{ path, code, message }] }`. A entrada aceita **exatamente** essas chaves: `dossierId`, `criadoEm`, `dataDaPesquisa`, `sinais`, `fontes`, ids de fato e de análise são **derivados** pelo sistema e recusados se vierem de fora (`CAMPO_DESCONHECIDO`). O erro nunca repete o valor recusado.

Dossiê: `dossierId, prospectId, loteId, criadoEm, dataDaPesquisa (data mais recente observada; sem fatos, a de agora), fatos, sinais, analises, fontes (derivadas dos fatos, sem repetição)`.

Fato: `{ factId (fato:<campo>, #n para repetidos), campo, valor, status, fonte, observadoEm }`. `DADO` exige valor válido para o campo e fonte; `NAO_VERIFICADO` exige valor **nulo** ("a pesquisa não confirmou nada"). Um fato nunca é `HIPOTESE`.

## Vocabulários (fechados)

- **Campos de fato** (`FACT_CATALOG`, 15): `instagram.url`, `site.url`, `googlePerfil.url`, `facebook.url`, `linkedin.url`, `youtube.url` (URL https pública); `instagram.ultimaPostagemEm` (data); `instagram.postagensObservadas` (2 a 30 datas); `instagram.cta` (texto curto); `whatsapp.publico`, `site.ctaWhatsapp`, `site.ctaAgendamento`, `site.formularioContato` (**só** `true`); `anuncios.meta`, `anuncios.google` (`IDENTIFICADO` \| `NAO_ENCONTRADO_NA_VERIFICACAO`).
- **Sinais** (`SIGNAL_TYPE`, 13): `INSTAGRAM_EXISTENTE`, `INSTAGRAM_ATIVIDADE`, `SITE_EXISTENTE`, `GOOGLE_PERFIL_EXISTENTE`, `FACEBOOK_EXISTENTE`, `LINKEDIN_EXISTENTE`, `YOUTUBE_EXISTENTE`, `WHATSAPP_PUBLICO`, `CTA_WHATSAPP`, `CTA_AGENDAMENTO`, `FORMULARIO_CONTATO`, `ANUNCIO_META`, `ANUNCIO_GOOGLE`. Cada sinal: `{ sinalId, tipo, valor, status (DADO \| NAO_VERIFICADO), evidencias (factIds), derivadoEm }`. Sem fato do campo, **não há sinal** (a ausência de sinal não é a ausência da coisa).
- **Análises**: status `ANALISE` \| `HIPOTESE`; tipos `PRESENCA_DIGITAL`, `ATIVIDADE_SOCIAL`, `CONVERSAO`, `ANUNCIOS`, `OUTRO`.

Mapeamento dos exemplos do pedido: `INSTAGRAM_ATIVO` / `INSTAGRAM_SEM_POSTAGEM_RECENTE` → um único `INSTAGRAM_ATIVIDADE` (valor estruturado, sem "ativo = true"); `ANUNCIO_META_IDENTIFICADO` / `ANUNCIO_GOOGLE_IDENTIFICADO` → `ANUNCIO_META` / `ANUNCIO_GOOGLE` com três estados; `SITE_NAO_ENCONTRADO` **não foi criado**: é uma negativa que o modelo não sustenta (o fato `site.url` `NAO_VERIFICADO` dá o sinal `SITE_EXISTENTE` `NAO_VERIFICADO`).

## Instagram e anúncios

`INSTAGRAM_ATIVIDADE` (só com fato `DADO`, sem conflito) guarda `{ dataDaObservacao, ultimaPostagemEm, diasDesdeUltimaPostagem, postouNosUltimos15Dias (dias ≤ 15), frequenciaAparente ({ postagensObservadas, intervaloMedioDias } só com ≥ 3 datas, senão null), cta, url }`. Uma postagem posterior à observação, ou uma última postagem que não é a mais recente das observadas, é recusada.

Anúncios têm três estados distintos e nunca "não anuncia": `IDENTIFICADO`; `NAO_ENCONTRADO_NA_VERIFICACAO` (verificação feita, com fonte e data, `DADO`); `NAO_VERIFICAVEL` (fato `NAO_VERIFICADO`, sinal `NAO_VERIFICADO`). `IDENTIFICADO` prevalece sobre um "não encontrado" de outra fonte.

## Evidência, conflito e ausência

Ausência de evidência **nunca** vira afirmação negativa: fatos de presença só aceitam `true`; o "não sei" é um fato `NAO_VERIFICADO` de valor nulo. Conflito = dois fatos `DADO` do mesmo campo com valores diferentes: os dois ficam (cada um com a sua fonte) e o sinal vira `NAO_VERIFICADO` de valor nulo — nenhum valor é escolhido em silêncio. Uma `ANALISE` exige ao menos um fato ou sinal `DADO` na base (`baseadoEm`, 1 a 10 referências `{ fato: <campo> }` ou `{ sinal: <tipo> }`, resolvidas para os ids do próprio dossiê); só `NAO_VERIFICADO` na base exige `HIPOTESE`. Texto de análise com promessa de resultado, urgência artificial ou "não anuncia" é recusado (trava determinística e conservadora, não prova de tom).

## Fontes e segurança

Fonte = `{ url, tipo (OFICIAL \| SECUNDARIA, o vocabulário do domínio), observadoEm, nome? }`, reutilizando os primitivos do `rawFindingSchema` (agora exportados, sem duplicar validação): só HTTPS, sem `javascript:`/`data:`/`file:`, sem usuário/senha/porta, sem IP nem host interno, sem espaços; texto sem controle; datas ISO reais (sem futuro além de amanhã, o relógio é injetável); a data da fonte tem de ser a da observação do fato. A entrada é dado **não confiável**: só objetos puros, sem getter, sem lacunas, sem Symbol, limites de nós, profundidade e tamanho; chaves `__proto__`/`constructor` são recusadas e nada é poluído. Limites: 60 fatos, 5 por campo, 20 análises, 600 caracteres por texto, 10 referências por análise, 200 no `prospectId`, 50 erros.

## Persistência

Porta `list() / getById(id) / save(dossiê)` (padrão do Batch Repository), adapter em memória e adapter de arquivo (`data/prospecting-dossiers.json`, **fora do Git**, escrita atômica tmp + fsync + rename, ENOENT = vazio, arquivo corrompido lança e **não** é sobrescrito, objeto sem protótipo ao ler). `save` **insere** e recusa um `dossierId` existente com `DOSSIER_CONFLICT`; nunca sobrescreve. Ids só no formato `dossie:<uuid>` (nada de caminho, `__proto__`, `constructor`); `getById` de id inválido devolve `null`; tudo é cópia defensiva. O único caminho de arquivo é o do adapter, escolhido por quem compõe.

## Testes e mutação

60 testes novos (`tests/research-prospector/dossier.test.js`, 43; `dossierRepository.test.js`, 17 casos, com os cinco primeiros rodando nos dois adapters) — o total do projeto subiu de 1016 para 1076: 1074 passam e 2 pulados com `.env`; 1069 e 7 pulados sem `.env`; 0 falhas. **Mutação:** 124 mutantes de `signalSchema.js`, `dossier.js` e `dossierRepository.js`; 24 sobreviveram na primeira rodada — 16 eram lacunas de teste (limites por constante, códigos de erro, propriedades extras em listas, arredondamento, deduplicação de fontes, ids com maiúsculas, quebra de linha, CTA/URL em conflito, chave `__proto__` no arquivo) e ganharam asserção; 1 era código morto (uma checagem redundante de referência) e foi simplificado. Restam 7 **equivalentes/não observáveis**: getter em lista de datas (o valor `undefined` já é recusado pela data), `dayNumber` com `floor`+meio-dia (mesmo resultado), `analiseId` por índice (só difere quando outra análise já falhou, e então o dossiê inteiro é recusado), sinais derivados mesmo com erro (o resultado é descartado), `in` no lugar de `hasOwn` num objeto sem protótipo com id já validado, `fsync` (durabilidade não observável em teste) e a leitura sem `structuredClone` (cada leitura já reparseia o arquivo).

## O que NÃO foi implementado

Integração com `submitProspecting` (rawFindings → dossiê → lote → fila), rota HTTP, Dashboard, pesquisa web, IA, navegador, exclusão de dossiê, atualização/versionamento de um dossiê existente, trava entre processos (mesmo limite dos outros arquivos: um servidor por pasta de dados), score, ranking, temperatura e qualquer decisão.

## Próximos passos

1. (feito na [0019](./0019-prospecting-dossier-ingestion.md)) Integrar ao `submitProspecting`: rawFindings → dossiê → lote → Approval Queue (decisão própria, sem mudar a máquina da fila).
2. Só depois, expor o dossiê ao revisor (Dashboard) e decidir a persistência definitiva (Supabase/Postgres, candidato, não decidido).
