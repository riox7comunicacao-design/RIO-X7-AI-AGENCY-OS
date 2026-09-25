// Correção D1 — o resolver confere o vínculo USER <-> identidade verificada.
//
// O problema: resolveAuthorizationContext(userStore, identidade) aceitava qualquer objeto
// com findByAuthUserId e emitia o contexto do USER que ele devolvesse. Com o store real isso é
// seguro por construção (ele só devolve o USER do authUserId pedido), mas um store falso ou
// defeituoso — um stub, ou um futuro store apoiado em banco com uma consulta errada — podia
// devolver o USER de OUTRA pessoa, inclusive um ADMIN, e a identidade verificada de A virava o
// AuthorizationContext de B.
//
// A regra agora: depois da busca, user.authUserId precisa ser IGUAL (===) ao authUserId da
// identidade verificada; senão, USER_NOT_FOUND — o mesmo erro público de sempre (nenhum erro
// novo), sem fallback, sem e-mail, sem "marcar" o store como confiável e sem alterar
// createUserStore.
//
// Cada teste abaixo é um item da especificação da correção (D1-1 a D1-8), mais dois de contrato
// (D1-9: o e-mail não participa; D1-10: nenhum erro ou API pública nova).
//
// Determinístico e sem rede: as identidades são REAIS (verifyAccessToken contra um Supabase falso —
// tests/helpers/authFixtures.js) e os USERs são definidos em memória, todos fictícios (example.test).
// A marca de VerifiedIdentity e a de USER definido são uma fronteira arquitetural interna
// confiável, NÃO criptografia.

const test = require('node:test');
const assert = require('node:assert/strict');

const userResolverModule = require('../../src/auth/userResolver');
const {
  ROLE,
  USER_STATUS,
  PERMISSION,
  USER_NOT_FOUND,
  USER_RESOLUTION_ERROR,
  UserResolutionError,
  defineUser,
  createUserStore,
  resolveAuthorizationContext,
  requirePermission,
} = require('../../src/auth');
const { createAuthorizationContext, isIssuedAuthorizationContext, verifiedIdentitiesFor } = require('../helpers/authFixtures');

const A_AUTH_ID = 'auth-d1-a';
const B_AUTH_ID = 'auth-d1-b';

// Listas LITERAIS, independentes de src/ (as mesmas de role-permissions.test.js).
const ADMIN_LITERAL = ['READ:CRM', 'ANALYZE:CRM', 'PROPOSE:CRM', 'WRITE:CRM', 'PROPOSE:LEAD_APPROVAL', 'APPROVE:LEAD_APPROVAL', 'APPROVE:OUTBOUND_APPROVAL', 'MANAGE:USERS'];
const CLOSER_LITERAL = ['READ:CRM', 'ANALYZE:CRM', 'PROPOSE:CRM', 'APPROVE:LEAD_APPROVAL', 'APPROVE:OUTBOUND_APPROVAL'];

// USER A: um COMMERCIAL_CLOSER. USER B: um ADMIN. Fictícios.
const usuarioA = (overrides = {}) =>
  defineUser({
    userId: 'user-d1-a',
    authUserId: A_AUTH_ID,
    name: 'Closer D1',
    email: 'a-d1@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    status: USER_STATUS.ACTIVE,
    ...overrides,
  });

const usuarioB = (overrides = {}) =>
  defineUser({
    userId: 'user-d1-b',
    authUserId: B_AUTH_ID,
    name: 'Admin D1',
    email: 'b-d1@example.test',
    role: ROLE.ADMIN,
    status: USER_STATUS.ACTIVE,
    ...overrides,
  });

// Validador para assert.throws: erro de resolução com o código esperado.
const falhaCom = (codigo) => (erro) => {
  assert.ok(erro instanceof UserResolutionError, `esperava UserResolutionError, veio ${erro && erro.name}`);
  assert.equal(erro.code, codigo);
  return true;
};

function capturar(funcao) {
  try {
    return { resultado: funcao(), erro: null };
  } catch (erro) {
    return { resultado: null, erro };
  }
}

// Um store "duck-typed": qualquer objeto com findByAuthUserId, que devolve o que o teste mandar.
function lojaFalsa(devolver, consultas = [], extras = {}) {
  return {
    ...extras,
    findByAuthUserId(authUserId) {
      consultas.push(authUserId);
      return devolver(authUserId);
    },
  };
}

// Identidades REAIS (VerifiedIdentity): A, B e A de novo num token sem e-mail.
async function identidades(t) {
  const [idA, idB, idASemEmail] = await verifiedIdentitiesFor(t, [
    { authUserId: A_AUTH_ID, email: 'a-d1@example.test' },
    { authUserId: B_AUTH_ID, email: 'b-d1@example.test' },
    { authUserId: A_AUTH_ID },
  ]);
  return { idA, idB, idASemEmail };
}

// ===========================================================================
// 1) identidade A + USER A -> sucesso
// ===========================================================================
test('[D1-1] identidade A + USER A -> sucesso: o contexto é o de A (store real e store falso honesto); o de B só vem com a identidade DE B', async (t) => {
  const { idA, idB } = await identidades(t);
  const real = createUserStore([usuarioA(), usuarioB()]);

  const consultas = [];
  for (const [rotulo, store] of [
    ['store real', real],
    ['store falso que devolve o USER certo', lojaFalsa((id) => (id === A_AUTH_ID ? usuarioA() : null), consultas)],
  ]) {
    const contexto = resolveAuthorizationContext(store, idA);
    assert.equal(isIssuedAuthorizationContext(contexto), true, rotulo);
    assert.equal(contexto.userId, 'user-d1-a', rotulo);
    assert.equal(contexto.authUserId, A_AUTH_ID, rotulo);
    assert.equal(contexto.role, ROLE.COMMERCIAL_CLOSER, rotulo);
    assert.deepEqual([...contexto.permissions].sort(), [...CLOSER_LITERAL].sort(), rotulo);
  }
  assert.deepEqual(consultas, [A_AUTH_ID], 'o store falso foi consultado uma vez, pelo authUserId de A');

  // Controle positivo — é isto que estaria em jogo: com a identidade DE B, o contexto é o do ADMIN, com as 8 permissões.
  const contextoB = resolveAuthorizationContext(real, idB);
  assert.equal(contextoB.userId, 'user-d1-b');
  assert.equal(contextoB.role, ROLE.ADMIN);
  assert.deepEqual([...contextoB.permissions].sort(), [...ADMIN_LITERAL].sort());
  assert.equal(requirePermission(contextoB, PERMISSION.MANAGE_USERS), contextoB);
});

// ===========================================================================
// 2) identidade A + USER B -> USER_NOT_FOUND
// ===========================================================================
test('[D1-2] identidade A + USER B -> USER_NOT_FOUND, nos dois sentidos, sem revelar o USER errado', async (t) => {
  const { idA, idB } = await identidades(t);
  const casos = [
    ['identidade do CLOSER A + USER do ADMIN B', idA, usuarioB(), /user-d1-b|b-d1@example\.test|auth-d1-b|Admin D1/],
    ['identidade do ADMIN B + USER do CLOSER A', idB, usuarioA(), /user-d1-a|a-d1@example\.test|auth-d1-a|Closer D1/],
  ];
  for (const [rotulo, identidade, devolvido, revelaria] of casos) {
    const { resultado, erro } = capturar(() => resolveAuthorizationContext(lojaFalsa(() => devolvido), identidade));
    assert.equal(resultado, null, rotulo);
    falhaCom(USER_NOT_FOUND)(erro);
    assert.match(erro.message, /não corresponde ao authUserId/, rotulo);
    assert.doesNotMatch(erro.message, revelaria, `${rotulo}: a mensagem não revela o USER que o store devolveu`);
  }
});

// ===========================================================================
// 3) identidade A + store REAL contendo somente B -> continua USER_NOT_FOUND
// ===========================================================================
test('[D1-3] identidade A + store REAL contendo somente B -> USER_NOT_FOUND: o comportamento de sempre continua, e o store não muda', async (t) => {
  const { idA } = await identidades(t);
  const usuarioC = usuarioA({ userId: 'user-d1-c', authUserId: 'auth-d1-c', email: 'c-d1@example.test' });
  const stores = [
    ['só o USER B', createUserStore([usuarioB()])],
    ['os USERs B e C', createUserStore([usuarioB(), usuarioC])],
    ['store vazio', createUserStore([])],
  ];
  for (const [rotulo, store] of stores) {
    const antes = store.all().map((usuario) => usuario.userId);
    assert.throws(() => resolveAuthorizationContext(store, idA), falhaCom(USER_NOT_FOUND), rotulo);
    // A mensagem de "não achado" de sempre (não a da conferência do vínculo): o caminho antigo não mudou.
    assert.throws(() => resolveAuthorizationContext(store, idA), /nenhum USER Rio X7 corresponde/, rotulo);
    assert.deepEqual(store.all().map((usuario) => usuario.userId), antes, `${rotulo}: o store não mudou`);
    assert.equal(store.findByAuthUserId(A_AUTH_ID), null, rotulo);
  }
});

// ===========================================================================
// 4) identidade A + store duck-typed retornando B -> agora falha
// ===========================================================================
test('[D1-4] identidade A + store duck-typed que devolve o USER B -> falha: o store é consultado só pelo authUserId de A e nenhum contexto sai — mesmo que o store se declare "confiável"', async (t) => {
  const { idA } = await identidades(t);
  const comportamentos = [
    ['devolve sempre B', () => usuarioB()],
    ['devolve B só quando pedem o authUserId de A', (id) => (id === A_AUTH_ID ? usuarioB() : null)],
    ['devolve o primeiro USER que conhece (B)', () => [usuarioB(), usuarioA()][0]],
  ];
  const declaracoes = [
    ['sem declaração', {}],
    ['declarando-se confiável', { trusted: true, isTrusted: () => true, verified: true, source: 'database' }],
  ];
  for (const [rotuloComportamento, devolver] of comportamentos) {
    for (const [rotuloDeclaracao, extras] of declaracoes) {
      const rotulo = `${rotuloComportamento} / ${rotuloDeclaracao}`;
      const consultas = [];
      const { resultado, erro } = capturar(() => resolveAuthorizationContext(lojaFalsa(devolver, consultas, extras), idA));
      assert.equal(resultado, null, rotulo);
      falhaCom(USER_NOT_FOUND)(erro);
      assert.deepEqual(consultas, [A_AUTH_ID], `${rotulo}: uma consulta, só pelo authUserId da identidade`);
    }
  }
});

// ===========================================================================
// 5) identidade A + USER B com role ADMIN -> NÃO emite contexto ADMIN
// ===========================================================================
test('[D1-5] identidade A + USER B com role ADMIN -> NÃO emite um contexto ADMIN', async (t) => {
  const { idA } = await identidades(t);
  const admin = usuarioB();
  assert.equal(admin.role, ROLE.ADMIN);

  const { resultado, erro } = capturar(() => resolveAuthorizationContext(lojaFalsa(() => admin), idA));
  assert.equal(resultado, null, 'nenhum contexto sai');
  falhaCom(USER_NOT_FOUND)(erro);

  // Contra-prova: o emissor, sozinho, aceitaria esse USER e emitiria um contexto ADMIN — quem barra é o vínculo do resolver.
  const seriaEmitido = createAuthorizationContext(admin);
  assert.equal(seriaEmitido.role, ROLE.ADMIN);
  assert.equal(seriaEmitido.permissions.length, 8);

  // O caminho honesto de A continua sendo o do CLOSER, nunca o do ADMIN.
  const honesto = resolveAuthorizationContext(createUserStore([usuarioA(), usuarioB()]), idA);
  assert.equal(honesto.role, ROLE.COMMERCIAL_CLOSER);
  assert.notEqual(honesto.role, ROLE.ADMIN);
});

// ===========================================================================
// 6) identidade A + USER B com permissões administrativas -> não atravessa a fronteira
// ===========================================================================
test('[D1-6] identidade A + USER B com permissões administrativas -> nenhuma permissão atravessa a fronteira (nem WRITE:CRM, nem MANAGE:USERS)', async (t) => {
  const { idA, idB } = await identidades(t);
  const atravessa = (store, identidade, permissao) => {
    try {
      requirePermission(resolveAuthorizationContext(store, identidade), permissao);
      return true;
    } catch {
      return false;
    }
  };
  const lojaMentirosa = lojaFalsa(() => usuarioB());

  // A + USER B (ADMIN, com as 8 permissões): nada atravessa — nem as administrativas, nem as comerciais.
  for (const permissao of ADMIN_LITERAL) {
    assert.equal(atravessa(lojaMentirosa, idA, permissao), false, `${permissao} não pode atravessar com a identidade de A + USER B`);
  }

  // Controles pelo caminho honesto: o CLOSER A só tem as 5 comerciais; o ADMIN B tem as 7.
  const real = createUserStore([usuarioA(), usuarioB()]);
  for (const permissao of ADMIN_LITERAL) {
    assert.equal(atravessa(real, idA, permissao), CLOSER_LITERAL.includes(permissao), `A, caminho honesto: ${permissao}`);
    assert.equal(atravessa(real, idB, permissao), true, `B, caminho honesto: ${permissao}`);
  }
  // As administrativas (só do ADMIN), em particular.
  for (const administrativa of [PERMISSION.WRITE_CRM, PERMISSION.MANAGE_USERS]) {
    assert.equal(atravessa(real, idA, administrativa), false, `${administrativa}: A, caminho honesto`);
    assert.equal(atravessa(lojaMentirosa, idA, administrativa), false, `${administrativa}: A + USER B`);
    assert.equal(atravessa(real, idB, administrativa), true, `${administrativa}: B, caminho honesto`);
  }
});

// ===========================================================================
// 7) authUserId ausente no USER -> falha
// ===========================================================================
test('[D1-7] authUserId ausente no USER devolvido -> falha (USER sem vínculo, literal sem a propriedade, undefined, null, vazio)', async (t) => {
  const { idA } = await identidades(t);
  const { authUserId: omitido, ...semAuthUserId } = usuarioA();
  assert.equal(omitido, A_AUTH_ID, 'sanidade: a propriedade existia e foi omitida do literal');

  const semVinculo = usuarioA({ userId: 'user-d1-sv', authUserId: null, email: 'sv-d1@example.test' });
  const ausentes = [
    ['USER definido sem vínculo (authUserId null)', semVinculo],
    ['literal sem a propriedade authUserId', semAuthUserId],
    ['literal com authUserId undefined', { ...usuarioA(), authUserId: undefined }],
    ['literal com authUserId null', { ...usuarioA(), authUserId: null }],
    ['literal com authUserId vazio', { ...usuarioA(), authUserId: '' }],
  ];
  for (const [rotulo, devolvido] of ausentes) {
    const { resultado, erro } = capturar(() => resolveAuthorizationContext(lojaFalsa(() => devolvido), idA));
    assert.equal(resultado, null, rotulo);
    falhaCom(USER_NOT_FOUND)(erro);
  }

  // O store real nem aceita guardar um USER sem vínculo (controle: já era assim).
  assert.throws(() => createUserStore([semVinculo]), falhaCom(USER_RESOLUTION_ERROR.USER_NOT_OPERATIONAL));
});

// ===========================================================================
// 8) authUserId diferente por qualquer motivo -> falha
// ===========================================================================
test('[D1-8] authUserId diferente por QUALQUER motivo -> falha: caixa, prefixo, sufixo, espaço, caractere invisível, homóglifo, um caractere, outro tipo e valores "iguais" só por coerção', async (t) => {
  const { idA } = await identidades(t);
  const original = idA.authUserId;
  assert.equal(original, A_AUTH_ID);

  const variantes = [
    ['caixa', original.toUpperCase()],
    ['sufixo a mais', `${original}-2`],
    ['prefixo a mais', `x${original}`],
    ['espaço à direita', `${original} `],
    ['espaço à esquerda', ` ${original}`],
    ['quebra de linha à direita', `${original}\n`],
    ['caractere de largura zero', `${original}​`],
    ['homóglifo (a latino trocado por a cirílico)', original.replace('a', 'а')],
    ['um caractere trocado', `${original.slice(0, -1)}c`],
    ['um caractere a menos', original.slice(0, -1)],
    ['o authUserId de B', B_AUTH_ID],
    ['texto vazio', ''],
    ['só espaços', '   '],
    ['número', 42],
    ['booleano', true],
    ['objeto String com o mesmo texto (igual só por coerção)', new String(original)],
    ['objeto cujo toString devolve o mesmo texto (igual só por coerção)', { toString: () => original }],
    ['lista com o mesmo texto (igual só por coerção)', [original]],
    ['null', null],
    ['undefined', undefined],
  ];
  for (const [rotulo, variante] of variantes) {
    assert.notStrictEqual(variante, original, `sanidade: "${rotulo}" precisa ser diferente do original`);
    const { resultado, erro } = capturar(() => resolveAuthorizationContext(lojaFalsa(() => ({ ...usuarioA(), authUserId: variante })), idA));
    assert.equal(resultado, null, rotulo);
    falhaCom(USER_NOT_FOUND)(erro);
  }

  // Controle: com o authUserId EXATO o vínculo passa — e é o emissor que recusa o literal (não é um USER definido por defineUser()).
  const { resultado: doLiteral, erro: doEmissor } = capturar(() => resolveAuthorizationContext(lojaFalsa(() => ({ ...usuarioA() })), idA));
  assert.equal(doLiteral, null);
  assert.match(doEmissor.message, /USER definido por defineUser/);
  assert.ok(!(doEmissor instanceof UserResolutionError), 'a recusa é do emissor, não da conferência do vínculo');

  // Um objeto cujo authUserId muda entre leituras (igual na 1ª, diferente depois): nenhum contexto sai,
  // porque só um USER definido (congelado) chega ao emissor.
  let leituras = 0;
  const instavel = {
    ...usuarioA(),
    get authUserId() {
      leituras += 1;
      return leituras === 1 ? A_AUTH_ID : 'auth-d1-outro';
    },
  };
  const { resultado: doInstavel, erro: erroInstavel } = capturar(() => resolveAuthorizationContext(lojaFalsa(() => instavel), idA));
  assert.equal(doInstavel, null);
  assert.match(erroInstavel.message, /USER definido por defineUser/);
});

// ===========================================================================
// O e-mail não participa (nem para resolver, nem para validar)
// ===========================================================================
test('[D1-9] o e-mail não resolve nem valida nada: mesmo e-mail + outro authUserId é recusado; outro e-mail + o mesmo authUserId é aceito', async (t) => {
  const { idA, idASemEmail } = await identidades(t);
  assert.equal(idA.email, 'a-d1@example.test');
  assert.equal(idASemEmail.email, null);

  // O mesmo e-mail da identidade, mas outro authUserId — o "vínculo por e-mail" que NÃO existe.
  const mesmoEmail = usuarioB({ userId: 'user-d1-mesmo-email', authUserId: 'auth-d1-outro', email: idA.email });
  assert.throws(() => resolveAuthorizationContext(lojaFalsa(() => mesmoEmail), idA), falhaCom(USER_NOT_FOUND));
  assert.throws(() => resolveAuthorizationContext(createUserStore([mesmoEmail]), idA), falhaCom(USER_NOT_FOUND));

  // O mesmo authUserId, com um e-mail sem relação com o da identidade — e uma identidade SEM e-mail: aceitos.
  const outroEmail = usuarioA({ email: 'totalmente-outro-d1@example.test' });
  for (const [rotulo, identidade] of [['identidade com e-mail', idA], ['identidade sem e-mail', idASemEmail]]) {
    assert.equal(resolveAuthorizationContext(lojaFalsa(() => outroEmail), identidade).userId, 'user-d1-a', `${rotulo}: store falso`);
    assert.equal(resolveAuthorizationContext(createUserStore([outroEmail]), identidade).userId, 'user-d1-a', `${rotulo}: store real`);
  }
});

// ===========================================================================
// Contrato: nenhum erro público novo, nenhuma API nova
// ===========================================================================
test('[D1-10] nenhum erro público novo, nenhuma API nova: a recusa é o USER_NOT_FOUND já existente, e o store não mudou', async (t) => {
  const { idA } = await identidades(t);

  // O catálogo de códigos e as exportações do resolver são exatamente os de antes da correção.
  assert.deepEqual(Object.keys(USER_RESOLUTION_ERROR).sort(), [
    'AUTH_USER_ID_DUPLICATE',
    'IDENTITY_NOT_VERIFIED',
    'USER_ID_DUPLICATE',
    'USER_NOT_DEFINED',
    'USER_NOT_FOUND',
    'USER_NOT_OPERATIONAL',
  ]);
  assert.equal(Object.isFrozen(USER_RESOLUTION_ERROR), true);
  assert.deepEqual(
    Object.keys(userResolverModule).sort(),
    ['USER_NOT_FOUND', 'USER_RESOLUTION_ERROR', 'UserResolutionError', 'createUserStore', 'resolveAuthorizationContext'].sort()
  );

  // A recusa do vínculo é a MESMA classe e o MESMO código da recusa "não achado".
  const { erro: erroVinculo } = capturar(() => resolveAuthorizationContext(lojaFalsa(() => usuarioB()), idA));
  const { erro: erroNaoAchado } = capturar(() => resolveAuthorizationContext(createUserStore([]), idA));
  assert.equal(erroVinculo.constructor, erroNaoAchado.constructor);
  assert.equal(erroVinculo.code, erroNaoAchado.code);
  assert.equal(erroVinculo.code, USER_NOT_FOUND);

  // createUserStore não ganhou nada: as 3 operações de sempre, sem nenhuma marca de "confiável".
  assert.deepEqual(Object.keys(createUserStore([])).sort(), ['add', 'all', 'findByAuthUserId']);
});
