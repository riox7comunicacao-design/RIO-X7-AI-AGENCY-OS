// Tela LEADS REPROVADOS (Implementação 3.0): os leads que NÃO estão ativos na Approval Queue — rejeitados por um humano, com dados insuficientes, duplicados, DNC e
// expirados — com todos os dados comerciais já pesquisados, o motivo, a data, quem decidiu e o job de origem. NADA é apagado aqui.
//
//   Browser -> esta tela -> api.mjs -> GET  /api/leads/reprovados?filtro=...              -> Lead Reconsideration Service
//                                   -> POST /api/leads/reprovados/:id/reaprovar { reason } -> Lead Reconsideration Service
//
// "REAPROVAR LEAD" NÃO pesquisa de novo, NÃO aprova e NÃO cria nada no CRM: só devolve um lead rejeitado por um humano à Approval Queue (AGUARDANDO_REVISAO), depois de o
// servidor checar as barreiras (já no CRM, DNC, duplicidade, exclusão permanente). Um humano ainda decide (aprovar) e depois promove, explicitamente. DNC é uma
// restrição de contato, não uma rejeição comercial: nunca aparece com o botão de reaprovar.
//
// PERMISSÕES: APPROVE:LEAD_APPROVAL (`canReview`) — o servidor decide de verdade; isto só mostra/esconde controles. Dados NÃO CONFIÁVEIS: tudo entra por dom.mjs.

import { h, fill } from '../dom.mjs';
import { textOf, formatDateTime } from '../format.mjs';
import { buildLeadProfile } from './leadProfile.mjs';
import { createEnrichmentPanel } from './leadEnrichmentPanel.mjs';

const FILTERS = Object.freeze([
  ['TODOS', 'Todos'],
  ['REPROVADOS', 'Reprovados'],
  ['DADOS_INSUFICIENTES', 'Dados insuficientes'],
  ['DUPLICADOS', 'Duplicados'],
  ['DNC', 'DNC'],
  ['EXPIRADOS', 'Expirados'],
]);
const STATE_LABELS = Object.freeze({ REJEITADO: 'Reprovado', DADOS_INSUFICIENTES: 'Dados insuficientes', DUPLICADO: 'Duplicado', DNC: 'DNC', EXPIRADO: 'Expirado' });

const messageFor = (error) => (error && typeof error.serverMessage === 'string' && error.serverMessage !== '' ? error.serverMessage : 'Não foi possível concluir agora. Tente novamente em instantes.');

export function createRejectedLeadsView({ document, root, api, permissions, schedule }) {
  const canReview = Boolean(permissions && permissions.canReview);
  const el = (tag, props, ...children) => h(document, tag, props, ...children);
  const state = { status: 'idle', error: null, items: [], filtro: 'TODOS', openId: null, reason: '', busy: false, message: null, panels: {} };
  let destroyed = false;

  async function load() {
    state.status = 'loading';
    render();
    try {
      const data = await api.listRejectedLeads(state.filtro);
      if (destroyed) return;
      state.items = Array.isArray(data && data.items) ? data.items : [];
      state.status = 'ready';
      state.error = null;
    } catch (error) {
      if (destroyed) return;
      state.status = 'error';
      state.error = messageFor(error);
    }
    render();
  }

  function setFilter(value) {
    state.filtro = value;
    state.openId = null;
    state.message = null;
    return load();
  }

  async function reapprove(item) {
    if (state.busy) return;
    state.busy = true;
    state.message = null;
    render();
    try {
      await api.reapproveLead(item.prospectId, state.reason.trim() === '' ? undefined : state.reason.trim());
      state.message = { kind: 'ok', text: `${textOf(item.empresa)} voltou para a Approval Queue (aguardando revisão). Nada foi enviado ao CRM.` };
      state.openId = null;
      state.reason = '';
      state.busy = false;
      await load();
      return;
    } catch (error) {
      state.message = { kind: 'error', text: messageFor(error) };
    }
    state.busy = false;
    render();
  }

  function filterBar() {
    return el('div', { className: 'filter-bar', role: 'group', 'aria-label': 'Filtrar leads reprovados' }, ...FILTERS.map(([value, label]) => el('button', { type: 'button', className: `btn ${state.filtro === value ? 'primary' : 'secondary'}`, 'data-filter': value, 'aria-pressed': state.filtro === value ? 'true' : 'false', disabled: state.status === 'loading', onclick: () => setFilter(value), text: label })));
  }

  // COMPLETAR PESQUISA / REVER SITE OFICIAL também aqui (3.0.2), com as MESMAS permissões (APPROVE:LEAD_APPROVAL, decidida pelo servidor). A pesquisa NÃO muda o estado do lead: ele continua
  // reprovado (ou o que for) na Approval Queue — reaprovar, aprovar ou promover são ações humanas SEPARADAS e explícitas. Um painel por lead aberto, uma pesquisa por vez.
  function panelFor(item) {
    if (!canReview || typeof api.getLeadResearchStatus !== 'function' || typeof api.completeLeadResearch !== 'function') return null;
    if (!state.panels[item.prospectId]) {
      const panel = createEnrichmentPanel({ document, api, prospectId: item.prospectId, canRun: true, ...(schedule ? { schedule } : {}), onFinished: () => load() });
      state.panels[item.prospectId] = panel;
      panel.load();
    }
    return state.panels[item.prospectId];
  }

  function detail(item) {
    const by = item.reprovadoPor ? `${textOf(item.reprovadoPor.name)} (${textOf(item.reprovadoPor.role)})` : 'Sistema (automático)';
    const nodes = [
      el('dl', { className: 'kv' },
        el('div', { className: 'kv-row' }, el('dt', { text: 'Motivo' }), el('dd', { text: textOf(item.motivo) || '—' })),
        el('div', { className: 'kv-row' }, el('dt', { text: 'Decidido por' }), el('dd', { text: by })),
        el('div', { className: 'kv-row' }, el('dt', { text: 'Data' }), el('dd', { text: formatDateTime(item.reprovadoEm) || '—' })),
        el('div', { className: 'kv-row' }, el('dt', { text: 'Job de origem' }), el('dd', { text: textOf(item.jobOrigem) || '—' })),
        el('div', { className: 'kv-row' }, el('dt', { text: 'Reaprovações anteriores' }), el('dd', { text: String(item.reaprovacoes || 0) }))
      ),
      el('h5', { text: 'Dados comerciais' }),
      buildLeadProfile(document, item.perfil),
      panelFor(item) ? panelFor(item).element : null,
    ].filter(Boolean);
    if (item.estado === 'DNC') nodes.push(el('p', { className: 'notice bad', role: 'note', text: 'Este contato está em DNC (restrição de contato). Não é uma rejeição comercial e não pode ser reaprovado.' }));
    else if (!item.reaprovavel) nodes.push(el('p', { className: 'muted', text: 'Só um lead reprovado por um humano pode ser reaprovado.' }));
    else if (canReview) {
      nodes.push(
        el('div', { className: 'field' },
          el('label', { for: 'reapprove-reason', text: 'Motivo da reaprovação (opcional)' }),
          el('input', { id: 'reapprove-reason', type: 'text', maxlength: '300', value: state.reason, oninput: (event) => { state.reason = event.target.value; } })
        ),
        el('button', { type: 'button', className: 'btn primary', id: 'btn-reapprove', disabled: state.busy, onclick: () => reapprove(item), text: 'REAPROVAR LEAD' }),
        el('p', { className: 'muted', text: 'Não pesquisa de novo: usa os dados acima, confere CRM/DNC/duplicidade e devolve o lead à Approval Queue. Um humano ainda precisa aprovar e promover.' })
      );
    }
    return el('tr', { className: 'detail-row' }, el('td', { colspan: '6' }, ...nodes));
  }

  function table() {
    if (state.items.length === 0) return el('p', { className: 'muted', id: 'rejected-empty', text: 'Nenhum lead nesta categoria.' });
    const rows = [];
    for (const item of state.items) {
      const open = state.openId === item.prospectId;
      rows.push(
        el('tr', { 'data-prospect': item.prospectId },
          el('td', { text: textOf(item.empresa) || '—' }),
          el('td', {}, el('span', { className: `badge ${item.estado === 'REJEITADO' ? 'warn' : 'neutral'}`, text: STATE_LABELS[item.estado] || textOf(item.estado) })),
          el('td', { text: textOf(item.motivo) || '—' }),
          el('td', { text: formatDateTime(item.reprovadoEm) || '—' }),
          el('td', { text: item.reprovadoPor ? textOf(item.reprovadoPor.name) : 'Sistema' }),
          el('td', {}, el('button', { type: 'button', className: 'btn secondary', 'data-open': item.prospectId, onclick: () => { state.openId = open ? null : item.prospectId; state.reason = ''; render(); }, text: open ? 'Ocultar' : 'Ver detalhes' }))
        )
      );
      if (open) rows.push(detail(item));
    }
    return el('table', { className: 'crm-table', id: 'rejected-table' },
      el('thead', {}, el('tr', {}, ...['Empresa', 'Situação', 'Motivo', 'Data', 'Por', ''].map((label) => el('th', { text: label })))),
      el('tbody', {}, ...rows)
    );
  }

  function render() {
    if (destroyed) return;
    fill(
      root,
      el('section', { className: 'overview', id: 'rejected-leads' },
        el('h2', { text: 'Leads Reprovados' }),
        el('p', { className: 'muted', text: 'Nada é apagado: aqui ficam os leads que saíram da Approval Queue, com tudo o que já foi pesquisado.' }),
        filterBar(),
        state.message ? el('p', { className: `message ${state.message.kind}`, role: state.message.kind === 'error' ? 'alert' : 'status', text: state.message.text }) : null,
        state.status === 'loading' ? el('p', { className: 'muted', text: 'Carregando…' }) : null,
        state.status === 'error' ? el('p', { className: 'message error', role: 'alert', text: state.error }) : null,
        state.status === 'ready' ? table() : null
      )
    );
  }

  return {
    load,
    render,
    destroy() {
      destroyed = true;
      for (const panel of Object.values(state.panels)) panel.destroy();
    },
  };
}
