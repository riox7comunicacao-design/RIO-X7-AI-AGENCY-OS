// Segurança dos arquivos estáticos e do Dashboard: path traversal (24), nenhum script externo/CDN (25) e dados
// dinâmicos nunca viram HTML (26). Sem framework de testes de frontend — só o handler estático (Node puro) e uma
// varredura ESTÁTICA de dashboard/ (mesmo tokenizer de tests/helpers/staticImports.js, já usado desde a Fase F).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStaticHandler } = require('../../src/server/static');
const { analyzeSource, listSourceFiles, toPosix } = require('../helpers/staticImports');
const { DASHBOARD_ROOT } = require('./testEnv');

const DASHBOARD_FILES = listSourceFiles(DASHBOARD_ROOT).filter((file) => file.endsWith('.mjs'));

// ===========================================================================
// [24] Path traversal
// ===========================================================================
test('[SRV-SEC-24a] o handler estático nunca serve nada fora de root, em nenhuma codificação de "..", em nenhuma rota', async () => {
  const handler = createStaticHandler({ root: DASHBOARD_ROOT });
  const tentativas = [
    '/../package.json',
    '/../../package.json',
    '/..%2f..%2fpackage.json',
    '/%2e%2e/%2e%2e/package.json',
    '/%2e%2e%2f%2e%2e%2fpackage.json',
    '/views/../../package.json',
    '/..\\..\\package.json',
    '/./../package.json',
    '//../package.json',
    '/%2e%2e/etc/passwd',
    '/index.html/../../../../etc/passwd',
  ];
  for (const alvo of tentativas) {
    const response = await handler.serve(alvo);
    assert.equal(response.status, 404, alvo);
    assert.ok(!response.body.includes('rio-x7-ai-agency-os'), `${alvo}: não pode devolver o conteúdo do package.json`);
  }
});

test('[SRV-SEC-24b] symlink escapando de root também não é servido (realpath é conferido, não só o caminho textual)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('criar symlink no Windows exige privilégio elevado neste ambiente');
    return;
  }
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fora-do-root-'));
  const outsideFile = path.join(outsideDir, 'segredo.js');
  fs.writeFileSync(outsideFile, 'module.exports = "nao deveria ser servido";\n');
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'com-link-'));
  t.after(() => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(linkDir, { recursive: true, force: true });
  });
  fs.symlinkSync(outsideFile, path.join(linkDir, 'link.js'));
  const handler = createStaticHandler({ root: linkDir });
  const response = await handler.serve('/link.js');
  assert.equal(response.status, 404);
});

// A confirmação do REALPATH (não só o caminho textual) é o que pega um symlink — e symlink exige privilégio
// elevado neste Windows de desenvolvimento (24b fica pulado aqui). Para provar a MESMA checagem sem depender do
// SO, forjamos fs.promises.realpath para devolver, só para o arquivo-alvo, um caminho que sai de root — exatamente
// o que um symlink malicioso faria. O arquivo (dentro de root) e o alvo forjado (fora) existem de verdade.
test('[SRV-SEC-24e] a checagem de realpath É o que barra o escape: com um realpath forjado apontando para fora de root, o arquivo continua recusado mesmo sendo alcançável pelo caminho textual', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-root-'));
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'static-fora-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fora, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'arquivo.mjs'), 'export const dentro = true;\n');
  fs.writeFileSync(path.join(fora, 'arquivo.mjs'), 'export const fora_de_root = true;\n');
  // A CHAVE de comparação é o caminho LEXICAL (path.join, sem resolver symlink/8.3) — o mesmo que static.js monta
  // como `target` e passa para fs.promises.realpath(target). Comparar contra um valor JÁ resolvido por realpath
  // (que pode normalizar de um jeito que o TEMP do SO não bate byte a byte) faria o mock nunca disparar.
  const alvoEsperado = path.resolve(path.join(root, 'arquivo.mjs'));
  const foraReal = await fs.promises.realpath(path.join(fora, 'arquivo.mjs'));
  t.mock.method(fs.promises, 'realpath', async (alvo) => (path.resolve(String(alvo)) === alvoEsperado ? foraReal : fs.realpathSync(alvo)));

  const handler = createStaticHandler({ root });
  const response = await handler.serve('/arquivo.mjs');
  assert.equal(response.status, 404, 'o realpath forjado (fora de root) precisa ser recusado, mesmo o caminho textual sendo válido');
});

test('[SRV-SEC-24c] arquivos legítimos, em subpastas, continuam servidos normalmente (a defesa não é ampla demais)', async () => {
  const handler = createStaticHandler({ root: DASHBOARD_ROOT });
  const raiz = await handler.serve('/index.html');
  assert.equal(raiz.status, 200);
  const raiz2 = await handler.serve('/');
  assert.equal(raiz2.status, 200);
  assert.equal(raiz2.body.toString('utf8'), raiz.body.toString('utf8'));
  const aninhado = await handler.serve('/views/approvals.mjs');
  assert.equal(aninhado.status, 200);
  assert.match(aninhado.headers['Content-Type'], /javascript/);
});

test('[SRV-SEC-24d] extensão desconhecida, arquivo oculto/reservado e diretório sem barra final -> 404, nunca conteúdo bruto (nenhum desses existe em dashboard/ — ver 24f para a mesma defesa contra um arquivo que REALMENTE existe)', async () => {
  const handler = createStaticHandler({ root: DASHBOARD_ROOT });
  for (const alvo of ['/styles.css.bak', '/.env', '/.git/config', '/views', '/CON', '/nul', '/package.json']) {
    const response = await handler.serve(alvo);
    assert.equal(response.status, 404, alvo);
  }
});

// 24d prova que um arquivo AUSENTE nunca "vaza" (404 por não existir). Isto aqui prova a defesa em si: cada um
// destes arquivos EXISTE de verdade dentro de root — se a checagem correspondente (ponto inicial, charset, nome
// reservado do Windows) fosse removida, o arquivo seria servido com sucesso. Só assim um mutante que remova a
// checagem muda o resultado observável.
function makeStaticFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.writeFileSync(path.join(dir, 'normal.mjs'), 'export const ok = true;\n');
  fs.writeFileSync(path.join(dir, '.hidden.mjs'), 'export const segredo = true;\n');
  fs.writeFileSync(path.join(dir, 'dados.txt'), 'extensao fora da lista permitida\n');
  fs.writeFileSync(path.join(dir, 'CON.mjs'), 'export const reservado = true;\n');
  fs.writeFileSync(path.join(dir, 'nested', 'arquivo com espaco.mjs'), 'export const x = 1;\n');
  return dir;
}

test('[SRV-SEC-24f] arquivo OCULTO (.hidden.mjs), extensão fora da lista (dados.txt), nome reservado do Windows (CON.mjs) e segmento com espaço — todos EXISTEM de verdade e ainda assim são recusados', async (t) => {
  const dir = makeStaticFixture(t);
  const handler = createStaticHandler({ root: dir });
  for (const alvo of ['/.hidden.mjs', '/dados.txt', '/CON.mjs', '/nested/arquivo%20com%20espaco.mjs']) {
    const response = await handler.serve(alvo);
    assert.equal(response.status, 404, alvo);
  }
  // controle: o mesmo diretório serve normalmente um arquivo comum — a defesa não bloqueia tudo.
  const ok = await handler.serve('/normal.mjs');
  assert.equal(ok.status, 200);
});

// ===========================================================================
// [25] Nenhum script externo / CDN
// ===========================================================================
test('[SRV-SEC-25] dashboard/index.html só carrega scripts do PRÓPRIO servidor (nenhum CDN, nenhuma origem externa)', () => {
  const html = fs.readFileSync(path.join(DASHBOARD_ROOT, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1]);
  assert.ok(srcs.length >= 2, 'o dashboard deveria carregar pelo menos o bundle do supabase e o app');
  for (const src of srcs) {
    assert.ok(src.startsWith('/'), `script externo detectado: ${src}`);
    assert.doesNotMatch(src, /^\/\//, `protocolo-relativo (ainda externo): ${src}`);
  }
  assert.doesNotMatch(html, /<link\b[^>]*\bhref=["']https?:\/\//i, 'nenhuma folha de estilo externa');
  assert.doesNotMatch(html, /\bcrossorigin\b/i, 'sem crossorigin (não deveria haver recurso de outra origem)');
});

test('[SRV-SEC-25b] nenhum arquivo de dashboard/ referencia um CDN ou uma origem http(s) para carregar código', () => {
  for (const file of DASHBOARD_FILES) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /https?:\/\/(cdn\.|unpkg\.|jsdelivr\.)/i, toPosix(path.relative(DASHBOARD_ROOT, file)));
  }
});

// ===========================================================================
// [26] Dados dinâmicos nunca viram HTML
// ===========================================================================
const FORBIDDEN_HTML_SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'write', 'writeln', 'eval', 'Function', 'execCommand', 'DOMParser'];

test('[SRV-SEC-26a] nenhum arquivo de dashboard/ usa um sink de HTML dinâmico, eval ou o construtor Function', () => {
  for (const file of DASHBOARD_FILES) {
    const rel = toPosix(path.relative(DASHBOARD_ROOT, file));
    const analysis = analyzeSource(fs.readFileSync(file, 'utf8'), rel);
    const identifiers = new Set(analysis.tokens.filter((token) => token.type === 'id').map((token) => token.value));
    for (const proibido of FORBIDDEN_HTML_SINKS) {
      assert.equal(identifiers.has(proibido), false, `${rel}: não pode usar ${proibido}`);
    }
  }
});

test('[SRV-SEC-26b] index.html não tem nenhum atributo de evento inline nem javascript: em nenhum link/atributo', () => {
  const html = fs.readFileSync(path.join(DASHBOARD_ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'nenhum onClick="..."/onerror="..." inline');
  assert.doesNotMatch(html, /javascript:/i);
});

// dom.mjs é o ÚNICO ponto por onde texto dinâmico entra no DOM (ver o próprio cabeçalho do arquivo). Um "document"
// mínimo, fiel o bastante ao subconjunto do DOM que h() usa, prova que um valor perigoso (`<img onerror=...>`)
// sempre vira TEXTO, nunca marcação — sem precisar de jsdom (nenhuma dependência nova).
function fakeDocument() {
  function createElement(tag) {
    return {
      tagName: tag,
      textContent: '',
      className: '',
      attributes: {},
      listeners: {},
      children: [],
      disabled: false,
      hidden: false,
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      addEventListener(type, handler) {
        this.listeners[type] = handler;
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
    };
  }
  return { createElement };
}

test('[SRV-SEC-26c] dom.mjs: h() sempre grava `text` como textContent — mesmo um valor com marcação nunca vira estrutura de elementos', async () => {
  const { h } = await import('../../dashboard/dom.mjs');
  const document = fakeDocument();
  const perigoso = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const elemento = h(document, 'span', { text: perigoso, className: 'ok' });
  assert.equal(elemento.textContent, perigoso, 'o valor chega inteiro, mas como TEXTO');
  assert.deepEqual(elemento.children, [], 'nenhum elemento filho foi criado a partir do texto perigoso');
  assert.equal(elemento.className, 'ok');
});

test('[SRV-SEC-26d] dom.mjs: h() recusa style/srcdoc e exige função em manipuladores on*', async () => {
  const { h } = await import('../../dashboard/dom.mjs');
  const document = fakeDocument();
  assert.throws(() => h(document, 'div', { style: 'x' }), /style/);
  assert.throws(() => h(document, 'iframe', { srcdoc: '<b>x</b>' }), /srcdoc/);
  assert.throws(() => h(document, 'button', { onclick: 'alert(1)' }), /onclick/);
  const ok = h(document, 'button', { onclick: () => {} });
  assert.equal(typeof ok.listeners.click, 'function');
});

test('[SRV-SEC-26e] dom.mjs: atributos comuns usam setAttribute (nunca concatenação em HTML) e ignoram valores ausentes', async () => {
  const { h } = await import('../../dashboard/dom.mjs');
  const document = fakeDocument();
  const link = h(document, 'a', { href: 'https://exemplo.example.test/<script>', rel: 'noopener noreferrer', target: '_blank', hidden: false, disabled: undefined });
  assert.equal(link.attributes.href, 'https://exemplo.example.test/<script>');
  assert.equal(link.attributes.rel, 'noopener noreferrer');
  assert.equal('disabled' in link.attributes, false);
});

// ===========================================================================
// Funções puras (api.mjs / views/approvals.mjs) — sem DOM nenhum
// ===========================================================================
test('[SRV-PURE-1] api.mjs: renova a sessão UMA vez em 401 e repete a chamada UMA vez; sem sessão nenhuma nunca tenta a rede', async () => {
  const { createApiClient, ApiError } = await import('../../dashboard/api.mjs');
  let chamadasFetch = 0;
  let renovacoes = 0;
  let sessaoPerdida = 0;
  const client = createApiClient({
    getAccessToken: async () => 'token-velho',
    refreshAccessToken: async () => {
      renovacoes += 1;
      return 'token-novo';
    },
    onSessionLost: () => {
      sessaoPerdida += 1;
    },
    fetchImpl: async (urlPath, init) => {
      chamadasFetch += 1;
      const token = init.headers.Authorization;
      if (token === 'Bearer token-velho') return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'x' } }), { status: 401 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  const resultado = await client.me();
  assert.deepEqual(resultado, { ok: true });
  assert.equal(chamadasFetch, 2, 'uma tentativa com o token velho, uma com o renovado');
  assert.equal(renovacoes, 1);
  assert.equal(sessaoPerdida, 0);
});

test('[SRV-PURE-2] api.mjs: se a renovação falhar (ou a segunda tentativa também for 401), avisa onSessionLost UMA vez — sem laço', async () => {
  const { createApiClient } = await import('../../dashboard/api.mjs');
  let chamadasFetch = 0;
  let sessaoPerdida = 0;
  const client = createApiClient({
    getAccessToken: async () => 'token-velho',
    refreshAccessToken: async () => null,
    onSessionLost: () => {
      sessaoPerdida += 1;
    },
    fetchImpl: async () => {
      chamadasFetch += 1;
      return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'x' } }), { status: 401 });
    },
  });
  await assert.rejects(() => client.listApprovals(), /UNAUTHENTICATED|./);
  assert.equal(chamadasFetch, 1, 'sem sessão renovada, nem tenta de novo');
  assert.equal(sessaoPerdida, 1);
});

test('[SRV-PURE-3] api.mjs: 403 nunca tenta renovar a sessão', async () => {
  const { createApiClient } = await import('../../dashboard/api.mjs');
  let renovacoes = 0;
  const client = createApiClient({
    getAccessToken: async () => 'token',
    refreshAccessToken: async () => {
      renovacoes += 1;
      return 'token';
    },
    onSessionLost: () => {},
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'sem acesso' } }), { status: 403 }),
  });
  await assert.rejects(() => client.listApprovals(), (erro) => erro.status === 403);
  assert.equal(renovacoes, 0);
});

test('[SRV-PURE-4] api.mjs: approve/reject enviam SÓ { reason } — nunca userId, role, permissions ou reviewedBy', async () => {
  const { createApiClient } = await import('../../dashboard/api.mjs');
  const corpos = [];
  const client = createApiClient({
    getAccessToken: async () => 'token',
    refreshAccessToken: async () => null,
    onSessionLost: () => {},
    fetchImpl: async (urlPath, init) => {
      corpos.push(init.body ? JSON.parse(init.body) : null);
      return new Response(JSON.stringify({ item: {} }), { status: 200 });
    },
  });
  await client.approve('id:alfa', 'Bom fit');
  await client.reject('id:beta', 'Fora do ICP');
  assert.deepEqual(corpos, [{ reason: 'Bom fit' }, { reason: 'Fora do ICP' }]);
});

test('[SRV-PURE-5] views/approvals.mjs: safeHttpUrl só aceita http(s), nunca javascript:/data:/file:, e nunca URL com usuário/senha embutidos', async () => {
  const { safeHttpUrl } = await import('../../dashboard/views/approvals.mjs');
  assert.equal(safeHttpUrl('https://exemplo.example.test/pagina'), 'https://exemplo.example.test/pagina');
  assert.equal(safeHttpUrl('exemplo.example.test', { assumeHttps: true }), 'https://exemplo.example.test/');
  for (const perigoso of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'vbscript:msgbox(1)', 'https://usuario:senha@exemplo.test', '  ', '', null, undefined, 42]) {
    assert.equal(safeHttpUrl(perigoso), null, String(perigoso));
  }
});

test('[SRV-PURE-6] views/approvals.mjs: textOf nunca devolve algo além de texto simples (objetos e listas viram vazio, nunca "[object Object]" solto em um atributo)', async () => {
  const { textOf } = await import('../../dashboard/views/approvals.mjs');
  assert.equal(textOf('  Empresa Exemplo  '), 'Empresa Exemplo');
  assert.equal(textOf(42), '42');
  assert.equal(textOf(null), '');
  assert.equal(textOf(undefined), '');
  assert.equal(textOf({ a: 1 }), '');
  assert.equal(textOf(['x']), '');
});

test('[SRV-PURE-7] views/approvals.mjs: labelForEstado, identityText, dataText, duplicityText e dncText nunca lançam para entrada inesperada', async () => {
  const view = await import('../../dashboard/views/approvals.mjs');
  for (const estranho of [undefined, null, 42, {}, [], 'ALGO_NOVO']) {
    assert.doesNotThrow(() => view.labelForEstado(estranho));
    assert.doesNotThrow(() => view.identityText(estranho));
    assert.doesNotThrow(() => view.dataText(estranho));
    assert.doesNotThrow(() => view.duplicityText(estranho, estranho));
    assert.doesNotThrow(() => view.dncText(estranho));
  }
});

test('[SRV-PURE-8] views/approvals.mjs: messageForError nunca repete a mensagem crua do servidor, exceto para 400 (dados inválidos, já pensada para o usuário)', async () => {
  const { messageForError, ApiError } = await import('../../dashboard/views/approvals.mjs').then(async (mod) => ({ ...mod, ApiError: (await import('../../dashboard/api.mjs')).ApiError }));
  assert.equal(messageForError(new ApiError(401, 'UNAUTHENTICATED', 'sessão expirada')), null);
  assert.match(messageForError(new ApiError(403, 'FORBIDDEN', 'x')), /não possui acesso/);
  assert.match(messageForError(new ApiError(404, 'NOT_FOUND', 'x')), /não foi encontrado/);
  assert.match(messageForError(new ApiError(409, 'ALREADY_DECIDED', 'x')), /já foi decidido/);
  assert.match(messageForError(new ApiError(500, 'INTERNAL', 'detalhe interno que não deveria aparecer')), /Não foi possível concluir/);
  assert.doesNotMatch(messageForError(new ApiError(500, 'INTERNAL', 'detalhe interno que não deveria aparecer')), /detalhe interno/);
});

test('[SRV-PURE-9] views/approvals.mjs: describeSources nunca gera uma URL insegura, mesmo quando o dado de origem tenta', async () => {
  const { describeSources } = await import('../../dashboard/views/approvals.mjs');
  const fontes = [
    { fonte: 'Site oficial', url: 'https://exemplo.example.test', campo: 'site' },
    { fonte: 'Maliciosa', url: 'javascript:alert(1)', campo: 'site' },
    'https://outra.example.test',
    { fonte: 'Sem URL', campo: 'telefone' },
  ];
  const descritas = describeSources(fontes);
  assert.equal(descritas.length, 4);
  assert.equal(descritas[0].url, 'https://exemplo.example.test/');
  assert.equal(descritas[1].url, null, 'uma URL javascript: nunca vira link');
  assert.equal(descritas[2].url, 'https://outra.example.test/');
  assert.equal(descritas[3].url, null);
});
