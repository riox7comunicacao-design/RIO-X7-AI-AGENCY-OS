// TESTES OFFLINE das peças do adaptador de pesquisa (decisão 0022): guarda de rede, transporte https (módulo `https` FALSO), robots.txt,
// extração de HTML, adaptador do Nominatim e fronteiras de arquitetura. Nenhuma requisição real.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { isPublicAddress, createGuardedLookup } = require('../../src/research-adapters/netGuard');
const { createHttpsTransport, TransportError } = require('../../src/research-adapters/httpsTransport');
const { parseRobots, isAllowed, MAX_LINES, MAX_PATTERN } = require('../../src/research-adapters/robots');
const { extractPage, decodeEntities, safeHref, MAX_LINKS } = require('../../src/research-adapters/htmlExtract');
const { createNominatimSearch, mapPlace } = require('../../src/research-adapters/nominatimSearch');
const { createResearchPorts } = require('../../src/research-adapters');
const { analyzeSource, toPosix } = require('../helpers/staticImports');

const RAIZ = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------------------------------------------------------------------
test('[NET-1] só endereços PÚBLICOS: loopback, privados, CGNAT, link-local (metadata de nuvem), multicast, reservados, documentação e IPv6 interno/mapeado/NAT64/6to4 são recusados; públicos passam; lixo é recusado', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '2a00:1450:4001:81b::200e']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '127.255.255.254', '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '192.0.2.1', '192.0.0.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1', '64:ff9b::808:808', '2002:c0a8:1::1', '::10.0.0.1', '0:0:0:0:0:0:0:1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const lixo of ['', 'localhost', 'example.test', '999.1.1.1', '1.2.3', '1.2.3.4.5', '::g', '1::2::3', '[::1]', null, undefined, 5, {}, ['8.8.8.8']]) assert.equal(isPublicAddress(lixo), false, String(lixo));
});

test('[NET-2] o `lookup` guardado só entrega se TODOS os endereços resolvidos são públicos (um interno no meio já recusa: ESSRF); erro do DNS passa; respeita o modo all/único', async () => {
  const chamar = (dns, opcoes = {}) => new Promise((resolve) => createGuardedLookup({ dns })('alfa.example.test', opcoes, (erro, a, b) => resolve({ erro, a, b })));
  const dns = (resultado) => ({ lookup: (host, opts, cb) => { assert.equal(opts.all, true); cb(resultado instanceof Error ? resultado : null, resultado instanceof Error ? undefined : resultado); } });
  const publico = [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }];
  assert.deepEqual(await chamar(dns(publico), { all: true }), { erro: null, a: publico, b: undefined });
  assert.deepEqual(await chamar(dns(publico)), { erro: null, a: '93.184.216.34', b: 4 });
  for (const ruim of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }], [{ address: '::1', family: 6 }], [{ address: 'nao-e-ip', family: 4 }], [], [null]]) {
    const r = await chamar(dns(ruim), { all: true });
    assert.equal(r.erro && r.erro.code, 'ESSRF', JSON.stringify(ruim));
    assert.equal(r.a, undefined);
  }
  const falha = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
  assert.equal((await chamar(dns(falha))).erro.code, 'ENOTFOUND');
  const semOpcoes = await new Promise((resolve) => createGuardedLookup({ dns: dns(publico) })('alfa.example.test', (erro, a) => resolve({ erro, a })));
  assert.equal(semOpcoes.a, '93.184.216.34');
});

// ---------------------------------------------------------------------------------------------------------------------------------
function httpsFalso(cenario) {
  const chamadas = [];
  return {
    chamadas,
    request(url, opcoes, callback) {
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = () => { req.destroyed = true; };
      req.end = () => cenario({ req, callback, url, opcoes });
      chamadas.push({ url: url.toString(), opcoes });
      return req;
    },
  };
}
const resposta = (status, headers = {}) => Object.assign(new EventEmitter(), { statusCode: status, headers });
const req0 = { url: 'https://alfa.example.test/x', headers: { 'user-agent': 'RioX7ResearcherV1/1.0 (teste)' }, timeoutMs: 1000, maxBytes: 1000 };

test('[TRN-1] transporte https: uma requisição GET com o lookup guardado, sem agente compartilhado, sem cookies; devolve só status, cabeçalhos de texto e os bytes (Set-Cookie é descartado)', async () => {
  const fake = httpsFalso(({ callback }) => {
    const res = resposta(200, { 'content-type': 'text/html', 'set-cookie': ['a=b'], 'x-segredo': 'y', location: '/z', 'content-length': '11' });
    callback(res);
    res.emit('data', Buffer.from('hello '));
    res.emit('data', Buffer.from('world'));
    res.emit('end');
  });
  const t = createHttpsTransport({ https: fake });
  const r = await t.request(req0);
  assert.deepEqual([r.status, r.body.toString(), r.headers], [200, 'hello world', { 'content-type': 'text/html', 'content-length': '11', location: '/z' }]);
  const { opcoes, url } = fake.chamadas[0];
  assert.equal(url, 'https://alfa.example.test/x');
  assert.deepEqual([opcoes.method, opcoes.agent, typeof opcoes.lookup], ['GET', false, 'function']);
  assert.deepEqual(opcoes.headers, req0.headers);
  assert.equal('rejectUnauthorized' in opcoes, false, 'a validação de certificado nunca é desligada');
  for (const proibida of ['auth', 'cookie', 'proxy', 'ca', 'cert', 'key', 'pfx', 'passphrase', 'ciphers', 'checkServerIdentity', 'secureProtocol']) assert.equal(proibida in opcoes, false, proibida);
});

test('[TRN-2] TIMEOUT total explícito: sem resposta, rejeita TIMEOUT e destrói a conexão; com resposta a tempo o cronômetro é desarmado; parâmetros inválidos são INVALID_URL', async () => {
  let req;
  const fake = httpsFalso((c) => { req = c.req; });
  const t = createHttpsTransport({ https: fake });
  const inicio = Date.now();
  await assert.rejects(t.request({ ...req0, timeoutMs: 30 }), (e) => e instanceof TransportError && e.code === 'TIMEOUT');
  assert.ok(Date.now() - inicio < 1000);
  assert.equal(req.destroyed, true);
  const goteja = httpsFalso(({ callback }) => { const res = resposta(200); callback(res); setTimeout(() => res.emit('data', Buffer.from('x')), 200); });
  await assert.rejects(createHttpsTransport({ https: goteja }).request({ ...req0, timeoutMs: 30 }), (e) => e.code === 'TIMEOUT', 'o tempo é do pedido inteiro, não só do primeiro byte');
  for (const ruim of [{ timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: Infinity }, { timeoutMs: '10' }, { timeoutMs: undefined }, { maxBytes: 0 }, { maxBytes: Infinity }, { maxBytes: undefined }]) {
    await assert.rejects(t.request({ ...req0, ...ruim }), (e) => e.code === 'INVALID_URL', JSON.stringify(ruim));
  }
});

test('[TRN-3] URL fora da política nunca chega ao módulo https: http, ftp, javascript:, data:, file:, IP, host local, porta, usuário/senha, tipos errados', async () => {
  const fake = httpsFalso(() => {});
  const t = createHttpsTransport({ https: fake });
  for (const url of ['http://a.example.test/', 'ftp://a.example.test/', 'javascript:alert(1)', 'data:text/html,x', 'file:///x', 'https://127.0.0.1/', 'https://localhost/', 'https://a.example.test:8443/', 'https://u:p@a.example.test/', '//a.example.test/', '', null, undefined, 5, {}]) {
    await assert.rejects(t.request({ ...req0, url }), (e) => e instanceof TransportError && e.code === 'INVALID_URL', String(url));
  }
  assert.equal(fake.chamadas.length, 0);
});

test('[TRN-4] TAMANHO: Content-Length acima do limite aborta sem ler; corpo em fluxo que passa do limite aborta e destrói; no limite exato passa', async () => {
  let req;
  const declarado = httpsFalso((c) => { req = c.req; c.callback(resposta(200, { 'content-length': '5000' })); });
  await assert.rejects(createHttpsTransport({ https: declarado }).request(req0), (e) => e.code === 'TOO_LARGE');
  assert.equal(req.destroyed, true);
  const fluxo = httpsFalso((c) => { req = c.req; const res = resposta(200); c.callback(res); res.emit('data', Buffer.alloc(600)); res.emit('data', Buffer.alloc(600)); res.emit('end'); });
  await assert.rejects(createHttpsTransport({ https: fluxo }).request(req0), (e) => e.code === 'TOO_LARGE');
  assert.equal(req.destroyed, true);
  const exato = httpsFalso((c) => { const res = resposta(200); c.callback(res); res.emit('data', Buffer.alloc(1000)); res.emit('end'); });
  assert.equal((await createHttpsTransport({ https: exato }).request(req0)).body.length, 1000);
});

test('[TRN-5] erros: endereço não público = SSRF; certificado/TLS = TLS; qualquer outro erro de rede ou resposta interrompida = NETWORK; exceção síncrona do módulo = NETWORK; só a primeira conclusão vale', async () => {
  const erro = (codigo) => httpsFalso(({ req }) => req.emit('error', Object.assign(new Error('mensagem que não deve vazar'), { code: codigo })));
  for (const [codigo, esperado] of [['ESSRF', 'SSRF'], ['CERT_HAS_EXPIRED', 'TLS'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS'], ['ERR_SSL_PROTOCOL_ERROR', 'TLS'], ['ECONNRESET', 'NETWORK'], ['ENOTFOUND', 'NETWORK'], ['ECONNREFUSED', 'NETWORK'], [undefined, 'NETWORK']]) {
    await assert.rejects(createHttpsTransport({ https: erro(codigo) }).request(req0), (e) => e.code === esperado && !/vazar/.test(e.message), String(codigo));
  }
  const abortada = httpsFalso(({ callback }) => { const res = resposta(200); callback(res); res.emit('aborted'); });
  await assert.rejects(createHttpsTransport({ https: abortada }).request(req0), (e) => e.code === 'NETWORK');
  const respostaComErro = httpsFalso(({ callback }) => { const res = resposta(200); callback(res); res.emit('error', new Error('x')); });
  let destruida = false;
  const comDestroy = { request: (u, o, cb) => { const r = respostaComErro.request(u, o, cb); const d = r.destroy; r.destroy = () => { destruida = true; d(); }; return r; } };
  await assert.rejects(createHttpsTransport({ https: comDestroy }).request(req0), (e) => e.code === 'NETWORK');
  assert.equal(destruida, true, 'erro na resposta destrói a conexão');
  const lanca = { request() { throw new Error('boom'); } };
  await assert.rejects(createHttpsTransport({ https: lanca }).request(req0), (e) => e.code === 'NETWORK');
  const duas = httpsFalso(({ req, callback }) => { const res = resposta(200); callback(res); res.emit('data', Buffer.from('ok')); res.emit('end'); req.emit('error', new Error('tarde demais')); });
  assert.equal((await createHttpsTransport({ https: duas }).request(req0)).body.toString(), 'ok');
});

// ---------------------------------------------------------------------------------------------------------------------------------
test('[ROB-1] robots.txt: grupo do nosso agente > *; padrão mais longo vence, empate permite; * e $; comentários; Disallow vazio; sem grupo = permitido; limites contra abuso', () => {
  const ok = (texto, caminho, agente = 'rioX7researcherv1') => isAllowed(parseRobots(texto), agente, caminho);
  assert.equal(ok('User-agent: *\nDisallow: /', '/x'), false);
  assert.equal(ok('User-agent: *\nDisallow:', '/x'), true, 'Disallow vazio não bloqueia');
  assert.equal(ok('', '/x'), true);
  assert.equal(ok('# só comentário\nSitemap: https://a.example.test/s.xml', '/x'), true);
  assert.equal(ok('User-agent: googlebot\nDisallow: /', '/x'), true, 'grupo de outro agente não vale');
  assert.equal(ok('User-agent: googlebot\nDisallow: /\nUser-agent: *\nAllow: /', '/x'), true);
  assert.equal(ok('User-agent: *\nDisallow: /a\nAllow: /a/b', '/a/b/c'), true);
  assert.equal(ok('User-agent: *\nDisallow: /a/b\nAllow: /a', '/a/b/c'), false);
  assert.equal(ok('User-agent: *\nDisallow: /a\nAllow: /a', '/a/x'), true, 'empate = permite');
  assert.equal(ok('User-agent: *\nDisallow: /*.pdf$', '/doc/x.pdf'), false);
  assert.equal(ok('User-agent: *\nDisallow: /*.pdf$', '/doc/x.pdf?x=1'), true);
  assert.equal(ok('User-agent: *\nDisallow: /*/privado/', '/a/b/privado/c'), false);
  assert.equal(ok('User-agent: *\nDisallow: /private # comentário', '/private/x'), false);
  assert.equal(ok('USER-AGENT: *\r\nDISALLOW: /x', '/x'), false, 'campos sem diferenciar maiúsculas; CRLF');
  assert.equal(ok('User-agent: rioX7researcherv1\nDisallow: /\n\nUser-agent: *\nAllow: /', '/x'), false);
  assert.equal(ok('User-agent: rio\nDisallow: /a\nUser-agent: rioX7researcherv1\nDisallow: /b', '/b'), false, 'o grupo mais específico');
  assert.equal(ok('User-agent: rio\nDisallow: /a\nUser-agent: rioX7researcherv1\nDisallow: /b', '/a'), true);
  assert.equal(ok('User-agent: a\nUser-agent: b\nUser-agent: *\nDisallow: /x', '/x'), false, 'vários agentes no mesmo grupo');
  assert.equal(ok('Disallow: /x', '/x'), true, 'regra sem user-agent antes não vale');
  assert.equal(ok('User-agent: *\nDisallow: /a.b', '/aXb'), true, 'o ponto é literal');
  const gigante = `User-agent: *\n${'Disallow: /x\n'.repeat(MAX_LINES)}Disallow: /y\n`;
  assert.equal(ok(gigante, '/y'), true, 'linhas além do limite são ignoradas');
  assert.equal(ok(`User-agent: *\nDisallow: /${'a'.repeat(MAX_PATTERN)}`, `/${'a'.repeat(MAX_PATTERN)}`), true, 'padrão gigante ignorado');
  assert.equal(ok('User-agent: *\nDisallow: /(((((((', '/((((((('), false, 'metacaracteres de regex são literais');
  assert.equal(ok('User-agent: *\nDisallow: /a*a*a*a*a*a*a*a*a*a*b', `/${'a'.repeat(200)}`), true, 'sem retrocesso catastrófico');
});

// ---------------------------------------------------------------------------------------------------------------------------------
test('[HTM-1] extração: links absolutos seguros com o texto visível, entidades decodificadas, tel:/mailto: preservados, esquemas perigosos e âncoras descartados, duplicatas fundidas, fragmento removido', () => {
  const pagina = extractPage('<A HREF="/agendar#topo">Agende &amp; venha&nbsp;já</A><a href=\'https://www.instagram.com/x\' class=y><span>Insta</span> <b>gram</b></a><a href=https://a.example.test/sem-aspas>s</a><a href="TEL:+552433331111">tel</a><a href="mailto:x@a.example.test">m</a><a href="javascript:alert(1)">j</a><a href="data:text/html,x">d</a><a href="file:///x">f</a><a href="ftp://x">f</a><a href="http://inseguro.example.test/">h</a><a href="#">h</a><a href="">v</a><a>sem href</a><a href="/agendar#outro">Agende &amp; venha&nbsp;já</a><abbr href="/nao">a</abbr>', 'https://alfa.example.test/base/');
  assert.deepEqual(pagina.links, [
    { href: 'https://alfa.example.test/agendar', texto: 'Agende & venha já' },
    { href: 'https://www.instagram.com/x', texto: 'Insta gram' },
    { href: 'https://a.example.test/sem-aspas', texto: 's' },
    { href: 'tel:+552433331111', texto: 'tel' },
    { href: 'mailto:x@a.example.test', texto: 'm' },
  ]);
  assert.equal(decodeEntities('&#65;&#x42;&lt;&bogus;&#0;&#xD800;'), 'AB<&bogus;  ');
  assert.equal(safeHref('//outro.example.test/x', 'https://a.example.test/'), 'https://outro.example.test/x');
  assert.equal(safeHref('x'.repeat(3000), 'https://a.example.test/'), null);
});

test('[HTM-2] script, style, noscript, template e comentários são REMOVIDOS antes de ler (nada é executado nem seguido); bloco sem fechamento descarta o resto; texto de link é limpo e limitado', () => {
  const pagina = extractPage('<a href="/1">um</a><script>var a="<a href=\'/no1\'>x</a>";</script><style>a{}</style><!-- <a href="/no2">c</a> --><noscript><a href="/no3">n</a></noscript><TEMPLATE><a href="/no4">t</a></TEMPLATE><a href="/2">dois</a><script>nunca fecha <a href="/no5">x</a>', 'https://a.example.test/');
  assert.deepEqual(pagina.links.map((l) => l.href), ['https://a.example.test/1', 'https://a.example.test/2']);
  const longo = extractPage(`<a href="/x">${'palavra '.repeat(100)}\u0000‮​fim</a>`, 'https://a.example.test/');
  assert.equal(longo.links[0].texto.length <= 200, true);
  assert.doesNotMatch(longo.links[0].texto, /[\u0000‮​]/);
});

test('[HTM-3] formulário de contato (textarea ou e-mail/telefone, sem senha); formulário de login/busca não conta; sinais de muro (senha, desafio forte, captcha fraco) e contagem de links', () => {
  const f = (h) => extractPage(h, 'https://a.example.test/');
  assert.equal(f('<form><textarea></textarea></form>').temFormularioContato, true);
  assert.equal(f('<form><input type="email"></form>').temFormularioContato, true);
  assert.equal(f('<form><input TYPE=\'tel\'></form>').temFormularioContato, true);
  assert.equal(f('<form><input type="text"><input type="submit"></form>').temFormularioContato, false, 'busca');
  assert.equal(f('<form><input type="email"><input type="password"></form>').temFormularioContato, false, 'login');
  assert.equal(f('<form><input type="password"></form><form><textarea></textarea></form>').temFormularioContato, true);
  assert.equal(f('<input type="email"><textarea></textarea>').temFormularioContato, false, 'fora de <form>');
  assert.equal(f('<form><input type="password"></form>').temSenha, true);
  assert.equal(f('<p>oi</p>').temSenha, false);
  assert.equal(f('<title>Just a moment...</title>').desafioForte, true);
  assert.equal(f('<div id="cf-chl-opt"></div>').desafioForte, true);
  assert.equal(f('<div class="g-recaptcha"></div>').desafioForte, false);
  assert.equal(f('<div class="g-recaptcha"></div>').marcadorCaptcha, true);
  assert.equal(f('<a href="/a">a</a><a href="/b">b</a>').totalLinks, 2);
});

test('[HTM-4] limite de links: até 600 devolvidos; o excesso é REPORTADO em linksTruncados (nunca silencioso); páginas hostis (tags sem fechamento, milhares de âncoras/forms/scripts) terminam rápido', () => {
  const muitos = Array.from({ length: 700 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('');
  const p = extractPage(muitos, 'https://a.example.test/');
  assert.deepEqual([p.links.length, p.linksTruncados, p.totalLinks, MAX_LINKS], [600, 100, 700, 600]);
  const inicio = Date.now();
  for (const hostil of ['<a href=x>'.repeat(100000), '<form>'.repeat(50000), '<script'.repeat(100000), '<input '.repeat(150000), `${'<a href="https://a.example.test/">'.repeat(30000)}${'x'.repeat(500000)}`, '<'.repeat(500000), '&#'.repeat(200000), '<!--'.repeat(100000), '<a href="'.repeat(100000)]) extractPage(hostil, 'https://a.example.test/');
  assert.ok(Date.now() - inicio < 8000, `páginas hostis levaram ${Date.now() - inicio} ms`);
});

// ---------------------------------------------------------------------------------------------------------------------------------
test('[NOM-1] Nominatim -> porta search: site https, canais do OSM (URL ou @usuário) revalidados pela política, cidade/estado, fonte = a página pública do objeto no OSM; http NÃO é promovido a https; canal errado, sem nome, tipo/id inválidos são descartados', () => {
  const lugar = (extra = {}, tags = {}) => ({ osm_type: 'node', osm_id: 42, name: 'Clínica Alfa Teste', address: { town: 'Petrópolis', state: 'Rio de Janeiro' }, extratags: tags, ...extra });
  const fonteUrl = 'https://www.openstreetmap.org/node/42';
  assert.deepEqual(mapPlace(lugar({}, { website: 'https://alfa-teste.example.test/', 'contact:instagram': '@alfa_teste', 'contact:facebook': 'https://facebook.com/alfa.teste/', youtube: 'https://www.youtube.com/@alfa', 'contact:linkedin': 'https://www.linkedin.com/company/alfa' })), [
    { nome: 'Clínica Alfa Teste', url: 'https://alfa-teste.example.test/', tipoResultado: 'SITE', fonteUrl, cidade: 'Petrópolis', estado: 'Rio de Janeiro' },
    { nome: 'Clínica Alfa Teste', url: 'https://www.instagram.com/alfa_teste', tipoResultado: 'INSTAGRAM', fonteUrl, cidade: 'Petrópolis', estado: 'Rio de Janeiro' },
    { nome: 'Clínica Alfa Teste', url: 'https://www.facebook.com/alfa.teste', tipoResultado: 'FACEBOOK', fonteUrl, cidade: 'Petrópolis', estado: 'Rio de Janeiro' },
    { nome: 'Clínica Alfa Teste', url: 'https://www.linkedin.com/company/alfa', tipoResultado: 'LINKEDIN', fonteUrl, cidade: 'Petrópolis', estado: 'Rio de Janeiro' },
    { nome: 'Clínica Alfa Teste', url: 'https://www.youtube.com/@alfa', tipoResultado: 'YOUTUBE', fonteUrl, cidade: 'Petrópolis', estado: 'Rio de Janeiro' },
  ]);
  assert.deepEqual(mapPlace(lugar({}, { website: 'http://alfa-teste.example.test/' })), [], 'http não vira https');
  assert.deepEqual(mapPlace(lugar({}, { 'contact:website': 'https://b.example.test/' })).map((r) => r.url), ['https://b.example.test/']);
  assert.deepEqual(mapPlace(lugar({}, { website: 'javascript:alert(1)', 'contact:instagram': 'https://www.instagram.com/p/abc', facebook: 'https://facebook.com/sharer/sharer.php' })), []);
  assert.deepEqual(mapPlace(lugar({}, { 'contact:instagram': 'https://www.facebook.com/alfa.teste' })), [], 'o canal tem de ser o certo');
  assert.deepEqual(mapPlace(lugar({}, { 'contact:instagram': 'com espaço' })), []);
  assert.deepEqual(mapPlace(lugar({}, { website: 'https://127.0.0.1/' })), []);
  for (const ruim of [lugar({ name: undefined }, { website: 'https://a.example.test/' }), lugar({ name: '   ' }, { website: 'https://a.example.test/' }), lugar({ osm_type: 'planet' }, { website: 'https://a.example.test/' }), lugar({ osm_id: '42' }, { website: 'https://a.example.test/' }), lugar({ osm_id: 0 }, { website: 'https://a.example.test/' }), null, 'x', 5, [], { name: 'X' }]) assert.deepEqual(mapPlace(ruim), [], JSON.stringify(ruim));
  assert.equal(mapPlace(lugar({ address: null }, { website: 'https://a.example.test/' }))[0].cidade, undefined);
  assert.equal(mapPlace(lugar({ extratags: null }, {})).length, 0);
  assert.equal(mapPlace(lugar({ extratags: JSON.parse('{"__proto__":{"website":"https://evil.example.test/"}}') })).length, 0, 'protótipo não é tag');
});

test('[HTM-5] limites de varredura deterministas: no máximo 20000 âncoras examinadas e 50 formulários; o formulário de contato depois do 50º não é lido (limite declarado)', () => {
  const ancoras = Array.from({ length: 25000 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('');
  assert.equal(extractPage(ancoras, 'https://a.example.test/').totalLinks, 20000);
  const busca = '<form><input type="text"></form>'.repeat(50);
  assert.equal(extractPage(`${busca}<form><textarea></textarea></form>`, 'https://a.example.test/').temFormularioContato, false);
  assert.equal(extractPage(`${busca.slice(0, busca.length - 33)}<form><textarea></textarea></form>`, 'https://a.example.test/').temFormularioContato, true);
});

test('[NOM-3] tags herdadas do protótipo não valem (só as próprias do lugar)', () => {
  const herdado = Object.create({ website: 'https://evil.example.test/' });
  assert.deepEqual(mapPlace({ osm_type: 'node', osm_id: 1, name: 'X Teste', extratags: herdado }), []);
  assert.deepEqual(mapPlace({ osm_type: 'node', osm_id: 1, name: 'X Teste', extratags: Object.assign(Object.create({ website: 'https://evil.example.test/' }), { 'contact:website': 'https://ok.example.test/' }) }).map((r) => r.url), ['https://ok.example.test/']);
});

test('[NOM-2] a busca: UMA requisição com a URL do provedor (formato, limite ≤ 40, idioma), sem detalhes do provedor no resultado; falhas do cliente passam; corpo fora da forma = ERRO; consulta inválida nem sai', async () => {
  const pedidos = [];
  const web = { getJson: async (url) => { pedidos.push(url); return { ok: true, data: [{ osm_type: 'way', osm_id: 7, name: 'Museu Teste', extratags: { website: 'https://museu-teste.example.test/' } }] }; } };
  const search = createNominatimSearch({ web });
  const r = await search({ consulta: 'Museu Teste Petrópolis', limite: 100 });
  assert.deepEqual(r, { ok: true, resultados: [{ nome: 'Museu Teste', url: 'https://museu-teste.example.test/', tipoResultado: 'SITE', fonteUrl: 'https://www.openstreetmap.org/way/7' }] });
  assert.deepEqual(pedidos, ['https://nominatim.openstreetmap.org/search?q=Museu+Teste+Petr%C3%B3polis&format=jsonv2&limit=40&addressdetails=1&extratags=1&accept-language=pt-BR']);
  assert.doesNotMatch(JSON.stringify(r), /osm_type|osm_id|extratags|display_name/);
  await search({ consulta: 'x', limite: 3 });
  assert.match(pedidos[1], /limit=3&/);
  for (const ruim of [{ consulta: '', limite: 3 }, { consulta: '   ', limite: 3 }, { consulta: 'x'.repeat(301), limite: 3 }, { consulta: 5, limite: 3 }, { consulta: 'x', limite: 0 }, { consulta: 'x', limite: 1.5 }, { consulta: 'x' }, null, undefined]) assert.deepEqual(await search(ruim), { ok: false, falha: 'ERRO' }, JSON.stringify(ruim));
  assert.equal(pedidos.length, 2, 'entrada inválida não gera requisição');
  for (const data of [{}, 'x', null, 5, Array.from({ length: 51 }, () => ({}))]) assert.deepEqual(await createNominatimSearch({ web: { getJson: async () => ({ ok: true, data }) } })({ consulta: 'x', limite: 1 }), { ok: false, falha: 'ERRO' });
  assert.deepEqual(await createNominatimSearch({ web: { getJson: async () => ({ ok: false, falha: 'ROBOTS' }) } })({ consulta: 'x', limite: 1 }), { ok: false, falha: 'ROBOTS' });
  assert.deepEqual(await createNominatimSearch({ web: { getJson: async () => ({ ok: true, data: [] }) } })({ consulta: 'x', limite: 1 }), { ok: true, resultados: [] }, 'sem resultado = lista vazia, nunca uma afirmação');
  assert.throws(() => createNominatimSearch({}), /getJson/);
  assert.throws(() => createNominatimSearch({ web, baseUrl: 'http://nominatim.example.test' }), /baseUrl/);
  assert.throws(() => createNominatimSearch({ web, baseUrl: 'https://nominatim.example.test/x?y=1' }), /baseUrl/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
test('[ARQ-1] fronteiras: o domínio (research-prospector) NÃO conhece os adaptadores; os adaptadores só importam módulos irmãos, node:https/net/dns e a política do domínio; nenhum importa CRM, fila, serviços, servidor ou autorização; sem dependência nova', () => {
  const dominio = path.join(RAIZ, 'src', 'research-prospector');
  for (const nome of fs.readdirSync(dominio)) assert.doesNotMatch(fs.readFileSync(path.join(dominio, nome), 'utf8'), /research-adapters/, `${nome} não conhece os adaptadores`);
  for (const proibido of ['src/services', 'src/server', 'src/auth', 'src/crm']) for (const nome of fs.readdirSync(path.join(RAIZ, 'src', 'research-adapters'))) assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, 'src', 'research-adapters', nome), 'utf8'), new RegExp(proibido.replace('/', '[/\\\\]')));
  const permitido = /^(\.\/(netGuard|httpsTransport|robots|htmlExtract|publicWeb|nominatimSearch)|\.\.\/research-prospector\/researchPolicy|node:(https|net|dns))$/;
  for (const nome of fs.readdirSync(path.join(RAIZ, 'src', 'research-adapters'))) {
    const arquivo = path.join(RAIZ, 'src', 'research-adapters', nome);
    const analise = analyzeSource(fs.readFileSync(arquivo, 'utf8'), toPosix(path.relative(RAIZ, arquivo)));
    assert.deepEqual(analise.issues, [], nome);
    for (const ref of analise.refs) assert.match(ref.specifier, nome === 'index.js' ? /^(\.\/(httpsTransport|publicWeb|nominatimSearch))$/ : permitido, `${nome} importa ${ref.specifier}`);
  }
  // o Researcher e a política continuam puros (sem rede) e SEM tocar em nada de adaptador
  for (const nome of ['researcher.js', 'researchPolicy.js']) assert.doesNotMatch(fs.readFileSync(path.join(dominio, nome), 'utf8').replace(/\/\/.*$/gm, ''), /node:|https?\.request|require\('\.\.\//);
  const pacote = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pacote.dependencies), ['@supabase/supabase-js'], 'nenhuma dependência nova');
  assert.equal(pacote.devDependencies, undefined);
});

test('[ARQ-2] a composição entrega as portas `search` e `fetchPage` e NENHUM `lookupAds` (não há fonte pública adequada de anúncios); o serviço de prospecção, a fila, o lote e o CRM não conhecem os adaptadores nem o Researcher', () => {
  const t = { request: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }) };
  const portas = createResearchPorts({ transport: t, userAgent: 'RioX7ResearcherV1/1.0 (teste)' });
  assert.deepEqual(Object.keys(portas).sort(), ['estatisticas', 'fetchPage', 'search']);
  assert.equal('lookupAds' in portas, false);
  for (const arquivo of ['src/services/prospectingService.js', 'src/services/prospectingFileService.js', 'src/services/approvalQueueService.js', 'src/research-prospector/approvalQueue.js', 'src/research-prospector/batchRepository.js', 'src/research-prospector/dossierRepository.js', 'src/server/app.js', 'src/server/index.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, arquivo), 'utf8'), /research-adapters|researcher|researchPolicy/, arquivo);
  }
  assert.equal(fs.existsSync(path.join(RAIZ, 'src', 'services', 'researchService.js')), false);
});
