// Tela APROVAÇÕES — o primeiro (e único) módulo do Dashboard: a fila de aprovação humana de prospects.
//
// A tela lista os prospects AGUARDANDO_REVISAO, mostra o detalhe de um e deixa o usuário APROVAR ou REJEITAR, com
// confirmação (motivo opcional ao aprovar; obrigatório ao rejeitar). Quem decide se a pessoa pode fazer isso é o
// SERVIDOR; a tela só usa `canReview` (vindo de /api/me) para mostrar ou esconder os botões — uma conveniência de
// interface, nunca uma autorização.
//
// "Aprovar candidato" é uma triagem interna (APROVADO_PARA_CRM): não cria registro no CRM e não autoriza contato
// (docs/decisions/0007). O texto da tela diz isso.
//
// SEGURANÇA: tudo o que vem dos dados entra no DOM por dom.mjs (textContent). Um endereço só vira link se for
// http(s) (safeHttpUrl), sempre com rel="noopener noreferrer". Nada aqui usa innerHTML, eval ou Function.
//
// As funções puras (rótulos, datas, URLs, mensagens de erro) são exportadas para teste; a tela recebe `document`,
// `root` e `api` por parâmetro, então roda igual no navegador e em um DOM de teste.

import { h } from '../dom.mjs';

export const PENDING_ESTADO = 'AGUARDANDO_REVISAO';

export const ESTADO_LABELS = Object.freeze({
  AGUARDANDO_REVISAO: 'Aguardando revisão',
  APROVADO_PARA_CRM: 'Aprovado (triagem)',
  REJEITADO: 'Rejeitado',
  DUPLICADO: 'Duplicado',
  DNC: 'Não contatar (DNC)',
  DADOS_INSUFICIENTES: 'Dados insuficientes',
  EXPIRADO: 'Expirado',
});

const IDENTITY_REASONS = Object.freeze({
  CONFIRMADA: 'confirmada',
  CONFLITO: 'conflito entre fontes',
  AMBIGUA: 'identidade ambígua',
  EVIDENCIA_FRACA: 'evidência fraca',
  SEM_EVIDENCIA: 'sem evidência',
});

const DATA_LABELS = Object.freeze({ SUFICIENTES: 'Suficientes', PARCIAIS: 'Parciais', INSUFICIENTES: 'Insuficientes' });
const DUPLICITY_LABELS = Object.freeze({
  NOVO: 'Novo',
  DUPLICADO: 'Duplicado',
  POSSIVEL_DUPLICADO: 'Possível duplicado',
  NAO_VERIFICADO: 'Não verificado',
});
const DNC_LABELS = Object.freeze({
  NAO_ENCONTRADO: 'Não encontrado no CRM',
  BLOQUEADO: 'Bloqueado (não contatar)',
  NAO_VERIFICADO: 'Não verificado (CRM indisponível)',
});

const TONES = Object.freeze({
  estado: { AGUARDANDO_REVISAO: 'warn', APROVADO_PARA_CRM: 'ok', REJEITADO: 'bad', DUPLICADO: 'bad', DNC: 'bad', DADOS_INSUFICIENTES: 'warn' },
  identity: { VALIDADA: 'ok', NAO_VALIDADA: 'warn' },
  data: { SUFICIENTES: 'ok', PARCIAIS: 'warn', INSUFICIENTES: 'bad' },
  duplicity: { NOVO: 'ok', POSSIVEL_DUPLICADO: 'warn', DUPLICADO: 'bad', NAO_VERIFICADO: 'neutral' },
  dnc: { NAO_ENCONTRADO: 'ok', NAO_VERIFICADO: 'warn', BLOQUEADO: 'bad' },
});

const GENERIC_ERROR = 'Não foi possível concluir a operação agora. Tente novamente em instantes.';
const MAX_SOURCES_SHOWN = 50;

// ---------------------------------------------------------------------------
// Funções puras
// ---------------------------------------------------------------------------

// Um valor de dado vira texto só se for um texto, número ou booleano; qualquer outra coisa (objeto, lista) é ignorada.
export function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function labelForEstado(estado) {
  return ESTADO_LABELS[estado] || textOf(estado) || '—';
}

// Devolve uma URL http(s) segura ou null. Nunca javascript:, data:, file:, blob:, vbscript:... e nunca URL com
// usuário/senha. `assumeHttps` (só para o campo "site", que é um domínio por definição) aceita "exemplo.com.br".
export function safeHttpUrl(value, { assumeHttps = false } = {}) {
  const raw = textOf(value);
  if (raw === '' || /\s/.test(raw)) return null;
  let candidate = raw;
  if (assumeHttps && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?([/?#].*)?$/.test(raw)) {
    candidate = `https://${raw}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}

// "2026-01-15" -> "15/01/2026" (sem fuso horário: é uma data, não um instante).
export function formatDate(value) {
  const raw = textOf(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : raw;
}

export function formatDateTime(value) {
  const raw = textOf(value);
  const date = new Date(raw);
  if (raw === '' || Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}

export function identityStatus(statusIdentidade) {
  return statusIdentidade && typeof statusIdentidade === 'object' ? textOf(statusIdentidade.status) : textOf(statusIdentidade);
}

export function identityText(statusIdentidade, { withReason = false } = {}) {
  const status = identityStatus(statusIdentidade);
  const label = status === 'VALIDADA' ? 'Validada' : status === 'NAO_VALIDADA' ? 'Não validada' : status || '—';
  const reason = statusIdentidade && typeof statusIdentidade === 'object' ? IDENTITY_REASONS[textOf(statusIdentidade.motivo)] : '';
  return withReason && reason ? `${label} (${reason})` : label;
}

export const dataText = (statusDados) => DATA_LABELS[textOf(statusDados)] || textOf(statusDados) || '—';

export function duplicityText(statusDuplicidade, matchedOn) {
  const label = DUPLICITY_LABELS[textOf(statusDuplicidade)] || textOf(statusDuplicidade) || '—';
  const criteria = Array.isArray(matchedOn) ? matchedOn.map(textOf).filter(Boolean) : [];
  return criteria.length > 0 ? `${label} (${criteria.join(', ')})` : label;
}

export const dncText = (statusDNC) => DNC_LABELS[textOf(statusDNC)] || textOf(statusDNC) || '—';

// As fontes de um prospect: cada uma vira { label, url, detail }. `url` só existe se for http(s) seguro.
export function describeSources(fontes) {
  if (!Array.isArray(fontes)) return [];
  const sources = [];
  for (const entry of fontes.slice(0, MAX_SOURCES_SHOWN)) {
    if (typeof entry === 'string') {
      const label = textOf(entry);
      if (label !== '') sources.push({ label, url: safeHttpUrl(label), detail: '' });
    } else if (entry && typeof entry === 'object') {
      const label = [entry.fonte, entry.nome, entry.descricao, entry.campo, entry.url].map(textOf).find(Boolean) || 'Fonte';
      const detail = [textOf(entry.tipoFonte), textOf(entry.campo) !== label ? textOf(entry.campo) : '', formatDateTime(entry.dataConsulta), textOf(entry.observacao)]
        .filter(Boolean)
        .join(' · ');
      sources.push({ label, url: safeHttpUrl(entry.url), detail });
    }
  }
  return sources;
}

// A mensagem para o usuário, por status. 401 devolve null: quem cuida é o fluxo de login.
export function messageForError(error) {
  const status = error && typeof error.status === 'number' ? error.status : 0;
  if (status === 401) return null;
  if (status === 403) return 'Esta conta não possui acesso a esta área.';
  if (status === 404) return 'Este item não foi encontrado. A lista foi atualizada.';
  if (status === 409) return 'Este item já foi decidido. A lista foi atualizada.';
  if (status === 400) return error.serverMessage ? `Dados inválidos: ${error.serverMessage}` : 'Dados inválidos.';
  return GENERIC_ERROR;
}

const cityUf = (snapshot) => [textOf(snapshot.cidade), textOf(snapshot.estadoUf)].filter(Boolean).join('/');

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------

// document/root: onde desenhar. api: { listApprovals, approve, reject } (api.mjs). canReview: mostra os botões.
export function createApprovalsView({ document, root, api, canReview }) {
  const state = { loading: true, items: [], selectedId: null, mode: null, busy: false, message: null, formError: null };
  let reasonInput = null;

  const badge = (text, tone) => h(document, 'span', { className: `badge ${tone || 'neutral'}`, text });
  const selectedItem = () => state.items.find((item) => item.prospectId === state.selectedId) || null;

  function setMessage(kind, text) {
    state.message = text ? { kind, text } : null;
  }

  async function load() {
    state.loading = true;
    render();
    try {
      const data = await api.listApprovals();
      state.items = Array.isArray(data && data.items) ? data.items : [];
      if (!selectedItem()) {
        state.selectedId = null;
        state.mode = null;
      }
    } catch (error) {
      setMessage('error', messageForError(error));
    }
    state.loading = false;
    render();
  }

  function select(prospectId) {
    state.selectedId = prospectId;
    state.mode = null;
    state.formError = null;
    state.message = null;
    render();
  }

  function openConfirmation(mode) {
    state.mode = mode;
    state.formError = null;
    render();
    if (reasonInput) reasonInput.focus();
  }

  function cancelConfirmation() {
    state.mode = null;
    state.formError = null;
    render();
  }

  async function confirm() {
    const item = selectedItem();
    if (!item || !state.mode || state.busy) return;
    const mode = state.mode;
    const reason = reasonInput ? String(reasonInput.value || '').trim() : '';
    if (mode === 'reject' && reason === '') {
      state.formError = 'Informe o motivo da rejeição.';
      render();
      return;
    }

    state.busy = true;
    state.formError = null;
    render();
    try {
      if (mode === 'approve') await api.approve(item.prospectId, reason || undefined);
      else await api.reject(item.prospectId, reason);
      setMessage('success', mode === 'approve' ? 'Prospect aprovado.' : 'Prospect rejeitado.');
      state.busy = false;
      state.mode = null;
      state.selectedId = null;
      await load();
    } catch (error) {
      state.busy = false;
      setMessage('error', messageForError(error));
      if (error && (error.status === 409 || error.status === 404)) {
        state.mode = null;
        state.selectedId = null;
        await load();
      } else {
        render();
      }
    }
  }

  function refresh() {
    state.message = null;
    return load();
  }

  // ---- desenho ----------------------------------------------------------

  function renderList() {
    if (state.loading && state.items.length === 0) return h(document, 'p', { className: 'muted', text: 'Carregando…' });
    if (state.items.length === 0) return h(document, 'p', { className: 'muted', text: 'Nenhum prospect aguardando revisão.' });

    const head = h(
      document,
      'tr',
      {},
      ...['Empresa', 'Cidade/UF', 'Nicho', 'Estado', 'Identidade', 'Dados', 'Pesquisa'].map((title) => h(document, 'th', { scope: 'col', text: title }))
    );
    const rows = state.items.map((item) => {
      const snapshot = item.discoverySnapshot || {};
      const selected = item.prospectId === state.selectedId;
      return h(
        document,
        'tr',
        { className: selected ? 'selected' : '' },
        h(
          document,
          'td',
          {},
          h(document, 'button', {
            type: 'button',
            className: 'link-button',
            text: textOf(item.empresa) || 'Sem nome',
            'aria-current': selected ? 'true' : null,
            onclick: () => select(item.prospectId),
          })
        ),
        h(document, 'td', { text: cityUf(snapshot) || '—' }),
        h(document, 'td', { text: textOf(snapshot.nicho) || '—' }),
        h(document, 'td', {}, badge(labelForEstado(item.estado), TONES.estado[item.estado])),
        h(document, 'td', {}, badge(identityText(snapshot.statusIdentidade), TONES.identity[identityStatus(snapshot.statusIdentidade)])),
        h(document, 'td', {}, badge(dataText(snapshot.statusDados), TONES.data[textOf(snapshot.statusDados)])),
        h(document, 'td', { text: formatDate(snapshot.dataDaPesquisa) || '—' })
      );
    });
    return h(
      document,
      'div',
      { className: 'table-wrap' },
      h(document, 'table', { className: 'list' }, h(document, 'caption', { className: 'visually-hidden', text: 'Prospects aguardando revisão' }), h(document, 'thead', {}, head), h(document, 'tbody', {}, ...rows))
    );
  }

  function field(label, content) {
    return [h(document, 'dt', { text: label }), h(document, 'dd', {}, content)];
  }

  function textValue(value) {
    const text = textOf(value);
    return text === '' ? null : h(document, 'span', { text });
  }

  function linkValue(value, options) {
    const text = textOf(value);
    if (text === '') return null;
    const url = safeHttpUrl(text, options);
    return url
      ? h(document, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer', text })
      : h(document, 'span', { text });
  }

  function renderSources(fontes) {
    const sources = describeSources(fontes);
    if (sources.length === 0) return null;
    return h(
      document,
      'ul',
      { className: 'plain' },
      ...sources.map((source) =>
        h(
          document,
          'li',
          {},
          source.url ? h(document, 'a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: source.label }) : h(document, 'span', { text: source.label }),
          source.detail ? h(document, 'span', { className: 'muted', text: ` — ${source.detail}` }) : null
        )
      )
    );
  }

  function renderHistory(historico) {
    if (!Array.isArray(historico) || historico.length === 0) return null;
    return h(
      document,
      'ol',
      { className: 'plain' },
      ...historico.map((entry) => {
        const who =
          entry && entry.actor === 'HUMAN' && entry.reviewedBy
            ? `${textOf(entry.reviewedBy.name)} (${textOf(entry.reviewedBy.role)})`
            : 'Sistema';
        const line = [
          formatDateTime(entry && entry.timestamp),
          `${entry && entry.from ? labelForEstado(entry.from) : 'Início'} → ${labelForEstado(entry && entry.to)}`,
          who,
        ].join(' · ');
        const reason = entry && textOf(entry.motivo) ? `: ${textOf(entry.motivo)}` : '';
        return h(document, 'li', { text: `${line}${reason}` });
      })
    );
  }

  function renderConfirmation(item) {
    const approving = state.mode === 'approve';
    reasonInput = h(document, 'textarea', { id: 'reason-input', rows: '3', maxlength: '2000', disabled: state.busy });
    return h(
      document,
      'div',
      { className: 'confirm', role: 'group', 'aria-label': approving ? 'Confirmar aprovação' : 'Confirmar rejeição' },
      h(document, 'h4', { text: approving ? 'Confirmar aprovação' : 'Confirmar rejeição' }),
      h(document, 'p', { text: `Prospect: ${textOf(item.empresa) || 'Sem nome'}` }),
      approving
        ? h(document, 'p', { className: 'muted', text: 'A aprovação é uma triagem interna: não cria registro no CRM nem autoriza contato.' })
        : null,
      h(document, 'label', { for: 'reason-input', text: approving ? 'Motivo (opcional)' : 'Motivo (obrigatório)' }),
      reasonInput,
      state.formError ? h(document, 'p', { className: 'message error', role: 'alert', text: state.formError }) : null,
      h(
        document,
        'div',
        { className: 'actions' },
        h(document, 'button', {
          type: 'button',
          className: approving ? 'btn primary' : 'btn danger',
          text: state.busy ? 'Enviando…' : approving ? 'Confirmar aprovação' : 'Confirmar rejeição',
          disabled: state.busy,
          onclick: confirm,
        }),
        h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Cancelar', disabled: state.busy, onclick: cancelConfirmation })
      )
    );
  }

  function renderDetail() {
    const item = selectedItem();
    reasonInput = null;
    if (!item) return h(document, 'p', { className: 'muted', text: 'Selecione um prospect na lista para ver os detalhes.' });

    const snapshot = item.discoverySnapshot || {};
    const rows = [
      ['Estado na fila', badge(labelForEstado(item.estado), TONES.estado[item.estado])],
      ['Tipo', textValue(snapshot.tipo)],
      ['Cidade/UF', textValue(cityUf(snapshot))],
      ['Nicho', textValue(snapshot.nicho)],
      ['Site', linkValue(snapshot.site, { assumeHttps: true })],
      ['Instagram', linkValue(snapshot.instagram)],
      ['Facebook', linkValue(snapshot.facebook)],
      ['LinkedIn', linkValue(snapshot.linkedin)],
      ['YouTube', linkValue(snapshot.youtube)],
      ['Telefone', textValue(snapshot.telefone)],
      ['WhatsApp', textValue(snapshot.whatsapp)],
      ['E-mail', textValue(snapshot.email)],
      ['Endereço', textValue(snapshot.endereco)],
      ['Identidade', badge(identityText(snapshot.statusIdentidade, { withReason: true }), TONES.identity[identityStatus(snapshot.statusIdentidade)])],
      ['Dados', badge(dataText(snapshot.statusDados), TONES.data[textOf(snapshot.statusDados)])],
      ['Duplicidade', badge(duplicityText(snapshot.statusDuplicidade, snapshot.matchedOn), TONES.duplicity[textOf(snapshot.statusDuplicidade)])],
      ['DNC', badge(dncText(snapshot.statusDNC), TONES.dnc[textOf(snapshot.statusDNC)])],
      ['Data da pesquisa', textValue(formatDate(snapshot.dataDaPesquisa))],
      ['Observações', textValue(snapshot.observacoes)],
      ['Hipótese de oportunidade', textValue(snapshot.hipoteseDeOportunidade)],
      ['Fontes', renderSources(snapshot.fontes)],
      ['Histórico', renderHistory(item.historico)],
    ].filter(([, content]) => content !== null);

    const pending = item.estado === PENDING_ESTADO;
    let actions = null;
    if (pending && canReview) {
      actions =
        state.mode === null
          ? h(
              document,
              'div',
              { className: 'actions' },
              h(document, 'button', { type: 'button', className: 'btn primary', text: 'Aprovar', onclick: () => openConfirmation('approve') }),
              h(document, 'button', { type: 'button', className: 'btn danger', text: 'Rejeitar', onclick: () => openConfirmation('reject') })
            )
          : renderConfirmation(item);
    } else if (pending) {
      actions = h(document, 'p', { className: 'muted', text: 'Sua conta não pode aprovar ou rejeitar prospects.' });
    } else {
      actions = h(document, 'p', { className: 'muted', text: 'Este item já foi decidido ou está bloqueado.' });
    }

    return h(
      document,
      'div',
      { className: 'detail' },
      h(document, 'h3', { text: textOf(item.empresa) || 'Sem nome' }),
      h(document, 'dl', { className: 'fields' }, ...rows.flatMap(([label, content]) => field(label, content))),
      actions
    );
  }

  function render() {
    const pendingCount = state.items.filter((item) => item.estado === PENDING_ESTADO).length;
    root.replaceChildren(
      h(
        document,
        'section',
        { className: 'approvals', 'aria-labelledby': 'approvals-title' },
        h(
          document,
          'div',
          { className: 'approvals-head' },
          h(document, 'h2', { id: 'approvals-title', text: 'Aprovações' }),
          h(document, 'p', { className: 'pending-count', text: `${pendingCount} ${pendingCount === 1 ? 'pendente' : 'pendentes'}` }),
          h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Atualizar', disabled: state.busy || state.loading, onclick: refresh })
        ),
        state.message ? h(document, 'p', { className: `message ${state.message.kind}`, role: 'status', text: state.message.text }) : null,
        h(document, 'div', { className: 'approvals-body' }, h(document, 'div', { className: 'approvals-list' }, renderList()), h(document, 'div', { className: 'approvals-detail' }, renderDetail()))
      )
    );
  }

  return { load, render, state };
}
