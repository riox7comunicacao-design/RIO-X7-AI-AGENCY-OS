// Tradução achado bruto -> fatos do dossiê (src/research-prospector/dossierFromFinding.js) — decisão 0019.
// Função pura: só o que o achado JÁ traz; nada inventado (url, data ou fonte); ausência de evidência não gera fato.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { factsFromFinding, FIELD_TO_FACT } = require('../../src/research-prospector/dossierFromFinding');
const { buildDossier } = require('../../src/research-prospector/dossier');
const { analyzeSource, toPosix } = require('../helpers/staticImports');

const HOJE = '2026-09-25';
const ev = (valor, extras = {}) => ({ valor, fonte: 'Fonte de teste', tipoFonte: 'OFICIAL', url: 'https://fonte.example.test/p', dataConsulta: '2026-09-24', ...extras });
const achado = (campos, extras = {}) => ({ empresa: 'Clínica Teste', campos, ...extras });
const fatos = (campos, extras) => factsFromFinding(achado(campos, extras), HOJE);

test('[DFF-1] o mapeamento é fechado: 6 campos de link -> <campo>.url e whatsapp -> whatsapp.publico; telefone, e-mail e endereço não geram fato', () => {
  assert.deepEqual(FIELD_TO_FACT, { site: 'site.url', instagram: 'instagram.url', facebook: 'facebook.url', linkedin: 'linkedin.url', youtube: 'youtube.url', googlePerfil: 'googlePerfil.url', whatsapp: 'whatsapp.publico' });
  assert.equal(Object.isFrozen(FIELD_TO_FACT), true);
  assert.deepEqual(fatos({ telefone: [ev('(24) 98765-1000')], email: [ev('a@example.test')], endereco: [ev('Rua Teste, 1')] }), []);
  assert.deepEqual(fatos({}), []);
  assert.deepEqual(factsFromFinding({ empresa: 'X' }, HOJE), [], 'sem campos');
  assert.deepEqual(factsFromFinding(null, HOJE), []);
  assert.deepEqual(fatos({ site: [] }), [], 'campo sem evidência: sem fato (ausência não é negativa)');
});

test('[DFF-2] evidência com valor https, url da fonte e dataConsulta vira um fato DADO com a fonte { url, tipo, observadoEm, nome } do próprio achado', () => {
  const [f] = fatos({ site: [ev('https://clinica.example.test', { tipoFonte: 'SECUNDARIA' })] });
  assert.deepEqual(f, { campo: 'site.url', valor: 'https://clinica.example.test', status: 'DADO', observadoEm: '2026-09-24', fonte: { url: 'https://fonte.example.test/p', tipo: 'SECUNDARIA', observadoEm: '2026-09-24', nome: 'Fonte de teste' } });
});

test('[DFF-3] domínio sem esquema ganha só o https://; @usuario, telefone e texto solto NÃO viram URL (o fato fica NAO_VERIFICADO de valor nulo)', () => {
  assert.equal(fatos({ site: [ev('clinica.example.test')] })[0].valor, 'https://clinica.example.test');
  assert.equal(fatos({ facebook: [ev('facebook.example.test/clinica')] })[0].valor, 'https://facebook.example.test/clinica');
  for (const valor of ['@clinica_teste', '(24) 98765-1000', 'clinica', 'http://clinica.example.test', 'ftp://a.example.test', 'javascript:alert(1)', 'com espaço.example.test', '']) {
    const [f] = fatos({ instagram: [ev(valor)] });
    assert.deepEqual([f.status, f.valor, f.fonte], ['NAO_VERIFICADO', null, undefined], JSON.stringify(valor));
  }
});

test('[DFF-4] sem url da fonte ou sem dataConsulta o fato é NAO_VERIFICADO (nunca uma url ou data inventada); a data cai para dataConsulta, dataDaPesquisa do achado ou a de reserva', () => {
  const [semUrl] = fatos({ site: [ev('https://a.example.test', { url: undefined })] });
  assert.deepEqual([semUrl.status, semUrl.valor, semUrl.observadoEm], ['NAO_VERIFICADO', null, '2026-09-24']);
  const [semData] = fatos({ site: [ev('https://a.example.test', { dataConsulta: undefined })] });
  assert.equal(semData.observadoEm, HOJE);
  const [comPesquisa] = fatos({ site: [ev('https://a.example.test', { dataConsulta: undefined })] }, { dataDaPesquisa: '2026-09-20' });
  assert.equal(comPesquisa.observadoEm, '2026-09-20');
  assert.equal(fatos({ site: [{ valor: 'https://a.example.test', fonte: 'F', tipoFonte: 'OFICIAL' }] }).length, 1);
});

test('[DFF-5] whatsapp: fato whatsapp.publico com valor true (só DADO com fonte e data); sem elas, NAO_VERIFICADO', () => {
  const [f] = fatos({ whatsapp: [ev('(24) 98765-1000')] });
  assert.deepEqual([f.campo, f.valor, f.status], ['whatsapp.publico', true, 'DADO']);
  assert.deepEqual([fatos({ whatsapp: [ev('(24) 98765-1000', { url: undefined })] })[0].status], ['NAO_VERIFICADO']);
});

test('[DFF-6] UM fato por evidência, na ordem, sem cortar nem descartar nada em silêncio (o excesso é recusado antes, pelo esquema; se chegasse aqui, o dossiê recusaria)', () => {
  const muitas = Array.from({ length: 8 }, (_, i) => ev(`https://a${i}.example.test`));
  assert.equal(fatos({ site: muitas }).length, 8, 'nenhum corte');
  const misto = fatos({ site: [ev('@x'), ev('https://ok.example.test')] });
  assert.deepEqual(misto.map((f) => [f.status, f.valor]), [['NAO_VERIFICADO', null], ['DADO', 'https://ok.example.test']]);
  const nenhuma = fatos({ site: [ev('@x'), ev('@y'), ev('@z')] });
  assert.deepEqual(nenhuma.map((f) => f.status), ['NAO_VERIFICADO', 'NAO_VERIFICADO', 'NAO_VERIFICADO']);
  const r = buildDossier({ prospectId: 'id:x', fatos: fatos({ site: muitas }) }, { now: new Date('2026-09-25T15:00:00Z') });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.code), ['FATOS_DO_CAMPO_EXCESSIVOS', 'FATOS_DO_CAMPO_EXCESSIVOS', 'FATOS_DO_CAMPO_EXCESSIVOS']);
});

test('[DFF-7] campo herdado do protótipo ou achado hostil não quebra nem polui; e o resultado é aceito por buildDossier (que revalida tudo), gerando sinais', () => {
  assert.deepEqual(factsFromFinding({ campos: Object.create({ site: [ev('https://a.example.test')] }) }, HOJE), []);
  assert.deepEqual(factsFromFinding({ campos: { __proto__: null, site: 'texto' } }, HOJE), []);
  const lista = fatos({ site: [ev('https://a.example.test')], instagram: [ev('https://instagram.example.test/a')], whatsapp: [ev('24 90000-0000')], facebook: [ev('@x')] });
  const r = buildDossier({ prospectId: 'id:x', loteId: 'lote:00000000-0000-4000-8000-000000000001', fatos: lista }, { now: new Date('2026-09-25T15:00:00Z') });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value.sinais.map((s) => [s.tipo, s.status]).sort(), [['FACEBOOK_EXISTENTE', 'NAO_VERIFICADO'], ['INSTAGRAM_EXISTENTE', 'DADO'], ['SITE_EXISTENTE', 'DADO'], ['WHATSAPP_PUBLICO', 'DADO']]);
});

test('[DFF-8] arquitetura: o módulo não importa nada; é puro (sem CRM, disco, rede, relógio ou ambiente); nenhum módulo do dossiê importa o serviço', () => {
  const raiz = path.join(__dirname, '..', '..');
  const arquivo = path.join(raiz, 'src', 'research-prospector', 'dossierFromFinding.js');
  const codigo = fs.readFileSync(arquivo, 'utf8');
  const analise = analyzeSource(codigo, toPosix(path.relative(raiz, arquivo)));
  assert.deepEqual(analise.issues, []);
  assert.deepEqual(analise.refs.map((r) => r.specifier), []);
  const semComentarios = codigo.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(semComentarios, /node:|fetch\(|process\.|new Date|Date\.now|Math\.random|crypto/);
  for (const nome of ['dossier.js', 'signalSchema.js', 'dossierRepository.js', 'dossierFromFinding.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(raiz, 'src', 'research-prospector', nome), 'utf8'), /require\('(\.\.\/services|\.\.\/server|\.\.\/auth|\.\.\/crm)/, nome);
  }
});

test('[DFF-9] a data de um fato NAO_VERIFICADO: a dataConsulta vale mais do que a dataDaPesquisa do achado, que vale mais do que a de reserva', () => {
  const [f] = fatos({ site: [ev('@x', { dataConsulta: '2026-09-23' })] }, { dataDaPesquisa: '2026-09-20' });
  assert.equal(f.observadoEm, '2026-09-23');
});
