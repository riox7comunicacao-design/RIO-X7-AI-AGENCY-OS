const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLE,
  USER_STATUS,
  PERMISSION,
  ROLE_PERMISSION_TEMPLATE,
  isValidPermissionString,
  defineUser,
  requireActiveUser,
  hasPermission,
  requirePermission,
  createUserStore,
  resolveAuthorizationContext,
  isSupabaseConfigured,
  createSupabaseAuthAdapter,
  toApprovalQueueIdentity,
} = require('../../src/auth');
// Fase C: createAuthorizationContext não é mais exportado por src/auth; os testes o
// obtêm do helper de composição (o mesmo emissor interno que o userResolver usa).
const { createAuthorizationContext } = require('../helpers/authFixtures');

function buildAdmin(overrides = {}) {
  return defineUser({
    userId: 'user-admin-1',
    authUserId: 'auth-admin-1',
    name: 'Admin de Teste',
    email: 'admin@example.test',
    role: ROLE.ADMIN,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN],
    status: USER_STATUS.ACTIVE,
    ...overrides,
  });
}

function buildCloser(overrides = {}) {
  return defineUser({
    userId: 'user-closer-1',
    authUserId: 'auth-closer-1',
    name: 'Closer de Teste',
    email: 'closer@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.COMMERCIAL_CLOSER],
    status: USER_STATUS.ACTIVE,
    ...overrides,
  });
}

// [A] ADMIN ativo possui suas permissões explícitas.
test('[A] ADMIN ativo possui suas permissões explícitas, nunca um coringa "*:*"', () => {
  const context = createAuthorizationContext(buildAdmin());
  for (const permission of Object.values(PERMISSION)) {
    assert.equal(hasPermission(context, permission), true);
  }
  assert.equal(context.permissions.includes('*:*'), false);
  assert.equal(context.permissions.every(isValidPermissionString), true);
});

// [B] CLOSER ativo possui exatamente o conjunto aprovado.
test('[B] CLOSER ativo possui exatamente as permissões aprovadas no Passo 0009.6', () => {
  const context = createAuthorizationContext(buildCloser());
  assert.deepEqual(
    [...context.permissions].sort(),
    ['ANALYZE:CRM', 'APPROVE:LEAD_APPROVAL', 'APPROVE:OUTBOUND_APPROVAL', 'PROPOSE:CRM', 'READ:CRM'].sort()
  );
});

// [C] CLOSER não possui MANAGE:USERS.
test('[C] CLOSER não possui MANAGE:USERS', () => {
  const context = createAuthorizationContext(buildCloser());
  assert.equal(context.permissions.includes(PERMISSION.MANAGE_USERS), false);
  assert.equal(hasPermission(context, PERMISSION.MANAGE_USERS), false);
});

// [D] CLOSER passa em requirePermission(APPROVE:LEAD_APPROVAL).
test('[D] CLOSER passa em requirePermission(APPROVE:LEAD_APPROVAL)', () => {
  const context = createAuthorizationContext(buildCloser());
  assert.doesNotThrow(() => requirePermission(context, PERMISSION.APPROVE_LEAD_APPROVAL));
});

// [E] CLOSER passa em requirePermission(APPROVE:OUTBOUND_APPROVAL).
test('[E] CLOSER passa em requirePermission(APPROVE:OUTBOUND_APPROVAL)', () => {
  const context = createAuthorizationContext(buildCloser());
  assert.doesNotThrow(() => requirePermission(context, PERMISSION.APPROVE_OUTBOUND_APPROVAL));
});

// [F] CLOSER não passa em requirePermission(MANAGE:USERS).
test('[F] CLOSER não passa em requirePermission(MANAGE:USERS)', () => {
  const context = createAuthorizationContext(buildCloser());
  assert.throws(() => requirePermission(context, PERMISSION.MANAGE_USERS), /acesso negado/);
});

// [G] usuário INACTIVE falha em autorização.
test('[G] usuário INACTIVE falha em requireActiveUser/requirePermission, e hasPermission nunca retorna true', () => {
  const inactiveAdmin = buildAdmin({
    userId: 'user-admin-inactive',
    authUserId: 'auth-admin-inactive',
    status: USER_STATUS.INACTIVE,
  });
  const context = createAuthorizationContext(inactiveAdmin);

  assert.throws(() => requireActiveUser(context), /inativo/);
  assert.throws(() => requirePermission(context, PERMISSION.APPROVE_LEAD_APPROVAL), /inativo/);
  assert.equal(hasPermission(context, PERMISSION.APPROVE_LEAD_APPROVAL), false);
});

// [H] usuário sem a permissão exigida falha.
test('[H] usuário ativo sem a permissão exigida falha em requirePermission', () => {
  const context = createAuthorizationContext(buildCloser());
  assert.throws(() => requirePermission(context, PERMISSION.WRITE_CRM), /acesso negado/);
  assert.equal(hasPermission(context, PERMISSION.WRITE_CRM), false);
});

// [I] permissão inválida deve ser rejeitada em toda checagem.
test('[I] permissão inválida (formato errado ou ação desconhecida) é sempre rejeitada', () => {
  const context = createAuthorizationContext(buildAdmin());
  assert.throws(() => requirePermission(context, 'nao-e-uma-permissao'), /permissão inválida/);
  assert.throws(() => hasPermission(context, 'FOO:BAR'), /permissão inválida/);
  assert.throws(
    () =>
      defineUser({
        userId: 'x',
        name: 'X',
        email: 'x@example.test',
        role: ROLE.ADMIN,
        permissions: ['nao-e-uma-permissao'],
        status: USER_STATUS.ACTIVE,
      }),
    /permissions/
  );
});

// [J] role inválida deve ser rejeitada.
test('[J] role inválida é rejeitada em defineUser, e um literal com role inválida nunca origina contexto', () => {
  assert.throws(
    () =>
      defineUser({
        userId: 'x',
        name: 'X',
        email: 'x@example.test',
        role: 'SYSTEM',
        permissions: [],
        status: USER_STATUS.ACTIVE,
      }),
    /role desconhecida/
  );
  // Fase C: o emissor só aceita um USER definido por defineUser() — um literal com
  // role inválida nem chega a ser avaliado, é rejeitado por não ser um USER definido.
  assert.throws(
    () => createAuthorizationContext({ userId: 'x', name: 'X', role: 'SYSTEM', permissions: [], status: USER_STATUS.ACTIVE }),
    /USER definido por defineUser/
  );
});

// [K] status inválido deve ser rejeitado.
test('[K] status inválido é rejeitado em defineUser, e um literal com status inválido nunca origina contexto', () => {
  assert.throws(
    () =>
      defineUser({
        userId: 'x',
        name: 'X',
        email: 'x@example.test',
        role: ROLE.ADMIN,
        permissions: [],
        status: 'PAUSED',
      }),
    /status desconhecido/
  );
  // Fase C: idem — um literal com status inválido não é um USER definido.
  assert.throws(
    () => createAuthorizationContext({ userId: 'x', name: 'X', role: ROLE.ADMIN, permissions: [], status: 'PAUSED' }),
    /USER definido por defineUser/
  );
});

// [L] AuthorizationContext não aceita dados incompletos.
test('[L] AuthorizationContext não aceita dados incompletos: só um USER definido origina contexto', () => {
  // Fase C: nenhum objeto incompleto (ou completo, mas solto) origina contexto.
  const incompletos = [
    null,
    undefined,
    {},
    { userId: 'x' },
    { userId: 'x', name: 'X' },
    { userId: 'x', name: 'X', role: ROLE.ADMIN },
  ];
  for (const incompleto of incompletos) {
    assert.throws(() => createAuthorizationContext(incompleto), /USER definido por defineUser/);
  }
});

// [M] AI actor não pode ser tratado como USER humano.
test('[M] um objeto fabricado simulando um especialista de IA se passando por ADMIN nunca é aceito', () => {
  const forged = {
    userId: 'ai-actor',
    name: 'COO Orchestrator',
    role: ROLE.ADMIN,
    permissions: Object.values(PERMISSION),
    status: USER_STATUS.ACTIVE,
  };

  assert.equal(Object.isFrozen(forged), false);
  assert.throws(() => requirePermission(forged, PERMISSION.APPROVE_LEAD_APPROVAL), /emitido pelo emissor interno confiável/);
  assert.throws(() => hasPermission(forged, PERMISSION.APPROVE_LEAD_APPROVAL), /emitido pelo emissor interno confiável/);

  // Fase C: congelar o objeto à mão (a "prova" antiga) também não basta — o que vale é a
  // marca de emissão, não o Object.freeze.
  const forgedCongelado = Object.freeze({ ...forged, authUserId: 'auth-ai-actor', permissions: Object.freeze([...forged.permissions]) });
  assert.throws(() => requirePermission(forgedCongelado, PERMISSION.APPROVE_LEAD_APPROVAL), /emitido pelo emissor interno confiável/);
  assert.throws(() => hasPermission(forgedCongelado, PERMISSION.APPROVE_LEAD_APPROVAL), /emitido pelo emissor interno confiável/);

  // "SYSTEM" (o actor de IA já usado em approvalQueue.js) nunca é um role de USER válido.
  assert.throws(
    () =>
      defineUser({
        userId: 'ai',
        name: 'IA',
        email: 'ia@example.test',
        role: 'SYSTEM',
        permissions: [],
        status: USER_STATUS.ACTIVE,
      }),
    /role desconhecida/
  );
});

// [N] nenhum teste exige credenciais reais — o adapter nunca finge uma sessão.
test('[N] authAdapter nunca finge uma sessão Supabase quando não configurado', async () => {
  assert.equal(isSupabaseConfigured({}), false);
  const adapter = createSupabaseAuthAdapter({});
  assert.equal(adapter.isConfigured(), false);
  await assert.rejects(() => adapter.resolveAuthenticatedIdentity(), /não configurado/);
});

test('userResolver: resolve AuthorizationContext a partir de authUserId, sem criar usuário novo', () => {
  const store = createUserStore([buildCloser()]);
  const context = resolveAuthorizationContext(store, { authUserId: 'auth-closer-1' });
  assert.equal(context.userId, 'user-closer-1');
  assert.throws(
    () => resolveAuthorizationContext(store, { authUserId: 'nao-existe', email: 'nao-existe@example.test' }),
    /não encontrado/
  );
});

test('approvalQueueBridge: AuthorizationContext do CLOSER aprova um prospect real no Approval Queue, sem alterar approvalQueue.js', () => {
  const { createEmptyQueue, addProspect, approveProspect } = require('../../src/research-prospector/approvalQueue');
  const { runDiscoveryPipeline, SOURCE_TYPE } = require('../../src/research-prospector/discovery');

  const briefing = { nicho: 'Psicologia', regiao: 'Petrópolis/RJ', exclusoes: [] };
  const achado = {
    empresa: 'Consultório Bridge Teste',
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Psicologia',
    campos: {
      site: [{ valor: 'consultoriobridgeteste.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }],
    },
    fontes: [],
  };
  const resultado = runDiscoveryPipeline({ briefing, rawFindings: [achado], crmRecords: [] }).resultados[0];

  const queue = createEmptyQueue();
  const item = addProspect(queue, resultado);

  const context = createAuthorizationContext(buildCloser());
  const identity = toApprovalQueueIdentity(context);
  const aprovado = approveProspect(queue, item.prospectId, identity, 'Bom fit — aprovado via bridge de teste');

  assert.equal(aprovado.estado, 'APROVADO_PARA_CRM');
  assert.equal(aprovado.historico[aprovado.historico.length - 1].reviewedBy.userId, 'user-closer-1');
});
