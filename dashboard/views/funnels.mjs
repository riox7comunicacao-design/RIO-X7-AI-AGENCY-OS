// Tela FUNIS DE VENDAS — o QUADRO (Kanban) das NEGOCIAÇÕES por etapa (CRM 5.0, Fase D1, decisão 0028; antes, só cards avulsos da Etapa "Funis 2", que continuam aparecendo).
//
//   Browser -> esta tela -> api.mjs -> GET /api/funnel-board (o quadro inteiro, com os totais por etapa, calculado no servidor)
//                                   -> POST /api/negotiations (criar), PATCH /api/negotiations/:id (editar), POST .../move | win | lose | reopen
//                                   -> GET /api/crm e GET /api/crm-catalogs/servicos (só para ESCOLHER o cliente e o serviço no formulário)
//
// UM CARTÃO é UMA negociação: o cliente, o serviço, as condições acordadas e o valor. O corpo do cartão abre o MODAL de detalhes (condições, finanças, histórico); as ações ficam no modal.
// NADA é mostrado como feito antes de a API confirmar: mover, ganhar, perder e salvar só mudam a tela DEPOIS da resposta, relendo o quadro do servidor — uma falha nunca deixa uma movimentação falsa.
// Os números (cartões e valor em jogo por etapa) vêm do servidor; a tela nunca soma nem inventa valor. Valor recebido NÃO existe aqui: ganhar é uma decisão comercial, não pagamento.
//
// PERMISSÕES (só para MOSTRAR ou esconder controles — o servidor decide de verdade):
//   ler o quadro: READ:CRM (`canReadCrm`); criar, editar, mover, ganhar e perder: PROPOSE:CRM (`canProposeCrm`); reabrir e arquivar um card avulso: WRITE:CRM (`canWriteCrm`, só ADMIN);
//   criar funis e etapas é de outra tela (Gestão de Funis e Etapas, MANAGE:FUNNELS).
// SEGURANÇA: todo dado de cartão é NÃO CONFIÁVEL — tudo entra no DOM por dom.mjs (textContent), nunca innerHTML/eval/Function.

import { h, fill } from '../dom.mjs';
import { textOf, formatDateTime, formatDate } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { clientName, formatMoney, normalizeText } from '../crm-model.mjs';
import { statusBadge, emptyState, kvList } from '../ui/index.mjs';
import { createNegotiationForm } from './negotiationForm.mjs';
import { conditionsText, durationText, eventText, negotiationErrorInfo, noticeText, paymentText, scheduleText, situationLabel, situationTone, MESSAGES } from '../negotiation-model.mjs';

const MONEY_NOTE = Object.freeze({ UNICO: 'Valor total do contrato (uma cobrança só)', RECORRENTE: 'Valor de cada cobrança' });

// document/root: onde desenhar. api: o cliente de api.mjs. permissions: de permissionsOf(me). navigate(hash): muda a rota. ui: { overlays, toasts } da sessão.
export function createFunnelsView({ document, root, api, permissions, navigate = () => {}, navigation = null, ui }) {
  const canPropose = Boolean(permissions && permissions.canProposeCrm);
  const canReopen = Boolean(permissions && permissions.canWriteCrm);
  const canManageFunnels = Boolean(permissions && permissions.canManageFunnels);
  const overlays = ui.overlays;
  const toasts = ui.toasts;
  const state = {
    status: 'idle', // idle | loading | ready | error
    error: null,
    board: { funnels: [], funnelId: null, stages: [], cards: [], totais: [] },
    query: '',
    busyKey: null,
    message: null,
    detail: null, // { cardId, handle, history }
    refreshing: false,
  };
  let destroyed = false;
  let loadToken = 0;
  const handles = new Set(); // as camadas abertas por esta tela (fecham quando ela sai de cena)
  const trackedConfirm = (options) => {
    const handle = overlays.openConfirm(options);
    handles.add(handle);
    return handle;
  };

  const el = (tag, props, ...children) => h(document, tag, props, ...children);
  const cardById = (id) => state.board.cards.find((card) => card.id === id) || null;
  const stageName = (id) => (state.board.stages.find((stage) => stage.id === id) || { nome: '' }).nome;
  // o nome do cliente: PF -> nome completo, PJ e registro antigo -> empresa (a mesma regra do CRM; ver clientName)
  const empresaOf = (card) => clientName(card.negociacao && card.negociacao.cliente ? card.negociacao.cliente : card.crm) || 'Cliente sem nome';

  function setMessage(kind, text) {
    state.message = text ? { kind, text } : null;
  }
  function notify(kind, text) {
    setMessage(kind, text);
    if (kind === 'error') toasts.error(text, { key: 'funnels-feedback' });
    else if (kind === 'success') toasts.success(text, { key: 'funnels-feedback' });
    else toasts.warning(text, { key: 'funnels-feedback' });
  }

  // ---- carga: SEMPRE do servidor ------------------------------------------------------------------------------------------------------------
  async function load({ funnelId = state.board.funnelId, quiet = false } = {}) {
    const token = ++loadToken;
    if (!quiet || state.status !== 'ready') state.status = 'loading';
    state.refreshing = true;
    render();
    try {
      const data = await api.funnelBoard(funnelId || undefined);
      if (token !== loadToken || destroyed) return;
      const quadro = data && data.quadro;
      if (!quadro || !Array.isArray(quadro.funnels) || !Array.isArray(quadro.stages) || !Array.isArray(quadro.cards)) throw Object.assign(new Error('INVALID_RESPONSE'), { status: 502, code: 'INVALID_RESPONSE' });
      state.board = { funnels: quadro.funnels, funnelId: quadro.funnelId, stages: quadro.stages, cards: quadro.cards, totais: Array.isArray(quadro.totais) ? quadro.totais : [] };
      state.status = 'ready';
      state.error = null;
    } catch (error) {
      if (token !== loadToken || destroyed) return;
      const info = negotiationErrorInfo(error);
      if (info === null) return; // a sessão acabou: o fluxo de login cuida
      if (state.status !== 'ready') {
        state.status = 'error';
        state.error = info.kind === 'forbidden' ? 'Sua conta não tem permissão para ver o quadro de negociações.' : info.kind === 'not-found' ? 'O quadro de negociações não está disponível neste servidor.' : 'Não foi possível carregar o quadro agora. Tente novamente.';
      } else {
        notify('error', info.kind === 'network' ? MESSAGES.network : 'Não foi possível atualizar o quadro agora. O que está na tela pode estar desatualizado.');
      }
    }
    state.refreshing = false;
    render();
    refreshDetail();
  }
  const refresh = () => load({ quiet: true });

  // ---- ações (cada uma só muda a tela DEPOIS da confirmação do servidor) ------------------------------------------------------------------------
  async function run(key, action, { successText, onFail } = {}) {
    if (state.busyKey !== null || destroyed) return false;
    state.busyKey = key;
    setMessage('info', null);
    render();
    try {
      await action();
      if (destroyed) return true;
      state.busyKey = null;
      if (successText) notify('success', successText);
      await load({ quiet: true });
      return true;
    } catch (error) {
      if (destroyed) return false;
      state.busyKey = null;
      const info = negotiationErrorInfo(error);
      if (info !== null) {
        notify('error', info.kind === 'validation' ? (Object.values(info.fields)[0] || info.message) : info.message);
        // a negociação mudou ou sumiu por outra pessoa: relê o quadro para mostrar o que é verdade
        if (['closed', 'invalid-state', 'not-found', 'conflict'].includes(info.kind)) await load({ quiet: true });
      }
      if (onFail) onFail(info);
      render();
      return false;
    }
  }

  const moveNegotiation = (card, stageId) => run(`move:${card.id}`, () => api.moveNegotiation(card.negotiationId, stageId), { successText: 'Etapa atualizada.' });

  function confirmWin(card) {
    const negotiation = card.negociacao;
    trackedConfirm({
      key: `negotiation-win:${negotiation.id}`,
      title: 'Marcar como ganha?',
      message: `${empresaOf(card)} — ${textOf(negotiation.servicoNome)}`,
      detail: ['Isto registra a decisão comercial de fechar. Não registra pagamento: o valor recebido virá dos pagamentos, em outra etapa do sistema.', 'Você poderá pedir a um administrador para reabrir a negociação se for preciso.'],
      confirmLabel: 'Marcar como ganha',
      cancelLabel: 'Cancelar',
      cancelFirst: true,
      busyLabel: 'Salvando…',
      onConfirm: async () => {
        await api.winNegotiation(negotiation.id).catch((error) => { throw confirmError(error); });
        notify('success', 'Negociação marcada como ganha.');
        await load({ quiet: true });
      },
    });
  }
  function confirmLose(card) {
    const negotiation = card.negociacao;
    trackedConfirm({
      key: `negotiation-lose:${negotiation.id}`,
      title: 'Marcar como perdida?',
      message: `${empresaOf(card)} — ${textOf(negotiation.servicoNome)}`,
      detail: ['Conte o motivo: ele fica no histórico da negociação. Nada é apagado.'],
      field: { id: 'negotiation-lose-reason', label: 'Motivo da perda', required: true, requiredMessage: 'Informe o motivo da perda.', maxlength: 300, rows: 3 },
      tone: 'danger',
      confirmLabel: 'Marcar como perdida',
      cancelLabel: 'Cancelar',
      cancelFirst: true,
      busyLabel: 'Salvando…',
      onConfirm: async (motivo) => {
        await api.loseNegotiation(negotiation.id, motivo).catch((error) => { throw confirmError(error); });
        notify('success', 'Negociação marcada como perdida.');
        await load({ quiet: true });
      },
    });
  }
  function confirmReopen(card) {
    const negotiation = card.negociacao;
    trackedConfirm({
      key: `negotiation-reopen:${negotiation.id}`,
      title: 'Reabrir a negociação?',
      message: `${empresaOf(card)} — ${textOf(negotiation.servicoNome)}`,
      detail: ['A negociação volta a ficar aberta, na etapa em que estava. O histórico guarda o fechamento e a reabertura.'],
      confirmLabel: 'Reabrir',
      cancelLabel: 'Cancelar',
      cancelFirst: true,
      busyLabel: 'Salvando…',
      onConfirm: async () => {
        await api.reopenNegotiation(negotiation.id).catch((error) => { throw confirmError(error); });
        notify('success', 'Negociação reaberta.');
        await load({ quiet: true });
      },
    });
  }
  // o erro de uma confirmação aparece DENTRO dela (sem fechar); uma negociação que mudou recarrega o quadro
  function confirmError(error) {
    const info = negotiationErrorInfo(error);
    if (info !== null && ['closed', 'invalid-state', 'not-found', 'conflict'].includes(info.kind)) load({ quiet: true });
    return new Error(info === null ? MESSAGES.generic : info.kind === 'validation' ? Object.values(info.fields)[0] || info.message : info.message);
  }

  function confirmArchive(card) {
    trackedConfirm({
      key: `funnel-card-archive:${card.id}`,
      title: 'Remover este card do funil?',
      message: empresaOf(card),
      detail: ['O card sai do quadro. O registro do cliente no CRM e o histórico não são apagados.'],
      tone: 'danger',
      confirmLabel: 'Remover',
      cancelLabel: 'Cancelar',
      cancelFirst: true,
      busyLabel: 'Removendo…',
      onConfirm: async () => {
        await api.deleteFunnelCard(card.id).catch((error) => { throw confirmError(error); });
        notify('success', 'Card removido do funil.');
        await load({ quiet: true });
      },
    });
  }

  // ---- o formulário (nova / editar) --------------------------------------------------------------------------------------------------------------
  function info(title, paragraphs, action) {
    const handle = overlays.openModal({
      key: 'funnels-info',
      title,
      size: 'sm',
      content: el('div', { className: 'confirm-body' }, ...paragraphs.map((text) => el('p', { text }))),
      footer: el('div', { className: 'actions' }, ...(action ? [action] : []), el('button', { type: 'button', className: 'btn secondary', 'data-action': 'close', text: 'Entendi', onclick: () => handle.close('button') })),
    });
    handles.add(handle);
  }

  async function openForm(card = null, { clientId = '' } = {}) {
    if (!canPropose || state.busyKey !== null) return;
    const editing = card !== null;
    if (!editing && state.board.funnelId === null) {
      info('Ainda não há funil', ['Para abrir uma negociação é preciso ter um funil com etapas.', canManageFunnels ? 'Crie o funil e as etapas na Gestão de Funis e Etapas.' : 'Peça a um administrador para criar o funil e as etapas.']);
      return;
    }
    // os dados para ESCOLHER: clientes (CRM) e serviços (catálogo, só os ativos)
    state.busyKey = 'form';
    render();
    let clients;
    let services;
    try {
      const [crm, catalog] = await Promise.all([api.listCrm(), api.listCatalog('servicos')]);
      clients = (Array.isArray(crm && crm.items) ? crm.items : []).filter((item) => item && typeof item.id === 'string' && item.status !== 'DO_NOT_CONTACT').map((item) => ({ id: item.id, empresa: textOf(item.empresa), tipoPessoa: item.tipoPessoa === 'PF' || item.tipoPessoa === 'PJ' ? item.tipoPessoa : null, nomeCompleto: textOf(item.nomeCompleto), cpf: textOf(item.cpf), cnpj: textOf(item.cnpj), contato: textOf(item.contato), telefone: textOf(item.telefone), whatsapp: textOf(item.whatsapp), email: textOf(item.email) }));
      services = Array.isArray(catalog && catalog.items) ? catalog.items.filter((item) => item && item.ativo !== false) : [];
    } catch (error) {
      state.busyKey = null;
      render();
      const failure = negotiationErrorInfo(error);
      if (failure !== null) notify('error', failure.kind === 'network' ? MESSAGES.network : 'Não foi possível carregar os clientes e os serviços agora. Tente novamente.');
      return;
    }
    state.busyKey = null;
    render();
    if (destroyed) return;
    if (!editing) {
      if (clients.length === 0) {
        info('Ainda não há clientes', ['Uma negociação é sempre de um cliente que já está no CRM. Cadastre o cliente em Clientes e volte aqui.'], el('a', { className: 'btn primary', href: buildHash({ name: 'crm-list' }), text: 'Ir para Clientes', onclick: () => overlays.closeAll() }));
        return;
      }
      if (services.length === 0) {
        info('Ainda não há serviços ativos', ['Uma negociação é sempre de um serviço do catálogo.', canManageFunnels || canReopen ? 'Cadastre o serviço em Configurações do CRM → Serviços.' : 'Peça a um administrador para cadastrar os serviços.']);
        return;
      }
    }
    const key = editing ? `negotiation-form:${card.negotiationId}` : 'negotiation-form:new';
    if (overlays.isOpen(key)) return;
    let handle = null;
    const form = createNegotiationForm({
      document,
      mode: editing ? 'edit' : 'create',
      negotiation: editing ? card.negociacao : null,
      funnels: state.board.funnels,
      funnelId: state.board.funnelId || '',
      clients,
      initialClientId: clientId,
      services,
      onSubmit: async (body) => {
        // nada de sucesso antes da confirmação: a promessa só resolve DEPOIS da resposta; se rejeitar, o formulário mostra o erro e continua aberto
        try {
          if (editing) await api.updateNegotiation(card.negotiationId, body);
          else await api.createNegotiation(body);
        } catch (error) {
          // outra pessoa mudou a negociação enquanto o formulário estava aberto: o quadro é relido (o formulário fica com o que foi digitado e mostra o aviso)
          const info = negotiationErrorInfo(error);
          if (info !== null && info.kind === 'conflict') load({ quiet: true });
          throw error;
        }
        form.discard();
        handle.setBusy(false);
        handle.close('saved', { force: true });
        notify('success', editing ? 'Negociação atualizada.' : 'Negociação criada.');
        await load({ quiet: true });
      },
      onBusy: (busy) => handle && handle.setBusy(busy), // enquanto salva, a camada não fecha por ESC/X/fundo
      onCancel: () => handle && handle.close('cancel'),
    });
    handle = overlays.openDrawer({
      centered: true,
      key,
      title: editing ? `${empresaOf(card)} — editar negociação` : 'Nova negociação',
      subtitle: editing ? '' : state.board.funnels.find((funnel) => funnel.id === state.board.funnelId)?.nome || '',
      content: form.element,
      footer: form.footer,
      isDirty: () => form.isDirty(),
      initialFocus: () => form.initialFocus(),
      onClose: () => handles.delete(handle),
    });
    handles.add(handle);
  }

  // ---- o modal de DETALHES ------------------------------------------------------------------------------------------------------------------------
  function detailRows(card) {
    const negotiation = card.negociacao;
    if (!negotiation) {
      const crm = card.crm || {};
      return [
        ['Tipo', 'Card avulso (sem negociação): só a posição do cliente neste funil'],
        ['Cliente', el('a', { href: buildHash({ name: 'crm-record', id: card.crmRecordId }), text: empresaOf(card), onclick: () => overlays.closeAll() })],
        ['Etapa', stageName(card.stageId) || 'Etapa desconhecida'],
        ['Contato', textOf(crm.contato) || 'Não informado'],
        ['Responsável no CRM', textOf(crm.responsavel) || 'Não informado'],
        ['Próxima ação', textOf(crm.proximaAcao) || 'Não informada'],
        ['Entrou no funil', formatDateTime(card.criadoEm)],
      ];
    }
    const finance = negotiation.financeiro;
    const rows = [
      ['Situação', statusBadge(document, situationLabel(negotiation.situacao), situationTone(negotiation.situacao))],
      ['Cliente', el('a', { href: buildHash({ name: 'crm-record', id: negotiation.crmRecordId }), text: empresaOf(card), onclick: () => overlays.closeAll() })],
      ['Serviço', textOf(negotiation.servicoNome) || 'Serviço sem nome'],
      ['Etapa', `${stageName(card.stageId) || negotiation.stageNome || 'Etapa desconhecida'} · ${textOf(negotiation.funnelNome)}`],
      ['Forma de pagamento', paymentText(negotiation)],
      ['Prazo do contrato', durationText(negotiation)],
      ...(negotiation.duracao === 'INDETERMINADA' && Number.isInteger(negotiation.avisoPrevioDias) ? [['Aviso prévio de cancelamento', `${noticeText(negotiation.avisoPrevioDias)} (condição do contrato: não é duração, período mínimo nem cobrança adicional)`]] : []),
      ['Valor negociado', `${formatMoney(negotiation.valorNegociado)} — ${MONEY_NOTE[negotiation.formaPagamento] || ''}`],
    ];
    if (finance) {
      // contrato por prazo INDETERMINADO: o MRR é o destaque e o TCV é "Indeterminado" (nunca R$ 0,00 nem uma estimativa de 12 meses)
      if (finance.tcvIndeterminado === true) {
        if (finance.mrr !== null) rows.push(['MRR (receita recorrente mensal)', formatMoney(finance.mrr)]);
        else if (finance.equivalenteMensal !== null) rows.push(['Equivalente mensal', `${formatMoney(finance.equivalenteMensal)} (comparação; não é o que entra no caixa)`]);
        rows.push(['TCV (valor total do contrato)', 'Indeterminado (contrato sem prazo final)']);
      } else {
        rows.push(['TCV (valor total do contrato)', formatMoney(finance.tcv)]);
        if (finance.mrr !== null) rows.push(['MRR (receita recorrente mensal)', formatMoney(finance.mrr)]);
        else if (finance.equivalenteMensal !== null) rows.push(['Equivalente mensal', `${formatMoney(finance.equivalenteMensal)} (comparação; não é o que entra no caixa)`]);
      }
      rows.push(['Cronograma', scheduleText(finance.cronograma)]);
    }
    rows.push(['Responsável', textOf(negotiation.responsavelNome) || 'Não informado']);
    if (negotiation.previsaoFechamento) rows.push(['Previsão de fechamento', formatDate(negotiation.previsaoFechamento)]);
    if (negotiation.situacao === 'PERDIDA' && negotiation.motivoPerda) rows.push(['Motivo da perda', negotiation.motivoPerda]);
    if (negotiation.fechadoEm) rows.push(['Fechada em', formatDateTime(negotiation.fechadoEm)]);
    rows.push(['Criada', `${formatDateTime(negotiation.criadoEm)}${textOf(negotiation.criadoPorNome) ? ` por ${textOf(negotiation.criadoPorNome)}` : ''}`]);
    rows.push(['Última alteração', `${formatDateTime(negotiation.atualizadoEm)}${textOf(negotiation.atualizadoPorNome) ? ` por ${textOf(negotiation.atualizadoPorNome)}` : ''}`]);
    return rows;
  }

  function historyNode(card) {
    const negotiation = card.negociacao;
    if (negotiation) {
      const events = [...negotiation.eventos].reverse();
      return el('ol', { className: 'negotiation-history' }, ...events.map((event) => el('li', {}, el('span', { className: 'muted', text: `${formatDateTime(event.em)} · ${textOf(event.porNome) || 'Sistema'}` }), el('span', { text: eventText(event) }))));
    }
    const moves = state.detail && state.detail.history;
    if (moves === undefined || moves === null) return el('p', { className: 'muted', text: 'Carregando o histórico…' });
    if (moves === false) return el('p', { className: 'muted', text: 'Não foi possível carregar o histórico agora.' });
    return el('ol', { className: 'negotiation-history' }, ...[...moves].reverse().map((move) => el('li', {}, el('span', { className: 'muted', text: `${formatDateTime(move.movedAt)} · ${textOf(move.movedBy && move.movedBy.name) || 'Sistema'}` }), el('span', { text: move.stageFrom ? `Mudou de etapa: ${stageName(move.stageFrom) || 'etapa anterior'} → ${stageName(move.stageTo) || 'nova etapa'}.` : `Entrou na etapa ${stageName(move.stageTo) || 'inicial'}.` }))));
  }

  const detailContent = (card) => el('div', { className: 'negotiation-detail' }, kvList(document, detailRows(card), { className: 'fields negotiation-detail-fields' }), el('h3', { className: 'panel-section-title', text: 'Histórico' }), historyNode(card));

  function detailFooter(card) {
    const negotiation = card.negociacao;
    const busy = state.busyKey !== null;
    const buttons = [el('button', { type: 'button', className: 'btn secondary', 'data-action': 'detail-close', text: 'Fechar', onclick: () => state.detail && state.detail.handle.close('button') })];
    if (negotiation && negotiation.situacao === 'ABERTA' && canPropose) {
      buttons.push(
        el('button', { type: 'button', className: 'btn secondary', 'data-action': 'detail-edit', text: 'Editar', disabled: busy, onclick: () => { state.detail.handle.close('edit', { force: true }); openForm(card); } }),
        el('button', { type: 'button', className: 'btn danger', 'data-action': 'detail-lose', text: 'Perder', disabled: busy, onclick: () => confirmLose(card) }),
        el('button', { type: 'button', className: 'btn primary', 'data-action': 'detail-win', text: 'Ganhar', disabled: busy, onclick: () => confirmWin(card) })
      );
    } else if (negotiation && negotiation.situacao !== 'ABERTA' && canReopen) {
      buttons.push(el('button', { type: 'button', className: 'btn primary', 'data-action': 'detail-reopen', text: 'Reabrir', disabled: busy, onclick: () => confirmReopen(card) }));
    } else if (!negotiation && canReopen) {
      buttons.push(el('button', { type: 'button', className: 'btn danger', 'data-action': 'detail-archive', text: 'Remover do funil', disabled: busy, onclick: () => confirmArchive(card) }));
    }
    return el('div', { className: 'actions catalog-detail-actions' }, ...buttons);
  }

  function openDetail(cardId) {
    const card = cardById(cardId);
    if (!card || destroyed) return;
    const key = `funnel-card-detail:${cardId}`;
    if (overlays.isOpen(key)) return; // clique duplo: já está aberto
    const handle = overlays.openModal({
      key,
      title: empresaOf(card),
      subtitle: card.negociacao ? 'Detalhes da negociação' : 'Detalhes do card',
      size: 'md',
      content: detailContent(card),
      footer: detailFooter(card),
      getReturnFocus: () => findButton(cardId),
      onClose: () => {
        if (state.detail && state.detail.handle === handle) state.detail = null;
        handles.delete(handle);
      },
    });
    handles.add(handle);
    state.detail = { cardId, handle, history: card.negociacao ? null : undefined, signature: JSON.stringify([card, state.busyKey]) };
    if (!card.negociacao) {
      // o histórico de um card avulso (movimentações), só leitura
      api.getFunnelCardHistory(card.id).then(
        (data) => {
          if (destroyed || !state.detail || state.detail.handle !== handle) return;
          state.detail.history = Array.isArray(data && data.historico) ? data.historico : false;
          refreshDetail(true);
        },
        () => {
          if (destroyed || !state.detail || state.detail.handle !== handle) return;
          state.detail.history = false;
          refreshDetail(true);
        }
      );
    }
  }

  function refreshDetail(force = false) {
    if (!state.detail || !state.detail.handle.isOpen) return;
    const card = cardById(state.detail.cardId);
    if (!card) {
      state.detail.handle.close('gone', { force: true });
      return;
    }
    const signature = JSON.stringify([card, state.busyKey, state.detail.history ?? null]);
    if (!force && signature === state.detail.signature) return;
    state.detail.signature = signature;
    state.detail.handle.setContent(detailContent(card));
    state.detail.handle.setFooter(detailFooter(card));
  }

  // ---- o desenho ---------------------------------------------------------------------------------------------------------------------------------
  function findButton(cardId) {
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.childNodes || []) {
        if (child.nodeType !== 1) continue;
        if (child.localName === 'button' && child.getAttribute('data-card') === cardId && child.getAttribute('data-action') === 'open') return child;
        stack.push(child);
      }
    }
    return null;
  }

  const matches = (card, query) => {
    const q = normalizeText(query);
    if (q === '') return true;
    const n = card.negociacao;
    return [empresaOf(card), n && n.servicoNome, n && n.responsavelNome].some((value) => normalizeText(textOf(value)).includes(q));
  };

  // o valor do cartão: o TCV; num contrato por prazo INDETERMINADO, o MRR (ou o equivalente mensal) e "TCV indeterminado" — nunca um TCV zerado nem estimado
  function cardValueText(finance) {
    if (finance.tcvIndeterminado !== true) return `TCV ${formatMoney(finance.tcv)}`;
    const monthly = finance.mrr !== null && finance.mrr !== undefined ? `MRR ${formatMoney(finance.mrr)}` : typeof finance.equivalenteMensal === 'number' ? `Equivalente mensal ${formatMoney(finance.equivalenteMensal)}` : '';
    return [monthly, 'TCV indeterminado'].filter(Boolean).join(' · ');
  }

  // o total da coluna: o TCV conhecido; os contratos de TCV indeterminado são contados à parte (e o MRR deles aparece) — nunca somados como zero
  function columnTotalText(totals) {
    const indeterminate = Number(totals.tcvIndeterminadas) || 0;
    if (indeterminate === 0) return `Em negociação: ${formatMoney(totals.tcvEmJogo)} (TCV)`;
    return `Em negociação: ${formatMoney(totals.tcvEmJogo)} (TCV conhecido) · MRR ${formatMoney(Number(totals.mrrEmJogo) || 0)} · ${indeterminate} ${indeterminate === 1 ? 'contrato' : 'contratos'} com TCV indeterminado`;
  }

  function cardNode(card) {
    const negotiation = card.negociacao;
    const busy = state.busyKey === `move:${card.id}`;
    const others = state.board.stages.filter((stage) => stage.id !== card.stageId && stage.ativo !== false);
    const guarded = (action) => (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      action();
    };
    const line = (text, className = '') => (text ? el('p', { className: `funnel-card-line muted${className ? ` ${className}` : ''}`, text }) : null);
    const body = negotiation
      ? [
          el('button', { type: 'button', className: 'funnel-card-title', 'data-card': card.id, 'data-action': 'open', 'aria-label': `Ver detalhes da negociação com ${empresaOf(card)}`, text: empresaOf(card), onclick: guarded(() => openDetail(card.id)) }),
          line(textOf(negotiation.servicoNome)),
          line(conditionsText(negotiation)),
          negotiation.financeiro ? el('p', { className: 'funnel-card-line funnel-card-value', text: cardValueText(negotiation.financeiro) }) : null,
          line(negotiation.responsavelNome ? `Responsável: ${negotiation.responsavelNome}` : ''),
          negotiation.situacao !== 'ABERTA' ? statusBadge(document, situationLabel(negotiation.situacao), situationTone(negotiation.situacao)) : null,
        ]
      : [
          el('button', { type: 'button', className: 'funnel-card-title', 'data-card': card.id, 'data-action': 'open', 'aria-label': `Ver detalhes do card de ${empresaOf(card)}`, text: empresaOf(card), onclick: guarded(() => openDetail(card.id)) }),
          line('Card avulso (sem negociação)'),
          line(textOf(card.crm && card.crm.proximaAcao) ? `Próxima ação: ${textOf(card.crm.proximaAcao)}` : ''),
        ];
    const mover = canPropose && negotiation && negotiation.situacao === 'ABERTA' && others.length > 0
      ? el(
          'select',
          { 'aria-label': `Mover a negociação com ${empresaOf(card)} para outra etapa`, 'data-action': 'move', disabled: busy || state.busyKey !== null, onchange: (event) => {
            const value = String(event.target.value || '');
            event.target.value = '';
            if (value) moveNegotiation(card, value);
          } },
          el('option', { value: '', text: 'Mover para…' }),
          ...others.map((stage) => el('option', { value: stage.id, text: stage.nome }))
        )
      : null;
    return el('div', { className: 'funnel-card', 'data-id': card.id, 'data-busy': busy ? 'true' : 'false', onclick: () => openDetail(card.id) }, ...body, mover ? el('div', { className: 'funnel-card-actions', onclick: (event) => event.stopPropagation() }, mover) : null);
  }

  function columnNode(stage) {
    const cards = state.board.cards.filter((card) => card.stageId === stage.id && matches(card, state.query));
    const totals = state.board.totais.find((entry) => entry.stageId === stage.id) || { cards: 0, negociacoesAbertas: 0, tcvEmJogo: 0 };
    return el(
      'section',
      { className: `funnel-column${stage.ativo === false ? ' is-inactive' : ''}`, 'aria-labelledby': `funnel-stage-${stage.id}`, 'data-stage': stage.id },
      el('h3', { id: `funnel-stage-${stage.id}`, className: 'funnel-column-title' }, el('span', { text: stage.nome }), el('span', { className: 'funnel-column-count', 'aria-label': `${totals.cards} ${totals.cards === 1 ? 'cartão' : 'cartões'}`, text: String(totals.cards) })),
      totals.negociacoesAbertas > 0 ? el('p', { className: 'funnel-column-total muted', text: columnTotalText(totals) }) : null,
      el('div', { className: 'funnel-column-cards' }, ...(cards.length > 0 ? cards.map(cardNode) : [el('p', { className: 'muted', text: totals.cards > 0 ? 'Nenhum cartão na busca.' : 'Nenhum cartão.' })]))
    );
  }

  function render() {
    if (!root || destroyed) return;
    if (!permissions.canReadCrm) {
      fill(root, el('p', { className: 'message error', role: 'alert', text: 'Sua conta não tem permissão para ver o Quadro de Negociações.' }));
      return;
    }
    const board = state.board;
    const head = el(
      'div',
      { className: 'funnel-head' },
      el('h2', { text: 'Funis de Vendas' }),
      board.funnels.length > 1
        ? el('select', { 'aria-label': 'Selecionar funil', 'data-action': 'select-funnel', onchange: (event) => load({ funnelId: String(event.target.value || ''), quiet: false }) }, ...board.funnels.filter((funnel) => funnel.ativo || funnel.id === board.funnelId).map((funnel) => el('option', { value: funnel.id, text: funnel.nome, ...(funnel.id === board.funnelId ? { selected: 'selected' } : {}) })))
        : board.funnels.length === 1
          ? el('span', { className: 'funnel-name muted', text: board.funnels[0].nome })
          : null,
      el('input', { type: 'search', 'aria-label': 'Buscar no funil', placeholder: 'Buscar cliente, serviço ou responsável…', value: state.query, oninput: (event) => { state.query = String(event.target.value || ''); renderBoardOnly(); } }),
      el('button', { type: 'button', className: 'btn secondary', 'data-action': 'refresh', text: 'Atualizar', disabled: state.refreshing, onclick: () => refresh() }),
      canPropose ? el('button', { type: 'button', className: 'btn primary', 'data-action': 'new', text: 'Nova negociação', disabled: state.busyKey !== null, onclick: () => openForm(null) }) : null
    );
    const intro = el('p', { className: 'muted page-subtitle', text: 'Cada cartão é uma negociação: um cliente, um serviço e as condições acordadas. Clique no cartão para ver os detalhes.' });
    const message = state.message ? el('p', { className: `message ${state.message.kind === 'warning' ? 'warn' : state.message.kind}`, role: state.message.kind === 'error' ? 'alert' : 'status', text: state.message.text }) : null;

    if (state.status === 'loading' && board.funnels.length === 0) {
      fill(root, head, intro, el('p', { className: 'muted', role: 'status', text: 'Carregando o quadro…' }));
      return;
    }
    if (state.status === 'error') {
      fill(root, head, el('p', { className: 'message error', role: 'alert', text: state.error }), el('button', { type: 'button', className: 'btn secondary', 'data-action': 'retry', text: 'Tentar novamente', onclick: () => load({ quiet: false }) }));
      return;
    }
    if (board.funnels.length === 0) {
      fill(root, head, intro, emptyState(document, { title: 'Nenhum funil configurado ainda.', text: canManageFunnels ? 'Crie o primeiro funil e as suas etapas para começar a acompanhar as negociações.' : 'Peça a um administrador para criar o funil e as etapas.', action: canManageFunnels ? el('a', { className: 'btn primary', href: buildHash({ name: 'crm-settings-funnels' }), text: 'Abrir a Gestão de Funis e Etapas' }) : null }));
      return;
    }
    fill(root, head, intro, message, boardNode());
  }

  function boardNode() {
    const board = state.board;
    if (board.stages.length === 0) {
      const canAdmin = canManageFunnels;
      return emptyState(document, { title: 'Este funil ainda não tem etapas.', text: canAdmin ? 'Crie as etapas na Gestão de Funis e Etapas.' : 'Peça a um administrador para criar as etapas.', action: canAdmin ? el('a', { className: 'btn primary', href: buildHash({ name: 'crm-settings-funnels' }), text: 'Abrir a Gestão de Funis e Etapas' }) : null });
    }
    const empty = board.cards.length === 0 ? emptyState(document, { className: 'funnel-empty', title: 'Nenhuma negociação neste funil ainda.', text: canPropose ? 'Abra a primeira negociação: escolha o cliente, o serviço e as condições acordadas.' : 'As negociações aparecem aqui quando alguém as abrir.', action: canPropose ? el('button', { type: 'button', className: 'btn primary', 'data-action': 'new-empty', text: 'Nova negociação', onclick: () => openForm(null) }) : null }) : null;
    return el('div', { className: 'funnel-board-wrap' }, empty, el('div', { className: 'funnel-board', id: 'funnel-board' }, ...board.stages.map(columnNode)));
  }

  // digitar na busca não recria a barra (o foco e o texto ficam): só o quadro
  function renderBoardOnly() {
    render();
    const input = findSearch();
    if (input) {
      input.focus();
      if (typeof input.setSelectionRange === 'function') input.setSelectionRange(String(state.query).length, String(state.query).length);
    }
  }
  function findSearch() {
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.childNodes || []) {
        if (child.nodeType !== 1) continue;
        if (child.localName === 'input' && child.getAttribute('type') === 'search') return child;
        stack.push(child);
      }
    }
    return null;
  }

  function destroy() {
    destroyed = true;
    for (const handle of [...handles]) if (handle.isOpen) handle.close('destroy', { force: true });
    handles.clear();
    fill(root);
  }

  // Fase D2: o atalho "Nova negociação" da ficha do cliente (#/funis/nova-negociacao/<id>). Só abre depois de o quadro carregar com sucesso; o endereço volta a ser #/funis
  // sem recarregar a tela (atualizar a página não reabre o formulário).
  async function openNewFor(clientId) {
    if (destroyed || state.status !== 'ready') return;
    // (o endereço é só reescrito, sem avisar o roteador: a tela não é recriada e o formulário não fecha)
    if (navigation && typeof navigation.rewrite === 'function') navigation.rewrite(buildHash({ name: 'funnels' }));
    await openForm(null, { clientId });
  }

  return { load, refresh, render, destroy, state, openDetail: (id) => openDetail(id), openForm: (card, options) => openForm(card || null, options || {}), openNewFor };
}
