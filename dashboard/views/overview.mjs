// Tela VISÃO GERAL — o resumo de entrada do Dashboard: quantos registros o CRM tem (e em que status) e quantos prospects
// aguardam revisão. Só números que as rotas que já existem devolvem (GET /api/crm e GET /api/approvals): nenhuma métrica
// inventada, nada que a API não entregue.
//
// Cada cartão só aparece se a conta tem a área correspondente (`permissions`, do que /api/me devolveu) — uma conveniência
// de interface; o servidor continua decidindo (um 403 vira uma frase, nunca uma tela quebrada). Todo texto entra no DOM
// por dom.mjs (textContent). A tela recebe `document`, `root` e `api` por parâmetro, como as demais.

import { h, fill } from '../dom.mjs';
import { textOf } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { countByStatus, messageForCrmError } from '../crm-model.mjs';

// document/root: onde desenhar. api: { listCrm, listApprovals }. me: o que /api/me devolveu (só o nome é usado).
// permissions: { canReadCrm, canReview } (de permissionsOf(me)).
export function createOverviewView({ document, root, api, me, permissions }) {
  const state = {
    crm: { status: permissions.canReadCrm ? 'loading' : 'off', items: [], error: null },
    approvals: { status: permissions.canReview ? 'loading' : 'off', count: 0, error: null },
    destroyed: false,
  };

  const el = (tag, props, ...children) => h(document, tag, props, ...children);

  function retry(kind) {
    return el('button', { type: 'button', className: 'btn secondary', text: 'Tentar novamente', onclick: () => load(kind) });
  }

  function crmCard() {
    const { crm } = state;
    let body;
    if (crm.status === 'loading') {
      body = [el('p', { className: 'muted', text: 'Carregando…' })];
    } else if (crm.status === 'error') {
      body = [el('p', { className: 'message error', role: 'alert', text: crm.error }), retry('crm')];
    } else {
      const total = crm.items.length;
      const present = countByStatus(crm.items).filter((status) => status.count > 0);
      body = [
        el('p', { className: 'stat', text: String(total) }),
        el('p', { className: 'muted', text: total === 1 ? 'registro no CRM' : 'registros no CRM' }),
        total === 0
          ? el('p', { className: 'muted', text: 'Ainda não há registros.' })
          : el('ul', { className: 'plain status-breakdown' }, ...present.map((status) => el('li', {}, el('span', { className: `badge ${status.tone}`, text: status.label }), el('span', { text: ` ${status.count}` })))),
      ];
    }
    return el('section', { className: 'card', 'aria-labelledby': 'overview-crm-title' }, el('h3', { id: 'overview-crm-title', text: 'CRM' }), ...body, el('p', {}, el('a', { href: buildHash({ name: 'crm-list' }), className: 'btn secondary', text: 'Abrir CRM' })));
  }

  function approvalsCard() {
    const { approvals } = state;
    let body;
    if (approvals.status === 'loading') {
      body = [el('p', { className: 'muted', text: 'Carregando…' })];
    } else if (approvals.status === 'error') {
      body = [el('p', { className: 'message error', role: 'alert', text: approvals.error }), retry('approvals')];
    } else {
      body = [el('p', { className: 'stat', text: String(approvals.count) }), el('p', { className: 'muted', text: approvals.count === 1 ? 'prospect aguardando revisão' : 'prospects aguardando revisão' })];
    }
    return el(
      'section',
      { className: 'card', 'aria-labelledby': 'overview-approvals-title' },
      el('h3', { id: 'overview-approvals-title', text: 'Aprovações' }),
      ...body,
      el('p', {}, el('a', { href: buildHash({ name: 'approvals' }), className: 'btn secondary', text: 'Abrir aprovações' }))
    );
  }

  function render() {
    if (state.destroyed) return;
    const name = me && typeof me.name === 'string' ? textOf(me.name) : '';
    const cards = [];
    if (state.crm.status !== 'off') cards.push(crmCard());
    if (state.approvals.status !== 'off') cards.push(approvalsCard());
    fill(root,
      el(
        'section',
        { className: 'overview', 'aria-labelledby': 'overview-title' },
        el('h2', { id: 'overview-title', text: 'Visão Geral' }),
        el('p', { className: 'muted', text: name ? `Olá, ${name}. Este é o resumo do que está em andamento.` : 'Este é o resumo do que está em andamento.' }),
        cards.length > 0 ? el('div', { className: 'cards' }, ...cards) : el('p', { className: 'muted', text: 'Esta conta ainda não tem nenhuma área disponível.' })
      )
    );
  }

  async function loadCrm() {
    state.crm = { status: 'loading', items: [], error: null };
    render();
    try {
      const data = await api.listCrm();
      state.crm = { status: 'ready', items: Array.isArray(data && data.items) ? data.items : [], error: null };
    } catch (error) {
      state.crm = { status: 'error', items: [], error: messageForCrmError(error) || 'Não foi possível carregar o CRM.' };
    }
    render();
  }

  async function loadApprovals() {
    state.approvals = { status: 'loading', count: 0, error: null };
    render();
    try {
      const data = await api.listApprovals();
      state.approvals = { status: 'ready', count: Array.isArray(data && data.items) ? data.items.length : 0, error: null };
    } catch (error) {
      state.approvals = { status: 'error', count: 0, error: messageForCrmError(error) || 'Não foi possível carregar as aprovações.' };
    }
    render();
  }

  function load(kind) {
    if (kind === 'crm') return loadCrm();
    if (kind === 'approvals') return loadApprovals();
    render(); // já desenha o que existe (e, sem nenhuma área na conta, a frase — não há carga que o faça)
    return Promise.all([state.crm.status !== 'off' ? loadCrm() : null, state.approvals.status !== 'off' ? loadApprovals() : null]);
  }

  function destroy() {
    state.destroyed = true;
  }

  return { load, render, destroy, state };
}
