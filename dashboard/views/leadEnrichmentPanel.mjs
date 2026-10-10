// Painel COMPLETAR PESQUISA (Implementação 3.0.2): o enriquecimento comercial APROFUNDADO, sob demanda, de UM lead — fica dentro da "Análise comercial" do perfil.
//
//   Browser -> este painel -> api.mjs -> GET  /api/leads/:id/completar-pesquisa   (estado)
//                                     -> POST /api/leads/:id/completar-pesquisa   (inicia a pesquisa dos campos PENDENTES; 202 na hora)
//
// A prospecção automática não chama o Claude para enriquecer: aqui a pessoa escolhe UM lead e o servidor pesquisa SÓ o que está ausente ou não verificado, reaproveitando o que já foi confirmado.
// O painel nunca bloqueia a leitura do perfil: a pesquisa roda em segundo plano no servidor e o painel só consulta o estado a cada poucos segundos. Uma execução por lead por vez (o botão fica
// desabilitado e o servidor recusa a segunda). Este painel NÃO decide nada sobre o lead: aprovar/rejeitar continua na Approval Queue, intocada.
//
// Dados NÃO CONFIÁVEIS: tudo entra por dom.mjs (textContent). A permissão é decidida pelo servidor; `canRun` só mostra/esconde o botão.

import { h, fill } from '../dom.mjs';
import { textOf, formatDateTime } from '../format.mjs';

const STATUS_LABELS = Object.freeze({ NAO_EXECUTADO: 'Não executado', EM_ANDAMENTO: 'Em andamento', COMPLETO: 'Completo', INCOMPLETO: 'Pesquisa incompleta', FALHOU: 'Falhou' });
const STATUS_TONES = Object.freeze({ NAO_EXECUTADO: 'neutral', EM_ANDAMENTO: 'warn', COMPLETO: 'ok', INCOMPLETO: 'warn', FALHOU: 'bad' });
const STAGE_LABELS = Object.freeze({ PREPARANDO: 'Preparando', PESQUISANDO: 'Pesquisando na web', VALIDANDO: 'Conferindo as informações', SALVANDO: 'Salvando' });
const FIELD_LABELS = Object.freeze({ siteOficial: 'site oficial', responsavel: 'responsável', endereco: 'endereço', telefones: 'telefones', whatsapps: 'WhatsApps', emails: 'e-mails', presencaDigital: 'presença digital', trafegoPago: 'tráfego pago', atividadeRecente: 'atividade recente' });
const SITE_REVIEW_LABELS = Object.freeze({ CONFIRMADO: 'Site confirmado', PROPOSTA_PENDENTE: 'Proposta de novo site pendente (o atual foi mantido)', ENCONTRADO: 'Site encontrado', SEM_COMPROVACAO: 'Sem comprovação suficiente (o site confirmado foi mantido)', FALHOU: 'Falhou' });
const POLL_MS = 2000;

const defaultSchedule = (fn, ms) => {
  const timer = globalThis.setTimeout(fn, ms);
  return () => globalThis.clearTimeout(timer);
};

const fieldsText = (list) => (Array.isArray(list) ? list : []).map((field) => FIELD_LABELS[field] || textOf(field)).filter(Boolean).join(', ');

const FIELD_ORDER = Object.freeze(Object.keys(FIELD_LABELS));
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
// Por que um campo está NÃO VERIFICADO (códigos do servidor -> texto para a pessoa). Um código desconhecido aparece como está (sem inventar explicação).
const REASON_LABELS = Object.freeze({
  OMITIDO_SEM_CONSULTA: 'o motor não trouxe o campo nem documentou onde procurou',
  FONTES_NAO_CONFIRMADAS: 'as fontes citadas pelo motor não puderam ser confirmadas',
  SEM_LEITURA_DE_PAGINA: 'não foi possível ler as fontes citadas',
  SEM_RESPOSTA_PARA_O_LEAD: 'o motor não respondeu para este lead',
  LIMITE_DE_TURNOS: 'a pesquisa foi cortada pelo limite de turnos',
  DESCARTADO_NA_VALIDACAO: 'o dado informado não passou na validação',
  FONTE_NAO_PERTINENTE_A_EMPRESA: 'a página lida não é da empresa (leitura genérica não comprova nada)',
  FONTE_NAO_PERTINENTE_AO_CAMPO: 'a página lida não é um lugar onde este campo apareceria',
  FONTE_NAO_APLICAVEL: 'este campo não se documenta por leitura de página',
  PAGINA_DE_LOGIN_OU_BLOQUEIO: 'a página era uma tela de login, bloqueio ou verificação (não comprova ausência de nada)',
  PAGINA_SEM_CONTEUDO: 'a página abriu quase vazia (tela genérica)',
  FONTE_PERTINENTE_MAS_INSUFICIENTE: 'a página é pertinente, mas uma página de terceiro não basta para concluir que não há o dado',
  CANDIDATO_SEM_VINCULO_COMPROVADO: 'a página mostra um candidato, mas o vínculo dele com a empresa não está comprovado',
  ERRO_NA_AVALIACAO: 'erro interno ao avaliar a fonte',
  LIMITE_DE_LEITURAS: 'o limite de leituras de verificação desta execução acabou antes de conferir este campo',
  ORIGEM_NAO_CONFIRMA_NOME_E_CARGO: 'a página citada não confirma nome e cargo',
  FORMATO_OU_ORIGEM_INVALIDOS: 'o dado informado tinha formato ou origem inválidos',
  PERFIL_INVALIDO: 'o perfil informado não é válido',
  PLATAFORMA_OU_URL_INVALIDA: 'a plataforma ou a URL da consulta eram inválidas',
  SEM_DATA_OU_CANAL_NAO_CONFIRMADO: 'sem data visível ou fora de um canal confirmado',
  PARCIAL: 'só parte do campo foi obtida',
  BLOQUEADO_POR_PRE_REQUISITO: 'bloqueado: confirme um canal oficial (Instagram, Facebook etc.) para poder pesquisar este campo (isto não é uma conclusão sobre o campo)',
  PENDENTE_DE_CONFIRMACAO: 'responsável encontrado, mas o vínculo da fonte com a empresa não está demonstrado (pendente de confirmação)',
  VINCULO_COM_A_EMPRESA_NAO_COMPROVADO: 'o vínculo da fonte com a empresa não foi comprovado',
  NAO_PESQUISADO: 'ainda não pesquisado',
  EXECUCAO_ANTERIOR_SEM_VERIFICACAO_REGISTRADA: 'a pesquisa anterior não registrou a verificação',
  TIMEOUT: 'tempo limite excedido',
  USAGE_LIMIT: 'limite de uso do Claude atingido',
  AGENT_ERROR: 'erro do motor',
  EXIT_NONZERO: 'o motor encerrou com erro',
  OUTPUT_INVALID: 'resposta do motor inutilizável',
  SPAWN_FAILED: 'o Claude não pôde ser iniciado',
  ERRO_INTERNO: 'erro interno',
});
const reasonText = (code) => (typeof code === 'string' && code !== '' ? REASON_LABELS[code] || textOf(code) : 'sem verificação registrada');
// O resultado de cada LEITURA de página (o que o leitor público informou, em código fixo)
const READ_LABELS = Object.freeze({
  OK: 'lida', ROBOTS: 'bloqueada pelo robots.txt', LOGIN: 'exige login', HTTP_403: 'acesso negado (403)', HTTP_429: 'muitas requisições (429)', BLOQUEADO: 'bloqueada', CAPTCHA: 'verificação anti-robô',
  TIMEOUT: 'tempo esgotado', REMOVIDA: 'não existe mais', FORA_DO_AR: 'fora do ar', ERRO: 'erro de leitura', EXCECAO_NA_LEITURA: 'exceção na leitura', SEM_TEXTO: 'sem texto', SEM_LEITURA_DE_PAGINA: 'sem leitor de páginas', NAO_TENTADA: 'não tentada (limite de leituras)',
});
const ENDING_LABELS = Object.freeze({ CONCLUIDA: 'concluída', LIMITE_DE_TURNOS: 'limite de turnos', SEM_RESPOSTA_PARA_O_LEAD: 'sem resposta para o lead', TIMEOUT: 'tempo limite', USAGE_LIMIT: 'limite de uso', ERRO_INTERNO: 'erro interno' });
const toolText = (value) => (Number.isInteger(value) ? String(value) : 'NÃO MEDIDO');

// O que o motor CITOU e o que o código fez com cada fonte: "endereço (leitura) → pertinência". Só URLs já reduzidas e códigos fixos; nada de conteúdo de página.
function attemptsText(entry) {
  const cited = Array.isArray(entry.citadas) ? entry.citadas.length : 0;
  const attempts = Array.isArray(entry.tentativas) ? entry.tentativas : [];
  if (cited === 0 && attempts.length === 0) return '';
  const parts = attempts.map((attempt) => {
    const read = READ_LABELS[attempt.leitura] || textOf(attempt.leitura);
    const cause = attempt.causa && attempt.causa !== attempt.leitura ? ` [${textOf(attempt.causa)}]` : '';
    const relevance = attempt.leitura === 'OK' && attempt.pertinencia && attempt.pertinencia !== 'PERTINENTE' ? ` · ${reasonText(attempt.pertinencia)}` : attempt.leitura === 'OK' && attempt.pertinencia === 'PERTINENTE' ? ' · pertinente' : '';
    const t = attempt.testes;
    const word = { PASSOU: 'passou', FALHOU: 'falhou', NAO_AVALIADO: 'não avaliado', SUFICIENTE: 'suficiente', INSUFICIENTE: 'insuficiente', NAO_AVALIADA: 'não avaliada' };
    const tests = t ? ` · testes: nome ${word[t.nome] || t.nome}, marcador ${word[t.marcador] || t.marcador}, conteúdo ${word[t.conteudo] || t.conteudo}, suficiência ${word[t.suficiencia] || t.suficiencia}${Number.isInteger(attempt.candidatos) ? `, candidatos ${attempt.candidatos}` : ''}` : '';
    return `${textOf(String(attempt.url).replace(/^https:\/\//, ''))} → ${read}${cause}${relevance}${tests}`;
  });
  return ` · fontes citadas pelo motor: ${cited}${parts.length > 0 ? ` · tentativas: ${parts.join('; ')}` : ' · nenhuma tentada'}`;
}

// O resultado de cada campo vem do servidor (`resolucao`). Sem ele (resposta de um servidor anterior), nada é afirmado como verificado: o que faltava fica NÃO VERIFICADO.
function fieldStates(info) {
  if (!info) return {};
  if (isObject(info.resolucao)) return info.resolucao;
  const out = {};
  for (const field of [...(Array.isArray(info.camposPendentes) ? info.camposPendentes : []), ...(Array.isArray(info.camposNaoEncontrados) ? info.camposNaoEncontrados : [])]) out[field] = { status: 'NAO_VERIFICADO', resolvido: false };
  return out;
}

// A linha de auditoria de UMA execução: duração, custo informado, turnos, ferramentas (NÃO MEDIDO quando o executor não informa), encerramento e fontes (novas x acumuladas).
function executionSummary(run) {
  const cost = typeof run.custoUsd === 'number' ? `custo informado pelo motor: US$ ${run.custoUsd.toFixed(2)}` : 'custo não informado';
  const tools = isObject(run.ferramentas) ? run.ferramentas : { webSearch: run.webSearchRequests, webFetch: null };
  const accumulated = Array.isArray(run.fontes) ? run.fontes.length : 0;
  const sources = Array.isArray(run.fontesNovas) ? `${run.fontesNovas.length} fonte(s) nova(s), ${accumulated} acumulada(s)` : `${accumulated} fonte(s) acumulada(s)`;
  return [
    `duração ${formatClock(run.duracaoMs)}`,
    cost,
    Number.isInteger(run.turnos) ? `${run.turnos} turno(s)` : 'turnos não informados',
    `WebSearch: ${toolText(tools.webSearch)} · WebFetch: ${toolText(tools.webFetch)}`,
    run.encerramento ? `encerramento: ${ENDING_LABELS[run.encerramento] || textOf(run.encerramento)}` : null,
    sources,
    run.origem === 'LEGADO' ? 'registro LEGADO (sem resultado por campo)' : null,
  ].filter(Boolean).join(' · ');
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function errorMessage(error) {
  const status = error && typeof error.status === 'number' ? error.status : null;
  if (error && error.code === 'ENRICH_BUSY') return 'Já existe uma pesquisa em andamento para outro lead. Aguarde ela terminar.';
  if (error && error.code === 'ENRICH_NOT_ALLOWED') return 'Este lead está em DNC (não contatar): a pesquisa não é permitida.';
  if (status === 409) return 'Já existe uma pesquisa em andamento para este lead.';
  if (status === 503) return 'O Claude não está disponível neste computador.';
  if (status === 403) return 'Sua conta não tem permissão para completar a pesquisa.';
  // 404 tem DUAS causas diferentes e a tela as distingue pelo `code` do servidor: o LEAD não existe na Approval Queue (ENRICH_NOT_FOUND) ou a ROTA não existe neste servidor (ROUTE_NOT_FOUND:
  // o processo em execução é anterior a esta função e precisa ser reiniciado). Nunca se diz "lead não encontrado" por uma rota ausente.
  if (error && error.code === 'ENRICH_NOT_FOUND') return 'Lead não encontrado na Approval Queue.';
  if (status === 404) return 'Esta função ainda não está disponível neste servidor (a versão em execução é anterior). Reinicie o servidor e recarregue a página.';
  return 'Não foi possível completar a pesquisa agora. Tente novamente em instantes.';
}

// api: { getLeadResearchStatus(id), completeLeadResearch(id) }. onFinished(): chamado quando uma pesquisa TERMINA (a tela recarrega o perfil). schedule(fn, ms) -> cancelar().
export function createEnrichmentPanel({ document, api, prospectId, canRun = true, onFinished = () => {}, schedule = defaultSchedule }) {
  const el = (tag, props, ...children) => h(document, tag, props, ...children);
  const element = el('div', { className: 'enrich-panel', id: 'enrich-panel', 'data-prospect': prospectId });
  const state = { info: null, busy: false, message: null, loaded: false, confirming: false };
  let cancelPoll = null;
  let destroyed = false;

  const running = () => Boolean(state.info) && state.info.status === 'EM_ANDAMENTO';

  function stopPolling() {
    if (cancelPoll) cancelPoll();
    cancelPoll = null;
  }

  function startPolling() {
    stopPolling();
    if (destroyed || !running()) return;
    cancelPoll = schedule(poll, POLL_MS);
  }

  async function poll() {
    cancelPoll = null;
    if (destroyed) return;
    const wasRunning = running();
    try {
      const data = await api.getLeadResearchStatus(prospectId);
      state.info = data && data.item ? data.item : state.info;
    } catch {
      // uma consulta que falha não derruba o painel: tenta de novo no próximo ciclo
    }
    render();
    if (running()) {
      startPolling();
      return;
    }
    if (wasRunning) onFinished(state.info);
  }

  async function load() {
    try {
      const data = await api.getLeadResearchStatus(prospectId);
      state.info = data && data.item ? data.item : null;
      state.message = null;
    } catch (error) {
      state.message = { kind: 'error', text: errorMessage(error) };
    }
    state.loaded = true;
    render();
    startPolling();
  }

  // O botão: na PRIMEIRA pesquisa inicia direto; depois de uma tentativa anterior, mostra o custo e a duração dela e só inicia com a confirmação explícita (nunca automática).
  async function onComplete() {
    if (state.busy || running()) return undefined;
    if (state.info && state.info.ultimaExecucao) {
      state.confirming = true;
      state.message = null;
      render();
      return undefined;
    }
    return startAction(() => api.completeLeadResearch(prospectId));
  }

  async function onConfirm() {
    state.confirming = false;
    return startAction(() => api.completeLeadResearch(prospectId));
  }

  function onCancelConfirm() {
    state.confirming = false;
    render();
  }

  async function onReviewSite() {
    return startAction(() => api.reviewLeadSite(prospectId));
  }

  // CONFIRMAR ALTERAÇÃO / MANTER SITE ATUAL: decisão humana sobre a proposta (nenhuma pesquisa). Ao decidir, o perfil é recarregado.
  async function decide(decisao) {
    if (state.busy || running()) return;
    state.busy = true;
    state.message = null;
    render();
    try {
      const data = await api.decideLeadSiteProposal(prospectId, decisao);
      state.info = data && data.item ? data.item : state.info;
      state.message = { kind: 'info', text: decisao === 'CONFIRMAR' ? 'Alteração confirmada: o novo domínio passou a ser o site oficial.' : 'O site atual foi mantido e a proposta foi descartada.' };
      state.busy = false;
      render();
      onFinished(state.info);
      return;
    } catch (error) {
      state.message = { kind: 'error', text: error && error.code === 'ENRICH_NO_PROPOSAL' ? 'Esta proposta já foi decidida.' : errorMessage(error) };
      try {
        const data = await api.getLeadResearchStatus(prospectId);
        state.info = data && data.item ? data.item : state.info;
      } catch {
        // mantém o que a tela já tinha
      }
    }
    state.busy = false;
    render();
  }

  async function startAction(call) {
    if (state.busy || running()) return;
    state.busy = true;
    state.message = null;
    render();
    try {
      const data = await call();
      state.info = data && data.item ? data.item : state.info;
      if (state.info && state.info.mensagem && state.info.status !== 'EM_ANDAMENTO') state.message = { kind: 'info', text: state.info.mensagem };
      startPolling();
    } catch (error) {
      state.message = { kind: 'error', text: errorMessage(error) };
    }
    state.busy = false;
    render();
  }

  function render() {
    if (destroyed) return;
    const info = state.info;
    const status = info ? info.status : 'NAO_EXECUTADO';
    const unavailable = info && info.disponivel === false;
    const pending = info && Array.isArray(info.camposPendentes) ? info.camposPendentes : [];
    const last = info && info.ultimaExecucao ? info.ultimaExecucao : null;
    const canClick = canRun && !state.busy && !running() && Boolean(info) && info.podeCompletar === true;
    const states = fieldStates(info);

    const nodes = [
      el('div', { className: 'enrich-head' },
        el('strong', { text: 'Pesquisa comercial' }),
        ' ',
        el('span', { className: `badge ${STATUS_TONES[status] || 'neutral'}`, id: 'enrich-status', text: STATUS_LABELS[status] || 'Não executado' })
      ),
    ];
    if (running()) {
      nodes.push(
        el('progress', { className: 'pipeline-bar', id: 'enrich-progress', 'aria-label': 'Pesquisa em andamento' }),
        el('p', { className: 'muted', id: 'enrich-elapsed', text: `${info.tipo === 'REVISAO_SITE' ? 'Revisando o site oficial · ' : ''}${STAGE_LABELS[info.etapa] || 'Pesquisando'} · ${formatClock(info.elapsedMs)}` }),
        info.camposSolicitados && info.camposSolicitados.length > 0 ? el('p', { className: 'muted', text: `Pesquisando: ${fieldsText(info.camposSolicitados)}` }) : null
      );
    } else {
      // O RESULTADO DE CADA CAMPO — nunca um "completo" genérico: encontrado, não encontrado COM a verificação documentada, ou não verificado (e por quê)
      const found = FIELD_ORDER.filter((field) => states[field] && states[field].status === 'ENCONTRADO' && !states[field].parcial);
      const documented = FIELD_ORDER.filter((field) => states[field] && states[field].status === 'NAO_ENCONTRADO_COM_VERIFICACAO' && states[field].resolvido);
      const unverified = FIELD_ORDER.filter((field) => states[field] && (states[field].status === 'NAO_VERIFICADO' || (states[field].resolvido === false && states[field].status !== 'ENCONTRADO')));
      const hasFieldData = Boolean(info) && (isObject(info.resolucao) || documented.length > 0 || pending.length > 0);
      if (hasFieldData && info && status !== 'NAO_EXECUTADO' && found.length > 0) nodes.push(el('p', { id: 'enrich-found', text: `Encontrado: ${fieldsText(found)}` }));
      if (documented.length > 0) {
        nodes.push(
          el('p', { id: 'enrich-notfound', text: `Não encontrado após verificação documentada: ${fieldsText(documented)}` }),
          el('p', { className: 'muted', text: 'Isso não prova que a informação não exista: só que, nas fontes consultadas e lidas, ela não apareceu.' })
        );
      }
      if (pending.length > 0) nodes.push(el('p', { id: 'enrich-pending', text: `Campos que ainda podem ser pesquisados: ${fieldsText(pending)}` }));
      const detail = FIELD_ORDER.filter((field) => states[field] && (documented.includes(field) || unverified.includes(field)));
      if (detail.length > 0 && isObject(info && info.resolucao)) {
        nodes.push(
          el('ul', { className: 'muted', id: 'enrich-fields' },
            ...detail.map((field) => {
              const entry = states[field];
              const sources = Array.isArray(entry.fontes) && entry.fontes.length > 0 ? ` · fontes lidas: ${entry.fontes.map((url) => textOf(url)).join(', ')}` : '';
              return el('li', { 'data-field': field, text: `${entry.status === 'NAO_ENCONTRADO_COM_VERIFICACAO' ? `${FIELD_LABELS[field] || field}: não encontrado após verificação${sources}` : `${FIELD_LABELS[field] || field}: não verificado — ${reasonText(entry.motivo)}${entry.origem === 'LEGADO' ? ' (registro LEGADO)' : ''}`}${attemptsText(entry)}` });
            })
          )
        );
      }
      if (info && info.statusRegistrado === 'COMPLETO') {
        nodes.push(el('p', { className: 'notice warn', role: 'note', id: 'enrich-legacy', text: 'Esta pesquisa foi registrada como Completa, mas o registro não guardou a verificação dos campos que faltam (registro LEGADO). Eles estão NÃO VERIFICADOS.' }));
      } else if (info && status === 'INCOMPLETO') {
        nodes.push(el('p', { className: 'notice warn', role: 'note', id: 'enrich-incomplete', text: 'Pesquisa incompleta: há campos sem encontrar nem verificar.' }));
      }
      if (info && info.limiteDeTurnos) nodes.push(el('p', { className: 'muted', text: last && last.limiteNaoConfirmado ? 'Limite de turnos registrado por contagem (o motor não confirmou o desfecho): pode ter sido um término normal.' : 'Limite de turnos do motor atingido.' }));
      const blockedList = info && Array.isArray(info.bloqueios) ? info.bloqueios : [];
      if (blockedList.length > 0) nodes.push(el('p', { className: 'notice warn', role: 'note', id: 'enrich-blocked-prereq', text: `${fieldsText(blockedList.map((entry) => entry.campo))}: bloqueado por pré-requisito. ${textOf(blockedList[0].mensagem)}` }));
      if (info && info.mensagem && (status === 'FALHOU' || status === 'INCOMPLETO')) nodes.push(el('p', { className: 'notice bad', role: 'note', id: 'enrich-error', text: info.mensagem }));
      if (info && info.bloqueio === 'DNC') nodes.push(el('p', { className: 'notice bad', role: 'note', id: 'enrich-blocked', text: info.mensagem }));
      if (unavailable) nodes.push(el('p', { className: 'notice bad', role: 'note', id: 'enrich-unavailable', text: 'O Claude não está disponível neste computador. A pesquisa comercial não pode ser executada agora.' }));
      if (last) nodes.push(el('p', { className: 'muted', id: 'enrich-last', text: `Última pesquisa: ${formatDateTime(last.iniciadoEm)} · ${executionSummary(last)}` }));
    }
    const review = info && info.revisaoSite && info.revisaoSite.ultimaRevisao ? info.revisaoSite : null;
    if (!running() && review) {
      const r = review.ultimaRevisao;
      const label = SITE_REVIEW_LABELS[r.resultado] || textOf(r.resultado);
      nodes.push(
        el('p', { id: 'enrich-site-review', text: `Revisão do site oficial: ${label} · ${formatDateTime(r.concluidoEm || r.iniciadoEm)}${typeof r.custoUsd === 'number' ? ` · custo informado pelo motor: US$ ${r.custoUsd.toFixed(2)}` : ''}` }),
        r.mensagem ? el('p', { className: 'muted', text: textOf(r.mensagem) }) : null,
        Array.isArray(r.fontes) && r.fontes.length > 0 ? el('p', { className: 'muted', id: 'enrich-site-sources', text: `Fontes conferidas: ${r.fontes.map((f) => textOf(f)).join(' · ')}` }) : null,
        r.alternativo ? el('p', { className: 'muted', text: `Site alternativo comprovado: ${textOf(r.alternativo)}` }) : null,
        r.siteAnterior ? el('p', { className: 'muted', text: `Site anterior (registrado): ${textOf(r.siteAnterior)}` }) : null
      );
    } else if (!running() && info && info.revisaoSite && info.revisaoSite.status === 'FALHOU' && info.revisaoSite.mensagem) {
      nodes.push(el('p', { className: 'notice bad', role: 'note', id: 'enrich-site-error', text: info.revisaoSite.mensagem }));
    }
    // PROPOSTA PENDENTE de novo domínio: as evidências dos dois lado a lado e a decisão humana. O site atual só muda com CONFIRMAR ALTERAÇÃO.
    const proposal = info && info.propostaSite && info.propostaSite.status === 'PENDENTE' ? info.propostaSite : null;
    if (!running() && proposal) {
      const evidenceText = (evidence) => {
        const e = evidence || {};
        const link = e.vinculo ? `vínculo: domínio ${e.vinculo.dominio ? 'sim' : 'não'}, título ${e.vinculo.titulo ? 'sim' : 'não'}` : '';
        return [e.comprovado ? 'vínculo com a empresa comprovado' : `não comprovado${e.motivo ? ` (${textOf(e.motivo)})` : ''}`, link, e.titulo ? `título da página: "${textOf(e.titulo)}"` : '', e.regra ? `regra: ${textOf(e.regra)}` : ''].filter(Boolean).join(' · ');
      };
      nodes.push(
        el('div', { className: 'notice warn', id: 'enrich-site-proposal', role: 'group', 'aria-label': 'Proposta de novo site oficial' },
          el('strong', { text: 'Proposta de novo site oficial (pendente)' }),
          el('p', { id: 'enrich-proposal-current', text: `Site atual: ${textOf(proposal.dominioAtual)} — ${evidenceText(proposal.evidencias && proposal.evidencias.atual)}` }),
          el('p', { id: 'enrich-proposal-new', text: `Site proposto: ${textOf(proposal.dominioNovo)} — ${evidenceText(proposal.evidencias && proposal.evidencias.novo)}` }),
          el('p', { className: 'muted', text: `Fontes conferidas: ${(proposal.fontes || []).map((f) => textOf(f)).join(' · ')}` }),
          el('p', { className: 'muted', text: 'O site atual continua valendo até uma confirmação. Decidir não faz nova pesquisa e não altera a decisão do lead.' }),
          canRun
            ? el('div', { className: 'actions' },
                el('button', { type: 'button', className: 'btn primary', id: 'enrich-site-confirm', disabled: state.busy || info.podeDecidirSite !== true, onclick: () => decide('CONFIRMAR'), text: 'CONFIRMAR ALTERAÇÃO' }),
                el('button', { type: 'button', className: 'btn secondary', id: 'enrich-site-keep', disabled: state.busy || info.podeDecidirSite !== true, onclick: () => decide('MANTER'), text: 'MANTER SITE ATUAL' })
              )
            : null
        )
      );
    }
    const lastDecision = info && Array.isArray(info.decisoesSite) && info.decisoesSite.length > 0 ? info.decisoesSite[info.decisoesSite.length - 1] : null;
    if (!running() && lastDecision && lastDecision.decisao !== 'SUBSTITUIDA') {
      const who = lastDecision.usuario ? textOf(lastDecision.usuario.name) : '';
      nodes.push(el('p', { className: 'muted', id: 'enrich-site-decision', text: `Decisão sobre o site: ${lastDecision.decisao === 'CONFIRMADA' ? 'alteração confirmada' : 'site atual mantido'}${who ? ` por ${who}` : ''} em ${formatDateTime(lastDecision.data)} (${textOf(lastDecision.dominioAnterior)} → ${textOf(lastDecision.dominioNovo)})` }));
    }
    if (state.message) nodes.push(el('p', { className: `message ${state.message.kind === 'error' ? 'error' : 'info'}`, role: state.message.kind === 'error' ? 'alert' : 'status', id: 'enrich-message', text: state.message.text }));
    // NOVA TENTATIVA: se já houve uma pesquisa, a pessoa vê o custo e a duração dela e CONFIRMA antes de gastar de novo; nunca começa sozinha
    if (canRun && state.confirming && !running() && last) {
      nodes.push(
        el('div', { className: 'notice warn', id: 'enrich-confirm', role: 'group', 'aria-label': 'Confirmar nova pesquisa' },
          el('strong', { text: 'Confirmar nova pesquisa' }),
          el('p', { id: 'enrich-confirm-previous', text: `Tentativa anterior: ${formatDateTime(last.iniciadoEm)} · ${executionSummary(last)}` }),
          el('p', { id: 'enrich-confirm-fields', text: `Será pesquisado somente: ${fieldsText(pending)}` }),
          el('p', { className: 'muted', text: 'A pesquisa roda em segundo plano, uma de cada vez, e não altera a decisão do lead nem a Approval Queue.' }),
          el('div', { className: 'actions' },
            el('button', { type: 'button', className: 'btn primary', id: 'enrich-confirm-run', disabled: !canClick, onclick: onConfirm, text: 'CONFIRMAR NOVA PESQUISA' }),
            el('button', { type: 'button', className: 'btn secondary', id: 'enrich-confirm-cancel', disabled: state.busy, onclick: onCancelConfirm, text: 'CANCELAR' })
          )
        )
      );
    }
    if (canRun) {
      nodes.push(el('button', { type: 'button', className: 'btn primary', id: 'enrich-run', disabled: !canClick || state.confirming, onclick: onComplete, text: last ? 'PESQUISAR CAMPOS NÃO VERIFICADOS' : 'COMPLETAR PESQUISA' }));
      nodes.push(el('button', { type: 'button', className: 'btn secondary', id: 'enrich-review-site', disabled: !(canRun && !state.busy && !running() && Boolean(info) && info.podeRever === true), onclick: onReviewSite, text: 'REVER SITE OFICIAL' }));
      if (pending.length === 0 && last) nodes.push(el('p', { className: 'muted', text: 'Todos os campos estão resolvidos (encontrados ou verificados). Não há o que pesquisar de novo.' }));
      else if (pending.length > 0 && last) nodes.push(el('p', { className: 'muted', text: 'Uma nova tentativa pesquisa somente os campos não verificados, só começa depois da sua confirmação e não é automática.' }));
    }
    fill(element, ...nodes);
  }

  render();
  // pause(): para a consulta de estado (a gaveta fechou); load() a retoma se a pesquisa ainda estiver rodando.
  return { element, load, render, pause: stopPolling, destroy() { destroyed = true; stopPolling(); } };
}
