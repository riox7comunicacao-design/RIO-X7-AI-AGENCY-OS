// `texto` do htmlExtract (Implementação 1): o texto público da página, limitado, sem HTML bruto e sem conteúdo inerte. Funções puras, sem rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractPage, MAX_PAGE_TEXT } = require('../../src/research-adapters/htmlExtract');

const BASE = 'https://alfa.example.test/';

test('[TXT-1] o texto traz título, meta description, h1, h2, corpo e rodapé; os campos antigos (links, formulário, sinais) continuam', () => {
  const p = extractPage('<html><head><title>Clínica Alfa &amp; Cia</title><meta name="description" content="Estética em Petrópolis"><meta property="og:description" content="OG descrição"></head><body><h1>Alfa</h1><h2>Serviços</h2><p>Rua A, 10</p><a href="/agendar">Agende</a><form><textarea></textarea></form><footer>© Alfa · Petrópolis</footer></body></html>', BASE);
  for (const trecho of ['Clínica Alfa & Cia', 'Estética em Petrópolis', 'OG descrição', 'Alfa', 'Serviços', 'Rua A, 10', '© Alfa · Petrópolis']) assert.ok(p.texto.includes(trecho), trecho);
  assert.deepEqual(p.links, [{ href: 'https://alfa.example.test/agendar', texto: 'Agende' }]);
  assert.equal(p.temFormularioContato, true);
  assert.deepEqual(Object.keys(p).sort(), ['desafioForte', 'identidade', 'links', 'linksTruncados', 'marcadorCaptcha', 'temFormularioContato', 'temSenha', 'texto', 'totalLinks']);
});

test('[TXT-2] NÃO entram: script, style, noscript, template, comentários, svg, iframe, controles, bidi, atributos e HTML bruto', () => {
  const p = extractPage('<html><head><style>.x{color:red}</style><script>var segredo="S1"</script></head><body><noscript>NS</noscript><template>TP</template><!-- comentário --><svg><text>SVGTXT</text></svg><iframe>IFR</iframe><p class="classe-oculta" onclick="x()">Visível ‮ com\u0000controle</p><select><option>OPC</option></select></body></html>', BASE);
  assert.match(p.texto, /Visível com controle/);
  assert.doesNotMatch(p.texto, /S1|segredo|color:red|NS|TP|comentário|SVGTXT|IFR|OPC|classe-oculta|onclick|<|>|‮|\u0000/);
});

test('[TXT-3] é LIMITADO: corpo gigante vira no máximo MAX_PAGE_TEXT, e o rodapé continua presente (vem antes do corpo)', () => {
  const p = extractPage(`<html><body>${'<p>palavra qualquer de enchimento</p>'.repeat(50000)}<footer>Rodapé Petrópolis RJ</footer></body></html>`, BASE);
  assert.ok(p.texto.length <= MAX_PAGE_TEXT);
  assert.ok(p.texto.includes('Rodapé Petrópolis RJ'));
});

test('[TXT-4] entradas degeneradas e hostis nunca lançam e sempre devolvem `texto` (string)', () => {
  for (const html of ['', '<', '<title>sem fechar', '<footer>sem fechar', '<h1>'.repeat(100000), '<body'.repeat(100000), '<meta name="description" content="'.repeat(50000), '<svg'.repeat(100000), 'só texto, sem tags']) {
    const p = extractPage(html, BASE);
    assert.equal(typeof p.texto, 'string');
    assert.ok(p.texto.length <= MAX_PAGE_TEXT);
  }
  assert.equal(extractPage('só texto, sem tags', BASE).texto, 'só texto, sem tags');
});

test('[TXT-5] `identidade` é o título + o H1 (onde a empresa se apresenta), curta e sem HTML; vazia quando não há nenhum dos dois', () => {
  const p = extractPage('<html><head><title>Espaço Facial | Clínica &amp; Estética</title></head><body><h1>Bem-vindo ao <b>Espaço Facial</b></h1><h2>Outro</h2><p>corpo</p></body></html>', BASE);
  assert.equal(p.identidade, 'Espaço Facial | Clínica & Estética\nBem-vindo ao Espaço Facial');
  assert.equal(extractPage('<p>só corpo</p>', BASE).identidade, '');
  assert.ok(extractPage(`<title>${'t'.repeat(5000)}</title><h1>${'h'.repeat(5000)}</h1>`, BASE).identidade.length <= 1000);
});
