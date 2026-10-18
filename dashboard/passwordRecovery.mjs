// Dashboard Rio X7 AI Agency OS — "Esqueci minha senha?" e a redefinição pelo link do e-mail.
//
// NÃO é um segundo sistema de autenticação: tudo passa pelo MESMO cliente do SDK do Supabase que o login usa (resetPasswordForEmail,
// setSession, verifyOtp, updateUser). Aqui só ficam as telas, a leitura do endereço que o e-mail traz e as regras da nova senha.
//
// COMO O LINK DO E-MAIL CHEGA: o Supabase confere o token e redireciona o navegador para a URL autorizada (Site URL / Redirect URLs) com o resultado
// no ENDEREÇO — no fluxo "implicit" (o do projeto) em #access_token=…&refresh_token=…&type=recovery; um link vencido ou já usado chega em
// #error=access_denied&error_code=otp_expired&…; um modelo de e-mail com token_hash chega em ?token_hash=…&type=recovery.
// O painel é roteado por # (router.mjs) e o SDK é criado com detectSessionInUrl: false, então ninguém lia esse endereço: o link caía no login.
// Agora `parseAuthRedirect` lê o endereço ANTES de qualquer tela, `handleRedirect` tira os parâmetros sensíveis da URL NA HORA (antes de qualquer espera) e cria a
// sessão de recuperação; o estado fica reconhecível em #/redefinir-senha ("Definir nova senha"). Um SIGNED_IN comum não o descarta: o painel só entra no
// dashboard por showDashboard, que a tela de nova senha nunca chama antes de o servidor confirmar a troca.
//
// SEGURANÇA: o token e a senha só existem em variáveis locais, passam direto ao SDK e nunca vão para o DOM, para o console, para mensagens de erro
// nem para o endereço. A resposta ao pedido de recuperação é a mesma exista o e-mail ou não (o Supabase também não revela). A senha antiga não é pedida;
// nada é gravado no banco por aqui. A autorização continua sendo do servidor (o token vai a /api/*): esta tela não decide nada.

import { h } from './dom.mjs';

export const RESET_HASH = '#/redefinir-senha';
// Um novo pedido só é aceito depois deste intervalo (contado na página; o Supabase tem o seu próprio limite).
export const RECOVERY_COOLDOWN_MS = 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

export const RECOVERY_TEXT = Object.freeze({
  forgotLink: 'Esqueci minha senha?',
  forgotTitle: 'Recuperar acesso',
  forgotHint: 'Informe o e-mail da sua conta. Se ele estiver cadastrado, enviaremos um link para você criar uma nova senha.',
  emailLabel: 'E-mail',
  send: 'Enviar link de recuperação',
  sending: 'Enviando…',
  back: 'Voltar ao login',
  sentTitle: 'Verifique seu e-mail',
  sentText: 'Se existir uma conta com esse e-mail, enviamos um link para criar uma nova senha. Abra a mensagem neste computador e clique no link: ele vale por pouco tempo e só pode ser usado uma vez. Não chegou? Confira a caixa de spam e, passado cerca de um minuto, peça outro link.',
  sendAgain: 'Pedir outro link',
  emailRequired: 'Informe o e-mail da sua conta.',
  emailInvalid: 'Informe um e-mail válido.',
  wait: 'Já enviamos um link há instantes. Aguarde cerca de um minuto antes de pedir outro.',
  tooMany: 'Muitos pedidos em pouco tempo. Aguarde alguns minutos e tente novamente.',
  sendFailed: 'Não foi possível enviar agora. Tente novamente em instantes.',
  linkInvalid: 'Este link de recuperação expirou, é inválido ou já foi usado. Peça um novo link abaixo.',
  newTitle: 'Definir nova senha',
  newHint: `Escolha uma senha com pelo menos ${MIN_PASSWORD_LENGTH} caracteres, com letras e números.`,
  newPassword: 'Nova senha',
  confirmPassword: 'Confirmar nova senha',
  save: 'Definir nova senha',
  saving: 'Salvando…',
  tooShort: `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
  needLetterAndDigit: 'A senha precisa ter letras e números.',
  mismatch: 'A confirmação não é igual à nova senha.',
  required: 'Informe a nova senha e a confirmação.',
  samePassword: 'A nova senha precisa ser diferente da senha atual.',
  weakPassword: 'Esta senha foi considerada fraca. Escolha outra, mais longa e menos previsível.',
  saveFailed: 'Não foi possível salvar a nova senha agora. Tente novamente em instantes.',
  doneTitle: 'Senha alterada com sucesso',
  doneText: 'Entre com a sua nova senha.',
});

const hasLetter = (text) => /\p{L}/u.test(text);
const hasDigit = (text) => /\p{N}/u.test(text);

// A regra da nova senha (a mesma tela e os mesmos testes). Devolve o texto do problema, ou null quando está tudo certo. A senha nunca é cortada nem alterada.
export function validateNewPassword(password, confirmation) {
  if (typeof password !== 'string' || password === '' || typeof confirmation !== 'string' || confirmation === '') return RECOVERY_TEXT.required;
  if (password.length < MIN_PASSWORD_LENGTH) return RECOVERY_TEXT.tooShort;
  if (!hasLetter(password) || !hasDigit(password)) return RECOVERY_TEXT.needLetterAndDigit;
  if (password !== confirmation) return RECOVERY_TEXT.mismatch;
  return null;
}

const paramsOf = (text) => {
  try {
    return new URLSearchParams(String(text || '').replace(/^[#?]/, ''));
  } catch {
    return new URLSearchParams('');
  }
};

// Lê o que o e-mail trouxe no endereço. NÃO altera nada. Devolve:
//   { kind: 'none' }                                 nada de autenticação (o caso de sempre: #/crm, vazio…)
//   { kind: 'error' }                                o Supabase recusou o link (vencido, já usado, inválido)
//   { kind: 'tokens', accessToken, refreshToken }    #access_token&refresh_token&type=recovery (fluxo implicit)
//   { kind: 'tokenHash', tokenHash }                 ?token_hash&type=recovery (modelo de e-mail com token_hash)
//   { kind: 'code', code }                           ?code= (fluxo PKCE)
// Só o tipo "recovery" é tratado: um link de outro tipo (cadastro, convite…) segue ignorado, como sempre foi.
export function parseAuthRedirect({ hash = '', search = '' } = {}) {
  const hashParams = typeof hash === 'string' && hash.startsWith('#') && !hash.startsWith('#/') ? paramsOf(hash) : new URLSearchParams('');
  const queryParams = paramsOf(search);
  const pick = (name) => hashParams.get(name) || queryParams.get(name) || '';
  if (pick('error') || pick('error_code') || pick('error_description')) return { kind: 'error' };
  const type = pick('type');
  const accessToken = hashParams.get('access_token') || '';
  if (accessToken !== '') {
    if (type !== 'recovery') return { kind: 'none' };
    return { kind: 'tokens', accessToken, refreshToken: hashParams.get('refresh_token') || '' };
  }
  const tokenHash = queryParams.get('token_hash') || '';
  if (tokenHash !== '' && type === 'recovery') return { kind: 'tokenHash', tokenHash };
  const code = queryParams.get('code') || '';
  if (code !== '') return { kind: 'code', code };
  return { kind: 'none' };
}

// O erro do SDK é uma sessão que não vale mais (o link venceu ou a sessão acabou)? Nunca lê a mensagem em inglês: só o nome, o status e o código.
function sessionIsGone(error) {
  if (!error || typeof error !== 'object') return false;
  const code = String(error.code || '');
  return error.name === 'AuthSessionMissingError' || error.status === 401 || error.status === 403 || ['session_not_found', 'session_expired', 'bad_jwt', 'no_authorization', 'refresh_token_not_found', 'refresh_token_already_used', 'otp_expired'].includes(code);
}

const isEmail = (text) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

// document, mount(...nós): desenha a tela inteira. client: o cliente do SDK do login. navigation: { current(), url(), scrub(hash) }.
// enter(): chamado ao abrir QUALQUER tela de autenticação (para o painel parar e o SIGNED_OUT não reconstruir o login por cima). showLogin(aviso): volta ao login.
// clock(): Date.now (injetável nos testes).
export function createPasswordRecovery({ document, mount, client, navigation, enter, showLogin, clock = () => Date.now() }) {
  let lastRequestAt = null; // quando o último link foi pedido COM SUCESSO (o intervalo mínimo vale para qualquer e-mail)
  let newPasswordVisible = false;

  function screen(title, hint, ...parts) {
    enter();
    newPasswordVisible = false;
    return h(
      document,
      'main',
      { className: 'centered' },
      h(
        document,
        'div',
        { className: 'login recovery' },
        h(document, 'div', { className: 'brand-block on-light' }, h(document, 'h1', { className: 'brand-name', text: 'RIO X7' }), h(document, 'span', { className: 'brand-sub', text: 'AI AGENCY OS' })),
        h(document, 'h2', { className: 'login-title', text: title }),
        hint ? h(document, 'p', { className: 'login-hint', text: hint }) : null,
        ...parts
      )
    );
  }

  const backButton = () => h(document, 'button', { type: 'button', className: 'link-button login-back', text: RECOVERY_TEXT.back, onclick: () => showLogin() });

  // "Recuperar acesso": pede o e-mail e envia o link. `notice` é um aviso que já vem pronto (ex.: o link venceu).
  function showForgot({ email: initialEmail = '', notice = '' } = {}) {
    const email = h(document, 'input', { id: 'recovery-email', type: 'email', autocomplete: 'username', required: 'required', inputmode: 'email' });
    if (initialEmail) email.value = initialEmail;
    const feedback = h(document, 'p', { className: notice ? 'message info' : 'message', role: 'status', text: notice });
    const submit = h(document, 'button', { type: 'submit', className: 'btn primary', text: RECOVERY_TEXT.send });
    let sending = false;

    async function onSubmit(event) {
      event.preventDefault();
      if (sending) return;
      const typed = email.value.trim();
      const say = (kind, text) => {
        feedback.className = `message ${kind}`;
        feedback.textContent = text;
      };
      if (typed === '') return say('error', RECOVERY_TEXT.emailRequired);
      if (!isEmail(typed)) return say('error', RECOVERY_TEXT.emailInvalid);
      if (lastRequestAt !== null && clock() - lastRequestAt < RECOVERY_COOLDOWN_MS) return say('info', RECOVERY_TEXT.wait);
      sending = true;
      submit.disabled = true;
      submit.textContent = RECOVERY_TEXT.sending;
      say('', '');
      try {
        const url = navigation && typeof navigation.url === 'function' ? navigation.url() : null;
        // A volta é sempre a raiz do painel (sem # e sem ?): é o endereço que o Supabase anexa o resultado. Sem a origem, vale a Site URL do projeto.
        const options = url && typeof url.origin === 'string' && url.origin !== '' ? { redirectTo: `${url.origin}${url.pathname || '/'}` } : undefined;
        const { error } = await client.auth.resetPasswordForEmail(typed, options);
        if (error) throw error;
        lastRequestAt = clock();
        showSent(typed);
      } catch (error) {
        sending = false;
        submit.disabled = false;
        submit.textContent = RECOVERY_TEXT.send;
        say('error', error && (error.status === 429 || error.code === 'over_email_send_rate_limit' || error.code === 'over_request_rate_limit') ? RECOVERY_TEXT.tooMany : RECOVERY_TEXT.sendFailed);
      }
    }

    mount(
      screen(
        RECOVERY_TEXT.forgotTitle,
        RECOVERY_TEXT.forgotHint,
        h(document, 'form', { className: 'recovery-form', onsubmit: onSubmit }, h(document, 'div', { className: 'field' }, h(document, 'label', { for: 'recovery-email', text: RECOVERY_TEXT.emailLabel }), email), feedback, submit),
        h(document, 'p', { className: 'login-links' }, backButton())
      )
    );
    email.focus();
  }

  // "Verifique seu e-mail": a MESMA resposta exista o e-mail ou não.
  function showSent(email) {
    mount(
      screen(
        RECOVERY_TEXT.sentTitle,
        RECOVERY_TEXT.sentText,
        h(document, 'p', { className: 'message success', role: 'status', text: RECOVERY_TEXT.sentTitle }),
        h(document, 'div', { className: 'actions' }, h(document, 'button', { type: 'button', className: 'btn primary', text: RECOVERY_TEXT.back, onclick: () => showLogin() }), h(document, 'button', { type: 'button', className: 'btn secondary', text: RECOVERY_TEXT.sendAgain, onclick: () => showForgot({ email }) }))
      )
    );
  }

  // "Definir nova senha": só com uma sessão de recuperação válida; a troca é do SDK (updateUser) e o sucesso só é mostrado depois da resposta real.
  function showNewPassword() {
    if (newPasswordVisible) return;
    const password = h(document, 'input', { id: 'new-password', type: 'password', autocomplete: 'new-password', required: 'required' });
    const confirmation = h(document, 'input', { id: 'confirm-password', type: 'password', autocomplete: 'new-password', required: 'required' });
    const feedback = h(document, 'p', { className: 'message', role: 'status', text: '' });
    const submit = h(document, 'button', { type: 'submit', className: 'btn primary', text: RECOVERY_TEXT.save });
    let saving = false;

    async function onSubmit(event) {
      event.preventDefault();
      if (saving) return;
      const say = (kind, text) => {
        feedback.className = `message ${kind}`;
        feedback.textContent = text;
      };
      const problem = validateNewPassword(password.value, confirmation.value);
      if (problem !== null) return say('error', problem);
      saving = true;
      submit.disabled = true;
      submit.textContent = RECOVERY_TEXT.saving;
      say('', '');
      let outcome;
      try {
        outcome = await client.auth.updateUser({ password: password.value });
      } catch (error) {
        outcome = { data: null, error: error || new Error('updateUser') };
      }
      const failed = Boolean(outcome && outcome.error) || !(outcome && outcome.data && outcome.data.user);
      if (failed) {
        saving = false;
        submit.disabled = false;
        submit.textContent = RECOVERY_TEXT.save;
        const error = outcome ? outcome.error : null;
        if (sessionIsGone(error)) {
          showForgot({ notice: RECOVERY_TEXT.linkInvalid });
          return;
        }
        if (error && error.code === 'same_password') return say('error', RECOVERY_TEXT.samePassword);
        if (error && error.code === 'weak_password') return say('error', RECOVERY_TEXT.weakPassword);
        return say('error', RECOVERY_TEXT.saveFailed);
      }
      password.value = '';
      confirmation.value = '';
      // Confirmado pela API. Encerra a sessão de recuperação NESTE navegador e mostra o sucesso (a pessoa entra com a senha nova).
      try {
        await client.auth.signOut({ scope: 'local' });
      } catch {
        // sem sessão local para limpar: o sucesso já foi confirmado pela API.
      }
      showDone();
    }

    const view = screen(
      RECOVERY_TEXT.newTitle,
      RECOVERY_TEXT.newHint,
      h(document, 'form', { className: 'recovery-form', onsubmit: onSubmit }, h(document, 'div', { className: 'field' }, h(document, 'label', { for: 'new-password', text: RECOVERY_TEXT.newPassword }), password), h(document, 'div', { className: 'field' }, h(document, 'label', { for: 'confirm-password', text: RECOVERY_TEXT.confirmPassword }), confirmation), feedback, submit),
      h(document, 'p', { className: 'login-links' }, backButton())
    );
    mount(view);
    newPasswordVisible = true; // depois de screen(), que zera o marcador
    password.focus();
  }

  function showDone() {
    mount(
      screen(
        RECOVERY_TEXT.doneTitle,
        RECOVERY_TEXT.doneText,
        h(document, 'p', { className: 'message success', role: 'status', text: RECOVERY_TEXT.doneTitle }),
        h(document, 'div', { className: 'actions' }, h(document, 'button', { type: 'button', className: 'btn primary', text: RECOVERY_TEXT.back, onclick: () => showLogin() }))
      )
    );
  }

  // O endereço da abertura: tira os parâmetros sensíveis da URL ANTES de qualquer espera e segue o que o e-mail trouxe. Devolve true quando o endereço era de
  // autenticação (já tratado: o chamador não desenha mais nada); false quando não era e a abertura segue o caminho de sempre.
  async function handleRedirect() {
    const url = navigation && typeof navigation.url === 'function' ? navigation.url() : { hash: navigation.current(), search: '' };
    const redirect = parseAuthRedirect(url);
    if (redirect.kind === 'none') return false;
    const recovered = redirect.kind === 'tokens' || redirect.kind === 'tokenHash' || redirect.kind === 'code';
    // limpa já: o token não fica na barra de endereços nem no histórico, nem se o resto falhar
    if (typeof navigation.scrub === 'function') navigation.scrub(recovered ? RESET_HASH : '');
    const invalid = () => showForgot({ notice: RECOVERY_TEXT.linkInvalid });
    if (!recovered) {
      invalid();
      return true;
    }
    try {
      let result;
      if (redirect.kind === 'tokens') {
        if (redirect.refreshToken === '') {
          invalid();
          return true;
        }
        result = await client.auth.setSession({ access_token: redirect.accessToken, refresh_token: redirect.refreshToken });
      } else if (redirect.kind === 'tokenHash') {
        result = await client.auth.verifyOtp({ token_hash: redirect.tokenHash, type: 'recovery' });
      } else {
        result = await client.auth.exchangeCodeForSession(redirect.code);
      }
      if (!result || result.error || !result.data || !result.data.session) {
        invalid();
        return true;
      }
    } catch {
      invalid();
      return true;
    }
    showNewPassword();
    return true;
  }

  return { showForgot, showNewPassword, showDone, handleRedirect };
}
