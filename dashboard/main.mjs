// Dashboard Rio X7 AI Agency OS — inicialização, login, sessão, navegação e estrutura da página.
//
// Este é o antigo corpo do app.mjs, agora uma função que recebe o que antes eram globais do navegador (document, fetch, o
// SDK do Supabase, a navegação por #). O comportamento do login, da sessão e do logout é o MESMO de antes — só passou a
// poder rodar num DOM de teste. Quem liga tudo ao navegador de verdade é o app.mjs (5 linhas).
//
// O navegador faz três coisas com o SDK do Supabase (o bundle local, /lib/supabase.js — nenhum CDN): entrar
// (signInWithPassword), manter e renovar a sessão, e sair. NADA é autorizado aqui: o access token da sessão é
// enviado ao servidor (api.mjs) e é o servidor que verifica o token, resolve o USER e decide o que a pessoa pode
// fazer. O que /api/me devolve (nome, role, permissions) serve só para mostrar a tela certa — nunca é uma decisão.
//
// PROTEÇÃO DAS ROTAS: sem sessão nenhuma tela do painel existe — qualquer # leva ao login, e nenhuma chamada de API é
// feita. Com sessão, o roteamento (router.mjs) só começa depois de /api/me responder; ao sair (logout, sessão expirada,
// SIGNED_OUT) o roteamento para e as telas descartam os dados carregados (nenhum dado de CRM sobra na página do login).
//
// Este arquivo não importa nada de src/: o navegador só conversa com o servidor por HTTP.

import { h } from './dom.mjs';
import { createApiClient } from './api.mjs';
import { roleLabel } from './format.mjs';
import { parseRoute, buildHash, sectionOf } from './router.mjs';
import { permissionsOf } from './crm-model.mjs';
import { createApprovalsView } from './views/approvals.mjs';
import { createCrmView } from './views/crm.mjs';
import { createOverviewView } from './views/overview.mjs';

const NO_ACCESS = 'Esta conta não possui acesso a esta área.';
const BASE_TITLE = 'Rio X7 AI Agency OS';
const PAGE_TITLES = Object.freeze({
  overview: 'Visão Geral',
  'crm-list': 'CRM',
  'crm-new': 'Novo registro · CRM',
  'crm-record': 'Registro · CRM',
  approvals: 'Aprovações',
  'not-found': 'Página não encontrada',
});

// O menu: as seções, na ordem. `needs` é a permissão (de /api/me) que a conta precisa ter para o item aparecer — só para
// não mostrar um caminho que levaria a um 403; o servidor continua decidindo.
const NAV_ITEMS = Object.freeze([
  { section: 'overview', label: 'Visão Geral', route: { name: 'overview' } },
  { section: 'crm', label: 'CRM', route: { name: 'crm-list' }, needs: 'canReadCrm' },
  { section: 'approvals', label: 'Aprovações', route: { name: 'approvals' } },
]);

// document/root: onde desenhar. fetchImpl: o fetch do navegador. sdk: o SDK do Supabase (globalThis.supabase).
// navigation: { current(), subscribe(fn), go(hash), replace(hash) } (router.mjs). Devolve uma promessa que termina
// quando a primeira tela (login ou painel) está desenhada.
export function startDashboard({ document, root, fetchImpl, sdk, navigation }) {
  function mount(...children) {
    root.replaceChildren(...children.filter(Boolean));
  }

  function showFatal(text) {
    mount(h(document, 'main', { className: 'centered' }, h(document, 'p', { className: 'message error', role: 'alert', text })));
  }

  async function loadConfig() {
    const response = await fetchImpl('/config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('config');
    const config = await response.json();
    if (typeof config.supabaseUrl !== 'string' || typeof config.supabaseAnonKey !== 'string') throw new Error('config');
    return config;
  }

  async function boot() {
    let client;
    try {
      const config = await loadConfig();
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

    const api = createApiClient({ getAccessToken, refreshAccessToken, onSessionLost: sessionLost, fetchImpl });

    // O painel em andamento (só existe com sessão): a assinatura das rotas e as telas que guardam dados.
    let session = null;
    // A tela de login está na página? Um SIGNED_OUT que chega com ela já visível (a sessão acabou aqui, ou saiu-se em
    // outra aba) não a reconstrói: apagaria o aviso "Sua sessão expirou" e o que a pessoa já digitou.
    let loginVisible = false;

    function endSession() {
      if (!session) return;
      session.stopRouting();
      for (const view of session.views) if (view && typeof view.destroy === 'function') view.destroy();
      session = null;
      document.title = BASE_TITLE;
    }

    async function logout() {
      try {
        await client.auth.signOut();
      } catch {
        // segue para o login mesmo se o servidor de autenticação não respondeu.
      }
      showLogin();
    }

    function showLogin(notice) {
      endSession();
      loginVisible = true;
      document.title = BASE_TITLE;
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

    // A moldura do painel: a barra de cima (nome, menu, Sair) e a área principal. `nav` só existe com /api/me carregado.
    function shell(me, main, nav) {
      const role = me ? roleLabel(me.role) : '';
      return h(
        document,
        'div',
        { className: 'shell' },
        h(
          document,
          'header',
          { className: 'topbar' },
          h(document, 'span', { className: 'brand', text: BASE_TITLE }),
          nav,
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
      loginVisible = false;
      endSession();
      mount(shell(null, h(document, 'main', { className: 'content' }, h(document, 'p', { className: 'muted', text: 'Carregando…' })), null));
      let me;
      try {
        me = await api.me();
      } catch (error) {
        if (error && error.status === 401) return; // o cliente de API já levou ao login
        const message = error && error.status === 403 ? NO_ACCESS : 'Não foi possível carregar o painel agora. Tente novamente em instantes.';
        mount(shell(null, h(document, 'main', { className: 'content' }, h(document, 'p', { className: 'message error', role: 'alert', text: message })), null));
        return;
      }

      const permissions = permissionsOf(me);
      const main = h(document, 'main', { className: 'content', id: 'main' });
      const navLinks = new Map();
      const nav = h(
        document,
        'nav',
        { className: 'nav', 'aria-label': 'Navegação principal' },
        ...NAV_ITEMS.filter((item) => !item.needs || permissions[item.needs]).map((item) => {
          const link = h(document, 'a', { className: 'nav-link', href: buildHash(item.route), text: item.label });
          navLinks.set(item.section, link);
          return link;
        })
      );
      mount(shell(me, main, nav));

      // Cada tela desenha no SEU contêiner: uma resposta que chega depois de a pessoa trocar de tela cai num contêiner
      // que já saiu da página, sem apagar a tela atual.
      const container = () => h(document, 'div', { className: 'view' });
      const crmContainer = container();
      const navigate = (hash) => navigation.go(hash);
      const crmView = createCrmView({ document, root: crmContainer, api, permissions, navigate });
      let transient = null; // a tela sem estado guardado (Visão Geral, Aprovações) que está na página agora

      function setActive(section) {
        for (const [name, link] of navLinks) {
          if (name === section) link.setAttribute('aria-current', 'page');
          else link.removeAttribute('aria-current');
        }
      }

      function renderRoute(route) {
        document.title = `${PAGE_TITLES[route.name] || BASE_TITLE} — ${BASE_TITLE}`;
        const section = sectionOf(route);
        setActive(section);
        if (transient && typeof transient.destroy === 'function') transient.destroy();
        transient = null;

        if (section === 'crm') {
          if (!permissions.canReadCrm) {
            main.replaceChildren(h(document, 'p', { className: 'message error', role: 'alert', text: NO_ACCESS }));
            return;
          }
          main.replaceChildren(crmContainer);
          crmView.show(route);
        } else if (section === 'approvals') {
          const target = container();
          main.replaceChildren(target);
          transient = createApprovalsView({ document, root: target, api, canReview: permissions.canReview });
          transient.load();
        } else if (section === 'overview') {
          const target = container();
          main.replaceChildren(target);
          transient = createOverviewView({ document, root: target, api, me, permissions });
          transient.load();
        } else {
          main.replaceChildren(
            h(
              document,
              'section',
              { className: 'overview' },
              h(document, 'h2', { text: 'Página não encontrada' }),
              h(document, 'p', { className: 'muted', text: 'O endereço que você abriu não existe neste painel.' }),
              h(document, 'a', { href: buildHash({ name: 'overview' }), className: 'btn secondary', text: 'Ir para a Visão Geral' })
            )
          );
        }
      }

      const stopRouting = navigation.subscribe(() => renderRoute(parseRoute(navigation.current())));
      session = { stopRouting, views: [crmView, { destroy: () => transient && typeof transient.destroy === 'function' && transient.destroy() }] };
      renderRoute(parseRoute(navigation.current()));
    }

    client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && !loginVisible) showLogin();
    });

    const { data } = await client.auth.getSession();
    if (data && data.session) await showDashboard();
    else showLogin();
  }

  return boot();
}
