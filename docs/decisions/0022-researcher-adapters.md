# 0022 — Adaptadores reais das portas do Researcher (passo 1 da 0021)

## Status

Implementado em 2026-09-26, sobre o commit 9cd4a2f. **Só** os adaptadores de rede das portas do Researcher e o primeiro smoke test real controlado. **Não** foram feitos: serviço Researcher → `submitProspecting`, Approval Queue, lote, CRM, Dashboard, SDR, análises/hipóteses, automação nem lote real de prospecção. `researcher.js`, `researchPolicy.js`, o contrato `rawFinding V2`, o CRM, a fila, o Promotion Service, o Batch, o `submitProspecting`, o Dashboard e as permissões **não foram alterados**. **Nenhuma dependência nova** (`node:https`, `node:dns`, `node:net` nativos; `package.json` só ganhou o script `smoke:researcher` e o novo diretório de testes no `npm test`).

## Onde vive

`src/research-adapters/` — um diretório NOVO, fora do domínio. A fronteira é testada (regras R13 e R14 em `tests/auth/architecture-boundaries.test.js`): o domínio `src/research-prospector/` **não conhece** os adaptadores (a rede é detalhe deles) e os adaptadores **não conhecem** `src/auth`, `src/crm`, `src/services` nem `src/server`; só usam a política de fontes do domínio (`researchPolicy`). O Researcher continua puro.

| Módulo | Papel |
|---|---|
| `netGuard.js` | só endereços PÚBLICOS: o `lookup` de conexão resolve todos os endereços e recusa (ESSRF) se qualquer um for loopback, privado, CGNAT, link-local (metadata de nuvem), multicast, documentação, IPv6 interno/mapeado/NAT64/6to4 — o endereço validado é o que recebe a conexão (sem DNS rebinding) |
| `httpsTransport.js` | UMA requisição GET: só https (política do rawFinding), certificado sempre validado, sem agente compartilhado, tempo total explícito, limite de bytes (aborta ao estourar), sem redirecionamento; devolve status, cabeçalhos de texto e bytes; `Set-Cookie` é descartado |
| `robots.js` | interpretação pura do robots.txt (RFC 9309): grupo do nosso agente > `*`, padrão mais longo vence, `*` e `$`, sem regex com retrocesso |
| `htmlExtract.js` | extração estática (links com texto, formulário de contato, sinais de muro): scripts/estilos/comentários removidos, nada executado nem seguido, varredura linear (HTML hostil não vira negação de serviço) |
| `publicWeb.js` | o cliente: robots, redirecionamentos, cortesia por host, orçamento, classificação de falhas; expõe `fetchPage` e `getJson` |
| `nominatimSearch.js` | a porta `search` sobre o OpenStreetMap Nominatim (dados abertos, sem chave/assinatura/raspagem de buscador) — o formato do provedor não sai daqui |
| `index.js` | `createResearchPorts` → `{ search, fetchPage, estatisticas }` |

## Segurança (regras cumpridas e testadas)

- **Só conteúdo público. Nunca:** login, credencial, cookie, sessão autenticada, captcha resolvido, bloqueio contornado, robots.txt ignorado, proxy, dado privado. Os cabeçalhos enviados são exatamente **quatro** (User-Agent identificado, Accept, Accept-Language, `Accept-Encoding: identity`); **não existe** opção para Cookie, Authorization, Referer, proxy, agente, desligar TLS ou desligar robots — uma opção desconhecida é recusada na criação. Um teste varre o código dos adaptadores atrás de qualquer um desses mecanismos.
- **HTTPS:** toda URL passa pela política existente (https público, sem usuário/senha, sem porta, sem IP nem host local; `http:`, `javascript:`, `data:`, `file:`, `ftp:` e `//host` recusados **antes** de qualquer requisição); o mesmo vale para o destino de cada redirecionamento.
- **Redirecionamentos:** seguidos à mão, no máximo 3, cada salto revalidado, por padrão só dentro do mesmo host (o `www.` conta como o mesmo); um salto para uma tela de login é `LOGIN` (evento `REDIRECT_TO_LOGIN`) e a pesquisa daquela página termina ali; a tela de login nunca é buscada.
- **robots.txt:** lido uma vez por origem, antes de qualquer página; a URL só é buscada se ele **permitir**. 404/410 = sem robots.txt (permitido). **Qualquer outra coisa que impeça uma verificação adequada** (401/403, 5xx, erro de rede, tempo, tamanho, redirecionamento externo, codificação inesperada) = **não se acessa** (`ROBOTS`, evento `ROBOTS_NAO_VERIFICADO`). Vale também para a API de busca.
- **Limites explícitos e finitos** (validados na criação; nada é infinito): tempo por requisição 10 s (1 ms–60 s), resposta 1 MiB (robots.txt 512 KiB), 3 redirecionamentos, 60 requisições no total (o robots.txt conta), 1 s entre requisições ao mesmo host, 600 links por página (o excesso vira o evento `LINKS_TRUNCADOS`, nunca silencioso), 200 eventos. **Nenhuma nova tentativa**: cada pedido é feito uma vez; uma falha é devolvida, não repetida.
- **Não executa nem interpreta conteúdo remoto como código:** o HTML é lido como texto; scripts, estilos, `noscript`, `template` e comentários são descartados antes de qualquer leitura; nenhum recurso, iframe ou import é seguido; só se aceita `text/html`/`application/xhtml+xml` (páginas) e JSON (API); resposta comprimida inesperada é recusada.
- **Não vaza:** o resultado das portas só tem o contrato do Researcher; os detalhes ficam em **eventos** (código estável + host), nunca URL completa, cabeçalho, corpo ou mensagem de rede.

## Estados devolvidos ao Researcher (contrato inalterado)

| Situação | `falha` | Evento do adaptador |
|---|---|---|
| tempo estourado | `TEMPO_ESGOTADO` | `TIMEOUT` |
| 401 / tela de login / muro de login / redirecionamento para login | `LOGIN` | `HTTP_401`, `MURO_DE_LOGIN`, `URL_DE_LOGIN`, `REDIRECT_TO_LOGIN` |
| desafio anti-robô (cabeçalho, HTML de desafio, captcha em página quase sem links) | `CAPTCHA` | `DESAFIO`, `DESAFIO_NA_PAGINA` |
| 403, 429, endereço não público | `BLOQUEADO` | `HTTP_403`, `HTTP_429`, `ENDERECO_NAO_PUBLICO` |
| robots.txt proíbe / não verificável | `ROBOTS` | `ROBOTS_BLOQUEIA`, `ROBOTS_NAO_VERIFICADO` |
| 404/410 | `REMOVIDA` | `HTTP_404`, `HTTP_410` |
| 5xx, erro de rede | `FORA_DO_AR` | `HTTP_5XX`, `ERRO_DE_REDE` |
| resposta grande, conteúdo inválido, TLS, redirecionamento inválido/externo/excessivo, limite de requisições, URL inválida | `ERRO` | `RESPOSTA_GRANDE`, `CONTEUDO_INVALIDO`, `TLS`, `REDIRECT_*`, `REDIRECTS_EXCESSIVOS`, `LIMITE_DE_REQUISICOES`, `URL_INVALIDA` |

`REDIRECT_TO_LOGIN`, `TIMEOUT`, `BLOCKED` etc. são o vocabulário do adaptador; o Researcher continua recebendo só o vocabulário dele (`researchPolicy.FAILURE`), que o transforma em `NAO_VERIFICADO` com `motivo`.

## A data

O adaptador **não devolve nem carimba data nenhuma**: a `dataConsulta` de toda evidência e fato é a do **relógio injetado do Researcher** (testado, inclusive com um relógio diferente no adaptador).

## `search` (Nominatim) e `lookupAds`

`search` usa o OpenStreetMap Nominatim: dados abertos (ODbL), API pública sem chave, conta ou assinatura, e sem raspagem de buscador comercial (Google/Bing proíbem). Um lugar com `website`/`contact:*` vira resultados SITE/canais (URL https revalidada pela política; `@usuário` do Instagram/Facebook vira a URL do perfil; um `website` **http não é promovido** a https); a fonte é a página pública do objeto no OSM (`openstreetmap.org/<tipo>/<id>`). Uma consulta = uma requisição (política de uso: 1 req/s, User-Agent identificado).

**`lookupAds` NÃO tem adaptador**: a Meta Ad Library e o Google Ads Transparency Center exigem token/conta ou executam JavaScript com desafio anti-robô, e o que existe de "API" é pago ou de terceiros. Sem uma fonte pública adequada a porta fica ausente (`createResearchPorts` não a devolve): o Researcher não produz nenhum fato de anúncio (nunca "não anuncia"). Reavaliar quando existir uma fonte pública/aberta adequada.

## Smoke test real (separado dos testes determinísticos)

`scripts/smoke-researcher.js` (`RIO_X7_SMOKE=1 npm run smoke:researcher`) — **fora do `npm test`**, não determinístico, o único acesso real à internet; não usa CRM, lote, fila nem `submitProspecting`, e **não escreve nada em disco** (só imprime). Dois estágios, sobre uma instituição pública (não uma empresa-prospect):

- **Estágio A — busca real (Nominatim):** resultado em 2026-09-26: o robots.txt do `nominatim.openstreetmap.org` **não permite** o acesso automatizado ao endpoint de busca para o nosso agente; o adaptador **respeitou** (`ROBOTS_BLOQUEIA`), o Researcher devolveu `RESEARCHER_BUSCA_FALHOU` e nada foi forçado nem inventado. **Limitação real:** o provedor de busca escolhido não é utilizável na prática sob a regra "respeitar robots.txt". A porta é plugável; a troca do provedor (uma instância própria do Nominatim, ou outra fonte aberta que permita acesso automatizado) é uma decisão a tomar — não foi improvisada nenhuma alternativa que contornasse a regra.
- **Estágio B — `fetchPage` real sobre UMA página pública declarada pelo operador** (`https://www.iana.org/`, entrada controlada fixa, rotulada como tal): 2 requisições (robots.txt + página), sem falhas; achado com a evidência `site` (OFICIAL, fonte = a própria página, HTTPS, data de hoje do relógio do Researcher), **validado por `validateRawFindingsV2`**. Como a página não publica links de canais nem contatos, não há mais evidências — nada foi inventado. O resultado real **não** foi persistido nem entrou no Git nem nos testes.

## O que NÃO foi feito / limites

Serviço Researcher → `submitProspecting`; qualquer gravação; extração de perfil do Instagram (`perfil` nunca é devolvido: o HTML público do Instagram não expõe postagens de forma confiável e o robots/login o bloqueiam — logo `INSTAGRAM_ATIVIDADE` ainda não nasce de pesquisa real); anúncios; execução de JavaScript/renderização (só HTML estático); sem taxa adaptativa, cache entre execuções ou robots.txt persistido (o cache é por instância); um provedor de busca utilizável (ver acima); nova tentativa/backoff (deliberadamente nenhum).

## Testes e mutação

OFFLINE (`tests/research-adapters/`, 36 testes, nenhum acesso à rede): sucesso, timeout, HTTPS inválido, redirect, redirect para login, CAPTCHA, bloqueio, robots, resposta grande, conteúdo inválido, erro de rede, limite de requisições, fonte correta (adapter → Researcher → V2 de ponta a ponta), data do relógio permitido, ausência de credenciais e de bypass, além de unidades de `netGuard`, transporte (módulo `https` falso), `robots`, `htmlExtract` (inclusive HTML hostil), Nominatim e fronteiras de arquitetura. Total do projeto: 1184 (1182 passam e 2 pulados com `.env`; 1177 e 7 pulados sem `.env`; 0 falhas). O smoke test real **não** entra nessas contagens. Mutação: 140 mutantes (cabeçalhos/credenciais, limites, robots, redirecionamentos, classificação de falhas, transporte, guarda de rede, robots.txt, HTML, Nominatim); 12 sobreviveram na primeira rodada — 7 lacunas reais corrigidas e agora detectadas (robots com query, redirecionamento para login no último salto, evento de links truncados, destruição da conexão em erro de resposta, limites de varredura do HTML, tags herdadas) e 5 equivalentes/redundantes: `http` no transporte (a política já recusa), `::1` e `::` (a regra do IPv6 compatível já os recusa), `javascript:` no HTML (já não é https) e o formato do @usuário no Nominatim (o `classifyLink` revalida).
