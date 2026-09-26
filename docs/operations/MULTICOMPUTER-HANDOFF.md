# RIO X7 AI AGENCY OS — MULTICOMPUTER HANDOFF

Este documento existe para que o projeto **nunca dependa de uma máquina específica nem da memória de uma conversa com o Claude**. Tudo que o código precisa para funcionar está, ou no GitHub, ou documentado aqui como configuração local que precisa ser recriada à mão. Os números abaixo (testes, resultados) são um retrato de **2026-09-25** — **sempre confira o estado real com os comandos deste documento**, nunca confie só no texto.

O passo a passo desta página foi **ensaiado** a partir de um clone limpo do `origin/main` (ver "Resultado esperado"). Depois de clonar, leia o [CONTINUE-HERE.md](./CONTINUE-HERE.md): ele diz onde o trabalho parou e qual é a próxima etapa.

## O que vive onde

| Categoria | Onde vive | Como chega ao computador novo |
|---|---|---|
| **Código e arquitetura** (código, testes, documentação, decisões, `package.json`, `package-lock.json`, `.env.example`) | **GitHub** | `git clone` |
| **Configuração e segredos** (`.env`, `data/users.json`) | Só no computador de quem usa. **Nunca no Git.** | Recriados à mão (passos 6 a 8) |
| **Dados operacionais locais** (`data/crm.json`, `data/approval-queue.json`, `data/prospecting-batches.json` — os lotes do Prospector, criados na primeira submissão) | Só no computador onde foram criados. **Nunca no Git.** | **Não são sincronizados.** Um computador novo começa com CRM e fila vazios — um estado válido. |

**Dados de teste** (por exemplo, os registros "TESTE CRM Rio X7" e "TESTE REDE 02") **não precisam ser transportados**. Compartilhar o CRM entre computadores exigirá uma **persistência centralizada** — uma necessidade futura, **ainda não decidida nem implementada**; nenhuma sincronização foi inventada.

## Pré-requisitos (Windows)

- **Windows** com PowerShell.
- **Node.js 22 ou mais recente** (`engines` em `package.json`; testado com a 24.x). Confira com `node --version`. O `npm` já vem com o Node.
- **Git** (`git --version`).
- **Acesso ao GitHub**: uma conta com permissão no repositório, autenticada neste computador (o Git Credential Manager pede o login na primeira vez).
- **Acesso ao projeto Supabase** da Rio X7 (painel `app.supabase.com`): é de lá que vêm a URL do projeto, a chave pública "anon" e o UID de cada usuário (ver "Supabase").
- **Claude Code**, quando disponível, para continuar o desenvolvimento assistido: abra a pasta do projeto e peça para ler o `CONTINUE-HERE.md` antes de qualquer coisa.

## Passo a passo do zero

```powershell
# 1. clonar o GitHub
git clone https://github.com/riox7comunicacao-design/RIO-X7-AI-AGENCY-OS.git
# 2. entrar na pasta
cd RIO-X7-AI-AGENCY-OS
# 3. verificar a branch (deve ser: main)
git branch --show-current
# 4. verificar HEAD == origin/main (os dois hashes precisam ser iguais)
git fetch origin
git status
git rev-parse HEAD
git rev-parse origin/main
# 5. instalar exatamente o que está no package-lock.json
npm ci
# 6. criar o .env a partir do exemplo
Copy-Item .env.example .env
```

7. **Preencha só as variáveis obrigatórias** no `.env`: `SUPABASE_URL` e `SUPABASE_ANON_KEY` (onde achar: seção "Supabase"). As demais são opcionais e têm padrão.
8. **Crie `data/users.json`** (a pasta `data/` já existe). É a lista de quem pode entrar no painel; **nenhum usuário é criado automaticamente**. Formato (os valores abaixo são só marcadores — use os reais, no arquivo local):

   ```json
   [
     { "userId": "breno", "authUserId": "<UID do usuário no Supabase Auth>", "name": "Breno Bento", "email": "<e-mail da conta no Supabase>", "role": "ADMIN", "status": "ACTIVE" },
     { "userId": "rafael", "authUserId": "<UID do usuário no Supabase Auth>", "name": "Rafael", "email": "<e-mail da conta no Supabase>", "role": "COMMERCIAL_CLOSER", "status": "ACTIVE" }
   ]
   ```

   `role` é `ADMIN` ou `COMMERCIAL_CLOSER`; as permissões vêm da role (não se escrevem no arquivo). O `authUserId` é o **User UID** do painel do Supabase (Authentication → Users). Criar/confirmar as **contas** no Supabase Auth é uma ação manual de Breno no painel — nenhum Claude Code cria usuário no Supabase.

```powershell
# 9 e 10. NUNCA versionar o .env nem o data/users.json: confirme que estão ignorados e fora do "git status"
git check-ignore -v .env data/users.json
git status
# 11. conferir o ambiente (mostra PRESENTE/AUSENTE, nunca o valor de nada)
node --env-file-if-exists=.env scripts/preflight.js
# 12. rodar a suíte
npm test
# 13. iniciar o Dashboard
npm start
```

14. **Abrir o Dashboard** em `http://127.0.0.1:3000` e entrar com a conta real (roteiro de conferência em "Validar o Dashboard").
15. **Ler o [CONTINUE-HERE.md](./CONTINUE-HERE.md) antes de modificar qualquer código.**

Em desenvolvimento, `npm run dev` reinicia sozinho quando o **código** muda — mas **não** quando `.env`/`data/users.json` mudam (para esses dois, pare e rode de novo). Sem `.env` ou sem `data/users.json`, o servidor **recusa subir** com uma mensagem dizendo o que falta — é o comportamento esperado, não um bug.

## Como confirmar que o projeto está sincronizado

```powershell
git fetch origin
git status
git rev-parse HEAD
git rev-parse origin/main
```

`HEAD` e `origin/main` precisam ser o **mesmo hash** (e o `git status` não deve mostrar arquivos alterados) antes de continuar. Se forem diferentes, `git pull` — ou decida deliberadamente qual lado prevalece; nunca resolva isso com `git reset --hard` sem entender a diferença primeiro. Avisos como `LF will be replaced by CRLF` são só a conversão de fim de linha do Windows e não indicam problema.

## Resultado esperado (ensaio com um clone limpo do `origin/main`, 2026-09-24)

Ensaio feito em 2026-09-24 num diretório temporário, só com os arquivos versionados — **sem** copiar `.env`, `data/users.json` nem `data/crm.json`. As etapas CRM-INTEGRATION e "promoção pelo Dashboard" (2026-09-25) só acrescentaram testes e código (serviço, rota e tela): `package.json`, `package-lock.json` e o preflight não mudaram, então os passos e os resultados são os mesmos, com a contagem de testes atualizada:

| Passo | Resultado esperado |
|---|---|
| `git clone` | `main`, `HEAD == origin/main`, `git status` limpo; `data/` traz só o `README.md` |
| `npm ci` | 9 pacotes instalados (a única dependência direta é `@supabase/supabase-js`), 0 vulnerabilidades, ~10 s |
| `preflight` **sem** `.env` | **4 falhas e 1 aviso** (`.env` ausente, `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `data/users.json` ausentes; conectividade pulada), código de saída 1 — **esperado**: o computador ainda não está configurado |
| `preflight` **com** `.env` e `data/users.json` | 14 verificações, **0 falhas**, 0 avisos (inclui uma checagem real, só leitura e sem login, do Supabase) |
| `npm test` **sem** `.env` | **1076 testes: 1069 passam, 0 falham, 7 pulados** |
| `npm test` **com** `.env` | **1076 testes: 1074 passam, 0 falham, 2 pulados** |

Os pulados são esperados: sem `.env`, 5 testes de conectividade/autenticação contra o Supabase real; o `[REAL-2]` (só roda com `RIO_X7_TEST_ACCESS_TOKEN`, um token real de um usuário de **teste** — opcional); e o `[SRV-SEC-24b]` (symlink, que o Windows sem privilégio não permite). Qualquer **falha** é um problema real, nunca esperado.

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
| `RIO_X7_CRM_PATH` | Não (padrão `data/crm.json`) | Caminho do arquivo do CRM (adapter local de desenvolvimento) |
| `RIO_X7_TEST_ACCESS_TOKEN` | Não | Só para o teste `[REAL-2]` (opcional); nunca um usuário real |

`SUPABASE_SERVICE_ROLE_KEY` **nunca** é uma variável deste projeto — nenhum código a lê, em nenhuma hipótese. Se ela existir no seu ambiente por outro motivo, não a copie para o `.env` deste projeto.

## Supabase

- **Qual projeto é usado:** o já criado por Breno no plano FREE do Supabase — o mesmo desde a decisão [0011](../decisions/0011-supabase-auth-integration.md). Este documento não repete nem indica a URL/projeto; ela vive só no `.env` local de quem já tem acesso.
- **Onde encontrar a configuração:** painel do Supabase (`app.supabase.com`) → o projeto da Rio X7 → **Project Settings → API** → `Project URL` (vira `SUPABASE_URL`) e `anon public` key (vira `SUPABASE_ANON_KEY`). A `service_role` key aparece na mesma tela — **nunca copie essa para nada deste projeto**.
- **O que precisa ser recriado manualmente no computador novo:** só o `.env` (os dois valores acima) e o `data/users.json`. O projeto Supabase em si é o mesmo, na nuvem — nada precisa ser recriado nele.
- **Onde achar o `authUserId` de cada pessoa:** painel do Supabase → **Authentication → Users** → coluna **User UID**.
- **Como verificar conectividade:** o `preflight` (passo 11) faz uma checagem real, só leitura, sem autenticar ninguém.

## Dados locais ignorados pelo Git

Nenhum destes é (ou deve ser) versionado — o `.gitignore` já cobre todos (`.env` e `data/*.json`).

| Arquivo | Obrigatório? | Pode ser recriado do zero? | Contém dado sensível/pessoal? |
|---|---|---|---|
| `.env` | Sim | Sim — copie `.env.example` e preencha (ver seção Supabase) | Sim (chave pública, mas mesmo assim nunca versionada) |
| `data/users.json` | Sim (para o Dashboard subir) | **Não sozinho** — precisa do `authUserId` real de cada pessoa (Supabase Auth → Users → User UID). Formato no passo 8 e em `.env.example` | Sim — nome e e-mail reais de Breno/Rafael |
| `data/approval-queue.json` | Não | Sim — ausente = fila vazia, um estado válido | Se existir com dado real: sim (prospects reais) |
| `data/approval-queue.dev.json` / `data/approval-queue.manual-validation.json` | Não | Sim — só dados fictícios (`scripts/seed-dev-queue.js` recria) | Não (só `example.test`) |
| `data/crm.json` | Não | Sim — ausente = CRM vazio, um estado válido (o arquivo é criado no primeiro registro) | Se existir com dado real: sim (prospects reais — o mesmo cuidado de `data/approval-queue.json`) |

**Se `data/approval-queue.json` ou `data/crm.json` tiverem prospects reais neste computador e você quiser continuar com eles no computador novo:** **NÃO** copie o(s) arquivo(s) para o GitHub, nem para nenhum repositório público. Transfira por um canal que só você controla — um pen drive, um compartilhamento seguro de arquivo do seu gerenciador de senhas, ou um upload privado numa nuvem pessoal que só você acessa — e apague a cópia temporária depois. Este documento não faz essa transferência por você. (Dados de teste não precisam ser transportados.)

## Validar o Dashboard (login real)

A etapa CRM-DASHBOARD foi conferida só com um serviço de autenticação **falso** — nenhuma credencial real foi usada nela. Esta conferência é de quem tem as contas:

- como `ADMIN` (Breno): entrar; a Visão Geral abre; o menu tem Visão Geral, CRM, Aprovações e Sair; no CRM, criar um registro, achá-lo na busca e nos filtros, abrir a ficha, editar um campo, mudar o status e, num registro de teste, usar "Marcar como Não contatar" (deve mostrar o aviso de ação terminal e exigir a caixa de confirmação); a fila de Aprovações continua abrindo;
- como `COMMERCIAL_CLOSER` (Rafael): entrar; ver a lista, buscar, filtrar e abrir a ficha; **nenhum** botão de criar, editar, mudar status ou "Não contatar" (e `#/crm/novo` deve dizer que a conta não pode criar);
- "Sair" volta ao login, e abrir `#/crm` sem sessão mostra só o login.

Os registros criados ficam em `data/crm.json` (local, fora do Git).

## Problemas comuns

- **O servidor não sobe e diz o que falta:** falta o `.env`, o `data/users.json` ou o `npm ci` (o SDK do Supabase para o navegador vem do `node_modules`). Rode o preflight — ele lista exatamente o quê.
- **`EADDRINUSE` / porta ocupada:** outra cópia do servidor já está rodando; use outra `PORT` no `.env` ou pare a outra.
- **Preflight com falhas num computador recém-clonado:** é o esperado até criar `.env` e `data/users.json` (ver a tabela "Resultado esperado").
- **Login recusado no painel:** confira que a conta existe no Supabase Auth e que o `authUserId` do `data/users.json` é o User UID dessa conta, com `status` `ACTIVE`.

## Acesso remoto / continuidade

Nenhuma integração de acesso remoto foi criada ou é necessária além do próprio GitHub — o repositório é a única fonte compartilhada entre computadores. O Dashboard não deve ser exposto além de `127.0.0.1` sem um proxy HTTPS deliberado na frente (não configurado, não recomendado nesta etapa). Nenhum túnel público, porta aberta ou "porta dos fundos" para o Claude foi criado.

## Regra operacional temporária: um servidor por pasta de dados

A fila e o CRM são arquivos JSON sem trava entre processos ([0016](../decisions/0016-crm-integration.md), seção de auditoria da concorrência): dois processos gravando os mesmos `data/*.json` ao mesmo tempo podem se sobrescrever. Por isso, **um servidor por pasta de dados** (nunca dois processos gravando os mesmos `data/*.json`): não suba dois servidores sobre a mesma pasta, não rode scripts que gravem na fila ou no CRM reais com o servidor no ar e não sincronize `data/` entre computadores em uso simultâneo. Cada computador tem os seus próprios dados (não compartilhados).

## Rota de ingestão de prospecção (nota operacional)

`POST /api/prospecting/submit` ([0017](../decisions/0017-prospecting-ingestion-route.md)) só existe depois de **reiniciar o servidor** (`npm start`) com este código. Ela usa os mesmos `data/approval-queue.json` e `data/crm.json` do servidor e grava os lotes em `data/prospecting-batches.json` (criado na primeira submissão, fora do Git, como os demais `data/*.json`). Continua valendo a regra "um servidor por pasta de dados". Não há interface: quem chama é um cliente autenticado (ADMIN).

## Dossiês de prospecção (nota operacional)

O Prospecting Dossier ([0018](../decisions/0018-prospecting-dossier-signals.md)) é só um módulo e um adapter de arquivo por enquanto: **nada no servidor o usa ainda**. Quando for integrado, os dossiês ficam em `data/prospecting-dossiers.json` (fora do Git, como os demais `data/*.json`; não é criado até o primeiro `save`), com a mesma regra "um servidor por pasta de dados".

## Próxima etapa

**Ainda não definida:** o proprietário decide depois de revisar a promoção Approval Queue → CRM pelo Dashboard ([0016](../decisions/0016-crm-integration.md)): o ADMIN promove um prospect aprovado pela tela Aprovações; o closer aprova, mas não promove. Nenhuma etapa começa sem autorização explícita. O estado completo e as decisões pendentes estão no [CONTINUE-HERE.md](./CONTINUE-HERE.md) e no [CHANGELOG.md](../../CHANGELOG.md).
