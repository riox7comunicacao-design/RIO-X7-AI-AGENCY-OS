// Tela FUNIS — o Kanban dos Funis configuráveis (reestruturação Prospecção/CRM/Funis, Etapa "Funis 2").
//
//   Browser -> esta tela -> api.mjs -> HTTP /api/funnels, /api/funnel-cards -> Funnel Service -> Funnel Domain
//
// Um CARD representa a posição COMERCIAL de um registro do CRM dentro de um funil — a tela NUNCA guarda nem
// inventa dados da empresa: tudo que aparece no card (empresa, contato, responsável, status legado, próxima
// ação, valor) vem da projeção que o servidor já devolve (`item.crm`), lida do CRM na hora.
//
// PERMISSÕES (só para MOSTRAR ou esconder controles — o servidor decide de verdade, e responde 403/409/400):
//   - ler o Kanban: READ:CRM (`canReadCrm`) — ambas as roles;
//   - adicionar um registro do CRM a um funil, ou mover um card: PROPOSE:CRM (`canProposeCrm`) — ADMIN e
//     COMMERCIAL_CLOSER;
//   - arquivar (remover) um card: WRITE:CRM (`canWriteCrm`) — só ADMIN. Arquivar NUNCA apaga o registro do CRM.
//   - administrar a ESTRUTURA do funil (criar/editar/excluir funil ou etapa) NÃO existe nesta tela ainda —
//     MANAGE:FUNNELS fica para uma tela de configuração própria, fora do escopo desta etapa.
//
// SEGURANÇA: os dados de um card/registro são NÃO CONFIÁVEIS (o mesmo princípio de views/crm.mjs) — tudo entra
// no DOM por dom.mjs (textContent), nunca innerHTML/eval/Function.

import { h, fill } from '../dom.mjs';
import { textOf } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { formatMoney, statusLabel, statusTone, normalizeText, matchesQuery } from '../crm-model.mjs';

// document/root: onde desenhar. api: o cliente de api.mjs. permissions: { canReadCrm, canProposeCrm, canWriteCrm }
// (de permissionsOf(me)). navigate(hash): muda a rota (para abrir a ficha do CRM a partir de um card).
export function createFunnelsView({ document, root, api, permissions, navigate }) {
  const canPropose = Boolean(permissions && permissions.canProposeCrm);
  const canArchive = Boolean(permissions && permissions.canWriteCrm);
  const state = {
    status: 'idle', // idle | loading | ready | error
    error: null,
    funnels: [],
    selectedFunnelId: null,
    stages: [],
    cards: [],
    query: '',
    addQuery: '',
    addOpen: false,
    crmItems: [], // carregado sob demanda, só quando o painel "adicionar" abre
    busyCardId: null,
    confirmingArchiveId: null, // confirmação INLINE (nunca window.confirm — este módulo roda igual num DOM de teste)
    message: null,
  };

  const el = (tag, props, ...children) => h(document, tag, props, ...children);

  function setMessage(kind, text) {
    state.message = text ? { kind, text } : null;
  }

  async function load() {
    state.status = 'loading';
    render();
    try {
      const data = await api.listFunnels();
      state.funnels = Array.isArray(data && data.items) ? data.items : [];
      if (!state.selectedFunnelId || !state.funnels.some((f) => f.id === state.selectedFunnelId)) {
        state.selectedFunnelId = state.funnels.length > 0 ? state.funnels[0].id : null;
      }
      await loadBoard();
      state.status = 'ready';
    } catch (error) {
      state.status = 'error';
      state.error = 'Não foi possível carregar os funis agora.';
    }
    render();
  }

  async function loadBoard() {
    if (!state.selectedFunnelId) {
      state.stages = [];
      state.cards = [];
      return;
    }
    const [stagesData, cardsData] = await Promise.all([api.listFunnelStages(state.selectedFunnelId), api.listFunnelCards(state.selectedFunnelId)]);
    state.stages = Array.isArray(stagesData && stagesData.items) ? stagesData.items : [];
    state.cards = Array.isArray(cardsData && cardsData.items) ? cardsData.items : [];
  }

  async function selectFunnel(funnelId) {
    if (state.selectedFunnelId === funnelId) return;
    state.selectedFunnelId = funnelId;
    state.status = 'loading';
    render();
    try {
      await loadBoard();
      state.status = 'ready';
    } catch {
      state.status = 'error';
      state.error = 'Não foi possível carregar este funil agora.';
    }
    render();
  }

  function cardsByStage(stageId) {
    const q = normalizeText(state.query);
    return state.cards.filter((card) => card.stageId === stageId && (q === '' || matchesQuery(card.crm || {}, state.query)));
  }

  async function moveCard(card, stageId) {
    if (state.busyCardId) return;
    state.busyCardId = card.id;
    render();
    try {
      const atualizado = await api.moveFunnelCard(card.id, stageId);
      const item = atualizado && atualizado.item;
      if (item) {
        const index = state.cards.findIndex((c) => c.id === item.id);
        if (index >= 0) state.cards[index] = item;
      }
      setMessage(null);
    } catch {
      setMessage('error', 'Não foi possível mover este card agora.');
    }
    state.busyCardId = null;
    render();
  }

  // Confirmação INLINE (nunca window.confirm): clicar em "Remover" pede confirmação no próprio card antes de
  // chamar a API — mesmo princípio de segurança de views/crm.mjs (a tela nunca decide sozinha, só evita o clique
  // acidental; o servidor é quem de fato autoriza e faz a remoção).
  function askArchive(cardId) {
    state.confirmingArchiveId = cardId;
    render();
  }
  function cancelArchive() {
    state.confirmingArchiveId = null;
    render();
  }
  async function archiveCard(card) {
    if (state.busyCardId) return;
    state.confirmingArchiveId = null;
    state.busyCardId = card.id;
    render();
    try {
      await api.deleteFunnelCard(card.id);
      state.cards = state.cards.filter((c) => c.id !== card.id);
      setMessage('success', 'Card removido do funil.');
    } catch {
      setMessage('error', 'Não foi possível remover este card agora.');
    }
    state.busyCardId = null;
    render();
  }

  async function openAddPanel() {
    state.addOpen = !state.addOpen;
    if (state.addOpen && state.crmItems.length === 0) {
      try {
        const data = await api.listCrm();
        state.crmItems = Array.isArray(data && data.items) ? data.items : [];
      } catch {
        setMessage('error', 'Não foi possível carregar os registros do CRM agora.');
      }
    }
    render();
  }

  async function addToFunnel(crmRecordId) {
    if (state.busyCardId || !state.selectedFunnelId) return;
    state.busyCardId = crmRecordId;
    render();
    try {
      const criado = await api.createFunnelCard(state.selectedFunnelId, crmRecordId);
      if (criado && criado.item) state.cards.push(criado.item);
      setMessage('success', 'Registro adicionado ao funil.');
      state.addOpen = false;
    } catch (error) {
      const code = error && error.code;
      setMessage('error', code === 'FUNNEL_CARD_DUPLICATE' ? 'Este registro já está neste funil.' : 'Não foi possível adicionar este registro agora.');
    }
    state.busyCardId = null;
    render();
  }

  // ---- desenho ---------------------------------------------------------------
  function cardNode(card) {
    const crm = card.crm;
    const empresa = crm ? textOf(crm.empresa) || 'Sem nome' : '(registro removido do CRM)';
    const linha = (texto) => (texto ? el('p', { className: 'funnel-card-line muted', text: texto }) : null);
    const outrasEtapas = state.stages.filter((s) => s.id !== card.stageId);
    const select = canPropose && outrasEtapas.length > 0
      ? el(
          'select',
          {
            'aria-label': `Mover ${empresa} para outra etapa`,
            disabled: state.busyCardId === card.id,
            onchange: (event) => {
              const valor = event.target.value;
              if (valor) moveCard(card, valor);
              event.target.value = '';
            },
          },
          el('option', { value: '', text: 'Mover para…' }),
          ...outrasEtapas.map((s) => el('option', { value: s.id, text: s.nome }))
        )
      : null;
    return el(
      'article',
      { className: 'funnel-card', 'data-busy': state.busyCardId === card.id ? 'true' : 'false' },
      crm
        ? el('a', { className: 'funnel-card-title', href: buildHash({ name: 'crm-record', id: card.crmRecordId }), text: empresa })
        : el('span', { className: 'funnel-card-title muted', text: empresa }),
      crm ? el('span', { className: `badge ${statusTone(crm.status)}`, text: statusLabel(crm.status) }) : null,
      linha(crm && crm.contato),
      linha(crm && crm.responsavel ? `Responsável: ${crm.responsavel}` : ''),
      linha(crm && crm.proximaAcao),
      linha(crm && typeof crm.valorProposta === 'number' ? `Proposta: ${formatMoney(crm.valorProposta)}` : ''),
      el(
        'div',
        { className: 'funnel-card-actions' },
        select,
        ...(canArchive && state.confirmingArchiveId === card.id
          ? [
              el('span', { className: 'muted', text: 'Remover deste funil?' }),
              el('button', { type: 'button', className: 'btn danger small', text: 'Confirmar', disabled: state.busyCardId === card.id, onclick: () => archiveCard(card) }),
              el('button', { type: 'button', className: 'btn secondary small', text: 'Cancelar', onclick: cancelArchive }),
            ]
          : canArchive
            ? [el('button', { type: 'button', className: 'btn secondary small', text: 'Remover', disabled: state.busyCardId === card.id, onclick: () => askArchive(card.id) })]
            : [])
      )
    );
  }

  function columnNode(stage) {
    const cards = cardsByStage(stage.id);
    return el(
      'section',
      { className: 'funnel-column', 'aria-labelledby': `funnel-stage-${stage.id}` },
      el('h3', { id: `funnel-stage-${stage.id}`, className: 'funnel-column-title', text: stage.nome }, el('span', { className: 'funnel-column-count', text: String(cards.length) })),
      el('div', { className: 'funnel-column-cards' }, ...(cards.length > 0 ? cards.map(cardNode) : [el('p', { className: 'muted', text: 'Nenhum card.' })]))
    );
  }

  function addPanelNode() {
    if (!state.addOpen) return null;
    const q = normalizeText(state.addQuery);
    const jaNoFunil = new Set(state.cards.map((c) => c.crmRecordId));
    const resultados = state.crmItems.filter((item) => !jaNoFunil.has(item.id) && (q === '' || normalizeText(item.empresa).includes(q))).slice(0, 20);
    return el(
      'div',
      { className: 'funnel-add-panel panel' },
      el('h3', { text: 'Adicionar registro do CRM a este funil' }),
      el('input', {
        type: 'search',
        placeholder: 'Buscar empresa…',
        value: state.addQuery,
        oninput: (event) => {
          state.addQuery = String(event.target.value || '');
          render();
        },
      }),
      el(
        'ul',
        { className: 'plain funnel-add-results' },
        ...resultados.map((item) =>
          el(
            'li',
            {},
            el('span', { text: textOf(item.empresa) || 'Sem nome' }),
            el('button', { type: 'button', className: 'btn secondary small', text: 'Adicionar', disabled: state.busyCardId === item.id, onclick: () => addToFunnel(item.id) })
          )
        ),
        resultados.length === 0 ? el('li', { className: 'muted', text: 'Nenhum registro encontrado.' }) : null
      )
    );
  }

  function render() {
    if (!root) return;
    if (!permissions.canReadCrm) {
      fill(root, el('p', { className: 'message error', role: 'alert', text: 'Sua conta não tem permissão para ver o Kanban de funis.' }));
      return;
    }
    const head = el(
      'div',
      { className: 'funnel-head' },
      el('h2', { text: 'Funis' }),
      state.funnels.length > 0
        ? el(
            'select',
            {
              'aria-label': 'Selecionar funil',
              value: state.selectedFunnelId || '',
              onchange: (event) => selectFunnel(event.target.value),
            },
            ...state.funnels.map((f) => el('option', { value: f.id, text: f.nome }))
          )
        : null,
      el('input', {
        type: 'search',
        placeholder: 'Buscar empresa no funil…',
        value: state.query,
        oninput: (event) => {
          state.query = String(event.target.value || '');
          render();
        },
      }),
      canPropose && state.selectedFunnelId ? el('button', { type: 'button', className: 'btn primary', text: state.addOpen ? 'Fechar' : '+ Adicionar card', onclick: openAddPanel }) : null
    );

    if (state.status === 'loading' && state.funnels.length === 0) {
      fill(root, head, el('p', { className: 'muted', text: 'Carregando…' }));
      return;
    }
    if (state.status === 'error') {
      fill(root, head, el('p', { className: 'message error', role: 'alert', text: state.error }), el('button', { type: 'button', className: 'btn secondary', text: 'Tentar novamente', onclick: load }));
      return;
    }
    if (state.funnels.length === 0) {
      fill(root, head, el('p', { className: 'muted', text: 'Nenhum funil configurado ainda.' }));
      return;
    }

    fill(
      root,
      head,
      state.message ? el('p', { className: `message ${state.message.kind}`, role: 'status', text: state.message.text }) : null,
      addPanelNode(),
      state.stages.length === 0
        ? el('p', { className: 'muted', text: 'Este funil ainda não tem etapas.' })
        : el('div', { className: 'funnel-board' }, ...state.stages.map(columnNode))
    );
  }

  function destroy() {
    fill(root);
  }

  return { load, render, destroy, state };
}
