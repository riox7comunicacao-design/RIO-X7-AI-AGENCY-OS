// Verificação POR CÓDIGO do conteúdo público de uma página oficial (Implementação 1): a empresa existe nesta página? O nicho aparece nela?
// A localização aparece nela? Função PURA — sem rede, sem banco, sem LLM, sem relógio.
//
//   verifyOnPage(texto, { nome, nicho, cidade, uf }) -> {
//     empresa:     { status, evidencia, regra },
//     nicho:       { status, evidencia, regra },
//     localizacao: { status, evidencia, regra },
//   }
//   status: 'VALIDADO' | 'NAO_VERIFICADO'. Sem evidência: { status: 'NAO_VERIFICADO', evidencia: null, regra: null }. Nunca se inventa evidência.
//
// O QUE É PROVA: só o `texto` da página (htmlExtract.extractText). O briefing, a resposta da busca, o domínio, o DDD de um telefone e um HTTP 200
// NÃO são prova: `nome`, `nicho`, `cidade` e `uf` aqui são o que se PROCURA no texto, nunca o que se aceita sem achar.
//
// SEGURANÇA: o texto de uma página externa é dado hostil. Ele só é comparado (busca de frases fechadas, sem interpretar nada como instrução) e
// NUNCA vai para um prompt. A evidência devolvida é um trecho CURTO (até MAX_EVIDENCE) do próprio texto, sem controles nem bidi.
//
// As regras (fechadas e explícitas):
//   empresa      nome              o nome completo, como palavras inteiras (sem acento, sem diferença de caixa)
//                nome_sem_titulo   o nome sem o título inicial (Dr., Dra., Prof., Profa.), quando sobra mais de uma palavra
//                nome_nucleo       o NOME-NÚCLEO: o nome sem o que vem entre parênteses ou depois de " - ", " – ", " | ", sem qualificador de unidade/filial
//                                  e sem sufixo jurídico; os tokens DISTINTIVOS (não genéricos) aparecem na mesma ordem, como palavras inteiras. Se TODOS
//                                  os tokens forem genéricos (ex.: "Espaço Facial"), exige corroboração: o rótulo do domínio + o título/H1 da página.
//                                  Nunca valida por uma palavra genérica isolada.
//   nicho        termo_nicho       um termo da LISTA CONTROLADA do nicho do briefing (NICHE_VOCABULARY)
//                frase_nicho       nicho sem lista controlada: a própria frase do nicho, palavra por palavra
//   localizacao  endereco          a cidade logo depois de um indicador de endereço (rua, avenida, estrada, bairro, cep...)
//                cidade_uf         a cidade seguida da UF (RJ) ou do nome do estado
//                cidade            a cidade, como palavra inteira

const { stripAccents } = require('./normalize');
const digital = require('./digitalPresence');

const MAX_EVIDENCE = 80;
const MAX_TEXT = 20000; // o htmlExtract já limita; esta função não confia nisso
const MAX_NAME = 200;

const NOT_VERIFIED = Object.freeze({ status: 'NAO_VERIFICADO', evidencia: null, regra: null });
const verified = (evidencia, regra) => ({ status: 'VALIDADO', evidencia, regra });

const TITLE_PREFIXES = ['dr', 'dra', 'prof', 'profa'];

// Vocabulário CONTROLADO por nicho: `gatilhos` casam (por trecho, sem acento) com o nicho pedido; `termos` são as palavras/frases que, na página,
// indicam o nicho. Um nicho sem lista aqui usa só a própria frase (frase_nicho). Não há classificação genérica nem aprendizado.
const NICHE_VOCABULARY = Object.freeze([
  {
    gatilhos: ['estetic'],
    termos: ['estetica', 'esteticista', 'estetico', 'harmonizacao facial', 'harmonizacao', 'botox', 'toxina botulinica', 'preenchimento', 'limpeza de pele', 'peeling', 'depilacao a laser', 'criolipolise', 'microagulhamento', 'bioestimulador', 'skinbooster', 'drenagem linfatica', 'massagem modeladora', 'dermatologia estetica', 'micropigmentacao'],
  },
  { gatilhos: ['odonto', 'dentist'], termos: ['odontologia', 'dentista', 'clinica odontologica', 'ortodontia', 'implante dentario', 'clareamento dental', 'lentes de contato dental'] },
  { gatilhos: ['psicolog'], termos: ['psicologia', 'psicologo', 'psicologa', 'psicoterapia', 'terapia cognitivo', 'atendimento psicologico'] },
  { gatilhos: ['nutri'], termos: ['nutricao', 'nutricionista', 'reeducacao alimentar', 'plano alimentar', 'consulta nutricional'] },
  { gatilhos: ['fisioterap'], termos: ['fisioterapia', 'fisioterapeuta', 'pilates', 'reabilitacao', 'rpg'] },
  { gatilhos: ['veterin'], termos: ['veterinaria', 'veterinario', 'clinica veterinaria', 'pet shop'] },
]);

// Termos GENÉRICOS do nicho/negócio (nunca bastam sozinhos para provar uma empresa) e as palavras de ligação. Lista fechada e explícita.
const GENERIC_TERMS = Object.freeze(new Set(['clinica', 'estetica', 'instituto', 'espaco', 'centro', 'saude', 'dermatologia', 'odonto', 'odontologia', 'studio', 'spa', 'avancada', 'facial', 'medicina']));
const CONNECTORS = Object.freeze(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'para', 'com']);
const LEGAL_SUFFIXES = Object.freeze(new Set(['ltda', 'me', 'epp', 'eireli', 'sa', 'mei', 'cia']));
const UNIT_MARKERS = Object.freeze(['unidade', 'filial', 'loja', 'matriz']);
const MIN_DISTINCTIVE_LENGTH = 5; // os tokens distintivos juntos: um nome curtíssimo casaria com qualquer coisa

const ADDRESS_MARKERS = ['rua', 'avenida', 'av', 'estrada', 'rodovia', 'travessa', 'alameda', 'praca', 'largo', 'bairro', 'endereco', 'cep', 'loja', 'sala', 'galeria', 'shopping', 'centro'];

const STATE_NAMES = Object.freeze({
  ac: 'acre', al: 'alagoas', ap: 'amapa', am: 'amazonas', ba: 'bahia', ce: 'ceara', df: 'distrito federal', es: 'espirito santo', go: 'goias',
  ma: 'maranhao', mt: 'mato grosso', ms: 'mato grosso do sul', mg: 'minas gerais', pa: 'para', pb: 'paraiba', pr: 'parana', pe: 'pernambuco',
  pi: 'piaui', rj: 'rio de janeiro', rn: 'rio grande do norte', rs: 'rio grande do sul', ro: 'rondonia', rr: 'roraima', sc: 'santa catarina',
  sp: 'sao paulo', se: 'sergipe', to: 'tocantins',
});

// Texto "comparável": em minúsculas, sem acento, e cada caractere que não é letra/dígito vira UM espaço (1 caractere de saída por caractere
// de entrada, para que a posição de um achado volte ao texto original e a evidência seja um trecho DELE). Devolve { text, origins }.
function comparable(source) {
  const out = [];
  const origins = [];
  let offset = 0;
  for (const ch of source) {
    const folded = stripAccents(ch).toLowerCase();
    out.push(/^[a-z0-9]$/.test(folded) ? folded : ' ');
    origins.push(offset);
    offset += ch.length;
  }
  return { text: out.join(''), origins };
}

// A frase de busca (só letras e dígitos, sem acento) como lista de palavras; null se não sobrar nada.
function words(phrase) {
  if (typeof phrase !== 'string') return null;
  const list = comparable(phrase.slice(0, MAX_NAME)).text.split(' ').filter(Boolean);
  return list.length > 0 ? list : null;
}

const WORD_EDGE_BEFORE = '(?<![a-z0-9])';
const WORD_EDGE_AFTER = '(?![a-z0-9])';
const joinWords = (list) => list.join(' +');

// A primeira ocorrência da frase (palavras inteiras, qualquer espaçamento entre elas). Devolve { start, end } ou null. Os padrões são montados
// só com letras e dígitos (nunca com texto livre), então não há metacaractere nem retrocesso catastrófico.
function findPhrase(text, list) {
  const found = new RegExp(`${WORD_EDGE_BEFORE}${joinWords(list)}${WORD_EDGE_AFTER}`).exec(text);
  return found ? { start: found.index, end: found.index + found[0].length } : null;
}

// O trecho do texto ORIGINAL de [start, end) do texto comparável: curto, sem controles/bidi, espaços colapsados.
function snippet(source, view, start, end) {
  const from = view.origins[start];
  const lastOrigin = view.origins[end - 1];
  const to = lastOrigin + (String.fromCodePoint(source.codePointAt(lastOrigin)).length);
  return clean(source.slice(from, to));
}

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g;
function clean(text) {
  const flat = String(text).replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_EVIDENCE ? `${flat.slice(0, MAX_EVIDENCE - 1).trimEnd()}…` : flat;
}

// O NOME-NÚCLEO de um candidato: { tokens, distinctive } ou null. Remove o que está entre parênteses e o que vem depois de " - ", " – ", " — " ou " | ",
// o qualificador de unidade/filial (e tudo depois), sufixos jurídicos e o título inicial. `distinctive` são os tokens que NÃO são genéricos nem ligações.
function coreName(nome) {
  if (typeof nome !== 'string') return null;
  const text = nome.slice(0, MAX_NAME).replace(/\([^)]*\)?/g, ' ').split(/\s[-–—|]\s/)[0];
  const all = words(text);
  if (all === null) return null;
  let list = all;
  const unit = list.findIndex((token, index) => index > 0 && UNIT_MARKERS.includes(token));
  if (unit > 0) list = list.slice(0, unit);
  while (list.length > 1 && LEGAL_SUFFIXES.has(list[list.length - 1])) list = list.slice(0, -1);
  if (list.length > 1 && TITLE_PREFIXES.includes(list[0])) list = list.slice(1);
  const distinctive = list.filter((token) => !GENERIC_TERMS.has(token) && !CONNECTORS.includes(token) && !TITLE_PREFIXES.includes(token));
  return { tokens: list, distinctive };
}

// Os tokens distintivos, na mesma ordem, como palavras inteiras (uma palavra de ligação entre eles é tolerada). { start, end } ou null.
function findDistinctive(text, distinctive) {
  const glue = ` +(?:(?:${CONNECTORS.join('|')}) +)?`;
  const found = new RegExp(`${WORD_EDGE_BEFORE}${distinctive.join(glue)}${WORD_EDGE_AFTER}`).exec(text);
  return found ? { start: found.index, end: found.index + found[0].length } : null;
}

// O rótulo do domínio contém os tokens distintivos (ou, se todos são genéricos, todos os tokens juntos: espacofacial)?
function domainMatches(host, core) {
  const label = digital.registrableLabel(host);
  if (label === '' || core === null) return false;
  const tokens = core.distinctive.filter((token) => token.length >= 3);
  if (core.distinctive.length > 0) return tokens.length > 0 && tokens.every((token) => label.includes(token));
  return core.tokens.length > 0 && label.includes(core.tokens.join(''));
}

// O núcleo do nome aparece no trecho (título/H1)? Mesma regra do núcleo, sobre o texto de identidade.
function coreInText(identidade, core) {
  if (typeof identidade !== 'string' || identidade.trim() === '' || core === null) return false;
  const view = comparable(identidade.slice(0, MAX_TEXT));
  // o núcleo INTEIRO (com os termos genéricos, como o título o escreve) ou, se os tokens distintivos são longos o bastante, só eles
  if (core.tokens.length > 0 && findPhrase(view.text, core.tokens) !== null) return true;
  return core.distinctive.length > 0 && core.distinctive.join('').length >= MIN_DISTINCTIVE_LENGTH && findDistinctive(view.text, core.distinctive) !== null;
}

function verifyCompany(source, view, nome, ctx) {
  const full = words(nome);
  if (full === null) return NOT_VERIFIED;
  const core = coreName(nome);
  // nome só com termos genéricos ("Espaço Facial"): nem a frase inteira vale sozinha — só com a corroboração do domínio + título/H1
  if (core !== null && core.distinctive.length === 0) {
    if (ctx && ctx.host && domainMatches(ctx.host, core) && coreInText(ctx.identidade, core)) {
      const hit = findPhrase(view.text, core.tokens);
      if (hit) return verified(snippet(source, view, hit.start, hit.end), 'nome_nucleo');
    }
    return NOT_VERIFIED;
  }
  const attempts = [['nome', full]];
  if (full.length > 2 && TITLE_PREFIXES.includes(full[0])) attempts.push(['nome_sem_titulo', full.slice(1)]);
  else if (full.length === 2 && TITLE_PREFIXES.includes(full[0]) && full[1].length >= 4) attempts.push(['nome_sem_titulo', full.slice(1)]);
  for (const [regra, list] of attempts) {
    if (list.join('').length < 4) continue; // um nome curtíssimo casaria com qualquer coisa
    const hit = findPhrase(view.text, list);
    if (hit) return verified(snippet(source, view, hit.start, hit.end), regra);
  }
  // o NOME-NÚCLEO inteiro (com os termos genéricos, sem parênteses/unidade/sufixo): mais forte que só os tokens distintivos, vale para nomes curtos
  if (core !== null && core.distinctive.length > 0 && core.tokens.length > 1 && core.tokens.join('').length >= 6) {
    const hit = findPhrase(view.text, core.tokens);
    if (hit) return verified(snippet(source, view, hit.start, hit.end), 'nome_nucleo');
  }
  // o NOME-NÚCLEO: os tokens distintivos, na mesma ordem, como palavras inteiras
  if (core !== null && core.distinctive.join('').length >= MIN_DISTINCTIVE_LENGTH) {
    const hit = findDistinctive(view.text, core.distinctive);
    if (hit) return verified(snippet(source, view, hit.start, hit.end), 'nome_nucleo');
  }
  return NOT_VERIFIED;
}

function verifyNiche(source, view, nicho) {
  const asked = words(nicho);
  if (asked === null) return NOT_VERIFIED;
  const key = asked.join(' ');
  const entry = NICHE_VOCABULARY.find((item) => item.gatilhos.some((trigger) => key.includes(trigger)));
  if (entry) {
    let best = null;
    for (const term of entry.termos) {
      const hit = findPhrase(view.text, words(term));
      if (hit && (best === null || hit.start < best.start)) best = hit;
    }
    return best ? verified(snippet(source, view, best.start, best.end), 'termo_nicho') : NOT_VERIFIED;
  }
  const hit = findPhrase(view.text, asked);
  return hit ? verified(snippet(source, view, hit.start, hit.end), 'frase_nicho') : NOT_VERIFIED;
}

function verifyLocation(source, view, cidade, uf) {
  const city = words(cidade);
  if (city === null) return NOT_VERIFIED;
  const cityPattern = joinWords(city);
  const state = typeof uf === 'string' && /^[A-Za-z]{2}$/.test(uf.trim()) ? uf.trim().toLowerCase() : null;
  const stateAlternatives = state ? [state, ...(STATE_NAMES[state] ? [STATE_NAMES[state].split(' ').join(' +')] : [])] : [];

  const markers = ADDRESS_MARKERS.join('|');
  const address = new RegExp(`${WORD_EDGE_BEFORE}(?:${markers})${WORD_EDGE_AFTER}[a-z0-9 ]{0,100}?${WORD_EDGE_BEFORE}${cityPattern}${WORD_EDGE_AFTER}`).exec(view.text);
  if (address) {
    const start = address.index;
    return verified(snippet(source, view, start, start + address[0].length), 'endereco');
  }
  if (stateAlternatives.length > 0) {
    const withState = new RegExp(`${WORD_EDGE_BEFORE}${cityPattern} {1,6}(?:${stateAlternatives.join('|')})${WORD_EDGE_AFTER}`).exec(view.text);
    if (withState) return verified(snippet(source, view, withState.index, withState.index + withState[0].length), 'cidade_uf');
  }
  const hit = findPhrase(view.text, city);
  return hit ? verified(snippet(source, view, hit.start, hit.end), 'cidade') : NOT_VERIFIED;
}

function verifyOnPage(texto, contexto) {
  const context = contexto && typeof contexto === 'object' ? contexto : {};
  if (typeof texto !== 'string' || texto.trim() === '') return { empresa: NOT_VERIFIED, nicho: NOT_VERIFIED, localizacao: NOT_VERIFIED };
  const source = texto.slice(0, MAX_TEXT);
  const view = comparable(source);
  return {
    empresa: verifyCompany(source, view, context.nome, { host: typeof context.host === 'string' ? context.host : null, identidade: context.identidade }),
    nicho: verifyNiche(source, view, context.nicho),
    localizacao: verifyLocation(source, view, context.cidade, context.uf),
  };
}

// O VÍNCULO de uma página com a empresa como SITE OFICIAL (nunca só HTTP 200). A página é a da raiz do `siteOficial` sugerido pelo agente (hipótese).
//   verifyOfficialSite(texto, { nome, url, identidade, nicho, cidade, uf }) -> { status: VALIDADO | NAO_VERIFICADO, regra?, motivo?, vinculos }
// Regras: o host NÃO pode ser um terceiro conhecido (rede social, diretório, portal, notícia); o nome (ou o nome-núcleo) tem de estar na página; e o
// vínculo é provado pelo DOMÍNIO (tokens distintivos no rótulo) ou pelo TÍTULO/H1 com o nome (nome só de termos genéricos exige os DOIS); e a página tem
// conteúdo institucional (nicho ou localização comprovados nela). Rótulos: dominio_e_nome | titulo_e_nome. Motivos: URL_INVALIDA | HOST_DE_TERCEIRO |
// NOME_INVALIDO | NOME_NAO_ENCONTRADO | VINCULO_NAO_CONFIRMADO | SEM_CONTEUDO_INSTITUCIONAL.
function verifyOfficialSite(texto, context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const fail = (motivo, vinculos = { dominio: false, titulo: false }) => ({ status: 'NAO_VERIFICADO', motivo, vinculos });
  const host = digital.hostOf(ctx.url);
  if (host === null) return fail('URL_INVALIDA');
  if (digital.isKnownThirdPartyHost(host)) return fail('HOST_DE_TERCEIRO');
  const core = coreName(ctx.nome);
  if (core === null) return fail('NOME_INVALIDO');
  const result = verifyOnPage(texto, { nome: ctx.nome, nicho: ctx.nicho, cidade: ctx.cidade, uf: ctx.uf, host, identidade: ctx.identidade });
  const vinculos = { dominio: domainMatches(host, core), titulo: coreInText(ctx.identidade, core) };
  if (result.empresa.status !== 'VALIDADO') return fail('NOME_NAO_ENCONTRADO', vinculos);
  const linked = core.distinctive.length > 0 ? vinculos.dominio || vinculos.titulo : vinculos.dominio && vinculos.titulo;
  if (!linked) return fail('VINCULO_NAO_CONFIRMADO', vinculos);
  if (result.nicho.status !== 'VALIDADO' && result.localizacao.status !== 'VALIDADO') return fail('SEM_CONTEUDO_INSTITUCIONAL', vinculos);
  return { status: 'VALIDADO', regra: vinculos.dominio ? 'dominio_e_nome' : 'titulo_e_nome', vinculos, evidencia: result.empresa.evidencia };
}

// O lugar esperado a partir do texto livre da região do briefing ("Cidade: Petrópolis/RJ", "Petrópolis - RJ", "Petrópolis, RJ"): { cidade, uf }
// ou null quando não há uma cidade clara. É só o que se PROCURA na página; nunca é prova.
function parseRegion(regiao) {
  if (typeof regiao !== 'string') return null;
  let text = regiao.replace(/^\s*cidade\s*:\s*/i, '').trim();
  if (text === '' || /\b(estado|regi[aã]o|bairros?|todos)\b/i.test(text)) return null;
  let uf = null;
  const withUf = /^(.+?)\s*[/,-]\s*([A-Za-z]{2})\s*$/.exec(text);
  if (withUf) {
    text = withUf[1].trim();
    uf = withUf[2].toUpperCase();
  }
  return text === '' || text.length > 120 ? null : { cidade: text, ...(uf ? { uf } : {}) };
}

module.exports = { verifyOnPage, verifyOfficialSite, coreName, parseRegion, NICHE_VOCABULARY, GENERIC_TERMS, MAX_EVIDENCE };
