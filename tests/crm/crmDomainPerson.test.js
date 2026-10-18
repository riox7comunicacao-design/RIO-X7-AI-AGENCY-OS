// CRM Domain — Clientes PESSOA FÍSICA / PESSOA JURÍDICA (CRM 5.0, Fase D2): criar PF e PJ, campos obrigatórios condicionais, documento opcional/inválido, duplicidade e DNC por documento, o registro LEGADO sem
// tipo (preservado, revisável, nunca inferido), edição parcial sem perda e a opção interna que exige o tipo. Repositório em MEMÓRIA, nenhuma rede, nenhum arquivo, dados fictícios (documentos de exemplo).

const test = require('node:test');
const assert = require('node:assert/strict');

const crm = require('../../src/crm/crmDomain');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
const { CRM_WRITABLE_FIELDS, CRM_LEGACY_WRITABLE_FIELDS, CRM_PERSON_FIELDS } = require('../../src/crm/constants');

const OP = Object.freeze({ actor: 'HUMAN', reviewedBy: { userId: 'user-admin', name: 'Admin Teste', role: 'ADMIN' }, motivo: null });
const CPF_A = '529.982.247-25';
const CPF_B = '111.444.777-35';
const CNPJ_A = '11.222.333/0001-81';
const CNPJ_ALFA = '12.ABC.345/01DE-35';

const repo = () => createInMemoryCrmRepository();
const criar = (r, campos, opcoes = {}) => crm.createRecord(r, campos, { ...OP, ...opcoes });
const erroDe = async (tarefa) => {
  try {
    await tarefa();
  } catch (erro) {
    return erro.message;
  }
  throw new Error('esperava uma falha e a operação terminou com sucesso');
};

test('[PERSON-DOM-1] Pessoa FÍSICA: nasce só com o tipo e o nome completo; `empresa` fica vazia (nenhum nome de pessoa num campo errado) e os 35 campos existem', async () => {
  const r = repo();
  const { record } = await criar(r, { tipoPessoa: 'PF', nomeCompleto: '  Maria Souza  ' });
  assert.equal(record.tipoPessoa, 'PF');
  assert.equal(record.nomeCompleto, 'Maria Souza', 'espaços das pontas saem');
  assert.equal(record.empresa, null, 'o nome da pessoa NÃO vai em empresa');
  assert.equal(record.cpf, null);
  assert.equal(record.cnpj, null);
  assert.deepEqual(Object.keys(record).sort(), ['id', 'status', 'dataDeEntrada', 'historico', ...CRM_WRITABLE_FIELDS].sort());
  assert.equal(record.status, 'PROSPECT');
  assert.equal(record.historico.length, 1);
  assert.match(record.id, /^crm:[0-9a-f-]{36}$/);
  assert.equal((await r.list()).length, 1);
});

test('[PERSON-DOM-2] Pessoa JURÍDICA: a empresa identifica; o nome da pessoa de contato vai em `contato`, e o CNPJ é guardado só com os caracteres do documento', async () => {
  const r = repo();
  const { record } = await criar(r, { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', contato: 'Ana Lima', cnpj: CNPJ_A, telefone: '24 90000-1111', email: 'contato@aurora.example.test' });
  assert.deepEqual([record.tipoPessoa, record.empresa, record.contato, record.cnpj, record.nomeCompleto, record.cpf], ['PJ', 'Clínica Aurora', 'Ana Lima', '11222333000181', null, null]);
});

test('[PERSON-DOM-3] campos obrigatórios CONDICIONAIS: PF sem nome completo, PJ sem empresa e registro sem tipo e sem empresa são recusados — e nada é gravado', async () => {
  const r = repo();
  assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PF' })), /exige "nomeCompleto" para Pessoa Física/);
  assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PF', nomeCompleto: '   ' })), /exige "nomeCompleto" para Pessoa Física/);
  assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PF', empresa: 'Só a empresa' })), /exige "nomeCompleto" para Pessoa Física/, 'a empresa não substitui o nome completo da PF');
  assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PJ' })), /createRecord exige "empresa" \(texto não vazio\)/, 'a mensagem do contrato legado continua a mesma');
  assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PJ', empresa: '  ' })), /createRecord exige "empresa"/);
  assert.match(await erroDe(() => criar(r, {})), /createRecord exige "empresa"/);
  assert.match(await erroDe(() => criar(r, { cidade: 'Niterói' })), /createRecord exige "empresa"/);
  assert.equal((await r.list()).length, 0);
});

test('[PERSON-DOM-4] a PF pode ter empresa (opcional: onde trabalha) e uma PJ não tem nome completo nem CPF — a regra é recusada com a mensagem certa', async () => {
  const r = repo();
  const { record } = await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'João Dias', empresa: 'Estúdio Dias' });
  assert.deepEqual([record.nomeCompleto, record.empresa], ['João Dias', 'Estúdio Dias']);
  assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PJ', empresa: 'Outra', nomeCompleto: 'Maria' })), /nomeCompleto só se aplica a Pessoa Física/);
  assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PJ', empresa: 'Outra', cpf: CPF_A })), /CPF só se aplica a Pessoa Física/);
  assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria', cnpj: CNPJ_A })), /CNPJ só se aplica a Pessoa Jurídica/);
  assert.equal((await r.list()).length, 1);
});

test('[PERSON-DOM-5] DOCUMENTO OPCIONAL: sem CPF/CNPJ o cadastro vale; preenchido, o formato e os dígitos são conferidos e o valor é guardado só com os caracteres do documento', async () => {
  const r = repo();
  const semDocumento = (await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Sem Documento' })).record;
  assert.equal(semDocumento.cpf, null);
  const pf = (await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Com Documento', cpf: ` ${CPF_A} ` })).record;
  assert.equal(pf.cpf, '52998224725');
  const pjAlfa = (await criar(r, { tipoPessoa: 'PJ', empresa: 'Alfanumérica', cnpj: CNPJ_ALFA.toLowerCase() })).record;
  assert.equal(pjAlfa.cnpj, '12ABC34501DE35', 'o CNPJ alfanumérico da Receita também vale, em maiúsculas');
  const vazio = (await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Documento Vazio', cpf: '   ' })).record;
  assert.equal(vazio.cpf, null, 'um texto que fica vazio é "sem documento"');
});

test('[PERSON-DOM-6] DOCUMENTO INVÁLIDO: dígito errado, sequência repetida e tamanho errado são recusados na criação e na edição, sem gravar nem alterar nada', async () => {
  const r = repo();
  for (const cpf of ['529.982.247-24', '111.111.111-11', '5299822472', '529.982.247-2x']) {
    assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria', cpf })), /CPF inválido/, cpf);
  }
  for (const cnpj of ['11.222.333/0001-82', '00.000.000/0000-00', '1122233300018']) {
    assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PJ', empresa: 'Aurora', cnpj })), /CNPJ inválido/, cnpj);
  }
  assert.equal((await r.list()).length, 0);
  const boa = (await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria', cpf: CPF_A })).record;
  const antes = JSON.stringify(await r.getById(boa.id));
  assert.match(await erroDe(() => crm.updateRecord(r, boa.id, { cpf: '529.982.247-24' })), /CPF inválido/);
  assert.equal(JSON.stringify(await r.getById(boa.id)), antes, 'a edição recusada não mudou nada');
});

test('[PERSON-DOM-7] tipo de pessoa inválido (texto qualquer, minúscula, número) é recusado; sem o tipo, nome completo/CPF/CNPJ não podem ser informados', async () => {
  const r = repo();
  for (const tipoPessoa of ['pf', 'PESSOA', 'Física', ' ']) {
    const msg = await erroDe(() => criar(r, { tipoPessoa, empresa: 'X', nomeCompleto: 'Maria' }));
    assert.match(msg, /campo "tipoPessoa" deve ser "PF" ou "PJ"|defina o tipo de pessoa/, JSON.stringify(tipoPessoa));
  }
  assert.match(await erroDe(() => criar(r, { tipoPessoa: 7, empresa: 'X' })), /campo "tipoPessoa" deve ser um texto ou null/);
  assert.match(await erroDe(() => criar(r, { empresa: 'X', nomeCompleto: 'Maria' })), /defina o tipo de pessoa/);
  assert.match(await erroDe(() => criar(r, { empresa: 'X', cpf: CPF_A })), /defina o tipo de pessoa/);
  assert.match(await erroDe(() => criar(r, { empresa: 'X', cnpj: CNPJ_A })), /defina o tipo de pessoa/);
  assert.equal((await r.list()).length, 0);
});

test('[PERSON-DOM-8] a opção INTERNA exigirTipoPessoa (que a API liga) torna o tipo obrigatório; ela nunca vale como campo do registro e a promoção/registros antigos seguem sem tipo', async () => {
  const r = repo();
  assert.match(await erroDe(() => criar(r, { empresa: 'Sem Tipo' }, { exigirTipoPessoa: true })), /exige "tipoPessoa" \(PF ou PJ\)/);
  assert.match(await erroDe(() => criar(r, { empresa: 'Sem Tipo', tipoPessoa: null }, { exigirTipoPessoa: true })), /exige "tipoPessoa"/);
  assert.equal((await criar(r, { empresa: 'Com Tipo', tipoPessoa: 'PJ' }, { exigirTipoPessoa: true })).record.tipoPessoa, 'PJ');
  // só `true` liga: qualquer outra coisa é ignorada (o Service já exige um booleano)
  assert.equal((await criar(r, { empresa: 'Sem Tipo Texto' }, { exigirTipoPessoa: 'true' })).record.tipoPessoa, null);
  // sem a opção (a promoção da Prospecção e os registros antigos): o contrato legado, o tipo fica NULL e nada é inferido
  const legado = (await criar(r, { empresa: 'Promovida Da Prospecção', site: 'promovida.example.test' })).record;
  assert.deepEqual([legado.tipoPessoa, legado.nomeCompleto, legado.cpf, legado.cnpj], [null, null, null, null]);
  // a opção é interna: não existe como CAMPO
  assert.match(await erroDe(() => criar(r, { empresa: 'X', exigirTipoPessoa: false })), /campos desconhecidos: exigirTipoPessoa/);
});

test('[PERSON-DOM-9] DUPLICIDADE por documento: o mesmo CPF ou CNPJ (com qualquer pontuação) é a MESMA pessoa/empresa — recusado como duplicado, mesmo com nome, site e telefone diferentes', async () => {
  const r = repo();
  const pf = (await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: CPF_A, cidade: 'Niterói' })).record;
  const pj = (await criar(r, { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: CNPJ_A, site: 'aurora.example.test' })).record;
  const dupCpf = await erroDe(() => criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Outra Pessoa Totalmente Diferente', cpf: '52998224725', cidade: 'Rio de Janeiro' }));
  assert.match(dupCpf, /já existe um registro com a mesma identidade \(cpf\)/);
  assert.ok(dupCpf.includes(pf.id));
  const dupCnpj = await erroDe(() => criar(r, { tipoPessoa: 'PJ', empresa: 'Nome Totalmente Outro', cnpj: '11222333000181', site: 'outro.example.test' }));
  assert.match(dupCnpj, /já existe um registro com a mesma identidade \(cnpj\)/);
  assert.ok(dupCnpj.includes(pj.id));
  assert.equal((await r.list()).length, 2, 'nenhuma duplicata foi gravada');
  // documentos DIFERENTES não colidem
  assert.equal((await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Outro João', cpf: CPF_B })).record.cpf, '11144477735');
});

test('[PERSON-DOM-10] sem documento não há duplicidade por documento; e só nome + cidade iguais é um AVISO (possível duplicado), também entre o NOME COMPLETO da PF e a EMPRESA de um registro antigo', async () => {
  const r = repo();
  const antigo = (await criar(r, { empresa: 'Maria Souza', cidade: 'Niterói' })).record;
  const mesmoNome = await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cidade: 'Niterói' });
  assert.equal(mesmoNome.duplicidade.status, 'POSSIVEL_DUPLICADO', 'o nome completo da PF é comparado com a empresa do registro antigo');
  assert.equal(mesmoNome.duplicidade.matchedRecord.id, antigo.id);
  const outraCidade = await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cidade: 'Petrópolis' });
  assert.equal(outraCidade.duplicidade, null);
  const doisSemDocumento = await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Fulano Sem Documento', cidade: 'Teresópolis' });
  assert.equal(doisSemDocumento.duplicidade, null);
  assert.equal((await r.list()).length, 4);
});

test('[PERSON-DOM-11] DO_NOT_CONTACT por documento: quem foi bloqueado não volta por baixo com o mesmo CPF/CNPJ — criar e editar para o documento de um bloqueado são recusados; o bloqueio vale para os dois tipos', async () => {
  const r = repo();
  const bloqueada = (await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Pessoa Bloqueada', cpf: CPF_A })).record;
  const bloqueadaPj = (await criar(r, { tipoPessoa: 'PJ', empresa: 'Empresa Bloqueada', cnpj: CNPJ_A })).record;
  await crm.markDoNotContact(r, bloqueada.id, OP);
  await crm.markDoNotContact(r, bloqueadaPj.id, OP);
  assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Nome Novo', cpf: '52998224725' })), /identidade já bloqueada como DO_NOT_CONTACT/);
  assert.match(await erroDe(() => criar(r, { tipoPessoa: 'PJ', empresa: 'Nome Novo', cnpj: CNPJ_A })), /identidade já bloqueada como DO_NOT_CONTACT/);
  const outro = (await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Pessoa Livre', cpf: CPF_B })).record;
  assert.match(await erroDe(() => crm.updateRecord(r, outro.id, { cpf: CPF_A })), /coincide com a de um registro bloqueado como DO_NOT_CONTACT/);
  assert.equal((await r.getById(outro.id)).cpf, '11144477735');
  // e o próprio bloqueado não pode mais ser alterado
  assert.match(await erroDe(() => crm.updateRecord(r, bloqueada.id, { cidade: 'Outra' })), /bloqueado \(DO_NOT_CONTACT\) não pode ser atualizado/);
});

test('[PERSON-DOM-12] editar o DOCUMENTO para o de outro registro ativo é recusado como duplicidade; reenviar o MESMO documento (outra formatação) não é conflito consigo mesmo', async () => {
  const r = repo();
  const a = (await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Pessoa A', cpf: CPF_A })).record;
  const b = (await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Pessoa B', cpf: CPF_B })).record;
  assert.match(await erroDe(() => crm.updateRecord(r, b.id, { cpf: CPF_A })), /coincide com a de outro registro \(cpf\)/);
  const mesmo = await crm.updateRecord(r, a.id, { cpf: '529-982-247.25' });
  assert.equal(mesmo.cpf, '52998224725');
  assert.equal((await r.getById(b.id)).cpf, '11144477735');
});

test('[PERSON-DOM-13] REGISTRO LEGADO: um registro antigo (sem tipo, sem as 4 chaves novas no armazenamento) abre, lista e é editado como sempre — a empresa continua obrigatória e nada é inferido', async () => {
  const bruto = {
    id: 'crm:00000000-0000-4000-8000-0000000000a1',
    ...Object.fromEntries(CRM_LEGACY_WRITABLE_FIELDS.map((campo) => [campo, null])),
    empresa: 'Clínica Antiga',
    cidade: 'Petrópolis',
    nicho: 'Psicologia',
    valorProposta: 1500,
    status: 'CONTACTED',
    dataDeEntrada: '2026-09-10T12:00:00.000Z',
    historico: [{ timestamp: '2026-09-10T12:00:00.000Z', from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: null, motivo: null }],
  };
  for (const campo of CRM_PERSON_FIELDS) assert.equal(Object.prototype.hasOwnProperty.call(bruto, campo), false, 'o registro antigo NÃO tem as chaves novas');
  const r = createInMemoryCrmRepository([bruto]);
  const lido = await crm.getRecord(r, bruto.id);
  assert.equal(lido.empresa, 'Clínica Antiga');
  assert.equal((await crm.listRecords(r)).length, 1);
  const editado = await crm.updateRecord(r, bruto.id, { telefone: '24 90000-2222' });
  assert.equal(editado.telefone, '24 90000-2222');
  assert.equal(editado.empresa, 'Clínica Antiga');
  assert.equal(editado.tipoPessoa ?? null, null, 'o tipo continua sem definir');
  assert.match(await erroDe(() => crm.updateRecord(r, bruto.id, { empresa: '   ' })), /updateRecord não pode deixar "empresa" vazia/);
  assert.match(await erroDe(() => crm.updateRecord(r, bruto.id, { nomeCompleto: 'Maria' })), /defina o tipo de pessoa/);
});

test('[PERSON-DOM-14] REVISÃO ADMINISTRATIVA do registro antigo: definir o tipo preserva TODOS os campos originais (empresa, valores, histórico); PF exige o nome completo; PJ mantém a empresa', async () => {
  const r = repo();
  const antigo = (await criar(r, { empresa: 'Estúdio Dias', cidade: 'Niterói', nicho: 'Design', valorProposta: 900, valorTotal: 1800, observacoes: 'cliente antigo' })).record;
  const original = structuredClone(antigo);

  assert.match(await erroDe(() => crm.updateRecord(r, antigo.id, { tipoPessoa: 'PF' })), /exige "nomeCompleto"/);
  assert.deepEqual(await r.getById(antigo.id), original, 'a tentativa recusada não mudou nada');

  const pj = await crm.updateRecord(r, antigo.id, { tipoPessoa: 'PJ', cnpj: CNPJ_A });
  assert.deepEqual([pj.tipoPessoa, pj.empresa, pj.cnpj], ['PJ', 'Estúdio Dias', '11222333000181']);
  for (const campo of CRM_LEGACY_WRITABLE_FIELDS) assert.deepEqual(pj[campo], original[campo], `${campo} preservado`);
  assert.deepEqual(pj.historico, original.historico);

  const outro = (await criar(r, { empresa: 'Consultório Lima', valorProposta: 500 })).record;
  const pf = await crm.updateRecord(r, outro.id, { tipoPessoa: 'PF', nomeCompleto: 'Dra. Lima' });
  assert.deepEqual([pf.tipoPessoa, pf.nomeCompleto, pf.empresa, pf.valorProposta], ['PF', 'Dra. Lima', 'Consultório Lima', 500], 'a empresa original continua (PF com empresa é válido)');
});

test('[PERSON-DOM-15] o tipo, depois de definido, só se TROCA (PF <-> PJ), nunca se remove; trocar exige deixar a identificação coerente com o novo tipo', async () => {
  const r = repo();
  const pf = (await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: CPF_A, empresa: 'Estúdio Maria' })).record;
  assert.match(await erroDe(() => crm.updateRecord(r, pf.id, { tipoPessoa: null })), /o tipo de pessoa, depois de definido, só pode ser trocado/);
  assert.match(await erroDe(() => crm.updateRecord(r, pf.id, { tipoPessoa: '' })), /só pode ser trocado/);
  assert.equal((await r.getById(pf.id)).tipoPessoa, 'PF');
  // PF -> PJ sem limpar o nome completo e o CPF: recusado (nada se perde em silêncio)
  assert.match(await erroDe(() => crm.updateRecord(r, pf.id, { tipoPessoa: 'PJ' })), /nomeCompleto só se aplica a Pessoa Física/);
  assert.match(await erroDe(() => crm.updateRecord(r, pf.id, { tipoPessoa: 'PJ', nomeCompleto: null })), /CPF só se aplica a Pessoa Física/);
  const pj = await crm.updateRecord(r, pf.id, { tipoPessoa: 'PJ', nomeCompleto: null, cpf: null, cnpj: CNPJ_A });
  assert.deepEqual([pj.tipoPessoa, pj.nomeCompleto, pj.cpf, pj.cnpj, pj.empresa], ['PJ', null, null, '11222333000181', 'Estúdio Maria']);
  // e de volta
  const devolta = await crm.updateRecord(r, pf.id, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cnpj: null });
  assert.deepEqual([devolta.tipoPessoa, devolta.nomeCompleto, devolta.cnpj], ['PF', 'Maria Souza', null]);
  // um registro SEM tipo aceita `tipoPessoa: null` como no-op
  const antigo = (await criar(r, { empresa: 'Sem Tipo Ainda' })).record;
  assert.equal((await crm.updateRecord(r, antigo.id, { tipoPessoa: null, cidade: 'Rio' })).cidade, 'Rio');
});

test('[PERSON-DOM-16] EDIÇÃO PARCIAL sem perda: mudar um campo não toca nos outros (identificação, contato, valores, histórico, status); esvaziar o nome de uma PF é recusado', async () => {
  const r = repo();
  const { record } = await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: CPF_A, telefone: '24 90000-3333', email: 'maria@example.test', nicho: 'Psicologia', origem: 'Indicação', valorProposta: 1200, observacoes: 'preferência pela manhã' });
  const antes = structuredClone(record);
  const depois = await crm.updateRecord(r, record.id, { cidade: 'Niterói' });
  for (const campo of Object.keys(antes)) if (campo !== 'cidade') assert.deepEqual(depois[campo], antes[campo], `${campo} intacto`);
  assert.equal(depois.cidade, 'Niterói');
  assert.match(await erroDe(() => crm.updateRecord(r, record.id, { nomeCompleto: null })), /exige "nomeCompleto" para Pessoa Física/);
  assert.match(await erroDe(() => crm.updateRecord(r, record.id, { nomeCompleto: '   ' })), /exige "nomeCompleto" para Pessoa Física/);
  assert.equal((await r.getById(record.id)).nomeCompleto, 'Maria Souza');
  const semDocumento = await crm.updateRecord(r, record.id, { cpf: null });
  assert.equal(semDocumento.cpf, null, 'o documento pode ser removido (é opcional)');
});

test('[PERSON-DOM-17] mudar de status, bloquear e excluir seguem como sempre para os dois tipos (a identificação não muda a máquina de estados nem a auditoria)', async () => {
  const r = repo();
  const pf = (await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza' })).record;
  const pj = (await criar(r, { tipoPessoa: 'PJ', empresa: 'Clínica Aurora' })).record;
  for (const id of [pf.id, pj.id]) {
    const movido = await crm.moveStatus(r, id, 'CONTACTED', OP);
    assert.equal(movido.status, 'CONTACTED');
    assert.equal(movido.historico.length, 2);
  }
  const apagado = await crm.deleteRecord(r, pf.id, { reviewedBy: OP.reviewedBy, motivo: 'teste' });
  assert.equal(apagado.id, pf.id);
  assert.equal(await r.getById(pf.id), null);
  assert.equal((await r.list()).length, 1);
});

test('[PERSON-DOM-18] os 31 campos LEGADOS continuam, na mesma ordem, como os 31 primeiros de CRM_WRITABLE_FIELDS; os 4 novos vêm depois e não há campo repetido', () => {
  assert.equal(CRM_LEGACY_WRITABLE_FIELDS.length, 31);
  assert.deepEqual([...CRM_WRITABLE_FIELDS].slice(0, 31), [...CRM_LEGACY_WRITABLE_FIELDS]);
  assert.deepEqual([...CRM_WRITABLE_FIELDS].slice(31), ['tipoPessoa', 'nomeCompleto', 'cpf', 'cnpj']);
  assert.equal(new Set(CRM_WRITABLE_FIELDS).size, 35);
  assert.equal(Object.isFrozen(CRM_WRITABLE_FIELDS) && Object.isFrozen(CRM_LEGACY_WRITABLE_FIELDS) && Object.isFrozen(CRM_PERSON_FIELDS), true);
});

test('[PERSON-DOM-19] escritas simultâneas do MESMO documento (corrida): UMA cria e as outras são recusadas como duplicadas — a serialização do domínio vale para a regra nova', async () => {
  const r = repo();
  const resultados = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => criar(r, { tipoPessoa: 'PF', nomeCompleto: `Pessoa ${i}`, cpf: CPF_A })));
  assert.equal(resultados.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(resultados.filter((x) => x.status === 'rejected').length, 7);
  assert.equal((await r.list()).length, 1);
});
