// Dashboard Rio X7 AI Agency OS — inicialização, login e estrutura da página.
//
// O navegador faz três coisas com o SDK do Supabase (o bundle local, /lib/supabase.js — nenhum CDN): entrar
// (signInWithPassword), manter e renovar a sessão, e sair. NADA é autorizado aqui: o access token da sessão é
// enviado ao servidor (api.mjs) e é o servidor que verifica o token, resolve o USER e decide o que a pessoa pode
// fazer. O que /api/me devolve (nome, role, permissions) serve só para mostrar a tela certa — nunca é uma decisão.
//
// Este arquivo não importa nada de src/: o navegador só conversa com o servidor por HTTP.

import { h } from './dom.mjs';
import { createApiClient } from './api.mjs';
import { createApprovalsView } from './views/approvals.mjs';

const REVIEW_PERMISSION = 'APPROVE:LEAD_APPROVAL';
const ROLE_LABELS = Object.freeze({ ADMIN: 'Administrador', COMMERCIAL_CLOSER: 'Closer comercial' });
const NO_ACCESS = 'Esta conta não possui acesso a esta área.';

const root = document.getElementById('app');

function mount(...children) {
  root.replaceChildren(...children.filter(Boolean));
}

function showFatal(text) {
  mount(h(document, 'main', { className: 'centered' }, h(document, 'p', { className: 'message error', role: 'alert', text })));
}

async function loadConfig() {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('config');
  const config = await response.json();
  if (typeof config.supabaseUrl !== 'string' || typeof config.supabaseAnonKey !== 'string') throw new Error('config');
  return config;
}

async function boot() {
  let client;
  try {
    const config = await loadConfig();
    const sdk = globalThis.supabase;
    if (!sdk || typeof sdk.createClient !== 'function') throw new Error('sdk');
    client = sdk.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  } catch {
    showFatal('Não foi possível carregar o Dashboard. Recarregue a página.');
    return;
  }

  async function getAccessToken() {
    const { data } = await client.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  }

  async function refreshAccessToken() {
    try {
      const { data, error } = await client.auth.refreshSession();
      return !error && data && data.session ? data.session.access_token : null;
    } catch {
      return null;
    }
  }

  // A sessão acabou (o servidor recusou o token mesmo depois de renovar): limpa a sessão local e volta ao login.
  async function sessionLost() {
    try {
      await client.auth.signOut({ scope: 'local' });
    } catch {
      // sem sessão para limpar: segue para o login do mesmo jeito.
    }
    showLogin('Sua sessão expirou. Entre novamente.');
  }

  const api = createApiClient({ getAccessToken, refreshAccessToken, onSessionLost: sessionLost });

  async function logout() {
    try {
      await client.auth.signOut();
    } catch {
      // segue para o login mesmo se o servidor de autenticação não respondeu.
    }
    showLogin();
  }

  function showLogin(notice) {
    const email = h(document, 'input', { id: 'login-email', type: 'email', autocomplete: 'username', required: 'required' });
    const password = h(document, 'input', { id: 'login-password', type: 'password', autocomplete: 'current-password', required: 'required' });
    const feedback = h(document, 'p', { className: notice ? 'message info' : 'message', role: 'status', text: notice || '' });
    const submit = h(document, 'button', { type: 'submit', className: 'btn primary', text: 'Entrar' });

    async function onSubmit(event) {
      event.preventDefault();
      const typedEmail = email.value.trim();
      const typedPassword = password.value;
      if (typedEmail === '' || typedPassword === '') {
        feedback.className = 'message error';
        feedback.textContent = 'Informe e-mail e senha.';
        return;
      }
      submit.disabled = true;
      feedback.className = 'message';
      feedback.textContent = '';
      try {
        const { error } = await client.auth.signInWithPassword({ email: typedEmail, password: typedPassword });
        if (error) throw error;
        password.value = '';
        await showDashboard();
      } catch {
        submit.disabled = false;
        feedback.className = 'message error';
        feedback.textContent = 'Não foi possível entrar. Confira o e-mail e a senha e tente novamente.';
      }
    }

    mount(
      h(
        document,
        'main',
        { className: 'centered' },
        h(
          document,
          'form',
          { className: 'login', onsubmit: onSubmit },
          h(document, 'h1', { text: 'Rio X7 AI Agency OS' }),
          h(document, 'p', { className: 'muted', text: 'Entre com a sua conta para acessar o painel.' }),
          h(document, 'div', { className: 'field' }, h(document, 'label', { for: 'login-email', text: 'E-mail' }), email),
          h(document, 'div', { className: 'field' }, h(document, 'label', { for: 'login-password', text: 'Senha' }), password),
          feedback,
          submit
        )
      )
    );
    email.focus();
  }

  function shell(me, main) {
    const role = ROLE_LABELS[me && me.role] || (me && typeof me.role === 'string' ? me.role : '');
    return h(
      document,
      'div',
      { className: 'shell' },
      h(
        document,
        'header',
        { className: 'topbar' },
        h(document, 'span', { className: 'brand', text: 'Rio X7 AI Agency OS' }),
        h(
          document,
          'div',
          { className: 'who' },
          me ? h(document, 'span', { className: 'who-name', text: typeof me.name === 'string' ? me.name : '' }) : null,
          role ? h(document, 'span', { className: 'badge neutral', text: role }) : null,
          h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Sair', onclick: logout })
        )
      ),
      main
    );
  }

  async function showDashboard() {
    mount(shell(null, h(document, 'main', { className: 'content' }, h(document, 'p', { className: 'muted', text: 'Carregando…' }))));
    let me;
    try {
      me = await api.me();
    } catch (error) {
      if (error && error.status === 401) return; // o cliente de API já levou ao login
      const message = error && error.status === 403 ? NO_ACCESS : 'Não foi possível carregar o painel agora. Tente novamente em instantes.';
      mount(shell(null, h(document, 'main', { className: 'content' }, h(document, 'p', { className: 'message error', role: 'alert', text: message }))));
      return;
    }
    const main = h(document, 'main', { className: 'content' });
    mount(shell(me, main));
    const permissions = Array.isArray(me.permissions) ? me.permissions : [];
    const view = createApprovalsView({ document, root: main, api, canReview: permissions.includes(REVIEW_PERMISSION) });
    await view.load();
  }

  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') showLogin();
  });

  const { data } = await client.auth.getSession();
  if (data && data.session) await showDashboard();
  else showLogin();
}

boot();
