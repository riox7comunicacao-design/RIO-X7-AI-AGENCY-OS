// Identificação do CLIENTE como Pessoa Física/Jurídica (src/crm/clientIdentity.js — CRM 5.0, Fase D2): CPF, CNPJ (numérico e alfanumérico), nome de exibição e a regra de coerência.
// Módulo PURO: nenhum I/O, nenhuma rede. Todo documento aqui é de exemplo público (números que só servem para provar o algoritmo) e nenhuma pessoa é real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TIPO_PESSOA, TIPO_PESSOA_VALUES, normalizeDocument, isValidCpf, isValidCnpj, clientDisplayName, resolvePersonFields } = require('../../src/crm/clientIdentity');

const CPF_VALIDOS = ['529.982.247-25', '52998224725', ' 529 982 247 25 ', '111.444.777-35'];
const CNPJ_VALIDOS = ['11.222.333/0001-81', '11222333000181', '12.ABC.345/01DE-35', '12abc34501de35'];

test('[PERSON-1] vocabulário: exatamente PF e PJ, congelado', () => {
  assert.deepEqual({ ...TIPO_PESSOA }, { PF: 'PF', PJ: 'PJ' });
  assert.deepEqual([...TIPO_PESSOA_VALUES], ['PF', 'PJ']);
  assert.equal(Object.isFrozen(TIPO_PESSOA), true);
  assert.equal(Object.isFrozen(TIPO_PESSOA_VALUES), true);
});

test('[PERSON-2] CPF: aceita 11 dígitos com os dois dígitos verificadores certos, com ou sem pontuação e espaços', () => {
  for (const cpf of CPF_VALIDOS) assert.equal(isValidCpf(cpf), true, cpf);
});

test('[PERSON-3] CPF: recusa dígito verificador errado, sequência repetida, tamanho errado, letras e o que não é texto', () => {
  const recusados = ['529.982.247-24', '529.982.247-35', '111.111.111-11', '000.000.000-00', '5299822472', '529982247250', '52998224a25', '', '   ', null, undefined, 52998224725, {}, ['52998224725']];
  for (const valor of recusados) assert.equal(isValidCpf(valor), false, JSON.stringify(valor));
});

test('[PERSON-4] CPF: trocar QUALQUER um dos 11 dígitos de um CPF válido por outro dígito o invalida (os dígitos verificadores pegam todo erro de um dígito)', () => {
  const base = '52998224725';
  for (let i = 0; i < base.length; i += 1) {
    for (const digito of '0123456789') {
      if (digito === base[i]) continue;
      const trocado = base.slice(0, i) + digito + base.slice(i + 1);
      assert.equal(isValidCpf(trocado), false, `${trocado} (posição ${i})`);
    }
  }
});

test('[PERSON-5] CNPJ: aceita o numérico e o ALFANUMÉRICO da Receita (12 caracteres 0-9/A-Z + 2 dígitos), com ou sem pontuação, em maiúsculas ou minúsculas', () => {
  for (const cnpj of CNPJ_VALIDOS) assert.equal(isValidCnpj(cnpj), true, cnpj);
});

test('[PERSON-6] CNPJ: recusa dígito verificador errado, sequência repetida, tamanho errado, letra nos dois últimos e o que não é texto', () => {
  const recusados = ['11.222.333/0001-82', '11.222.333/0001-91', '00.000.000/0000-00', '11.111.111/1111-11', '1122233300018', '112223330001811', '1122233300018A', '12.ABC.345/01DE-34', '', null, undefined, 11222333000181, {}];
  for (const valor of recusados) assert.equal(isValidCnpj(valor), false, JSON.stringify(valor));
});

test('[PERSON-7] CNPJ numérico: trocar qualquer um dos 14 dígitos de um CNPJ válido por outro dígito o invalida', () => {
  const base = '11222333000181';
  for (let i = 0; i < base.length; i += 1) {
    for (const digito of '0123456789') {
      if (digito === base[i]) continue;
      const trocado = base.slice(0, i) + digito + base.slice(i + 1);
      assert.equal(isValidCnpj(trocado), false, `${trocado} (posição ${i})`);
    }
  }
});

test('[PERSON-8] normalizeDocument: tira pontos, barras, hífens e espaços, põe em maiúsculas; vazio e o que não é texto viram null; nunca "corrige" outros caracteres', () => {
  assert.equal(normalizeDocument('529.982.247-25'), '52998224725');
  assert.equal(normalizeDocument('12.abc.345/01de-35'), '12ABC34501DE35');
  assert.equal(normalizeDocument('  11 222 333 / 0001-81 '), '11222333000181');
  for (const vazio of ['', '   ', '.-/', null, undefined, 123, {}, []]) assert.equal(normalizeDocument(vazio), null, JSON.stringify(vazio));
  // um caractere estranho segue (em maiúsculas) e é recusado pela validação, nunca descartado em silêncio
  assert.equal(normalizeDocument('529.982.247-2x'), '5299822472X');
  assert.equal(isValidCpf('529.982.247-2x'), false);
});

test('[PERSON-9] nome de exibição: PF -> nome completo (cai na empresa se faltar); PJ e registro sem tipo -> empresa (cai no nome completo se faltar); espaços aparados; vazio = null', () => {
  assert.equal(clientDisplayName({ tipoPessoa: 'PF', nomeCompleto: ' Maria Souza ', empresa: 'Clínica Legada' }), 'Maria Souza');
  assert.equal(clientDisplayName({ tipoPessoa: 'PF', nomeCompleto: null, empresa: 'Clínica Legada' }), 'Clínica Legada');
  assert.equal(clientDisplayName({ tipoPessoa: 'PJ', empresa: 'Clínica Aurora', nomeCompleto: null }), 'Clínica Aurora');
  assert.equal(clientDisplayName({ tipoPessoa: 'PJ', empresa: '  ', nomeCompleto: 'Maria' }), 'Maria');
  assert.equal(clientDisplayName({ tipoPessoa: null, empresa: 'Clínica Antiga' }), 'Clínica Antiga');
  assert.equal(clientDisplayName({ empresa: 'Sem as chaves novas' }), 'Sem as chaves novas', 'um registro gravado antes da Fase D2 não tem as chaves novas');
  for (const vazio of [null, undefined, 'texto', 42, {}, { tipoPessoa: 'PF' }, { empresa: '   ' }]) assert.equal(clientDisplayName(vazio), null, JSON.stringify(vazio));
});

const ERRO = (contexto) => ({
  tipo: new RegExp(`^CRM: ${contexto} — campo "tipoPessoa" deve ser "PF" ou "PJ"`),
  nome: new RegExp(`^CRM: ${contexto} exige "nomeCompleto" para Pessoa Física`),
  semTipo: new RegExp(`^CRM: ${contexto} — defina o tipo de pessoa`),
  cnpjNaPf: new RegExp(`^CRM: ${contexto} — CNPJ só se aplica a Pessoa Jurídica`),
  cpfNaPj: new RegExp(`^CRM: ${contexto} — CPF só se aplica a Pessoa Física`),
  nomeNaPj: new RegExp(`^CRM: ${contexto} — nomeCompleto só se aplica a Pessoa Física`),
  cpf: new RegExp(`^CRM: ${contexto} — CPF inválido`),
  cnpj: new RegExp(`^CRM: ${contexto} — CNPJ inválido`),
});

test('[PERSON-10] coerência (resolvePersonFields): a matriz completa de tipo x nome x CPF x CNPJ — o que vale e a mensagem de cada recusa', () => {
  const E = ERRO('createRecord');
  const casos = [
    // [registro, resultado esperado: objeto normalizado OU a expressão do erro]
    [{}, { tipoPessoa: null, nomeCompleto: null, cpf: null, cnpj: null }],
    [{ tipoPessoa: null, empresa: 'X' }, { tipoPessoa: null, nomeCompleto: null, cpf: null, cnpj: null }],
    [{ tipoPessoa: 'PF', nomeCompleto: 'Maria' }, { tipoPessoa: 'PF', nomeCompleto: 'Maria', cpf: null, cnpj: null }],
    [{ tipoPessoa: 'PF', nomeCompleto: ' Maria Souza ', cpf: '529.982.247-25' }, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: '52998224725', cnpj: null }],
    [{ tipoPessoa: 'PJ', empresa: 'Aurora' }, { tipoPessoa: 'PJ', nomeCompleto: null, cpf: null, cnpj: null }],
    [{ tipoPessoa: 'PJ', empresa: 'Aurora', cnpj: '11.222.333/0001-81' }, { tipoPessoa: 'PJ', nomeCompleto: null, cpf: null, cnpj: '11222333000181' }],
    [{ tipoPessoa: 'PJ', cnpj: '12.abc.345/01de-35' }, { tipoPessoa: 'PJ', nomeCompleto: null, cpf: null, cnpj: '12ABC34501DE35' }],
    [{ tipoPessoa: 'PF' }, E.nome],
    [{ tipoPessoa: 'PF', nomeCompleto: '   ' }, E.nome],
    [{ tipoPessoa: 'PF', nomeCompleto: 'Maria', cnpj: '11.222.333/0001-81' }, E.cnpjNaPf],
    [{ tipoPessoa: 'PJ', empresa: 'Aurora', cpf: '529.982.247-25' }, E.cpfNaPj],
    [{ tipoPessoa: 'PJ', empresa: 'Aurora', nomeCompleto: 'Maria' }, E.nomeNaPj],
    [{ tipoPessoa: 'PF', nomeCompleto: 'Maria', cpf: '529.982.247-24' }, E.cpf],
    [{ tipoPessoa: 'PJ', empresa: 'Aurora', cnpj: '11.222.333/0001-82' }, E.cnpj],
    [{ nomeCompleto: 'Maria' }, E.semTipo],
    [{ cpf: '529.982.247-25' }, E.semTipo],
    [{ cnpj: '11.222.333/0001-81' }, E.semTipo],
    [{ tipoPessoa: 'pf', nomeCompleto: 'Maria' }, E.tipo],
    [{ tipoPessoa: 'PESSOA', nomeCompleto: 'Maria' }, E.tipo],
    [{ tipoPessoa: '', nomeCompleto: 'Maria' }, E.tipo],
  ];
  for (const [registro, esperado] of casos) {
    if (esperado instanceof RegExp) assert.throws(() => resolvePersonFields(registro, 'createRecord'), { message: esperado }, JSON.stringify(registro));
    else assert.deepEqual(resolvePersonFields(registro, 'createRecord'), esperado, JSON.stringify(registro));
  }
});

test('[PERSON-11] o contexto entra na mensagem: a mesma regra, na edição, fala "updateRecord"', () => {
  assert.throws(() => resolvePersonFields({ tipoPessoa: 'PF' }, 'updateRecord'), { message: ERRO('updateRecord').nome });
  assert.throws(() => resolvePersonFields({ tipoPessoa: 'PJ', cpf: '529.982.247-25' }, 'updateRecord'), { message: ERRO('updateRecord').cpfNaPj });
});

test('[PERSON-12] resolvePersonFields não muda o registro que recebe e devolve um objeto novo com só os 4 campos', () => {
  const registro = Object.freeze({ tipoPessoa: 'PF', nomeCompleto: ' Maria ', cpf: '529.982.247-25', empresa: 'Legado', cidade: 'Niterói' });
  const resultado = resolvePersonFields(registro, 'createRecord');
  assert.deepEqual(Object.keys(resultado).sort(), ['cnpj', 'cpf', 'nomeCompleto', 'tipoPessoa']);
  assert.equal(registro.cpf, '529.982.247-25');
});

test('[PERSON-13] o módulo é PURO: nenhum require (nem fs, rede ou outro módulo do projeto) e nada de console', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'crm', 'clientIdentity.js'), 'utf8');
  const semComentarios = fonte.split('\n').filter((linha) => !/^\s*\/\//.test(linha)).join('\n');
  assert.doesNotMatch(semComentarios, /require\(/);
  assert.doesNotMatch(semComentarios, /console\./);
  assert.doesNotMatch(semComentarios, /process\.|Date\.now|Math\.random/);
});
