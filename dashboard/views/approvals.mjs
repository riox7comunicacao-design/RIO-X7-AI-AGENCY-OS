// Tela APROVAÇÕES (Approval Queue) — a fila de aprovação humana de prospects. Primeira tela de REFERÊNCIA da UX 4.0.
//
// A tela lista os prospects AGUARDANDO_REVISAO (ou APROVADO_PARA_CRM), com busca, ordenação e paginação, e abre cada lead numa GAVETA (drawer)
// na própria tela — sem recarregar, sem perder o filtro, a busca, a página nem a posição na lista. Na gaveta o usuário vê o resumo, os dados,
// os contatos, a pesquisa comercial, as fontes e o histórico, e pode APROVAR, REJEITAR ou PROMOVER, SEMPRE por uma confirmação humana
// explícita (motivo opcional ao aprovar; obrigatório ao rejeitar). Quem decide se a pessoa pode fazer isso é o SERVIDOR; a tela só usa
// `canReview`/`canPromote` (vindos de /api/me) para mostrar ou esconder botões — uma conveniência de interface, nunca uma autorização.
//
// "Aprovar candidato" é uma triagem interna (APROVADO_PARA_CRM): não cria registro no CRM e não autoriza contato (docs/decisions/0007).
//
// NAVEGAÇÃO: a gaveta tem URL (#/aprovacoes/<id>): o link direto abre o lead, o Voltar do navegador fecha a gaveta sem sair do módulo, o
// Avançar a reabre. A tela é PERSISTENTE na sessão (como o CRM): trocar de módulo e voltar mantém busca, filtro, ordenação e página; ao
// voltar, os dados são atualizados em silêncio (uma requisição), sem apagar a lista.
//
// ATUALIZAÇÃO: depois de aprovar/rejeitar/promover a lista e os contadores se atualizam sozinhos (uma requisição, sem F5), o menu recebe o novo
// contador pelo barramento (dataBus) e um aviso (toast) confirma — só DEPOIS da resposta do servidor. Em erro, o que foi digitado fica.
//
// SEGURANÇA: tudo o que vem dos dados entra no DOM por dom.mjs (textContent). Um endereço só vira link se for http(s) (safeHttpUrl), sempre
// com rel="noopener noreferrer". Nada aqui usa innerHTML, eval ou Function. Nenhuma ação comercial começa sozinha: pesquisar, aprovar,
// rejeitar e promover exigem o clique explícito da pessoa.
//
// As funções puras (rótulos, datas, URLs, mensagens de erro) são exportadas para teste; a tela recebe `document`, `root` e `api` por
// parâmetro, então roda igual no navegador e em um DOM de teste.

import { h, fill } from '../dom.mjs';
import { textOf, safeHttpUrl, formatDate, formatDateTime } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { buildLeadProfile, LEAD_TYPE_LABELS } from './leadProfile.mjs';
import { createEnrichmentPanel } from './leadEnrichmentPanel.mjs';
import { createUi, statusBadge, emptyState, skeleton, pageHeader, kvList, section, searchField, selectField, pagination, createTabs } from '../ui/index.mjs';

// Estas quatro funções puras vivem em ../format.mjs (compartilhadas com as demais telas); continuam exportadas daqui.
export { textOf, safeHttpUrl, formatDate, formatDateTime };

export const PENDING_ESTADO = 'AGUARDANDO_REVISAO';
export const APPROVED_ESTADO = 'APROVADO_PARA_CRM';

export const ESTADO_LABELS = Object.freeze({
  AGUARDANDO_REVISAO: 'Aguardando revisão',
  APROVADO_PARA_CRM: 'Aprovado (triagem)',
  REJEITADO: 'Rejeitado',
  DUPLICADO: 'Duplicado',
  DNC: 'Não contatar (DNC)',
  DADOS_INSUFICIENTES: 'Dados insuficientes',
  EXPIRADO: 'Expirado',
});

const IDENTITY_REASONS = Object.freeze({
  CONFIRMADA: 'confirmada',
  CONFLITO: 'conflito entre fontes',
  AMBIGUA: 'identidade ambígua',
  EVIDENCIA_FRACA: 'evidência fraca',
  SEM_EVIDENCIA: 'sem evidência',
});

const DATA_LABELS = Object.freeze({ SUFICIENTES: 'Suficientes', PARCIAIS: 'Parciais', INSUFICIENTES: 'Insuficientes' });
const DUPLICITY_LABELS = Object.freeze({
  NOVO: 'Novo',
  DUPLICADO: 'Duplicado',
  POSSIVEL_DUPLICADO: 'Possível duplicado',
  NAO_VERIFICADO: 'Não verificado',
});
const DNC_LABELS = Object.freeze({
  NAO_ENCONTRADO: 'Não encontrado no CRM',
  BLOQUEADO: 'Bloqueado (não contatar)',
  NAO_VERIFICADO: 'Não verificado (CRM indisponível)',
});

const TONES = Object.freeze({
  estado: { AGUARDANDO_REVISAO: 'warn', APROVADO_PARA_CRM: 'ok', REJEITADO: 'bad', DUPLICADO: 'bad', DNC: 'bad', DADOS_INSUFICIENTES: 'warn' },
  identity: { VALIDADA: 'ok', NAO_VALIDADA: 'warn' },
  data: { SUFICIENTES: 'ok', PARCIAIS: 'warn', INSUFICIENTES: 'bad' },
  duplicity: { NOVO: 'ok', POSSIVEL_DUPLICADO: 'warn', DUPLICADO: 'bad', NAO_VERIFICADO: 'neutral' },
  dnc: { NAO_ENCONTRADO: 'ok', NAO_VERIFICADO: 'warn', BLOQUEADO: 'bad' },
  // tipoLead é só IDENTIFICAÇÃO (RULES: PROFISSIONAL não é um lead ruim) — nenhum tom aqui é "bad".
  tipoLead: { EMPRESA: 'ok', UNIDADE_FRANQUIA: 'ok', PROFISSIONAL: 'neutral', NAO_VERIFICADO: 'neutral' },
});

export const leadTypeText = (tipoLead) => LEAD_TYPE_LABELS[textOf(tipoLead)] || LEAD_TYPE_LABELS.NAO_VERIFICADO;

const GENERIC_ERROR = 'Não foi possível concluir a operação agora. Tente novamente em instantes.';
const MAX_SOURCES_SHOWN = 50;
const PAGE_SIZE = 15;

// ---------------------------------------------------------------------------
// Funções puras
// ---------------------------------------------------------------------------

export function labelForEstado(estado) {
  return ESTADO_LABELS[estado] || textOf(estado) || '—';
}

export function identityStatus(statusIdentidade) {
  return statusIdentidade && typeof statusIdentidade === 'object' ? textOf(statusIdentidade.status) : textOf(statusIdentidade);
}

export function identityText(statusIdentidade, { withReason = false } = {}) {
  const status = identityStatus(statusIdentidade);
  const label = status === 'VALIDADA' ? 'Validada' : status === 'NAO_VALIDADA' ? 'Não validada' : status || '—';
  const reason = statusIdentidade && typeof statusIdentidade === 'object' ? IDENTITY_REASONS[textOf(statusIdentidade.motivo)] : '';
  return withReason && reason ? `${label} (${reason})` : label;
}

export const dataText = (statusDados) => DATA_LABELS[textOf(statusDados)] || textOf(statusDados) || '—';

export function duplicityText(statusDuplicidade, matchedOn) {
  const label = DUPLICITY_LABELS[textOf(statusDuplicidade)] || textOf(statusDuplicidade) || '—';
  const criteria = Array.isArray(matchedOn) ? matchedOn.map(textOf).filter(Boolean) : [];
  return criteria.length > 0 ? `${label} (${criteria.join(', ')})` : label;
}

export const dncText = (statusDNC) => DNC_LABELS[textOf(statusDNC)] || textOf(statusDNC) || '—';

// As fontes de um prospect: cada uma vira { label, url, detail }. `url` só existe se for http(s) seguro.
export function describeSources(fontes) {
  if (!Array.isArray(fontes)) return [];
  const sources = [];
  for (const entry of fontes.slice(0, MAX_SOURCES_SHOWN)) {
    if (typeof entry === 'string') {
      const label = textOf(entry);
      if (label !== '') sources.push({ label, url: safeHttpUrl(label), detail: '' });
    } else if (entry && typeof entry === 'object') {
      const label = [entry.fonte, entry.nome, entry.descricao, entry.campo, entry.url].map(textOf).find(Boolean) || 'Fonte';
      const detail = [textOf(entry.tipoFonte), textOf(entry.campo) !== label ? textOf(entry.campo) : '', formatDateTime(entry.dataConsulta), textOf(entry.observacao)]
        .filter(Boolean)
        .join(' · ');
      sources.push({ label, url: safeHttpUrl(entry.url), detail });
    }
  }
  return sources;
}

// A mensagem para o usuário, por status. 401 devolve null: quem cuida é o fluxo de login.
export function messageForError(error) {
  const status = error && typeof error.status === 'number' ? error.status : 0;
  if (status === 401) return null;
  if (status === 403) return 'Esta conta não possui acesso a esta área.';
  if (status === 404) return 'Este item não foi encontrado. A lista foi atualizada.';
  if (status === 409) return 'Este item já foi decidido. A lista foi atualizada.';
  if (status === 400) return error.serverMessage ? `Dados inválidos: ${error.serverMessage}` : 'Dados inválidos.';
  return GENERIC_ERROR;
}

// Como a promoção terminou (o servidor devolve só isto). Qualquer outro valor é resposta inesperada.
const PROMOTION_DONE = Object.freeze(['CRIADO', 'RECONCILIADO']);
const PROMOTION_ALREADY = 'JA_PROMOVIDO';

export const PROMOTED_MESSAGE = 'Prospect promovido para o CRM.';
export const ALREADY_PROMOTED_MESSAGE = 'Este prospect já foi promovido para o CRM.';
export const PROMOTE_CONFIRM_TEXT = 'Este prospect será incluído no CRM e poderá entrar no pipeline comercial.';

// A mensagem de uma promoção que falhou. Os 409 trazem uma mensagem FIXA do servidor (duplicidade, restrição de contato,
// não aprovado...), só usada quando o código é de promoção — nada de texto interno. 401 devolve null (o login cuida).
export function promotionMessageForError(error) {
  const status = error && typeof error.status === 'number' ? error.status : 0;
  if (status === 401) return null;
  if (status === 403) return 'Sua conta não pode promover prospects para o CRM.';
  if (status === 404) return 'Este prospect não foi encontrado. A lista foi atualizada.';
  if (status === 409) {
    const fromServer = error && typeof error.code === 'string' && error.code.startsWith('PROMOTION_') ? textOf(error.serverMessage) : '';
    return fromServer || 'A promoção foi bloqueada.';
  }
  if (status === 400) return 'Não foi possível promover: identificador inválido.';
  return GENERIC_ERROR;
}

const cityUf = (snapshot) => [textOf(snapshot.cidade), textOf(snapshot.estadoUf)].filter(Boolean).join('/');

// Texto sem acento e em minúsculas: a busca ignora maiúsculas e acentos.
const fold = (value) => textOf(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const SORTS = Object.freeze([
  { value: 'empresa-asc', label: 'Empresa (A–Z)' },
  { value: 'empresa-desc', label: 'Empresa (Z–A)' },
  { value: 'data-desc', label: 'Pesquisa mais recente' },
  { value: 'data-asc', label: 'Pesquisa mais antiga' },
]);

// Filtra pela busca (empresa, cidade/UF, nicho, tipo e estado) e ordena. Não altera a lista de entrada.
export function visibleItems(items, { query = '', sort = 'empresa-asc' } = {}) {
  const needle = fold(query);
  const matches = needle === ''
    ? [...items]
    : items.filter((item) => {
        const snapshot = item.discoverySnapshot || {};
        return fold([item.empresa, cityUf(snapshot), snapshot.nicho, leadTypeText(snapshot.tipoLead), labelForEstado(item.estado)].join(' ')).includes(needle);
      });
  const nameOf = (item) => fold(item.empresa);
  const dateOf = (item) => textOf((item.discoverySnapshot || {}).dataDaPesquisa);
  const compare = {
    'empresa-asc': (a, b) => nameOf(a).localeCompare(nameOf(b), 'pt-BR'),
    'empresa-desc': (a, b) => nameOf(b).localeCompare(nameOf(a), 'pt-BR'),
    'data-desc': (a, b) => dateOf(b).localeCompare(dateOf(a)) || nameOf(a).localeCompare(nameOf(b), 'pt-BR'),
    'data-asc': (a, b) => dateOf(a).localeCompare(dateOf(b)) || nameOf(a).localeCompare(nameOf(b), 'pt-BR'),
  }[sort] || (() => 0);
  return matches.sort(compare);
}

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------

// document/root: onde desenhar. api: { listApprovals, approve, reject, promoteApproval, getLeadProfile?, getLeadResearchStatus?... } (api.mjs).
// canReview: mostra os botões de aprovar/rejeitar. canPromote: mostra "Promover para CRM" nos aprovados. canReadCrm: mostra "Ver no CRM".
// As três são conveniência de interface (vêm de /api/me); quem autoriza é o servidor.
// ui: os componentes globais da sessão (camadas e avisos); sem ele a tela cria os seus. bus: o barramento de atualização (opcional).
// navigation: { go, replace, back } do router — quando existe, a gaveta tem URL. schedule: agendador (testes).
export function createApprovalsView({ document, root, api, canReview, canPromote = false, canReadCrm = false, schedule, ui: providedUi = null, bus = null, navigation = null, pageSize = PAGE_SIZE }) {
  const state = {
    loading: true,
    items: [],
    selectedId: null,
    mode: null,
    busy: false,
    message: null,
    formError: null,
    filter: PENDING_ESTADO,
    promoted: {},
    profiles: {},
    panels: {},
    query: '',
    sort: 'empresa-asc',
    page: 1,
    tab: 'resumo',
    loadedAt: null,
    visible: false,
    drawerOpen: false,
    routeLeadId: null,
    openedByPush: false,
  };
  let destroyed = false;
  let loadToken = 0;
  let suppressNav = false;
  let drawer = null;
  let tabs = null;

  // --- estrutura estável (montada UMA vez; as regiões abaixo é que mudam) ---
  const content = h(document, 'div', { className: 'approvals-view' });
  const ownsUi = providedUi === null;
  let ui = providedUi;
  if (ownsUi) {
    const host = h(document, 'div', { className: 'overlay-host' });
    root.replaceChildren(content, host);
    ui = createUi({ document, host, getInertTargets: () => [content], ...(schedule ? { schedule } : {}) });
  } else {
    root.replaceChildren(content);
  }
  const overlays = ui.overlays;
  const toasts = ui.toasts;

  const badge = (text, tone) => statusBadge(document, text, tone);
  const selectedItem = () => state.items.find((item) => item.prospectId === state.selectedId) || null;
  const isApprovedView = () => state.filter === APPROVED_ESTADO;

  const messageRegion = h(document, 'div', { className: 'message-region' });
  const counterEl = h(document, 'p', { className: 'pending-count' });
  const listRegion = h(document, 'div', { className: 'list-region' });
  const pagerRegion = h(document, 'div', { className: 'pager-region' });
  const refreshButton = h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Atualizar', onclick: () => refresh() });
  const pendingButton = h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Pendentes', onclick: () => setFilter(PENDING_ESTADO) });
  const approvedButton = h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Aprovados', onclick: () => setFilter(APPROVED_ESTADO) });
  const search = searchField(document, {
    id: 'approvals-search',
    label: 'Buscar lead',
    placeholder: 'Empresa, cidade, nicho…',
    onInput: (value) => {
      state.query = value;
      state.page = 1;
      paintList();
    },
  });
  const sorter = selectField(document, {
    id: 'approvals-sort',
    label: 'Ordenar por',
    options: SORTS,
    value: state.sort,
    onChange: (value) => {
      state.sort = value;
      state.page = 1;
      paintList();
    },
  });

  content.append(
    h(
      document,
      'section',
      { className: 'approvals', 'aria-labelledby': 'approvals-title' },
      pageHeader(document, { title: 'Aprovações', titleId: 'approvals-title', subtitle: 'Revise cada lead: aprovar é uma triagem interna; nada aqui contata o lead nem cria registro no CRM sozinho.', actions: [refreshButton] }),
      h(
        document,
        'div',
        { className: 'toolbar' },
        h(document, 'div', { className: 'actions', role: 'group', 'aria-label': 'Filtrar por estado' }, pendingButton, approvedButton),
        search.element,
        sorter.element,
        counterEl
      ),
      messageRegion,
      h(document, 'div', { className: 'list-card' }, listRegion, pagerRegion)
    )
  );

  function setMessage(kind, text) {
    state.message = text ? { kind, text } : null;
    fill(messageRegion, state.message ? h(document, 'p', { className: `message ${state.message.kind}`, role: state.message.kind === 'error' ? 'alert' : 'status', text: state.message.text }) : null);
  }

  // Aviso + linha de status: o servidor já respondeu quando isto é chamado.
  function notify(kind, text) {
    setMessage(kind, text);
    if (kind === 'error') toasts.error(text, { key: 'approvals-feedback' });
    else if (kind === 'success') toasts.success(text, { key: 'approvals-feedback' });
    else toasts.warning(text, { key: 'approvals-feedback' });
  }

  // ---- carga ---------------------------------------------------------------

  async function load({ quiet = false } = {}) {
    const token = ++loadToken;
    state.loading = true;
    if (!quiet || state.items.length === 0) paintList();
    refreshButton.disabled = true;
    try {
      const data = await api.listApprovals(state.filter === PENDING_ESTADO ? undefined : state.filter);
      if (token !== loadToken || destroyed) return;
      state.items = Array.isArray(data && data.items) ? data.items : [];
      state.loadedAt = Date.now();
      if (state.selectedId !== null && !selectedItem() && !state.drawerOpen) {
        state.selectedId = null;
        state.mode = null;
      }
    } catch (error) {
      if (token !== loadToken || destroyed) return;
      const text = messageForError(error);
      if (text) notify('error', text);
    }
    if (token !== loadToken || destroyed) return;
    state.loading = false;
    refreshButton.disabled = false;
    paintAll();
    announceCounts();
    syncDrawerWithList();
  }

  function announceCounts() {
    if (bus && state.filter === PENDING_ESTADO) bus.publish('approvals:counts', { pending: state.items.filter((item) => item.estado === PENDING_ESTADO).length });
  }

  // A lista foi atualizada com a gaveta aberta: se o lead saiu da lista (decidido por outra pessoa), avisa e fecha; senão, atualiza o conteúdo.
  function syncDrawerWithList() {
    if (!state.drawerOpen) return;
    const item = selectedItem();
    if (!item) {
      notify('warning', 'Este lead não está mais nesta lista (já foi decidido ou removido). A lista foi atualizada.');
      closeDrawer({ silent: false, reason: 'gone' });
      return;
    }
    refreshDrawer();
  }

  function setFilter(filter) {
    if (state.busy || state.filter === filter) return undefined;
    state.filter = filter;
    state.items = [];
    state.page = 1;
    state.selectedId = null;
    state.mode = null;
    state.formError = null;
    setMessage(null);
    return load();
  }

  function refresh() {
    setMessage(null);
    return load({ quiet: true });
  }

  // O perfil comercial do lead (Implementação 3.0): buscado uma vez por lead, só por quem pode revisar; `null` = o lead não tem análise detalhada.
  async function loadProfile(prospectId) {
    if (!canReview || typeof api.getLeadProfile !== 'function' || Object.prototype.hasOwnProperty.call(state.profiles, prospectId)) return;
    state.profiles[prospectId] = undefined;
    try {
      const data = await api.getLeadProfile(prospectId);
      state.profiles[prospectId] = data && data.item ? data.item : null;
    } catch {
      delete state.profiles[prospectId]; // tenta de novo na próxima abertura
      return;
    }
    if (state.selectedId === prospectId) refreshDrawer();
  }

  // COMPLETAR PESQUISA (3.0.2): um painel por lead aberto (criado uma vez e reaproveitado, para a consulta de estado seguir). Ao terminar, o perfil é recarregado.
  function panelFor(item) {
    if (!canReview || typeof api.getLeadResearchStatus !== 'function' || typeof api.completeLeadResearch !== 'function') return null;
    if (!state.panels[item.prospectId]) {
      const panel = createEnrichmentPanel({
        document,
        api,
        prospectId: item.prospectId,
        canRun: true,
        ...(schedule ? { schedule } : {}),
        onFinished: () => {
          delete state.profiles[item.prospectId];
          loadProfile(item.prospectId);
        },
      });
      state.panels[item.prospectId] = panel;
      panel.load();
    }
    return state.panels[item.prospectId];
  }

  // ---- a gaveta do lead -------------------------------------------------------

  const rowButtonOf = (prospectId) => {
    const buttons = [];
    const visit = (node) => {
      for (const child of node.childNodes || []) {
        if (child.nodeType !== 1) continue;
        if (child.localName === 'button' && child.getAttribute('data-prospect') === prospectId) buttons.push(child);
        visit(child);
      }
    };
    visit(listRegion);
    return buttons[0] || null;
  };

  // Abre o lead (clique na lista). Com navegação, o endereço muda (#/aprovacoes/<id>) — o Voltar do navegador fecha a gaveta.
  function openLead(prospectId) {
    if (state.drawerOpen && state.selectedId === prospectId) return;
    openDrawerFor(prospectId);
    if (navigation && state.routeLeadId !== prospectId) {
      state.openedByPush = true;
      state.routeLeadId = prospectId;
      navigation.go(buildHash({ name: 'approval-lead', id: prospectId }));
    }
  }

  function openDrawerFor(prospectId) {
    const item = state.items.find((entry) => entry.prospectId === prospectId);
    if (!item) return;
    if (state.drawerOpen && drawer) closeDrawer({ silent: true, reason: 'switch' });
    state.selectedId = prospectId;
    state.mode = null;
    state.formError = null;
    setMessage(null);
    state.drawerOpen = true;
    const reopened = Boolean(state.panels[prospectId]); // painel já existe: a consulta foi pausada ao fechar e precisa retomar
    const snapshot = item.discoverySnapshot || {};
    drawer = overlays.openDrawer({
      key: `approval-lead:${prospectId}`,
      title: textOf(item.empresa) || 'Sem nome',
      subtitle: [cityUf(snapshot), textOf(snapshot.nicho)].filter(Boolean).join(' · '),
      content: buildDrawerBody(item),
      footer: buildDrawerFooter(item),
      getReturnFocus: () => rowButtonOf(prospectId),
      onClose: onDrawerClosed,
    });
    paintList();
    loadProfile(prospectId);
    const panel = state.panels[prospectId];
    if (panel && reopened) panel.load(); // retoma a consulta de estado (se a pesquisa ainda roda)
  }

  function refreshDrawer() {
    const item = selectedItem();
    if (!state.drawerOpen || !drawer || !item) return;
    drawer.setContent(buildDrawerBody(item));
    drawer.setFooter(buildDrawerFooter(item));
  }

  // Fecha a gaveta por código (rota, troca de lead, módulo): `silent` = não mexe no endereço.
  function closeDrawer({ silent = false, reason = 'api' } = {}) {
    if (!drawer) return;
    const previous = suppressNav;
    suppressNav = silent;
    const handle = drawer;
    handle.close(reason, { force: true });
    suppressNav = previous;
  }

  function onDrawerClosed() {
    const id = state.selectedId;
    state.drawerOpen = false;
    state.selectedId = null;
    state.mode = null;
    drawer = null;
    tabs = null;
    if (id && state.panels[id]) state.panels[id].pause(); // fechou: para de consultar o estado da pesquisa
    // fechar pela interface (X, ESC, fundo) com endereço de lead: volta ao da lista — Voltar do navegador, se o lead foi aberto por clique; senão, troca a entrada
    if (!suppressNav && navigation && state.routeLeadId !== null) {
      state.routeLeadId = null;
      if (state.openedByPush) navigation.back();
      else navigation.replace(buildHash({ name: 'approvals' }));
      state.openedByPush = false;
    }
    // o foco já voltou à linha; repintar a lista a substitui — então devolve o foco à linha nova
    const focused = document.activeElement;
    const hadRowFocus = Boolean(id && focused && typeof focused.getAttribute === 'function' && focused.getAttribute('data-prospect') === id);
    paintList();
    if (hadRowFocus) {
      const row = rowButtonOf(id);
      if (row) row.focus();
    }
  }

  function buildDrawerBody(item) {
    const snapshot = item.discoverySnapshot || {};
    const profileLoaded = Object.prototype.hasOwnProperty.call(state.profiles, item.prospectId) && state.profiles[item.prospectId] !== undefined;
    const profile = profileLoaded ? state.profiles[item.prospectId] : undefined;
    const ownerLine = ownerSummary(profile, profileLoaded);

    const field = (label, contentNode) => [label, contentNode];
    const textValue = (value) => {
      const text = textOf(value);
      return text === '' ? null : h(document, 'span', { text });
    };
    const linkValue = (value, options) => {
      const text = textOf(value);
      if (text === '') return null;
      const url = safeHttpUrl(text, options);
      return url ? h(document, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer', text }) : h(document, 'span', { text });
    };

    const indicator = (label, node) => h(document, 'div', { className: 'indicator' }, h(document, 'span', { className: 'indicator-label', text: label }), node);
    const facts = kvList(
      document,
      [
        field('Tipo de lead', badge(leadTypeText(snapshot.tipoLead), TONES.tipoLead[textOf(snapshot.tipoLead)])),
        field('Tipo', textValue(snapshot.tipo)),
        field('Pesquisado em', textValue(formatDate(snapshot.dataDaPesquisa))),
      ]
    );
    const notes = kvList(document, [field('Hipótese de oportunidade', textValue(snapshot.hipoteseDeOportunidade)), field('Observações', textValue(snapshot.observacoes))]);

    const summary = h(
      document,
      'div',
      { className: 'lead-summary' },
      section(document, 'Identidade', facts),
      section(
        document,
        'Situação comercial',
        h(
          document,
          'div',
          { className: 'indicator-grid' },
          indicator('Estado na fila', badge(labelForEstado(item.estado), TONES.estado[item.estado])),
          indicator('Verificação', badge(identityText(snapshot.statusIdentidade, { withReason: true }), TONES.identity[identityStatus(snapshot.statusIdentidade)])),
          indicator('Dados', badge(dataText(snapshot.statusDados), TONES.data[textOf(snapshot.statusDados)])),
          indicator('Duplicidade', badge(duplicityText(snapshot.statusDuplicidade, snapshot.matchedOn), TONES.duplicity[textOf(snapshot.statusDuplicidade)])),
          indicator('DNC', badge(dncText(snapshot.statusDNC), TONES.dnc[textOf(snapshot.statusDNC)]))
        )
      ),
      section(document, 'Responsável', ownerCard(ownerLine)),
      notes.children.length > 0 ? section(document, 'Notas da pesquisa', notes) : null
    );

    const contacts = kvList(document, [
      field('Site', linkValue(snapshot.site, { assumeHttps: true })),
      field('Instagram', linkValue(snapshot.instagram)),
      field('Facebook', linkValue(snapshot.facebook)),
      field('LinkedIn', linkValue(snapshot.linkedin)),
      field('YouTube', linkValue(snapshot.youtube)),
      field('Telefone', textValue(snapshot.telefone)),
      field('WhatsApp', textValue(snapshot.whatsapp)),
      field('E-mail', textValue(snapshot.email)),
      field('Endereço', textValue(snapshot.endereco)),
    ]);

    const sources = renderSources(snapshot.fontes);
    const history = renderHistory(item.historico);
    const researchEnabled = canReview && typeof api.getLeadProfile === 'function';
    const panel = panelFor(item);

    const list = [
      { key: 'resumo', label: 'Resumo', content: summary },
      { key: 'contatos', label: 'Contatos e canais', content: contacts.children.length > 0 ? contacts : emptyState(document, { title: 'Sem contatos informados', text: 'A pesquisa não encontrou site, redes, telefone, WhatsApp ou e-mail para este lead.' }) },
    ];
    if (researchEnabled) {
      list.push({
        key: 'pesquisa',
        label: 'Pesquisa comercial',
        content: section(document, 'Análise comercial', profileLoaded ? buildLeadProfile(document, profile) : h(document, 'span', { className: 'muted', text: 'Carregando…' }), panel ? panel.element : null),
      });
    }
    list.push({ key: 'fontes', label: 'Fontes', badge: sources ? String(describeSources(snapshot.fontes).length) : undefined, content: sources ? section(document, 'Fontes', sources) : emptyState(document, { title: 'Sem fontes registradas' }) });
    list.push({ key: 'historico', label: 'Histórico', content: history ? section(document, 'Histórico', history) : emptyState(document, { title: 'Sem histórico' }) });

    tabs = createTabs(document, { idPrefix: 'lead', label: 'Seções do lead', tabs: list, active: state.tab, onChange: (key) => { state.tab = key; } });
    return h(document, 'div', { className: 'lead-drawer-body' }, tabs.element);
  }

  // O responsável: nome e cargo com espaço próprio e o nível de verificação. PENDENTE_DE_CONFIRMACAO nunca parece validado.
  function ownerCard(owner) {
    const classes = ['owner-card', owner.tone ? `owner-${owner.tone}` : null].filter(Boolean).join(' ');
    return h(
      document,
      'div',
      { className: classes },
      h(document, 'div', { className: 'owner-main' }, h(document, 'span', { className: 'owner-name', text: owner.name }), owner.role ? h(document, 'span', { className: 'owner-role', text: owner.role }) : null),
      owner.badge,
      owner.note ? h(document, 'p', { className: 'owner-note', text: owner.note }) : null
    );
  }

  // O responsável e o nível de verificação, a partir do perfil comercial (quando carregado). Nunca afirma mais do que o perfil diz.
  function ownerSummary(profile, loaded) {
    if (!canReview || typeof api.getLeadProfile !== 'function') return { name: 'Disponível para quem revisa os leads', role: '', badge: null, note: null, tone: 'muted' };
    if (!loaded) return { name: 'Carregando…', role: '', badge: null, note: null, tone: 'muted' };
    const owner = profile && profile.responsavel ? profile.responsavel : null;
    if (!owner) return { name: 'Sem análise comercial', role: '', badge: null, note: null, tone: 'muted' };
    const name = textOf(owner.nome) || 'Informado';
    const role = textOf(owner.cargo);
    if (owner.status === 'ENCONTRADO') return { name, role, badge: badge('Confirmado', 'ok'), note: null, tone: 'ok' };
    if (owner.status === 'PENDENTE_DE_CONFIRMACAO') return { name, role, badge: badge('Pendente de confirmação', 'warn'), note: 'Ainda não validado: confirme antes de tratar esta pessoa como a responsável.', tone: 'warn' };
    return { name: 'Não encontrado', role: '', badge: badge('Não verificado', 'neutral'), note: null, tone: 'muted' };
  }

  function renderSources(fontes) {
    const sources = describeSources(fontes);
    if (sources.length === 0) return null;
    return h(
      document,
      'ul',
      { className: 'plain' },
      ...sources.map((source) =>
        h(
          document,
          'li',
          {},
          source.url ? h(document, 'a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: source.label }) : h(document, 'span', { text: source.label }),
          source.detail ? h(document, 'span', { className: 'muted', text: ` — ${source.detail}` }) : null
        )
      )
    );
  }

  function renderHistory(historico) {
    if (!Array.isArray(historico) || historico.length === 0) return null;
    return h(
      document,
      'ol',
      { className: 'plain' },
      ...historico.map((entry) => {
        const who = entry && entry.actor === 'HUMAN' && entry.reviewedBy ? `${textOf(entry.reviewedBy.name)} (${textOf(entry.reviewedBy.role)})` : 'Sistema';
        const line = [formatDateTime(entry && entry.timestamp), `${entry && entry.from ? labelForEstado(entry.from) : 'Início'} → ${labelForEstado(entry && entry.to)}`, who].join(' · ');
        const reason = entry && textOf(entry.motivo) ? `: ${textOf(entry.motivo)}` : '';
        return h(document, 'li', { text: `${line}${reason}` });
      })
    );
  }

  // O id do registro do CRM que ESTE prospect já tem — só o que o servidor informou (a resposta da promoção ou o
  // item.promocao da fila). Nunca inventado nem montado a partir do nome.
  function promotedRecordId(item) {
    const fromResponse = Object.prototype.hasOwnProperty.call(state.promoted, item.prospectId) ? state.promoted[item.prospectId] : null;
    if (typeof fromResponse === 'string' && fromResponse !== '') return fromResponse;
    const promocao = item.promocao;
    if (promocao && typeof promocao === 'object' && promocao.resultado !== 'BLOQUEADO' && typeof promocao.crmRecordId === 'string' && promocao.crmRecordId !== '') {
      return promocao.crmRecordId;
    }
    return null;
  }

  // As ações do rodapé da gaveta: nenhuma começa sozinha — cada uma abre uma confirmação humana.
  function buildDrawerFooter(item) {
    const pending = item.estado === PENDING_ESTADO;
    if (pending && canReview) {
      return h(
        document,
        'div',
        { className: 'drawer-actions' },
        h(document, 'button', { type: 'button', className: 'btn primary', text: 'Aprovar', disabled: state.busy, onclick: () => openDecision('approve') }),
        h(document, 'button', { type: 'button', className: 'btn danger', text: 'Rejeitar', disabled: state.busy, onclick: () => openDecision('reject') }),
        h(document, 'p', { className: 'muted note', text: 'Aprovar é uma triagem interna: não cria registro no CRM nem autoriza contato.' })
      );
    }
    if (pending) return h(document, 'p', { className: 'muted', text: 'Sua conta não pode aprovar ou rejeitar prospects.' });
    if (item.estado === APPROVED_ESTADO) {
      const recordId = promotedRecordId(item);
      if (recordId !== null) {
        return h(document, 'div', { className: 'promotion' }, h(document, 'p', { className: 'muted', text: ALREADY_PROMOTED_MESSAGE }), canReadCrm ? h(document, 'a', { className: 'btn secondary', href: buildHash({ name: 'crm-record', id: recordId }), text: 'Ver no CRM' }) : null);
      }
      if (!canPromote) return h(document, 'p', { className: 'muted', text: 'Sua conta não pode promover prospects para o CRM.' });
      return h(document, 'div', { className: 'actions' }, h(document, 'button', { type: 'button', className: 'btn primary', text: 'Promover para CRM', disabled: state.busy, onclick: () => openPromotion() }));
    }
    return h(document, 'p', { className: 'muted', text: 'Este item já foi decidido ou está bloqueado.' });
  }

  // ---- decisões (aprovar / rejeitar) e promoção: SEMPRE por confirmação humana ------------------

  function openDecision(mode) {
    const item = selectedItem();
    if (!item || state.busy || (mode !== 'approve' && mode !== 'reject') || !canReview) return;
    const approving = mode === 'approve';
    state.mode = mode;
    state.formError = null;
    overlays.openConfirm({
      key: `decision:${item.prospectId}`,
      title: approving ? 'Confirmar aprovação' : 'Confirmar rejeição',
      message: `Prospect: ${textOf(item.empresa) || 'Sem nome'}`,
      detail: approving ? 'A aprovação é uma triagem interna: não cria registro no CRM nem autoriza contato.' : undefined,
      tone: approving ? 'primary' : 'danger',
      confirmLabel: approving ? 'Confirmar aprovação' : 'Confirmar rejeição',
      field: { id: 'reason-input', label: approving ? 'Motivo (opcional)' : 'Motivo (obrigatório)', required: !approving, requiredMessage: 'Informe o motivo da rejeição.' },
      onConfirm: (reason) => decide(item, mode, reason),
      onClose: () => { state.mode = null; },
      getReturnFocus: () => drawer && drawer.element.parentNode ? findByText(drawer.element, approving ? 'Aprovar' : 'Rejeitar') : null,
    });
  }

  function findByText(container, text) {
    const stack = [container];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.childNodes || []) {
        if (child.nodeType !== 1) continue;
        if (child.localName === 'button' && child.textContent === text) return child;
        stack.push(child);
      }
    }
    return null;
  }

  async function decide(item, mode, reason) {
    if (state.busy) return;
    state.busy = true;
    refreshDrawerFooter();
    try {
      if (mode === 'approve') await api.approve(item.prospectId, reason || undefined);
      else await api.reject(item.prospectId, reason);
    } catch (error) {
      state.busy = false;
      const text = messageForError(error) || GENERIC_ERROR;
      setMessage('error', text);
      if (error && (error.status === 409 || error.status === 404)) {
        // o item já não está na fila como estava: avisa, fecha a gaveta e atualiza a lista
        toasts.error(text, { key: 'approvals-feedback' });
        closeDrawer({ silent: false, reason: 'gone' });
        load({ quiet: true });
        throw Object.assign(new Error(text), { closeDialog: true });
      }
      refreshDrawerFooter();
      throw new Error(text); // a confirmação mostra o erro e MANTÉM o motivo digitado
    }
    // confirmado pelo servidor: só agora há sucesso para mostrar
    state.busy = false;
    notify('success', mode === 'approve' ? 'Prospect aprovado.' : 'Prospect rejeitado.');
    if (bus) bus.publish('approvals:changed', { action: mode, prospectId: item.prospectId });
    closeDrawer({ silent: false, reason: 'decided' });
    load({ quiet: true });
  }

  function refreshDrawerFooter() {
    const item = selectedItem();
    if (drawer && item) drawer.setFooter(buildDrawerFooter(item));
  }

  function openPromotion() {
    const item = selectedItem();
    if (!item || state.busy || !canPromote || item.estado !== APPROVED_ESTADO) return;
    state.mode = 'promote';
    overlays.openConfirm({
      key: `promotion:${item.prospectId}`,
      title: 'Promover para o CRM',
      message: `Prospect: ${textOf(item.empresa) || 'Sem nome'}`,
      detail: PROMOTE_CONFIRM_TEXT,
      confirmLabel: 'Promover',
      busyLabel: 'Promovendo…',
      onConfirm: () => promote(item),
      onClose: () => { state.mode = null; },
      getReturnFocus: () => drawer && drawer.element.parentNode ? findByText(drawer.element, 'Promover para CRM') : null,
    });
  }

  async function promote(item) {
    // busy: um segundo clique (ou um botão antigo ainda na tela) nunca dispara uma segunda requisição.
    if (state.busy || state.mode !== 'promote' || !canPromote || item.estado !== APPROVED_ESTADO) return;
    state.busy = true;
    setMessage(null);
    refreshDrawerFooter();
    try {
      const result = await api.promoteApproval(item.prospectId);
      const outcome = result && typeof result === 'object' ? result.outcome : null;
      const crmRecordId = result && typeof result === 'object' ? result.crmRecordId : null;
      if (!(PROMOTION_DONE.includes(outcome) || outcome === PROMOTION_ALREADY) || typeof crmRecordId !== 'string' || crmRecordId === '') {
        throw new Error('resposta inesperada');
      }
      state.promoted[item.prospectId] = crmRecordId;
      const base = outcome === PROMOTION_ALREADY ? ALREADY_PROMOTED_MESSAGE : PROMOTED_MESSAGE;
      state.busy = false;
      notify('success', result.possivelDuplicidade === true ? `${base} Atenção: há sinal de possível duplicidade no CRM — confira o registro.` : base);
      if (bus) {
        bus.publish('approvals:changed', { action: 'promote', prospectId: item.prospectId });
        bus.publish('crm:changed', { prospectId: item.prospectId, crmRecordId });
      }
      refreshDrawer();
      load({ quiet: true });
    } catch (error) {
      state.busy = false;
      const text = promotionMessageForError(error) || GENERIC_ERROR;
      notify('error', text);
      if (error && error.status === 404) {
        closeDrawer({ silent: false, reason: 'gone' });
        load({ quiet: true });
      } else if (error && error.status === 409) {
        load({ quiet: true });
      } else {
        refreshDrawerFooter();
      }
      throw Object.assign(new Error(text), { closeDialog: true }); // a mensagem fica na tela; a confirmação sai
    }
  }

  // ---- desenho das regiões ----------------------------------------------------------

  function filtered() {
    return visibleItems(state.items, { query: state.query, sort: state.sort });
  }

  function paintAll() {
    pendingButton.setAttribute('aria-pressed', isApprovedView() ? 'false' : 'true');
    approvedButton.setAttribute('aria-pressed', isApprovedView() ? 'true' : 'false');
    paintList();
  }

  function paintList() {
    pendingButton.setAttribute('aria-pressed', isApprovedView() ? 'false' : 'true');
    approvedButton.setAttribute('aria-pressed', isApprovedView() ? 'true' : 'false');
    pendingButton.disabled = state.busy;
    approvedButton.disabled = state.busy;
    const approved = isApprovedView();
    const count = state.items.filter((item) => item.estado === (approved ? APPROVED_ESTADO : PENDING_ESTADO)).length;
    const countText = approved ? `${count} ${count === 1 ? 'aprovado' : 'aprovados'}` : `${count} ${count === 1 ? 'pendente' : 'pendentes'}`;
    const shown = filtered();
    counterEl.textContent = state.query.trim() !== '' && shown.length !== state.items.length ? `${countText} · ${shown.length} na busca` : countText;

    if (state.loading && state.items.length === 0) {
      fill(listRegion, skeleton(document, { rows: 6, label: 'Carregando a fila…' }));
      fill(pagerRegion);
      return;
    }
    if (state.items.length === 0) {
      fill(listRegion, emptyState(document, { title: approved ? 'Nenhum prospect aprovado.' : 'Nenhum prospect aguardando revisão.', text: approved ? 'Os leads aprovados na triagem aparecem aqui até serem promovidos.' : 'Quando uma prospecção entregar leads, eles aparecem aqui para revisão.' }));
      fill(pagerRegion);
      return;
    }
    if (shown.length === 0) {
      fill(listRegion, emptyState(document, { title: 'Nenhum lead encontrado', text: 'Nada na lista combina com a busca. Ajuste ou limpe o termo para ver todos.' }));
      fill(pagerRegion);
      return;
    }
    const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
    state.page = Math.min(Math.max(1, state.page), pageCount);
    const slice = shown.slice((state.page - 1) * pageSize, state.page * pageSize);
    fill(listRegion, buildTable(slice, approved));
    fill(pagerRegion, pagination(document, { page: state.page, pageCount, total: shown.length, pageSize, onPage: (next) => { state.page = next; paintList(); } }));
  }

  function buildTable(rows, approved) {
    const head = h(document, 'tr', {}, ...['Empresa', 'Tipo', 'Estado', 'Identidade', 'Dados', 'Pesquisa'].map((title) => h(document, 'th', { scope: 'col', text: title })));
    const body = rows.map((item) => {
      const snapshot = item.discoverySnapshot || {};
      const selected = item.prospectId === state.selectedId;
      return h(
        document,
        'tr',
        { className: selected ? 'queue-row selected' : 'queue-row', onclick: () => openLead(item.prospectId) },
        h(
          document,
          'td',
          { 'data-label': 'Empresa' },
          h(
            document,
            'div',
            { className: 'company-cell' },
            h(document, 'button', { type: 'button', className: 'company-name', 'data-prospect': item.prospectId, text: textOf(item.empresa) || 'Sem nome', 'aria-current': selected ? 'true' : null }),
            h(document, 'span', { className: 'company-meta', text: [cityUf(snapshot), textOf(snapshot.nicho)].filter(Boolean).join(' · ') || '—' })
          )
        ),
        h(document, 'td', { 'data-label': 'Tipo' }, badge(leadTypeText(snapshot.tipoLead), TONES.tipoLead[textOf(snapshot.tipoLead)])),
        h(document, 'td', { 'data-label': 'Estado' }, badge(labelForEstado(item.estado), TONES.estado[item.estado])),
        h(document, 'td', { 'data-label': 'Identidade' }, badge(identityText(snapshot.statusIdentidade), TONES.identity[identityStatus(snapshot.statusIdentidade)])),
        h(document, 'td', { 'data-label': 'Dados' }, badge(dataText(snapshot.statusDados), TONES.data[textOf(snapshot.statusDados)])),
        h(document, 'td', { 'data-label': 'Pesquisa', text: formatDate(snapshot.dataDaPesquisa) || '—' })
      );
    });
    return h(
      document,
      'div',
      { className: 'table-wrap' },
      h(document, 'table', { className: 'list queue' }, h(document, 'caption', { className: 'visually-hidden', text: approved ? 'Prospects aprovados' : 'Prospects aguardando revisão' }), h(document, 'thead', {}, head), h(document, 'tbody', {}, ...body))
    );
  }

  function render() {
    paintAll();
    setMessage(state.message ? state.message.kind : null, state.message ? state.message.text : null);
  }

  // ---- roteamento (chamado pelo shell a cada mudança de #) ------------------------------------

  async function locate(prospectId) {
    if (state.items.some((item) => item.prospectId === prospectId)) return true;
    if (state.loadedAt === null) await load();
    if (state.items.some((item) => item.prospectId === prospectId)) return true;
    // o lead pode estar na outra lista (aprovado, ou ainda pendente): procura nela UMA vez
    const other = isApprovedView() ? PENDING_ESTADO : APPROVED_ESTADO;
    try {
      const data = await api.listApprovals(other === PENDING_ESTADO ? undefined : other);
      const items = Array.isArray(data && data.items) ? data.items : [];
      if (items.some((item) => item.prospectId === prospectId)) {
        state.filter = other;
        state.items = items;
        state.page = 1;
        paintAll();
        return true;
      }
    } catch {
      // sem a outra lista, o lead não é localizado
    }
    return false;
  }

  async function show(route) {
    if (destroyed) return;
    const entering = !state.visible;
    state.visible = true;
    if (route && route.name === 'approval-lead') {
      state.routeLeadId = route.id;
      if (state.drawerOpen && state.selectedId === route.id) return;
      if (entering && state.loadedAt !== null) load({ quiet: true });
      const found = await locate(route.id);
      if (destroyed || state.routeLeadId !== route.id) return;
      if (!found) {
        notify('warning', 'Este lead não foi encontrado na fila (já foi decidido ou removido).');
        state.routeLeadId = null;
        if (navigation) navigation.replace(buildHash({ name: 'approvals' }));
        return;
      }
      openDrawerFor(route.id);
      return;
    }
    // rota da lista: fecha a gaveta (se estiver aberta) sem mexer no endereço; só atualiza se o módulo estava fora de cena
    state.routeLeadId = null;
    state.openedByPush = false;
    if (state.drawerOpen) closeDrawer({ silent: true, reason: 'route' });
    if (state.loadedAt === null) await load();
    else if (entering) load({ quiet: true });
    else paintAll();
  }

  // O módulo saiu de cena (outro item do menu): as camadas fecham, as consultas de estado param; busca, filtro e página ficam guardados.
  function hide() {
    state.visible = false;
    state.routeLeadId = null;
    state.openedByPush = false;
    const previous = suppressNav;
    suppressNav = true; // o endereço já mudou (o usuário saiu do módulo): fechar a gaveta não navega de volta
    overlays.closeAll();
    suppressNav = previous;
    for (const panel of Object.values(state.panels)) panel.pause();
  }

  const unsubscribe = [];

  paintAll();

  return {
    load,
    render,
    state,
    show,
    hide,
    refresh,
    openLead,
    closeLead: () => closeDrawer({ silent: false, reason: 'api' }),
    destroy() {
      destroyed = true;
      for (const stop of unsubscribe) stop();
      for (const panel of Object.values(state.panels)) panel.destroy();
      closeDrawer({ silent: true, reason: 'destroy' });
      if (ownsUi) ui.destroy();
    },
  };
}
