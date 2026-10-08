// Apresentação do PERFIL COMERCIAL de um lead e do RESUMO de um job de prospecção (Implementação 3.0) — compartilhada pelas telas Nova Prospecção, Histórico,
// Approval Queue e Leads Reprovados. Só monta DOM a partir de dados NÃO CONFIÁVEIS (pesquisa na web): todo texto entra por dom.mjs (textContent) e toda URL
// passa por safeHttpUrl (só http/https). Nenhuma decisão acontece aqui; nada é inventado: o que não foi verificado aparece como "Não verificado".

import { h } from '../dom.mjs';
import { textOf, safeHttpUrl, formatDate } from '../format.mjs';

const CHANNEL_LABELS = Object.freeze([
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['googleMeuNegocio', 'Google Meu Negócio'],
  ['linkedin', 'LinkedIn'],
  ['youtube', 'YouTube'],
  ['tiktok', 'TikTok'],
  ['whatsapp', 'WhatsApp'],
]);
const PLATFORM_LABELS = Object.freeze([
  ['meta', 'Meta'],
  ['google', 'Google'],
  ['tiktok', 'TikTok'],
]);
const SITE_LABELS = Object.freeze({ ENCONTRADO: 'Encontrado', NAO_ENCONTRADO: 'Não encontrado' });
const ADS_LABELS = Object.freeze({ EVIDENCIA_ENCONTRADA: 'Evidência pública encontrada', NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA: 'Nenhuma evidência pública encontrada', NAO_VERIFICADO: 'Não verificado' });
const ACTIVITY_LABELS = Object.freeze({ SIM: 'Sim', NAO: 'Não', NAO_VERIFICADO: 'Não verificado' });
const WINDOWS = Object.freeze([
  ['ultimos7Dias', '7 dias'],
  ['ultimos30Dias', '30 dias'],
  ['ultimos60Dias', '60 dias'],
  ['ultimos90Dias', '90 dias'],
]);
const SOURCE_TYPE_LABELS = Object.freeze({ OFICIAL: 'Site oficial', REDE_SOCIAL: 'Rede social', DIRETORIO: 'Diretório', NOTICIA_OU_TERCEIRO: 'Notícia / terceiro' });

export const LEAD_TYPE_LABELS = Object.freeze({
  EMPRESA: 'Empresa',
  PROFISSIONAL: 'Profissional',
  UNIDADE_FRANQUIA: 'Unidade / Franquia',
  NAO_VERIFICADO: 'Não verificado',
});

const NOT_FOUND = 'Não encontrado';

function link(document, url, label) {
  const safe = safeHttpUrl(url);
  return safe ? h(document, 'a', { href: safe, target: '_blank', rel: 'noopener noreferrer', text: textOf(label) || safe }) : h(document, 'span', { text: textOf(label) || NOT_FOUND });
}

function row(document, label, ...value) {
  return h(document, 'div', { className: 'kv-row' }, h(document, 'dt', { text: label }), h(document, 'dd', {}, ...value.flat(Infinity)));
}

function list(document, items, empty = NOT_FOUND) {
  const visible = (Array.isArray(items) ? items : []).filter(Boolean);
  if (visible.length === 0) return h(document, 'span', { text: empty });
  return h(document, 'ul', { className: 'plain-list' }, ...visible.map((item) => h(document, 'li', {}, ...(Array.isArray(item) ? item.flat(Infinity) : [item]))));
}

function sourceList(document, sources) {
  return list(document, (Array.isArray(sources) ? sources : []).map((source) => (source && typeof source.url === 'string' ? [link(document, source.url, source.url), h(document, 'span', { className: 'muted', text: ` · ${SOURCE_TYPE_LABELS[source.tipo] || textOf(source.tipo)}` })] : null)), '—');
}

// O perfil comercial completo, em blocos legíveis (sem JSON). `perfil` pode ser null (lead de uma pesquisa manual): mostra um aviso honesto.
export function buildLeadProfile(document, perfil) {
  if (!perfil || typeof perfil !== 'object') {
    return h(document, 'p', { className: 'muted', text: 'Este lead não tem análise comercial detalhada (veio de uma pesquisa anterior ou manual).' });
  }
  const owner = perfil.responsavel || {};
  const address = perfil.endereco || {};
  const site = perfil.siteOficial || {};
  const presence = perfil.presencaDigital || {};
  const ads = perfil.trafegoPago || {};
  const activity = perfil.atividadeRecente || {};
  const windows = activity.janelas || {};
  const last = activity.ultimaPostagem;

  const ownerBlock = owner.status === 'ENCONTRADO'
    ? [h(document, 'span', { text: `${textOf(owner.nome)} — ${textOf(owner.cargo) || 'cargo não informado'}` }), ' ', h(document, 'span', { className: 'muted', text: `(confiança ${textOf(owner.confianca) || 'não informada'}) ` }), link(document, owner.origem, 'fonte')]
    : [h(document, 'span', { text: NOT_FOUND })];
  const addressText = [textOf(address.rua), [textOf(address.cidade), textOf(address.estado)].filter(Boolean).join('/'), textOf(address.cep) ? `CEP ${textOf(address.cep)}` : ''].filter(Boolean).join(' · ');
  const addressBlock = address.status === 'ENCONTRADO' && addressText ? [h(document, 'span', { text: addressText }), ' ', link(document, address.origem, 'fonte')] : [h(document, 'span', { text: NOT_FOUND })];

  const channels = CHANNEL_LABELS.map(([key, label]) => {
    const channel = presence[key];
    if (!channel || channel.status !== 'ENCONTRADO' || !safeHttpUrl(channel.url)) return [h(document, 'strong', { text: `${label}: ` }), h(document, 'span', { text: channel && channel.status === 'NAO_ENCONTRADO' ? NOT_FOUND : 'Não verificado' })];
    return [h(document, 'strong', { text: `${label}: ` }), link(document, channel.url, channel.url), h(document, 'span', { className: 'muted', text: channel.confirmacao === 'CONFIRMADO' ? ' · confirmado por vínculo público' : ' · sugerido, não confirmado' })];
  });
  const phones = (Array.isArray(perfil.telefones) ? perfil.telefones : []).map((p) => [h(document, 'span', { text: `${textOf(p.numero)}${p.celular ? ' (celular)' : ''} ` }), link(document, p.origem, 'fonte')]);
  const whatsapps = (Array.isArray(perfil.whatsapps) ? perfil.whatsapps : []).map((p) => [h(document, 'span', { text: `${textOf(p.numero)} ` }), link(document, p.origem, 'fonte')]);
  const emails = (Array.isArray(perfil.emails) ? perfil.emails : []).map((m) => [h(document, 'span', { text: `${textOf(m.email)} ` }), link(document, m.origem, 'fonte')]);
  const adRows = PLATFORM_LABELS.map(([key, label]) => {
    const item = ads[key] || { status: 'NAO_VERIFICADO' };
    return [
      h(document, 'strong', { text: `${label}: ` }),
      h(document, 'span', { text: ADS_LABELS[item.status] || 'Não verificado' }),
      item.origem && safeHttpUrl(item.origem.url) ? [' · ', link(document, item.origem.url, 'fonte')] : null,
      item.data ? h(document, 'span', { className: 'muted', text: ` · ${formatDate(item.data)}` }) : null,
      item.observacao ? h(document, 'span', { className: 'muted', text: ` — ${textOf(item.observacao)}` }) : null,
    ].flat().filter(Boolean);
  });

  return h(
    document,
    'dl',
    { className: 'kv lead-profile' },
    row(document, 'Tipo de lead', h(document, 'span', { text: LEAD_TYPE_LABELS[perfil.tipoLead] || LEAD_TYPE_LABELS.NAO_VERIFICADO })),
    row(document, 'Responsável', ...ownerBlock),
    row(document, 'Endereço', ...addressBlock),
    row(document, 'Site oficial', h(document, 'span', { text: SITE_LABELS[site.status] || NOT_FOUND }), site.url ? [' ', link(document, site.url, site.url)] : null),
    row(document, 'Presença digital', list(document, channels)),
    row(document, 'Telefones', list(document, phones)),
    row(document, 'WhatsApps', list(document, whatsapps)),
    row(document, 'E-mails', list(document, emails)),
    row(document, 'Tráfego pago (informação pública)', list(document, adRows)),
    row(
      document,
      'Atividade recente',
      last ? h(document, 'span', { text: `Última postagem: ${formatDate(last.data)} (${textOf(last.canal) || 'canal'}) ` }) : h(document, 'span', { text: 'Última postagem: não verificada ' }),
      last ? link(document, last.url, 'fonte') : null,
      h(document, 'div', { className: 'muted', text: WINDOWS.map(([key, label]) => `${label}: ${ACTIVITY_LABELS[windows[key]] || 'Não verificado'}`).join(' · ') }),
      perfil.dataPesquisa ? h(document, 'div', { className: 'muted', text: `Pesquisado em ${formatDate(perfil.dataPesquisa)}` }) : null
    ),
    row(document, 'Fontes de descoberta', sourceList(document, perfil.fontesDescoberta)),
    row(document, 'Fontes de validação', sourceList(document, perfil.fontesValidacao)),
    row(document, 'Fontes de enriquecimento', sourceList(document, perfil.fontesEnriquecimento)),
    row(document, 'Outras presenças (não são site oficial)', sourceList(document, perfil.outrasPresencas))
  );
}

const SUMMARY_FIELDS = Object.freeze([
  ['solicitados', 'Solicitados'],
  ['candidatosProcessados', 'Candidatos processados'],
  ['validados', 'Validados'],
  ['naApprovalQueue', 'Na Approval Queue'],
  ['jaExistentes', 'Já existentes'],
  ['dadosInsuficientes', 'Dados insuficientes'],
  ['duplicados', 'Duplicados'],
  ['dnc', 'DNC'],
  ['reposicoes', 'Reposições'],
  ['aprovados', 'Aprovados'],
  ['rejeitados', 'Rejeitados'],
  ['promovidos', 'Promovidos'],
]);

function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// O resumo padronizado do resultado de um job (contadores únicos): `resumo` vem do servidor. Sem resumo (job antigo), devolve null.
export function buildJobSummary(document, resumo) {
  if (!resumo || typeof resumo !== 'object') return null;
  const cells = SUMMARY_FIELDS.filter(([key]) => Number.isInteger(resumo[key])).map(([key, label]) =>
    h(document, 'div', { className: 'summary-cell', 'data-key': key }, h(document, 'span', { className: 'summary-value', text: String(resumo[key]) }), h(document, 'span', { className: 'summary-label', text: label }))
  );
  cells.push(h(document, 'div', { className: 'summary-cell', 'data-key': 'tempoMs' }, h(document, 'span', { className: 'summary-value', text: formatClock(resumo.tempoMs) }), h(document, 'span', { className: 'summary-label', text: 'Tempo' })));
  if (typeof resumo.custoUsd === 'number') {
    cells.push(h(document, 'div', { className: 'summary-cell', 'data-key': 'custoUsd' }, h(document, 'span', { className: 'summary-value', text: `US$ ${resumo.custoUsd.toFixed(2)}` }), h(document, 'span', { className: 'summary-label', text: 'Custo das pesquisas' })));
  }
  return h(document, 'div', { className: 'job-summary', id: 'pros-job-summary' }, ...cells);
}
