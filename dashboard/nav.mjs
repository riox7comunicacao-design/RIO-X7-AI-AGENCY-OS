// A ESTRUTURA do menu lateral do Dashboard (CRM 5.0, Fase 2A): a árvore de entradas, a permissão de cada uma e a regra de qual entrada fica "ativa" para cada rota.
//
// Só dados e funções puras: nada aqui toca o DOM, a rede ou o navegador (quem desenha é ui/sidebar.mjs; quem decide a tela é main.mjs).
//
// O QUE O MENU É E NÃO É: é só um caminho. `needs` esconde uma entrada que levaria a um 403 — a decisão real de acesso continua sendo do servidor, que recusa de verdade. Uma entrada
// SEM rota é uma área que ainda não existe: aparece desabilitada e marcada "Em desenvolvimento", nunca como link. Uma entrada COM rota e `soon: true` abre uma página que diz
// EM DESENVOLVIMENTO, sem nenhum dado simulado (views/comingSoon.mjs).
//
// HIERARQUIA: raiz (nível 0) → submenu (nível 1) → submenu de segundo nível (nível 2). Não há terceiro nível.
//   - uma entrada COM `route` e filhos: o TEXTO abre a rota e a SETA (botão separado) só expande/recolhe;
//   - uma entrada SEM `route` e com filhos: o texto inteiro só expande/recolhe.

import { NAV_LABELS } from './i18n/pt-BR.mjs';

export const MAX_NAV_DEPTH = 2;

// `icon` é o nome de um ícone do conjunto que está em index.html (ver ICON_NAMES). Só as entradas da raiz têm ícone; os submenus se reconhecem pela indentação.
export const NAV_TREE = Object.freeze([
  { id: 'overview', label: NAV_LABELS.overview, icon: 'home', route: { name: 'overview' } },
  {
    id: 'crm',
    label: NAV_LABELS.crm,
    icon: 'users',
    route: { name: 'crm-dashboard' }, // clicar no texto "CRM" abre o Dashboard Comercial
    needs: 'canReadCrm',
    children: [
      { id: 'crm-dashboard', label: NAV_LABELS.crmDashboard, route: { name: 'crm-dashboard' }, needs: 'canReadCrm' },
      { id: 'crm-clients', label: NAV_LABELS.crmClients, route: { name: 'crm-clients' }, needs: 'canReadCrm' },
      { id: 'funnels', label: NAV_LABELS.funnels, route: { name: 'funnels' }, needs: 'canReadCrm' },
      { id: 'crm-goals', label: NAV_LABELS.crmGoals, route: { name: 'crm-goals' }, needs: 'canReadCrm', soon: true },
      {
        id: 'crm-settings',
        label: NAV_LABELS.crmSettings,
        route: { name: 'crm-settings' }, // a página de acessos aos cadastros (views/crmSettings.mjs); o pai só aparece se algum filho aparecer
        needs: 'canReadCrm',
        children: [
          // Os três catálogos são telas ADMINISTRATIVAS reais (Fase 2B-2): só aparecem para quem pode administrá-los (MANAGE:CRM_CATALOGS). A Gestão de Funis e Etapas (Fase D1) também é real e,
          // por ser administrativa, só aparece para quem tem MANAGE:FUNNELS. Quem só pode ler o CRM não vê nenhum item de Configurações (o pai some quando fica sem filhos).
          { id: 'crm-settings-services', label: NAV_LABELS.crmServices, route: { name: 'crm-settings-services' }, needs: 'canManageCrmCatalogs' },
          { id: 'crm-settings-niches', label: NAV_LABELS.crmNiches, route: { name: 'crm-settings-niches' }, needs: 'canManageCrmCatalogs' },
          { id: 'crm-settings-funnels', label: NAV_LABELS.crmFunnelAdmin, route: { name: 'crm-settings-funnels' }, needs: 'canManageFunnels' },
          { id: 'crm-settings-origins', label: NAV_LABELS.crmOrigins, route: { name: 'crm-settings-origins' }, needs: 'canManageCrmCatalogs' },
        ],
      },
    ],
  },
  {
    id: 'prospecting-group',
    label: NAV_LABELS.prospectingGroup,
    icon: 'search',
    children: [
      { id: 'prospecting', label: NAV_LABELS.prospecting, route: { name: 'prospecting' }, needs: 'canProposeLead' },
      { id: 'prospecting-history', label: NAV_LABELS.prospectingHistory, route: { name: 'prospecting-history' }, needs: 'canProposeLead' },
      { id: 'approvals', label: NAV_LABELS.approvals, route: { name: 'approvals' } },
      { id: 'rejected-leads', label: NAV_LABELS.rejectedLeads, route: { name: 'rejected-leads' }, needs: 'canReview' },
    ],
  },
  {
    id: 'agents-group',
    label: NAV_LABELS.agentsGroup,
    icon: 'bot',
    children: [{ id: 'agents', label: NAV_LABELS.agents, route: { name: 'agents' } }],
  },
  {
    id: 'management',
    label: NAV_LABELS.management,
    icon: 'shield',
    children: [
      { id: 'prospecting-exclusions', label: NAV_LABELS.prospectingExclusions, route: { name: 'prospecting-exclusions' }, needs: 'canManageProspectingExclusions' },
      // Os módulos do menu ANTIGO que ainda não existem: ficam aqui só como referência, desabilitados e marcados "Em desenvolvimento" — SEM rota (nada de link falso nem de tela simulada).
      // Agenda, Conversas, Reuniões e Propostas são do universo comercial: só aparecem para quem pode ler o CRM. Relatórios e Configurações gerais não tinham permissão no menu antigo e seguem assim.
      // "Leads" NÃO está aqui de propósito: já existe acesso real (Clientes, Fila de Aprovação e Leads Reprovados); um item desabilitado só duplicaria e confundiria.
      { id: 'agenda', label: NAV_LABELS.agenda, needs: 'canReadCrm' },
      { id: 'conversations', label: NAV_LABELS.conversations, needs: 'canReadCrm' },
      { id: 'meetings', label: NAV_LABELS.meetings, needs: 'canReadCrm' },
      { id: 'proposals', label: NAV_LABELS.proposals, needs: 'canReadCrm' },
      { id: 'reports', label: NAV_LABELS.reports },
      { id: 'settings', label: NAV_LABELS.settings },
    ],
  },
]);

// Os ícones que o menu usa (cada um existe em index.html como <svg id="rx7-icon-NOME">). Um teste confere que não falta nenhum.
export const ICON_NAMES = Object.freeze(['home', 'users', 'search', 'bot', 'shield', 'chevron', 'collapse', 'menu', 'close', 'logout']);

// A INSTÂNCIA HOSPEDADA (decisão 0033; /config.json com modo "crm-only"): o servidor desliga a Approval Queue, a prospecção e o que depende de arquivo local — as telas deles somem do menu e
// um endereço digitado à mão mostra "módulo indisponível", sem chamar a API. É só conforto: quem recusa de verdade é o servidor (MODULE_DISABLED).
export const CRM_ONLY_HIDDEN_NAV_IDS = Object.freeze(['prospecting-group', 'prospecting-exclusions']);
export const CRM_ONLY_DISABLED_SECTIONS = Object.freeze(['approvals', 'rejected-leads', 'prospecting', 'prospecting-history', 'prospecting-exclusions']);

// A árvore que ESTA conta enxerga: tira o que a permissão não cobre, e os pais que ficaram sem nada para mostrar. Devolve cópias novas (a árvore original não é alterada).
// `hide`: ids de entradas (e de tudo o que há dentro delas) que ficam de fora, quaisquer que sejam as permissões.
export function visibleTree(tree, permissions, { hide = [] } = {}) {
  const allowed = (item) => !hide.includes(item.id) && (!item.needs || Boolean(permissions && permissions[item.needs]));
  const walk = (items) =>
    items
      .filter(allowed)
      .map((item) => {
        const children = Array.isArray(item.children) ? walk(item.children) : null;
        return { ...item, ...(children ? { children } : {}) };
      })
      // um pai só existe enquanto tiver algum filho visível; uma folha (inclusive a "em desenvolvimento", sem rota) fica
      .filter((item) => !item.children || item.children.length > 0);
  return walk(tree);
}

// Todas as entradas da árvore, em ordem, com o nível e o caminho de ancestrais: [{ item, depth, parentId }].
export function flattenTree(tree) {
  const out = [];
  const walk = (items, depth, parentId) => {
    for (const item of items) {
      out.push({ item, depth, parentId });
      if (item.children) walk(item.children, depth + 1, item.id);
    }
  };
  walk(tree, 0, null);
  return out;
}

// Os ids dos ancestrais de uma entrada (do pai mais próximo à raiz).
export function ancestorsOf(tree, id) {
  const flat = flattenTree(tree);
  const byId = new Map(flat.map((entry) => [entry.item.id, entry]));
  const out = [];
  for (let current = byId.get(id); current && current.parentId; current = byId.get(current.parentId)) out.push(current.parentId);
  return out;
}

// Qual entrada do menu uma ROTA acende. A "seção" de router.mjs escolhe a TELA; esta função escolhe o destaque do menu (não são a mesma coisa: #/crm — a lista antiga de
// registros — e #/crm/clientes são a mesma tela e acendem "Clientes").
export function menuItemOf(route) {
  const name = route && route.name;
  switch (name) {
    case 'overview':
      return 'overview';
    case 'crm-dashboard':
      return 'crm-dashboard';
    case 'crm-list':
    case 'crm-clients':
    case 'crm-new':
    case 'crm-record':
      return 'crm-clients';
    case 'funnels':
      return 'funnels';
    case 'crm-goals':
      return 'crm-goals';
    case 'crm-settings':
      return 'crm-settings';
    case 'crm-settings-services':
      return 'crm-settings-services';
    case 'crm-settings-niches':
      return 'crm-settings-niches';
    case 'crm-settings-funnels':
      return 'crm-settings-funnels';
    case 'crm-settings-origins':
      return 'crm-settings-origins';
    // o painel de novo item / de edição de um catálogo mantém aceso o item do menu do catálogo
    case 'crm-catalog-new':
    case 'crm-catalog-item':
      return route.catalog === 'servicos' ? 'crm-settings-services' : route.catalog === 'nichos' ? 'crm-settings-niches' : route.catalog === 'origens' ? 'crm-settings-origins' : null;
    case 'prospecting':
    case 'prospecting-run':
    case 'prospecting-brief':
      return 'prospecting';
    case 'prospecting-history':
    case 'prospecting-job':
      return 'prospecting-history';
    case 'approvals':
    case 'approval-lead':
      return 'approvals';
    case 'rejected-leads':
    case 'rejected-lead':
      return 'rejected-leads';
    case 'agents':
      return 'agents';
    case 'prospecting-exclusions':
      return 'prospecting-exclusions';
    default:
      return null;
  }
}
