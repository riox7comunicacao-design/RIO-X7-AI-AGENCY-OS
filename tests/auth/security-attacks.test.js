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
  createAuthorizationContext,
  requireActiveUser,
  hasPermission,
  requirePermission,
  createUserStore,
  resolveAuthorizationContext,
  isSupabaseConfigured,
  createSupabaseAuthAdapter,
  toApprovalQueueIdentity,
} = require('../../src/auth');

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
// LIMITAÇÃO REAL, NÃO CORRIGIDA NESTE PASSO: createAuthorizationContext()
// valida só a FORMA do objeto recebido — não confirma que os dados vieram de
// fato de um USER armazenado em algum lugar confiável. Qualquer código no
// mesmo processo (não só um especialista de IA — qualquer módulo que
// consiga chamar require('../../src/auth')) pode montar um objeto com a
// forma certa e "virar" ADMIN. Isso é possível hoje porque não existe
// nenhuma autenticação real conectada (Supabase não está configurado) nem
// nenhuma restrição de que só o userResolver pode chamar esta função.
// PENDENTE — DEPENDE DE AUTENTICAÇÃO REAL (ver threat model, item 4).
test('[ATAQUE D] contexto forjado com role=ADMIN, sem corresponder a nenhum USER real, é aceito hoje (risco documentado, não corrigido)', () => {
  const closerReal = buildCloser();

  const forjado = {
    userId: closerReal.userId, // mesmo userId de um Closer real...
    name: closerReal.name,
    role: ROLE.ADMIN, // ...mas role trocado para ADMIN
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN], // ...com todas as permissões de ADMIN
    status: USER_STATUS.ACTIVE,
  };

  // createAuthorizationContext() não rejeita isso — não há verificação
  // cruzada contra um USER store real dentro desta função.
  const context = createAuthorizationContext(forjado);
  assert.equal(context.role, ROLE.ADMIN);
  assert.doesNotThrow(() => requirePermission(context, PERMISSION.MANAGE_USERS));

  // Isso é o ataque funcionando, não uma proteção. Documentado como
  // PENDENTE — DEPENDE DE AUTENTICAÇÃO REAL.
});

// ===========================================================================
// ATAQUE E — IA fingindo ser ADMIN
// ===========================================================================
test('[ATAQUE E-1] um objeto {actorType:"AI", role:"ADMIN", ...} SEM passar por createAuthorizationContext é REJEITADO', () => {
  const fingindoSerAdmin = {
    actorType: 'AI',
    userId: 'ai-actor-coo',
    name: 'COO Orchestrator',
    role: ROLE.ADMIN,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN],
    status: USER_STATUS.ACTIVE,
  };

  // Este objeto nunca foi produzido por createAuthorizationContext() — não
  // é frozen. Esta é a proteção estrutural que de fato existe hoje.
  assert.equal(Object.isFrozen(fingindoSerAdmin), false);
  assert.throws(() => requirePermission(fingindoSerAdmin, PERMISSION.MANAGE_USERS), /criado por createAuthorizationContext/);
  assert.throws(() => hasPermission(fingindoSerAdmin, PERMISSION.MANAGE_USERS), /criado por createAuthorizationContext/);
});

// LIMITAÇÃO REAL, NÃO CORRIGIDA: se o mesmo objeto passar primeiro por
// createAuthorizationContext() (que não sabe nada sobre "actorType" — o
// campo é simplesmente ignorado/descartado, nem aceito nem usado para
// rejeitar), o resultado fica indistinguível de um contexto humano legítimo.
// Não existe, hoje, nenhum "actor model" que marque a origem (IA vs. humano
// autenticado) de um AuthorizationContext. PENDENTE — DEPENDE DE
// AUTENTICAÇÃO REAL (ver threat model, item 4). Nenhuma validação de
// "actorType" foi adicionada para simular proteção: seria trivialmente
// contornável por quem simplesmente omitisse o campo, dando falsa confiança.
test('[ATAQUE E-2] o mesmo objeto, PASSANDO por createAuthorizationContext, produz um contexto indistinguível de um ADMIN humano legítimo', () => {
  const fingindoSerAdmin = {
    actorType: 'AI',
    userId: 'ai-actor-coo',
    name: 'COO Orchestrator',
    role: ROLE.ADMIN,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN],
    status: USER_STATUS.ACTIVE,
  };

  const context = createAuthorizationContext(fingindoSerAdmin);
  assert.equal(Object.prototype.hasOwnProperty.call(context, 'actorType'), false, 'actorType é descartado, não usado para bloquear nem preservado');
  assert.doesNotThrow(() => requirePermission(context, PERMISSION.MANAGE_USERS));

  // AI != HUMAN continua sendo verdade só como REGRA DE ARQUITETURA/PROCESSO
  // (nenhum código de orquestração deveria chamar createAuthorizationContext
  // diretamente) — não como uma garantia que o runtime hoje impõe sozinho.
});

// ===========================================================================
// ATAQUE F — Permission injection
// ===========================================================================
// Mesma fronteira de confiança do Ataque D: createAuthorizationContext()
// aceita qualquer array de permissions bem formatado, sem confirmar que
// aquele CLOSER realmente tem essas permissões em algum registro confiável.
// PENDENTE — DEPENDE DE AUTENTICAÇÃO REAL.
test('[ATAQUE F] injetar MANAGE:USERS no array de permissions de um CLOSER é aceito hoje (risco documentado, não corrigido)', () => {
  const closerReal = buildCloser();
  const comPermissaoInjetada = {
    ...closerReal,
    permissions: [...closerReal.permissions, PERMISSION.MANAGE_USERS],
  };

  const context = createAuthorizationContext(comPermissaoInjetada);
  assert.doesNotThrow(() => requirePermission(context, PERMISSION.MANAGE_USERS));

  // A única coisa que createAuthorizationContext() de fato valida é o
  // FORMATO de cada string de permissão — nunca a legitimidade/origem delas.
});

// ===========================================================================
// ATAQUE G — Role injection
// ===========================================================================
test('[ATAQUE G] trocar role de COMMERCIAL_CLOSER para ADMIN, mantendo as permissions do Closer, é aceito (mas concede só o que o array já permite)', () => {
  const closerReal = buildCloser();
  const comRoleTrocado = { ...closerReal, role: ROLE.ADMIN };

  const context = createAuthorizationContext(comRoleTrocado);
  assert.equal(context.role, ROLE.ADMIN);

  // Importante: trocar SÓ o role não concede NADA por si só — permissions
  // continua sendo a lista original do Closer (ROLE != PERMISSION é
  // respeitado mesmo neste ataque: MANAGE:USERS continua ausente).
  assert.equal(hasPermission(context, PERMISSION.MANAGE_USERS), false);
  assert.throws(() => requirePermission(context, PERMISSION.MANAGE_USERS), /acesso negado/);

  // O risco real de "role injection" só se materializa combinado com o
  // Ataque F (também trocar/estender permissions) — isolado, o role sozinho
  // não é lido por nenhuma checagem de autorização. Isso É uma proteção
  // real (ROLE != PERMISSION na prática), mesmo dentro da mesma limitação
  // de confiança de origem dos dados (Ataque D/F).
});

// ===========================================================================
// ATAQUE H — Status injection (INACTIVE -> ACTIVE)
// ===========================================================================
// Mesma fronteira de confiança dos ataques D/F: createAuthorizationContext()
// não consulta nenhum store para confirmar o status real do usuário — aceita
// o status que o objeto de entrada declarar. PENDENTE — DEPENDE DE
// AUTENTICAÇÃO REAL (a implementação real do userResolver, quando conectada
// a um store persistente de verdade, deve buscar o status atual no store,
// nunca aceitar um status embutido no objeto vindo de fora).
test('[ATAQUE H] declarar status=ACTIVE num USER originalmente INACTIVE é aceito hoje (risco documentado, não corrigido)', () => {
  const inactiveAdmin = buildAdmin({
    userId: 'user-admin-was-inactive',
    authUserId: 'auth-admin-was-inactive',
    status: USER_STATUS.INACTIVE,
  });
  const adulterado = { ...inactiveAdmin, status: USER_STATUS.ACTIVE };

  const context = createAuthorizationContext(adulterado);
  assert.doesNotThrow(() => requireActiveUser(context));
  assert.doesNotThrow(() => requirePermission(context, PERMISSION.MANAGE_USERS));
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

test('[ATAQUE J-2] role=ADMIN sozinho, sem permissions concedidas, não autoriza NADA — ROLE != PERMISSION estrutural', () => {
  const adminSemPermissoes = {
    userId: 'user-admin-sem-permissoes',
    name: 'Admin Sem Permissões',
    role: ROLE.ADMIN,
    permissions: [], // nenhuma permissão concedida, apesar do role
    status: USER_STATUS.ACTIVE,
  };
  const context = createAuthorizationContext(adminSemPermissoes);

  for (const permission of Object.values(PERMISSION)) {
    assert.equal(hasPermission(context, permission), false, `role ADMIN sozinho não deveria conceder ${permission}`);
    assert.throws(() => requirePermission(context, permission), /acesso negado/);
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
    permissions: [PERMISSION.READ_CRM],
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

  // Comportamento REAL documentado (não inventado): a implementação atual
  // NÃO rejeita permissões duplicadas no array — duplicatas são aceitas
  // silenciosamente. Isso não concede mais acesso (o array é consultado só
  // com .includes()), mas é registrado aqui como comportamento real, não
  // como algo a "corrigir" sem autorização.
  const comDuplicata = defineUser({ ...base, permissions: [PERMISSION.READ_CRM, PERMISSION.READ_CRM] });
  assert.deepEqual(comDuplicata.permissions, [PERMISSION.READ_CRM, PERMISSION.READ_CRM]);

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

  // Mesmo um objeto completo, se for manualmente Object.freeze()d por fora
  // de createAuthorizationContext(), ainda precisa ter a forma certa —
  // congelar não basta se os campos estiverem incompletos.
  const congeladoIncompleto = Object.freeze({ userId: 'x' });
  assert.throws(() => requireActiveUser(congeladoIncompleto), /forma inesperada/);
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
test('[ATAQUE O-1] authUserId válido resolve para o USER correto', () => {
  const store = createUserStore([buildAdmin(), buildCloser()]);
  const context = resolveAuthorizationContext(store, { authUserId: 'auth-closer-1' });
  assert.equal(context.userId, 'user-closer-1');
  assert.equal(context.role, ROLE.COMMERCIAL_CLOSER);
});

test('[ATAQUE O-2] email válido resolve para o USER correto (operação suportada, primeiro login)', () => {
  const store = createUserStore([buildAdmin(), buildCloser()]);
  const context = resolveAuthorizationContext(store, { email: 'closer@example.test' });
  assert.equal(context.userId, 'user-closer-1');
});

test('[ATAQUE O-3] usuário inexistente (authUserId e email desconhecidos) falha', () => {
  const store = createUserStore([buildCloser()]);
  assert.throws(
    () => resolveAuthorizationContext(store, { authUserId: 'nao-existe', email: 'nao-existe@example.test' }),
    /não encontrado/
  );
});

test('[ATAQUE O-4] resolver um usuário INACTIVE produz um contexto que nenhuma ação sensível aceita', () => {
  const store = createUserStore([buildCloser({ userId: 'user-closer-inactive', authUserId: 'auth-closer-inactive', status: USER_STATUS.INACTIVE })]);
  const context = resolveAuthorizationContext(store, { authUserId: 'auth-closer-inactive' });
  assert.throws(() => requirePermission(context, PERMISSION.APPROVE_LEAD_APPROVAL), /inativo/);
});

test('[ATAQUE O-5] o resolver não aceita nenhum parâmetro de role — não há como "pedir" ADMIN pela API do resolver', () => {
  const store = createUserStore([buildCloser()]);
  // resolveAuthorizationContext só aceita { authUserId, email } — mesmo
  // passando um campo "role" extra, ele é ignorado pela desestruturação.
  const context = resolveAuthorizationContext(store, { authUserId: 'auth-closer-1', role: ROLE.ADMIN });
  assert.equal(context.role, ROLE.COMMERCIAL_CLOSER, 'o role retornado é sempre o do registro armazenado, nunca o solicitado pelo chamador');
});

test('[ATAQUE O-6] authUserId de um usuário nunca resolve para o registro de outro usuário', () => {
  const store = createUserStore([buildAdmin(), buildCloser()]);
  const adminContext = resolveAuthorizationContext(store, { authUserId: 'auth-admin-1' });
  const closerContext = resolveAuthorizationContext(store, { authUserId: 'auth-closer-1' });

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
  // Ela converte com sucesso mesmo um Closer sem APPROVE:LEAD_APPROVAL —
  // a rejeição de fato acontece dentro de approveProspect(), que já checa
  // isso desde 0009.2. Isso não é uma falha da ponte: é a divisão de
  // responsabilidades pretendida (ver approvalQueueBridge.js).
  const closerSemAprovacao = createAuthorizationContext(
    defineUser({
      userId: 'user-closer-sem-aprovacao',
      authUserId: 'auth-closer-sem-aprovacao',
      name: 'Closer Sem Aprovação',
      email: 'closer-sem-aprovacao@example.test',
      role: ROLE.COMMERCIAL_CLOSER,
      permissions: [PERMISSION.READ_CRM],
      status: USER_STATUS.ACTIVE,
    })
  );

  const identity = toApprovalQueueIdentity(closerSemAprovacao); // não lança aqui
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

// LIMITAÇÃO REAL, HERDADA DO ATAQUE D/E — a ponte não adiciona nenhuma
// proteção além da que authorizationContext.js já oferece: se um ator
// (IA ou não) já conseguiu produzir um AuthorizationContext forjado através
// de createAuthorizationContext(), a ponte o converte normalmente, porque
// nada a esta altura ainda sabe que a identidade é forjada. PENDENTE —
// DEPENDE DE AUTENTICAÇÃO REAL.
test('[BRIDGE-6] um AuthorizationContext forjado (Ataque D), uma vez criado, é convertido pela ponte como se fosse legítimo', () => {
  const forjado = createAuthorizationContext({
    userId: 'ai-actor-fabricando-admin',
    name: 'IA fabricando ADMIN',
    role: ROLE.ADMIN,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN],
    status: USER_STATUS.ACTIVE,
  });

  const identity = toApprovalQueueIdentity(forjado);
  assert.equal(identity.role, ROLE.ADMIN);
  // A ponte não é o lugar certo para resolver isso — a correção real
  // pertence à camada de autenticação (userResolver conectado a um store
  // real + Supabase Auth), não a este módulo.
});
