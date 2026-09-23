// Testes da ponte de autorização do CRM (src/auth/crmBridge.js) — a implementação real da porta
// authorizeOperation(context, requiredPermission) -> { userId, name, role } que o CRM Service recebe por injeção.
//
// O que estes testes protegem: a ponte autoriza SÓ READ:CRM e WRITE:CRM (nenhuma outra permissão, nenhum padrão por
// omissão); só aceita um AuthorizationContext emitido (nada de userId/role/permissions soltos, nem cópias/clones de um
// contexto); recusa um usuário inativo; decide pelas `permissions` do contexto e nunca pelo nome da role
// (ROLE != PERMISSION); e devolve SÓ a identidade mínima { userId, name, role } — nunca permissions, authUserId,
// e-mail ou qualquer outro dado do contexto.
//
// Contextos REAIS, emitidos pelo emissor interno a partir de um USER definido (helpers de testes): nada é fabricado.
// As marcas de contexto são uma fronteira arquitetural interna confiável, NÃO criptografia.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ROLE, USER_STATUS, PERMISSION, defineUser, authorizeCrmOperation } = require('../../src/auth');
const { CRM_PERMISSIONS } = require('../../src/auth/crmBridge');
const constants = require('../../src/auth/constants');
const { createAuthorizationContext } = require('../helpers/authFixtures');

const usuario = (overrides = {}) =>
  defineUser({
    userId: 'user-crm-1',
    authUserId: 'auth-crm-1',
    name: 'Operador do CRM',
    email: 'operador-crm@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    status: USER_STATUS.ACTIVE,
    ...overrides,
  });
const contexto = (overrides) => createAuthorizationContext(usuario(overrides));

function erroDe(fn) {
  try {
    fn();
  } catch (erro) {
    return erro;
  }
  return null;
}

test('[CRM-BRIDGE-1] a ponte autoriza exatamente READ:CRM e WRITE:CRM — e nenhuma outra permissão', () => {
  assert.deepEqual([...CRM_PERMISSIONS].sort(), [PERMISSION.READ_CRM, PERMISSION.WRITE_CRM].sort());
  assert.ok(Object.isFrozen(CRM_PERMISSIONS), 'a lista de permissões da ponte não pode ser alterada em tempo de execução');
});

test('[CRM-BRIDGE-2] ADMIN é autorizado para READ:CRM e para WRITE:CRM', () => {
  const admin = contexto({ role: ROLE.ADMIN });
  assert.equal(authorizeCrmOperation(admin, PERMISSION.READ_CRM).userId, 'user-crm-1');
  assert.equal(authorizeCrmOperation(admin, PERMISSION.WRITE_CRM).userId, 'user-crm-1');
});

test('[CRM-BRIDGE-3] COMMERCIAL_CLOSER é autorizado para READ:CRM, e RECUSADO para WRITE:CRM (não possui a permissão — nunca "por ser closer")', () => {
  const closer = contexto({ role: ROLE.COMMERCIAL_CLOSER });
  assert.equal(authorizeCrmOperation(closer, PERMISSION.READ_CRM).role, ROLE.COMMERCIAL_CLOSER);
  const erro = erroDe(() => authorizeCrmOperation(closer, PERMISSION.WRITE_CRM));
  assert.ok(erro, 'o closer não pode escrever no CRM');
  assert.match(erro.message, /acesso negado/);
  assert.match(erro.message, /WRITE:CRM/);
});

test('[CRM-BRIDGE-4] um usuário INACTIVE é recusado para READ:CRM e para WRITE:CRM, seja qual for a role', () => {
  for (const role of [ROLE.ADMIN, ROLE.COMMERCIAL_CLOSER]) {
    const inativo = contexto({ role, status: USER_STATUS.INACTIVE });
    for (const permissao of CRM_PERMISSIONS) {
      const erro = erroDe(() => authorizeCrmOperation(inativo, permissao));
      assert.ok(erro, `${role} inativo ${permissao}`);
      assert.match(erro.message, /usuário inativo/);
    }
  }
});

test('[CRM-BRIDGE-5] o que a ponte devolve é EXATAMENTE { userId, name, role } — nunca permissions, authUserId, e-mail ou status — e um objeto novo a cada chamada', () => {
  const admin = contexto({ role: ROLE.ADMIN });
  const identidade = authorizeCrmOperation(admin, PERMISSION.WRITE_CRM);
  assert.deepEqual(Object.keys(identidade).sort(), ['name', 'role', 'userId']);
  assert.deepEqual(identidade, { userId: 'user-crm-1', name: 'Operador do CRM', role: ROLE.ADMIN });
  const texto = JSON.stringify(identidade);
  for (const proibido of ['auth-crm-1', 'operador-crm@example.test', 'permissions', 'READ:CRM', 'WRITE:CRM']) {
    assert.ok(!texto.includes(proibido), `a identidade não pode conter ${proibido}`);
  }
  const outra = authorizeCrmOperation(admin, PERMISSION.WRITE_CRM);
  assert.notEqual(outra, identidade, 'nunca o mesmo objeto: quem recebe não pode alterar o que outro recebeu');
  identidade.role = 'ALTERADA';
  assert.equal(authorizeCrmOperation(admin, PERMISSION.WRITE_CRM).role, ROLE.ADMIN);
});

test('[CRM-BRIDGE-6] só um AuthorizationContext EMITIDO atravessa: identidade simples, literal, cópia, clone, Proxy e não-objetos são recusados para as duas permissões', () => {
  const legitimo = contexto({ role: ROLE.ADMIN });
  const simples = { userId: legitimo.userId, name: legitimo.name, role: legitimo.role, permissions: [...legitimo.permissions] };
  const literal = { ...simples, authUserId: legitimo.authUserId, status: legitimo.status };
  const naoEmitidos = [
    ['texto livre', 'Breno'],
    ['um userId solto', legitimo.userId],
    ['número', 42],
    ['null', null],
    ['undefined', undefined],
    ['lista', []],
    ['função', () => legitimo],
    ['objeto vazio', {}],
    ['identidade simples { userId, name, role, permissions }', simples],
    ['literal com a forma perfeita de um contexto, congelado', Object.freeze({ ...literal, permissions: Object.freeze([...literal.permissions]) })],
    ['cópia rasa de um contexto real', { ...legitimo }],
    ['structuredClone de um contexto real', structuredClone(legitimo)],
    ['clone via JSON', JSON.parse(JSON.stringify(legitimo))],
    ['Object.create(contexto real)', Object.create(legitimo)],
    ['Proxy(contexto real)', new Proxy(legitimo, {})],
  ];
  for (const [nome, falso] of naoEmitidos) {
    for (const permissao of CRM_PERMISSIONS) {
      assert.ok(erroDe(() => authorizeCrmOperation(falso, permissao)), `${nome} (${permissao}) deveria ser recusado`);
    }
  }
});

test('[CRM-BRIDGE-7] ROLE != PERMISSION: um contexto com a role ADMIN mas SEM WRITE:CRM é recusado para escrever — a ponte decide pelas permissions do contexto, nunca pelo nome da role', (t) => {
  t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.READ_CRM]));
  const adminSemEscrita = contexto({ role: ROLE.ADMIN });
  assert.equal(adminSemEscrita.role, ROLE.ADMIN);
  assert.ok(!adminSemEscrita.permissions.includes(PERMISSION.WRITE_CRM), 'sanidade: o contexto emitido não tem WRITE:CRM');
  assert.match(erroDe(() => authorizeCrmOperation(adminSemEscrita, PERMISSION.WRITE_CRM)).message, /acesso negado/);
  assert.equal(authorizeCrmOperation(adminSemEscrita, PERMISSION.READ_CRM).role, ROLE.ADMIN, 'a leitura, que ele tem, continua autorizada');
});

test('[CRM-BRIDGE-8] um contexto sem NENHUMA permissão de CRM é recusado também para leitura', (t) => {
  t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.MANAGE_USERS]));
  const semCrm = contexto({ role: ROLE.ADMIN });
  assert.match(erroDe(() => authorizeCrmOperation(semCrm, PERMISSION.READ_CRM)).message, /acesso negado/);
  assert.match(erroDe(() => authorizeCrmOperation(semCrm, PERMISSION.WRITE_CRM)).message, /acesso negado/);
});

test('[CRM-BRIDGE-9] qualquer OUTRA permissão é recusada, mesmo para um ADMIN que a possui — e omitir a permissão é uma recusa, nunca leitura ou escrita por padrão', () => {
  const admin = contexto({ role: ROLE.ADMIN });
  for (const permissao of [
    PERMISSION.ANALYZE_CRM,
    PERMISSION.PROPOSE_CRM,
    PERMISSION.APPROVE_LEAD_APPROVAL,
    PERMISSION.APPROVE_OUTBOUND_APPROVAL,
    PERMISSION.MANAGE_USERS,
    undefined,
    null,
    '',
    'READ:CRM ',
    'read:crm',
    'WRITE:CRM\n',
    ['READ:CRM'],
    { toString: () => 'READ:CRM' },
    42,
  ]) {
    const erro = erroDe(() => authorizeCrmOperation(admin, permissao));
    assert.ok(erro, `${String(permissao)} deveria ser recusada`);
    assert.match(erro.message, /ponte do CRM só autoriza/);
  }
  assert.ok(erroDe(() => authorizeCrmOperation(admin)), 'sem o segundo argumento nada é autorizado');
});

test('[CRM-BRIDGE-10] a permissão pedida é validada ANTES de o contexto ser consultado: um pedido malformado nunca chega a autorizar nada, nem com um contexto inválido', () => {
  const erro = erroDe(() => authorizeCrmOperation('não é um contexto', 'PERMISSAO:INVENTADA'));
  assert.match(erro.message, /ponte do CRM só autoriza/);
});
