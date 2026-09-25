// Fase A — permissões efetivas determinadas pela ROLE (fechamento da fronteira
// de identidade e autorização; riscos R4 e R5).
//
// Decisão do proprietário: ADMIN possui EXATAMENTE 8 permissões e
// COMMERCIAL_CLOSER EXATAMENTE 5; não há customização de permissions por
// usuário. As listas abaixo são LITERAIS e independentes de src/ de propósito:
// se o código mudar (ou voltar a derivar as permissões do enum PERMISSION),
// estes testes falham em vez de acompanhar a mudança.
//
// Determinístico e sem rede: só importa src/auth/constants e src/auth/user
// (não carrega o adapter do Supabase).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROLE,
  USER_STATUS,
  PERMISSION,
  ADMIN_PERMISSIONS,
  COMMERCIAL_CLOSER_PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_PERMISSION_TEMPLATE,
  getRolePermissions,
} = require('../../src/auth/constants');
const { defineUser } = require('../../src/auth/user');

const ADMIN_LITERAL = [
  'READ:CRM',
  'ANALYZE:CRM',
  'PROPOSE:CRM',
  'WRITE:CRM',
  'PROPOSE:LEAD_APPROVAL',
  'APPROVE:LEAD_APPROVAL',
  'APPROVE:OUTBOUND_APPROVAL',
  'MANAGE:USERS',
];

const CLOSER_LITERAL = ['READ:CRM', 'ANALYZE:CRM', 'PROPOSE:CRM', 'APPROVE:LEAD_APPROVAL', 'APPROVE:OUTBOUND_APPROVAL'];

// Decisão EXPLÍCITA do que cada role NÃO recebe entre as permissões nomeadas em
// PERMISSION. Ao adicionar uma permissão nova ao enum, ela precisa entrar
// numa das duas listas de CADA role (concedida ou retida) — é isso que o
// [ROLE-3] cobra.
const ADMIN_EXPLICITLY_WITHHELD = [];
const CLOSER_EXPLICITLY_WITHHELD = ['WRITE:CRM', 'PROPOSE:LEAD_APPROVAL', 'MANAGE:USERS'];

const sorted = (list) => [...list].sort();

function userInput(overrides = {}) {
  return {
    userId: 'user-fase-a',
    authUserId: 'auth-fase-a',
    name: 'Usuário Fase A',
    email: 'fase-a@example.test',
    role: ROLE.ADMIN,
    status: USER_STATUS.ACTIVE,
    ...overrides,
  };
}

// ===========================================================================
// Tabela role -> permissions
// ===========================================================================
test('[ROLE-1] ADMIN possui EXATAMENTE 8 permissões, literais e iguais em todas as formas de acesso', () => {
  assert.equal(ADMIN_LITERAL.length, 8);
  assert.equal(ADMIN_PERMISSIONS.length, 8);
  assert.equal(new Set(ADMIN_PERMISSIONS).size, 8, 'sem duplicatas');
  assert.deepEqual(sorted(ADMIN_PERMISSIONS), sorted(ADMIN_LITERAL));
  assert.deepEqual(sorted(getRolePermissions(ROLE.ADMIN)), sorted(ADMIN_LITERAL));
  assert.deepEqual(sorted(ROLE_PERMISSIONS[ROLE.ADMIN]), sorted(ADMIN_LITERAL));
  assert.deepEqual(sorted(ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN]), sorted(ADMIN_LITERAL));

  assert.equal(Object.isFrozen(ADMIN_PERMISSIONS), true);
  assert.equal(Object.isFrozen(ROLE_PERMISSIONS), true);
  assert.equal(ROLE_PERMISSION_TEMPLATE, ROLE_PERMISSIONS, 'o nome antigo é alias do MESMO objeto, não uma segunda tabela');
});

test('[ROLE-2] COMMERCIAL_CLOSER possui EXATAMENTE 5 permissões, sem WRITE:CRM, PROPOSE:LEAD_APPROVAL nem MANAGE:USERS', () => {
  assert.equal(CLOSER_LITERAL.length, 5);
  assert.equal(COMMERCIAL_CLOSER_PERMISSIONS.length, 5);
  assert.equal(new Set(COMMERCIAL_CLOSER_PERMISSIONS).size, 5, 'sem duplicatas');
  assert.deepEqual(sorted(COMMERCIAL_CLOSER_PERMISSIONS), sorted(CLOSER_LITERAL));
  assert.deepEqual(sorted(getRolePermissions(ROLE.COMMERCIAL_CLOSER)), sorted(CLOSER_LITERAL));
  assert.deepEqual(sorted(ROLE_PERMISSION_TEMPLATE[ROLE.COMMERCIAL_CLOSER]), sorted(CLOSER_LITERAL));

  assert.equal(Object.isFrozen(COMMERCIAL_CLOSER_PERMISSIONS), true);
  assert.equal(COMMERCIAL_CLOSER_PERMISSIONS.includes(PERMISSION.WRITE_CRM), false);
  assert.equal(COMMERCIAL_CLOSER_PERMISSIONS.includes(PERMISSION.MANAGE_USERS), false);
});

test('[ROLE-3] trava contra crescimento implícito: toda permissão do enum tem decisão explícita para ADMIN e para COMMERCIAL_CLOSER', () => {
  const doEnum = sorted(Object.values(PERMISSION));
  const orientacao =
    'PERMISSION mudou sem decisão explícita. Decida se ADMIN e COMMERCIAL_CLOSER recebem a permissão nova, ' +
    'atualize ADMIN_PERMISSIONS/COMMERCIAL_CLOSER_PERMISSIONS em src/auth/constants.js e as listas literais deste teste.';

  assert.deepEqual(doEnum, sorted([...ADMIN_LITERAL, ...ADMIN_EXPLICITLY_WITHHELD]), `ADMIN: ${orientacao}`);
  assert.deepEqual(doEnum, sorted([...CLOSER_LITERAL, ...CLOSER_EXPLICITLY_WITHHELD]), `COMMERCIAL_CLOSER: ${orientacao}`);

  // Nenhuma permissão é, ao mesmo tempo, concedida e retida pela mesma role.
  assert.equal(ADMIN_LITERAL.filter((p) => ADMIN_EXPLICITLY_WITHHELD.includes(p)).length, 0);
  assert.equal(CLOSER_LITERAL.filter((p) => CLOSER_EXPLICITLY_WITHHELD.includes(p)).length, 0);

  // O que cada role de fato recebe é a lista decidida — não o enum inteiro.
  assert.deepEqual(sorted(ADMIN_PERMISSIONS), sorted(ADMIN_LITERAL));
  assert.deepEqual(sorted(COMMERCIAL_CLOSER_PERMISSIONS), sorted(CLOSER_LITERAL));
});

test('[ROLE-4] constants.js não deriva as permissões de nenhuma role do enum PERMISSION', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'auth', 'constants.js'), 'utf8');
  const semComentarios = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  assert.doesNotMatch(semComentarios, /Object\.(values|keys|entries)\(\s*PERMISSION\s*\)/);
  assert.doesNotMatch(semComentarios, /\.\.\.\s*PERMISSION\b/);

  // Sanidade do próprio teste: o código literal existe e a remoção de comentários não o apagou.
  assert.match(semComentarios, /const ADMIN_PERMISSIONS = Object\.freeze\(\[/);
  assert.match(semComentarios, /const COMMERCIAL_CLOSER_PERMISSIONS = Object\.freeze\(\[/);
});

// ===========================================================================
// defineUser(): as permissions efetivas vêm da role
// ===========================================================================
test('[USER-1] defineUser sem permissions deriva as permissions da role, como cópia congelada', () => {
  const admin = defineUser(userInput({ role: ROLE.ADMIN }));
  const closer = defineUser(
    userInput({
      userId: 'user-fase-a-closer',
      authUserId: 'auth-fase-a-closer',
      email: 'closer-fase-a@example.test',
      role: ROLE.COMMERCIAL_CLOSER,
    })
  );

  assert.deepEqual(sorted(admin.permissions), sorted(ADMIN_LITERAL));
  assert.deepEqual(sorted(closer.permissions), sorted(CLOSER_LITERAL));
  assert.equal(admin.permissions.length, 8);
  assert.equal(closer.permissions.length, 5);
  assert.equal(Object.isFrozen(admin.permissions), true);
  assert.equal(Object.isFrozen(closer.permissions), true);

  // Cópia: nunca o mesmo array da tabela da role.
  assert.notEqual(admin.permissions, ADMIN_PERMISSIONS);
  assert.notEqual(closer.permissions, COMMERCIAL_CLOSER_PERMISSIONS);

  // Nem o array do chamador: alterá-lo depois da criação não afeta o USER.
  const doChamador = [...CLOSER_LITERAL];
  const comArrayDoChamador = defineUser(userInput({ role: ROLE.COMMERCIAL_CLOSER, permissions: doChamador }));
  assert.notEqual(comArrayDoChamador.permissions, doChamador);
  doChamador.push('MANAGE:USERS');
  assert.equal(comArrayDoChamador.permissions.includes('MANAGE:USERS'), false);
  assert.equal(comArrayDoChamador.permissions.length, 5);
});

test('[USER-2] defineUser rejeita qualquer conjunto de permissions diferente do conjunto da role', () => {
  const comoCloser = (permissions) => userInput({ role: ROLE.COMMERCIAL_CLOSER, permissions });
  const comoAdmin = (permissions) => userInput({ role: ROLE.ADMIN, permissions });

  const tentativas = [
    ['CLOSER + MANAGE:USERS', comoCloser([...CLOSER_LITERAL, 'MANAGE:USERS'])],
    ['CLOSER + WRITE:CRM', comoCloser([...CLOSER_LITERAL, 'WRITE:CRM'])],
    ['CLOSER com o conjunto inteiro do ADMIN', comoCloser([...ADMIN_LITERAL])],
    ['CLOSER faltando uma permissão', comoCloser(CLOSER_LITERAL.slice(1))],
    ['CLOSER com uma trocada por MANAGE:USERS (mesma contagem)', comoCloser([...CLOSER_LITERAL.slice(1), 'MANAGE:USERS'])],
    ['CLOSER com lista vazia', comoCloser([])],
    ['ADMIN faltando uma permissão', comoAdmin(ADMIN_LITERAL.slice(1))],
    ['ADMIN com o conjunto do CLOSER', comoAdmin([...CLOSER_LITERAL])],
    ['ADMIN com uma duplicata a mais', comoAdmin([...ADMIN_LITERAL, 'READ:CRM'])],
    ['ADMIN com uma faltando e outra repetida (mesma contagem)', comoAdmin([...ADMIN_LITERAL.slice(1), 'ANALYZE:CRM'])],
    ['ADMIN com lista vazia', comoAdmin([])],
  ];

  for (const [rotulo, entrada] of tentativas) {
    assert.throws(() => defineUser(entrada), /não podem diferir das permissions da role/, rotulo);
  }
});

test('[USER-3] defineUser aceita permissions exatamente iguais ao conjunto da role, em qualquer ordem, e guarda a lista canônica', () => {
  const adminInvertido = defineUser(userInput({ role: ROLE.ADMIN, permissions: [...ADMIN_LITERAL].reverse() }));
  assert.deepEqual([...adminInvertido.permissions], [...ADMIN_PERMISSIONS], 'guarda a ordem canônica da tabela, não a do chamador');

  const adminDaTabela = defineUser(userInput({ role: ROLE.ADMIN, permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN] }));
  assert.deepEqual(sorted(adminDaTabela.permissions), sorted(ADMIN_LITERAL));

  const closerInvertido = defineUser(userInput({ role: ROLE.COMMERCIAL_CLOSER, permissions: [...CLOSER_LITERAL].reverse() }));
  assert.deepEqual([...closerInvertido.permissions], [...COMMERCIAL_CLOSER_PERMISSIONS]);
});

test('[USER-4] role inválida e permissions inválidas continuam rejeitadas, e os erros anteriores mantêm a precedência', () => {
  for (const role of ['SUPER_ADMIN', 'SYSTEM', 'admin', undefined, null]) {
    assert.throws(() => defineUser(userInput({ role })), /role desconhecida/, `defineUser com role ${String(role)}`);
  }
  for (const role of ['SUPER_ADMIN', 'admin', 'constructor', '__proto__', 'toString', undefined]) {
    assert.throws(() => getRolePermissions(role), /role desconhecida/, `getRolePermissions(${String(role)})`);
  }

  const invalidas = ['not-valid', '*', '*:*', 'ADMIN', 'ADMIN:*', '*:CRM', 'read:crm', 'READ'];
  for (const invalida of invalidas) {
    assert.throws(() => defineUser(userInput({ permissions: [invalida] })), /permissions/, `[${invalida}]`);
    assert.throws(() => defineUser(userInput({ permissions: [...ADMIN_LITERAL, invalida] })), /permissions/, `7 + ${invalida}`);
  }
  for (const naoLista of ['READ:CRM', 123, null, {}, true]) {
    assert.throws(() => defineUser(userInput({ permissions: naoLista })), /permissions deve ser uma lista/, String(naoLista));
  }

  // Precedência: um erro anterior continua sendo o reportado, mesmo com permissions divergentes.
  assert.throws(() => defineUser(userInput({ status: 'PAUSED', permissions: [] })), /status desconhecido/);
  assert.throws(() => defineUser(userInput({ userId: '', permissions: [] })), /userId/);
});
