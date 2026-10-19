// Tela DASHBOARD COMERCIAL (CRM 5.0, Fase D1, decisão 0028) — os indicadores REAIS das negociações, calculados no servidor a partir do que está gravado.
//
//   Browser -> esta tela -> api.mjs -> GET /api/negotiations/summary  ({ resumo }: abertas, ganhas, perdidas, conversão, por etapa)
//
// A tela NUNCA soma, estima nem inventa: cada número vem do servidor; sem dados, mostra o que falta (estado vazio), nunca um zero de enfeite. Definições (as mesmas do resto do sistema):
//   (D3) Um contrato por prazo INDETERMINADO tem TCV indeterminado: não entra no total de TCV (que passa a ser o TCV CONHECIDO), é contado à parte e o MRR dele entra normalmente. Nunca zero, nunca estimado.
//   TCV = valor total do contrato; MRR = receita recorrente MENSAL (só da recorrência mensal); equivalente mensal = TCV ÷ prazo, só para COMPARAR recorrências que não são mensais;
//   "em negociação" = negociações abertas; "contratado" = negociações ganhas. Valor RECEBIDO não aparece: ganhar é uma decisão comercial, não pagamento (virá dos pagamentos).
// Leitura com READ:CRM. Todo texto entra por dom.mjs (textContent).

import { h, fill } from '../dom.mjs';
import { textOf } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { formatMoney } from '../crm-model.mjs';
import { emptyState } from '../ui/index.mjs';
import { negotiationErrorInfo, MESSAGES } from '../negotiation-model.mjs';

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const percent = (rate) => `${(rate * 100).toFixed(1).replace('.', ',')}%`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// document/root: onde desenhar. api: o cliente de api.mjs. permissions: de permissionsOf(me).
export function createCommercialDashboardView({ document, root, api, permissions }) {
  const canRead = Boolean(permissions && permissions.canReadCrm);
  const state = { status: 'idle', error: null, summary: null, refreshing: false, message: null };
  let destroyed = false;
  let token = 0;
  const el = (tag, props, ...children) => h(document, tag, props, ...children);

  async function load({ quiet = false } = {}) {
    if (!canRead || destroyed) {
      render();
      return;
    }
    const mine = ++token;
    if (!quiet || state.status !== 'ready') state.status = 'loading';
    state.refreshing = true;
    state.message = null;
    render();
    try {
      const data = await api.negotiationSummary();
      if (destroyed || mine !== token) return;
      const resumo = data && data.resumo;
      if (!resumo || typeof resumo !== 'object' || !resumo.abertas || !resumo.ganhas || !resumo.perdidas || !resumo.conversao || !Array.isArray(resumo.porEtapa)) throw Object.assign(new Error('INVALID_RESPONSE'), { status: 502, code: 'INVALID_RESPONSE' });
      state.summary = resumo;
      state.status = 'ready';
      state.error = null;
    } catch (error) {
      if (destroyed || mine !== token) return;
      const info = negotiationErrorInfo(error);
      if (info === null) return;
      if (state.status !== 'ready') {
        state.status = 'error';
        state.error = info.kind === 'forbidden' ? 'Sua conta não tem permissão para ver o Dashboard Comercial.' : info.kind === 'not-found' ? 'O Dashboard Comercial não está disponível neste servidor.' : info.kind === 'network' ? MESSAGES.network : 'Não foi possível carregar os indicadores agora. Tente novamente.';
      } else {
        state.message = info.kind === 'network' ? MESSAGES.network : 'Não foi possível atualizar os indicadores agora. Os números na tela podem estar desatualizados.';
      }
    }
    state.refreshing = false;
    render();
  }

  const stat = (id, label, value, note) =>
    el('div', { className: 'dash-stat', 'data-stat': id }, el('p', { className: 'dash-stat-label muted', text: label }), el('p', { className: 'dash-stat-value', text: value }), note ? el('p', { className: 'dash-stat-note muted', text: note }) : null);

  function monthly(bucket) {
    // MRR e, à parte, o equivalente mensal das recorrências que não são mensais — nunca somados num número só sem dizer
    const rows = [stat('mrr', 'MRR (receita recorrente mensal)', formatMoney(number(bucket.mrr)), 'Só pagamentos recorrentes mensais.')];
    if (number(bucket.equivalenteMensalOutrasRecorrencias) > 0) rows.push(stat('equivalente', 'Equivalente mensal (outras recorrências)', formatMoney(number(bucket.equivalenteMensalOutrasRecorrencias)), 'Trimestral, semestral e anual, só para comparar: não é o que entra no caixa.'));
    return rows;
  }

  // O TCV: com contratos por prazo indeterminado no grupo, o total é o TCV CONHECIDO (só os de prazo definido) e a nota diz quantos ficaram de fora — o TCV deles não é determinado
  function tcvStat(id, bucket) {
    const indeterminate = number(bucket.tcvIndeterminado);
    if (indeterminate === 0) return stat(`${id}-tcv`, 'TCV (valor total dos contratos)', formatMoney(number(bucket.tcv)));
    return stat(`${id}-tcv`, 'TCV conhecido (contratos com prazo definido)', formatMoney(number(bucket.tcv)), `${plural(indeterminate, 'contrato por prazo indeterminado não entra', 'contratos por prazo indeterminado não entram')} neste total: o TCV deles é indeterminado (não é zero nem uma estimativa).`);
  }

  function group(id, title, subtitle, bucket, extra = []) {
    return el(
      'section',
      { className: 'dash-group', 'data-group': id, 'aria-labelledby': `dash-${id}-title` },
      el('h3', { id: `dash-${id}-title`, className: 'panel-section-title', text: title }),
      el('p', { className: 'muted', text: subtitle }),
      el('div', { className: 'dash-stats' }, stat(`${id}-qtd`, 'Negociações', String(number(bucket.quantidade))), tcvStat(id, bucket), ...monthly(bucket), ...extra),
      number(bucket.semCalculo) > 0 ? el('p', { className: 'muted', text: `${plural(number(bucket.semCalculo), 'negociação ficou fora', 'negociações ficaram fora')} dos valores por não ter as condições de pagamento completas.` }) : null
    );
  }

  function stagesTable(summary) {
    if (summary.porEtapa.length === 0) return el('p', { className: 'muted', text: 'Nenhuma negociação aberta no momento.' });
    return el(
      'table',
      { className: 'crm-table dash-table' },
      el('caption', { className: 'muted', text: 'Negociações abertas por etapa' }),
      el('thead', {}, el('tr', {}, ...['Funil', 'Etapa', 'Negociações', 'TCV em jogo'].map((title) => el('th', { scope: 'col', text: title })))),
      el('tbody', {}, ...summary.porEtapa.map((row) => el('tr', {}, el('td', { 'data-label': 'Funil', text: textOf(row.funnelNome) || 'Funil' }), el('td', { 'data-label': 'Etapa', text: textOf(row.stageNome) || 'Etapa' }), el('td', { 'data-label': 'Negociações', text: String(number(row.quantidade)) }), el('td', { 'data-label': 'TCV em jogo', text: number(row.tcvIndeterminadas) > 0 ? `${formatMoney(number(row.tcv))} (+ ${number(row.tcvIndeterminadas)} com TCV indeterminado; MRR ${formatMoney(number(row.mrr))})` : formatMoney(number(row.tcv)) }))))
    );
  }

  function render() {
    if (!root || destroyed) return;
    const head = el(
      'header',
      { className: 'page-title-row' },
      el('div', { className: 'page-title-block' }, el('h2', { id: 'dash-title', text: 'Dashboard Comercial' }), el('p', { className: 'muted page-subtitle', text: 'Os números das negociações, calculados a partir do que está gravado. Nada aqui é estimado.' })),
      canRead ? el('button', { type: 'button', className: 'btn secondary', 'data-action': 'refresh', text: 'Atualizar', disabled: state.refreshing, onclick: () => load({ quiet: true }) }) : null
    );
    if (!canRead) {
      fill(root, el('p', { className: 'message error', role: 'alert', text: 'Sua conta não tem permissão para ver o Dashboard Comercial.' }));
      return;
    }
    if (state.status === 'idle' || (state.status === 'loading' && state.summary === null)) {
      fill(root, head, el('p', { className: 'muted', role: 'status', text: 'Carregando os indicadores…' }));
      return;
    }
    if (state.status === 'error') {
      fill(root, head, el('p', { className: 'message error', role: 'alert', text: state.error }), el('button', { type: 'button', className: 'btn secondary', 'data-action': 'retry', text: 'Tentar novamente', onclick: () => load({ quiet: false }) }));
      return;
    }
    const summary = state.summary;
    const message = state.message ? el('p', { className: 'message warn', role: 'alert', text: state.message }) : null;
    if (number(summary.total) === 0) {
      fill(root, head, message, emptyState(document, { title: 'Ainda não há negociações.', text: 'Os indicadores aparecem assim que a primeira negociação for aberta em Funis de Vendas.', action: el('a', { className: 'btn primary', href: buildHash({ name: 'funnels' }), text: 'Abrir Funis de Vendas' }) }));
      return;
    }
    const conversion = summary.conversao;
    const conversionNode = number(conversion.fechadas) > 0 && typeof conversion.taxa === 'number'
      ? stat('conversao', 'Taxa de conversão', percent(conversion.taxa), `${plural(number(conversion.ganhas), 'ganha', 'ganhas')} de ${plural(number(conversion.fechadas), 'fechada', 'fechadas')} (ganhas + perdidas).`)
      : stat('conversao', 'Taxa de conversão', 'Sem dados', 'Aparece depois da primeira negociação ganha ou perdida.');
    fill(
      root,
      head,
      message,
      el('div', { className: 'dash' },
        group('abertas', 'Em negociação', 'Negociações abertas: ainda não são receita contratada.', summary.abertas),
        group('ganhas', 'Contratado', 'Negociações ganhas: o que foi fechado. Não é valor recebido.', summary.ganhas),
        group('perdidas', 'Perdidas', 'Negociações perdidas, com o valor que estava em jogo.', summary.perdidas, [conversionNode]),
        el('section', { className: 'dash-group', 'aria-labelledby': 'dash-stages-title' }, el('h3', { id: 'dash-stages-title', className: 'panel-section-title', text: 'Por etapa' }), stagesTable(summary)),
        el('p', { className: 'muted', text: 'O valor recebido não aparece aqui: ele virá dos pagamentos, em outra etapa do sistema.' })
      )
    );
  }

  function destroy() {
    destroyed = true;
    fill(root);
  }

  return { load, render, destroy, state };
}
