// TESTES OFFLINE do adaptador de pesquisa (src/research-adapters/) — decisão 0022.
// NENHUMA requisição real: o transporte é um FAKE em memória (e, para o transporte de verdade, o módulo `https` é um fake injetado).
// O único acesso real à internet é o smoke test manual (scripts/smoke-researcher.js), separado de tudo isto.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPublicWeb } = require('../../src/research-adapters/publicWeb');
const { createResearchPorts } = require('../../src/research-adapters');
const { TransportError } = require('../../src/research-adapters/httpsTransport');
const { createResearcher } = require('../../src/research-prospector/researcher');
const { validateRawFindingsV2 } = require('../../src/research-prospector/rawFindingV2');
const { FAILURE } = require('../../src/research-prospector/researchPolicy');

const UA = 'RioX7ResearcherV1/1.0 (pesquisa publica controlada)';
const SITE = 'https://alfa-teste.example.test/';
const AGORA = new Date('2026-09-26T15:00:00.000Z');

const resp = (status, body = '', headers = {}) => ({ status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body: Buffer.from(body) });
const html = (body, extras) => resp(200, `<html><body>${body}</body></html>`, extras);
const linksHtml = (n = 5) => Array.from({ length: n }, (_, i) => `<a href="/p${i}">Página ${i}</a>`).join('');
const PAGINA_COM_LINKS = `${linksHtml(6)}<a href="https://www.instagram.com/alfa_teste">Instagram</a><a href="https://wa.me/5524987651000">WhatsApp</a><a href="/agendar">Agende sua consulta</a><form action="/c"><input type="email"><textarea></textarea></form>`;

// Transporte fake: rotas por URL (resposta, função ou erro); registra todas as requisições; robots.txt padrão = 404.
function transporteFake(rotas = {}) {
  const chamadas = [];
  return {
    chamadas,
    request: async (req) => {
      chamadas.push(req);
      const rota = rotas[req.url] !== undefined ? rotas[req.url] : req.url.endsWith('/robots.txt') ? resp(404) : resp(404);
      const saida = typeof rota === 'function' ? rota(req) : rota;
      if (saida instanceof Error) throw saida;
      return saida;
    },
  };
}
function web(rotas, opcoes = {}) {
  const t = transporteFake(rotas);
  const dormiu = [];
  let relogio = 1_000_000;
  const w = createPublicWeb({ transport: t, userAgent: UA, now: () => new Date(relogio), sleep: async (ms) => { dormiu.push(ms); relogio += ms; }, ...opcoes });
  return { w, t, dormiu, avancar: (ms) => { relogio += ms; } };
}
const paginas = (t) => t.chamadas.filter((c) => !c.url.endsWith('/robots.txt')).map((c) => c.url);
const eventos = (w) => w.estatisticas().eventos.map((e) => e.codigo);

// ---------------------------------------------------------------------------------------------------------------------------------
test('[ADP-1] SUCESSO: robots.txt lido primeiro, depois a página; devolve exatamente o contrato do Researcher { ok, urlFinal, links, temFormularioContato }', async () => {
  const { w, t } = web({ [SITE]: html(PAGINA_COM_LINKS) });
  const r = await w.fetchPage(SITE);
  assert.deepEqual(Object.keys(r).sort(), ['links', 'ok', 'temFormularioContato', 'urlFinal']);
  assert.deepEqual([r.ok, r.urlFinal, r.temFormularioContato], [true, SITE, true]);
  assert.ok(r.links.some((l) => l.href === 'https://www.instagram.com/alfa_teste' && l.texto === 'Instagram'));
  assert.ok(r.links.some((l) => l.href === 'https://alfa-teste.example.test/agendar' && l.texto === 'Agende sua consulta'), 'links relativos resolvidos contra a página');
  assert.deepEqual(t.chamadas.map((c) => c.url), ['https://alfa-teste.example.test/robots.txt', SITE]);
  assert.deepEqual([w.estatisticas().requisicoes, w.estatisticas().robotsConsultados, w.estatisticas().falhas], [2, 1, {}]);
});

test('[ADP-2] TIMEOUT: o transporte estoura o tempo -> TEMPO_ESGOTADO (sem nova tentativa); o tempo é explícito, configurável e nunca infinito', async () => {
  const { w, t } = web({ [SITE]: new TransportError('TIMEOUT') }, { timeoutMs: 1234 });
  assert.deepEqual(await w.fetchPage(SITE), { ok: false, falha: FAILURE.TEMPO_ESGOTADO });
  assert.equal(paginas(t).length, 1, 'uma única tentativa');
  assert.deepEqual(t.chamadas.map((c) => c.timeoutMs), [1234, 1234], 'o robots.txt e a página usam o tempo configurado');
  assert.ok(eventos(w).includes('TIMEOUT'));
  assert.equal(w.estatisticas().limites.timeoutMs, 1234);
  assert.equal(createPublicWeb({ transport: t, userAgent: UA }).estatisticas().limites.timeoutMs, 10000, 'há um padrão finito');
  for (const ruim of [0, -1, Infinity, NaN, 1.5, '10', null, 60001]) assert.throws(() => createPublicWeb({ transport: t, userAgent: UA, timeoutMs: ruim }), /timeoutMs/, String(ruim));
});

test('[ADP-3] HTTPS INVÁLIDO: http, javascript:, data:, file:, ftp:, //host, host local, IP, porta e usuário/senha são recusados ANTES de qualquer requisição; um redirecionamento para http também', async () => {
  const { w, t } = web({ [SITE]: resp(302, '', { location: 'http://alfa-teste.example.test/x' }) });
  for (const url of ['http://a.example.test/', 'javascript:alert(1)', 'data:text/html,x', 'file:///C:/x', 'ftp://a.example.test/', '//a.example.test/', 'https://localhost/', 'https://127.0.0.1/', 'https://10.0.0.5/', 'https://[::1]/', 'https://a.example.test:8443/', 'https://u:p@a.example.test/', 'texto', '', null, undefined, 5, {}]) {
    assert.deepEqual(await w.fetchPage(url), { ok: false, falha: FAILURE.ERRO }, String(url));
  }
  assert.equal(t.chamadas.length, 0, 'nenhuma requisição saiu');
  assert.deepEqual(await w.fetchPage(SITE), { ok: false, falha: FAILURE.ERRO });
  assert.ok(eventos(w).includes('REDIRECT_INVALIDO'));
  assert.equal(paginas(t).length, 1, 'o destino http nunca foi buscado');
});

test('[ADP-4] REDIRECT: seguido à mão dentro do limite (3), só no mesmo host por padrão, cada salto revalidado; excesso, destino ausente e host externo são falhas com evento', async () => {
  const salto = (n, destino) => resp(301 + (n % 2), '', { location: destino });
  const a = web({ [SITE]: salto(0, '/b'), 'https://alfa-teste.example.test/b': salto(1, 'https://www.alfa-teste.example.test/c'), 'https://www.alfa-teste.example.test/c': html('<a href="/x">x</a>') });
  const r = await a.w.fetchPage(SITE);
  assert.deepEqual([r.ok, r.urlFinal], [true, 'https://www.alfa-teste.example.test/c'], 'o "www." conta como o mesmo host');
  assert.equal(a.w.estatisticas().redirecionamentos, 2);
  assert.deepEqual(a.t.chamadas.filter((c) => c.url.endsWith('/robots.txt')).length, 2, 'o robots.txt é consultado por origem (apex e www)');

  const laco = {};
  for (let i = 0; i < 6; i += 1) laco[`https://alfa-teste.example.test/${i === 0 ? '' : i}`] = salto(i, `/${i + 1}`);
  const b = web(laco);
  assert.deepEqual(await b.w.fetchPage(SITE), { ok: false, falha: FAILURE.ERRO });
  assert.ok(eventos(b.w).includes('REDIRECTS_EXCESSIVOS'));
  assert.equal(paginas(b.t).length, 4, '1 pedido + 3 redirecionamentos, nunca mais');
  assert.equal(web({}, { maxRedirects: 0 }).w.estatisticas().limites.maxRedirects, 0);

  const externo = web({ [SITE]: resp(302, '', { location: 'https://outro-dominio.example.test/' }) });
  assert.deepEqual(await externo.w.fetchPage(SITE), { ok: false, falha: FAILURE.ERRO });
  assert.ok(eventos(externo.w).includes('REDIRECT_EXTERNO'));
  assert.equal(paginas(externo.t).length, 1);
  const liberado = web({ [SITE]: resp(302, '', { location: 'https://outro-dominio.example.test/' }), 'https://outro-dominio.example.test/': html('<a href="/x">x</a>') }, { allowCrossHostRedirects: true });
  assert.equal((await liberado.w.fetchPage(SITE)).ok, true);

  const semDestino = web({ [SITE]: resp(302) });
  assert.deepEqual(await semDestino.w.fetchPage(SITE), { ok: false, falha: FAILURE.ERRO });
  assert.ok(eventos(semDestino.w).includes('REDIRECT_SEM_DESTINO'));
  for (const [destino, codigo] of [['http://alfa-teste.example.test/', 'REDIRECT_INVALIDO'], ['javascript:alert(1)', 'REDIRECT_INVALIDO'], ['https://127.0.0.1/', 'REDIRECT_INVALIDO'], ['https://localhost/', 'REDIRECT_INVALIDO']]) {
    const x = web({ [SITE]: resp(302, '', { location: destino }) });
    assert.equal((await x.w.fetchPage(SITE)).ok, false, destino);
    assert.ok(eventos(x.w).includes(codigo), destino);
  }
});

test('[ADP-5] REDIRECT PARA LOGIN: LOGIN com o evento REDIRECT_TO_LOGIN; a tela de login NUNCA é buscada e não há nova tentativa', async () => {
  for (const destino of ['/login', '/accounts/login/?next=/', 'https://alfa-teste.example.test/checkpoint/1', '/signin', '/authwall']) {
    const { w, t } = web({ [SITE]: resp(302, '', { location: destino }) });
    assert.deepEqual(await w.fetchPage(SITE), { ok: false, falha: FAILURE.LOGIN }, destino);
    assert.ok(eventos(w).includes('REDIRECT_TO_LOGIN'), destino);
    assert.equal(paginas(t).length, 1, `${destino}: só a página original foi pedida`);
    assert.deepEqual(w.estatisticas().falhas, { LOGIN: 1 });
  }
  const direta = web({});
  assert.deepEqual(await direta.w.fetchPage('https://alfa-teste.example.test/login'), { ok: false, falha: FAILURE.LOGIN });
  assert.equal(direta.t.chamadas.length, 0);
  assert.ok(eventos(direta.w).includes('URL_DE_LOGIN'));
});

test('[ADP-6] CAPTCHA: desafio anunciado por cabeçalho, desafio forte no HTML e captcha numa página quase sem links = CAPTCHA (nunca resolvido); um site normal com reCAPTCHA num formulário NÃO é bloqueio', async () => {
  const cf = web({ [SITE]: resp(403, 'x', { 'cf-mitigated': 'challenge' }) });
  assert.deepEqual(await cf.w.fetchPage(SITE), { ok: false, falha: FAILURE.CAPTCHA });
  const cf503 = web({ [SITE]: resp(503, 'x', { 'cf-mitigated': 'challenge' }) });
  assert.equal((await cf503.w.fetchPage(SITE)).falha, FAILURE.CAPTCHA);
  const forte = web({ [SITE]: html('<title>Just a moment...</title><div id="cf-chl-widget"></div>' + linksHtml(20)) });
  assert.equal((await forte.w.fetchPage(SITE)).falha, FAILURE.CAPTCHA);
  const fraco = web({ [SITE]: html('<div class="g-recaptcha"></div><a href="/a">a</a>') });
  assert.deepEqual(await fraco.w.fetchPage(SITE), { ok: false, falha: FAILURE.CAPTCHA });
  assert.ok(eventos(fraco.w).includes('DESAFIO_NA_PAGINA'));
  const normal = web({ [SITE]: html(`${linksHtml(8)}<form><textarea></textarea><div class="g-recaptcha"></div></form>`) });
  const r = await normal.w.fetchPage(SITE);
  assert.deepEqual([r.ok, r.temFormularioContato], [true, true], 'reCAPTCHA de formulário em página normal é só um formulário');
  assert.equal(normal.t.chamadas.length, 2, 'nenhuma tentativa de "passar" pelo desafio');
});

test('[ADP-7] BLOQUEIO: 401 = LOGIN; 403 e 429 = BLOQUEADO; endereço não público (SSRF) = BLOQUEADO; muro de login no HTML = LOGIN — sem repetir; uma página normal com formulário de login e muitos links não é muro', async () => {
  const casos = [[401, FAILURE.LOGIN], [403, FAILURE.BLOQUEADO], [429, FAILURE.BLOQUEADO], [404, FAILURE.REMOVIDA], [410, FAILURE.REMOVIDA], [500, FAILURE.FORA_DO_AR], [502, FAILURE.FORA_DO_AR], [503, FAILURE.FORA_DO_AR], [418, FAILURE.ERRO], [100, FAILURE.ERRO]];
  for (const [status, falha] of casos) {
    const { w, t } = web({ [SITE]: resp(status, 'x') });
    assert.deepEqual(await w.fetchPage(SITE), { ok: false, falha }, String(status));
    assert.equal(paginas(t).length, 1, `${status}: sem nova tentativa`);
  }
  const ssrf = web({ [SITE]: new TransportError('SSRF') });
  assert.deepEqual(await ssrf.w.fetchPage(SITE), { ok: false, falha: FAILURE.BLOQUEADO });
  assert.ok(eventos(ssrf.w).includes('ENDERECO_NAO_PUBLICO'));
  const muro = web({ [SITE]: html('<form><input type="password" name="s"><input name="u"></form><a href="/esqueci">Esqueci</a>') });
  assert.deepEqual(await muro.w.fetchPage(SITE), { ok: false, falha: FAILURE.LOGIN });
  assert.ok(eventos(muro.w).includes('MURO_DE_LOGIN'));
  const portal = web({ [SITE]: html(`${linksHtml(10)}<form><input type="password"></form>`) });
  assert.equal((await portal.w.fetchPage(SITE)).ok, true, 'site com portal de login e conteúdo público: o conteúdo público vale');
});

test('[ADP-8] ROBOTS: bloqueado pelo robots.txt = ROBOTS sem pedir a página; robots inexistente (404/410) = permitido; qualquer outra coisa que impeça verificar = NÃO acessa; uma consulta por origem', async () => {
  const bloqueia = web({ 'https://alfa-teste.example.test/robots.txt': resp(200, 'User-agent: *\nDisallow: /', { 'content-type': 'text/plain' }), [SITE]: html(PAGINA_COM_LINKS) });
  assert.deepEqual(await bloqueia.w.fetchPage(SITE), { ok: false, falha: FAILURE.ROBOTS });
  assert.equal(paginas(bloqueia.t).length, 0, 'a página proibida nunca foi pedida');
  assert.ok(eventos(bloqueia.w).includes('ROBOTS_BLOQUEIA'));

  for (const status of [404, 410]) assert.equal((await web({ 'https://alfa-teste.example.test/robots.txt': resp(status), [SITE]: html('<a href="/x">x</a>') }).w.fetchPage(SITE)).ok, true, String(status));

  const naoVerifica = [['401', resp(401)], ['403', resp(403)], ['500', resp(500)], ['503', resp(503)], ['400', resp(400)], ['timeout', new TransportError('TIMEOUT')], ['rede', new TransportError('NETWORK')], ['grande', new TransportError('TOO_LARGE')], ['ssrf', new TransportError('SSRF')], ['redirect externo', resp(301, '', { location: 'https://outro.example.test/robots.txt' })], ['redirect sem destino', resp(301)], ['gzip', resp(200, 'User-agent: *\nAllow: /', { 'content-encoding': 'gzip' })], ['resposta inválida', { status: 'x', headers: {}, body: 'y' }]];
  for (const [nome, robots] of naoVerifica) {
    const { w, t } = web({ 'https://alfa-teste.example.test/robots.txt': robots, [SITE]: html('<a href="/x">x</a>') });
    assert.deepEqual(await w.fetchPage(SITE), { ok: false, falha: FAILURE.ROBOTS }, nome);
    assert.equal(paginas(t).length, 0, `${nome}: sem verificação adequada NÃO se acessa`);
    assert.ok(eventos(w).includes('ROBOTS_NAO_VERIFICADO'), nome);
  }
  const permite = web({ 'https://alfa-teste.example.test/robots.txt': resp(200, 'User-agent: *\nDisallow: /privado\nAllow: /privado/publico', { 'content-type': 'text/plain' }), [SITE]: html('<a href="/x">x</a>'), 'https://alfa-teste.example.test/privado/publico': html('<a href="/x">x</a>'), 'https://alfa-teste.example.test/privado/x': html('<a href="/x">x</a>') });
  assert.equal((await permite.w.fetchPage(SITE)).ok, true);
  assert.equal((await permite.w.fetchPage('https://alfa-teste.example.test/privado/publico')).ok, true, 'o Allow mais específico vence');
  assert.equal((await permite.w.fetchPage('https://alfa-teste.example.test/privado/x')).falha, FAILURE.ROBOTS);
  assert.equal(permite.t.chamadas.filter((c) => c.url.endsWith('/robots.txt')).length, 1, 'uma consulta por origem, guardada');
  const nosso = web({ 'https://alfa-teste.example.test/robots.txt': resp(200, 'User-agent: rioX7researcherv1\nDisallow: /\n\nUser-agent: *\nAllow: /', { 'content-type': 'text/plain' }), [SITE]: html('<a href="/x">x</a>') });
  assert.equal((await nosso.w.fetchPage(SITE)).falha, FAILURE.ROBOTS, 'o grupo do NOSSO user-agent prevalece sobre o *');
  // a API também respeita o robots: getJson passa pelo mesmo caminho
  const api = web({ 'https://api.example.test/robots.txt': resp(200, 'User-agent: *\nDisallow: /search', { 'content-type': 'text/plain' }) });
  assert.deepEqual(await api.w.getJson('https://api.example.test/search?q=x'), { ok: false, falha: FAILURE.ROBOTS });
});

test('[ADP-9] RESPOSTA MUITO GRANDE: o limite é passado ao transporte (1 MiB páginas, 512 KiB robots.txt) e o estouro é falha ERRO sem ler o resto; limites validados e finitos', async () => {
  const { w, t } = web({ [SITE]: new TransportError('TOO_LARGE') });
  assert.deepEqual(await w.fetchPage(SITE), { ok: false, falha: FAILURE.ERRO });
  assert.ok(eventos(w).includes('RESPOSTA_GRANDE'));
  assert.deepEqual(t.chamadas.map((c) => [c.url.endsWith('/robots.txt') ? 'robots' : 'pagina', c.maxBytes]), [['robots', 512 * 1024], ['pagina', 1024 * 1024]]);
  const menor = web({ [SITE]: html('<a href="/x">x</a>') }, { maxBytes: 4096, robotsMaxBytes: 2048 });
  await menor.w.fetchPage(SITE);
  assert.deepEqual(menor.t.chamadas.map((c) => c.maxBytes), [2048, 4096]);
  for (const [nome, ruim] of [['maxBytes', 0], ['maxBytes', 1e12], ['maxBytes', Infinity], ['robotsMaxBytes', 2 * 1024 * 1024], ['maxRedirects', 6], ['maxRedirects', -1], ['maxRequests', 0], ['maxRequests', 100000], ['minIntervalMs', -1], ['maxEvents', 0]]) assert.throws(() => createPublicWeb({ transport: t, userAgent: UA, [nome]: ruim }), new RegExp(nome), `${nome}=${ruim}`);
});

test('[ADP-10] CONTEÚDO INVÁLIDO: tipo que não é HTML, JSON malformado, codificação comprimida inesperada, resposta fora da forma e bytes aleatórios são tratados sem lançar; nada é executado', async () => {
  for (const [nome, resposta] of [['pdf', resp(200, '%PDF-1.4', { 'content-type': 'application/pdf' })], ['imagem', resp(200, 'GIF89a', { 'content-type': 'image/gif' })], ['sem tipo', { status: 200, headers: {}, body: Buffer.from('<a href="/x">x</a>') }], ['json como página', resp(200, '{"a":1}', { 'content-type': 'application/json' })]]) {
    assert.deepEqual(await web({ [SITE]: resposta }).w.fetchPage(SITE), { ok: false, falha: FAILURE.ERRO }, nome);
  }
  const gz = web({ [SITE]: html('x', { 'content-encoding': 'gzip' }) });
  assert.deepEqual(await gz.w.fetchPage(SITE), { ok: false, falha: FAILURE.ERRO });
  assert.ok(eventos(gz.w).includes('CODIFICACAO'));
  assert.equal((await web({ [SITE]: html('x', { 'content-encoding': 'identity' }) }).w.fetchPage(SITE)).ok, true);
  for (const lixo of [null, 5, 'x', {}, { status: 200 }, { status: '200', headers: {}, body: Buffer.from('') }, { status: 200, headers: {}, body: 'texto' }]) {
    assert.deepEqual(await web({ [SITE]: lixo }).w.fetchPage(SITE), { ok: false, falha: FAILURE.ERRO }, JSON.stringify(lixo));
  }
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) % 256));
  const r = await web({ [SITE]: { status: 200, headers: { 'content-type': 'text/html' }, body: bytes } }).w.fetchPage(SITE);
  assert.deepEqual([r.ok, r.links], [true, []], 'bytes sem HTML: página sem links, nunca um erro nem uma execução');
  const script = await web({ [SITE]: html('<script>document.location="https://evil.example.test/"; fetch("https://evil.example.test/steal")</script><a href="/ok">ok</a><!-- <a href="https://evil.example.test/c">c</a> -->') }).w.fetchPage(SITE);
  assert.deepEqual(script.links.map((l) => l.href), ['https://alfa-teste.example.test/ok'], 'script e comentário não são lidos nem seguidos');
  const json = web({ 'https://api.example.test/x': resp(200, '{ quebrado', { 'content-type': 'application/json' }) });
  assert.deepEqual(await json.w.getJson('https://api.example.test/x'), { ok: false, falha: FAILURE.ERRO });
  assert.deepEqual(await web({ 'https://api.example.test/x': resp(200, '[1,2]', { 'content-type': 'application/json; charset=utf-8' }) }).w.getJson('https://api.example.test/x'), { ok: true, data: [1, 2] });
  assert.equal((await web({ 'https://api.example.test/x': resp(200, '[]', { 'content-type': 'text/html' }) }).w.getJson('https://api.example.test/x')).ok, false);
});

test('[ADP-11] ERRO DE REDE: rede = FORA_DO_AR; TLS = ERRO; exceção desconhecida = ERRO; NUNCA lança, e a mensagem/URL/cabeçalho não aparecem no resultado nem nos eventos', async () => {
  for (const [erro, falha, evento] of [[new TransportError('NETWORK'), FAILURE.FORA_DO_AR, 'ERRO_DE_REDE'], [new TransportError('TLS'), FAILURE.ERRO, 'TLS'], [new TransportError('INVALID_URL'), FAILURE.ERRO, 'URL_INVALIDA'], [new Error('C:\\segredo\\x ECONNRESET https://interno.example.test'), FAILURE.ERRO, 'ERRO_INTERNO'], [new TypeError('boom'), FAILURE.ERRO, 'ERRO_INTERNO']]) {
    const { w } = web({ [SITE]: erro });
    const r = await w.fetchPage(SITE);
    assert.deepEqual(r, { ok: false, falha }, erro.message);
    assert.ok(eventos(w).includes(evento), erro.message);
    assert.doesNotMatch(JSON.stringify([r, w.estatisticas()]), /segredo|interno\.example|ECONNRESET|boom|https:\/\/alfa-teste\.example\.test\/[a-z]/i);
  }
});

test('[ADP-12] LIMITE DE REQUISIÇÕES: o orçamento total (robots.txt incluído) é finito; estourado = ERRO com evento, e o transporte NÃO é mais chamado; cortesia por host respeita o intervalo com relógio injetável', async () => {
  const rotas = {};
  for (let i = 0; i < 5; i += 1) rotas[`https://alfa-teste.example.test/p${i}`] = html('<a href="/x">x</a>');
  const { w, t } = web(rotas, { maxRequests: 3, minIntervalMs: 0 });
  assert.equal((await w.fetchPage('https://alfa-teste.example.test/p0')).ok, true); // robots + página = 2
  assert.equal((await w.fetchPage('https://alfa-teste.example.test/p1')).ok, true); // 3
  assert.deepEqual(await w.fetchPage('https://alfa-teste.example.test/p2'), { ok: false, falha: FAILURE.ERRO });
  assert.deepEqual(await w.fetchPage('https://alfa-teste.example.test/p3'), { ok: false, falha: FAILURE.ERRO });
  assert.equal(t.chamadas.length, 3, 'nenhuma requisição além do orçamento');
  assert.ok(eventos(w).includes('LIMITE_DE_REQUISICOES'));
  assert.equal(w.estatisticas().requisicoes, 3);
  // cortesia: 1 s entre requisições ao mesmo host, medido pelo relógio injetado (o sleep é do teste)
  const c = web(rotas, { minIntervalMs: 1000 });
  await c.w.fetchPage('https://alfa-teste.example.test/p0');
  await c.w.fetchPage('https://alfa-teste.example.test/p1');
  assert.deepEqual(c.dormiu, [1000, 1000], 'robots -> página -> página: cada uma espera o intervalo');
  const passou = web(rotas, { minIntervalMs: 1000 });
  await passou.w.fetchPage('https://alfa-teste.example.test/p0');
  passou.avancar(5000);
  await passou.w.fetchPage('https://alfa-teste.example.test/p1');
  assert.deepEqual(passou.dormiu, [1000], 'se já passou o intervalo, não espera');
  const outros = web({ 'https://a.example.test/': html('<a href="/x">x</a>'), 'https://b.example.test/': html('<a href="/x">x</a>') }, { minIntervalMs: 1000 });
  await outros.w.fetchPage('https://a.example.test/');
  await outros.w.fetchPage('https://b.example.test/');
  assert.deepEqual(outros.dormiu, [1000, 1000], 'cada host espera só pela SUA última requisição (robots -> página); hosts diferentes não esperam um pelo outro');
});

test('[ADP-13] FONTE CORRETA de ponta a ponta: adapter real (transporte fake) -> Researcher -> rawFinding V2; a fonte de cada evidência é a URL efetivamente lida, https, com o tipo certo, e o achado é válido no V2', async () => {
  const t = transporteFake({
    'https://nominatim.openstreetmap.org/search?q=Clinica+Alfa+Teste&format=jsonv2&limit=6&addressdetails=1&extratags=1&accept-language=pt-BR': resp(200, JSON.stringify([{ osm_type: 'node', osm_id: 42, name: 'Clínica Alfa Teste', address: { city: 'Petrópolis', state: 'Rio de Janeiro' }, extratags: { website: SITE, 'contact:instagram': 'alfa_teste' } }]), { 'content-type': 'application/json; charset=utf-8' }),
    [SITE]: html(PAGINA_COM_LINKS),
  });
  const ports = createResearchPorts({ transport: t, userAgent: UA, minIntervalMs: 0 });
  const researcher = createResearcher(ports, { now: () => AGORA });
  const saida = await researcher.research({ nicho: 'Clinica Alfa Teste', quantidadeDesejada: 2 });
  assert.equal(saida.ok, true, JSON.stringify(saida.relatorio));
  assert.equal(saida.achados.length, 1);
  const achado = saida.achados[0];
  assert.equal(validateRawFindingsV2(saida.achados, { now: AGORA }).ok, true);
  const evid = (campo) => achado.campos[campo].map((e) => [e.valor, e.tipoFonte, e.url]);
  assert.deepEqual(evid('site'), [[SITE, 'OFICIAL', SITE]], 'a página lida é a fonte do site');
  assert.deepEqual(evid('instagram').sort(), [['https://www.instagram.com/alfa_teste', 'OFICIAL', SITE], ['https://www.instagram.com/alfa_teste', 'SECUNDARIA', 'https://www.openstreetmap.org/node/42']].sort(), 'o link do site é OFICIAL; o do OSM é SECUNDARIA com a página do objeto como fonte');
  assert.deepEqual(evid('whatsapp'), [['5524987651000', 'OFICIAL', SITE]]);
  assert.equal(achado.cidade, 'Petrópolis');
  for (const e of Object.values(achado.campos).flat()) assert.match(e.url, /^https:\/\//);
  for (const url of achado.fontes) assert.match(url, /^https:\/\//);
  // o que o adaptador buscou: só https, só o que a política permitiu (o perfil do Instagram fica bloqueado pelo robots/ausente aqui: 404 = sem robots -> permitido no fake)
  for (const c of t.chamadas) assert.match(c.url, /^https:\/\//);
  assert.ok(fato(achado, 'site.ctaWhatsapp') && fato(achado, 'site.formularioContato') && fato(achado, 'site.ctaAgendamento'));
});
const fato = (achado, campo) => (achado.dossie ? achado.dossie.fatos : []).find((f) => f.campo === campo);

test('[ADP-14] DATA: quem carimba a data da pesquisa é o RELÓGIO INJETADO do Researcher; o adaptador não devolve data nenhuma e o relógio dele (outra data) não vaza para o achado', async () => {
  const t = transporteFake({ [SITE]: html(PAGINA_COM_LINKS) });
  const ports = createResearchPorts({ transport: t, userAgent: UA, now: () => new Date('2001-01-01T00:00:00Z'), sleep: async () => {}, minIntervalMs: 0 });
  const pagina = await ports.fetchPage(SITE);
  assert.deepEqual(Object.keys(pagina).sort(), ['links', 'ok', 'temFormularioContato', 'urlFinal']);
  const busca = { ok: true, resultados: [{ nome: 'Clínica Alfa Teste', url: SITE, tipoResultado: 'SITE', fonteUrl: 'https://busca.example.test/r' }] };
  const saida = await createResearcher({ search: async () => busca, fetchPage: ports.fetchPage }, { now: () => AGORA }).research({ nicho: 'Psicologia', quantidadeDesejada: 1 });
  const datas = new Set();
  for (const e of Object.values(saida.achados[0].campos).flat()) datas.add(e.dataConsulta);
  for (const f of saida.achados[0].dossie.fatos) { datas.add(f.observadoEm); if (f.fonte) datas.add(f.fonte.observadoEm); }
  datas.add(saida.achados[0].dataDaPesquisa);
  assert.deepEqual([...datas], ['2026-09-26'], 'todas as datas vêm do relógio do Researcher; nenhuma do adaptador');
});

test('[ADP-15] SEM CREDENCIAIS: exatamente 4 cabeçalhos; nunca Cookie/Authorization/Referer/Proxy; Set-Cookie da resposta não é guardado nem reenviado; não existe opção de credencial (opção desconhecida é recusada)', async () => {
  const { w, t } = web({ [SITE]: html('<a href="/x">x</a>', { 'set-cookie': 'sessao=segredo; HttpOnly' }), 'https://alfa-teste.example.test/x': html('<a href="/y">y</a>') });
  await w.fetchPage(SITE);
  await w.fetchPage('https://alfa-teste.example.test/x');
  for (const c of t.chamadas) {
    assert.deepEqual(Object.keys(c.headers).sort(), ['accept', 'accept-encoding', 'accept-language', 'user-agent']);
    assert.equal(c.headers['user-agent'], UA);
    assert.equal(c.headers['accept-encoding'], 'identity');
    assert.doesNotMatch(JSON.stringify(c), /cookie|authorization|bearer|proxy|referer|segredo|sessao/i);
  }
  for (const opcao of ['cookie', 'cookies', 'headers', 'authorization', 'auth', 'token', 'password', 'credentials', 'proxy', 'agent', 'rejectUnauthorized', 'respectRobots', 'robots', 'retries', 'session']) {
    assert.throws(() => createPublicWeb({ transport: t, userAgent: UA, [opcao]: 'x' }), /opção desconhecida/, opcao);
    assert.throws(() => createResearchPorts({ transport: t, userAgent: UA, [opcao]: 'x' }), /opção desconhecida/, opcao);
  }
  for (const ua of [undefined, '', 'curto', 'x'.repeat(201), 'com\nquebra de linha valida', 'acentuação inválida ç']) assert.throws(() => createPublicWeb({ transport: t, userAgent: ua }), /userAgent/, String(ua));
  assert.throws(() => createPublicWeb({ userAgent: UA }), /transport/);
});

test('[ADP-16] SEM BYPASS: nenhuma nova tentativa em nenhuma falha (uma requisição por URL); o user-agent é o declarado; robots e TLS não têm chave de desligamento; nada no código de rede desliga validação, muda identidade ou usa proxy', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const { w, t } = web({ [SITE]: resp(status, 'x') });
    await w.fetchPage(SITE);
    await w.fetchPage(SITE);
    assert.equal(paginas(t).length, 2, `${status}: exatamente uma tentativa por chamada`);
  }
  const captcha = web({ [SITE]: html('<title>Just a moment...</title>') });
  await captcha.w.fetchPage(SITE);
  assert.equal(paginas(captcha.t).length, 1);
  const raiz = path.join(__dirname, '..', '..', 'src', 'research-adapters');
  for (const nome of fs.readdirSync(raiz)) {
    const codigo = fs.readFileSync(path.join(raiz, nome), 'utf8').replace(/\/\/.*$/gm, '');
    for (const proibido of [/rejectUnauthorized/i, /NODE_TLS_REJECT_UNAUTHORIZED/, /\bproxy\b|HTTP_PROXY|HTTPS_PROXY|ProxyAgent/i, /process\.env/, /\bcookie\b|set-cookie/i, /authorization|bearer|basic\s+auth/i, /puppeteer|playwright|selenium|webdriver|headless/i, /\bfetch\(|XMLHttpRequest|WebSocket/, /\beval\(|new Function|vm\./, /child_process/, /node:fs|writeFile|appendFile/, /2captcha|anticaptcha|solveCaptcha/i]) assert.doesNotMatch(codigo, proibido, `${nome}: ${proibido}`);
  }
});

test('[ADP-17] eventos: só códigos estáveis e o host (nunca URL completa, cabeçalho ou corpo); no máximo maxEvents; estatísticas devolvem cópia', async () => {
  const { w } = web({ [SITE]: resp(403, 'x') }, { maxEvents: 2 });
  for (let i = 0; i < 5; i += 1) await w.fetchPage(SITE);
  const s = w.estatisticas();
  assert.equal(s.eventos.length, 2);
  for (const e of s.eventos) assert.match(JSON.stringify(e), /^\{"codigo":"[A-Z_0-9]+"(,"host":"[a-z0-9.-]+")?\}$/);
  assert.equal(s.falhas.BLOQUEADO, 5);
  s.eventos.length = 0;
  s.falhas.BLOQUEADO = 0;
  assert.equal(w.estatisticas().eventos.length, 2);
  assert.equal(w.estatisticas().falhas.BLOQUEADO, 5);
});

test('[ADP-18] lacunas da mutação: o robots.txt vale também para a QUERY da URL; redirecionamento para login no último salto permitido continua LOGIN; links além do limite geram o evento LINKS_TRUNCADOS', async () => {
  const robots = resp(200, 'User-agent: *\nDisallow: /*?segredo=', { 'content-type': 'text/plain' });
  const q = web({ 'https://alfa-teste.example.test/robots.txt': robots, 'https://alfa-teste.example.test/p': html('<a href="/x">x</a>'), 'https://alfa-teste.example.test/p?segredo=1': html('<a href="/x">x</a>') });
  assert.equal((await q.w.fetchPage('https://alfa-teste.example.test/p')).ok, true);
  assert.deepEqual(await q.w.fetchPage('https://alfa-teste.example.test/p?segredo=1'), { ok: false, falha: FAILURE.ROBOTS });
  assert.equal(paginas(q.t).includes('https://alfa-teste.example.test/p?segredo=1'), false);
  const semSaltos = web({ [SITE]: resp(302, '', { location: '/login' }) }, { maxRedirects: 0 });
  assert.deepEqual(await semSaltos.w.fetchPage(SITE), { ok: false, falha: FAILURE.LOGIN });
  assert.ok(eventos(semSaltos.w).includes('REDIRECT_TO_LOGIN'));
  const muitos = Array.from({ length: 700 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('');
  const l = web({ [SITE]: html(muitos) });
  const r = await l.w.fetchPage(SITE);
  assert.equal(r.links.length, 600);
  assert.ok(eventos(l.w).includes('LINKS_TRUNCADOS'), 'o corte de links é REPORTADO');
});
