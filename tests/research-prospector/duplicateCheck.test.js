const test = require('node:test');
const assert = require('node:assert/strict');
const { createCandidate } = require('../../src/research-prospector/candidate');
const { checkDuplicate } = require('../../src/research-prospector/duplicateCheck');
const { DUPLICATE_STATUS } = require('../../src/research-prospector/constants');

test('domínio duplicado: mesmo site de um registro existente => DUPLICADO', () => {
  const candidate = createCandidate({ empresa: 'Clínica Nova', site: 'https://www.clinicaexemplo.com.br' });
  const existing = [{ empresa: 'Clínica Exemplo Ltda', site: 'clinicaexemplo.com.br' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.DUPLICADO);
  assert.ok(result.matchedOn.includes('dominio'));
});

test('telefone duplicado: mesmo telefone (formatado diferente) => DUPLICADO', () => {
  const candidate = createCandidate({ empresa: 'Consultório Novo', telefone: '(24) 99999-9999' });
  const existing = [{ empresa: 'Consultório Antigo', telefone: '24999999999' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.DUPLICADO);
  assert.ok(result.matchedOn.includes('telefone'));
});

test('Instagram duplicado: mesmo perfil em formatos diferentes => DUPLICADO', () => {
  const candidate = createCandidate({ empresa: 'Perfil Novo', instagram: 'https://instagram.com/psicologa.exemplo/' });
  const existing = [{ empresa: 'Perfil Antigo', instagram: '@psicologa.exemplo' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.DUPLICADO);
  assert.ok(result.matchedOn.includes('instagram'));
});

test('nome + cidade: só esse critério bate => POSSIVEL_DUPLICADO, nunca DUPLICADO', () => {
  const candidate = createCandidate({ empresa: 'Consultório Ana Silva', cidade: 'Petrópolis' });
  const existing = [{ empresa: 'Consultório Ana Silva', cidade: 'Petrópolis', telefone: '24911112222' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.POSSIVEL_DUPLICADO);
  assert.deepEqual(result.matchedOn, ['nome_cidade']);
});

test('dados incompletos: nenhum dos 4 critérios disponível => NAO_VERIFICADO, nunca NOVO por padrão', () => {
  const candidate = createCandidate({ empresa: 'Consultório Sem Dados' });
  const existing = [{ empresa: 'Outro Consultório', cidade: 'Petrópolis', telefone: '24900000000' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.NAO_VERIFICADO);
});

test('candidato novo: critérios disponíveis, nenhum bate com a base => NOVO', () => {
  const candidate = createCandidate({
    empresa: 'Consultório Realmente Novo',
    site: 'https://consultorionovo.com.br',
    telefone: '24955554444',
    instagram: '@consultorionovo',
    cidade: 'Petrópolis',
  });
  const existing = [{ empresa: 'Consultório Diferente', site: 'outraclinica.com.br', cidade: 'Petrópolis' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.NOVO);
});

test('base vazia: nunca é tratado como duplicado', () => {
  const candidate = createCandidate({ empresa: 'Único no Mercado', site: 'https://unico.com.br' });

  const result = checkDuplicate(candidate, []);

  assert.equal(result.status, DUPLICATE_STATUS.NOVO);
});

// Passo 1.9 — correção conservadora de telefone e de nome+cidade
// (ver docs/decisions/0005-conservative-name-and-phone-matching.md)

test('[1.9-A] telefone com/sem +55 é o único identificador coincidente => DUPLICADO', () => {
  const candidate = createCandidate({ empresa: 'Contato Novo', telefone: '(24) 98765-4321' });
  const existing = [{ empresa: 'Helena Duarte', telefone: '+55 24 98765-4321' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.DUPLICADO);
  assert.deepEqual(result.matchedOn, ['telefone']);
});

test('[1.9-B] mesmo formato +55, DDD diferente => NOVO (nunca equivalente)', () => {
  const candidate = createCandidate({ empresa: 'Contato Novo', telefone: '+55 21 98765-4321' });
  const existing = [{ empresa: 'Helena Duarte', telefone: '+55 24 98765-4321' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.NOVO);
});

test('[1.9-C] "Helena Duarte" vs "Helena Duarte Psicóloga", mesma cidade => POSSIVEL_DUPLICADO', () => {
  const candidate = createCandidate({ empresa: 'Helena Duarte', cidade: 'Petrópolis' });
  const existing = [{ empresa: 'Helena Duarte Psicóloga', cidade: 'Petrópolis' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.POSSIVEL_DUPLICADO);
});

test('[1.9-D] "Dra. Helena Duarte" vs "Helena Duarte", mesma cidade => POSSIVEL_DUPLICADO', () => {
  const candidate = createCandidate({ empresa: 'Dra. Helena Duarte', cidade: 'Petrópolis' });
  const existing = [{ empresa: 'Helena Duarte', cidade: 'Petrópolis' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.POSSIVEL_DUPLICADO);
});

test('[1.9-E] nomes claramente diferentes, mesma cidade => NOVO', () => {
  const candidate = createCandidate({ empresa: 'Helena Duarte', cidade: 'Petrópolis' });
  const existing = [{ empresa: 'Mariana Duarte', cidade: 'Petrópolis' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.NOVO);
});

test('[1.9-F] sobrenome real diferente não é assumido como a mesma pessoa (falso negativo preferido a falso positivo)', () => {
  const candidate = createCandidate({ empresa: 'Helena Duarte Silva', cidade: 'Petrópolis' });
  const existing = [{ empresa: 'Helena Duarte', cidade: 'Petrópolis' }];

  const result = checkDuplicate(candidate, existing);

  assert.equal(result.status, DUPLICATE_STATUS.NOVO);
});

test('[1.9-G] domínio diferente + nome/cidade coincidente: nome nunca produz DUPLICADO sozinho', () => {
  const candidate = createCandidate({ empresa: 'Helena Duarte', site: 'https://helenaexemplo.com', cidade: 'Petrópolis' });
  const existing = [{ empresa: 'Helena Duarte', site: 'https://helenaduarte.exemplo.com.br', cidade: 'Petrópolis' }];

  const result = checkDuplicate(candidate, existing);

  assert.notEqual(result.status, DUPLICATE_STATUS.DUPLICADO);
  assert.equal(result.status, DUPLICATE_STATUS.POSSIVEL_DUPLICADO);
});
