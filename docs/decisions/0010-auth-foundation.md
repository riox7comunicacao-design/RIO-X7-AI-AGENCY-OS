# 0010 — Fundação de Autenticação e Autorização (USER/ROLE/PERMISSION/AuthorizationContext)

## Status

Implementado (fundação apenas). Registrado em 2026-09-18, Passo 0009.6, como primeira implementação real do modelo conceitual definido em [0009](./0009-identity-roles-and-authorization-model.md) e detalhado em [0009.5 (design, sessão anterior)](./0009-identity-roles-and-authorization-model.md).

## Objetivo

Implementar somente a fundação de `USER`, `ROLE`, `PERMISSION` e `AuthorizationContext`, e preparar (sem conectar) a integração futura com Supabase Auth. Nenhuma escrita real no CRM, nenhum Dashboard, nenhuma automação comercial, nenhuma conta/projeto Supabase foi criada por este passo.

## Supabase Auth como direção escolhida

Confirmado (0009.4/0009.5): Supabase Auth resolve "quem é essa pessoa?"; a Rio X7 mantém inteiramente "essa pessoa pode fazer o quê?" (`USER`/`role`/`permissions`/`status`, nunca delegado ao provedor). Nenhum SDK do Supabase foi instalado — `package.json` continua com `dependencies: {}`. A integração futura é isolada atrás de um adapter (`src/auth/authAdapter.js`) que hoje só verifica a presença de `SUPABASE_URL`/`SUPABASE_ANON_KEY` como variáveis de ambiente e falha explicitamente (nunca finge uma sessão) se chamado sem configuração real.

## USER

Implementado em `src/auth/user.js` (`defineUser()`), validando exatamente o modelo de 0009/0009.5:

```
USER { userId, authUserId (nullable), name, email, role, permissions, status, createdAt, updatedAt }
```

Nunca aceita/armazena senha, token ou credencial. `authUserId` é `null` até o primeiro login (convite pré-existente, vinculado por `email` — ver `userResolver.js`).

## ROLE

`ADMIN` e `COMMERCIAL_CLOSER` (`src/auth/constants.js`, `ROLE`). Rótulo organizacional — nunca lido por nenhuma checagem de autorização.

## PERMISSION

Formato `{ACTION}:{DOMÍNIO}`, `ACTION` fechada em 10 valores: as 9 já documentadas em `permissions-matrix.md` (`READ`, `ANALYZE`, `PROPOSE`, `WRITE`, `EXECUTE`, `SEND`, `PUBLISH`, `DELETE`, `APPROVE`) mais `MANAGE` — introduzida neste passo especificamente para `MANAGE:USERS`, que o próprio pedido deste passo já usa como exemplo de permissão (seção 4), sem estar coberta pelas 9 originais. `DOMAIN` é livre/extensível — novos domínios não exigem alteração de código.

Permissões já nomeadas em `PERMISSION` (`src/auth/constants.js`): `READ:CRM`, `ANALYZE:CRM`, `PROPOSE:CRM`, `WRITE:CRM`, `APPROVE:LEAD_APPROVAL`, `APPROVE:OUTBOUND_APPROVAL`, `MANAGE:USERS`.

## ROLE != PERMISSION — como foi mantido na prática

`ROLE_PERMISSION_TEMPLATE` (`src/auth/constants.js`) existe só como ponto de partida ao criar/seedar um usuário — nenhuma função de autorização (`hasPermission`, `requirePermission`, `requireActiveUser`) lê `role` para decidir uma ação; todas leem exclusivamente o array `permissions` já persistido no próprio `USER`. Isso vale inclusive para `ADMIN`: seu template inclui, de forma **explícita**, cada permissão já nomeada no sistema (`Object.values(PERMISSION)`) — nunca um coringa `"*:*"` ou um atalho `if role === 'ADMIN' then allow`.

## CLOSER — permissões implementadas

Exatamente as aprovadas nesta sessão, nem mais nem menos:

```
READ:CRM
ANALYZE:CRM
PROPOSE:CRM
APPROVE:LEAD_APPROVAL
APPROVE:OUTBOUND_APPROVAL
```

`MANAGE:USERS` explicitamente **fora** do template do Closer — testado (`[C]`/`[F]` em `tests/auth/authorization.test.js`).

## ADMIN — regras

`ADMIN` = maior autoridade administrativa humana — não uma permissão coringa, não uma licença para IA agir sozinha. Nenhuma checagem de autorização trata `role === 'ADMIN'` como "permita tudo"; as permissões do ADMIN são uma lista explícita como qualquer outro usuário. Nenhum bypass de DNC, nenhuma exceção de UI, nenhuma fabricação de identidade por IA é aberta por este passo — reafirmação de 0009.5, seções J/K, sem alteração de mérito.

## ACTIVE / INACTIVE

`USER_STATUS` (`ACTIVE`/`INACTIVE`). `requireActiveUser()`/`requirePermission()` sempre reverificam `status` no momento da ação (nunca confiam num valor "lembrado" desde a resolução do contexto) — `hasPermission()` retorna `false` (nunca lança, nunca retorna `true`) para um usuário `INACTIVE`. Testado em `[G]`.

## AI != HUMAN

Nenhum especialista de IA é representado como `USER` — não existe `role` para IA no enum `ROLE` (`SYSTEM`, usado em `approvalQueue.js`, nunca é um valor válido de `role` aqui — rejeitado explicitamente, teste `[M]`/`[J]`). A única forma válida de obter um `AuthorizationContext` é `createAuthorizationContext()`, que sempre retorna um objeto `Object.freeze`d; `hasPermission`/`requirePermission` recusam qualquer objeto que não seja o resultado dessa função — inclusive um objeto forjado com a forma exata de um ADMIN (teste `[M]`). Esta é uma mitigação estrutural, documentada como tal no próprio código (`authorizationContext.js`) — não uma prova criptográfica de origem.

## Segurança

Nenhuma senha, token, API key, Supabase secret, service role key, credencial ou cookie secreto foi criado, armazenado ou commitado. `.gitignore` já cobria `.env`/`.env.*`/`*secret*`/`*token*`/`*credential*` antes deste passo (nenhuma alteração necessária nele). `.env.example` criado só com nomes de variáveis (`SUPABASE_URL`, `SUPABASE_ANON_KEY`), sem nenhum valor.

## O que foi implementado

- `src/auth/constants.js` — `ACTION`, `ROLE`, `USER_STATUS`, `PERMISSION`, `ROLE_PERMISSION_TEMPLATE`, `isValidPermissionString`.
- `src/auth/user.js` — `defineUser()` (validação do modelo `USER`).
- `src/auth/authorizationContext.js` — `createAuthorizationContext()`, `assertIsAuthorizationContext()`, `requireActiveUser()`, `hasPermission()`, `requirePermission()`.
- `src/auth/userResolver.js` — `createUserStore()`/`resolveAuthorizationContext()`, um store **em memória** (não é banco real, não persiste em disco) que documenta/testa o fluxo `authUserId/email → USER → AuthorizationContext`.
- `src/auth/authAdapter.js` — abstração do Supabase Auth (`isSupabaseConfigured()`, `createSupabaseAuthAdapter()`), sem SDK instalado e sem conexão real.
- `src/auth/approvalQueueBridge.js` — `toApprovalQueueIdentity()`, conversão pequena e seletiva de `AuthorizationContext` para o formato `identity` que `approvalQueue.js` já espera desde 0009.2 — **sem alterar `approvalQueue.js`**.
- `src/auth/index.js` — agregador de exports do módulo.
- `tests/auth/authorization.test.js` — 16 testes novos, cobrindo os itens A–N pedidos, mais dois testes adicionais (`userResolver`, integração real com `approvalQueue.js` via a ponte).
- `.env.example` — variáveis de ambiente esperadas, sem valores.
- `package.json` — script `test` ajustado para descobrir também `tests/auth/*.test.js` (o padrão anterior só cobria `tests/research-prospector/*.test.js`).

## O que NÃO foi implementado (fora de escopo, por instrução explícita)

CRM write; Dashboard; SDR outbound; WhatsApp/Instagram/e-mail/Google Calendar; pagamentos; publicação; campanhas; envio de mensagens; automações comerciais; qualquer projeto/conta/conexão real com Supabase; persistência real de usuários (banco/arquivo); tela ou fluxo de gestão de usuários (convite, edição, desativação, exclusão); sistema completo de auditoria (`audit_log` continua conceitual, não implementado como tabela/arquivo); alteração de `approvalQueue.js`.

## Pendências (registradas, não resolvidas)

- Nome final da permissão de administração de usuários já foi decidido nesta sessão como `MANAGE:USERS` (não mais pendente) — o que continua pendente é a **implementação** de qualquer fluxo que a utilize (convite, edição, desativação).
- Regra "usuário não pode alterar as próprias permissions" (`actingUserId !== targetUserId`) — desenhada em 0009.5, ainda não implementada em código (não há nenhuma função de administração de usuários neste passo).
- Exceção para o único ADMIN existente poder editar as próprias permissões — não resolvida.
- Persistência real do `USER` store (arquivo local nos moldes de `approvalQueue.js`, ou banco Supabase) — não decidida nem implementada.
- Implementação real do `authAdapter` contra o SDK do Supabase — depende de projeto Supabase existir (não criado).
- Implementação real do `audit_log` — hoje é só o modelo conceitual de 0009.5, sem código.
- Conexão de fato entre um futuro Dashboard/API e este módulo — não existe nenhum servidor ainda.

## Próximo passo recomendado

Não implementado por este passo (Regra 22 — não avançar de escopo). Candidatos naturais, cada um exigindo autorização própria: (1) criar o projeto Supabase real e implementar `authAdapter` de fato; (2) implementar persistência real do `USER` store; (3) implementar a permissão `MANAGE:USERS` em uma função de administração de usuários; (4) só então considerar o Passo 4 (CRM write), agora com uma base de autorização real para alimentá-lo.

## Atualização (Passo 0009.8, Fase A — verificação de conexão real)

Fase A do Passo 0009.8 verificou o ambiente local e confirmou: nenhuma variável `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` estava presente; nenhum projeto Supabase estava acessível a partir deste ambiente. Resultado: **B — precisa de ação do usuário**.

## Atualização (Passo 0009.8, Fase B — conexão real implementada)

O usuário criou o projeto Supabase (plano FREE) e configurou `.env` localmente. `authAdapter.js` foi atualizado de stub para real, e a conectividade foi verificada de fato (não simulada). Detalhamento completo em [0011-supabase-auth-integration.md](./0011-supabase-auth-integration.md) — inclui o achado de que `getSession()` sozinho não prova conectividade real, a classificação de erros implementada, e a confirmação de que nenhum USER/tabela/migration foi criado por este passo.
