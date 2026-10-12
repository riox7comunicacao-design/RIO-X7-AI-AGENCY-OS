// Catalog Service (src/services/catalogService.js — CRM 5.0, Fase 2B-1): a camada de autorização dos catálogos do CRM. Peças REAIS: contextos
// emitidos pelo emissor interno, a ponte real de src/auth/catalogBridge.js, o domínio real e o repositório de memória. O único "double" é o
// contador de uso do CRM legado (`countUsage`), injetado — exatamente como a composição faz.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { authorizeCatalogOperation } = require('../../src/auth');
const { createCatalogService, PERMISSION_FOR, AUDIT_FIELDS } = require('../../src/services/catalogService');
const { createInMemoryCatalogRepository } = require('../../src/crm/catalogRepository');
const { CATALOG_ERROR, CATALOG_KEYS, COMMON_ITEM_FIELDS, CATALOG_DEFINITIONS } = require('../../src/crm/catalogConstants');
const { analyzeSource } = require('../helpers/staticImports');
const { admin, closer, inativo } = require('../helpers/promotionFixtures');

const T0 = new Date('2026-10-12T12:00:00.000Z');

function criar({ repository = createInMemoryCatalogRepository(), countUsage = async () => 0, authorizeOperation = authorizeCatalogOperation } = {}) {
  return { service: createCatalogService({ authorizeOperation, repository, countUsage, now: () => T0 }), repository };
}
async function erroDe(task) {
  try {
    await task();
  } catch (error) {
    return error;
  }
  throw new Error('esperava uma falha e não houve');
}

test('[CATSVC-1] o Service expõe exatamente as 7 operações, congelado — nenhuma de exclusão', () => {
  const { service } = criar();
  assert.deepEqual(Object.keys(service).sort(), ['activate', 'create', 'deactivate', 'get', 'list', 'reorder', 'update']);
  assert.equal(Object.isFrozen(service), true);
  assert.equal(Object.keys(service).some((nome) => /delete|remove|destroy/i.test(nome)), false);
});

test('[CATSVC-2] dependências obrigatórias: sem autorizador, sem repositório válido, sem contador de uso ou com um domínio incompleto o Service NÃO existe', () => {
  const repository = createInMemoryCatalogRepository();
  const base = { authorizeOperation: authorizeCatalogOperation, repository, countUsage: async () => 0 };
  assert.throws(() => createCatalogService({ ...base, authorizeOperation: undefined }), /exige \{ authorizeOperation \}/);
  assert.throws(() => createCatalogService({ ...base, authorizeOperation: 'função' }), /exige \{ authorizeOperation \}/);
  assert.throws(() => createCatalogService({ ...base, repository: undefined }), /exige \{ repository \}/);
  assert.throws(() => createCatalogService({ ...base, repository: null }), /exige \{ repository \}/);
  assert.throws(() => createCatalogService({ ...base, repository: { list() {} } }), /repositório inválido/);
  assert.throws(() => createCatalogService({ ...base, countUsage: undefined }), /exige \{ countUsage \}/);
  assert.throws(() => createCatalogService({ ...base, countUsage: 5 }), /exige \{ countUsage \}/);
  assert.throws(() => createCatalogService({ ...base, catalog: null }), /dependência catalog/);
  assert.throws(() => createCatalogService({ ...base, catalog: {} }), /não tem a função listItems\(\)/);
  assert.throws(() => createCatalogService({ ...base, now: 'agora' }), /now deve ser uma função/);
  assert.throws(() => createCatalogService(undefined), /exige \{ authorizeOperation \}/);
  assert.ok(createCatalogService(base), 'com tudo certo, o Service existe');
});

test('[CATSVC-3] a tabela de permissões: leitura de ativos = READ:CRM; todo o resto (inclusive ver os desativados) = MANAGE:CRM_CATALOGS', () => {
  assert.deepEqual({ ...PERMISSION_FOR }, {
    list: 'READ:CRM', listInactive: 'MANAGE:CRM_CATALOGS', get: 'READ:CRM',
    create: 'MANAGE:CRM_CATALOGS', update: 'MANAGE:CRM_CATALOGS', activate: 'MANAGE:CRM_CATALOGS', deactivate: 'MANAGE:CRM_CATALOGS', reorder: 'MANAGE:CRM_CATALOGS',
  });
  assert.equal(Object.isFrozen(PERMISSION_FOR), true);
  assert.deepEqual([...AUDIT_FIELDS], ['criadoPorUserId', 'criadoPorNome', 'atualizadoPorUserId', 'atualizadoPorNome']);
});

test('[CATSVC-4] ADMIN faz tudo: cria, lista, consulta, edita, desativa, reativa e reordena nos TRÊS catálogos', async () => {
  const { service } = criar();
  for (const catalogo of CATALOG_KEYS) {
    const a = await service.create(admin(), catalogo, { nome: `Primeiro ${catalogo}` });
    const b = await service.create(admin(), catalogo, { nome: `Segundo ${catalogo}` });
    assert.equal(a.ordem, 0);
    assert.equal(b.ordem, 1);
    assert.equal((await service.list(admin(), catalogo)).length, 2);
    assert.equal((await service.get(admin(), catalogo, a.id)).nome, `Primeiro ${catalogo}`);
    assert.equal((await service.update(admin(), catalogo, a.id, { descricao: 'Texto' })).descricao, 'Texto');
    assert.equal((await service.deactivate(admin(), catalogo, a.id)).ativo, false);
    assert.equal((await service.list(admin(), catalogo, { incluirInativos: true })).length, 2);
    assert.equal((await service.activate(admin(), catalogo, a.id)).ativo, true);
    const nova = await service.reorder(admin(), catalogo, [b.id, a.id]);
    assert.deepEqual(nova.map((item) => item.nome), [`Segundo ${catalogo}`, `Primeiro ${catalogo}`]);
  }
});

test('[CATSVC-5] COMMERCIAL_CLOSER (só READ:CRM) lista e consulta os ATIVOS, e é recusado em TODA operação de gestão — inclusive pedir os desativados', async () => {
  const { service } = criar();
  const item = await service.create(admin(), 'nichos', { nome: 'Estética' });
  assert.equal((await service.list(closer(), 'nichos')).length, 1);
  assert.equal((await service.get(closer(), 'nichos', item.id)).nome, 'Estética');
  for (const chamada of [
    () => service.create(closer(), 'nichos', { nome: 'Outro' }),
    () => service.update(closer(), 'nichos', item.id, { descricao: 'x' }),
    () => service.activate(closer(), 'nichos', item.id),
    () => service.deactivate(closer(), 'nichos', item.id),
    () => service.reorder(closer(), 'nichos', [item.id]),
    () => service.list(closer(), 'nichos', { incluirInativos: true }),
  ]) {
    assert.match((await erroDe(chamada)).message, /acesso negado/);
  }
  assert.equal((await service.list(admin(), 'nichos', { incluirInativos: true })).length, 1, 'nada foi alterado pelas tentativas');
  assert.equal((await service.get(admin(), 'nichos', item.id)).ativo, true);
});

test('[CATSVC-6] usuário INATIVO é recusado em TODAS as operações (leitura inclusive), e um contexto que não foi emitido também', async () => {
  const { service } = criar();
  const item = await service.create(admin(), 'origens', { nome: 'Indicação' });
  const ex = inativo();
  for (const chamada of [
    () => service.list(ex, 'origens'),
    () => service.get(ex, 'origens', item.id),
    () => service.create(ex, 'origens', { nome: 'x' }),
    () => service.update(ex, 'origens', item.id, { descricao: 'x' }),
    () => service.activate(ex, 'origens', item.id),
    () => service.deactivate(ex, 'origens', item.id),
    () => service.reorder(ex, 'origens', [item.id]),
  ]) {
    assert.match((await erroDe(chamada)).message, /usuário inativo/);
  }
  const forjado = { userId: 'x', name: 'x', role: 'ADMIN', permissions: ['MANAGE:CRM_CATALOGS', 'READ:CRM'], status: 'ACTIVE' };
  for (const chamada of [() => service.list(forjado, 'origens'), () => service.create(forjado, 'origens', { nome: 'x' }), () => service.get(null, 'origens', item.id)]) {
    await assert.rejects(chamada, Error);
  }
});

test('[CATSVC-7] a AUTORIZAÇÃO vem ANTES de tudo: sem permissão, nenhuma validação roda e o repositório nem é tocado — mesmo com entrada inválida, catálogo desconhecido ou armazenamento quebrado', async () => {
  const pedidos = [];
  const quebrado = { list: () => { throw new Error('tocou'); }, getById: () => { throw new Error('tocou'); }, insert: () => { throw new Error('tocou'); }, update: () => { throw new Error('tocou'); }, reorder: () => { throw new Error('tocou'); } };
  const { service } = criar({
    repository: quebrado,
    authorizeOperation: (contexto, permissao) => {
      pedidos.push(permissao);
      return authorizeCatalogOperation(contexto, permissao);
    },
  });
  const lixo = { ativo: 'sim', ordem: -1, qualquerCoisa: {} };
  for (const chamada of [
    () => service.create(closer(), 'catalogo-inexistente', lixo),
    () => service.update(closer(), 'catalogo-inexistente', '', lixo),
    () => service.activate(closer(), 'nichos', 12345),
    () => service.deactivate(closer(), 'nichos', null),
    () => service.reorder(closer(), 'nichos', 'lixo'),
    () => service.list(closer(), 'nichos', { incluirInativos: true }),
  ]) {
    assert.match((await erroDe(chamada)).message, /acesso negado/, 'a recusa é de autorização, não de validação nem de armazenamento');
  }
  assert.ok(pedidos.length >= 6);
  assert.ok(pedidos.every((permissao) => ['READ:CRM', 'MANAGE:CRM_CATALOGS'].includes(permissao)));
  // para quem TEM permissão, a validação e o armazenamento passam a valer
  assert.equal((await erroDe(() => service.create(admin(), 'catalogo-inexistente', {}))).code, CATALOG_ERROR.INVALID_INPUT);
  assert.equal((await erroDe(() => service.create(admin(), 'nichos', { nome: 'x' }))).code, CATALOG_ERROR.PERSISTENCE);
});

test('[CATSVC-8] cada operação pede a permissão certa ao autorizador (READ para ler ativos; MANAGE para o resto)', async () => {
  const pedidos = [];
  const { service } = criar({ authorizeOperation: (contexto, permissao) => (pedidos.push(permissao), authorizeCatalogOperation(contexto, permissao)) });
  const a = await service.create(admin(), 'nichos', { nome: 'Estética' });
  const b = await service.create(admin(), 'nichos', { nome: 'Psicologia' });
  // as permissões pedidas durante UMA chamada, na ordem
  const pedidasEm = async (chamada) => {
    pedidos.length = 0;
    await chamada();
    return [...pedidos];
  };
  // ler os ativos EXIGE a leitura, como a primeira permissão pedida; depois o Service só sonda a de gestão para escolher a visão do papel
  // (quem não a tem recebe a visão sem auditoria) — essa sondagem nunca decide uma escrita
  assert.deepEqual(await pedidasEm(() => service.list(admin(), 'nichos')), ['READ:CRM', 'MANAGE:CRM_CATALOGS']);
  assert.deepEqual((await pedidasEm(() => service.get(admin(), 'nichos', a.id))).slice(0, 1), ['READ:CRM']);
  assert.deepEqual(await pedidasEm(() => service.list(closer(), 'nichos')), ['READ:CRM', 'MANAGE:CRM_CATALOGS'], 'o closer passa na leitura e a sondagem de gestão não o autoriza a nada');
  // ver os desativados começa pela leitura e EXIGE também a de gestão
  assert.deepEqual(await pedidasEm(() => service.list(admin(), 'nichos', { incluirInativos: true })), ['READ:CRM', 'MANAGE:CRM_CATALOGS']);
  // toda escrita pede a de gestão, como a PRIMEIRA e única permissão
  assert.deepEqual(await pedidasEm(() => service.create(admin(), 'nichos', { nome: 'Novo' })), ['MANAGE:CRM_CATALOGS']);
  assert.deepEqual(await pedidasEm(() => service.update(admin(), 'nichos', a.id, { descricao: 'x' })), ['MANAGE:CRM_CATALOGS']);
  assert.deepEqual(await pedidasEm(() => service.deactivate(admin(), 'nichos', a.id)), ['MANAGE:CRM_CATALOGS']);
  assert.deepEqual(await pedidasEm(() => service.activate(admin(), 'nichos', a.id)), ['MANAGE:CRM_CATALOGS']);
  // a reordenação exige a lista COMPLETA (ativos e desativados): b, a e o item "Novo"
  const todos = (await service.list(admin(), 'nichos', { incluirInativos: true })).map((item) => item.id);
  assert.equal(todos.length, 3);
  assert.deepEqual(await pedidasEm(() => service.reorder(admin(), 'nichos', [...todos].reverse())), ['MANAGE:CRM_CATALOGS']);
  assert.ok(todos.includes(b.id));
});

test('[CATSVC-9] PROJEÇÃO por papel: o ADMIN recebe todos os campos (inclusive quem criou/alterou); quem só lê não recebe auditoria nem `emUso` — e só os campos conhecidos de cada catálogo, nunca um objeto vivo', async () => {
  const { service } = criar();
  const casos = {
    servicos: { nome: 'Site', categoria: 'Web', precoReferencia: 1500, tipoCobranca: 'UNICA' },
    nichos: { nome: 'Estética', cor: 'azul' },
    origens: { nome: 'Indicação', canal: 'INDICACAO' },
  };
  for (const catalogo of CATALOG_KEYS) {
    const criado = await service.create(admin(), catalogo, casos[catalogo]);
    const esperadosAdmin = [...COMMON_ITEM_FIELDS, ...CATALOG_DEFINITIONS[catalogo].specificFields].sort();
    assert.deepEqual(Object.keys(criado).sort(), esperadosAdmin, `${catalogo}: ADMIN`);
    assert.equal(criado.criadoPorUserId, 'user-admin-promo');
    assert.equal(criado.criadoPorNome, 'Administrador da Promoção');

    const lidoPeloCloser = await service.get(closer(), catalogo, criado.id);
    assert.deepEqual(Object.keys(lidoPeloCloser).sort(), esperadosAdmin.filter((campo) => !AUDIT_FIELDS.includes(campo)), `${catalogo}: quem só lê`);
    assert.equal('emUso' in lidoPeloCloser, false);
    const [naLista] = await service.list(closer(), catalogo);
    assert.deepEqual(naLista, lidoPeloCloser);
    // o administrador recebe `emUso` na consulta de um item
    assert.equal((await service.get(admin(), catalogo, criado.id)).emUso, 0);
    // alterar o que foi devolvido não altera o armazenado
    lidoPeloCloser.nome = 'Adulterado';
    assert.equal((await service.get(closer(), catalogo, criado.id)).nome, casos[catalogo].nome);
  }
});

test('[CATSVC-10] DESATIVADOS: somem das listas e da consulta de quem só lê (para ele "não existe": 404), e só o administrador os vê — pelo parâmetro explícito', async () => {
  const { service } = criar();
  const a = await service.create(admin(), 'nichos', { nome: 'Ativo' });
  const b = await service.create(admin(), 'nichos', { nome: 'Desativado' });
  await service.deactivate(admin(), 'nichos', b.id);
  assert.deepEqual((await service.list(closer(), 'nichos')).map((i) => i.nome), ['Ativo']);
  assert.deepEqual((await service.list(admin(), 'nichos')).map((i) => i.nome), ['Ativo'], 'o padrão do ADMIN também é só ativos');
  assert.deepEqual((await service.list(admin(), 'nichos', { incluirInativos: true })).map((i) => i.nome), ['Ativo', 'Desativado']);
  assert.deepEqual((await service.list(admin(), 'nichos', { incluirInativos: false })).map((i) => i.nome), ['Ativo']);
  assert.equal((await erroDe(() => service.get(closer(), 'nichos', b.id))).code, CATALOG_ERROR.NOT_FOUND);
  assert.equal((await service.get(admin(), 'nichos', b.id)).ativo, false);
  assert.equal((await service.get(closer(), 'nichos', a.id)).ativo, true);
  assert.equal((await erroDe(() => service.get(closer(), 'nichos', 'niche:inexistente'))).code, CATALOG_ERROR.NOT_FOUND);
  assert.equal((await erroDe(() => service.get(admin(), 'nichos', 'niche:inexistente'))).code, CATALOG_ERROR.NOT_FOUND);
});

test('[CATSVC-11] as OPÇÕES de listagem são estritas: só { incluirInativos: boolean }; uma chave desconhecida ou um valor que não é booleano é erro de entrada', async () => {
  const { service } = criar();
  for (const ruim of [{ todos: true }, { incluirInativos: 'true' }, { incluirInativos: 1 }, { incluirInativos: null }, 'texto', 5, [], { incluirInativos: true, extra: 1 }]) {
    const erro = await erroDe(() => service.list(admin(), 'nichos', ruim));
    assert.equal(erro.code, CATALOG_ERROR.INVALID_INPUT, JSON.stringify(ruim));
  }
  assert.equal((await service.list(admin(), 'nichos', undefined)).length, 0);
  assert.equal((await service.list(admin(), 'nichos', null)).length, 0);
  assert.equal((await service.list(admin(), 'nichos', {})).length, 0);
  assert.equal((await erroDe(() => service.list(admin(), 'clientes'))).code, CATALOG_ERROR.INVALID_INPUT, 'catálogo desconhecido');
});

test('[CATSVC-12] A IDENTIDADE DO AUTOR vem só do autorizador: o corpo nunca escolhe quem criou ou alterou — e tentar mandar esses campos é recusado', async () => {
  const { service } = criar();
  const item = await service.create(admin(), 'origens', { nome: 'Indicação' });
  assert.equal(item.criadoPorUserId, 'user-admin-promo');
  assert.equal(item.atualizadoPorNome, 'Administrador da Promoção');
  for (const campo of ['criadoPorUserId', 'criadoPorNome', 'atualizadoPorUserId', 'atualizadoPorNome', 'userId', 'role', 'permissions', 'reviewedBy', 'actor']) {
    const erro = await erroDe(() => service.create(admin(), 'origens', { nome: `Outro ${campo}`, [campo]: 'Impostor' }));
    assert.equal(erro.code, CATALOG_ERROR.INVALID_INPUT, campo);
    const edicao = await erroDe(() => service.update(admin(), 'origens', item.id, { [campo]: 'Impostor' }));
    assert.equal(edicao.code, CATALOG_ERROR.INVALID_INPUT, campo);
  }
  assert.equal((await service.list(admin(), 'origens')).length, 1, 'nada foi criado pelas tentativas');
});

test('[CATSVC-13] TRAVA DE RENOMEAÇÃO: com uso no CRM legado o nome não muda (NAME_IN_USE) e o resto da edição segue livre; sem uso, renomear funciona; o contador só é consultado quando o nome PODE mudar', async () => {
  const chamadas = [];
  let uso = 2;
  const { service } = criar({ countUsage: async (catalogo, item) => (chamadas.push([catalogo, item.nome, Object.keys(item).includes('emUso')]), uso) });
  const item = await service.create(admin(), 'nichos', { nome: 'Estética', cor: 'rosa' });
  chamadas.length = 0;

  const erro = await erroDe(() => service.update(admin(), 'nichos', item.id, { nome: 'Beleza' }));
  assert.equal(erro.code, CATALOG_ERROR.NAME_IN_USE);
  assert.deepEqual(chamadas, [['nichos', 'Estética', false]], 'o contador recebeu o catálogo e uma CÓPIA do item atual');
  assert.equal((await service.get(admin(), 'nichos', item.id)).nome, 'Estética', 'o nome não mudou');

  chamadas.length = 0;
  const livre = await service.update(admin(), 'nichos', item.id, { descricao: 'Nova', cor: 'azul' });
  assert.equal(livre.descricao, 'Nova');
  assert.deepEqual(chamadas, [], 'sem `nome` no patch, o uso nem é consultado');

  uso = 0;
  const renomeado = await service.update(admin(), 'nichos', item.id, { nome: 'Beleza' });
  assert.equal(renomeado.nome, 'Beleza');
  assert.equal(renomeado.id, item.id, 'o identificador não muda com o nome');

  // um `nome` que não é texto não gasta contagem (o domínio o recusa)
  chamadas.length = 0;
  assert.equal((await erroDe(() => service.update(admin(), 'nichos', item.id, { nome: 12 }))).code, CATALOG_ERROR.INVALID_INPUT);
  assert.deepEqual(chamadas, []);
  // um id inexistente: não conta uso e devolve 404
  assert.equal((await erroDe(() => service.update(admin(), 'nichos', 'niche:inexistente', { nome: 'x' }))).code, CATALOG_ERROR.NOT_FOUND);
  assert.deepEqual(chamadas, []);
});

test('[CATSVC-14] FALHA FECHADA do contador: se contar o uso falha (exceção, rejeição, número inválido), a renomeação é RECUSADA com erro de armazenamento — nunca "na dúvida, deixa"; as demais edições seguem', async () => {
  const modos = {
    lanca: async () => { throw new Error('crm indisponível SEGREDO'); },
    sincrono: () => { throw new Error('boom SEGREDO'); },
    negativo: async () => -1,
    fracionario: async () => 1.5,
    texto: async () => '2',
    nulo: async () => null,
    indefinido: async () => undefined,
    nan: async () => Number.NaN,
  };
  for (const [nome, countUsage] of Object.entries(modos)) {
    const { service } = criar({ countUsage });
    const item = await service.create(admin(), 'servicos', { nome: 'Site' });
    const erro = await erroDe(() => service.update(admin(), 'servicos', item.id, { nome: 'Site novo' }));
    assert.equal(erro.code, CATALOG_ERROR.PERSISTENCE, nome);
    assert.equal(erro.message, 'Cadastro: não foi possível verificar o uso do item.', nome);
    assert.doesNotMatch(erro.message, /SEGREDO/);
    assert.equal((await service.get(admin(), 'servicos', item.id)).nome, 'Site', `${nome}: o nome não mudou`);
    assert.equal((await service.update(admin(), 'servicos', item.id, { descricao: 'continua livre' })).descricao, 'continua livre', nome);
    // na consulta, um contador quebrado vira `emUso: null` (desconhecido) — nunca um 0 inventado
    assert.equal((await service.get(admin(), 'servicos', item.id)).emUso, null, nome);
  }
});

test('[CATSVC-15] `emUso` na consulta do administrador é o número que o contador devolveu (por item e por catálogo); quem só lê nunca recebe a chave', async () => {
  const usos = { 'Estética': 3, 'Site': 0 };
  const { service } = criar({ countUsage: async (catalogo, item) => (item.nome in usos ? usos[item.nome] : 9) });
  const nicho = await service.create(admin(), 'nichos', { nome: 'Estética' });
  const servico = await service.create(admin(), 'servicos', { nome: 'Site' });
  assert.equal((await service.get(admin(), 'nichos', nicho.id)).emUso, 3);
  assert.equal((await service.get(admin(), 'servicos', servico.id)).emUso, 0);
  assert.equal('emUso' in (await service.get(closer(), 'nichos', nicho.id)), false);
  assert.equal('emUso' in (await service.list(admin(), 'nichos'))[0], false, 'a listagem não paga o custo de contar o uso de cada item');
});

test('[CATSVC-16] os erros do DOMÍNIO passam INTACTOS (mesmo código e detalhes): duplicidade, entrada inválida, item inexistente, lista de reordenação inválida', async () => {
  const { service } = criar();
  const a = await service.create(admin(), 'nichos', { nome: 'Estética' });
  assert.equal((await erroDe(() => service.create(admin(), 'nichos', { nome: 'ESTETICA' }))).code, CATALOG_ERROR.DUPLICATE_NAME);
  const invalido = await erroDe(() => service.create(admin(), 'nichos', { nome: '', cor: 'preto' }));
  assert.equal(invalido.code, CATALOG_ERROR.INVALID_INPUT);
  assert.deepEqual(invalido.details.errors.map((e) => `${e.path}:${e.code}`).sort(), ['cor:VALOR_INVALIDO', 'nome:OBRIGATORIO']);
  assert.equal((await erroDe(() => service.activate(admin(), 'nichos', 'niche:nao-existe'))).code, CATALOG_ERROR.NOT_FOUND);
  assert.equal((await erroDe(() => service.reorder(admin(), 'nichos', [a.id, 'niche:x']))).code, CATALOG_ERROR.INVALID_INPUT);
  assert.equal((await erroDe(() => service.reorder(admin(), 'nichos', undefined))).code, CATALOG_ERROR.INVALID_INPUT);
});

test('[CATSVC-17] um AUTORIZADOR defeituoso falha fechado: devolver uma Promise, uma identidade incompleta ou com campos a mais, ou lançar, nunca autoriza nem toca o armazenamento', async () => {
  const defeitos = {
    promessa: () => Promise.resolve({ userId: 'u', name: 'n', role: 'ADMIN' }),
    vazio: () => ({}),
    aMenos: () => ({ userId: 'u', name: 'n' }),
    aMais: () => ({ userId: 'u', name: 'n', role: 'ADMIN', permissions: ['MANAGE:CRM_CATALOGS'] }),
    textoVazio: () => ({ userId: ' ', name: 'n', role: 'ADMIN' }),
    tipoErrado: () => ({ userId: 5, name: 'n', role: 'ADMIN' }),
    nulo: () => null,
    verdadeiro: () => true,
    lanca: () => { throw new Error('acesso negado'); },
  };
  for (const [nome, authorizeOperation] of Object.entries(defeitos)) {
    const repository = createInMemoryCatalogRepository();
    const { service } = criar({ authorizeOperation, repository });
    await assert.rejects(() => service.create(admin(), 'nichos', { nome: 'x' }), Error, nome);
    await assert.rejects(() => service.list(admin(), 'nichos'), Error, nome);
    assert.deepEqual(repository.list('nichos'), [], `${nome}: nada gravado`);
  }
});

test('[CATSVC-18] FALHA DE ARMAZENAMENTO vira CRM_CATALOG_PERSISTENCE com mensagem fixa em toda operação (a causa nunca vai para quem chama)', async () => {
  const quebrado = { list: () => { throw new Error('SEGREDO-1'); }, getById: () => { throw new Error('SEGREDO-2'); }, insert: () => { throw new Error('SEGREDO-3'); }, update: () => { throw new Error('SEGREDO-4'); }, reorder: () => { throw new Error('SEGREDO-5'); } };
  const { service } = criar({ repository: quebrado });
  for (const chamada of [
    () => service.list(admin(), 'nichos'),
    () => service.get(admin(), 'nichos', 'niche:x'),
    () => service.create(admin(), 'nichos', { nome: 'x' }),
    () => service.update(admin(), 'nichos', 'niche:x', { descricao: 'x' }),
    () => service.deactivate(admin(), 'nichos', 'niche:x'),
    () => service.reorder(admin(), 'nichos', []),
  ]) {
    const erro = await erroDe(chamada);
    assert.equal(erro.code, CATALOG_ERROR.PERSISTENCE);
    assert.doesNotMatch(erro.message, /SEGREDO/);
  }
});

test('[CATSVC-19] NÃO INTERFERE no resto do sistema: o Service importa só o domínio dos catálogos e a autorização — nunca o CRM Service, a promoção, a prospecção nem a Fila de Aprovação', () => {
  const arquivo = 'src/services/catalogService.js';
  const analise = analyzeSource(fs.readFileSync(path.join(__dirname, '..', '..', arquivo), 'utf8'), arquivo);
  assert.deepEqual(analise.issues, []);
  assert.deepEqual(analise.refs.map((ref) => ref.specifier).sort(), ['../auth', '../crm/catalogConstants', '../crm/catalogDomain', '../crm/catalogDomain', '../crm/catalogRepositoryPort']);
  const codigo = fs.readFileSync(path.join(__dirname, '..', '..', arquivo), 'utf8').replace(/\/\/.*$/gm, '');
  for (const proibido of ['crmService', 'crmDomain', 'crmRepository', 'crmIntegration', 'approvalQueue', 'prospecting', 'valorProposta', 'valorTotal']) {
    assert.equal(codigo.includes(proibido), false, `o Service não pode citar ${proibido}`);
  }
});
