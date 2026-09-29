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

function geografiaTexto(brief) {
  if (brief.nivelGeografico === 'CIDADE') return `Cidade: ${(brief.cidades || []).join(', ')}`;
  if (brief.nivelGeografico === 'ESTADO') return `Estado: ${(brief.estados || []).join(', ')}`;
  return `Nacional: ${brief.pais || 'Brasil'}`;
}

// document/root: onde desenhar. api: o cliente de api.mjs. permissions: { canProposeLead }. navigate: não usado
// ainda (a ficha de um achado aprovado é a fila de Aprovações, não esta tela).
export function createProspectingView({ document, root, api, permissions }) {
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
  };

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
  }

  async function selectBrief(id) {
    state.selectedId = id;
    state.selected = null;
    state.batch = null;
    render();
    try {
      const data = await api.getProspectingBrief(id);
      state.selected = data.item;
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
      el('div', { className: 'actions' },
        brief.status === 'RASCUNHO' ? actionButton('Marcar pronto para pesquisa', () => runAction(() => api.markProspectingBriefReady(brief.id)), 'primary') : null,
        (brief.status === 'PRONTO_PARA_PESQUISA' || brief.status === 'PESQUISANDO') ? actionButton('Gerar pacote de pesquisa', () => runAction(() => api.generateProspectingPackage(brief.id)), 'primary') : null,
        brief.status === 'AGUARDANDO_REVISAO' ? actionButton('Marcar concluído', () => runAction(() => api.concludeProspectingBrief(brief.id)), 'secondary') : null,
        !['CONCLUIDO', 'CANCELADO'].includes(brief.status) ? actionButton('Cancelar lote', () => runAction(() => api.cancelProspectingBrief(brief.id)), 'danger') : null
      ),
      buildPackageBlock(brief),
      brief.status === 'PESQUISANDO' ? buildIngestBlock() : null,
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

  return { load, render, destroy: () => {} };
}
