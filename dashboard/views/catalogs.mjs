// As telas ADMINISTRATIVAS dos catálogos do CRM (CRM 5.0, Fase 2B-2): Serviços, Nichos e Cores e Origens dos Leads. Uma tela só, três configurações — o desenho é o mesmo e muda o conteúdo.
//
//   Browser -> esta tela -> api.mjs -> GET  /api/crm-catalogs/<catalogo>?todos=1                (a lista, com os desativados)
//                                   -> GET  /api/crm-catalogs/<catalogo>/:id                    (só para saber quanto o CRM usa o item: `emUso`)
//                                   -> POST /api/crm-catalogs/<catalogo>                         (criar)
//                                   -> PATCH /api/crm-catalogs/<catalogo>/:id                    (editar — só os campos que mudaram)
//                                   -> POST /api/crm-catalogs/<catalogo>/:id/activate|deactivate (reativar / desativar)
//                                   -> POST /api/crm-catalogs/<catalogo>/reorder                 (a nova ordem)
//
// O QUE ESTA TELA NUNCA FAZ: apagar (não existe exclusão — "excluir" é desativar), decidir permissão, criar proposta ou negociação, ligar o catálogo ao cadastro do CRM (isso é de uma fase
// posterior) ou ativar integração alguma. O servidor é a autoridade final de tudo: nome único (mesmo desativado), nome em uso pelo CRM, coerência de cobrança e permissão. Nenhum sucesso é
// mostrado antes de a API confirmar; se o armazenamento dos cadastros não está disponível (por exemplo, a estrutura de dados ainda não foi preparada), a tela diz isso com clareza.
//
// NAVEGAÇÃO: o painel lateral de "Novo ..." e o de edição têm URL (#/crm/configuracoes/<catalogo>/novo e .../<id>): link direto, Voltar fecha o painel sem sair da tela, Avançar reabre. A tela é
// PERSISTENTE na sessão: busca, filtro e rolagem sobrevivem a abrir o painel e a trocar de módulo. ESC, X e clique no fundo fecham o painel; havendo alteração não salva, o gerenciador de
// camadas pergunta antes ("Descartar alterações" / "Continuar editando"). O mesmo vale para Voltar/Avançar e para trocar de módulo (leaveState/confirmLeave, como no CRM).
//
// PERMISSÃO: MANAGE:CRM_CATALOGS (`canManageCrmCatalogs`, só ADMIN). Sem ela a tela não mostra nada nem chama a API (o servidor também recusa, 403).
// Todo texto entra por dom.mjs (textContent): nada de HTML dinâmico nem estilo inline.

import { h, fill } from '../dom.mjs';
import { formatDateTime, textOf } from '../format.mjs';
import { buildHash, catalogOfRoute } from '../router.mjs';
import { NAV_LABELS } from '../i18n/pt-BR.mjs';
import { createUi, createRoutedDrawer, statusBadge, emptyState, skeleton, pageHeader, searchField, selectField, kvList } from '../ui/index.mjs';
import { createCatalogForm } from './catalogForm.mjs';
import { STATUS_FILTERS, catalogErrorInfo, channelLabel, modalitiesSummary, periodicitiesOf, recurrenceLabel, priceText, visibleCatalogItems, MESSAGES, NO_MODALITY_LABEL } from '../catalog-model.mjs';
import { colorClassOf, colorNameOf } from '../catalog-colors.mjs';

const NEW_ID = '__novo__'; // o "id" do painel de novo item (um id real nunca é assim: service:<uuid>)
const NO_ACCESS = 'Esta conta não possui acesso a esta área.';

// Os textos de cada catálogo.
const CONFIG = Object.freeze({
  servicos: Object.freeze({
    key: 'servicos',
    gender: 'm',
    listRoute: 'crm-settings-services',
    title: 'Serviços',
    subtitle: 'O catálogo de serviços que a agência oferece. O preço de referência é apenas informativo: ele não altera propostas nem negociações.',
    newLabel: 'Novo Serviço',
    newDrawerTitle: 'Novo serviço',
    editDrawerTitle: 'Editar serviço',
    plural: 'serviços',
    singular: 'serviço',
    searchLabel: 'Buscar serviço',
    searchPlaceholder: 'Digite o nome do serviço…',
    loading: 'Carregando os serviços…',
    emptyTitle: 'Nenhum serviço cadastrado ainda.',
    emptyText: 'Cadastre os serviços que a agência oferece. Eles ficarão disponíveis para uso futuro no CRM.',
    noResultTitle: 'Nenhum serviço encontrado',
    created: 'Serviço criado.',
    updated: 'Serviço atualizado.',
    activated: 'Serviço reativado.',
    deactivated: 'Serviço desativado.',
    deactivateTitle: 'Desativar serviço?',
    deactivateDetail: 'O serviço deixa de aparecer nas listas de escolha. Nada é apagado: o que já usa este serviço continua como está, e você pode reativá-lo quando quiser.',
    reordered: 'Ordem dos serviços atualizada.',
  }),
  nichos: Object.freeze({
    key: 'nichos',
    gender: 'm',
    listRoute: 'crm-settings-niches',
    title: 'Nichos e Cores',
    subtitle: 'Os nichos de atuação dos clientes e a cor que identifica cada um. O nome do nicho aparece sempre junto da cor.',
    newLabel: 'Novo Nicho',
    newDrawerTitle: 'Novo nicho',
    editDrawerTitle: 'Editar nicho',
    plural: 'nichos',
    singular: 'nicho',
    searchLabel: 'Buscar nicho',
    searchPlaceholder: 'Digite o nome do nicho…',
    loading: 'Carregando os nichos…',
    emptyTitle: 'Nenhum nicho cadastrado ainda.',
    emptyText: 'Cadastre os nichos de atuação e escolha uma das 20 cores para cada um. Eles ficarão disponíveis para uso futuro no CRM.',
    noResultTitle: 'Nenhum nicho encontrado',
    created: 'Nicho criado.',
    updated: 'Nicho atualizado.',
    activated: 'Nicho reativado.',
    deactivated: 'Nicho desativado.',
    deactivateTitle: 'Desativar nicho?',
    deactivateDetail: 'O nicho deixa de aparecer nas listas de escolha. Nada é apagado: o que já usa este nicho continua como está, e você pode reativá-lo quando quiser.',
    reordered: 'Ordem dos nichos atualizada.',
  }),
  origens: Object.freeze({
    key: 'origens',
    gender: 'f',
    listRoute: 'crm-settings-origins',
    title: 'Origens dos Leads',
    subtitle: 'De onde os leads chegam: prospecção ativa, anúncio, indicação e outros canais. Este cadastro apenas organiza as origens: não ativa nenhuma integração com WhatsApp, Meta Ads, Google Ads ou IA.',
    newLabel: 'Nova Origem',
    newDrawerTitle: 'Nova origem',
    editDrawerTitle: 'Editar origem',
    plural: 'origens',
    singular: 'origem',
    searchLabel: 'Buscar origem',
    searchPlaceholder: 'Digite o nome da origem…',
    loading: 'Carregando as origens…',
    emptyTitle: 'Nenhuma origem cadastrada ainda.',
    emptyText: 'Cadastre as origens dos leads (por onde eles chegam). Elas ficarão disponíveis para uso futuro no CRM.',
    noResultTitle: 'Nenhuma origem encontrada',
    created: 'Origem criada.',
    updated: 'Origem atualizada.',
    activated: 'Origem reativada.',
    deactivated: 'Origem desativada.',
    deactivateTitle: 'Desativar origem?',
    deactivateDetail: 'A origem deixa de aparecer nas listas de escolha. Nada é apagado: o que já usa esta origem continua como está, e você pode reativá-la quando quiser.',
    reordered: 'Ordem das origens atualizada.',
  }),
});

const invalidResponse = () => Object.assign(new Error('INVALID_RESPONSE'), { status: 502, code: 'INVALID_RESPONSE' });

// A mesma ordem de exibição do servidor: `ordem`, depois o nome normalizado, depois o id.
function sortItems(items) {
  const rank = (item) => (Number.isInteger(item.ordem) ? item.ordem : Number.MAX_SAFE_INTEGER);
  return [...items].sort((a, b) => rank(a) - rank(b) || textOf(a.nomeNormalizado).localeCompare(textOf(b.nomeNormalizado)) || textOf(a.id).localeCompare(textOf(b.id)));
}

// ---------------------------------------------------------------------------
// UMA tela de catálogo
// ---------------------------------------------------------------------------
function createCatalogScreen({ document, catalog, api, ui, bus = null, navigation = null }) {
  const cfg = CONFIG[catalog];
  const overlays = ui.overlays;
  const toasts = ui.toasts;
  // unavailable: o SERVIDOR confirmou (503) que os cadastros estão indisponíveis — enquanto durar, nenhuma gravação é enviada. Uma falha de rede NÃO liga isto: é transitória. checking: uma nova verificação está em curso.
  const state = { status: 'idle', error: null, items: [], query: '', statusFilter: 'TODOS', busyId: null, reordering: false, loadedAt: null, visible: false, scrollTop: 0, message: null, unavailable: false, checking: false };
  let destroyed = false;
  let loadToken = 0;
  let current = null; // { form, handle, id } enquanto o painel está aberto
  let pendingFocus = null; // { id, action }: o botão que deve receber o foco depois de repintar a lista
  let detail = null; // { id, handle, usage, signature } enquanto o modal de DETALHES (somente leitura) está aberto

  const el = (tag, props, ...children) => h(document, tag, props, ...children);
  const pick = (masculine, feminine) => (cfg.gender === 'f' ? feminine : masculine);
  const byId = (id) => state.items.find((item) => item.id === id) || null;

  // --- estrutura estável (montada UMA vez; as regiões abaixo é que mudam) ---
  const content = el('div', { className: 'approvals-view catalog-view', 'data-catalog': catalog });
  const messageRegion = el('div', { className: 'message-region' });
  const hintRegion = el('div', { className: 'catalog-hint-region' });
  const availabilityRegion = el('div', { className: 'catalog-availability' });
  const counterEl = el('p', { className: 'pending-count toolbar-count' });
  const listRegion = el('div', { className: 'list-region' });
  const refreshButton = el('button', { type: 'button', className: 'btn secondary', 'data-action': 'refresh', text: 'Atualizar', onclick: () => refresh() });
  const newButton = el('button', { type: 'button', className: 'btn primary', id: `catalog-new-${catalog}`, 'data-action': 'new', text: cfg.newLabel, onclick: () => openNew() });
  const search = searchField(document, {
    id: `catalog-search-${catalog}`,
    label: cfg.searchLabel,
    placeholder: cfg.searchPlaceholder,
    onInput: (value) => {
      state.query = value;
      paintList();
    },
  });
  const statusSelect = selectField(document, {
    id: `catalog-status-${catalog}`,
    label: 'Situação',
    options: STATUS_FILTERS,
    value: state.statusFilter,
    onChange: (value) => {
      state.statusFilter = value;
      paintList();
    },
  });

  content.append(
    el(
      'section',
      { className: 'approvals', id: `catalog-${catalog}`, 'aria-labelledby': `catalog-title-${catalog}` },
      // o caminho de volta à página Configurações do CRM (de onde os três cadastros são abertos)
      el('nav', { className: 'breadcrumb', 'aria-label': 'Você está em' }, el('a', { href: buildHash({ name: 'crm-settings' }), text: NAV_LABELS.crmSettings }), el('span', { className: 'breadcrumb-sep', 'aria-hidden': 'true', text: '/' }), el('span', { 'aria-current': 'page', text: cfg.title })),
      pageHeader(document, { title: cfg.title, titleId: `catalog-title-${catalog}`, subtitle: cfg.subtitle, actions: [refreshButton, newButton] }),
      el('div', { className: 'toolbar toolbar-stacked' }, el('div', { className: 'toolbar-row toolbar-tools' }, search.element, statusSelect.element, counterEl)),
      messageRegion,
      availabilityRegion,
      hintRegion,
      el('div', { className: 'list-card catalog-card' }, listRegion)
    )
  );

  // `source` diz de onde veio o aviso: 'load' (a atualização da lista falhou — some quando uma atualização dá certo) ou 'action' (o resultado de uma ação da pessoa — fica até ser trocado).
  function setMessage(kind, text, source = 'action') {
    state.message = text ? { kind, text, source } : null;
    fill(messageRegion, state.message ? el('p', { className: `message ${state.message.kind === 'warning' ? 'warn' : state.message.kind}`, role: state.message.kind === 'error' ? 'alert' : 'status', text: state.message.text }) : null);
  }

  function notify(kind, text, source = 'action') {
    setMessage(kind === 'success' ? 'success' : kind, text, source);
    if (kind === 'error') toasts.error(text, { key: `catalog-${catalog}-feedback` });
    else if (kind === 'success') toasts.success(text, { key: `catalog-${catalog}-feedback` });
    else toasts.warning(text, { key: `catalog-${catalog}-feedback` });
  }

  function announce(action, id = null) {
    if (bus) bus.publish('crm-catalogs:changed', { catalog, action, id });
  }

  // ---- disponibilidade -------------------------------------------------------------------
  // O que a tela faz quando o servidor CONFIRMA a indisponibilidade (503): avisa com clareza, pausa TODA gravação (criar, editar, ativar/desativar, reordenar — nada é enviado), mantém a navegação,
  // a leitura e o "Tentar novamente", e preserva o rascunho de um painel já aberto. Só uma resposta bem-sucedida da lista a desliga. Falha de rede e erros comuns NÃO a ligam.
  const unavailableError = () => Object.assign(new Error('UNAVAILABLE'), { status: 503, code: 'CRM_CATALOG_PERSISTENCE' });

  function paintAvailability() {
    // sem itens na tela, o bloco de erro da lista já explica e oferece "Tentar novamente"; com itens, o aviso fica acima da lista
    const visible = state.unavailable && state.status !== 'error';
    fill(
      availabilityRegion,
      visible
        ? el(
            'div',
            { className: 'catalog-unavailable' },
            el('p', { className: 'message error', role: 'alert', text: `${MESSAGES.unavailable} ${MESSAGES.writesPaused}` }),
            el('button', { type: 'button', className: 'btn secondary', 'data-action': 'recheck', disabled: state.checking, text: state.checking ? 'Verificando…' : 'Tentar novamente', onclick: () => recheck() })
          )
        : null
    );
  }

  function applyAvailability() {
    newButton.disabled = state.unavailable;
    paintAvailability();
    paintList();
    if (current) current.form.setAvailability({ unavailable: state.unavailable, checking: state.checking });
  }

  function markUnavailable() {
    if (state.unavailable && !state.checking) return;
    state.unavailable = true;
    applyAvailability();
  }

  async function recheck() {
    if (state.checking || destroyed) return;
    state.checking = true;
    applyAvailability();
    try {
      await load({ quiet: true });
    } finally {
      state.checking = false;
      if (!destroyed) applyAvailability();
    }
  }

  function openNew() {
    if (state.unavailable) {
      notify('warning', MESSAGES.createBlocked);
      return;
    }
    drawerCtl.open(NEW_ID);
  }

  // ---- carga -------------------------------------------------------------------

  async function load({ quiet = false } = {}) {
    const token = ++loadToken;
    state.status = quiet && state.items.length > 0 ? 'ready' : 'loading';
    refreshButton.disabled = true;
    paintList();
    let failure = null;
    let failureKind = null;
    try {
      const data = await api.listCatalog(catalog, { todos: true });
      if (token !== loadToken || destroyed) return;
      if (!data || !Array.isArray(data.items)) throw invalidResponse();
      state.items = sortItems(data.items.filter((item) => item && typeof item.id === 'string'));
      state.loadedAt = Date.now();
    } catch (error) {
      if (token !== loadToken || destroyed) return;
      const info = catalogErrorInfo(error);
      if (info === null) return; // a sessão acabou: o fluxo de login cuida
      failure = info.message;
      failureKind = info.kind;
    }
    state.status = failure && state.items.length === 0 ? 'error' : 'ready';
    state.error = failure && state.items.length === 0 ? failure : null;
    refreshButton.disabled = false;
    // a disponibilidade só muda por uma resposta CONFIRMADA: lista carregada = disponível; 503 = indisponível; falha de rede ou outro erro = continua como estava
    if (failure === null) state.unavailable = false;
    else if (failureKind === 'unavailable') state.unavailable = true;
    if (failure && failureKind !== 'unavailable' && state.items.length > 0) notify('error', failure, 'load'); // a lista que já estava na tela fica; o erro aparece como aviso
    else if (failure === null && state.message && state.message.source === 'load') setMessage('info', null);
    applyAvailability();
  }

  function refresh() {
    setMessage('info', null);
    return load({ quiet: true });
  }

  // Coloca (ou troca) um item que o servidor confirmou, na ordem de exibição.
  function upsert(item) {
    const at = state.items.findIndex((entry) => entry.id === item.id);
    state.items = sortItems(at >= 0 ? state.items.map((entry) => (entry.id === item.id ? item : entry)) : [...state.items, item]);
  }

  // ---- reordenar -----------------------------------------------------------------
  // Só com a lista COMPLETA à vista (sem busca e com "Todos"): a nova ordem vale para todos os itens, ativos e desativados. A lista mostra a nova ordem já, mas ela só é considerada salva depois
  // que a API confirma; se a API falhar, a ordem anterior volta e a pessoa é avisada.
  const canReorder = () => state.query.trim() === '' && state.statusFilter === 'TODOS';

  async function move(id, delta) {
    if (!canReorder() || state.busyId !== null || state.reordering || state.unavailable || destroyed) return;
    const from = state.items.findIndex((item) => item.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= state.items.length) return;
    const previous = state.items;
    const next = [...previous];
    [next[from], next[to]] = [next[to], next[from]];
    state.items = next;
    state.reordering = true;
    pendingFocus = { id, action: delta < 0 ? 'up' : 'down' };
    setMessage('info', null);
    paintList();
    try {
      const data = await api.reorderCatalog(
        catalog,
        next.map((item) => item.id)
      );
      if (destroyed) return;
      if (!data || !Array.isArray(data.items)) throw invalidResponse();
      state.items = sortItems(data.items.filter((item) => item && typeof item.id === 'string'));
      state.reordering = false;
      paintList();
      notify('success', cfg.reordered);
      announce('reorder');
    } catch (error) {
      if (destroyed) return;
      state.items = previous; // a ordem anterior volta
      state.reordering = false;
      const info = catalogErrorInfo(error);
      paintList();
      if (info !== null && info.kind === 'unavailable') {
        markUnavailable(); // o aviso persistente (com "Tentar novamente") substitui o aviso de uma tentativa só
        return;
      }
      if (info !== null) notify('error', info.kind === 'validation' ? MESSAGES.staleList : /Nada foi alterado\.$/.test(info.message) ? info.message : `${info.message} A ordem não foi alterada.`);
      if (info !== null && (info.kind === 'validation' || info.kind === 'not-found')) load({ quiet: true });
    }
  }

  // ---- ativar / desativar -----------------------------------------------------------

  // Chama a API e atualiza a lista SÓ depois da confirmação. Lança Error com a mensagem para a pessoa (a confirmação a mostra sem fechar).
  async function runToggle(item, active) {
    if (state.busyId !== null || state.reordering) throw new Error('Aguarde a operação em andamento terminar.');
    if (state.unavailable) throw new Error(MESSAGES.unavailable); // indisponibilidade confirmada: nada é enviado
    state.busyId = item.id;
    paintList();
    try {
      const data = await (active ? api.activateCatalogItem(catalog, item.id) : api.deactivateCatalogItem(catalog, item.id));
      const saved = data && data.item;
      if (!saved || typeof saved.id !== 'string') throw invalidResponse();
      upsert(saved);
      announce(active ? 'activate' : 'deactivate', saved.id);
      return saved;
    } catch (error) {
      const info = catalogErrorInfo(error);
      if (info !== null && info.kind === 'not-found') load({ quiet: true });
      if (info !== null && info.kind === 'unavailable') markUnavailable();
      throw new Error(info !== null ? info.message : MESSAGES.generic);
    } finally {
      state.busyId = null;
      pendingFocus = { id: item.id, action: 'toggle' };
      paintList();
    }
  }

  async function reactivate(item) {
    try {
      await runToggle(item, true);
      notify('success', cfg.activated);
    } catch (error) {
      notify('error', error.message);
    }
  }

  // O que a pessoa lê sobre o impacto de desativar: quantos registros do CRM usam o item hoje (a contagem vem do servidor; sem ela, o aviso diz isso e nada é afirmado).
  function usageSentence(item, count) {
    const name = textOf(item.nome);
    if (!Number.isInteger(count)) return `Não foi possível verificar agora se ${pick('este', 'esta')} ${cfg.singular} é ${pick('usado', 'usada')} em registros do CRM. Nada é apagado de qualquer forma.`;
    if (count === 0) return `Nenhum registro do CRM usa ${pick('este', 'esta')} ${cfg.singular} hoje.`;
    return `${pick('Este', 'Esta')} ${cfg.singular} é ${pick('usado', 'usada')} em ${count} ${count === 1 ? 'registro' : 'registros'} do CRM. Eles continuam mostrando "${name}" exatamente como está (o histórico é preservado); ${pick('ele', 'ela')} só deixa de ser ${pick('oferecido', 'oferecida')} em novos cadastros.`;
  }

  const toggleFocusTarget = (id) => (detail && detail.id === id && detailAction('detail-toggle')) || rowAction(id, 'toggle');

  function askDeactivate(item) {
    if (state.busyId !== null || state.reordering || state.unavailable) return;
    const key = `catalog-deactivate:${catalog}:${item.id}`;
    if (overlays.isOpen(key)) return; // clique duplo: a pergunta já está aberta
    const note = el('p', { className: 'muted catalog-usage-note', role: 'status', text: `Verificando se ${pick('este', 'esta')} ${cfg.singular} é ${pick('usado', 'usada')} em registros do CRM…` });
    overlays.openConfirm({
      key,
      title: cfg.deactivateTitle,
      message: textOf(item.nome),
      body: note,
      detail: [cfg.deactivateDetail],
      confirmLabel: 'Desativar',
      cancelLabel: 'Cancelar',
      cancelFirst: true,
      busyLabel: 'Desativando…',
      onConfirm: async () => {
        await runToggle(item, false);
        notify('success', cfg.deactivated);
      },
      getReturnFocus: () => toggleFocusTarget(item.id),
    });
    // a contagem chega depois e só preenche o aviso (se a pergunta ainda está na tela); falhar nunca bloqueia a desativação
    api.getCatalogItem(catalog, item.id).then(
      (data) => {
        if (!destroyed && note.isConnected !== false) note.textContent = usageSentence(item, data && data.item ? data.item.emUso : null);
      },
      () => {
        if (!destroyed && note.isConnected !== false) note.textContent = usageSentence(item, null);
      }
    );
  }

  // ---- o modal de DETALHES (somente leitura): o corpo do cartão abre; Editar e Desativar/Reativar agem a partir dele ------------------------------------
  const detailAction = (name) => {
    if (!detail || !detail.handle.isOpen) return null;
    const stack = [detail.handle.element];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.childNodes || []) {
        if (child.nodeType !== 1) continue;
        if (child.localName === 'button' && child.getAttribute('data-action') === name) return child;
        stack.push(child);
      }
    }
    return null;
  };

  const modalitiesLines = (item) => {
    const lines = [];
    const periods = periodicitiesOf(item).map((value) => recurrenceLabel(value).toLowerCase());
    if (item.permitePagamentoUnico === true) lines.push('Pagamento único: permitido.');
    if (item.permitePagamentoRecorrente === true) lines.push(periods.length > 0 ? `Pagamento recorrente: permitido (${periods.join(', ')}).` : 'Pagamento recorrente: permitido.');
    return lines.length > 0 ? lines : [NO_MODALITY_LABEL + '.'];
  };

  function detailRows(item, usage) {
    const active = item.ativo === true;
    const text = (value, empty = 'Não informado') => textOf(value) || empty;
    const rows = [['Situação', statusBadge(document, active ? 'Ativo' : 'Inativo', active ? 'ok' : 'neutral')]];
    if (catalog === 'servicos') {
      rows.push(['Categoria', text(item.categoria)]);
      rows.push(['Preço de referência', typeof item.precoReferencia === 'number' ? `${priceText(item.precoReferencia)} (apenas informativo)` : 'Não informado']);
      rows.push(['Formas de pagamento permitidas', el('div', { className: 'catalog-detail-lines' }, ...modalitiesLines(item).map((line) => el('p', { text: line })))]);
    } else if (catalog === 'nichos') {
      const colorClass = colorClassOf(item.cor);
      rows.push(['Cor', el('span', { className: `nicho-chip${colorClass ? ` ${colorClass}` : ''}`, 'data-color': textOf(item.cor), text: colorNameOf(item.cor) || 'Sem cor definida' })]);
    } else {
      rows.push(['Canal', channelLabel(item.canal) || 'Canal não classificado']);
    }
    rows.push(['Descrição', text(item.descricao, 'Sem descrição')]);
    const position = state.items.findIndex((entry) => entry.id === item.id);
    if (position >= 0) rows.push(['Posição na lista', `${position + 1} de ${state.items.length}`]);
    rows.push(['Uso no CRM', usage === 'loading' ? 'Verificando…' : usageSentence(item, usage)]);
    const created = formatDateTime(item.criadoEm);
    const updated = formatDateTime(item.atualizadoEm);
    if (created) rows.push(['Criado', `${created}${textOf(item.criadoPorNome) ? ` por ${textOf(item.criadoPorNome)}` : ''}`]);
    if (updated) rows.push(['Última alteração', `${updated}${textOf(item.atualizadoPorNome) ? ` por ${textOf(item.atualizadoPorNome)}` : ''}`]);
    return rows;
  }

  function detailFooter(item) {
    const active = item.ativo === true;
    const locked = state.busyId !== null || state.reordering;
    const toggling = state.busyId === item.id;
    return el(
      'div',
      { className: 'actions catalog-detail-actions' },
      el('button', { type: 'button', className: 'btn secondary', 'data-item': item.id, 'data-action': 'detail-close', text: 'Fechar', onclick: () => detail && detail.handle.close('button') }),
      el('button', { type: 'button', className: 'btn secondary', 'data-item': item.id, 'data-action': 'detail-edit', 'aria-label': `Editar ${cfg.singular} ${textOf(item.nome)}`, text: 'Editar', disabled: locked, onclick: () => detailEdit(item.id) }),
      el('button', { type: 'button', className: `btn ${active ? 'danger' : 'primary'}`, 'data-item': item.id, 'data-action': 'detail-toggle', 'aria-label': `${active ? 'Desativar' : 'Reativar'} ${cfg.singular} ${textOf(item.nome)}`, text: toggling ? (active ? 'Desativando…' : 'Reativando…') : active ? 'Desativar' : 'Reativar', disabled: locked || state.unavailable, onclick: () => (active ? askDeactivate(item) : reactivate(item)) })
    );
  }

  function detailContent(item, usage) {
    return el('div', { className: 'catalog-detail' }, kvList(document, detailRows(item, usage), { className: 'fields catalog-detail-fields' }));
  }

  const detailSignature = (item) => JSON.stringify([item, state.items.length, state.items.findIndex((entry) => entry.id === item.id), state.busyId === item.id, state.busyId !== null || state.reordering, state.unavailable, detail ? detail.usage : null]);

  function openDetail(id) {
    const item = byId(id);
    if (!item || destroyed) return;
    const key = `catalog-detail:${catalog}:${id}`;
    if (overlays.isOpen(key)) return; // clique duplo: o modal já está aberto
    const handle = overlays.openModal({
      key,
      title: textOf(item.nome) || 'Sem nome',
      subtitle: `Detalhes ${pick('do', 'da')} ${cfg.singular}`,
      size: 'md',
      content: detailContent(item, 'loading'),
      footer: detailFooter(item),
      getReturnFocus: () => rowAction(id, 'details'),
      onClose: () => {
        if (detail && detail.handle === handle) detail = null;
      },
    });
    detail = { id, handle, usage: 'loading', signature: null };
    detail.signature = detailSignature(item);
    // quanto o CRM usa o item: chega depois; o modal já mostra tudo o mais
    api.getCatalogItem(catalog, id).then(
      (data) => {
        if (destroyed || !detail || detail.handle !== handle) return;
        detail.usage = data && data.item && Number.isInteger(data.item.emUso) ? data.item.emUso : null;
        refreshDetail();
      },
      () => {
        if (destroyed || !detail || detail.handle !== handle) return;
        detail.usage = null;
        refreshDetail();
      }
    );
  }

  // Repinta o modal só se o que ele mostra mudou (o item, a posição, o estado de ocupado, a disponibilidade, a contagem de uso): não rouba o foco à toa.
  function refreshDetail() {
    if (!detail || !detail.handle.isOpen) return;
    const item = byId(detail.id);
    if (!item) {
      detail.handle.close('gone', { force: true });
      return;
    }
    const signature = detailSignature(item);
    if (signature === detail.signature) return;
    detail.signature = signature;
    const hadFocusOn = document.activeElement && typeof document.activeElement.getAttribute === 'function' ? document.activeElement.getAttribute('data-action') : null;
    detail.handle.setTitle(textOf(item.nome) || 'Sem nome');
    detail.handle.setContent(detailContent(item, detail.usage));
    detail.handle.setFooter(detailFooter(item));
    const again = hadFocusOn ? detailAction(hadFocusOn) : null;
    if (again && !again.disabled) again.focus();
  }

  // Editar a partir do modal de detalhes: o modal fecha e o formulário abre (a mesma rota e o mesmo painel de sempre).
  function detailEdit(id) {
    if (state.busyId !== null || state.reordering || !detail || detail.id !== id) return;
    detail.handle.close('edit', { force: true });
    drawerCtl.open(id);
  }

  // ---- o painel lateral (novo / editar), com URL ---------------------------------------------

  const rowAction = (id, action) => {
    const stack = [listRegion];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.childNodes || []) {
        if (child.nodeType !== 1) continue;
        if (child.localName === 'button' && child.getAttribute('data-item') === id && child.getAttribute('data-action') === action) return child;
        stack.push(child);
      }
    }
    return null;
  };
  // o alvo do foco ao fechar o painel: o botão do nome (editar) da linha; para "Novo ...", o botão do cabeçalho
  const rowButtonOf = (id) => (id === NEW_ID ? newButton : rowAction(id, 'edit'));

  const drawerCtl = createRoutedDrawer({
    document,
    navigation,
    hashFor: (id) => (id === NEW_ID ? buildHash({ name: 'crm-catalog-new', catalog }) : buildHash({ name: 'crm-catalog-item', catalog, id })),
    listHash: buildHash({ name: cfg.listRoute }),
    rowButton: rowButtonOf,
    repaint: () => paintList(),
    build: (id, hooks) => openPanel(id, hooks),
  });

  function openPanel(id, hooks) {
    const isNew = id === NEW_ID;
    const item = isNew ? null : byId(id);
    if (!isNew && !item) return null;
    let handle = null;
    const form = createCatalogForm({
      document,
      catalog,
      mode: isNew ? 'create' : 'edit',
      item,
      onSubmit: (body) => save(id, body),
      onUnavailable: () => markUnavailable(),
      onRecheck: () => recheck(),
      onBusy: (busy) => {
        if (handle) handle.setBusy(busy);
      },
      onCancel: () => {
        if (handle) handle.close('cancel');
      },
    });
    handle = overlays.openDrawer({
      centered: true,
      key: `catalog:${catalog}:${isNew ? 'new' : id}`,
      title: isNew ? cfg.newDrawerTitle : textOf(item.nome) || cfg.editDrawerTitle,
      subtitle: isNew ? '' : cfg.editDrawerTitle,
      content: form.element,
      footer: form.footer,
      isDirty: () => form.isDirty(),
      initialFocus: () => form.initialFocus(),
      getReturnFocus: hooks.getReturnFocus,
      onClose: (reason) => {
        if (current && current.form === form) current = null;
        hooks.onClose(reason);
      },
    });
    current = { form, handle, id };
    if (state.unavailable) form.setAvailability({ unavailable: true, checking: state.checking }); // o painel abre já avisando (e sem enviar nada)
    if (!isNew) loadUsage(id, form);
    return handle;
  }

  // Quanto o CRM já usa o item (a leitura de um item do servidor traz `emUso` só para quem administra). Sem a informação, o servidor ainda recusa a troca do nome.
  async function loadUsage(id, form) {
    try {
      const data = await api.getCatalogItem(catalog, id);
      if (destroyed || !current || current.form !== form) return;
      const item = data && data.item;
      if (item && Number.isInteger(item.emUso)) form.setUsage(item.emUso);
    } catch {
      // sem a contagem a tela continua útil
    }
  }

  // Grava, e só depois de a API confirmar mostra o sucesso, atualiza a lista e fecha o painel. Se rejeitar, o formulário mostra o erro e continua aberto.
  async function save(id, body) {
    const isNew = id === NEW_ID;
    if (state.unavailable) throw unavailableError(); // indisponibilidade confirmada: não envia uma gravação que já se sabe que falhará
    let data;
    try {
      data = await (isNew ? api.createCatalogItem(catalog, body) : api.updateCatalogItem(catalog, id, body));
    } catch (error) {
      if (error && error.status === 404) load({ quiet: true });
      throw error;
    }
    const saved = data && data.item;
    if (!saved || typeof saved.id !== 'string') throw invalidResponse();
    upsert(saved);
    announce(isNew ? 'create' : 'update', saved.id);
    if (current) current.form.discard(); // salvo: não há mais alteração a proteger
    if (current) current.handle.setBusy(false);
    paintList();
    drawerCtl.close({ silent: false, reason: 'saved' }); // repinta a lista de novo e devolve o foco ao item (ou ao botão "Novo ...")
    notify('success', isNew ? cfg.created : cfg.updated);
  }

  // ==========================================================================
  // PROTEÇÃO DE ALTERAÇÕES NÃO SALVAS
  // ==========================================================================
  // O navegador não deixa CANCELAR um "Voltar", um "Avançar" ou um clique num link: quando o aviso chega, o endereço JÁ mudou. Por isso, com uma alteração não salva (ou um envio em andamento)
  // a tela, em vez de fechar o painel, pergunta; se a pessoa escolher "Continuar editando", leva o endereço de volta (navigation.restore) sem empilhar entradas. Sem alteração, a navegação é livre.
  //   ESC / X / fundo / Cancelar  -> o gerenciador de camadas (isDirty do painel)
  //   Voltar / Avançar / outro item -> show() abaixo
  //   trocar de módulo ou de catálogo -> main.mjs / createCatalogsView perguntam por leaveState()/confirmLeave() ANTES de mostrar o outro
  //   atualizar/fechar a aba -> o guarda de beforeunload (o navegador decide se e como mostra o aviso)
  const hasUnsavedChanges = () => !destroyed && current !== null && current.form.isDirty();
  const isSaving = () => !destroyed && current !== null && current.form.busy;
  const routeKey = (route) => (route.name === 'crm-catalog-new' ? 'new' : route.name === 'crm-catalog-item' ? `item:${route.id}` : 'list');
  const currentKey = () => (drawerCtl.isOpen() ? (drawerCtl.state.selectedId === NEW_ID ? 'new' : `item:${drawerCtl.state.selectedId}`) : 'list');
  const currentHash = () => {
    if (!drawerCtl.isOpen()) return buildHash({ name: cfg.listRoute });
    return drawerCtl.state.selectedId === NEW_ID ? buildHash({ name: 'crm-catalog-new', catalog }) : buildHash({ name: 'crm-catalog-item', catalog, id: drawerCtl.state.selectedId });
  };
  const restoreAddress = () => {
    if (navigation && typeof navigation.restore === 'function') navigation.restore(currentHash());
  };

  function confirmDiscard({ onDiscard, onStay = () => {} }) {
    overlays.openConfirm({
      key: `catalog-discard:${catalog}`,
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

  // A pergunta de saída. Um segundo aviso (outro "Voltar" com a pergunta aberta) só troca para onde a saída vai; a pergunta continua uma só.
  let pendingLeave = null;
  function askLeave({ discard, stay }) {
    pendingLeave = { discard, stay };
    confirmDiscard({
      onDiscard: () => {
        const leaving = pendingLeave;
        pendingLeave = null;
        if (current) current.form.discard();
        if (leaving) leaving.discard();
      },
      onStay: () => {
        const leaving = pendingLeave;
        pendingLeave = null;
        if (leaving) leaving.stay();
      },
    });
  }

  function refuseWhileSaving(stay) {
    toasts.warning('Aguarde o salvamento terminar antes de sair.', { key: `catalog-${catalog}-saving` });
    stay();
  }

  // Quem troca de módulo (main.mjs) ou de catálogo pergunta ANTES de mostrar o outro: 'saving' (não dá para sair), 'unsaved' (precisa perguntar) ou null (livre).
  function leaveState() {
    if (isSaving()) return 'saving';
    return hasUnsavedChanges() ? 'unsaved' : null;
  }

  // discard(): segue para onde a pessoa ia (o rascunho já foi descartado). stay(): leva o endereço de volta a este catálogo.
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

  const releaseLeaveGuard = navigation && typeof navigation.setLeaveGuard === 'function' ? navigation.setLeaveGuard(() => !destroyed && (hasUnsavedChanges() || isSaving())) : null;

  // ---- desenho -----------------------------------------------------------------

  function detailsOf(item) {
    if (catalog === 'servicos') {
      const parts = [];
      if (textOf(item.categoria) !== '') parts.push(textOf(item.categoria));
      if (typeof item.precoReferencia === 'number') parts.push(`Preço de referência: ${priceText(item.precoReferencia)}`);
      // todas as modalidades habilitadas numa só linha (o serviço aparece UMA vez); um serviço antigo, sem nenhuma, mostra o aviso
      parts.push(modalitiesSummary(item));
      return parts.join(' · ');
    }
    if (catalog === 'origens') return channelLabel(item.canal) || 'Canal não classificado';
    return '';
  }

  function buildRow(item, index, locked) {
    const active = item.ativo === true;
    const toggling = state.busyId === item.id;
    const colorClass = catalog === 'nichos' ? colorClassOf(item.cor) : '';
    const selected = drawerCtl.state.selectedId === item.id;
    const name = textOf(item.nome) || 'Sem nome';
    const description = textOf(item.descricao);
    const details = detailsOf(item);
    const reorderOn = canReorder() && !locked;
    const disabledMove = (offset) => !reorderOn || index + offset < 0 || index + offset >= state.items.length;
    const classes = ['catalog-row', active ? '' : 'is-inactive', catalog === 'nichos' ? `is-niche${colorClass ? ` ${colorClass}` : ''}` : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
    // Cada registro é um CARTÃO. O corpo (nome, situação, informações) abre o modal de detalhes; os botões ficam FORA do corpo (nenhum clique de botão sobe até ele) e cada um para a propagação.
    const guarded = (action) => (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      action();
    };
    return el(
      'li',
      { className: classes, 'data-id': item.id },
      el(
        'div',
        { className: 'catalog-row-main', onclick: () => openDetail(item.id) },
        el(
          'div',
          { className: 'catalog-row-title' },
          el('button', { type: 'button', className: 'catalog-name', 'data-item': item.id, 'data-action': 'details', 'aria-label': `Ver detalhes do ${cfg.singular} ${name}`, onclick: guarded(() => openDetail(item.id)), text: name }),
          statusBadge(document, active ? 'Ativo' : 'Inativo', active ? 'ok' : 'neutral'),
          catalog === 'nichos' ? el('span', { className: `nicho-chip${colorClass ? ` ${colorClass}` : ''}`, 'data-color': textOf(item.cor), text: colorNameOf(item.cor) || 'Sem cor definida' }) : null
        ),
        details !== '' ? el('p', { className: 'catalog-meta muted', text: details }) : null,
        description !== '' ? el('p', { className: 'catalog-desc', text: description }) : null
      ),
      el(
        'div',
        { className: 'catalog-row-actions' },
        el(
          'div',
          { className: 'catalog-move' },
          el('button', { type: 'button', className: 'btn small secondary', 'data-item': item.id, 'data-action': 'up', 'aria-label': `Subir ${cfg.singular} ${name} na ordem`, text: '↑', disabled: disabledMove(-1) || locked || state.unavailable, onclick: guarded(() => move(item.id, -1)) }),
          el('button', { type: 'button', className: 'btn small secondary', 'data-item': item.id, 'data-action': 'down', 'aria-label': `Descer ${cfg.singular} ${name} na ordem`, text: '↓', disabled: disabledMove(1) || locked || state.unavailable, onclick: guarded(() => move(item.id, 1)) })
        ),
        el('button', { type: 'button', className: 'btn small secondary', 'data-item': item.id, 'data-action': 'edit', 'aria-label': `Editar ${cfg.singular} ${name}`, 'aria-current': selected ? 'true' : null, text: 'Editar', disabled: locked, onclick: guarded(() => drawerCtl.open(item.id)) }),
        el('button', { type: 'button', className: 'btn small secondary', 'data-item': item.id, 'data-action': 'toggle', 'aria-label': `${active ? 'Desativar' : 'Reativar'} ${cfg.singular} ${name}`, text: toggling ? (active ? 'Desativando…' : 'Reativando…') : active ? 'Desativar' : 'Reativar', disabled: locked || state.unavailable, onclick: guarded(() => (active ? askDeactivate(item) : reactivate(item))) })
      )
    );
  }

  function paintHint() {
    const filtering = state.query.trim() !== '' || state.statusFilter !== 'TODOS';
    fill(hintRegion, filtering && state.items.length > 1 ? el('p', { className: 'muted catalog-hint', text: 'Para reordenar, limpe a busca e mostre todos os itens.' }) : null);
  }

  function paintList() {
    const total = state.items.length;
    const shown = visibleCatalogItems(state.items, { query: state.query, status: state.statusFilter });
    const narrowed = state.query.trim() !== '' || state.statusFilter !== 'TODOS';
    const base = `${total} ${total === 1 ? cfg.singular : cfg.plural}`;
    counterEl.textContent = narrowed && shown.length !== total ? `${base} · ${shown.length} no filtro` : base;
    paintHint();

    if (state.status === 'loading' && total === 0) {
      fill(listRegion, skeleton(document, { rows: 5, label: cfg.loading }));
      return;
    }
    if (state.status === 'error') {
      fill(listRegion, el('div', { className: 'catalog-error' }, el('p', { className: 'message error', role: 'alert', text: state.error }), el('button', { type: 'button', className: 'btn secondary', 'data-action': 'retry', text: 'Tentar novamente', onclick: () => load() })));
      return;
    }
    if (total === 0) {
      fill(listRegion, el('div', { id: `catalog-empty-${catalog}` }, emptyState(document, { title: cfg.emptyTitle, text: cfg.emptyText, action: el('button', { type: 'button', className: 'btn primary', 'data-action': 'new-empty', text: cfg.newLabel, disabled: state.unavailable, onclick: () => openNew() }) })));
      return;
    }
    if (shown.length === 0) {
      fill(
        listRegion,
        emptyState(document, {
          title: cfg.noResultTitle,
          text: 'Nada na lista combina com a busca ou com a situação escolhida. Ajuste ou limpe os filtros para ver todos.',
          action: el('button', { type: 'button', className: 'btn secondary', 'data-action': 'clear-filters', text: 'Limpar busca e filtros', onclick: () => clearFilters() }),
        })
      );
      return;
    }
    const locked = state.busyId !== null || state.reordering;
    fill(listRegion, el('ul', { className: 'catalog-list catalog-grid', id: `catalog-list-${catalog}`, 'aria-label': cfg.title }, ...shown.map((item) => buildRow(item, state.items.indexOf(item), locked))));
    if (pendingFocus && !locked) {
      const target = rowAction(pendingFocus.id, pendingFocus.action);
      const fallback = target && !target.disabled ? target : rowAction(pendingFocus.id, 'edit');
      pendingFocus = null;
      if (fallback) fallback.focus();
    }
    refreshDetail();
  }

  function clearFilters() {
    state.query = '';
    state.statusFilter = 'TODOS';
    search.setValue('');
    statusSelect.select.value = 'TODOS';
    paintList();
    search.input.focus();
  }

  // ---- roteamento (chamado pelo gerenciador a cada mudança de #) -----------------------------------

  const scroller = () => document.scrollingElement || document.documentElement || null;
  function saveScroll() {
    const target = scroller();
    if (target && typeof target.scrollTop === 'number' && content.parentNode) state.scrollTop = target.scrollTop;
  }
  function restoreScroll() {
    const target = scroller();
    if (target && state.scrollTop > 0) target.scrollTop = state.scrollTop;
  }

  async function show(route, { skipGuard = false } = {}) {
    if (destroyed) return;
    // Voltar/Avançar/link para outro lugar com alteração não salva (ou salvando): não fecha nada sozinho.
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
    if (entering) restoreScroll();

    if (route.name === 'crm-catalog-new' || route.name === 'crm-catalog-item') {
      const id = route.name === 'crm-catalog-new' ? NEW_ID : route.id;
      drawerCtl.setRoute(id);
      if (drawerCtl.isOpen() && drawerCtl.state.selectedId === id) return;
      if (state.loadedAt === null) await load();
      else if (entering) load({ quiet: true });
      if (destroyed || drawerCtl.state.routeId !== id) return;
      // criar com a indisponibilidade confirmada: o painel NÃO abre (o aviso já está na tela) e o endereço volta à lista
      if (id === NEW_ID && state.unavailable) {
        notify('warning', MESSAGES.createBlocked);
        drawerCtl.setRoute(null);
        if (navigation) navigation.replace(buildHash({ name: cfg.listRoute }));
        return;
      }
      if (id !== NEW_ID && !byId(id)) {
        // a lista nem carregou (erro já explicado na tela): não se diz que o item "não foi encontrado"
        if (state.status !== 'error') notify('warning', `Este ${cfg.singular} não foi encontrado na lista.`);
        drawerCtl.setRoute(null);
        if (navigation) navigation.replace(buildHash({ name: cfg.listRoute }));
        return;
      }
      drawerCtl.openFromRoute(id);
      return;
    }

    // rota da lista: fecha o painel (se estiver aberto) sem mexer no endereço; só atualiza se a tela estava fora de cena
    drawerCtl.listRoute();
    if (state.loadedAt === null) await load();
    else if (entering) await load({ quiet: true });
    // senão a lista já está desenhada: nada a refazer (repintar à toa tiraria o foco da linha que acabou de fechar o painel)
  }

  // A tela saiu de cena: o painel fecha (sem navegar); busca, filtro e rolagem ficam guardados.
  function hide() {
    saveScroll();
    state.visible = false;
    drawerCtl.leave(overlays);
  }

  paintList();

  return {
    element: content,
    catalog,
    state,
    show,
    hide,
    load,
    refresh,
    leaveState,
    confirmLeave,
    currentHash,
    recheck,
    isUnavailable: () => state.unavailable,
    hasUnsavedChanges: () => hasUnsavedChanges(),
    openNew: () => openNew(), // pela checagem de disponibilidade, como o botão e o link direto
    openItem: (id) => drawerCtl.open(id),
    openDetail: (id) => openDetail(id),
    isDetailOpen: () => detail !== null && detail.handle.isOpen,
    closePanel: () => drawerCtl.close({ silent: false, reason: 'api' }),
    isPanelOpen: () => drawerCtl.isOpen(),
    destroy() {
      destroyed = true;
      if (releaseLeaveGuard) releaseLeaveGuard();
      if (detail) detail.handle.close('destroy', { force: true });
      drawerCtl.close({ silent: true, reason: 'destroy' });
      state.items = [];
      current = null;
      fill(content);
    },
  };
}

// ---------------------------------------------------------------------------
// O gerenciador das três telas
// ---------------------------------------------------------------------------
// document/root: onde desenhar. api: { listCatalog, getCatalogItem, createCatalogItem, updateCatalogItem, activateCatalogItem, deactivateCatalogItem, reorderCatalog }. permissions:
// permissionsOf(me). ui/bus/navigation: os da sessão (opcionais; sem ui a tela cria o seu — testes).
export function createCatalogsView({ document, root, api, permissions, ui: providedUi = null, bus = null, navigation = null }) {
  const ownsUi = providedUi === null;
  const screenHost = h(document, 'div', { className: 'catalog-screens' });
  let ui = providedUi;
  if (ownsUi) {
    const host = h(document, 'div', { className: 'overlay-host' });
    root.replaceChildren(screenHost, host);
    ui = createUi({ document, host, getInertTargets: () => [screenHost] });
  } else {
    root.replaceChildren(screenHost);
  }
  const screens = {};
  let active = null;
  let destroyed = false;
  const canManage = Boolean(permissions) && permissions.canManageCrmCatalogs === true; // só o booleano verdadeiro vale (permissionsOf devolve sempre um booleano)

  const screenFor = (catalog) => {
    if (!screens[catalog]) screens[catalog] = createCatalogScreen({ document, catalog, api, ui, bus, navigation });
    return screens[catalog];
  };

  function show(route) {
    if (destroyed) return;
    const catalog = catalogOfRoute(route);
    if (catalog === null) return;
    if (!canManage) {
      if (active) active.hide();
      active = null;
      fill(screenHost, h(document, 'p', { className: 'message error', role: 'alert', text: NO_ACCESS }));
      return;
    }
    const next = screenFor(catalog);
    // Trocar de catálogo (Serviços -> Nichos...) com alteração não salva: a tela que sai pergunta antes.
    if (active && active !== next) {
      if (active.leaveState() !== null) {
        const leaving = active;
        leaving.confirmLeave({ discard: () => show(route), stay: () => navigation && typeof navigation.restore === 'function' && navigation.restore(leaving.currentHash()) });
        return;
      }
      active.hide();
    }
    active = next;
    fill(screenHost, next.element);
    next.show(route);
  }

  return {
    show,
    hide() {
      if (active) active.hide();
    },
    refresh() {
      return active ? active.refresh() : undefined;
    },
    leaveState: () => (active ? active.leaveState() : null),
    confirmLeave(handlers) {
      if (active) active.confirmLeave(handlers);
      else handlers.discard();
    },
    hasUnsavedChanges: () => Boolean(active && active.hasUnsavedChanges()),
    screen: (catalog) => screens[catalog] || null,
    get active() {
      return active;
    },
    destroy() {
      destroyed = true;
      for (const screen of Object.values(screens)) screen.destroy();
      active = null;
      if (ownsUi) ui.destroy();
      fill(root);
    },
  };
}
