// A permissão MANAGE:CRM_CATALOGS e a ponte authorizeCatalogOperation (src/auth/catalogBridge.js) — CRM 5.0, Fase 2B-1 (decisão 0026).
//
// Decisão do proprietário: SÓ o ADMIN administra os catálogos (Serviços, Nichos, Origens dos Leads); quem tem READ:CRM (ADMIN e
// COMMERCIAL_CLOSER) consulta os itens ativos. A ponte autoriza exatamente essas duas permissões. Contextos EMITIDOS pelo emissor interno
// (nunca fabricados à mão), dados fictícios, sem rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const constants = require('../../src/auth/constants');
const barrel = require('../../src/auth');
const { authorizeCatalogOperation, CATALOG_PERMISSIONS } = require('../../src/auth/catalogBridge');
const { ROLE, USER_STATUS, PERMISSION, defineUser, hasPermission } = barrel;
const { createAuthorizationContext } = require('../helpers/authFixtures');

const usuario = (role, extras = {}) => defineUser({ userId: `user-${role}`, authUserId: `auth-${role}`, name: `Pessoa ${role}`, email: `${role}@example.test`, role, status: USER_STATUS.ACTIVE, ...extras });
const contexto = (role, extras) => createAuthorizationContext(usuario(role, extras));

test('[CATBR-1] a permissão: MANAGE:CRM_CATALOGS existe, tem formato válido, é só do ADMIN (decisão explícita) — e o COMMERCIAL_CLOSER continua com as mesmas 5', () => {
  assert.equal(PERMISSION.MANAGE_CRM_CATALOGS, 'MANAGE:CRM_CATALOGS');
  assert.equal(constants.isValidPermissionString('MANAGE:CRM_CATALOGS'), true);
  assert.equal(constants.ADMIN_PERMISSIONS.includes('MANAGE:CRM_CATALOGS'), true);
  assert.equal(constants.COMMERCIAL_CLOSER_PERMISSIONS.includes('MANAGE:CRM_CATALOGS'), false);
  assert.equal(constants.ADMIN_PERMISSIONS.length, 12);
  assert.equal(constants.COMMERCIAL_CLOSER_PERMISSIONS.length, 5);
  assert.equal(hasPermission(contexto(ROLE.ADMIN), PERMISSION.MANAGE_CRM_CATALOGS), true);
  assert.equal(hasPermission(contexto(ROLE.COMMERCIAL_CLOSER), PERMISSION.MANAGE_CRM_CATALOGS), false);
  // não é herdada de outra permissão: quem administra Funis ou Exclusões não administra catálogos por isso, e vice-versa
  assert.notEqual(PERMISSION.MANAGE_CRM_CATALOGS, PERMISSION.MANAGE_FUNNELS);
  assert.notEqual(PERMISSION.MANAGE_CRM_CATALOGS, PERMISSION.MANAGE_PROSPECTING_EXCLUSIONS);
  assert.notEqual(PERMISSION.MANAGE_CRM_CATALOGS, PERMISSION.WRITE_CRM);
});

test('[CATBR-2] a ponte autoriza só READ:CRM e MANAGE:CRM_CATALOGS; ADMIN recebe as duas, COMMERCIAL_CLOSER só a leitura', () => {
  assert.deepEqual([...CATALOG_PERMISSIONS], ['READ:CRM', 'MANAGE:CRM_CATALOGS']);
  assert.equal(Object.isFrozen(CATALOG_PERMISSIONS), true);
  assert.equal(barrel.authorizeCatalogOperation, authorizeCatalogOperation, 'exportada pelo barrel de src/auth');
  const admin = contexto(ROLE.ADMIN);
  const closer = contexto(ROLE.COMMERCIAL_CLOSER);
  assert.doesNotThrow(() => authorizeCatalogOperation(admin, PERMISSION.READ_CRM));
  assert.doesNotThrow(() => authorizeCatalogOperation(admin, PERMISSION.MANAGE_CRM_CATALOGS));
  assert.doesNotThrow(() => authorizeCatalogOperation(closer, PERMISSION.READ_CRM));
  assert.throws(() => authorizeCatalogOperation(closer, PERMISSION.MANAGE_CRM_CATALOGS), /acesso negado/);
});

test('[CATBR-3] devolve SÓ a identidade mínima { userId, name, role } — nunca permissions, authUserId, e-mail, status ou token', () => {
  const identidade = authorizeCatalogOperation(contexto(ROLE.ADMIN), PERMISSION.MANAGE_CRM_CATALOGS);
  assert.deepEqual(Object.keys(identidade).sort(), ['name', 'role', 'userId']);
  assert.deepEqual(identidade, { userId: 'user-ADMIN', name: 'Pessoa ADMIN', role: 'ADMIN' });
  assert.equal(JSON.stringify(identidade).includes('auth-'), false);
  assert.equal(JSON.stringify(identidade).includes('example.test'), false);
});

test('[CATBR-4] qualquer OUTRA permissão é recusada pela ponte, mesmo que o contexto a possua: WRITE:CRM, DELETE:CRM, PROPOSE:CRM, MANAGE:FUNNELS, MANAGE:USERS, uma permissão omitida, null ou de formato estranho', () => {
  const admin = contexto(ROLE.ADMIN);
  for (const ruim of [PERMISSION.WRITE_CRM, PERMISSION.DELETE_CRM, PERMISSION.PROPOSE_CRM, PERMISSION.ANALYZE_CRM, PERMISSION.MANAGE_FUNNELS, PERMISSION.MANAGE_USERS, PERMISSION.MANAGE_PROSPECTING_EXCLUSIONS, 'MANAGE:CRM', 'READ:CRM ', 'manage:crm_catalogs', undefined, null, '', 5, {}, [PERMISSION.READ_CRM], true]) {
    assert.throws(() => authorizeCatalogOperation(admin, ruim), /ponte dos catálogos do CRM só autoriza READ:CRM e MANAGE:CRM_CATALOGS/, String(ruim));
  }
});

test('[CATBR-5] usuário INATIVO e contexto que não foi emitido (objeto à mão, cópia, clone) são recusados — a decisão lê só `permissions` do contexto emitido, nunca o nome da role', () => {
  const inativo = createAuthorizationContext(usuario(ROLE.ADMIN, { status: USER_STATUS.INACTIVE }));
  for (const permissao of CATALOG_PERMISSIONS) assert.throws(() => authorizeCatalogOperation(inativo, permissao), /usuário inativo/);
  const emitido = contexto(ROLE.ADMIN);
  const forjados = [
    { userId: 'x', name: 'x', role: 'ADMIN', permissions: ['MANAGE:CRM_CATALOGS', 'READ:CRM'], status: 'ACTIVE' },
    { ...emitido },
    structuredClone({ ...emitido }),
    Object.create(emitido),
    null,
    undefined,
    'ADMIN',
  ];
  for (const falso of forjados) {
    for (const permissao of CATALOG_PERMISSIONS) assert.throws(() => authorizeCatalogOperation(falso, permissao), Error);
  }
});

test('[CATBR-6] a checagem da permissão pedida vem ANTES da do contexto: um pedido malformado nunca chega a consultar o contexto', () => {
  let consultado = false;
  const espiao = new Proxy({}, { get() { consultado = true; return undefined; }, has() { consultado = true; return false; } });
  assert.throws(() => authorizeCatalogOperation(espiao, 'EXECUTE:ALGO'), /ponte dos catálogos do CRM/);
  assert.equal(consultado, false);
});

test('[CATBR-7] a ponte só depende de authorizationContext.js e constants.js: não importa src/crm nem src/services (auth e domínio desacoplados, sem ciclo)', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'auth', 'catalogBridge.js'), 'utf8');
  const requires = [...fonte.replace(/\/\/.*$/gm, '').matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(requires, ['./authorizationContext', './constants']);
});
