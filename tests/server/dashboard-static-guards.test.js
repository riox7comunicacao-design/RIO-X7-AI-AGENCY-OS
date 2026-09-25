// Guardas ESTÁTICAS do Dashboard, para o que o CRM-DASHBOARD acrescentou (varredura por tokens, o mesmo analisador de
// tests/helpers/staticImports.js usado pelas fronteiras de arquitetura — comentários e textos nunca contam como código).
//
// tests/server/static-security.test.js já barra, em TODO arquivo .mjs de dashboard/ (inclusive os novos): sinks de HTML
// dinâmico, eval/Function e CDN em index.html. Estes testes travam o resto do que o pedido exige:
//   - o navegador conversa com o servidor SÓ pelo cliente de API (api.mjs) — nenhuma tela usa fetch, XHR, WebSocket...;
//   - nada é guardado no navegador pelo Dashboard (localStorage, cookies...) e nada vai para o console;
//   - nenhum segredo (service_role, chave, JWT) e nenhum authUserId no código do navegador;
//   - nenhuma origem externa, nenhum CDN, nenhum script além do bundle local do Supabase e do app;
//   - o CSS é responsivo e não carrega nada de fora; o JS nunca usa estilo inline (o CSP os barra);
//   - todo módulo importado existe, é servido pelo servidor estático e fica dentro de dashboard/ — e nenhum módulo é órfão.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createStaticHandler } = require('../../src/server/static');
const { analyzeSource, listSourceFiles, walkTokenArrays, toPosix } = require('../helpers/staticImports');
const { DASHBOARD_ROOT } = require('./testEnv');

const FILES = listSourceFiles(DASHBOARD_ROOT).filter((file) => file.endsWith('.mjs'));
const rel = (file) => toPosix(path.relative(DASHBOARD_ROOT, file));
const read = (file) => fs.readFileSync(file, 'utf8');

// Todos os identificadores de um arquivo (inclusive os de dentro de ${...} de um template) e todos os textos literais.
function scan(file) {
  const analysis = analyzeSource(read(file), rel(file));
  const identifiers = new Set();
  walkTokenArrays(analysis.tokens, (tokens) => {
    for (const token of tokens) if (token.type === 'id') identifiers.add(token.value);
  });
  return { analysis, identifiers, strings: analysis.strings.map((entry) => entry.value) };
}

const SCANS = new Map(FILES.map((file) => [rel(file), scan(file)]));

test('[DASH-GUARD-1] a lista de módulos do Dashboard é a esperada (um módulo novo exige decidir aqui — de propósito)', () => {
  assert.deepEqual([...SCANS.keys()].sort(), ['api.mjs', 'app.mjs', 'crm-model.mjs', 'dom.mjs', 'format.mjs', 'main.mjs', 'router.mjs', 'views/agents.mjs', 'views/approvals.mjs', 'views/crm.mjs', 'views/overview.mjs']);
  for (const [nome, { analysis }] of SCANS) assert.deepEqual(analysis.issues, [], `${nome}: carregamento que a análise não enxerga`);
});

test('[DASH-GUARD-2] o Dashboard conversa com o servidor SÓ pelo cliente de API: fetch aparece apenas em api.mjs e app.mjs, e nenhum arquivo usa XMLHttpRequest, WebSocket, EventSource, sendBeacon ou importScripts', () => {
  const rede = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts'];
  const permitidos = new Map([['fetch', ['api.mjs', 'app.mjs']]]);
  for (const [nome, { identifiers }] of SCANS) {
    for (const proibido of rede) {
      if (identifiers.has(proibido)) assert.ok((permitidos.get(proibido) || []).includes(nome), `${nome} não pode usar ${proibido}: a rede é do cliente de API`);
    }
  }
  for (const nome of ['views/crm.mjs', 'views/overview.mjs', 'views/approvals.mjs', 'main.mjs', 'crm-model.mjs']) {
    assert.equal(SCANS.get(nome).identifiers.has('fetch'), false, `${nome} não usa fetch`);
  }
  // As telas e o painel recebem o cliente de API (ou o fetch) por parâmetro — nunca importam api.mjs para chamá-lo às escondidas.
  for (const nome of ['views/crm.mjs', 'views/overview.mjs']) {
    assert.deepEqual(SCANS.get(nome).analysis.refs.filter((ref) => /api\.mjs$/.test(ref.specifier)), [], `${nome} recebe a api por parâmetro`);
  }
});

test('[DASH-GUARD-3] nada é guardado no navegador pelo Dashboard e nada vai para o console: nenhum localStorage, sessionStorage, indexedDB, cookie, console, caches, alert ou prompt', () => {
  const proibidos = ['localStorage', 'sessionStorage', 'indexedDB', 'cookie', 'console', 'caches', 'alert', 'prompt', 'BroadcastChannel'];
  for (const [nome, { identifiers }] of SCANS) {
    for (const proibido of proibidos) assert.equal(identifiers.has(proibido), false, `${nome} não pode usar ${proibido}`);
  }
});

test('[DASH-GUARD-4] nenhum segredo no código do navegador: nada de service_role, chaves, JWT, variáveis do Supabase, e o authUserId nunca é lido nem mostrado', () => {
  const identificadoresProibidos = ['authUserId', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'service_role', 'serviceRole'];
  for (const [nome, { identifiers, strings }] of SCANS) {
    for (const proibido of identificadoresProibidos) assert.equal(identifiers.has(proibido), false, `${nome}: identificador ${proibido}`);
    for (const texto of strings) {
      assert.doesNotMatch(texto, /service[_-]?role/i, `${nome}: texto com service_role`);
      assert.doesNotMatch(texto, /sb_(secret|publishable)_/i, `${nome}: chave do Supabase`);
      assert.doesNotMatch(texto, /eyJ[A-Za-z0-9_-]{10,}/, `${nome}: parece um JWT`);
      assert.doesNotMatch(texto, /^[A-Za-z0-9_\-+/=]{40,}$/, `${nome}: texto longo demais parece uma chave`);
    }
  }
  const html = read(path.join(DASHBOARD_ROOT, 'index.html'));
  assert.doesNotMatch(html, /service[_-]?role|eyJ[A-Za-z0-9_-]{10,}|sb_secret_|apikey/i);
});

test('[DASH-GUARD-5] nenhuma origem externa no código: nenhum texto http(s):// (a única exceção é o prefixo "https://" que safeHttpUrl acrescenta a um domínio sem esquema) e nenhum CDN', () => {
  for (const [nome, { strings }] of SCANS) {
    for (const texto of strings) {
      if (/^https?:\/\//i.test(texto)) assert.ok(nome === 'format.mjs' && texto === 'https://', `${nome}: origem externa "${texto}"`);
      assert.doesNotMatch(texto, /(cdn\.|unpkg\.|jsdelivr\.|googleapis\.|gstatic\.|cloudflare)/i, `${nome}: CDN "${texto}"`);
    }
  }
});

test('[DASH-GUARD-6] index.html carrega exatamente o bundle LOCAL do Supabase e o app (nenhum outro script), uma folha de estilo local e nenhum recurso de outra origem', () => {
  const html = read(path.join(DASHBOARD_ROOT, 'index.html'));
  assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1]), ['/lib/supabase.js', '/app.mjs']);
  assert.equal([...html.matchAll(/<script\b(?![^>]*\bsrc=)/gi)].length, 0, 'nenhum script inline');
  assert.deepEqual([...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/gi)].map((match) => match[1]), ['/styles.css']);
  assert.doesNotMatch(html, /(src|href)=["'](https?:)?\/\//i, 'nenhuma origem externa');
  assert.doesNotMatch(html, /<(iframe|object|embed|form)\b/i);
});

test('[DASH-GUARD-7] o CSS é responsivo (telas menores) e não carrega nada de fora: sem @import, sem url(), sem fontes externas, sem expression()', () => {
  const css = read(path.join(DASHBOARD_ROOT, 'styles.css'));
  assert.match(css, /@media \(max-width: \d+px\)/, 'há regras para telas menores');
  assert.ok((css.match(/@media/g) || []).length >= 2, 'mais de um ponto de quebra (notebook e tela menor)');
  assert.doesNotMatch(css, /@import/i);
  assert.doesNotMatch(css, /url\(/i);
  assert.doesNotMatch(css, /expression\(/i);
  assert.doesNotMatch(css, /https?:\/\//i);
  assert.match(css, /table\.crm-table td::before/, 'a tabela do CRM vira cartões em telas menores');
});

test('[DASH-GUARD-8] compatível com o CSP (style-src \'self\'): o JS nunca usa estilo inline — nenhum acesso a .style, nenhum setAttribute("style") e nenhum atributo style em textos', () => {
  for (const [nome, { analysis }] of SCANS) {
    walkTokenArrays(analysis.tokens, (tokens) => {
      tokens.forEach((token, indice) => {
        if (token.type === 'id' && token.value === 'style') {
          const anterior = tokens[indice - 1];
          assert.ok(!(anterior && anterior.type === 'punct' && anterior.value === '.'), `${nome}: acesso a .style (linha ${token.line})`);
        }
        if (token.type === 'id' && token.value === 'setAttribute') {
          const argumento = tokens[indice + 2];
          assert.ok(!(argumento && argumento.type === 'str' && argumento.value.toLowerCase() === 'style'), `${nome}: setAttribute('style') (linha ${token.line})`);
        }
      });
    });
    for (const texto of analysis.strings.map((entry) => entry.value)) assert.doesNotMatch(texto, /\sstyle\s*=/i, `${nome}: atributo style em texto`);
  }
});

test('[DASH-GUARD-9] o grafo de módulos: tudo o que app.mjs importa existe, fica DENTRO de dashboard/, é servido pelo servidor estático (200, JavaScript) — e nenhum módulo do Dashboard é órfão', async () => {
  const handler = createStaticHandler({ root: DASHBOARD_ROOT });
  const alcancados = new Set();
  const pilha = ['app.mjs'];
  while (pilha.length > 0) {
    const atual = pilha.pop();
    if (alcancados.has(atual)) continue;
    alcancados.add(atual);
    const { analysis } = SCANS.get(atual);
    for (const ref of analysis.refs) {
      assert.match(ref.specifier, /^\.\.?\//, `${atual}: só importa módulos relativos (achou "${ref.specifier}")`);
      const alvo = toPosix(path.normalize(path.join(path.dirname(atual), ref.specifier)));
      assert.ok(!alvo.startsWith('..') && !path.isAbsolute(alvo), `${atual}: "${ref.specifier}" sai de dashboard/`);
      assert.ok(SCANS.has(alvo), `${atual}: importa ${alvo}, que não existe em dashboard/`);
      pilha.push(alvo);
    }
  }
  for (const modulo of alcancados) {
    const resposta = await handler.serve(`/${modulo}`);
    assert.equal(resposta.status, 200, `${modulo} precisa ser servido`);
    assert.match(resposta.headers['Content-Type'], /javascript/);
  }
  assert.deepEqual([...alcancados].sort(), [...SCANS.keys()].sort(), 'todo módulo de dashboard/ é usado por alguém a partir de app.mjs');
});
