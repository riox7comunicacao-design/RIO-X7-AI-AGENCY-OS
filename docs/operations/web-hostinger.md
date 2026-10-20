# Rio X7 AI Agency OS online — CRM na Hostinger (Fase WEB 1)

Guia operacional da **instância hospedada "CRM-only"** (decisão [0033](../decisions/0033-crm-only-hosted-deployment.md)). Este documento descreve o que configurar; **nada aqui foi executado**: nenhum deploy, nenhuma hospedagem contratada, nenhuma alteração no Supabase. O sistema **local** (completo, com prospecção e Fila de Aprovação) continua como sempre e não é afetado.

> **Estado honesto.** O código está pronto e testado com Supabase simulado. O que depende da plataforma real (porta, HTTPS, cabeçalhos do proxy, tamanho das variáveis, reinício por ociosidade) está marcado **[NÃO CONFIRMADO]** e se resolve no **teste de homologação** (seção 9), num subdomínio, antes de apontar o domínio principal.

## 1. O que a instância online faz — e o que não faz

| Funciona | Fica DESATIVADO no servidor (404 `MODULE_DISABLED`) |
|---|---|
| Login (Supabase Auth) e recuperação de senha, RBAC (ADMIN / COMMERCIAL_CLOSER) | Fila de Aprovação e promoção (`/api/approvals*`) |
| Clientes PF/PJ | Prospecção: submissão, lotes, briefs, jobs, exclusões permanentes (`/api/prospecting*`) |
| Serviços, Nichos, Origens (catálogos) | Leads reprovados, reaprovação e enriquecimento (`/api/leads*`) |
| Funis, etapas e cards; Negociações; Dashboard Comercial | |

A prospecção e a Fila **continuam no computador local**, com os arquivos de `data/` exatamente onde estão. Nada foi migrado, copiado ou apagado.

## 2. Configuração exata no hPanel

Caminho (documentação da Hostinger): **Websites → Add Website → Node.js Apps → Import Git repository** (instalar o *Hostinger GitHub App* e autorizar só este repositório; uma hospedagem liga a **uma** conta GitHub).

| Campo | Valor |
|---|---|
| Repositório / branch | `RIO-X7-AI-AGENCY-OS` / ver a recomendação abaixo |
| Framework preset | **Other** (aplicativo próprio) |
| Node.js | **22** (o `package.json` declara `engines.node: ">=22.0.0"`; escolha 22 explicitamente) |
| Gerenciador de pacotes | npm (detectado pelo `package-lock.json`; a instalação é `npm ci`/`npm install`) |
| Build script | **vazio** — o projeto não tem etapa de build |
| Output directory | ignorado com "Other" quando há arquivo de entrada |
| **Arquivo de entrada (entry file)** | **`server.js`** (na raiz do repositório) |
| Start command | não existe campo: a Hostinger executa o arquivo de entrada |

**Recomendação de branch.** A Hostinger publica a cada *push* no branch conectado. Conecte um branch dedicado (por exemplo `hospedagem`) e só leve commits para ele quando quiser publicar; assim o trabalho diário em `main` não republica o site sozinho.

**Limites da plataforma que importam** (documentação oficial): dependências e build têm 15 minutos cada; um deploy por vez por site; os últimos 10 logs de build ficam guardados; `hbuilds/` e `public_html` são **sobrescritos a cada deploy** (por isso a instância não grava nada em disco); o processo é **parado por ociosidade** e reiniciado na próxima requisição; falha do processo reinicia sozinha.

## 3. Variáveis de ambiente (somente os NOMES — os valores ficam só no painel)

Painel: **Environment variables** do site (adicionar uma a uma, ou *Import .env*). Salvar **faz um novo deploy**. Chaves: letras maiúsculas, números e `_`; até 255 caracteres; até 1.000 variáveis. As variáveis valem no build e na execução, persistem entre deploys e ficam criptografadas.

| Variável | Obrigatória | Para quê |
|---|---|---|
| `RIO_X7_DEPLOYMENT_MODE` | sim | `crm-only` |
| `REPOSITORY_MODE` | sim | `supabase` |
| `SUPABASE_URL` | sim | URL do projeto Supabase (o mesmo projeto de produção) |
| `SUPABASE_ANON_KEY` | sim | chave pública (anon) |
| `SUPABASE_SERVICE_ROLE_KEY` | sim | chave de serviço — **só aqui**, nunca no navegador, no Git, em log ou em chat |
| `RIO_X7_PUBLIC_URL` | sim | origem https do site, sem caminho (`https://crm.seudominio.com.br`) |
| `RIO_X7_USERS_JSON` | sim | os usuários da aplicação (seção 4) |
| `HOST` | se preciso | `0.0.0.0` se o site não responder com o padrão `127.0.0.1` **[NÃO CONFIRMADO]** |
| `PORT` | se preciso | a plataforma pode fornecer; sem ela vale 3000 **[NÃO CONFIRMADO]** |
| `RIO_X7_TRUST_PROXY` | opcional | `1` depois da homologação (seção 7) |

Não defina `RIO_X7_USERS_FILE`, `RIO_X7_QUEUE_PATH` nem os caminhos de arquivos de prospecção: não têm uso aqui.

**Tamanho.** A Hostinger só diz que valores "extremamente longos" são recusados (o limite não é publicado). Referência: cada usuário em JSON ocupa ~230–300 caracteres (~1,35× em base64); cinco usuários ficam em torno de 2 KB. Se o painel truncar o valor, a subida **falha** com `RIO_X7_USERS_JSON inválida` — nunca sobe com uma lista cortada.

## 4. Os usuários (sem criar ninguém novo)

A instância usa **os mesmos usuários** do `data/users.json` local (mesmos `userId`, `authUserId`, papéis e status) — **não** se cria um segundo administrador nem conta alguma. Quem tem o arquivo, no computador local:

```powershell
node scripts/export-users-env.js
```

O script valida o arquivo pelas mesmas regras do servidor e imprime **só uma linha** (o valor em base64) para colar na variável `RIO_X7_USERS_JSON` no painel. O valor contém e-mails e identificadores: trate como dado pessoal — **nunca** em Git, chat, log ou relatório. Mudou alguém no arquivo local? Gere de novo e atualize a variável (isso redeploya).

## 5. Domínio, HTTPS e Supabase Auth

1. **Domínio.** Adicione o domínio (recomendado: um **subdomínio**, `crm.seudominio.com.br`) ao app Node no hPanel e ative o **SSL** do domínio. Ligue a opção de forçar HTTPS se o hPanel a oferecer para este tipo de app **[NÃO CONFIRMADO]**. O app ainda emite **HSTS** (1 ano, sem `includeSubDomains`) e redireciona leituras recebidas por HTTP (se o proxy enviar `X-Forwarded-Proto`).
2. **Site URL e Redirect URLs** (Supabase → Authentication → URL Configuration). O projeto é **um só** para o uso local e o online; o painel pede a recuperação de senha com `redirectTo` = a origem de onde se pediu (`https://crm.../` ou `http://localhost:3000/`), então as duas precisam estar na lista:
   - **Site URL:** `https://crm.seudominio.com.br` (é o destino de reserva quando nenhum `redirectTo` vale; o padrão do Supabase é localhost);
   - **Redirect URLs:** `https://crm.seudominio.com.br/` (use a URL **exata** de produção, como o Supabase recomenda) e `http://localhost:3000/**` (uso local; o curinga é aceitável só para local).
3. **Cadastro aberto.** Em Authentication → Providers → Email, desligue "Allow new users to sign up" se estiver ligado: as contas são criadas por você. (Mesmo ligado, uma conta que não está em `RIO_X7_USERS_JSON` recebe 403 em toda rota; desligar só evita ruído.)
4. **Limites de login.** O login é direto do navegador ao Supabase Auth (o servidor nunca vê a senha). Revise Authentication → **Rate Limits** e, se quiser mais, **CAPTCHA** em Attack Protection. O CAPTCHA exige mudar a CSP e a tela de login: **não está implementado** (melhoria futura).

## 6. SMTP da recuperação de senha

Sem SMTP próprio o Supabase **recusa enviar para endereços fora da equipe do projeto** e o provedor embutido envia **no máximo 2 e-mails por hora** (documentação do Supabase; pode mudar sem aviso). A recuperação de senha online **depende de um SMTP próprio**:

1. Crie uma caixa de envio (por exemplo `nao-responder@seudominio.com.br`, no e-mail da Hostinger ou outro serviço de envio).
2. Supabase → Authentication → **SMTP Settings** (Custom SMTP): host, porta, usuário e senha **da caixa de envio** — a senha vai só no painel do Supabase, nunca em arquivo ou chat. Remetente = o endereço da caixa.
3. Desative o **rastreamento de links** no provedor (ele deforma o link de recuperação).
4. Authentication → Rate Limits: o limite de e-mails com SMTP próprio é configurável (padrão baixo: ajuste ao uso real).
5. Teste com o **seu** e-mail (seção 9). Nunca teste com conta de outra pessoa.

## 7. Segurança: o que o app faz e o que é da plataforma

| Item | Onde é feito |
|---|---|
| Autenticação e RBAC em todas as rotas `/api` (exceto `/healthz` e estáticos) | app (testado em `hosted-crm-only.test.js`) |
| Módulos de arquivo desativados no servidor (404 `MODULE_DISABLED`, antes da autenticação) | app |
| CSP estrita, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `COOP/CORP`, `Permissions-Policy` | app |
| **HSTS** `max-age=31536000` (sem `includeSubDomains`, sem `preload`) | app, só na instância hospedada |
| **CORS:** nenhum cabeçalho `Access-Control-*` (só a própria origem lê as respostas) | app |
| HTTP → HTTPS: redireciona leitura / recusa escrita (via `X-Forwarded-Proto`) para `RIO_X7_PUBLIC_URL` | app + plataforma **[NÃO CONFIRMADO: o proxy enviar o cabeçalho]** |
| Certificado SSL e forçar HTTPS | plataforma (hPanel) |
| Tentativas de **senha** (login, recuperação) | Supabase Auth (Rate Limits) |
| Tentativas abusivas na **API** (sessão ausente/inválida): 30 em 10 min bloqueiam o cliente por 10 min (429) | app (em memória; reinício por ociosidade zera) |
| Erros com mensagem fixa (sem token, chave, URL ou stack); log só com método, rota, status e `userId` | app |
| `service_role` só no servidor (`/config.json` entrega só URL, chave anon e o modo) | app |
| Recuperação de senha com o domínio público | painel (`redirectTo` = origem do site) + Supabase (lista de redirects) |

**`RIO_X7_TRUST_PROXY`.** Atrás de um proxy, todos os clientes aparecem com o mesmo endereço, e o limitador daria a mesma chave a todos (um abusador bloquearia todos por 10 minutos). Depois do teste de homologação, se o proxy acrescentar o endereço real em `X-Forwarded-For`, defina `RIO_X7_TRUST_PROXY=1` (o app usa o **último** endereço da lista, o que o proxy acrescentou; um valor forjado pelo cliente vem antes e é ignorado).

## 8. Inventário: o que o servidor lê e grava (e por que a instância online não usa disco)

| Arquivo / local | Quem usa | Crítico ou regenerável | Na instância `crm-only` |
|---|---|---|---|
| `data/users.json` (`RIO_X7_USERS_FILE`) | usuários, lido só na subida | **crítico** (identidade/RBAC; só o proprietário o recria) | **não lido**; vem de `RIO_X7_USERS_JSON` |
| `data/approval-queue.json` (`RIO_X7_QUEUE_PATH`) | Fila de Aprovação, promoção | **crítico** (prospects reais; escrita atômica) | **nunca criado** |
| `data/prospecting-batches.json` | lotes da prospecção | **crítico** | nunca criado |
| `data/prospecting-briefs.json` (`RIO_X7_PROSPECTING_BRIEFS_PATH`) | briefs | **crítico** | nunca criado |
| `data/prospecting-jobs.json` (`RIO_X7_PROSPECTING_JOBS_PATH`) | jobs (a subida marca os interrompidos) | operacional (histórico das execuções) | nunca criado; **não recupera jobs** |
| `data/prospecting-profiles.json` (`RIO_X7_PROSPECTING_PROFILES_PATH`) | perfis comerciais/enriquecimento | **crítico** | nunca criado |
| `data/prospecting-dossiers.json` | dossiês da prospecção | **crítico** | nunca criado |
| `data/crm.json`, `funnels.json`, `negotiations.json`, `crm-catalogs.json` | **só** `REPOSITORY_MODE=file` (desenvolvimento/testes) | regenerável/descartável | **nunca usados** (`REPOSITORY_MODE=supabase` é obrigatório) |
| `data/prospeccao-real-2026-10-06.json`, `data/approval-queue.test-run.json` | nenhum código os usa (artefatos antigos) | histórico | ignorados |
| `backups/crm/*.json` | `scripts/export-crm.js` (manual, local) | cópia de segurança | fora do servidor |
| Diretório temporário do SO (`rio-x7-claude-*`) | execução do `claude -p` (prospecção local) | regenerável | **nunca criado** (sem prospecção) |
| Logs | só `stdout`/`stderr` (nenhum arquivo de log) | — | Runtime Logs da Hostinger |
| Uploads | não existem | — | — |

O inventário foi feito sobre **todas** as chamadas de leitura/escrita de `src/` (nenhum módulo esquecido) e é **provado** por `tests/server/hosted-no-local-files.test.js`: durante a subida (código recarregado do zero) e uma sequência de requisições (CRM, catálogos, funis, negociações, health, estáticos e todas as rotas desativadas), **nenhum acesso a `data/` e nenhuma escrita em disco**.

## 9. Teste de homologação (num subdomínio, antes do domínio principal)

Em ordem; cada passo tem um resultado esperado e confirma um **[NÃO CONFIRMADO]**:

1. Deploy e **Runtime Logs**: a linha `Rio X7 AI Agency OS (CRM — instância hospedada) — Dashboard em http://<host>:<porta> (N usuário(s) carregado(s))`. Confirma a entrada (`server.js`), o `HOST` e a `PORT`. Se aparecer `Não foi possível iniciar o servidor: …`, a mensagem cita a variável (seção 10).
2. `https://crm.../healthz` → `{"status":"ok"}`. Confirma HTTPS/domínio/porta.
3. `http://crm.../` → vai para `https://crm.../` (confirma o `X-Forwarded-Proto` e/ou o redirecionamento da plataforma).
4. Abrir o site, **entrar com a sua conta** (você digita a senha; eu não a vejo): o painel abre sem Prospecção/Fila. A Visão Geral mostra o CRM.
5. No navegador (aba Rede), `/api/approvals` → **404 `MODULE_DISABLED`**; Clientes, Funis, Catálogos e Dashboard Comercial **só leem** nesta etapa (nada fictício é criado em produção).
6. **Recuperar senha** com o **seu** e-mail: o e-mail chega, o link abre `https://crm.../` e a nova senha é definida (confirma SMTP, Site URL e Redirect URLs).
7. Reiniciar pelo painel e repetir 2 e 4: continua igual (nada depende de disco).
8. **Limitador por cliente.** O app não registra endereços em log, então a conferência é por comportamento: de um aparelho, faça ~35 requisições sem sessão (por exemplo, recarregar `https://crm.../api/crm` com o botão de atualizar) até receber `429`; em **outro** aparelho (ou outra rede) o painel deve continuar normal. Se o segundo também for bloqueado, o proxy não diferencia os clientes: mantenha `RIO_X7_TRUST_PROXY=0` e avise antes de abrir ao público. Se o segundo seguir normal com `RIO_X7_TRUST_PROXY=1`, deixe ligado. Espere 10 minutos antes de continuar os testes.
9. Só então apontar o domínio principal.

## 10. Diagnosticar falhas pelos logs

**Runtime Logs** (hPanel → site → Runtime Logs): `stdout`/`stderr` do **último deploy** (até 5.000 linhas; cada deploy começa um buffer novo). **Build logs**: página de cada deploy (últimos 10).

| Sintoma / mensagem | Causa provável |
|---|---|
| Build verde mas o site cai (502/503) | porta ou `HOST` errados (tente `HOST=0.0.0.0`); variável ausente |
| `RIO_X7_DEPLOYMENT_MODE inválido` | valor diferente de `local`/`crm-only` |
| `crm-only exige REPOSITORY_MODE=supabase` | falta `REPOSITORY_MODE=supabase` |
| `SUPABASE_SERVICE_ROLE_KEY …` | falta a chave de serviço |
| `RIO_X7_PUBLIC_URL é obrigatória` / `inválida` | falta, ou tem `http`, caminho, usuário ou consulta |
| `crm-only exige RIO_X7_USERS_JSON` | falta a variável de usuários |
| `RIO_X7_USERS_JSON inválida` | valor cortado/corrompido: gere de novo e cole inteiro |
| `usuário #N de RIO_X7_USERS_JSON: …` | campo ou papel inválido no usuário N |
| `configure só UMA fonte de usuários` | `RIO_X7_USERS_FILE` e `RIO_X7_USERS_JSON` ao mesmo tempo |
| `PORT inválida` | `PORT` não numérica |
| Tela de login ok, mas "Não foi possível entrar" | URL/chave anon do Supabase erradas (ou senha) |
| Tudo `401` depois de entrar | `SUPABASE_URL`/`SUPABASE_ANON_KEY` do app diferentes dos do painel |
| `403` "não possui acesso" | a conta existe no Supabase mas não está em `RIO_X7_USERS_JSON` |
| `429` "Muitas tentativas recusadas" | limitador: aguarde 10 min (ou revise `RIO_X7_TRUST_PROXY`) |
| `404 MODULE_DISABLED` | esperado: módulo desativado |
| `503` no CRM / `erro 5xx em GET /api/crm` | Supabase indisponível ou chave de serviço inválida (a mensagem do log não traz a chave) |
| E-mail de recuperação não chega | SMTP próprio (seção 6), spam, limite de envios |

O log de requisições tem só `MÉTODO rota status user=<id>` — nunca token, senha, e-mail ou corpo.

## 11. Reverter um deploy

A Hostinger **não tem rollback de um clique** (e guarda só o build atual): para voltar, **reverta o código no Git e dê push** no branch conectado (`git revert <commit>` e push), ou republique um arquivo anterior. As **variáveis de ambiente persistem**. Um build que falha **não troca** a versão no ar.

- O deploy **não toca no banco**: reverter o app nunca reverte uma migration. O código novo lê um banco sem a D3 (colunas ausentes valem como contrato de prazo definido); migrations são sempre decisão e ação do proprietário, à parte.
- Se o problema for de **configuração**, corrija a variável (isso redeploya) em vez de reverter código.

## 12. Backup e recuperação

- **Fonte de verdade: o Supabase.** A instância online **não guarda nada**: reconstruir o site = novo deploy + variáveis. Confirme no painel do Supabase o plano e os **backups/PITR** do projeto (o que o plano oferece; eu não consigo verificar daqui).
- **Cópia lógica do CRM:** `node --env-file-if-exists=.env scripts/export-crm.js` (manual, no computador local; política em [crm-data-policy.md](./crm-data-policy.md)). O arquivo gerado tem dados reais: guarde fora do Git e fora de pastas sincronizadas públicas.
- **Dados locais de prospecção/fila** (`data/*.json`): continuam só no computador local — faça cópia periódica deles (pasta `data/` inteira) para um disco/nuvem **privados**. São a única cópia.
- **Segredos:** guarde as variáveis (valores) num gerenciador de senhas. Perdeu as variáveis do painel? Recrie com os valores guardados e gere `RIO_X7_USERS_JSON` de novo com `scripts/export-users-env.js`.
- **Plano de recuperação (site fora do ar):** (1) Runtime Logs → mensagem (seção 10); (2) se foi um deploy, reverter o código (seção 11); (3) se foi configuração, corrigir a variável; (4) se a conta Hostinger estiver indisponível, o CRM continua acessível **localmente** (`npm start`, `REPOSITORY_MODE=supabase`, mesmo Supabase).

## 13. Melhorias para depois (fora desta fase)

CAPTCHA no login; limitador compartilhado entre processos; rotação de chaves por calendário; mover Fila e prospecção para o Supabase (permitiria prospecção online); monitoramento externo de `/healthz`; cabeçalho `Content-Security-Policy-Report-Only` com relatório.
