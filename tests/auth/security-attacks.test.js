// Passo 0009.7 — testes de ataque contra a fundação de autorização
// (src/auth/*), criada no Passo 0009.6.
//
// Este arquivo é deliberadamente separado de authorization.test.js: aquele
// prova que o sistema funciona corretamente (casos de uso); este tenta
// QUEBRAR o sistema (casos de abuso). Alguns testes abaixo demonstram um
// ataque que HOJE FUNCIONA — isso é intencional e documentado explicitamente
// como "NÃO BLOQUEADO — PENDENTE, depende de autenticação real" (ver
// docs/security/0001-authorization-threat-model.md). Nenhum teste finge uma
// proteção que não existe.

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
  USER_NOT_FOUND,
  isSupabaseConfigured,
  createSupabaseAuthAdapter,
  toApprovalQueueIdentity,
} = require('../../src/auth');
// Fase C: createAuthorizationContext não é mais exportado por src/auth; os testes o
// obtêm do helper de composição (o mesmo emissor interno que o userResolver usa).
const { createAuthorizationContext, verifiedIdentityFor, verifiedIdentitiesFor } = require('../helpers/authFixtures');

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

// ===========================================================================
// ATAQUE A — CLOSER tentando MANAGE:USERS
// ===========================================================================
test('[ATAQUE A] CLOSER tentando MANAGE:USERS é REJEITADO', () => {
  const context = createAuthorizationContext(buildCloser());
  assert.throws(() => requirePermission(context, PERMISSION.MANAGE_USERS), /acesso negado/);
  assert.equal(hasPermission(context, PERMISSION.MANAGE_USERS), false);
});

// ===========================================================================
// ATAQUE B — CLOSER tentando privilégios inexistentes
// ===========================================================================
test('[ATAQUE B] CLOSER tentando permissões não concedidas é REJEITADO, sem fallback', () => {
  const context = createAuthorizationContext(buildCloser());
  const naoConcedidas = ['WRITE:CRM', 'DELETE:CRM', 'SEND:OUTBOUND', 'PUBLISH:CONTENT', 'MANAGE:USERS'];
  for (const permission of naoConcedidas) {
    assert.equal(isValidPermissionString(permission), true, `${permission} deveria ter formato válido para este teste ser significativo`);
    assert.throws(() => requirePermission(context, permission), /acesso negado/, `${permission} deveria ser rejeitada`);
    assert.equal(hasPermission(context, permission), false, `${permission} não deveria retornar true`);
  }
});

// ===========================================================================
// ATAQUE C — usuário INACTIVE
// ===========================================================================
test('[ATAQUE C] CLOSER INACTIVE com APPROVE:LEAD_APPROVAL ainda assim é REJEITADO', () => {
  const inactiveCloser = buildCloser({
    userId: 'user-closer-inactive',
    authUserId: 'auth-closer-inactive',
    status: USER_STATUS.INACTIVE,
  });
  const context = createAuthorizationContext(inactiveCloser);

  assert.ok(context.permissions.includes(PERMISSION.APPROVE_LEAD_APPROVAL));
  assert.throws(() => requireActiveUser(context), /inativo/);
  assert.throws(() => requirePermission(context, PERMISSION.APPROVE_LEAD_APPROVAL), /inativo/);
  assert.equal(hasPermission(context, PERMISSION.APPROVE_LEAD_APPROVAL), false);
});

// ===========================================================================
// ATAQUE D — contexto adulterado (role/permissions incompatíveis com o USER real)
// ===========================================================================
// ATUALIZADO NA FASE C: createAuthorizationContext() deixou de ser um
// construtor público. O emissor interno só aceita um USER devolvido por
// defineUser() (e com authUserId), e os serviços só aceitam contextos que esse
// emissor emitiu: um objeto forjado — mesmo com a forma certa, mesmo congelado
// — é rejeitado nos dois pontos. Isto é uma fronteira arquitetural interna
// confiável, NÃO criptografia: não protege contra código malicioso que já
// controle o processo e importe o emissor interno (o teste estático de imports
// da Fase F vigia quem pode importá-lo).
test('[ATAQUE D] contexto forjado com role=ADMIN, sem corresponder a nenhum USER real, é REJEITADO', () => {
  const closerReal = buildCloser();

  const forjado = {
    userId: closerReal.userId, // mesmo userId de um Closer real...
    name: closerReal.name,
    role: ROLE.ADMIN, // ...mas role trocado para ADMIN
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN], // ...com todas as permissões de ADMIN
    status: USER_STATUS.ACTIVE,
  };

  // 1) O emissor só aceita USER definido por defineUser(): um literal com a forma certa não é.
  assert.throws(() => createAuthorizationContext(forjado), /USER definido por defineUser/);

  // 2) Um objeto que imita o contexto — inclusive congelado e com authUserId — não passa como contexto emitido.
  const contextoForjado = Object.freeze({
    ...forjado,
    authUserId: 'auth-forjado',
    permissions: Object.freeze([...forjado.permissions]),
  });
  assert.throws(() => requirePermission(contextoForjado, PERMISSION.MANAGE_USERS), /emitido pelo emissor interno confiável/);
  assert.throws(() => hasPermission(contextoForjado, PERMISSION.MANAGE_USERS), /emitido pelo emissor interno confiável/);
});

// ===========================================================================
// ATAQUE E — IA fingindo ser ADMIN
// ===========================================================================
test('[ATAQUE E-1] um objeto {actorType:"AI", role:"ADMIN", ...} SEM passar pelo emissor interno é REJEITADO', () => {
  const fingindoSerAdmin = {
    actorType: 'AI',
    userId: 'ai-actor-coo',
    name: 'COO Orchestrator',
    role: ROLE.ADMIN,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN],
    status: USER_STATUS.ACTIVE,
  };

  // Este objeto nunca foi emitido pelo emissor interno (a marca de emissão é a
  // proteção estrutural — desde a Fase C não depende mais de Object.freeze).
  assert.equal(Object.isFrozen(fingindoSerAdmin), false);
  assert.throws(() => requirePermission(fingindoSerAdmin, PERMISSION.MANAGE_USERS), /emitido pelo emissor interno confiável/);
  assert.throws(() => hasPermission(fingindoSerAdmin, PERMISSION.MANAGE_USERS), /emitido pelo emissor interno confiável/);
});

// ATUALIZADO NA FASE C: o mesmo objeto, passado ao emissor interno, é
// rejeitado — o emissor só aceita um USER definido por defineUser(). O que
// CONTINUA verdade, e é registrado aqui com honestidade: não existe "actor
// model" que marque a origem (IA vs. humano) dentro do próprio dado. Quem tem
// acesso ao emissor interno E a defineUser() consegue emitir um contexto — a
// fronteira é arquitetural (só o userResolver deve importar o emissor; o teste
// estático de imports da Fase F vigia isso), não criptográfica. Nenhuma
// validação de "actorType" foi adicionada: seria trivialmente contornável por
// quem simplesmente omitisse o campo, dando falsa confiança.
test('[ATAQUE E-2] o mesmo objeto, PASSADO ao emissor interno, é REJEITADO: só um USER definido origina contexto', () => {
  const fingindoSerAdmin = {
    actorType: 'AI',
    userId: 'ai-actor-coo',
    name: 'COO Orchestrator',
    role: ROLE.ADMIN,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN],
    status: USER_STATUS.ACTIVE,
  };

  // O literal nunca origina contexto, nem passando pelo emissor.
  assert.throws(() => createAuthorizationContext(fingindoSerAdmin), /USER definido por defineUser/);

  // Documentação honesta do limite da fronteira: o caminho legítimo
  // (defineUser + emissor interno) existe e emite — e actorType é descartado.
  const definido = defineUser({
    userId: 'ai-actor-coo',
    authUserId: 'auth-ai-actor-coo',
    name: 'COO Orchestrator',
    email: 'coo@example.test',
    role: ROLE.ADMIN,
    status: USER_STATUS.ACTIVE,
    actorType: 'AI',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(definido, 'actorType'), false);
  const context = createAuthorizationContext(definido);
  assert.equal(Object.prototype.hasOwnProperty.call(context, 'actorType'), false, 'actorType é descartado, não usado para bloquear nem preservado');
  assert.doesNotThrow(() => requirePermission(context, PERMISSION.MANAGE_USERS));
});

// ===========================================================================
// ATAQUE F — Permission injection
// ===========================================================================
// ATUALIZADO NA FASE C: a injeção de permissions é bloqueada em três camadas —
// defineUser() rejeita um conjunto ≠ role (Fase A), o emissor rejeita a cópia
// adulterada (não é um USER definido) e, mesmo para um USER autêntico, as
// permissions do contexto são derivadas da ROLE, nunca de user.permissions.
test('[ATAQUE F] injetar MANAGE:USERS nas permissions de um CLOSER é REJEITADO em todas as camadas', () => {
  const closerReal = buildCloser();

  // 1) defineUser() rejeita um conjunto de permissions diferente do da role.
  assert.throws(
    () => buildCloser({ permissions: [...closerReal.permissions, PERMISSION.MANAGE_USERS] }),
    /não podem diferir das permissions da role/
  );

  // 2) Uma cópia adulterada de um USER real não é um USER definido: o emissor a rejeita.
  const comPermissaoInjetada = {
    ...closerReal,
    permissions: [...closerReal.permissions, PERMISSION.MANAGE_USERS],
  };
  assert.throws(() => createAuthorizationContext(comPermissaoInjetada), /USER definido por defineUser/);

  // 3) O USER autêntico continua sem MANAGE:USERS: o contexto vem da role.
  const context = createAuthorizationContext(closerReal);
  assert.equal(hasPermission(context, PERMISSION.MANAGE_USERS), false);
  assert.throws(() => requirePermission(context, PERMISSION.MANAGE_USERS), /acesso negado/);
});

// ===========================================================================
// ATAQUE G — Role injection
// ===========================================================================
// ATUALIZADO NA FASE C: a troca de role numa cópia do USER é rejeitada pelo
// emissor (não é um USER definido), e defineUser() não aceita as permissions do
// Closer para uma role ADMIN — as permissions efetivas são as da role.
test('[ATAQUE G] trocar role de COMMERCIAL_CLOSER para ADMIN é REJEITADO: cópia adulterada não origina contexto e defineUser não aceita permissions de outra role', () => {
  const closerReal = buildCloser();

  // 1) Cópia do USER com o role trocado: não é um USER definido.
  const comRoleTrocado = { ...closerReal, role: ROLE.ADMIN };
  assert.throws(() => createAuthorizationContext(comRoleTrocado), /USER definido por defineUser/);

  // 2) Declarar ADMIN mantendo as permissions do Closer: defineUser rejeita (permissions ≠ conjunto da role).
  assert.throws(() => buildAdmin({ permissions: [...closerReal.permissions] }), /não podem diferir das permissions da role/);

  // 3) Um ADMIN autêntico tem as permissions do ADMIN; o CLOSER autêntico continua sem MANAGE:USERS.
  assert.equal(hasPermission(createAuthorizationContext(buildAdmin()), PERMISSION.MANAGE_USERS), true);
  assert.equal(hasPermission(createAuthorizationContext(closerReal), PERMISSION.MANAGE_USERS), false);
});

// ===========================================================================
// ATAQUE H — Status injection (INACTIVE -> ACTIVE)
// ===========================================================================
// ATUALIZADO NA FASE C: uma cópia do USER com status=ACTIVE não é um USER
// definido (o emissor a rejeita), e o contexto emitido é imutável — não dá para
// "reativar" um contexto INACTIVE depois de emitido. Continua valendo a nota do
// resolver: com um store persistente real, o status atual deve vir do store a
// cada resolução, nunca de um objeto vindo de fora.
test('[ATAQUE H] declarar status=ACTIVE num USER originalmente INACTIVE é REJEITADO, e o contexto emitido não pode ser reativado', () => {
  const inactiveAdmin = buildAdmin({
    userId: 'user-admin-was-inactive',
    authUserId: 'auth-admin-was-inactive',
    status: USER_STATUS.INACTIVE,
  });

  // 1) Cópia adulterada do USER: não é um USER definido.
  const adulterado = { ...inactiveAdmin, status: USER_STATUS.ACTIVE };
  assert.throws(() => createAuthorizationContext(adulterado), /USER definido por defineUser/);

  // 2) O contexto legítimo do USER INACTIVE fica INACTIVE, e não dá para alterá-lo depois de emitido.
  const context = createAuthorizationContext(inactiveAdmin);
  assert.equal(Reflect.set(context, 'status', USER_STATUS.ACTIVE), false, 'contexto congelado: a alteração é recusada');
  assert.equal(context.status, USER_STATUS.INACTIVE);
  assert.throws(() => requireActiveUser(context), /inativo/);
  assert.throws(() => requirePermission(context, PERMISSION.MANAGE_USERS), /inativo/);

  // 3) Nem o USER definido (congelado) aceita ser "reativado".
  assert.equal(Reflect.set(inactiveAdmin, 'status', USER_STATUS.ACTIVE), false);
});

// ===========================================================================
// ATAQUE I — permissão coringa
// ===========================================================================
test('[ATAQUE I] nenhuma forma de coringa é aceita como permissão válida', () => {
  const coringas = ['*', '*:*', 'ADMIN', 'ALL', 'ADMIN:*', '*:CRM'];
  for (const coringa of coringas) {
    assert.equal(isValidPermissionString(coringa), false, `"${coringa}" não deveria ser um formato válido`);
  }

  const context = createAuthorizationContext(buildAdmin());
  for (const coringa of coringas) {
    assert.throws(() => requirePermission(context, coringa), /permissão inválida/, `"${coringa}" deveria lançar como permissão inválida, nunca autorizar`);
  }

  // Um coringa também não pode entrar disfarçado dentro do array de
  // permissions de um USER — a lista inteira é rejeitada se qualquer
  // entrada for inválida.
  for (const coringa of coringas) {
    assert.throws(
      () =>
        defineUser({
          userId: 'x',
          name: 'X',
          email: 'x@example.test',
          role: ROLE.ADMIN,
          permissions: [PERMISSION.READ_CRM, coringa],
          status: USER_STATUS.ACTIVE,
        }),
      /permissions/,
      `array contendo "${coringa}" deveria ser rejeitado por inteiro`
    );
  }
});

// ===========================================================================
// ATAQUE J — ADMIN
// ===========================================================================
test('[ATAQUE J-1] template de ADMIN não contém nenhum coringa e é uma lista explícita e finita', () => {
  const template = ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN];
  assert.equal(Array.isArray(template), true);
  assert.ok(template.length > 0);
  for (const permission of template) {
    assert.equal(isValidPermissionString(permission), true);
    assert.notEqual(permission, '*:*');
    assert.notEqual(permission, '*');
  }
});

// ATUALIZADO NA FASE C: as permissões efetivas de um USER vêm da role, então um
// "ADMIN sem permissions" deixou de ser construível. A garantia ROLE !=
// PERMISSION continua provada assim: com a fonte canônica role -> permissions
// trocada (só neste teste) por uma lista que NÃO dá MANAGE:USERS a ninguém, o
// contexto de um ADMIN autêntico não autoriza MANAGE:USERS — as decisões usam só
// `permissions`, nunca o nome da role.
test('[ATAQUE J-2] o nome da role sozinho não autoriza NADA — ROLE != PERMISSION estrutural (as decisões leem só permissions)', (t) => {
  const admin = buildAdmin();
  const closer = buildCloser();

  // Fonte canônica trocada só neste teste: as DUAS roles passam a ter a MESMA lista, sem MANAGE:USERS.
  const constants = require('../../src/auth/constants');
  t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.READ_CRM]));

  const adminContext = createAuthorizationContext(admin);
  const closerContext = createAuthorizationContext(closer);
  assert.equal(adminContext.role, ROLE.ADMIN);
  assert.equal(closerContext.role, ROLE.COMMERCIAL_CLOSER);

  for (const context of [adminContext, closerContext]) {
    for (const permission of Object.values(PERMISSION)) {
      const esperado = permission === PERMISSION.READ_CRM;
      assert.equal(hasPermission(context, permission), esperado, `${context.role} + ${permission}`);
      if (!esperado) {
        assert.throws(() => requirePermission(context, permission), /acesso negado/, `${context.role} + ${permission}`);
      }
    }
  }
});

// ===========================================================================
// ATAQUE K — CLOSER exato
// ===========================================================================
test('[ATAQUE K] CLOSER possui exatamente o conjunto aprovado, nem mais, nem menos', () => {
  const context = createAuthorizationContext(buildCloser());
  assert.deepEqual(
    [...context.permissions].sort(),
    ['ANALYZE:CRM', 'APPROVE:LEAD_APPROVAL', 'APPROVE:OUTBOUND_APPROVAL', 'PROPOSE:CRM', 'READ:CRM'].sort()
  );
  assert.equal(context.permissions.includes(PERMISSION.MANAGE_USERS), false);
});

// ===========================================================================
// ATAQUE L — USER inválido
// ===========================================================================
test('[ATAQUE L] USER inválido é rejeitado em cada campo, e comportamento real (não inventado) é documentado', () => {
  const base = {
    userId: 'x',
    name: 'X',
    email: 'x@example.test',
    role: ROLE.ADMIN,
    // Fase A: as permissões efetivas vêm da role — aqui, o conjunto exato do ADMIN.
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN],
    status: USER_STATUS.ACTIVE,
  };

  assert.throws(() => defineUser({ ...base, userId: '' }), /userId/);
  assert.throws(() => defineUser({ ...base, userId: undefined }), /userId/);
  assert.throws(() => defineUser({ ...base, authUserId: '' }), /authUserId/);
  assert.throws(() => defineUser({ ...base, authUserId: 123 }), /authUserId/);
  assert.throws(() => defineUser({ ...base, name: '' }), /name/);
  assert.throws(() => defineUser({ ...base, email: '' }), /email/);
  assert.throws(() => defineUser({ ...base, email: 'sem-arroba.example.test' }), /email/);
  assert.throws(() => defineUser({ ...base, role: 'SUPER_ADMIN' }), /role desconhecida/);
  assert.throws(() => defineUser({ ...base, status: 'PAUSED' }), /status desconhecido/);
  assert.throws(() => defineUser({ ...base, permissions: 'READ:CRM' }), /permissions/);
  assert.throws(() => defineUser({ ...base, permissions: [123] }), /permissions/);
  assert.throws(() => defineUser({ ...base, permissions: ['not-valid'] }), /permissions/);

  // Comportamento documentado (ATUALIZADO na Fase A): até o Passo 0009.7 o
  // defineUser() aceitava permissões duplicadas no array. Agora as permissões
  // efetivas são determinadas pela role, e um `permissions` que difira do
  // conjunto exato da role — inclusive por duplicata — é rejeitado, então
  // duplicatas deixam de existir.
  assert.throws(
    () => defineUser({ ...base, permissions: [PERMISSION.READ_CRM, PERMISSION.READ_CRM] }),
    /não podem diferir das permissions da role/
  );
  assert.throws(
    () => defineUser({ ...base, permissions: [...ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN], PERMISSION.READ_CRM] }),
    /não podem diferir das permissions da role/
  );

  // Comportamento REAL documentado: campos inesperados/estranhos no objeto
  // de entrada (ex.: password, token, actorType) NUNCA aparecem no USER
  // retornado — defineUser() só copia os campos que conhece. Isso é uma
  // proteção real contra vazamento acidental de dado sensível, mesmo que
  // não seja uma proteção contra forjar identidade (Ataque D/F/G/H).
  const comCamposInesperados = defineUser({
    ...base,
    password: 'nunca-deveria-aparecer',
    token: 'nunca-deveria-aparecer',
    actorType: 'AI',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(comCamposInesperados, 'password'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(comCamposInesperados, 'token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(comCamposInesperados, 'actorType'), false);
});

// ===========================================================================
// ATAQUE M — contexto incompleto
// ===========================================================================
test('[ATAQUE M] nenhum contexto incompleto passa por requireActiveUser/requirePermission sem erro explícito', () => {
  const combinacoesIncompletas = [
    {},
    { userId: 'x' },
    { userId: 'x', name: 'X' },
    { userId: 'x', name: 'X', role: ROLE.ADMIN },
    { userId: 'x', name: 'X', role: ROLE.ADMIN, permissions: [] }, // falta status
    { name: 'X', role: ROLE.ADMIN, permissions: [], status: USER_STATUS.ACTIVE }, // falta userId
  ];

  for (const incompleto of combinacoesIncompletas) {
    assert.throws(() => requireActiveUser(incompleto), /AuthorizationContext inválido/);
    assert.throws(() => requirePermission(incompleto, PERMISSION.READ_CRM), /AuthorizationContext inválido/);
  }

  // Fase C: a marca de emissão é checada ANTES da forma. Um objeto congelado à
  // mão — incompleto ou até com a forma perfeita — não foi emitido pelo emissor
  // interno e é rejeitado por esse motivo (congelar não basta).
  const congeladoIncompleto = Object.freeze({ userId: 'x' });
  assert.throws(() => requireActiveUser(congeladoIncompleto), /emitido pelo emissor interno confiável/);
});

// ===========================================================================
// ATAQUE N — Permission format
// ===========================================================================
test('[ATAQUE N] apenas o formato ACTION:DOMAIN em maiúsculas é aceito', () => {
  const validas = ['READ:CRM', 'ANALYZE:CRM', 'PROPOSE:CRM', 'APPROVE:LEAD_APPROVAL'];
  for (const permissao of validas) {
    assert.equal(isValidPermissionString(permissao), true, `${permissao} deveria ser válida`);
  }

  const invalidas = ['READ', 'CRM', 'read:crm', 'READ_CRM', 'APPROVE', 'APPROVE:', ':CRM'];
  for (const permissao of invalidas) {
    assert.equal(isValidPermissionString(permissao), false, `${permissao} deveria ser inválida`);
  }
});

// ===========================================================================
// ATAQUE O — Resolver
// ===========================================================================
// Fase D: o resolver só aceita uma VerifiedIdentity — nestes testes, REAIS
// (verifyAccessToken contra um Supabase falso, sem rede).
test('[ATAQUE O-1] authUserId válido (de uma VerifiedIdentity) resolve para o USER correto', async (t) => {
  const store = createUserStore([buildAdmin(), buildCloser()]);
  const identidade = await verifiedIdentityFor(t, { authUserId: 'auth-closer-1', email: 'closer@example.test' });
  const context = resolveAuthorizationContext(store, identidade);
  assert.equal(context.userId, 'user-closer-1');
  assert.equal(context.role, ROLE.COMMERCIAL_CLOSER);
});

// ATUALIZADO NA FASE D: o e-mail NUNCA é identidade de runtime. Um e-mail que
// pertence a um USER real, mas com authUserId desconhecido, não resolve nada —
// não há fallback, nem vínculo, nem criação de USER. Resultado: USER_NOT_FOUND.
test('[ATAQUE O-2] e-mail correto de um USER, mas authUserId desconhecido, NÃO resolve (USER_NOT_FOUND): o e-mail nunca é identidade', async (t) => {
  const store = createUserStore([buildAdmin(), buildCloser()]);
  // Identidade VERIFICADA, com o e-mail CONFIRMADO de um USER real — porém com authUserId desconhecido.
  const identidade = await verifiedIdentityFor(t, {
    authUserId: 'auth-desconhecido',
    email: 'closer@example.test',
    emailConfirmed: true,
  });
  assert.throws(
    () => resolveAuthorizationContext(store, identidade),
    (erro) => {
      assert.equal(erro.code, USER_NOT_FOUND);
      return true;
    }
  );
  assert.equal(store.all().length, 2, 'nenhum USER foi criado nem vinculado');
});

test('[ATAQUE O-3] usuário inexistente (authUserId e email desconhecidos) falha com USER_NOT_FOUND', async (t) => {
  const store = createUserStore([buildCloser()]);
  const identidade = await verifiedIdentityFor(t, { authUserId: 'nao-existe', email: 'nao-existe@example.test' });
  assert.throws(() => resolveAuthorizationContext(store, identidade), /não encontrado/);
  assert.throws(
    () => resolveAuthorizationContext(store, identidade),
    (erro) => erro.code === USER_NOT_FOUND
  );
});

test('[ATAQUE O-4] resolver um usuário INACTIVE produz um contexto que nenhuma ação sensível aceita', async (t) => {
  const store = createUserStore([buildCloser({ userId: 'user-closer-inactive', authUserId: 'auth-closer-inactive', status: USER_STATUS.INACTIVE })]);
  const identidade = await verifiedIdentityFor(t, { authUserId: 'auth-closer-inactive', email: 'closer@example.test' });
  const context = resolveAuthorizationContext(store, identidade);
  assert.throws(() => requirePermission(context, PERMISSION.APPROVE_LEAD_APPROVAL), /inativo/);
});

test('[ATAQUE O-5] o resolver não aceita nenhum parâmetro de role — não há como "pedir" ADMIN pela API do resolver', async (t) => {
  const store = createUserStore([buildCloser()]);
  // Nem do lado do Supabase: um "role" ADMIN no corpo do usuário (ruído/metadata) nunca vira parte da identidade.
  const identidade = await verifiedIdentityFor(t, {
    authUserId: 'auth-closer-1',
    email: 'closer@example.test',
    extras: { role: ROLE.ADMIN, app_metadata: { role: ROLE.ADMIN } },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(identidade, 'role'), false);

  // resolveAuthorizationContext só tem 2 parâmetros — um "role" extra do chamador é ignorado.
  assert.equal(resolveAuthorizationContext.length, 2);
  const context = resolveAuthorizationContext(store, identidade, { role: ROLE.ADMIN });
  assert.equal(context.role, ROLE.COMMERCIAL_CLOSER, 'o role retornado é sempre o do registro armazenado, nunca o solicitado pelo chamador');
});

test('[ATAQUE O-6] authUserId de um usuário nunca resolve para o registro de outro usuário', async (t) => {
  const store = createUserStore([buildAdmin(), buildCloser()]);
  const [identidadeAdmin, identidadeCloser] = await verifiedIdentitiesFor(t, [
    { authUserId: 'auth-admin-1', email: 'admin@example.test' },
    { authUserId: 'auth-closer-1', email: 'closer@example.test' },
  ]);
  const adminContext = resolveAuthorizationContext(store, identidadeAdmin);
  const closerContext = resolveAuthorizationContext(store, identidadeCloser);

  assert.notEqual(adminContext.userId, closerContext.userId);
  assert.equal(adminContext.role, ROLE.ADMIN);
  assert.equal(closerContext.role, ROLE.COMMERCIAL_CLOSER);
  assert.equal(closerContext.permissions.includes(PERMISSION.MANAGE_USERS), false);
});

// ===========================================================================
// Seção 16 — Supabase: adapter nunca finge uma sessão
// ===========================================================================
test('[SUPABASE-1] ausência de SUPABASE_URL sozinha já marca não configurado', async () => {
  const adapter = createSupabaseAuthAdapter({ SUPABASE_ANON_KEY: 'algum-valor' });
  assert.equal(adapter.isConfigured(), false);
  await assert.rejects(() => adapter.resolveAuthenticatedIdentity(), /não configurado/);
});

test('[SUPABASE-2] ausência de SUPABASE_ANON_KEY sozinha já marca não configurado', async () => {
  const adapter = createSupabaseAuthAdapter({ SUPABASE_URL: 'https://exemplo.supabase.co' });
  assert.equal(adapter.isConfigured(), false);
  await assert.rejects(() => adapter.resolveAuthenticatedIdentity(), /não configurado/);
});

// Atualizado no Passo 0009.8 Fase B: com as duas variáveis presentes (ainda
// que falsas/de teste), o adapter agora é REAL — ele de fato cria um
// cliente Supabase válido (a URL "https://exemplo.supabase.co" é
// sintaticamente válida) e consulta getSession(), que resolve localmente
// (persistSession desligado, verificado empiricamente durante este passo:
// nunca faz uma chamada de rede) para "sem sessão". O resultado correto,
// portanto, deixou de ser "não configurado" (isso seria enganoso — o
// adapter ESTÁ configurado o suficiente para operar) e passou a ser
// "nenhuma sessão autenticada" — uma distinção mais precisa que só existe
// porque o adapter agora é real, não mais um stub incondicional.
test('[SUPABASE-3] com as duas variáveis presentes mas falsas, o adapter nunca fabrica uma sessão — corretamente reporta ausência de sessão, não uma identidade', async () => {
  const envAparentementeConfigurado = { SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_ANON_KEY: 'chave-de-teste-nao-real' };
  const adapter = createSupabaseAuthAdapter(envAparentementeConfigurado);
  assert.equal(adapter.isConfigured(), true, 'isConfigured() só verifica presença das variáveis, não validade real');
  await assert.rejects(
    () => adapter.resolveAuthenticatedIdentity(),
    /nenhuma sessão autenticada/,
    'configurado o suficiente para operar, mas nenhuma sessão real existe — a função nunca fabrica uma identidade'
  );
});

// ===========================================================================
// Seção 17 — Approval Queue bridge
// ===========================================================================
test('[BRIDGE-1] ADMIN válido e ativo é convertido normalmente', () => {
  const identity = toApprovalQueueIdentity(createAuthorizationContext(buildAdmin()));
  assert.equal(identity.userId, 'user-admin-1');
  assert.equal(identity.role, ROLE.ADMIN);
});

test('[BRIDGE-2] CLOSER válido e ativo é convertido normalmente', () => {
  const identity = toApprovalQueueIdentity(createAuthorizationContext(buildCloser()));
  assert.equal(identity.userId, 'user-closer-1');
});

test('[BRIDGE-3] usuário INACTIVE nunca é convertido', () => {
  const inactive = createAuthorizationContext(
    buildCloser({ userId: 'user-closer-inactive-2', authUserId: 'auth-closer-inactive-2', status: USER_STATUS.INACTIVE })
  );
  assert.throws(() => toApprovalQueueIdentity(inactive), /inativo/);
});

test('[BRIDGE-4] toApprovalQueueIdentity sozinho NÃO valida a permissão específica de negócio (isso é responsabilidade do approvalQueue.js)', () => {
  // Documentação de comportamento real: a ponte só garante ATIVO + forma.
  // Ela converte com sucesso a identidade mesmo quando as permissions que
  // carrega não incluem APPROVE:LEAD_APPROVAL — a rejeição de fato acontece
  // dentro de approveProspect(), que já checa isso desde 0009.2. Isso não é
  // uma falha da ponte: é a divisão de responsabilidades pretendida (ver
  // approvalQueueBridge.js).
  //
  // Fase A: as permissões efetivas vêm da role e nenhuma role atual carece de
  // APPROVE:LEAD_APPROVAL, então um "Closer sem aprovação" deixou de ser
  // construível via defineUser(). O mesmo cenário é reproduzido aqui editando
  // a saída já convertida pela ponte (uma identidade simples).
  const closerContext = createAuthorizationContext(
    buildCloser({
      userId: 'user-closer-sem-aprovacao',
      authUserId: 'auth-closer-sem-aprovacao',
      email: 'closer-sem-aprovacao@example.test',
    })
  );

  const convertida = toApprovalQueueIdentity(closerContext); // a ponte não lança nem olha a permissão de negócio
  const identity = { ...convertida, permissions: [PERMISSION.READ_CRM] };
  assert.equal(convertida.permissions.includes(PERMISSION.APPROVE_LEAD_APPROVAL), true);
  assert.equal(identity.permissions.includes(PERMISSION.APPROVE_LEAD_APPROVAL), false);

  const { createEmptyQueue, addProspect, approveProspect } = require('../../src/research-prospector/approvalQueue');
  const { runDiscoveryPipeline, SOURCE_TYPE } = require('../../src/research-prospector/discovery');
  const briefing = { nicho: 'Psicologia', regiao: 'Petrópolis/RJ', exclusoes: [] };
  const achado = {
    empresa: 'Consultório Ataque Bridge',
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Psicologia',
    campos: { site: [{ valor: 'consultorioataquebridge.com.br', fonte: 'Site', tipoFonte: SOURCE_TYPE.OFICIAL }] },
    fontes: [],
  };
  const resultado = runDiscoveryPipeline({ briefing, rawFindings: [achado], crmRecords: [] }).resultados[0];
  const queue = createEmptyQueue();
  const item = addProspect(queue, resultado);

  // A rejeição de fato acontece aqui — dentro do Approval Queue já existente.
  assert.throws(() => approveProspect(queue, item.prospectId, identity, 'tentativa sem permissão'), /sem permissão necessária/);
});

test('[BRIDGE-5] contexto inválido nunca é convertido', () => {
  assert.throws(() => toApprovalQueueIdentity({}), /AuthorizationContext inválido/);
  assert.throws(() => toApprovalQueueIdentity(null), /AuthorizationContext inválido/);
});

// ATUALIZADO NA FASE C: um AuthorizationContext forjado não chega mais à ponte —
// o emissor não o cria e a ponte (que reutiliza requireActiveUser) rejeita
// qualquer objeto que o emissor não tenha emitido, mesmo congelado e com a
// forma perfeita. Continua valendo o limite da fronteira: é arquitetural
// interna, não protege contra código que controle o processo.
test('[BRIDGE-6] um AuthorizationContext forjado (Ataque D) nunca é criado e nunca é convertido pela ponte', () => {
  const dadosForjados = {
    userId: 'ai-actor-fabricando-admin',
    name: 'IA fabricando ADMIN',
    role: ROLE.ADMIN,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN],
    status: USER_STATUS.ACTIVE,
  };

  // 1) O emissor não cria contexto a partir de um literal.
  assert.throws(() => createAuthorizationContext(dadosForjados), /USER definido por defineUser/);

  // 2) A ponte rejeita um objeto que imita o contexto (congelado, com authUserId), pois não foi emitido.
  const imitacao = Object.freeze({
    ...dadosForjados,
    authUserId: 'auth-forjado',
    permissions: Object.freeze([...dadosForjados.permissions]),
  });
  assert.throws(() => toApprovalQueueIdentity(imitacao), /emitido pelo emissor interno confiável/);
});
