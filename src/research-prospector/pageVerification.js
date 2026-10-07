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
//   nicho        termo_nicho       um termo da LISTA CONTROLADA do nicho do briefing (NICHE_VOCABULARY)
//                frase_nicho       nicho sem lista controlada: a própria frase do nicho, palavra por palavra
//   localizacao  endereco          a cidade logo depois de um indicador de endereço (rua, avenida, estrada, bairro, cep...)
//                cidade_uf         a cidade seguida da UF (RJ) ou do nome do estado
//                cidade            a cidade, como palavra inteira

const { stripAccents } = require('./normalize');

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

function verifyCompany(source, view, nome) {
  const full = words(nome);
  if (full === null) return NOT_VERIFIED;
  const attempts = [['nome', full]];
  if (full.length > 2 && TITLE_PREFIXES.includes(full[0])) attempts.push(['nome_sem_titulo', full.slice(1)]);
  else if (full.length === 2 && TITLE_PREFIXES.includes(full[0]) && full[1].length >= 4) attempts.push(['nome_sem_titulo', full.slice(1)]);
  for (const [regra, list] of attempts) {
    if (list.join('').length < 4) continue; // um nome curtíssimo casaria com qualquer coisa
    const hit = findPhrase(view.text, list);
    if (hit) return verified(snippet(source, view, hit.start, hit.end), regra);
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
    empresa: verifyCompany(source, view, context.nome),
    nicho: verifyNiche(source, view, context.nicho),
    localizacao: verifyLocation(source, view, context.cidade, context.uf),
  };
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

module.exports = { verifyOnPage, parseRegion, NICHE_VOCABULARY, MAX_EVIDENCE };
