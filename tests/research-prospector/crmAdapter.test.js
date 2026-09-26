// Adaptador CRM -> checagens do Prospector (src/research-prospector/crmAdapter.js).
//
// O que estes testes provam: um registro do CRM com status DO_NOT_CONTACT NUNCA passa pelo Prospector — nem quando a
// identidade coincide por site, telefone, WhatsApp, Instagram ou nome+cidade, nem quando o número está guardado no campo "errado"
// (de qualquer dos dois lados). Os registros são REAIS: criados e movidos pelo domínio do CRM (src/crm), sem doNotContact.
// Nenhum dado real: tudo fictício (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');

const crm = require('../../src/crm');
const { CRM_STATUS } = require('../../src/crm/constants');
const { checkDoNotContact } = require('../../src/research-prospector/doNotContact');
const { createCandidate } = require('../../src/research-prospector/candidate');
const { runDiscoveryPipeline, OPERATIONAL_STATE, DNC_STATUS, SOURCE_TYPE, runDncCheck, runDuplicateCheck } = require('../../src/research-prospector/discovery');
const { CRM_DNC_STATUS, identityViews, toProspectorRecords, isDoNotContactRecord } = require('../../src/research-prospector/crmAdapter');

const OPERADOR = { actor: 'HUMAN', reviewedBy: { userId: 'user-teste', name: 'Teste', role: 'ADMIN' }, motivo: 'teste' };

// Registros REAIS do domínio do CRM (sem nenhum campo doNotContact). `dnc: true` os move para DO_NOT_CONTACT.
async function crmComRegistros(especificacoes) {
  const repository = crm.createInMemoryCrmRepository();
  for (const { campos, dnc } of especificacoes) {
    const { record } = await crm.createRecord(repository, campos, OPERADOR);
    if (dnc) await crm.markDoNotContact(repository, record.id, OPERADOR);
  }
  return await crm.listRecords(repository);
}

const evidencia = (valor, tipoFonte = SOURCE_TYPE.OFICIAL) => ({ valor, fonte: 'Fonte de teste', tipoFonte });
const briefing = { nicho: 'Psicologia', regiao: 'Petrópolis/RJ', quantidadeDesejada: 10, exclusoes: [] };

function descobrir(campos, crmRecords, extras = {}) {
  const finding = { empresa: 'Candidato Novo Teste', cidade: 'Niterói', estado: 'RJ', nicho: 'Psicologia', campos, fontes: [], ...extras };
  return runDiscoveryPipeline({ briefing, rawFindings: [finding], crmRecords }).resultados[0];
}

test('[CRM-ADAPT-1] o literal do status DO_NOT_CONTACT do adaptador é o do domínio do CRM (o domínio do prospector não importa src/crm, então o teste os compara)', () => {
  assert.equal(CRM_DNC_STATUS, CRM_STATUS.DO_NOT_CONTACT);
});

test('[CRM-ADAPT-2] o problema real: um registro do CRM em DO_NOT_CONTACT não tem `doNotContact`, e a checagem existente, sem tradução, o IGNORA — com o adaptador ele é reconhecido', async () => {
  const registros = await crmComRegistros([{ campos: { empresa: 'Bloqueada Teste', telefone: '24 90000-1111', cidade: 'Petrópolis' }, dnc: true }]);
  assert.equal(registros[0].status, 'DO_NOT_CONTACT');
  assert.equal('doNotContact' in registros[0], false, 'o CRM não grava o booleano');

  const candidato = createCandidate({ empresa: 'Outra Empresa', telefone: '24900001111' });
  assert.equal(checkDoNotContact(candidato, registros).doNotContact, false, 'sem tradução, o bloqueio passaria despercebido');
  assert.equal(checkDoNotContact(candidato, toProspectorRecords(registros)).doNotContact, true, 'com a tradução, é bloqueado');
});

test('[CRM-ADAPT-3] status DO_NOT_CONTACT bloqueia; PROSPECT e qualquer outro status não; sem status não; o booleano `doNotContact` já existente continua valendo (só o `true` estrito)', () => {
  const base = { empresa: 'Empresa Teste', telefone: '24 90000-2222' };
  assert.equal(toProspectorRecords([{ ...base, status: 'DO_NOT_CONTACT' }])[0].doNotContact, true);
  for (const status of ['PROSPECT', 'RESEARCH', 'CONTACTED', 'WON', 'LOST', 'do_not_contact', 'DO_NOT_CONTACT ', undefined, null, 42]) {
    assert.equal(toProspectorRecords([{ ...base, status }])[0].doNotContact, false, `status ${String(status)}`);
  }
  assert.equal(toProspectorRecords([base])[0].doNotContact, false, 'sem status');
  assert.equal(toProspectorRecords([{ ...base, doNotContact: true }])[0].doNotContact, true, 'o campo legado continua respeitado');
  for (const valor of ['true', 1, 'sim', {}, [], false, null]) {
    assert.equal(toProspectorRecords([{ ...base, doNotContact: valor }])[0].doNotContact, false, `doNotContact ${JSON.stringify(valor)} não é "true"`);
  }
  assert.equal(isDoNotContactRecord({ status: 'DO_NOT_CONTACT' }), true);
  assert.equal(isDoNotContactRecord({ status: 'PROSPECT' }), false);
});

test('[CRM-ADAPT-4] pelo discovery real, com registros CRUS do CRM: cada identidade (site, telefone, WhatsApp, Instagram, nome+cidade) de um DO_NOT_CONTACT leva o candidato a DNC', async () => {
  const registros = await crmComRegistros([
    {
      campos: { empresa: 'Bloqueada Um', site: 'bloqueada-um.example.test', telefone: '24 90000-3333', whatsapp: '24 90000-4444', instagram: '@bloqueada_um', cidade: 'Petrópolis' },
      dnc: true,
    },
  ]);
  const casos = {
    'site': { site: [evidencia('bloqueada-um.example.test')] },
    'telefone': { telefone: [evidencia('24900003333')] },
    'WhatsApp (guardado como whatsapp no CRM, achado como telefone)': { telefone: [evidencia('(24) 90000-4444')] },
    'WhatsApp (o mesmo número, achado como whatsapp)': { whatsapp: [evidencia('24900004444')] },
    'Instagram': { instagram: [evidencia('https://instagram.com/bloqueada_um')] },
  };
  for (const [nome, campos] of Object.entries(casos)) {
    const resultado = descobrir(campos, registros, { empresa: 'Nome Completamente Diferente' });
    assert.equal(resultado.statusDNC, DNC_STATUS.BLOQUEADO, nome);
    assert.equal(resultado.estadoOperacional, OPERATIONAL_STATE.DNC, nome);
  }
  const porNome = descobrir({ site: [evidencia('outro-dominio.example.test')] }, registros, { empresa: 'Bloqueada Um', cidade: 'Petrópolis' });
  assert.equal(porNome.statusDNC, DNC_STATUS.BLOQUEADO, 'nome + cidade também bloqueia (não se contorna o DNC trocando de canal)');
});

test('[CRM-ADAPT-5] o MESMO registro em PROSPECT nunca é tratado como DNC: vira DUPLICADO (identidade forte) ou POSSIVEL_DUPLICADO (só nome+cidade), e um registro só com o nome não casa com nada', async () => {
  const registros = await crmComRegistros([
    { campos: { empresa: 'Normal Um', telefone: '24 90000-5555', cidade: 'Petrópolis' } },
    { campos: { empresa: 'Só Nome Teste' } },
    { campos: { empresa: 'Nome e Cidade Teste', cidade: 'Teresópolis' } },
  ]);
  const porTelefone = descobrir({ telefone: [evidencia('24900005555')] }, registros, { empresa: 'Outro Nome' });
  assert.equal(porTelefone.statusDNC, DNC_STATUS.NAO_ENCONTRADO);
  assert.equal(porTelefone.estadoOperacional, OPERATIONAL_STATE.DUPLICADO);

  const porNomeCidade = descobrir({ site: [evidencia('novo-site.example.test')] }, registros, { empresa: 'Nome e Cidade Teste', cidade: 'Teresópolis' });
  assert.equal(porNomeCidade.statusDNC, DNC_STATUS.NAO_ENCONTRADO);
  assert.equal(porNomeCidade.estadoOperacional, OPERATIONAL_STATE.POSSIVEL_DUPLICADO);

  const semNada = descobrir({ site: [evidencia('totalmente-novo.example.test')] }, registros, { empresa: 'Empresa Sem Relação' });
  assert.equal(semNada.statusDNC, DNC_STATUS.NAO_ENCONTRADO);
  assert.equal(semNada.statusDuplicidade, 'NOVO');
});

test('[CRM-ADAPT-6] um número guardado no campo "errado" nunca escapa: registro com telefone A e WhatsApp B, e candidato com telefone C e WhatsApp B (os dois validados) — ainda é bloqueado', async () => {
  const registros = await crmComRegistros([{ campos: { empresa: 'Duas Linhas', telefone: '24 90000-6001', whatsapp: '24 90000-6002', cidade: 'Petrópolis' }, dnc: true }]);
  // o candidato tem dois números; só um deles é o do registro (o WhatsApp B do CRM)
  const resultado = descobrir({ telefone: [evidencia('24900007777')], whatsapp: [evidencia('24900006002')] }, registros, { empresa: 'Sem Relação Alguma' });
  assert.equal(resultado.statusDNC, DNC_STATUS.BLOQUEADO, 'o número do WhatsApp do candidato bate com o WhatsApp do CRM');

  // e o inverso: o número do candidato coincide com o TELEFONE do CRM, guardado no campo whatsapp do candidato
  const inverso = descobrir({ whatsapp: [evidencia('24900006001')] }, registros, { empresa: 'Sem Relação Alguma' });
  assert.equal(inverso.statusDNC, DNC_STATUS.BLOQUEADO);

  // sem coincidência nenhuma, não bloqueia
  const livre = descobrir({ telefone: [evidencia('24900008888')], whatsapp: [evidencia('24900009999')] }, registros, { empresa: 'Sem Relação Alguma' });
  assert.equal(livre.statusDNC, DNC_STATUS.NAO_ENCONTRADO);
});

test('[CRM-ADAPT-7] a duplicidade também vê o segundo número (a mesma correção): candidato com dois números, um deles é o WhatsApp de um registro comum, vira DUPLICADO', async () => {
  const registros = await crmComRegistros([{ campos: { empresa: 'Comum Duas Linhas', telefone: '24 90000-7001', whatsapp: '24 90000-7002', cidade: 'Petrópolis' } }]);
  const resultado = descobrir({ telefone: [evidencia('24900008001')], whatsapp: [evidencia('24900007002')] }, registros, { empresa: 'Sem Relação' });
  assert.equal(resultado.statusDuplicidade, 'DUPLICADO');
  assert.deepEqual(resultado.matchedOn, ['telefone']);
  assert.equal(resultado.statusDNC, DNC_STATUS.NAO_ENCONTRADO);
});

test('[CRM-ADAPT-8] as visões de identidade: uma por número distinto (ou uma só sem número); só os campos de identidade; valores que não são texto viram ausência', () => {
  assert.equal(identityViews({ empresa: 'A', telefone: '1', whatsapp: '2' }).length, 2);
  assert.equal(identityViews({ empresa: 'A', telefone: '24 90000-0000', whatsapp: '24 90000-0000' }).length, 1, 'o mesmo número nos dois campos é uma visão só');
  assert.deepEqual(identityViews({ empresa: 'A' }), [{ empresa: 'A', site: null, instagram: null, cidade: null, telefone: null, whatsapp: null }]);
  const [visao] = identityViews({ empresa: 'A', site: 42, instagram: {}, cidade: ['x'], telefone: 5511, whatsapp: '   ', contato: 'Fulano', status: 'PROSPECT' });
  assert.deepEqual(visao, { empresa: 'A', site: null, instagram: null, cidade: null, telefone: null, whatsapp: null }, 'nada além da identidade, e nada que não seja texto');
});

test('[CRM-ADAPT-9] falha fechada: entrada que o adaptador não sabe interpretar LANÇA (ignorar um registro poderia esconder um DO NOT CONTACT) — inclusive pelo discovery', () => {
  assert.throws(() => toProspectorRecords(null), /esperava uma lista/);
  assert.throws(() => toProspectorRecords({}), /esperava uma lista/);
  for (const invalido of [null, undefined, 'texto', 42, [], () => {}]) {
    assert.throws(() => toProspectorRecords([{ empresa: 'Ok' }, invalido]), /posição 1/);
  }
  const candidato = createCandidate({ empresa: 'X' });
  assert.throws(() => runDuplicateCheck(candidato, [null]), /posição 0/);
  assert.throws(() => runDncCheck(candidato, ['lixo'], true), /posição 0/);
  assert.throws(() => descobrir({}, [null]), /posição 0/);
  // sem CRM disponível o DNC continua NAO_VERIFICADO (nunca "liberado") e a lista nem é lida
  assert.equal(runDncCheck(candidato, [null], false).status, DNC_STATUS.NAO_VERIFICADO);
});

test('[CRM-ADAPT-10] os registros do CRM nunca são alterados, e o resultado não carrega campos comerciais do registro (só a identidade, o bloqueio e o id)', async () => {
  const registros = await crmComRegistros([{ campos: { empresa: 'Sigilo Teste', telefone: '24 90000-8001', email: 'reservado@example.test', valorProposta: 1234, observacoes: 'não sair' }, dnc: true }]);
  const antes = JSON.stringify(registros);
  const traduzidos = toProspectorRecords(registros);
  assert.equal(JSON.stringify(registros), antes);
  assert.deepEqual(Object.keys(traduzidos[0]).sort(), ['cidade', 'crmRecordId', 'doNotContact', 'empresa', 'instagram', 'site', 'telefone', 'whatsapp']);
  assert.equal(traduzidos[0].crmRecordId, registros[0].id);
  assert.equal(JSON.stringify(traduzidos).includes('reservado@example.test'), false);
});
