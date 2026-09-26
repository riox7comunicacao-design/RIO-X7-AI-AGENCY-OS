// M1 — independência de evidências por ORIGEM (decisão H1 = host). Só exercita a API pública já exportada (identifyAndConfirm).
// Origem: host normalizado da URL https (minúsculas, sem "www.", sem porta); sem URL, a `fonte` normalizada.
const test = require('node:test');
const assert = require('node:assert/strict');
const { identifyAndConfirm } = require('../../src/research-prospector/discovery');
const { INFO_STATUS } = require('../../src/research-prospector/constants');

const TEL = '24999990000';
const ev = (over = {}) => ({ valor: TEL, fonte: 'Busca pública', tipoFonte: 'SECUNDARIA', ...over });
const telefone = (evidencias) => identifyAndConfirm({ empresa: 'X', campos: { telefone: evidencias } }).camposConfirmados.telefone;

test('[ORI-A] uma evidência SECUNDARIA => HIPOTESE', () => {
  const r = telefone([ev({ url: 'https://a.example.test/p' })]);
  assert.equal(r.status, INFO_STATUS.HIPOTESE);
  assert.equal(r.valor, TEL);
  assert.equal(r.conflito, false);
});

test('[ORI-B] duas SECUNDARIA, mesmo valor, mesmo host, URLs diferentes => HIPOTESE (uma origem)', () => {
  const r = telefone([ev({ url: 'https://empresa.example.test/' }), ev({ url: 'https://empresa.example.test/contato' })]);
  assert.equal(r.status, INFO_STATUS.HIPOTESE);
  assert.equal(r.evidencias.length, 2, 'as evidências continuam todas registradas; só a contagem de origens muda');
});

test('[ORI-C] duas SECUNDARIA, mesmo valor, hosts diferentes => VALIDADO (duas origens)', () => {
  const r = telefone([ev({ url: 'https://empresa.example.test/' }), ev({ url: 'https://outra-fonte.example.test/' })]);
  assert.equal(r.status, INFO_STATUS.VALIDADO);
  assert.equal(r.valor, TEL);
  assert.equal(r.conflito, false);
});

test('[ORI-D] a mesma evidência duplicada => HIPOTESE', () => {
  const e = ev({ url: 'https://empresa.example.test/p' });
  assert.equal(telefone([e, { ...e }]).status, INFO_STATUS.HIPOTESE);
  assert.equal(telefone([ev(), ev()]).status, INFO_STATUS.HIPOTESE, 'duplicata sem URL: mesma fonte = uma origem');
});

test('[ORI-E] mesma URL com fontes (nomes) diferentes => HIPOTESE', () => {
  const r = telefone([ev({ fonte: 'Fonte A', url: 'https://empresa.example.test/p' }), ev({ fonte: 'Fonte B', url: 'https://empresa.example.test/p' })]);
  assert.equal(r.status, INFO_STATUS.HIPOTESE);
});

test('[ORI-F] OFICIAL única permanece VALIDADO (regra do OFICIAL inalterada)', () => {
  assert.equal(telefone([ev({ tipoFonte: 'OFICIAL', url: 'https://empresa.example.test/' })]).status, INFO_STATUS.VALIDADO);
  assert.equal(telefone([ev({ tipoFonte: 'OFICIAL' })]).status, INFO_STATUS.VALIDADO, 'sem URL também');
});

test('[ORI-G] duas evidências divergentes permanecem HIPOTESE com conflito', () => {
  const r = telefone([ev({ url: 'https://a.example.test/' }), ev({ valor: '24911112222', url: 'https://b.example.test/' })]);
  assert.equal(r.status, INFO_STATUS.HIPOTESE);
  assert.equal(r.conflito, true);
  assert.equal(r.valor, null);
});

test('[ORI-H] sem URL + com URL: a origem sem URL é a `fonte` normalizada e é DISTINTA de qualquer host (duas origens => VALIDADO)', () => {
  assert.equal(telefone([ev({ fonte: 'Google Maps' }), ev({ url: 'https://empresa.example.test/' })]).status, INFO_STATUS.VALIDADO);
  // o espaço dos nomes de fonte não colide com o de hosts: uma fonte chamada como um host NÃO é o mesmo que a URL desse host
  assert.equal(telefone([ev({ fonte: 'empresa.example.test' }), ev({ url: 'https://empresa.example.test/' })]).status, INFO_STATUS.VALIDADO);
  // duas sem URL: comparadas pela fonte normalizada (acento, caixa e espaços não criam origem nova)
  assert.equal(telefone([ev({ fonte: 'Google  Maps' }), ev({ fonte: 'google maps' })]).status, INFO_STATUS.HIPOTESE);
  assert.equal(telefone([ev({ fonte: 'Guia Médico' }), ev({ fonte: 'guia medico' })]).status, INFO_STATUS.HIPOTESE);
  assert.equal(telefone([ev({ fonte: 'Google Maps' }), ev({ fonte: 'Guia Telefônico' })]).status, INFO_STATUS.VALIDADO);
  // URL que não é https válida cai para a fonte
  assert.equal(telefone([ev({ fonte: 'A', url: 'http://x.example.test/' }), ev({ fonte: 'A', url: 'não é url' })]).status, INFO_STATUS.HIPOTESE);
});

test('[ORI-I] caminho, barra final, caixa do hostname, query e fragmento não criam origem nova (mesmo host)', () => {
  const urls = ['https://Empresa.Example.test', 'https://empresa.example.test/', 'https://EMPRESA.example.test/contato/', 'https://empresa.example.test/a?b=1#c'];
  for (let i = 1; i < urls.length; i += 1) {
    assert.equal(telefone([ev({ url: urls[0] }), ev({ url: urls[i] })]).status, INFO_STATUS.HIPOTESE, `${urls[0]} x ${urls[i]}`);
  }
});

test('[ORI-J] a porta NÃO faz parte da origem: o hostname é a unidade (escolha conservadora: menos origens)', () => {
  assert.equal(telefone([ev({ url: 'https://empresa.example.test/' }), ev({ url: 'https://empresa.example.test:8443/x' })]).status, INFO_STATUS.HIPOTESE);
});

test('[ORI-L] "www." inicial não cria origem nova (a mesma definição de host de researchPolicy.bareHost); subdomínios diferentes SÃO hosts diferentes', () => {
  assert.equal(telefone([ev({ url: 'https://www.empresa.example.test/' }), ev({ url: 'https://empresa.example.test/' })]).status, INFO_STATUS.HIPOTESE);
  assert.equal(telefone([ev({ url: 'https://blog.empresa.example.test/' }), ev({ url: 'https://empresa.example.test/' })]).status, INFO_STATUS.VALIDADO);
});

test('[ORI-M] mesmo valor por 3 evidências: 2 do mesmo host + 1 de outro => VALIDADO; e a saída de valor/evidências não muda', () => {
  const r = telefone([ev({ url: 'https://a.example.test/1' }), ev({ url: 'https://a.example.test/2' }), ev({ url: 'https://b.example.test/' })]);
  assert.equal(r.status, INFO_STATUS.VALIDADO);
  assert.equal(r.evidencias.length, 3);
});
