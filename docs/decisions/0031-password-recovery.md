# 0031 — "Esqueci minha senha?" e a redefinição pelo link do e-mail

**Estado:** implementado. Não há migration, não há mudança de servidor/API e nenhum dado comercial é tocado. Há **uma conferência manual no painel do Supabase** (abaixo).

## Causa raiz
1. A tela de login **não tinha** "Esqueci minha senha?" (o e-mail de recuperação só saía pelo painel do Supabase).
2. O link do e-mail leva o navegador à URL autorizada (hoje `http://localhost:3000`) com o resultado **no endereço**: `#access_token=…&refresh_token=…&type=recovery` (fluxo *implicit*, o do projeto). O painel cria o SDK com `detectSessionInUrl: false` e é roteado por `#` (`router.mjs`), então **ninguém lia esse endereço**: a abertura caía no login, e a sessão de recuperação nunca virava uma tela de "Definir nova senha". Era um defeito do **aplicativo**, não da configuração do Supabase — por isso se repetia.

## Decisão
Tudo dentro do **mesmo** cliente do SDK que o login usa (não é um segundo sistema de autenticação). Código novo: `dashboard/passwordRecovery.mjs`; ligações em `main.mjs` e `router.mjs` (`url()`, `scrub()`).

- **Login:** o botão "Esqueci minha senha?" fica logo abaixo do campo Senha e leva o e-mail já digitado. "Recuperar acesso" pede o e-mail e chama `resetPasswordForEmail(email, { redirectTo })`, onde `redirectTo` é a **raiz do painel** (origem + `/`, sem `#` nem `?`: o Supabase anexa o resultado a essa URL, e um `#` no redirecionamento a quebraria). A resposta é a mesma exista o e-mail ou não ("Verifique seu e-mail"). Um novo pedido só passa depois de **1 minuto** (e um clique em andamento bloqueia o seguinte); o limite do próprio Supabase (429) tem texto próprio.
- **O link:** `parseAuthRedirect` lê o endereço **antes de qualquer tela**: `#access_token…&type=recovery` (implicit), `?token_hash=…&type=recovery` (modelo de e-mail com token_hash, `verifyOtp`), `?code=` (PKCE) e `#error=…`/`?error=…` (link vencido ou já usado). Os parâmetros sensíveis saem da barra de endereços e do histórico **na hora** (antes de qualquer espera), e o estado fica reconhecível em **`#/redefinir-senha`** (atualizar a página ali com sessão continua em "Definir nova senha"; sem sessão, o link já não vale). Só o tipo `recovery` é tratado; links de cadastro/convite seguem ignorados como sempre foram.
- **Eventos:** `PASSWORD_RECOVERY` abre a tela de nova senha (uma vez só, sem refazer o que a pessoa digitou). Um `SIGNED_IN` comum **não** leva ao painel nem descarta o estado: o painel só abre por `showDashboard`, que a tela de nova senha nunca chama. Um `SIGNED_OUT` não troca as telas de recuperação pelo login.
- **Nova senha:** "Nova senha" + "Confirmar nova senha"; mínimo de 8 caracteres, com letras e números, e confirmação igual (a senha nunca é cortada). Troca por `supabase.auth.updateUser({ password })` — **sem pedir a senha antiga**; o sucesso ("Senha alterada com sucesso") só aparece **depois** da resposta real da API (sem erro e com usuário); depois dele a sessão de recuperação é encerrada neste navegador (`signOut({ scope: 'local' })`) e "Voltar ao login" leva ao login. Falhas: senha igual à atual, senha fraca (regra do Supabase), sessão vencida (volta a "Recuperar acesso" com o aviso e a opção de pedir novo link) e erro genérico — nunca a mensagem técnica do SDK.
- **Segurança:** token e senha só existem em variáveis locais e vão direto ao SDK; nada vai ao DOM, ao console, ao `localStorage`, a mensagens nem ao endereço; nenhum SQL, nenhuma senha por SQL, nenhum novo administrador; nada de autorização no navegador (o servidor continua verificando o token em `/api/*`). Os guardas estáticos do Dashboard (`dashboard-static-guards`) passam a vigiar o módulo novo.

## Configuração manual no Supabase (conferir; nada foi alterado remotamente)
**Painel do Supabase → Authentication → URL Configuration:**
- **Site URL:** `http://localhost:3000` (ou o endereço público do painel, quando houver).
- **Redirect URLs** (acrescente se não estiver): `http://localhost:3000/**` (e `https://<dominio-do-painel>/**` quando existir domínio).
O `redirectTo` enviado é exatamente `http://localhost:3000/`; se não estiver na lista, o Supabase usa a Site URL — e funciona do mesmo jeito enquanto ela for essa. **Como testar:** peça o link em "Esqueci minha senha?", abra o e-mail **no mesmo computador** e clique: o endereço deve abrir "Definir nova senha". Um link de outro host (por exemplo, o do Supabase sem o painel) indica que a Site URL está errada.
Observação: alguns leitores de e-mail/antivírus abrem o link antes da pessoa e o **consomem** (o token vale uma vez): nesse caso a pessoa vê "expirou, é inválido ou já foi usado" e pede outro; se acontecer sempre, o modelo de e-mail "Reset Password" pode passar a usar `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=recovery` (já suportado), que só é consumido pelo clique no painel.

## Testes
`tests/server/dashboard-password-recovery.test.js` (RECOV-1 a 25, no DOM de teste com SDK falso; nenhum e-mail enviado) + a bateria de mutantes da recuperação (32 mutantes, todos mortos). Fora do escopo: troca de senha de quem já está logado (não há tela de perfil), bloqueio de conta e MFA.
