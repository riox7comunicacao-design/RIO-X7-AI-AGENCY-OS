// Tela VISÃO GERAL — a central operacional: indicadores, pipeline comercial e atividade recente.
//
// Só mostra dados que as rotas que já existem devolvem (GET /api/crm e GET /api/approvals): nenhum número inventado e nenhum
// status novo. Os indicadores do CRM são contagens dos status REAIS do domínio (Prospect, Meeting Scheduled, Proposal,
// Negotiation); a atividade recente são os eventos REAIS do histórico dos registros do CRM. Sem dado, um estado vazio — nunca
// um número de enfeite.
//
// Cada indicador só aparece se a conta tem a área correspondente (`permissions`, do que /api/me devolveu) — uma
// conveniência de interface; o servidor continua decidindo (um 403 vira uma frase, nunca uma tela quebrada). Todo texto entra
// no DOM por dom.mjs (textContent). A tela recebe `document`, `root` e `api` por parâmetro, como as demais.

import { h, fill } from '../dom.mjs';
import { textOf, formatDateTime } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { countByStatus, messageForCrmError, statusLabel, statusTone } from '../crm-model.mjs';

const MAX_ACTIVITY = 8;

// "Bom dia" até 11h59, "Boa tarde" até 17h59, "Boa noite" depois (a hora é a de Brasília).
export function greetingFor(hour) {
  if (typeof hour !== 'number' || Number.isNaN(hour)) return 'Olá';
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

function brasiliaHour(date) {
  const hour = Number.parseInt(date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }), 10);
  return Number.isNaN(hour) ? NaN : hour % 24;
}

const plural = (count, one, many) => (count === 1 ? one : many);

// Os eventos do histórico de todos os registros, do mais recente para o mais antigo (só os que têm data válida entram na
// ordenação; um evento malformado é ignorado, nunca uma exceção).
export function recentActivity(items, limit = MAX_ACTIVITY) {
  const events = [];
  for (const record of Array.isArray(items) ? items : []) {
    if (!record || typeof record !== 'object' || !Array.isArray(record.historico)) continue;
    for (const entry of record.historico) {
      if (!entry || typeof entry !== 'object') continue;
      const time = new Date(textOf(entry.timestamp)).getTime();
      if (Number.isNaN(time)) continue;
      events.push({ time, record, entry });
    }
  }
  events.sort((a, b) => b.time - a.time);
  return events.slice(0, limit);
}

// document/root: onde desenhar. api: { listCrm, listApprovals }. me: o que /api/me devolveu (só o nome é usado).
// permissions: { canReadCrm, canReview } (de permissionsOf(me)). now: () => Date (só para os testes fixarem a hora).
export function createOverviewView({ document, root, api, me, permissions, now = () => new Date() }) {
  const state = {
    crm: { status: permissions.canReadCrm ? 'loading' : 'off', items: [], error: null },
    approvals: { status: permissions.canReview ? 'loading' : 'off', count: 0, error: null },
    destroyed: false,
  };

  const el = (tag, props, ...children) => h(document, tag, props, ...children);

  function retry(kind) {
    return el('button', { type: 'button', className: 'btn secondary', text: 'Tentar novamente', onclick: () => load(kind) });
  }

  // Um indicador: título, valor grande, uma linha de apoio e (opcional) o caminho para a área.
  function kpi({ id, title, value, sub, link }) {
    return el(
      'section',
      { className: 'card kpi', 'aria-labelledby': `kpi-${id}` },
      el('h3', { id: `kpi-${id}`, className: 'kpi-title', text: title }),
      el('p', { className: 'stat', text: String(value) }),
      el('p', { className: 'muted kpi-sub', text: sub }),
      link ? el('a', { href: link.href, className: 'kpi-link', text: link.text }) : null
    );
  }

  function pendingKpi(id, title) {
    return el('section', { className: 'card kpi', 'aria-labelledby': `kpi-${id}` }, el('h3', { id: `kpi-${id}`, className: 'kpi-title', text: title }), el('p', { className: 'muted', text: 'Carregando…' }));
  }

  function errorCard(kind, id, title, message) {
    return el(
      'section',
      { className: 'card kpi kpi-error', 'aria-labelledby': `kpi-${id}` },
      el('h3', { id: `kpi-${id}`, className: 'kpi-title', text: title }),
      el('p', { className: 'message error', role: 'alert', text: message }),
      retry(kind)
    );
  }

  function crmKpis() {
    const { crm } = state;
    if (crm.status === 'off') return [];
    if (crm.status === 'loading') return [pendingKpi('leads', 'Leads no CRM')];
    if (crm.status === 'error') return [errorCard('crm', 'crm-error', 'CRM', crm.error)];
    const counts = new Map(countByStatus(crm.items).map((status) => [status.value, status.count]));
    const total = crm.items.length;
    return [
      kpi({ id: 'leads', title: 'Leads no CRM', value: total, sub: plural(total, 'registro no CRM', 'registros no CRM'), link: { href: buildHash({ name: 'crm-list' }), text: 'Abrir CRM' } }),
      kpi({ id: 'prospects', title: 'Novos prospects', value: counts.get('PROSPECT') || 0, sub: 'no status Prospect' }),
    ];
  }

  function approvalsKpi() {
    const { approvals } = state;
    if (approvals.status === 'off') return [];
    if (approvals.status === 'loading') return [pendingKpi('approvals', 'Aprovações pendentes')];
    if (approvals.status === 'error') return [errorCard('approvals', 'approvals-error', 'Aprovações', approvals.error)];
    return [
      kpi({
        id: 'approvals',
        title: 'Aprovações pendentes',
        value: approvals.count,
        sub: plural(approvals.count, 'prospect aguardando revisão', 'prospects aguardando revisão'),
        link: { href: buildHash({ name: 'approvals' }), text: 'Abrir aprovações' },
      }),
    ];
  }

  function crmStageKpis() {
    const { crm } = state;
    if (crm.status !== 'ready') return [];
    const counts = new Map(countByStatus(crm.items).map((status) => [status.value, status.count]));
    return [
      kpi({ id: 'meetings', title: 'Reuniões', value: counts.get('MEETING_SCHEDULED') || 0, sub: 'no status Meeting Scheduled' }),
      kpi({ id: 'proposals', title: 'Propostas', value: counts.get('PROPOSAL') || 0, sub: 'no status Proposal' }),
      kpi({ id: 'negotiations', title: 'Negociações', value: counts.get('NEGOTIATION') || 0, sub: 'no status Negotiation' }),
    ];
  }

  // O pipeline: os 13 status reais do domínio, na ordem do funil, cada um com a sua contagem.
  function pipelineCard() {
    const { crm } = state;
    const total = crm.items.length;
    let body;
    if (total === 0) {
      body = el('p', { className: 'empty-state', text: 'Ainda não há registros.' });
    } else {
      const stages = countByStatus(crm.items);
      body = el(
        'ul',
        { className: 'plain pipeline' },
        ...stages.map((stage) =>
          el(
            'li',
            { className: `pipeline-row${stage.count === 0 ? ' is-empty' : ''}` },
            el('span', { className: `badge ${stage.tone}`, text: stage.label }),
            el('progress', { className: `pipeline-bar tone-${stage.tone}`, max: String(total), value: String(stage.count), 'aria-label': `${stage.label}: ${stage.count} de ${total}` }),
            el('span', { className: 'pipeline-count', text: String(stage.count) })
          )
        )
      );
    }
    return el(
      'section',
      { className: 'card panel-card', 'aria-labelledby': 'overview-pipeline-title' },
      el('h3', { id: 'overview-pipeline-title', text: 'Pipeline comercial' }),
      el('p', { className: 'muted', text: 'Registros do CRM em cada status.' }),
      body
    );
  }

  function activityCard() {
    const events = recentActivity(state.crm.items);
    const body =
      events.length === 0
        ? el('p', { className: 'empty-state', text: 'Nenhuma atividade registrada ainda.' })
        : el(
            'ol',
            { className: 'plain activity' },
            ...events.map(({ record, entry }) => {
              const company = textOf(record.empresa) || 'Sem nome';
              const to = statusLabel(entry.to);
              const change = entry.from ? `${statusLabel(entry.from)} → ${to}` : `Registro criado como ${to}`;
              const who = entry.actor === 'HUMAN' && entry.reviewedBy && typeof entry.reviewedBy === 'object' ? textOf(entry.reviewedBy.name) || 'Equipe' : 'Sistema';
              const id = textOf(record.id);
              return el(
                'li',
                { className: 'activity-row' },
                id ? el('a', { href: buildHash({ name: 'crm-record', id }), className: 'activity-title', text: company }) : el('span', { className: 'activity-title', text: company }),
                el('span', { className: 'activity-change' }, el('span', { className: `badge ${statusTone(entry.to)}`, text: change })),
                el('span', { className: 'muted activity-meta', text: `${who} · ${formatDateTime(entry.timestamp)}` })
              );
            })
          );
    return el(
      'section',
      { className: 'card panel-card', 'aria-labelledby': 'overview-activity-title' },
      el('h3', { id: 'overview-activity-title', text: 'Atividade recente' }),
      el('p', { className: 'muted', text: 'Últimos eventos dos registros do CRM.' }),
      body
    );
  }

  function render() {
    if (state.destroyed) return;
    const name = me && typeof me.name === 'string' ? textOf(me.name) : '';
    const greeting = greetingFor(brasiliaHour(now()));
    const cards = [...crmKpis().slice(0, 2), ...approvalsKpi(), ...crmStageKpis()];
    // ordem dos indicadores: Leads, Novos prospects (CRM), Aprovações pendentes, e as três etapas do CRM (Reuniões, Propostas, Negociações)
    const panels = state.crm.status === 'ready' ? [pipelineCard(), activityCard()] : [];
    fill(
      root,
      el(
        'section',
        { className: 'overview', 'aria-labelledby': 'overview-title' },
        el(
          'div',
          { className: 'page-head' },
          el('h2', { id: 'overview-title', text: name ? `${greeting}, ${name}` : greeting }),
          el('p', { className: 'muted', text: 'Central operacional da Rio X7.' })
        ),
        cards.length > 0 ? el('div', { className: 'cards kpi-grid' }, ...cards) : el('p', { className: 'muted', text: 'Esta conta ainda não tem nenhuma área disponível.' }),
        panels.length > 0 ? el('div', { className: 'overview-panels' }, ...panels) : null
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
