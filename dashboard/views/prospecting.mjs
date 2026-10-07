// Tela PROSPECÇÃO — o Workbench operacional de prospecção (Etapa "Prospecção 1").
//
//   Browser -> esta tela -> api.mjs -> HTTP /api/prospecting/briefs -> Prospecting Brief Service
//                                    -> HTTP /api/prospecting/batches -> Prospecting Service (achados)
//                                    -> HTTP /api/approvals/:id/(approve|reject) -> Approval Queue (JÁ EXISTENTE)
//
// Um BRIEF é o rascunho do Workbench (nicho, subnicho, geografia, quantidade, objetivo), com um id amigável
// (PROS-YYYYMMDD-NNN) e um status (RASCUNHO -> PRONTO_PARA_PESQUISA -> PESQUISANDO -> AGUARDANDO_REVISAO ->
// CONCLUIDO/CANCELADO). "Gerar pacote de pesquisa" NUNCA pesquisa a web por conta própria — monta um pedido
// estruturado para colar numa conversa com o Claude; o RESULTADO (achados) é colado de volta (JSON) e ingerido
// pelo Prospecting Service já existente, que autoriza, valida, deduplica e cria o LOTE de verdade.
//
// Uma vez ingerido (brief.loteRealId), a tabela de achados vem do LOTE real (GET /api/prospecting/batches/:id) —
// aprovar/rejeitar um achado usa a MESMA Approval Queue de sempre (api.approve/api.reject); esta tela nunca
// duplica essa lógica. Achados que o pipeline já classificou como duplicado/DNC/dados insuficientes NUNCA chegam
// à fila — aparecem aqui só como status informativo, sem ação (não há nada para decidir: o sistema já decidiu).
//
// INICIAR PROSPECÇÃO (Fase 2): com o brief pronto, o botão cria um JOB no servidor (descoberta na web + validação das páginas por código + UMA
// ingestão pelo caminho oficial) e a tela consulta o status a cada poucos segundos — sem copiar JSON, sem terminal. O job pode ser cancelado
// até a ingestão; ao terminar, o resultado e o link para a fila de Aprovações aparecem aqui. Nada vai para o CRM sem a aprovação humana.
//
// PERMISSÕES: PROPOSE:LEAD_APPROVAL (`canProposeLead`) para tudo nesta tela — a mesma que já autoriza o
// Prospecting Service. O servidor decide de verdade; isto só mostra/esconde controles.
//
// SEGURANÇA: dados de um achado são NÃO CONFIÁVEIS (pesquisa web) — tudo entra no DOM por dom.mjs (textContent).

import { h, fill } from '../dom.mjs';
import { textOf, safeHttpUrl, formatDateTime } from '../format.mjs';

const GEO_LEVELS = [
  { value: 'CIDADE', label: 'Cidade' },
  { value: 'ESTADO', label: 'Estado' },
  { value: 'NACIONAL', label: 'Nacional' },
];

const STATUS_LABELS = Object.freeze({
  RASCUNHO: 'Rascunho',
  PRONTO_PARA_PESQUISA: 'Pronto para pesquisa',
  PESQUISANDO: 'Pesquisando',
  AGUARDANDO_REVISAO: 'Aguardando revisão',
  CONCLUIDO: 'Concluído',
  CANCELADO: 'Cancelado',
});

const RESULT_STATUS_LABELS = Object.freeze({
  DNC: 'Não contatar (DNC)',
  DUPLICADO: 'Duplicado',
  DADOS_INSUFICIENTES: 'Dados insuficientes',
  REPETIDO_NA_SUBMISSAO: 'Repetido nesta submissão',
});

const JOB_STEP_LABELS = Object.freeze({
  PREPARANDO: 'Preparando',
  DESCOBRINDO: 'Descobrindo empresas na web',
  VALIDANDO: 'Validando as páginas das empresas',
  INGERINDO: 'Enviando para a aprovação',
  FINALIZADO: 'Finalizado',
});

const JOB_STATUS_LABELS = Object.freeze({
  CRIADO: 'Criada',
  EXECUTANDO: 'Em execução',
  CANCELAMENTO_SOLICITADO: 'Cancelando…',
  CANCELADO: 'Cancelada',
  CONCLUIDO: 'Concluída',
  PARCIAL: 'Parcial',
  ERRO: 'Falhou',
});

const JOB_ACTIVE = Object.freeze(['CRIADO', 'EXECUTANDO', 'CANCELAMENTO_SOLICITADO']);
const POLL_MS = 2500;
const MAX_POLL_FAILURES = 4;

// Mensagens para o usuário (nunca o código técnico nem JSON).
const JOB_ERROR_TEXT = Object.freeze({
  DISCOVERY_FAILED: 'Não foi possível descobrir empresas agora. Tente novamente em instantes.',
  JOB_INTERRUPTED: 'A prospecção foi interrompida (o servidor foi reiniciado). Você pode iniciar de novo.',
  INGESTION_FAILED: 'As empresas foram validadas, mas não puderam ser enviadas para a aprovação. Nada foi promovido ao CRM.',
  JOB_INTERNAL: 'A prospecção falhou por um erro interno. Tente novamente.',
});

const CANDIDATE_RESULT_LABELS = Object.freeze({ VALIDADO: 'Validada', NAO_VERIFICADO: 'Não verificada', DESCARTADO: 'Descartada' });
const CHANNEL_LABELS = Object.freeze({ instagram: 'Instagram', facebook: 'Facebook', googleMeuNegocio: 'Google Meu Negócio', linkedin: 'LinkedIn', youtube: 'YouTube', tiktok: 'TikTok', whatsapp: 'WhatsApp' });

// Os canais públicos CONFIRMADOS da empresa, em texto ("Instagram, Facebook"); "—" se nenhum.
function confirmedChannelsText(presence) {
  if (!presence || typeof presence !== 'object') return '—';
  const names = Object.keys(CHANNEL_LABELS).filter((canal) => presence[canal] && presence[canal].confirmacao === 'CONFIRMADO').map((canal) => CHANNEL_LABELS[canal]);
  return names.length > 0 ? names.join(', ') : '—';
}

// Onde o candidato terminou no pipeline oficial: "Na fila" (chegou à Approval Queue) ou "Fora da fila: <estado real>"; "—" se não foi ingerido.
function deliveryText(candidate) {
  const delivery = candidate && candidate.entrega;
  if (!delivery || typeof delivery !== 'object') return '—';
  if (delivery.naFila === true) return 'Na fila';
  if (delivery.jaExistiaNaFila === true) return 'Já estava na fila';
  const state = typeof delivery.estadoOperacional === 'string' ? RESULT_STATUS_LABELS[delivery.estadoOperacional] || delivery.estadoOperacional : 'estado desconhecido';
  return `Fora da fila: ${state}`;
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function geografiaTexto(brief) {
  if (brief.nivelGeografico === 'CIDADE') return `Cidade: ${(brief.cidades || []).join(', ')}`;
  if (brief.nivelGeografico === 'ESTADO') return `Estado: ${(brief.estados || []).join(', ')}`;
  return `Nacional: ${brief.pais || 'Brasil'}`;
}

// document/root: onde desenhar. api: o cliente de api.mjs. permissions: { canProposeLead }. navigate: não usado
// ainda (a ficha de um achado aprovado é a fila de Aprovações, não esta tela).
// schedule(fn, ms) -> cancelar(): o agendador da consulta de status (padrão: setTimeout; os testes passam o seu).
const defaultSchedule = (fn, ms) => {
  const timer = globalThis.setTimeout(fn, ms);
  return () => globalThis.clearTimeout(timer);
};

export function createProspectingView({ document, root, api, permissions, schedule = defaultSchedule }) {
  const canPropose = Boolean(permissions && permissions.canProposeLead);
  const el = (tag, props, ...children) => h(document, tag, props, ...children);

  const state = {
    status: 'idle', // idle | loading | ready | error
    error: null,
    briefs: [],
    selectedId: null,
    selected: null, // o brief carregado (getBrief)
    batch: null, // o lote real, quando selected.loteRealId existe
    form: { nicho: '', subnicho: '', nivelGeografico: 'CIDADE', locais: '', pais: 'Brasil', quantidade: 50, observacoes: '' },
    findingsText: '',
    busy: false,
    message: null,
    job: null, // o job de prospecção automática do brief selecionado (o mais recente)
    manualOpen: false, // o "Modo manual" (fluxo antigo) está aberto?
  };
  let stopPolling = null;
  let pollFailures = 0;
  let destroyed = false;

  let refs = {};

  function setMessage(kind, text) {
    state.message = text ? { kind, text } : null;
  }

  async function load() {
    state.status = 'loading';
    render();
    try {
      const data = await api.listProspectingBriefs();
      state.briefs = Array.isArray(data && data.items) ? data.items : [];
      state.status = 'ready';
    } catch (error) {
      state.status = 'error';
      state.error = messageFor(error);
    }
    render();
    await resumeActiveJob();
  }

  // Depois de um refresh da página: se há uma prospecção em andamento, seleciona o brief dela e volta a acompanhar.
  async function resumeActiveJob() {
    if (state.selectedId || state.job || destroyed) return;
    try {
      const data = await api.listProspectingJobs();
      const active = (Array.isArray(data && data.items) ? data.items : []).find((job) => JOB_ACTIVE.includes(job.status));
      if (active) await selectBrief(active.briefId);
    } catch {
      // a tela segue sem o acompanhamento; o usuário pode abrir o brief
    }
  }

  function stopJobPolling() {
    if (stopPolling) stopPolling();
    stopPolling = null;
  }

  function startJobPolling() {
    stopJobPolling();
    if (destroyed || !state.job || !JOB_ACTIVE.includes(state.job.status)) return;
    stopPolling = schedule(pollJob, POLL_MS);
  }

  async function pollJob() {
    stopPolling = null;
    if (destroyed || !state.job) return;
    try {
      const data = await api.getProspectingJobStatus(state.job.id);
      pollFailures = 0;
      state.job = data.item;
    } catch (error) {
      pollFailures += 1;
      if (pollFailures >= MAX_POLL_FAILURES) {
        setMessage('error', 'Perdi o acompanhamento da prospecção. Recarregue a página para ver o resultado.');
        render();
        return;
      }
    }
    render();
    if (state.job && JOB_ACTIVE.includes(state.job.status)) {
      startJobPolling();
      return;
    }
    // terminou: atualiza o brief (status, lote e tabela de achados) e a lista
    pollFailures = 0;
    if (state.selectedId) await selectBrief(state.selectedId);
    try {
      const lista = await api.listProspectingBriefs();
      state.briefs = Array.isArray(lista && lista.items) ? lista.items : state.briefs;
    } catch {
      // a lista se atualiza na próxima carga
    }
    render();
  }

  async function onStartJob() {
    if (state.busy || !state.selectedId) return;
    state.busy = true;
    setMessage(null);
    render();
    try {
      const data = await api.startProspectingJob(state.selectedId);
      state.job = data.item;
      pollFailures = 0;
      startJobPolling();
    } catch (error) {
      setMessage('error', messageFor(error));
    }
    state.busy = false;
    render();
  }

  async function onCancelJob() {
    if (state.busy || !state.job) return;
    state.busy = true;
    setMessage(null);
    render();
    try {
      const data = await api.cancelProspectingJob(state.job.id);
      state.job = data.item;
      setMessage('ok', 'Cancelamento solicitado. A prospecção para na próxima etapa segura.');
      startJobPolling();
    } catch (error) {
      setMessage('error', messageFor(error));
    }
    state.busy = false;
    render();
  }

  async function selectBrief(id) {
    state.selectedId = id;
    state.selected = null;
    state.batch = null;
    if (state.job && state.job.briefId !== id) {
      stopJobPolling();
      state.job = null;
    }
    render();
    try {
      const data = await api.getProspectingBrief(id);
      state.selected = data.item;
      try {
        const jobs = await api.listProspectingJobs(id);
        const latest = Array.isArray(jobs && jobs.items) && jobs.items.length > 0 ? jobs.items[0] : null;
        if (latest) {
          state.job = latest;
          if (!stopPolling) startJobPolling();
        }
      } catch {
        // sem o acompanhamento do job a tela segue funcionando
      }
      if (state.selected.loteRealId) {
        try {
          const lote = await api.getProspectingBatch(state.selected.loteRealId);
          state.batch = lote.item;
        } catch {
          state.batch = null; // o lote pode não estar acessível (ex.: dupla checagem de permissão) — a tela não trava por isso
        }
      }
    } catch (error) {
      setMessage('error', messageFor(error));
    }
    render();
  }

  function messageFor(error) {
    const status = error && typeof error.status === 'number' ? error.status : null;
    if (status === 403) return 'Sua conta não tem permissão para esta ação.';
    if (status === 404) return 'Não encontrado.';
    if (status === 409) return (error && error.serverMessage) || 'Esta ação não é permitida no estado atual.';
    if (status === 400) return (error && error.serverMessage) || 'Dados inválidos.';
    return 'Não foi possível concluir a operação agora. Tente novamente.';
  }

  async function runAction(fn) {
    if (state.busy) return;
    state.busy = true;
    setMessage(null);
    render();
    try {
      await fn();
      if (state.selectedId) await selectBrief(state.selectedId);
      await load();
    } catch (error) {
      setMessage('error', messageFor(error));
    }
    state.busy = false;
    render();
  }

  async function onCreateSubmit(event) {
    event.preventDefault();
    if (state.busy) return;
    const f = state.form;
    const fields = { nicho: f.nicho, nivelGeografico: f.nivelGeografico, quantidade: Number(f.quantidade) };
    if (f.subnicho.trim() !== '') fields.subnicho = f.subnicho.trim();
    if (f.observacoes.trim() !== '') fields.observacoes = f.observacoes.trim();
    if (f.nivelGeografico === 'CIDADE') fields.cidades = f.locais;
    else if (f.nivelGeografico === 'ESTADO') fields.estados = f.locais;
    else fields.pais = f.pais.trim() || 'Brasil';

    state.busy = true;
    setMessage(null);
    render();
    try {
      const criado = await api.createProspectingBrief(fields);
      state.form = { nicho: '', subnicho: '', nivelGeografico: 'CIDADE', locais: '', pais: 'Brasil', quantidade: 50, observacoes: '' };
      await load();
      await selectBrief(criado.item.id);
    } catch (error) {
      setMessage('error', messageFor(error));
    }
    state.busy = false;
    render();
  }

  function onIngest() {
    let parsed;
    try {
      parsed = JSON.parse(state.findingsText);
    } catch {
      setMessage('error', 'O texto colado não é um JSON válido.');
      render();
      return;
    }
    const rawFindings = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.rawFindings) ? parsed.rawFindings : null;
    if (rawFindings === null) {
      setMessage('error', 'Cole uma lista de achados (ou um objeto { rawFindings: [...] }).');
      render();
      return;
    }
    runAction(async () => {
      await api.ingestProspectingFindings(state.selectedId, rawFindings);
      state.findingsText = '';
    });
  }

  // ---- construção da tela --------------------------------------------------
  function buildForm() {
    const f = state.form;
    const nicho = el('input', { id: 'pros-nicho', value: f.nicho, required: 'required', oninput: (e) => (f.nicho = e.target.value) });
    const subnicho = el('input', { id: 'pros-subnicho', value: f.subnicho, oninput: (e) => (f.subnicho = e.target.value) });
    const nivel = el(
      'select',
      { id: 'pros-nivel', onchange: (e) => { f.nivelGeografico = e.target.value; render(); } },
      ...GEO_LEVELS.map((g) => el('option', { value: g.value, selected: f.nivelGeografico === g.value ? 'selected' : undefined, text: g.label }))
    );
    const locaisLabel = f.nivelGeografico === 'CIDADE' ? 'Cidade(s) — separadas por vírgula' : 'Estado(s) — separados por vírgula';
    const locais = el('input', { id: 'pros-locais', value: f.locais, placeholder: 'Ex.: Petrópolis, Teresópolis', oninput: (e) => (f.locais = e.target.value) });
    const pais = el('input', { id: 'pros-pais', value: f.pais, oninput: (e) => (f.pais = e.target.value) });
    const quantidade = el('input', { id: 'pros-quantidade', type: 'number', min: '1', max: '300', value: String(f.quantidade), oninput: (e) => (f.quantidade = e.target.value) });
    const observacoes = el('textarea', { id: 'pros-observacoes', rows: '2', oninput: (e) => (f.observacoes = e.target.value) }, f.observacoes);

    return el(
      'form',
      { className: 'panel', onsubmit: onCreateSubmit },
      el('h3', { text: 'Novo lote' }),
      el('div', { className: 'form-grid' },
        el('div', { className: 'field' }, el('label', { for: 'pros-nicho', text: 'Nicho' }), nicho),
        el('div', { className: 'field' }, el('label', { for: 'pros-subnicho', text: 'Subnicho (opcional)' }), subnicho),
        el('div', { className: 'field' }, el('label', { for: 'pros-nivel', text: 'Nível geográfico' }), nivel),
        el('div', { className: 'field' },
          el('label', { for: 'pros-locais', text: locaisLabel }),
          ...(f.nivelGeografico === 'NACIONAL' ? [] : [locais])
        ),
        ...(f.nivelGeografico === 'NACIONAL' ? [el('div', { className: 'field' }, el('label', { for: 'pros-pais', text: 'País' }), pais)] : []),
        el('div', { className: 'field' }, el('label', { for: 'pros-quantidade', text: 'Quantidade desejada (1–300)' }), quantidade)
      ),
      el('div', { className: 'field' }, el('label', { for: 'pros-observacoes', text: 'Observações / objetivo (opcional)' }), observacoes),
      el('button', { type: 'submit', className: 'btn primary', disabled: state.busy || !canPropose, text: 'Criar lote' })
    );
  }

  function briefRow(brief) {
    const row = el(
      'tr',
      { className: brief.id === state.selectedId ? 'selected' : '' },
      el('td', {}, el('button', { type: 'button', className: 'link', onclick: () => selectBrief(brief.id), text: brief.id })),
      el('td', { text: brief.nicho }),
      el('td', { text: geografiaTexto(brief) }),
      el('td', { text: String(brief.quantidade) }),
      el('td', {}, el('span', { className: `badge tone-${brief.status === 'CANCELADO' ? 'bad' : brief.status === 'CONCLUIDO' ? 'ok' : 'warn'}`, text: STATUS_LABELS[brief.status] || brief.status }))
    );
    return row;
  }

  function buildRecent() {
    if (state.briefs.length === 0) return el('p', { className: 'muted', text: 'Nenhum lote ainda.' });
    return el(
      'table',
      { className: 'crm-table' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Lote' }), el('th', { text: 'Nicho' }), el('th', { text: 'Geografia' }), el('th', { text: 'Qtd.' }), el('th', { text: 'Status' }))),
      el('tbody', {}, ...state.briefs.map(briefRow))
    );
  }

  function actionButton(text, onclick, extraClass = 'secondary') {
    return el('button', { type: 'button', className: `btn ${extraClass}`, disabled: state.busy, onclick, text });
  }

  function buildPackageBlock(brief) {
    if (!brief.pacotePesquisa) return null;
    const json = JSON.stringify(brief.pacotePesquisa, null, 2);
    return el(
      'div', { className: 'field' },
      el('label', { text: 'Pacote de pesquisa (copie e cole numa conversa com o Claude/Web)' }),
      el('textarea', { rows: '10', readonly: 'readonly', text: json })
    );
  }

  function buildIngestBlock() {
    return el(
      'div', { className: 'field' },
      el('label', { for: 'pros-findings', text: 'Cole aqui o resultado da pesquisa (JSON: uma lista de achados)' }),
      el('textarea', { id: 'pros-findings', rows: '8', value: state.findingsText, oninput: (e) => (state.findingsText = e.target.value) }),
      actionButton('Ingerir achados', onIngest, 'primary')
    );
  }

  function resultRow(entry) {
    const podeDecidir = entry.naFila && entry.estadoFila === 'AGUARDANDO_REVISAO';
    const statusTexto = entry.motivo ? RESULT_STATUS_LABELS[entry.motivo] || entry.motivo : entry.estadoFila || entry.estadoOperacional;
    return el(
      'tr', {},
      el('td', { text: entry.empresa || '—' }),
      el('td', { text: statusTexto || '—' }),
      el('td', {},
        ...(podeDecidir
          ? [
              actionButton('Aprovar', () => runAction(() => api.approve(entry.prospectId)), 'secondary'),
              actionButton('Rejeitar', () => runAction(() => api.reject(entry.prospectId, 'rejeitado pelo Workbench de Prospecção')), 'danger'),
            ]
          : [el('span', { className: 'muted', text: 'sem ação (já decidido pelo sistema)' })])
      )
    );
  }

  function buildFindingsTable() {
    if (!state.batch) return null;
    const resultados = Array.isArray(state.batch.resultados) ? state.batch.resultados : [];
    return el(
      'div', {},
      el('h4', { text: `Achados do lote (${resultados.length})` }),
      el(
        'table', { className: 'crm-table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Empresa' }), el('th', { text: 'Status' }), el('th', { text: 'Ações' }))),
        el('tbody', {}, ...resultados.map(resultRow))
      )
    );
  }

  // O bloco "INICIAR PROSPECÇÃO": o botão, o andamento (status, etapa, contagens, progresso, tempo, cancelar) e o resultado final.
  function buildAutoRun(brief) {
    const job = state.job;
    const active = Boolean(job) && JOB_ACTIVE.includes(job.status);
    const startable = brief.status === 'PRONTO_PARA_PESQUISA';
    const parts = [];
    if (startable && !active) {
      parts.push(
        el('p', { className: 'muted', text: 'A prospecção automática procura empresas na web, confere a página de cada uma e envia só as comprovadas para a aprovação.' }),
        el('button', { type: 'button', className: 'btn primary', id: 'pros-start-job', disabled: state.busy, onclick: onStartJob, text: 'INICIAR PROSPECÇÃO' })
      );
    }
    if (job) parts.push(buildJobProgress(job, active));
    if (parts.length === 0) return null;
    return el('div', { className: 'panel', id: 'pros-auto' }, el('h4', { text: 'Prospecção automática' }), ...parts);
  }

  function buildJobProgress(job, active) {
    const tone = job.status === 'CONCLUIDO' ? 'ok' : job.status === 'ERRO' || job.status === 'CANCELADO' ? 'bad' : 'warn';
    const nodes = [];
    const title = { CONCLUIDO: 'PROSPECÇÃO CONCLUÍDA', PARCIAL: 'PROSPECÇÃO PARCIAL', CANCELADO: 'PROSPECÇÃO CANCELADA', ERRO: 'A PROSPECÇÃO FALHOU' }[job.status];
    if (title) nodes.push(el('h4', { className: 'job-title', text: title }));
    nodes.push(el('p', {}, el('span', { className: `badge ${tone}`, text: JOB_STATUS_LABELS[job.status] || job.status }), ' ', el('span', { className: 'muted', text: JOB_STEP_LABELS[job.currentStep] || '' })));
    // a meta é só o que CHEGOU à Approval Queue; "reposições" = ciclos de busca de candidatos novos para substituir o que o pipeline reteve
    const queued = Number.isInteger(job.leadsNaFila) ? job.leadsNaFila : job.lote && Number.isInteger(job.lote.naFila) ? job.lote.naFila : 0;
    const processed = (Number(job.candidatesValidated) || 0) + (Number(job.candidatesRejected) || 0);
    const replenished = job.telemetria && Number.isInteger(job.telemetria.reposicoesRealizadas) ? job.telemetria.reposicoesRealizadas : 0;
    nodes.push(
      el('progress', { className: 'pipeline-bar', max: '100', value: String(Math.max(0, Math.min(100, Number(job.progress) || 0))), 'aria-label': 'Progresso da prospecção' }),
      el('p', { text: `Empresas descobertas: ${job.candidatesDiscovered} · Validadas pela página: ${job.candidatesValidated} · Não validadas: ${job.candidatesRejected} · Solicitadas: ${job.requestedQuantity}` }),
      el('p', { id: 'pros-job-queue', text: `Leads na Approval Queue: ${queued} de ${job.requestedQuantity} · Candidatos processados: ${processed} · Reposições: ${replenished}` }),
      el('p', { className: 'muted', text: `Tempo decorrido: ${formatElapsed(job.elapsedMs)}` })
    );
    if (active && job.currentStep !== 'INGERINDO') nodes.push(el('button', { type: 'button', className: 'btn danger', id: 'pros-cancel-job', disabled: state.busy || job.status === 'CANCELAMENTO_SOLICITADO', onclick: onCancelJob, text: 'CANCELAR PROSPECÇÃO' }));
    if (job.status === 'ERRO') nodes.push(el('p', { className: 'notice bad', role: 'note', text: JOB_ERROR_TEXT[job.error && job.error.code] || JOB_ERROR_TEXT.JOB_INTERNAL }));
    if (job.status === 'CONCLUIDO' || job.status === 'PARCIAL') {
      if (replenished > 0) nodes.push(el('p', { className: 'muted', id: 'pros-job-replenish', text: `Reposições realizadas: ${replenished}` }));
      // a meta conta só os leads que CHEGARAM à Approval Queue; validado pela pesquisa não é o mesmo que entregue à fila
      const naFila = job.lote && Number.isInteger(job.lote.naFila) ? job.lote.naFila : queued;
      const foraDaFila = job.lote && Number.isInteger(job.lote.foraDaFila) ? job.lote.foraDaFila : 0;
      nodes.push(
        el('p', { text: naFila > 0 ? `${naFila} de ${job.requestedQuantity} lead(s) solicitado(s) chegaram à Approval Queue.` : job.candidatesValidated > 0 ? 'Nenhum lead chegou à Approval Queue.' : 'Nenhuma empresa pôde ser comprovada pela página; nada foi enviado para a aprovação.' }),
        ...(foraDaFila > 0 ? [el('p', { className: 'muted', text: `${job.candidatesValidated} empresa(s) comprovada(s) pela pesquisa, mas ${foraDaFila} não foi(ram) entregue(s) à fila (dados insuficientes, DNC ou duplicado).` })] : []),
        ...(job.status === 'PARCIAL' && job.candidatesValidated > 0 ? [el('p', { className: 'muted', text: 'A quantidade pedida não foi atingida: nenhuma empresa fraca foi incluída para completar.' })] : []),
        ...(naFila > 0 ? [el('a', { className: 'btn secondary', id: 'pros-open-approvals', href: '#/aprovacoes', text: 'Abrir Aprovações' })] : [])
      );
    }
    // o resultado por empresa examinada (sem JSON): resultado, se o site oficial foi encontrado e quais canais públicos foram CONFIRMADOS
    const examined = Array.isArray(job.candidatos) ? job.candidatos.filter((c) => c && c.resultado) : [];
    if (!active && examined.length > 0) {
      nodes.push(
        el('table', { className: 'crm-table', id: 'pros-job-candidates' },
          el('thead', {}, el('tr', {}, el('th', { text: 'Empresa' }), el('th', { text: 'Resultado' }), el('th', { text: 'Site oficial' }), el('th', { text: 'Presença digital confirmada' }), el('th', { text: 'Approval Queue' }))),
          el('tbody', {}, ...examined.map((c) => el('tr', {}, el('td', { text: c.nome }), el('td', { text: CANDIDATE_RESULT_LABELS[c.resultado] || c.resultado }), el('td', { text: c.siteOficial && c.siteOficial.status === 'ENCONTRADO' ? 'Encontrado' : 'Não encontrado' }), el('td', { text: confirmedChannelsText(c.presencaDigital) }), el('td', { text: deliveryText(c) })))))
      );
    }
    return el('div', { className: 'job-box' }, ...nodes);
  }

  // O "Modo manual" (o fluxo ANTIGO: gerar o pacote de pesquisa, levar ao Claude/Web e colar o JSON de volta): um bloco discreto, recolhido, SÓ quando não há
  // prospecção automática para este brief. Havendo um job (ativo ou terminado), a tela mostra só o fluxo automático: nenhum pacote JSON, nenhum "copiar",
  // nenhuma ingestão manual.
  function buildManualMode(brief) {
    if (state.job) return null;
    const canGenerate = brief.status === 'PRONTO_PARA_PESQUISA' || brief.status === 'PESQUISANDO';
    if (!canGenerate && !brief.pacotePesquisa) return null;
    return el(
      'div', { className: 'manual-mode', id: 'pros-manual' },
      el('button', { type: 'button', className: 'link', id: 'pros-manual-toggle', onclick: () => { state.manualOpen = !state.manualOpen; render(); }, text: state.manualOpen ? 'Ocultar modo manual' : 'Modo manual' }),
      ...(state.manualOpen
        ? [
            el('p', { className: 'muted', text: 'Fluxo antigo: gere um pacote de pesquisa, leve-o ao Claude/Web e cole o resultado de volta.' }),
            canGenerate ? actionButton('Gerar pacote de pesquisa', () => runAction(() => api.generateProspectingPackage(brief.id)), 'secondary') : null,
            buildPackageBlock(brief),
            brief.status === 'PESQUISANDO' ? buildIngestBlock() : null,
          ]
        : [])
    );
  }

  function buildSelected() {
    const brief = state.selected;
    if (!state.selectedId) return el('p', { className: 'muted', text: 'Selecione um lote para ver os detalhes.' });
    if (!brief) return el('p', { className: 'muted', text: 'Carregando…' });
    const contagens = brief.contagens || {};
    return el(
      'div', { className: 'panel' },
      el('h3', { text: brief.id }),
      el('p', {}, el('span', { className: 'badge', text: STATUS_LABELS[brief.status] || brief.status })),
      el('p', { text: `Nicho: ${brief.nicho}${brief.subnicho ? ` / ${brief.subnicho}` : ''}` }),
      el('p', { text: geografiaTexto(brief) }),
      el('p', { text: `Quantidade solicitada: ${brief.quantidade}` }),
      brief.observacoes ? el('p', { className: 'muted', text: brief.observacoes }) : null,
      brief.contagens
        ? el('p', { text: `Encontrados: ${contagens.encontrados ?? '—'} · Válidos: ${(contagens.validos ?? contagens.suficientes ?? '—')} · Aguardando revisão: ${brief.excluidosPermanentemente ? `(${brief.excluidosPermanentemente} excluídos permanentemente)` : ''}` })
        : null,
      buildAutoRun(brief),
      el('div', { className: 'actions' },
        brief.status === 'RASCUNHO' ? actionButton('Marcar pronto para pesquisa', () => runAction(() => api.markProspectingBriefReady(brief.id)), 'primary') : null,
        brief.status === 'AGUARDANDO_REVISAO' ? actionButton('Marcar concluído', () => runAction(() => api.concludeProspectingBrief(brief.id)), 'secondary') : null,
        !['CONCLUIDO', 'CANCELADO'].includes(brief.status) ? actionButton('Cancelar lote', () => runAction(() => api.cancelProspectingBrief(brief.id)), 'danger') : null
      ),
      buildManualMode(brief),
      buildFindingsTable()
    );
  }

  function render() {
    if (!canPropose) {
      fill(root, el('section', { className: 'prospecting' }, el('h2', { text: 'Prospecção' }), el('p', { className: 'muted', text: 'Seu perfil não pode usar o Workbench de Prospecção.' })));
      return;
    }
    const messageNode = state.message ? el('p', { className: `notice ${state.message.kind === 'error' ? 'bad' : 'ok'}`, role: 'note', text: state.message.text }) : null;
    fill(
      root,
      el(
        'section', { className: 'prospecting' },
        el('h2', { text: 'Prospecção' }),
        el('p', { className: 'muted', text: 'Crie um lote de pesquisa, gere o pacote para o Claude/Web e ingira o resultado — a aprovação continua sendo humana.' }),
        messageNode,
        buildForm(),
        el('h3', { text: 'Lotes recentes' }),
        state.status === 'loading' ? el('p', { className: 'muted', text: 'Carregando…' }) : buildRecent(),
        el('h3', { text: 'Lote selecionado' }),
        buildSelected()
      )
    );
  }

  return {
    load,
    render,
    destroy: () => {
      destroyed = true;
      stopJobPolling();
    },
  };
}
