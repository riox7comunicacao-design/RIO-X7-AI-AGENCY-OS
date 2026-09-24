// O modelo de APRESENTAÇÃO do CRM no Dashboard — só funções e dados puros: nada aqui toca o DOM, a rede ou o servidor.
//
// O que este módulo É: o vocabulário que a interface precisa para desenhar o CRM (os 13 status e seus rótulos, os 31 campos
// e o bloco de cada um), a busca e os filtros do lado do navegador, a conversão do que a pessoa digita no corpo que a
// CRM-API espera, e a tradução de cada erro da API para uma frase que uma pessoa entende.
//
// O que este módulo NÃO é: o CRM. As REGRAS continuam sendo do domínio (src/crm), atrás do CRM Service e da CRM-API:
//   - a máquina de estados NÃO existe aqui — a interface oferece os status e o SERVIDOR decide qual mudança vale
//     (409 INVALID_TRANSITION); a API ainda não devolve as transições permitidas (limite registrado);
//   - deduplicação, DO_NOT_CONTACT, validação de campo e autorização também não — o servidor recusa e a interface só
//     mostra a recusa. O único conhecimento de regra aqui é que DO_NOT_CONTACT é TERMINAL (isLocked): serve para não
//     oferecer botões que o servidor recusaria (409 RECORD_LOCKED) e para que esse status só seja alcançável pela ação
//     própria, que avisa e pede confirmação (nenhum seletor de status da tela o oferece; só o filtro da lista).
//
// O Dashboard não pode importar src/ (regra R11): o vocabulário abaixo é uma CÓPIA deliberada dos nomes do domínio, e o
// teste tests/server/dashboard-crm-model.test.js a compara com src/crm/constants.js nos dois sentidos — se o domínio
// mudar um status, um rótulo ou um campo, a suíte quebra aqui em vez de a tela mostrar algo defasado.

import { textOf, formatDate, formatDateTime } from './format.mjs';

// ---------------------------------------------------------------------------
// Status (13) — a mesma ordem do funil em src/crm/constants.js. Os rótulos são os de CRM_STATUS_LABEL (os mesmos nomes
// do CRM do Notion, que a equipe já conhece); `tone` é só a cor do selo.
// ---------------------------------------------------------------------------
export const CRM_STATUSES = Object.freeze(
  [
    { value: 'PROSPECT', label: 'Prospect', tone: 'neutral' },
    { value: 'RESEARCH', label: 'Research', tone: 'neutral' },
    { value: 'QUALIFIED_PROSPECT', label: 'Qualified Prospect', tone: 'neutral' },
    { value: 'CONTACTED', label: 'Contacted', tone: 'info' },
    { value: 'RESPONDED', label: 'Responded', tone: 'info' },
    { value: 'QUALIFICATION', label: 'Qualification', tone: 'info' },
    { value: 'MEETING_SCHEDULED', label: 'Meeting Scheduled', tone: 'info' },
    { value: 'MEETING_COMPLETED', label: 'Meeting Completed', tone: 'info' },
    { value: 'PROPOSAL', label: 'Proposal', tone: 'warn' },
    { value: 'NEGOTIATION', label: 'Negotiation', tone: 'warn' },
    { value: 'WON', label: 'Won', tone: 'ok' },
    { value: 'LOST', label: 'Lost', tone: 'neutral' },
    { value: 'DO_NOT_CONTACT', label: 'Do Not Contact', tone: 'bad' },
  ].map((status) => Object.freeze(status))
);

export const DEFAULT_INITIAL_STATUS = 'PROSPECT';
export const LOCKED_STATUS = 'DO_NOT_CONTACT';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const STATUS_BY_VALUE = new Map(CRM_STATUSES.map((status) => [status.value, status]));

export function statusLabel(value) {
  const known = STATUS_BY_VALUE.get(value);
  return known ? known.label : textOf(value) || '—';
}

export function statusTone(value) {
  const known = STATUS_BY_VALUE.get(value);
  return known ? known.tone : 'neutral';
}

// DO_NOT_CONTACT é terminal (decisão 0013): o registro não pode mais ser editado nem mudar de status. Serve só para a
// tela não oferecer o que o servidor recusaria; a regra em si é do domínio.
export function isLocked(record) {
  return Boolean(record) && record.status === LOCKED_STATUS;
}

// ---------------------------------------------------------------------------
// Campos — os 31 graváveis de src/crm/constants.js (CRM_WRITABLE_FIELDS), agrupados nos blocos da ficha. Os dois campos
// `managed` (status, dataDeEntrada) só são EXIBIDOS: o domínio os gerencia (o status muda pela ação "Mudar status").
// kind: text | textarea | email | tel | url | date | number | status | datetime
// ---------------------------------------------------------------------------
const field = (key, label, kind = 'text', extra = {}) => Object.freeze({ key, label, kind, ...extra });
const group = (id, title, fields) => Object.freeze({ id, title, fields: Object.freeze(fields) });

export const FIELD_GROUPS = Object.freeze([
  group('identificacao', 'Identificação', [
    field('empresa', 'Empresa', 'text', { required: true }),
    field('nicho', 'Nicho'),
    field('cidade', 'Cidade'),
    field('estado', 'Estado (UF)'),
    field('origem', 'Origem'),
  ]),
  group('contato', 'Contato', [
    field('contato', 'Nome do contato'),
    field('cargo', 'Cargo'),
    field('telefone', 'Telefone', 'tel'),
    field('whatsapp', 'WhatsApp', 'tel'),
    field('email', 'E-mail', 'email'),
  ]),
  group('presenca', 'Presença digital', [
    field('site', 'Site', 'url', { assumeHttps: true }),
    field('instagram', 'Instagram', 'url'),
    field('facebook', 'Facebook', 'url'),
    field('googlePerfil', 'Perfil no Google', 'url'),
  ]),
  group('comercial', 'Comercial', [
    field('servicoPotencial', 'Serviço potencial'),
    field('temperatura', 'Temperatura'),
    field('problemaIdentificado', 'Problema identificado', 'textarea'),
    field('raioXDeNicho', 'Raio-X de nicho', 'textarea'),
    field('raioXPersonalizado', 'Raio-X personalizado', 'textarea'),
    field('statusDoDiagnostico', 'Status do diagnóstico'),
    field('linkDoRaioX', 'Link do Raio-X', 'url'),
    field('dataDaAnalise', 'Data da análise', 'date'),
    field('valorProposta', 'Valor da proposta', 'number'),
    field('valorTotal', 'Valor total', 'number'),
    field('observacoes', 'Observações', 'textarea'),
  ]),
  group('pipeline', 'Pipeline', [
    field('status', 'Status', 'status', { managed: true }),
    field('dataDeEntrada', 'Data de entrada', 'datetime', { managed: true }),
    field('responsavel', 'Responsável'),
    field('dataDaReuniao', 'Data da reunião', 'date'),
    field('linkDoMeet', 'Link do Meet', 'url'),
    field('ultimaInteracao', 'Última interação', 'date'),
  ]),
  group('proxima', 'Próxima ação', [
    field('proximaAcao', 'Próxima ação', 'textarea'),
    field('dataDaProximaAcao', 'Data da próxima ação', 'date'),
  ]),
]);

// Os campos que a pessoa pode preencher/editar (todos, menos os gerenciados pelo domínio).
export const EDITABLE_FIELDS = Object.freeze(FIELD_GROUPS.flatMap((entry) => entry.fields).filter((entry) => entry.managed !== true));
export const WRITABLE_KEYS = Object.freeze(EDITABLE_FIELDS.map((entry) => entry.key));

// Os campos que ganham sugestões (datalist) tiradas dos PRÓPRIOS dados já carregados: menos digitação errada, e nenhum
// vocabulário inventado.
export const SUGGESTION_KEYS = Object.freeze(['nicho', 'cidade', 'estado', 'origem', 'temperatura', 'servicoPotencial', 'statusDoDiagnostico', 'responsavel']);

// As colunas da lista (só campos que existem na API).
export const LIST_COLUMNS = Object.freeze([
  { key: 'empresa', label: 'Empresa' },
  { key: 'contato', label: 'Contato' },
  { key: 'nicho', label: 'Nicho' },
  { key: 'cidade', label: 'Cidade' },
  { key: 'status', label: 'Status' },
  { key: 'servicoPotencial', label: 'Serviço potencial' },
  { key: 'responsavel', label: 'Responsável' },
  { key: 'proximaAcao', label: 'Próxima ação' },
  { key: 'valorProposta', label: 'Valor da proposta' },
]);

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------
const MONEY = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

// Um número finito vira "R$ 1.500,00"; qualquer outra coisa (texto, null, objeto) vira vazio.
export function formatMoney(value) {
  return typeof value === 'number' && Number.isFinite(value) ? MONEY.format(value) : '';
}

// "2026-01-15" -> "15/01/2026"; "2026-01-15T13:00:00Z" -> data e hora; qualquer outro texto passa como veio.
export function formatDateValue(value) {
  const raw = textOf(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return formatDate(raw);
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return formatDateTime(raw);
  return raw;
}

// O texto de um campo para EXIBIR (vazio = ''). Só texto e número entram; um valor de outro tipo é ignorado.
export function displayValue(entry, record) {
  const value = record && hasOwn(record, entry.key) ? record[entry.key] : null;
  if (entry.kind === 'number') return formatMoney(value);
  if (entry.kind === 'date') return formatDateValue(value);
  if (entry.kind === 'datetime') return formatDateTime(value);
  if (entry.kind === 'status') return value === null || value === undefined ? '' : statusLabel(value);
  return textOf(value);
}

// As nove colunas da lista, já em texto: `cidade` inclui o estado quando existe; `proximaAcao` inclui a data.
export function listCells(record) {
  const cidade = [textOf(record.cidade), textOf(record.estado)].filter(Boolean).join('/');
  const proxima = [textOf(record.proximaAcao), formatDateValue(record.dataDaProximaAcao)].filter(Boolean).join(' · ');
  return {
    empresa: textOf(record.empresa) || 'Sem nome',
    contato: textOf(record.contato),
    nicho: textOf(record.nicho),
    cidade,
    status: textOf(record.status),
    servicoPotencial: textOf(record.servicoPotencial),
    responsavel: textOf(record.responsavel),
    proximaAcao: proxima,
    valorProposta: formatMoney(record.valorProposta),
  };
}

// ---------------------------------------------------------------------------
// Busca e filtros (do lado do navegador, sobre os dados já carregados — não há endpoint de busca)
// ---------------------------------------------------------------------------
export function normalizeText(value) {
  return textOf(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export const digitsOf = (value) => textOf(value).replace(/\D/g, '');

const SEARCH_TEXT_KEYS = Object.freeze(['empresa', 'contato', 'telefone', 'whatsapp', 'email', 'instagram']);
const MIN_PHONE_DIGITS = 3;

// Cada palavra da busca precisa aparecer em algum dos campos pesquisáveis (sem acento, sem diferença de caixa). Uma
// palavra com pelo menos 3 dígitos também casa com o telefone/WhatsApp pelos dígitos, então "(24) 90000-0001" e
// "24900000001" encontram o mesmo número guardado com qualquer formatação.
export function matchesQuery(record, query) {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = normalizeText(SEARCH_TEXT_KEYS.map((key) => textOf(record[key])).join('\n'));
  const phones = `${digitsOf(record.telefone)}\n${digitsOf(record.whatsapp)}`;
  return tokens.every((token) => {
    if (text.includes(token)) return true;
    const digits = digitsOf(token);
    return digits.length >= MIN_PHONE_DIGITS && phones.includes(digits);
  });
}

// criteria: { query, status, nicho, responsavel } — '' significa "sem filtro". Nicho e responsável casam sem acento nem
// diferença de caixa (o mesmo critério das opções do filtro, que juntam "Psicologia" e "psicologia").
export function filterRecords(items, criteria = {}) {
  const { query = '', status = '', nicho = '', responsavel = '' } = criteria;
  const nichoKey = normalizeText(nicho);
  const responsavelKey = normalizeText(responsavel);
  return items.filter(
    (record) =>
      (status === '' || record.status === status) &&
      (nichoKey === '' || normalizeText(record.nicho) === nichoKey) &&
      (responsavelKey === '' || normalizeText(record.responsavel) === responsavelKey) &&
      matchesQuery(record, query)
  );
}

// Os valores distintos de um campo (as opções do filtro e as sugestões), ordenados; a grafia mostrada é a primeira vista.
export function distinctValues(items, key) {
  const seen = new Map();
  for (const record of items) {
    const value = textOf(record[key]);
    const id = normalizeText(value);
    if (id !== '' && !seen.has(id)) seen.set(id, value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

// Do mais recente para o mais antigo (a API devolve na ordem de criação); o desempate é o nome da empresa.
export function sortRecords(items) {
  return [...items].sort(
    (a, b) => textOf(b.dataDeEntrada).localeCompare(textOf(a.dataDeEntrada)) || textOf(a.empresa).localeCompare(textOf(b.empresa), 'pt-BR')
  );
}

// { value, label, tone, count } dos 13 status, na ordem do funil (inclui os de contagem zero).
export function countByStatus(items) {
  const counts = new Map();
  for (const record of items) counts.set(record.status, (counts.get(record.status) || 0) + 1);
  return CRM_STATUSES.map((status) => ({ ...status, count: counts.get(status.value) || 0 }));
}

// ---------------------------------------------------------------------------
// Formulários: do que a pessoa digita para o corpo da CRM-API
// ---------------------------------------------------------------------------
const rawText = (value) => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));

// "1500", "1500.5" e "1500,5" — um número finito e >= 0 (o domínio recusa o resto).
export function parseAmount(raw) {
  const text = rawText(raw).trim().replace(',', '.');
  if (text === '') return { ok: true, value: null };
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? { ok: true, value: number } : { ok: false, value: null };
}

// O valor de um campo do FORMULÁRIO em forma de dado: texto aparado (vazio = null) ou número (vazio = null).
function formValue(entry, raw) {
  if (entry.kind === 'number') {
    const parsed = parseAmount(raw);
    return parsed.ok ? parsed.value : null;
  }
  const text = rawText(raw).trim();
  return text === '' ? null : text;
}

// Os valores do formulário de edição: todo campo editável como texto ('' quando o registro não tem valor).
export function valuesFromRecord(record) {
  const values = {};
  for (const entry of EDITABLE_FIELDS) {
    const value = record && hasOwn(record, entry.key) ? record[entry.key] : null;
    values[entry.key] = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  }
  return values;
}

// { [campo]: mensagem } — vazio quando está tudo certo. A empresa é obrigatória; os valores em dinheiro precisam ser
// números >= 0. O resto (tamanho, duplicidade, DNC) é do servidor.
export function validateForm(values) {
  const errors = {};
  if (textOf(values.empresa) === '') errors.empresa = 'Informe o nome da empresa.';
  for (const entry of EDITABLE_FIELDS) {
    if (entry.kind === 'number' && !parseAmount(values[entry.key]).ok) errors[entry.key] = 'Informe um valor numérico maior ou igual a zero.';
  }
  return errors;
}

// Só o que a pessoa MUDOU, na forma que o PATCH espera (um campo esvaziado vai como null). Vazio = nada a salvar.
// A comparação é com os valores com que o formulário ABRIU (valuesFromRecord no momento da abertura), e não com o registro
// de agora: se outra pessoa editou um campo no meio tempo, o que esta pessoa não tocou não é enviado — nunca se
// sobrescreve com um valor velho o que ela nem mexeu.
export function buildPatch(initialValues, values) {
  const patch = {};
  for (const entry of EDITABLE_FIELDS) {
    const next = formValue(entry, values[entry.key]);
    if (next !== formValue(entry, initialValues ? initialValues[entry.key] : '')) patch[entry.key] = next;
  }
  return patch;
}

// Os campos preenchidos + as duas opções que a API aceita na criação (status inicial e motivo da entrada).
export function buildCreateRequest(values, { status = '', reason = '' } = {}) {
  const fields = {};
  for (const entry of EDITABLE_FIELDS) {
    const value = formValue(entry, values[entry.key]);
    if (value !== null) fields[entry.key] = value;
  }
  const options = {};
  if (textOf(status) !== '') options.status = textOf(status);
  if (textOf(reason) !== '') options.reason = textOf(reason);
  return { fields, options };
}

// ---------------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------------
// Do mais recente para o mais antigo. Só o que a API devolveu: nenhum evento é inventado.
export function describeHistory(entries, roleName = (role) => role) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const operator = entry.reviewedBy && typeof entry.reviewedBy === 'object' ? entry.reviewedBy : null;
      const name = operator ? textOf(operator.name) : '';
      const role = operator ? textOf(operator.role) : '';
      let who = '';
      if (entry.actor === 'SYSTEM') who = 'Sistema';
      else if (name !== '') who = role !== '' ? `${name} (${roleName(role)})` : name;
      const to = statusLabel(entry.to);
      return {
        when: formatDateTime(entry.timestamp),
        transition: textOf(entry.from) === '' ? `Registro criado como ${to}` : `${statusLabel(entry.from)} → ${to}`,
        who,
        reason: textOf(entry.motivo),
      };
    })
    .reverse();
}

// ---------------------------------------------------------------------------
// Permissões (só para MOSTRAR ou esconder botões — nunca autorizam: o servidor decide, e a API responde 403)
// ---------------------------------------------------------------------------
export const PERMISSIONS = Object.freeze({ READ_CRM: 'READ:CRM', WRITE_CRM: 'WRITE:CRM', REVIEW: 'APPROVE:LEAD_APPROVAL' });

// `me`: o que /api/me devolveu. As permissões vêm do servidor (derivadas da role dele), nunca do navegador.
export function permissionsOf(me) {
  const list = me && Array.isArray(me.permissions) ? me.permissions : [];
  return {
    canReadCrm: list.includes(PERMISSIONS.READ_CRM),
    canWriteCrm: list.includes(PERMISSIONS.WRITE_CRM),
    canReview: list.includes(PERMISSIONS.REVIEW),
  };
}

// ---------------------------------------------------------------------------
// Erros da API -> frases para uma pessoa
// ---------------------------------------------------------------------------
export const GENERIC_ERROR = 'Não foi possível concluir a operação agora. Tente novamente em instantes.';

const CONFLICT_MESSAGES = Object.freeze({
  DUPLICATE_RECORD: 'Já existe um registro com esta identidade (mesmo site, telefone ou Instagram). Confira antes de criar outro.',
  DNC_BLOCKED: 'Esta identidade está bloqueada como "Não contatar": o cadastro não pode usar estes dados.',
  RECORD_LOCKED: 'Este registro está bloqueado como "Não contatar" e não pode mais ser alterado.',
  INVALID_TRANSITION: 'Esta mudança de status não é permitida a partir do status atual.',
});

// 401 devolve null: quem cuida é o fluxo de login (a sessão acabou). As mensagens de 400/409 do servidor são FIXAS e
// escritas para pessoas (a CRM-API nunca repete dado de um registro nelas); o resto usa frases daqui.
export function messageForCrmError(error) {
  // Só um ApiError traz status numérico (0 = a rede falhou). Qualquer outra coisa é um erro inesperado: frase genérica.
  const status = error && typeof error.status === 'number' ? error.status : null;
  if (status === null) return GENERIC_ERROR;
  if (status === 401) return null;
  if (status === 403) return 'Sua conta não tem permissão para esta ação.';
  if (status === 404) return 'Registro não encontrado.';
  if (status === 409) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    return hasOwn(CONFLICT_MESSAGES, code) ? CONFLICT_MESSAGES[code] : 'Esta ação não pôde ser concluída no estado atual do registro. Atualize a página e tente novamente.';
  }
  if (status === 400) {
    const detail = error && typeof error.serverMessage === 'string' ? error.serverMessage.trim() : '';
    return detail !== '' ? detail : 'Dados inválidos. Confira os campos e tente novamente.';
  }
  if (status === 413) return 'Os dados enviados são grandes demais.';
  if (status === 0) return 'Sem conexão com o servidor. Verifique a internet e tente novamente.';
  return GENERIC_ERROR;
}
