# 0011 — Integração Real com Supabase Auth (Fundação de Conectividade)

## Status

Implementado (só a camada de conectividade/identidade — nenhum USER persistente, nenhum login visual, nenhuma escrita). Registrado em 2026-09-18, Passo 0009.8 Fase B, sobre a fundação de [0010](./0010-auth-foundation.md).

## Contexto

O usuário criou um projeto Supabase real, no **plano FREE**, e configurou localmente (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) em um arquivo `.env` — nunca commitado, protegido por `.gitignore` (confirmado com `git check-ignore -v .env` antes e depois desta etapa). **Nenhum valor dessas variáveis aparece neste documento, no código, nos testes ou em qualquer saída de terminal deste passo** — só presença (`PRESENTE`/`AUSENTE`) ou resultados classificados (status HTTP, categoria de erro).

## Carregamento do `.env`

Avaliado e confirmado: `node --env-file-if-exists=.env` (nativo do Node 24, sem flag experimental) carrega as variáveis corretamente, e **não falha quando o arquivo não existe** (testado explicitamente: aponta para um arquivo inexistente e o processo continua normalmente, só com um aviso em stderr). Isso foi preferido a instalar `dotenv` — **nenhuma dependência foi adicionada só para isso**. O script `test` em `package.json` foi atualizado para usar essa flag, então `npm test` funciona igualmente bem com ou sem `.env` presente (em CI, num clone novo, etc.).

## SDK utilizado

`@supabase/supabase-js` — única dependência nova instalada (`package.json`: `dependencies: { "@supabase/supabase-js": "^2.116.0" }`; `package-lock.json` gerado). Nenhuma outra dependência foi instalada (nenhum `dotenv`, framework, ORM, ou biblioteca de dashboard).

## Auth Adapter — de stub para real

`src/auth/authAdapter.js` deixou de ser um stub que sempre falha e passou a:

1. Criar um cliente Supabase real (`createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })`) — configuração de servidor/backend, nunca de navegador.
2. Expor `getSessionStatus()` (consulta local de sessão), `checkConnectivity()` (prova real de rede) e `resolveAuthenticatedIdentity()` (identidade de quem estiver autenticado, ou erro explícito).
3. **Nunca ler `SUPABASE_SERVICE_ROLE_KEY`** — essa variável não é usada por nenhuma função deste arquivo, em nenhuma hipótese.
4. **Nunca decidir `ADMIN`/`CLOSER`/`role`/`permissions`** — o adapter só responde "quem está autenticado?" (`authUserId`, `email`); toda regra de negócio continua em `user.js`/`authorizationContext.js`, inalterados por este passo.

## Achado técnico relevante: `getSession()` sozinho não prova conectividade

Verificado empiricamente durante este passo: com `persistSession: false` (obrigatório para uso em servidor, já que não existe `localStorage` em Node), `client.auth.getSession()` resolve em ~1ms **mesmo apontando para um projeto Supabase inexistente** — é uma operação puramente local (não há sessão para persistir/recuperar, então não há nada para buscar na rede). Ou seja: **"sessão inexistente" não comprova que o Supabase está acessível** — só comprova que, localmente, nenhum token foi fornecido a este cliente (o que é sempre verdade hoje, já que nenhum Dashboard/fluxo de login existe para fornecer um).

Por isso, `checkConnectivity()` foi implementada separadamente, chamando o endpoint público e somente-leitura `GET {SUPABASE_URL}/auth/v1/settings` (o mesmo usado pelos SDKs oficiais do Supabase para descobrir a configuração de auth do projeto) — sem efeito colateral, sem autenticar ninguém. **Este teste, sim, prova rede real**: contra o projeto configurado, retornou HTTP 200 em ~670ms (tempo consistente com uma requisição HTTPS real, não uma resposta local); contra um host inexistente, `fetch` lança `TypeError: fetch failed` (classificado como `NETWORK`); contra o projeto real com uma chave inválida, retornou HTTP 401 (classificado como `AUTH`).

## Classificação de erros (`CONNECTIVITY_ERROR`)

Baseada em comportamento real observado durante este passo, não inventada:

| Categoria | Quando ocorre (verificado) |
|---|---|
| `CONFIGURACAO` | `SUPABASE_URL`/`SUPABASE_ANON_KEY` ausentes, ou `SUPABASE_URL` com formato inválido (o próprio SDK rejeita ao criar o cliente) |
| `NETWORK` | Host inalcançável — `fetch` lança antes de qualquer resposta HTTP (testado com um subdomínio `.supabase.co` inexistente) |
| `AUTH` | Supabase respondeu, mas rejeitou a API key — HTTP 401 (testado com uma chave inválida contra o projeto real) |
| `PERMISSION` | Supabase respondeu proibindo o acesso — HTTP 403 (categoria reservada; não observada durante este passo, mas mantida por completude) |
| `SDK` | Falha inesperada dentro do próprio SDK, não classificável nas demais |
| `UNKNOWN` | Qualquer resposta HTTP fora das anteriores |

## Resultado da verificação real (Passo 0009.8, seção 10)

**D — Supabase acessível e sem sessão** foi o resultado confirmado, com as duas provas exigidas separadamente: `checkConnectivity()` → `OK` (rede real, HTTP 200); `getSessionStatus()` → `{ authenticated: false }` (sem sessão, não é erro). Nenhuma sessão foi simulada; nenhum usuário foi criado; nenhuma tabela foi criada; nenhuma migration foi executada.

## USER — continua em memória

`src/auth/userResolver.js` **não foi alterado**. Continua sendo um store em memória, sem persistência real (nem arquivo local, nem tabela Supabase). Uma identidade no formato que o Supabase devolveria (`{ authUserId, email }`) sem correspondência no store continua sendo rejeitada explicitamente (equivalente a `USER_NOT_FOUND`) — nunca um usuário é inventado a partir de um e-mail ou de uma regra implícita (`email conhecido → ADMIN`, `primeiro usuário → ADMIN`, etc. — nenhuma dessas regras existe em nenhum lugar do código).

## Autenticação visual — não implementada

Nenhum Dashboard, tela de login, cadastro público ou fluxo de login existe. Não há, hoje, nenhuma forma de um usuário real de fato autenticar-se nesta aplicação — a verificação deste passo prova que o **projeto e a API de Auth existem e respondem**, não que exista um caminho para alguém logar.

## O que continua fora de escopo (reafirmado)

Dashboard; tela de login; cadastro público; convite de usuários; administração de usuários (`MANAGE:USERS`); CRM write; escrita no Notion; SDR/outbound/WhatsApp/Instagram/e-mail; campanhas; pagamentos; audit log completo; multi-tenant; qualquer tabela `users`/`profiles`/equivalente no Supabase; qualquer migration.

## Segurança

- `SUPABASE_SERVICE_ROLE_KEY` não é lida, não é usada, não é mencionada em nenhum valor real em nenhum arquivo.
- Nenhuma função de impersonation (`loginAI`, `asUser`, `assumeRole`, `impersonateAdmin` ou equivalente) existe — verificado por teste (`tests/auth/supabase-integration.test.js`, item L).
- Nenhum valor de `SUPABASE_URL`/`SUPABASE_ANON_KEY` aparece em nenhum teste, log ou neste documento.

## Próximo passo recomendado

Não implementado por este passo. Candidatos, cada um com autorização própria: (1) persistência real do `USER` store (arquivo local disciplinado como `approvalQueue.js`, ou uma tabela Supabase mínima, schema já registrado em [0009](./0009-identity-roles-and-authorization-model.md)/[0010](./0010-auth-foundation.md)); (2) um fluxo real de login (exigiria um Dashboard/servidor, ainda inexistente); (3) só então, `MANAGE:USERS` e administração de usuários.
