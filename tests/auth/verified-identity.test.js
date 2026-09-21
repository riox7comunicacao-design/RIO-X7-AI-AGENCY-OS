// Fase B — identidade verificada (marca interna da saída de verifyAccessToken).
//
// O que estes testes protegem: uma "VerifiedIdentity" é EXATAMENTE um objeto
// que verifyAccessToken devolveu ao fim do caminho validado. A marca é interna
// e por IDENTIDADE DE OBJETO (não por conteúdo). É uma fronteira arquitetural
// interna confiável — NÃO um mecanismo criptográfico: não protege contra
// código malicioso que já controle o mesmo processo.
//
// Determinístico e sem rede: o SDK real do Supabase roda contra um fetch falso
// (tests/helpers/authFixtures.js), passando pelo verifyAccessToken real.
//
// Não duplica o que já existe em identity-verification.test.js: o CONTEÚDO da
// identidade (só authUserId/email/emailConfirmed; nada de role/permissions
// vindos do Supabase) é coberto por [ID-1..6], [REQ-3] e [SEC-3], e as
// categorias de erro por [TOKEN-1..4], [RESP-*] e [ERRO-*]. Aqui o assunto é
// só a marca — e, onde há sobreposição, o teste afirma a propriedade NOVA
// (isVerifiedIdentity), não a categoria do erro.

const test = require('node:test');
const assert = require('node:assert/strict');

const authAdapterModule = require('../../src/auth/authAdapter');
const { createSupabaseAuthAdapter, isVerifiedIdentity, SupabaseAdapterError, CONNECTIVITY_ERROR } = authAdapterModule;
const {
  FAKE_ENV,
  fakeAccessToken,
  supabaseUserBody,
  installFakeSupabaseAuth,
  verifiedIdentityFor,
  verifiedIdentitiesFor,
} = require('../helpers/authFixtures');

const AUTH_ID = '00000000-0000-4000-8000-00000000000b';
const EMAIL = 'usuario-verificado@example.test';

// Resolve ou rejeita sem lançar, para inspecionar tanto o valor quanto o erro.
function settle(promise) {
  return promise.then(
    (valor) => ({ resolveu: true, valor }),
    (erro) => ({ resolveu: false, erro })
  );
}

// ===========================================================================
// 1 — a saída válida é reconhecida
// ===========================================================================
test('[VERIF-1] a saída válida de verifyAccessToken é reconhecida por isVerifiedIdentity, sem que a marca altere o objeto', async (t) => {
  const identidade = await verifiedIdentityFor(t, { authUserId: AUTH_ID, email: EMAIL, emailConfirmed: true });

  assert.equal(isVerifiedIdentity(identidade), true);

  // O helper passou pelo verifyAccessToken REAL: exatamente 1 requisição,
  // GET /auth/v1/user, com o token em Authorization.
  const chamadas = globalThis.fetch.mock.calls;
  assert.equal(chamadas.length, 1);
  const [url, init] = chamadas[0].arguments;
  assert.equal(new URL(String(url)).pathname, '/auth/v1/user');
  assert.equal(String(init.method).toUpperCase(), 'GET');
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${fakeAccessToken(0)}`);

  // Contrato inalterado (item 5): só os 3 campos, congelada, sem role/permissions —
  // e a marca NÃO vive no objeto (nem propriedade enumerável, nem símbolo).
  assert.deepEqual(identidade, { authUserId: AUTH_ID, email: EMAIL, emailConfirmed: true });
  assert.deepEqual(Reflect.ownKeys(identidade).map(String).sort(), ['authUserId', 'email', 'emailConfirmed']);
  assert.equal(Object.isFrozen(identidade), true);
  for (const proibido of ['role', 'permissions', 'status', 'userId', 'name']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(identidade, proibido),
      false,
      `${proibido} não pode existir na identidade verificada`
    );
  }
});

// ===========================================================================
// 2 — cópias e clones não são reconhecidos
// ===========================================================================
test('[VERIF-2] cópias e clones da identidade verificada NÃO são reconhecidos: a marca é por objeto, não por conteúdo', async (t) => {
  const original = await verifiedIdentityFor(t, { authUserId: AUTH_ID, email: EMAIL, emailConfirmed: true });
  assert.equal(isVerifiedIdentity(original), true);

  const copias = [
    ['spread', { ...original }],
    ['spread congelada', Object.freeze({ ...original })],
    ['Object.assign', Object.assign({}, original)],
    ['Object.fromEntries', Object.fromEntries(Object.entries(original))],
    ['structuredClone', structuredClone(original)],
    ['clone via JSON', JSON.parse(JSON.stringify(original))],
    ['Object.create(original)', Object.create(original)],
    ['Proxy(original)', new Proxy(original, {})],
  ];
  for (const [rotulo, copia] of copias) {
    assert.equal(isVerifiedIdentity(copia), false, rotulo);
  }

  // O original continua reconhecido; as cópias não o afetam.
  assert.equal(isVerifiedIdentity(original), true);
});

// ===========================================================================
// 3 — literal com os mesmos campos não é reconhecido
// ===========================================================================
test('[VERIF-3] um literal com os mesmos campos NÃO é reconhecido, e duas verificações com o mesmo conteúdo geram objetos distintos, ambos reconhecidos', async (t) => {
  const [a, b] = await verifiedIdentitiesFor(t, [
    { authUserId: AUTH_ID, email: EMAIL, emailConfirmed: true },
    { authUserId: AUTH_ID, email: EMAIL, emailConfirmed: true },
  ]);

  // Duas verificações do "mesmo" usuário: conteúdo igual, objetos diferentes,
  // ambos vindos do caminho validado.
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  assert.equal(isVerifiedIdentity(a), true);
  assert.equal(isVerifiedIdentity(b), true);

  // Literais com os mesmos campos e valores (ou piores): nenhum é reconhecido.
  const literais = [
    ['literal simples', { authUserId: AUTH_ID, email: EMAIL, emailConfirmed: true }],
    ['literal congelado', Object.freeze({ authUserId: AUTH_ID, email: EMAIL, emailConfirmed: true })],
    ['literal sem e-mail', { authUserId: AUTH_ID, email: null, emailConfirmed: false }],
    ['literal só com authUserId', { authUserId: AUTH_ID }],
    [
      'literal com campos extras (role/permissions)',
      { authUserId: AUTH_ID, email: EMAIL, emailConfirmed: true, role: 'ADMIN', permissions: ['MANAGE:USERS'] },
    ],
  ];
  for (const [rotulo, literal] of literais) {
    assert.equal(isVerifiedIdentity(literal), false, rotulo);
  }
});

// ===========================================================================
// 4 — valores não-objeto (e objetos quaisquer) não são reconhecidos
// ===========================================================================
test('[VERIF-4] valores que não são identidades verificadas (não-objetos e objetos quaisquer) nunca são reconhecidos, e isVerifiedIdentity nunca lança', () => {
  const valores = [
    ['undefined', undefined],
    ['null', null],
    ['string vazia', ''],
    ['string', 'authUserId'],
    ['zero', 0],
    ['número', 42],
    ['NaN', Number.NaN],
    ['true', true],
    ['false', false],
    ['bigint', 1n],
    ['symbol', Symbol('x')],
    ['função', () => ({ authUserId: 'x' })],
    ['classe', class Identidade {}],
    ['objeto vazio', {}],
    ['Object.create(null)', Object.create(null)],
    ['array', []],
    ['array com objeto', [{ authUserId: 'x' }]],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['Set', new Set()],
    ['RegExp', /x/],
    ['Error', new Error('x')],
    ['Buffer', Buffer.from('x')],
  ];
  for (const [rotulo, valor] of valores) {
    let resultado;
    assert.doesNotThrow(() => {
      resultado = isVerifiedIdentity(valor);
    }, rotulo);
    assert.equal(resultado, false, rotulo);
  }
  assert.equal(isVerifiedIdentity(), false, 'sem argumento');
});

// ===========================================================================
// 6 — token inválido não produz identidade verificada
// ===========================================================================
test('[VERIF-5] token inválido, expirado ou sem usuário nunca produz identidade verificada', async (t) => {
  // Supabase falso que NÃO conhece o token usado abaixo.
  const fake = installFakeSupabaseAuth(t, {});
  const adapter = createSupabaseAuthAdapter({ ...FAKE_ENV });

  const cenarios = [
    [
      'HTTP 403 bad_jwt (formato observado no Supabase real)',
      403,
      { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT: unable to parse or verify signature, token is malformed' },
    ],
    ['HTTP 401 token expirado', 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT: token has invalid claims: token is expired' }],
    ['HTTP 200 com corpo sem id de usuário', 200, {}],
  ];

  for (const [rotulo, status, corpo] of cenarios) {
    fake.respondToUnknownTokensWith(status, corpo);
    const resultado = await settle(adapter.verifyAccessToken(fakeAccessToken(99)));

    assert.equal(resultado.resolveu, false, `${rotulo}: não pode resolver com uma identidade`);
    assert.ok(resultado.erro instanceof SupabaseAdapterError, rotulo);
    assert.equal(resultado.erro.category, CONNECTIVITY_ERROR.AUTH, rotulo);
    assert.equal(isVerifiedIdentity(resultado.valor), false, rotulo);
    assert.equal(isVerifiedIdentity(resultado.erro), false, rotulo);
  }
  assert.equal(fake.unexpectedRequests.length, 0);
});

// ===========================================================================
// 7 — ausência de token não produz identidade verificada
// ===========================================================================
test('[VERIF-6] ausência de token nunca produz identidade verificada e nem chega à rede', async (t) => {
  // Até um Supabase falso que conhece o token do teste não chega a ser consultado.
  installFakeSupabaseAuth(t, { [fakeAccessToken(0)]: supabaseUserBody({ authUserId: AUTH_ID, email: EMAIL }) });
  const adapter = createSupabaseAuthAdapter({ ...FAKE_ENV });

  const ausentes = [
    ['undefined', undefined],
    ['null', null],
    ['string vazia', ''],
    ['só espaços', '   '],
    ['não-string (objeto)', { accessToken: fakeAccessToken(0) }],
    ['não-string (número)', 123],
  ];
  for (const [rotulo, valor] of ausentes) {
    const resultado = await settle(adapter.verifyAccessToken(valor));

    assert.equal(resultado.resolveu, false, rotulo);
    assert.equal(resultado.erro.category, CONNECTIVITY_ERROR.AUTH, rotulo);
    assert.equal(isVerifiedIdentity(resultado.valor), false, rotulo);
    assert.equal(isVerifiedIdentity(resultado.erro), false, rotulo);
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0, 'nenhuma requisição foi feita');
});

// ===========================================================================
// Superfície: nada exportado permite marcar uma identidade
// ===========================================================================
test('[VERIF-7] nenhuma função exportada ou exposta pelo adapter permite marcar uma identidade como verificada', () => {
  assert.equal(typeof isVerifiedIdentity, 'function');

  // Tripwire: mudar a superfície exportada do módulo exige uma decisão
  // consciente — só isVerifiedIdentity (leitura) é nova; nada que "marque".
  assert.deepEqual(Object.keys(authAdapterModule).sort(), [
    'CONNECTIVITY_ERROR',
    'SUPABASE_ENV_VARS',
    'SupabaseAdapterError',
    'createSupabaseAuthAdapter',
    'isSupabaseConfigured',
    'isVerifiedIdentity',
  ]);

  // O adapter (criar um não abre cliente nem faz rede) também não expõe nada com cara de marcador.
  const adapter = createSupabaseAuthAdapter({ ...FAKE_ENV });
  for (const nome of Object.keys(adapter)) {
    assert.doesNotMatch(nome, /mark|regist|brand|stamp|certif|vouch|verified/i, `membro suspeito do adapter: ${nome}`);
  }
});
