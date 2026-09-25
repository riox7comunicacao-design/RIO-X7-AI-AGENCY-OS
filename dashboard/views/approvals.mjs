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
import { textOf, safeHttpUrl, formatDate, formatDateTime } from '../format.mjs';
import { buildHash } from '../router.mjs';

// Estas quatro funções puras vivem em ../format.mjs (compartilhadas com as demais telas); continuam exportadas daqui.
export { textOf, safeHttpUrl, formatDate, formatDateTime };

export const PENDING_ESTADO = 'AGUARDANDO_REVISAO';
export const APPROVED_ESTADO = 'APROVADO_PARA_CRM';

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

export function labelForEstado(estado) {
  return ESTADO_LABELS[estado] || textOf(estado) || '—';
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

// Como a promoção terminou (o servidor devolve só isto). Qualquer outro valor é resposta inesperada.
const PROMOTION_DONE = Object.freeze(['CRIADO', 'RECONCILIADO']);
const PROMOTION_ALREADY = 'JA_PROMOVIDO';

export const PROMOTED_MESSAGE = 'Prospect promovido para o CRM.';
export const ALREADY_PROMOTED_MESSAGE = 'Este prospect já foi promovido para o CRM.';
export const PROMOTE_CONFIRM_TEXT = 'Este prospect será incluído no CRM e poderá entrar no pipeline comercial.';

// A mensagem de uma promoção que falhou. Os 409 trazem uma mensagem FIXA do servidor (duplicidade, restrição de contato,
// não aprovado...), só usada quando o código é de promoção — nada de texto interno. 401 devolve null (o login cuida).
export function promotionMessageForError(error) {
  const status = error && typeof error.status === 'number' ? error.status : 0;
  if (status === 401) return null;
  if (status === 403) return 'Sua conta não pode promover prospects para o CRM.';
  if (status === 404) return 'Este prospect não foi encontrado. A lista foi atualizada.';
  if (status === 409) {
    const fromServer = error && typeof error.code === 'string' && error.code.startsWith('PROMOTION_') ? textOf(error.serverMessage) : '';
    return fromServer || 'A promoção foi bloqueada.';
  }
  if (status === 400) return 'Não foi possível promover: identificador inválido.';
  return GENERIC_ERROR;
}

const cityUf = (snapshot) => [textOf(snapshot.cidade), textOf(snapshot.estadoUf)].filter(Boolean).join('/');

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------

// document/root: onde desenhar. api: { listApprovals, approve, reject, promoteApproval } (api.mjs). canReview: mostra os
// botões de aprovar/rejeitar. canPromote: mostra "Promover para CRM" nos aprovados. canReadCrm: mostra "Ver no CRM".
// As três são conveniência de interface (vêm de /api/me); quem autoriza é o servidor.
export function createApprovalsView({ document, root, api, canReview, canPromote = false, canReadCrm = false }) {
  const state = { loading: true, items: [], selectedId: null, mode: null, busy: false, message: null, formError: null, filter: PENDING_ESTADO, promoted: {} };
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
      const data = await api.listApprovals(state.filter === PENDING_ESTADO ? undefined : state.filter);
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

  function setFilter(filter) {
    if (state.busy || state.filter === filter) return;
    state.filter = filter;
    state.items = [];
    state.selectedId = null;
    state.mode = null;
    state.formError = null;
    state.message = null;
    return load();
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

  // O id do registro do CRM que ESTE prospect já tem — só o que o servidor informou (a resposta da promoção ou o
  // item.promocao da fila). Nunca inventado nem montado a partir do nome.
  function promotedRecordId(item) {
    const fromResponse = Object.prototype.hasOwnProperty.call(state.promoted, item.prospectId) ? state.promoted[item.prospectId] : null;
    if (typeof fromResponse === 'string' && fromResponse !== '') return fromResponse;
    const promocao = item.promocao;
    if (promocao && typeof promocao === 'object' && promocao.resultado !== 'BLOQUEADO' && typeof promocao.crmRecordId === 'string' && promocao.crmRecordId !== '') {
      return promocao.crmRecordId;
    }
    return null;
  }

  async function confirmPromotion() {
    const item = selectedItem();
    // busy: um segundo clique (ou um botão antigo ainda na tela) nunca dispara uma segunda requisição.
    if (!item || state.mode !== 'promote' || state.busy || !canPromote || item.estado !== APPROVED_ESTADO) return;
    state.busy = true;
    state.message = null;
    render();
    try {
      const result = await api.promoteApproval(item.prospectId);
      const outcome = result && typeof result === 'object' ? result.outcome : null;
      const crmRecordId = result && typeof result === 'object' ? result.crmRecordId : null;
      if (!(PROMOTION_DONE.includes(outcome) || outcome === PROMOTION_ALREADY) || typeof crmRecordId !== 'string' || crmRecordId === '') {
        throw new Error('resposta inesperada');
      }
      state.promoted[item.prospectId] = crmRecordId;
      const base = outcome === PROMOTION_ALREADY ? ALREADY_PROMOTED_MESSAGE : PROMOTED_MESSAGE;
      setMessage('success', result.possivelDuplicidade === true ? `${base} Atenção: há sinal de possível duplicidade no CRM — confira o registro.` : base);
      state.busy = false;
      state.mode = null;
      await load();
    } catch (error) {
      state.busy = false;
      state.mode = null;
      setMessage('error', promotionMessageForError(error));
      if (error && error.status === 404) {
        state.selectedId = null;
        await load();
      } else if (error && error.status === 409) {
        await load();
      } else {
        render();
      }
    }
  }

  async function confirm() {
    if (state.mode === 'promote') return confirmPromotion();
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
    const approved = state.filter === APPROVED_ESTADO;
    if (state.loading && state.items.length === 0) return h(document, 'p', { className: 'muted', text: 'Carregando…' });
    if (state.items.length === 0) return h(document, 'p', { className: 'muted', text: approved ? 'Nenhum prospect aprovado.' : 'Nenhum prospect aguardando revisão.' });

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
      h(document, 'table', { className: 'list' }, h(document, 'caption', { className: 'visually-hidden', text: approved ? 'Prospects aprovados' : 'Prospects aguardando revisão' }), h(document, 'thead', {}, head), h(document, 'tbody', {}, ...rows))
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

  function renderPromotionConfirmation(item) {
    return h(
      document,
      'div',
      { className: 'confirm', role: 'group', 'aria-label': 'Confirmar promoção para o CRM' },
      h(document, 'h4', { text: 'Promover para o CRM' }),
      h(document, 'p', { text: `Prospect: ${textOf(item.empresa) || 'Sem nome'}` }),
      h(document, 'p', { text: PROMOTE_CONFIRM_TEXT }),
      h(
        document,
        'div',
        { className: 'actions' },
        h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Cancelar', disabled: state.busy, onclick: cancelConfirmation }),
        h(document, 'button', { type: 'button', className: 'btn primary', text: state.busy ? 'Promovendo…' : 'Promover', disabled: state.busy, onclick: confirm })
      )
    );
  }

  // As ações de um prospect já APROVADO na triagem: promover para o CRM (só com permissão) ou, se já foi promovido,
  // avisar e levar ao registro.
  function renderApprovedActions(item) {
    const recordId = promotedRecordId(item);
    if (recordId !== null) {
      return h(
        document,
        'div',
        { className: 'promotion' },
        h(document, 'p', { className: 'muted', text: ALREADY_PROMOTED_MESSAGE }),
        canReadCrm ? h(document, 'a', { className: 'btn secondary', href: buildHash({ name: 'crm-record', id: recordId }), text: 'Ver no CRM' }) : null
      );
    }
    if (!canPromote) return h(document, 'p', { className: 'muted', text: 'Sua conta não pode promover prospects para o CRM.' });
    if (state.mode === 'promote') return renderPromotionConfirmation(item);
    return h(
      document,
      'div',
      { className: 'actions' },
      h(document, 'button', { type: 'button', className: 'btn primary', text: 'Promover para CRM', disabled: state.busy, onclick: () => openConfirmation('promote') })
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
    } else if (item.estado === APPROVED_ESTADO) {
      actions = renderApprovedActions(item);
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
    const approvedView = state.filter === APPROVED_ESTADO;
    const pendingCount = state.items.filter((item) => item.estado === (approvedView ? APPROVED_ESTADO : PENDING_ESTADO)).length;
    const countText = approvedView ? `${pendingCount} ${pendingCount === 1 ? 'aprovado' : 'aprovados'}` : `${pendingCount} ${pendingCount === 1 ? 'pendente' : 'pendentes'}`;
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
          h(document, 'p', { className: 'pending-count', text: countText }),
          h(
            document,
            'div',
            { className: 'actions', role: 'group', 'aria-label': 'Filtrar por estado' },
            h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Pendentes', 'aria-pressed': approvedView ? 'false' : 'true', disabled: state.busy, onclick: () => setFilter(PENDING_ESTADO) }),
            h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Aprovados', 'aria-pressed': approvedView ? 'true' : 'false', disabled: state.busy, onclick: () => setFilter(APPROVED_ESTADO) })
          ),
          h(document, 'button', { type: 'button', className: 'btn secondary', text: 'Atualizar', disabled: state.busy || state.loading, onclick: refresh })
        ),
        state.message ? h(document, 'p', { className: `message ${state.message.kind}`, role: 'status', text: state.message.text }) : null,
        h(document, 'div', { className: 'approvals-body' }, h(document, 'div', { className: 'approvals-list' }, renderList()), h(document, 'div', { className: 'approvals-detail' }, renderDetail()))
      )
    );
  }

  return { load, render, state };
}
