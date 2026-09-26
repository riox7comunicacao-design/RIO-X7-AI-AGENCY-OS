// Dos ACHADOS BRUTOS (já validados) aos FATOS do dossiê — a tradução determinística da integração (decisão 0019).
//
// Função pura: sem CRM, sem disco, sem rede, sem relógio próprio (a data de reserva é injetada). Só olha o que o achado JÁ traz
// (`campos.<campo>: [{ valor, fonte, tipoFonte, url?, dataConsulta? }]`); não inventa nada que o achado não diga:
//
//   site, instagram, facebook, linkedin, youtube, googlePerfil  -> fato <campo>.url
//   whatsapp                                                    -> fato whatsapp.publico (valor true)
//
// Um fato é DADO só quando há, ao mesmo tempo, (a) um valor que é (ou vira, só pela troca de "sem esquema" para https://, no caso
// de um domínio) uma URL https válida — "@usuario" e telefones NÃO viram URL —, (b) a URL https da fonte e (c) a data da consulta;
// a fonte do fato é { url, tipo (o tipoFonte), observadoEm (a dataConsulta), nome (a fonte) }. Sem isso o fato é NAO_VERIFICADO de
// valor nulo (a pesquisa não confirmou nada) — nunca uma URL, uma data ou uma fonte inventada. Um campo sem evidência não gera
// fato (a ausência de fato não é a ausência da coisa). No máximo LIMITS.FATOS_POR_CAMPO fatos DADO por campo (os primeiros).
//
// Não há fato de atividade do Instagram, CTA, formulário nem anúncios, e não há análises: o achado não tem onde trazê-los, então
// esses sinais simplesmente não nascem. O dossiê (buildDossier) revalida TUDO; aqui só se monta a entrada.

const { LIMITS } = require('./dossier');

const FIELD_TO_FACT = Object.freeze({
  site: 'site.url',
  instagram: 'instagram.url',
  facebook: 'facebook.url',
  linkedin: 'linkedin.url',
  youtube: 'youtube.url',
  googlePerfil: 'googlePerfil.url',
  whatsapp: 'whatsapp.publico',
});

const BARE_DOMAIN = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?:[/?#]\S*)?$/;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// O valor da evidência como URL https, ou null. Um domínio sem esquema ganha "https://"; "@usuario" e o resto NÃO viram URL.
function asHttpsUrl(valor) {
  if (typeof valor !== 'string') return null;
  if (/^https:\/\//i.test(valor)) return valor;
  return BARE_DOMAIN.test(valor) ? `https://${valor}` : null;
}

// finding: um achado VÁLIDO (rawFindingSchema). fallbackDate: AAAA-MM-DD usada só como data de um fato NAO_VERIFICADO sem dataConsulta.
function factsFromFinding(finding, fallbackDate) {
  const facts = [];
  const campos = finding && typeof finding.campos === 'object' && finding.campos !== null ? finding.campos : {};
  for (const [field, campo] of Object.entries(FIELD_TO_FACT)) {
    const evidences = hasOwn(campos, field) && Array.isArray(campos[field]) ? campos[field] : [];
    if (evidences.length === 0) continue;
    const verified = [];
    for (const evidence of evidences) {
      const valor = campo === 'whatsapp.publico' ? true : asHttpsUrl(evidence.valor);
      if (valor === null || !evidence.url || !evidence.dataConsulta) continue;
      verified.push({
        campo,
        valor,
        status: 'DADO',
        observadoEm: evidence.dataConsulta,
        fonte: { url: evidence.url, tipo: evidence.tipoFonte, observadoEm: evidence.dataConsulta, nome: evidence.fonte },
      });
    }
    if (verified.length > 0) facts.push(...verified.slice(0, LIMITS.FATOS_POR_CAMPO));
    else facts.push({ campo, valor: null, status: 'NAO_VERIFICADO', observadoEm: evidences[0].dataConsulta || finding.dataDaPesquisa || fallbackDate });
  }
  return facts;
}

module.exports = { FIELD_TO_FACT, factsFromFinding };
