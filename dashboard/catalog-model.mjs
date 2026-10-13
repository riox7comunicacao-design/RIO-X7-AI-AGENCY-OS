// O MODELO dos catálogos do CRM no Dashboard (CRM 5.0, Fase 2B-2): Serviços, Nichos e Origens dos Leads. Só funções e dados PUROS — nada aqui toca o DOM, a rede ou o navegador.
//
// O QUE ESTE ARQUIVO É: a tradução entre o formulário e o contrato do servidor (campos graváveis, rótulos em português, dinheiro em reais, o que enviar numa criação e numa edição) e entre os
// erros do servidor e as mensagens que a pessoa lê. O QUE ELE NÃO É: a regra de negócio. Unicidade do nome, nome em uso pelo CRM, coerência de cobrança, limites e permissões continuam
// sendo do servidor, que sempre tem a palavra final; as poucas conferências feitas aqui (nome preenchido, preço em reais com centavos) só evitam uma ida ao servidor à toa.
//
// O contrato vem de src/crm/catalogConstants.js (copiado aqui como dado estático — o navegador nunca importa src/, regra R11). tests/server/dashboard-catalog-model.test.js compara as duas
// cópias (campos, enumerações, limites): se o servidor mudar e este arquivo não, o teste falha.

import { formatMoney } from './crm-model.mjs';
import { textOf } from './format.mjs';

// ---------------------------------------------------------------------------
// Os catálogos e os campos que o corpo de uma escrita pode levar
// ---------------------------------------------------------------------------
export const CATALOG_KEYS = Object.freeze(['servicos', 'nichos', 'origens']);

// Os campos GRAVÁVEIS de cada catálogo (nunca id, ordem, ativo, datas ou responsáveis: isso o servidor define; ativar/desativar e reordenar têm chamadas próprias).
export const CATALOG_WRITABLE_FIELDS = Object.freeze({
  servicos: Object.freeze(['nome', 'descricao', 'categoria', 'precoReferencia', 'tipoCobranca', 'recorrencia']),
  nichos: Object.freeze(['nome', 'descricao', 'cor']),
  origens: Object.freeze(['nome', 'descricao', 'canal']),
});

export const LIMITS = Object.freeze({ NOME: 80, DESCRICAO: 500, CATEGORIA: 60, PRECO_MAXIMO: 1_000_000_000 });

const option = (value, label) => Object.freeze({ value, label });

// Tipo de cobrança e recorrência dos serviços; canal das origens. O valor é o que viaja para o servidor; o rótulo é o que a pessoa lê.
export const BILLING_OPTIONS = Object.freeze([option('UNICA', 'Pagamento único'), option('RECORRENTE', 'Cobrança recorrente')]);
export const RECURRENCE_OPTIONS = Object.freeze([option('MENSAL', 'Mensal'), option('TRIMESTRAL', 'Trimestral'), option('SEMESTRAL', 'Semestral'), option('ANUAL', 'Anual')]);
export const CHANNEL_OPTIONS = Object.freeze([
  option('PROSPECCAO_ATIVA', 'Prospecção ativa'),
  option('ANUNCIO_PAGO', 'Anúncio pago'),
  option('INDICACAO', 'Indicação'),
  option('ORGANICO', 'Orgânico'),
  option('PARCERIA', 'Parceria'),
  option('OUTRO', 'Outro'),
]);

const labelIn = (options, value) => {
  const found = options.find((entry) => entry.value === value);
  return found ? found.label : '';
};
export const billingLabel = (value) => labelIn(BILLING_OPTIONS, value);
export const recurrenceLabel = (value) => labelIn(RECURRENCE_OPTIONS, value);
export const channelLabel = (value) => labelIn(CHANNEL_OPTIONS, value);

// ---------------------------------------------------------------------------
// Busca e filtro da lista (só exibição: nada disto muda dado algum)
// ---------------------------------------------------------------------------
export const STATUS_FILTERS = Object.freeze([option('ATIVOS', 'Somente ativos'), option('INATIVOS', 'Somente inativos'), option('TODOS', 'Todos')]);

export const foldText = (value) =>
  textOf(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// Os itens que a lista mostra: a busca é pelo NOME (sem acento e sem diferenciar maiúsculas) e o filtro de situação. A ordem é a do servidor (a ordem de exibição do catálogo).
export function visibleCatalogItems(items, { query = '', status = 'TODOS' } = {}) {
  const needle = foldText(query);
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (status === 'ATIVOS' && item.ativo !== true) return false;
    if (status === 'INATIVOS' && item.ativo === true) return false;
    return needle === '' || foldText(item.nome).includes(needle);
  });
}

// ---------------------------------------------------------------------------
// Dinheiro em reais (preço de referência dos serviços — só informativo)
// ---------------------------------------------------------------------------
// Aceita o formato brasileiro ("1.500,00", "1500,5", "R$ 99") e, por conveniência, o ponto decimal com 1 ou 2 casas ("1500.50"). Ponto seguido de exatamente 3 dígitos é separador de
// milhar ("1.500" = 1500). Devolve { ok, value } (value null = campo vazio) ou { ok: false, code }.
export function parseMoney(text) {
  const raw = typeof text === 'string' ? text.replace(/\s+/g, '').replace(/^R\$/i, '') : '';
  if (raw === '') return { ok: true, value: null };
  if (raw.startsWith('-')) return { ok: false, code: 'NEGATIVO' };
  let normalized = null;
  if (/^\d+(,\d{1,2})?$/.test(raw)) normalized = raw.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(raw)) normalized = raw.replace(/\./g, '').replace(',', '.');
  else if (/^\d+\.\d{1,2}$/.test(raw)) normalized = raw;
  if (normalized === null) return { ok: false, code: /^[\d.]*,\d{3,}$/.test(raw) || /^\d+\.\d{3,}$/.test(raw) ? 'MAIS_DE_DUAS_CASAS' : 'FORMATO_INVALIDO' };
  const value = Number(normalized);
  if (!Number.isFinite(value)) return { ok: false, code: 'FORMATO_INVALIDO' };
  if (value > LIMITS.PRECO_MAXIMO) return { ok: false, code: 'VALOR_FORA_DO_LIMITE' };
  return { ok: true, value: Math.round(value * 100) / 100 };
}

const MONEY_FIELD = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });

// O número como a pessoa o digita no campo ("1.500,00"); '' quando não há valor.
export function moneyFieldText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? MONEY_FIELD.format(value) : '';
}

// O preço para EXIBIR ("R$ 1.500,00"); '' quando não há preço.
export const priceText = (value) => formatMoney(value);

// ---------------------------------------------------------------------------
// Formulário <-> contrato
// ---------------------------------------------------------------------------
// Os valores do formulário são sempre TEXTO (o que a pessoa vê). '' = campo vazio.
const collapse = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const trimmed = (value) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '');

export function emptyFormValues(catalogo) {
  if (catalogo === 'servicos') return { nome: '', descricao: '', categoria: '', precoReferencia: '', tipoCobranca: '', recorrencia: '' };
  if (catalogo === 'nichos') return { nome: '', descricao: '', cor: '' };
  return { nome: '', descricao: '', canal: '' };
}

// Os valores iniciais do formulário de EDIÇÃO, a partir do item que o servidor devolveu.
export function formValuesFromItem(catalogo, item) {
  const base = emptyFormValues(catalogo);
  const source = item && typeof item === 'object' ? item : {};
  const values = { ...base, nome: textOf(source.nome), descricao: textOf(source.descricao) };
  if (catalogo === 'servicos') {
    values.categoria = textOf(source.categoria);
    values.precoReferencia = moneyFieldText(source.precoReferencia);
    values.tipoCobranca = textOf(source.tipoCobranca);
    values.recorrencia = textOf(source.recorrencia);
  } else if (catalogo === 'nichos') {
    values.cor = textOf(source.cor);
  } else {
    values.canal = textOf(source.canal);
  }
  return values;
}

// O valor que um campo leva para o servidor: texto vazio = null; preço = número; os demais = o texto limpo. { ok: false, code } quando o preço não é um valor em reais.
function wireValue(field, values) {
  const text = values[field];
  if (field === 'nome' || field === 'categoria') return { ok: true, value: collapse(text) === '' ? null : collapse(text) };
  if (field === 'descricao') return { ok: true, value: trimmed(text) === '' ? null : trimmed(text) };
  if (field === 'precoReferencia') return parseMoney(text);
  return { ok: true, value: textOf(text) === '' ? null : textOf(text) };
}

// Os campos que o formulário mostra para um catálogo, na ordem em que viajam.
const fieldsOf = (catalogo) => CATALOG_WRITABLE_FIELDS[catalogo] || [];

// Compara o formulário com o ponto de partida SEM contar espaços a mais como alteração. Devolve os nomes dos campos diferentes.
export function changedFields(catalogo, initial, values) {
  const changed = [];
  for (const field of fieldsOf(catalogo)) {
    const before = wireValue(field, initial);
    const now = wireValue(field, values);
    if (!before.ok || !now.ok) {
      if (textOf(initial[field]) !== textOf(values[field])) changed.push(field);
      continue;
    }
    if (!Object.is(before.value, now.value)) changed.push(field);
  }
  return changed;
}

// O corpo de uma CRIAÇÃO: o nome e só os campos opcionais preenchidos. { ok, body, errors } — errors: { campo: mensagem } (só o que dá para conferir no navegador).
export function buildCreateBody(catalogo, values) {
  const errors = {};
  const body = {};
  for (const field of fieldsOf(catalogo)) {
    const wired = wireValue(field, values);
    if (!wired.ok) {
      errors[field] = fieldMessage(field, wired.code);
      continue;
    }
    if (field === 'nome') {
      if (wired.value === null) errors.nome = fieldMessage('nome', 'OBRIGATORIO');
      else body.nome = wired.value;
    } else if (wired.value !== null) {
      body[field] = wired.value;
    }
  }
  return { ok: Object.keys(errors).length === 0, body, errors };
}

// O corpo de uma EDIÇÃO: SÓ os campos que mudaram (o servidor recusa um corpo vazio). Mudar o tipo de cobrança leva a recorrência junto (a coerência é conferida sobre o estado final).
// { ok, body, errors, empty } — empty: nada mudou.
export function buildPatchBody(catalogo, initial, values) {
  const errors = {};
  const body = {};
  const changed = changedFields(catalogo, initial, values);
  const send = new Set(changed);
  if (catalogo === 'servicos' && (send.has('tipoCobranca') || send.has('recorrencia'))) {
    send.add('tipoCobranca');
    send.add('recorrencia');
  }
  for (const field of fieldsOf(catalogo)) {
    if (!send.has(field)) continue;
    const wired = wireValue(field, values);
    if (!wired.ok) {
      errors[field] = fieldMessage(field, wired.code);
      continue;
    }
    if (field === 'nome' && wired.value === null) {
      errors.nome = fieldMessage('nome', 'OBRIGATORIO');
      continue;
    }
    body[field] = wired.value;
  }
  return { ok: Object.keys(errors).length === 0, body, errors, empty: changed.length === 0 };
}

// ---------------------------------------------------------------------------
// Mensagens para a pessoa
// ---------------------------------------------------------------------------
const FIELD_NOUN = Object.freeze({
  nome: 'o nome',
  descricao: 'a descrição',
  categoria: 'a categoria',
  precoReferencia: 'o preço de referência',
  tipoCobranca: 'o tipo de cobrança',
  recorrencia: 'a recorrência',
  cor: 'a cor',
  canal: 'o canal',
});
const FIELD_LIMIT = Object.freeze({ nome: LIMITS.NOME, descricao: LIMITS.DESCRICAO, categoria: LIMITS.CATEGORIA });
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// A mensagem de UM campo, a partir do código que o servidor (ou o navegador) devolveu. Nunca repete o valor digitado.
export function fieldMessage(path, code) {
  const noun = FIELD_NOUN[path] || 'este campo';
  switch (code) {
    case 'OBRIGATORIO':
      return `Informe ${noun}.`;
    case 'MUITO_LONGO':
      return `${capitalize(noun)} pode ter no máximo ${FIELD_LIMIT[path] || 80} caracteres.`;
    case 'CARACTERE_INVALIDO':
      return `${capitalize(noun)} tem um caractere que não pode ser usado.`;
    case 'NOME_SEM_LETRAS':
      return 'O nome precisa ter pelo menos uma letra ou um número.';
    case 'TIPO_INVALIDO':
      return `Confira ${noun}: o valor não é válido.`;
    case 'VALOR_INVALIDO':
      return `Escolha uma das opções da lista para ${noun}.`;
    case 'VALOR_FORA_DO_LIMITE':
    case 'NEGATIVO':
      return 'Informe um valor entre R$ 0,00 e R$ 1.000.000.000,00.';
    case 'MAIS_DE_DUAS_CASAS':
      return 'Use no máximo duas casas decimais (os centavos).';
    case 'FORMATO_INVALIDO':
      return 'Informe o valor em reais, como 1.500,00.';
    case 'RECORRENCIA_OBRIGATORIA':
      return 'Escolha a recorrência: a cobrança é recorrente.';
    case 'RECORRENCIA_NAO_PERMITIDA':
      return 'A recorrência só vale para cobrança recorrente.';
    default:
      return `Confira ${noun}.`;
  }
}

export const MESSAGES = Object.freeze({
  generic: 'Não foi possível concluir agora. Tente novamente em instantes.',
  network: 'Sem conexão com o servidor. Verifique a internet e tente novamente. Nada foi alterado.',
  forbidden: 'Sua conta não tem permissão para administrar estes cadastros.',
  notFound: 'Este item não existe mais. A lista foi atualizada.',
  unavailable: 'Os cadastros não estão disponíveis agora. Isso acontece, por exemplo, quando a estrutura de dados dos cadastros ainda não foi preparada neste ambiente. Nada foi alterado.',
  validation: 'Confira os campos destacados e tente novamente.',
  duplicateName: 'Já existe um item com este nome, mesmo desativado. Use outro nome ou reative o item existente.',
  nameInUse: 'Este item já é usado em registros do CRM, então o nome não pode ser alterado nesta fase. As demais informações podem ser editadas.',
  nothingToChange: 'Nenhuma alteração foi feita.',
  staleList: 'A lista mudou desde a última atualização. Atualize a página e tente reordenar de novo.',
});

const FIELD_PATHS = Object.freeze(['nome', 'descricao', 'categoria', 'precoReferencia', 'tipoCobranca', 'recorrencia', 'cor', 'canal']);

// O que mostrar de um erro da API (ApiError): { message, fields, kind }. 401 devolve null (o fluxo de login cuida). `fields` = { campo: mensagem } para colocar perto do campo.
export function catalogErrorInfo(error) {
  const status = error && typeof error.status === 'number' ? error.status : null;
  if (status === null) return { kind: 'other', message: MESSAGES.generic, fields: {} };
  if (status === 401) return null;
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (status === 0) return { kind: 'network', message: MESSAGES.network, fields: {} };
  if (status === 403) return { kind: 'forbidden', message: MESSAGES.forbidden, fields: {} };
  if (status === 404) return { kind: 'not-found', message: MESSAGES.notFound, fields: {} };
  if (status === 409 && code === 'CRM_CATALOG_DUPLICATE_NAME') return { kind: 'duplicate', message: MESSAGES.duplicateName, fields: { nome: MESSAGES.duplicateName } };
  if (status === 409 && code === 'CRM_CATALOG_NAME_IN_USE') return { kind: 'in-use', message: MESSAGES.nameInUse, fields: { nome: MESSAGES.nameInUse } };
  if (status === 400) {
    const fields = {};
    let message = MESSAGES.validation;
    const list = error && Array.isArray(error.details) ? error.details : [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const path = typeof entry.path === 'string' ? entry.path : '';
      const entryCode = typeof entry.code === 'string' ? entry.code : '';
      if (entryCode === 'NADA_A_ALTERAR') message = MESSAGES.nothingToChange;
      else if (entryCode === 'LISTA_INVALIDA') message = MESSAGES.staleList;
      else if (FIELD_PATHS.includes(path) && !Object.prototype.hasOwnProperty.call(fields, path)) fields[path] = fieldMessage(path, entryCode);
    }
    return { kind: 'validation', message, fields };
  }
  if (status === 503 || code === 'CRM_CATALOG_PERSISTENCE') return { kind: 'unavailable', message: MESSAGES.unavailable, fields: {} };
  return { kind: 'other', message: MESSAGES.generic, fields: {} };
}
