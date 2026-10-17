// Tela GESTÃO DE FUNIS E ETAPAS (CRM 5.0, Fase D1, decisão 0028) — a administração da ESTRUTURA do quadro de negociações: criar, renomear, ativar/desativar e excluir funis; criar, renomear, reordenar,
// ativar/desativar e excluir etapas. Só para quem tem MANAGE:FUNNELS (hoje, só ADMIN); o servidor decide de verdade.
//
//   Browser -> esta tela -> api.mjs -> GET /api/funnels, GET /api/funnels/:id/stages  (a estrutura, SEMPRE do servidor)
//                                   -> POST/PATCH/DELETE /api/funnels..., /api/funnel-stages/... e POST .../stages/reorder
//                                   -> GET /api/funnel-board?funnelId=... (só para contar os cartões de cada etapa; se falhar, a tela segue sem os números)
//
// REGRAS QUE A TELA MOSTRA (o servidor repete todas): um funil ou uma etapa com cartões NUNCA é excluído — a tela explica o que fazer (mover os cartões ou desativar); desativar um funil impede
// negociações NOVAS nele e não mexe nas que já existem; desativar uma etapa não apaga nada. NADA muda na tela antes de a API confirmar: cada ação relê a estrutura do servidor.
// SEGURANÇA: todo nome é dado NÃO CONFIÁVEL — entra no DOM por dom.mjs (textContent), nunca innerHTML/eval/Function.

import { h, fill } from '../dom.mjs';
import { textOf } from '../format.mjs';
import { statusBadge, emptyState, formField } from '../ui/index.mjs';

const NAME_MAX = 80;
const TEXT_MAX = 300;

const MESSAGES = Object.freeze({
  network: 'Sem conexão com o servidor. Verifique a internet e tente novamente. Nada foi alterado.',
  forbidden: 'Sua conta não tem permissão para esta ação.',
  notFound: 'Este item não existe mais. A lista foi atualizada.',
  hasCards: 'Há cartões neste item: ele não pode ser excluído. Mova os cartões para outra etapa ou desative o item.',
  unavailable: 'A estrutura dos funis não está disponível agora. Nada foi alterado.',
  generic: 'Não foi possível concluir a operação agora. Tente novamente em instantes.',
});

function structureError(error) {
  const status = error && typeof error.status === 'number' ? error.status : null;
  if (status === 401) return null;
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (status === 0) return { kind: 'network', message: MESSAGES.network };
  if (status === 403) return { kind: 'forbidden', message: MESSAGES.forbidden };
  if (status === 404) return { kind: 'not-found', message: MESSAGES.notFound };
  if (status === 409 && (code === 'FUNNEL_HAS_CARDS' || code === 'STAGE_HAS_CARDS')) return { kind: 'has-cards', message: MESSAGES.hasCards };
  if (status === 503) return { kind: 'unavailable', message: MESSAGES.unavailable };
  return { kind: 'other', message: MESSAGES.generic };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// document/root: onde desenhar. api: o cliente de api.mjs. permissions: de permissionsOf(me). ui: { overlays, toasts } da sessão.
export function createFunnelAdminView({ document, root, api, permissions, ui }) {
  const canManage = Boolean(permissions && permissions.canManageFunnels);
  const overlays = ui.overlays;
  const toasts = ui.toasts;
  const state = {
    status: 'idle', // idle | loading | ready | error
    error: null,
    funnels: [],
    selectedId: null,
    stages: [],
    stagesStatus: 'idle', // idle | loading | ready | error
    counts: null, // Map stageId -> quantidade de cartões (null: a contagem não está disponível)
    busyKey: null,
    message: null,
  };
  let destroyed = false;
  let loadToken = 0;
  const handles = new Set();
  const el = (tag, props, ...children) => h(document, tag, props, ...children);

  const selected = () => state.funnels.find((funnel) => funnel.id === state.selectedId) || null;
  const totalCards = () => (state.counts ? [...state.counts.values()].reduce((sum, value) => sum + value, 0) : null);

  function notify(kind, text) {
    state.message = text ? { kind, text } : null;
    if (kind === 'error') toasts.error(text, { key: 'funnel-admin-feedback' });
    else if (kind === 'success') toasts.success(text, { key: 'funnel-admin-feedback' });
    else toasts.warning(text, { key: 'funnel-admin-feedback' });
  }
  const trackedConfirm = (options) => {
    const handle = overlays.openConfirm(options);
    handles.add(handle);
    return handle;
  };
  const confirmError = (error) => {
    const info = structureError(error);
    return Object.assign(new Error(info ? info.message : MESSAGES.generic), { cause: error });
  };

  // ---- carga: SEMPRE do servidor ---------------------------------------------------------------------------------------------------------------
  async function loadStages() {
    const funnelId = state.selectedId;
    if (funnelId === null) {
      state.stages = [];
      state.counts = null;
      state.stagesStatus = 'idle';
      return;
    }
    const token = loadToken;
    state.stagesStatus = 'loading';
    render();
    try {
      const data = await api.listFunnelStages(funnelId);
      if (destroyed || token !== loadToken || state.selectedId !== funnelId) return;
      state.stages = Array.isArray(data && data.items) ? [...data.items].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)) : [];
      state.stagesStatus = 'ready';
    } catch (error) {
      if (destroyed || token !== loadToken || state.selectedId !== funnelId) return;
      state.stages = [];
      state.stagesStatus = 'error';
      const info = structureError(error);
      if (info !== null) notify('error', info.message);
      render();
      return;
    }
    // a contagem de cartões é um auxílio: se não vier, a tela continua (o servidor ainda recusa a exclusão do que tem cartões)
    try {
      const board = await api.funnelBoard(funnelId);
      if (destroyed || token !== loadToken || state.selectedId !== funnelId) return;
      const totais = board && board.quadro && Array.isArray(board.quadro.totais) ? board.quadro.totais : null;
      state.counts = totais ? new Map(totais.map((entry) => [entry.stageId, Number(entry.cards) || 0])) : null;
    } catch {
      if (destroyed || token !== loadToken) return;
      state.counts = null;
    }
    render();
  }

  async function load({ quiet = false } = {}) {
    if (!canManage || destroyed) {
      render();
      return;
    }
    const token = ++loadToken;
    if (!quiet || state.status !== 'ready') state.status = 'loading';
    render();
    try {
      const data = await api.listFunnels();
      if (destroyed || token !== loadToken) return;
      state.funnels = Array.isArray(data && data.items) ? [...data.items].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)) : [];
      state.status = 'ready';
      state.error = null;
      if (!state.funnels.some((funnel) => funnel.id === state.selectedId)) state.selectedId = state.funnels.length > 0 ? state.funnels[0].id : null;
    } catch (error) {
      if (destroyed || token !== loadToken) return;
      const info = structureError(error);
      if (info === null) return;
      if (state.status !== 'ready') {
        state.status = 'error';
        state.error = info.kind === 'forbidden' ? 'Sua conta não tem permissão para administrar os funis.' : info.kind === 'not-found' ? 'A gestão de funis não está disponível neste servidor.' : info.kind === 'network' ? MESSAGES.network : 'Não foi possível carregar os funis agora. Tente novamente.';
      } else {
        notify('error', info.message);
      }
      render();
      return;
    }
    render();
    await loadStages();
  }

  // ---- ações (cada uma só muda a tela DEPOIS da confirmação do servidor) --------------------------------------------------------------------------
  async function run(key, action, { successText } = {}) {
    if (state.busyKey !== null || destroyed) return false;
    state.busyKey = key;
    state.message = null;
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
      const info = structureError(error);
      if (info !== null) {
        notify('error', info.message);
        if (info.kind === 'not-found' || info.kind === 'has-cards') await load({ quiet: true });
      }
      render();
      return false;
    }
  }

  // Uma ação confirmada numa janela de confirmação: se o servidor recusar, o erro aparece DENTRO da janela (ela continua aberta, nada mudou); se o item mudou ou sumiu por outra pessoa, a lista é relida.
  async function applyConfirmed(action, successText) {
    try {
      await action();
    } catch (error) {
      const info = structureError(error);
      if (info !== null && (info.kind === 'not-found' || info.kind === 'has-cards')) load({ quiet: true });
      throw confirmError(error);
    }
    if (destroyed) return;
    notify('success', successText);
    await load({ quiet: true });
  }

  // ---- o formulário de nome (funil e etapa) --------------------------------------------------------------------------------------------------------
  // fields: [{ key, label, required, maxlength, rows, help }]; initial: { key: valor }; onSubmit(values): Promise (rejeitar mostra o erro e mantém aberto).
  function openForm({ key, title, subtitle = '', fields, initial = {}, submitLabel = 'Salvar', onSubmit }) {
    if (overlays.isOpen(key)) return;
    let handle = null;
    let busy = false;
    const controls = fields.map((spec) => {
      const control = spec.rows
        ? el('textarea', { id: `funnel-admin-${spec.key}`, rows: String(spec.rows), maxlength: String(spec.maxlength) })
        : el('input', { id: `funnel-admin-${spec.key}`, type: 'text', autocomplete: 'off', maxlength: String(spec.maxlength) });
      control.value = initial[spec.key] || '';
      return { spec, control, wrapper: formField(document, { id: `funnel-admin-${spec.key}`, label: spec.label, control, help: spec.help || '', required: Boolean(spec.required) }) };
    });
    const formError = el('p', { className: 'message error', role: 'alert', hidden: true });
    const baseline = Object.fromEntries(controls.map(({ spec, control }) => [spec.key, control.value]));
    const valuesNow = () => Object.fromEntries(controls.map(({ spec, control }) => [spec.key, String(control.value || '').trim()]));
    const isDirty = () => controls.some(({ spec, control }) => control.value !== baseline[spec.key]);
    const setBusy = (value) => {
      busy = value;
      for (const { control } of controls) control.disabled = value;
      saveButton.disabled = value;
      cancelButton.disabled = value;
      saveButton.textContent = value ? 'Salvando…' : submitLabel;
      form.setAttribute('aria-busy', value ? 'true' : 'false');
      if (handle) handle.setBusy(value);
    };
    async function submit() {
      if (busy) return;
      formError.hidden = true;
      let first = null;
      for (const { spec, control, wrapper } of controls) {
        const value = String(control.value || '').trim();
        wrapper.setError(spec.required && value === '' ? `Informe ${spec.requiredText || 'o nome'}.` : null);
        if (spec.required && value === '' && first === null) first = control;
      }
      if (first !== null) {
        first.focus();
        return;
      }
      setBusy(true);
      try {
        await onSubmit(valuesNow());
        setBusy(false);
        handle.close('saved', { force: true });
      } catch (error) {
        setBusy(false);
        formError.textContent = error && typeof error.message === 'string' && error.message !== '' ? error.message : MESSAGES.generic;
        formError.hidden = false;
      }
    }
    const saveButton = el('button', { type: 'button', className: 'btn primary', 'data-action': 'save', text: submitLabel, onclick: () => submit() });
    const cancelButton = el('button', { type: 'button', className: 'btn secondary', 'data-action': 'cancel', text: 'Cancelar', onclick: () => handle && handle.close('cancel') });
    const form = el('form', { className: 'catalog-form funnel-admin-form', novalidate: 'novalidate', onsubmit: (event) => { event.preventDefault(); submit(); } }, el('p', { className: 'muted required-note', text: 'Os campos marcados com * são obrigatórios.' }), formError, ...controls.map(({ wrapper }) => wrapper.element));
    // Enter num campo de uma linha envia (o botão é type=button: um só caminho de envio)
    form.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      if (event.target && event.target.localName === 'input') {
        event.preventDefault();
        submit();
      }
    });
    handle = overlays.openDrawer({
      centered: true,
      key,
      title,
      subtitle,
      content: form,
      footer: el('div', { className: 'drawer-actions catalog-form-actions' }, cancelButton, saveButton),
      isDirty,
      initialFocus: () => controls[0].control,
      onClose: () => handles.delete(handle),
    });
    handles.add(handle);
  }

  function info(title, paragraphs) {
    const handle = overlays.openModal({
      key: 'funnel-admin-info',
      title,
      size: 'sm',
      content: el('div', { className: 'confirm-body' }, ...paragraphs.map((text) => el('p', { text }))),
      footer: el('div', { className: 'actions' }, el('button', { type: 'button', className: 'btn secondary', 'data-action': 'close', text: 'Entendi', onclick: () => handle.close('button') })),
    });
    handles.add(handle);
  }

  // ---- funis ----------------------------------------------------------------------------------------------------------------------------------------
  const newFunnel = () =>
    openForm({
      key: 'funnel-admin-funnel:new',
      title: 'Novo funil',
      subtitle: 'O funil nasce ativo e sem etapas. Crie as etapas em seguida.',
      fields: [
        { key: 'nome', label: 'Nome do funil', required: true, maxlength: NAME_MAX, requiredText: 'o nome do funil' },
        { key: 'descricao', label: 'Descrição', maxlength: TEXT_MAX, rows: 3, help: 'Opcional.' },
        { key: 'finalidade', label: 'Finalidade', maxlength: TEXT_MAX, rows: 2, help: 'Opcional. Para que este funil serve.' },
      ],
      submitLabel: 'Criar funil',
      onSubmit: async (values) => {
        let created;
        try {
          created = await api.createFunnel({ nome: values.nome, ...(values.descricao ? { descricao: values.descricao } : {}), ...(values.finalidade ? { finalidade: values.finalidade } : {}) });
        } catch (error) {
          throw confirmError(error);
        }
        if (created && created.item && typeof created.item.id === 'string') state.selectedId = created.item.id;
        notify('success', 'Funil criado.');
        await load({ quiet: true });
      },
    });

  const editFunnel = (funnel) =>
    openForm({
      key: `funnel-admin-funnel:${funnel.id}`,
      title: 'Editar funil',
      subtitle: textOf(funnel.nome),
      fields: [
        { key: 'nome', label: 'Nome do funil', required: true, maxlength: NAME_MAX, requiredText: 'o nome do funil' },
        { key: 'descricao', label: 'Descrição', maxlength: TEXT_MAX, rows: 3 },
        { key: 'finalidade', label: 'Finalidade', maxlength: TEXT_MAX, rows: 2 },
      ],
      initial: { nome: textOf(funnel.nome), descricao: textOf(funnel.descricao), finalidade: textOf(funnel.finalidade) },
      onSubmit: async (values) => {
        const patch = {};
        if (values.nome !== textOf(funnel.nome)) patch.nome = values.nome;
        if (values.descricao !== textOf(funnel.descricao)) patch.descricao = values.descricao;
        if (values.finalidade !== textOf(funnel.finalidade)) patch.finalidade = values.finalidade;
        if (Object.keys(patch).length === 0) throw new Error('Nenhuma alteração foi feita.');
        try {
          await api.updateFunnel(funnel.id, patch);
        } catch (error) {
          throw confirmError(error);
        }
        notify('success', 'Funil atualizado.');
        await load({ quiet: true });
      },
    });

  function toggleFunnel(funnel) {
    const activating = funnel.ativo === false;
    trackedConfirm({
      key: `funnel-admin-toggle:${funnel.id}`,
      title: activating ? 'Reativar o funil?' : 'Desativar o funil?',
      message: textOf(funnel.nome),
      detail: activating
        ? ['O funil volta a aceitar negociações novas e a aparecer no quadro.']
        : ['O funil deixa de aceitar negociações NOVAS e some da lista de funis do quadro.', 'As negociações que já estão nele não são apagadas nem alteradas. Você pode reativar o funil quando quiser.'],
      confirmLabel: activating ? 'Reativar' : 'Desativar',
      cancelLabel: 'Cancelar',
      cancelFirst: true,
      busyLabel: 'Salvando…',
      tone: activating ? undefined : 'danger',
      onConfirm: async () => {
        await applyConfirmed(() => api.updateFunnel(funnel.id, { ativo: activating }), activating ? 'Funil reativado.' : 'Funil desativado.');
      },
    });
  }

  function deleteFunnel(funnel) {
    const total = funnel.id === state.selectedId ? totalCards() : null;
    if (total !== null && total > 0) {
      info('Este funil tem cartões', [`${plural(total, 'cartão está', 'cartões estão')} neste funil, por isso ele não pode ser excluído.`, 'Mova as negociações para outro funil ou desative este funil: nada é apagado.']);
      return;
    }
    trackedConfirm({
      key: `funnel-admin-delete:${funnel.id}`,
      title: 'Excluir o funil?',
      message: textOf(funnel.nome),
      detail: ['O funil e as suas etapas são excluídos para sempre. Só é possível porque nenhum cartão está nele.', 'Se quiser só tirá-lo de uso, desative o funil: nada é apagado.'],
      tone: 'danger',
      confirmLabel: 'Excluir funil',
      cancelLabel: 'Cancelar',
      cancelFirst: true,
      busyLabel: 'Excluindo…',
      onConfirm: async () => {
        await applyConfirmed(() => api.deleteFunnel(funnel.id), 'Funil excluído.');
      },
    });
  }

  // ---- etapas ---------------------------------------------------------------------------------------------------------------------------------------
  const newStage = (funnel) =>
    openForm({
      key: `funnel-admin-stage:new:${funnel.id}`,
      title: 'Nova etapa',
      subtitle: textOf(funnel.nome),
      fields: [{ key: 'nome', label: 'Nome da etapa', required: true, maxlength: NAME_MAX, requiredText: 'o nome da etapa', help: 'A etapa entra no fim do funil. Reordene depois, se precisar.' }],
      submitLabel: 'Criar etapa',
      onSubmit: async (values) => {
        try {
          await api.createFunnelStage(funnel.id, { nome: values.nome });
        } catch (error) {
          throw confirmError(error);
        }
        notify('success', 'Etapa criada.');
        await load({ quiet: true });
      },
    });

  const editStage = (stage) =>
    openForm({
      key: `funnel-admin-stage:${stage.id}`,
      title: 'Renomear etapa',
      subtitle: textOf(stage.nome),
      fields: [{ key: 'nome', label: 'Nome da etapa', required: true, maxlength: NAME_MAX, requiredText: 'o nome da etapa' }],
      initial: { nome: textOf(stage.nome) },
      onSubmit: async (values) => {
        if (values.nome === textOf(stage.nome)) throw new Error('Nenhuma alteração foi feita.');
        try {
          await api.updateFunnelStage(stage.id, { nome: values.nome });
        } catch (error) {
          throw confirmError(error);
        }
        notify('success', 'Etapa renomeada.');
        await load({ quiet: true });
      },
    });

  function toggleStage(stage) {
    const activating = stage.ativo === false;
    const count = state.counts ? state.counts.get(stage.id) || 0 : null;
    trackedConfirm({
      key: `funnel-admin-stage-toggle:${stage.id}`,
      title: activating ? 'Reativar a etapa?' : 'Desativar a etapa?',
      message: textOf(stage.nome),
      detail: activating
        ? ['A etapa volta a aceitar cartões.']
        : [count !== null && count > 0 ? `${plural(count, 'cartão está', 'cartões estão')} nesta etapa e continua${count === 1 ? '' : 'm'} lá: nada é movido nem apagado.` : 'Nenhum cartão será movido nem apagado.', 'Nenhum cartão poderá ser movido PARA uma etapa desativada. Você pode reativá-la quando quiser.'],
      confirmLabel: activating ? 'Reativar' : 'Desativar',
      cancelLabel: 'Cancelar',
      cancelFirst: true,
      busyLabel: 'Salvando…',
      tone: activating ? undefined : 'danger',
      onConfirm: async () => {
        await applyConfirmed(() => api.updateFunnelStage(stage.id, { ativo: activating }), activating ? 'Etapa reativada.' : 'Etapa desativada.');
      },
    });
  }

  function deleteStage(stage) {
    const count = state.counts ? state.counts.get(stage.id) || 0 : null;
    if (count !== null && count > 0) {
      info('Esta etapa tem cartões', [`${plural(count, 'cartão está', 'cartões estão')} nesta etapa, por isso ela não pode ser excluída.`, 'Mova os cartões para outra etapa ou desative esta etapa: nada é apagado.']);
      return;
    }
    trackedConfirm({
      key: `funnel-admin-stage-delete:${stage.id}`,
      title: 'Excluir a etapa?',
      message: textOf(stage.nome),
      detail: ['A etapa é excluída para sempre. Só é possível porque nenhum cartão está nela.', 'Se quiser só tirá-la de uso, desative a etapa: nada é apagado.'],
      tone: 'danger',
      confirmLabel: 'Excluir etapa',
      cancelLabel: 'Cancelar',
      cancelFirst: true,
      busyLabel: 'Excluindo…',
      onConfirm: async () => {
        await applyConfirmed(() => api.deleteFunnelStage(stage.id), 'Etapa excluída.');
      },
    });
  }

  function moveStage(stage, delta) {
    const index = state.stages.findIndex((entry) => entry.id === stage.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= state.stages.length) return;
    const ids = state.stages.map((entry) => entry.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    run(`stage-move:${stage.id}`, () => api.reorderFunnelStages(state.selectedId, ids), { successText: 'Ordem das etapas atualizada.' });
  }

  // ---- desenho --------------------------------------------------------------------------------------------------------------------------------------
  function funnelListNode() {
    return el(
      'ul',
      { className: 'funnel-admin-list plain', 'aria-label': 'Funis' },
      ...state.funnels.map((funnel) =>
        el(
          'li',
          { className: `funnel-admin-item${funnel.id === state.selectedId ? ' is-selected' : ''}` },
          el('button', { type: 'button', className: 'funnel-admin-pick', 'data-funnel': funnel.id, 'aria-current': funnel.id === state.selectedId ? 'true' : 'false', onclick: () => { if (state.busyKey === null && funnel.id !== state.selectedId) { state.selectedId = funnel.id; state.counts = null; loadStages(); } } }, el('span', { className: 'funnel-admin-name', text: textOf(funnel.nome) || 'Funil sem nome' }), funnel.ativo === false ? statusBadge(document, 'Desativado', 'neutral') : null)
        )
      )
    );
  }

  function stageRow(stage, index) {
    const count = state.counts ? state.counts.get(stage.id) || 0 : null;
    const busy = state.busyKey !== null;
    const inactive = stage.ativo === false;
    return el(
      'li',
      { className: `funnel-admin-stage${inactive ? ' is-inactive' : ''}`, 'data-stage': stage.id },
      el('div', { className: 'funnel-admin-stage-main' }, el('strong', { className: 'funnel-admin-stage-name', text: textOf(stage.nome) || 'Etapa sem nome' }), inactive ? statusBadge(document, 'Desativada', 'neutral') : null, count !== null ? el('span', { className: 'muted', text: plural(count, 'cartão', 'cartões') }) : null),
      el(
        'div',
        { className: 'funnel-admin-stage-actions' },
        el('button', { type: 'button', className: 'btn secondary small', 'data-action': 'stage-up', 'aria-label': `Subir a etapa ${textOf(stage.nome)}`, text: '↑', disabled: busy || index === 0, onclick: () => moveStage(stage, -1) }),
        el('button', { type: 'button', className: 'btn secondary small', 'data-action': 'stage-down', 'aria-label': `Descer a etapa ${textOf(stage.nome)}`, text: '↓', disabled: busy || index === state.stages.length - 1, onclick: () => moveStage(stage, 1) }),
        el('button', { type: 'button', className: 'btn secondary small', 'data-action': 'stage-rename', text: 'Renomear', disabled: busy, onclick: () => editStage(stage) }),
        el('button', { type: 'button', className: 'btn secondary small', 'data-action': 'stage-toggle', text: inactive ? 'Reativar' : 'Desativar', disabled: busy, onclick: () => toggleStage(stage) }),
        el('button', { type: 'button', className: 'btn danger small', 'data-action': 'stage-delete', text: 'Excluir', disabled: busy, onclick: () => deleteStage(stage) })
      )
    );
  }

  function detailNode(funnel) {
    const busy = state.busyKey !== null;
    const inactive = funnel.ativo === false;
    const total = totalCards();
    let stagesNode;
    if (state.stagesStatus === 'loading') stagesNode = el('p', { className: 'muted', role: 'status', text: 'Carregando as etapas…' });
    else if (state.stagesStatus === 'error') stagesNode = el('div', {}, el('p', { className: 'message error', role: 'alert', text: 'Não foi possível carregar as etapas deste funil.' }), el('button', { type: 'button', className: 'btn secondary', 'data-action': 'retry-stages', text: 'Tentar novamente', onclick: () => loadStages() }));
    else if (state.stages.length === 0) stagesNode = emptyState(document, { title: 'Este funil ainda não tem etapas.', text: 'Crie a primeira etapa, como "Contato" ou "Proposta". Sem etapas, não há onde colocar as negociações.' });
    else stagesNode = el('ol', { className: 'funnel-admin-stages plain' }, ...state.stages.map((stage, index) => stageRow(stage, index)));
    return el(
      'section',
      { className: 'funnel-admin-detail', 'aria-labelledby': 'funnel-admin-detail-title' },
      el('header', { className: 'funnel-admin-detail-head' }, el('h3', { id: 'funnel-admin-detail-title', text: textOf(funnel.nome) || 'Funil sem nome' }), inactive ? statusBadge(document, 'Desativado', 'neutral') : statusBadge(document, 'Ativo', 'ok')),
      funnel.descricao ? el('p', { className: 'muted', text: textOf(funnel.descricao) }) : null,
      funnel.finalidade ? el('p', { className: 'muted', text: `Finalidade: ${textOf(funnel.finalidade)}` }) : null,
      total !== null ? el('p', { className: 'muted', text: `${plural(total, 'cartão', 'cartões')} neste funil.` }) : null,
      el(
        'div',
        { className: 'actions' },
        el('button', { type: 'button', className: 'btn secondary', 'data-action': 'funnel-edit', text: 'Editar funil', disabled: busy, onclick: () => editFunnel(funnel) }),
        el('button', { type: 'button', className: 'btn secondary', 'data-action': 'funnel-toggle', text: inactive ? 'Reativar funil' : 'Desativar funil', disabled: busy, onclick: () => toggleFunnel(funnel) }),
        el('button', { type: 'button', className: 'btn danger', 'data-action': 'funnel-delete', text: 'Excluir funil', disabled: busy, onclick: () => deleteFunnel(funnel) })
      ),
      el('h3', { className: 'panel-section-title', text: 'Etapas' }),
      el('p', { className: 'muted', text: 'As etapas aparecem no quadro na ordem abaixo. Use as setas para mudar a ordem.' }),
      stagesNode,
      el('div', { className: 'actions' }, el('button', { type: 'button', className: 'btn primary', 'data-action': 'stage-new', text: 'Nova etapa', disabled: busy || state.stagesStatus === 'loading', onclick: () => newStage(funnel) }))
    );
  }

  function render() {
    if (!root || destroyed) return;
    const head = el(
      'header',
      { className: 'page-title-row' },
      el('div', { className: 'page-title-block' }, el('h2', { id: 'funnel-admin-title', text: 'Gestão de Funis e Etapas' }), el('p', { className: 'muted page-subtitle', text: 'Crie os funis de vendas e as etapas por onde as negociações passam. Os cartões e o valor de cada etapa aparecem em Funis de Vendas.' })),
      canManage ? el('button', { type: 'button', className: 'btn primary', 'data-action': 'funnel-new', text: 'Novo funil', disabled: state.busyKey !== null || state.status !== 'ready', onclick: () => newFunnel() }) : null
    );
    if (!canManage) {
      fill(root, el('p', { className: 'message error', role: 'alert', text: 'Sua conta não tem permissão para administrar os funis.' }));
      return;
    }
    if (state.status === 'idle' || (state.status === 'loading' && state.funnels.length === 0)) {
      fill(root, head, el('p', { className: 'muted', role: 'status', text: 'Carregando os funis…' }));
      return;
    }
    if (state.status === 'error') {
      fill(root, head, el('p', { className: 'message error', role: 'alert', text: state.error }), el('button', { type: 'button', className: 'btn secondary', 'data-action': 'retry', text: 'Tentar novamente', onclick: () => load({ quiet: false }) }));
      return;
    }
    const message = state.message ? el('p', { className: `message ${state.message.kind === 'warning' ? 'warn' : state.message.kind}`, role: state.message.kind === 'error' ? 'alert' : 'status', text: state.message.text }) : null;
    if (state.funnels.length === 0) {
      fill(root, head, message, emptyState(document, { title: 'Nenhum funil criado ainda.', text: 'Crie o primeiro funil (por exemplo, "Vendas") e depois as etapas dele.' }));
      return;
    }
    const funnel = selected();
    fill(root, head, message, el('div', { className: 'funnel-admin' }, funnelListNode(), funnel ? detailNode(funnel) : null));
  }

  function destroy() {
    destroyed = true;
    for (const handle of [...handles]) if (handle.isOpen) handle.close('destroy', { force: true });
    handles.clear();
    fill(root);
  }

  return { load, render, destroy, state };
}
