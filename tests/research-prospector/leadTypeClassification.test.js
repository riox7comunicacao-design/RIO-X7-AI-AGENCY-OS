// Classificação do TIPO DE LEAD (src/research-prospector/leadTypeClassification.js) — Implementação 3.0, Prospecção
// Comercial. Prova os quatro casos do briefing (empresa, profissional, unidade/franquia, ambíguo) e que a classificação
// nunca vem só de um palpite sobre o nome: usa nome, título/H1 e texto institucional já lidos, e nunca inventa nada.

const test = require('node:test');
const assert = require('node:assert/strict');

const { LEAD_TYPE, classifyLeadType } = require('../../src/research-prospector/leadTypeClassification');

test('[LEADTYPE-1] "Clínica XYZ" -> EMPRESA (termo empresarial no próprio nome)', () => {
  const resultado = classifyLeadType({ nome: 'Clínica XYZ' });
  assert.equal(resultado.tipo, LEAD_TYPE.EMPRESA);
  assert.equal(resultado.regra, 'NOME_EMPRESARIAL');
});

test('[LEADTYPE-2] "Dra. Maria Silva" -> PROFISSIONAL (título + nome de pessoa); "Dr. João Souza" e "João Souza Dermatologista" também', () => {
  assert.equal(classifyLeadType({ nome: 'Dra. Maria Silva' }).tipo, LEAD_TYPE.PROFISSIONAL);
  assert.equal(classifyLeadType({ nome: 'Dr. João Souza' }).tipo, LEAD_TYPE.PROFISSIONAL);
  assert.equal(classifyLeadType({ nome: 'João Souza Dermatologista' }).tipo, LEAD_TYPE.PROFISSIONAL);
});

test('[LEADTYPE-3] "Royal Face Petrópolis" -> UNIDADE_FRANQUIA só com indicação EXPLÍCITA (texto institucional "unidade da rede"); nunca pelo nome sozinho', () => {
  const semEvidencia = classifyLeadType({ nome: 'Royal Face Petrópolis' });
  assert.equal(semEvidencia.tipo, LEAD_TYPE.NAO_VERIFICADO, 'o nome sozinho não prova franquia/unidade');

  const comEvidencia = classifyLeadType({
    nome: 'Royal Face Petrópolis',
    texto: 'Royal Face Petrópolis é uma unidade da rede Royal Face, presente em diversas cidades.',
  });
  assert.equal(comEvidencia.tipo, LEAD_TYPE.UNIDADE_FRANQUIA);
  assert.equal(comEvidencia.regra, 'INDICACAO_FRANQUIA_TEXTO');

  assert.equal(classifyLeadType({ nome: 'Clínica XYZ - Unidade Petrópolis' }).tipo, LEAD_TYPE.UNIDADE_FRANQUIA, 'marcador de unidade no próprio nome também basta');
});

test('[LEADTYPE-4] caso ambíguo -> NAO_VERIFICADO: sem nenhum sinal claro, e quando os sinais se contradizem (termo empresarial + título de pessoa)', () => {
  assert.equal(classifyLeadType({ nome: 'Vida Plena' }).tipo, LEAD_TYPE.NAO_VERIFICADO, 'sem evidência suficiente');
  assert.equal(classifyLeadType({ nome: '' }).tipo, LEAD_TYPE.NAO_VERIFICADO);
  assert.equal(classifyLeadType({}).tipo, LEAD_TYPE.NAO_VERIFICADO);
  assert.equal(classifyLeadType(null).tipo, LEAD_TYPE.NAO_VERIFICADO);

  const conflito = classifyLeadType({ nome: 'Dra. Estética Avançada' });
  assert.equal(conflito.tipo, LEAD_TYPE.NAO_VERIFICADO, 'termo empresarial e título de pessoa ao mesmo tempo: nunca um palpite');
  assert.equal(conflito.regra, 'CONFLITO_NOME_AMBIGUO');
});

test('[LEADTYPE-5] PROFISSIONAL não é score nem rejeição: é só uma identificação de tipo, nunca um estado de aprovação', () => {
  const resultado = classifyLeadType({ nome: 'Dra. Maria Silva' });
  assert.equal(Object.keys(resultado).sort().join(','), 'regra,tipo', 'a saída não traz score, nota, ranking nem temperatura');
  assert.equal(typeof resultado.tipo, 'string');
});

test('[LEADTYPE-6] o título/H1 da página oficial também corrobora EMPRESA quando o nome por si só não tem termo empresarial', () => {
  const resultado = classifyLeadType({ nome: 'Grupo Alfa', identidade: 'Grupo Alfa | Clínica de Estética em Petrópolis' });
  assert.equal(resultado.tipo, LEAD_TYPE.EMPRESA);
  assert.equal(resultado.regra, 'TEXTO_INSTITUCIONAL_EMPRESARIAL');
});
