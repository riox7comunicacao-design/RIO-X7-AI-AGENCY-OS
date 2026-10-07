// Extração ESTÁTICA de uma página HTML (decisão 0022) — função pura: texto -> { links, formulário, sinais de bloqueio }.
//
// Nunca executa nada: scripts, estilos e comentários são REMOVIDOS antes de qualquer leitura; nada do conteúdo é interpretado como código
// nem seguido (não há busca de recursos, iframes ou imports). É uma leitura tolerante e conservadora, não um parser completo: só o que o
// Researcher usa — os links (`<a href>` com o texto visível), se há um formulário de contato e os sinais de que a página é um MURO
// (login ou desafio de captcha), que o adaptador traduz em falha (nunca em conteúdo).
//
// Entrada não confiável e possivelmente hostil: tudo é varredura LINEAR com indexOf (nenhuma expressão regular com retrocesso sobre o
// documento inteiro), então um HTML cheio de tags sem fechamento não vira uma negação de serviço.

const MAX_TEXT = 200;
const MAX_LINKS = 600; // abaixo do que o Researcher aceita por página; o excesso é REPORTADO (linksTruncados), nunca silencioso
const MAX_ANCHOR_BODY = 2000;
const MAX_ANCHORS_SCANNED = 20000;
const MAX_FORM_BODY = 100000;
const MAX_FORMS_SCANNED = 50;
// `texto`: o texto público da página para a verificação por código (nunca HTML bruto): tetos por parte e no total.
const MAX_PAGE_TEXT = 12000;
const MAX_TEXT_BODY = 6000;
const MAX_TEXT_FOOTER = 1500;
const MAX_TEXT_HEADING = 300;
const MAX_HEADINGS = 10;
const MAX_TEXT_META = 500;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, code) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ' ';
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, code.toLowerCase()) ? ENTITIES[code.toLowerCase()] : whole;
  });
}

const asciiLower = (text) => text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)); // mantém o comprimento

// Remove comentários e blocos inertes (script, style, noscript, template) por varredura linear. Um bloco sem fechamento descarta o resto.
function stripInert(html, extraBlocks = []) {
  let text = html;
  let lower = asciiLower(text);
  const cut = (open, close) => {
    let out = '';
    let outLower = '';
    let pos = 0;
    for (;;) {
      const i = lower.indexOf(open, pos);
      if (i === -1) break;
      if (open !== '<!--' && /[a-z0-9]/.test(lower[i + open.length] || '')) {
        out += text.slice(pos, i + open.length);
        outLower += lower.slice(pos, i + open.length);
        pos = i + open.length;
        continue;
      }
      out += `${text.slice(pos, i)} `;
      outLower += `${lower.slice(pos, i)} `;
      const end = lower.indexOf(close, i + open.length);
      if (end === -1) {
        pos = text.length;
        break;
      }
      pos = end + close.length;
    }
    text = out + text.slice(pos);
    lower = outLower + lower.slice(pos);
  };
  cut('<!--', '-->');
  for (const name of ['script', 'style', 'noscript', 'template', ...extraBlocks]) cut(`<${name}`, `</${name}>`);
  return { text, lower };
}

// As tags de abertura `<nome ...>` (a fonte e a posição do `>`), em ordem; uma tag sem `>` encerra a leitura.
function* openTags(source, lower, name) {
  const open = `<${name}`;
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start === -1) return;
    if (/[a-z0-9]/.test(lower[start + open.length] || '')) {
      pos = start + open.length;
      continue;
    }
    const gt = lower.indexOf('>', start);
    if (gt === -1) return;
    yield { start, gt, tag: source.slice(start, gt + 1) };
    pos = gt + 1;
  }
}

// tira as tags por varredura linear (sem regex com retrocesso)
function stripTags(fragment) {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = fragment.indexOf('<', pos);
    if (open === -1) return out + fragment.slice(pos);
    out += `${fragment.slice(pos, open)} `;
    const close = fragment.indexOf('>', open);
    if (close === -1) return out;
    pos = close + 1;
  }
}
const visibleText = (fragment, max = MAX_TEXT) => decodeEntities(stripTags(fragment)).replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim() : null;
}

// Um href absoluto seguro ou null: tel:/mailto: passam como estão; o resto é resolvido contra a base e só vale se for https.
function safeHref(href, base) {
  if (href === null || href === '' || href.length > 2048) return null;
  if (/^(tel|mailto):/i.test(href)) return href.replace(/^(tel|mailto):/i, (scheme) => scheme.toLowerCase());
  if (/^(javascript|data|file|ftp|blob|vbscript):/i.test(href) || href.startsWith('#')) return null;
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

// O texto das tags `<nome ...>...</nome>` (as primeiras `limit`), já sem tags, sem controles e com teto por trecho. Varredura linear.
function blockTexts(source, lower, name, limit, max) {
  const out = [];
  for (const { gt } of openTags(source, lower, name)) {
    if (out.length >= limit) break;
    const end = lower.indexOf(`</${name}`, gt);
    if (end === -1) break;
    const text = visibleText(source.slice(gt + 1, Math.min(end, gt + 1 + max * 4)), max);
    if (text !== '') out.push(text);
  }
  return out;
}

// O texto público da página, para a verificação por CÓDIGO (nunca para um prompt): título, meta description, h1, h2, rodapé e o texto
// visível do corpo — sem script, estilo, noscript, template, comentários, svg, iframe, controles nem bidi, e com teto de tamanho. O rodapé
// vem ANTES do corpo para que um corpo longo não o corte. Não devolve HTML.
function extractText(clean, lower) {
  const parts = [];
  parts.push(...blockTexts(clean, lower, 'title', 1, MAX_TEXT_HEADING));
  let metas = 0;
  for (const { tag } of openTags(clean, lower, 'meta')) {
    const key = (attribute(tag, 'name') || attribute(tag, 'property') || '').toLowerCase();
    if (key !== 'description' && key !== 'og:description') continue;
    const content = attribute(tag, 'content');
    const text = content === null ? '' : visibleText(content, MAX_TEXT_META);
    if (text !== '') parts.push(text);
    metas += 1;
    if (metas >= 3) break;
  }
  parts.push(...blockTexts(clean, lower, 'h1', MAX_HEADINGS, MAX_TEXT_HEADING));
  parts.push(...blockTexts(clean, lower, 'h2', MAX_HEADINGS, MAX_TEXT_HEADING));
  parts.push(...blockTexts(clean, lower, 'footer', 1, MAX_TEXT_FOOTER));
  const { text: bodySource, lower: bodyLower } = stripInert(clean, ['svg', 'iframe', 'object', 'select', 'head']);
  const bodyStart = bodyLower.indexOf('<body');
  const bodyFrom = bodyStart === -1 ? 0 : bodyLower.indexOf('>', bodyStart) + 1;
  const body = visibleText(bodySource.slice(bodyFrom, bodyFrom + MAX_TEXT_BODY * 8), MAX_TEXT_BODY);
  if (body !== '') parts.push(body);
  return parts.join('\n').slice(0, MAX_PAGE_TEXT);
}

// A IDENTIDADE da página (título + H1): onde uma empresa se apresenta. Usada pela verificação do site oficial (o nome da empresa no título/H1).
function extractIdentity(clean, lower) {
  return [...blockTexts(clean, lower, 'title', 1, MAX_TEXT_HEADING), ...blockTexts(clean, lower, 'h1', MAX_HEADINGS, MAX_TEXT_HEADING)].join('\n').slice(0, 1000);
}

const STRONG_CHALLENGE = /cf-chl|challenge-platform|captcha-delivery|px-captcha|<title>\s*(just a moment|attention required|access denied|verifying you are human)/i;
const WEAK_CAPTCHA = /g-recaptcha|h-captcha|cf-turnstile|captcha/i;
const isType = (tag, names) => {
  const type = attribute(tag, 'type');
  return type !== null && names.includes(type.toLowerCase());
};

function extractPage(html, baseUrl) {
  const raw = String(html);
  const { text: clean, lower } = stripInert(raw);

  const links = [];
  const seen = new Set();
  let total = 0;
  let nextClose = -2;
  let scanned = 0;
  for (const { gt, tag } of openTags(clean, lower, 'a')) {
    scanned += 1;
    if (scanned > MAX_ANCHORS_SCANNED) break;
    const href = safeHref(attribute(tag, 'href'), baseUrl);
    if (href === null) continue;
    if (nextClose !== -1 && nextClose < gt) nextClose = lower.indexOf('</a', gt);
    const body = nextClose === -1 || nextClose - gt > MAX_ANCHOR_BODY ? '' : clean.slice(gt + 1, nextClose);
    const texto = visibleText(body);
    const key = `${href}\u0000${texto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += 1;
    if (links.length < MAX_LINKS) links.push(texto === '' ? { href } : { href, texto });
  }

  let hasPassword = false;
  for (const { tag } of openTags(clean, lower, 'input')) if (isType(tag, ['password'])) hasPassword = true;

  // formulário de contato: um <form> sem campo de senha que tenha textarea ou campo de e-mail/telefone
  let contactForm = false;
  let formEnd = -2;
  let formsScanned = 0;
  for (const { start, gt } of openTags(clean, lower, 'form')) {
    formsScanned += 1;
    if (contactForm || formsScanned > MAX_FORMS_SCANNED) break;
    if (formEnd !== -1 && formEnd < gt) formEnd = lower.indexOf('</form', gt);
    const end = formEnd === -1 ? Math.min(lower.length, gt + MAX_FORM_BODY) : formEnd;
    const body = lower.slice(start, Math.min(end, start + MAX_FORM_BODY));
    const bodySource = clean.slice(start, Math.min(end, start + MAX_FORM_BODY));
    let password = false;
    let field = body.includes('<textarea');
    for (const { tag } of openTags(bodySource, body, 'input')) {
      if (isType(tag, ['password'])) password = true;
      if (isType(tag, ['email', 'tel'])) field = true;
    }
    if (!password && field) contactForm = true;
  }

  return {
    links,
    linksTruncados: total - links.length,
    temFormularioContato: contactForm,
    temSenha: hasPassword,
    desafioForte: STRONG_CHALLENGE.test(raw.slice(0, 200000)),
    marcadorCaptcha: WEAK_CAPTCHA.test(raw.slice(0, 200000)),
    totalLinks: total,
    texto: extractText(clean, lower),
    identidade: extractIdentity(clean, lower),
  };
}

module.exports = { extractPage, decodeEntities, safeHref, MAX_LINKS, MAX_TEXT, MAX_PAGE_TEXT };
