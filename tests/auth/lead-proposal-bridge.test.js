// A permissão PROPOSE:LEAD_APPROVAL e a ponte authorizeProposerForLeadApproval (src/auth/leadProposalBridge.js).
//
// Decisão do proprietário: PROPOSE:LEAD_APPROVAL representa APENAS a capacidade de PROPOR candidatos para análise humana. Não aprova,
// não promove e não escreve no CRM. Inicialmente o ADMIN a recebe e o COMMERCIAL_CLOSER NÃO. Estes testes tornam essa decisão
// explícita: na matriz (as listas por role), na ponte e na separação entre PROPOR, APROVAR e PROMOVER. Só contextos em memória, fictícios.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const constants = require('../../src/auth/constants');
const { ROLE, USER_STATUS, PERMISSION, defineUser, authorizeProposerForLeadApproval, authorizeReviewerForApprovalQueue, authorizeCrmOperation, hasPermission } = require('../../src/auth');
const { createAuthorizationContext } = require('../helpers/authFixtures');

const usuario = (role, extras = {}) =>
  defineUser({ userId: `user-${role}`, authUserId: `auth-${role}`, name: `Pessoa ${role}`, email: `${role}@example.test`, role, status: USER_STATUS.ACTIVE, ...extras });
const contexto = (role, extras) => createAuthorizationContext(usuario(role, extras));

test('[PROPOSE-1] a decisão está explícita na matriz: ADMIN recebe PROPOSE:LEAD_APPROVAL; COMMERCIAL_CLOSER NÃO recebe (e continua sem WRITE:CRM e MANAGE:USERS)', () => {
  assert.equal(PERMISSION.PROPOSE_LEAD_APPROVAL, 'PROPOSE:LEAD_APPROVAL');
  assert.equal(constants.isValidPermissionString('PROPOSE:LEAD_APPROVAL'), true);
  assert.equal(constants.ADMIN_PERMISSIONS.includes('PROPOSE:LEAD_APPROVAL'), true);
  assert.equal(constants.COMMERCIAL_CLOSER_PERMISSIONS.includes('PROPOSE:LEAD_APPROVAL'), false);
  assert.equal(hasPermission(contexto(ROLE.ADMIN), PERMISSION.PROPOSE_LEAD_APPROVAL), true);
  assert.equal(hasPermission(contexto(ROLE.COMMERCIAL_CLOSER), PERMISSION.PROPOSE_LEAD_APPROVAL), false);
  assert.deepEqual([...constants.COMMERCIAL_CLOSER_PERMISSIONS].sort(), ['ANALYZE:CRM', 'APPROVE:LEAD_APPROVAL', 'APPROVE:OUTBOUND_APPROVAL', 'PROPOSE:CRM', 'READ:CRM']);
  assert.equal(constants.ADMIN_PERMISSIONS.length, 8);
});

test('[PROPOSE-2] PROPOR não é APROVAR, PROMOVER nem ESCREVER: são permissões diferentes, com pontes diferentes — nenhuma implica a outra', () => {
  const propor = PERMISSION.PROPOSE_LEAD_APPROVAL;
  assert.notEqual(propor, PERMISSION.APPROVE_LEAD_APPROVAL);
  assert.notEqual(propor, PERMISSION.WRITE_CRM);
  assert.notEqual(propor, PERMISSION.PROPOSE_CRM, 'PROPOSE:CRM (do closer) não é a permissão de propor candidatos');
  const admin = contexto(ROLE.ADMIN);
  const closer = contexto(ROLE.COMMERCIAL_CLOSER);
  // o closer aprova, mas não propõe; o ADMIN faz as duas coisas — por permissões próprias
  assert.doesNotThrow(() => authorizeReviewerForApprovalQueue(closer));
  assert.throws(() => authorizeProposerForLeadApproval(closer), /PROPOSE:LEAD_APPROVAL|acesso negado|permiss/i);
  // a ponte de proposta não aprova, e a de aprovação não propõe
  assert.throws(() => authorizeProposerForLeadApproval(admin, PERMISSION.APPROVE_LEAD_APPROVAL), /só autoriza PROPOSE:LEAD_APPROVAL/);
  assert.throws(() => authorizeProposerForLeadApproval(admin, PERMISSION.WRITE_CRM), /só autoriza PROPOSE:LEAD_APPROVAL/);
  assert.throws(() => authorizeReviewerForApprovalQueue(admin, PERMISSION.PROPOSE_LEAD_APPROVAL), /só autoriza APPROVE:LEAD_APPROVAL/);
  assert.throws(() => authorizeCrmOperation(admin, PERMISSION.PROPOSE_LEAD_APPROVAL), /só autoriza/);
});

test('[PROPOSE-3] a ponte autoriza um contexto real com a permissão e devolve SÓ { userId, name, role }', () => {
  const identidade = authorizeProposerForLeadApproval(contexto(ROLE.ADMIN));
  assert.deepEqual(identidade, { userId: `user-${ROLE.ADMIN}`, name: `Pessoa ${ROLE.ADMIN}`, role: ROLE.ADMIN });
  assert.deepEqual(Object.keys(identidade), ['userId', 'name', 'role']);
  assert.deepEqual(authorizeProposerForLeadApproval(contexto(ROLE.ADMIN), PERMISSION.PROPOSE_LEAD_APPROVAL), identidade);
  assert.notEqual(authorizeProposerForLeadApproval(contexto(ROLE.ADMIN)), authorizeProposerForLeadApproval(contexto(ROLE.ADMIN)), 'sempre um objeto novo');
});

test('[PROPOSE-4] recusas: contexto forjado (mesmo com a forma perfeita), ausente, usuário inativo, e o CLOSER sem a permissão', () => {
  const admin = contexto(ROLE.ADMIN);
  const forjado = { ...admin };
  const clone = structuredClone({ userId: admin.userId, name: admin.name, role: admin.role, permissions: [...admin.permissions], status: 'ACTIVE' });
  for (const ruim of [forjado, clone, {}, null, undefined, 'admin', 42, [], { permissions: ['PROPOSE:LEAD_APPROVAL'] }]) {
    assert.throws(() => authorizeProposerForLeadApproval(ruim), undefined, String(JSON.stringify(ruim)).slice(0, 40));
  }
  assert.throws(() => authorizeProposerForLeadApproval(contexto(ROLE.ADMIN, { status: USER_STATUS.INACTIVE })), /inativo/);
  assert.throws(() => authorizeProposerForLeadApproval(contexto(ROLE.COMMERCIAL_CLOSER)), /PROPOSE:LEAD_APPROVAL|acesso negado|permiss/i);
});

test('[PROPOSE-5] a decisão lê só `permissions` do contexto emitido (nunca o nome da role): o código da ponte não compara role, e quem a decide é requirePermission', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'auth', 'leadProposalBridge.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(fonte, /\.role\s*(===|!==|==|!=)/, 'a ponte nunca decide pelo nome da role');
  assert.match(fonte, /requirePermission\(active, PERMISSION\.PROPOSE_LEAD_APPROVAL\)/);
  assert.match(fonte, /requireActiveUser\(context\)/);
  // e o comportamento acompanha a lista de permissões da role (não o rótulo): quem tem a permissão passa, quem não tem é recusado
  assert.doesNotThrow(() => authorizeProposerForLeadApproval(contexto(ROLE.ADMIN)));
  assert.throws(() => authorizeProposerForLeadApproval(contexto(ROLE.COMMERCIAL_CLOSER)));
});

test('[PROPOSE-6] a ponte é pequena e isolada: só depende de authorizationContext e constants, não importa o domínio do Prospector nem o CRM, e não tem lógica de fila, lote ou CRM', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'auth', 'leadProposalBridge.js'), 'utf8');
  const codigo = fonte.replace(/\/\/.*$/gm, '');
  const importados = [...codigo.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]).sort();
  assert.deepEqual(importados, ['./authorizationContext', './constants']);
  for (const proibido of [/research-prospector/, /\bcrm\b/i, /approvalQueue/, /QUEUE_STATE/, /lote/i]) assert.doesNotMatch(codigo, proibido, String(proibido));
});
