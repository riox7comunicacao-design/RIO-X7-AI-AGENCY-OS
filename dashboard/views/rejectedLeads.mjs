// Tela LEADS REPROVADOS — os leads que NÃO estão ativos na Approval Queue (rejeitados por um humano, dados insuficientes, duplicados, DNC e expirados),
// com todos os dados comerciais já pesquisados, o motivo, a data, quem decidiu e o job de origem. NADA é apagado aqui. Segunda tela da UX 4.0, no mesmo
// padrão da Approval Queue: lista com busca, ordenação e paginação (linha inteira clicável) e uma GAVETA por lead, com URL.
//
//   Browser -> esta tela -> api.mjs -> GET  /api/leads/reprovados?filtro=...              -> Lead Reconsideration Service
//                                   -> POST /api/leads/reprovados/:id/reaprovar { reason } -> Lead Reconsideration Service
//
// "RECONSIDERAR" (o serviço chama de reaprovar) NÃO pesquisa de novo, NÃO aprova e NÃO cria nada no CRM: só devolve um lead rejeitado por um humano à
// Approval Queue (AGUARDANDO_REVISAO), depois de o SERVIDOR checar as barreiras (já no CRM, DNC, duplicidade, exclusão permanente). Um humano ainda
// decide (aprovar) e depois promove, explicitamente. DNC é uma restrição de contato, não uma rejeição comercial: nunca aparece com o botão de
// reconsiderar. A justificativa é OPCIONAL (a regra do serviço não a exige); a confirmação humana é sempre pedida.
//
// NAVEGAÇÃO: a gaveta tem URL (#/prospeccao/leads-reprovados/<id>): o link direto abre o lead, o Voltar do navegador fecha a gaveta sem sair do
// módulo e o Avançar a reabre. A tela é PERSISTENTE na sessão: trocar de módulo e voltar mantém filtro, busca, ordem e página; ao voltar, os dados
// são atualizados em silêncio (uma requisição).
//
// PERMISSÕES: APPROVE:LEAD_APPROVAL (`canReview`) — o servidor decide de verdade; isto só mostra/esconde controles. Dados NÃO CONFIÁVEIS: tudo entra
// por dom.mjs (textContent); um endereço só vira link se for http(s). Nenhuma pesquisa, aprovação ou promoção começa sozinha.

import { h, fill } from '../dom.mjs';
import { textOf, formatDate, formatDateTime, safeHttpUrl } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { buildLeadProfile } from './leadProfile.mjs';
import { createEnrichmentPanel } from './leadEnrichmentPanel.mjs';
import { identityText, identityStatus, dataText, duplicityText, dncText, leadTypeText, describeSources, ESTADO_LABELS } from './approvals.mjs';
import { createUi, statusBadge, emptyState, skeleton, pageHeader, kvList, section, searchField, selectField, pagination, createTabs } from '../ui/index.mjs';

export const FILTERS = Object.freeze([
  ['TODOS', 'Todos'],
  ['REPROVADOS', 'Reprovados'],
  ['DADOS_INSUFICIENTES', 'Dados insuficientes'],
  ['DUPLICADOS', 'Duplicados'],
  ['DNC', 'DNC'],
  ['EXPIRADOS', 'Expirados'],
]);
const STATE_LABELS = Object.freeze({ REJEITADO: 'Reprovado', DADOS_INSUFICIENTES: 'Dados insuficientes', DUPLICADO: 'Duplicado', DNC: 'DNC', EXPIRADO: 'Expirado' });
const STATE_TONES = Object.freeze({ REJEITADO: 'bad', DADOS_INSUFICIENTES: 'warn', DUPLICADO: 'warn', DNC: 'bad', EXPIRADO: 'neutral' });
const SORTS = Object.freeze([
  { value: 'decisao-desc', label: 'Decisão mais recente' },
  { value: 'decisao-asc', label: 'Decisão mais antiga' },
  { value: 'empresa-asc', label: 'Empresa (A–Z)' },
  { value: 'empresa-desc', label: 'Empresa (Z–A)' },
]);
const PAGE_SIZE = 15;
const GENERIC_ERROR = 'Não foi possível concluir agora. Tente novamente em instantes.';
const RECONSIDERED_NOTE = 'Devolve o lead à Approval Queue (aguardando revisão). Não pesquisa de novo, não aprova e não cria registro no CRM: um humano ainda precisa aprovar e promover.';

const messageFor = (error) => (error && typeof error.serverMessage === 'string' && error.serverMessage !== '' ? error.serverMessage : GENERIC_ERROR);
const cityUf = (snapshot) => [textOf(snapshot.cidade), textOf(snapshot.estadoUf)].filter(Boolean).join('/');
const fold = (value) => textOf(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const snapshotOf = (item) => (item && item.dadosComerciais && typeof item.dadosComerciais === 'object' ? item.dadosComerciais : {});
const stateLabel = (estado) => STATE_LABELS[estado] || textOf(estado) || '—';

// Quem decidiu: o nome (e o papel) de um humano, ou o sistema. Nunca inventa uma pessoa que o servidor não informou.
export function deciderText(item) {
  if (item && item.reprovadoPor) return [textOf(item.reprovadoPor.name), textOf(item.reprovadoPor.role) ? `(${textOf(item.reprovadoPor.role)})` : ''].filter(Boolean).join(' ') || 'Não registrado';
  return item && item.origemDaDecisao === 'HUMANO' ? 'Não registrado' : 'Sistema (automático)';
}

// Filtra pela busca (empresa, cidade/UF, nicho, motivo e situação; ignora maiúsculas e acentos) e ordena. Não altera a lista de entrada.
export function visibleRejected(items, { query = '', sort = 'decisao-desc' } = {}) {
  const needle = fold(query);
  const matches = needle === '' ? [...items] : items.filter((item) => fold([item.empresa, cityUf(snapshotOf(item)), snapshotOf(item).nicho, item.motivo, stateLabel(item.estado)].join(' ')).includes(needle));
  const nameOf = (item) => fold(item.empresa);
  const dateOf = (item) => textOf(item.reprovadoEm);
  const compare = {
    'decisao-desc': (a, b) => dateOf(b).localeCompare(dateOf(a)) || nameOf(a).localeCompare(nameOf(b), 'pt-BR'),
    'decisao-asc': (a, b) => dateOf(a).localeCompare(dateOf(b)) || nameOf(a).localeCompare(nameOf(b), 'pt-BR'),
    'empresa-asc': (a, b) => nameOf(a).localeCompare(nameOf(b), 'pt-BR'),
    'empresa-desc': (a, b) => nameOf(b).localeCompare(nameOf(a), 'pt-BR'),
  }[sort] || (() => 0);
  return matches.sort(compare);
}

// document/root: onde desenhar. api: { listRejectedLeads, reapproveLead, getLeadProfile?, getLeadResearchStatus?, completeLeadResearch? } (api.mjs).
// permissions.canReview: mostra o botão (conveniência; o servidor autoriza). ui/bus/navigation: os da sessão (opcionais). schedule: agendador (testes).
export function createRejectedLeadsView({ document, root, api, permissions, schedule, ui: providedUi = null, bus = null, navigation = null, pageSize = PAGE_SIZE }) {
  const canReview = Boolean(permissions && permissions.canReview);
  const state = {
    status: 'idle',
    error: null,
    items: [],
    filtro: 'TODOS',
    query: '',
    sort: 'decisao-desc',
    page: 1,
    tab: 'resumo',
    selectedId: null,
    drawerOpen: false,
    busy: false,
    message: null,
    profiles: {},
    panels: {},
    loadedAt: null,
    visible: false,
    routeLeadId: null,
    openedByPush: false,
  };
  let destroyed = false;
  let loadToken = 0;
  let suppressNav = false;
  let drawer = null;
  let tabs = null;

  // --- estrutura estável (montada UMA vez; as regiões abaixo é que mudam) ---
  const content = h(document, 'div', { className: 'approvals-view rejected-view' });
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

  const messageRegion = h(document, 'div', { className: 'message-region' });
  const counterEl = h(document, 'p', { className: 'pending-count toolbar-count' });
  const listRegion = h(document, 'div', { className: 'list-region' });
  const pagerRegion = h(document, 'div', { className: 'pager-region' });
  const refreshButton = h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Atualizar', onclick: () => refresh() });
  const filterButtons = FILTERS.map(([value, label]) => h(document, 'button', { type: 'button', className: 'btn secondary', 'data-filter': value, text: label, onclick: () => setFilter(value) }));
  const search = searchField(document, {
    id: 'rejected-search',
    label: 'Buscar lead',
    placeholder: 'Empresa, cidade, nicho…',
    onInput: (value) => {
      state.query = value;
      state.page = 1;
      paintList();
    },
  });
  const sorter = selectField(document, {
    id: 'rejected-sort',
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
      { className: 'approvals', id: 'rejected-leads', 'aria-labelledby': 'rejected-title' },
      pageHeader(document, { title: 'Leads Reprovados', titleId: 'rejected-title', subtitle: 'Nada é apagado: aqui ficam os leads que passaram pela Approval Queue e saíram dela, com tudo o que já foi pesquisado. Candidatos descartados durante a prospecção ficam no Histórico de prospecções.', actions: [refreshButton] }),
      h(
        document,
        'div',
        { className: 'toolbar toolbar-stacked' },
        // linha 1: as CATEGORIAS (filtros do servidor); linha 2: BUSCA e ORDEM, com o contador à direita (nunca espremido entre os campos)
        h(document, 'div', { className: 'toolbar-row toolbar-filters' }, h(document, 'div', { className: 'actions filter-bar', role: 'group', 'aria-label': 'Filtrar leads reprovados' }, ...filterButtons)),
        h(document, 'div', { className: 'toolbar-row toolbar-tools' }, search.element, sorter.element, counterEl)
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
    setMessage(kind === 'success' ? 'ok' : kind, text);
    if (kind === 'error') toasts.error(text, { key: 'rejected-feedback' });
    else if (kind === 'success') toasts.success(text, { key: 'rejected-feedback' });
    else toasts.warning(text, { key: 'rejected-feedback' });
  }

  // ---- carga ---------------------------------------------------------------

  async function load({ quiet = false } = {}) {
    const token = ++loadToken;
    state.status = quiet && state.items.length > 0 ? 'ready' : 'loading';
    refreshButton.disabled = true;
    paintAll();
    let failure = null;
    try {
      const data = await api.listRejectedLeads(state.filtro);
      if (token !== loadToken || destroyed) return;
      state.items = Array.isArray(data && data.items) ? data.items : [];
      state.loadedAt = Date.now();
      state.error = null;
    } catch (error) {
      if (token !== loadToken || destroyed) return;
      failure = messageFor(error);
    }
    state.status = failure && state.items.length === 0 ? 'error' : 'ready';
    state.error = failure && state.items.length === 0 ? failure : null;
    refreshButton.disabled = false;
    if (failure && state.items.length > 0) notify('error', failure); // a lista que já estava na tela fica; o erro aparece como aviso
    paintAll();
    syncDrawerWithList();
  }

  function refresh() {
    setMessage(null);
    return load({ quiet: true });
  }

  function setFilter(filtro) {
    if (state.busy || state.filtro === filtro) return undefined;
    state.filtro = filtro;
    state.items = [];
    state.page = 1;
    setMessage(null);
    if (state.drawerOpen) closeDrawer({ silent: false, reason: 'filter' });
    return load();
  }

  // A lista foi atualizada com a gaveta aberta: se o lead saiu da lista (reconsiderado por outra pessoa), avisa e fecha; senão, atualiza o conteúdo.
  function syncDrawerWithList() {
    if (!state.drawerOpen) return;
    if (!selectedItem()) {
      notify('warning', 'Este lead não está mais nesta lista (já foi reconsiderado ou removido). A lista foi atualizada.');
      closeDrawer({ silent: false, reason: 'gone' });
      return;
    }
    refreshDrawer();
  }

  // O perfil comercial APRESENTADO pelo servidor (um responsável sem vínculo demonstrado vem como PENDENTE_DE_CONFIRMACAO), buscado uma vez por lead.
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

  // COMPLETAR PESQUISA / REVER SITE OFICIAL também aqui (3.0.2), com as MESMAS permissões. A pesquisa NÃO muda o estado do lead: ele continua reprovado
  // (ou o que for); reconsiderar, aprovar ou promover são ações humanas SEPARADAS. Um painel por lead aberto, criado uma vez e reaproveitado.
  function panelFor(item) {
    if (!canReview || typeof api.getLeadResearchStatus !== 'function' || typeof api.completeLeadResearch !== 'function') return null;
    if (!state.panels[item.prospectId]) {
      const panel = createEnrichmentPanel({ document, api, prospectId: item.prospectId, canRun: true, ...(schedule ? { schedule } : {}), onFinished: () => load({ quiet: true }) });
      state.panels[item.prospectId] = panel;
      panel.load();
    }
    return state.panels[item.prospectId];
  }

  // ---- a gaveta do lead -------------------------------------------------------

  const rowButtonOf = (prospectId) => {
    const stack = [listRegion];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.childNodes || []) {
        if (child.nodeType !== 1) continue;
        if (child.localName === 'button' && child.getAttribute('data-prospect') === prospectId) return child;
        stack.push(child);
      }
    }
    return null;
  };

  // Abre o lead (clique na linha). Com navegação, o endereço muda — o Voltar do navegador fecha a gaveta.
  function openLead(prospectId) {
    if (state.drawerOpen && state.selectedId === prospectId) return;
    openDrawerFor(prospectId);
    if (navigation && state.routeLeadId !== prospectId) {
      state.openedByPush = true;
      state.routeLeadId = prospectId;
      navigation.go(buildHash({ name: 'rejected-lead', id: prospectId }));
    }
  }

  function openDrawerFor(prospectId) {
    const item = state.items.find((entry) => entry.prospectId === prospectId);
    if (!item) return;
    if (state.drawerOpen && drawer) closeDrawer({ silent: true, reason: 'switch' });
    state.selectedId = prospectId;
    setMessage(null);
    state.drawerOpen = true;
    const reopened = Boolean(state.panels[prospectId]); // painel já existe: a consulta foi pausada ao fechar e precisa retomar
    const snapshot = snapshotOf(item);
    drawer = overlays.openDrawer({
      key: `rejected-lead:${prospectId}`,
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
    if (panel && reopened) panel.load();
  }

  function refreshDrawer() {
    const item = selectedItem();
    if (!state.drawerOpen || !drawer || !item) return;
    drawer.setContent(buildDrawerBody(item));
    drawer.setFooter(buildDrawerFooter(item));
  }

  function refreshDrawerFooter() {
    const item = selectedItem();
    if (drawer && item) drawer.setFooter(buildDrawerFooter(item));
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
    drawer = null;
    tabs = null;
    if (id && state.panels[id]) state.panels[id].pause(); // fechou: para de consultar o estado da pesquisa
    // fechar pela interface (X, ESC, fundo) com endereço de lead: volta ao da lista — Voltar do navegador, se o lead foi aberto por clique; senão, troca a entrada
    if (!suppressNav && navigation && state.routeLeadId !== null) {
      state.routeLeadId = null;
      if (state.openedByPush) navigation.back();
      else navigation.replace(buildHash({ name: 'rejected-leads' }));
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
    const snapshot = snapshotOf(item);
    const profileLoaded = Object.prototype.hasOwnProperty.call(state.profiles, item.prospectId) && state.profiles[item.prospectId] !== undefined;
    const presented = profileLoaded ? state.profiles[item.prospectId] : undefined;
    const profile = presented !== undefined && presented !== null ? presented : item.perfil;
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

    // A DECISÃO: o motivo, a data e quem decidiu em destaque (só o que o servidor informou; o que falta aparece como "não registrado").
    const reason = textOf(item.motivo);
    const decision = h(
      document,
      'div',
      { className: `decision-card decision-${STATE_TONES[item.estado] || 'neutral'}` },
      h(document, 'div', { className: 'decision-head' }, badge(stateLabel(item.estado), STATE_TONES[item.estado] || 'neutral'), h(document, 'span', { className: 'decision-date', text: formatDateTime(item.reprovadoEm) || 'Data não registrada' })),
      h(document, 'span', { className: 'decision-label', text: 'Motivo da decisão' }),
      h(document, 'p', { className: reason === '' ? 'decision-reason muted' : 'decision-reason', text: reason === '' ? 'Motivo não registrado.' : reason }),
      kvList(document, [
        field('Decidido por', h(document, 'span', { text: deciderText(item) })),
        field('Job de origem', textValue(item.jobOrigem)),
        field('Reconsiderações anteriores', h(document, 'span', { text: String(Number.isInteger(item.reaprovacoes) ? item.reaprovacoes : 0) })),
      ])
    );

    const facts = kvList(document, [
      field('Tipo de lead', textOf(snapshot.tipoLead) === '' ? null : badge(leadTypeText(snapshot.tipoLead), 'neutral')),
      field('Tipo', textValue(snapshot.tipo)),
      field('Pesquisado em', textValue(formatDate(snapshot.dataDaPesquisa))),
    ]);
    const indicators = [
      textOf(identityStatus(snapshot.statusIdentidade)) === '' ? null : indicator('Verificação', badge(identityText(snapshot.statusIdentidade, { withReason: true }), 'neutral')),
      textOf(snapshot.statusDados) === '' ? null : indicator('Dados', badge(dataText(snapshot.statusDados), 'neutral')),
      textOf(snapshot.statusDuplicidade) === '' ? null : indicator('Duplicidade', badge(duplicityText(snapshot.statusDuplicidade, snapshot.matchedOn), 'neutral')),
      textOf(snapshot.statusDNC) === '' ? null : indicator('DNC', badge(dncText(snapshot.statusDNC), 'neutral')),
    ].filter(Boolean);
    const notes = kvList(document, [field('Hipótese de oportunidade', textValue(snapshot.hipoteseDeOportunidade)), field('Observações', textValue(snapshot.observacoes))]);

    const summary = h(
      document,
      'div',
      { className: 'lead-summary' },
      section(document, 'Decisão', decision),
      facts.children.length > 0 ? section(document, 'Identidade', facts) : null,
      indicators.length > 0 ? section(document, 'Situação comercial', h(document, 'div', { className: 'indicator-grid' }, ...indicators)) : null,
      section(document, 'Responsável', ownerCard(ownerSummary(profile, presented !== undefined || !canReview || typeof api.getLeadProfile !== 'function'))),
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
    const panel = panelFor(item);

    const list = [
      { key: 'resumo', label: 'Resumo', content: summary },
      { key: 'contatos', label: 'Contatos e canais', content: contacts.children.length > 0 ? contacts : emptyState(document, { title: 'Sem contatos informados', text: 'A pesquisa não registrou site, redes, telefone, WhatsApp ou e-mail no cadastro deste lead.' }) },
      { key: 'pesquisa', label: 'Pesquisa comercial', content: section(document, 'Análise comercial', buildLeadProfile(document, profile), panel ? panel.element : null) },
      { key: 'fontes', label: 'Fontes', badge: sources ? String(describeSources(snapshot.fontes).length) : undefined, content: sources ? section(document, 'Fontes', sources) : emptyState(document, { title: 'Sem fontes registradas' }) },
      { key: 'historico', label: 'Histórico', content: history ? section(document, 'Histórico', history) : emptyState(document, { title: 'Sem histórico' }) },
    ];
    tabs = createTabs(document, { idPrefix: 'rejected', label: 'Seções do lead', tabs: list, active: state.tab, onChange: (key) => { state.tab = key; } });
    return h(document, 'div', { className: 'lead-drawer-body' }, tabs.element);
  }

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

  // O responsável a partir do perfil (o apresentado pelo servidor, quando carregado). Nunca afirma mais do que o perfil diz.
  function ownerSummary(profile, settled) {
    const muted = (name) => ({ name, role: '', badge: null, note: null, tone: 'muted' });
    if (!settled) return muted('Carregando…');
    const owner = profile && profile.responsavel ? profile.responsavel : null;
    if (!owner) return muted('Sem análise comercial');
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
    const label = (estado) => ESTADO_LABELS[estado] || textOf(estado) || '—';
    return h(
      document,
      'ol',
      { className: 'plain' },
      ...historico.map((entry) => {
        const who = entry && entry.actor === 'HUMAN' && entry.reviewedBy ? `${textOf(entry.reviewedBy.name)} (${textOf(entry.reviewedBy.role)})` : 'Sistema';
        const line = [formatDateTime(entry && entry.timestamp), `${entry && entry.from ? label(entry.from) : 'Início'} → ${label(entry && entry.to)}`, who].join(' · ');
        const why = entry && textOf(entry.motivo) ? `: ${textOf(entry.motivo)}` : '';
        return h(document, 'li', { text: `${line}${why}` });
      })
    );
  }

  // O rodapé fixo da gaveta: a ação humana (reconsiderar) ou a explicação de por que ela não existe. Nada começa sozinho.
  function buildDrawerFooter(item) {
    if (item.estado === 'DNC') {
      return h(document, 'p', { className: 'notice bad', role: 'note', text: 'Este contato está em DNC (restrição de contato). Não é uma rejeição comercial e não pode ser reconsiderado.' });
    }
    if (!item.reaprovavel) return h(document, 'p', { className: 'muted', text: 'Só um lead reprovado por um humano pode ser reconsiderado.' });
    if (!canReview) return h(document, 'p', { className: 'muted', text: 'Sua conta não pode reconsiderar leads.' });
    return h(
      document,
      'div',
      { className: 'drawer-actions' },
      h(document, 'button', { type: 'button', className: 'btn primary', id: 'btn-reapprove', text: 'Reconsiderar lead', disabled: state.busy, onclick: () => openReconsider() }),
      h(document, 'p', { className: 'muted note', text: RECONSIDERED_NOTE })
    );
  }

  // ---- reconsiderar: SEMPRE por confirmação humana ----------------------------------------------

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

  function openReconsider() {
    const item = selectedItem();
    if (!item || state.busy || !canReview || !item.reaprovavel || item.estado !== 'REJEITADO') return;
    overlays.openConfirm({
      key: `reconsider:${item.prospectId}`,
      title: 'Reconsiderar lead',
      message: `Lead: ${textOf(item.empresa) || 'Sem nome'}`,
      detail: [`Motivo original da rejeição: ${(textOf(item.motivo) || 'não registrado').replace(/[.\s]+$/, '')}.`, RECONSIDERED_NOTE],
      confirmLabel: 'Reconsiderar',
      busyLabel: 'Reconsiderando…',
      field: { id: 'reapprove-reason', label: 'Justificativa (opcional)', required: false, maxlength: 300 },
      onConfirm: (reason) => reconsider(item, reason),
      getReturnFocus: () => (drawer && drawer.element.parentNode ? findByText(drawer.element, 'Reconsiderar lead') : null),
    });
  }

  async function reconsider(item, reason) {
    // busy: um segundo clique (ou um botão antigo ainda na tela) nunca dispara uma segunda requisição.
    if (state.busy) return;
    state.busy = true;
    refreshDrawerFooter();
    try {
      await api.reapproveLead(item.prospectId, reason === '' ? undefined : reason);
    } catch (error) {
      state.busy = false;
      const text = messageFor(error);
      if (error && error.status === 404) {
        // o lead já não existe como estava: avisa, fecha a gaveta e atualiza a lista
        notify('error', text);
        closeDrawer({ silent: false, reason: 'gone' });
        load({ quiet: true });
        throw Object.assign(new Error(text), { closeDialog: true });
      }
      if (error && error.status === 409) load({ quiet: true }); // o estado mudou ou uma barreira bloqueou: a lista se atualiza; a justificativa digitada fica
      refreshDrawerFooter();
      throw new Error(text); // a confirmação mostra o erro e MANTÉM o texto digitado
    }
    // confirmado pelo servidor: só agora há sucesso para mostrar
    state.busy = false;
    notify('success', `${textOf(item.empresa) || 'O lead'} voltou para a Approval Queue (aguardando revisão). Nada foi enviado ao CRM.`);
    if (bus) bus.publish('approvals:changed', { action: 'reconsider', prospectId: item.prospectId });
    state.items = state.items.filter((entry) => entry.prospectId !== item.prospectId);
    closeDrawer({ silent: false, reason: 'decided' });
    load({ quiet: true });
  }

  // ---- desenho das regiões ----------------------------------------------------------

  function filtered() {
    return visibleRejected(state.items, { query: state.query, sort: state.sort });
  }

  function paintAll() {
    for (const button of filterButtons) {
      const active = button.getAttribute('data-filter') === state.filtro;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.className = `btn ${active ? 'primary' : 'secondary'}`;
      button.disabled = state.status === 'loading';
    }
    paintList();
  }

  function paintList() {
    const total = state.items.length;
    const shown = filtered();
    const base = `${total} ${total === 1 ? 'lead' : 'leads'}`;
    counterEl.textContent = state.query.trim() !== '' && shown.length !== total ? `${base} · ${shown.length} na busca` : base;

    if (state.status === 'loading' && total === 0) {
      fill(listRegion, skeleton(document, { rows: 6, label: 'Carregando os leads…' }));
      fill(pagerRegion);
      return;
    }
    if (state.status === 'error') {
      fill(listRegion, h(document, 'p', { className: 'message error', role: 'alert', text: state.error }));
      fill(pagerRegion);
      return;
    }
    if (total === 0) {
      fill(listRegion, h(document, 'div', { id: 'rejected-empty' }, emptyState(document, { title: 'Nenhum lead nesta categoria.', text: 'Esta área reúne os leads que passaram pela Approval Queue e saíram dela: reprovados por uma pessoa, expirados ou bloqueados. Quando isso acontecer, eles aparecem aqui. Candidatos que a prospecção descartou ANTES de chegar à fila (não validados, dados insuficientes, duplicados ou DNC) ficam no Histórico de prospecções, não aqui.', action: h(document, 'a', { className: 'btn secondary', id: 'rejected-empty-history', href: buildHash({ name: 'prospecting-history' }), text: 'Ver o Histórico de prospecções' }) })));
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
    fill(listRegion, buildTable(slice));
    fill(pagerRegion, pagination(document, { page: state.page, pageCount, total: shown.length, pageSize, onPage: (next) => { state.page = next; paintList(); } }));
  }

  // A linha INTEIRA abre o lead (um único tratador de clique); o botão da empresa continua sendo o alvo do teclado (Enter/Espaço).
  function buildTable(rows) {
    const head = h(document, 'tr', {}, ...['Empresa', 'Situação', 'Motivo', 'Data', 'Decidido por'].map((title) => h(document, 'th', { scope: 'col', text: title })));
    const body = rows.map((item) => {
      const snapshot = snapshotOf(item);
      const selected = item.prospectId === state.selectedId;
      return h(
        document,
        'tr',
        { className: selected ? 'queue-row selected' : 'queue-row', 'data-prospect': item.prospectId, onclick: () => openLead(item.prospectId) },
        h(
          document,
          'td',
          { 'data-label': 'Empresa' },
          h(
            document,
            'div',
            { className: 'company-cell' },
            h(document, 'button', { type: 'button', className: 'company-name', 'data-prospect': item.prospectId, 'data-open': item.prospectId, text: textOf(item.empresa) || 'Sem nome', 'aria-current': selected ? 'true' : null }),
            h(document, 'span', { className: 'company-meta', text: [cityUf(snapshot), textOf(snapshot.nicho)].filter(Boolean).join(' · ') || '—' })
          )
        ),
        h(document, 'td', { 'data-label': 'Situação' }, badge(stateLabel(item.estado), STATE_TONES[item.estado] || 'neutral')),
        h(document, 'td', { 'data-label': 'Motivo' }, h(document, 'span', { className: 'reason-text', text: textOf(item.motivo) || '—' })),
        h(document, 'td', { 'data-label': 'Data', text: formatDateTime(item.reprovadoEm) || '—' }),
        h(document, 'td', { 'data-label': 'Decidido por', text: item.reprovadoPor ? textOf(item.reprovadoPor.name) : item.origemDaDecisao === 'HUMANO' ? '—' : 'Sistema' })
      );
    });
    return h(
      document,
      'div',
      { className: 'table-wrap' },
      h(document, 'table', { className: 'list queue', id: 'rejected-table' }, h(document, 'caption', { className: 'visually-hidden', text: 'Leads reprovados' }), h(document, 'thead', {}, head), h(document, 'tbody', {}, ...body))
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
    // o lead pode estar em outra categoria: procura em TODOS UMA vez
    if (state.filtro !== 'TODOS') {
      try {
        const data = await api.listRejectedLeads('TODOS');
        const items = Array.isArray(data && data.items) ? data.items : [];
        if (items.some((item) => item.prospectId === prospectId)) {
          state.filtro = 'TODOS';
          state.items = items;
          state.page = 1;
          paintAll();
          return true;
        }
      } catch {
        // sem a lista completa, o lead não é localizado
      }
    }
    return false;
  }

  async function show(route) {
    if (destroyed) return;
    const entering = !state.visible;
    state.visible = true;
    if (route && route.name === 'rejected-lead') {
      state.routeLeadId = route.id;
      if (state.drawerOpen && state.selectedId === route.id) return;
      if (entering && state.loadedAt !== null) load({ quiet: true });
      const found = await locate(route.id);
      if (destroyed || state.routeLeadId !== route.id) return;
      if (!found) {
        notify('warning', 'Este lead não foi encontrado em Leads Reprovados (já foi reconsiderado ou removido).');
        state.routeLeadId = null;
        if (navigation) navigation.replace(buildHash({ name: 'rejected-leads' }));
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

  // O módulo saiu de cena (outro item do menu): as camadas fecham, as consultas de estado param; filtro, busca e página ficam guardados.
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
      for (const panel of Object.values(state.panels)) panel.destroy();
      closeDrawer({ silent: true, reason: 'destroy' });
      if (ownsUi) ui.destroy();
    },
  };
}
