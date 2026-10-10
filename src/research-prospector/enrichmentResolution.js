// Resolução por CAMPO do enriquecimento comercial (Ajuste de confiabilidade 3.0.2): uma execução SEM ERRO não é, por si só, uma pesquisa completa.
//
// Cada campo pedido termina com UM resultado verificável:
//   ENCONTRADO                       a informação foi obtida e VALIDADA por código (nada do que o motor afirma entra sem validação);
//   NAO_ENCONTRADO_COM_VERIFICACAO   o motor respondeu para o lead, a execução não foi cortada nem falhou, e há ao menos UMA fonte consultada cuja leitura o CÓDIGO conseguiu confirmar:
//                                    a tentativa está documentada e nada foi achado. NÃO prova que a informação não existe — só que, nestas fontes e neste momento, não apareceu;
//   NAO_VERIFICADO                   pesquisa insuficiente: campo omitido sem consulta documentada, fonte não confirmada, resposta vazia/ausente, dado descartado na validação,
//                                    falha ou limite de execução (turnos, tempo, uso). É a única situação que permite — e pede — uma nova tentativa.
//
// Um campo omitido ou vazio NUNCA vira NAO_ENCONTRADO_COM_VERIFICACAO sozinho. O status geral COMPLETO só existe quando TODOS os campos pedidos estão resolvidos.
// Este módulo é puro: sem rede, sem arquivo, sem relógio.

const digital = require('./digitalPresence');
const commercial = require('./commercialProfile');

const FIELD_STATUS = Object.freeze({
  ENCONTRADO: 'ENCONTRADO',
  NAO_ENCONTRADO_COM_VERIFICACAO: 'NAO_ENCONTRADO_COM_VERIFICACAO',
  NAO_VERIFICADO: 'NAO_VERIFICADO',
});

// Os campos do enriquecimento, na ordem em que aparecem na tela.
const FIELDS = Object.freeze(['siteOficial', 'responsavel', 'endereco', 'telefones', 'whatsapps', 'emails', 'presencaDigital', 'trafegoPago', 'atividadeRecente']);

// Os motivos de um campo NAO_VERIFICADO (códigos estáveis; a tela os traduz).
const REASON = Object.freeze({
  OMITIDO_SEM_CONSULTA: 'OMITIDO_SEM_CONSULTA', // o motor não trouxe o campo e não documentou onde procurou
  FONTES_NAO_CONFIRMADAS: 'FONTES_NAO_CONFIRMADAS', // o motor citou fontes, mas o código não conseguiu confirmá-las
  SEM_LEITURA_DE_PAGINA: 'SEM_LEITURA_DE_PAGINA', // não havia como conferir as fontes citadas
  SEM_RESPOSTA_PARA_O_LEAD: 'SEM_RESPOSTA_PARA_O_LEAD', // o motor terminou sem responder para este lead (resposta vazia)
  LIMITE_DE_TURNOS: 'LIMITE_DE_TURNOS', // a execução foi cortada antes de terminar
  DESCARTADO_NA_VALIDACAO: 'DESCARTADO_NA_VALIDACAO', // o motor afirmou algo que o código não conseguiu validar
  FONTE_NAO_PERTINENTE_A_EMPRESA: 'FONTE_NAO_PERTINENTE_A_EMPRESA', // a página lida não é da empresa (nem a cita): uma leitura genérica não documenta nada
  FONTE_NAO_PERTINENTE_AO_CAMPO: 'FONTE_NAO_PERTINENTE_AO_CAMPO', // a página é da empresa, mas não é um lugar onde este campo apareceria
  PAGINA_DE_LOGIN_OU_BLOQUEIO: 'PAGINA_DE_LOGIN_OU_BLOQUEIO', // a página abriu, mas é uma tela de login, bloqueio ou verificação: não comprova a ausência de nada
  PAGINA_SEM_CONTEUDO: 'PAGINA_SEM_CONTEUDO', // a página abriu quase vazia (tela genérica): não comprova nada
  ERRO_NA_AVALIACAO: 'ERRO_NA_AVALIACAO', // a avaliação da fonte falhou por um erro interno: nada é documentado
  FONTE_NAO_APLICAVEL: 'FONTE_NAO_APLICAVEL', // este campo não se documenta por leitura de página (tráfego pago: só a consulta à biblioteca de anúncios)
  LIMITE_DE_LEITURAS: 'LIMITE_DE_LEITURAS', // o orçamento de leituras de verificação desta execução acabou antes de conferir este campo
  FONTE_PERTINENTE_MAS_INSUFICIENTE: 'FONTE_PERTINENTE_MAS_INSUFICIENTE', // a página é da empresa e do assunto, mas uma página de terceiro NÃO basta para concluir que não há o dado (pertinente != suficiente)
  CANDIDATO_SEM_VINCULO_COMPROVADO: 'CANDIDATO_SEM_VINCULO_COMPROVADO', // a página mostra um candidato (pessoa/contato) cujo vínculo com a empresa não está comprovado: segue não verificado
  BLOQUEADO_POR_PRE_REQUISITO: 'BLOQUEADO_POR_PRE_REQUISITO', // o campo depende de algo que ainda não existe (atividade recente: um canal oficial CONFIRMADO): não se gasta pesquisa nele
  PENDENTE_DE_CONFIRMACAO: 'PENDENTE_DE_CONFIRMACAO', // responsável com nome e cargo, mas sem o vínculo da fonte com a empresa demonstrado
  PARCIAL: 'PARCIAL', // parte do campo foi obtida; o restante segue sem verificação
  NAO_PESQUISADO: 'NAO_PESQUISADO', // nenhuma pesquisa tentou este campo ainda
  EXECUCAO_ANTERIOR_SEM_VERIFICACAO_REGISTRADA: 'EXECUCAO_ANTERIOR_SEM_VERIFICACAO_REGISTRADA', // registro LEGADO: sem evidência da verificação
});

const ORIGEM_LEGADO = 'LEGADO';
const NAO_MEDIDO = 'NAO_MEDIDO';
const MAX_SOURCES_PER_FIELD = 3;
const MAX_URL_RECORDED = 200;
const MAX_ATTEMPTS_RECORDED = 4;
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// O motor devolveu algo para o campo? (lista vazia, objeto sem nenhum valor, null e texto vazio são "nada")
function isReturned(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.values(value).some((entry) => isReturned(entry));
  return true;
}

// Resolve os campos PEDIDOS de UMA execução.
//   requested     os campos pedidos
//   obtained      Set — os campos que o código VALIDOU e mesclou
//   returned      Set — os campos que o motor trouxe (com algum conteúdo), validados ou não
//   discarded     [{ campo, motivo }] — os que o motor trouxe e a validação descartou
//   verified      { campo: [urls] } — as fontes consultadas que o CÓDIGO confirmou ler
//   declared      { campo: n } — quantas fontes o motor citou por campo (para distinguir "omitido" de "fonte não confirmada")
//   evidencias    { campo: { citadas, tentativas } } — as URLs que o motor citou e o que o código fez com elas (leitura, categoria de falha, pertinência); vai junto do resultado do campo
//   rejected      { campo: motivo } — por que as fontes citadas NÃO sustentaram a ausência (não pertinente à empresa/ao campo, ilegível, orçamento de leituras)
//   residual      Set — os campos que AINDA faltam no perfil depois da mescla (campo composto obtido só em parte)
//   interrupted   motivo (LIMITE_DE_TURNOS, ...) quando a execução foi cortada; senão null
//   answered      o motor respondeu para o lead?
//   adsOnlyNone   trafegoPago obtido apenas como "nenhuma evidência pública" (a consulta à biblioteca de anúncios é a fonte)
//   adsSources    as URLs dessas consultas
//   canVerifyPages  há leitura de página disponível para conferir as fontes citadas?
function resolveFields({ requested, obtained, returned, discarded = [], verified = {}, declared = {}, rejected = {}, evidencias = {}, residual = new Set(), interrupted = null, answered = true, adsOnlyNone = false, adsSources = [], canVerifyPages = true }) {
  const dropped = new Map(discarded.map((entry) => [entry.campo, entry.motivo]));
  const fields = {};
  for (const field of requested) {
    const sources = (Array.isArray(verified[field]) ? verified[field] : []).slice(0, MAX_SOURCES_PER_FIELD);
    const documented = sources.length > 0 && !interrupted && answered;
    if (obtained.has(field)) {
      if (field === 'trafegoPago' && adsOnlyNone) {
        // "nenhuma evidência pública" é um achado DOCUMENTADO (a consulta à biblioteca de anúncios é a fonte), nunca "não anuncia"
        // ...mas só resolve o campo se as TRÊS plataformas foram consultadas (senão sobra uma parte sem verificação)
        const urls = adsSources.slice(0, MAX_SOURCES_PER_FIELD);
        const partial = residual.has(field);
        fields[field] = urls.length > 0
          ? { status: FIELD_STATUS.NAO_ENCONTRADO_COM_VERIFICACAO, resolvido: !partial, fontes: urls, ...(partial ? { parcial: true, motivo: REASON.PARCIAL } : {}) }
          : { status: FIELD_STATUS.NAO_VERIFICADO, resolvido: false, motivo: REASON.OMITIDO_SEM_CONSULTA };
        continue;
      }
      const partial = residual.has(field);
      // campo composto (presença digital, anúncios) obtido só em parte: o que sobrou só se resolve se a consulta ao restante foi documentada
      fields[field] = { status: FIELD_STATUS.ENCONTRADO, resolvido: !partial || documented, ...(partial ? { parcial: true } : {}), ...(partial && documented ? { fontes: sources } : {}), ...(partial && !documented ? { motivo: REASON.PARCIAL } : {}) };
      continue;
    }
    if (interrupted) {
      fields[field] = { status: FIELD_STATUS.NAO_VERIFICADO, resolvido: false, motivo: interrupted };
    } else if (!answered) {
      fields[field] = { status: FIELD_STATUS.NAO_VERIFICADO, resolvido: false, motivo: REASON.SEM_RESPOSTA_PARA_O_LEAD };
    } else if (dropped.has(field) || returned.has(field)) {
      fields[field] = { status: FIELD_STATUS.NAO_VERIFICADO, resolvido: false, motivo: dropped.get(field) || REASON.DESCARTADO_NA_VALIDACAO };
    } else if (documented) {
      fields[field] = { status: FIELD_STATUS.NAO_ENCONTRADO_COM_VERIFICACAO, resolvido: true, fontes: sources };
    } else {
      const motivo = rejected[field] || (!canVerifyPages && (declared[field] || 0) > 0 ? REASON.SEM_LEITURA_DE_PAGINA : (declared[field] || 0) > 0 ? REASON.FONTES_NAO_CONFIRMADAS : REASON.OMITIDO_SEM_CONSULTA);
      fields[field] = { status: FIELD_STATUS.NAO_VERIFICADO, resolvido: false, motivo };
    }
  }
  for (const field of Object.keys(fields)) if (evidencias[field]) Object.assign(fields[field], evidencias[field]);
  return fields;
}

const unresolved = (fields) => Object.keys(fields).filter((field) => fields[field].resolvido !== true);
const documentedAbsent = (fields) => Object.keys(fields).filter((field) => fields[field].status === FIELD_STATUS.NAO_ENCONTRADO_COM_VERIFICACAO && fields[field].resolvido === true);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// PERTINÊNCIA DA FONTE: uma página LIDA só sustenta "não encontrado" quando é da EMPRESA e é um lugar onde ESTE campo apareceria. Uma leitura genérica (qualquer página que abre) não é prova.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const plainText = (text) => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');

// o que uma página precisa mencionar para ser um lugar onde o campo apareceria (texto normalizado, sem acento)
const FIELD_MARKERS = Object.freeze({
  siteOficial: null, // basta ser da empresa (um diretório ou uma busca que a lista)
  responsavel: /(equipe|sobre|quem somos|corpo clinico|responsavel|diretor|diretora|proprietari|socio|socia|fundador|fundadora|\bdono\b|\bdona\b|profissionais)/,
  endereco: /(endereco|localizacao|como chegar|nossa unidade|onde estamos|\brua\b|\bav\.|avenida|\bcep\b)/,
  telefones: /(telefone|contato|fale conosco|\bligue\b|atendimento|agende|\btel\b|whatsapp)/,
  whatsapps: /(whatsapp|fale conosco|contato|agende|atendimento)/,
  emails: /(e-?mail|contato|fale conosco|atendimento|escreva)/,
  presencaDigital: /(instagram|facebook|linkedin|youtube|tiktok|redes sociais|\bsiga\b|nossas redes)/,
  atividadeRecente: /(blog|noticias|novidades|postagem|publicacao|artigos|ultimas|eventos)/,
});
// campos de contato que, se a PÁGINA OFICIAL lida os traz, deixam de ser "não encontrados": o código os extrai (mesmas regras da validação) em vez de aceitar a ausência
const EXTRACTABLE = Object.freeze(['emails', 'telefones', 'whatsapps', 'endereco', 'responsavel']);

// ctx: { company, officialOrigin, knownUrls }. page: o resultado de fetchPage. Devolve { ok: false, motivo } ou { ok: true } ou { ok: true, encontrado: { [campo]: valor } } (a própria página oficial traz o dado).
const AGGREGATORS = Object.freeze(['linktr.ee', 'linktree.com', 'beacons.ai', 'bio.link']);
// telas de login, bloqueio, verificação de robô ou "indisponível" (texto normalizado, sem acento): não comprovam a ausência de informação comercial
const WALL_TEXT = /(faca login|fazer login|entre na sua conta|entrar na sua conta|log in|sign in|crie (uma|sua) conta|criar conta|cadastre-se|acesso negado|access denied|forbidden|verifique que voce e humano|verify you are human|enable javascript|habilite o javascript|checking your browser|just a moment|nao foi possivel (carregar|acessar)|pagina indisponivel|conteudo indisponivel|this page isn.t available)/;
const MIN_PAGE_TEXT = 120;

// Os campos em que uma PÁGINA DE TERCEIRO pode trazer candidatos (pessoa/contato): antes de concluir "não há", o código procura por eles na página.
const CANDIDATE_FIELDS = Object.freeze(['responsavel', 'emails', 'telefones', 'whatsapps']);

// Avalia UMA fonte lida para UM campo. Distingue PERTINENTE (é da empresa e do assunto) de SUFICIENTE (basta para concluir "não encontrado"):
//   { ok, pertinente, motivo?, testes: { nome, marcador, conteudo, suficiencia }, candidatos?, encontrado?, origem? }
//   ok = a fonte sustenta a conclusão (ausência documentada) ou traz o dado (página oficial). Uma página de terceiro pertinente pode ser insuficiente (pertinente: true, ok: false).
// `testes` registra, em códigos fechados, cada teste (PASSOU | FALHOU | NAO_AVALIADO; suficiência SUFICIENTE | INSUFICIENTE | NAO_AVALIADA): nunca o texto da página.
function assessSource(field, page, url, ctx) {
  const testes = { nome: 'NAO_AVALIADO', marcador: 'NAO_AVALIADO', conteudo: 'NAO_AVALIADO', suficiencia: 'NAO_AVALIADA' };
  const reject = (motivo, extra = {}) => ({ ok: false, pertinente: false, motivo, testes: { ...testes }, ...extra });
  if (field === 'trafegoPago') return reject(REASON.FONTE_NAO_APLICAVEL);
  if (!page || page.ok !== true || typeof page.texto !== 'string') return reject(REASON.FONTES_NAO_CONFIRMADAS);
  const finalUrl = typeof page.urlFinal === 'string' ? page.urlFinal : url;
  const origin = digital.normalizeToOrigin(finalUrl);
  const text = plainText(page.texto);
  const name = plainText(ctx.company || '').trim();
  const official = Boolean(origin) && origin === ctx.officialOrigin;
  const host = digital.hostOf(finalUrl) || '';
  const classified = digital.classifyHost(host);
  const weak = AGGREGATORS.some((aggregator) => host === aggregator || host.endsWith('.' + aggregator)) || (classified !== null && classified.tipo === digital.SOURCE_TYPE.REDE_SOCIAL);
  // "conhecida": o site oficial do lead ou uma URL que o próprio perfil já guarda — serve só para ONDE a atividade recente se conclui; NUNCA dispensa a evidência textual de vínculo com a empresa
  const known = official || (Array.isArray(ctx.knownUrls) && ctx.knownUrls.some((entry) => typeof entry === 'string' && finalUrl.startsWith(entry.replace(/\/$/, ''))));
  // 1. CONTEÚDO MÍNIMO: login, bloqueio, verificação de robô e telas genéricas não comprovam ausência de nada (em rede social/agregador, qualquer sinal de muro vale; em outras páginas, só se forem curtas)
  if (WALL_TEXT.test(text) && (weak || text.length < 1500)) {
    testes.conteudo = 'FALHOU';
    return reject(REASON.PAGINA_DE_LOGIN_OU_BLOQUEIO);
  }
  if (text.length < MIN_PAGE_TEXT) {
    testes.conteudo = 'FALHOU';
    return reject(REASON.PAGINA_SEM_CONTEUDO);
  }
  testes.conteudo = 'PASSOU';
  // 2. NOME/IDENTIDADE: o próprio site oficial (já verificado) ou a EMPRESA CITADA no texto — a URL constar no perfil não basta (Instagram, Facebook e agregadores de links incluídos)
  if (!(official || (name.length >= 3 && text.includes(name)))) {
    testes.nome = 'FALHOU';
    return reject(REASON.FONTE_NAO_PERTINENTE_A_EMPRESA);
  }
  testes.nome = 'PASSOU';
  // o que a página mostra (candidatos), por código — uma página oficial que traz o dado o entrega; uma de terceiro só gera CANDIDATO (nunca é associada à empresa por si)
  const shown = CANDIDATE_FIELDS.includes(field) || EXTRACTABLE.includes(field)
    ? commercial.enrichmentFromOfficialPage({ texto: page.texto, links: page.links, origem: origin || finalUrl, identidade: page.identidade })
    : null;
  if (official && EXTRACTABLE.includes(field) && shown) {
    const value = field === 'endereco' || field === 'responsavel' ? shown[field] : Array.isArray(shown[field]) && shown[field].length > 0 ? shown[field] : null;
    if (value) return { ok: true, pertinente: true, encontrado: { [field]: value }, origem: origin, testes: { ...testes, marcador: 'PASSOU', suficiencia: 'SUFICIENTE' } };
  }
  // 3. MARCADOR DO CAMPO: a atividade recente só se conclui em um lugar do próprio lead (site oficial ou perfil já confirmado); os demais precisam ser um lugar onde o campo apareceria
  if (field === 'atividadeRecente' && !known) {
    testes.marcador = 'FALHOU';
    return reject(REASON.FONTE_NAO_PERTINENTE_AO_CAMPO);
  }
  const marker = FIELD_MARKERS[field];
  if (marker && !marker.test(text)) {
    testes.marcador = 'FALHOU';
    return reject(REASON.FONTE_NAO_PERTINENTE_AO_CAMPO);
  }
  testes.marcador = 'PASSOU';
  // 4. SUFICIÊNCIA: pertinente != suficiente. Numa página de TERCEIRO, responsável nunca se conclui como "não há" (a palavra "sócio" só diz que ali é onde ele apareceria) e um contato visível na página é um CANDIDATO
  // sem vínculo comprovado: nos dois casos o campo segue NAO_VERIFICADO.
  if (!official && CANDIDATE_FIELDS.includes(field)) {
    const candidates = shown ? (field === 'responsavel' ? (shown.responsavel ? 1 : 0) : Array.isArray(shown[field]) ? shown[field].length : 0) : 0;
    if (candidates > 0) return { ok: false, pertinente: true, motivo: REASON.CANDIDATO_SEM_VINCULO_COMPROVADO, candidatos: candidates, testes: { ...testes, suficiencia: 'INSUFICIENTE' } };
    if (field === 'responsavel') return { ok: false, pertinente: true, motivo: REASON.FONTE_PERTINENTE_MAS_INSUFICIENTE, candidatos: 0, testes: { ...testes, suficiencia: 'INSUFICIENTE' } };
  }
  return { ok: true, pertinente: true, testes: { ...testes, suficiencia: 'SUFICIENTE' } };
}

// A telemetria de ferramentas: só o que o executor MEDIU. WebSearch vem do uso por modelo (quando informado); o WebFetch do Claude Code não é contado pelo executor — "NÃO MEDIDO", nunca um zero inventado.
function toolCounts(found) {
  return {
    webSearch: found && Number.isInteger(found.webSearchRequests) ? found.webSearchRequests : NAO_MEDIDO,
    webFetch: found && Number.isInteger(found.webFetchRequests) ? found.webFetchRequests : NAO_MEDIDO,
  };
}

// A URL como fica REGISTRADA: https, só origem + caminho (sem consulta, âncora ou credencial — onde poderia haver token ou dado pessoal), até 200 caracteres. Outra coisa = null.
function safeSourceUrl(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return null;
    return `${url.origin}${url.pathname}`.slice(0, MAX_URL_RECORDED);
  } catch {
    return null;
  }
}

// O resultado de UMA leitura de página, em vocabulário fechado: OK ou a categoria da falha (ROBOTS, LOGIN, HTTP_403, HTTP_429, BLOQUEADO, CAPTCHA, TIMEOUT, REMOVIDA, FORA_DO_AR, ERRO,
// EXCECAO_NA_LEITURA, SEM_TEXTO, SEM_LEITURA_DE_PAGINA) e, quando o leitor informa, a causa técnica (código fixo, nunca a mensagem da rede).
function readOutcome(page) {
  if (page === null || page === undefined) return { leitura: 'SEM_LEITURA_DE_PAGINA' };
  if (!isPlainObject(page)) return { leitura: 'ERRO' };
  if (page.ok === true) return { leitura: typeof page.texto === 'string' ? 'OK' : 'SEM_TEXTO' };
  const falha = typeof page.falha === 'string' ? page.falha : '';
  const causa = typeof page.causa === 'string' && CODE.test(page.causa) ? page.causa : null;
  let leitura;
  if (falha === 'EXCECAO_NA_LEITURA') leitura = 'EXCECAO_NA_LEITURA';
  else if (falha === 'ROBOTS') leitura = 'ROBOTS';
  else if (falha === 'LOGIN') leitura = 'LOGIN';
  else if (falha === 'CAPTCHA') leitura = 'CAPTCHA';
  else if (falha === 'TEMPO_ESGOTADO' || causa === 'TIMEOUT') leitura = 'TIMEOUT';
  else if (falha === 'BLOQUEADO') leitura = causa === 'HTTP_403' ? 'HTTP_403' : causa === 'HTTP_429' ? 'HTTP_429' : 'BLOQUEADO';
  else if (falha === 'REMOVIDA') leitura = 'REMOVIDA';
  else if (falha === 'FORA_DO_AR') leitura = 'FORA_DO_AR';
  else leitura = 'ERRO';
  return { leitura, ...(causa && causa !== leitura ? { causa } : {}) };
}

// Os TESTES de pertinência/suficiência de uma tentativa (códigos fechados; nunca texto da página): nome da empresa, marcador do campo, conteúdo mínimo e suficiência para concluir.
const TEST_RESULT = Object.freeze(['PASSOU', 'FALHOU', 'NAO_AVALIADO']);
const SUFFICIENCY = Object.freeze(['SUFICIENTE', 'INSUFICIENTE', 'NAO_AVALIADA']);
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);
function cleanTests(tests) {
  return { nome: oneOf(tests.nome, TEST_RESULT, 'NAO_AVALIADO'), marcador: oneOf(tests.marcador, TEST_RESULT, 'NAO_AVALIADO'), conteudo: oneOf(tests.conteudo, TEST_RESULT, 'NAO_AVALIADO'), suficiencia: oneOf(tests.suficiencia, SUFFICIENCY, 'NAO_AVALIADA') };
}

// Uma tentativa gravada: { url, leitura, causa?, pertinencia? } — só códigos e a URL já reduzida; qualquer outra coisa é descartada.
function cleanAttempt(item) {
  if (!isPlainObject(item) || typeof item.url !== 'string' || !CODE.test(String(item.leitura))) return null;
  return {
    url: item.url.slice(0, MAX_URL_RECORDED),
    leitura: item.leitura,
    ...(typeof item.causa === 'string' && CODE.test(item.causa) ? { causa: item.causa } : {}),
    ...(typeof item.pertinencia === 'string' && CODE.test(item.pertinencia) ? { pertinencia: item.pertinencia } : {}),
    ...(isPlainObject(item.testes) ? { testes: cleanTests(item.testes) } : {}),
    ...(Number.isInteger(item.candidatos) && item.candidatos >= 0 && item.candidatos <= 50 ? { candidatos: item.candidatos } : {}),
  };
}

// Uma entrada guardada no perfil -> só os campos conhecidos (nunca devolve texto bruto nem dados além do contrato).
function cleanEntry(entry) {
  if (!isPlainObject(entry) || !Object.values(FIELD_STATUS).includes(entry.status)) return null;
  return {
    status: entry.status,
    resolvido: entry.resolvido === true,
    ...(typeof entry.motivo === 'string' ? { motivo: entry.motivo } : {}),
    ...(entry.parcial === true ? { parcial: true } : {}),
    ...(entry.bloqueio === REASON.BLOQUEADO_POR_PRE_REQUISITO ? { bloqueio: entry.bloqueio, ...(typeof entry.requer === 'string' && CODE.test(entry.requer) ? { requer: entry.requer } : {}) } : {}),
    ...(Array.isArray(entry.fontes) ? { fontes: entry.fontes.filter((url) => typeof url === 'string').slice(0, MAX_SOURCES_PER_FIELD) } : {}),
    ...(typeof entry.execucao === 'string' ? { execucao: entry.execucao } : {}),
    ...(entry.origem === ORIGEM_LEGADO ? { origem: ORIGEM_LEGADO } : {}),
    ...(Array.isArray(entry.citadas) ? { citadas: entry.citadas.filter((url) => typeof url === 'string').map((url) => url.slice(0, MAX_URL_RECORDED)).slice(0, MAX_SOURCES_PER_FIELD) } : {}),
    ...(Array.isArray(entry.tentativas) ? { tentativas: entry.tentativas.map(cleanAttempt).filter(Boolean).slice(0, MAX_ATTEMPTS_RECORDED) } : {}),
  };
}

// PRÉ-REQUISITOS. A atividade recente só é aceita numa postagem de um canal oficial JÁ CONFIRMADO do lead (commercialProfile.deriveActivity): sem um, qualquer pesquisa seria jogada fora. O campo fica
// BLOQUEADO_POR_PRE_REQUISITO — não é "inexistente" nem "resolvido" —, nada é pedido ao motor e, quando um canal for confirmado, volta a ser pesquisável. Sugestões de perfil NÃO viram confirmadas aqui.
const REQUIRES = Object.freeze({ atividadeRecente: 'CANAL_OFICIAL_CONFIRMADO' });
const hasConfirmedChannel = (profile) => digital.confirmedChannels(isPlainObject(profile) ? profile.presencaDigital : null).some((channel) => channel.canal !== 'whatsapp');
const isBlocked = (profile, field) => REQUIRES[field] === 'CANAL_OFICIAL_CONFIRMADO' && !hasConfirmedChannel(profile);
const blockedFields = (profile, fields) => fields.filter((field) => isBlocked(profile, field));
const blockedEntry = (field) => ({ status: FIELD_STATUS.NAO_VERIFICADO, resolvido: false, motivo: REASON.BLOQUEADO_POR_PRE_REQUISITO, bloqueio: REASON.BLOQUEADO_POR_PRE_REQUISITO, requer: REQUIRES[field] });

// Tráfego pago sai de `needs` quando nenhuma plataforma está NAO_VERIFICADO — mas "nenhuma evidência pública" em todas NÃO é um achado: é uma ausência documentada (a consulta à biblioteca de anúncios é a fonte).
function adsState(profile) {
  const ads = isPlainObject(profile) && isPlainObject(profile.trafegoPago) ? Object.values(profile.trafegoPago).filter((entry) => isPlainObject(entry)) : [];
  if (ads.some((entry) => entry.status === 'EVIDENCIA_ENCONTRADA')) return { status: FIELD_STATUS.ENCONTRADO, resolvido: true };
  const sources = ads.map((entry) => entry.origem && entry.origem.url).filter((url) => typeof url === 'string').slice(0, MAX_SOURCES_PER_FIELD);
  if (ads.length > 0 && sources.length > 0) return { status: FIELD_STATUS.NAO_ENCONTRADO_COM_VERIFICACAO, resolvido: true, fontes: sources };
  return { status: FIELD_STATUS.ENCONTRADO, resolvido: true };
}

// O estado de CADA campo do perfil agora. O que o perfil já TEM (não está em `needs`) é ENCONTRADO; o que falta usa o resultado gravado pela última execução que o pesquisou; e um perfil
// ANTIGO (3.0 / 3.0.1 / execução anterior a este ajuste, sem resultado por campo) é lido como NAO_VERIFICADO com origem LEGADO — porque não há registro de que a verificação aconteceu.
// Só LÊ: nada é regravado, e o histórico real das execuções fica como está.
function fieldStates(profile, needs) {
  const info = isPlainObject(profile) && isPlainObject(profile.enriquecimento) ? profile.enriquecimento : {};
  const stored = isPlainObject(info.resolucao) ? info.resolucao : null;
  const researchedBefore = isPlainObject(info.legado) || ['COMPLETO', 'INCOMPLETO', 'FALHOU'].includes(info.status);
  const out = {};
  for (const field of FIELDS) {
    if (!needs.includes(field)) {
      out[field] = field === 'trafegoPago' ? adsState(profile) : { status: FIELD_STATUS.ENCONTRADO, resolvido: true };
      continue;
    }
    if (isBlocked(profile, field)) {
      out[field] = blockedEntry(field);
      continue;
    }
    // um bloqueio gravado por uma execução anterior não vale mais depois que o pré-requisito existe: o campo volta a ser pesquisável
    let entry = stored ? cleanEntry(stored[field]) : null;
    if (entry && entry.bloqueio) entry = null;
    // um responsável sem o vínculo com a empresa DEMONSTRADO nunca aparece como encontrado/resolvido
    // (inclusive num registro HISTÓRICO que o tenha dado como "não encontrado": a leitura é corrigida sem reescrever o registro; as evidências da tentativa seguem visíveis)
    if (field === 'responsavel' && ['PENDENTE', 'NAO_DEMONSTRADO'].includes(commercial.responsibleLinkState(profile))) {
      out[field] = entry ? holdPendingResponsible(entry) : { status: FIELD_STATUS.NAO_VERIFICADO, resolvido: false, motivo: REASON.PENDENTE_DE_CONFIRMACAO, ...(stored === null && researchedBefore ? { origem: ORIGEM_LEGADO } : {}) };
      continue;
    }
    if (entry) out[field] = entry;
    else if (stored === null && researchedBefore) out[field] = { status: FIELD_STATUS.NAO_VERIFICADO, resolvido: false, origem: ORIGEM_LEGADO, motivo: info.limiteDeTurnos ? REASON.LIMITE_DE_TURNOS : REASON.EXECUCAO_ANTERIOR_SEM_VERIFICACAO_REGISTRADA };
    else out[field] = { status: FIELD_STATUS.NAO_VERIFICADO, resolvido: false, motivo: REASON.NAO_PESQUISADO };
  }
  return out;
}

// Um responsável pendente (ou sem vínculo demonstrado) NUNCA fica dado como ausente nem com uma conclusão de "fonte insuficiente" solta: o motivo exibido é PENDENTE_DE_CONFIRMACAO — a menos que o
// motivo gravado explique algo mais específico (candidato sem vínculo, vínculo não comprovado, limite de turnos/leituras). O resto da entrada (citadas, tentativas, execução) é preservado.
const SPECIFIC_FOR_PENDING = Object.freeze(['VINCULO_COM_A_EMPRESA_NAO_COMPROVADO', REASON.CANDIDATO_SEM_VINCULO_COMPROVADO, REASON.LIMITE_DE_TURNOS, REASON.LIMITE_DE_LEITURAS]);
function holdPendingResponsible(entry) {
  if (!isPlainObject(entry) || entry.status === FIELD_STATUS.ENCONTRADO) return entry;
  const { fontes, ...kept } = entry;
  const specific = entry.status === FIELD_STATUS.NAO_VERIFICADO && SPECIFIC_FOR_PENDING.includes(entry.motivo);
  return { ...kept, status: FIELD_STATUS.NAO_VERIFICADO, resolvido: false, motivo: specific ? entry.motivo : REASON.PENDENTE_DE_CONFIRMACAO };
}

// Se o enriquecimento anterior é LEGADO (existe, mas sem resultado por campo), o que dele precisa ficar guardado antes de uma nova execução sobrescrever o estado geral.
function legacyOrigin(info, at) {
  if (!isPlainObject(info)) return undefined;
  if (isPlainObject(info.legado)) return info.legado;
  if (isPlainObject(info.resolucao)) return undefined;
  if (!['COMPLETO', 'INCOMPLETO', 'FALHOU'].includes(info.status)) return undefined;
  return {
    origem: ORIGEM_LEGADO,
    statusAnterior: info.status,
    camposPendentesAnterior: Array.isArray(info.camposPendentes) ? info.camposPendentes.slice(0, 20) : [],
    camposNaoEncontradosAnterior: Array.isArray(info.camposNaoEncontrados) ? info.camposNaoEncontrados.slice(0, 20) : [],
    limiteDeTurnosAnterior: Boolean(info.limiteDeTurnos),
    ...(typeof info.motivo === 'string' ? { motivoAnterior: info.motivo } : {}),
    preservadoEm: at,
  };
}

module.exports = {
  FIELD_STATUS,
  FIELDS,
  REASON,
  ORIGEM_LEGADO,
  NAO_MEDIDO,
  MAX_SOURCES_PER_FIELD,
  isReturned,
  resolveFields,
  holdPendingResponsible,
  REQUIRES,
  isBlocked,
  blockedFields,
  blockedEntry,
  assessSource,
  EXTRACTABLE,
  readOutcome,
  safeSourceUrl,
  unresolved,
  documentedAbsent,
  toolCounts,
  fieldStates,
  legacyOrigin,
};
