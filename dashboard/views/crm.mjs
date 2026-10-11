// Tela CRM — a lista de registros (busca, filtros, ordem e paginação), a FICHA de cada registro numa GAVETA com abas e as ações de escrita (criar, editar,
// mudar status, marcar DO_NOT_CONTACT, excluir). Quarta tela da UX 4.0, no mesmo padrão da Approval Queue e do Histórico (decisão 0015 traz os contratos
// da API; a exclusão administrativa é a decisão 0025).
//
//   Browser -> esta tela -> api.mjs -> HTTP /api/crm -> CRM-API -> CRM Service -> CRM Domain -> repositório
//
// A tela conversa com o CRM SÓ pelo cliente de API (api.mjs): não importa o domínio, o Service nem o repositório, não usa `fetch` e não guarda nada no
// navegador. Quem autentica, autoriza e aplica as regras (status permitidos, duplicidade, DO_NOT_CONTACT, campos válidos) é o servidor. A tela só:
//   - MOSTRA ou esconde os botões de escrita conforme `permissions` (o que /api/me devolveu). Isso é conveniência de interface, nunca autorização: um
//     COMMERCIAL_CLOSER que forçasse a chamada receberia 403, e a tela trata o 403;
//   - oferece os status como opções e mostra a recusa do servidor (409) — não existe máquina de estados aqui. Só DO_NOT_CONTACT não é opção de nenhum
//     seletor: é terminal e só se alcança pela ação própria, com aviso e confirmação;
//   - nunca monta `userId`, `role`, `permissions`, `actor` ou `reviewedBy`: o corpo de uma escrita é só campos do registro (e o status inicial/motivo), e a
//     identidade de quem escreveu é a do token, gravada pelo servidor.
//
// NAVEGAÇÃO (UX 4.0.6): a tela é PERSISTENTE na sessão (show/hide): busca, filtros, ordem, página e posição de rolagem sobrevivem a abrir a ficha e a trocar de
// módulo. A ficha abre numa GAVETA lateral com URL (#/crm/registro/<id>): link direto, ESC/X, Voltar (fecha) e Avançar (reabre) funcionam, e a lista continua por
// baixo. As ações de escrita (editar, mudar status, DNC, excluir) continuam as de sempre, agora dentro da gaveta; "Novo registro" ainda é a página própria
// (#/crm/novo) — a migração delas para gaveta/confirmações vem nas próximas etapas.
//
// ATUALIZAÇÃO: sem polling. A lista se atualiza ao entrar na tela, pelo botão "Atualizar" e quando outra tela avisa pelo barramento (`crm:changed`, ex.: uma
// promoção da Approval Queue). Uma atualização nunca apaga o que a pessoa está digitando: o formulário de edição aberto não é redesenhado.
//
// SEGURANÇA: os dados de um registro são NÃO CONFIÁVEIS (pesquisa na web, digitação, IA no futuro). Tudo entra no DOM por dom.mjs (textContent, setAttribute) —
// nunca HTML. Um endereço só vira link se for http(s) (safeHttpUrl, com rel="noopener noreferrer"). Só os campos conhecidos são desenhados: um campo a mais no
// registro (authUserId, token...) nunca aparece. Nada aqui usa innerHTML, eval ou Function.

import { h, fill } from '../dom.mjs';
import { textOf, safeHttpUrl, roleLabel } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { createUi, createRoutedDrawer, createTabs, statusBadge as uiStatusBadge, emptyState, skeleton, pageHeader, searchField, selectField, pagination, section } from '../ui/index.mjs';
import {
  CRM_STATUSES,
  DEFAULT_INITIAL_STATUS,
  FIELD_GROUPS,
  LIST_COLUMNS,
  LOCKED_STATUS,
  RECORD_TABS,
  SORT_OPTIONS,
  SUGGESTION_KEYS,
  buildCreateRequest,
  buildPatch,
  describeHistory,
  displayValue,
  distinctValues,
  filterRecords,
  isLocked,
  listCells,
  messageForCrmError,
  normalizeText,
  sortRecordsBy,
  statusLabel,
  statusTone,
  validateForm,
  valuesFromRecord,
} from '../crm-model.mjs';

export const PAGE_SIZE = 20;
const MAX_LINE = '500';
const MAX_TEXT = '4000';

const DNC_LABEL = 'Não contatar';
const FIELD_BY_KEY = new Map(FIELD_GROUPS.flatMap((entry) => entry.fields).map((entry) => [entry.key, entry]));

// document/root: onde desenhar. api: o cliente de api.mjs (listCrm, getCrm, getCrmHistory, createCrm, updateCrm, moveCrmStatus, markCrmDnc, deleteCrm).
// permissions: { canWriteCrm, canDeleteCrm } (de permissionsOf(me)). navigate(hash): muda a rota. ui/bus/navigation: os da sessão (main.mjs); sem eles a tela
// cria os seus (testes). pageSize: tamanho da página da lista.
export function createCrmView({ document, root, api, permissions, navigate = () => {}, ui: providedUi = null, bus = null, navigation = null, pageSize = PAGE_SIZE }) {
  const canWrite = Boolean(permissions && permissions.canWriteCrm);
  // DELETE_CRM (decisão 0025): só MOSTRA/ESCONDE o botão "Excluir registro" — quem decide de verdade é o servidor (403 mesmo que a tela seja manipulada).
  // Deliberadamente independente de canWrite: excluir é uma ação diferente de criar/editar/mudar status, e continua disponível mesmo num registro bloqueado
  // como DNC (ver paintActions).
  const canDelete = Boolean(permissions && permissions.canDeleteCrm);
  const state = {
    route: { name: 'crm-list' },
    visible: false,
    list: { status: 'idle', items: [], error: null },
    loadedAt: null,
    stale: false,
    query: '',
    filters: { status: '', nicho: '', responsavel: '' },
    sort: 'recentes',
    page: 1,
    scrollTop: 0,
    record: { id: null, item: null, status: 'idle', error: null },
    history: { status: 'idle', entries: [], error: null },
    tab: 'resumo',
    panel: null,
    busy: false,
    message: null,
    flash: null,
    destroyed: false,
  };
  let destroyed = false;
  let listToken = 0;
  let recordToken = 0;
  let historyToken = 0;
  let current = null; // a ficha aberta: { handle, refs, panelApi, tabs, sig }
  let newForm = null; // o formulário de "Novo registro" (para as sugestões)
  let newDraft = null; // { isDirty() } enquanto a página de "Novo registro" está na tela

  const el = (tag, props, ...children) => h(document, tag, props, ...children);
  const statusBadge = (value) => uiStatusBadge(document, statusLabel(value), statusTone(value));
  const anchor = (href, text, className) => el('a', { href, className, text });
  const listHash = buildHash({ name: 'crm-list' });

  // ---- estrutura estável (montada UMA vez; as regiões é que mudam) --------------------------
  const content = el('div', { className: 'approvals-view crm-view' });
  const ownsUi = providedUi === null;
  let ui = providedUi;
  if (ownsUi) {
    const host = el('div', { className: 'overlay-host' });
    root.replaceChildren(content, host);
    ui = createUi({ document, host, getInertTargets: () => [content] });
  } else {
    root.replaceChildren(content);
  }
  const overlays = ui.overlays;
  const toasts = ui.toasts;

  const messageRegion = el('div', { className: 'message-region crm-message' });
  const counterEl = el('p', { className: 'pending-count toolbar-count crm-count', role: 'status' });
  const listRegion = el('div', { className: 'list-region crm-results' });
  const pagerRegion = el('div', { className: 'pager-region' });
  const refreshButton = el('button', { type: 'button', className: 'btn secondary', id: 'crm-refresh', text: 'Atualizar', onclick: () => refresh() });

  const search = searchField(document, {
    id: 'crm-search',
    label: 'Buscar',
    placeholder: 'Empresa, contato, telefone, WhatsApp, e-mail ou Instagram',
    onInput: (value) => {
      state.query = value;
      state.page = 1;
      paintResults();
    },
  });
  const statusSelect = selectField(document, {
    id: 'crm-filter-status',
    label: 'Status',
    options: [{ value: '', label: 'Todos os status' }, ...CRM_STATUSES.map((status) => ({ value: status.value, label: status.label }))],
    value: '',
    onChange: (value) => onFilter('status', value),
  });
  const nichoSelect = selectField(document, { id: 'crm-filter-nicho', label: 'Nicho', options: [{ value: '', label: 'Todos os nichos' }], value: '', onChange: (value) => onFilter('nicho', value) });
  const responsavelSelect = selectField(document, { id: 'crm-filter-responsavel', label: 'Responsável', options: [{ value: '', label: 'Todos os responsáveis' }], value: '', onChange: (value) => onFilter('responsavel', value) });
  const sorter = selectField(document, {
    id: 'crm-sort',
    label: 'Ordenar por',
    options: SORT_OPTIONS,
    value: state.sort,
    onChange: (value) => {
      state.sort = value;
      state.page = 1;
      paintResults();
    },
  });
  const clearButton = el('button', { type: 'button', className: 'btn secondary', id: 'crm-clear', text: 'Limpar filtros', onclick: () => clearFilters() });

  const listScreen = el(
    'section',
    { className: 'approvals crm', id: 'crm-list', 'aria-labelledby': 'crm-title' },
    pageHeader(document, {
      title: 'CRM',
      titleId: 'crm-title',
      subtitle: 'Os registros comerciais. Clique em uma linha para abrir a ficha sem sair da lista.',
      actions: [refreshButton, canWrite ? anchor(buildHash({ name: 'crm-new' }), 'Novo registro', 'btn primary') : null].filter(Boolean),
    }),
    el(
      'form',
      { className: 'toolbar toolbar-stacked', role: 'search', onsubmit: (event) => event.preventDefault() },
      el('div', { className: 'toolbar-row toolbar-tools' }, search.element, statusSelect.element, nichoSelect.element, responsavelSelect.element, sorter.element, el('div', { className: 'field filters-clear' }, clearButton), counterEl)
    ),
    messageRegion,
    el('div', { className: 'list-card' }, listRegion, pagerRegion)
  );
  const newHost = el('div', { className: 'crm-new-host' });
  content.append(listScreen);

  // A lista é PERSISTENTE, mas só está na página quando a rota é a dela (ou a de uma ficha); a página de "Novo registro" a substitui — sem campos repetidos na tela.
  // A lista continua guardada em memória (busca, filtros, ordem, página), e a rolagem é restaurada ao voltar.
  function showScreen(which) {
    content.replaceChildren(which === 'list' ? listScreen : newHost);
  }

  // ---- mensagens ---------------------------------------------------------

  // Pinta uma mensagem { kind, text, link? } num contêiner (ou o esvazia). `error` é um alerta; o resto, um aviso de status.
  function paintMessageInto(container, message) {
    if (!container) return;
    if (!message) {
      fill(container);
      return;
    }
    const role = message.kind === 'error' ? 'alert' : 'status';
    fill(container,
      el('p', { className: `message ${message.kind}`, role }, el('span', { text: message.text }), message.link ? el('span', { text: ' ' }) : null, message.link ? anchor(message.link.href, message.link.text) : null)
    );
  }

  // A mensagem da FICHA (dentro da gaveta).
  function setMessage(kind, text, link) {
    state.message = text ? { kind, text, ...(link ? { link } : {}) } : null;
    if (current) paintMessageInto(current.refs.message, state.message);
  }

  // O aviso da LISTA (ex.: registro excluído): fica na página e também aparece como notificação.
  function listNotice(kind, text) {
    paintMessageInto(messageRegion, text ? { kind: kind === 'success' ? 'ok' : kind, text } : null);
    if (!text) return;
    if (kind === 'error') toasts.error(text, { key: 'crm-feedback' });
    else if (kind === 'success') toasts.success(text, { key: 'crm-feedback' });
    else toasts.warning(text, { key: 'crm-feedback' });
  }

  const publish = (action, id) => {
    if (bus) bus.publish('crm:changed', { source: 'crm', action, id });
  };

  // ---- carga da lista ---------------------------------------------------------

  const isRecordLike = (item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '';

  async function loadList({ quiet = false } = {}) {
    const token = ++listToken;
    state.list.status = quiet && state.list.items.length > 0 ? 'ready' : 'loading';
    state.list.error = null;
    if (!quiet || state.list.items.length === 0) paintListParts();
    let failed = false;
    try {
      const data = await api.listCrm();
      if (destroyed || token !== listToken) return;
      state.list.items = Array.isArray(data && data.items) ? data.items.filter(isRecordLike) : [];
      state.list.status = 'ready';
      state.loadedAt = Date.now();
      state.stale = false;
    } catch (error) {
      if (destroyed || token !== listToken) return;
      failed = true;
      state.list.status = 'error';
      state.list.error = messageForCrmError(error);
    }
    paintListParts();
    if (newForm) newForm.paintSuggestions(state.list.items);
    if (!failed) syncFichaWithList();
  }

  function refresh() {
    paintMessageInto(messageRegion, null);
    return loadList({ quiet: true });
  }

  // ==========================================================================
  // LISTA
  // ==========================================================================
  function onFilter(name, value) {
    state.filters[name] = String(value || '');
    state.page = 1;
    paintResults();
  }

  function clearFilters() {
    state.query = '';
    state.filters = { status: '', nicho: '', responsavel: '' };
    state.page = 1;
    search.setValue('');
    paintFilterOptions();
    paintResults();
  }

  const hasCriteria = () => state.query.trim() !== '' || state.filters.status !== '' || state.filters.nicho !== '' || state.filters.responsavel !== '';

  function optionElements(allLabel, values) {
    return [el('option', { value: '', text: allLabel }), ...values.map((entry) => el('option', { value: entry.value, text: entry.label }))];
  }

  // As opções dos filtros vêm dos dados carregados; um valor escolhido que deixou de existir volta para "todos".
  function paintFilterOptions() {
    const nichos = distinctValues(state.list.items, 'nicho');
    const responsaveis = distinctValues(state.list.items, 'responsavel');
    const known = (values, chosen) => values.some((value) => normalizeText(value) === normalizeText(chosen));
    if (state.filters.nicho !== '' && !known(nichos, state.filters.nicho)) state.filters.nicho = '';
    if (state.filters.responsavel !== '' && !known(responsaveis, state.filters.responsavel)) state.filters.responsavel = '';

    fill(statusSelect.select, ...optionElements('Todos os status', CRM_STATUSES.map((status) => ({ value: status.value, label: status.label }))));
    fill(nichoSelect.select, ...optionElements('Todos os nichos', nichos.map((value) => ({ value, label: value }))));
    fill(responsavelSelect.select, ...optionElements('Todos os responsáveis', responsaveis.map((value) => ({ value, label: value }))));
    statusSelect.select.value = state.filters.status;
    nichoSelect.select.value = state.filters.nicho;
    responsavelSelect.select.value = state.filters.responsavel;
  }

  function paintListParts() {
    paintFilterOptions();
    paintResults();
  }

  function matchingRecords() {
    return sortRecordsBy(filterRecords(state.list.items, { query: state.query, ...state.filters }), state.sort);
  }

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

  function paintResults() {
    const { list } = state;
    const total = list.items.length;

    if ((list.status === 'loading' || list.status === 'idle') && total === 0) {
      counterEl.textContent = '';
      fill(listRegion, skeleton(document, { rows: 6, label: 'Carregando registros…' }));
      fill(pagerRegion);
      return;
    }
    if (list.status === 'error' && total === 0) {
      counterEl.textContent = '';
      fill(listRegion,
        el('p', { className: 'message error', role: 'alert', text: list.error || 'Não foi possível carregar o CRM agora.' }),
        el('button', { type: 'button', className: 'btn secondary', text: 'Tentar novamente', onclick: () => loadList() })
      );
      fill(pagerRegion);
      return;
    }
    if (total === 0) {
      counterEl.textContent = '';
      fill(listRegion,
        el('div', { id: 'crm-empty' }, emptyState(document, {
          title: 'Nenhum registro no CRM ainda.',
          text: canWrite ? 'Os registros aparecem aqui assim que forem criados ou promovidos da Approval Queue.' : 'Os registros aparecem aqui assim que forem criados ou promovidos da Approval Queue.',
          action: canWrite ? anchor(buildHash({ name: 'crm-new' }), 'Criar o primeiro registro', 'btn primary') : null,
        }))
      );
      fill(pagerRegion);
      return;
    }

    const matches = matchingRecords();
    counterEl.textContent = hasCriteria() ? `${matches.length} de ${total} registros` : `${total} ${total === 1 ? 'registro' : 'registros'}`;
    const extras = [];
    if (list.status === 'error') extras.push(el('p', { className: 'message error', role: 'alert', text: list.error || 'Não foi possível atualizar a lista. Estes são os dados já carregados.' }));
    if (matches.length === 0) {
      fill(listRegion,
        ...extras,
        emptyState(document, {
          title: 'Nenhum registro encontrado',
          text: 'Nada na lista combina com a busca ou com os filtros. Ajuste ou limpe os filtros para ver todos.',
          action: el('button', { type: 'button', className: 'btn secondary', text: 'Limpar busca e filtros', onclick: clearFilters }),
        })
      );
      fill(pagerRegion);
      return;
    }
    const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
    state.page = Math.min(Math.max(1, state.page), pageCount);
    const shown = matches.slice((state.page - 1) * pageSize, state.page * pageSize);
    fill(listRegion, ...extras, buildTable(shown));
    fill(pagerRegion, pagination(document, { page: state.page, pageCount, total: matches.length, pageSize, onPage: (next) => { state.page = next; paintResults(); } }));
  }

  // A linha INTEIRA abre a ficha (um único tratador de clique); o botão com o nome da empresa é o alvo do teclado (Enter/Espaço) e do foco ao fechar.
  function buildTable(records) {
    const head = el('tr', {}, ...LIST_COLUMNS.map((column) => el('th', { scope: 'col', text: column.label })));
    const rows = records.map((record) => {
      const cells = listCells(record);
      const cell = (column, node, value) => el('td', { 'data-label': column.label, className: value === '' ? 'empty' : '' }, node);
      const plain = (column) => cell(column, el('span', { text: cells[column.key] || '—' }), cells[column.key]);
      const selected = record.id === drawerCtl.state.selectedId;
      return el(
        'tr',
        { className: selected ? 'queue-row selected' : 'queue-row', 'data-record': record.id, onclick: () => drawerCtl.open(record.id) },
        el('td', { 'data-label': LIST_COLUMNS[0].label }, el('div', { className: 'company-cell' }, el('button', { type: 'button', className: 'company-name', 'data-item': record.id, 'data-open': record.id, text: cells.empresa }))),
        ...LIST_COLUMNS.slice(1).map((column) => (column.key === 'status' ? cell(column, statusBadge(record.status), textOf(record.status)) : plain(column)))
      );
    });
    return el(
      'div',
      { className: 'table-wrap' },
      el('table', { className: 'list queue crm-table', id: 'crm-table' }, el('caption', { className: 'visually-hidden', text: 'Registros do CRM' }), el('thead', {}, head), el('tbody', {}, ...rows))
    );
  }

  // ==========================================================================
  // FICHA (a gaveta)
  // ==========================================================================
  const isCurrentRecord = (id) => !destroyed && current !== null && state.record.id === id;

  const drawerCtl = createRoutedDrawer({
    document,
    navigation,
    hashFor: (id) => buildHash({ name: 'crm-record', id }),
    listHash,
    rowButton: rowButtonOf,
    repaint: () => paintResults(),
    build: (id, hooks) => openFicha(id, hooks),
  });

  // ==========================================================================
  // PROTEÇÃO DE ALTERAÇÕES NÃO SALVAS (UX 4.0.6.3)
  // ==========================================================================
  // O navegador não deixa CANCELAR um "Voltar", um "Avançar" ou um clique num link: quando o aviso chega, o endereço JÁ mudou. Por isso, com uma edição não salva (ou um envio em
  // andamento) a tela, em vez de fechar a gaveta, pergunta; e, se a pessoa escolher "Continuar editando", leva o endereço de volta com navigation.restore — sem empilhar entradas e sem
  // laço (voltar ao endereço da gaveta que já está aberta não pergunta nada). Sem alteração nenhuma, nada disso acontece e a navegação é livre.
  //   ESC / X / fundo     -> o gerenciador de camadas (isDirty da gaveta)
  //   Voltar / Avançar / outro registro / outro endereço do CRM -> show() abaixo
  //   trocar de módulo    -> main.mjs pergunta por leaveState()/confirmLeave() ANTES de mostrar o outro módulo
  //   atualizar/fechar a aba -> o guarda de beforeunload (o navegador decide se e como mostra o aviso)
  const editDirty = () => !destroyed && state.panel === 'edit' && current !== null && current.panelApi !== null && typeof current.panelApi.isDirty === 'function' && current.panelApi.isDirty();
  const newDirty = () => !destroyed && newDraft !== null && newHost.parentNode === content && newDraft.isDirty();
  const hasUnsavedChanges = () => editDirty() || newDirty();
  const isSaving = () => !destroyed && state.busy;
  const routeKey = (route) => (route.name === 'crm-record' ? `rec:${route.id}` : route.name === 'crm-new' ? 'new' : 'list');
  const currentKey = () => (newHost.parentNode === content ? 'new' : drawerCtl.isOpen() ? `rec:${drawerCtl.state.selectedId}` : 'list');
  const currentHash = () => {
    const key = currentKey();
    if (key === 'new') return buildHash({ name: 'crm-new' });
    if (key === 'list') return listHash;
    return buildHash({ name: 'crm-record', id: drawerCtl.state.selectedId });
  };
  const restoreAddress = () => {
    if (navigation && typeof navigation.restore === 'function') navigation.restore(currentHash());
  };

  // Descarta o rascunho (a gaveta/página em si quem fecha é quem navega): a edição sai de cena, o formulário de novo registro é esquecido.
  function discardDraft() {
    if (state.panel === 'edit' && current) {
      state.panel = null;
      paintPanel();
      paintActions();
      paintTabs(true);
    }
    newDraft = null;
  }

  // A pergunta de saída. Um segundo aviso (outro "Voltar" apertado com a pergunta aberta) só troca para onde a saída vai; a pergunta continua uma só.
  let pendingLeave = null;
  function askLeave({ discard, stay }) {
    pendingLeave = { discard, stay };
    confirmDiscard({
      onDiscard: () => {
        const leaving = pendingLeave;
        pendingLeave = null;
        discardDraft();
        if (leaving) leaving.discard();
      },
      onStay: () => {
        const leaving = pendingLeave;
        pendingLeave = null;
        if (leaving) leaving.stay();
      },
    });
  }

  // Salvando: não dá para sair no meio (confundiria o resultado). O endereço volta e a pessoa é avisada.
  function refuseWhileSaving(stay) {
    toasts.warning('Aguarde o salvamento terminar antes de sair.', { key: 'crm-saving' });
    stay();
  }

  function resetRecord() {
    recordToken += 1;
    historyToken += 1;
    state.record = { id: null, item: null, status: 'idle', error: null };
    state.history = { status: 'idle', entries: [], error: null };
    state.panel = null;
    state.message = null;
    state.busy = false;
  }

  function openFicha(id, hooks) {
    const cached = state.list.items.find((item) => item.id === id) || null;
    state.record = { id, item: cached, status: cached ? 'ready' : 'loading', error: null };
    state.history = { status: 'loading', entries: [], error: null };
    state.panel = null;
    state.tab = 'resumo';
    state.message = state.flash;
    state.flash = null;

    const refs = {
      head: el('div', { className: 'ficha-head' }),
      message: el('div', { className: 'crm-message' }),
      notice: el('div', { className: 'ficha-notice' }),
      panel: el('div', { className: 'ficha-panel' }),
      tabs: el('div', { className: 'ficha-tabs' }),
      footer: el('div', { className: 'drawer-actions ficha-actions' }),
    };
    const element = el('div', { className: 'crm-ficha' }, refs.head, refs.message, refs.notice, refs.panel, refs.tabs);
    const handle = overlays.openDrawer({
      key: `crm-record:${id}`,
      title: cached ? textOf(cached.empresa) || 'Sem nome' : 'Carregando registro…',
      content: element,
      getReturnFocus: hooks.getReturnFocus,
      isDirty: () => editDirty(),
      onClose: (reason) => {
        current = null;
        resetRecord();
        hooks.onClose(reason);
      },
    });
    current = { handle, refs, panelApi: null, tabs: null, sig: '' };
    paintRecordParts();
    loadRecord(id);
    loadHistory(id);
    return handle;
  }

  function paintRecordParts() {
    if (!current) return;
    paintHead();
    paintMessageInto(current.refs.message, state.message);
    paintActions();
    paintPanel();
    paintTabs(true);
  }

  async function loadRecord(id) {
    const token = ++recordToken;
    try {
      const data = await api.getCrm(id);
      if (!isCurrentRecord(id) || token !== recordToken) return;
      const item = data && data.item;
      if (!isRecordLike(item) || item.id !== id) throw Object.assign(new Error('resposta inesperada'), { status: 500 });
      state.record.item = item;
      state.record.status = 'ready';
      upsertListItem(item);
      paintResults();
    } catch (error) {
      if (!isCurrentRecord(id) || token !== recordToken) return;
      const text = messageForCrmError(error);
      if (state.record.item === null) {
        state.record.status = 'error';
        state.record.error = text || 'Não foi possível abrir este registro.';
      } else if (text) {
        setMessage('warn', 'Não foi possível atualizar esta ficha. Os dados mostrados podem estar desatualizados.');
      }
    }
    paintHead();
    paintActions();
    // Se o registro ficou bloqueado por baixo ("Não contatar" marcado por outra pessoa), o painel aberto não vale mais.
    if (state.panel !== null && state.record.item && isLocked(state.record.item)) paintPanel();
    if (state.panel !== 'edit') paintTabs();
  }

  async function loadHistory(id) {
    const token = ++historyToken;
    state.history = { status: 'loading', entries: state.history.entries, error: null };
    paintTabs();
    try {
      const data = await api.getCrmHistory(id);
      if (!isCurrentRecord(id) || token !== historyToken) return;
      state.history = { status: 'ready', entries: Array.isArray(data && data.historico) ? data.historico : [], error: null };
    } catch (error) {
      if (!isCurrentRecord(id) || token !== historyToken) return;
      state.history = { status: 'error', entries: [], error: messageForCrmError(error) || 'Não foi possível carregar o histórico.' };
    }
    paintTabs();
  }

  // A lista foi atualizada com a ficha aberta: se o registro mudou, a ficha acompanha — SÓ fora do modo de edição (o formulário em uso nunca é redesenhado).
  function syncFichaWithList() {
    if (!current || state.record.status !== 'ready') return;
    const fresh = state.list.items.find((item) => item.id === state.record.id);
    if (!fresh || JSON.stringify(fresh) === JSON.stringify(state.record.item)) return;
    state.record.item = fresh;
    paintHead();
    paintActions();
    if (state.panel !== null && isLocked(fresh)) paintPanel();
    if (state.panel !== 'edit') paintTabs();
  }

  function upsertListItem(item) {
    const index = state.list.items.findIndex((entry) => entry.id === item.id);
    if (index >= 0) state.list.items[index] = item;
    else state.list.items.push(item);
  }

  // Exclusão (decisão 0025): o registro deixou de existir — some da lista local para feedback imediato.
  function removeListItem(id) {
    const index = state.list.items.findIndex((entry) => entry.id === id);
    if (index >= 0) state.list.items.splice(index, 1);
  }

  // Um registro devolvido por uma escrita passa a ser o atual (ficha e lista).
  function applyRecord(item) {
    if (!isRecordLike(item) || item.id !== state.record.id) throw Object.assign(new Error('resposta inesperada'), { status: 500 });
    state.record.item = item;
    state.record.status = 'ready';
    upsertListItem(item);
    paintListParts();
  }

  function paintHead() {
    if (!current) return;
    const { record } = state;
    if (record.status === 'loading') {
      current.handle.setTitle('Carregando registro…');
      fill(current.refs.head);
      return;
    }
    if (record.status === 'error') {
      current.handle.setTitle('Registro');
      fill(current.refs.head, el('p', { className: 'message error', role: 'alert', text: record.error }));
      return;
    }
    const item = record.item;
    current.handle.setTitle(textOf(item.empresa) || 'Sem nome');
    fill(current.refs.head, statusBadge(item.status));
  }

  // ---- ações (os botões ficam no rodapé fixo da gaveta; os avisos, no corpo) ---------------------------------

  function paintActions() {
    if (!current) return;
    const { refs, handle } = current;
    const item = state.record.item;
    if (state.record.status !== 'ready' || !item) {
      fill(refs.notice);
      fill(refs.footer);
      handle.setFooter(null);
      return;
    }
    const button = (text, panel, className) =>
      el('button', { type: 'button', className: `btn ${className}`, text, 'aria-pressed': state.panel === panel ? 'true' : 'false', disabled: state.busy, onclick: () => togglePanel(panel) });
    // Excluir (decisão 0025) continua disponível mesmo com o registro bloqueado como DNC: excluir não é uma mudança
    // de estado do CRM, e um registro DNC é exatamente o cenário que motivou a exclusão existir.
    let notice = null;
    let buttons = [];
    if (isLocked(item)) {
      notice = el('p', { className: 'notice bad', role: 'note', text: `Este registro está bloqueado como "${DNC_LABEL}". Ele não pode mais ser editado nem mudar de status.` });
      buttons = [canDelete ? button('Excluir registro', 'delete', 'danger') : null];
    } else if (!canWrite && !canDelete) {
      notice = el('p', { className: 'muted', text: 'Seu perfil pode consultar o CRM, mas não pode criar nem alterar registros.' });
    } else {
      buttons = [
        canWrite ? button('Editar', 'edit', 'secondary') : null,
        canWrite ? button('Mudar status', 'status', 'secondary') : null,
        canWrite ? button(`Marcar como ${DNC_LABEL}`, 'dnc', 'danger') : null,
        canDelete ? button('Excluir registro', 'delete', 'danger') : null,
      ];
    }
    fill(refs.notice, notice);
    // Editando: o rodapé fixo é o do formulário (estado, Salvar e Cancelar) — as outras ações só voltam quando a edição termina, para uma escrita nunca atropelar a outra.
    if (state.panel === 'edit' && current.panelApi && current.panelApi.footer) {
      handle.setFooter(current.panelApi.footer);
      return;
    }
    buttons = buttons.filter(Boolean);
    fill(refs.footer, ...buttons);
    handle.setFooter(buttons.length > 0 ? refs.footer : null);
  }

  function togglePanel(panel) {
    if (state.busy || !current) return;
    state.panel = state.panel === panel ? null : panel;
    paintPanel();
    paintActions();
    paintTabs(true);
    if (current.panelApi && current.panelApi.focus) current.panelApi.focus();
  }

  function closePanel() {
    if (state.busy || !current) return;
    state.panel = null;
    paintPanel();
    paintActions();
    paintTabs(true);
  }

  // A pergunta única de descarte (ESC/X usam a mesma, vinda do gerenciador de camadas): "Continuar editando" é o botão que já nasce em foco; nada é descartado sem o "Descartar alterações".
  function confirmDiscard({ onDiscard, onStay = () => {} }) {
    overlays.openConfirm({
      key: 'crm-discard',
      title: 'Descartar alterações?',
      message: 'Há alterações que ainda não foram salvas. Se você continuar, elas serão perdidas.',
      tone: 'danger',
      confirmLabel: 'Descartar alterações',
      cancelLabel: 'Continuar editando',
      cancelFirst: true,
      onConfirm: async () => onDiscard(),
      onClose: (reason) => {
        if (reason !== 'confirmed') onStay();
      },
    });
  }

  function paintPanel() {
    if (!current) return;
    const { refs } = current;
    // O registro ficou bloqueado ("Não contatar" por outra pessoa) com a edição aberta: o que foi digitado NÃO some — fica à vista, sem poder ser salvo, até a pessoa cancelar.
    if (state.panel === 'edit' && current.panelApi && typeof current.panelApi.setLocked === 'function' && state.record.status === 'ready' && isLocked(state.record.item)) {
      current.panelApi.setLocked();
      return;
    }
    current.panelApi = null;
    if (state.panel === null || state.record.status !== 'ready') {
      state.panel = null;
      fill(refs.panel);
      return;
    }
    // Excluir (decisão 0025) é o ÚNICO painel que abre mesmo sem canWrite e mesmo com o registro bloqueado (DNC) —
    // as demais ações continuam exigindo canWrite e um registro não bloqueado, como sempre.
    if (state.panel === 'delete') {
      if (!canDelete) {
        state.panel = null;
        fill(refs.panel);
        return;
      }
      current.panelApi = buildDeletePanel();
      fill(refs.panel, current.panelApi.element);
      return;
    }
    if (!canWrite || isLocked(state.record.item)) {
      state.panel = null;
      fill(refs.panel);
      return;
    }
    current.panelApi = state.panel === 'edit' ? buildEditPanel() : state.panel === 'status' ? buildStatusPanel() : buildDncPanel();
    fill(refs.panel, current.panelApi.element);
  }

  // A moldura de um painel (título, corpo, mensagem e botões). Cada painel devolve { element, focus(), setBusy(bool),
  // setMessage(kind, text) }.
  function panelShell(title, body, buttons) {
    const message = el('div', { className: 'panel-message' });
    return {
      element: el('form', { className: 'panel', novalidate: 'novalidate', 'aria-label': title, onsubmit: (event) => event.preventDefault() }, el('h3', { text: title }), ...body, message, el('div', { className: 'form-actions' }, ...buttons)),
      setBusy(busy) {
        for (const control of buttons) control.disabled = busy;
      },
      setMessage(kind, text) {
        paintMessageInto(message, text ? { kind, text } : null);
      },
    };
  }

  // ---- painel: editar ----------------------------------------------------------
  // LIMITE DA API: a CRM-API não tem versionamento (nem ETag nem data de atualização por registro). Duas pessoas que salvam o mesmo campo ao mesmo tempo: o último salvamento prevalece. A tela
  // reduz o risco enviando SÓ o que a pessoa alterou (os campos que ela não tocou não são reenviados), mas não detecta nem resolve disputas entre usuários e não diz que protege disso.
  // A edição ocupa a gaveta: os mesmos 31 campos, organizados nas abas Resumo / Contato e presença / Comercial, com o rodapé fixo (estado, Salvar, Cancelar). Salvar é SEMPRE uma ação
  // explícita — nada é salvo sozinho. Só os campos que a pessoa alterou são enviados. O que foi digitado nunca é apagado por uma resposta, um evento ou um erro.
  function buildEditPanel() {
    const item = state.record.item;
    const initial = valuesFromRecord(item);
    let locked = false;
    const statusEl = el('span', { className: 'edit-status muted', id: 'crm-edit-status', role: 'status', 'aria-live': 'polite' });
    const form = buildFieldForm({ values: initial, record: item, layout: 'tabs', onChange: () => refreshStatus() });
    form.paintSuggestions(state.list.items);
    const submit = el('button', { type: 'button', className: 'btn primary', id: 'crm-edit-save', text: 'Salvar alterações', onclick: () => submitEdit(panel) });
    const cancel = el('button', { type: 'button', className: 'btn secondary', id: 'crm-edit-cancel', text: 'Cancelar', onclick: () => cancelEdit(panel) });
    const intro = el('p', { className: 'muted edit-intro', text: 'Os campos marcados como "(obrigatório)" precisam ser preenchidos. Ao salvar, só o que você alterou é enviado; nada é salvo automaticamente.' });
    const shell = panelShell('Editar registro', [intro, form.element], []);
    const footer = el('div', { className: 'drawer-actions edit-footer' }, statusEl, submit, cancel);
    // Há algo a perder? (fechar a gaveta, voltar ou sair do módulo pergunta antes de descartar o que foi digitado.)
    const isDirty = () => {
      try {
        return Object.keys(buildPatch(initial, form.read())).length > 0;
      } catch {
        return true; // um valor que nem dá para interpretar é, com certeza, algo digitado
      }
    };
    function refreshStatus() {
      let text = '';
      let dirty = false;
      if (state.busy) text = 'Salvando…';
      else if (locked) text = 'Registro bloqueado: não pode ser salvo';
      else if (isDirty()) {
        text = 'Alterações não salvas';
        dirty = true;
      }
      statusEl.textContent = text;
      statusEl.className = dirty ? 'edit-status dirty' : 'edit-status muted';
    }
    const panel = {
      element: shell.element,
      footer,
      form,
      initial,
      isDirty,
      focus: form.focusFirst,
      setMessage: shell.setMessage,
      setBusy(busy) {
        submit.disabled = busy || locked;
        cancel.disabled = busy;
        submit.textContent = busy ? 'Salvando…' : 'Salvar alterações';
        shell.element.setAttribute('aria-busy', busy ? 'true' : 'false');
        refreshStatus();
      },
      setLocked() {
        locked = true;
        submit.disabled = true;
        shell.setMessage('error', 'Este registro foi bloqueado como "' + DNC_LABEL + '" por baixo e não pode mais ser alterado. O que você digitou continua aqui, mas não pode ser salvo. Use Cancelar para sair.');
        refreshStatus();
      },
    };
    shell.element.addEventListener('submit', () => submitEdit(panel));
    return panel;
  }

  // Cancelar: sem alterações fecha direto; com alterações pergunta. Nada vai ao servidor.
  function cancelEdit(panel) {
    if (state.busy) return;
    if (panel.isDirty()) confirmDiscard({ onDiscard: closePanel });
    else closePanel();
  }

  async function submitEdit(panel) {
    if (state.busy || !current || current.panelApi !== panel) return;
    const id = state.record.id;
    const values = panel.form.read();
    const errors = validateForm(values);
    panel.form.showErrors(errors);
    if (Object.keys(errors).length > 0) {
      const total = Object.keys(errors).length;
      panel.setMessage('error', total === 1 ? 'Corrija o campo destacado. O que você digitou foi mantido.' : 'Corrija os ' + total + ' campos destacados. O que você digitou foi mantido.');
      panel.form.focusError(errors);
      return;
    }
    const patch = buildPatch(panel.initial, values);
    if (Object.keys(patch).length === 0) {
      panel.setMessage('info', 'Nenhuma alteração para salvar.');
      return;
    }
    await runWrite(panel, () => api.updateCrm(id, patch), (data) => {
      applyRecord(data && data.item);
      state.panel = null;
      setMessage('success', 'Alterações salvas.');
      publish('update', id);
    });
  }

  // ---- painel: mudar status ------------------------------------------------------
  function buildStatusPanel() {
    const currentStatus = state.record.item.status;
    // "Não contatar" NÃO é destino daqui: é terminal e tem painel próprio, com o aviso e a confirmação ("Marcar como Não contatar").
    const destinations = CRM_STATUSES.filter((status) => status.value !== currentStatus && status.value !== LOCKED_STATUS);
    const select = el('select', { id: 'crm-status-to', name: 'to' }, el('option', { value: '', text: 'Escolha o novo status' }), ...destinations.map((status) => el('option', { value: status.value, text: status.label })));
    select.value = '';
    const reason = el('textarea', { id: 'crm-status-reason', name: 'reason', rows: '2', maxlength: MAX_TEXT });
    const submit = el('button', { type: 'submit', className: 'btn primary', text: 'Confirmar mudança' });
    const cancel = el('button', { type: 'button', className: 'btn secondary', text: 'Cancelar', onclick: closePanel });
    const shell = panelShell(
      'Mudar status',
      [
        el('p', { className: 'muted', text: `Status atual: ${statusLabel(currentStatus)}. O sistema confere se a mudança é permitida.` }),
        el('p', { className: 'muted', text: `Para bloquear o contato de vez, use o botão "Marcar como ${DNC_LABEL}": ele pede confirmação, porque a ação é terminal.` }),
        el('div', { className: 'field' }, el('label', { for: 'crm-status-to', text: 'Novo status' }), select),
        el('div', { className: 'field' }, el('label', { for: 'crm-status-reason', text: 'Motivo (opcional)' }), reason),
      ],
      [submit, cancel]
    );
    shell.element.addEventListener('submit', async () => {
      if (state.busy) return;
      const to = String(select.value || '');
      if (to === '') {
        shell.setMessage('error', 'Escolha o novo status.');
        select.focus();
        return;
      }
      const id = state.record.id;
      await runWrite(shell, () => api.moveCrmStatus(id, to, String(reason.value || '').trim()), (data) => {
        applyRecord(data && data.item);
        state.panel = null;
        setMessage('success', `Status alterado para ${statusLabel(to)}.`);
        publish('status', id);
        loadHistory(id);
      });
    });
    return { element: shell.element, setBusy: shell.setBusy, setMessage: shell.setMessage, focus: () => select.focus() };
  }

  // ---- painel: não contatar (DO_NOT_CONTACT) ---------------------------------------
  function buildDncPanel() {
    const reason = el('textarea', { id: 'crm-dnc-reason', name: 'reason', rows: '2', maxlength: MAX_TEXT });
    const understood = el('input', { id: 'crm-dnc-understood', type: 'checkbox', name: 'understood' });
    const submit = el('button', { type: 'submit', className: 'btn danger', text: `Confirmar: marcar como ${DNC_LABEL}` });
    const cancel = el('button', { type: 'button', className: 'btn secondary', text: 'Cancelar', onclick: closePanel });
    const shell = panelShell(
      `Marcar como "${DNC_LABEL}"`,
      [
        el(
          'div',
          { className: 'notice bad', role: 'note' },
          el('p', { text: 'Atenção: esta é uma ação TERMINAL e não pode ser desfeita.' }),
          el('ul', { className: 'plain' }, el('li', { text: 'O registro deixa de poder ser editado e de mudar de status.' }), el('li', { text: 'O site, o telefone e o Instagram dele ficam bloqueados: nenhum outro registro poderá usá-los.' }))
        ),
        el('div', { className: 'field' }, el('label', { for: 'crm-dnc-reason', text: 'Motivo (opcional)' }), reason),
        el('div', { className: 'field checkbox' }, understood, el('label', { for: 'crm-dnc-understood', text: 'Entendo que esta ação é terminal e não pode ser desfeita.' })),
      ],
      [submit, cancel]
    );
    shell.element.addEventListener('submit', async () => {
      if (state.busy) return;
      if (!understood.checked) {
        shell.setMessage('error', 'Confirme que você entende que a ação é terminal para continuar.');
        understood.focus();
        return;
      }
      const id = state.record.id;
      await runWrite(shell, () => api.markCrmDnc(id, String(reason.value || '').trim()), (data) => {
        applyRecord(data && data.item);
        state.panel = null;
        setMessage('success', `Registro marcado como "${DNC_LABEL}". Ele agora está bloqueado.`);
        publish('dnc', id);
        loadHistory(id);
      });
    });
    return { element: shell.element, setBusy: shell.setBusy, setMessage: shell.setMessage, focus: () => reason.focus() };
  }

  // ---- painel: excluir (exclusão ADMINISTRATIVA e IRREVERSÍVEL — decisão 0025) -----------------------
  // Diferente dos demais painéis (que continuam na ficha, com o registro atualizado): excluir faz o registro deixar de existir, então o sucesso aqui NUNCA
  // chama applyRecord/runWrite — ele tira o registro da lista local, fecha a gaveta e volta para a lista (nunca deixar a ficha do registro excluído aberta).
  // O motivo é OBRIGATÓRIO e a confirmação (checkbox) também — os dois são exigidos AQUI, antes de qualquer chamada à API; o servidor exige o motivo de novo
  // (400 se ausente/vazio), porque a tela nunca é a camada de segurança: mesmo que o JavaScript fosse manipulado para pular esta checagem, o servidor recusaria.
  function buildDeletePanel() {
    const reason = el('textarea', { id: 'crm-delete-reason', name: 'reason', rows: '2', maxlength: MAX_TEXT });
    const understood = el('input', { id: 'crm-delete-understood', type: 'checkbox', name: 'understood' });
    const submit = el('button', { type: 'submit', className: 'btn danger', text: 'Excluir permanentemente' });
    const cancel = el('button', { type: 'button', className: 'btn secondary', text: 'Cancelar', onclick: closePanel });
    const shell = panelShell(
      'Excluir registro',
      [
        el('div', { className: 'notice bad', role: 'note' }, el('p', { text: 'Esta ação removerá permanentemente este registro do CRM.' })),
        el('div', { className: 'field' }, el('label', { for: 'crm-delete-reason', text: 'Motivo da exclusão (obrigatório)' }), reason),
        el('div', { className: 'field checkbox' }, understood, el('label', { for: 'crm-delete-understood', text: 'Entendo que esta ação é irreversível.' })),
      ],
      [submit, cancel]
    );
    shell.element.addEventListener('submit', async () => {
      if (state.busy) return;
      const motivo = String(reason.value || '').trim();
      if (motivo === '') {
        shell.setMessage('error', 'Informe o motivo da exclusão.');
        reason.focus();
        return;
      }
      if (!understood.checked) {
        shell.setMessage('error', 'Confirme que você entende que esta ação é irreversível.');
        understood.focus();
        return;
      }
      const id = state.record.id;
      setBusy(true);
      shell.setBusy(true);
      shell.setMessage(null);
      paintActions();
      try {
        await api.deleteCrm(id, motivo);
        setBusy(false);
        if (destroyed) return; // saiu-se (logout) durante o envio: nada mais a fazer nesta ficha
        removeListItem(id);
        publish('delete', id);
        leaveDeletedFicha();
        paintListParts();
        listNotice('success', 'Registro excluído.');
      } catch (error) {
        setBusy(false);
        if (!isCurrentRecord(id)) return;
        paintActions();
        shell.setBusy(false);
        const text = messageForCrmError(error);
        if (text) shell.setMessage('error', text);
        // Registro já não existe (excluído por outra sessão, ou nunca existiu): recarrega a ficha, que mostrará o 404.
        if (error && error.status === 404) loadRecord(id);
      }
    });
    return { element: shell.element, setBusy: shell.setBusy, setMessage: shell.setMessage, focus: () => reason.focus() };
  }

  // O registro foi excluído: fecha a gaveta e leva à lista. Com a navegação da sessão, o endereço do registro é substituído (o Voltar não reabre uma ficha inexistente).
  function leaveDeletedFicha() {
    if (navigation) {
      drawerCtl.dismiss('deleted');
      return;
    }
    drawerCtl.close({ silent: true, reason: 'deleted' });
    navigate(listHash);
  }

  // A ficha ocupada (enviando): ESC/X/fundo não fecham a gaveta no meio de uma operação.
  function setBusy(value) {
    state.busy = Boolean(value);
    if (current) current.handle.setBusy(state.busy);
  }

  // Executa uma escrita: trava os botões, chama a API e, em sucesso, aplica o resultado e redesenha a ficha; em falha,
  // mostra a recusa do servidor NO painel (o que a pessoa digitou fica) e, se o registro mudou por baixo (bloqueado,
  // inexistente), recarrega a ficha.
  async function runWrite(shell, call, onSuccess) {
    const id = state.record.id;
    setBusy(true);
    shell.setBusy(true);
    shell.setMessage(null);
    paintActions();
    try {
      const data = await call();
      setBusy(false);
      if (!isCurrentRecord(id)) {
        // a escrita deu certo no servidor, mas a ficha já não está na tela: a lista (e as outras telas) ainda precisam saber
        if (!destroyed && data && isRecordLike(data.item)) {
          upsertListItem(data.item);
          paintListParts();
          publish('update', data.item.id);
        }
        return;
      }
      onSuccess(data);
      paintRecordParts();
    } catch (error) {
      setBusy(false);
      paintActions();
      if (!isCurrentRecord(id)) return;
      shell.setBusy(false);
      const text = messageForCrmError(error);
      if (text) shell.setMessage('error', text);
      if (error && (error.status === 404 || (error.status === 409 && (error.code === 'RECORD_LOCKED' || error.code === 'INVALID_TRANSITION')))) loadRecord(id);
    }
  }

  // ---- abas (somente leitura) e histórico ---------------------------------------
  function valueNode(entry, record) {
    const text = displayValue(entry, record);
    if (text === '') return el('span', { className: 'muted', text: '—' });
    if (entry.kind === 'status') return statusBadge(record.status);
    if (entry.kind === 'url') {
      const url = safeHttpUrl(record[entry.key], { assumeHttps: entry.assumeHttps === true });
      if (url) return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text });
    }
    return el('span', { className: entry.kind === 'textarea' ? 'multiline' : '', text });
  }

  function fieldSection(spec, item) {
    return section(
      document,
      spec.title,
      el('dl', { className: 'fields' }, ...spec.keys.flatMap((key) => {
        const entry = FIELD_BY_KEY.get(key);
        return entry ? [el('dt', { text: entry.label }), el('dd', {}, valueNode(entry, item))] : [];
      }))
    );
  }

  function historyNode() {
    const { history } = state;
    if (history.status === 'loading' && history.entries.length === 0) return skeleton(document, { rows: 3, label: 'Carregando histórico…' });
    if (history.status === 'error') {
      return el(
        'div',
        {},
        el('p', { className: 'message error', role: 'alert', text: history.error }),
        el('button', { type: 'button', className: 'btn secondary', text: 'Tentar novamente', onclick: () => loadHistory(state.record.id) })
      );
    }
    const entries = describeHistory(history.entries, roleLabel);
    if (entries.length === 0) return el('p', { className: 'muted', text: 'Nenhum evento registrado.' });
    return el(
      'ul',
      { className: 'timeline' },
      ...entries.map((entry) =>
        el(
          'li',
          {},
          el('strong', { text: entry.transition }),
          el('span', { className: 'muted', text: ` — ${[entry.when, entry.who].filter(Boolean).join(' · ')}` }),
          entry.reason ? el('p', { className: 'timeline-reason', text: entry.reason }) : null
        )
      )
    );
  }

  // As abas da ficha. Só é redesenhado quando algo mudou (assinatura) — uma atualização em segundo plano não tira o foco da aba que a pessoa está usando.
  // Em modo de edição, as abas saem de cena (o formulário ocupa a gaveta) e voltam, sem perder a aba escolhida, quando a edição termina.
  function paintTabs(force = false) {
    if (!current) return;
    const { refs } = current;
    const record = state.record;
    refs.tabs.hidden = state.panel === 'edit';
    if (record.status === 'loading') {
      current.sig = '';
      current.tabs = null;
      fill(refs.tabs, skeleton(document, { rows: 6, label: 'Carregando o registro…' }));
      return;
    }
    if (record.status !== 'ready' || !record.item) {
      current.sig = '';
      current.tabs = null;
      fill(refs.tabs);
      return;
    }
    const sig = JSON.stringify([record.item, state.history.status, state.history.entries, state.history.error]);
    if (!force && current.tabs && current.sig === sig) return;
    current.sig = sig;
    const item = record.item;
    const tabs = createTabs(document, {
      idPrefix: 'crm-ficha',
      label: 'Dados do registro',
      active: state.tab,
      onChange: (key) => {
        state.tab = key;
      },
      tabs: RECORD_TABS.map((tab) => ({
        key: tab.key,
        label: tab.label,
        content: tab.key === 'historico' ? el('div', { className: 'ficha-block', id: 'crm-history' }, historyNode()) : el('div', { className: 'ficha-blocks' }, ...tab.sections.map((spec) => fieldSection(spec, item))),
      })),
    });
    const hadFocus = Boolean(document.activeElement && refs.tabs.contains(document.activeElement));
    current.tabs = tabs;
    fill(refs.tabs, tabs.element);
    if (hadFocus) {
      const tabButton = findTabButton(refs.tabs, tabs.active);
      if (tabButton) tabButton.focus();
    }
  }

  function findTabButton(container, key) {
    const stack = [container];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.childNodes || []) {
        if (child.nodeType !== 1) continue;
        if (child.localName === 'button' && child.getAttribute('role') === 'tab' && child.getAttribute('data-tab') === key) return child;
        stack.push(child);
      }
    }
    return null;
  }

  // ==========================================================================
  // FORMULÁRIO DE CAMPOS (compartilhado pela criação e pela edição)
  // ==========================================================================
  const dateFriendly = (value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value);

  // values: { campo: texto }. record: só na edição (mostra status e data de entrada, que o domínio gerencia). Devolve
  // { element, read(), showErrors(errors), focusFirst(), focusError(errors) }.
  function buildFieldForm({ values, record, layout = 'groups', onChange = () => {} }) {
    const controls = new Map();
    const errorSlots = new Map();
    const datalists = new Map();
    let tabsApi = null;
    const tabOfKey = new Map(RECORD_TABS.flatMap((tab) => tab.sections.flatMap((spec) => spec.keys.map((key) => [key, tab.key]))));

    function control(entry) {
      const id = `crm-field-${entry.key}`;
      const value = values[entry.key] || '';
      const suggest = SUGGESTION_KEYS.includes(entry.key);
      let input;
      if (entry.kind === 'textarea') {
        input = el('textarea', { id, name: entry.key, rows: '3', maxlength: MAX_TEXT, text: value });
      } else if (entry.kind === 'number') {
        // Texto, não type="number": um <input type="number"> devolve '' para o que o navegador não entende (ex.: "1.500,50"), e na
        // edição isso apagaria o valor sem aviso. Como texto, quem valida é o modelo (parseAmount), que aponta o erro.
        input = el('input', { id, name: entry.key, type: 'text', inputmode: 'decimal', maxlength: '20', autocomplete: 'off', placeholder: '0,00', value });
      } else if (entry.kind === 'date') {
        input = el('input', { id, name: entry.key, type: dateFriendly(value) ? 'date' : 'text', value });
      } else {
        input = el('input', {
          id,
          name: entry.key,
          type: entry.kind === 'email' ? 'email' : entry.kind === 'tel' ? 'tel' : 'text',
          maxlength: MAX_LINE,
          autocomplete: 'off',
          list: suggest ? `crm-suggest-${entry.key}` : null,
          value,
        });
      }
      const slot = el('p', { className: 'field-error', id: `${id}-error`, role: 'alert' });
      if (entry.required) input.setAttribute('aria-required', 'true');
      input.addEventListener('input', onChange);
      input.addEventListener('change', onChange);
      controls.set(entry.key, input);
      errorSlots.set(entry.key, slot);
      const wide = entry.kind === 'textarea';
      const datalist = suggest ? el('datalist', { id: `crm-suggest-${entry.key}` }) : null;
      if (datalist) datalists.set(entry.key, datalist);
      return el('div', { className: wide ? 'field wide' : 'field' }, el('label', { for: id, text: entry.required ? `${entry.label} (obrigatório)` : entry.label }), input, slot, datalist);
    }

    function managed(entry) {
      if (!record) return null;
      const shown = entry.kind === 'status' ? el('div', {}, statusBadge(record.status), el('p', { className: 'hint', text: 'Para mudar o status, use "Mudar status".' })) : el('span', { text: displayValue(entry, record) || '—' });
      return el('div', { className: 'field' }, el('span', { className: 'label', text: entry.label }), shown);
    }

    let element;
    if (layout === 'tabs') {
      const sectionNode = (spec) =>
        el(
          'fieldset',
          { className: 'form-block' },
          el('legend', { text: spec.title }),
          el('div', { className: 'form-grid' }, ...spec.keys.map((key) => (FIELD_BY_KEY.get(key).managed === true ? managed(FIELD_BY_KEY.get(key)) : control(FIELD_BY_KEY.get(key)))))
        );
      // as abas de edição são as da ficha, menos o Histórico (que não se edita); todos os campos ficam no DOM o tempo todo: trocar de aba nunca perde o que foi digitado
      tabsApi = createTabs(document, {
        idPrefix: 'crm-edit',
        label: 'Campos do registro',
        active: 'resumo',
        tabs: RECORD_TABS.filter((tab) => tab.sections.length > 0).map((tab) => ({ key: tab.key, label: tab.label, content: el('div', { className: 'edit-tab-body' }, ...tab.sections.map(sectionNode)) })),
      });
      element = el('div', { className: 'field-form field-form-tabs' }, tabsApi.element);
    } else {
      element = el(
        'div',
        { className: 'field-form' },
        ...FIELD_GROUPS.map((group) =>
          el(
            'fieldset',
            { className: 'form-block' },
            el('legend', { text: group.title }),
            el('div', { className: 'form-grid' }, ...group.fields.map((entry) => (entry.managed === true ? managed(entry) : control(entry))))
          )
        )
      );
    }

    return {
      element,
      read() {
        const read = {};
        for (const [key, input] of controls) read[key] = String(input.value === undefined || input.value === null ? '' : input.value);
        return read;
      },
      showErrors(errors) {
        for (const [key, slot] of errorSlots) {
          const message = Object.prototype.hasOwnProperty.call(errors, key) ? errors[key] : '';
          slot.textContent = message;
          const input = controls.get(key);
          if (message) input.setAttribute('aria-invalid', 'true');
          else input.removeAttribute('aria-invalid');
        }
        // nas abas, cada uma mostra quantos campos com erro tem (o erro nunca fica escondido numa aba fechada)
        if (tabsApi) {
          const perTab = new Map();
          for (const key of Object.keys(errors)) perTab.set(tabOfKey.get(key), (perTab.get(tabOfKey.get(key)) || 0) + 1);
          for (const tab of RECORD_TABS) if (tab.sections.length > 0) tabsApi.setBadge(tab.key, perTab.has(tab.key) ? String(perTab.get(tab.key)) : '');
        }
      },
      focusFirst() {
        const first = controls.get('empresa');
        if (first) first.focus();
      },
      focusError(errors) {
        const key = [...controls.keys()].find((name) => Object.prototype.hasOwnProperty.call(errors, name));
        if (!key) return;
        if (tabsApi) tabsApi.select(tabOfKey.get(key), { notify: false }); // abre a aba do primeiro erro, para o foco poder chegar nele
        controls.get(key).focus();
      },
      // As sugestões vêm dos dados já carregados (a lista pode chegar depois de o formulário abrir).
      paintSuggestions(items) {
        for (const [key, datalist] of datalists) fill(datalist, ...distinctValues(items, key).map((value) => el('option', { value })));
      },
    };
  }

  // ==========================================================================
  // NOVO REGISTRO (a página própria; vira gaveta numa etapa futura)
  // ==========================================================================
  // Devolve { element, focus() }: o foco só pode ir para o campo depois de a tela estar no documento.
  function buildNewScreen() {
    newForm = null;
    newDraft = null;
    const back = el('p', { className: 'back' }, anchor(listHash, '← Voltar à lista'));
    if (!canWrite) {
      return {
        element: el('section', { className: 'crm crm-new' }, back, el('h2', { id: 'crm-title', text: 'Novo registro' }), el('p', { className: 'notice warn', role: 'note', text: 'Sua conta não pode criar registros no CRM.' })),
        focus() {},
      };
    }

    const form = buildFieldForm({ values: {}, record: null });
    // Como em "Mudar status": um registro nunca nasce "Não contatar" sem o painel de confirmação (crie e depois bloqueie).
    const statusSelectNew = el('select', { id: 'crm-initial-status', name: 'status' }, ...CRM_STATUSES.filter((status) => status.value !== LOCKED_STATUS).map((status) => el('option', { value: status.value, text: status.label })));
    statusSelectNew.value = DEFAULT_INITIAL_STATUS;
    const reason = el('input', { id: 'crm-initial-reason', name: 'reason', type: 'text', maxlength: MAX_LINE, autocomplete: 'off' });
    const submit = el('button', { type: 'submit', className: 'btn primary', text: 'Criar registro' });
    const cancel = anchor(listHash, 'Cancelar', 'btn secondary');
    const panelMessage = el('div', { className: 'panel-message' });

    async function onSubmit(event) {
      event.preventDefault();
      if (state.busy) return;
      const values = form.read();
      const errors = validateForm(values);
      form.showErrors(errors);
      if (Object.keys(errors).length > 0) {
        paintMessageInto(panelMessage, { kind: 'error', text: 'Corrija os campos destacados.' });
        form.focusError(errors);
        return;
      }
      const { fields, options } = buildCreateRequest(values, { status: String(statusSelectNew.value || ''), reason: String(reason.value || '') });
      state.busy = true;
      submit.disabled = true;
      paintMessageInto(panelMessage, null);
      try {
        const data = await api.createCrm(fields, options);
        state.busy = false;
        const created = data && data.item;
        if (!isRecordLike(created)) throw Object.assign(new Error('resposta inesperada'), { status: 500 });
        if (destroyed) return; // saiu-se (logout) durante o envio: nenhum dado do CRM volta para a memória
        upsertListItem(created);
        newDraft = null; // foi salvo: ir para a ficha não perde nada
        state.stale = true;
        publish('create', created.id);
        const duplicate = data.duplicidade && typeof data.duplicidade === 'object' ? data.duplicidade : null;
        if (duplicate && typeof duplicate.matchedRecordId === 'string' && duplicate.matchedRecordId !== '') {
          state.flash = {
            kind: 'warn',
            text: 'Registro criado. Atenção: já existe um registro com o mesmo nome e cidade — pode ser uma duplicidade.',
            link: { href: buildHash({ name: 'crm-record', id: duplicate.matchedRecordId }), text: 'Ver o registro semelhante' },
          };
        } else {
          state.flash = { kind: 'success', text: 'Registro criado.' };
        }
        navigate(buildHash({ name: 'crm-record', id: created.id }));
      } catch (error) {
        state.busy = false;
        submit.disabled = false;
        const text = messageForCrmError(error);
        if (text) paintMessageInto(panelMessage, { kind: 'error', text });
      }
    }

    newForm = form;
    // há algo digitado? (qualquer campo, o motivo ou um status inicial diferente do padrão)
    newDraft = { isDirty: () => Object.values(form.read()).some((value) => value.trim() !== '') || String(reason.value || '').trim() !== '' || String(statusSelectNew.value || '') !== DEFAULT_INITIAL_STATUS };
    form.paintSuggestions(state.list.items);
    const element = el(
      'section',
      { className: 'crm crm-new' },
      back,
      el('h2', { id: 'crm-title', text: 'Novo registro' }),
      el('p', { className: 'muted', text: 'Só o nome da empresa é obrigatório. O sistema confere duplicidade e bloqueios ao salvar.' }),
      el(
        'form',
        { className: 'panel', novalidate: 'novalidate', 'aria-labelledby': 'crm-title', onsubmit: onSubmit },
        form.element,
        el(
          'fieldset',
          { className: 'form-block' },
          el('legend', { text: 'Entrada no CRM' }),
          el(
            'div',
            { className: 'form-grid' },
            el('div', { className: 'field' }, el('label', { for: 'crm-initial-status', text: 'Status inicial' }), statusSelectNew),
            el('div', { className: 'field' }, el('label', { for: 'crm-initial-reason', text: 'Motivo da entrada (opcional)' }), reason)
          )
        ),
        panelMessage,
        el('div', { className: 'form-actions' }, submit, cancel)
      )
    );
    return { element, focus: form.focusFirst };
  }

  // ==========================================================================
  // CICLO DE VIDA (chamado pelo shell a cada mudança de #)
  // ==========================================================================
  const scroller = () => document.scrollingElement || document.documentElement || null;

  function saveScroll() {
    const target = scroller();
    if (target && typeof target.scrollTop === 'number' && listScreen.parentNode === content) state.scrollTop = target.scrollTop;
  }

  function restoreScroll() {
    const target = scroller();
    if (target && state.scrollTop > 0) target.scrollTop = state.scrollTop;
  }

  async function show(route, { skipGuard = false } = {}) {
    if (destroyed) return;
    // Voltar/Avançar/link para outro lugar com edição não salva (ou salvando): não fecha nada sozinho.
    if (!skipGuard && state.visible && routeKey(route) !== currentKey()) {
      if (isSaving()) {
        refuseWhileSaving(restoreAddress);
        return;
      }
      if (hasUnsavedChanges()) {
        askLeave({ discard: () => show(route, { skipGuard: true }), stay: restoreAddress });
        return;
      }
    }
    const entering = !state.visible;
    state.visible = true;
    state.route = route;

    if (route.name === 'crm-new') {
      // já está na página de novo registro (ex.: o endereço devolvido depois de "Continuar editando"): não a refaz — refazer apagaria o que foi digitado
      if (newHost.parentNode === content && newDraft !== null) return;
      saveScroll();
      drawerCtl.listRoute();
      showScreen('new');
      const screen = buildNewScreen();
      fill(newHost, screen.element);
      screen.focus();
      if (canWrite) loadList({ quiet: true });
      return;
    }

    const returning = newHost.parentNode === content;
    if (returning) fill(newHost); // o formulário de "Novo registro" não fica guardado: a página só existe enquanto a rota existir
    newForm = null;
    showScreen('list');
    if (entering || returning) restoreScroll();

    if (route.name === 'crm-record') {
      drawerCtl.setRoute(route.id);
      if (drawerCtl.isOpen() && drawerCtl.state.selectedId === route.id) return;
      // a lista fica por baixo da ficha: carrega junto (sem esperar), para a gaveta abrir já
      if (state.loadedAt === null) {
        if (state.list.status !== 'loading') loadList();
      } else if (entering || state.stale) {
        loadList({ quiet: true });
      }
      drawerCtl.openFromRoute(route.id);
      return;
    }

    // rota da lista: fecha a gaveta (se estiver aberta) sem mexer no endereço
    drawerCtl.listRoute();
    if (state.loadedAt === null) {
      await loadList();
    } else if (entering || state.stale) {
      await loadList({ quiet: true });
    }
    // senão a lista já está desenhada: nada a refazer (repintar à toa tiraria o foco da linha que acabou de fechar a ficha)
  }

  // Quem troca de módulo (main.mjs) pergunta ANTES de mostrar o outro: 'saving' (não dá para sair), 'unsaved' (precisa perguntar) ou null (livre).
  function leaveState() {
    if (isSaving()) return 'saving';
    return hasUnsavedChanges() ? 'unsaved' : null;
  }

  // discard(): segue para onde a pessoa ia (o rascunho já foi descartado). stay(): leva o endereço de volta ao CRM.
  function confirmLeave({ discard, stay }) {
    if (isSaving()) {
      refuseWhileSaving(stay);
      return;
    }
    if (!hasUnsavedChanges()) {
      discard();
      return;
    }
    askLeave({ discard, stay });
  }

  // Atualizar ou fechar a aba com alteração não salva (ou salvando): pede ao navegador o aviso nativo. LIMITE REAL: o navegador decide se e como mostra o aviso (ele pode ignorar o pedido, sobretudo
  // se a pessoa ainda não interagiu com a página, e o texto não é nosso) — por isso a tela nunca afirma que o aviso vai aparecer.
  const releaseLeaveGuard = navigation && typeof navigation.setLeaveGuard === 'function' ? navigation.setLeaveGuard(() => !destroyed && (hasUnsavedChanges() || isSaving())) : null;

  // O módulo saiu de cena: a gaveta fecha (sem navegar) e busca, filtros, ordem, página e rolagem ficam guardados.
  function hide() {
    saveScroll();
    state.visible = false;
    drawerCtl.leave(overlays);
  }

  // Outra tela mudou um registro (ex.: promoção na Approval Queue): atualiza a lista em silêncio e a ficha aberta — sem tocar no formulário em uso.
  const unsubscribe = bus
    ? bus.subscribe('crm:changed', (event) => {
        if (destroyed || (event && event.source === 'crm')) return;
        state.stale = true;
        if (!state.visible || state.route.name === 'crm-new') return;
        loadList({ quiet: true });
        if (current && state.record.id && state.panel !== 'edit' && !state.busy) loadRecord(state.record.id);
      })
    : null;

  paintListParts();

  return {
    show,
    hide,
    refresh,
    state,
    leaveState,
    confirmLeave,
    hasUnsavedChanges: () => hasUnsavedChanges(),
    openRecord: (id) => drawerCtl.open(id),
    closeRecord: () => drawerCtl.close({ silent: false, reason: 'api' }),
    destroy() {
      destroyed = true;
      state.destroyed = true;
      if (unsubscribe) unsubscribe();
      if (releaseLeaveGuard) releaseLeaveGuard();
      drawerCtl.close({ silent: true, reason: 'destroy' });
      state.list = { status: 'idle', items: [], error: null };
      state.record = { id: null, item: null, status: 'idle', error: null };
      state.history = { status: 'idle', entries: [], error: null };
      current = null;
      newForm = null;
      newDraft = null;
      if (ownsUi) ui.destroy();
      fill(root);
    },
  };
}
