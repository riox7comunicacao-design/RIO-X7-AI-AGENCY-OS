// Adaptador CRM -> checagens do Prospector (src/research-prospector/crmAdapter.js) com clientes PESSOA FÍSICA (CRM 5.0, Fase D2): o nome completo da PF vira uma visão de identidade (um bloqueio por nome não
// pode ser contornado só porque o nome está no campo da pessoa, e não no da empresa); candidatos e registros antigos ficam exatamente como eram. Módulo puro: nada de rede nem arquivo; dados fictícios.

const test = require('node:test');
const assert = require('node:assert/strict');

const { identityViews, toProspectorRecords } = require('../../src/research-prospector/crmAdapter');
const { checkDoNotContact } = require('../../src/research-prospector/doNotContact');
const { checkDuplicate } = require('../../src/research-prospector/duplicateCheck');

test('[CRMADP-PERSON-1] registro ANTIGO e candidato: as visões são EXATAMENTE as de sempre (uma por número, ou uma só), com a empresa; nada muda para quem não tem nome completo', () => {
  const antigo = { empresa: 'Estúdio Dias', site: 'dias.example.test', cidade: 'Niterói', telefone: '24 90000-1111', whatsapp: '24 90000-2222' };
  assert.deepEqual(identityViews(antigo).map((v) => [v.empresa, v.telefone, v.whatsapp]), [['Estúdio Dias', '24 90000-1111', null], ['Estúdio Dias', '24 90000-2222', null]]);
  assert.deepEqual(identityViews({ empresa: 'Só Nome' }), [{ empresa: 'Só Nome', site: null, instagram: null, cidade: null, telefone: null, whatsapp: null }]);
  assert.deepEqual(identityViews({}), [{ empresa: null, site: null, instagram: null, cidade: null, telefone: null, whatsapp: null }]);
  // as chaves novas ausentes ou nulas (registro gravado antes da Fase D2, ou ainda sem tipo) não mudam nada
  assert.deepEqual(identityViews({ empresa: 'X', nomeCompleto: null, tipoPessoa: null }), identityViews({ empresa: 'X' }));
});

test('[CRMADP-PERSON-2] uma PESSOA FÍSICA tem uma visão por NOME (empresa e nome completo) e por NÚMERO; sem empresa, o nome completo é o nome; textos vazios e não-textos são ignorados', () => {
  const pf = { tipoPessoa: 'PF', empresa: null, nomeCompleto: 'Maria Souza', cidade: 'Niterói', telefone: '24 90000-1111' };
  assert.deepEqual(identityViews(pf).map((v) => [v.empresa, v.telefone]), [['Maria Souza', '24 90000-1111']]);
  const comEmpresa = { empresa: 'Estúdio Maria', nomeCompleto: 'Maria Souza', cidade: 'Niterói', telefone: '24 90000-1111', whatsapp: '24 90000-2222' };
  assert.deepEqual(identityViews(comEmpresa).map((v) => [v.empresa, v.telefone]), [
    ['Estúdio Maria', '24 90000-1111'],
    ['Estúdio Maria', '24 90000-2222'],
    ['Maria Souza', '24 90000-1111'],
    ['Maria Souza', '24 90000-2222'],
  ]);
  assert.deepEqual(identityViews({ empresa: 'Mesmo', nomeCompleto: 'Mesmo' }).length, 1, 'o mesmo nome nos dois campos é uma visão só');
  assert.deepEqual(identityViews({ empresa: '  ', nomeCompleto: 42 }), identityViews({}), 'vazio e não-texto são "ausente"');
  // nada além dos campos de identidade chega às checagens (nem o documento)
  for (const visao of identityViews({ ...pf, cpf: '52998224725', observacoes: 'privado' })) assert.deepEqual(Object.keys(visao).sort(), ['cidade', 'empresa', 'instagram', 'site', 'telefone', 'whatsapp']);
});

test('[CRMADP-PERSON-3] a prospecção respeita o BLOQUEIO de uma PF: um candidato com o mesmo nome (e cidade) de uma pessoa em Não Contatar é barrado, mesmo sem empresa no registro; o ativo só avisa duplicidade', () => {
  const crm = [
    { id: 'crm:pf-dnc', status: 'DO_NOT_CONTACT', tipoPessoa: 'PF', empresa: null, nomeCompleto: 'Maria Souza', cidade: 'Niterói' },
    { id: 'crm:pf-ativa', status: 'PROSPECT', tipoPessoa: 'PF', empresa: null, nomeCompleto: 'João Pereira', cidade: 'Petrópolis' },
  ];
  const registros = toProspectorRecords(crm);
  const candidato = (empresa, cidade) => ({ empresa, cidade, site: null, instagram: null, telefone: null, whatsapp: null });
  let barrado = false;
  for (const visao of identityViews(candidato('Maria Souza', 'Niterói'))) {
    const r = checkDoNotContact(visao, registros);
    if (r.doNotContact) barrado = r.matchedRecord.crmRecordId === 'crm:pf-dnc';
  }
  assert.equal(barrado, true, 'o nome completo da PF bloqueada impede a prospecção do mesmo nome e cidade');
  for (const visao of identityViews(candidato('Maria Souza', 'Rio de Janeiro'))) assert.equal(checkDoNotContact(visao, registros).doNotContact, false, 'outra cidade não casa');
  const ativa = identityViews(candidato('João Pereira', 'Petrópolis')).map((visao) => checkDuplicate(visao, registros));
  assert.ok(ativa.some((r) => r.status === 'POSSIVEL_DUPLICADO'), 'a PF ativa é só um aviso de possível duplicidade (nome + cidade)');
});
