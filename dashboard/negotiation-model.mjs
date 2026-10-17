// O MODELO das Negociações no Dashboard (CRM 5.0, Fase D1, decisão 0028): funções PURAS — sem DOM, rede nem relógio. Tudo o que a tela precisa para montar, conferir e mostrar uma negociação.
//
// O QUE ESTE MÓDULO FAZ: os rótulos em português; a conta financeira que PRÉ-VISUALIZA o resultado no formulário (a MESMA regra do servidor, copiada daqui porque o navegador não importa
// src/ — um teste confere a PARIDADE com src/crm/negotiationFinance.js em todas as combinações); montar o corpo de criar e de editar (editar leva SÓ o que mudou); traduzir os erros da API
// em mensagens por campo; descrever cada evento do histórico.
// O QUE NÃO FAZ: decidir nada. O servidor é a autoridade (permissão, serviço permitido, cliente real, prazo x periodicidade, situação) e SEMPRE repete todas as conferências; o que se mostra aqui como
// "prévia" nunca é gravado pelo navegador. Valor recebido não existe aqui: uma negociação GANHA é uma decisão comercial, não dinheiro no caixa.

import { parseMoney } from './catalog-model.mjs';
import { formatMoney } from './crm-model.mjs';
import { textOf } from './format.mjs';

// ---------------------------------------------------------------------------
// Vocabulário
// ---------------------------------------------------------------------------
const option = (value, label) => Object.freeze({ value, label });
export const PAYMENT_OPTIONS = Object.freeze([option('UNICO', 'Pagamento único'), option('RECORRENTE', 'Pagamento recorrente')]);
export const PERIODICITY_OPTIONS = Object.freeze([option('MENSAL', 'Mensal'), option('TRIMESTRAL', 'Trimestral'), option('SEMESTRAL', 'Semestral'), option('ANUAL', 'Anual')]);
export const MONTHS_PER_PERIOD = Object.freeze({ MENSAL: 1, TRIMESTRAL: 3, SEMESTRAL: 6, ANUAL: 12 });
export const TERM_PRESETS = Object.freeze([3, 6, 12]);
export const LIMITS = Object.freeze({ PRAZO_MINIMO: 1, PRAZO_MAXIMO: 120, MOTIVO_PERDA: 300 });
export const SITUATIONS = Object.freeze({ OPEN: 'ABERTA', WON: 'GANHA', LOST: 'PERDIDA' });

const labelIn = (options, value) => {
  const found = options.find((entry) => entry.value === value);
  return found ? found.label : '';
};
export const paymentLabel = (value) => labelIn(PAYMENT_OPTIONS, value);
export const periodicityLabel = (value) => labelIn(PERIODICITY_OPTIONS, value);
export const situationLabel = (value) => (value === SITUATIONS.WON ? 'Ganha' : value === SITUATIONS.LOST ? 'Perdida' : value === SITUATIONS.OPEN ? 'Aberta' : '');
export const situationTone = (value) => (value === SITUATIONS.WON ? 'ok' : value === SITUATIONS.LOST ? 'bad' : 'info');

// "Pagamento recorrente (mensal)" / "Pagamento único"
export function paymentText(negotiation) {
  const base = paymentLabel(negotiation && negotiation.formaPagamento);
  if (!base) return '';
  if (negotiation.formaPagamento === 'RECORRENTE' && periodicityLabel(negotiation.periodicidade)) return `${base} (${periodicityLabel(negotiation.periodicidade).toLowerCase()})`;
  return base;
}
export const termText = (months) => (Number.isInteger(months) ? `${months} ${months === 1 ? 'mês' : 'meses'}` : '');

// ---------------------------------------------------------------------------
// A conta financeira (PRÉVIA no formulário) — paridade com src/crm/negotiationFinance.js
// ---------------------------------------------------------------------------
const MAX_CENTS = 100_000_000_000;
function toCents(reais) {
  if (typeof reais !== 'number' || !Number.isFinite(reais) || reais <= 0) return null;
  const cents = Math.round(reais * 100);
  if (Math.abs(reais * 100 - cents) > 1e-6) return null;
  return cents < 1 || cents > MAX_CENTS ? null : cents;
}
const halfUp = (numerator, denominator) => Math.floor((2 * numerator + denominator) / (2 * denominator));

// { ok: true, tcv, mrr, equivalenteMensal, cronograma } ou { ok: false, code } — o MESMO contrato do servidor.
export function previewFinance(input) {
  const { formaPagamento, periodicidade = null, prazoMeses, valorNegociado } = input || {};
  const cents = toCents(valorNegociado);
  if (cents === null) return { ok: false, code: 'VALOR_INVALIDO' };
  if (!Number.isInteger(prazoMeses) || prazoMeses < LIMITS.PRAZO_MINIMO || prazoMeses > LIMITS.PRAZO_MAXIMO) return { ok: false, code: 'PRAZO_INVALIDO' };
  if (formaPagamento === 'UNICO') {
    if (periodicidade !== null && periodicidade !== undefined) return { ok: false, code: 'PERIODICIDADE_NAO_PERMITIDA' };
    return { ok: true, tcv: cents / 100, mrr: null, equivalenteMensal: null, cronograma: { cobrancas: 1, valorPorCobranca: cents / 100, mesesEntreCobrancas: null } };
  }
  if (formaPagamento === 'RECORRENTE') {
    if (periodicidade === null || periodicidade === undefined) return { ok: false, code: 'PERIODICIDADE_OBRIGATORIA' };
    if (!Object.prototype.hasOwnProperty.call(MONTHS_PER_PERIOD, periodicidade)) return { ok: false, code: 'PERIODICIDADE_INVALIDA' };
    const months = MONTHS_PER_PERIOD[periodicidade];
    if (prazoMeses % months !== 0) return { ok: false, code: 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE' };
    const charges = prazoMeses / months;
    const monthly = months === 1 ? cents : halfUp(cents, months);
    return { ok: true, tcv: (cents * charges) / 100, mrr: periodicidade === 'MENSAL' ? cents / 100 : null, equivalenteMensal: monthly / 100, cronograma: { cobrancas: charges, valorPorCobranca: cents / 100, mesesEntreCobrancas: months } };
  }
  return { ok: false, code: 'FORMA_PAGAMENTO_INVALIDA' };
}

// O texto do cronograma (a regra explícita: quantas cobranças, de quanto, de quanto em quanto tempo).
export function scheduleText(schedule) {
  if (!schedule || !Number.isInteger(schedule.cobrancas)) return '';
  if (schedule.mesesEntreCobrancas === null || schedule.mesesEntreCobrancas === undefined) return `1 cobrança de ${formatMoney(schedule.valorPorCobranca)}`;
  const every = schedule.mesesEntreCobrancas === 1 ? 'todo mês' : `a cada ${schedule.mesesEntreCobrancas} meses`;
  return `${schedule.cobrancas} ${schedule.cobrancas === 1 ? 'cobrança' : 'cobranças'} de ${formatMoney(schedule.valorPorCobranca)}, ${every}`;
}

// ---------------------------------------------------------------------------
// O formulário <-> o contrato. Os valores do formulário são sempre TEXTO ('' = vazio).
// ---------------------------------------------------------------------------
export const WRITABLE_CREATE_FIELDS = Object.freeze(['crmRecordId', 'funnelId', 'serviceId', 'prazoMeses', 'formaPagamento', 'periodicidade', 'valorNegociado', 'previsaoFechamento']);
export const WRITABLE_EDIT_FIELDS = Object.freeze(['serviceId', 'prazoMeses', 'formaPagamento', 'periodicidade', 'valorNegociado', 'previsaoFechamento']);

export const emptyFormValues = (funnelId = '') => ({ crmRecordId: '', funnelId, serviceId: '', prazoMeses: '12', formaPagamento: '', periodicidade: '', valorNegociado: '', previsaoFechamento: '' });

export function formValuesFromNegotiation(negotiation) {
  const source = negotiation && typeof negotiation === 'object' ? negotiation : {};
  return {
    crmRecordId: textOf(source.crmRecordId),
    funnelId: textOf(source.funnelId),
    serviceId: textOf(source.serviceId),
    prazoMeses: Number.isInteger(source.prazoMeses) ? String(source.prazoMeses) : '',
    formaPagamento: textOf(source.formaPagamento),
    periodicidade: textOf(source.periodicidade),
    valorNegociado: typeof source.valorNegociado === 'number' ? new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(source.valorNegociado) : '',
    previsaoFechamento: textOf(source.previsaoFechamento),
  };
}

// O prazo digitado: só dígitos, inteiro de 1 a 120.
export function parseTerm(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return { ok: false, code: 'OBRIGATORIO' };
  if (!/^\d{1,4}$/.test(raw)) return { ok: false, code: 'PRAZO_INVALIDO' };
  const value = Number(raw);
  return value >= LIMITS.PRAZO_MINIMO && value <= LIMITS.PRAZO_MAXIMO ? { ok: true, value } : { ok: false, code: 'PRAZO_INVALIDO' };
}

// O valor de cada campo como vai para o servidor: { ok, value } ou { ok: false, code }.
function wireValue(field, values) {
  const text = values[field];
  switch (field) {
    case 'crmRecordId':
    case 'funnelId':
    case 'serviceId':
    case 'formaPagamento':
      return textOf(text).trim() === '' ? { ok: false, code: 'OBRIGATORIO' } : { ok: true, value: textOf(text).trim() };
    case 'prazoMeses':
      return parseTerm(text);
    case 'periodicidade':
      return { ok: true, value: textOf(text).trim() === '' ? null : textOf(text).trim() };
    case 'valorNegociado': {
      const money = parseMoney(text);
      if (!money.ok) return money;
      return money.value === null || money.value <= 0 ? { ok: false, code: money.value === null ? 'OBRIGATORIO' : 'VALOR_INVALIDO' } : { ok: true, value: money.value };
    }
    case 'previsaoFechamento':
      return { ok: true, value: textOf(text).trim() === '' ? null : textOf(text).trim() };
    default:
      return { ok: true, value: null };
  }
}

// As conferências que dá para fazer SEM ir ao servidor (o servidor repete todas e tem a palavra final). `service`: { permitePagamentoUnico, permitePagamentoRecorrente, periodicidades } do
// serviço escolhido (ou null se ainda não escolheu / não carregou — então só se confere o que não depende dele).
function stateProblems(state, service, { checkService }) {
  const errors = {};
  const finance = previewFinance(state);
  if (!finance.ok) {
    const path = { VALOR_INVALIDO: 'valorNegociado', PRAZO_INVALIDO: 'prazoMeses', PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE: 'prazoMeses', FORMA_PAGAMENTO_INVALIDA: 'formaPagamento', PERIODICIDADE_OBRIGATORIA: 'periodicidade', PERIODICIDADE_INVALIDA: 'periodicidade', PERIODICIDADE_NAO_PERMITIDA: 'periodicidade' }[finance.code] || 'valorNegociado';
    errors[path] = fieldMessage(path, finance.code);
  }
  if (checkService && service) {
    const unique = service.permitePagamentoUnico === true;
    const recurring = service.permitePagamentoRecorrente === true;
    if (!unique && !recurring) errors.serviceId = fieldMessage('serviceId', 'SERVICO_SEM_MODALIDADE');
    else if (state.formaPagamento === 'UNICO' && !unique) errors.formaPagamento = fieldMessage('formaPagamento', 'FORMA_NAO_PERMITIDA_PELO_SERVICO');
    else if (state.formaPagamento === 'RECORRENTE') {
      if (!recurring) errors.formaPagamento = fieldMessage('formaPagamento', 'FORMA_NAO_PERMITIDA_PELO_SERVICO');
      else if (state.periodicidade && !(Array.isArray(service.periodicidades) && service.periodicidades.includes(state.periodicidade))) errors.periodicidade = fieldMessage('periodicidade', 'PERIODICIDADE_NAO_PERMITIDA_PELO_SERVICO');
    }
  }
  return errors;
}

// O corpo de uma CRIAÇÃO: todos os campos obrigatórios; a periodicidade só no pagamento recorrente. { ok, body, errors } — errors: { campo: mensagem }.
export function buildCreateBody(values, { service = null } = {}) {
  const errors = {};
  const body = {};
  for (const field of WRITABLE_CREATE_FIELDS) {
    if (field === 'periodicidade' && values.formaPagamento !== 'RECORRENTE') continue;
    const wired = wireValue(field, values);
    if (!wired.ok) {
      errors[field] = fieldMessage(field, wired.code);
      continue;
    }
    if (field === 'previsaoFechamento' && wired.value === null) continue;
    if (field === 'periodicidade' && wired.value === null) continue;
    body[field] = wired.value;
  }
  if (Object.keys(errors).length === 0) Object.assign(errors, stateProblems({ ...body, periodicidade: body.periodicidade ?? null }, service, { checkService: true }));
  return { ok: Object.keys(errors).length === 0, body, errors };
}

// O corpo de uma EDIÇÃO: SÓ o que mudou. Mudar a forma de pagamento ou a periodicidade leva as duas juntas (a coerência é do estado final); editar só o valor, o prazo ou a previsão nunca
// reenvia a forma de pagamento. { ok, body, errors, empty }.
export function buildPatchBody(initial, values, { service = null } = {}) {
  const errors = {};
  const changed = [];
  for (const field of WRITABLE_EDIT_FIELDS) {
    const before = wireValue(field, initial);
    const now = wireValue(field, values);
    if (!now.ok) {
      errors[field] = fieldMessage(field, now.code);
      continue;
    }
    if (!before.ok || !Object.is(before.value, now.value)) changed.push(field);
  }
  const body = {};
  const send = new Set(changed);
  if (send.has('formaPagamento') || send.has('periodicidade')) {
    send.add('formaPagamento');
    send.add('periodicidade');
  }
  for (const field of WRITABLE_EDIT_FIELDS) {
    if (!send.has(field)) continue;
    const wired = wireValue(field, values);
    if (wired.ok) body[field] = field === 'periodicidade' && values.formaPagamento !== 'RECORRENTE' ? null : wired.value;
  }
  if (Object.keys(errors).length === 0 && changed.length > 0) {
    const state = { prazoMeses: wireValue('prazoMeses', values).value, formaPagamento: wireValue('formaPagamento', values).value, periodicidade: values.formaPagamento === 'RECORRENTE' ? wireValue('periodicidade', values).value : null, valorNegociado: wireValue('valorNegociado', values).value };
    Object.assign(errors, stateProblems(state, service, { checkService: send.has('serviceId') || send.has('formaPagamento') || send.has('periodicidade') }));
  }
  return { ok: Object.keys(errors).length === 0, body, errors, empty: changed.length === 0 };
}

// ---------------------------------------------------------------------------
// Mensagens (pt-BR, por campo)
// ---------------------------------------------------------------------------
const FIELD_NOUN = Object.freeze({ crmRecordId: 'o cliente', funnelId: 'o funil', serviceId: 'o serviço', prazoMeses: 'o prazo', formaPagamento: 'a forma de pagamento', periodicidade: 'a periodicidade', valorNegociado: 'o valor', previsaoFechamento: 'a previsão de fechamento', motivo: 'o motivo', stageId: 'a etapa' });
const FIELD_PATHS = Object.freeze(Object.keys(FIELD_NOUN));

export function fieldMessage(path, code) {
  const noun = FIELD_NOUN[path] || 'este campo';
  switch (code) {
    case 'OBRIGATORIO':
      return path === 'crmRecordId' ? 'Escolha o cliente.' : path === 'funnelId' ? 'Escolha o funil.' : path === 'serviceId' ? 'Escolha o serviço.' : path === 'formaPagamento' ? 'Escolha a forma de pagamento: único ou recorrente.' : path === 'prazoMeses' ? 'Informe o prazo do contrato, em meses.' : path === 'valorNegociado' ? 'Informe o valor negociado.' : path === 'motivo' ? 'Informe o motivo.' : `Informe ${noun}.`;
    case 'CLIENTE_NAO_ENCONTRADO':
      return 'Este cliente não foi encontrado. Atualize a lista e escolha de novo.';
    case 'CLIENTE_NAO_CONTATAR':
      return 'Este cliente está marcado como "Não Contatar": não é possível abrir uma negociação.';
    case 'FUNIL_NAO_ENCONTRADO':
      return 'Este funil não foi encontrado. Atualize a página e escolha de novo.';
    case 'FUNIL_INATIVO':
      return 'Este funil está desativado: escolha outro.';
    case 'FUNIL_SEM_ETAPAS':
      return 'Este funil ainda não tem etapas ativas. Peça a um administrador para criar as etapas.';
    case 'SERVICO_NAO_ENCONTRADO':
      return 'Este serviço não foi encontrado. Atualize a lista e escolha de novo.';
    case 'SERVICO_INATIVO':
      return 'Este serviço está desativado e não aceita negociações novas.';
    case 'SERVICO_SEM_MODALIDADE':
      return 'Este serviço ainda não tem as formas de pagamento informadas. Peça a um administrador para completar o cadastro do serviço.';
    case 'FORMA_NAO_PERMITIDA_PELO_SERVICO':
      return 'O serviço escolhido não permite esta forma de pagamento.';
    case 'PERIODICIDADE_NAO_PERMITIDA_PELO_SERVICO':
      return 'O serviço escolhido não permite esta periodicidade.';
    case 'PERIODICIDADE_OBRIGATORIA':
      return 'Escolha a periodicidade da cobrança recorrente.';
    case 'PERIODICIDADE_NAO_PERMITIDA':
      return 'A periodicidade só vale para o pagamento recorrente.';
    case 'PERIODICIDADE_INVALIDA':
    case 'FORMA_PAGAMENTO_INVALIDA':
      return `Escolha ${noun} entre as opções.`;
    case 'PRAZO_INVALIDO':
      return `Informe o prazo em meses, um número inteiro de ${LIMITS.PRAZO_MINIMO} a ${LIMITS.PRAZO_MAXIMO}.`;
    case 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE':
      return 'O prazo precisa ser um múltiplo da periodicidade (por exemplo, 12 meses com cobrança trimestral = 4 cobranças). Ajuste o prazo ou a periodicidade.';
    case 'VALOR_INVALIDO':
      return path === 'valorNegociado' ? 'Informe um valor maior que zero, em reais, com até duas casas decimais (como 1.500,00).' : `Confira ${noun}.`;
    case 'NEGATIVO':
      return 'O valor não pode ser negativo.';
    case 'MAIS_DE_DUAS_CASAS':
      return 'Use no máximo duas casas decimais (os centavos).';
    case 'FORMATO_INVALIDO':
      return 'Informe o valor em reais, como 1.500,00.';
    case 'VALOR_FORA_DO_LIMITE':
      return 'Informe um valor entre R$ 0,01 e R$ 1.000.000.000,00.';
    case 'DATA_INVALIDA':
      return 'Informe uma data válida.';
    case 'MUITO_LONGO':
      return `O texto pode ter no máximo ${LIMITS.MOTIVO_PERDA} caracteres.`;
    case 'CARACTERE_INVALIDO':
      return 'O texto tem um caractere que não pode ser usado.';
    case 'ETAPA_DE_OUTRO_FUNIL':
    case 'ETAPA_DESATIVADA':
    case 'ETAPA_NAO_ENCONTRADA':
      return 'Esta etapa não está disponível. Atualize o quadro e tente de novo.';
    case 'TIPO_INVALIDO':
    case 'ID_INVALIDO':
      return `Confira ${noun}.`;
    default:
      return `Confira ${noun}.`;
  }
}

export const MESSAGES = Object.freeze({
  generic: 'Não foi possível concluir agora. Tente novamente em instantes.',
  network: 'Sem conexão com o servidor. Verifique a internet e tente de novo.',
  forbidden: 'Sua conta não tem permissão para esta ação.',
  notFound: 'Esta negociação não foi encontrada. Atualize a lista.',
  validation: 'Confira os campos destacados e tente novamente.',
  closed: 'Só uma negociação aberta pode ser editada ou mudar de etapa. Atualize o quadro.',
  invalidState: 'Esta ação não é possível na situação atual da negociação. Atualize o quadro.',
  unavailable: 'As negociações não estão disponíveis agora. Nada foi alterado. Tente novamente em instantes.',
  stale: 'O quadro mudou desde a última leitura. Atualize e tente de novo.',
  conflict: 'Esta negociação foi alterada por outra pessoa. O quadro foi atualizado: confira e tente de novo.',
});

// Traduz um ApiError em { kind, message, fields } (kind: validation | not-found | closed | invalid-state | conflict | forbidden | unavailable | network | other). `null` = a sessão acabou (o login cuida).
export function negotiationErrorInfo(error) {
  const status = error && typeof error.status === 'number' ? error.status : null;
  if (status === null) return { kind: 'other', message: MESSAGES.generic, fields: {} };
  if (status === 401) return null;
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (status === 0) return { kind: 'network', message: MESSAGES.network, fields: {} };
  if (status === 403) return { kind: 'forbidden', message: MESSAGES.forbidden, fields: {} };
  if (status === 404) return { kind: 'not-found', message: MESSAGES.notFound, fields: {} };
  if (status === 409 && code === 'NEGOTIATION_CLOSED') return { kind: 'closed', message: MESSAGES.closed, fields: {} };
  if (status === 409 && code === 'NEGOTIATION_CONFLICT') return { kind: 'conflict', message: MESSAGES.conflict, fields: {} }; // outra pessoa gravou antes (concorrência do banco)
  if (status === 409 && code === 'NEGOTIATION_INVALID_STATE') return { kind: 'invalid-state', message: MESSAGES.invalidState, fields: {} };
  if (status === 409) return { kind: 'invalid-state', message: MESSAGES.invalidState, fields: {} };
  if (status === 400) {
    const fields = {};
    let message = MESSAGES.validation;
    const list = error && Array.isArray(error.details) ? error.details : [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const path = typeof entry.path === 'string' ? entry.path : '';
      const entryCode = typeof entry.code === 'string' ? entry.code : '';
      if (entryCode === 'NADA_A_ALTERAR') message = 'Nenhuma alteração foi feita.';
      else if (FIELD_PATHS.includes(path) && !Object.prototype.hasOwnProperty.call(fields, path)) fields[path] = fieldMessage(path, entryCode);
    }
    return { kind: 'validation', message, fields };
  }
  if (status === 503 || code === 'NEGOTIATION_PERSISTENCE') return { kind: 'unavailable', message: MESSAGES.unavailable, fields: {} };
  return { kind: 'other', message: MESSAGES.generic, fields: {} };
}

// ---------------------------------------------------------------------------
// O histórico (cada evento vira uma frase: o que, e com quem e quando a tela mostra ao lado)
// ---------------------------------------------------------------------------
const CHANGE_LABEL = Object.freeze({ serviceId: 'Serviço', prazoMeses: 'Prazo', formaPagamento: 'Forma de pagamento', periodicidade: 'Periodicidade', valorNegociado: 'Valor negociado', previsaoFechamento: 'Previsão de fechamento' });

function changeText(change) {
  const label = CHANGE_LABEL[change.campo] || 'Campo';
  const show = (value) => {
    if (value === null || value === undefined || value === '') return 'vazio';
    if (change.campo === 'valorNegociado') return formatMoney(value);
    if (change.campo === 'prazoMeses') return termText(value);
    if (change.campo === 'formaPagamento') return paymentLabel(value) || 'valor inválido';
    if (change.campo === 'periodicidade') return periodicityLabel(value) || 'valor inválido';
    if (change.campo === 'serviceId') return 'outro serviço';
    return textOf(value);
  };
  return change.campo === 'serviceId' ? `${label}: trocado` : `${label}: de ${show(change.de)} para ${show(change.para)}`;
}

export function eventText(event) {
  const detail = event && typeof event.detalhe === 'object' && event.detalhe !== null ? event.detalhe : {};
  switch (event && event.tipo) {
    case 'CRIADA':
      return 'Negociação criada.';
    case 'ATUALIZADA':
      return Array.isArray(detail.alteracoes) && detail.alteracoes.length > 0 ? `Atualizada — ${detail.alteracoes.map(changeText).join('; ')}.` : 'Atualizada.';
    case 'ETAPA':
      return `Mudou de etapa: ${textOf(detail.deEtapaNome) || 'etapa anterior'} → ${textOf(detail.paraEtapaNome) || 'nova etapa'}.${textOf(detail.motivo) ? ` Motivo: ${textOf(detail.motivo)}` : ''}`;
    case 'GANHA':
      return 'Marcada como ganha.';
    case 'PERDIDA':
      return `Marcada como perdida.${textOf(detail.motivo) ? ` Motivo: ${textOf(detail.motivo)}` : ''}`;
    case 'REABERTA':
      return `Reaberta${detail.de === 'GANHA' ? ' (estava ganha)' : detail.de === 'PERDIDA' ? ' (estava perdida)' : ''}.`;
    default:
      return 'Evento registrado.';
  }
}

// ---------------------------------------------------------------------------
// O QUADRO
// ---------------------------------------------------------------------------
// O texto de uma linha do cartão da negociação: "Pagamento recorrente (mensal) · 12 meses".
export const conditionsText = (negotiation) => [paymentText(negotiation), termText(negotiation && negotiation.prazoMeses)].filter(Boolean).join(' · ');
