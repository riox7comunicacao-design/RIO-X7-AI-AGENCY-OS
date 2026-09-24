// Tela CRM — a lista de registros, a ficha de um registro e as ações de escrita (criar, editar, mudar status, marcar
// DO_NOT_CONTACT). Primeira versão operacional do CRM no Dashboard (decisão 0015 traz os contratos da API).
//
//   Browser -> esta tela -> api.mjs -> HTTP /api/crm -> CRM-API -> CRM Service -> CRM Domain -> repositório
//
// A tela conversa com o CRM SÓ pelo cliente de API (api.mjs): não importa o domínio, o Service nem o repositório, não usa
// `fetch` e não guarda nada no navegador. Quem autentica, autoriza e aplica as regras (status permitidos, duplicidade,
// DO_NOT_CONTACT, campos válidos) é o servidor. A tela só:
//   - MOSTRA ou esconde os botões de escrita conforme `permissions` (o que /api/me devolveu). Isso é conveniência de
//     interface, nunca autorização: um COMMERCIAL_CLOSER que forçasse a chamada receberia 403, e a tela trata o 403;
//   - oferece os status como opções e mostra a recusa do servidor (409) — não existe máquina de estados aqui. Só
//     DO_NOT_CONTACT não é opção de nenhum seletor: é terminal e só se alcança pela ação própria, com aviso e confirmação;
//   - nunca monta `userId`, `role`, `permissions`, `actor` ou `reviewedBy`: o corpo de uma escrita é só campos do
//     registro (e o status inicial/motivo), e a identidade de quem escreveu é a do token, gravada pelo servidor.
//
// SEGURANÇA: os dados de um registro são NÃO CONFIÁVEIS (pesquisa na web, digitação, IA no futuro). Tudo entra no DOM por
// dom.mjs (textContent, setAttribute) — nunca HTML. Um endereço só vira link se for http(s) (safeHttpUrl, com
// rel="noopener noreferrer"). Só os campos conhecidos são desenhados: um campo a mais no registro (authUserId, token...) nunca
// aparece. Nada aqui usa innerHTML, eval ou Function.
//
// ORGANIZAÇÃO: cada parte da tela (cabeçalho, mensagem, ações, painel, blocos, histórico) tem o seu contêiner e a sua
// função de desenho, e só o que mudou é redesenhado — assim uma resposta que chega tarde não apaga o que a pessoa está
// digitando num formulário, e a busca não perde o foco a cada tecla.

import { h, fill } from '../dom.mjs';
import { textOf, safeHttpUrl, roleLabel } from '../format.mjs';
import { buildHash } from '../router.mjs';
import {
  CRM_STATUSES,
  DEFAULT_INITIAL_STATUS,
  FIELD_GROUPS,
  LIST_COLUMNS,
  LOCKED_STATUS,
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
  sortRecords,
  statusLabel,
  statusTone,
  validateForm,
  valuesFromRecord,
} from '../crm-model.mjs';

export const PAGE_SIZE = 100;
const MAX_LINE = '500';
const MAX_TEXT = '4000';

const DNC_LABEL = 'Não contatar';

// document/root: onde desenhar. api: o cliente de api.mjs (listCrm, getCrm, getCrmHistory, createCrm, updateCrm,
// moveCrmStatus, markCrmDnc). permissions: { canWriteCrm } (de permissionsOf(me)). navigate(hash): muda a rota.
export function createCrmView({ document, root, api, permissions, navigate }) {
  const canWrite = Boolean(permissions && permissions.canWriteCrm);
  const state = {
    route: { name: 'crm-list' },
    list: { status: 'idle', items: [], error: null },
    query: '',
    filters: { status: '', nicho: '', responsavel: '' },
    visible: PAGE_SIZE,
    record: { id: null, item: null, status: 'idle', error: null },
    history: { status: 'idle', entries: [], error: null },
    panel: null,
    busy: false,
    message: null,
    flash: null,
    destroyed: false,
  };
  let refs = {};
  let listToken = 0;
  let recordToken = 0;
  let historyToken = 0;

  const el = (tag, props, ...children) => h(document, tag, props, ...children);
  const badge = (text, tone) => el('span', { className: `badge ${tone || 'neutral'}`, text });
  const statusBadge = (value) => badge(statusLabel(value), statusTone(value));
  const anchor = (href, text, className) => el('a', { href, className, text });

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

  function setMessage(kind, text, link) {
    state.message = text ? { kind, text, ...(link ? { link } : {}) } : null;
    paintMessageInto(refs.message, state.message);
  }

  // ---- roteamento (chamado pelo shell a cada mudança de #) ------------------

  function show(route) {
    if (state.destroyed) return;
    state.route = route;
    state.panel = null;
    state.message = state.flash;
    state.flash = null;
    if (route.name === 'crm-record') {
      openRecord(route.id);
    } else if (route.name === 'crm-new') {
      const screen = buildNewScreen();
      fill(root, screen.element);
      screen.focus();
      if (canWrite) loadList({ quiet: true });
    } else {
      fill(root, buildListScreen());
      loadList();
    }
  }

  function destroy() {
    state.destroyed = true;
    state.list = { status: 'idle', items: [], error: null };
    state.record = { id: null, item: null, status: 'idle', error: null };
    state.history = { status: 'idle', entries: [], error: null };
    refs = {};
    fill(root);
  }

  // ---- carga da lista ---------------------------------------------------------

  const isRecordLike = (item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '';

  async function loadList({ quiet = false } = {}) {
    const token = ++listToken;
    state.list.status = 'loading';
    state.list.error = null;
    if (!quiet) paintListParts();
    try {
      const data = await api.listCrm();
      if (state.destroyed || token !== listToken) return;
      state.list.items = Array.isArray(data && data.items) ? data.items.filter(isRecordLike) : [];
      state.list.status = 'ready';
    } catch (error) {
      if (state.destroyed || token !== listToken) return;
      state.list.status = 'error';
      state.list.error = messageForCrmError(error);
    }
    if (state.route.name === 'crm-list') paintListParts();
    else if (state.route.name === 'crm-new' && refs.form) refs.form.paintSuggestions(state.list.items);
  }

  // ==========================================================================
  // LISTA
  // ==========================================================================
  function buildListScreen() {
    refs = {};
    refs.message = el('div', { className: 'crm-message' });
    refs.count = el('p', { className: 'muted crm-count', role: 'status' });
    refs.search = el('input', {
      id: 'crm-search',
      type: 'search',
      autocomplete: 'off',
      placeholder: 'Empresa, contato, telefone, WhatsApp, e-mail ou Instagram',
      value: state.query,
      oninput: onSearch,
    });
    refs.status = el('select', { id: 'crm-filter-status', onchange: () => onFilter('status', refs.status.value) });
    refs.nicho = el('select', { id: 'crm-filter-nicho', onchange: () => onFilter('nicho', refs.nicho.value) });
    refs.responsavel = el('select', { id: 'crm-filter-responsavel', onchange: () => onFilter('responsavel', refs.responsavel.value) });
    refs.clear = el('button', { type: 'button', className: 'btn secondary', text: 'Limpar filtros', onclick: clearFilters });
    refs.results = el('div', { className: 'crm-results' });

    const filterField = (id, label, control) => el('div', { className: 'field' }, el('label', { for: id, text: label }), control);
    return el(
      'section',
      { className: 'crm', 'aria-labelledby': 'crm-title' },
      el(
        'div',
        { className: 'crm-head' },
        el('h2', { id: 'crm-title', text: 'CRM' }),
        refs.count,
        el('button', { type: 'button', className: 'btn secondary', text: 'Atualizar', onclick: () => loadList() }),
        canWrite ? anchor(buildHash({ name: 'crm-new' }), 'Novo registro', 'btn primary') : null
      ),
      refs.message,
      el(
        'form',
        { className: 'filters', role: 'search', onsubmit: (event) => event.preventDefault() },
        filterField('crm-search', 'Buscar', refs.search),
        filterField('crm-filter-status', 'Status', refs.status),
        filterField('crm-filter-nicho', 'Nicho', refs.nicho),
        filterField('crm-filter-responsavel', 'Responsável', refs.responsavel),
        el('div', { className: 'field filters-clear' }, refs.clear)
      ),
      refs.results
    );
  }

  function onSearch() {
    state.query = String(refs.search.value || '');
    state.visible = PAGE_SIZE;
    paintResults();
  }

  function onFilter(name, value) {
    state.filters[name] = String(value || '');
    state.visible = PAGE_SIZE;
    paintResults();
  }

  function clearFilters() {
    state.query = '';
    state.filters = { status: '', nicho: '', responsavel: '' };
    state.visible = PAGE_SIZE;
    if (refs.search) refs.search.value = '';
    paintFilterOptions();
    paintResults();
  }

  const hasCriteria = () => state.query.trim() !== '' || state.filters.status !== '' || state.filters.nicho !== '' || state.filters.responsavel !== '';

  function optionElements(allLabel, values) {
    return [el('option', { value: '', text: allLabel }), ...values.map((entry) => el('option', { value: entry.value, text: entry.label }))];
  }

  // As opções dos filtros vêm dos dados carregados; um valor escolhido que deixou de existir volta para "todos".
  function paintFilterOptions() {
    if (!refs.status) return;
    const nichos = distinctValues(state.list.items, 'nicho');
    const responsaveis = distinctValues(state.list.items, 'responsavel');
    const known = (values, chosen) => values.some((value) => normalizeText(value) === normalizeText(chosen));
    if (state.filters.nicho !== '' && !known(nichos, state.filters.nicho)) state.filters.nicho = '';
    if (state.filters.responsavel !== '' && !known(responsaveis, state.filters.responsavel)) state.filters.responsavel = '';

    fill(refs.status, ...optionElements('Todos os status', CRM_STATUSES.map((status) => ({ value: status.value, label: status.label }))));
    fill(refs.nicho, ...optionElements('Todos os nichos', nichos.map((value) => ({ value, label: value }))));
    fill(refs.responsavel, ...optionElements('Todos os responsáveis', responsaveis.map((value) => ({ value, label: value }))));
    refs.status.value = state.filters.status;
    refs.nicho.value = state.filters.nicho;
    refs.responsavel.value = state.filters.responsavel;
  }

  function paintListParts() {
    if (!refs.results) return;
    paintMessageInto(refs.message, state.message);
    paintFilterOptions();
    paintResults();
  }

  function matchingRecords() {
    return sortRecords(filterRecords(state.list.items, { query: state.query, ...state.filters }));
  }

  function paintResults() {
    if (!refs.results) return;
    const { list } = state;
    const total = list.items.length;

    if ((list.status === 'loading' || list.status === 'idle') && total === 0) {
      refs.count.textContent = '';
      fill(refs.results, el('p', { className: 'muted', text: 'Carregando registros…' }));
      return;
    }
    if (list.status === 'error' && total === 0) {
      refs.count.textContent = '';
      fill(refs.results,
        el('p', { className: 'message error', role: 'alert', text: list.error || 'Não foi possível carregar o CRM agora.' }),
        el('button', { type: 'button', className: 'btn secondary', text: 'Tentar novamente', onclick: () => loadList() })
      );
      return;
    }
    if (total === 0) {
      refs.count.textContent = '';
      fill(refs.results,
        el('p', { className: 'muted', text: 'Nenhum registro no CRM ainda.' }),
        canWrite ? anchor(buildHash({ name: 'crm-new' }), 'Criar o primeiro registro', 'btn primary') : null
      );
      return;
    }

    const matches = matchingRecords();
    refs.count.textContent = hasCriteria() ? `${matches.length} de ${total} registros` : `${total} ${total === 1 ? 'registro' : 'registros'}`;
    const extras = [];
    if (list.status === 'error') extras.push(el('p', { className: 'message error', role: 'alert', text: list.error || 'Não foi possível atualizar a lista. Estes são os dados já carregados.' }));
    if (matches.length === 0) {
      fill(refs.results,
        ...extras,
        el('p', { className: 'muted', text: 'Nenhum registro encontrado para esta busca ou filtro.' }),
        el('button', { type: 'button', className: 'btn secondary', text: 'Limpar busca e filtros', onclick: clearFilters })
      );
      return;
    }
    const shown = matches.slice(0, state.visible);
    fill(refs.results,
      ...extras,
      buildTable(shown),
      matches.length > shown.length
        ? el(
            'div',
            { className: 'actions' },
            el('span', { className: 'muted', text: `Mostrando ${shown.length} de ${matches.length}.` }),
            el('button', {
              type: 'button',
              className: 'btn secondary',
              text: 'Mostrar mais',
              onclick: () => {
                state.visible += PAGE_SIZE;
                paintResults();
              },
            })
          )
        : null
    );
  }

  function buildTable(records) {
    const head = el('tr', {}, ...LIST_COLUMNS.map((column) => el('th', { scope: 'col', text: column.label })));
    const rows = records.map((record) => {
      const cells = listCells(record);
      const cell = (column, content, value) => el('td', { 'data-label': column.label, className: value === '' ? 'empty' : '' }, content);
      const plain = (column) => cell(column, el('span', { text: cells[column.key] || '—' }), cells[column.key]);
      return el(
        'tr',
        {},
        el('td', { 'data-label': LIST_COLUMNS[0].label }, anchor(buildHash({ name: 'crm-record', id: record.id }), cells.empresa, 'link-button')),
        ...LIST_COLUMNS.slice(1).map((column) => (column.key === 'status' ? cell(column, statusBadge(record.status), textOf(record.status)) : plain(column)))
      );
    });
    return el(
      'div',
      { className: 'table-wrap' },
      el('table', { className: 'list crm-table' }, el('caption', { className: 'visually-hidden', text: 'Registros do CRM' }), el('thead', {}, head), el('tbody', {}, ...rows))
    );
  }

  // ==========================================================================
  // FICHA (detalhe de um registro)
  // ==========================================================================
  const isCurrentRecord = (id) => !state.destroyed && state.route.name === 'crm-record' && state.record.id === id;

  function openRecord(id) {
    const cached = state.list.items.find((item) => item.id === id) || null;
    state.record = { id, item: cached, status: cached ? 'ready' : 'loading', error: null };
    state.history = { status: 'loading', entries: [], error: null };
    fill(root, buildRecordScreen());
    paintRecordParts();
    loadRecord(id);
    loadHistory(id);
  }

  function buildRecordScreen() {
    refs = {};
    refs.message = el('div', { className: 'crm-message' });
    refs.head = el('div', { className: 'ficha-head' });
    refs.actions = el('div', { className: 'ficha-actions' });
    refs.panel = el('div', { className: 'ficha-panel' });
    refs.blocks = el('div', { className: 'ficha-blocks' });
    refs.history = el('section', { className: 'ficha-block', 'aria-labelledby': 'crm-history-title' });
    return el(
      'section',
      { className: 'crm crm-ficha' },
      el('p', { className: 'back' }, anchor(buildHash({ name: 'crm-list' }), '← Voltar à lista')),
      refs.head,
      refs.message,
      refs.actions,
      refs.panel,
      refs.blocks,
      refs.history
    );
  }

  function paintRecordParts() {
    paintHead();
    paintMessageInto(refs.message, state.message);
    paintActions();
    paintPanel();
    paintBlocks();
    paintHistory();
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
    if (state.panel !== 'edit') paintBlocks();
  }

  async function loadHistory(id) {
    const token = ++historyToken;
    state.history = { status: 'loading', entries: state.history.entries, error: null };
    paintHistory();
    try {
      const data = await api.getCrmHistory(id);
      if (!isCurrentRecord(id) || token !== historyToken) return;
      state.history = { status: 'ready', entries: Array.isArray(data && data.historico) ? data.historico : [], error: null };
    } catch (error) {
      if (!isCurrentRecord(id) || token !== historyToken) return;
      state.history = { status: 'error', entries: [], error: messageForCrmError(error) || 'Não foi possível carregar o histórico.' };
    }
    paintHistory();
  }

  function upsertListItem(item) {
    const index = state.list.items.findIndex((entry) => entry.id === item.id);
    if (index >= 0) state.list.items[index] = item;
    else state.list.items.push(item);
  }

  // Um registro devolvido por uma escrita passa a ser o atual (ficha e lista).
  function applyRecord(item) {
    if (!isRecordLike(item) || item.id !== state.record.id) throw Object.assign(new Error('resposta inesperada'), { status: 500 });
    state.record.item = item;
    state.record.status = 'ready';
    upsertListItem(item);
  }

  function paintHead() {
    if (!refs.head) return;
    const { record } = state;
    if (record.status === 'loading') {
      fill(refs.head, el('h2', { id: 'crm-title', text: 'Carregando registro…' }));
      return;
    }
    if (record.status === 'error') {
      fill(refs.head, el('h2', { id: 'crm-title', text: 'Registro' }), el('p', { className: 'message error', role: 'alert', text: record.error }));
      return;
    }
    const item = record.item;
    fill(refs.head, el('h2', { id: 'crm-title', text: textOf(item.empresa) || 'Sem nome' }), statusBadge(item.status));
  }

  // ---- ações -----------------------------------------------------------------

  function paintActions() {
    if (!refs.actions) return;
    const item = state.record.item;
    if (state.record.status !== 'ready' || !item) {
      fill(refs.actions);
      return;
    }
    if (isLocked(item)) {
      fill(refs.actions,
        el('p', { className: 'notice bad', role: 'note', text: `Este registro está bloqueado como "${DNC_LABEL}". Ele não pode mais ser editado nem mudar de status.` })
      );
      return;
    }
    if (!canWrite) {
      fill(refs.actions, el('p', { className: 'muted', text: 'Seu perfil pode consultar o CRM, mas não pode criar nem alterar registros.' }));
      return;
    }
    const button = (text, panel, className) =>
      el('button', { type: 'button', className: `btn ${className}`, text, 'aria-pressed': state.panel === panel ? 'true' : 'false', disabled: state.busy, onclick: () => togglePanel(panel) });
    fill(refs.actions, button('Editar', 'edit', 'secondary'), button('Mudar status', 'status', 'secondary'), button(`Marcar como ${DNC_LABEL}`, 'dnc', 'danger'));
  }

  function togglePanel(panel) {
    if (state.busy) return;
    state.panel = state.panel === panel ? null : panel;
    paintActions();
    paintPanel();
    if (state.panel === 'edit') fill(refs.blocks);
    else paintBlocks();
    if (refs.panelApi && refs.panelApi.focus) refs.panelApi.focus();
  }

  function closePanel() {
    if (state.busy) return;
    state.panel = null;
    paintActions();
    paintPanel();
    paintBlocks();
  }

  function paintPanel() {
    if (!refs.panel) return;
    refs.panelApi = null;
    if (state.panel === null || state.record.status !== 'ready' || !canWrite || isLocked(state.record.item)) {
      state.panel = null;
      fill(refs.panel);
      return;
    }
    refs.panelApi = state.panel === 'edit' ? buildEditPanel() : state.panel === 'status' ? buildStatusPanel() : buildDncPanel();
    fill(refs.panel, refs.panelApi.element);
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
  function buildEditPanel() {
    const item = state.record.item;
    const initial = valuesFromRecord(item);
    const form = buildFieldForm({ values: initial, record: item });
    form.paintSuggestions(state.list.items);
    const submit = el('button', { type: 'submit', className: 'btn primary', text: 'Salvar alterações' });
    const cancel = el('button', { type: 'button', className: 'btn secondary', text: 'Cancelar', onclick: closePanel });
    const shell = panelShell('Editar registro', [form.element], [submit, cancel]);
    shell.element.addEventListener('submit', () => submitEdit(shell, form, initial));
    return { element: shell.element, setBusy: shell.setBusy, setMessage: shell.setMessage, focus: form.focusFirst };
  }

  async function submitEdit(shell, form, initial) {
    if (state.busy) return;
    const id = state.record.id;
    const values = form.read();
    const errors = validateForm(values);
    form.showErrors(errors);
    if (Object.keys(errors).length > 0) {
      shell.setMessage('error', 'Corrija os campos destacados.');
      form.focusError(errors);
      return;
    }
    const patch = buildPatch(initial, values);
    if (Object.keys(patch).length === 0) {
      shell.setMessage('info', 'Nenhuma alteração para salvar.');
      return;
    }
    await runWrite(shell, () => api.updateCrm(id, patch), (data) => {
      applyRecord(data && data.item);
      state.panel = null;
      setMessage('success', 'Alterações salvas.');
    });
  }

  // ---- painel: mudar status ------------------------------------------------------
  function buildStatusPanel() {
    const current = state.record.item.status;
    // "Não contatar" NÃO é destino daqui: é terminal e tem painel próprio, com o aviso e a confirmação ("Marcar como Não contatar").
    const destinations = CRM_STATUSES.filter((status) => status.value !== current && status.value !== LOCKED_STATUS);
    const select = el('select', { id: 'crm-status-to', name: 'to' }, el('option', { value: '', text: 'Escolha o novo status' }), ...destinations.map((status) => el('option', { value: status.value, text: status.label })));
    select.value = '';
    const reason = el('textarea', { id: 'crm-status-reason', name: 'reason', rows: '2', maxlength: MAX_TEXT });
    const submit = el('button', { type: 'submit', className: 'btn primary', text: 'Confirmar mudança' });
    const cancel = el('button', { type: 'button', className: 'btn secondary', text: 'Cancelar', onclick: closePanel });
    const shell = panelShell(
      'Mudar status',
      [
        el('p', { className: 'muted', text: `Status atual: ${statusLabel(current)}. O sistema confere se a mudança é permitida.` }),
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
        loadHistory(id);
      });
    });
    return { element: shell.element, setBusy: shell.setBusy, setMessage: shell.setMessage, focus: () => reason.focus() };
  }

  // Executa uma escrita: trava os botões, chama a API e, em sucesso, aplica o resultado e redesenha a ficha; em falha,
  // mostra a recusa do servidor NO painel (o que a pessoa digitou fica) e, se o registro mudou por baixo (bloqueado,
  // inexistente), recarrega a ficha.
  async function runWrite(shell, call, onSuccess) {
    const id = state.record.id;
    state.busy = true;
    shell.setBusy(true);
    shell.setMessage(null);
    paintActions();
    try {
      const data = await call();
      state.busy = false;
      if (!isCurrentRecord(id)) return;
      onSuccess(data);
      paintRecordParts();
    } catch (error) {
      state.busy = false;
      paintActions();
      if (!isCurrentRecord(id)) return;
      shell.setBusy(false);
      const text = messageForCrmError(error);
      if (text) shell.setMessage('error', text);
      if (error && (error.status === 404 || (error.status === 409 && (error.code === 'RECORD_LOCKED' || error.code === 'INVALID_TRANSITION')))) loadRecord(id);
    }
  }

  // ---- blocos (somente leitura) e histórico ---------------------------------------
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

  function paintBlocks() {
    if (!refs.blocks) return;
    const item = state.record.item;
    if (state.record.status === 'loading') {
      fill(refs.blocks, el('p', { className: 'muted', text: 'Carregando…' }));
      return;
    }
    if (state.record.status !== 'ready' || !item) {
      fill(refs.blocks);
      return;
    }
    fill(refs.blocks,
      ...FIELD_GROUPS.map((group) =>
        el(
          'section',
          { className: 'ficha-block', 'aria-labelledby': `crm-block-${group.id}` },
          el('h3', { id: `crm-block-${group.id}`, text: group.title }),
          el('dl', { className: 'fields' }, ...group.fields.flatMap((entry) => [el('dt', { text: entry.label }), el('dd', {}, valueNode(entry, item))]))
        )
      )
    );
  }

  function paintHistory() {
    if (!refs.history) return;
    const { history } = state;
    const title = el('h3', { id: 'crm-history-title', text: 'Histórico' });
    if (history.status === 'loading' && history.entries.length === 0) {
      fill(refs.history, title, el('p', { className: 'muted', text: 'Carregando histórico…' }));
      return;
    }
    if (history.status === 'error') {
      fill(refs.history,
        title,
        el('p', { className: 'message error', role: 'alert', text: history.error }),
        el('button', { type: 'button', className: 'btn secondary', text: 'Tentar novamente', onclick: () => loadHistory(state.record.id) })
      );
      return;
    }
    const entries = describeHistory(history.entries, roleLabel);
    if (entries.length === 0) {
      fill(refs.history, title, el('p', { className: 'muted', text: 'Nenhum evento registrado.' }));
      return;
    }
    fill(refs.history,
      title,
      el(
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
      )
    );
  }

  // ==========================================================================
  // FORMULÁRIO DE CAMPOS (compartilhado pela criação e pela edição)
  // ==========================================================================
  const dateFriendly = (value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value);

  // values: { campo: texto }. record: só na edição (mostra status e data de entrada, que o domínio gerencia). Devolve
  // { element, read(), showErrors(errors), focusFirst(), focusError(errors) }.
  function buildFieldForm({ values, record }) {
    const controls = new Map();
    const errorSlots = new Map();
    const datalists = new Map();

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

    const element = el(
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
      },
      focusFirst() {
        const first = controls.get('empresa');
        if (first) first.focus();
      },
      focusError(errors) {
        const key = [...controls.keys()].find((name) => Object.prototype.hasOwnProperty.call(errors, name));
        if (key) controls.get(key).focus();
      },
      // As sugestões vêm dos dados já carregados (a lista pode chegar depois de o formulário abrir).
      paintSuggestions(items) {
        for (const [key, datalist] of datalists) fill(datalist, ...distinctValues(items, key).map((value) => el('option', { value })));
      },
    };
  }

  // ==========================================================================
  // NOVO REGISTRO
  // ==========================================================================
  // Devolve { element, focus() }: o foco só pode ir para o campo depois de a tela estar no documento.
  function buildNewScreen() {
    refs = {};
    const back = el('p', { className: 'back' }, anchor(buildHash({ name: 'crm-list' }), '← Voltar à lista'));
    if (!canWrite) {
      return {
        element: el('section', { className: 'crm crm-new' }, back, el('h2', { id: 'crm-title', text: 'Novo registro' }), el('p', { className: 'notice warn', role: 'note', text: 'Sua conta não pode criar registros no CRM.' })),
        focus() {},
      };
    }

    const form = buildFieldForm({ values: {}, record: null });
    // Como em "Mudar status": um registro nunca nasce "Não contatar" sem o painel de confirmação (crie e depois bloqueie).
    const statusSelect = el('select', { id: 'crm-initial-status', name: 'status' }, ...CRM_STATUSES.filter((status) => status.value !== LOCKED_STATUS).map((status) => el('option', { value: status.value, text: status.label })));
    statusSelect.value = DEFAULT_INITIAL_STATUS;
    const reason = el('input', { id: 'crm-initial-reason', name: 'reason', type: 'text', maxlength: MAX_LINE, autocomplete: 'off' });
    const submit = el('button', { type: 'submit', className: 'btn primary', text: 'Criar registro' });
    const cancel = anchor(buildHash({ name: 'crm-list' }), 'Cancelar', 'btn secondary');
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
      const { fields, options } = buildCreateRequest(values, { status: String(statusSelect.value || ''), reason: String(reason.value || '') });
      state.busy = true;
      submit.disabled = true;
      paintMessageInto(panelMessage, null);
      try {
        const data = await api.createCrm(fields, options);
        state.busy = false;
        const created = data && data.item;
        if (!isRecordLike(created)) throw Object.assign(new Error('resposta inesperada'), { status: 500 });
        if (state.destroyed) return; // saiu-se (logout) durante o envio: nenhum dado do CRM volta para a memória
        upsertListItem(created);
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

    refs.form = form;
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
            el('div', { className: 'field' }, el('label', { for: 'crm-initial-status', text: 'Status inicial' }), statusSelect),
            el('div', { className: 'field' }, el('label', { for: 'crm-initial-reason', text: 'Motivo da entrada (opcional)' }), reason)
          )
        ),
        panelMessage,
        el('div', { className: 'form-actions' }, submit, cancel)
      )
    );
    return { element, focus: form.focusFirst };
  }

  return { show, destroy, state };
}
