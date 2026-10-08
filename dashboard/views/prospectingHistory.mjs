// Tela HISTÓRICO de prospecções (Implementação 3.0): todas as prospecções automáticas já executadas, da mais recente para a mais antiga, cada uma com o resumo padronizado
// do resultado. "REFAZER PROSPECÇÃO" cria um job NOVO com o mesmo briefing; o histórico nunca é alterado nem apagado, e as exclusões permanentes, o DNC e a deduplicação
// valem como em qualquer prospecção. Não há "cancelar" aqui: uma prospecção terminada não é cancelável.
//
//   Browser -> esta tela -> api.mjs -> GET  /api/prospecting/jobs
//                                   -> POST /api/prospecting/jobs/:id/redo
//
// PERMISSÕES: PROPOSE:LEAD_APPROVAL (`canProposeLead`); o servidor decide. Dados NÃO CONFIÁVEIS: tudo entra por dom.mjs.

import { h, fill } from '../dom.mjs';
import { textOf, formatDateTime } from '../format.mjs';
import { buildJobSummary } from './leadProfile.mjs';

const JOB_STATUS_LABELS = Object.freeze({ CRIADO: 'Criada', EXECUTANDO: 'Em execução', CANCELAMENTO_SOLICITADO: 'Cancelando…', CANCELADO: 'Cancelada', CONCLUIDO: 'Concluída', PARCIAL: 'Parcial', ERRO: 'Falhou' });
const ACTIVE = Object.freeze(['CRIADO', 'EXECUTANDO', 'CANCELAMENTO_SOLICITADO']);
const messageFor = (error) => (error && typeof error.serverMessage === 'string' && error.serverMessage !== '' ? error.serverMessage : 'Não foi possível concluir agora. Tente novamente em instantes.');

// navigate(hash): leva à tela Nova Prospecção depois de refazer (onde o andamento é acompanhado).
export function createProspectingHistoryView({ document, root, api, navigate = () => {} }) {
  const el = (tag, props, ...children) => h(document, tag, props, ...children);
  const state = { status: 'idle', error: null, jobs: [], busy: false, message: null };
  let destroyed = false;

  async function load() {
    state.status = 'loading';
    render();
    try {
      const data = await api.listProspectingJobs();
      if (destroyed) return;
      state.jobs = Array.isArray(data && data.items) ? data.items : [];
      state.status = 'ready';
    } catch (error) {
      if (destroyed) return;
      state.status = 'error';
      state.error = messageFor(error);
    }
    render();
  }

  async function redo(job) {
    if (state.busy) return;
    state.busy = true;
    state.message = null;
    render();
    try {
      await api.redoProspectingJob(job.id);
      state.busy = false;
      navigate('#/prospeccao');
      return;
    } catch (error) {
      state.message = { kind: 'error', text: messageFor(error) };
    }
    state.busy = false;
    render();
  }

  function card(job) {
    const active = ACTIVE.includes(job.status);
    const tone = job.status === 'CONCLUIDO' ? 'ok' : job.status === 'ERRO' || job.status === 'CANCELADO' ? 'bad' : 'warn';
    return el('article', { className: 'panel', 'data-job': job.id },
      el('h4', {}, el('span', { text: `${textOf(job.id)} ` }), el('span', { className: `badge ${tone}`, text: JOB_STATUS_LABELS[job.status] || textOf(job.status) })),
      el('p', { className: 'muted', text: `Iniciada em ${formatDateTime(job.startedAt || job.createdAt) || '—'}${job.refeitoDe ? ` · refeita a partir de ${textOf(job.refeitoDe)}` : ''}` }),
      buildJobSummary(document, job.resumo) || el('p', { className: 'muted', text: 'Sem resumo disponível para esta prospecção.' }),
      active ? el('a', { className: 'btn secondary', href: '#/prospeccao', text: 'Acompanhar na Nova Prospecção' }) : el('button', { type: 'button', className: 'btn primary', 'data-redo': job.id, disabled: state.busy, onclick: () => redo(job), text: 'REFAZER PROSPECÇÃO' })
    );
  }

  function render() {
    if (destroyed) return;
    fill(
      root,
      el('section', { className: 'overview', id: 'prospecting-history' },
        el('h2', { text: 'Histórico de prospecções' }),
        el('p', { className: 'muted', text: 'Refazer cria uma prospecção nova com o mesmo briefing. O histórico anterior é preservado.' }),
        state.message ? el('p', { className: `message ${state.message.kind}`, role: state.message.kind === 'error' ? 'alert' : 'status', text: state.message.text }) : null,
        state.status === 'loading' ? el('p', { className: 'muted', text: 'Carregando…' }) : null,
        state.status === 'error' ? el('p', { className: 'message error', role: 'alert', text: state.error }) : null,
        state.status === 'ready' && state.jobs.length === 0 ? el('p', { className: 'muted', id: 'history-empty', text: 'Nenhuma prospecção executada ainda.' }) : null,
        ...(state.status === 'ready' ? state.jobs.map(card) : [])
      )
    );
  }

  return { load, render, destroy() { destroyed = true; } };
}
