// Tela NOVA PROSPECÇÃO — o Workbench operacional de prospecção. Quarta tela da UX 4.0, no mesmo padrão da Approval Queue, de Leads Reprovados e do Histórico.
//
//   Browser -> esta tela -> api.mjs -> HTTP /api/prospecting/briefs   -> Prospecting Brief Service   (criar o briefing; marcar pronto; concluir; cancelar)
//                                   -> HTTP /api/prospecting/jobs     -> Prospecting Job Service     (iniciar, acompanhar o status, cancelar, refazer)
//                                   -> HTTP /api/prospecting/batches  -> Prospecting Service         (modo manual: achados colados)
//
// FLUXO: (1) o BRIEFING (nicho, abrangência, quantidade de LEADS NOVOS desejados, observações) é criado pelos campos que o endpoint aceita — NUNCA leva `maxCandidates`;
// (2) com o briefing PRONTO, "Iniciar prospecção" abre uma CONFIRMAÇÃO que resume o que será feito e avisa que a pesquisa usa o Claude Code local e pode consumir o
// limite de uso; só depois do clique de confirmação o job é criado — `maxCandidates` (o limite de candidatos EXAMINADOS, 1 a 100, outra coisa que a quantidade de leads)
// vai SÓ nessa chamada; (3) a tela acompanha o job (etapas reais, sem percentual inventado) e, ao terminar, mostra o resultado e abre o detalhe numa gaveta.
//
// Iniciar uma prospecção NÃO aprova leads, NÃO promove nada ao CRM e NÃO inicia contato: os leads só chegam à Approval Queue, onde uma pessoa decide. Nada começa
// sozinho: abrir ou navegar por esta tela nunca inicia pesquisa — só o clique de confirmação. O DNC, as exclusões permanentes e a deduplicação valem no servidor.
//
// A tela é PERSISTENTE na sessão: o rascunho do formulário, o briefing selecionado e a gaveta (com URL #/prospeccao/execucao/<id>) sobrevivem a trocar de módulo.
// O acompanhamento (consulta de status, intervalo moderado) só roda para um job realmente em andamento, com a tela à vista; para ao terminar, falhar ou sair da tela.
//
// PERMISSÕES: PROPOSE:LEAD_APPROVAL (`canProposeLead`) para tudo nesta tela — a mesma que já autoriza o Prospecting Service. O servidor decide de verdade; isto só
// mostra/esconde controles. SEGURANÇA: dados de um achado são NÃO CONFIÁVEIS (pesquisa web) — tudo entra no DOM por dom.mjs (textContent).

import { h, fill } from '../dom.mjs';
import { textOf, formatDateTime } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { createUi, createPoller, createRoutedDrawer, statusBadge, emptyState, skeleton, pageHeader, kvList, section, formField, pagination } from '../ui/index.mjs';
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
export const DEFAULT_MAX_CANDIDATES = 50;
export const DEFAULT_QUANTIDADE = 50;

const POLL_MS = 4000;
const MAX_POLL_FAILURES = 4;
const PAGE_SIZE = 8;
const GENERIC_ERROR = 'Não foi possível concluir a operação agora. Tente novamente.';

const STEPS = Object.freeze([
  ['DESCOBRINDO', 'Descoberta'],
  ['VALIDANDO', 'Validação'],
  ['INGERINDO', 'Envio à aprovação'],
]);
const STEP_ORDER = Object.freeze({ PREPARANDO: 0, DESCOBRINDO: 1, VALIDANDO: 2, INGERINDO: 3, FINALIZADO: 4 });
const FINISH_TITLES = Object.freeze({ CONCLUIDO: 'PROSPECÇÃO CONCLUÍDA', PARCIAL: 'PROSPECÇÃO PARCIAL', CANCELADO: 'PROSPECÇÃO CANCELADA', ERRO: 'A PROSPECÇÃO FALHOU' });

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

// O máximo de candidatos de UM briefing já criado (o campo da tela de início): mesma regra do formulário.
export function validateMaxCandidates(value) {
  const number = Number(String(value).trim());
  return isWholeNumber(value) && number >= MAX_CANDIDATES_MIN && number <= MAX_CANDIDATES_MAX ? { ok: true, value: number } : { ok: false, message: `Informe um número inteiro de ${MAX_CANDIDATES_MIN} a ${MAX_CANDIDATES_MAX} candidatos.` };
}

export const isDirtyForm = (form) => JSON.stringify(form) !== JSON.stringify(emptyForm());

function geografiaTexto(brief) {
  if (brief.nivelGeografico === 'CIDADE') return `Cidade: ${(brief.cidades || []).join(', ')}`;
  if (brief.nivelGeografico === 'ESTADO') return `Estado: ${(brief.estados || []).join(', ')}`;
  return `Nacional: ${brief.pais || 'Brasil'}`;
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
    status: 'idle', // idle | loading | ready | error
    error: null,
    briefs: [],
    page: 1,
    selectedId: null,
    selected: null, // o brief carregado (getBrief)
    batch: null, // o lote real, quando selected.loteRealId existe
    form: emptyForm(),
    submitted: false, // já tentou enviar? (depois disso a validação acompanha a digitação)
    errors: {},
    findingsText: '',
    busy: false,
    message: null,
    job: null, // o job de prospecção automática do brief selecionado (o mais recente)
    manualOpen: false, // o "Modo manual" (fluxo antigo) está aberto?
    maxByBrief: {}, // brief id -> o MÁXIMO DE CANDIDATOS escolhido (o brief não o guarda: vai à API só quando a prospecção é iniciada)
    startMax: {}, // brief id -> o texto do campo "Máximo de candidatos" da tela de início
    startError: null,
    tab: 'resumo',
    loadedAt: null,
    visible: false,
    gaveUp: false, // o acompanhamento desistiu depois de falhas seguidas
  };
  let destroyed = false;
  let loadToken = 0;
  let selectToken = 0;
  const signatures = new Map();

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

  const messageRegion = el('div', { className: 'message-region' });
  const recentRegion = el('div', { className: 'list-region' });
  const recentPager = el('div', { className: 'pager-region' });
  const briefRegion = el('div', { className: 'pros-brief-region' });
  const jobRegion = el('div', { className: 'pros-job-region' });
  const manualRegion = el('div', { className: 'pros-manual-region' });
  const refreshButton = el('button', { type: 'button', className: 'btn secondary', text: 'Atualizar', onclick: () => refresh() });

  // ---- o formulário (os controles são criados UMA vez: o foco e o texto digitado nunca se perdem) ----
  const controls = {};
  const fieldOf = {};
  function control(tag, name, props = {}, ...children) {
    const node = el(tag, { id: `pros-${name}`, ...props }, ...children);
    controls[name] = node;
    return node;
  }
  const bind = (name, event = 'input') => (node) => {
    node.addEventListener(event, () => {
      state.form[name] = String(node.value);
      onFormEdit(name);
    });
    return node;
  };
  const nichoInput = bind('nicho')(control('input', 'nicho', { type: 'text', maxlength: String(BRIEF_LIMITS.NICHO), autocomplete: 'off', placeholder: 'Ex.: Clínicas de estética' }));
  const subnichoInput = bind('subnicho')(control('input', 'subnicho', { type: 'text', maxlength: String(BRIEF_LIMITS.SUBNICHO), autocomplete: 'off', placeholder: 'Ex.: Harmonização facial' }));
  const nivelSelect = bind('nivelGeografico', 'change')(control('select', 'nivel', {}, ...GEO_LEVELS.map((level) => el('option', { value: level.value, text: level.label }))));
  const locaisInput = bind('locais')(control('input', 'locais', { type: 'text', autocomplete: 'off', placeholder: 'Ex.: Petrópolis, Teresópolis' }));
  const paisInput = bind('pais')(control('input', 'pais', { type: 'text', maxlength: String(BRIEF_LIMITS.PAIS), autocomplete: 'off' }));
  const quantidadeInput = bind('quantidade')(control('input', 'quantidade', { type: 'number', min: String(BRIEF_LIMITS.QUANTIDADE_MIN), max: String(BRIEF_LIMITS.QUANTIDADE_MAX), inputmode: 'numeric' }));
  const maxInput = bind('maxCandidates')(control('input', 'max-candidates', { type: 'number', min: String(MAX_CANDIDATES_MIN), max: String(MAX_CANDIDATES_MAX), inputmode: 'numeric' }));
  const observacoesInput = bind('observacoes')(control('textarea', 'observacoes', { rows: '3', maxlength: String(BRIEF_LIMITS.OBSERVACOES) }));
  const counterEl = el('p', { className: 'field-counter muted', 'aria-live': 'off' });

  fieldOf.nicho = formField(document, { id: 'pros-nicho', label: 'Nicho', control: nichoInput, required: true, help: 'O tipo de empresa que você quer encontrar.' });
  fieldOf.subnicho = formField(document, { id: 'pros-subnicho', label: 'Subnicho (opcional)', control: subnichoInput, help: 'Afina a busca dentro do nicho.' });
  fieldOf.nivelGeografico = formField(document, { id: 'pros-nivel', label: 'Abrangência geográfica', control: nivelSelect, required: true, help: 'Onde procurar: uma ou mais cidades, estados ou o país todo.' });
  fieldOf.locais = formField(document, { id: 'pros-locais', label: 'Cidade(s) — separadas por vírgula', control: locaisInput, required: true, help: 'Use vírgula para mais de um local.' });
  fieldOf.pais = formField(document, { id: 'pros-pais', label: 'País', control: paisInput, help: 'Se ficar em branco, vale Brasil.' });
  fieldOf.quantidade = formField(document, { id: 'pros-quantidade', label: `Quantidade de leads novos desejados (${BRIEF_LIMITS.QUANTIDADE_MIN}–${BRIEF_LIMITS.QUANTIDADE_MAX})`, control: quantidadeInput, required: true, help: 'Quantos NOVOS leads você quer receber na Approval Queue. Não é o número de candidatos examinados.' });
  fieldOf.maxCandidates = formField(document, { id: 'pros-max-candidates', label: `Máximo de candidatos examinados (${MAX_CANDIDATES_MIN}–${MAX_CANDIDATES_MAX})`, control: maxInput, required: true, help: 'Limite de empresas que a pesquisa poderá examinar. Pode terminar antes, quando a quantidade desejada for atingida.' });
  // o texto de ajuda do máximo tem id próprio, usado pelos testes e leitores de tela (o campo de ajuda do formField já cobre aria-describedby)
  fieldOf.observacoes = formField(document, { id: 'pros-observacoes', label: 'Observações / objetivo (opcional)', control: observacoesInput, help: 'Contexto que ajuda a pesquisa (público, restrições, o que evitar).' });
  fieldOf.observacoes.element.append(counterEl);

  const draftHint = el('p', { className: 'draft-hint', role: 'status', hidden: true, text: 'Você tem alterações que ainda não foram criadas. O rascunho é mantido se você trocar de tela.' });
  const submitButton = el('button', { type: 'submit', className: 'btn primary', id: 'pros-create', text: 'Criar briefing' });
  const clearButton = el('button', { type: 'button', className: 'btn secondary', id: 'pros-clear', text: 'Limpar formulário', onclick: () => askClear() });
  const form = el(
    'form',
    { className: 'pros-form', id: 'pros-form', novalidate: 'novalidate', 'aria-labelledby': 'pros-form-title', onsubmit: (event) => { event.preventDefault(); onCreateSubmit(); } },
    el('h3', { id: 'pros-form-title', className: 'form-title', text: 'Novo briefing' }),
    el('fieldset', { className: 'form-section' }, el('legend', { text: 'O que prospectar' }), el('div', { className: 'form-grid' }, fieldOf.nicho.element, fieldOf.subnicho.element)),
    el('fieldset', { className: 'form-section' }, el('legend', { text: 'Onde' }), el('div', { className: 'form-grid' }, fieldOf.nivelGeografico.element, fieldOf.locais.element, fieldOf.pais.element)),
    el('fieldset', { className: 'form-section' }, el('legend', { text: 'Quantidades' }), el('div', { className: 'form-grid' }, fieldOf.quantidade.element, fieldOf.maxCandidates.element)),
    el('fieldset', { className: 'form-section' }, el('legend', { text: 'Informações adicionais' }), fieldOf.observacoes.element),
    draftHint,
    el('div', { className: 'pros-form-actions' }, submitButton, clearButton)
  );

  // mostra/esconde os campos conforme a abrangência e mantém rótulos e contadores em dia (sem recriar nada)
  function syncFormView() {
    const nivel = state.form.nivelGeografico;
    fieldOf.locais.setHidden(nivel === 'NACIONAL');
    fieldOf.pais.setHidden(nivel !== 'NACIONAL');
    locaisLabel.textContent = nivel === 'ESTADO' ? 'Estado(s) — separados por vírgula' : 'Cidade(s) — separadas por vírgula';
    counterEl.textContent = `${String(state.form.observacoes).length}/${BRIEF_LIMITS.OBSERVACOES}`;
    draftHint.hidden = !isDirtyForm(state.form);
  }
  const locaisLabel = findLabel(fieldOf.locais.element);
  function findLabel(container) {
    for (const child of container.childNodes || []) if (child.nodeType === 1 && child.localName === 'label') return child;
    return container;
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

  // depois da primeira tentativa de envio, a validação acompanha a digitação (o erro some assim que o campo fica certo)
  function onFormEdit(name) {
    if (name === 'nivelGeografico') showErrors({ ...state.errors, locais: undefined, pais: undefined });
    syncFormView();
    if (state.submitted) showErrors(validateForm(state.form).errors);
  }

  async function onCreateSubmit() {
    if (state.busy) return;
    if (!canPropose) return;
    state.submitted = true;
    const result = validateForm(state.form);
    showErrors(result.errors);
    if (!result.ok) {
      const first = ['nicho', 'subnicho', 'nivelGeografico', 'locais', 'pais', 'quantidade', 'maxCandidates', 'observacoes'].find((name) => result.errors[name]);
      if (first) fieldOf[first].control.focus();
      toasts.warning('Revise os campos destacados antes de criar o briefing.', { key: 'pros-form' });
      return;
    }
    state.busy = true;
    setMessage(null);
    submitButton.disabled = true;
    submitButton.textContent = 'Criando…';
    try {
      // o briefing leva SÓ os campos que o endpoint aceita; o máximo de candidatos fica guardado aqui e só vai ao iniciar a prospecção
      const created = await api.createProspectingBrief(result.fields);
      const id = created.item.id;
      state.maxByBrief[id] = result.maxCandidates;
      state.startMax[id] = String(result.maxCandidates);
      state.form = emptyForm();
      state.submitted = false;
      showErrors({});
      writeControls();
      toasts.success(`Briefing ${id} criado. Revise e inicie a pesquisa quando quiser.`, { key: 'pros-form' });
      state.busy = false;
      submitButton.disabled = false;
      submitButton.textContent = 'Criar briefing';
      try {
        await loadBriefs();
      } catch {
        // o briefing JÁ foi criado: a lista se atualiza na próxima carga
      }
      await selectBrief(id);
      return;
    } catch (error) {
      // o formulário NÃO é apagado: tudo o que foi digitado fica
      notify('error', messageFor(error));
    }
    state.busy = false;
    submitButton.disabled = false;
    submitButton.textContent = 'Criar briefing';
  }

  // "Limpar formulário": com rascunho, pergunta antes de descartar
  function askClear() {
    if (!isDirtyForm(state.form)) return;
    overlays.openConfirm({
      key: 'pros-clear',
      title: 'Descartar o rascunho?',
      message: 'O que você digitou no formulário ainda não foi criado e será perdido.',
      tone: 'danger',
      confirmLabel: 'Descartar rascunho',
      cancelLabel: 'Continuar editando',
      cancelFirst: true,
      onConfirm: async () => {
        state.form = emptyForm();
        state.submitted = false;
        showErrors({});
        writeControls();
      },
      getReturnFocus: () => clearButton,
    });
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

  // ---- carga ---------------------------------------------------------------

  async function loadBriefs() {
    const data = await api.listProspectingBriefs();
    state.briefs = Array.isArray(data && data.items) ? data.items : [];
    paintRecent();
  }

  async function load() {
    const token = ++loadToken;
    state.status = state.briefs.length > 0 ? 'ready' : 'loading';
    refreshButton.disabled = true;
    paintRecent();
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
    refreshButton.disabled = false;
    paintRecent();
    await resumeActiveJob();
  }

  // Depois de um refresh da página: se há uma prospecção em andamento, seleciona o brief dela e volta a acompanhar (só LEITURA; nada é iniciado).
  async function resumeActiveJob() {
    if (state.selectedId || state.job || destroyed) return;
    try {
      const data = await api.listProspectingJobs();
      const active = (Array.isArray(data && data.items) ? data.items : []).find(isActive);
      if (active) await selectBrief(active.briefId);
    } catch {
      // a tela segue sem o acompanhamento; a pessoa pode abrir o briefing
    }
  }

  // "Atualizar": relê a lista de briefings e, se há um selecionado, o briefing e o status do job (e retoma o acompanhamento).
  async function refresh() {
    setMessage(null);
    state.gaveUp = false;
    refreshButton.disabled = true;
    try {
      await loadBriefs();
      if (state.selectedId) await selectBrief(state.selectedId, { keepMessage: true });
      else await resumeActiveJob();
    } catch (error) {
      notify('error', messageFor(error));
    }
    refreshButton.disabled = false;
  }

  async function selectBrief(id, { keepMessage = false } = {}) {
    const token = ++selectToken;
    const changed = state.selectedId !== id;
    state.selectedId = id;
    if (changed) {
      state.selected = null;
      state.batch = null;
    }
    if (state.job && state.job.briefId !== id) {
      state.job = null;
      drawerCtl.listRoute();
    }
    if (!keepMessage) setMessage(null);
    paintSelected();
    paintRecent();
    try {
      const data = await api.getProspectingBrief(id);
      if (token !== selectToken || destroyed) return;
      state.selected = data.item;
      try {
        const jobs = await api.listProspectingJobs(id);
        if (token !== selectToken || destroyed) return;
        const latest = Array.isArray(jobs && jobs.items) && jobs.items.length > 0 ? jobs.items[0] : null;
        if (latest) state.job = latest;
      } catch {
        // sem o acompanhamento do job a tela segue funcionando
      }
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
    paintSelected();
    paintRecent();
    syncDrawer();
    managePolling();
  }

  // ---- o acompanhamento do job (só para um job realmente em andamento) ----------------
  const poller = createPoller({
    tick: async () => {
      if (!state.job) return null; // o briefing mudou enquanto a consulta esperava: nada a acompanhar
      const data = await api.getProspectingJobStatus(state.job.id);
      state.job = data.item;
      state.gaveUp = false;
      paintJob();
      syncDrawer();
      if (!isActive(state.job)) await onJobFinished();
      return state.job;
    },
    shouldContinue: (job) => Boolean(job) && isActive(job) && state.visible && !destroyed,
    intervalMs: pollMs,
    maxFailures: MAX_POLL_FAILURES,
    isHidden: () => Boolean(document.hidden),
    onGiveUp: () => {
      state.gaveUp = true;
      notify('error', 'Perdi o acompanhamento da prospecção. Use "Atualizar" para ver o resultado.');
      paintJob();
    },
    ...(schedule ? { schedule } : {}),
  });

  function managePolling() {
    if (destroyed || !state.visible || !state.job || !isActive(state.job) || state.gaveUp) {
      poller.stop();
      return;
    }
    poller.start();
  }

  // terminou: atualiza o briefing (status, lote e achados) e a lista; o aviso diz o que de fato aconteceu
  async function onJobFinished() {
    const job = state.job;
    if (bus) bus.publish('prospecting:changed', { action: 'finish', jobId: job.id });
    const queued = jobIndicators(job).naFila;
    if (job.status === 'CONCLUIDO') toasts.success(`Prospecção concluída${queued !== null ? `: ${queued} lead(s) chegaram à Approval Queue` : ''}.`, { key: 'pros-feedback' });
    else if (job.status === 'PARCIAL') toasts.warning(`Prospecção parcial: a quantidade pedida não foi atingida${queued !== null ? ` (${queued} lead(s) na Approval Queue)` : ''}.`, { key: 'pros-feedback' });
    else if (job.status === 'CANCELADO') toasts.warning('Prospecção cancelada.', { key: 'pros-feedback' });
    else if (job.status === 'ERRO') toasts.error('A prospecção falhou. Veja os detalhes da execução.', { key: 'pros-feedback' });
    try {
      if (state.selectedId) {
        const data = await api.getProspectingBrief(state.selectedId);
        state.selected = data.item;
        if (state.selected.loteRealId) {
          try {
            state.batch = (await api.getProspectingBatch(state.selected.loteRealId)).item;
          } catch {
            state.batch = null;
          }
        }
      }
      await loadBriefs();
    } catch {
      // a lista se atualiza na próxima carga
    }
    paintSelected();
    paintRecent();
  }

  // ---- iniciar (SEMPRE por confirmação humana) ------------------------------------

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
      paintJob();
      const field = findById(jobRegion, 'pros-start-max');
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
      detail: [
        'A pesquisa usa o Claude Code instalado neste computador e pode consumir o seu limite de uso.',
        'Iniciar uma prospecção não aprova leads, não promove nada ao CRM e não inicia nenhum contato: os leads encontrados só chegam à Approval Queue, onde uma pessoa decide.',
        'Só uma prospecção roda por vez. Você pode cancelá-la enquanto ela ainda não estiver enviando os leads para a aprovação.',
      ],
      confirmLabel: 'Iniciar prospecção',
      busyLabel: 'Iniciando…',
      onConfirm: () => startJob(brief, check.value),
      getReturnFocus: () => findById(jobRegion, 'pros-start-job') || findById(jobRegion, 'pros-job-details'),
    });
  }

  async function startJob(brief, max) {
    // busy: um segundo clique (ou um botão antigo ainda na tela) nunca inicia uma segunda prospecção.
    if (state.busy) return;
    state.busy = true;
    try {
      const data = await api.startProspectingJob(brief.id, max); // `maxCandidates` vai SÓ aqui, nunca na criação do briefing
      state.job = data.item;
      state.gaveUp = false;
    } catch (error) {
      state.busy = false;
      throw new Error(messageFor(error)); // a confirmação mostra o erro e continua aberta
    }
    state.busy = false;
    // o servidor confirmou: só agora há sucesso para mostrar
    notify('success', 'Prospecção iniciada. Acompanhe o andamento abaixo; nenhum lead é aprovado ou enviado ao CRM por isso.');
    if (bus) bus.publish('prospecting:changed', { action: 'start', jobId: state.job.id });
    paintSelected();
    managePolling();
  }

  async function onCancelJob() {
    if (state.busy || !state.job) return;
    state.busy = true;
    setMessage(null);
    paintJob();
    try {
      const data = await api.cancelProspectingJob(state.job.id);
      state.job = data.item;
      notify('success', 'Cancelamento solicitado. A prospecção para na próxima etapa segura.');
      managePolling();
    } catch (error) {
      notify('error', messageFor(error));
    }
    state.busy = false;
    paintJob();
  }

  // REFAZER PROSPECÇÃO: um job NOVO com o mesmo briefing (o anterior e o seu histórico ficam intactos), só depois da confirmação.
  function openRedo() {
    const job = state.job;
    if (!job || state.busy || isActive(job) || !canPropose) return;
    overlays.openConfirm({
      key: `pros-redo:${job.id}`,
      title: 'Refazer prospecção',
      message: `Prospecção: ${textOf(job.id)}`,
      detail: ['Isto cria e INICIA uma prospecção nova com o mesmo briefing. Ela usa a pesquisa na web e o Claude Code deste computador, pode consumir o seu limite de uso e pode levar alguns minutos.', 'Não aprova leads, não promove ao CRM e não inicia contato. O histórico atual é preservado: nada é apagado.'],
      confirmLabel: 'Refazer prospecção',
      busyLabel: 'Iniciando…',
      onConfirm: () => redo(job),
      getReturnFocus: () => findById(jobRegion, 'pros-redo-job') || (drawerCtl.handle ? findById(drawerCtl.handle.element, 'pros-drawer-redo') : null),
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
    state.job = created.item;
    state.gaveUp = false;
    drawerCtl.close({ silent: false, reason: 'redo' });
    notify('success', 'Nova prospecção iniciada com o mesmo briefing. Acompanhe o andamento abaixo.');
    if (bus) bus.publish('prospecting:changed', { action: 'redo', jobId: created.item.id });
    try {
      await loadBriefs();
    } catch {
      // a lista se atualiza na próxima carga
    }
    await selectBrief(created.item.briefId, { keepMessage: true });
    managePolling();
  }

  // ---- ações do briefing (as de sempre; cancelar pede confirmação) ---------------------

  async function runAction(fn) {
    if (state.busy) return;
    state.busy = true;
    setMessage(null);
    paintBrief();
    try {
      await fn();
      if (state.selectedId) await selectBrief(state.selectedId, { keepMessage: true });
      await loadBriefs();
    } catch (error) {
      notify('error', messageFor(error));
    }
    state.busy = false;
    paintSelected();
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

  // ---- a gaveta da execução (o ciclo de vida, com URL, vem do controlador compartilhado) -----------
  const jobDetails = createJobDetails({
    document,
    getBrief: (job) => (state.selected && state.selected.id === job.briefId ? state.selected : state.briefs.find((brief) => brief.id === job.briefId) || null),
    liveNote: 'Esta tela se atualiza sozinha enquanto a prospecção roda.',
    onFilterChange: (selectId) => {
      refreshDrawer();
      const again = drawerCtl.handle ? findById(drawerCtl.handle.element, selectId) : null;
      if (again) again.focus();
    },
  });

  const rowButtonOf = (id) => (state.job && state.job.id === id ? findById(jobRegion, 'pros-job-details') : null);

  const drawerCtl = createRoutedDrawer({
    document,
    navigation,
    hashFor: (id) => buildHash({ name: 'prospecting-run', id }),
    listHash: buildHash({ name: 'prospecting' }),
    rowButton: rowButtonOf,
    repaint: () => paintJob(),
    onClosed: (id) => {
      if (id !== null) signatures.delete(id);
    },
    build: (id, hooks) => {
      const job = state.job && state.job.id === id ? state.job : null;
      if (!job) return null;
      signatures.set(id, JSON.stringify(job));
      const brief = state.selected && state.selected.id === job.briefId ? state.selected : null;
      return overlays.openDrawer({
        key: `pros-run:${id}`,
        title: textOf(job.id) || 'Prospecção',
        subtitle: [textOf(brief && brief.nicho), briefPlace(brief)].filter(Boolean).join(' · ') || `Iniciada em ${formatDateTime(job.startedAt || job.createdAt) || '—'}`,
        content: drawerBody(job),
        footer: drawerFooter(job),
        getReturnFocus: hooks.getReturnFocus,
        onClose: hooks.onClose,
      });
    },
  });

  function drawerBody(job) {
    return jobDetails.build(job, { tab: state.tab, onTab: (key) => { state.tab = key; } }).element;
  }

  function drawerFooter(job) {
    const history = el('a', { className: 'btn secondary', href: buildHash({ name: 'prospecting-job', id: job.id }), text: 'Ver no Histórico' });
    if (isActive(job)) return el('div', { className: 'drawer-actions' }, history, el('p', { className: 'muted note', text: 'Os números se atualizam sozinhos enquanto a prospecção roda.' }));
    if (!canPropose) return el('div', { className: 'drawer-actions' }, history);
    return el('div', { className: 'drawer-actions' }, el('button', { type: 'button', className: 'btn primary', id: 'pros-drawer-redo', text: 'Refazer prospecção', disabled: state.busy, onclick: () => openRedo() }), history);
  }

  function refreshDrawer() {
    const handle = drawerCtl.handle;
    const job = state.job && drawerCtl.state.selectedId === state.job.id ? state.job : null;
    if (!handle || !job) return;
    handle.setContent(drawerBody(job));
    handle.setFooter(drawerFooter(job));
  }

  // o job mudou (consulta de status): a gaveta só é reconstruída se algo mudou (a aba e o foco ficam)
  function syncDrawer() {
    if (!drawerCtl.isOpen()) return;
    const id = drawerCtl.state.selectedId;
    if (!state.job || state.job.id !== id) {
      toasts.warning('Esta prospecção não está mais na tela. Abra-a de novo pelo Histórico.', { key: 'pros-feedback' });
      drawerCtl.dismiss('gone');
      return;
    }
    const signature = JSON.stringify(state.job);
    if (signatures.get(id) === signature) return;
    signatures.set(id, signature);
    refreshDrawer();
  }

  // ---- desenho das regiões ----------------------------------------------------------

  function briefRow(brief) {
    const selected = brief.id === state.selectedId;
    return el(
      'tr',
      { className: selected ? 'queue-row selected' : 'queue-row', 'data-brief': brief.id, onclick: () => selectBrief(brief.id) },
      el('td', { 'data-label': 'Briefing' }, el('div', { className: 'company-cell' }, el('button', { type: 'button', className: 'company-name job-code', 'data-item': brief.id, text: textOf(brief.id), 'aria-current': selected ? 'true' : null }), el('span', { className: 'company-meta', text: `${textOf(brief.nicho)}${brief.subnicho ? ` / ${textOf(brief.subnicho)}` : ''}` }))),
      el('td', { 'data-label': 'Local', text: briefPlace(brief) || '—' }),
      el('td', { 'data-label': 'Leads desejados', className: 'num', text: String(brief.quantidade) }),
      el('td', { 'data-label': 'Situação' }, badge(STATUS_LABELS[brief.status] || textOf(brief.status), STATUS_TONES[brief.status] || 'neutral'))
    );
  }

  function paintRecent() {
    if (state.status === 'loading' && state.briefs.length === 0) {
      fill(recentRegion, skeleton(document, { rows: 4, label: 'Carregando os briefings…' }));
      fill(recentPager);
      return;
    }
    if (state.status === 'error' && state.briefs.length === 0) {
      fill(recentRegion, el('p', { className: 'message error', role: 'alert', text: state.error }));
      fill(recentPager);
      return;
    }
    if (state.briefs.length === 0) {
      fill(recentRegion, el('div', { id: 'pros-recent-empty' }, emptyState(document, { title: 'Nenhum briefing ainda', text: 'Crie o primeiro briefing no formulário ao lado. Nada é pesquisado até você confirmar.' })));
      fill(recentPager);
      return;
    }
    const pageCount = Math.max(1, Math.ceil(state.briefs.length / pageSize));
    state.page = Math.min(Math.max(1, state.page), pageCount);
    const slice = state.briefs.slice((state.page - 1) * pageSize, state.page * pageSize);
    const head = el('tr', {}, ...['Briefing', 'Local', 'Leads desejados', 'Situação'].map((title, index) => el('th', { scope: 'col', className: index === 2 ? 'num' : '', text: title })));
    fill(recentRegion, el('div', { className: 'table-wrap' }, el('table', { className: 'list queue', id: 'pros-recent' }, el('caption', { className: 'visually-hidden', text: 'Briefings recentes' }), el('thead', {}, head), el('tbody', {}, ...slice.map(briefRow)))));
    fill(recentPager, pagination(document, { page: state.page, pageCount, total: state.briefs.length, pageSize, onPage: (next) => { state.page = next; paintRecent(); } }));
  }

  function paintSelected() {
    paintBrief();
    paintJob();
    paintManual();
  }

  function actionButton(text, onclick, extraClass = 'secondary') {
    return el('button', { type: 'button', className: `btn ${extraClass}`, disabled: state.busy, onclick, text });
  }

  function paintBrief() {
    if (!state.selectedId) {
      fill(briefRegion, emptyState(document, { title: 'Nenhum briefing selecionado', text: 'Escolha um briefing da lista para ver os detalhes e iniciar a pesquisa.' }));
      return;
    }
    const brief = state.selected;
    if (!brief) {
      fill(briefRegion, skeleton(document, { rows: 3, label: 'Carregando o briefing…' }));
      return;
    }
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
    fill(
      briefRegion,
      el('div', { className: 'pros-brief-card' },
        el('div', { className: 'pros-brief-head' }, el('h3', { text: textOf(brief.id) }), badge(STATUS_LABELS[brief.status] || textOf(brief.status), STATUS_TONES[brief.status] || 'neutral')),
        facts,
        actions.length > 0 ? el('div', { className: 'actions' }, ...actions) : null
      )
    );
  }

  // O cartão de INÍCIO (briefing pronto, sem prospecção em andamento) ou o de EXECUÇÃO (o job).
  function paintJob() {
    const brief = state.selected;
    const job = state.job;
    if (!brief && !job) {
      fill(jobRegion);
      return;
    }
    const active = Boolean(job) && isActive(job);
    const startable = Boolean(brief) && brief.status === 'PRONTO_PARA_PESQUISA' && canPropose;
    const parts = [];
    if (startable && !active) parts.push(startCard(brief));
    if (job) parts.push(execCard(job, active));
    fill(jobRegion, ...parts);
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

  function stepper(job, active) {
    const finishedOk = job.status === 'CONCLUIDO' || job.status === 'PARCIAL';
    if (!active && !finishedOk) return null; // erro ou cancelamento: o servidor não diz até onde chegou com certeza — nada é afirmado
    const at = STEP_ORDER[job.currentStep] ?? 0;
    return el(
      'ol',
      { className: 'stepper', 'aria-label': 'Etapas da prospecção' },
      ...STEPS.map(([key, label]) => {
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
    const nodes = [];
    const title = FINISH_TITLES[job.status];
    nodes.push(el('div', { className: 'exec-head' }, el('h3', { text: 'Prospecção automática' }), badge(JOB_STATUS_LABELS[job.status] || textOf(job.status), JOB_TONES[job.status] || 'neutral'), el('span', { className: 'muted exec-id', text: textOf(job.id) })));
    if (title) nodes.push(el('h4', { className: 'job-title', text: title }));
    if (active) nodes.push(el('p', { className: 'exec-step', text: STEP_LABELS[job.currentStep] || 'Em andamento' }));
    const steps = stepper(job, active);
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
    if (state.gaveUp) nodes.push(el('p', { className: 'notice bad', role: 'note', text: 'O acompanhamento automático parou depois de falhas seguidas. Use "Atualizar" para tentar de novo.' }));
    if (!active) nodes.push(...resultText(job, ind));
    nodes.push(execActions(job, active, ind));
    return el('div', { className: 'exec-card', id: 'pros-auto' }, ...nodes);
  }

  function indicatorTile(label, value, hint) {
    return el('div', { className: 'indicator indicator-number' }, el('span', { className: 'indicator-label', text: label }), el('span', { className: 'indicator-value', text: num(value) }), el('span', { className: 'indicator-hint muted', text: hint }));
  }

  function clock(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
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
    buttons.push(el('button', { type: 'button', className: 'btn secondary', id: 'pros-job-details', 'data-item': job.id, text: 'Ver detalhes da execução', onclick: () => drawerCtl.open(job.id) }));
    if (active && job.currentStep !== 'INGERINDO' && canPropose) buttons.push(el('button', { type: 'button', className: 'btn danger', id: 'pros-cancel-job', disabled: state.busy || job.status === 'CANCELAMENTO_SOLICITADO', onclick: onCancelJob, text: 'Cancelar prospecção' }));
    if (!active && canPropose) buttons.push(el('button', { type: 'button', className: 'btn secondary', id: 'pros-redo-job', disabled: state.busy, onclick: () => openRedo(), text: 'Refazer prospecção' }));
    if (!active && ind.naFila !== null && ind.naFila > 0 && (job.status === 'CONCLUIDO' || job.status === 'PARCIAL')) buttons.push(el('a', { className: 'btn secondary', id: 'pros-open-approvals', href: buildHash({ name: 'approvals' }), text: 'Abrir a Approval Queue' }));
    buttons.push(el('a', { className: 'btn secondary', href: buildHash({ name: 'prospecting-job', id: job.id }), text: 'Ver no Histórico' }));
    return el('div', { className: 'actions exec-actions' }, ...buttons);
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
    if (!state.batch) return null;
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

  function paintManual() {
    const brief = state.selected;
    if (!brief || !canPropose) {
      fill(manualRegion);
      return;
    }
    // havendo um job (ativo ou terminado), a tela mostra só o fluxo automático: nenhum pacote JSON, nenhum "copiar", nenhuma ingestão manual
    const canGenerate = brief.status === 'PRONTO_PARA_PESQUISA' || brief.status === 'PESQUISANDO';
    const manual = state.job || (!canGenerate && !brief.pacotePesquisa)
      ? null
      : el(
          'div',
          { className: 'manual-mode', id: 'pros-manual' },
          el('button', { type: 'button', className: 'link', id: 'pros-manual-toggle', onclick: () => { state.manualOpen = !state.manualOpen; paintManual(); }, text: state.manualOpen ? 'Ocultar modo manual' : 'Modo manual' }),
          ...(state.manualOpen
            ? [
                el('p', { className: 'muted', text: 'Fluxo antigo: gere um pacote de pesquisa, leve-o ao Claude/Web e cole o resultado de volta.' }),
                canGenerate ? actionButton('Gerar pacote de pesquisa', () => runAction(() => api.generateProspectingPackage(brief.id)), 'secondary') : null,
                packageBlock(brief),
                brief.status === 'PESQUISANDO' ? ingestBlock() : null,
              ]
            : [])
        );
    fill(manualRegion, manual, findingsTable());
  }

  // ---- a página ----------------------------------------------------------------

  if (!canPropose) {
    content.append(el('section', { className: 'prospecting', id: 'prospecting' }, pageHeader(document, { title: 'Nova Prospecção' }), el('p', { className: 'muted', text: 'Seu perfil não pode usar o Workbench de Prospecção.' })));
  } else {
    content.append(
      el(
        'section',
        { className: 'prospecting', id: 'prospecting', 'aria-labelledby': 'pros-title' },
        pageHeader(document, { title: 'Nova Prospecção', titleId: 'pros-title', subtitle: 'Crie um briefing, revise o resumo e inicie a pesquisa. Iniciar uma prospecção não aprova leads, não promove ao CRM e não inicia contatos: a aprovação continua sendo humana.', actions: [refreshButton] }),
        messageRegion,
        el('div', { className: 'pros-layout' }, el('div', { className: 'pros-form-card list-card' }, form), el('div', { className: 'pros-recent-card list-card' }, el('h3', { className: 'form-title', text: 'Briefings recentes' }), recentRegion, recentPager)),
        el('div', { className: 'pros-selected' }, briefRegion, jobRegion, manualRegion)
      )
    );
  }
  writeControls();
  paintRecent();
  paintSelected();

  // ---- roteamento (chamado pelo shell a cada mudança de #) ------------------------------------

  async function show(route) {
    if (destroyed) return;
    const entering = !state.visible;
    state.visible = true;
    if (!canPropose) return;
    if (route && route.name === 'prospecting-run') {
      drawerCtl.setRoute(route.id);
      if (drawerCtl.isOpen() && drawerCtl.state.selectedId === route.id) return;
      if (state.loadedAt === null) await load();
      if (destroyed || drawerCtl.state.routeId !== route.id) return;
      if (!state.job || state.job.id !== route.id) await locateJob(route.id);
      if (destroyed || drawerCtl.state.routeId !== route.id) return;
      if (!state.job || state.job.id !== route.id) {
        notify('warning', 'Esta prospecção não foi encontrada. Procure-a no Histórico.');
        drawerCtl.setRoute(null);
        if (navigation) navigation.replace(buildHash({ name: 'prospecting' }));
        return;
      }
      drawerCtl.openFromRoute(route.id);
      managePolling();
      return;
    }
    drawerCtl.listRoute();
    if (state.loadedAt === null) await load();
    else if (entering) await refreshQuiet();
    managePolling();
  }

  // O link direto para uma execução: acha o job pela lista (só leitura) e seleciona o briefing dele.
  async function locateJob(id) {
    try {
      const data = await api.listProspectingJobs();
      const found = (Array.isArray(data && data.items) ? data.items : []).find((job) => job.id === id);
      if (!found) return;
      await selectBrief(found.briefId);
      if (!state.job || state.job.id !== id) state.job = found;
      paintJob();
    } catch {
      // sem a lista de jobs, o link direto não é resolvido
    }
  }

  // voltar ao módulo: atualiza em silêncio (a lista e, se há, o job selecionado) sem apagar nada
  async function refreshQuiet() {
    try {
      await loadBriefs();
      if (state.selectedId) await selectBrief(state.selectedId, { keepMessage: true });
      else await resumeActiveJob();
    } catch {
      // a tela segue com o que já tinha
    }
  }

  // O módulo saiu de cena: as camadas fecham e o acompanhamento PARA; o rascunho, o briefing e a página ficam guardados.
  function hide() {
    state.visible = false;
    drawerCtl.leave(overlays);
    poller.stop();
  }

  return {
    load,
    render: () => {
      paintRecent();
      paintSelected();
    },
    state,
    show,
    hide,
    refresh,
    openJob: (id) => drawerCtl.open(id),
    closeJob: () => drawerCtl.close({ silent: false, reason: 'api' }),
    destroy() {
      destroyed = true;
      poller.stop();
      drawerCtl.close({ silent: true, reason: 'destroy' });
      if (ownsUi) ui.destroy();
    },
  };
}
