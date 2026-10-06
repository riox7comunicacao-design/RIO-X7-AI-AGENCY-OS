// Tela EXCLUSÕES PERMANENTES (Workbench de Prospecção, Etapa 2) — administração ADMIN-only.
//
//   Browser -> esta tela -> api.mjs -> HTTP /api/prospecting/exclusions -> Prospecting Permanent Exclusion Service
//
// "Excluir" pela interface é sempre DESATIVAR — nunca há um botão de exclusão física (essa ação não existe em
// nenhuma camada do sistema). Quem decide se a conta pode administrar é o SERVIDOR (MANAGE:PROSPECTING_
// EXCLUSIONS); esta tela só mostra/esconde os controles.
//
// SEGURANÇA: dados de uma exclusão são texto digitado por um humano ADMIN — mesmo assim, tudo entra no DOM por
// dom.mjs (textContent), nunca innerHTML/eval/Function (mesmo padrão de todo o Dashboard).

import { h, fill } from '../dom.mjs';

const GEO_FIELDS = [
  ['empresa', 'Empresa'],
  ['cidade', 'Cidade'],
  ['estado', 'Estado'],
  ['pais', 'País'],
  ['dominio', 'Domínio'],
  ['motivo', 'Motivo'],
];

export function createProspectingExclusionsView({ document, root, api, permissions }) {
  const canManage = Boolean(permissions && permissions.canManageProspectingExclusions);
  const el = (tag, props, ...children) => h(document, tag, props, ...children);

  const state = {
    status: 'idle',
    items: [],
    form: { empresa: '', cidade: '', estado: '', pais: '', dominio: '', motivo: '' },
    editingId: null,
    busy: false,
    message: null,
  };

  function setMessage(kind, text) {
    state.message = text ? { kind, text } : null;
  }

  function messageFor(error) {
    const status = error && typeof error.status === 'number' ? error.status : null;
    if (status === 403) return 'Sua conta não tem permissão para esta ação.';
    if (status === 404) return 'Exclusão não encontrada.';
    if (status === 400) return (error && error.serverMessage) || 'Dados inválidos.';
    return 'Não foi possível concluir a operação agora. Tente novamente.';
  }

  async function load() {
    state.status = 'loading';
    render();
    try {
      const data = await api.listProspectingExclusions();
      state.items = Array.isArray(data && data.items) ? data.items : [];
      state.status = 'ready';
    } catch (error) {
      state.status = 'error';
      setMessage('error', messageFor(error));
    }
    render();
  }

  function resetForm() {
    state.form = { empresa: '', cidade: '', estado: '', pais: '', dominio: '', motivo: '' };
    state.editingId = null;
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (state.busy) return;
    const fields = {};
    for (const [key] of GEO_FIELDS) {
      const valor = state.form[key].trim();
      if (valor !== '') fields[key] = valor;
    }
    state.busy = true;
    setMessage(null);
    render();
    try {
      if (state.editingId) await api.updateProspectingExclusion(state.editingId, fields);
      else await api.createProspectingExclusion(fields);
      resetForm();
      await load();
    } catch (error) {
      setMessage('error', messageFor(error));
    }
    state.busy = false;
    render();
  }

  function onEdit(item) {
    state.editingId = item.id;
    state.form = { empresa: item.empresa || '', cidade: item.cidade || '', estado: item.estado || '', pais: item.pais || '', dominio: item.dominio || '', motivo: item.motivo || '' };
    render();
  }

  async function onToggle(item) {
    if (state.busy) return;
    state.busy = true;
    setMessage(null);
    render();
    try {
      if (item.ativo) await api.deactivateProspectingExclusion(item.id);
      else await api.activateProspectingExclusion(item.id);
      await load();
    } catch (error) {
      setMessage('error', messageFor(error));
    }
    state.busy = false;
    render();
  }

  function buildForm() {
    const f = state.form;
    const inputs = GEO_FIELDS.map(([key, label]) =>
      el(
        'div',
        { className: 'field' },
        el('label', { for: `excl-${key}`, text: key === 'empresa' || key === 'motivo' ? `${label} (obrigatório)` : `${label} (opcional)` }),
        key === 'motivo'
          ? el('textarea', { id: `excl-${key}`, rows: '2', value: f[key], oninput: (e) => (f[key] = e.target.value) })
          : el('input', { id: `excl-${key}`, value: f[key], oninput: (e) => (f[key] = e.target.value) })
      )
    );
    return el(
      'form',
      { className: 'panel', onsubmit: onSubmit },
      el('h3', { text: state.editingId ? 'Editar exclusão' : 'Nova exclusão' }),
      el('div', { className: 'form-grid' }, ...inputs),
      el(
        'div', { className: 'actions' },
        el('button', { type: 'submit', className: 'btn primary', disabled: state.busy, text: state.editingId ? 'Salvar' : 'Adicionar' }),
        state.editingId ? el('button', { type: 'button', className: 'btn secondary', onclick: () => { resetForm(); render(); }, text: 'Cancelar' }) : null
      )
    );
  }

  function row(item) {
    return el(
      'tr',
      {},
      el('td', { text: item.empresa }),
      el('td', { text: item.cidade || '—' }),
      el('td', { text: item.estado || '—' }),
      el('td', { text: item.dominio || '—' }),
      el('td', { text: item.motivo }),
      el('td', {}, el('span', { className: `badge tone-${item.ativo ? 'ok' : 'bad'}`, text: item.ativo ? 'Ativa' : 'Desativada' })),
      el('td', { text: item.criadoEm ? item.criadoEm.slice(0, 10) : '—' }),
      el(
        'td', {},
        el('button', { type: 'button', className: 'btn small secondary', disabled: state.busy, onclick: () => onEdit(item), text: 'Editar' }),
        el('button', { type: 'button', className: `btn small ${item.ativo ? 'danger' : 'secondary'}`, disabled: state.busy, onclick: () => onToggle(item), text: item.ativo ? 'Desativar' : 'Ativar' })
      )
    );
  }

  function buildTable() {
    if (state.status === 'loading') return el('p', { className: 'muted', text: 'Carregando…' });
    if (state.items.length === 0) return el('p', { className: 'muted', text: 'Nenhuma exclusão cadastrada.' });
    return el(
      'table',
      { className: 'crm-table' },
      el(
        'thead', {},
        el('tr', {}, ...['Empresa', 'Cidade', 'Estado', 'Domínio', 'Motivo', 'Status', 'Criado em', 'Ações'].map((texto) => el('th', { text: texto })))
      ),
      el('tbody', {}, ...state.items.map(row))
    );
  }

  function render() {
    if (!canManage) {
      fill(root, el('section', { className: 'prospecting-exclusions' }, el('h2', { text: 'Exclusões Permanentes' }), el('p', { className: 'muted', text: 'Seu perfil não pode administrar exclusões permanentes.' })));
      return;
    }
    const messageNode = state.message ? el('p', { className: `notice ${state.message.kind === 'error' ? 'bad' : 'ok'}`, role: 'note', text: state.message.text }) : null;
    fill(
      root,
      el(
        'section',
        { className: 'prospecting-exclusions' },
        el('h2', { text: 'Exclusões Permanentes' }),
        el('p', { className: 'muted', text: 'Uma empresa aqui nunca avança pela prospecção: não é pesquisada para contato, não entra na fila de revisão, não é promovida ao CRM e não ganha Card.' }),
        messageNode,
        buildForm(),
        buildTable()
      )
    );
  }

  return { load, render, destroy: () => {} };
}
