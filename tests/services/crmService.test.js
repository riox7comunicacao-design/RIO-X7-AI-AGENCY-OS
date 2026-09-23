// CRM Service — a fronteira de aplicação do CRM operacional (decisões 0012, 0013 e 0014).
//
//   CONSUMIDOR -> SERVICE -> DOMÍNIO (src/crm) -> porta de persistência -> adapter
//
// O que estes testes protegem: o Service é a ÚNICA camada de autorização do CRM. Ele autoriza (READ:CRM nas leituras,
// WRITE:CRM nas escritas — decidido pelo autorizador injetado, aqui a ponte REAL de src/auth) ANTES de qualquer outra
// coisa e antes de tocar na persistência; só aceita um AuthorizationContext emitido, nunca userId/role/permissions/
// reviewedBy do consumidor; deixa TODAS as regras de negócio (status, DNC, deduplicação, histórico) para o domínio,
// sem cópia; grava no histórico só a identidade que o AUTORIZADOR devolveu; e devolve projeções seguras, nunca objetos
// vivos nem campos que o domínio não declarou.
//
// Isolamento: o domínio é o REAL e a ponte de autorização é a REAL (src/auth). Os repositórios são reais (memória e
// arquivo TEMPORÁRIO, removido ao fim do teste); os "doubles" existem só onde não há outro jeito de provar o ponto e
// nenhum esconde a lógica principal: um repositório que DELEGA ao real e só registra as chamadas (prova de "nada foi
// tocado"), um domínio observador que DELEGA ao real e só registra os argumentos (prova do que o Service passa),
// autorizadores defeituosos/permissivos e uma falha de gravação simulada.
//
// Determinístico e sem rede. Nenhum dado real: tudo em example.test. As marcas de contexto são uma fronteira
// arquitetural interna confiável, NÃO criptografia.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crmDomain = require('../../src/crm/crmDomain');
const { createInMemoryCrmRepository, createJsonFileCrmRepository, CRM_STATUS, CRM_WRITABLE_FIELDS, ACTOR } = require('../../src/crm');
const { createCrmService } = require('../../src/services/crmService');
const { ROLE, USER_STATUS, PERMISSION, defineUser, authorizeCrmOperation } = require('../../src/auth');
const constants = require('../../src/auth/constants');
const { createAuthorizationContext } = require('../helpers/authFixtures');
const { analyzeSource } = require('../helpers/staticImports');

const SERVICE_SOURCE = path.join(__dirname, '..', '..', 'src', 'services', 'crmService.js');
const READ = PERMISSION.READ_CRM;
const WRITE = PERMISSION.WRITE_CRM;

// ---------------------------------------------------------------------------
// Fixtures (fictícias) — usuários e contextos REAIS, emitidos pelo emissor interno a partir de um USER definido
// ---------------------------------------------------------------------------
const ADMIN_USER = { userId: 'user-admin-crm', authUserId: 'auth-admin-crm', name: 'Administrador do CRM', email: 'admin-crm@example.test', role: ROLE.ADMIN };
const CLOSER_USER = { userId: 'user-closer-crm', authUserId: 'auth-closer-crm', name: 'Closer do CRM', email: 'closer-crm@example.test', role: ROLE.COMMERCIAL_CLOSER };
const usuario = (base, overrides = {}) => defineUser({ ...base, status: USER_STATUS.ACTIVE, ...overrides });
const admin = (overrides) => createAuthorizationContext(usuario(ADMIN_USER, overrides));
const closer = (overrides) => createAuthorizationContext(usuario(CLOSER_USER, overrides));
const inativo = (base) => createAuthorizationContext(usuario(base, { status: USER_STATUS.INACTIVE }));

const OPERADOR_ADMIN = { userId: ADMIN_USER.userId, name: ADMIN_USER.name, role: ROLE.ADMIN };

// O Service de produção: domínio real, autorizador real (a ponte de src/auth), repositório injetado.
const criarServico = (repository, extras = {}) => createCrmService({ authorizeOperation: authorizeCrmOperation, repository, ...extras });

// Semeia um registro pelo próprio Service (ADMIN) e devolve o id.
const semear = (servico, campos = { empresa: 'Semente Ltda', site: 'semente.example.test' }) => servico.createRecord(admin(), campos).record.id;

// Um repositório que DELEGA ao real e só registra as chamadas — para provar o que foi (ou não) tocado.
function repositorioObservado(interno = createInMemoryCrmRepository()) {
  const chamadas = [];
  return {
    chamadas,
    interno,
    list() {
      chamadas.push('list');
      return interno.list();
    },
    getById(id) {
      chamadas.push('getById');
      return interno.getById(id);
    },
    save(registro) {
      chamadas.push('save');
      return interno.save(registro);
    },
  };
}
const gravacoes = (repo) => repo.chamadas.filter((chamada) => chamada === 'save').length;

// Um domínio observador: DELEGA ao domínio real e só registra [nome, argumentos].
function dominioObservado(chamadas) {
  const registrar = (nome) => (...args) => {
    chamadas.push([nome, args]);
    return crmDomain[nome](...args);
  };
  return {
    createRecord: registrar('createRecord'),
    getRecord: registrar('getRecord'),
    listRecords: registrar('listRecords'),
    updateRecord: registrar('updateRecord'),
    moveStatus: registrar('moveStatus'),
    markDoNotContact: registrar('markDoNotContact'),
  };
}

// As 7 operações do Service, com argumentos típicos — para exercitar todas de uma vez. `permissao`: a que cada uma exige.
const operacoes = (servico, id) => [
  ['listRecords', READ, (ctx) => servico.listRecords(ctx)],
  ['getRecord', READ, (ctx) => servico.getRecord(ctx, id)],
  ['getHistory', READ, (ctx) => servico.getHistory(ctx, id)],
  ['createRecord', WRITE, (ctx) => servico.createRecord(ctx, { empresa: 'Nova Empresa', site: 'nova.example.test' })],
  ['updateRecord', WRITE, (ctx) => servico.updateRecord(ctx, id, { observacoes: 'nota' })],
  ['moveStatus', WRITE, (ctx) => servico.moveStatus(ctx, id, CRM_STATUS.RESEARCH)],
  ['markDoNotContact', WRITE, (ctx) => servico.markDoNotContact(ctx, id)],
];

// Contextos que NÃO são um AuthorizationContext emitido: a antiga identidade simples, literais, cópias, clones e
// não-objetos — nenhum pode atravessar a fronteira.
function contextosNaoEmitidos() {
  const legitimo = admin();
  const simples = { userId: legitimo.userId, name: legitimo.name, role: legitimo.role, permissions: [...legitimo.permissions] };
  const literal = { ...simples, authUserId: legitimo.authUserId, status: legitimo.status };
  return [
    ['texto livre', 'Breno'],
    ['um userId solto', legitimo.userId],
    ['número', 42],
    ['null', null],
    ['undefined', undefined],
    ['lista', []],
    ['função', () => legitimo],
    ['objeto vazio', {}],
    ['identidade simples { userId, name, role, permissions }', simples],
    ['identidade simples congelada', Object.freeze({ ...simples, permissions: Object.freeze([...simples.permissions]) })],
    ['literal com a forma perfeita de um contexto, congelado', Object.freeze({ ...literal, permissions: Object.freeze([...literal.permissions]) })],
    ['cópia rasa de um contexto real', { ...legitimo }],
    ['structuredClone de um contexto real', structuredClone(legitimo)],
    ['clone via JSON de um contexto real', JSON.parse(JSON.stringify(legitimo))],
    ['Object.create(contexto real)', Object.create(legitimo)],
    ['Proxy(contexto real)', new Proxy(legitimo, {})],
  ];
}

// Executa `fn` e devolve o erro lançado (ou null).
function erroDe(fn) {
  try {
    fn();
  } catch (erro) {
    return erro;
  }
  return null;
}

function arquivoTemporario(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'crm.json');
}

// ===========================================================================
// 1) Composição — o que o Service exige para existir, e o que ele expõe
// ===========================================================================
test('[CRM-SVC-1] o Service expõe exatamente as 7 operações, congelado — e nada do repositório, do domínio ou do autorizador', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  assert.deepEqual(Object.keys(servico).sort(), ['createRecord', 'getHistory', 'getRecord', 'listRecords', 'markDoNotContact', 'moveStatus', 'updateRecord']);
  assert.ok(Object.isFrozen(servico), 'o Service não pode ser alterado depois de criado');
  for (const interno of ['repository', 'crm', 'authorizeOperation', 'authorize', 'domain', 'save', 'list', 'getById', 'deleteRecord', 'removeRecord']) {
    assert.equal(servico[interno], undefined, `${interno} não pode ser exposto`);
  }
});

test('[CRM-SVC-2] sem autorizador injetado o Service não existe: ausente, não-função e função async são recusados na criação', () => {
  const repository = createInMemoryCrmRepository();
  for (const ruim of [undefined, null, 'ponte', {}, [], 42]) {
    assert.match(erroDe(() => createCrmService({ authorizeOperation: ruim, repository })).message, /exige \{ authorizeOperation \}/, String(ruim));
  }
  assert.match(erroDe(() => createCrmService({ authorizeOperation: async () => ({}), repository })).message, /síncrono/);
  assert.match(erroDe(() => createCrmService()).message, /exige \{ authorizeOperation \}/);
  assert.match(erroDe(() => createCrmService(null)).message, /exige \{ authorizeOperation \}/);
});

test('[CRM-SVC-3] sem repositório válido o Service não existe: o Service NUNCA escolhe um adapter (sem padrão, sem arquivo), e uma porta assíncrona é recusada', () => {
  for (const ausente of [undefined, null]) {
    assert.match(erroDe(() => createCrmService({ authorizeOperation: authorizeCrmOperation, repository: ausente })).message, /exige \{ repository \}/);
  }
  assert.match(erroDe(() => createCrmService({ authorizeOperation: authorizeCrmOperation })).message, /exige \{ repository \}/);
  for (const invalido of ['arquivo.json', 42, [], {}, { list: () => [] }, { list() {}, getById() {} }]) {
    assert.ok(erroDe(() => criarServico(invalido)), `${JSON.stringify(invalido)} deveria ser recusado`);
  }
  assert.match(erroDe(() => criarServico({ list: async () => [], getById: () => null, save: () => {} })).message, /list\(\) é assíncrono/);
});

test('[CRM-SVC-4] um domínio incompleto injetado falha na criação, nomeando a função que falta — nunca no meio de uma operação', () => {
  for (const funcao of ['createRecord', 'getRecord', 'listRecords', 'updateRecord', 'moveStatus', 'markDoNotContact']) {
    const incompleto = { ...crmDomain };
    delete incompleto[funcao];
    assert.match(erroDe(() => criarServico(createInMemoryCrmRepository(), { crm: incompleto })).message, new RegExp(`não tem a função ${funcao}\\(\\)`));
  }
  assert.match(erroDe(() => criarServico(createInMemoryCrmRepository(), { crm: 'domínio' })).message, /deve ser o domínio do CRM/);
});

test('[CRM-SVC-5] as funções do domínio ficam CAPTURADAS na criação: substituir uma delas no objeto injetado depois não muda o Service', () => {
  const chamadas = [];
  const dominio = dominioObservado(chamadas);
  const servico = criarServico(createInMemoryCrmRepository(), { crm: dominio });
  dominio.createRecord = () => {
    throw new Error('substituída depois da criação — nunca deveria ser chamada');
  };
  assert.doesNotThrow(() => servico.createRecord(admin(), { empresa: 'Capturada Ltda' }));
  assert.equal(chamadas.filter(([nome]) => nome === 'createRecord').length, 1);
});

test('[CRM-SVC-6] o Service depende só do contrato: um repositório PRÓPRIO (nem memória, nem arquivo) que satisfaça { list, getById, save } funciona igual', () => {
  const guardados = new Map();
  const repositorioProprio = {
    list: () => [...guardados.values()].map((registro) => structuredClone(registro)),
    getById: (id) => (guardados.has(id) ? structuredClone(guardados.get(id)) : null),
    save: (registro) => void guardados.set(registro.id, structuredClone(registro)),
  };
  const servico = criarServico(repositorioProprio);
  const id = semear(servico);
  assert.equal(servico.getRecord(closer(), id).empresa, 'Semente Ltda');
  assert.equal(servico.moveStatus(admin(), id, CRM_STATUS.RESEARCH).status, CRM_STATUS.RESEARCH);
  assert.equal(guardados.get(id).status, CRM_STATUS.RESEARCH, 'gravou no repositório INJETADO');
});

test('[CRM-SVC-7] o código do Service não conhece adapter nem disco: só importa o domínio, a porta, as constantes e a autenticação — nunca fs, crmRepository, servidor ou dashboard', () => {
  const codigo = fs.readFileSync(SERVICE_SOURCE, 'utf8');
  const analise = analyzeSource(codigo, 'src/services/crmService.js');
  assert.deepEqual(analise.issues, []);
  assert.deepEqual(
    analise.refs.map((ref) => ref.specifier).sort(),
    ['../auth', '../crm/constants', '../crm/crmDomain', '../crm/crmRepositoryPort'],
    'a lista de importações do Service é fechada'
  );
  const identificadores = new Set(analise.tokens.filter((token) => token.type === 'id').map((token) => token.value));
  for (const proibido of ['createJsonFileCrmRepository', 'createInMemoryCrmRepository', 'readFileSync', 'writeFileSync', 'fetch', 'eval', 'Function']) {
    assert.equal(identificadores.has(proibido), false, `o Service não pode usar ${proibido}`);
  }
});

// ===========================================================================
// 2) Autorização — quem pode o quê (READ:CRM x WRITE:CRM), decidido pelo autorizador injetado
// ===========================================================================
test('[CRM-SVC-8] cada operação pede ao autorizador EXATAMENTE a permissão certa (READ:CRM ou WRITE:CRM), uma vez, com o contexto recebido', () => {
  const chamadas = [];
  const observado = (context, permission) => {
    chamadas.push([context, permission]);
    return authorizeCrmOperation(context, permission);
  };
  const servico = criarServico(createInMemoryCrmRepository(), { authorizeOperation: observado });
  const id = semear(servico);
  for (const [nome, permissao, executar] of operacoes(servico, id)) {
    chamadas.length = 0;
    const ctx = admin();
    executar(ctx);
    assert.equal(chamadas.length, 1, `${nome}: o autorizador é consultado uma única vez`);
    assert.equal(chamadas[0][1], permissao, `${nome}: pede ${permissao}`);
    assert.equal(chamadas[0][0], ctx, `${nome}: recebe o MESMO contexto que o consumidor passou`);
  }
});

test('[CRM-SVC-9] ADMIN executa as 7 operações (escrita e leitura)', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  const id = semear(servico);
  for (const [nome, , executar] of operacoes(servico, id)) {
    assert.doesNotThrow(() => executar(admin()), nome);
  }
});

test('[CRM-SVC-10] COMMERCIAL_CLOSER LÊ (as 3 leituras), mas NÃO escreve: as 4 escritas são recusadas com "acesso negado" e a persistência não é tocada', () => {
  const inicial = createInMemoryCrmRepository();
  const id = semear(criarServico(inicial));
  const repo = repositorioObservado(inicial);
  const servico = criarServico(repo);

  for (const [nome, permissao, executar] of operacoes(servico, id)) {
    repo.chamadas.length = 0;
    if (permissao === READ) {
      assert.doesNotThrow(() => executar(closer()), `${nome}: o closer lê`);
    } else {
      const erro = erroDe(() => executar(closer()));
      assert.ok(erro, `${nome}: o closer NÃO escreve`);
      assert.match(erro.message, /acesso negado/, nome);
      assert.match(erro.message, /WRITE:CRM/, nome);
      assert.deepEqual(repo.chamadas, [], `${nome}: recusado antes de tocar a persistência`);
    }
  }
  assert.equal(inicial.getById(id).status, CRM_STATUS.PROSPECT, 'nada mudou no registro');
  assert.equal(inicial.getById(id).observacoes, null);
});

test('[CRM-SVC-11] um usuário INACTIVE é recusado em TODAS as 7 operações, ADMIN ou CLOSER, sem tocar a persistência', () => {
  const inicial = createInMemoryCrmRepository();
  const id = semear(criarServico(inicial));
  for (const base of [ADMIN_USER, CLOSER_USER]) {
    const repo = repositorioObservado(inicial);
    const servico = criarServico(repo);
    for (const [nome, , executar] of operacoes(servico, id)) {
      const erro = erroDe(() => executar(inativo(base)));
      assert.ok(erro, `${base.role} inativo: ${nome}`);
      assert.match(erro.message, /usuário inativo/, `${base.role}: ${nome}`);
    }
    assert.deepEqual(repo.chamadas, [], `${base.role} inativo: a persistência não foi tocada`);
  }
});

test('[CRM-SVC-12] só um AuthorizationContext EMITIDO atravessa: contexto forjado, cópia, clone, identidade simples e não-objetos são recusados em TODAS as operações, sem tocar a persistência', () => {
  const inicial = createInMemoryCrmRepository();
  const id = semear(criarServico(inicial));
  const repo = repositorioObservado(inicial);
  const servico = criarServico(repo);
  for (const [descricao, falso] of contextosNaoEmitidos()) {
    for (const [nome, , executar] of operacoes(servico, id)) {
      assert.ok(erroDe(() => executar(falso)), `${descricao} deveria ser recusado em ${nome}`);
    }
  }
  assert.deepEqual(repo.chamadas, [], 'nenhum contexto falso chegou perto da persistência');
  assert.equal(inicial.list().length, 1, 'nenhum registro foi criado');
});

test('[CRM-SVC-13] a autorização vem ANTES da validação da entrada: quem não pode escrever recebe "acesso negado", nunca uma pista sobre o formato esperado', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  const id = semear(servico);
  const lixo = [
    () => servico.createRecord(closer(), 'lixo', { opcaoInventada: 1 }),
    () => servico.updateRecord(closer(), 42, [1, 2, 3]),
    () => servico.moveStatus(closer(), {}, 999),
    () => servico.markDoNotContact(closer(), null, 'texto'),
    () => servico.getRecord(inativo(CLOSER_USER), {}),
    () => servico.listRecords(closer({ status: USER_STATUS.INACTIVE }), 'lixo'),
    () => servico.getHistory('forjado', id),
  ];
  for (const chamar of lixo) {
    const erro = erroDe(chamar);
    assert.ok(erro);
    assert.match(erro.message, /acesso negado|usuário inativo|AuthorizationContext inválido/);
    assert.doesNotMatch(erro.message, /deve ser um|opções/);
  }
});

test('[CRM-SVC-14] ROLE != PERMISSION: um contexto com a role ADMIN mas só READ:CRM não escreve; e um sem nenhuma permissão de CRM não lê — a decisão é sempre das permissions do contexto', (t) => {
  const inicial = createInMemoryCrmRepository();
  const id = semear(criarServico(inicial));
  const servico = criarServico(inicial);

  const derivacao = t.mock.method(constants, 'getRolePermissions', () => Object.freeze([READ]));
  const adminSoLeitura = admin();
  assert.equal(adminSoLeitura.role, ROLE.ADMIN);
  assert.doesNotThrow(() => servico.getRecord(adminSoLeitura, id));
  for (const [nome, permissao, executar] of operacoes(servico, id)) {
    if (permissao === WRITE) assert.match(erroDe(() => executar(adminSoLeitura)).message, /acesso negado/, nome);
  }

  derivacao.mock.restore();
  t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.MANAGE_USERS]));
  const adminSemCrm = admin();
  for (const [nome, , executar] of operacoes(servico, id)) {
    assert.match(erroDe(() => executar(adminSemCrm)).message, /acesso negado/, `${nome}: sem permissão de CRM nem a leitura passa`);
  }
});

// ===========================================================================
// 3) Escalada de privilégio e identidade vinda do consumidor
// ===========================================================================
test('[CRM-SVC-15] userId/role/permissions/reviewedBy/authUserId/actor NUNCA são aceitos do consumidor: nem nos campos, nem nas opções — recusados, sem gravar nada', () => {
  const inicial = createInMemoryCrmRepository();
  const id = semear(criarServico(inicial));
  const repo = repositorioObservado(inicial);
  const servico = criarServico(repo);
  const antes = JSON.stringify(inicial.list());

  const injetados = { userId: 'user-atacante', role: ROLE.ADMIN, permissions: [WRITE], reviewedBy: { userId: 'x', name: 'x', role: 'ADMIN' }, authUserId: 'auth-atacante', actor: 'SYSTEM' };
  for (const [campo, valor] of Object.entries(injetados)) {
    // Sempre um contexto que PODERIA escrever (ADMIN): a recusa tem que ser da ENTRADA, nunca da autorização.
    const alvo = admin();
    assert.match(erroDe(() => servico.createRecord(alvo, { empresa: 'Injetada', [campo]: valor })).message, /campos desconhecidos/, `createRecord campo ${campo}`);
    assert.match(erroDe(() => servico.updateRecord(alvo, id, { [campo]: valor })).message, /campos desconhecidos/, `updateRecord campo ${campo}`);
    assert.match(erroDe(() => servico.createRecord(alvo, { empresa: 'Injetada' }, { [campo]: valor })).message, /opções não reconhecidas/, `createRecord opção ${campo}`);
    assert.match(erroDe(() => servico.moveStatus(alvo, id, CRM_STATUS.RESEARCH, { [campo]: valor })).message, /opções não reconhecidas/, `moveStatus opção ${campo}`);
    assert.match(erroDe(() => servico.markDoNotContact(alvo, id, { [campo]: valor })).message, /opções não reconhecidas/, `markDoNotContact opção ${campo}`);
  }
  assert.equal(JSON.stringify(inicial.list()), antes, 'nada foi gravado por nenhuma tentativa');
  assert.equal(gravacoes(repo), 0);

  // Leituras também não aceitam opções (nenhuma é conhecida): identidade na "consulta" é recusada.
  for (const campo of Object.keys(injetados)) {
    assert.match(erroDe(() => servico.listRecords(admin(), { [campo]: injetados[campo] })).message, /opções não reconhecidas/, `listRecords ${campo}`);
  }
});

test('[CRM-SVC-16] o `reviewedBy` e o `actor` do histórico vêm SÓ do autorizador: o operador autenticado, nunca um valor do consumidor — e o domínio recebe exatamente { actor, reviewedBy, motivo } (mais `status` só se pedido)', () => {
  const chamadas = [];
  const servico = criarServico(createInMemoryCrmRepository(), { crm: dominioObservado(chamadas) });
  const ctx = admin();
  const { record } = servico.createRecord(ctx, { empresa: 'Auditada Ltda' }, { status: CRM_STATUS.RESEARCH, reason: '  primeiro contato  ' });
  servico.moveStatus(ctx, record.id, CRM_STATUS.CONTACTED, { reason: 'ligou' });
  servico.markDoNotContact(ctx, record.id);

  const [criar, mover, bloquear] = chamadas.filter(([nome]) => ['createRecord', 'moveStatus', 'markDoNotContact'].includes(nome));
  assert.deepEqual(Object.keys(criar[1][2]).sort(), ['actor', 'motivo', 'reviewedBy', 'status']);
  assert.deepEqual(criar[1][2], { status: CRM_STATUS.RESEARCH, actor: ACTOR.HUMAN, reviewedBy: OPERADOR_ADMIN, motivo: 'primeiro contato' });
  assert.deepEqual(Object.keys(mover[1][3]).sort(), ['actor', 'motivo', 'reviewedBy']);
  assert.deepEqual(mover[1][3], { actor: ACTOR.HUMAN, reviewedBy: OPERADOR_ADMIN, motivo: 'ligou' });
  assert.deepEqual(bloquear[1][2], { actor: ACTOR.HUMAN, reviewedBy: OPERADOR_ADMIN, motivo: undefined });

  const historico = servico.getHistory(ctx, record.id);
  assert.deepEqual(historico.map((entrada) => entrada.reviewedBy), [OPERADOR_ADMIN, OPERADOR_ADMIN, OPERADOR_ADMIN]);
  assert.deepEqual(historico.map((entrada) => entrada.actor), [ACTOR.HUMAN, ACTOR.HUMAN, ACTOR.HUMAN]);
});

test('[CRM-SVC-17] o histórico guarda o operador de CADA escrita (ADMIN diferente por operação): nunca o do último, nunca o do primeiro', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  const outroAdmin = { userId: 'user-admin-2', authUserId: 'auth-admin-2', name: 'Outro Administrador', email: 'admin2-crm@example.test', role: ROLE.ADMIN };
  const { record } = servico.createRecord(admin(), { empresa: 'Duas Mãos Ltda' });
  servico.moveStatus(createAuthorizationContext(usuario(outroAdmin)), record.id, CRM_STATUS.RESEARCH);
  const historico = servico.getHistory(admin(), record.id);
  assert.equal(historico[0].reviewedBy.userId, ADMIN_USER.userId);
  assert.equal(historico[1].reviewedBy.userId, 'user-admin-2');
});

test('[CRM-SVC-18] um autorizador DEFEITUOSO nunca autoriza: false, undefined, texto, lista, Promise, campos a mais (permissions/authUserId), campos faltando/vazios e a role SYSTEM são recusas — em todas as operações, sem tocar a persistência', () => {
  const inicial = createInMemoryCrmRepository();
  const id = semear(criarServico(inicial));
  const identidadeOk = { userId: 'u', name: 'n', role: 'ADMIN' };
  const defeituosos = [
    ['false', () => false],
    ['undefined', () => undefined],
    ['null', () => null],
    ['texto', () => 'autorizado'],
    ['lista', () => [identidadeOk]],
    ['Promise (autorizador assíncrono)', () => Promise.resolve(identidadeOk)],
    ['objeto com then', () => ({ ...identidadeOk, then() {} })],
    ['permissions a mais (a antiga identidade)', () => ({ ...identidadeOk, permissions: [WRITE] })],
    ['authUserId a mais', () => ({ ...identidadeOk, authUserId: 'auth-vazado' })],
    ['e-mail a mais', () => ({ ...identidadeOk, email: 'x@example.test' })],
    ['sem userId', () => ({ name: 'n', role: 'ADMIN' })],
    ['name vazio', () => ({ ...identidadeOk, name: '   ' })],
    ['role não-texto', () => ({ ...identidadeOk, role: 42 })],
    ['role SYSTEM', () => ({ ...identidadeOk, role: 'SYSTEM' })],
    ['role system (minúsculas)', () => ({ ...identidadeOk, role: ' system ' })],
    ['instância de classe', () => new (class Identidade { constructor() { Object.assign(this, identidadeOk); } })()],
  ];
  for (const [nome, autorizador] of defeituosos) {
    const repo = repositorioObservado(inicial);
    const servico = criarServico(repo, { authorizeOperation: autorizador });
    for (const [operacao, , executar] of operacoes(servico, id)) {
      assert.match(erroDe(() => executar(admin())).message, /autorização recusada/, `${nome}: ${operacao}`);
    }
    assert.deepEqual(repo.chamadas, [], `${nome}: a persistência não foi tocada`);
  }
});

test('[CRM-SVC-19] o erro de um autorizador que LANÇA passa intacto (mesma classe, mesma mensagem), e a identidade devolvida é COPIADA: alterar o objeto do autorizador depois não muda o histórico', () => {
  class ErroDeAutorizacao extends Error {}
  const inicial = createInMemoryCrmRepository();
  const negador = criarServico(inicial, {
    authorizeOperation: () => {
      throw new ErroDeAutorizacao('negado pela política do autorizador');
    },
  });
  const erro = erroDe(() => negador.listRecords(admin()));
  assert.ok(erro instanceof ErroDeAutorizacao);
  assert.equal(erro.message, 'negado pela política do autorizador');

  const compartilhada = { userId: 'user-compartilhado', name: 'Compartilhado', role: 'ADMIN' };
  const servico = criarServico(inicial, { authorizeOperation: () => compartilhada });
  const { record } = servico.createRecord(admin(), { empresa: 'Cópia Ltda' });
  compartilhada.role = 'ALTERADA-DEPOIS';
  compartilhada.userId = 'outro-usuario';
  assert.deepEqual(servico.getHistory(admin(), record.id)[0].reviewedBy, { userId: 'user-compartilhado', name: 'Compartilhado', role: 'ADMIN' });
});

test('[CRM-SVC-20] LIMITE documentado: o Service obedece ao autorizador que recebe (quem o compõe o escolhe) — um autorizador permissivo autoriza tudo; por isso a composição real usa só a ponte de src/auth', () => {
  const servico = criarServico(createInMemoryCrmRepository(), { authorizeOperation: () => ({ userId: 'qualquer', name: 'Qualquer', role: 'ADMIN' }) });
  assert.doesNotThrow(() => servico.createRecord('não é um contexto', { empresa: 'Permissiva Ltda' }));
});

// ===========================================================================
// 4) Leituras
// ===========================================================================
test('[CRM-SVC-21] listRecords devolve TODOS os registros como projeções (incluindo os bloqueados), vazio quando não há nenhum, e só aceita "nenhuma opção"', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  assert.deepEqual(servico.listRecords(closer()), []);
  const a = semear(servico, { empresa: 'A', site: 'a.example.test' });
  semear(servico, { empresa: 'B', site: 'b.example.test' });
  servico.markDoNotContact(admin(), a);
  const lista = servico.listRecords(closer());
  assert.equal(lista.length, 2);
  assert.deepEqual(lista.map((registro) => registro.empresa).sort(), ['A', 'B']);
  assert.equal(lista.find((registro) => registro.empresa === 'A').status, CRM_STATUS.DO_NOT_CONTACT);

  for (const semOpcao of [undefined, null, {}]) assert.doesNotThrow(() => servico.listRecords(closer(), semOpcao));
  for (const invalida of ['texto', 42, [], { estado: 'PROSPECT' }, { status: 'PROSPECT' }]) {
    assert.ok(erroDe(() => servico.listRecords(closer(), invalida)), JSON.stringify(invalida));
  }
});

test('[CRM-SVC-22] getRecord devolve a projeção do registro, null para um id inexistente, e uma CÓPIA: alterar o retorno nunca muda o que está guardado', () => {
  const inicial = createInMemoryCrmRepository();
  const servico = criarServico(inicial);
  const id = semear(servico);
  assert.equal(servico.getRecord(closer(), 'crm:nao-existe'), null);

  const lido = servico.getRecord(closer(), id);
  assert.equal(lido.id, id);
  assert.equal(lido.empresa, 'Semente Ltda');
  lido.empresa = 'Adulterada';
  lido.historico.push({ falso: true });
  lido.historico[0].reviewedBy.role = 'ADULTERADA';
  assert.equal(servico.getRecord(closer(), id).empresa, 'Semente Ltda');
  assert.equal(servico.getRecord(closer(), id).historico.length, 1);
  assert.equal(servico.getRecord(closer(), id).historico[0].reviewedBy.role, ROLE.ADMIN);
  assert.notEqual(servico.getRecord(closer(), id), servico.getRecord(closer(), id), 'cada leitura é um objeto novo');
});

test('[CRM-SVC-23] getHistory devolve a trilha (uma entrada por criação/mudança de status, em ordem, só crescendo) e recusa um registro inexistente', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  const id = semear(servico);
  servico.moveStatus(admin(), id, CRM_STATUS.RESEARCH, { reason: 'começou' });
  servico.updateRecord(admin(), id, { observacoes: 'editar campos não gera histórico (limite documentado)' });
  servico.moveStatus(admin(), id, CRM_STATUS.CONTACTED);

  const historico = servico.getHistory(closer(), id);
  assert.deepEqual(historico.map((entrada) => [entrada.from, entrada.to]), [[null, 'PROSPECT'], ['PROSPECT', 'RESEARCH'], ['RESEARCH', 'CONTACTED']]);
  assert.equal(historico[1].motivo, 'começou');
  assert.equal(historico[2].motivo, null);
  for (const entrada of historico) {
    assert.deepEqual(Object.keys(entrada).sort(), ['actor', 'from', 'motivo', 'reviewedBy', 'timestamp', 'to']);
    assert.ok(!Number.isNaN(Date.parse(entrada.timestamp)), 'timestamp ISO');
  }
  assert.match(erroDe(() => servico.getHistory(closer(), 'crm:nao-existe')).message, /registro não encontrado/);
  historico.push({ falso: true });
  assert.equal(servico.getHistory(closer(), id).length, 3, 'cópia: alterar o retorno não muda o histórico');
});

test('[CRM-SVC-24] as leituras NUNCA gravam: nenhuma das 3 leituras chama save() na persistência', () => {
  const inicial = createInMemoryCrmRepository();
  const id = semear(criarServico(inicial));
  const repo = repositorioObservado(inicial);
  const servico = criarServico(repo);
  servico.listRecords(closer());
  servico.getRecord(closer(), id);
  servico.getHistory(closer(), id);
  servico.getRecord(closer(), 'crm:nao-existe');
  assert.equal(gravacoes(repo), 0);
});

// ===========================================================================
// 5) Escritas — criar, atualizar, mover status, DNC
// ===========================================================================
test('[CRM-SVC-25] createRecord (ADMIN): grava no repositório, devolve a projeção com EXATAMENTE os campos do modelo, e a primeira entrada do histórico traz o operador e o motivo (sem espaços nas pontas)', () => {
  const inicial = createInMemoryCrmRepository();
  const servico = criarServico(inicial);
  const { record, duplicidade } = servico.createRecord(admin(), { empresa: 'Consultório Novo', cidade: 'Petrópolis', valorProposta: 1500 }, { reason: ' abertura do lead ' });
  assert.equal(duplicidade, null);
  assert.deepEqual(Object.keys(record).sort(), ['id', ...CRM_WRITABLE_FIELDS, 'status', 'dataDeEntrada', 'historico'].sort());
  assert.match(record.id, /^crm:/);
  assert.equal(record.status, CRM_STATUS.PROSPECT);
  assert.equal(record.valorProposta, 1500);
  assert.equal(record.telefone, null);
  assert.equal(record.historico.length, 1);
  assert.deepEqual(record.historico[0], { timestamp: record.dataDeEntrada, from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: OPERADOR_ADMIN, motivo: 'abertura do lead' });
  assert.equal(inicial.getById(record.id).empresa, 'Consultório Novo', 'gravou de fato');
});

test('[CRM-SVC-26] createRecord: o status inicial é opcional e validado pelo domínio; o motivo só aceita texto; entradas que não são um objeto simples são recusadas ANTES de tocar a persistência', () => {
  const inicial = createInMemoryCrmRepository();
  const repo = repositorioObservado(inicial);
  const servico = criarServico(repo);
  assert.equal(servico.createRecord(admin(), { empresa: 'X1' }, { status: CRM_STATUS.QUALIFIED_PROSPECT }).record.status, CRM_STATUS.QUALIFIED_PROSPECT);
  assert.equal(servico.createRecord(admin(), { empresa: 'X2' }, { status: null }).record.status, CRM_STATUS.PROSPECT);
  assert.match(erroDe(() => servico.createRecord(admin(), { empresa: 'X3' }, { status: 'INVENTADO' })).message, /status desconhecido/);
  assert.match(erroDe(() => servico.createRecord(admin(), { empresa: 'X4' }, { status: 42 })).message, /status deve ser um texto/);
  assert.match(erroDe(() => servico.createRecord(admin(), { empresa: 'X5' }, { reason: 42 })).message, /reason deve ser um texto/);

  repo.chamadas.length = 0;
  class Modelo { constructor() { this.empresa = 'Instância de classe'; } }
  const heranca = Object.create({ empresa: 'Herdada' });
  // (Um Proxy de um objeto simples NÃO entra aqui: é indistinguível de um objeto simples e inofensivo — o domínio lê
  // cada campo uma única vez e valida o valor lido; o que uma armadilha devolver numa segunda leitura nunca é usado.)
  for (const invalida of [undefined, null, 'texto', 42, [], [{ empresa: 'x' }], new Modelo(), heranca, () => ({})]) {
    const erro = erroDe(() => servico.createRecord(admin(), invalida));
    assert.ok(erro, `${String(invalida)} deveria ser recusado`);
    assert.match(erro.message, /input deve ser um objeto simples/);
  }
  for (const opcoesInvalidas of ['texto', 42, [], new Modelo(), Object.create({ reason: 'herdada' })]) {
    assert.match(erroDe(() => servico.createRecord(admin(), { empresa: 'X6' }, opcoesInvalidas)).message, /opções devem ser um objeto simples/);
  }
  assert.deepEqual(repo.chamadas, [], 'entrada inválida nunca chega à persistência');
  assert.equal(inicial.list().length, 2, 'só os dois válidos foram criados');
});

test('[CRM-SVC-27] as regras de campo são do DOMÍNIO e passam intactas: empresa obrigatória, campos desconhecidos e gerenciados, tipos (valor numérico >= 0), espaços nas pontas', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  assert.match(erroDe(() => servico.createRecord(admin(), {})).message, /exige "empresa"/);
  assert.match(erroDe(() => servico.createRecord(admin(), { empresa: '   ' })).message, /exige "empresa"/);
  assert.match(erroDe(() => servico.createRecord(admin(), { empresa: 'x', bogus: 1 })).message, /campos desconhecidos: bogus/);
  for (const gerenciado of ['id', 'status', 'dataDeEntrada', 'historico']) {
    assert.match(erroDe(() => servico.createRecord(admin(), { empresa: 'x', [gerenciado]: 'y' })).message, /gerenciados pelo domínio/, gerenciado);
  }
  assert.match(erroDe(() => servico.createRecord(admin(), { empresa: 'x', valorProposta: -1 })).message, /valorProposta/);
  assert.match(erroDe(() => servico.createRecord(admin(), { empresa: 'x', valorTotal: '100' })).message, /valorTotal/);
  assert.equal(servico.createRecord(admin(), { empresa: '  Com Espaços  ', site: '  espacos.example.test  ' }).record.site, 'espacos.example.test');
});

test('[CRM-SVC-28] DEDUPLICAÇÃO via Service: identidade forte idêntica (site, telefone, instagram — inclusive com espaços e telefone×whatsapp cruzados) NÃO cria um segundo registro; nome+cidade cria e avisa', () => {
  const inicial = createInMemoryCrmRepository();
  const servico = criarServico(inicial);
  servico.createRecord(admin(), { empresa: 'Original', site: 'original.example.test', telefone: '24911110000', whatsapp: '24922220000', instagram: 'original.perfil', cidade: 'Petrópolis' });

  const tentativas = [
    { empresa: 'Cópia site', site: 'https://WWW.Original.example.test/x' },
    { empresa: 'Cópia site com espaços', site: '  original.example.test  ' },
    { empresa: 'Cópia telefone', telefone: '+55 (24) 91111-0000' },
    { empresa: 'Cópia whatsapp como telefone', telefone: '24922220000' },
    { empresa: 'Cópia telefone como whatsapp', whatsapp: '24911110000' },
    { empresa: 'Cópia instagram', instagram: '@Original.Perfil' },
  ];
  for (const campos of tentativas) {
    assert.match(erroDe(() => servico.createRecord(admin(), campos)).message, /mesma identidade/, campos.empresa);
  }
  assert.equal(inicial.list().length, 1, 'nenhuma tentativa criou um segundo registro');

  const { record, duplicidade } = servico.createRecord(admin(), { empresa: 'Original', cidade: 'Petrópolis' });
  assert.equal(inicial.list().length, 2, 'só nome+cidade: cria (preferir falso negativo)');
  assert.equal(duplicidade.status, 'POSSIVEL_DUPLICADO');
  assert.deepEqual(duplicidade.matchedOn, ['nome_cidade']);
  assert.notEqual(record.id, duplicidade.matchedRecordId);
});

test('[CRM-SVC-29] o aviso de possível duplicidade é MÍNIMO: só { status, matchedOn, matchedRecordId } — nunca o registro inteiro de OUTRA empresa dentro da resposta de uma criação', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  const { record: primeiro } = servico.createRecord(admin(), { empresa: 'Sigilosa Ltda', cidade: 'Niterói', observacoes: 'dado interno que não deve vazar', telefone: '24900001111' });
  const { duplicidade } = servico.createRecord(admin(), { empresa: 'Sigilosa Ltda', cidade: 'Niterói' });
  assert.deepEqual(Object.keys(duplicidade).sort(), ['matchedOn', 'matchedRecordId', 'status']);
  assert.equal(duplicidade.matchedRecordId, primeiro.id);
  const texto = JSON.stringify(duplicidade);
  for (const vazado of ['dado interno', '24900001111', 'observacoes', 'telefone']) assert.ok(!texto.includes(vazado), `não pode conter ${vazado}`);
});

test('[CRM-SVC-30] updateRecord (ADMIN): altera só os campos enviados, preserva o resto e o histórico; campos gerenciados/desconhecidos são recusados; um patch inválido nunca chega à persistência', () => {
  const inicial = createInMemoryCrmRepository();
  const repo = repositorioObservado(inicial);
  const servico = criarServico(repo);
  const id = semear(servico, { empresa: 'Editável Ltda', cidade: 'Petrópolis' });
  const atualizado = servico.updateRecord(admin(), id, { telefone: '24999990000', observacoes: 'nota' });
  assert.equal(atualizado.telefone, '24999990000');
  assert.equal(atualizado.observacoes, 'nota');
  assert.equal(atualizado.cidade, 'Petrópolis');
  assert.equal(atualizado.status, CRM_STATUS.PROSPECT);
  assert.equal(atualizado.historico.length, 1, 'editar campos não mexe no histórico (limite documentado)');

  for (const gerenciado of ['id', 'status', 'dataDeEntrada', 'historico']) {
    assert.match(erroDe(() => servico.updateRecord(admin(), id, { [gerenciado]: 'x' })).message, /gerenciados pelo domínio/, gerenciado);
  }
  assert.match(erroDe(() => servico.updateRecord(admin(), id, { bogus: 1 })).message, /campos desconhecidos/);
  assert.match(erroDe(() => servico.updateRecord(admin(), id, { empresa: '  ' })).message, /"empresa" vazia/);

  const antes = gravacoes(repo);
  for (const invalido of [undefined, null, 'texto', [], Object.create({ observacoes: 'herdada' })]) {
    assert.match(erroDe(() => servico.updateRecord(admin(), id, invalido)).message, /patch deve ser um objeto simples/);
  }
  assert.equal(gravacoes(repo), antes, 'patch inválido não gravou');
});

test('[CRM-SVC-31] EDITAR a identidade não contorna o DNC nem a deduplicação via Service (a brecha do domínio corrigida nesta etapa)', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  const bloqueado = semear(servico, { empresa: 'Bloqueada Ltda', site: 'bloqueada.example.test', telefone: '24933334444' });
  servico.markDoNotContact(admin(), bloqueado);
  const outro = semear(servico, { empresa: 'Outra Ltda', site: 'outra.example.test' });
  const ativo = semear(servico, { empresa: 'Ativa Ltda', site: 'ativa.example.test' });

  assert.match(erroDe(() => servico.updateRecord(admin(), ativo, { site: '  bloqueada.example.test  ' })).message, /bloqueado como DO_NOT_CONTACT/);
  assert.match(erroDe(() => servico.updateRecord(admin(), ativo, { whatsapp: '24933334444' })).message, /bloqueado como DO_NOT_CONTACT/, 'o telefone do bloqueado, agora como whatsapp');
  assert.match(erroDe(() => servico.updateRecord(admin(), ativo, { site: 'outra.example.test' })).message, /coincide com a de outro registro/);
  assert.equal(servico.getRecord(admin(), ativo).site, 'ativa.example.test');
  assert.equal(servico.getRecord(admin(), outro).site, 'outra.example.test');
});

test('[CRM-SVC-32] moveStatus (ADMIN): aplica a máquina de estados do DOMÍNIO e registra a transição no histórico; transições proibidas, status inventado e destino que não é texto são recusados', () => {
  const inicial = createInMemoryCrmRepository();
  const repo = repositorioObservado(inicial);
  const servico = criarServico(repo);
  const id = semear(servico);

  const movido = servico.moveStatus(admin(), id, CRM_STATUS.NEGOTIATION, { reason: 'proposta aceita para negociar' });
  assert.equal(movido.status, CRM_STATUS.NEGOTIATION);
  assert.deepEqual(movido.historico.at(-1), { timestamp: movido.historico.at(-1).timestamp, from: 'PROSPECT', to: 'NEGOTIATION', actor: 'HUMAN', reviewedBy: OPERADOR_ADMIN, motivo: 'proposta aceita para negociar' });
  assert.equal(servico.moveStatus(admin(), id, CRM_STATUS.QUALIFICATION).status, CRM_STATUS.QUALIFICATION, 'o funil também volta');

  const ganho = servico.moveStatus(admin(), id, CRM_STATUS.WON);
  assert.equal(ganho.status, CRM_STATUS.WON);
  assert.match(erroDe(() => servico.moveStatus(admin(), id, CRM_STATUS.PROSPECT)).message, /transição não permitida: WON -> PROSPECT/);
  assert.match(erroDe(() => servico.moveStatus(admin(), id, CRM_STATUS.LOST)).message, /transição não permitida/);
  assert.match(erroDe(() => servico.moveStatus(admin(), id, 'ESTADO_INVENTADO')).message, /status desconhecido/);

  const antes = gravacoes(repo);
  for (const naoTexto of [undefined, null, 42, {}, [], CRM_STATUS]) {
    assert.match(erroDe(() => servico.moveStatus(admin(), id, naoTexto)).message, /status de destino deve ser um texto/, String(naoTexto));
  }
  assert.match(erroDe(() => servico.moveStatus(admin(), id, CRM_STATUS.LOST, { reason: 42 })).message, /reason deve ser um texto/);
  assert.equal(gravacoes(repo), antes, 'nada disso gravou');
  assert.equal(inicial.getById(id).status, CRM_STATUS.WON);
});

test('[CRM-SVC-33] DO_NOT_CONTACT via Service: o ADMIN bloqueia; o bloqueio é TERMINAL — nenhum destino, nenhuma edição, nenhuma reentrada com a mesma identidade — e o motivo fica no histórico', () => {
  const inicial = createInMemoryCrmRepository();
  const servico = criarServico(inicial);
  const id = semear(servico, { empresa: 'Pediu Para Sair', site: 'saiu.example.test', telefone: '24955556666' });
  const bloqueado = servico.markDoNotContact(admin(), id, { reason: 'pediu para não ser mais contatado' });
  assert.equal(bloqueado.status, CRM_STATUS.DO_NOT_CONTACT);
  assert.equal(bloqueado.historico.at(-1).motivo, 'pediu para não ser mais contatado');
  assert.deepEqual(bloqueado.historico.at(-1).reviewedBy, OPERADOR_ADMIN);

  for (const destino of Object.values(CRM_STATUS)) {
    assert.match(erroDe(() => servico.moveStatus(admin(), id, destino)).message, /transição não permitida/, `DNC -> ${destino}`);
  }
  assert.match(erroDe(() => servico.markDoNotContact(admin(), id)).message, /transição não permitida/, 'marcar de novo também é recusado');
  assert.match(erroDe(() => servico.updateRecord(admin(), id, { observacoes: 'reabrir' })).message, /não pode ser atualizado/);
  for (const reentrada of [{ empresa: 'Reentrada por site', site: '  saiu.example.test ' }, { empresa: 'Reentrada por telefone', telefone: '24955556666' }, { empresa: 'Reentrada por whatsapp', whatsapp: '24955556666' }]) {
    assert.match(erroDe(() => servico.createRecord(admin(), reentrada)).message, /bloqueada como DO_NOT_CONTACT/, reentrada.empresa);
  }
  assert.equal(inicial.list().length, 1, 'nenhuma reentrada criou um registro');
  assert.equal(servico.getRecord(closer(), id).status, CRM_STATUS.DO_NOT_CONTACT);
});

test('[CRM-SVC-34] DECISÃO PENDENTE (produto), registrada: o COMMERCIAL_CLOSER NÃO pode marcar DO_NOT_CONTACT — é uma escrita e ele não tem WRITE:CRM. Nenhuma exceção foi criada; se o negócio quiser essa capacidade, é uma nova permissão ou uma mudança da matriz, nunca um atalho aqui', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  const id = semear(servico);
  const erro = erroDe(() => servico.markDoNotContact(closer(), id, { reason: 'o lead pediu para não ser contatado' }));
  assert.match(erro.message, /acesso negado/);
  assert.match(erro.message, /WRITE:CRM/);
  assert.equal(servico.getRecord(admin(), id).status, CRM_STATUS.PROSPECT);
});

test('[CRM-SVC-35] toda escrita que dá certo grava EXATAMENTE uma vez; toda que falha (domínio ou entrada) não grava nenhuma', () => {
  const inicial = createInMemoryCrmRepository();
  const id = semear(criarServico(inicial));
  const repo = repositorioObservado(inicial);
  const servico = criarServico(repo);

  const ok = [
    () => servico.createRecord(admin(), { empresa: 'Uma Gravação', site: 'uma.example.test' }),
    () => servico.updateRecord(admin(), id, { observacoes: 'nota' }),
    () => servico.moveStatus(admin(), id, CRM_STATUS.RESEARCH),
    () => servico.markDoNotContact(admin(), id),
  ];
  for (const executar of ok) {
    const antes = gravacoes(repo);
    executar();
    assert.equal(gravacoes(repo) - antes, 1);
  }
  const falhas = [
    () => servico.createRecord(admin(), { empresa: 'Duplicada', site: 'uma.example.test' }),
    () => servico.updateRecord(admin(), id, { observacoes: 'bloqueado não edita' }),
    () => servico.moveStatus(admin(), id, CRM_STATUS.PROSPECT),
    () => servico.markDoNotContact(admin(), 'crm:nao-existe'),
    () => servico.createRecord(admin(), { empresa: '' }),
  ];
  for (const executar of falhas) {
    const antes = gravacoes(repo);
    assert.ok(erroDe(executar));
    assert.equal(gravacoes(repo), antes);
  }
});

// ===========================================================================
// 6) Registros inexistentes, ids perigosos, objetos herdados, entrada não confiável
// ===========================================================================
test('[CRM-SVC-36] registro INEXISTENTE: getRecord devolve null; getHistory/updateRecord/moveStatus/markDoNotContact recusam com "registro não encontrado" — sem gravar nada', () => {
  const inicial = createInMemoryCrmRepository();
  semear(criarServico(inicial));
  const repo = repositorioObservado(inicial);
  const servico = criarServico(repo);
  const inexistente = 'crm:00000000-0000-0000-0000-000000000000';
  assert.equal(servico.getRecord(admin(), inexistente), null);
  assert.match(erroDe(() => servico.getHistory(admin(), inexistente)).message, /registro não encontrado/);
  assert.match(erroDe(() => servico.updateRecord(admin(), inexistente, { observacoes: 'x' })).message, /registro não encontrado/);
  assert.match(erroDe(() => servico.moveStatus(admin(), inexistente, CRM_STATUS.RESEARCH)).message, /registro não encontrado/);
  assert.match(erroDe(() => servico.markDoNotContact(admin(), inexistente)).message, /registro não encontrado/);
  assert.equal(gravacoes(repo), 0);
});

test('[CRM-SVC-37] ids INVÁLIDOS (vazio, só espaços, não-texto) são recusados em toda operação por id, antes da persistência', () => {
  const inicial = createInMemoryCrmRepository();
  const repo = repositorioObservado(inicial);
  const servico = criarServico(repo);
  for (const ruim of ['', '   ', undefined, null, 42, {}, [], true]) {
    for (const executar of [
      () => servico.getRecord(admin(), ruim),
      () => servico.getHistory(admin(), ruim),
      () => servico.updateRecord(admin(), ruim, { observacoes: 'x' }),
      () => servico.moveStatus(admin(), ruim, CRM_STATUS.RESEARCH),
      () => servico.markDoNotContact(admin(), ruim),
    ]) {
      assert.match(erroDe(executar).message, /id deve ser um texto não vazio/, String(ruim));
    }
  }
  assert.deepEqual(repo.chamadas, []);
});

test('[CRM-SVC-38] ids HERDADOS do protótipo do Object ("__proto__", "constructor", "prototype", "toString", "hasOwnProperty") nunca são um registro — em memória e em arquivo — e nunca poluem o protótipo', (t) => {
  const arquivo = arquivoTemporario(t);
  for (const repositorio of [createInMemoryCrmRepository(), createJsonFileCrmRepository(arquivo)]) {
    const servico = criarServico(repositorio);
    semear(servico);
    for (const perigoso of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
      assert.equal(servico.getRecord(closer(), perigoso), null, perigoso);
      assert.match(erroDe(() => servico.getHistory(closer(), perigoso)).message, /registro não encontrado/, perigoso);
      assert.match(erroDe(() => servico.updateRecord(admin(), perigoso, { observacoes: 'x' })).message, /registro não encontrado/, perigoso);
      assert.match(erroDe(() => servico.moveStatus(admin(), perigoso, CRM_STATUS.RESEARCH)).message, /registro não encontrado/, perigoso);
      assert.match(erroDe(() => servico.markDoNotContact(admin(), perigoso)).message, /registro não encontrado/, perigoso);
    }
    assert.equal(servico.listRecords(closer()).length, 1, 'o repositório continua íntegro');
  }
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('[CRM-SVC-39] entradas com chaves perigosas vindas de JSON ("__proto__", "constructor") são recusadas como desconhecidas e nunca poluem o protótipo global', () => {
  const inicial = createInMemoryCrmRepository();
  const servico = criarServico(inicial);
  const id = semear(servico);
  const maliciosoComoJson = JSON.parse('{"empresa":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  assert.match(erroDe(() => servico.createRecord(admin(), maliciosoComoJson)).message, /campos desconhecidos/);
  assert.match(erroDe(() => servico.updateRecord(admin(), id, JSON.parse('{"__proto__":{"polluted":true}}'))).message, /campos desconhecidos/);
  for (const opcoes of [JSON.parse('{"__proto__":{"reason":"x"}}'), JSON.parse('{"constructor":{"reason":"x"}}')]) {
    assert.match(erroDe(() => servico.moveStatus(admin(), id, CRM_STATUS.RESEARCH, opcoes)).message, /opções não reconhecidas/);
  }
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(inicial.list().length, 1);
});

test('[CRM-SVC-40] propriedades HERDADAS nunca participam: um `reason` herdado (Object.create) é uma entrada inválida, e uma Object.prototype.reason poluída NÃO vira o motivo', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  const id = semear(servico);
  assert.match(erroDe(() => servico.moveStatus(admin(), id, CRM_STATUS.RESEARCH, Object.create({ reason: 'herdado' }))).message, /opções devem ser um objeto simples/);
  Object.prototype.reason = 'motivo poluído';
  Object.prototype.status = 'WON';
  try {
    const { record } = servico.createRecord(admin(), { empresa: 'Sem Herança' }, {});
    assert.equal(record.status, CRM_STATUS.PROSPECT, 'um status herdado nunca escolhe o status inicial');
    assert.equal(record.historico[0].motivo, null, 'um reason herdado nunca vira o motivo');
    assert.equal(servico.moveStatus(admin(), id, CRM_STATUS.CONTACTED, {}).historico.at(-1).motivo, null);
  } finally {
    delete Object.prototype.reason;
    delete Object.prototype.status;
  }
});

// ===========================================================================
// 7) Dados sensíveis: o que sai do Service
// ===========================================================================
test('[CRM-SVC-41] nenhum authUserId, e-mail de usuário, permissions ou token sai do Service — em nenhuma operação — e o reviewedBy tem só { userId, name, role }', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  const ctx = admin();
  const { record } = servico.createRecord(ctx, { empresa: 'Sem Vazamento', site: 'sem-vazamento.example.test' }, { reason: 'ok' });
  const saidas = [
    record,
    servico.updateRecord(ctx, record.id, { observacoes: 'nota' }),
    servico.moveStatus(ctx, record.id, CRM_STATUS.RESEARCH, { reason: 'x' }),
    servico.getRecord(ctx, record.id),
    servico.getHistory(ctx, record.id),
    servico.listRecords(ctx),
    servico.markDoNotContact(ctx, record.id),
  ];
  const texto = JSON.stringify(saidas);
  for (const proibido of [ADMIN_USER.authUserId, ADMIN_USER.email, 'permissions', 'READ:CRM', 'WRITE:CRM', 'APPROVE', 'token', 'Bearer', 'authUserId']) {
    assert.ok(!texto.includes(proibido), `a saída não pode conter ${proibido}`);
  }
  for (const entrada of servico.getHistory(ctx, record.id)) {
    assert.deepEqual(Object.keys(entrada.reviewedBy).sort(), ['name', 'role', 'userId']);
  }
});

test('[CRM-SVC-42] uma ADULTERAÇÃO no armazenamento (campos a mais, authUserId, permissions, tokens, objetos aninhados, reviewedBy com dados extras) nunca vaza: a saída é sempre a lista explícita de campos, com valores primitivos', () => {
  const adulterado = {
    id: 'crm:adulterado',
    empresa: 'Adulterada Ltda',
    status: 'PROSPECT',
    dataDeEntrada: '2026-01-01T00:00:00.000Z',
    authUserId: 'auth-vazado',
    token: 'token-vazado',
    senha: 'senha-vazada',
    permissions: ['WRITE:CRM'],
    observacoes: { aninhado: 'objeto-vazado' },
    contato: ['lista-vazada'],
    valorProposta: Infinity,
    historico: [
      { timestamp: 't', from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: { userId: 'u', name: 'n', role: 'ADMIN', permissions: ['x'], authUserId: 'auth-vazado-2' }, motivo: null, extra: 'extra-vazado' },
      'entrada-que-nao-e-objeto',
      { timestamp: 't2', reviewedBy: 'texto-vazado' },
    ],
  };
  const servico = criarServico(createInMemoryCrmRepository([adulterado]));
  const saidas = [servico.getRecord(closer(), 'crm:adulterado'), servico.listRecords(closer()), servico.getHistory(closer(), 'crm:adulterado')];
  const texto = JSON.stringify(saidas);
  for (const vazado of ['vazado', 'vazada', 'authUserId', 'permissions', 'token', 'senha', 'aninhado', 'extra']) {
    assert.ok(!texto.includes(vazado), `a saída não pode conter ${vazado}`);
  }
  const registro = saidas[0];
  assert.equal(registro.observacoes, null, 'objeto aninhado vira null');
  assert.equal(registro.contato, null, 'lista vira null');
  assert.equal(registro.valorProposta, null, 'número não finito vira null');
  assert.deepEqual(Object.keys(registro).sort(), ['id', ...CRM_WRITABLE_FIELDS, 'status', 'dataDeEntrada', 'historico'].sort());
  assert.deepEqual(registro.historico[0].reviewedBy, { userId: 'u', name: 'n', role: 'ADMIN' });
  assert.equal(registro.historico[1].reviewedBy, null);
  assert.equal(registro.historico[2].reviewedBy, null);
});

test('[CRM-SVC-43] corrupção do armazenamento aparece, nunca é escondida: um item que não é um registro na lista lança um erro claro; um registro sem histórico nunca é "consertado" numa escrita', () => {
  const corrompido = criarServico(createInMemoryCrmRepository([{ id: 'crm:ok', empresa: 'Ok', status: 'PROSPECT', historico: [] }, { id: 'crm:sem-historico', empresa: 'Sem histórico', status: 'PROSPECT' }]));
  assert.match(erroDe(() => corrompido.moveStatus(admin(), 'crm:sem-historico', CRM_STATUS.RESEARCH)).message, /histórico ausente ou inválido/);
  assert.match(erroDe(() => corrompido.updateRecord(admin(), 'crm:sem-historico', { observacoes: 'x' })).message, /histórico ausente ou inválido/);

  const listaSuja = { list: () => [{ id: 'crm:a', empresa: 'A', historico: [] }, null], getById: () => null, save: () => {} };
  assert.match(erroDe(() => criarServico(listaSuja).listRecords(closer())).message, /registro inválido no armazenamento/);
});

test('[CRM-SVC-44] um repositório DEFEITUOSO que devolve o registro de OUTRO id nunca sai como o registro pedido: getRecord devolve null e getHistory recusa', () => {
  const outro = { id: 'crm:outro', empresa: 'Outro', status: 'PROSPECT', historico: [] };
  const defeituoso = { list: () => [outro], getById: () => structuredClone(outro), save: () => {} };
  const servico = criarServico(defeituoso);
  assert.equal(servico.getRecord(closer(), 'crm:pedido'), null);
  assert.match(erroDe(() => servico.getHistory(closer(), 'crm:pedido')).message, /registro não encontrado/);
});

// ===========================================================================
// 8) Persistência de verdade (arquivo) e falhas
// ===========================================================================
test('[CRM-SVC-45] PERSISTÊNCIA: o que um Service grava, um SEGUNDO Service — outra instância, outro repositório sobre o MESMO arquivo — lê, inclusive histórico e o bloqueio DNC', (t) => {
  const arquivo = arquivoTemporario(t);
  const primeiro = criarServico(createJsonFileCrmRepository(arquivo));
  const { record } = primeiro.createRecord(admin(), { empresa: 'Persistente Ltda', site: 'persistente.example.test' }, { reason: 'gravado pelo primeiro' });
  primeiro.moveStatus(admin(), record.id, CRM_STATUS.QUALIFICATION, { reason: 'qualificado' });
  primeiro.markDoNotContact(admin(), record.id, { reason: 'pediu para sair' });

  const segundo = criarServico(createJsonFileCrmRepository(arquivo));
  const lido = segundo.getRecord(closer(), record.id);
  assert.equal(lido.status, CRM_STATUS.DO_NOT_CONTACT);
  assert.deepEqual(lido.historico.map((entrada) => entrada.to), ['PROSPECT', 'QUALIFICATION', 'DO_NOT_CONTACT']);
  assert.deepEqual(lido.historico.map((entrada) => entrada.motivo), ['gravado pelo primeiro', 'qualificado', 'pediu para sair']);
  assert.match(erroDe(() => segundo.createRecord(admin(), { empresa: 'Reentrada', site: 'persistente.example.test' })).message, /bloqueada como DO_NOT_CONTACT/, 'o DNC sobrevive à reinicialização');
  assert.equal(segundo.listRecords(closer()).length, 1);
});

test('[CRM-SVC-46] falhas de armazenamento passam intactas e não deixam meia-escrita: uma gravação que falha lança o erro do repositório e o registro continua como estava; um arquivo CORROMPIDO nunca é mascarado como "vazio"', (t) => {
  const inicial = createInMemoryCrmRepository();
  const id = semear(criarServico(inicial));
  const gravacaoQuebrada = {
    list: () => inicial.list(),
    getById: (registroId) => inicial.getById(registroId),
    save: () => {
      throw new Error('disco cheio (simulado)');
    },
  };
  const servico = criarServico(gravacaoQuebrada);
  assert.match(erroDe(() => servico.moveStatus(admin(), id, CRM_STATUS.RESEARCH)).message, /disco cheio \(simulado\)/);
  assert.equal(inicial.getById(id).status, CRM_STATUS.PROSPECT, 'nada mudou');
  assert.equal(inicial.getById(id).historico.length, 1);

  const arquivo = arquivoTemporario(t);
  fs.writeFileSync(arquivo, '{ isto não é json [[[', 'utf8');
  const sobreCorrompido = criarServico(createJsonFileCrmRepository(arquivo));
  assert.match(erroDe(() => sobreCorrompido.listRecords(admin())).message, /corrompido/);
  assert.match(erroDe(() => sobreCorrompido.createRecord(admin(), { empresa: 'Não pode' })).message, /corrompido/);
  assert.equal(fs.readFileSync(arquivo, 'utf8'), '{ isto não é json [[[', 'o arquivo corrompido não foi sobrescrito');
});

test('[CRM-SVC-47] os erros do domínio passam INTACTOS (mesma classe e mesma mensagem), sem tradução', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  const id = semear(servico);
  servico.moveStatus(admin(), id, CRM_STATUS.WON);
  const doServico = erroDe(() => servico.moveStatus(admin(), id, CRM_STATUS.PROSPECT));
  const doDominio = erroDe(() => crmDomain.moveStatus(createInMemoryCrmRepository([{ id: 'x', empresa: 'x', status: 'WON', historico: [] }]), 'x', CRM_STATUS.PROSPECT));
  assert.equal(doServico.constructor, doDominio.constructor);
  assert.equal(doServico.message, doDominio.message);
});

test('[CRM-SVC-48] concorrência dentro do processo: duas operações seguidas sobre o mesmo registro enxergam uma à outra (cada operação é síncrona e indivisível — sem "última gravação vence" silenciosa)', () => {
  const servico = criarServico(createInMemoryCrmRepository());
  const id = semear(servico);
  servico.updateRecord(admin(), id, { observacoes: 'primeira' });
  servico.updateRecord(admin(), id, { telefone: '24900001111' });
  const registro = servico.getRecord(admin(), id);
  assert.equal(registro.observacoes, 'primeira', 'a segunda edição não apagou a primeira');
  assert.equal(registro.telefone, '24900001111');
  servico.moveStatus(admin(), id, CRM_STATUS.RESEARCH);
  servico.updateRecord(admin(), id, { cargo: 'Diretora' });
  assert.equal(servico.getRecord(admin(), id).status, CRM_STATUS.RESEARCH, 'editar campos depois não desfez a mudança de status');
});

// ===========================================================================
// 9) Reforços (achados pela checagem de mutação)
// ===========================================================================
test('[CRM-SVC-49] nada "thenable" é aceito como identidade do autorizador — nem quando o `then` é HERDADO (Object.prototype poluído): recusa fechada, nunca uma autorização', () => {
  const servico = criarServico(createInMemoryCrmRepository(), { authorizeOperation: () => ({ userId: 'u', name: 'n', role: 'ADMIN' }) });
  assert.doesNotThrow(() => servico.listRecords(admin()), 'sanidade: sem a poluição, o mesmo autorizador funciona');
  Object.prototype.then = function then() {};
  try {
    assert.match(erroDe(() => servico.listRecords(admin())).message, /síncrono/);
  } finally {
    delete Object.prototype.then;
  }
  assert.equal(Object.prototype.then, undefined, 'a poluição de teste foi removida');
});

test('[CRM-SVC-50] o Service NÃO depende de o repositório copiar o que recebe: com um repositório que guarda REFERÊNCIAS, alterar depois o objeto devolvido pelo autorizador não muda o histórico gravado', () => {
  const guardados = new Map();
  const porReferencia = {
    list: () => [...guardados.values()],
    getById: (id) => guardados.get(id) || null,
    save: (registro) => void guardados.set(registro.id, registro),
  };
  const compartilhada = { userId: 'user-ref', name: 'Referência', role: 'ADMIN' };
  const servico = criarServico(porReferencia, { authorizeOperation: () => compartilhada });
  const { record } = servico.createRecord(admin(), { empresa: 'Por Referência' });
  servico.moveStatus(admin(), record.id, CRM_STATUS.RESEARCH);
  compartilhada.role = 'ALTERADA-DEPOIS';
  compartilhada.userId = 'outro-usuario';
  for (const entrada of guardados.get(record.id).historico) {
    assert.deepEqual(entrada.reviewedBy, { userId: 'user-ref', name: 'Referência', role: 'ADMIN' });
  }
});
