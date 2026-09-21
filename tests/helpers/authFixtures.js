'use strict';

// Helpers de teste da fronteira de identidade (Fases B e C).
//
// Fase B: produzem uma VerifiedIdentity REAL — o objeto que authAdapter.verifyAccessToken
// de fato devolve — SEM rede: o SDK real do Supabase roda contra um `fetch`
// falso e controlado, então o caminho de verificação (GET /auth/v1/user, leitura
// da resposta, validações e marca interna) é o de produção. Nada aqui fabrica
// um objeto e o marca à mão.
//
// USO SOMENTE EM TESTES: src/ nunca deve importar este arquivo. Nenhuma
// credencial real é usada — URL, chave e tokens são placeholders óbvios.
//
// Ressalva honesta: a marca de VerifiedIdentity prova que o objeto saiu do
// caminho de código de verificação, não que o Supabase real o tenha validado —
// se o fetch for substituído (como estes helpers fazem, de propósito), a rede
// deixa de participar. É a mesma limitação de qualquer fronteira arquitetural
// interna: ela não protege contra código que controla o processo.

const { createSupabaseAuthAdapter } = require('../../src/auth/authAdapter');

// Ponto de composição de testes do AuthorizationContext (Fase C). O emissor
// único vive em src/auth/internal/contextIssuer.js e NÃO é exportado pelo
// barrel de src/auth; este helper é o único ponto de testes que o importa e o
// expõe sob o nome antigo `createAuthorizationContext`, para que os testes
// existentes mudem só a linha de import. Em src/ NÃO existe mais nenhum
// construtor público de contexto: aqui é só o mesmo emissor interno,
// estrito (aceita só USER de defineUser() com authUserId), usado por testes.
const contextIssuerModule = require('../../src/auth/internal/contextIssuer');
const { issueAuthorizationContext, isIssuedAuthorizationContext } = contextIssuerModule;

const createAuthorizationContext = issueAuthorizationContext;

const FAKE_ENV = Object.freeze({
  SUPABASE_URL: 'https://exemplo.supabase.co',
  SUPABASE_ANON_KEY: 'chave-de-teste-nao-real',
});

// Resposta de erro no formato observado no Supabase real para um token
// malformado (HTTP 403, bad_jwt).
const BAD_JWT_RESPONSE = Object.freeze({
  status: 403,
  body: Object.freeze({
    code: 403,
    error_code: 'bad_jwt',
    msg: 'invalid JWT: unable to parse or verify signature, token is malformed',
  }),
});

// Access token de teste (placeholder óbvio — nunca um token real).
function fakeAccessToken(indice = 0) {
  return `token-de-teste-nao-real-${indice}.parte-b.parte-c`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Corpo JSON de GET /auth/v1/user para um usuário fictício. Sem `authUserId`
// não há `id` (cenário "usuário sem id"); sem `email` não há e-mail nem
// confirmação; `extras` permite injetar ruído (role, metadata…) do lado do
// Supabase para provar que ele não vaza para a identidade.
function supabaseUserBody({ authUserId, email = null, emailConfirmed = true, extras = {} } = {}) {
  const body = {
    id: authUserId,
    aud: 'authenticated',
    role: 'authenticated',
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...extras,
  };
  if (email !== null) {
    body.email = email;
    if (emailConfirmed) {
      body.email_confirmed_at = '2026-01-01T00:00:00.000000Z';
    }
  }
  return body;
}

// Instala UM fetch falso para o teste `t`. Serve somente GET /auth/v1/user:
//   - token conhecido (chave de `users`) -> HTTP 200 com o corpo do usuário;
//   - token desconhecido -> a resposta configurada (padrão: 403 bad_jwt).
// Qualquer outra URL ou método é erro do teste (nada de rede, nada de escrita):
// é registrado em `unexpectedRequests` e a chamada falha.
//
// Deve ser chamado ANTES de o adapter criar o cliente (o SDK captura o fetch
// global na criação). O mock é restaurado automaticamente no fim do teste.
function installFakeSupabaseAuth(t, users = {}) {
  let unknownToken = BAD_JWT_RESPONSE;
  const unexpectedRequests = [];

  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const pathname = new URL(String(url)).pathname;
    if (method !== 'GET' || pathname !== '/auth/v1/user') {
      unexpectedRequests.push(`${method} ${pathname}`);
      throw new Error(`requisição inesperada no Supabase falso: ${method} ${pathname}`);
    }
    const authorization = new Headers((init && init.headers) || {}).get('authorization') || '';
    const token = authorization.replace(/^Bearer\s+/i, '');
    if (Object.prototype.hasOwnProperty.call(users, token)) {
      return jsonResponse(users[token]);
    }
    return jsonResponse(unknownToken.body, unknownToken.status);
  });

  return {
    unexpectedRequests,
    respondToUnknownTokensWith(status, body) {
      unknownToken = { status, body };
    },
  };
}

// Devolve, em ordem, uma VerifiedIdentity REAL para cada spec
// ({ authUserId, email, emailConfirmed, extras }). Cada uma passa por
// authAdapter.verifyAccessToken, com um token de teste distinto.
async function verifiedIdentitiesFor(t, specs) {
  const users = {};
  const tokens = specs.map((spec, indice) => {
    const token = fakeAccessToken(indice);
    users[token] = supabaseUserBody(spec);
    return token;
  });

  installFakeSupabaseAuth(t, users);
  const adapter = createSupabaseAuthAdapter({ ...FAKE_ENV });

  const identities = [];
  for (const token of tokens) {
    identities.push(await adapter.verifyAccessToken(token));
  }
  return identities;
}

async function verifiedIdentityFor(t, spec) {
  const [identity] = await verifiedIdentitiesFor(t, [spec]);
  return identity;
}

module.exports = {
  contextIssuerModule,
  issueAuthorizationContext,
  createAuthorizationContext,
  isIssuedAuthorizationContext,
  FAKE_ENV,
  BAD_JWT_RESPONSE,
  fakeAccessToken,
  jsonResponse,
  supabaseUserBody,
  installFakeSupabaseAuth,
  verifiedIdentitiesFor,
  verifiedIdentityFor,
};
