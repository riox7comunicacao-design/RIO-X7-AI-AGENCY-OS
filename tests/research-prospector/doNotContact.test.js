const test = require('node:test');
const assert = require('node:assert/strict');
const { createCandidate } = require('../../src/research-prospector/candidate');
const { checkDoNotContact } = require('../../src/research-prospector/doNotContact');

test('DO NOT CONTACT: match exato (telefone) bloqueia o candidato', () => {
  const candidate = createCandidate({ empresa: 'Consultório X', telefone: '24999998888' });
  const existing = [{ empresa: 'Consultório X (antigo)', telefone: '24999998888', doNotContact: true }];

  const result = checkDoNotContact(candidate, existing);

  assert.equal(result.doNotContact, true);
});

test('tentativa de contornar DO NOT CONTACT com outro telefone: ainda bloqueado pelo domínio', () => {
  // Mesmo domínio do site, telefone diferente do registrado como DO NOT CONTACT —
  // o guard não pode ser enganado só porque um canal de contato mudou.
  const candidate = createCandidate({
    empresa: 'Consultório Y',
    site: 'https://consultorioy.com.br',
    telefone: '24911110000',
  });
  const existing = [
    {
      empresa: 'Consultório Y',
      site: 'consultorioy.com.br',
      telefone: '24900001111',
      doNotContact: true,
    },
  ];

  const result = checkDoNotContact(candidate, existing);

  assert.equal(result.doNotContact, true);
});

test('tentativa de contornar DO NOT CONTACT com outro canal (Instagram): ainda bloqueado pelo nome+cidade', () => {
  const candidate = createCandidate({
    empresa: 'Consultório Z',
    cidade: 'Petrópolis',
    instagram: '@consultorio.z.novo',
  });
  const existing = [
    {
      empresa: 'Consultório Z',
      cidade: 'Petrópolis',
      instagram: '@consultorio.z.antigo',
      doNotContact: true,
    },
  ];

  const result = checkDoNotContact(candidate, existing);

  assert.equal(result.doNotContact, true);
});

test('sem match: candidato normal não é afetado por outro registro DO NOT CONTACT', () => {
  const candidate = createCandidate({ empresa: 'Consultório Livre', telefone: '24933332222' });
  const existing = [{ empresa: 'Outro Consultório', telefone: '24900000000', doNotContact: true }];

  const result = checkDoNotContact(candidate, existing);

  assert.equal(result.doNotContact, false);
});
