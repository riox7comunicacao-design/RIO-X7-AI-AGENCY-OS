// O modelo de APRESENTAÇÃO do CRM no Dashboard — só funções e dados puros: nada aqui toca o DOM, a rede ou o servidor.
//
// O que este módulo É: o vocabulário que a interface precisa para desenhar o CRM (os 13 status e seus rótulos, os 35 campos (31 legados + 4 de identificação PF/PJ)
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
import { STATUS_LABELS, localizeStoredText } from './i18n/pt-BR.mjs';

// ---------------------------------------------------------------------------
// Status (13) — a mesma ordem do funil em src/crm/constants.js. Os rótulos são os de CRM_STATUS_LABEL (os mesmos nomes
// do CRM do Notion, que a equipe já conhece); `tone` é só a cor do selo.
// ---------------------------------------------------------------------------
export const CRM_STATUSES = Object.freeze(
  [
    { value: 'PROSPECT', label: STATUS_LABELS.PROSPECT, tone: 'neutral' },
    { value: 'RESEARCH', label: STATUS_LABELS.RESEARCH, tone: 'neutral' },
    { value: 'QUALIFIED_PROSPECT', label: STATUS_LABELS.QUALIFIED_PROSPECT, tone: 'neutral' },
    { value: 'CONTACTED', label: STATUS_LABELS.CONTACTED, tone: 'info' },
    { value: 'RESPONDED', label: STATUS_LABELS.RESPONDED, tone: 'info' },
    { value: 'QUALIFICATION', label: STATUS_LABELS.QUALIFICATION, tone: 'info' },
    { value: 'MEETING_SCHEDULED', label: STATUS_LABELS.MEETING_SCHEDULED, tone: 'info' },
    { value: 'MEETING_COMPLETED', label: STATUS_LABELS.MEETING_COMPLETED, tone: 'info' },
    { value: 'PROPOSAL', label: STATUS_LABELS.PROPOSAL, tone: 'warn' },
    { value: 'NEGOTIATION', label: STATUS_LABELS.NEGOTIATION, tone: 'warn' },
    { value: 'WON', label: STATUS_LABELS.WON, tone: 'ok' },
    { value: 'LOST', label: STATUS_LABELS.LOST, tone: 'neutral' },
    { value: 'DO_NOT_CONTACT', label: STATUS_LABELS.DO_NOT_CONTACT, tone: 'bad' },
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
// Cliente Pessoa Física / Pessoa Jurídica (Fase D2). Esta é uma CÓPIA deliberada das regras de src/crm/clientIdentity.js (o Dashboard não importa src/, regra R11):
// serve só para a tela avisar ANTES de enviar. O servidor repete tudo e tem a palavra final; tests/server/dashboard-crm-person.test.js compara as duas implementações.
// ---------------------------------------------------------------------------
export const TIPOS_PESSOA = Object.freeze([
  Object.freeze({ value: 'PF', label: 'Pessoa Física' }),
  Object.freeze({ value: 'PJ', label: 'Pessoa Jurídica' }),
]);
export const SEM_TIPO = 'SEM_TIPO'; // só no filtro da lista: os registros antigos, ainda sem tipo definido

export function tipoLabel(value) {
  const known = TIPOS_PESSOA.find((tipo) => tipo.value === value);
  return known ? known.label : 'Sem tipo definido';
}
export const tipoShort = (value) => (value === 'PF' || value === 'PJ' ? value : 'Sem tipo');

// O nome pelo qual o cliente é mostrado: PF -> nome completo; PJ e registro sem tipo -> empresa (cada um cai no outro quando o primeiro falta).
export function clientName(record) {
  if (!record || typeof record !== 'object') return '';
  const empresa = textOf(record.empresa).trim();
  const nomeCompleto = textOf(record.nomeCompleto).trim();
  return record.tipoPessoa === 'PF' ? nomeCompleto || empresa : empresa || nomeCompleto;
}

// O rótulo de um cliente numa LISTA DE ESCOLHA (ex.: o formulário de negociação): o nome e, quando há, o tipo — "Maria Souza (PF)", "Clínica Aurora (PJ)"; registro antigo, só o nome.
export function clientOptionLabel(record) {
  const name = clientName(record) || 'Sem nome';
  return record && (record.tipoPessoa === 'PF' || record.tipoPessoa === 'PJ') ? name + ' (' + record.tipoPessoa + ')' : name;
}

// "123.456.789-09" -> "12345678909"; "12.abc.345/01de-35" -> "12ABC34501DE35"; vazio -> ''.
export function normalizeDocument(value) {
  // só texto (como no domínio): um número ou um objeto nunca é um documento
  if (typeof value !== 'string') return '';
  return value.replace(/[.\-/\s]/g, '').toUpperCase();
}
const allSame = (text) => text.split('').every((char) => char === text[0]);
export function isValidCpf(value) {
  const cpf = normalizeDocument(value);
  if (!/^\d{11}$/.test(cpf) || allSame(cpf)) return false;
  const digits = cpf.split('').map(Number);
  const check = (length) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += digits[i] * (length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === digits[9] && check(10) === digits[10];
}
const CNPJ_WEIGHTS_12 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_WEIGHTS_13 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const cnpjDigit = (chars, weights) => {
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) sum += (chars.charCodeAt(i) - 48) * weights[i];
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
};
export function isValidCnpj(value) {
  const cnpj = normalizeDocument(value);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj) || allSame(cnpj)) return false;
  const first = cnpjDigit(cnpj.slice(0, 12), CNPJ_WEIGHTS_12);
  const second = cnpjDigit(cnpj.slice(0, 12) + String(first), CNPJ_WEIGHTS_13);
  return cnpj.slice(12) === `${first}${second}`;
}
// Só para MOSTRAR: um documento válido em forma de máscara; qualquer outra coisa passa como veio.
export function formatCpf(value) {
  const cpf = normalizeDocument(value);
  return /^\d{11}$/.test(cpf) ? `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}` : textOf(value);
}
export function formatCnpj(value) {
  const cnpj = normalizeDocument(value);
  return /^[0-9A-Z]{12}\d{2}$/.test(cnpj) ? `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}` : textOf(value);
}

// Quais campos de identificação fazem sentido para o tipo escolhido (a tela esconde os outros enquanto estão vazios; um campo já preenchido nunca é escondido,
// para o dado nunca sumir da vista nem ser descartado em silêncio). Sem tipo (registro antigo ou formulário novo ainda sem escolha): só a empresa, como sempre foi.
export function relevantIdentityKeys(tipo) {
  if (tipo === 'PF') return ['nomeCompleto', 'cpf'];
  if (tipo === 'PJ') return ['empresa', 'cnpj', 'contato'];
  return ['empresa'];
}

// ---------------------------------------------------------------------------
// Campos — os 35 graváveis de src/crm/constants.js (CRM_WRITABLE_FIELDS: os 31 legados + tipoPessoa, nomeCompleto, cpf e cnpj), agrupados nos blocos da ficha. Os dois campos
// `managed` (status, dataDeEntrada) só são EXIBIDOS: o domínio os gerencia (o status muda pela ação "Mudar status").
// kind: text | textarea | email | tel | url | date | number | status | datetime
// ---------------------------------------------------------------------------
const field = (key, label, kind = 'text', extra = {}) => Object.freeze({ key, label, kind, ...extra });
const group = (id, title, fields) => Object.freeze({ id, title, fields: Object.freeze(fields) });

export const FIELD_GROUPS = Object.freeze([
  group('identificacao', 'Identificação', [
    field('tipoPessoa', 'Tipo de pessoa', 'tipo'),
    field('nomeCompleto', 'Nome completo'),
    // a empresa é obrigatória para Pessoa Jurídica e para o registro ainda sem tipo (a tela mostra o "(obrigatório)" conforme o tipo escolhido)
    field('empresa', 'Empresa'),
    field('cpf', 'CPF', 'cpf'),
    field('cnpj', 'CNPJ', 'cnpj'),
    field('nicho', 'Nicho'),
    field('cidade', 'Cidade'),
    field('estado', 'Estado (UF)'),
    field('origem', 'Origem do Lead'),
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
  group('pipeline', 'Funil de Vendas', [
    field('status', 'Status', 'status', { managed: true }),
    field('dataDeEntrada', 'Data de entrada', 'datetime', { managed: true }),
    field('responsavel', 'Responsável'),
    field('dataDaReuniao', 'Data da reunião', 'date'),
    field('linkDoMeet', 'Link do Google Meet', 'url'),
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
  { key: 'empresa', label: 'Cliente' }, // o nome de exibição: empresa (PJ e registros antigos) ou nome completo (PF)
  { key: 'tipoPessoa', label: 'Tipo' },
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
  if (entry.kind === 'tipo') return value === 'PF' || value === 'PJ' ? tipoLabel(value) : '';
  if (entry.kind === 'cpf') return formatCpf(value);
  if (entry.kind === 'cnpj') return formatCnpj(value);
  return textOf(value);
}

// As nove colunas da lista, já em texto: `cidade` inclui o estado quando existe; `proximaAcao` inclui a data.
export function listCells(record) {
  const cidade = [textOf(record.cidade), textOf(record.estado)].filter(Boolean).join('/');
  const proxima = [textOf(record.proximaAcao), formatDateValue(record.dataDaProximaAcao)].filter(Boolean).join(' · ');
  return {
    empresa: clientName(record) || 'Sem nome',
    tipoPessoa: tipoShort(record.tipoPessoa),
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

const SEARCH_TEXT_KEYS = Object.freeze(['empresa', 'nomeCompleto', 'contato', 'telefone', 'whatsapp', 'email', 'instagram']);
const MIN_PHONE_DIGITS = 3;

// Cada palavra da busca precisa aparecer em algum dos campos pesquisáveis (sem acento, sem diferença de caixa). Uma
// palavra com pelo menos 3 dígitos também casa com o telefone/WhatsApp pelos dígitos, então "(24) 90000-0001" e
// "24900000001" encontram o mesmo número guardado com qualquer formatação.
export function matchesQuery(record, query) {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = normalizeText(SEARCH_TEXT_KEYS.map((key) => textOf(record[key])).join('\n'));
  const phones = `${digitsOf(record.telefone)}\n${digitsOf(record.whatsapp)}`;
  // CPF e CNPJ: pelo documento sem pontuação ("529.982.247-25" e "52998224725" encontram o mesmo cliente)
  const documents = `${normalizeDocument(record.cpf)}\n${normalizeDocument(record.cnpj)}`.toLowerCase();
  return tokens.every((token) => {
    if (text.includes(token)) return true;
    const digits = digitsOf(token);
    if (digits.length >= MIN_PHONE_DIGITS && phones.includes(digits)) return true;
    const document = normalizeDocument(token).toLowerCase();
    return document.length >= MIN_PHONE_DIGITS && documents.includes(document);
  });
}

// criteria: { query, status, nicho, responsavel, tipo } — '' significa "sem filtro"; tipo: 'PF', 'PJ' ou 'SEM_TIPO' (os registros antigos, ainda sem tipo definido). Nicho e responsável casam sem acento nem
// diferença de caixa (o mesmo critério das opções do filtro, que juntam "Psicologia" e "psicologia").
export function filterRecords(items, criteria = {}) {
  const { query = '', status = '', nicho = '', responsavel = '', tipo = '' } = criteria;
  const nichoKey = normalizeText(nicho);
  const responsavelKey = normalizeText(responsavel);
  return items.filter(
    (record) =>
      (status === '' || record.status === status) &&
      (tipo === '' || (tipo === SEM_TIPO ? record.tipoPessoa !== 'PF' && record.tipoPessoa !== 'PJ' : record.tipoPessoa === tipo)) &&
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
  return [...items].sort((a, b) => textOf(b.dataDeEntrada).localeCompare(textOf(a.dataDeEntrada)) || clientName(a).localeCompare(clientName(b), 'pt-BR'));
}

// As ordens da lista: SÓ critérios que existem nos dados do registro (nada de coluna inventada). A ordem padrão é a de sempre.
export const SORT_OPTIONS = Object.freeze([
  { value: 'recentes', label: 'Mais recentes' },
  { value: 'antigos', label: 'Mais antigos' },
  { value: 'empresa', label: 'Cliente (A–Z)' },
  { value: 'status', label: 'Status (ordem do funil)' },
  { value: 'proxima', label: 'Próxima ação (mais próxima)' },
  { value: 'valor', label: 'Maior valor da proposta' },
]);

const byCompany = (a, b) => clientName(a).localeCompare(clientName(b), 'pt-BR');
const numberOrNull = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
// Quem não tem o dado (sem próxima ação, sem valor) vai sempre para o fim, em qualquer sentido.
const withValueFirst = (a, b, pick, compare) => {
  const left = pick(a);
  const right = pick(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compare(left, right);
};

export function sortRecordsBy(items, sort = 'recentes') {
  const comparers = {
    recentes: (a, b) => textOf(b.dataDeEntrada).localeCompare(textOf(a.dataDeEntrada)) || byCompany(a, b),
    antigos: (a, b) => textOf(a.dataDeEntrada).localeCompare(textOf(b.dataDeEntrada)) || byCompany(a, b),
    empresa: (a, b) => byCompany(a, b) || textOf(b.dataDeEntrada).localeCompare(textOf(a.dataDeEntrada)),
    status: (a, b) => CRM_STATUSES.findIndex((s) => s.value === a.status) - CRM_STATUSES.findIndex((s) => s.value === b.status) || byCompany(a, b),
    proxima: (a, b) => withValueFirst(a, b, (r) => (textOf(r.dataDaProximaAcao) === '' ? null : textOf(r.dataDaProximaAcao)), (x, y) => x.localeCompare(y)) || byCompany(a, b),
    valor: (a, b) => withValueFirst(a, b, (r) => numberOrNull(r.valorProposta), (x, y) => y - x) || byCompany(a, b),
  };
  return [...items].sort(Object.prototype.hasOwnProperty.call(comparers, sort) ? comparers[sort] : comparers.recentes);
}

// ---------------------------------------------------------------------------
// As abas da ficha (gaveta): cada campo existente aparece em UMA aba, em seções que já eram os blocos da ficha. Nenhum campo é inventado.
// ---------------------------------------------------------------------------
export const RECORD_TABS = Object.freeze([
  Object.freeze({
    key: 'resumo',
    label: 'Resumo',
    sections: Object.freeze([
      Object.freeze({ title: 'Identificação', keys: Object.freeze(['tipoPessoa', 'nomeCompleto', 'empresa', 'cpf', 'cnpj', 'nicho', 'cidade', 'estado', 'origem']) }),
      Object.freeze({ title: 'Funil de Vendas', keys: Object.freeze(['status', 'dataDeEntrada', 'responsavel', 'ultimaInteracao']) }),
      Object.freeze({ title: 'Próxima ação', keys: Object.freeze(['proximaAcao', 'dataDaProximaAcao']) }),
    ]),
  }),
  Object.freeze({
    key: 'contato',
    label: 'Contato e presença',
    sections: Object.freeze([
      Object.freeze({ title: 'Contato', keys: Object.freeze(['contato', 'cargo', 'telefone', 'whatsapp', 'email']) }),
      Object.freeze({ title: 'Presença digital', keys: Object.freeze(['site', 'instagram', 'facebook', 'googlePerfil']) }),
    ]),
  }),
  Object.freeze({
    key: 'comercial',
    label: 'Comercial',
    sections: Object.freeze([
      Object.freeze({ title: 'Comercial', keys: Object.freeze(['servicoPotencial', 'temperatura', 'problemaIdentificado', 'raioXDeNicho', 'raioXPersonalizado', 'statusDoDiagnostico', 'linkDoRaioX', 'dataDaAnalise', 'valorProposta', 'valorTotal', 'observacoes']) }),
      Object.freeze({ title: 'Reunião', keys: Object.freeze(['dataDaReuniao', 'linkDoMeet']) }),
    ]),
  }),
  Object.freeze({ key: 'historico', label: 'Histórico', sections: Object.freeze([]) }),
]);

// { value, label, tone, count } dos 13 status, na ordem do funil (inclui os de contagem zero).
export function countByStatus(items) {
  const counts = new Map();
  for (const record of items) counts.set(record.status, (counts.get(record.status) || 0) + 1);
  return CRM_STATUSES.map((status) => ({ ...status, count: counts.get(status.value) || 0 }));
}

// ---------------------------------------------------------------------------
// O formulário de NOVO CLIENTE (Fase D2): o essencial à vista e o resto numa seção expansível. TODO campo editável do registro aparece em exatamente UMA destas seções
// (um teste confere): nada é eliminado, só escondido até a pessoa querer. `principal` é o que se pede de início; `mais` é o que fica recolhido.
// ---------------------------------------------------------------------------
export const CLIENT_FORM_SECTIONS = Object.freeze({
  principal: Object.freeze([
    Object.freeze({ id: 'quem', title: 'Quem é o cliente', keys: Object.freeze(['tipoPessoa', 'nomeCompleto', 'empresa', 'cpf', 'cnpj', 'contato']) }),
    Object.freeze({ id: 'falar', title: 'Como falar com ele', keys: Object.freeze(['telefone', 'whatsapp', 'email']) }),
    Object.freeze({ id: 'classificacao', title: 'Classificação', keys: Object.freeze(['nicho', 'origem', 'responsavel']) }),
  ]),
  mais: Object.freeze([
    Object.freeze({ id: 'redes', title: 'Redes sociais e presença digital', keys: Object.freeze(['site', 'instagram', 'facebook', 'googlePerfil']) }),
    Object.freeze({ id: 'adicionais', title: 'Informações adicionais', keys: Object.freeze(['cargo', 'cidade', 'estado']) }),
    Object.freeze({
      id: 'legado',
      title: 'Diagnóstico e histórico comercial',
      keys: Object.freeze(['servicoPotencial', 'temperatura', 'problemaIdentificado', 'raioXDeNicho', 'raioXPersonalizado', 'statusDoDiagnostico', 'linkDoRaioX', 'dataDaAnalise', 'valorProposta', 'valorTotal', 'observacoes']),
    }),
    Object.freeze({ id: 'agenda', title: 'Reunião e próxima ação', keys: Object.freeze(['ultimaInteracao', 'dataDaReuniao', 'linkDoMeet', 'proximaAcao', 'dataDaProximaAcao']) }),
  ]),
});

// Fase D2.1: as ABAS dentro de "Mais informações (opcional)". Cada aba mostra as seções (`sections`: ids de CLIENT_FORM_SECTIONS.mais) que lhe cabem; os campos continuam sendo exatamente os mesmos, só
// distribuídos por assunto. A aba "Entrada" não tem campo do registro: guarda o status inicial e o motivo da entrada (que não são campos do cliente e a tela monta). O responsável fica em
// "Classificação" (à vista, no bloco principal): é um campo do cadastro essencial e não se repete aqui.
export const CLIENT_MORE_TABS = Object.freeze([
  Object.freeze({ key: 'digital', label: 'Digital', sections: Object.freeze(['redes']) }),
  Object.freeze({ key: 'adicionais', label: 'Adicionais', sections: Object.freeze(['adicionais']) }),
  Object.freeze({ key: 'comercial', label: 'Comercial', sections: Object.freeze(['legado']) }),
  Object.freeze({ key: 'funil', label: 'Funil', sections: Object.freeze(['agenda']) }),
  Object.freeze({ key: 'entrada', label: 'Entrada', sections: Object.freeze([]) }),
]);

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
  // CPF e CNPJ vão (e são comparados) só com os caracteres do documento: a máscara é só da tela
  if (entry.kind === 'cpf' || entry.kind === 'cnpj') {
    const document = normalizeDocument(raw);
    return document === '' ? null : document;
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

// { [campo]: mensagem } — vazio quando está tudo certo. As regras espelham as do servidor (que repete tudo e decide): num cadastro NOVO o tipo de pessoa é obrigatório; PF exige o
// nome completo e PJ (e o registro antigo, sem tipo) exige a empresa; CPF e CNPJ são opcionais mas, preenchidos, precisam ser válidos e do tipo certo; os valores em dinheiro
// precisam ser números >= 0. O resto (tamanho, duplicidade, DNC) é do servidor. `creating`: true no formulário de novo cliente.
export function validateForm(values, { creating = false } = {}) {
  const errors = {};
  const tipo = textOf(values.tipoPessoa);
  const filled = (key) => textOf(values[key]).trim() !== '';
  if (tipo !== '' && tipo !== 'PF' && tipo !== 'PJ') errors.tipoPessoa = 'Escolha Pessoa Física ou Pessoa Jurídica.';
  else if (tipo === '' && creating) errors.tipoPessoa = 'Escolha se o cliente é Pessoa Física ou Pessoa Jurídica.';
  else if (tipo === '' && (filled('nomeCompleto') || filled('cpf') || filled('cnpj'))) errors.tipoPessoa = 'Escolha o tipo de pessoa para informar nome completo, CPF ou CNPJ.';

  if (tipo === 'PF') {
    if (!filled('nomeCompleto')) errors.nomeCompleto = 'Informe o nome completo.';
    if (filled('cnpj')) errors.cnpj = 'O CNPJ só vale para Pessoa Jurídica.';
  } else if (tipo === 'PJ') {
    if (!filled('empresa')) errors.empresa = 'Informe o nome da empresa.';
    if (filled('nomeCompleto')) errors.nomeCompleto = 'O nome completo só vale para Pessoa Física; para uma empresa use o campo Empresa.';
    if (filled('cpf')) errors.cpf = 'O CPF só vale para Pessoa Física.';
  } else if (!(creating && tipo === '') && !filled('empresa')) {
    errors.empresa = 'Informe o nome da empresa.';
  }
  if (filled('cpf') && !isValidCpf(values.cpf) && errors.cpf === undefined) errors.cpf = 'CPF inválido. Confira os 11 números.';
  if (filled('cnpj') && !isValidCnpj(values.cnpj) && errors.cnpj === undefined) errors.cnpj = 'CNPJ inválido. Confira os 14 caracteres.';
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
        reason: localizeStoredText(textOf(entry.motivo)), // só a exibição: o motivo guardado não muda
      };
    })
    .reverse();
}

// ---------------------------------------------------------------------------
// Permissões (só para MOSTRAR ou esconder botões — nunca autorizam: o servidor decide, e a API responde 403)
// ---------------------------------------------------------------------------
// DELETE_CRM (decisão 0025): exclusão ADMINISTRATIVA e IRREVERSÍVEL do registro — deliberadamente separada de
// WRITE_CRM, e só ADMIN a recebe (ver src/auth/constants.js). Serve só para MOSTRAR ou esconder o botão "Excluir
// registro"; quem decide de verdade é o servidor (403 mesmo se a tela for manipulada).
// PROPOSE_CRM (reestruturação Prospecção/CRM/Funis, Etapa "Funis 2"): a ação COMERCIAL de criar/mover um card —
// ADMIN e COMMERCIAL_CLOSER têm as duas (ver src/auth/constants.js/crmBridge.js).
// PROPOSE_LEAD_APPROVAL (Etapa "Prospecção 1"): submeter um brief/achados ao Workbench de Prospecção — a MESMA
// permissão que já autoriza o Prospecting Service existente (ADMIN tem; COMMERCIAL_CLOSER não — decisão já vigente).
export const PERMISSIONS = Object.freeze({
  READ_CRM: 'READ:CRM',
  WRITE_CRM: 'WRITE:CRM',
  DELETE_CRM: 'DELETE:CRM',
  PROPOSE_CRM: 'PROPOSE:CRM',
  REVIEW: 'APPROVE:LEAD_APPROVAL',
  PROPOSE_LEAD_APPROVAL: 'PROPOSE:LEAD_APPROVAL',
  // Administrar Exclusões Permanentes de Prospecção (Workbench, Etapa 2) — só ADMIN.
  MANAGE_PROSPECTING_EXCLUSIONS: 'MANAGE:PROSPECTING_EXCLUSIONS',
  // Administrar os catálogos do CRM — Serviços, Nichos e Origens dos Leads (Fase 2B-1/2B-2, decisão 0026) — só ADMIN. Consultar os itens ATIVOS exige só READ:CRM.
  MANAGE_CRM_CATALOGS: 'MANAGE:CRM_CATALOGS',
  // Administrar a estrutura dos funis (MANAGE:FUNNELS, só ADMIN): aqui só decide se o item de menu "Gestão de Funis e Etapas" aparece.
  MANAGE_FUNNELS: 'MANAGE:FUNNELS',
});

// `me`: o que /api/me devolveu. As permissões vêm do servidor (derivadas da role dele), nunca do navegador.
export function permissionsOf(me) {
  const list = me && Array.isArray(me.permissions) ? me.permissions : [];
  return {
    canReadCrm: list.includes(PERMISSIONS.READ_CRM),
    canWriteCrm: list.includes(PERMISSIONS.WRITE_CRM),
    canDeleteCrm: list.includes(PERMISSIONS.DELETE_CRM),
    canProposeCrm: list.includes(PERMISSIONS.PROPOSE_CRM),
    canReview: list.includes(PERMISSIONS.REVIEW),
    canProposeLead: list.includes(PERMISSIONS.PROPOSE_LEAD_APPROVAL),
    canManageProspectingExclusions: list.includes(PERMISSIONS.MANAGE_PROSPECTING_EXCLUSIONS),
    canManageCrmCatalogs: list.includes(PERMISSIONS.MANAGE_CRM_CATALOGS),
    canManageFunnels: list.includes(PERMISSIONS.MANAGE_FUNNELS),
  };
}

// ---------------------------------------------------------------------------
// Erros da API -> frases para uma pessoa
// ---------------------------------------------------------------------------
export const GENERIC_ERROR = 'Não foi possível concluir a operação agora. Tente novamente em instantes.';

const CONFLICT_MESSAGES = Object.freeze({
  DUPLICATE_RECORD: 'Já existe um registro com esta identidade (mesmo site, telefone ou Instagram). Confira antes de criar outro.',
  DNC_BLOCKED: 'Esta identidade está bloqueada como "Não Contatar": o cadastro não pode usar estes dados.',
  RECORD_LOCKED: 'Este registro está bloqueado como "Não Contatar" e não pode mais ser alterado.',
  INVALID_TRANSITION: 'Esta mudança de status não é permitida a partir do status atual.',
  // Integridade CRM ↔ Card (Etapa "Funis 2 — correção final"): excluir é recusado enquanto o registro tiver Cards
  // ativos em algum Funil — a regra é sempre do servidor (seção 8); esta tela só mostra a explicação.
  CRM_HAS_ACTIVE_FUNNEL_CARDS: 'Este registro possui Cards ativos em funis. Arquive os Cards antes de excluir o registro.',
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
