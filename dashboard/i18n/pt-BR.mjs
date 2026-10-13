// O CATÁLOGO CENTRAL de textos do Dashboard em português do Brasil (CRM 5.0, Fase 2A).
//
// POR QUE EXISTE: os textos da interface estavam espalhados pelas telas, com termos em inglês misturados (Approval Queue, Pipeline, Prospect, DNC, Won...). Aqui moram os
// nomes que se repetem em mais de um lugar (menu, títulos, selos de status, papéis, termos do glossário) e a REGRA DE IDIOMA que um teste vigia.
//
// O QUE NUNCA É TRADUZIDO (compatibilidade): identificadores técnicos, valores guardados no banco ou na API (PROSPECT, WON, DO_NOT_CONTACT, APROVADO_PARA_CRM...), nomes de
// funções, rotas, permissões e contratos. Este arquivo só devolve o que a PESSOA lê; o valor que viaja para o servidor continua sendo o de sempre.
//
// REGRA DE IDIOMA: toda a interface usa português do Brasil simples. Podem continuar em inglês, por decisão do proprietário: LEAD, Dashboard, MQL, Status, Follow-up e os
// nomes próprios (WhatsApp, Google Meet, Meta Ads, Google Ads, CRM, Instagram...), mais os termos da agência Raio-X e Briefing. Todo o resto se traduz conforme o contexto.

// Palavras (e nomes próprios) que PODEM aparecer em inglês na interface.
export const ALLOWED_ENGLISH = Object.freeze([
  'LEAD', 'Lead', 'Leads', 'Dashboard', 'MQL', 'Status', 'Follow-up',
  'WhatsApp', 'Google Meet', 'Meta Ads', 'Google Ads', 'TikTok Ads', 'CRM', 'Instagram', 'Facebook', 'LinkedIn', 'YouTube', 'Google', 'E-mail', 'SDR',
  'Raio-X', 'Briefing', 'Briefings', 'IA', 'Supabase', 'Rio X7', 'AI Agency OS',
]);

// Termos em inglês que NÃO podem aparecer em texto voltado ao usuário (o teste de vocabulário varre as strings do Dashboard atrás deles). Cada entrada: o padrão e a tradução esperada.
export const FORBIDDEN_UI_TERMS = Object.freeze([
  { pattern: /\bApproval Queue\b/, use: 'Fila de Aprovação' },
  { pattern: /\bPipeline\b/i, use: 'Funil de Vendas' },
  { pattern: /\bKanban\b/i, use: 'Quadro de Negociações' },
  { pattern: /\bDrawer\b/i, use: 'Painel Lateral' },
  { pattern: /\bModal\b/i, use: 'Janela de Confirmação' },
  { pattern: /\bDNC\b/, use: 'Não Contatar' },
  { pattern: /\bDo Not Contact\b/i, use: 'Não Contatar' },
  { pattern: /\bProspects?\b/, use: 'Lead em Prospecção' },
  { pattern: /\bWorkbench\b/i, use: 'Prospecção' },
  { pattern: /\bJobs?\b/, use: 'prospecção / execução' },
  { pattern: /\bCloser\b/, use: 'Vendedor' },
  { pattern: /\b(Contacted|Responded|Qualified|Qualification|Meeting Scheduled|Meeting Completed|Proposal|Negotiation|Won|Lost)\b/, use: 'o rótulo em português do status' },
  { pattern: /\bResearch\b/, use: 'Em Pesquisa' },
  { pattern: /\bLink do Meet\b/, use: 'Link do Google Meet' },
]);

// Os 13 status do CRM, pelo valor GUARDADO (que não muda): o que a pessoa lê é o rótulo em português.
export const STATUS_LABELS = Object.freeze({
  PROSPECT: 'Lead em Prospecção',
  RESEARCH: 'Em Pesquisa',
  QUALIFIED_PROSPECT: 'Lead Qualificado',
  CONTACTED: 'Contatado',
  RESPONDED: 'Respondeu',
  QUALIFICATION: 'Em Qualificação',
  MEETING_SCHEDULED: 'Reunião Agendada',
  MEETING_COMPLETED: 'Reunião Realizada',
  PROPOSAL: 'Proposta Enviada',
  NEGOTIATION: 'Em Negociação',
  WON: 'Fechada',
  LOST: 'Perdida',
  DO_NOT_CONTACT: 'Não Contatar',
});

// Os papéis (role) que a pessoa vê.
export const ROLE_LABELS = Object.freeze({ ADMIN: 'Administrador', COMMERCIAL_CLOSER: 'Vendedor' });

// O glossário: o nome que a interface usa para cada conceito que antes aparecia em inglês.
export const TERMS = Object.freeze({
  approvalQueue: 'Fila de Aprovação',
  doNotContact: 'Não Contatar',
  salesFunnel: 'Funil de Vendas',
  salesFunnels: 'Funis de Vendas',
  dealBoard: 'Quadro de Negociações',
  leadInProspecting: 'Lead em Prospecção',
  sidePanel: 'Painel Lateral',
  confirmationWindow: 'Janela de Confirmação',
  kickoffMeeting: 'Reunião de Início',
  comingSoon: 'EM DESENVOLVIMENTO',
});

// O MENU: nomes de cada entrada (a estrutura e as permissões estão em nav.mjs).
export const NAV_LABELS = Object.freeze({
  overview: 'Visão Geral',
  crm: 'CRM',
  crmDashboard: 'Dashboard Comercial',
  crmClients: 'Clientes',
  funnels: 'Funis de Vendas',
  crmGoals: 'Metas e Indicadores',
  crmSettings: 'Configurações do CRM',
  crmServices: 'Serviços',
  crmNiches: 'Nichos e Cores',
  crmFunnelAdmin: 'Gestão de Funis e Etapas',
  crmOrigins: 'Origens dos Leads',
  prospectingGroup: 'Prospecção',
  prospecting: 'Nova Prospecção',
  prospectingHistory: 'Histórico',
  approvals: 'Fila de Aprovação',
  rejectedLeads: 'Leads Reprovados',
  agentsGroup: 'Agentes IA',
  agents: 'Central de Agentes',
  management: 'Gestão',
  prospectingExclusions: 'Exclusões Permanentes',
  agenda: 'Agenda',
  conversations: 'Conversas',
  meetings: 'Reuniões',
  proposals: 'Propostas',
  reports: 'Relatórios',
  settings: 'Configurações gerais',
});

// Textos do próprio menu e da moldura.
export const SHELL_TEXT = Object.freeze({
  navLabel: 'Navegação principal',
  collapse: 'Recolher menu',
  expand: 'Expandir menu',
  openMenu: 'Abrir menu',
  closeMenu: 'Fechar menu',
  expandBranch: (name) => `Expandir ${name}`,
  collapseBranch: (name) => `Recolher ${name}`,
  soonSuffix: 'em desenvolvimento',
  logout: 'Sair',
});

// O título da aba do navegador para cada rota (o sufixo é o nome do produto).
export const PAGE_TITLES = Object.freeze({
  overview: 'Visão Geral',
  'crm-dashboard': 'Dashboard Comercial',
  'crm-clients': 'Clientes · CRM',
  'crm-list': 'Clientes · CRM',
  'crm-new': 'Novo registro · CRM',
  'crm-record': 'Registro · CRM',
  'crm-goals': 'Metas e Indicadores · CRM',
  'crm-settings': 'Configurações do CRM',
  'crm-settings-services': 'Serviços · Configurações do CRM',
  'crm-settings-niches': 'Nichos e Cores · Configurações do CRM',
  'crm-settings-funnels': 'Gestão de Funis e Etapas · Configurações do CRM',
  'crm-settings-origins': 'Origens dos Leads · Configurações do CRM',
  approvals: 'Fila de Aprovação',
  'approval-lead': 'Lead · Fila de Aprovação',
  agents: 'Agentes IA',
  funnels: 'Funis de Vendas',
  prospecting: 'Nova Prospecção',
  'prospecting-history': 'Histórico de prospecções',
  'prospecting-job': 'Prospecção · Histórico',
  'prospecting-run': 'Execução · Nova Prospecção',
  'prospecting-brief': 'Briefing · Nova Prospecção',
  'rejected-leads': 'Leads Reprovados',
  'rejected-lead': 'Lead · Leads Reprovados',
  'prospecting-exclusions': 'Exclusões Permanentes',
  'not-found': 'Página não encontrada',
});

// As páginas futuras do CRM: o que cada uma vai ser. (Serviços, Nichos e Cores, Origens dos Leads e a página Configurações do CRM já existem — Fase 2B-2 —, por isso não estão mais aqui.) Nenhuma tem dado, botão de ação ou número — só a explicação honesta de que ainda não existe.
export const FUTURE_PAGES = Object.freeze({
  'crm-dashboard': {
    title: 'Dashboard Comercial',
    summary: 'Uma visão executiva do que acontece na área comercial: negociações em aberto, propostas, vendas, metas e o que precisa de atenção.',
    plans: ['Quantidade e valor de negociações por etapa e por funil', 'Propostas enviadas, vendas fechadas e taxa de conversão', 'Follow-ups pendentes e atrasados', 'Desempenho por vendedor, nicho e funil'],
  },
  'crm-goals': {
    title: 'Metas e Indicadores',
    summary: 'Metas por período, funil e responsável, comparadas com o que foi realizado.',
    plans: ['Metas de quantidade de negociações e de valor vendido', 'Meta versus realizado', 'Ticket médio e tempo médio de fechamento'],
  },
  'crm-settings-funnels': {
    title: 'Gestão de Funis e Etapas',
    summary: 'A administração dos funis de vendas e das etapas de cada um.',
    plans: ['Criar, renomear, reordenar e arquivar funis', 'Criar, renomear e reordenar etapas', 'Excluir etapas vazias, quando for seguro'],
  },
});

// TEXTO GUARDADO: o backend grava, por exemplo, "Promovido da Approval Queue (prospect ...)" no histórico de um registro. O texto guardado NUNCA é alterado; só a EXIBIÇÃO traduz as duas
// expressões conhecidas (Approval Queue e prospect), para a tela ficar em português. Qualquer outra coisa aparece como veio.
export function localizeStoredText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/Approval Queue/g, TERMS.approvalQueue).replace(/\bprospect\b/g, 'lead');
}

// Para o teste de vocabulário e para quem quiser conferir um texto: acha o primeiro termo proibido (ou null).
export function findForbiddenTerm(text) {
  if (typeof text !== 'string') return null;
  for (const entry of FORBIDDEN_UI_TERMS) if (entry.pattern.test(text)) return entry;
  return null;
}
