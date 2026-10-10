// O DETALHE de uma prospecção (job) — compartilhado pelo Histórico de prospecções e pela Nova Prospecção: as constantes e funções puras (indicadores reais,
// classificação dos candidatos, motivos) e a montagem das quatro abas da gaveta (Resumo, Candidatos, Resultados e Auditoria). Aqui não há regra de negócio nem
// chamada de API: recebe o job que o servidor já devolveu e só o APRESENTA — nada é inventado, e o que o servidor não informou aparece como "—".
//
// DUAS POPULAÇÕES, NUNCA MISTURADAS: os CANDIDATOS descartados durante a prospecção (não validados pela página, exclusão permanente, validados mas retidos
// por dados insuficientes/DNC/duplicidade) vivem só no job; os LEADS entregues à Approval Queue são outra coisa, e só estes podem ser aprovados ou REJEITADOS
// POR UMA PESSOA (decisão humana, com contadores vindos da fila). "Não validado" nunca é "rejeitado": ninguém decidiu nada.
//
// Dados NÃO CONFIÁVEIS (pesquisa na web): tudo entra por dom.mjs (textContent); só URLs http(s), sempre com rel="noopener noreferrer".

import { h } from '../dom.mjs';
import { textOf, formatDateTime, safeHttpUrl } from '../format.mjs';
import { buildHash } from '../router.mjs';
import { buildJobSummary, LEAD_TYPE_LABELS } from './leadProfile.mjs';
import { statusBadge, emptyState, kvList, section, selectField, createTabs } from '../ui/index.mjs';

export const JOB_STATUS_LABELS = Object.freeze({ CRIADO: 'Criada', EXECUTANDO: 'Em execução', CANCELAMENTO_SOLICITADO: 'Cancelando…', CANCELADO: 'Cancelada', CONCLUIDO: 'Concluída', PARCIAL: 'Parcial', ERRO: 'Falhou' });
export const JOB_TONES = Object.freeze({ CRIADO: 'warn', EXECUTANDO: 'warn', CANCELAMENTO_SOLICITADO: 'warn', CANCELADO: 'bad', CONCLUIDO: 'ok', PARCIAL: 'warn', ERRO: 'bad' });
export const ACTIVE = Object.freeze(['CRIADO', 'EXECUTANDO', 'CANCELAMENTO_SOLICITADO']);
export const JOB_ERROR_TEXT = Object.freeze({
  DISCOVERY_FAILED: 'Não foi possível descobrir empresas. A prospecção não chegou a validar candidatos.',
  JOB_INTERRUPTED: 'A prospecção foi interrompida (o servidor foi reiniciado). Você pode refazê-la.',
  INGESTION_FAILED: 'As empresas foram validadas, mas não puderam ser enviadas para a aprovação. Nada foi promovido ao CRM.',
  JOB_INTERNAL: 'A prospecção falhou por um erro interno.',
});
export const STEP_LABELS = Object.freeze({ PREPARANDO: 'Preparando', DESCOBRINDO: 'Descobrindo empresas na web', VALIDANDO: 'Validando as páginas das empresas', INGERINDO: 'Enviando para a aprovação', FINALIZADO: 'Finalizado' });

// Por que um candidato NÃO foi validado (vocabulário fechado do job) e a causa técnica quando a página não abriu.
export const REASON_LABELS = Object.freeze({
  EXCLUSAO_PERMANENTE: 'Está nas exclusões permanentes',
  EXCLUSAO_NAO_CONSULTADA: 'A lista de exclusões permanentes não pôde ser consultada',
  URL_INVALIDA: 'Endereço inválido',
  SEM_FONTE_VERIFICAVEL: 'Nenhuma página legível para conferir',
  PAGINA_INACESSIVEL: 'As páginas tentadas não abriram',
  EVIDENCIA_INCOMPLETA: 'A página abriu, mas faltou comprovar dados da empresa',
  VALIDACAO_FALHOU: 'A validação não foi concluída',
});
const CAUSE_LABELS = Object.freeze({ DNS: 'o endereço não foi encontrado', TLS: 'falha na conexão segura', RESPOSTA_GRANDE: 'a página era grande demais', DESAFIO_NA_PAGINA: 'a página pediu uma verificação anti-robô' });
const ASPECT_LABELS = Object.freeze({ empresa: 'empresa', nicho: 'nicho', localizacao: 'localização' });
const HELD_LABELS = Object.freeze({ DADOS_INSUFICIENTES: 'Dados insuficientes', DNC: 'Não contatar (DNC)', DUPLICADO: 'Duplicado', REPETIDO_NA_SUBMISSAO: 'Repetido nesta submissão' });
const CHANNEL_LABELS = Object.freeze({ instagram: 'Instagram', facebook: 'Facebook', googleMeuNegocio: 'Google Meu Negócio', linkedin: 'LinkedIn', youtube: 'YouTube', tiktok: 'TikTok', whatsapp: 'WhatsApp' });
const LEAD_TYPE_FILTERS = Object.freeze(['TODOS', 'EMPRESA', 'PROFISSIONAL', 'UNIDADE_FRANQUIA', 'NAO_VERIFICADO']);

// Os grupos de candidatos: cada candidato cai em UM só grupo (os mesmos nomes na gaveta e nos contadores).
export const GROUPS = Object.freeze([
  ['ENTREGUE', 'Entregues à Approval Queue', 'ok'],
  ['JA_EXISTIA', 'Já estavam na fila', 'neutral'],
  ['RETIDO', 'Validados, retidos fora da fila', 'warn'],
  ['NAO_VALIDADO', 'Não validados', 'neutral'],
  ['DESCARTADO', 'Descartados por exclusão permanente', 'bad'],
  ['SEM_ENTREGA', 'Validados, sem registro de entrega', 'warn'],
  ['NAO_PROCESSADO', 'Ainda não processados', 'neutral'],
]);
const GROUP_LABEL = Object.freeze(Object.fromEntries(GROUPS.map(([key, label]) => [key, label])));
const GROUP_TONE = Object.freeze(Object.fromEntries(GROUPS.map(([key, , tone]) => [key, tone])));
// o selo de UM candidato (singular); os grupos acima, no plural, são os títulos e os filtros
const GROUP_BADGE = Object.freeze({ ENTREGUE: 'Entregue à fila', JA_EXISTIA: 'Já estava na fila', RETIDO: 'Retido fora da fila', NAO_VALIDADO: 'Não validado', DESCARTADO: 'Descartado', SEM_ENTREGA: 'Sem registro de entrega', NAO_PROCESSADO: 'Não processado' });

const int = (value) => (Number.isInteger(value) ? value : null);
export const num = (value) => (value === null || value === undefined ? '—' : String(value));
export const isActive = (job) => ACTIVE.includes(job && job.status);

// Achar um elemento por id dentro de um contêiner (a gaveta é reconstruída; o foco volta ao filtro que a pessoa usava).
export function findById(container, id) {
  const stack = [container];
  while (stack.length > 0) {
    const node = stack.pop();
    for (const child of node.childNodes || []) {
      if (child.nodeType !== 1) continue;
      if (child.id === id) return child;
      stack.push(child);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Funções puras (exportadas para teste)
// ---------------------------------------------------------------------------

// A localidade de um brief, em texto; só o que o brief informa.
export function briefPlace(brief) {
  if (!brief || typeof brief !== 'object') return '';
  if (brief.nivelGeografico === 'CIDADE') return (Array.isArray(brief.cidades) ? brief.cidades : []).map(textOf).filter(Boolean).join(', ');
  if (brief.nivelGeografico === 'ESTADO') return (Array.isArray(brief.estados) ? brief.estados : []).map(textOf).filter(Boolean).join(', ');
  return brief.nivelGeografico ? textOf(brief.pais) || 'Brasil' : '';
}

// Os indicadores REAIS de um job (o que o servidor mediu); `null` = o servidor não informou (a tela mostra "—", nunca um zero inventado).
//   encontrados: candidatos que a descoberta trouxe · validados: comprovados pela página · naFila: o que ESTE job entregou à Approval Queue
//   descartados: não validados + validados retidos fora da fila (dados insuficientes, DNC, duplicado) — "já existentes" e "repetidos" NÃO são descartes.
export function jobIndicators(job) {
  const resumo = job && job.resumo && typeof job.resumo === 'object' ? job.resumo : {};
  const pick = (a, b) => (int(a) !== null ? a : int(b));
  const naoValidados = pick(resumo.naoValidados, job && job.candidatesRejected);
  const parts = [resumo.dadosInsuficientes, resumo.duplicados, resumo.dnc].map(int);
  const lote = job && job.lote && typeof job.lote === 'object' ? job.lote : {};
  // sem o resumo (job antigo ou ainda em andamento), o que o lote já registrou: os mesmos números que o servidor usa para montar o resumo
  const retidos = parts.every((value) => value !== null) ? parts.reduce((total, value) => total + value, 0) : int(lote.foraDaFila);
  return {
    solicitados: pick(resumo.solicitados, job && job.requestedQuantity),
    encontrados: pick(resumo.descobertos, job && job.candidatesDiscovered),
    processados: int(resumo.candidatosProcessados),
    validados: pick(resumo.validados, job && job.candidatesValidated),
    naFila: int(resumo.naApprovalQueue) !== null ? resumo.naApprovalQueue : pick(lote.naFila, job && job.leadsNaFila),
    naoValidados,
    retidos,
    descartados: naoValidados !== null && retidos !== null ? naoValidados + retidos : naoValidados,
    jaExistentes: int(resumo.jaExistentes),
    repetidos: int(resumo.repetidos),
    aprovados: int(resumo.aprovados),
    rejeitados: int(resumo.rejeitados),
    promovidos: int(resumo.promovidos),
  };
}

// Onde UM candidato terminou — um grupo só. Nunca chama de "rejeitado" quem não foi validado: rejeitar é decisão de uma pessoa sobre um lead da fila.
export function classifyCandidate(candidate) {
  const delivery = candidate && candidate.entrega && typeof candidate.entrega === 'object' ? candidate.entrega : null;
  if (delivery) {
    if (delivery.naFila === true) return 'ENTREGUE';
    if (delivery.jaExistiaNaFila === true) return 'JA_EXISTIA';
    return 'RETIDO';
  }
  if (!candidate || !candidate.resultado) return 'NAO_PROCESSADO';
  if (candidate.resultado === 'DESCARTADO') return 'DESCARTADO';
  if (candidate.resultado === 'NAO_VERIFICADO') return 'NAO_VALIDADO';
  return 'SEM_ENTREGA';
}

// O texto do porquê, só com o que o job registrou (motivo, causa técnica, o que faltou comprovar, estado retido).
export function candidateDetail(candidate) {
  const group = classifyCandidate(candidate);
  const lines = [];
  if (group === 'RETIDO') {
    const state = candidate.entrega && typeof candidate.entrega.estadoOperacional === 'string' ? candidate.entrega.estadoOperacional : null;
    lines.push(state ? HELD_LABELS[state] || state : 'Retido fora da fila (motivo não informado)');
  }
  const reason = textOf(candidate && candidate.motivo);
  if (reason !== '' && group !== 'ENTREGUE') lines.push(REASON_LABELS[reason] || reason);
  const cause = textOf(candidate && candidate.causa);
  if (cause !== '') lines.push(`causa: ${CAUSE_LABELS[cause] || cause}`);
  const missing = Array.isArray(candidate && candidate.faltando) ? candidate.faltando.map((aspect) => ASPECT_LABELS[aspect] || textOf(aspect)).filter(Boolean) : [];
  if (missing.length > 0) lines.push(`faltou comprovar: ${missing.join(', ')}`);
  return lines;
}

// Os canais públicos CONFIRMADOS da empresa, em texto ("Instagram, Facebook"); '' se nenhum.
export function confirmedChannels(presence) {
  if (!presence || typeof presence !== 'object') return '';
  return Object.keys(CHANNEL_LABELS).filter((canal) => presence[canal] && presence[canal].confirmacao === 'CONFIRMADO').map((canal) => CHANNEL_LABELS[canal]).join(', ');
}

// ---------------------------------------------------------------------------
// As abas da gaveta
// ---------------------------------------------------------------------------

// getBrief(job): o brief do job (ou null). liveNote: o aviso do Resumo enquanto o job roda ("esta lista..."/"esta tela..."). onFilterChange(selectId): a tela dona
// reconstrói a gaveta (o filtro ficou guardado aqui) e devolve o foco ao filtro. Sem estado de negócio: só o filtro de candidatos.
export function createJobDetails({ document, getBrief = () => null, liveNote = 'Esta tela se atualiza sozinha enquanto a prospecção roda.', onFilterChange = () => {} }) {
  const filters = { group: 'TODOS', type: 'TODOS' };
  const badge = (text, tone) => statusBadge(document, text, tone);
  const indicator = (label, value, hint = '') =>
    h(document, 'div', { className: 'indicator indicator-number' }, h(document, 'span', { className: 'indicator-label', text: label }), h(document, 'span', { className: 'indicator-value', text: num(value) }), hint ? h(document, 'span', { className: 'indicator-hint muted', text: hint }) : null);
  const field = (label, node) => [label, node];
  const textNode = (value) => (textOf(value) === '' ? null : h(document, 'span', { text: textOf(value) }));
  const clock = (ms) => {
    if (!Number.isFinite(ms)) return null;
    const total = Math.max(0, Math.floor(ms / 1000));
    return h(document, 'span', { text: `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` });
  };
  const link = (url, label) => {
    const safe = safeHttpUrl(url);
    return safe ? h(document, 'a', { href: safe, target: '_blank', rel: 'noopener noreferrer', text: label || safe }) : null;
  };

  function summaryTab(job, brief) {
    const ind = jobIndicators(job);
    const when = formatDateTime(job.startedAt || job.createdAt);
    const situation = [h(document, 'div', { className: 'decision-head' }, badge(JOB_STATUS_LABELS[job.status] || textOf(job.status) || '—', JOB_TONES[job.status] || 'neutral'), h(document, 'span', { className: 'decision-date', text: when ? `Iniciada em ${when}` : 'Data não registrada' }))];
    if (isActive(job)) situation.push(h(document, 'p', { className: 'muted', text: `${STEP_LABELS[job.currentStep] || 'Em andamento'}. ${liveNote}` }));
    if (job.status === 'ERRO') situation.push(h(document, 'p', { className: 'notice bad', role: 'note', text: JOB_ERROR_TEXT[job.error && job.error.code] || JOB_ERROR_TEXT.JOB_INTERNAL }));
    if (job.status === 'PARCIAL') situation.push(h(document, 'p', { className: 'muted', text: 'A quantidade pedida não foi atingida: nenhuma empresa fraca foi incluída para completar.' }));
    if (job.status === 'CANCELADO') situation.push(h(document, 'p', { className: 'muted', text: 'A prospecção foi cancelada antes de terminar. O que já tinha sido entregue à Approval Queue continua lá.' }));

    const funnel = h(
      document,
      'div',
      { className: 'indicator-grid' },
      indicator('Encontrados', ind.encontrados, 'candidatos trazidos pela descoberta'),
      indicator('Validados', ind.validados, 'comprovados pela página'),
      indicator('Entregues à fila', ind.naFila, ind.solicitados === null ? 'na Approval Queue' : `de ${ind.solicitados} solicitados`),
      indicator('Descartados', ind.descartados, 'não validados + retidos fora da fila')
    );
    const notLeads = [];
    if (ind.jaExistentes !== null && ind.jaExistentes > 0) notLeads.push(`${ind.jaExistentes} já existia(m) na fila ou no CRM`);
    if (ind.repetidos !== null && ind.repetidos > 0) notLeads.push(`${ind.repetidos} repetido(s)`);

    const decisions = h(
      document,
      'div',
      { className: 'indicator-grid' },
      indicator('Aprovados', ind.aprovados, 'por uma pessoa'),
      indicator('Rejeitados por uma pessoa', ind.rejeitados, 'decisão humana na fila'),
      indicator('Promovidos ao CRM', ind.promovidos, 'por uma pessoa')
    );
    const nav = [];
    if (ind.naFila !== null && ind.naFila > 0) nav.push(h(document, 'a', { className: 'btn secondary', href: buildHash({ name: 'approvals' }), text: 'Abrir a Approval Queue' }));
    if (ind.rejeitados !== null && ind.rejeitados > 0) nav.push(h(document, 'a', { className: 'btn secondary', href: buildHash({ name: 'rejected-leads' }), text: 'Ver em Leads Reprovados' }));

    const briefing = kvList(document, [
      field('Nicho', textNode(brief && brief.nicho)),
      field('Localidade', textNode(briefPlace(brief))),
      field('Quantidade pedida', ind.solicitados === null ? null : h(document, 'span', { text: String(ind.solicitados) })),
      field('Observações do briefing', textNode(brief && brief.observacoes)),
      field('Refeita a partir de', textNode(job.refeitoDe)),
    ]);
    const dates = kvList(document, [
      field('Criada em', textNode(formatDateTime(job.createdAt))),
      field('Iniciada em', textNode(formatDateTime(job.startedAt))),
      field('Concluída em', textNode(formatDateTime(job.finishedAt))),
      field('Duração', clock(job.elapsedMs)),
      field('Iniciada por', job.criadoPor && typeof job.criadoPor === 'object' ? textNode([textOf(job.criadoPor.name), textOf(job.criadoPor.role) ? `(${textOf(job.criadoPor.role)})` : ''].filter(Boolean).join(' ')) : null),
    ]);
    return h(
      document,
      'div',
      { className: 'lead-summary' },
      section(document, 'Situação', ...situation),
      section(document, 'Funil da prospecção', funnel, notLeads.length > 0 ? h(document, 'p', { className: 'muted', text: `Fora das contas acima (não são entregas novas nem descartes): ${notLeads.join('; ')}.` }) : null),
      section(document, 'Decisões humanas sobre os leads entregues', decisions, h(document, 'p', { className: 'muted', text: 'Só um lead entregue à Approval Queue pode ser aprovado ou rejeitado por uma pessoa. Candidato não validado nunca foi decidido por ninguém: não passou pela validação automática.' }), nav.length > 0 ? h(document, 'div', { className: 'actions' }, ...nav) : null),
      briefing.children.length > 0 ? section(document, 'Briefing', briefing) : null,
      dates.children.length > 0 ? section(document, 'Datas', dates) : null
    );
  }

  // Todos os candidatos examinados, em grupos que nunca se misturam; os filtros (grupo e tipo de lead) ficam guardados.
  function candidatesTab(job) {
    const candidates = Array.isArray(job.candidatos) ? job.candidatos.filter((entry) => entry && typeof entry === 'object') : [];
    if (candidates.length === 0) return emptyState(document, { title: 'Nenhum candidato registrado', text: isActive(job) ? 'Os candidatos aparecem aqui conforme a prospecção avança.' : 'Esta prospecção não registrou candidatos examinados.' });
    const counts = {};
    for (const entry of candidates) counts[classifyCandidate(entry)] = (counts[classifyCandidate(entry)] || 0) + 1;
    const options = [{ value: 'TODOS', label: `Todos (${candidates.length})` }, ...GROUPS.filter(([key]) => counts[key]).map(([key, label]) => ({ value: key, label: `${label} (${counts[key]})` }))];
    if (!options.some((option) => option.value === filters.group)) filters.group = 'TODOS';
    const groupSelect = selectField(document, { id: 'jobd-group', label: 'Mostrar', options, value: filters.group, onChange: (value) => { filters.group = value; onFilterChange('jobd-group'); } });
    const typeSelect = selectField(document, {
      id: 'jobd-type',
      label: 'Tipo de lead',
      options: LEAD_TYPE_FILTERS.map((value) => ({ value, label: value === 'TODOS' ? 'Todos' : LEAD_TYPE_LABELS[value] })),
      value: filters.type,
      onChange: (value) => { filters.type = value; onFilterChange('jobd-type'); },
    });
    const shown = candidates.filter((entry) => (filters.group === 'TODOS' || classifyCandidate(entry) === filters.group) && (filters.type === 'TODOS' || (entry.tipoLead || 'NAO_VERIFICADO') === filters.type));
    return h(
      document,
      'div',
      { className: 'candidates' },
      h(document, 'div', { className: 'toolbar toolbar-inline' }, groupSelect.element, typeSelect.element),
      h(document, 'p', { className: 'muted', text: 'Candidatos descartados ou não validados vivem só nesta prospecção: não são leads e não aparecem em Leads Reprovados.' }),
      shown.length > 0 ? h(document, 'ul', { className: 'candidate-list' }, ...shown.map(candidateItem)) : emptyState(document, { title: 'Nenhum candidato neste filtro' })
    );
  }

  function candidateItem(entry) {
    const group = classifyCandidate(entry);
    const name = textOf(entry.nome) || textOf(entry.empresa) || 'Sem nome';
    const sources = [];
    const official = entry.siteOficial && typeof entry.siteOficial === 'object' && entry.siteOficial.status === 'ENCONTRADO' ? link(entry.siteOficial.url, 'site oficial') : null;
    if (official) sources.push(official);
    for (const source of Array.isArray(entry.fontesDescoberta) ? entry.fontesDescoberta.slice(0, 3) : []) {
      const anchor = source && typeof source === 'object' ? link(source.url) : null;
      if (anchor) sources.push(anchor);
    }
    const informed = link(entry.url, 'endereço informado');
    if (informed && sources.length === 0) sources.push(informed);
    const detail = candidateDetail(entry);
    const place = [textOf(entry.empresa) !== '' && textOf(entry.empresa) !== name ? textOf(entry.empresa) : '', textOf(entry.nicho), textOf(entry.localizacao)].filter(Boolean).join(' · ');
    const siteStatus = entry.siteOficial && typeof entry.siteOficial === 'object' && entry.siteOficial.status ? (entry.siteOficial.status === 'ENCONTRADO' ? 'encontrado' : 'não encontrado') : '';
    const channels = confirmedChannels(entry.presencaDigital);
    const facts = [textOf(entry.tipoLead) !== '' ? `Tipo: ${LEAD_TYPE_LABELS[entry.tipoLead] || textOf(entry.tipoLead)}` : '', siteStatus ? `Site oficial: ${siteStatus}` : '', channels ? `Canais confirmados: ${channels}` : ''].filter(Boolean);
    return h(
      document,
      'li',
      { className: 'candidate-item', 'data-group': group },
      h(document, 'div', { className: 'candidate-head' }, h(document, 'span', { className: 'candidate-name', text: name }), badge(GROUP_BADGE[group], GROUP_TONE[group])),
      place !== '' ? h(document, 'p', { className: 'muted', text: place }) : null,
      facts.length > 0 ? h(document, 'p', { className: 'muted', text: facts.join(' · ') }) : null,
      ...detail.map((line) => h(document, 'p', { className: 'candidate-reason', text: line })),
      sources.length > 0 ? h(document, 'p', { className: 'candidate-sources' }, 'Fontes: ', ...sources.flatMap((anchor, index) => (index === 0 ? [anchor] : [' · ', anchor]))) : null
    );
  }

  // O que a prospecção ENTREGOU (ou deixou de entregar) à Approval Queue, e o resumo padronizado do servidor.
  function resultsTab(job) {
    const candidates = (Array.isArray(job.candidatos) ? job.candidatos : []).filter((entry) => entry && typeof entry === 'object');
    const by = (group) => candidates.filter((entry) => classifyCandidate(entry) === group);
    const names = (entries) => h(document, 'ul', { className: 'plain' }, ...entries.map((entry) => h(document, 'li', {}, h(document, 'span', { text: textOf(entry.nome) || textOf(entry.empresa) || 'Sem nome' }), candidateDetail(entry).length > 0 ? h(document, 'span', { className: 'muted', text: ` — ${candidateDetail(entry).join('; ')}` }) : null)));
    const delivered = by('ENTREGUE');
    const held = by('RETIDO');
    const existing = by('JA_EXISTIA');
    const summary = buildJobSummary(document, job.resumo);
    return h(
      document,
      'div',
      { className: 'lead-summary' },
      section(document, `Entregues à Approval Queue (${delivered.length})`, delivered.length > 0 ? names(delivered) : emptyState(document, { title: 'Nenhum lead foi entregue por esta prospecção', text: 'Só candidatos validados pela página chegam à Approval Queue.' })),
      held.length > 0 ? section(document, `Validados, mas retidos fora da fila (${held.length})`, h(document, 'p', { className: 'muted', text: 'Passaram pela validação, mas o pipeline os reteve (dados insuficientes, DNC ou duplicidade). Não viraram lead.' }), names(held)) : null,
      existing.length > 0 ? section(document, `Já estavam na fila (${existing.length})`, names(existing)) : null,
      section(document, 'Resumo padronizado', summary || h(document, 'p', { className: 'muted', text: 'Sem resumo disponível para esta prospecção.' }))
    );
  }

  function auditTab(job) {
    const tele = job.telemetria && typeof job.telemetria === 'object' ? job.telemetria : {};
    const limits = job.limits && typeof job.limits === 'object' ? job.limits : {};
    const lote = job.lote && typeof job.lote === 'object' ? job.lote : {};
    const seconds = (value) => (typeof value === 'number' ? h(document, 'span', { text: `${value}s` }) : null);
    const count = (value) => (Number.isInteger(value) ? h(document, 'span', { text: String(value) }) : null);
    const repeated = tele.repetidosPor && typeof tele.repetidosPor === 'object' ? tele.repetidosPor : null;
    const timing = kvList(document, [field('Descoberta', seconds(tele.descobertaSegundos)), field('Validação', seconds(tele.validacaoSegundos)), field('Envio à fila', seconds(tele.ingestaoSegundos)), field('Tempo total', seconds(tele.totalSegundos))]);
    const engine = kvList(document, [
      field('Custo informado pelo motor', typeof tele.custoUsd === 'number' ? h(document, 'span', { text: `US$ ${tele.custoUsd.toFixed(2)}` }) : null),
      field('Buscas na web', count(tele.webSearchRequests)),
      field('Rodadas de descoberta', count(tele.discoveryRuns)),
      field('Ciclos executados', count(tele.ciclosExecutados)),
      field('Reposições realizadas', count(tele.reposicoesRealizadas)),
      field('Reposições necessárias', count(tele.reposicoesNecessarias)),
    ]);
    const counters = kvList(document, [
      field('Descobertos', count(tele.candidatosDescobertos)),
      field('Novos', count(tele.candidatosNovos)),
      field('Repetidos', count(tele.candidatosRepetidos)),
      field('Repetidos: já na fila', repeated ? count(repeated.fila) : null),
      field('Repetidos: duplicados', repeated ? count(repeated.duplicado) : null),
      field('Repetidos: DNC', repeated ? count(repeated.dnc) : null),
      field('Repetidos: neste job', repeated ? count(repeated.job) : null),
    ]);
    const config = kvList(document, [
      field('Máximo de candidatos', count(limits.maxCandidates)),
      field('Máximo de ciclos', count(limits.maxCycles)),
      field('Tempo máximo', Number.isFinite(limits.maxDurationMs) ? h(document, 'span', { text: `${Math.round(limits.maxDurationMs / 1000)}s` }) : null),
      field('Limite atingido', typeof tele.limitReached === 'string' ? textNode(tele.limitReached) : null),
    ]);
    const ids = kvList(document, [
      field('Código da prospecção', textNode(job.id)),
      field('Briefing', textNode(job.briefId)),
      field('Lote', textNode(lote.loteId)),
      field('Cancelamento solicitado', typeof job.cancelRequested === 'boolean' ? h(document, 'span', { text: job.cancelRequested ? 'Sim' : 'Não' }) : null),
      field('Envio à fila iniciado', typeof job.ingestionStarted === 'boolean' ? h(document, 'span', { text: job.ingestionStarted ? 'Sim' : 'Não' }) : null),
    ]);
    const events = Array.isArray(tele.eventos) ? tele.eventos.filter((entry) => entry && typeof entry === 'object' && textOf(entry.codigo) !== '') : [];
    const blocks = [
      timing.children.length > 0 ? section(document, 'Tempos', timing) : null,
      engine.children.length > 0 ? section(document, 'Motor de pesquisa', engine) : null,
      counters.children.length > 0 ? section(document, 'Contagens do pipeline', counters) : null,
      config.children.length > 0 ? section(document, 'Limites da execução', config) : null,
      events.length > 0 ? section(document, 'Eventos registrados', h(document, 'ul', { className: 'plain' }, ...events.map((entry) => h(document, 'li', { text: `${textOf(entry.codigo)}${Number.isInteger(entry.ciclo) ? ` (ciclo ${entry.ciclo})` : ''}` })))) : null,
      ids.children.length > 0 ? section(document, 'Identificação', ids) : null,
    ].filter(Boolean);
    return blocks.length > 0 ? h(document, 'div', { className: 'lead-summary' }, ...blocks) : emptyState(document, { title: 'Sem dados de auditoria', text: 'Esta prospecção não registrou telemetria.' });
  }

  // As quatro abas montadas: { element, tabs }. `tab`: a aba ativa; onTab(key): avisa a tela dona quando a pessoa troca de aba.
  function build(job, { tab = 'resumo', onTab = () => {} } = {}) {
    const brief = getBrief(job);
    const list = [
      { key: 'resumo', label: 'Resumo', content: summaryTab(job, brief) },
      { key: 'candidatos', label: 'Candidatos', badge: String(Array.isArray(job.candidatos) ? job.candidatos.length : 0), content: candidatesTab(job) },
      { key: 'resultados', label: 'Resultados', content: resultsTab(job) },
      { key: 'auditoria', label: 'Auditoria', content: auditTab(job) },
    ];
    const tabs = createTabs(document, { idPrefix: 'jobd', label: 'Seções da prospecção', tabs: list, active: tab, onChange: onTab });
    return { element: h(document, 'div', { className: 'lead-drawer-body' }, tabs.element), tabs };
  }

  return { build, filters };
}
