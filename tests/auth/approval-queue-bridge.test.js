// Fase E — o adaptador authorizeReviewerForApprovalQueue
// (src/auth/approvalQueueBridge.js).
//
// O que estes testes protegem: a ponte é a implementação da PORTA
// authorizeReviewer(context, requiredPermission) -> { userId, name, role } que o
// Approval Queue recebe por injeção. Ela decide SOBRE UM AuthorizationContext
// emitido — nunca sobre um objeto simples —, exige usuário ativo e a permissão
// APPROVE:LEAD_APPROVAL (lida só de `permissions`, nunca da role: ROLE != PERMISSION)
// e devolve ao domínio somente a identidade mínima. Nenhuma lógica da fila vive
// na ponte, e ela não importa o domínio (sem dependência circular).
//
// Como a decisão é sobre um contexto EMITIDO, nada aqui é forjado: para provar que
// a ausência da permissão é recusada, um contexto REAL é emitido sob uma derivação
// role -> permissions reduzida (só dentro do teste). A marca do contexto é uma
// fronteira arquitetural interna confiável, não criptografia.
//
// Determinístico e sem rede: só contextos em memória, fictícios (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const authBarrel = require('../../src/auth');
const bridgeModule = require('../../src/auth/approvalQueueBridge');
const constants = require('../../src/auth/constants');
const { createAuthorizationContext } = require('../helpers/authFixtures');

const { ROLE, USER_STATUS, PERMISSION, defineUser, authorizeReviewerForApprovalQueue, toApprovalQueueIdentity } = authBarrel;

const hasOwn = (objeto, nome) => Object.prototype.hasOwnProperty.call(objeto, nome);

function buildUser(overrides = {}) {
  return defineUser({
    userId: 'user-adapt-1',
    authUserId: 'auth-adapt-1',
    name: 'Revisor de Teste',
    email: 'revisor@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    status: USER_STATUS.ACTIVE,
    ...overrides,
  });
}

const contextFor = (overrides) => createAuthorizationContext(buildUser(overrides));

// Só as linhas de CÓDIGO: descarta as de comentário (// , /* e * ), para que a
// varredura estática não confunda um comentário com um require.
function linhasDeCodigo(fonte) {
  return fonte
    .split('\n')
    .filter((linha) => !/^\s*(\/\/|\/\*|\*)/.test(linha))
    .join('\n');
}

test('[ADAPT-1] usuário ativo com APPROVE:LEAD_APPROVAL (ADMIN e CLOSER) recebe só a identidade mínima { userId, name, role }', () => {
  for (const role of [ROLE.ADMIN, ROLE.COMMERCIAL_CLOSER]) {
    const context = contextFor({ role });
    const identity = authorizeReviewerForApprovalQueue(context, PERMISSION.APPROVE_LEAD_APPROVAL);

    assert.deepEqual(identity, { userId: 'user-adapt-1', name: 'Revisor de Teste', role });
    assert.deepEqual(Object.keys(identity).sort(), ['name', 'role', 'userId']);
    for (const campo of ['permissions', 'authUserId', 'status', 'email']) {
      assert.equal(hasOwn(identity, campo), false, `a identidade mínima não carrega ${campo}`);
    }
    assert.notEqual(identity, context, 'devolve um objeto novo, nunca o próprio contexto');
  }

  // Omitir a permissão equivale a pedir a permissão da fila.
  assert.deepEqual(authorizeReviewerForApprovalQueue(contextFor()), {
    userId: 'user-adapt-1',
    name: 'Revisor de Teste',
    role: ROLE.COMMERCIAL_CLOSER,
  });
});

test('[ADAPT-2] contexto que não foi emitido é recusado: ausente, não-objeto, literal, cópia ou clone — mesmo com a forma perfeita', () => {
  const original = contextFor();
  const literal = {
    userId: original.userId,
    authUserId: original.authUserId,
    name: original.name,
    role: original.role,
    permissions: [...original.permissions],
    status: original.status,
  };
  const imitacoes = [
    ['literal com os mesmos campos', literal],
    ['literal congelado (a forma perfeita)', Object.freeze({ ...literal, permissions: Object.freeze([...literal.permissions]) })],
    ['cópia rasa (spread)', { ...original }],
    ['Object.assign', Object.assign({}, original)],
    ['structuredClone', structuredClone(original)],
    ['clone via JSON', JSON.parse(JSON.stringify(original))],
    ['Object.create(original)', Object.create(original)],
    [
      'a antiga identidade simples { userId, name, role, permissions }',
      { userId: original.userId, name: original.name, role: original.role, permissions: [...original.permissions] },
    ],
    ['objeto vazio', {}],
  ];
  for (const [rotulo, imitacao] of imitacoes) {
    assert.throws(() => authorizeReviewerForApprovalQueue(imitacao), /AuthorizationContext inválido/, rotulo);
  }

  for (const naoObjeto of [undefined, null, '', 'contexto', 0, 42, true, [], () => {}]) {
    assert.throws(() => authorizeReviewerForApprovalQueue(naoObjeto), /AuthorizationContext inválido/);
  }
  assert.throws(() => authorizeReviewerForApprovalQueue(), /AuthorizationContext inválido/);

  // O original continua válido depois de todas as tentativas.
  assert.equal(authorizeReviewerForApprovalQueue(original).userId, 'user-adapt-1');
});

test('[ADAPT-3] usuário INACTIVE é recusado, mesmo com a forma e a permissão corretas no contexto', () => {
  for (const role of [ROLE.ADMIN, ROLE.COMMERCIAL_CLOSER]) {
    const inativo = contextFor({ role, status: USER_STATUS.INACTIVE });
    assert.equal(inativo.status, USER_STATUS.INACTIVE);
    assert.equal(
      inativo.permissions.includes(PERMISSION.APPROVE_LEAD_APPROVAL),
      true,
      'o contexto inativo carrega a permissão — a recusa vem do status, não da falta dela'
    );
    assert.throws(() => authorizeReviewerForApprovalQueue(inativo), /usuário inativo/, role);
    assert.throws(() => authorizeReviewerForApprovalQueue(inativo, PERMISSION.APPROVE_LEAD_APPROVAL), /usuário inativo/, role);
  }
});

test('[ADAPT-4] contexto real SEM APPROVE:LEAD_APPROVAL é recusado — a decisão lê só permissions, nunca a role (o ADMIN também é recusado)', (t) => {
  const usuarios = [
    buildUser({ role: ROLE.ADMIN, userId: 'user-adapt-admin', authUserId: 'auth-adapt-admin' }),
    buildUser({ role: ROLE.COMMERCIAL_CLOSER }),
  ];

  // Fase A: nenhuma role atual carece de APPROVE:LEAD_APPROVAL. O cenário é
  // reproduzido SEM forjar nada: a fonte canônica role -> permissions é trocada só
  // neste teste, e o emissor interno emite contextos legítimos sob ela.
  const derivacao = t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.READ_CRM]));
  const cenarios = [
    [PERMISSION.READ_CRM],
    [],
    [PERMISSION.APPROVE_OUTBOUND_APPROVAL], // permissão de outro domínio não basta
    [PERMISSION.WRITE_CRM, PERMISSION.MANAGE_USERS], // nem as permissões mais fortes
  ];
  for (const cenario of cenarios) {
    derivacao.mock.mockImplementation(() => Object.freeze([...cenario]));
    for (const usuario of usuarios) {
      const context = createAuthorizationContext(usuario);
      assert.equal(context.permissions.includes(PERMISSION.APPROVE_LEAD_APPROVAL), false);
      assert.throws(
        () => authorizeReviewerForApprovalQueue(context),
        /acesso negado/,
        `${usuario.role} com [${cenario.join(', ')}]`
      );
    }
  }
});

test('[ADAPT-5] a ponte só autoriza a permissão da fila: o pedido de OUTRA permissão é recusado, mesmo para quem a possui', () => {
  const admin = contextFor({ role: ROLE.ADMIN }); // o ADMIN possui todas as permissões
  for (const outra of [
    PERMISSION.READ_CRM,
    PERMISSION.WRITE_CRM,
    PERMISSION.MANAGE_USERS,
    PERMISSION.APPROVE_OUTBOUND_APPROVAL,
    'APPROVE:LEAD_APPROVAL ',
    '*:*',
    '',
    null,
    42,
  ]) {
    assert.throws(() => authorizeReviewerForApprovalQueue(admin, outra), /só autoriza APPROVE:LEAD_APPROVAL/, String(outra));
  }
  assert.doesNotThrow(() => authorizeReviewerForApprovalQueue(admin, PERMISSION.APPROVE_LEAD_APPROVAL));
});

test('[ADAPT-6] a ponte não contém lógica de domínio da fila e não importa research-prospector (sem dependência circular)', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '../../src/auth/approvalQueueBridge.js'), 'utf8');
  const codigo = linhasDeCodigo(fonte);

  const requires = [...codigo.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(requires, ['./authorizationContext', './constants'], 'a ponte só depende de auth');

  assert.doesNotMatch(codigo, /research-prospector/);
  assert.doesNotMatch(
    codigo,
    /QUEUE_STATE|ALLOWED_TRANSITIONS|AGUARDANDO_REVISAO|APROVADO_PARA_CRM|REJEITADO|DUPLICADO|DNC|DADOS_INSUFICIENTES|historico|transition/i,
    'nenhum estado, transição, DNC ou histórico da fila vive em src/auth'
  );
});

test('[ADAPT-7] toApprovalQueueIdentity (legado, DEPRECATED) continua existindo e inalterado — e não é o autorizador', () => {
  const context = contextFor();
  const legado = toApprovalQueueIdentity(context);

  assert.deepEqual(Object.keys(legado).sort(), ['name', 'permissions', 'role', 'userId']);
  assert.equal(legado.userId, context.userId);
  assert.deepEqual([...legado.permissions].sort(), [...context.permissions].sort());

  assert.throws(() => toApprovalQueueIdentity(contextFor({ status: USER_STATUS.INACTIVE })), /inativo/);
  assert.throws(() => toApprovalQueueIdentity({}), /AuthorizationContext inválido/);
  assert.throws(() => toApprovalQueueIdentity(null), /AuthorizationContext inválido/);

  assert.notEqual(toApprovalQueueIdentity, authorizeReviewerForApprovalQueue);
});

test('[ADAPT-8] a ponte exporta exatamente o autorizador e o adaptador legado; o barrel os reexporta (as mesmas funções)', () => {
  assert.deepEqual(Object.keys(bridgeModule).sort(), ['authorizeReviewerForApprovalQueue', 'toApprovalQueueIdentity']);
  assert.equal(typeof bridgeModule.authorizeReviewerForApprovalQueue, 'function');
  assert.equal(authBarrel.authorizeReviewerForApprovalQueue, bridgeModule.authorizeReviewerForApprovalQueue);
  assert.equal(authBarrel.toApprovalQueueIdentity, bridgeModule.toApprovalQueueIdentity);
});

// A ponte chama requireActiveUser() de forma EXPLÍCITA, embora requirePermission()
// também a faça (ver o comentário em approvalQueueBridge.js). Este teste prova que essa
// chamada é da própria ponte e não um efeito colateral de requirePermission: numa cópia
// ISOLADA da ponte, requirePermission é trocado por um que só confere a emissão e a
// permissão — SEM olhar o status. Mesmo assim o usuário INACTIVE é recusado.
test('[ADAPT-9] a ponte recusa usuário INACTIVE por conta própria — mesmo que requirePermission NÃO checasse a atividade', () => {
  const bridgePath = require.resolve('../../src/auth/approvalQueueBridge');
  const real = require('../../src/auth/authorizationContext');
  const requirePermissionCegoAoStatus = {
    ...real,
    requirePermission(context, permission) {
      real.assertIsAuthorizationContext(context);
      if (!context.permissions.includes(permission)) throw new Error(`acesso negado: ${permission}`);
      return context;
    },
  };

  // Carrega uma cópia nova da ponte ligada ao colaborador "cego" e restaura tudo em seguida.
  const carregarOriginal = Module._load;
  delete require.cache[bridgePath];
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === bridgePath && request === './authorizationContext') return requirePermissionCegoAoStatus;
    return carregarOriginal.apply(this, arguments);
  };
  let ponteIsolada;
  try {
    ponteIsolada = require(bridgePath);
  } finally {
    Module._load = carregarOriginal;
    delete require.cache[bridgePath];
  }

  const inativo = contextFor({ status: USER_STATUS.INACTIVE });
  // Prova de que o colaborador é mesmo cego: sozinho, ele NÃO recusaria o inativo.
  assert.equal(requirePermissionCegoAoStatus.requirePermission(inativo, PERMISSION.APPROVE_LEAD_APPROVAL), inativo);

  assert.throws(() => ponteIsolada.authorizeReviewerForApprovalQueue(inativo), /usuário inativo/);
  assert.deepEqual(ponteIsolada.authorizeReviewerForApprovalQueue(contextFor()), {
    userId: 'user-adapt-1',
    name: 'Revisor de Teste',
    role: ROLE.COMMERCIAL_CLOSER,
  });
});

test('[ADAPT-10] a ponte é pura: não altera o contexto congelado, não produz efeito colateral e devolve sempre um objeto novo', () => {
  const context = contextFor();
  const antes = JSON.stringify(context);

  const primeira = authorizeReviewerForApprovalQueue(context);
  const segunda = authorizeReviewerForApprovalQueue(context);
  assert.notEqual(primeira, segunda);
  assert.deepEqual(primeira, segunda);
  assert.equal(JSON.stringify(context), antes);
  assert.equal(Object.isFrozen(context), true);

  // Alterar o objeto devolvido não afeta o contexto nem as próximas respostas.
  primeira.role = ROLE.ADMIN;
  primeira.userId = 'outro-usuario';
  assert.equal(context.userId, 'user-adapt-1');
  assert.equal(context.role, ROLE.COMMERCIAL_CLOSER);
  assert.deepEqual(authorizeReviewerForApprovalQueue(context), segunda);
});
