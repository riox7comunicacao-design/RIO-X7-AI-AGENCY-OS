# 0033 — Instância hospedada "CRM-only" (Fase WEB 1)

**Estado:** implementado e testado localmente. **Nenhum deploy foi feito**, nenhuma hospedagem foi contratada ou conectada, o Supabase não foi tocado (nenhuma migration, nenhuma consulta) e o servidor operacional local não foi reiniciado. A homologação numa hospedagem real é a próxima etapa e depende do proprietário (ver `docs/operations/web-hostinger.md`).

## Contexto
- O CRM Comercial 5.0 já tem persistência oficial no Supabase (`REPOSITORY_MODE=supabase`: clientes, catálogos, funis, negociações — decisões 0024, 0029). Mas a **Approval Queue** e **toda a prospecção** (lotes, briefs, jobs, dossiês, perfis) ainda guardam estado em **arquivos locais** (`data/*.json`), e a prospecção chama o `claude -p` instalado no computador do proprietário.
- A hospedagem escolhida para o primeiro lançamento é a **Hostinger Web Apps (plano Business/"Unlimited")**: sem VPS. Segundo a documentação da Hostinger, os diretórios gerenciados do deploy são **sobrescritos a cada publicação** e a documentação não promete persistência fora deles; o processo é parado por ociosidade e reiniciado na próxima requisição; não há root nem SSH para edição.
- O sistema local completo **continua o produto de trabalho do proprietário** e não pode ser prejudicado.

## Decisão
Um **modo de implantação explícito**, `RIO_X7_DEPLOYMENT_MODE`:

| Valor | O que é |
|---|---|
| `local` (padrão; variável ausente ou vazia) | O sistema completo, exatamente como era. |
| `crm-only` | A instância hospedada: só o CRM Comercial. Qualquer outro valor derruba a subida (nunca se cai em `local` por engano). |

Em `crm-only`:
1. **Composição mínima.** `src/server/index.js` só compõe CRM, catálogos, funis e negociações, sobre o Supabase. A Approval Queue, a promoção, a prospecção, os briefs, os jobs (inclusive a recuperação de jobs interrompidos), os leads reprovados, o enriquecimento e as exclusões permanentes **não são criados**: nenhum repositório de arquivo nasce, nenhum arquivo de `data/` é lido ou criado, nada é escrito em disco (provado por teste que registra todas as chamadas do `fs`).
2. **Recusa no servidor, não só no menu.** `createApp` recusa receber esses módulos (nem como dependência morta) e responde **404 `MODULE_DISABLED`** a `/api/approvals*`, `/api/prospecting*` e `/api/leads*`, **qualquer método, com ou sem sessão, antes da autenticação e de qualquer Service**. O painel também os esconde (o `/config.json` traz `modo: "crm-only"`), mas isso é só conforto.
3. **Exige** `REPOSITORY_MODE=supabase` (nunca persistência em arquivo), `SUPABASE_SERVICE_ROLE_KEY`, `RIO_X7_PUBLIC_URL` (origem https) e uma fonte de usuários explícita — não existe arquivo de usuários padrão.
4. **Usuários por variável de ambiente.** `RIO_X7_USERS_JSON`: a lista JSON no **mesmo formato** de `data/users.json` (mesmos campos, papéis e regras de `defineUser`), ou esse JSON em base64 (evita problemas de aspas no painel). Não se combina com `RIO_X7_USERS_FILE`. Valor ausente, truncado, corrompido ou inválido derruba a subida com uma mensagem que não repete o conteúdo. `scripts/export-users-env.js` gera o valor a partir de um arquivo de usuários (o proprietário o executa; nenhuma conta nova é criada). No modo `local` nada muda: `data/users.json` continua valendo.
5. **Entrada da hospedagem:** `server.js` na raiz (a Hostinger executa um arquivo de entrada, não `npm start`): carrega o servidor e chama `main()`, que sobe **um** servidor por processo (uma segunda chamada devolve a mesma promessa). `HOST` e `PORT` vêm do ambiente. Não há etapa de build. Node 22 (`engines: >=22.0.0`).
6. **Health check:** `GET /healthz`, público, sem Supabase nem disco, responde só `{"status":"ok"}`, fora do redirecionamento HTTPS e fora do log.
7. **Segurança mínima para a internet** (só em `crm-only`):
   - **HTTPS:** se o proxy informa `X-Forwarded-Proto: http`, leituras são redirecionadas (308) para a **origem pública configurada** — nunca para o cabeçalho `Host` — e escritas são recusadas (403 `HTTPS_REQUIRED`). Sem o cabeçalho nada se sabe e nada se redireciona: a imposição de HTTPS é do domínio/plataforma e do HSTS.
   - **HSTS** `max-age=31536000`, **sem** `includeSubDomains` (o domínio pode abrigar outros sites) e sem `preload`; `Permissions-Policy` fechada.
   - **CORS:** nenhum cabeçalho `Access-Control-*`; `OPTIONS` não vira preflight liberado.
   - **Tentativas abusivas:** o login é direto do navegador ao **Supabase Auth** (o servidor nunca vê a senha), então o limite das tentativas de senha é o do Supabase (ver o guia). A API própria ganhou um **limitador de falhas de autenticação** em memória: 30 recusas por sessão ausente/inválida em 10 minutos bloqueiam o cliente por 10 minutos (429 + `Retry-After`). Só `401` conta (nem 403 nem 503). Chave: o último `X-Forwarded-For` com `RIO_X7_TRUST_PROXY=1`, senão o endereço do socket.
   - Os cabeçalhos, a CSP, a autenticação e o RBAC de todas as rotas, a mensagem de erro sempre fixa (sem token, chave ou stack) e a regra "a service_role nunca vai ao navegador" **já existiam** e foram reconferidos por testes na composição hospedada.

## O que NÃO muda
- O modo local, os arquivos de `data/`, a prospecção, a Fila de Aprovação, `npm start`, os testes herméticos, as migrations e o Supabase. Só `GET /healthz` passou a responder também no modo local.
- A propriedade de **gravação única por processo**: a proteção de concorrência entre duas gravações do mesmo registro continua dentro de um processo (como já documentado em 0023/0024). A instância hospedada deve rodar **um** processo.

## Consequências e riscos (não provados)
- **Não confirmado pela documentação da Hostinger** (precisa do teste de homologação): qual porta/`HOST` a plataforma espera; se o HTTPS do app Node é terminado pela plataforma e se ela envia `X-Forwarded-Proto`/`X-Forwarded-For`; se o arquivo de entrada é executado diretamente por `node`; o tamanho máximo de uma variável de ambiente; quanto custa o reinício após ociosidade.
- A **parada por ociosidade** zera os contadores do limitador (em memória) e a primeira requisição depois dela é mais lenta. O CRM não perde nada: o estado é do Supabase.
- O limitador sem `RIO_X7_TRUST_PROXY=1` atrás de um proxy dá a **mesma chave a todos**: o limite é generoso e só conta falhas, mas um abusador pode bloquear todos por 10 minutos. Por isso `RIO_X7_TRUST_PROXY=1` deve ser ligado assim que o teste de homologação mostrar que o proxy acrescenta o endereço real.
- O painel esconde os módulos desativados; um painel antigo em cache apenas recebe `MODULE_DISABLED` do servidor.
- A prospecção continua **só no computador local** (depende do `claude -p` e de arquivos): nada foi migrado, nada foi apagado. Mover a fila e a prospecção para o Supabase é uma fase própria, futura, só se o proprietário quiser.

## Alternativas rejeitadas
- **VPS agora:** custo e administração contínua sem necessidade para o CRM; permanece como caminho futuro se a prospecção precisar ficar online.
- **Só esconder os módulos no menu:** deixaria rotas com escrita em disco efêmero e dados reais de prospects a um deploy de serem perdidos.
- **Gravar a fila no disco da hospedagem:** a documentação não garante persistência fora dos diretórios sobrescritos.
- **Usuários num arquivo do deploy / no Git:** `data/*.json` tem dados pessoais e não vai pelo GitHub.
- **Redirecionar HTTP→HTTPS usando o `Host` da requisição:** abriria redirecionamento aberto; a origem vem da configuração.
