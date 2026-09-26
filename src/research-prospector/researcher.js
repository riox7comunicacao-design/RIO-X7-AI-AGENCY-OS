// Researcher V1 — transforma PESQUISA PÚBLICA em achados rawFinding V2 (decisão 0021). Só o módulo: nenhuma pesquisa real é executada aqui.
//
//   briefing --> [porta de busca] --> candidatos --> [porta de página] --> evidências e observações --> rawFinding V2 (validado)
//                                                    [porta de anúncios]
//
// O QUE FAZ: dado um briefing (o mesmo que o Prospecting Service valida), pede a uma PORTA de busca os candidatos públicos, visita (por uma
// PORTA de página) o site oficial e o perfil do Instagram de cada um, consulta (por uma PORTA de anúncios) as bibliotecas públicas de
// anúncios e devolve SÓ dados estruturados no formato do rawFinding V2 — cada achado já validado por validateRawFindingsV2 (o contrato
// não mudou). O Researcher é a ÚNICA peça que sabe QUAIS fontes valem e COMO uma observação vira evidência; as portas só entregam o que
// viram (o adaptador real — HTTP, navegador — é uma etapa futura e NÃO existe aqui: este módulo não importa rede, disco, CRM, fila, serviço,
// autorização nem relógio próprio).
//
// O QUE NUNCA FAZ: escrever no CRM ou na Approval Queue, aprovar, rejeitar, promover, enviar comunicação, criar score, ranking,
// temperatura, prioridade ou decisão comercial, gerar análise ou hipótese (sem IA: só fatos e o "não verificado"), inferir telefone,
// WhatsApp, e-mail, proprietário ou responsável (só o que a página publica como link explícito), contornar login, captcha, robots ou
// qualquer controle de acesso, nem transformar ausência de resultado em afirmação negativa ("não anuncia", "site não existe",
// "Instagram inativo" NUNCA são produzidos).
//
// REGRAS DE EVIDÊNCIA (todas determinísticas — researchPolicy.js):
//   - toda informação externa vira uma evidência com { valor, fonte, tipoFonte, url https pública, dataConsulta };
//   - OFICIAL: o próprio site (a página lida) e o que ele LINKA (Instagram, Facebook, LinkedIn, YouTube, Google Perfil, wa.me, tel:,
//     mailto:); SECUNDARIA: o que só a busca apontou (a URL da busca é a fonte);
//   - dois valores diferentes para o mesmo canal são preservados como CONFLITO (o discovery e o dossiê os tratam), nunca escolhidos;
//   - uma falha (login, captcha, robots, perfil privado, fora do ar, tempo) vira fato NAO_VERIFICADO com `motivo` e a pesquisa SEGUE:
//     nada é contornado nem afirmado;
//   - anúncios: IDENTIFICADO só se o nome do anunciante for IGUAL ao da empresa (mesma normalização do discovery); uma verificação feita
//     sem esse anunciante é NAO_ENCONTRADO_NA_VERIFICACAO (com a biblioteca e a data); uma falha é NAO_VERIFICADO;
//   - Instagram: só datas de postagens observadas (no máximo as 30 mais recentes, declarado no relatório) e o CTA da bio que a página
//     mostra; perfil privado = NAO_VERIFICADO (PERFIL_PRIVADO); nenhuma "atividade" é afirmada aqui (o sinal é derivado pelo dossiê);
//   - NADA é cortado em silêncio: o que não coube (mais de 5 evidências de um campo, links, datas futuras, fontes) é omitido COM código no
//     relatório.
//
// PORTAS (injetadas; síncronas ou assíncronas; a saída é dado NÃO CONFIÁVEL e é revalidada aqui):
//   search({ consulta, limite })  -> { ok: true, resultados: [{ nome, url, tipoResultado, fonteUrl, cidade?, estado?, tipo?, nicho? }] } | { ok: false, falha }
//   fetchPage(url)                -> { ok: true, urlFinal, links: [{ href, texto? }], temFormularioContato?, perfil?: { privado?, postagens?: [data], ctaBio? } } | { ok: false, falha }
//   lookupAds({ plataforma, nome, regiao }) -> { ok: true, url, anunciantes: [{ nome }] } | { ok: false, falha }      (opcional)
// `falha` é um código de researchPolicy.FAILURE. CONTRATO DO ADAPTADOR (futuro): só páginas públicas por https, respeitar robots.txt
// (devolver ROBOTS), devolver LOGIN/CAPTCHA/BLOQUEADO em vez de tentar passar, limite de taxa e tempo por chamada.

const { isPlainObject, ownEntries, ownItems, measure, checkText, checkDate, LIMITS: SCHEMA_LIMITS } = require('./rawFindingSchema');
const { validateRawFindingsV2 } = require('./rawFindingV2');
const { normalizeNameCity } = require('./normalize');
const policy = require('./researchPolicy');

const LIMITS = Object.freeze({
  MAX_ACHADOS: SCHEMA_LIMITS.ACHADOS_POR_LOTE, // 150: o teto de uma submissão
  MAX_RESULTADOS: 300,
  PAGINAS_POR_CANDIDATO: 2, // o site e o perfil do Instagram
  MAX_PAGINAS: 300,
  MAX_LINKS_POR_PAGINA: 500,
  MAX_POSTAGENS: 30,
  MAX_ANUNCIANTES: 200,
  MAX_FONTES: SCHEMA_LIMITS.FONTES,
  EVIDENCIAS_POR_CAMPO: SCHEMA_LIMITS.EVIDENCIAS_POR_CAMPO,
  DURACAO_MAXIMA_MS: 15 * 60 * 1000,
  QUANTIDADE_MAX: 1000, // a mesma do briefing do Prospecting Service
});

const ERROR = Object.freeze({
  BRIEFING_INVALIDO: 'RESEARCHER_BRIEFING_INVALIDO',
  BUSCA_FALHOU: 'RESEARCHER_BUSCA_FALHOU',
});

const OMISSAO = Object.freeze({
  EVIDENCIAS_EXCESSIVAS: 'EVIDENCIAS_EXCESSIVAS',
  LINKS_EXCESSIVOS: 'LINKS_EXCESSIVOS',
  CANAL_AMBIGUO: 'CANAL_AMBIGUO',
  DATA_FUTURA: 'DATA_FUTURA',
  DATA_INVALIDA: 'DATA_INVALIDA',
  AMOSTRA_LIMITADA: 'AMOSTRA_LIMITADA',
  FONTES_EXCESSIVAS: 'FONTES_EXCESSIVAS',
  SEM_EVIDENCIA: 'SEM_EVIDENCIA',
  ORCAMENTO_ESGOTADO: 'ORCAMENTO_ESGOTADO',
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Uma cópia rasa e SEGURA das chaves de dado de um objeto que veio de uma porta (null se não for dado puro).
function readObject(value, allowed) {
  if (!isPlainObject(value)) return null;
  const entries = ownEntries(value);
  if (entries === null) return null;
  const out = {};
  for (const [key, item] of entries) if (allowed.includes(key)) out[key] = item;
  return out;
}

function readBriefing(briefing) {
  const raw = readObject(briefing, ['nicho', 'quantidadeDesejada', 'regiao', 'tipo']);
  if (raw === null) return null;
  const nicho = checkText(raw.nicho, 120);
  if (nicho.error) return null;
  const quantidade = raw.quantidadeDesejada;
  if (typeof quantidade !== 'number' || !Number.isInteger(quantidade) || quantidade < 1 || quantidade > LIMITS.QUANTIDADE_MAX) return null;
  const out = { nicho: nicho.value, quantidadeDesejada: quantidade };
  for (const key of ['regiao', 'tipo']) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const text = checkText(raw[key], 120);
    if (text.error) return null;
    out[key] = text.value;
  }
  return out;
}

const sameName = (a, b) => {
  const left = normalizeNameCity(a, 'x');
  return left !== null && left === normalizeNameCity(b, 'x');
};

// Um resultado de busca, revalidado (dado não confiável). Devolve null se inválido.
function readResult(item) {
  const raw = readObject(item, ['nome', 'url', 'tipoResultado', 'fonteUrl', 'cidade', 'estado', 'tipo', 'nicho']);
  if (raw === null) return null;
  const nome = checkText(raw.nome, 200);
  if (nome.error || typeof raw.tipoResultado !== 'string' || !hasOwn(policy.RESULT_TYPE, raw.tipoResultado)) return null;
  const url = policy.parsePublicUrl(typeof raw.url === 'string' ? raw.url : '');
  const fonte = policy.parsePublicUrl(typeof raw.fonteUrl === 'string' ? raw.fonteUrl : '');
  if (url === null || fonte === null || policy.isLoginWall(raw.url) || policy.isLoginWall(raw.fonteUrl)) return null;
  const out = { nome: nome.value, tipoResultado: raw.tipoResultado, url: raw.url.trim(), fonteUrl: raw.fonteUrl.trim() };
  for (const key of ['cidade', 'estado', 'tipo', 'nicho']) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const text = checkText(raw[key], 120);
    if (text.error) return null;
    out[key] = text.value;
  }
  return out;
}

function createResearcher(ports, options = {}) {
  const { search, fetchPage, lookupAds } = ports || {};
  const { now = () => new Date(), maxDurationMs = LIMITS.DURACAO_MAXIMA_MS } = options || {};
  if (typeof search !== 'function') throw new Error('createResearcher exige { search } (função): sem porta de busca não há pesquisa');
  if (typeof fetchPage !== 'function') throw new Error('createResearcher exige { fetchPage } (função): sem porta de página não há evidência');
  if (lookupAds !== undefined && typeof lookupAds !== 'function') throw new Error('createResearcher: lookupAds deve ser uma função');
  if (typeof now !== 'function') throw new Error('createResearcher: now deve ser uma função');
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1) throw new Error('createResearcher: maxDurationMs deve ser um inteiro positivo');

  async function research(rawBriefing) {
    const briefing = readBriefing(rawBriefing);
    if (briefing === null) return { ok: false, erro: { code: ERROR.BRIEFING_INVALIDO }, achados: [], relatorio: null };

    const started = now();
    const hoje = started.toISOString().slice(0, 10);
    const alvo = Math.min(LIMITS.MAX_ACHADOS, briefing.quantidadeDesejada + Math.ceil(briefing.quantidadeDesejada / 2));
    const consulta = [briefing.nicho, briefing.tipo, briefing.regiao].filter(Boolean).join(' ');
    const report = { consulta, alvo, resultadosRecebidos: 0, resultadosInvalidos: 0, candidatos: 0, achadosGerados: 0, achadosDescartados: [], paginasConsultadas: 0, consultasDeAnuncios: 0, falhas: {}, omissoes: [], interrompidaPorTempo: false };
    const omit = (campo, codigo, quantidade) => report.omissoes.push(quantidade === undefined ? { campo, codigo } : { campo, codigo, quantidade });
    const fail = (falha) => {
      const key = typeof falha === 'string' && hasOwn(policy.FAILURE, falha) ? falha : 'DESCONHECIDA';
      report.falhas[key] = (report.falhas[key] || 0) + 1;
      return falha;
    };
    const expired = () => now().getTime() - started.getTime() > maxDurationMs;

    async function call(port, argument) {
      try {
        return await port(argument);
      } catch {
        return { ok: false, falha: policy.FAILURE.ERRO };
      }
    }

    // ---- busca ----
    const searched = await call(search, { consulta, limite: Math.min(LIMITS.MAX_RESULTADOS, alvo * 2) });
    const found = isPlainObject(searched) ? ownEntries(searched) : null;
    const searchOut = found === null ? null : Object.fromEntries(found);
    if (searchOut === null || searchOut.ok !== true || !Array.isArray(searchOut.resultados)) {
      fail(searchOut && searchOut.falha);
      return { ok: false, erro: { code: ERROR.BUSCA_FALHOU }, achados: [], relatorio: report };
    }
    const rawResults = searchOut.resultados.length > LIMITS.MAX_RESULTADOS ? null : ownItems(searchOut.resultados);
    if (rawResults === null) {
      fail('DESCONHECIDA');
      return { ok: false, erro: { code: ERROR.BUSCA_FALHOU }, achados: [], relatorio: report };
    }
    report.resultadosRecebidos = rawResults.length;

    // agrupa por empresa, na ordem em que vieram: o mesmo nome normalizado (a mesma normalização do discovery) e a mesma cidade; um resultado
    // SEM cidade entra no primeiro grupo do mesmo nome (nunca se inventa cidade); cidades diferentes são empresas diferentes
    const groups = [];
    for (const item of rawResults) {
      const result = readResult(item);
      if (result === null) {
        report.resultadosInvalidos += 1;
        continue;
      }
      const nameKey = normalizeNameCity(result.nome, 'x') || result.nome.toLowerCase();
      const cityKey = result.cidade ? (normalizeNameCity(result.nome, result.cidade) || '').split('|')[1] || result.cidade.toLowerCase() : null;
      let group = groups.find((g) => g.nameKey === nameKey && (g.cityKey === null || cityKey === null || g.cityKey === cityKey));
      if (!group) {
        group = { nameKey, cityKey, results: [] };
        groups.push(group);
      } else if (group.cityKey === null) group.cityKey = cityKey;
      group.results.push(result);
    }
    report.candidatos = groups.length;

    const achados = [];
    let position = 0;
    for (const { results } of groups) {
      if (achados.length >= alvo) break;
      if (expired()) {
        report.interrompidaPorTempo = true;
        break;
      }
      position += 1;
      const finding = await researchCandidate(results, briefing, hoje);
      if (finding === null) continue;
      const checked = validateRawFindingsV2([finding], { now: started });
      if (checked.ok) {
        achados.push(checked.validos[0]);
        report.achadosGerados += 1;
      } else {
        report.achadosDescartados.push({ posicao: position, erros: (checked.items[0].errors || []).map((error) => ({ path: error.path, code: error.code })) });
      }
    }
    return { ok: true, achados, relatorio: report };

    // ---- um candidato ----
    async function researchCandidate(results, brief, today) {
      const empresa = results[0].nome;
      const campos = {};
      const fatos = [];
      const fontes = new Set();
      const evidenceKeys = new Set();
      const addEvidence = (campo, valor, fonteNome, tipoFonte, url) => {
        const key = `${campo}|${valor}|${url}|${tipoFonte}`;
        if (evidenceKeys.has(key)) return;
        evidenceKeys.add(key);
        if (!campos[campo]) campos[campo] = [];
        campos[campo].push({ valor, fonte: fonteNome, tipoFonte, url, dataConsulta: today });
        fontes.add(url);
      };
      const factSource = (url, tipo, nome) => ({ url, tipo, observadoEm: today, ...(nome ? { nome } : {}) });
      const addFact = (campo, valor, url, tipo, nome) => fatos.push({ campo, valor, status: 'DADO', fonte: factSource(url, tipo, nome), observadoEm: today });
      const addUnverified = (campo, falha, site) => fatos.push({ campo, valor: null, status: 'NAO_VERIFICADO', observadoEm: today, motivo: policy.motivoFor(falha, { site }) });
      let pages = 0;
      const pageAllowed = () => pages < LIMITS.PAGINAS_POR_CANDIDATO && report.paginasConsultadas < LIMITS.MAX_PAGINAS && !expired();
      // uma página pública lida com segurança; devolve { ok:true, page } ou { ok:false, falha }
      async function visit(url, validateFinal) {
        if (!pageAllowed()) {
          omit('pagina', OMISSAO.ORCAMENTO_ESGOTADO);
          return { ok: false, falha: policy.FAILURE.TEMPO_ESGOTADO };
        }
        pages += 1;
        report.paginasConsultadas += 1;
        const out = await call(fetchPage, url);
        const raw = isPlainObject(out) ? ownEntries(out) : null;
        const page = raw === null ? null : Object.fromEntries(raw);
        if (page === null || measure(page) || page.ok !== true) return { ok: false, falha: fail(page && page.ok === false ? page.falha : 'DESCONHECIDA') };
        if (typeof page.urlFinal !== 'string' || policy.parsePublicUrl(page.urlFinal) === null) return { ok: false, falha: fail('DESCONHECIDA') };
        if (policy.isLoginWall(page.urlFinal)) return { ok: false, falha: fail(policy.FAILURE.LOGIN) };
        if (!validateFinal(page.urlFinal)) return { ok: false, falha: fail('DESCONHECIDA') };
        return { ok: true, page };
      }

      // 1) site oficial (prioridade 1)
      const sites = results.filter((r) => r.tipoResultado === policy.RESULT_TYPE.SITE);
      const hosts = new Set(sites.map((r) => policy.bareHost(policy.parsePublicUrl(r.url))));
      const ambigua = hosts.size > 1;
      if (sites.length > 0) {
        if (ambigua) {
          for (const r of sites) addEvidence('site', r.url, 'Busca pública', 'SECUNDARIA', r.fonteUrl);
        } else {
          const visited = await visit(sites[0].url, () => true);
          if (visited.ok) {
            const siteUrl = visited.page.urlFinal.trim();
            addEvidence('site', siteUrl, 'Site oficial', 'OFICIAL', siteUrl);
            readOfficialPage(visited.page, siteUrl);
          } else {
            addEvidence('site', sites[0].url, 'Busca pública', 'SECUNDARIA', sites[0].fonteUrl);
            for (const campo of ['site.ctaWhatsapp', 'site.ctaAgendamento', 'site.formularioContato']) addUnverified(campo, visited.falha, true);
          }
        }
      }

      // 2) canais apontados só pela busca (SECUNDARIA): Google Perfil, Instagram, Facebook, LinkedIn, YouTube
      for (const r of results) {
        if (r.tipoResultado === policy.RESULT_TYPE.SITE) continue;
        const canal = policy.RESULT_FIELD[r.tipoResultado];
        const link = policy.classifyLink(r.url);
        if (link !== null && link.canal === canal) addEvidence(canal, link.url, 'Busca pública', 'SECUNDARIA', r.fonteUrl);
        else report.resultadosInvalidos += 1;
      }

      // links publicados na página oficial (OFICIAL): canais, wa.me, tel:, mailto:
      function readOfficialPage(page, siteUrl) {
        const links = Array.isArray(page.links) ? ownItems(page.links) : null;
        const list = links === null ? [] : links;
        if (list.length > LIMITS.MAX_LINKS_POR_PAGINA) omit('site', OMISSAO.LINKS_EXCESSIVOS, list.length - LIMITS.MAX_LINKS_POR_PAGINA);
        let whatsapp = false;
        let scheduling = false;
        for (const item of list.slice(0, LIMITS.MAX_LINKS_POR_PAGINA)) {
          const link = readObject(item, ['href', 'texto']);
          if (link === null) continue;
          const found = policy.classifyLink(link.href);
          if (found !== null) {
            if (found.canal === 'whatsapp') {
              whatsapp = true;
              addEvidence('whatsapp', found.numero, 'Link no site oficial', 'OFICIAL', siteUrl);
            } else if (found.canal === 'telefone') addEvidence('telefone', found.numero, 'Link no site oficial', 'OFICIAL', siteUrl);
            else if (found.canal === 'email') addEvidence('email', found.endereco, 'Link no site oficial', 'OFICIAL', siteUrl);
            else addEvidence(found.canal, found.url, 'Link no site oficial', 'OFICIAL', siteUrl);
          }
          if (policy.isSchedulingLink(link)) scheduling = true;
        }
        if (whatsapp) addFact('site.ctaWhatsapp', true, siteUrl, 'OFICIAL', 'Site oficial');
        if (scheduling) addFact('site.ctaAgendamento', true, siteUrl, 'OFICIAL', 'Site oficial');
        if (page.temFormularioContato === true) addFact('site.formularioContato', true, siteUrl, 'OFICIAL', 'Site oficial');
      }

      // 3) Instagram público: só se houver UM perfil (dois valores diferentes são um conflito preservado, nunca escolhido)
      const perfis = [...new Set((campos.instagram || []).map((e) => e.valor))];
      if (perfis.length === 1) {
        const profileUrl = perfis[0];
        const visited = await visit(profileUrl, (finalUrl) => policy.isChannelPage('instagram', finalUrl));
        if (!visited.ok) addUnverified('instagram.ultimaPostagemEm', visited.falha, false);
        else readProfile(visited.page, profileUrl);
      } else if (perfis.length > 1) omit('instagram', OMISSAO.CANAL_AMBIGUO, perfis.length);

      function readProfile(page, profileUrl) {
        const official = (campos.instagram || []).some((e) => e.valor === profileUrl && e.tipoFonte === 'OFICIAL');
        const tipo = official ? 'OFICIAL' : 'SECUNDARIA';
        const perfil = readObject(page.perfil, ['privado', 'postagens', 'ctaBio']);
        const finalUrl = page.urlFinal.trim();
        fontes.add(finalUrl);
        if (perfil === null) return;
        if (perfil.privado === true) {
          addUnverified('instagram.ultimaPostagemEm', policy.FAILURE.PRIVADO, false);
          return;
        }
        const datas = Array.isArray(perfil.postagens) ? ownItems(perfil.postagens) : null;
        if (datas !== null && datas.length > 0) {
          const valid = [];
          let futuras = 0;
          let invalidas = 0;
          for (const data of datas) {
            const checked = typeof data === 'string' ? checkDate(data, started) : { error: 'x' };
            if (checked.error) {
              invalidas += 1;
              continue;
            }
            const day = checked.value.slice(0, 10);
            if (day > today) futuras += 1;
            else valid.push(day);
          }
          if (futuras > 0) omit('instagram.postagensObservadas', OMISSAO.DATA_FUTURA, futuras);
          if (invalidas > 0) omit('instagram.postagensObservadas', OMISSAO.DATA_INVALIDA, invalidas);
          const ordered = [...new Set(valid)].sort();
          if (ordered.length > LIMITS.MAX_POSTAGENS) omit('instagram.postagensObservadas', OMISSAO.AMOSTRA_LIMITADA, ordered.length - LIMITS.MAX_POSTAGENS);
          const sample = ordered.slice(-LIMITS.MAX_POSTAGENS);
          if (sample.length >= 2) addFact('instagram.postagensObservadas', sample, finalUrl, tipo, 'Perfil no Instagram');
          else if (sample.length === 1) addFact('instagram.ultimaPostagemEm', sample[0], finalUrl, tipo, 'Perfil no Instagram');
        }
        if (perfil.ctaBio !== undefined && perfil.ctaBio !== null) {
          const cta = checkText(perfil.ctaBio, 200);
          if (!cta.error) addFact('instagram.cta', cta.value, finalUrl, tipo, 'Perfil no Instagram');
        }
      }

      // 4) anúncios: bibliotecas públicas de Meta e Google (só se a porta existir; nunca "não anuncia")
      if (lookupAds) {
        for (const plataforma of [policy.ADS_PLATFORM.META, policy.ADS_PLATFORM.GOOGLE]) {
          if (expired()) break;
          report.consultasDeAnuncios += 1;
          const out = await call(lookupAds, { plataforma, nome: empresa, ...(brief.regiao ? { regiao: brief.regiao } : {}) });
          const raw = isPlainObject(out) ? ownEntries(out) : null;
          const ads = raw === null ? null : Object.fromEntries(raw);
          const campo = policy.ADS_FIELD[plataforma];
          const anunciantes = ads && ads.ok === true && Array.isArray(ads.anunciantes) && ads.anunciantes.length <= LIMITS.MAX_ANUNCIANTES ? ownItems(ads.anunciantes) : null;
          if (ads === null || measure(ads) || ads.ok !== true || anunciantes === null || typeof ads.url !== 'string' || !policy.isAdsLibraryUrl(plataforma, ads.url)) {
            addUnverified(campo, fail(ads && ads.ok === false ? ads.falha : 'DESCONHECIDA'), false);
            continue;
          }
          const names = anunciantes.map((a) => readObject(a, ['nome'])).filter((a) => a !== null && typeof a.nome === 'string');
          const identificado = names.some((a) => sameName(a.nome, empresa));
          fontes.add(ads.url.trim());
          addFact(campo, identificado ? 'IDENTIFICADO' : 'NAO_ENCONTRADO_NA_VERIFICACAO', ads.url.trim(), 'OFICIAL', 'Biblioteca de anúncios');
        }
      }

      // 5) o achado (só o que foi observado; nada de análise, hipótese, observação bruta ou decisão)
      for (const campo of Object.keys(campos)) {
        if (campos[campo].length > LIMITS.EVIDENCIAS_POR_CAMPO) {
          omit(campo, OMISSAO.EVIDENCIAS_EXCESSIVAS, campos[campo].length);
          delete campos[campo];
        }
      }
      if (Object.keys(campos).length === 0) {
        omit('achado', OMISSAO.SEM_EVIDENCIA);
        return null;
      }
      const sourceList = [...fontes];
      if (sourceList.length > LIMITS.MAX_FONTES) omit('fontes', OMISSAO.FONTES_EXCESSIVAS, sourceList.length - LIMITS.MAX_FONTES);
      const pick = (key) => (results.find((r) => r[key]) || {})[key];
      const usableFatos = fatos.filter((fato) => {
        const channel = fato.campo.startsWith('instagram.') ? 'instagram' : fato.campo.startsWith('site.') ? 'site' : null;
        return channel === null || hasOwn(campos, channel);
      });
      return {
        empresa,
        ...(pick('tipo') ? { tipo: pick('tipo') } : brief.tipo ? { tipo: brief.tipo } : {}),
        ...(pick('cidade') ? { cidade: pick('cidade') } : {}),
        ...(pick('estado') ? { estado: pick('estado') } : {}),
        nicho: pick('nicho') || brief.nicho,
        campos,
        fontes: sourceList.slice(0, LIMITS.MAX_FONTES),
        ...(ambigua ? { identidadeAmbigua: true } : {}),
        dataDaPesquisa: today,
        ...(usableFatos.length > 0 ? { dossie: { fatos: usableFatos } } : {}),
      };
    }
  }

  return Object.freeze({ research });
}

module.exports = { createResearcher, LIMITS, ERROR, OMISSAO };
