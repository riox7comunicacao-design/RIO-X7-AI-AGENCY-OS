// O MODELO do Dashboard para clientes PF/PJ (dashboard/crm-model.mjs — CRM 5.0, Fase D2): puro, sem DOM. O Dashboard não importa src/ (regra R11), então CPF, CNPJ, nome de exibição e a validação do formulário
// são CÓPIAS deliberadas das regras do domínio — e este arquivo prova que as duas implementações NUNCA divergem: o mesmo veredito em amostras grandes e em TODAS as combinações do formulário. Dados fictícios.

const test = require('node:test');
const assert = require('node:assert/strict');

const identity = require('../../src/crm/clientIdentity');
const crmDomain = require('../../src/crm/crmDomain');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
const { CRM_WRITABLE_FIELDS } = require('../../src/crm/constants');

const loadModel = () => import('../../dashboard/crm-model.mjs');
const loadRouter = () => import('../../dashboard/router.mjs');

// gerador determinístico (mulberry32): a mesma amostra em toda execução
function gerador(semente) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALFABETO = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const sortear = (rand, alfabeto, tamanho) => Array.from({ length: tamanho }, () => alfabeto[Math.floor(rand() * alfabeto.length)]).join('');

test('[DASH-PERSON-1] PARIDADE dos documentos: CPF e CNPJ (numérico e alfanumérico) têm o MESMO veredito e a MESMA normalização no Dashboard e no domínio — em milhares de amostras', async () => {
  const model = await loadModel();
  const rand = gerador(20261020);
  const amostrasCpf = ['529.982.247-25', '111.444.777-35', '111.111.111-11', '', '   ', '529.982.247-24', 'abc', null, undefined, 42, {}];
  const amostrasCnpj = ['11.222.333/0001-81', '12.ABC.345/01DE-35', '12abc34501de35', '00.000.000/0000-00', '11.222.333/0001-82', '', null, undefined, 7, {}];
  for (let i = 0; i < 4000; i += 1) {
    amostrasCpf.push(sortear(rand, '0123456789', 11));
    amostrasCpf.push(sortear(rand, '0123456789', 9 + Math.floor(rand() * 5)));
    amostrasCnpj.push(sortear(rand, '0123456789', 14));
    amostrasCnpj.push(sortear(rand, ALFABETO, 12) + sortear(rand, '0123456789', 2));
    amostrasCnpj.push(sortear(rand, ALFABETO, 10 + Math.floor(rand() * 7)));
  }
  // documentos válidos GERADOS: o CPF e o CNPJ com os dígitos verificadores calculados pelo domínio -> o Dashboard concorda
  let validosCpf = 0;
  let validosCnpj = 0;
  for (const valor of amostrasCpf) {
    assert.equal(model.isValidCpf(valor), identity.isValidCpf(valor), `CPF ${JSON.stringify(valor)}`);
    if (identity.isValidCpf(valor)) validosCpf += 1;
  }
  for (const valor of amostrasCnpj) {
    assert.equal(model.isValidCnpj(valor), identity.isValidCnpj(valor), `CNPJ ${JSON.stringify(valor)}`);
    if (identity.isValidCnpj(valor)) validosCnpj += 1;
  }
  assert.ok(validosCpf >= 20, `a amostra de CPF tem válidos de verdade (${validosCpf})`);
  assert.ok(validosCnpj >= 2, `a amostra de CNPJ tem válidos de verdade (${validosCnpj})`);
  for (const valor of [...amostrasCpf, ...amostrasCnpj, ' 12.ab.c/ 3-4 ', '..--//', 'a.b-c/d e']) {
    const doDominio = identity.normalizeDocument(valor);
    assert.equal(model.normalizeDocument(valor), doDominio === null ? '' : doDominio, `normalizeDocument ${JSON.stringify(valor)}`);
  }
});

test('[DASH-PERSON-2] PARIDADE do nome de exibição: clientName (Dashboard) == clientDisplayName (domínio) para todas as combinações de tipo, empresa e nome completo', async () => {
  const model = await loadModel();
  for (const tipoPessoa of [undefined, null, 'PF', 'PJ']) {
    for (const empresa of [undefined, null, '', '   ', ' Clínica Aurora ']) {
      for (const nomeCompleto of [undefined, null, '', '   ', ' Maria Souza ']) {
        const registro = { tipoPessoa, empresa, nomeCompleto };
        assert.equal(model.clientName(registro), identity.clientDisplayName(registro) ?? '', JSON.stringify(registro));
      }
    }
  }
  for (const nada of [null, undefined, 'texto', 42, []]) assert.equal(model.clientName(nada), '');
});

test('[DASH-PERSON-3] PARIDADE da validação do formulário: validateForm aprova EXATAMENTE o que o domínio aceita — todas as combinações de tipo, empresa, nome completo, CPF e CNPJ, no cadastro novo e no registro antigo', async () => {
  const model = await loadModel();
  const valores = {
    tipoPessoa: ['', 'PF', 'PJ'],
    empresa: ['', 'Clínica Aurora'],
    nomeCompleto: ['', 'Maria Souza'],
    cpf: ['', '529.982.247-25', '529.982.247-24'],
    cnpj: ['', '11.222.333/0001-81', '11.222.333/0001-82'],
  };
  let total = 0;
  let aceitas = 0;
  for (const tipoPessoa of valores.tipoPessoa) {
    for (const empresa of valores.empresa) {
      for (const nomeCompleto of valores.nomeCompleto) {
        for (const cpf of valores.cpf) {
          for (const cnpj of valores.cnpj) {
            for (const creating of [true, false]) {
              const form = { tipoPessoa, empresa, nomeCompleto, cpf, cnpj };
              const ui = Object.keys(model.validateForm(form, { creating })).length === 0;
              const campos = Object.fromEntries(Object.entries(form).filter(([, valor]) => valor !== ''));
              let dominio = true;
              try {
                await crmDomain.createRecord(createInMemoryCrmRepository(), campos, creating ? { exigirTipoPessoa: true } : {});
              } catch {
                dominio = false;
              }
              total += 1;
              if (ui) aceitas += 1;
              assert.equal(ui, dominio, `creating=${creating} ${JSON.stringify(form)}: tela=${ui} domínio=${dominio}`);
            }
          }
        }
      }
    }
  }
  assert.equal(total, 3 * 2 * 2 * 3 * 3 * 2);
  assert.ok(aceitas > 10 && aceitas < total, `aceita ${aceitas} de ${total}: a regra não é trivial`);
});

test('[DASH-PERSON-4] as mensagens de validação são claras e apontam o CAMPO certo (e só ele)', async () => {
  const { validateForm } = await loadModel();
  assert.deepEqual(validateForm({}, { creating: true }), { tipoPessoa: 'Escolha se o cliente é Pessoa Física ou Pessoa Jurídica.' });
  assert.deepEqual(validateForm({ tipoPessoa: 'PF' }, { creating: true }), { nomeCompleto: 'Informe o nome completo.' });
  assert.deepEqual(validateForm({ tipoPessoa: 'PJ' }, { creating: true }), { empresa: 'Informe o nome da empresa.' });
  assert.deepEqual(validateForm({ tipoPessoa: 'PF', nomeCompleto: 'Maria', cpf: '123' }), { cpf: 'CPF inválido. Confira os 11 números.' });
  assert.deepEqual(validateForm({ tipoPessoa: 'PJ', empresa: 'Aurora', cnpj: '123' }), { cnpj: 'CNPJ inválido. Confira os 14 caracteres.' });
  assert.deepEqual(validateForm({ tipoPessoa: 'PF', nomeCompleto: 'Maria', cnpj: '11.222.333/0001-81' }), { cnpj: 'O CNPJ só vale para Pessoa Jurídica.' });
  assert.deepEqual(validateForm({ tipoPessoa: 'PJ', empresa: 'Aurora', cpf: '529.982.247-25' }), { cpf: 'O CPF só vale para Pessoa Física.' });
  assert.deepEqual(validateForm({ tipoPessoa: 'PJ', empresa: 'Aurora', nomeCompleto: 'Maria' }), { nomeCompleto: 'O nome completo só vale para Pessoa Física; para uma empresa use o campo Empresa.' });
  assert.deepEqual(validateForm({ nomeCompleto: 'Maria' }), { tipoPessoa: 'Escolha o tipo de pessoa para informar nome completo, CPF ou CNPJ.', empresa: 'Informe o nome da empresa.' });
  // o registro ANTIGO (sem tipo) continua pedindo só a empresa; os valores em dinheiro seguem validados
  assert.deepEqual(validateForm({ empresa: 'Clínica Antiga' }), {});
  assert.deepEqual(validateForm({ empresa: '   ' }), { empresa: 'Informe o nome da empresa.' });
  assert.deepEqual(Object.keys(validateForm({ tipoPessoa: 'PJ', empresa: 'Aurora', valorProposta: 'muito' })), ['valorProposta']);
  assert.deepEqual(validateForm({ tipoPessoa: 'PF', nomeCompleto: 'Maria', cpf: '529.982.247-25' }, { creating: true }), {}, 'PF válida com CPF formatado');
});

test('[DASH-PERSON-5] o modelo tem os 35 campos (31 legados + 4), o tipo é um rótulo claro, e cada campo do NOVO CLIENTE aparece em exatamente UMA seção (principal ou expansível)', async () => {
  const model = await loadModel();
  assert.deepEqual([...model.WRITABLE_KEYS].sort(), [...CRM_WRITABLE_FIELDS].sort());
  assert.deepEqual(model.TIPOS_PESSOA.map((tipo) => [tipo.value, tipo.label]), [['PF', 'Pessoa Física'], ['PJ', 'Pessoa Jurídica']]);
  assert.equal(model.tipoLabel('PF'), 'Pessoa Física');
  assert.equal(model.tipoLabel('PJ'), 'Pessoa Jurídica');
  for (const semTipo of [null, undefined, '', 'pf', 'X']) assert.equal(model.tipoLabel(semTipo), 'Sem tipo definido');
  assert.deepEqual([model.tipoShort('PF'), model.tipoShort('PJ'), model.tipoShort(null)], ['PF', 'PJ', 'Sem tipo']);
  const secoes = [...model.CLIENT_FORM_SECTIONS.principal, ...model.CLIENT_FORM_SECTIONS.mais];
  const todas = secoes.flatMap((secao) => secao.keys);
  assert.equal(new Set(todas).size, todas.length, 'nenhum campo em duas seções');
  assert.deepEqual([...todas].sort(), [...model.WRITABLE_KEYS].sort(), 'nenhum campo eliminado e nenhum inventado');
  assert.deepEqual(model.CLIENT_FORM_SECTIONS.principal.map((secao) => secao.title), ['Quem é o cliente', 'Como falar com ele', 'Classificação']);
  assert.deepEqual(model.CLIENT_FORM_SECTIONS.principal.flatMap((secao) => secao.keys), ['tipoPessoa', 'nomeCompleto', 'empresa', 'cpf', 'cnpj', 'contato', 'telefone', 'whatsapp', 'email', 'nicho', 'origem', 'responsavel']);
  assert.ok(model.CLIENT_FORM_SECTIONS.mais.length >= 4, 'o resto fica na seção expansível');
  assert.equal(Object.isFrozen(model.CLIENT_FORM_SECTIONS), true);
});

test('[DASH-PERSON-6] quais campos de identificação fazem sentido para cada tipo (a tela esconde o resto enquanto vazio)', async () => {
  const { relevantIdentityKeys } = await loadModel();
  assert.deepEqual(relevantIdentityKeys('PF'), ['nomeCompleto', 'cpf']);
  assert.deepEqual(relevantIdentityKeys('PJ'), ['empresa', 'cnpj', 'contato']);
  assert.deepEqual(relevantIdentityKeys(''), ['empresa'], 'sem tipo: só a empresa, como sempre foi');
  assert.deepEqual(relevantIdentityKeys(null), ['empresa']);
});

test('[DASH-PERSON-7] LISTA: o filtro por tipo (PF, PJ e "Sem tipo definido" para a revisão), a busca por nome completo e por CPF/CNPJ com ou sem pontuação, e a ordem pelo nome de exibição', async () => {
  const { filterRecords, matchesQuery, sortRecordsBy, listCells, SEM_TIPO } = await loadModel();
  const maria = { id: 'crm:1', tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', empresa: null, cpf: '52998224725', cnpj: null, status: 'PROSPECT', dataDeEntrada: '2026-10-03T00:00:00Z' };
  const aurora = { id: 'crm:2', tipoPessoa: 'PJ', empresa: 'Clínica Aurora', nomeCompleto: null, cpf: null, cnpj: '11222333000181', status: 'PROSPECT', dataDeEntrada: '2026-10-02T00:00:00Z' };
  const antigo = { id: 'crm:3', tipoPessoa: null, empresa: 'Estúdio Dias', status: 'PROSPECT', dataDeEntrada: '2026-10-01T00:00:00Z' };
  const todos = [maria, aurora, antigo];
  assert.deepEqual(filterRecords(todos, { tipo: 'PF' }).map((r) => r.id), ['crm:1']);
  assert.deepEqual(filterRecords(todos, { tipo: 'PJ' }).map((r) => r.id), ['crm:2']);
  assert.deepEqual(filterRecords(todos, { tipo: SEM_TIPO }).map((r) => r.id), ['crm:3'], 'o registro antigo é achado para a revisão administrativa');
  assert.deepEqual(filterRecords(todos, { tipo: '' }).map((r) => r.id), ['crm:1', 'crm:2', 'crm:3']);
  assert.deepEqual(filterRecords(todos, { tipo: 'PF', query: 'aurora' }), [], 'o filtro de tipo se combina com a busca');
  // busca: nome completo (sem acento nem caixa) e documento (qualquer pontuação)
  assert.equal(matchesQuery(maria, 'maria souza'), true);
  assert.equal(matchesQuery(maria, 'MARIA'), true);
  assert.equal(matchesQuery(maria, '529.982.247-25'), true);
  assert.equal(matchesQuery(maria, '52998224725'), true);
  assert.equal(matchesQuery(maria, '982.247'), true, 'um pedaço do CPF');
  assert.equal(matchesQuery(maria, '111.444'), false);
  assert.equal(matchesQuery(aurora, '11.222.333/0001-81'), true);
  assert.equal(matchesQuery(aurora, '11222333'), true);
  assert.equal(matchesQuery(aurora, '529'), false);
  assert.equal(matchesQuery(antigo, 'dias'), true);
  // a primeira coluna é o nome de exibição, e a de tipo diz "Sem tipo" para o registro antigo
  assert.deepEqual([listCells(maria).empresa, listCells(maria).tipoPessoa], ['Maria Souza', 'PF']);
  assert.deepEqual([listCells(aurora).empresa, listCells(aurora).tipoPessoa], ['Clínica Aurora', 'PJ']);
  assert.deepEqual([listCells(antigo).empresa, listCells(antigo).tipoPessoa], ['Estúdio Dias', 'Sem tipo']);
  assert.equal(listCells({ id: 'crm:9' }).empresa, 'Sem nome');
  // a ordem "Cliente (A–Z)" usa o nome de exibição (Maria depois de Estúdio, antes de... por nome, não por empresa nula)
  assert.deepEqual(sortRecordsBy(todos, 'empresa').map((r) => r.id), ['crm:2', 'crm:3', 'crm:1']);
});

test('[DASH-PERSON-8] o corpo e o PATCH: o documento vai SÓ com os caracteres do documento; reabrir um cliente e não mexer em nada não gera PATCH (a máscara não conta como alteração); só o que mudou é enviado', async () => {
  const { buildCreateRequest, buildPatch, valuesFromRecord, formatCpf, formatCnpj } = await loadModel();
  const criacao = buildCreateRequest({ tipoPessoa: 'PF', nomeCompleto: ' Maria Souza ', cpf: '529.982.247-25', cnpj: '', empresa: '   ', telefone: '' });
  assert.deepEqual(criacao.fields, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: '52998224725' });
  const pj = buildCreateRequest({ tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: '12.abc.345/01de-35', contato: 'Ana Lima' });
  assert.deepEqual(pj.fields, { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: '12ABC34501DE35', contato: 'Ana Lima' });

  const registro = { id: 'crm:1', tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', empresa: 'Estúdio Maria', cpf: '52998224725', cnpj: null, cidade: 'Niterói' };
  const inicial = valuesFromRecord(registro);
  assert.equal(inicial.cpf, '52998224725');
  assert.deepEqual(buildPatch(inicial, { ...inicial, cpf: formatCpf(inicial.cpf) }), {}, 'mostrar o CPF com a máscara não é uma alteração');
  assert.deepEqual(buildPatch(inicial, { ...inicial, cidade: 'Rio' }), { cidade: 'Rio' });
  assert.deepEqual(buildPatch(inicial, { ...inicial, cpf: '' }), { cpf: null }, 'esvaziar o documento vai como null');
  assert.deepEqual(buildPatch(inicial, { ...inicial, tipoPessoa: 'PJ', nomeCompleto: '', cpf: '', cnpj: '11.222.333/0001-81' }), { tipoPessoa: 'PJ', nomeCompleto: null, cpf: null, cnpj: '11222333000181' });
  assert.equal(formatCpf('52998224725'), '529.982.247-25');
  assert.equal(formatCnpj('11222333000181'), '11.222.333/0001-81');
  assert.equal(formatCnpj('12abc34501de35'), '12.ABC.345/01DE-35');
  assert.equal(formatCpf('123'), '123', 'o que não é um CPF válido passa como veio (só se MOSTRA com máscara o que tem 11 dígitos)');
});

test('[DASH-PERSON-9] o rótulo de um cliente numa lista de escolha mostra o nome e o tipo ("Maria Souza (PF)"); o registro antigo, só o nome', async () => {
  const { clientOptionLabel } = await loadModel();
  assert.equal(clientOptionLabel({ tipoPessoa: 'PF', nomeCompleto: 'Maria Souza' }), 'Maria Souza (PF)');
  assert.equal(clientOptionLabel({ tipoPessoa: 'PJ', empresa: 'Clínica Aurora' }), 'Clínica Aurora (PJ)');
  assert.equal(clientOptionLabel({ tipoPessoa: null, empresa: 'Estúdio Dias' }), 'Estúdio Dias');
  assert.equal(clientOptionLabel({ id: 'crm:9' }), 'Sem nome');
  assert.equal(clientOptionLabel(null), 'Sem nome');
});

test('[DASH-PERSON-10] ROTA #/funis/nova-negociacao/<id>: ida e volta (ids com caracteres especiais), o id codificado vazio ou quebrado é "não encontrada" e a rota continua sendo a tela de Funis no menu', async () => {
  const { parseRoute, buildHash, sectionOf } = await loadRouter();
  const id = 'crm:00000000-0000-4000-8000-000000000001';
  const hash = buildHash({ name: 'funnels', newFor: id });
  assert.equal(hash, `#/funis/nova-negociacao/${encodeURIComponent(id)}`);
  assert.deepEqual(parseRoute(hash), { name: 'funnels', newFor: id });
  assert.deepEqual(parseRoute('#/funis'), { name: 'funnels' });
  assert.equal(buildHash({ name: 'funnels' }), '#/funis');
  assert.equal(buildHash({ name: 'funnels', newFor: '' }), '#/funis');
  assert.deepEqual(parseRoute('#/funis/nova-negociacao/'), { name: 'not-found' });
  assert.deepEqual(parseRoute('#/funis/nova-negociacao/%'), { name: 'not-found' });
  assert.deepEqual(parseRoute('#/funis/outra-coisa/x'), { name: 'not-found' });
  assert.equal(sectionOf({ name: 'funnels', newFor: id }), 'funnels', 'o item "Funis de Vendas" continua aceso');
  const estranho = 'crm:a b/c?d#e';
  assert.deepEqual(parseRoute(buildHash({ name: 'funnels', newFor: estranho })), { name: 'funnels', newFor: estranho });
});
