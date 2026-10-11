// Tela NOVA PROSPECÇÃO — o Workbench operacional de prospecção, organizado em TRÊS ABAS (UX 4.0.5), no mesmo padrão da Approval Queue, de Leads Reprovados e do Histórico:
//
//   NOVA PESQUISA     — um assistente em 3 etapas (O que prospectar → Onde e quanto → Revisar e iniciar). Passar de etapa NUNCA cria nada: só "Salvar briefing" cria o
//                       briefing, e só "Iniciar pesquisa" (depois de uma confirmação explícita) cria o briefing se preciso, o marca como pronto e inicia o job.
//   BRIEFINGS SALVOS  — a lista (busca, situação, paginação, linha inteira clicável) e, ao clicar, a gaveta do briefing (#/prospeccao/briefing/<id>) com as ações de sempre.
//   EM ANDAMENTO      — as prospecções em andamento (etapas reais, indicadores, tempo), o último resultado, e a gaveta da execução (#/prospeccao/execucao/<id>).
//
//   Browser -> esta tela -> api.mjs -> HTTP /api/prospecting/briefs   -> Prospecting Brief Service   (criar o briefing; marcar pronto; concluir; cancelar)
//                                   -> HTTP /api/prospecting/jobs     -> Prospecting Job Service     (iniciar, acompanhar o status, cancelar, refazer)
//                                   -> HTTP /api/prospecting/batches  -> Prospecting Service         (modo manual: achados colados)
//
// CONTRATO (preservado): o BRIEFING é criado só pelos campos que o endpoint aceita — NUNCA leva `maxCandidates`; `maxCandidates` (o limite de candidatos EXAMINADOS, 1 a 100,
// outra coisa que a quantidade de LEADS NOVOS desejados) vai SÓ na chamada que inicia o job: { briefId, maxCandidates }. Iniciar uma prospecção NÃO aprova leads, NÃO promove nada
// ao CRM e NÃO inicia contato: os leads só chegam à Approval Queue, onde uma pessoa decide. Abrir, navegar, trocar de aba ou de etapa nunca inicia pesquisa. DNC, exclusões
// permanentes e deduplicação valem no servidor.
//
// A tela é PERSISTENTE na sessão: o rascunho do assistente (todos os campos e a etapa), a aba, a lista e as gavetas sobrevivem a trocar de aba e de módulo. O acompanhamento
// (consulta de status, intervalo moderado) só roda para uma prospecção realmente em andamento, com a tela à vista; para ao terminar, falhar ou sair da tela.
//
// PERMISSÕES: PROPOSE:LEAD_APPROVAL (`canProposeLead`) para tudo nesta tela — a mesma que já autoriza o Prospecting Service. O servidor decide de verdade; isto só mostra/esconde
// controles. SEGURANÇA: dados de um achado são NÃO CONFIÁVEIS (pesquisa web) — tudo entra no DOM por dom.mjs (textContent).

import { h, fill } from '../dom.mjs';
import { textOf, formatDateTime, formatLocation, formatLocations } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { createUi, createPoller, createRoutedDrawer, createTabs, statusBadge, emptyState, skeleton, pageHeader, kvList, formField, searchField, selectField, pagination } from '../ui/index.mjs';
import { createJobDetails, findById, isActive, STEP_LABELS, JOB_STATUS_LABELS, JOB_TONES, JOB_ERROR_TEXT, jobIndicators, briefPlace, num } from './jobDetails.mjs';

const GEO_LEVELS = Object.freeze([
  { value: 'CIDADE', label: 'Cidade' },
  { value: 'ESTADO', label: 'Estado' },
  { value: 'NACIONAL', label: 'Nacional' },
]);

const STATUS_LABELS = Object.freeze({
  RASCUNHO: 'Rascunho',
  PRONTO_PARA_PESQUISA: 'Pronto para pesquisa',
  PESQUISANDO: 'Pesquisando',
  AGUARDANDO_REVISAO: 'Aguardando revisão',
  CONCLUIDO: 'Concluído',
  CANCELADO: 'Cancelado',
});
const STATUS_TONES = Object.freeze({ RASCUNHO: 'neutral', PRONTO_PARA_PESQUISA: 'info', PESQUISANDO: 'warn', AGUARDANDO_REVISAO: 'warn', CONCLUIDO: 'ok', CANCELADO: 'bad' });

const RESULT_STATUS_LABELS = Object.freeze({
  DNC: 'Não contatar (DNC)',
  DUPLICADO: 'Duplicado',
  DADOS_INSUFICIENTES: 'Dados insuficientes',
  REPETIDO_NA_SUBMISSAO: 'Repetido nesta submissão',
});

// Os limites que o SERVIDOR já impõe ao briefing (src/research-prospector/prospectingBrief.js) e ao job: a tela só os repete para avisar ANTES de enviar.
export const BRIEF_LIMITS = Object.freeze({ NICHO: 120, SUBNICHO: 120, LOCAL: 120, PAIS: 60, OBSERVACOES: 2000, MAX_LOCAIS: 20, QUANTIDADE_MIN: 1, QUANTIDADE_MAX: 300 });
export const MAX_CANDIDATES_MIN = 1;
export const MAX_CANDIDATES_MAX = 100;
// Valores iniciais CONSERVADORES de um formulário NOVO (3 leads novos desejados, no máximo 10 candidatos examinados): nada é sobrescrito depois que a pessoa escolhe.
export const DEFAULT_QUANTIDADE = 3;
export const DEFAULT_MAX_CANDIDATES = 10;

const POLL_MS = 4000;
const MAX_POLL_FAILURES = 4;
const PAGE_SIZE = 10;
const GENERIC_ERROR = 'Não foi possível concluir a operação agora. Tente novamente.';

const TABS = Object.freeze([
  ['nova', 'Nova pesquisa'],
  ['briefings', 'Briefings salvos'],
  ['andamento', 'Em andamento'],
]);
const WIZARD_STEPS = Object.freeze([
  [1, 'O que prospectar'],
  [2, 'Onde e quanto'],
  [3, 'Revisar e iniciar'],
]);
export const STEP_FIELDS = Object.freeze({ 1: ['nicho', 'subnicho', 'observacoes'], 2: ['nivelGeografico', 'locais', 'pais', 'quantidade', 'maxCandidates'] });
const FIELD_ORDER = Object.freeze(['nicho', 'subnicho', 'observacoes', 'nivelGeografico', 'locais', 'pais', 'quantidade', 'maxCandidates']);
const JOB_STEPS = Object.freeze([
  ['DESCOBRINDO', 'Descoberta'],
  ['VALIDANDO', 'Validação'],
  ['INGERINDO', 'Envio à aprovação'],
]);
const STEP_ORDER = Object.freeze({ PREPARANDO: 0, DESCOBRINDO: 1, VALIDANDO: 2, INGERINDO: 3, FINALIZADO: 4 });
const FINISH_TITLES = Object.freeze({ CONCLUIDO: 'PROSPECÇÃO CONCLUÍDA', PARCIAL: 'PROSPECÇÃO PARCIAL', CANCELADO: 'PROSPECÇÃO CANCELADA', ERRO: 'A PROSPECÇÃO FALHOU' });
const START_NOTES = Object.freeze([
  'A pesquisa usa o Claude Code instalado neste computador e pode consumir o seu limite de uso.',
  'Iniciar uma prospecção não aprova leads, não promove nada ao CRM e não inicia nenhum contato: os leads encontrados só chegam à Approval Queue, onde uma pessoa decide.',
  'Só uma prospecção roda por vez. Você pode cancelá-la enquanto ela ainda não estiver enviando os leads para a aprovação.',
]);
const QUANTITY_EXPLANATION = 'Leads desejados são os NOVOS leads que você quer receber na Approval Queue. Candidatos examinados são as empresas que a pesquisa analisa para encontrá-los: o máximo limita esse esforço, e a pesquisa pode parar antes se a quantidade desejada for atingida.';

// ---------------------------------------------------------------------------
// Funções puras (exportadas para teste)
// ---------------------------------------------------------------------------

export const emptyForm = () => ({ nicho: '', subnicho: '', nivelGeografico: 'CIDADE', locais: '', pais: 'Brasil', quantidade: String(DEFAULT_QUANTIDADE), maxCandidates: String(DEFAULT_MAX_CANDIDATES), observacoes: '' });

// Separa "Petrópolis, Teresópolis" em itens (sem vazios nem repetidos), do mesmo jeito que o servidor.
export function splitLocais(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const value = part.trim();
    if (value === '' || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out;
}

const isWholeNumber = (value) => /^\d{1,9}$/.test(String(value).trim());

// A validação ANTES do envio. Devolve { ok, errors: { campo: mensagem }, fields, maxCandidates }. `fields` é EXATAMENTE o que o endpoint de briefing aceita (nunca
// `maxCandidates`); `maxCandidates` sai à parte, porque só vai ao iniciar o job. Nenhum limite é inventado: são os do servidor.
export function validateForm(form) {
  const errors = {};
  const nicho = String(form.nicho || '').trim();
  if (nicho === '') errors.nicho = 'Informe o nicho que será prospectado.';
  else if (nicho.length > BRIEF_LIMITS.NICHO) errors.nicho = `O nicho aceita até ${BRIEF_LIMITS.NICHO} caracteres.`;
  const subnicho = String(form.subnicho || '').trim();
  if (subnicho.length > BRIEF_LIMITS.SUBNICHO) errors.subnicho = `O subnicho aceita até ${BRIEF_LIMITS.SUBNICHO} caracteres.`;

  const nivel = form.nivelGeografico;
  if (!GEO_LEVELS.some((level) => level.value === nivel)) errors.nivelGeografico = 'Escolha a abrangência geográfica.';
  const locais = splitLocais(form.locais);
  if (nivel === 'CIDADE' || nivel === 'ESTADO') {
    const noun = nivel === 'CIDADE' ? 'uma cidade' : 'um estado';
    if (locais.length === 0) errors.locais = `Informe ao menos ${noun}.`;
    else if (locais.length > BRIEF_LIMITS.MAX_LOCAIS) errors.locais = `Informe no máximo ${BRIEF_LIMITS.MAX_LOCAIS} locais.`;
    else if (locais.some((local) => local.length > BRIEF_LIMITS.LOCAL)) errors.locais = `Cada local aceita até ${BRIEF_LIMITS.LOCAL} caracteres.`;
  }
  const pais = String(form.pais || '').trim();
  if (nivel === 'NACIONAL' && pais.length > BRIEF_LIMITS.PAIS) errors.pais = `O país aceita até ${BRIEF_LIMITS.PAIS} caracteres.`;

  const quantidade = Number(String(form.quantidade).trim());
  if (!isWholeNumber(form.quantidade) || quantidade < BRIEF_LIMITS.QUANTIDADE_MIN || quantidade > BRIEF_LIMITS.QUANTIDADE_MAX) errors.quantidade = `Informe um número inteiro de ${BRIEF_LIMITS.QUANTIDADE_MIN} a ${BRIEF_LIMITS.QUANTIDADE_MAX} leads.`;

  const maxCandidates = Number(String(form.maxCandidates).trim());
  if (!isWholeNumber(form.maxCandidates) || maxCandidates < MAX_CANDIDATES_MIN || maxCandidates > MAX_CANDIDATES_MAX) errors.maxCandidates = `Informe um número inteiro de ${MAX_CANDIDATES_MIN} a ${MAX_CANDIDATES_MAX} candidatos.`;

  const observacoes = String(form.observacoes || '').trim();
  if (observacoes.length > BRIEF_LIMITS.OBSERVACOES) errors.observacoes = `As observações aceitam até ${BRIEF_LIMITS.OBSERVACOES} caracteres.`;

  const fields = { nicho, nivelGeografico: nivel, quantidade };
  if (subnicho !== '') fields.subnicho = subnicho;
  if (observacoes !== '') fields.observacoes = observacoes;
  if (nivel === 'CIDADE') fields.cidades = String(form.locais).trim();
  else if (nivel === 'ESTADO') fields.estados = String(form.locais).trim();
  else fields.pais = pais || 'Brasil';
  return { ok: Object.keys(errors).length === 0, errors, fields, maxCandidates };
}

// A validação de UMA etapa do assistente (só os campos dela): é o que "Próximo" confere.
export function validateStep(form, step) {
  const all = validateForm(form).errors;
  const errors = {};
  for (const name of STEP_FIELDS[step] || []) if (all[name]) errors[name] = all[name];
  return { ok: Object.keys(errors).length === 0, errors };
}

// O máximo de candidatos de UM briefing já criado (o campo da tela de início): mesma regra do formulário.
export function validateMaxCandidates(value) {
  const number = Number(String(value).trim());
  return isWholeNumber(value) && number >= MAX_CANDIDATES_MIN && number <= MAX_CANDIDATES_MAX ? { ok: true, value: number } : { ok: false, message: `Informe um número inteiro de ${MAX_CANDIDATES_MIN} a ${MAX_CANDIDATES_MAX} candidatos.` };
}

export const isDirtyForm = (form) => JSON.stringify(form) !== JSON.stringify(emptyForm());

// A abrangência para a TELA: a caixa e o "Cidade/UF" são padronizados na exibição; o valor guardado no briefing nunca é alterado.
function geografiaTexto(brief) {
  if (brief.nivelGeografico === 'CIDADE') return `Cidade: ${formatLocations(brief.cidades)}`;
  if (brief.nivelGeografico === 'ESTADO') return `Estado: ${formatLocations(brief.estados)}`;
  return `Nacional: ${formatLocation(brief.pais) || 'Brasil'}`;
}

const fold = (value) => textOf(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Filtra os briefings salvos pela busca (código, nicho, subnicho, local, situação) e pela situação; os mais recentes primeiro.
export function visibleBriefs(briefs, { query = '', status = 'TODOS' } = {}) {
  const needle = fold(query);
  const matches = briefs.filter((brief) => (status === 'TODOS' || brief.status === status) && (needle === '' || fold([brief.id, brief.nicho, brief.subnicho, briefPlace(brief), ...(Array.isArray(brief.cidades) ? brief.cidades : []), ...(Array.isArray(brief.estados) ? brief.estados : []), STATUS_LABELS[brief.status] || brief.status].join(' ')).includes(needle)));
  return matches.sort((a, b) => textOf(b.criadoEm).localeCompare(textOf(a.criadoEm)) || textOf(b.id).localeCompare(textOf(a.id)));
}

function messageFor(error) {
  const status = error && typeof error.status === 'number' ? error.status : null;
  if (status === 403) return 'Sua conta não tem permissão para esta ação.';
  if (status === 404) return 'Não encontrado.';
  if (status === 409) return (error && error.serverMessage) || 'Esta ação não é permitida no estado atual.';
  if (status === 400) return (error && error.serverMessage) || 'Dados inválidos.';
  return GENERIC_ERROR;
}

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------

// document/root: onde desenhar. api: o cliente de api.mjs. permissions: { canProposeLead }. ui/bus/navigation: os da sessão (opcionais; sem eles a tela cria os seus).
// schedule(fn, ms) -> cancelar(): o agendador do acompanhamento (padrão: setTimeout; os testes passam o seu). pollMs: o intervalo da consulta de status.
export function createProspectingView({ document, root, api, permissions, schedule, ui: providedUi = null, bus = null, navigation = null, pageSize = PAGE_SIZE, pollMs = POLL_MS }) {
  const canPropose = Boolean(permissions && permissions.canProposeLead);
  const state = {
    status: 'idle', // idle | loading | ready | error (a lista de briefings)
    error: null,
    briefs: [],
    jobs: [], // as prospecções (a lista do servidor, mantida em dia pelo acompanhamento)
    tab: 'nova',
    userSwitched: false, // a pessoa já escolheu uma aba? (a abertura automática de "Em andamento" respeita isso)
    // o assistente
    form: emptyForm(),
    step: 1,
    errors: {},
    wizardBriefId: null, // o briefing já criado para o rascunho atual (uma nova tentativa não duplica)
    wizardSnapshot: null,
    // os briefings salvos
    query: '',
    statusFilter: 'TODOS',
    page: 1,
    // a gaveta do briefing
    selectedId: null,
    selected: null, // o brief carregado (getBrief)
    batch: null, // o lote real, quando selected.loteRealId existe
    startMax: {}, // brief id -> o texto do campo "Máximo de candidatos" da tela de início
    maxByBrief: {}, // brief id -> o máximo escolhido no assistente (o brief não o guarda: vai à API só quando a prospecção é iniciada)
    startError: null,
    manualOpen: false, // o "Modo manual" (fluxo antigo) está aberto?
    findingsText: '',
    // a gaveta da execução
    runTab: 'resumo',
    busy: false,
    message: null,
    loadedAt: null,
    visible: false,
    gaveUp: false, // o acompanhamento desistiu depois de falhas seguidas
  };
  let destroyed = false;
  let loadToken = 0;
  let selectToken = 0;
  const signatures = new Map();
  // execuções que a tela VIU em andamento nesta sessão (e as que a pessoa já fechou): só estas podem aparecer, terminadas, em "Em andamento"
  const seenActive = new Set();
  const dismissedRuns = new Set();

  // --- estrutura estável (montada UMA vez; as regiões abaixo é que mudam) ---
  const content = h(document, 'div', { className: 'approvals-view pros-view' });
  const ownsUi = providedUi === null;
  let ui = providedUi;
  if (ownsUi) {
    const host = h(document, 'div', { className: 'overlay-host' });
    root.replaceChildren(content, host);
    ui = createUi({ document, host, getInertTargets: () => [content], ...(schedule ? { schedule } : {}) });
  } else {
    root.replaceChildren(content);
  }
  const overlays = ui.overlays;
  const toasts = ui.toasts;
  const badge = (text, tone) => statusBadge(document, text, tone);
  const el = (tag, props, ...children) => h(document, tag, props, ...children);
  const jobById = (id) => state.jobs.find((job) => job.id === id) || null;
  const activeJobs = () => state.jobs.filter(isActive);
  // A execução que ACABOU DE TERMINAR nesta sessão (vista em andamento por esta tela e ainda não fechada) — nunca uma execução antiga do histórico.
  const finishedHere = () => state.jobs.filter((job) => !isActive(job) && seenActive.has(job.id) && !dismissedRuns.has(job.id)).sort((a, b) => textOf(b.startedAt || b.createdAt).localeCompare(textOf(a.startedAt || a.createdAt)))[0] || null;

  const messageRegion = el('div', { className: 'message-region' });
  const refreshButton = el('button', { type: 'button', className: 'btn secondary', text: 'Atualizar', onclick: () => refresh() });
  const briefsRegion = el('div', { className: 'list-region' });
  const briefsPager = el('div', { className: 'pager-region' });
  const briefsCounter = el('p', { className: 'pending-count toolbar-count' });
  const runRegion = el('div', { className: 'pros-job-region' });

  // ---- o assistente (os controles são criados UMA vez: o foco e o texto digitado nunca se perdem) ----
  const fieldOf = {};
  const bind = (name, event = 'input') => (node) => {
    node.addEventListener(event, () => {
      state.form[name] = String(node.value);
      onFormEdit(name);
    });
    return node;
  };
  const nichoInput = bind('nicho')(el('input', { id: 'pros-nicho', type: 'text', maxlength: String(BRIEF_LIMITS.NICHO), autocomplete: 'off', placeholder: 'Ex.: Clínicas de estética' }));
  const subnichoInput = bind('subnicho')(el('input', { id: 'pros-subnicho', type: 'text', maxlength: String(BRIEF_LIMITS.SUBNICHO), autocomplete: 'off', placeholder: 'Ex.: Harmonização facial' }));
  const nivelSelect = bind('nivelGeografico', 'change')(el('select', { id: 'pros-nivel' }, ...GEO_LEVELS.map((level) => el('option', { value: level.value, text: level.label }))));
  const locaisInput = bind('locais')(el('input', { id: 'pros-locais', type: 'text', autocomplete: 'off', placeholder: 'Ex.: Petrópolis, Teresópolis' }));
  const paisInput = bind('pais')(el('input', { id: 'pros-pais', type: 'text', maxlength: String(BRIEF_LIMITS.PAIS), autocomplete: 'off' }));
  const quantidadeInput = bind('quantidade')(el('input', { id: 'pros-quantidade', type: 'number', min: String(BRIEF_LIMITS.QUANTIDADE_MIN), max: String(BRIEF_LIMITS.QUANTIDADE_MAX), inputmode: 'numeric' }));
  const maxInput = bind('maxCandidates')(el('input', { id: 'pros-max-candidates', type: 'number', min: String(MAX_CANDIDATES_MIN), max: String(MAX_CANDIDATES_MAX), inputmode: 'numeric' }));
  const observacoesInput = bind('observacoes')(el('textarea', { id: 'pros-observacoes', rows: '3', maxlength: String(BRIEF_LIMITS.OBSERVACOES) }));
  const counterEl = el('p', { className: 'field-counter muted', 'aria-live': 'off' });

  fieldOf.nicho = formField(document, { id: 'pros-nicho', label: 'Nicho', control: nichoInput, required: true, help: 'O tipo de empresa que você quer encontrar.' });
  fieldOf.subnicho = formField(document, { id: 'pros-subnicho', label: 'Subnicho (opcional)', control: subnichoInput, help: 'Afina a busca dentro do nicho.' });
  fieldOf.nivelGeografico = formField(document, { id: 'pros-nivel', label: 'Abrangência geográfica', control: nivelSelect, required: true, help: 'Onde procurar: uma ou mais cidades, estados ou o país todo.' });
  fieldOf.locais = formField(document, { id: 'pros-locais', label: 'Cidade(s) — separadas por vírgula', control: locaisInput, required: true, help: 'Use vírgula para mais de um local.' });
  fieldOf.pais = formField(document, { id: 'pros-pais', label: 'País', control: paisInput, help: 'Se ficar em branco, vale Brasil.' });
  fieldOf.quantidade = formField(document, { id: 'pros-quantidade', label: `Quantidade de leads novos desejados (${BRIEF_LIMITS.QUANTIDADE_MIN}–${BRIEF_LIMITS.QUANTIDADE_MAX})`, control: quantidadeInput, required: true, help: 'Quantos NOVOS leads você quer receber na Approval Queue. Não é o número de candidatos examinados.' });
  fieldOf.maxCandidates = formField(document, { id: 'pros-max-candidates', label: `Máximo de candidatos examinados (${MAX_CANDIDATES_MIN}–${MAX_CANDIDATES_MAX})`, control: maxInput, required: true, help: 'Limite de empresas que a pesquisa poderá examinar. Pode terminar antes, quando a quantidade desejada for atingida.' });
  fieldOf.observacoes = formField(document, { id: 'pros-observacoes', label: 'Observações / objetivo (opcional)', control: observacoesInput, help: 'Contexto que ajuda a pesquisa (público, restrições, o que evitar).' });
  fieldOf.observacoes.element.append(counterEl);
  const locaisLabel = (() => {
    for (const child of fieldOf.locais.element.childNodes || []) if (child.nodeType === 1 && child.localName === 'label') return child;
    return fieldOf.locais.element;
  })();

  const summaryRegion = el('div', { className: 'wizard-summary', id: 'pros-summary' });
  const draftHint = el('p', { className: 'draft-hint', role: 'status', hidden: true, text: 'Você tem alterações que ainda não foram salvas. O rascunho é mantido se você trocar de aba ou de tela. Ao atualizar ou fechar a página, o navegador pode pedir confirmação.' });
  const prevButton = el('button', { type: 'button', className: 'btn secondary', id: 'pros-prev', text: 'Voltar', onclick: () => goBack() });
  const nextButton = el('button', { type: 'button', className: 'btn primary', id: 'pros-next', text: 'Próximo', onclick: () => goNext() });
  const saveButton = el('button', { type: 'button', className: 'btn secondary', id: 'pros-save', text: 'Salvar briefing', onclick: () => onSaveWizard() });
  const startWizardButton = el('button', { type: 'button', className: 'btn primary', id: 'pros-start-wizard', text: 'Iniciar pesquisa…', onclick: () => openWizardStart() });
  const clearButton = el('button', { type: 'button', className: 'btn secondary', id: 'pros-clear', text: 'Limpar formulário', onclick: () => askClear() });
  const stepper = el('ol', { className: 'wizard-steps', 'aria-label': 'Etapas da nova pesquisa' }, ...WIZARD_STEPS.map(([n, label]) => el('li', { className: 'wizard-step-item', 'data-wizard-step': String(n) }, el('span', { className: 'wizard-step-number', text: String(n) }), el('span', { className: 'wizard-step-label', text: label }))));
  const stepPanels = {
    1: el('fieldset', { className: 'form-section wizard-step', 'data-step': '1' }, el('legend', { text: 'Etapa 1 de 3 — O que prospectar' }), el('div', { className: 'form-grid' }, fieldOf.nicho.element, fieldOf.subnicho.element), fieldOf.observacoes.element),
    2: el('fieldset', { className: 'form-section wizard-step', 'data-step': '2' }, el('legend', { text: 'Etapa 2 de 3 — Onde e quanto' }), el('div', { className: 'form-grid' }, fieldOf.nivelGeografico.element, fieldOf.locais.element, fieldOf.pais.element), el('div', { className: 'form-grid' }, fieldOf.quantidade.element, fieldOf.maxCandidates.element)),
    3: el('fieldset', { className: 'form-section wizard-step', 'data-step': '3' }, el('legend', { text: 'Etapa 3 de 3 — Revisar e iniciar' }), summaryRegion, el('p', { className: 'wizard-explain', id: 'pros-explain', text: QUANTITY_EXPLANATION }), el('p', { className: 'notice warn', role: 'note', id: 'pros-consumption', text: START_NOTES[0] }), el('p', { className: 'muted', text: START_NOTES[1] })),
  };
  const form = el(
    'form',
    { className: 'pros-form', id: 'pros-form', novalidate: 'novalidate', 'aria-labelledby': 'pros-form-title', onsubmit: (event) => { event.preventDefault(); if (state.step < 3) goNext(); } },
    el('h3', { id: 'pros-form-title', className: 'form-title', text: 'Nova pesquisa' }),
    stepper,
    stepPanels[1],
    stepPanels[2],
    stepPanels[3],
    draftHint,
    el('div', { className: 'pros-form-actions' }, prevButton, nextButton, saveButton, startWizardButton, clearButton)
  );
  const novaRegion = el('div', { className: 'pros-wizard-card list-card' }, form);

  function currentSummaryRows() {
    const f = state.form;
    const locais = splitLocais(f.locais);
    const place = f.nivelGeografico === 'CIDADE' ? `Cidade: ${formatLocations(locais)}` : f.nivelGeografico === 'ESTADO' ? `Estado: ${formatLocations(locais)}` : `Nacional: ${formatLocation(f.pais) || 'Brasil'}`; // só a exibição: o que é enviado é o que foi digitado
    return [
      ['Nicho', el('span', { text: `${String(f.nicho).trim()}${String(f.subnicho).trim() ? ` / ${String(f.subnicho).trim()}` : ''}` })],
      ['Local', el('span', { text: place })],
      ['Leads novos desejados', el('span', { text: String(f.quantidade).trim() })],
      ['Máximo de candidatos examinados', el('span', { text: String(f.maxCandidates).trim() })],
      String(f.observacoes).trim() === '' ? null : ['Observações', el('span', { text: String(f.observacoes).trim() })],
    ].filter(Boolean);
  }

  function paintSummary() {
    fill(summaryRegion, kvList(document, currentSummaryRows(), { className: 'fields confirm-summary' }));
  }

  function setStep(n, { focus = false } = {}) {
    state.step = n;
    for (const [key, panel] of Object.entries(stepPanels)) panel.hidden = Number(key) !== n;
    for (const item of stepper.childNodes || []) {
      if (item.nodeType !== 1) continue;
      const k = Number(item.getAttribute('data-wizard-step'));
      item.className = `wizard-step-item ${k < n ? 'done' : k === n ? 'current' : 'pending'}`;
      if (k === n) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    }
    prevButton.hidden = n === 1;
    nextButton.hidden = n === 3;
    saveButton.hidden = n !== 3;
    startWizardButton.hidden = n !== 3;
    if (n === 3) paintSummary();
    syncFormView();
    if (focus) (n === 1 ? nichoInput : n === 2 ? nivelSelect : startWizardButton).focus();
  }

  // mostra/esconde os campos conforme a abrangência e mantém rótulos e contadores em dia (sem recriar nada)
  function syncFormView() {
    const nivel = state.form.nivelGeografico;
    fieldOf.locais.setHidden(nivel === 'NACIONAL');
    fieldOf.pais.setHidden(nivel !== 'NACIONAL');
    locaisLabel.textContent = nivel === 'ESTADO' ? 'Estado(s) — separados por vírgula' : 'Cidade(s) — separadas por vírgula';
    counterEl.textContent = `${String(state.form.observacoes).length}/${BRIEF_LIMITS.OBSERVACOES}`;
    draftHint.hidden = !isDirtyForm(state.form);
    clearButton.hidden = !isDirtyForm(state.form);
    updateBadges();
  }

  function writeControls() {
    nichoInput.value = state.form.nicho;
    subnichoInput.value = state.form.subnicho;
    nivelSelect.value = state.form.nivelGeografico;
    locaisInput.value = state.form.locais;
    paisInput.value = state.form.pais;
    quantidadeInput.value = state.form.quantidade;
    maxInput.value = state.form.maxCandidates;
    observacoesInput.value = state.form.observacoes;
    syncFormView();
  }

  function showErrors(errors) {
    state.errors = errors;
    for (const [name, handle] of Object.entries(fieldOf)) handle.setError(errors[name] || null);
  }

  // o erro some assim que o campo fica certo (depois de uma tentativa de avançar com erro)
  function onFormEdit(name) {
    syncFormView();
    if (Object.keys(state.errors).some((key) => state.errors[key])) {
      const fresh = validateForm(state.form).errors;
      const next = {};
      for (const key of Object.keys(state.errors)) if (state.errors[key] && fresh[key]) next[key] = fresh[key];
      showErrors(next);
    }
    if (state.step === 3) paintSummary();
  }

  function focusFirstError(errors) {
    const first = FIELD_ORDER.find((name) => errors[name]);
    if (first) fieldOf[first].control.focus();
    return first;
  }

  // "Próximo": confere SÓ os campos da etapa; passar de etapa nunca cria nada
  function goNext() {
    if (state.step >= 3 || state.busy) return;
    const result = validateStep(state.form, state.step);
    showErrors(result.errors);
    if (!result.ok) {
      focusFirstError(result.errors);
      toasts.warning('Revise os campos destacados antes de continuar.', { key: 'pros-form' });
      return;
    }
    setStep(state.step + 1, { focus: true });
  }

  function goBack() {
    if (state.step <= 1 || state.busy) return;
    setStep(state.step - 1, { focus: true });
  }

  // a validação completa (as etapas 1 e 2) antes de salvar ou iniciar; se algo falhar, a tela volta à etapa com o problema
  function validateAllOrJump() {
    const result = validateForm(state.form);
    showErrors(result.errors);
    if (result.ok) return result;
    setStep(FIELD_ORDER.slice(0, 3).some((name) => result.errors[name]) ? 1 : 2);
    focusFirstError(result.errors);
    toasts.warning('Revise os campos destacados antes de continuar.', { key: 'pros-form' });
    return null;
  }

  function resetWizard() {
    state.form = emptyForm();
    state.wizardBriefId = null;
    state.wizardSnapshot = null;
    showErrors({});
    writeControls();
    setStep(1);
  }

  // "Limpar formulário": com rascunho, pergunta antes de descartar
  function askClear() {
    if (!isDirtyForm(state.form)) return;
    overlays.openConfirm({
      key: 'pros-clear',
      title: 'Descartar o rascunho?',
      message: 'O que você digitou no formulário ainda não foi salvo e será perdido.',
      tone: 'danger',
      confirmLabel: 'Descartar rascunho',
      cancelLabel: 'Continuar editando',
      cancelFirst: true,
      onConfirm: async () => {
        resetWizard();
      },
      getReturnFocus: () => (clearButton.hidden ? nichoInput : clearButton),
    });
  }

  // cria o briefing do rascunho UMA vez: uma nova tentativa (depois de um erro mais adiante) reaproveita o que já foi criado, enquanto o rascunho não mudar
  async function ensureBrief(result) {
    const snapshot = JSON.stringify([result.fields, result.maxCandidates]);
    if (state.wizardBriefId && state.wizardSnapshot === snapshot) {
      const known = state.briefs.find((brief) => brief.id === state.wizardBriefId);
      if (known) return known;
    }
    // o briefing leva SÓ os campos que o endpoint aceita; o máximo de candidatos fica guardado aqui e só vai ao iniciar a prospecção
    const created = await api.createProspectingBrief(result.fields);
    const brief = created.item;
    state.wizardBriefId = brief.id;
    state.wizardSnapshot = snapshot;
    state.maxByBrief[brief.id] = result.maxCandidates;
    state.startMax[brief.id] = String(result.maxCandidates);
    state.briefs = [brief, ...state.briefs.filter((entry) => entry.id !== brief.id)];
    paintBriefs();
    return brief;
  }

  async function ensureReady(brief) {
    if (brief.status !== 'RASCUNHO') return;
    await api.markProspectingBriefReady(brief.id);
    brief.status = 'PRONTO_PARA_PESQUISA';
    state.briefs = state.briefs.map((entry) => (entry.id === brief.id ? { ...entry, status: 'PRONTO_PARA_PESQUISA' } : entry));
  }

  // "Salvar briefing": cria SÓ o briefing (nada é pesquisado) e leva à lista de salvos
  async function onSaveWizard() {
    if (state.busy || !canPropose) return;
    const result = validateAllOrJump();
    if (!result) return;
    state.busy = true;
    saveButton.disabled = true;
    saveButton.textContent = 'Salvando…';
    try {
      const brief = await ensureBrief(result);
      state.busy = false;
      saveButton.disabled = false;
      saveButton.textContent = 'Salvar briefing';
      resetWizard();
      toasts.success(`Briefing ${brief.id} salvo. Ele aparece em Briefings salvos; nada foi pesquisado.`, { key: 'pros-form' });
      switchTab('briefings');
      try {
        await loadBriefs();
      } catch {
        // o briefing JÁ foi criado: a lista se atualiza na próxima carga
      }
      return;
    } catch (error) {
      // o formulário NÃO é apagado: tudo o que foi digitado fica
      notify('error', messageFor(error));
    }
    state.busy = false;
    saveButton.disabled = false;
    saveButton.textContent = 'Salvar briefing';
  }

  // "Iniciar pesquisa…": a CONFIRMAÇÃO humana; só o clique nela cria o briefing (se preciso), marca como pronto e inicia o job
  function openWizardStart() {
    if (state.busy || !canPropose) return;
    const result = validateAllOrJump();
    if (!result) return;
    overlays.openConfirm({
      key: 'pros-wizard-start',
      title: 'Iniciar pesquisa',
      message: 'Confira antes de iniciar',
      body: kvList(document, currentSummaryRows(), { className: 'fields confirm-summary' }),
      detail: START_NOTES,
      confirmLabel: 'Iniciar pesquisa',
      busyLabel: 'Iniciando…',
      onConfirm: () => runWizardStart(result),
      getReturnFocus: () => startWizardButton,
    });
  }

  async function runWizardStart(result) {
    // busy: um segundo clique nunca inicia uma segunda prospecção
    if (state.busy) return;
    state.busy = true;
    let job;
    try {
      const brief = await ensureBrief(result);
      await ensureReady(brief);
      const data = await api.startProspectingJob(brief.id, result.maxCandidates); // `maxCandidates` vai SÓ aqui, nunca na criação do briefing
      job = data.item;
    } catch (error) {
      state.busy = false;
      throw new Error(messageFor(error)); // a confirmação mostra o erro e continua aberta; o que já foi criado não é duplicado na próxima tentativa
    }
    state.busy = false;
    state.gaveUp = false;
    state.jobs = [job, ...state.jobs.filter((entry) => entry.id !== job.id)];
    resetWizard();
    // o servidor confirmou: só agora há sucesso para mostrar
    notify('success', 'Prospecção iniciada. Acompanhe o andamento nesta aba; nenhum lead é aprovado ou enviado ao CRM por isso.');
    if (bus) bus.publish('prospecting:changed', { action: 'start', jobId: job.id });
    switchTab('andamento');
    paintRun();
    managePolling();
    try {
      await loadBriefs();
    } catch {
      // a lista se atualiza na próxima carga
    }
  }

  // ---- mensagens ---------------------------------------------------------------

  function setMessage(kind, text) {
    state.message = text ? { kind, text } : null;
    fill(messageRegion, state.message ? el('p', { className: `message ${state.message.kind}`, role: state.message.kind === 'error' ? 'alert' : 'status', text: state.message.text }) : null);
  }

  // Aviso + linha de status: o servidor já respondeu quando isto é chamado.
  function notify(kind, text) {
    setMessage(kind === 'success' ? 'ok' : kind, text);
    if (kind === 'error') toasts.error(text, { key: 'pros-feedback' });
    else if (kind === 'success') toasts.success(text, { key: 'pros-feedback' });
    else toasts.warning(text, { key: 'pros-feedback' });
  }

  // ---- as abas -------------------------------------------------------------------
  const briefSearch = searchField(document, {
    id: 'pros-brief-search',
    label: 'Buscar briefing',
    placeholder: 'Código, nicho, cidade…',
    onInput: (value) => {
      state.query = value;
      state.page = 1;
      paintBriefs();
    },
  });
  const briefStatus = selectField(document, {
    id: 'pros-brief-status',
    label: 'Situação',
    options: [{ value: 'TODOS', label: 'Todas as situações' }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))],
    value: state.statusFilter,
    onChange: (value) => {
      state.statusFilter = value;
      state.page = 1;
      paintBriefs();
    },
  });
  const briefsToolbar = el('div', { className: 'toolbar toolbar-stacked' }, el('div', { className: 'toolbar-row toolbar-tools' }, briefSearch.element, briefStatus.element, briefsCounter));
  const briefsPanel = el('div', { className: 'pros-briefs' }, briefsToolbar, el('div', { className: 'list-card' }, briefsRegion, briefsPager));
  const runPanel = el('div', { className: 'pros-run' }, runRegion);

  const tabs = createTabs(document, {
    idPrefix: 'pros',
    label: 'Seções da Nova Prospecção',
    tabs: TABS.map(([key, label]) => ({ key, label, content: key === 'nova' ? novaRegion : key === 'briefings' ? briefsPanel : runPanel })),
    active: 'nova',
    onChange: (key) => {
      state.tab = key;
      state.userSwitched = true;
    },
  });
  tabs.element.className = 'tabs tabs-main';

  function switchTab(key) {
    if (!canPropose) return;
    tabs.select(key, { notify: false });
    state.tab = key;
    updateBadges();
  }

  function updateBadges() {
    tabs.setBadge('nova', isDirtyForm(state.form) ? 'rascunho' : '');
    tabs.setBadge('briefings', state.briefs.length > 0 ? String(state.briefs.length) : '');
    tabs.setBadge('andamento', activeJobs().length > 0 ? String(activeJobs().length) : '');
  }

  // ---- carga ---------------------------------------------------------------

  async function loadBriefs() {
    const data = await api.listProspectingBriefs();
    state.briefs = Array.isArray(data && data.items) ? data.items : [];
    paintBriefs();
    updateBadges();
  }

  async function loadJobs() {
    const data = await api.listProspectingJobs();
    state.jobs = Array.isArray(data && data.items) ? data.items : [];
    paintRun();
    updateBadges();
  }

  async function load() {
    const token = ++loadToken;
    state.status = state.briefs.length > 0 ? 'ready' : 'loading';
    refreshButton.disabled = true;
    paintBriefs();
    try {
      const data = await api.listProspectingBriefs();
      if (token !== loadToken || destroyed) return;
      state.briefs = Array.isArray(data && data.items) ? data.items : [];
      state.status = 'ready';
      state.loadedAt = Date.now();
    } catch (error) {
      if (token !== loadToken || destroyed) return;
      state.status = state.briefs.length > 0 ? 'ready' : 'error';
      state.error = messageFor(error);
      if (state.briefs.length > 0) notify('error', state.error);
    }
    try {
      await loadJobs(); // só LEITURA: se há uma prospecção em andamento (depois de recarregar a página), a tela volta a acompanhá-la
    } catch {
      // a tela segue sem o acompanhamento; a pessoa pode abrir a aba
    }
    refreshButton.disabled = false;
    paintBriefs();
    updateBadges();
    if (!destroyed && !state.userSwitched && state.tab === 'nova' && !isDirtyForm(state.form) && activeJobs().length > 0) switchTab('andamento');
    managePolling();
  }

  // "Atualizar": relê a lista de briefings e de prospecções (e o briefing aberto) e retoma o acompanhamento.
  async function refresh() {
    setMessage(null);
    state.gaveUp = false;
    refreshButton.disabled = true;
    try {
      await loadBriefs();
      await loadJobs();
      if (state.selectedId && briefCtl.isOpen()) await selectBrief(state.selectedId, { keepMessage: true });
    } catch (error) {
      notify('error', messageFor(error));
    }
    refreshButton.disabled = false;
    syncRunDrawer();
    managePolling();
  }

  // O briefing aberto na gaveta: o detalhe (pacote, contagens, lote real) vem do servidor; a lista já tem o essencial.
  async function selectBrief(id, { keepMessage = false } = {}) {
    const token = ++selectToken;
    if (state.selectedId !== id) {
      state.selected = state.briefs.find((brief) => brief.id === id) || null;
      state.batch = null;
      state.startError = null;
    }
    state.selectedId = id;
    if (!keepMessage) setMessage(null);
    refreshBriefDrawer();
    try {
      const data = await api.getProspectingBrief(id);
      if (token !== selectToken || destroyed) return;
      state.selected = data.item;
      if (state.selected.loteRealId) {
        try {
          const lote = await api.getProspectingBatch(state.selected.loteRealId);
          if (token !== selectToken || destroyed) return;
          state.batch = lote.item;
        } catch {
          state.batch = null; // o lote pode não estar acessível — a tela não trava por isso
        }
      } else {
        state.batch = null;
      }
    } catch (error) {
      if (token !== selectToken || destroyed) return;
      notify('error', messageFor(error));
    }
    refreshBriefDrawer();
    paintBriefs();
  }

  // ---- o acompanhamento (só para uma prospecção realmente em andamento) ----------------
  const poller = createPoller({
    tick: async () => {
      const active = activeJobs();
      if (active.length === 0) return state.jobs; // nada em andamento: nada a consultar
      let finished = null;
      for (const current of active) {
        const data = await api.getProspectingJobStatus(current.id);
        state.jobs = [data.item, ...state.jobs.filter((entry) => entry.id !== data.item.id)];
        if (!isActive(data.item)) finished = data.item;
      }
      state.gaveUp = false;
      paintRun();
      syncRunDrawer();
      updateBadges();
      if (finished) await onJobFinished(finished);
      return state.jobs;
    },
    shouldContinue: (jobs) => state.visible && !destroyed && jobs.some(isActive),
    intervalMs: pollMs,
    maxFailures: MAX_POLL_FAILURES,
    isHidden: () => Boolean(document.hidden),
    onGiveUp: () => {
      state.gaveUp = true;
      notify('error', 'Perdi o acompanhamento da prospecção. Use "Atualizar" para ver o resultado.');
      paintRun();
    },
    ...(schedule ? { schedule } : {}),
  });

  function managePolling() {
    if (destroyed || !state.visible || activeJobs().length === 0 || state.gaveUp) {
      poller.stop();
      return;
    }
    poller.start();
  }

  // terminou: o aviso diz o que de fato aconteceu; o briefing e a lista se atualizam
  async function onJobFinished(job) {
    if (bus) bus.publish('prospecting:changed', { action: 'finish', jobId: job.id });
    const queued = jobIndicators(job).naFila;
    if (job.status === 'CONCLUIDO') toasts.success(`Prospecção concluída${queued !== null ? `: ${queued} lead(s) chegaram à Approval Queue` : ''}.`, { key: 'pros-feedback' });
    else if (job.status === 'PARCIAL') toasts.warning(`Prospecção parcial: a quantidade pedida não foi atingida${queued !== null ? ` (${queued} lead(s) na Approval Queue)` : ''}.`, { key: 'pros-feedback' });
    else if (job.status === 'CANCELADO') toasts.warning('Prospecção cancelada.', { key: 'pros-feedback' });
    else if (job.status === 'ERRO') toasts.error('A prospecção falhou. Veja os detalhes da execução.', { key: 'pros-feedback' });
    try {
      await loadBriefs();
      if (state.selectedId && briefCtl.isOpen()) await selectBrief(state.selectedId, { keepMessage: true });
    } catch {
      // a lista se atualiza na próxima carga
    }
    paintRun();
    updateBadges();
  }

  async function onCancelJob(job) {
    if (state.busy) return;
    state.busy = true;
    setMessage(null);
    paintRun();
    try {
      const data = await api.cancelProspectingJob(job.id);
      state.jobs = [data.item, ...state.jobs.filter((entry) => entry.id !== data.item.id)];
      notify('success', 'Cancelamento solicitado. A prospecção para na próxima etapa segura.');
      managePolling();
    } catch (error) {
      notify('error', messageFor(error));
    }
    state.busy = false;
    paintRun();
  }

  // ---- iniciar a partir de um briefing salvo (SEMPRE por confirmação humana) ------------------------------------

  function startSummary(brief, max) {
    return kvList(document, [
      ['Nicho', el('span', { text: `${textOf(brief.nicho)}${brief.subnicho ? ` / ${textOf(brief.subnicho)}` : ''}` })],
      ['Local', el('span', { text: briefPlace(brief) || geografiaTexto(brief) })],
      ['Leads novos desejados', el('span', { text: String(brief.quantidade) })],
      ['Máximo de candidatos examinados', el('span', { text: String(max) })],
    ], { className: 'fields confirm-summary' });
  }

  function onStartClick() {
    const brief = state.selected;
    if (!brief || state.busy || !canPropose || brief.status !== 'PRONTO_PARA_PESQUISA') return;
    const check = validateMaxCandidates(state.startMax[brief.id] !== undefined ? state.startMax[brief.id] : String(state.maxByBrief[brief.id] ?? DEFAULT_MAX_CANDIDATES));
    if (!check.ok) {
      state.startError = check.message;
      refreshBriefDrawer();
      const field = briefCtl.handle ? findById(briefCtl.handle.element, 'pros-start-max') : null;
      if (field) field.focus();
      toasts.warning('Revise o máximo de candidatos antes de iniciar.', { key: 'pros-feedback' });
      return;
    }
    state.startError = null;
    state.maxByBrief[brief.id] = check.value;
    overlays.openConfirm({
      key: `pros-start:${brief.id}`,
      title: 'Iniciar prospecção',
      message: `Briefing ${brief.id}`,
      body: startSummary(brief, check.value),
      detail: START_NOTES,
      confirmLabel: 'Iniciar prospecção',
      busyLabel: 'Iniciando…',
      onConfirm: () => startJob(brief, check.value),
      getReturnFocus: () => (briefCtl.handle && briefCtl.handle.element.parentNode ? findById(briefCtl.handle.element, 'pros-start-job') : null) || findById(runRegion, 'pros-job-details'),
    });
  }

  async function startJob(brief, max) {
    // busy: um segundo clique (ou um botão antigo ainda na tela) nunca inicia uma segunda prospecção.
    if (state.busy) return;
    state.busy = true;
    let created;
    try {
      created = await api.startProspectingJob(brief.id, max); // `maxCandidates` vai SÓ aqui, nunca na criação do briefing
    } catch (error) {
      state.busy = false;
      throw new Error(messageFor(error)); // a confirmação mostra o erro e continua aberta
    }
    state.busy = false;
    state.gaveUp = false;
    state.jobs = [created.item, ...state.jobs.filter((entry) => entry.id !== created.item.id)];
    // o servidor confirmou: só agora há sucesso para mostrar
    notify('success', 'Prospecção iniciada. Acompanhe o andamento nesta aba; nenhum lead é aprovado ou enviado ao CRM por isso.');
    if (bus) bus.publish('prospecting:changed', { action: 'start', jobId: created.item.id });
    briefCtl.close({ silent: false, reason: 'started' });
    switchTab('andamento');
    paintRun();
    managePolling();
  }

  // REFAZER PROSPECÇÃO: um job NOVO com o mesmo briefing (o anterior e o seu histórico ficam intactos), só depois da confirmação.
  function openRedo(job) {
    if (!job || state.busy || isActive(job) || !canPropose) return;
    overlays.openConfirm({
      key: `pros-redo:${job.id}`,
      title: 'Refazer prospecção',
      message: `Prospecção: ${textOf(job.id)}`,
      detail: ['Isto cria e INICIA uma prospecção nova com o mesmo briefing. Ela usa a pesquisa na web e o Claude Code deste computador, pode consumir o seu limite de uso e pode levar alguns minutos.', 'Não aprova leads, não promove ao CRM e não inicia contato. O histórico atual é preservado: nada é apagado.'],
      confirmLabel: 'Refazer prospecção',
      busyLabel: 'Iniciando…',
      onConfirm: () => redo(job),
      getReturnFocus: () => findById(runRegion, 'pros-redo-job') || (runCtl.handle ? findById(runCtl.handle.element, 'pros-drawer-redo') : null),
    });
  }

  async function redo(job) {
    if (state.busy) return;
    state.busy = true;
    let created;
    try {
      created = await api.redoProspectingJob(job.id);
    } catch (error) {
      state.busy = false;
      throw new Error(messageFor(error));
    }
    state.busy = false;
    state.gaveUp = false;
    state.jobs = [created.item, ...state.jobs.filter((entry) => entry.id !== created.item.id)];
    runCtl.close({ silent: false, reason: 'redo' });
    notify('success', 'Nova prospecção iniciada com o mesmo briefing. Acompanhe o andamento abaixo.');
    if (bus) bus.publish('prospecting:changed', { action: 'redo', jobId: created.item.id });
    switchTab('andamento');
    paintRun();
    managePolling();
    try {
      await loadBriefs();
    } catch {
      // a lista se atualiza na próxima carga
    }
  }

  // ---- ações do briefing (as de sempre; cancelar pede confirmação) ---------------------

  async function runAction(fn) {
    if (state.busy) return;
    state.busy = true;
    setMessage(null);
    refreshBriefDrawer();
    try {
      await fn();
      if (state.selectedId) await selectBrief(state.selectedId, { keepMessage: true });
      await loadBriefs();
    } catch (error) {
      notify('error', messageFor(error));
    }
    state.busy = false;
    refreshBriefDrawer();
  }

  function askCancelBrief(brief) {
    overlays.openConfirm({
      key: `pros-cancel-brief:${brief.id}`,
      title: 'Cancelar briefing',
      message: `Briefing ${brief.id}`,
      detail: 'O briefing passa a Cancelado e não poderá ser usado para uma nova pesquisa. O que já foi entregue à Approval Queue continua lá.',
      tone: 'danger',
      confirmLabel: 'Cancelar briefing',
      cancelLabel: 'Voltar',
      cancelFirst: true,
      onConfirm: async () => {
        try {
          await api.cancelProspectingBrief(brief.id);
        } catch (error) {
          throw new Error(messageFor(error));
        }
        toasts.success('Briefing cancelado.', { key: 'pros-feedback' });
        await selectBrief(brief.id);
        await loadBriefs();
      },
    });
  }

  function onIngest() {
    let parsed;
    try {
      parsed = JSON.parse(state.findingsText);
    } catch {
      notify('error', 'O texto colado não é um JSON válido.');
      return;
    }
    const rawFindings = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.rawFindings) ? parsed.rawFindings : null;
    if (rawFindings === null) {
      notify('error', 'Cole uma lista de achados (ou um objeto { rawFindings: [...] }).');
      return;
    }
    runAction(async () => {
      await api.ingestProspectingFindings(state.selectedId, rawFindings);
      state.findingsText = '';
    });
  }

  // ---- as gavetas (o ciclo de vida, com URL, vem do controlador compartilhado) -----------------------------

  const rowButtonOf = (id) => {
    const stack = [briefsRegion];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.childNodes || []) {
        if (child.nodeType !== 1) continue;
        if (child.localName === 'button' && child.getAttribute('data-item') === id) return child;
        stack.push(child);
      }
    }
    return null;
  };

  // a gaveta do BRIEFING
  const briefCtl = createRoutedDrawer({
    document,
    navigation,
    hashFor: (id) => buildHash({ name: 'prospecting-brief', id }),
    listHash: buildHash({ name: 'prospecting' }),
    rowButton: rowButtonOf,
    repaint: () => paintBriefs(),
    onClosed: () => {
      state.startError = null;
    },
    build: (id, hooks) => {
      const brief = state.selected && state.selected.id === id ? state.selected : state.briefs.find((entry) => entry.id === id) || null;
      if (!brief) return null;
      if (state.selectedId !== id) {
        state.selectedId = id;
        state.selected = brief;
        state.batch = null;
      }
      return overlays.openDrawer({
        key: `pros-brief:${id}`,
        title: textOf(brief.id),
        subtitle: [textOf(brief.nicho), briefPlace(brief)].filter(Boolean).join(' · '),
        content: briefDrawerBody(brief),
        getReturnFocus: hooks.getReturnFocus,
        onClose: hooks.onClose,
      });
    },
  });

  function refreshBriefDrawer() {
    const handle = briefCtl.handle;
    const brief = state.selected && briefCtl.state.selectedId === state.selected.id ? state.selected : null;
    if (!handle || !brief) return;
    handle.setContent(briefDrawerBody(brief));
  }

  // a gaveta da EXECUÇÃO: as quatro abas vêm do detalhe compartilhado (./jobDetails.mjs)
  const jobDetails = createJobDetails({
    document,
    getBrief: (job) => state.briefs.find((brief) => brief.id === job.briefId) || (state.selected && state.selected.id === job.briefId ? state.selected : null),
    liveNote: 'Esta tela se atualiza sozinha enquanto a prospecção roda.',
    onFilterChange: (selectId) => {
      refreshRunDrawer();
      const again = runCtl.handle ? findById(runCtl.handle.element, selectId) : null;
      if (again) again.focus();
    },
  });

  const runButtonOf = (id) => (jobById(id) ? findById(runRegion, 'pros-job-details') : null);

  const runCtl = createRoutedDrawer({
    document,
    navigation,
    hashFor: (id) => buildHash({ name: 'prospecting-run', id }),
    listHash: buildHash({ name: 'prospecting' }),
    rowButton: runButtonOf,
    repaint: () => paintRun(),
    onClosed: (id) => {
      if (id !== null) signatures.delete(id);
    },
    build: (id, hooks) => {
      const job = jobById(id);
      if (!job) return null;
      signatures.set(id, JSON.stringify(job));
      const brief = state.briefs.find((entry) => entry.id === job.briefId) || null;
      return overlays.openDrawer({
        key: `pros-run:${id}`,
        title: textOf(job.id) || 'Prospecção',
        subtitle: [textOf(brief && brief.nicho), briefPlace(brief)].filter(Boolean).join(' · ') || `Iniciada em ${formatDateTime(job.startedAt || job.createdAt) || '—'}`,
        content: runDrawerBody(job),
        footer: runDrawerFooter(job),
        getReturnFocus: hooks.getReturnFocus,
        onClose: hooks.onClose,
      });
    },
  });

  function runDrawerBody(job) {
    return jobDetails.build(job, { tab: state.runTab, onTab: (key) => { state.runTab = key; } }).element;
  }

  function runDrawerFooter(job) {
    const history = el('a', { className: 'btn secondary', href: buildHash({ name: 'prospecting-job', id: job.id }), text: 'Ver no Histórico' });
    if (isActive(job)) return el('div', { className: 'drawer-actions' }, history, el('p', { className: 'muted note', text: 'Os números se atualizam sozinhos enquanto a prospecção roda.' }));
    if (!canPropose) return el('div', { className: 'drawer-actions' }, history);
    return el('div', { className: 'drawer-actions' }, el('button', { type: 'button', className: 'btn primary', id: 'pros-drawer-redo', text: 'Refazer prospecção', disabled: state.busy, onclick: () => openRedo(jobById(runCtl.state.selectedId)) }), history);
  }

  function refreshRunDrawer() {
    const handle = runCtl.handle;
    const job = runCtl.state.selectedId ? jobById(runCtl.state.selectedId) : null;
    if (!handle || !job) return;
    handle.setContent(runDrawerBody(job));
    handle.setFooter(runDrawerFooter(job));
  }

  // o job mudou (consulta de status): a gaveta só é reconstruída se algo mudou (a aba e o foco ficam)
  function syncRunDrawer() {
    if (!runCtl.isOpen()) return;
    const id = runCtl.state.selectedId;
    const job = jobById(id);
    if (!job) {
      toasts.warning('Esta prospecção não está mais na lista. Abra-a de novo pelo Histórico.', { key: 'pros-feedback' });
      runCtl.dismiss('gone');
      return;
    }
    const signature = JSON.stringify(job);
    if (signatures.get(id) === signature) return;
    signatures.set(id, signature);
    refreshRunDrawer();
  }

  // ---- desenho: BRIEFINGS SALVOS ----------------------------------------------------------

  function briefRow(brief) {
    const selected = brief.id === briefCtl.state.selectedId;
    return el(
      'tr',
      { className: selected ? 'queue-row selected' : 'queue-row', 'data-brief': brief.id, onclick: () => openBrief(brief.id) },
      el('td', { 'data-label': 'Código' }, el('button', { type: 'button', className: 'company-name job-code', 'data-item': brief.id, text: textOf(brief.id), 'aria-current': selected ? 'true' : null })),
      el('td', { 'data-label': 'Nicho' }, el('div', { className: 'company-cell' }, el('span', { className: 'brief-nicho', text: textOf(brief.nicho) || '—' }), brief.subnicho ? el('span', { className: 'company-meta', text: textOf(brief.subnicho) }) : null)),
      el('td', { 'data-label': 'Localização', text: briefPlace(brief) || '—' }),
      el('td', { 'data-label': 'Leads desejados', className: 'num', text: num(Number.isInteger(brief.quantidade) ? brief.quantidade : null) }),
      el('td', { 'data-label': 'Situação' }, badge(STATUS_LABELS[brief.status] || textOf(brief.status), STATUS_TONES[brief.status] || 'neutral')),
      el('td', { 'data-label': 'Criado em', text: formatDateTime(brief.criadoEm) || '—' })
    );
  }

  function paintBriefs() {
    const total = state.briefs.length;
    const shown = visibleBriefs(state.briefs, { query: state.query, status: state.statusFilter });
    const narrowed = state.query.trim() !== '' || state.statusFilter !== 'TODOS';
    briefsCounter.textContent = narrowed && shown.length !== total ? `${total} ${total === 1 ? 'briefing' : 'briefings'} · ${shown.length} no filtro` : `${total} ${total === 1 ? 'briefing' : 'briefings'}`;
    if (state.status === 'loading' && total === 0) {
      fill(briefsRegion, skeleton(document, { rows: 4, label: 'Carregando os briefings…' }));
      fill(briefsPager);
      return;
    }
    if (state.status === 'error' && total === 0) {
      fill(briefsRegion, el('p', { className: 'message error', role: 'alert', text: state.error }));
      fill(briefsPager);
      return;
    }
    if (total === 0) {
      fill(briefsRegion, el('div', { id: 'pros-recent-empty' }, emptyState(document, { title: 'Nenhum briefing salvo ainda', text: 'Crie o primeiro na aba Nova pesquisa. Nada é pesquisado até você confirmar.', action: el('button', { type: 'button', className: 'btn secondary', text: 'Nova pesquisa', onclick: () => switchTab('nova') }) })));
      fill(briefsPager);
      return;
    }
    if (shown.length === 0) {
      fill(briefsRegion, emptyState(document, { title: 'Nenhum briefing encontrado', text: 'Nada na lista combina com a busca ou com a situação escolhida. Ajuste ou limpe os filtros.' }));
      fill(briefsPager);
      return;
    }
    const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
    state.page = Math.min(Math.max(1, state.page), pageCount);
    const slice = shown.slice((state.page - 1) * pageSize, state.page * pageSize);
    const heads = [['Código', ''], ['Nicho', ''], ['Localização', ''], ['Leads desejados', 'num'], ['Situação', ''], ['Criado em', '']];
    const head = el('tr', {}, ...heads.map(([title, cls]) => el('th', { scope: 'col', className: cls, text: title })));
    fill(briefsRegion, el('div', { className: 'table-wrap' }, el('table', { className: 'list queue briefs-table', id: 'pros-recent' }, el('caption', { className: 'visually-hidden', text: 'Briefings salvos' }), el('thead', {}, head), el('tbody', {}, ...slice.map(briefRow)))));
    fill(briefsPager, pagination(document, { page: state.page, pageCount, total: shown.length, pageSize, onPage: (next) => { state.page = next; paintBriefs(); } }));
  }

  // abre a gaveta do briefing (o endereço muda) e carrega o detalhe — só LEITURA: abrir um briefing nunca inicia nada
  function openBrief(id) {
    briefCtl.open(id);
    if (briefCtl.isOpen()) selectBrief(id);
  }

  function actionButton(text, onclick, extraClass = 'secondary') {
    return el('button', { type: 'button', className: `btn ${extraClass}`, disabled: state.busy, onclick, text });
  }

  // o conteúdo da gaveta do briefing: os dados, as ações, o início da pesquisa e o modo manual
  function briefDrawerBody(brief) {
    const contagens = brief.contagens || {};
    const facts = kvList(document, [
      ['Nicho', el('span', { text: `${textOf(brief.nicho)}${brief.subnicho ? ` / ${textOf(brief.subnicho)}` : ''}` })],
      ['Abrangência', el('span', { text: geografiaTexto(brief) })],
      ['Leads novos desejados', el('span', { text: String(brief.quantidade) })],
      ['Observações', textOf(brief.observacoes) === '' ? null : el('span', { text: textOf(brief.observacoes) })],
      ['Criado em', formatDateTime(brief.criadoEm) ? el('span', { text: formatDateTime(brief.criadoEm) }) : null],
      brief.contagens ? ['Encontrados / válidos', el('span', { text: `${num(contagens.encontrados ?? null)} / ${num(contagens.validos ?? contagens.suficientes ?? null)}${brief.excluidosPermanentemente ? ` (${brief.excluidosPermanentemente} excluídos permanentemente)` : ''}` })] : null,
    ].filter(Boolean));
    const actions = [
      brief.status === 'RASCUNHO' && canPropose ? actionButton('Marcar pronto para pesquisa', () => runAction(() => api.markProspectingBriefReady(brief.id)), 'primary') : null,
      brief.status === 'AGUARDANDO_REVISAO' && canPropose ? actionButton('Marcar concluído', () => runAction(() => api.concludeProspectingBrief(brief.id)), 'secondary') : null,
      !['CONCLUIDO', 'CANCELADO'].includes(brief.status) && canPropose ? actionButton('Cancelar briefing', () => askCancelBrief(brief), 'danger') : null,
    ].filter(Boolean);
    const related = state.jobs.find((job) => job.briefId === brief.id) || null;
    const active = Boolean(related) && isActive(related);
    const startable = brief.status === 'PRONTO_PARA_PESQUISA' && canPropose && !active;
    return el(
      'div',
      { className: 'pros-brief-drawer' },
      el('div', { className: 'pros-brief-head' }, el('h3', { text: textOf(brief.id) }), badge(STATUS_LABELS[brief.status] || textOf(brief.status), STATUS_TONES[brief.status] || 'neutral')),
      facts,
      actions.length > 0 ? el('div', { className: 'actions' }, ...actions) : null,
      startable ? startCard(brief) : null,
      related ? el('p', { className: 'muted' }, active ? 'Há uma prospecção em andamento para este briefing: ' : 'Este briefing já teve uma prospecção: ', el('a', { href: buildHash({ name: 'prospecting-run', id: related.id }), text: 'ver a execução' }), '.') : null,
      brief.status === 'PESQUISANDO' && !active ? el('p', { className: 'notice warn', role: 'note', id: 'pros-stale-note', text: 'Este briefing consta como "Pesquisando", mas não há nenhuma prospecção em andamento registrada para ele. O status do briefing não é uma execução.' }) : null,
      manualBlock(brief),
      findingsTable()
    );
  }

  function startCard(brief) {
    const maxText = state.startMax[brief.id] !== undefined ? state.startMax[brief.id] : String(state.maxByBrief[brief.id] ?? DEFAULT_MAX_CANDIDATES);
    const maxControl = el('input', { id: 'pros-start-max', type: 'number', min: String(MAX_CANDIDATES_MIN), max: String(MAX_CANDIDATES_MAX), inputmode: 'numeric', value: maxText });
    const maxField = formField(document, { id: 'pros-start-max', label: `Máximo de candidatos examinados (${MAX_CANDIDATES_MIN}–${MAX_CANDIDATES_MAX})`, control: maxControl, required: true, help: 'Limite de empresas que a pesquisa poderá examinar. A quantidade de leads desejados é a do briefing.' });
    maxControl.addEventListener('input', () => {
      state.startMax[brief.id] = String(maxControl.value);
      if (state.startError) {
        state.startError = validateMaxCandidates(maxControl.value).ok ? null : state.startError;
        maxField.setError(state.startError);
      }
    });
    maxField.setError(state.startError);
    return el(
      'div',
      { className: 'pros-start-card', id: 'pros-auto-start' },
      el('h3', { text: 'Iniciar a pesquisa' }),
      el('p', { className: 'muted', text: 'A prospecção automática procura empresas na web, confere a página de cada uma e envia só as comprovadas para a Approval Queue. Você confirma antes de começar; nada é aprovado nem enviado ao CRM.' }),
      maxField.element,
      el('div', { className: 'actions' }, el('button', { type: 'button', className: 'btn primary', id: 'pros-start-job', disabled: state.busy, onclick: onStartClick, text: 'Iniciar prospecção…' }))
    );
  }

  // ---- o "Modo manual" (o fluxo ANTIGO): recolhido e só quando não há prospecção automática para o briefing ----------

  function resultRow(entry) {
    const podeDecidir = entry.naFila && entry.estadoFila === 'AGUARDANDO_REVISAO';
    const statusTexto = entry.motivo ? RESULT_STATUS_LABELS[entry.motivo] || entry.motivo : entry.estadoFila || entry.estadoOperacional;
    return el(
      'tr',
      {},
      el('td', { text: entry.empresa || '—' }),
      el('td', { text: statusTexto || '—' }),
      el('td', {}, ...(podeDecidir
        ? [actionButton('Aprovar', () => runAction(() => api.approve(entry.prospectId)), 'secondary'), actionButton('Rejeitar', () => runAction(() => api.reject(entry.prospectId, 'rejeitado pelo Workbench de Prospecção')), 'danger')]
        : [el('span', { className: 'muted', text: 'sem ação (já decidido pelo sistema)' })]))
    );
  }

  function findingsTable() {
    if (!state.batch || !state.selected || !canPropose) return null;
    const resultados = Array.isArray(state.batch.resultados) ? state.batch.resultados : [];
    return el('div', {}, el('h4', { text: `Achados do lote (${resultados.length})` }), el('table', { className: 'crm-table' }, el('thead', {}, el('tr', {}, el('th', { text: 'Empresa' }), el('th', { text: 'Status' }), el('th', { text: 'Ações' }))), el('tbody', {}, ...resultados.map(resultRow))));
  }

  function packageBlock(brief) {
    if (!brief.pacotePesquisa) return null;
    return el('div', { className: 'field' }, el('label', { text: 'Pacote de pesquisa (copie e cole numa conversa com o Claude/Web)' }), el('textarea', { rows: '10', readonly: 'readonly', text: JSON.stringify(brief.pacotePesquisa, null, 2) }));
  }

  function ingestBlock() {
    const area = el('textarea', { id: 'pros-findings', rows: '8' });
    area.value = state.findingsText;
    area.addEventListener('input', () => { state.findingsText = String(area.value); });
    return el('div', { className: 'field' }, el('label', { for: 'pros-findings', text: 'Cole aqui o resultado da pesquisa (JSON: uma lista de achados)' }), area, actionButton('Ingerir achados', onIngest, 'primary'));
  }

  function manualBlock(brief) {
    if (!canPropose) return null;
    // havendo uma prospecção (ativa ou terminada) para o briefing, a tela mostra só o fluxo automático: nenhum pacote JSON, nenhum "copiar", nenhuma ingestão manual
    const hasJob = state.jobs.some((job) => job.briefId === brief.id);
    const canGenerate = brief.status === 'PRONTO_PARA_PESQUISA' || brief.status === 'PESQUISANDO';
    if (hasJob || (!canGenerate && !brief.pacotePesquisa)) return null;
    return el(
      'div',
      { className: 'manual-mode', id: 'pros-manual' },
      el('button', { type: 'button', className: 'link', id: 'pros-manual-toggle', onclick: () => { state.manualOpen = !state.manualOpen; refreshBriefDrawer(); }, text: state.manualOpen ? 'Ocultar modo manual' : 'Modo manual' }),
      ...(state.manualOpen
        ? [
            el('p', { className: 'muted', text: 'Fluxo antigo: gere um pacote de pesquisa, leve-o ao Claude/Web e cole o resultado de volta.' }),
            canGenerate ? actionButton('Gerar pacote de pesquisa', () => runAction(() => api.generateProspectingPackage(brief.id)), 'secondary') : null,
            packageBlock(brief),
            brief.status === 'PESQUISANDO' ? ingestBlock() : null,
          ]
        : [])
    );
  }

  // ---- desenho: EM ANDAMENTO ----------------------------------------------------------------

  // "Em andamento" mostra SÓ execuções realmente ativas (o status do JOB no servidor). O status de um briefing — inclusive "Pesquisando" — nunca prova que há execução.
  function paintRun() {
    const active = activeJobs();
    for (const job of active) seenActive.add(job.id);
    const last = active.length === 0 ? finishedHere() : null;
    const nodes = [];
    if (active.length > 0) {
      for (const job of active) nodes.push(execCard(job, true));
    } else {
      const actions = el('div', { className: 'actions' }, canPropose ? el('button', { type: 'button', className: 'btn secondary', text: 'Nova pesquisa', onclick: () => switchTab('nova') }) : null, el('a', { className: 'btn secondary', href: buildHash({ name: 'prospecting-history' }), text: 'Ver o Histórico de prospecções' }));
      nodes.push(el('div', { id: 'pros-run-empty' }, emptyState(document, { title: 'Nenhuma prospecção em andamento', text: 'Quando você iniciar uma pesquisa, o andamento aparece aqui. Nada é pesquisado sem a sua confirmação. Prospecções anteriores ficam no Histórico.', action: actions })));
      if (last) {
        nodes.push(
          el('div', { className: 'run-last-head' }, el('h3', { className: 'form-title run-last-title', text: 'Execução finalizada nesta sessão' }), el('button', { type: 'button', className: 'btn secondary', id: 'pros-run-dismiss', text: 'Fechar resultado', onclick: () => { dismissedRuns.add(last.id); paintRun(); } })),
          execCard(last, false)
        );
      }
    }
    fill(runRegion, ...nodes);
  }

  function indicatorTile(label, value, hint) {
    return el('div', { className: 'indicator indicator-number' }, el('span', { className: 'indicator-label', text: label }), el('span', { className: 'indicator-value', text: num(value) }), el('span', { className: 'indicator-hint muted', text: hint }));
  }

  function clock(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  function jobStepper(job, active) {
    const finishedOk = job.status === 'CONCLUIDO' || job.status === 'PARCIAL';
    if (!active && !finishedOk) return null; // erro ou cancelamento: o servidor não diz até onde chegou com certeza — nada é afirmado
    const at = STEP_ORDER[job.currentStep] ?? 0;
    return el(
      'ol',
      { className: 'stepper', 'aria-label': 'Etapas da prospecção' },
      ...JOB_STEPS.map(([key, label]) => {
        const order = STEP_ORDER[key];
        const done = finishedOk || at > order;
        const current = !finishedOk && at === order;
        const stateText = done ? 'concluída' : current ? 'em andamento' : 'aguardando';
        return el('li', { className: `step ${done ? 'done' : current ? 'current' : 'pending'}`, 'aria-current': current ? 'step' : null, 'data-step': key }, el('span', { className: 'step-label', text: label }), el('span', { className: 'step-state muted', text: stateText }));
      })
    );
  }

  function execCard(job, active) {
    const ind = jobIndicators(job);
    const tele = job.telemetria && typeof job.telemetria === 'object' ? job.telemetria : {};
    const brief = state.briefs.find((entry) => entry.id === job.briefId) || null;
    const nodes = [];
    const title = FINISH_TITLES[job.status];
    nodes.push(el('div', { className: 'exec-head' }, el('h3', { text: 'Prospecção automática' }), badge(JOB_STATUS_LABELS[job.status] || textOf(job.status), JOB_TONES[job.status] || 'neutral'), el('span', { className: 'muted exec-id', text: textOf(job.id) })));
    if (brief) nodes.push(el('p', { className: 'muted exec-brief', text: [textOf(brief.nicho), briefPlace(brief)].filter(Boolean).join(' · ') }));
    if (title) nodes.push(el('h4', { className: 'job-title', text: title }));
    if (active) nodes.push(el('p', { className: 'exec-step', text: STEP_LABELS[job.currentStep] || 'Em andamento' }));
    const steps = jobStepper(job, active);
    if (steps) nodes.push(steps);
    nodes.push(
      el(
        'div',
        { className: 'indicator-grid' },
        indicatorTile('Encontrados', ind.encontrados, 'candidatos trazidos pela descoberta'),
        indicatorTile('Validados', ind.validados, 'comprovados pela página'),
        indicatorTile('Entregues à fila', ind.naFila, ind.solicitados === null ? 'na Approval Queue' : `de ${ind.solicitados} solicitados`),
        indicatorTile('Retidos fora da fila', ind.retidos, 'dados insuficientes, DNC ou duplicado'),
        indicatorTile('Não validados', ind.naoValidados, 'a página não comprovou')
      )
    );
    const meta = [`Tempo decorrido: ${clock(job.elapsedMs)}`];
    if (typeof tele.custoUsd === 'number' && tele.custoUsd > 0) meta.push(`Custo informado pelo motor: US$ ${tele.custoUsd.toFixed(2)}`);
    if (Number.isInteger(tele.reposicoesRealizadas) && tele.reposicoesRealizadas > 0) meta.push(`Reposições realizadas: ${tele.reposicoesRealizadas}`);
    nodes.push(el('p', { className: 'muted exec-meta', id: 'pros-job-meta', text: meta.join(' · ') }));
    if (job.status === 'ERRO') nodes.push(el('p', { className: 'notice bad', role: 'note', text: JOB_ERROR_TEXT[job.error && job.error.code] || JOB_ERROR_TEXT.JOB_INTERNAL }));
    if (state.gaveUp && active) nodes.push(el('p', { className: 'notice bad', role: 'note', text: 'O acompanhamento automático parou depois de falhas seguidas. Use "Atualizar" para tentar de novo.' }));
    if (!active) nodes.push(...resultText(job, ind));
    nodes.push(execActions(job, active, ind));
    return el('div', { className: 'exec-card', id: 'pros-auto' }, ...nodes);
  }

  // o que a prospecção entregou, em palavras: o lead só existe quando CHEGOU à Approval Queue; validado pela pesquisa não é o mesmo que entregue
  function resultText(job, ind) {
    if (job.status !== 'CONCLUIDO' && job.status !== 'PARCIAL') return [];
    const lote = job.lote && typeof job.lote === 'object' ? job.lote : {};
    const naFila = Number.isInteger(lote.naFila) ? lote.naFila : ind.naFila || 0;
    const foraDaFila = Number.isInteger(lote.foraDaFila) ? lote.foraDaFila : 0;
    const validated = Number(job.candidatesValidated) || 0;
    const out = [el('p', { text: naFila > 0 ? `${naFila} de ${job.requestedQuantity} lead(s) solicitado(s) chegaram à Approval Queue.` : validated > 0 ? 'Nenhum lead chegou à Approval Queue.' : 'Nenhuma empresa pôde ser comprovada pela página; nada foi enviado para a aprovação.' })];
    if (foraDaFila > 0) out.push(el('p', { className: 'muted', text: `${validated} empresa(s) comprovada(s) pela pesquisa, mas ${foraDaFila} não foi(ram) entregue(s) à fila (dados insuficientes, DNC ou duplicado).` }));
    if (job.status === 'PARCIAL' && validated > 0) out.push(el('p', { className: 'muted', text: 'A quantidade pedida não foi atingida: nenhuma empresa fraca foi incluída para completar.' }));
    return out;
  }

  function execActions(job, active, ind) {
    const buttons = [];
    buttons.push(el('button', { type: 'button', className: 'btn secondary', id: 'pros-job-details', 'data-item': job.id, text: 'Ver detalhes da execução', onclick: () => runCtl.open(job.id) }));
    if (active && job.currentStep !== 'INGERINDO' && canPropose) buttons.push(el('button', { type: 'button', className: 'btn danger', id: 'pros-cancel-job', disabled: state.busy || job.status === 'CANCELAMENTO_SOLICITADO', onclick: () => onCancelJob(job), text: 'Cancelar prospecção' }));
    if (!active && canPropose) buttons.push(el('button', { type: 'button', className: 'btn secondary', id: 'pros-redo-job', disabled: state.busy, onclick: () => openRedo(job), text: 'Refazer prospecção' }));
    if (!active && ind.naFila !== null && ind.naFila > 0 && (job.status === 'CONCLUIDO' || job.status === 'PARCIAL')) buttons.push(el('a', { className: 'btn secondary', id: 'pros-open-approvals', href: buildHash({ name: 'approvals' }), text: 'Abrir a Approval Queue' }));
    buttons.push(el('a', { className: 'btn secondary', href: buildHash({ name: 'prospecting-job', id: job.id }), text: 'Ver no Histórico' }));
    return el('div', { className: 'actions exec-actions' }, ...buttons);
  }

  // ---- a página ----------------------------------------------------------------

  if (!canPropose) {
    content.append(el('section', { className: 'prospecting', id: 'prospecting' }, pageHeader(document, { title: 'Nova Prospecção' }), el('p', { className: 'muted', text: 'Seu perfil não pode usar o Workbench de Prospecção.' })));
  } else {
    content.append(
      el(
        'section',
        { className: 'prospecting', id: 'prospecting', 'aria-labelledby': 'pros-title' },
        pageHeader(document, { title: 'Nova Prospecção', titleId: 'pros-title', subtitle: 'Crie uma pesquisa em três etapas, consulte os briefings salvos e acompanhe o que está em andamento. Iniciar uma prospecção não aprova leads, não promove ao CRM e não inicia contatos: a aprovação continua sendo humana.', actions: [refreshButton] }),
        messageRegion,
        tabs.element
      )
    );
  }
  writeControls();
  setStep(1);
  paintBriefs();
  paintRun();
  updateBadges();

  // Atualizar ou fechar a aba COM rascunho não salvo: pede ao navegador o aviso nativo (ele decide se e como mostra). Sem alteração, nada é pedido e nada é bloqueado.
  const releaseLeaveGuard = navigation && typeof navigation.setLeaveGuard === 'function' ? navigation.setLeaveGuard(() => canPropose && !destroyed && isDirtyForm(state.form)) : null;

  // ---- roteamento (chamado pelo shell a cada mudança de #) ------------------------------------

  async function show(route) {
    if (destroyed) return;
    const entering = !state.visible;
    state.visible = true;
    if (!canPropose) return;
    const name = route && route.name;
    if (name === 'prospecting-brief') {
      switchTab('briefings');
      runCtl.listRoute();
      briefCtl.setRoute(route.id);
      if (briefCtl.isOpen() && briefCtl.state.selectedId === route.id) return;
      if (state.loadedAt === null) await load();
      else if (entering) await refreshQuiet();
      if (destroyed || briefCtl.state.routeId !== route.id) return;
      if (!state.briefs.some((brief) => brief.id === route.id)) {
        notify('warning', 'Este briefing não foi encontrado em Briefings salvos.');
        briefCtl.setRoute(null);
        if (navigation) navigation.replace(buildHash({ name: 'prospecting' }));
        return;
      }
      briefCtl.openFromRoute(route.id);
      selectBrief(route.id);
      return;
    }
    if (name === 'prospecting-run') {
      switchTab('andamento');
      briefCtl.listRoute();
      runCtl.setRoute(route.id);
      if (runCtl.isOpen() && runCtl.state.selectedId === route.id) return;
      if (state.loadedAt === null) await load();
      else if (entering) await refreshQuiet();
      if (destroyed || runCtl.state.routeId !== route.id) return;
      if (!jobById(route.id)) {
        notify('warning', 'Esta prospecção não foi encontrada. Procure-a no Histórico.');
        runCtl.setRoute(null);
        if (navigation) navigation.replace(buildHash({ name: 'prospecting' }));
        return;
      }
      runCtl.openFromRoute(route.id);
      managePolling();
      return;
    }
    briefCtl.listRoute();
    runCtl.listRoute();
    if (state.loadedAt === null) await load();
    else if (entering) await refreshQuiet();
    managePolling();
  }

  // voltar ao módulo: atualiza em silêncio (as listas) sem apagar nada
  async function refreshQuiet() {
    try {
      await loadBriefs();
      await loadJobs();
      if (state.selectedId && briefCtl.isOpen()) await selectBrief(state.selectedId, { keepMessage: true });
    } catch {
      // a tela segue com o que já tinha
    }
    syncRunDrawer();
    managePolling();
  }

  // O módulo saiu de cena: as camadas fecham e o acompanhamento PARA; o rascunho, a aba, os briefings e a página ficam guardados.
  function hide() {
    state.visible = false;
    briefCtl.leave(overlays);
    runCtl.leave(overlays);
    poller.stop();
  }

  return {
    load,
    render: () => {
      paintBriefs();
      paintRun();
    },
    state,
    show,
    hide,
    refresh,
    switchTab,
    openBrief,
    openJob: (id) => runCtl.open(id),
    closeBrief: () => briefCtl.close({ silent: false, reason: 'api' }),
    closeJob: () => runCtl.close({ silent: false, reason: 'api' }),
    destroy() {
      destroyed = true;
      if (releaseLeaveGuard) releaseLeaveGuard();
      poller.stop();
      briefCtl.close({ silent: true, reason: 'destroy' });
      runCtl.close({ silent: true, reason: 'destroy' });
      if (ownsUi) ui.destroy();
    },
  };
}
