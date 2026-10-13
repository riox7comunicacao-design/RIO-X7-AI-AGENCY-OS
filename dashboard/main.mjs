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
import { parseRoute, buildHash, sectionOf, catalogListRouteName } from './router.mjs';
import { NAV_TREE, visibleTree, menuItemOf } from './nav.mjs';
import { PAGE_TITLES, SHELL_TEXT } from './i18n/pt-BR.mjs';
import { permissionsOf } from './crm-model.mjs';
import { createAgentsView } from './views/agents.mjs';
import { createApprovalsView } from './views/approvals.mjs';
import { createCrmView } from './views/crm.mjs';
import { createCatalogsView } from './views/catalogs.mjs';
import { createCrmSettingsView } from './views/crmSettings.mjs';
import { createFunnelsView } from './views/funnels.mjs';
import { createProspectingView } from './views/prospecting.mjs';
import { createProspectingExclusionsView } from './views/prospectingExclusions.mjs';
import { createProspectingHistoryView } from './views/prospectingHistory.mjs';
import { createRejectedLeadsView } from './views/rejectedLeads.mjs';
import { createOverviewView } from './views/overview.mjs';
import { createComingSoonView } from './views/comingSoon.mjs';
import { createUi, createDataBus } from './ui/index.mjs';
import { createSidebar, browserViewport, iconNode } from './ui/sidebar.mjs';

const NO_ACCESS = 'Esta conta não possui acesso a esta área.';
const BASE_TITLE = 'Rio X7 AI Agency OS';
// Os títulos de cada rota (i18n/pt-BR.mjs) e a estrutura do menu lateral com as permissões de cada entrada (nav.mjs).
// Uma entrada do menu COM rota e `soon` abre uma página EM DESENVOLVIMENTO; uma SEM rota é uma área que ainda não existe e aparece desabilitada — nunca um link para uma rota inexistente.

// document/root: onde desenhar. fetchImpl: o fetch do navegador. sdk: o SDK do Supabase (globalThis.supabase).
// navigation: { current(), subscribe(fn), go(hash), replace(hash) } (router.mjs). Devolve uma promessa que termina
// quando a primeira tela (login ou painel) está desenhada.
// preferences: { getSidebarCollapsed(), setSidebarCollapsed(bool) } (preferences.mjs) — a ÚNICA preferência visual lembrada: menu recolhido ou expandido. Sem ela, vale só enquanto a página está aberta.
// viewport: { isMobile(), subscribe(fn) } — quando a largura é de celular (padrão: window.matchMedia, se existir).
export function startDashboard({ document, root, fetchImpl, sdk, navigation, preferences = null, viewport = null }) {
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
            h(document, 'div', { className: 'brand-block on-light' }, h(document, 'h1', { className: 'brand-name', text: 'RIO X7' }), h(document, 'span', { className: 'brand-sub', text: 'AI AGENCY OS' })),
            h(document, 'p', { className: 'muted', text: 'Central operacional da Rio X7 Comunicação.' }),
            h(document, 'p', { className: 'login-hint', text: 'Entre com a sua conta para acessar o painel.' }),
            h(document, 'div', { className: 'field' }, h(document, 'label', { for: 'login-email', text: 'E-mail' }), email),
            h(document, 'div', { className: 'field' }, h(document, 'label', { for: 'login-password', text: 'Senha' }), password),
            feedback,
            submit
          )
        )
      );
      email.focus();
    }

    // O bloco de baixo do menu: quem está logado e "Sair".
    function whoBlock(me) {
      const role = me ? roleLabel(me.role) : '';
      return h(
        document,
        'div',
        { className: 'who' },
        me ? h(document, 'span', { className: 'who-name', text: typeof me.name === 'string' ? me.name : '' }) : null,
        role ? h(document, 'span', { className: 'badge neutral', text: role }) : null,
        h(document, 'button', { type: 'button', className: 'btn secondary logout', 'data-tip': SHELL_TEXT.logout, onclick: logout }, h(document, 'span', { className: 'logout-icon', 'aria-hidden': 'true' }, iconNode(document, 'logout')), h(document, 'span', { className: 'logout-label', text: SHELL_TEXT.logout }))
      );
    }

    // A moldura do painel: o menu lateral (ou, antes de /api/me, só a marca e "Sair") e a área principal. `sidebar` só existe com /api/me carregado.
    function shell(me, main, sidebar) {
      const parts = sidebar
        ? [sidebar.topbar, sidebar.backdrop, sidebar.aside]
        : [h(document, 'aside', { className: 'sidebar' }, h(document, 'div', { className: 'sidebar-head' }, brandBlock()), whoBlock(me))];
      return h(document, 'div', { className: 'shell', 'data-sidebar': 'expanded', 'data-nav-open': 'false' }, ...parts, main);
    }

    function brandBlock() {
      return h(document, 'div', { className: 'brand-block' }, h(document, 'span', { className: 'brand-name', text: 'RIO X7' }), h(document, 'span', { className: 'brand-sub', text: 'AI AGENCY OS' }));
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
      const win = document.defaultView || null;
      const sidebar = createSidebar({
        document,
        tree: visibleTree(NAV_TREE, permissions),
        brand: brandBlock,
        footer: whoBlock(me),
        preferences,
        viewport: viewport || browserViewport(win),
      });
      sidebar.build((route) => buildHash(route));
      // A moldura e, ao lado dela, o lugar das CAMADAS (gaveta/modal/confirmação) e dos AVISOS: enquanto há uma camada aberta, a moldura fica inert.
      const shellEl = shell(me, main, sidebar);
      sidebar.bindShell(shellEl, main);
      const overlayHost = h(document, 'div', { className: 'overlay-host' });
      mount(shellEl, overlayHost);
      const ui = createUi({ document, host: overlayHost, getInertTargets: () => [shellEl] });
      const bus = createDataBus();

      // Cada tela desenha no SEU contêiner: uma resposta que chega depois de a pessoa trocar de tela cai num contêiner
      // que já saiu da página, sem apagar a tela atual.
      const container = () => h(document, 'div', { className: 'view' });
      const crmContainer = container();
      const navigate = (hash) => navigation.go(hash);
      // O CRM é PERSISTENTE na sessão (como a Approval Queue): busca, filtros, ordem, página e rolagem sobrevivem a abrir a ficha (uma gaveta com URL) e a trocar de módulo.
      const crmView = createCrmView({ document, root: crmContainer, api, permissions, navigate, ui, bus, navigation });
      // A Approval Queue é PERSISTENTE na sessão (como o CRM): busca, filtro, ordem e página sobrevivem a trocar de módulo; a gaveta do lead tem URL (#/aprovacoes/<id>).
      const approvalsContainer = container();
      const approvalsView = createApprovalsView({
        document,
        root: approvalsContainer,
        api,
        canReview: permissions.canReview,
        // Promover exige as duas permissões (o servidor confere as reais): APPROVE:LEAD_APPROVAL e WRITE:CRM.
        canPromote: permissions.canReview && permissions.canWriteCrm,
        canReadCrm: permissions.canReadCrm,
        ui,
        bus,
        navigation,
      });
      // o contador do menu acompanha a fila: quem muda a fila avisa pelo barramento (sem recarregar a página)
      // (o menu soma a contagem no grupo "Prospecção", para o número não ficar escondido com o grupo recolhido)
      const stopCounts = bus.subscribe('approvals:counts', ({ pending }) => sidebar.setBadge('approvals', pending));
      // Leads Reprovados também é PERSISTENTE (filtro, busca, ordem e página sobrevivem a trocar de módulo; a gaveta do lead tem URL). Reconsiderar devolve o lead à fila:
      // o barramento avisa e a Fila de Aprovação se atualiza em silêncio (uma leitura), para o contador do menu acompanhar.
      const rejectedContainer = container();
      const rejectedView = createRejectedLeadsView({ document, root: rejectedContainer, api, permissions, ui, bus, navigation });
      const stopReconsider = bus.subscribe('approvals:changed', ({ action }) => {
        if (action === 'reconsider') approvalsView.refresh();
      });
      // O Histórico de prospecções também é PERSISTENTE (busca, filtro, ordem e página sobrevivem a trocar de módulo; a gaveta da prospecção tem URL). Refazer leva à Nova Prospecção.
      const historyContainer = container();
      const historyView = createProspectingHistoryView({ document, root: historyContainer, api, navigate, canProposeLead: permissions.canProposeLead, ui, bus, navigation });
      // A Nova Prospecção também é PERSISTENTE (o rascunho do formulário, o briefing e a gaveta da execução, com URL, sobrevivem a trocar de módulo). Nada começa sozinho:
      // só a confirmação humana inicia uma prospecção; o acompanhamento só consulta o status de um job em andamento, com a tela à vista.
      const prospectingContainer = container();
      const prospectingView = createProspectingView({ document, root: prospectingContainer, api, permissions, ui, bus, navigation });
      // Os catálogos do CRM (Serviços, Nichos e Cores, Origens dos Leads — Fase 2B-2) também são PERSISTENTES: busca, filtro e rolagem sobrevivem a abrir o painel lateral (que tem URL) e a trocar de módulo.
      // Só quem tem MANAGE:CRM_CATALOGS entra; o servidor também recusa as chamadas de quem não tem.
      const catalogsContainer = container();
      const catalogsView = createCatalogsView({ document, root: catalogsContainer, api, permissions, ui, bus, navigation });
      let currentSection = null;
      let transient = null; // a tela sem estado guardado (Visão Geral, Aprovações) que está na página agora

      // O endereço da tela que está na página: o CRM, com uma edição não salva, pode pedir para voltar a ele (navigation.restore) se a pessoa escolher "Continuar editando".
      let renderedHash = navigation.current();

      function renderRoute(route) {
        const section = sectionOf(route);
        // Sair do CRM (ou de um catálogo do CRM) com edição não salva (ou salvando): o navegador já mudou o endereço, mas NADA muda na tela até a pessoa decidir. Descartar segue para onde ia;
        // continuar editando volta o endereço.
        const guarded = currentSection === 'crm' ? crmView : currentSection === 'crm-catalogs' ? catalogsView : null;
        if (guarded && section !== currentSection && typeof guarded.leaveState === 'function' && guarded.leaveState() !== null) {
          guarded.confirmLeave({ discard: () => renderRoute(route), stay: () => navigation.restore(renderedHash) });
          return;
        }
        renderedHash = navigation.current();
        document.title = `${PAGE_TITLES[catalogListRouteName(route) || route.name] || BASE_TITLE} — ${BASE_TITLE}`;
        sidebar.setActive(menuItemOf(route));
        if (transient && typeof transient.destroy === 'function') transient.destroy();
        transient = null;
        if (currentSection === 'crm' && section !== 'crm') crmView.hide(); // saiu do CRM: a ficha aberta fecha; busca, filtros e página ficam guardados
        if (currentSection === 'crm-catalogs' && section !== 'crm-catalogs') catalogsView.hide(); // saiu dos catálogos: o painel lateral fecha; busca, filtro e rolagem ficam guardados
        if (currentSection === 'approvals' && section !== 'approvals') approvalsView.hide(); // saiu da fila: as camadas fecham e as consultas param
        if (currentSection === 'rejected-leads' && section !== 'rejected-leads') rejectedView.hide();
        if (currentSection === 'prospecting-history' && section !== 'prospecting-history') historyView.hide();
        if (currentSection === 'prospecting' && section !== 'prospecting') prospectingView.hide();
        currentSection = section;

        if (section === 'crm') {
          if (!permissions.canReadCrm) {
            main.replaceChildren(h(document, 'p', { className: 'message error', role: 'alert', text: NO_ACCESS }));
            return;
          }
          main.replaceChildren(crmContainer);
          crmView.show(route);
        } else if (section === 'crm-catalogs') {
          // Administrar os catálogos exige MANAGE:CRM_CATALOGS (só ADMIN): sem ela nada é mostrado nem chamado.
          if (!permissions.canManageCrmCatalogs) {
            main.replaceChildren(h(document, 'p', { className: 'message error', role: 'alert', text: NO_ACCESS }));
            return;
          }
          main.replaceChildren(catalogsContainer);
          catalogsView.show(route);
        } else if (section === 'crm-settings') {
          // Configurações do CRM: os acessos aos cadastros. Só mostra o que a conta pode administrar; sem nenhuma permissão administrativa não há o que mostrar.
          if (!permissions.canManageCrmCatalogs && !permissions.canManageFunnels) {
            main.replaceChildren(h(document, 'p', { className: 'message error', role: 'alert', text: NO_ACCESS }));
            return;
          }
          const target = container();
          main.replaceChildren(target);
          transient = createCrmSettingsView({ document, root: target, permissions });
          transient.render();
        } else if (section === 'crm-future') {
          // Dashboard Comercial, Metas e Configurações do CRM: páginas EM DESENVOLVIMENTO, sem dado nenhum
          if (!permissions.canReadCrm) {
            main.replaceChildren(h(document, 'p', { className: 'message error', role: 'alert', text: NO_ACCESS }));
            return;
          }
          const target = container();
          main.replaceChildren(target);
          transient = createComingSoonView({ document, root: target, pageName: route.name, canReadCrm: permissions.canReadCrm });
          transient.render();
        } else if (section === 'approvals') {
          main.replaceChildren(approvalsContainer);
          approvalsView.show(route);
        } else if (section === 'agents') {
          const target = container();
          main.replaceChildren(target);
          transient = createAgentsView({ document, root: target });
          transient.render();
        } else if (section === 'funnels') {
          if (!permissions.canReadCrm) {
            main.replaceChildren(h(document, 'p', { className: 'message error', role: 'alert', text: NO_ACCESS }));
            return;
          }
          const target = container();
          main.replaceChildren(target);
          transient = createFunnelsView({ document, root: target, api, permissions, navigate });
          transient.load();
        } else if (section === 'prospecting') {
          if (!permissions.canProposeLead) {
            main.replaceChildren(h(document, 'p', { className: 'message error', role: 'alert', text: NO_ACCESS }));
            return;
          }
          main.replaceChildren(prospectingContainer);
          prospectingView.show(route);
        } else if (section === 'prospecting-history') {
          if (!permissions.canProposeLead) {
            main.replaceChildren(h(document, 'p', { className: 'message error', role: 'alert', text: NO_ACCESS }));
            return;
          }
          main.replaceChildren(historyContainer);
          historyView.show(route);
        } else if (section === 'rejected-leads') {
          if (!permissions.canReview) {
            main.replaceChildren(h(document, 'p', { className: 'message error', role: 'alert', text: NO_ACCESS }));
            return;
          }
          main.replaceChildren(rejectedContainer);
          rejectedView.show(route);
        } else if (section === 'prospecting-exclusions') {
          if (!permissions.canManageProspectingExclusions) {
            main.replaceChildren(h(document, 'p', { className: 'message error', role: 'alert', text: NO_ACCESS }));
            return;
          }
          const target = container();
          main.replaceChildren(target);
          transient = createProspectingExclusionsView({ document, root: target, api, permissions });
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
      session = {
        stopRouting,
        views: [{ destroy: () => sidebar.destroy() }, crmView, catalogsView, approvalsView, rejectedView, historyView, prospectingView, { destroy: stopReconsider }, { destroy: () => transient && typeof transient.destroy === 'function' && transient.destroy() }, { destroy: stopCounts }, { destroy: () => ui.destroy() }],
      };
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
