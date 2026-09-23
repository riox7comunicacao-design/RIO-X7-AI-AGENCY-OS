# RIO X7 AI AGENCY OS — MULTICOMPUTER HANDOFF

Este documento existe para que o projeto **nunca dependa de uma máquina específica nem da memória de uma conversa com o Claude**. Tudo que o código precisa para funcionar está, ou no GitHub, ou documentado aqui como configuração local que precisa ser recriada à mão. Os valores abaixo (commit, contagens) são um retrato de quando este documento foi escrito — **sempre confira o estado real com os comandos da seção "Como clonar/verificar"**, nunca confie só no texto.

## Estado atual (na data deste documento)

- **branch:** `main`
- **último commit de código:** `a5ed905` — `feat(crm): implement CRM domain and persistence port`
- **origin/main:** sincronizado com o commit acima (confirmado por push + `git fetch` antes de escrever este documento)
- **etapa concluída:** CRM-DOMAIN (modelo de dados, os 13 status, máquina de estados, DNC, deduplicação, repositório de persistência — ver [docs/decisions/0013-crm-domain.md](../decisions/0013-crm-domain.md))
- **próxima etapa:** CRM-SERVICE (a fronteira de autorização sobre o CRM Domain, no padrão de `src/services/approvalQueueService.js`)

Este próprio documento, e o `CONTINUE-HERE.md` ao lado, são publicados num commit **seguinte** ao de cima (documentação, sem mudança de código) — confira `git log --oneline -5` para o HEAD exato agora.

## Como clonar

```powershell
git clone https://github.com/riox7comunicacao-design/RIO-X7-AI-AGENCY-OS.git
cd RIO-X7-AI-AGENCY-OS
```

Se o repositório já existir localmente (ex.: você está voltando a um clone antigo):

```powershell
git fetch origin
git status
git log -1 --oneline
git rev-parse HEAD
git rev-parse origin/main
```

Confirme que `HEAD` e `origin/main` são o mesmo commit antes de continuar. Se não forem, `git pull` (ou decida deliberadamente qual lado prevalece — nunca resolva isso com `git reset --hard` sem entender a diferença primeiro).

## Como instalar

```powershell
npm install
```

Node.js **22 ou mais recente** é exigido (`engines.node` em `package.json`; este projeto foi testado com a 24.x). Nenhuma outra ferramenta (banco, Docker, etc.) é necessária — a única dependência de terceiros é `@supabase/supabase-js`.

## Como executar os testes

```powershell
npm test
```

Sem nenhuma configuração local, a suíte roda quase inteira (só os testes que exigem `.env`/um token real do Supabase ficam `PENDENTE`, nunca falham). No retrato desta data: **491 testes, 489 passam, 0 falham, 2 pulados** sem `.env`/token real presentes.

## Verificação estrutural (preflight)

Antes de tentar rodar o Dashboard pela primeira vez numa máquina nova:

```powershell
node --env-file-if-exists=.env scripts/preflight.js
```

Verifica versão do Node, dependências instaladas, estrutura de diretórios, `.gitignore`, presença de `.env` e das variáveis obrigatórias (só `PRESENTE`/`AUSENTE`, nunca o valor), `data/users.json`, e conectividade real (só leitura, sem login) com o Supabase. Termina com uma lista de OK/AVISO/FALHA e o exit code reflete se algo falhou.

## Como iniciar o Dashboard

```powershell
npm start
```

ou, em desenvolvimento (reinicia sozinho quando o código muda — **não** quando `.env`/`data/users.json` mudam; para esses dois, pare e rode de novo):

```powershell
npm run dev
```

Abra `http://127.0.0.1:3000` (ou a porta/host configurados — ver variáveis abaixo). Sem `.env` configurado ou sem `data/users.json`, o servidor **recusa subir**, com uma mensagem clara dizendo o que falta — isso é o comportamento esperado, não um bug.

## Variáveis de ambiente

Nomes apenas — **nenhum valor secreto neste documento, nem em nenhum outro arquivo versionado**.

| Variável | Obrigatória | Para quê |
|---|---|---|
| `SUPABASE_URL` | Sim | URL do projeto Supabase (ver seção Supabase abaixo) |
| `SUPABASE_ANON_KEY` | Sim | Chave pública "anon" do mesmo projeto — pública por desenho, mas ainda assim nunca versionada |
| `PORT` | Não (padrão 3000) | Porta do Dashboard |
| `HOST` | Não (padrão 127.0.0.1) | Endereço em que o servidor escuta — nunca exponha além do localhost sem um proxy HTTPS na frente |
| `RIO_X7_USERS_FILE` | Não (padrão `data/users.json`) | Caminho do arquivo de usuários operacionais |
| `RIO_X7_QUEUE_PATH` | Não (padrão `data/approval-queue.json`) | Caminho da fila de aprovação |
| `RIO_X7_TEST_ACCESS_TOKEN` | Não | Só para o teste `[REAL-2]` (opcional); nunca um usuário real |

`SUPABASE_SERVICE_ROLE_KEY` **nunca** é uma variável deste projeto — nenhum código a lê, em nenhuma hipótese. Se ela existir no seu ambiente por outro motivo, não a copie para o `.env` deste projeto.

Copie `.env.example` para `.env` e preencha os dois valores obrigatórios.

## Supabase

- **Qual projeto é usado:** o já criado por Breno no plano FREE do Supabase — o mesmo desde a decisão [0011](../decisions/0011-supabase-auth-integration.md). Este documento não repete nem indica a URL/projeto; ela vive só no `.env` local de quem já tem acesso.
- **Onde encontrar a configuração:** painel do Supabase (`app.supabase.com`) → o projeto da Rio X7 → **Project Settings → API** → `Project URL` (vira `SUPABASE_URL`) e `anon public` key (vira `SUPABASE_ANON_KEY`). A `service_role` key aparece na mesma tela — **nunca copie essa para nada deste projeto**.
- **O que precisa ser recriado manualmente no computador novo:** só o arquivo `.env` (os dois valores acima). O projeto Supabase em si é o mesmo, na nuvem — nada precisa ser recriado nele.
- **Como verificar conectividade:** `node --env-file-if-exists=.env scripts/preflight.js` (seção acima) — faz uma checagem real, só leitura, sem autenticar ninguém.
- **Como configurar os usuários operacionais:** ver a seção "Dados locais ignorados pelo Git" abaixo — é um arquivo separado (`data/users.json`), não uma configuração do Supabase em si. Criar/confirmar as CONTAS de Breno e Rafael no Supabase Auth (Authentication → Users) é uma ação manual, feita por Breno diretamente no painel — nenhum Claude Code cria usuário no Supabase.

## Dados locais ignorados pelo Git

Nenhum destes é (ou deve ser) versionado — `.gitignore` já cobre todos.

| Arquivo | Obrigatório? | Pode ser recriado do zero? | Contém dado sensível/pessoal? |
|---|---|---|---|
| `.env` | Sim | Sim — copie `.env.example` e preencha (ver seção Supabase) | Sim (chave pública, mas mesmo assim nunca versionada) |
| `data/users.json` | Sim (para o Dashboard subir) | **Não sozinho** — precisa do `authUserId` real de cada pessoa (Supabase Auth → Users → User UID). Formato exato documentado em `.env.example` e em `src/server/index.js` (`USER_FIELDS`) | Sim — nome e e-mail reais de Breno/Rafael |
| `data/approval-queue.json` | Não | Sim — ausente = fila vazia, um estado válido | Se existir com dado real: sim (prospects reais) |
| `data/approval-queue.dev.json` / `data/approval-queue.manual-validation.json` | Não | Sim — só dados fictícios (`scripts/seed-dev-queue.js` recria) | Não (só `example.test`) |

**Se `data/approval-queue.json` já tiver prospects reais nesta máquina e você quiser continuar com eles no computador novo:** **NÃO** copie o arquivo para o GitHub, nem para nenhum repositório público. Transfira por um canal que só você controla — um pen drive, um compartilhamento seguro de arquivo do seu gerenciador de senhas, ou um upload privado numa nuvem pessoal (Google Drive/iCloud) que só você acessa — e apague a cópia temporária depois. Este documento não faz essa transferência por você.

## Ordem de retomada

1. `git clone`/`git pull` (confirme `HEAD == origin/main`)
2. `npm install`
3. Copiar `.env.example` → `.env` e preencher `SUPABASE_URL`/`SUPABASE_ANON_KEY`
4. `node --env-file-if-exists=.env scripts/preflight.js` — deve dar 0 falhas até aqui (menos `data/users.json`, que ainda não existe)
5. Criar `data/users.json` (formato em `.env.example`; `authUserId` de cada pessoa vem do painel do Supabase)
6. `node --env-file-if-exists=.env scripts/preflight.js` de novo — agora tudo deve estar OK
7. `npm test`
8. `npm start` (ou `npm run dev`)
9. Validar o Dashboard: login real, `/api/me`, aprovações
10. Continuar a partir da próxima etapa aprovada (ver [CONTINUE-HERE.md](./CONTINUE-HERE.md))

## Acesso remoto / continuidade

Nenhuma integração de acesso remoto foi criada ou é necessária além do próprio GitHub — o repositório é a única fonte compartilhada entre computadores. O Dashboard não deve ser exposto além de `127.0.0.1` sem um proxy HTTPS deliberado na frente (não configurado, não recomendado nesta etapa). Nenhum túnel público, porta aberta ou "porta dos fundos" para o Claude foi criado.

## Próxima etapa

**CRM-SERVICE** — ver [docs/decisions/0013-crm-domain.md](../decisions/0013-crm-domain.md), seção "Próximo passo recomendado". Não implementado ainda; aguardando autorização.
