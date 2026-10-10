// Tela HISTÓRICO de prospecções — todas as prospecções automáticas já executadas, da mais recente para a mais antiga. Terceira tela da UX 4.0, no mesmo padrão
// da Approval Queue e de Leads Reprovados: lista com busca, filtro, ordenação e paginação (linha inteira clicável) e uma GAVETA por prospecção, com URL.
//
//   Browser -> esta tela -> api.mjs -> GET  /api/prospecting/jobs            (a lista; cada job já traz o resumo, os candidatos e a telemetria)
//                                   -> GET  /api/prospecting/briefs          (só leitura: o nicho e a localidade de cada job)
//                                   -> POST /api/prospecting/jobs/:id/redo   (REFAZER PROSPECÇÃO, só depois da confirmação humana)
//
// O QUE ESTA TELA NUNCA FAZ: criar lead, aprovar, rejeitar, pesquisar ou iniciar uma prospecção ao abrir um detalhe. Abrir a gaveta é só LEITURA. O histórico
// nunca é alterado nem apagado; "refazer" cria um job NOVO (com o mesmo briefing) — e só depois de uma confirmação explícita, porque usa a pesquisa na web e o
// Claude deste computador. Não há "cancelar" aqui: uma prospecção terminada não é cancelável.
//
// DUAS POPULAÇÕES, NUNCA MISTURADAS: os CANDIDATOS descartados durante a prospecção (não validados pela página, exclusão permanente, validados mas retidos
// por dados insuficientes/DNC/duplicidade) vivem só no job; os LEADS entregues à Approval Queue são outra coisa, e só estes podem ser aprovados ou
// REJEITADOS POR UMA PESSOA (decisão humana, com contadores vindos da fila). "Não validado" nunca é "rejeitado": ninguém decidiu nada.
//
// NAVEGAÇÃO: a gaveta tem URL (#/prospeccao/historico/<id>): link direto, Voltar fecha sem sair do módulo, Avançar reabre. A tela é PERSISTENTE na sessão:
// busca, filtro, ordem e página sobrevivem a trocar de módulo. Enquanto há uma prospecção em andamento e a tela está à vista, a lista se atualiza em silêncio
// pelo mesmo endpoint de sempre (intervalo mínimo, para sozinha quando nada mais está em andamento).
//
// PERMISSÕES: PROPOSE:LEAD_APPROVAL (`canProposeLead`); o servidor decide. Dados NÃO CONFIÁVEIS (pesquisa na web): tudo entra por dom.mjs; só URLs http(s).

import { h, fill } from '../dom.mjs';
import { textOf, formatDateTime } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { createUi, createPoller, createRoutedDrawer, statusBadge, emptyState, skeleton, pageHeader, searchField, selectField, pagination } from '../ui/index.mjs';
import { createJobDetails, findById, isActive, ACTIVE, JOB_STATUS_LABELS, JOB_TONES, REASON_LABELS, GROUPS, briefPlace, jobIndicators, classifyCandidate, candidateDetail, num } from './jobDetails.mjs';

// O detalhe de uma prospecção (indicadores, grupos de candidatos, motivos) vive em ./jobDetails.mjs, compartilhado com a Nova Prospecção; continua exportado daqui.
export { JOB_STATUS_LABELS, ACTIVE, REASON_LABELS, GROUPS, briefPlace, jobIndicators, classifyCandidate, candidateDetail };

const SORTS = Object.freeze([
  { value: 'recentes', label: 'Mais recentes' },
  { value: 'antigas', label: 'Mais antigas' },
  { value: 'leads', label: 'Mais leads na fila' },
]);
const STATUS_FILTERS = Object.freeze([
  { value: 'TODAS', label: 'Todas as situações' },
  { value: 'EM_ANDAMENTO', label: 'Em andamento' },
  { value: 'CONCLUIDO', label: 'Concluídas' },
  { value: 'PARCIAL', label: 'Parciais' },
  { value: 'ERRO', label: 'Falharam' },
  { value: 'CANCELADO', label: 'Canceladas' },
]);
const PAGE_SIZE = 15;
const POLL_MS = 5000;
const GENERIC_ERROR = 'Não foi possível concluir agora. Tente novamente em instantes.';

const messageFor = (error) => (error && typeof error.serverMessage === 'string' && error.serverMessage !== '' ? error.serverMessage : GENERIC_ERROR);
const fold = (value) => textOf(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function visibleJobs(jobs, briefs, { query = '', status = 'TODAS', sort = 'recentes' } = {}) {
  const needle = fold(query);
  const briefOf = (job) => (briefs && briefs[job.briefId]) || null;
  const matchesStatus = (job) => status === 'TODAS' || (status === 'EM_ANDAMENTO' ? isActive(job) : job.status === status);
  const matchesQuery = (job) => {
    if (needle === '') return true;
    const brief = briefOf(job);
    const who = job.criadoPor && typeof job.criadoPor === 'object' ? job.criadoPor.name : '';
    return fold([job.id, brief && brief.nicho, briefPlace(brief), who, JOB_STATUS_LABELS[job.status] || job.status].join(' ')).includes(needle);
  };
  const dateOf = (job) => textOf(job.startedAt || job.createdAt);
  const compare = {
    recentes: (a, b) => dateOf(b).localeCompare(dateOf(a)) || textOf(b.id).localeCompare(textOf(a.id)),
    antigas: (a, b) => dateOf(a).localeCompare(dateOf(b)) || textOf(a.id).localeCompare(textOf(b.id)),
    leads: (a, b) => (jobIndicators(b).naFila || 0) - (jobIndicators(a).naFila || 0) || dateOf(b).localeCompare(dateOf(a)),
  }[sort] || (() => 0);
  return jobs.filter((job) => matchesStatus(job) && matchesQuery(job)).sort(compare);
}

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------

// document/root: onde desenhar. api: { listProspectingJobs, listProspectingBriefs?, redoProspectingJob } (api.mjs). navigate(hash): leva à Nova Prospecção depois de
// refazer (onde o andamento é acompanhado). canProposeLead: mostra "Refazer" (conveniência; o servidor autoriza). ui/bus/navigation: os da sessão (opcionais).
// schedule: agendador da atualização em segundo plano (testes).
export function createProspectingHistoryView({ document, root, api, navigate = () => {}, canProposeLead = true, schedule, ui: providedUi = null, bus = null, navigation = null, pageSize = PAGE_SIZE, pollMs = POLL_MS }) {
  const state = {
    status: 'idle',
    error: null,
    jobs: [],
    briefs: {},
    query: '',
    statusFilter: 'TODAS',
    sort: 'recentes',
    page: 1,
    tab: 'resumo',
    busy: false,
    message: null,
    loadedAt: null,
    visible: false,
  };
  let destroyed = false;
  let loadToken = 0;
  const signatures = new Map();

  // --- estrutura estável (montada UMA vez; as regiões abaixo é que mudam) ---
  const content = h(document, 'div', { className: 'approvals-view history-view' });
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
  const jobById = (id) => state.jobs.find((job) => job.id === id) || null;

  const messageRegion = h(document, 'div', { className: 'message-region' });
  const counterEl = h(document, 'p', { className: 'pending-count toolbar-count' });
  const listRegion = h(document, 'div', { className: 'list-region' });
  const pagerRegion = h(document, 'div', { className: 'pager-region' });
  const refreshButton = h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Atualizar', onclick: () => refresh() });
  const search = searchField(document, {
    id: 'history-search',
    label: 'Buscar prospecção',
    placeholder: 'Código, nicho, cidade, quem iniciou…',
    onInput: (value) => {
      state.query = value;
      state.page = 1;
      paintList();
    },
  });
  const statusSelect = selectField(document, {
    id: 'history-status',
    label: 'Situação',
    options: STATUS_FILTERS,
    value: state.statusFilter,
    onChange: (value) => {
      state.statusFilter = value;
      state.page = 1;
      paintList();
    },
  });
  const sorter = selectField(document, {
    id: 'history-sort',
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
      { className: 'approvals', id: 'prospecting-history', 'aria-labelledby': 'history-title' },
      pageHeader(document, { title: 'Histórico de prospecções', titleId: 'history-title', subtitle: 'Cada prospecção com o que foi encontrado, validado, entregue à Approval Queue e descartado. O histórico é preservado: refazer cria uma prospecção nova.', actions: [refreshButton] }),
      h(document, 'div', { className: 'toolbar toolbar-stacked' }, h(document, 'div', { className: 'toolbar-row toolbar-tools' }, search.element, statusSelect.element, sorter.element, counterEl)),
      messageRegion,
      h(document, 'div', { className: 'list-card' }, listRegion, pagerRegion)
    )
  );

  function setMessage(kind, text) {
    state.message = text ? { kind, text } : null;
    fill(messageRegion, state.message ? h(document, 'p', { className: `message ${state.message.kind}`, role: state.message.kind === 'error' ? 'alert' : 'status', text: state.message.text }) : null);
  }

  function notify(kind, text) {
    setMessage(kind === 'success' ? 'ok' : kind, text);
    if (kind === 'error') toasts.error(text, { key: 'history-feedback' });
    else if (kind === 'success') toasts.success(text, { key: 'history-feedback' });
    else toasts.warning(text, { key: 'history-feedback' });
  }

  // ---- carga ---------------------------------------------------------------

  async function load({ quiet = false } = {}) {
    const token = ++loadToken;
    state.status = quiet && state.jobs.length > 0 ? 'ready' : 'loading';
    refreshButton.disabled = true;
    paintList();
    let failure = null;
    try {
      const data = await api.listProspectingJobs();
      if (token !== loadToken || destroyed) return;
      state.jobs = Array.isArray(data && data.items) ? data.items : [];
      state.loadedAt = Date.now();
    } catch (error) {
      if (token !== loadToken || destroyed) return;
      failure = messageFor(error);
    }
    if (failure === null) await loadBriefs(token);
    if (token !== loadToken || destroyed) return;
    state.status = failure && state.jobs.length === 0 ? 'error' : 'ready';
    state.error = failure && state.jobs.length === 0 ? failure : null;
    refreshButton.disabled = false;
    if (failure && state.jobs.length > 0) notify('error', failure); // a lista que já estava na tela fica; o erro aparece como aviso
    else if (failure === null && state.message && state.message.kind === 'error') setMessage(null);
    paintList();
    syncDrawerWithList();
    managePolling();
  }

  // O nicho e a localidade vêm do brief de cada job (só leitura); sem o brief, a tela mostra "—" — nunca um valor inventado.
  async function loadBriefs(token) {
    if (typeof api.listProspectingBriefs !== 'function') return;
    try {
      const data = await api.listProspectingBriefs();
      if (token !== loadToken || destroyed) return;
      const map = {};
      for (const brief of Array.isArray(data && data.items) ? data.items : []) if (brief && typeof brief.id === 'string') map[brief.id] = brief;
      state.briefs = map;
    } catch {
      // sem os briefs, a lista continua útil
    }
  }

  function refresh() {
    setMessage(null);
    return load({ quiet: true });
  }

  // ---- atualização em segundo plano: só com a tela à vista e uma prospecção em andamento; o mesmo endpoint de sempre, intervalo mínimo ----
  const poller = createPoller({
    tick: async () => {
      await load({ quiet: true });
      return state.jobs;
    },
    shouldContinue: (jobs) => state.visible && !destroyed && jobs.some(isActive),
    intervalMs: pollMs,
    maxFailures: 3,
    ...(schedule ? { schedule } : {}),
  });
  function managePolling() {
    if (destroyed || !state.visible || !state.jobs.some(isActive)) {
      poller.stop();
      return;
    }
    poller.start();
  }

  // ---- a gaveta (o ciclo de vida, com URL, vem do controlador compartilhado) ----------------
  const rowButtonOf = (id) => {
    const stack = [listRegion];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.childNodes || []) {
        if (child.nodeType !== 1) continue;
        if (child.localName === 'button' && child.getAttribute('data-item') === id) return child;
        stack.push(child);
      }
    }
    return null;
  };

  const drawerCtl = createRoutedDrawer({
    document,
    navigation,
    hashFor: (id) => buildHash({ name: 'prospecting-job', id }),
    listHash: buildHash({ name: 'prospecting-history' }),
    rowButton: rowButtonOf,
    repaint: () => paintList(),
    onClosed: (id) => {
      if (id !== null) signatures.delete(id);
    },
    build: (id, hooks) => {
      const job = jobById(id);
      if (!job) return null;
      signatures.set(id, JSON.stringify(job));
      const brief = state.briefs[job.briefId] || null;
      return overlays.openDrawer({
        key: `history-job:${id}`,
        title: textOf(job.id) || 'Prospecção',
        subtitle: [textOf(brief && brief.nicho), briefPlace(brief)].filter(Boolean).join(' · ') || `Iniciada em ${formatDateTime(job.startedAt || job.createdAt) || '—'}`,
        content: buildDrawerBody(job),
        footer: buildDrawerFooter(job),
        getReturnFocus: hooks.getReturnFocus,
        onClose: hooks.onClose,
      });
    },
  });

  // A lista foi atualizada com a gaveta aberta: se o job saiu da lista, avisa e fecha; senão, atualiza o conteúdo SÓ se ele mudou (não perde o foco à toa).
  function syncDrawerWithList() {
    if (!drawerCtl.isOpen()) return;
    const id = drawerCtl.state.selectedId;
    const job = jobById(id);
    if (!job) {
      notify('warning', 'Esta prospecção não está mais na lista. A lista foi atualizada.');
      drawerCtl.dismiss('gone');
      return;
    }
    const signature = JSON.stringify(job);
    if (signatures.get(id) === signature) return;
    signatures.set(id, signature);
    refreshDrawer(job);
  }

  function refreshDrawer(job = jobById(drawerCtl.state.selectedId)) {
    const handle = drawerCtl.handle;
    if (!handle || !job) return;
    handle.setContent(buildDrawerBody(job));
    handle.setFooter(buildDrawerFooter(job));
  }

  // ---- o conteúdo da gaveta: as quatro abas vêm do detalhe compartilhado (./jobDetails.mjs) ----------------
  const details = createJobDetails({
    document,
    getBrief: (job) => state.briefs[job.briefId] || null,
    liveNote: 'Esta lista se atualiza sozinha enquanto a prospecção roda.',
    onFilterChange: (selectId) => {
      refreshDrawer();
      const again = drawerCtl.handle ? findById(drawerCtl.handle.element, selectId) : null;
      if (again) again.focus(); // a gaveta foi reconstruída: o foco volta ao filtro que a pessoa estava usando
    },
  });

  function buildDrawerBody(job) {
    return details.build(job, { tab: state.tab, onTab: (key) => { state.tab = key; } }).element;
  }

  // O rodapé fixo da gaveta: a ação humana (refazer) ou o caminho para acompanhar. Abrir a gaveta nunca inicia nada.
  function buildDrawerFooter(job) {
    if (isActive(job)) {
      return h(document, 'div', { className: 'drawer-actions' }, h(document, 'a', { className: 'btn secondary', href: buildHash({ name: 'prospecting' }), text: 'Acompanhar na Nova Prospecção' }), h(document, 'p', { className: 'muted note', text: 'Uma prospecção em andamento não pode ser refeita nem cancelada por aqui.' }));
    }
    if (!canProposeLead) return h(document, 'p', { className: 'muted', text: 'Sua conta não pode iniciar prospecções.' });
    return h(
      document,
      'div',
      { className: 'drawer-actions' },
      h(document, 'button', { type: 'button', className: 'btn primary', id: 'history-redo', 'data-redo': job.id, text: 'Refazer prospecção', disabled: state.busy, onclick: () => openRedo(job.id) }),
      h(document, 'p', { className: 'muted note', text: 'Cria uma prospecção nova com o mesmo briefing. Nada é apagado deste histórico.' })
    );
  }

  // ---- refazer: SEMPRE por confirmação humana (inicia uma prospecção real) ----------------------

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

  function openRedo(id) {
    const job = jobById(id);
    if (!job || state.busy || isActive(job) || !canProposeLead) return;
    overlays.openConfirm({
      key: `history-redo:${id}`,
      title: 'Refazer prospecção',
      message: `Prospecção: ${textOf(job.id)}`,
      detail: ['Isto cria e INICIA uma prospecção nova com o mesmo briefing. Ela usa a pesquisa na web e o Claude deste computador e pode levar alguns minutos.', 'Este histórico é preservado: nada é apagado.'],
      confirmLabel: 'Refazer prospecção',
      busyLabel: 'Iniciando…',
      onConfirm: () => redo(job),
      getReturnFocus: () => (drawerCtl.handle && drawerCtl.handle.element.parentNode ? findByText(drawerCtl.handle.element, 'Refazer prospecção') : null),
    });
  }

  async function redo(job) {
    // busy: um segundo clique (ou um botão antigo ainda na tela) nunca inicia uma segunda prospecção.
    if (state.busy) return;
    state.busy = true;
    refreshDrawerFooter();
    try {
      await api.redoProspectingJob(job.id);
    } catch (error) {
      state.busy = false;
      refreshDrawerFooter();
      throw new Error(messageFor(error)); // a confirmação mostra o erro e continua aberta
    }
    state.busy = false;
    if (bus) bus.publish('prospecting:changed', { action: 'redo', jobId: job.id });
    drawerCtl.close({ silent: true, reason: 'redo' }); // o destino é outra tela: nada de "voltar" ao fechar
    navigate(buildHash({ name: 'prospecting' })); // onde o andamento é acompanhado
  }

  function refreshDrawerFooter() {
    const handle = drawerCtl.handle;
    const job = jobById(drawerCtl.state.selectedId);
    if (handle && job) handle.setFooter(buildDrawerFooter(job));
  }

  // ---- desenho das regiões ----------------------------------------------------------

  function filtered() {
    return visibleJobs(state.jobs, state.briefs, { query: state.query, status: state.statusFilter, sort: state.sort });
  }

  function paintList() {
    const total = state.jobs.length;
    const shown = filtered();
    const base = `${total} ${total === 1 ? 'prospecção' : 'prospecções'}`;
    const narrowed = state.query.trim() !== '' || state.statusFilter !== 'TODAS';
    counterEl.textContent = narrowed && shown.length !== total ? `${base} · ${shown.length} no filtro` : base;

    if (state.status === 'loading' && total === 0) {
      fill(listRegion, skeleton(document, { rows: 6, label: 'Carregando o histórico…' }));
      fill(pagerRegion);
      return;
    }
    if (state.status === 'error') {
      fill(listRegion, h(document, 'p', { className: 'message error', role: 'alert', text: state.error }));
      fill(pagerRegion);
      return;
    }
    if (total === 0) {
      fill(listRegion, h(document, 'div', { id: 'history-empty' }, emptyState(document, { title: 'Nenhuma prospecção executada ainda.', text: 'Quando uma prospecção automática for executada, ela aparece aqui com tudo o que foi encontrado, validado, entregue à Approval Queue e descartado.', action: h(document, 'a', { className: 'btn secondary', href: buildHash({ name: 'prospecting' }), text: 'Ir para Nova Prospecção' }) })));
      fill(pagerRegion);
      return;
    }
    if (shown.length === 0) {
      fill(listRegion, emptyState(document, { title: 'Nenhuma prospecção encontrada', text: 'Nada na lista combina com a busca ou com a situação escolhida. Ajuste ou limpe os filtros para ver todas.' }));
      fill(pagerRegion);
      return;
    }
    const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
    state.page = Math.min(Math.max(1, state.page), pageCount);
    const slice = shown.slice((state.page - 1) * pageSize, state.page * pageSize);
    fill(listRegion, buildTable(slice));
    fill(pagerRegion, pagination(document, { page: state.page, pageCount, total: shown.length, pageSize, onPage: (next) => { state.page = next; paintList(); } }));
  }

  // A linha INTEIRA abre a prospecção (um único tratador de clique); o botão do código continua sendo o alvo do teclado (Enter/Espaço).
  function buildTable(rows) {
    const heads = [['Prospecção', ''], ['Situação', ''], ['Data', ''], ['Encontrados', 'num'], ['Validados', 'num'], ['Na fila', 'num'], ['Descartados', 'num']];
    const head = h(document, 'tr', {}, ...heads.map(([title, cls]) => h(document, 'th', { scope: 'col', className: cls, text: title })));
    const body = rows.map((job) => {
      const ind = jobIndicators(job);
      const brief = state.briefs[job.briefId] || null;
      const selected = job.id === drawerCtl.state.selectedId;
      const meta = [textOf(brief && brief.nicho), briefPlace(brief)].filter(Boolean).join(' · ');
      return h(
        document,
        'tr',
        { className: selected ? 'queue-row selected' : 'queue-row', 'data-job': job.id, onclick: () => drawerCtl.open(job.id) },
        h(document, 'td', { 'data-label': 'Prospecção' }, h(document, 'div', { className: 'company-cell' }, h(document, 'button', { type: 'button', className: 'company-name job-code', 'data-item': job.id, 'data-open': job.id, text: textOf(job.id) || 'Sem código', 'aria-current': selected ? 'true' : null }), h(document, 'span', { className: 'company-meta', text: meta || '—' }))),
        h(document, 'td', { 'data-label': 'Situação' }, badge(JOB_STATUS_LABELS[job.status] || textOf(job.status) || '—', JOB_TONES[job.status] || 'neutral')),
        h(document, 'td', { 'data-label': 'Data', text: formatDateTime(job.startedAt || job.createdAt) || '—' }),
        h(document, 'td', { 'data-label': 'Encontrados', className: 'num', text: num(ind.encontrados) }),
        h(document, 'td', { 'data-label': 'Validados', className: 'num', text: num(ind.validados) }),
        h(document, 'td', { 'data-label': 'Na fila', className: 'num', text: num(ind.naFila) }),
        h(document, 'td', { 'data-label': 'Descartados', className: 'num', text: num(ind.descartados) })
      );
    });
    return h(document, 'div', { className: 'table-wrap' }, h(document, 'table', { className: 'list queue', id: 'history-table' }, h(document, 'caption', { className: 'visually-hidden', text: 'Prospecções executadas' }), h(document, 'thead', {}, head), h(document, 'tbody', {}, ...body)));
  }

  function render() {
    paintList();
    setMessage(state.message ? state.message.kind : null, state.message ? state.message.text : null);
  }

  // ---- roteamento (chamado pelo shell a cada mudança de #) ------------------------------------

  async function show(route) {
    if (destroyed) return;
    const entering = !state.visible;
    state.visible = true;
    if (route && route.name === 'prospecting-job') {
      drawerCtl.setRoute(route.id);
      if (drawerCtl.isOpen() && drawerCtl.state.selectedId === route.id) return;
      if (state.loadedAt === null) await load();
      else if (entering) load({ quiet: true });
      if (destroyed || drawerCtl.state.routeId !== route.id) return;
      if (!jobById(route.id)) {
        notify('warning', 'Esta prospecção não foi encontrada no histórico.');
        drawerCtl.setRoute(null);
        if (navigation) navigation.replace(buildHash({ name: 'prospecting-history' }));
        return;
      }
      drawerCtl.openFromRoute(route.id);
      return;
    }
    // rota da lista: fecha a gaveta (se estiver aberta) sem mexer no endereço; só atualiza se o módulo estava fora de cena
    drawerCtl.listRoute();
    if (state.loadedAt === null) await load();
    else if (entering) load({ quiet: true });
    else {
      paintList();
      managePolling();
    }
  }

  // O módulo saiu de cena: as camadas fecham e a atualização em segundo plano PARA; filtros, busca e página ficam guardados.
  function hide() {
    state.visible = false;
    drawerCtl.leave(overlays);
    poller.stop();
  }

  paintList();

  return {
    load,
    render,
    state,
    show,
    hide,
    refresh,
    openJob: (id) => drawerCtl.open(id),
    closeJob: () => drawerCtl.close({ silent: false, reason: 'api' }),
    destroy() {
      destroyed = true;
      poller.stop();
      drawerCtl.close({ silent: true, reason: 'destroy' });
      if (ownsUi) ui.destroy();
    },
  };
}
