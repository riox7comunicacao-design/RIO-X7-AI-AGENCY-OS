// Auth Adapter — isola o resto do sistema do SDK específico do provedor de
// autenticação (Passo 0009.6 / decisão 0010, seção 15; conectado de fato no
// Passo 0009.8 Fase B — ver docs/decisions/0011-supabase-auth-integration.md).
//
// Este adapter SÓ responde "quem está autenticado?" — nunca decide
// ADMIN/CLOSER/CRM/permissões. Essas regras pertencem a USER/
// AuthorizationContext (user.js/authorizationContext.js), nunca a este
// arquivo. Nenhum outro módulo deste projeto deve importar
// "@supabase/supabase-js" diretamente — só este arquivo.
//
// Usa exclusivamente a chave pública "anon" do Supabase
// (SUPABASE_URL/SUPABASE_ANON_KEY). Este arquivo NUNCA lê
// SUPABASE_SERVICE_ROLE_KEY — nem para autenticação normal, nem para
// nenhum outro propósito. Se essa variável existir no ambiente, ela
// simplesmente não é usada por nenhuma função aqui.

const SUPABASE_ENV_VARS = Object.freeze(['SUPABASE_URL', 'SUPABASE_ANON_KEY']);

function isSupabaseConfigured(env = process.env) {
  return SUPABASE_ENV_VARS.every((key) => Boolean(env[key] && String(env[key]).trim()));
}

// Categorias de erro de conectividade (Passo 0009.8, seção 16) — nunca
// "inventadas" na hora do erro: cada uma corresponde a um comportamento
// real observado do SDK/API do Supabase durante este passo.
const CONNECTIVITY_ERROR = Object.freeze({
  CONFIGURACAO: 'CONFIGURACAO', // SUPABASE_URL/ANON_KEY ausentes ou com formato inválido
  NETWORK: 'NETWORK', // host inalcançável (DNS/conexão) — fetch falha antes de qualquer resposta HTTP
  AUTH: 'AUTH', // Supabase respondeu, mas rejeitou a API key (HTTP 401)
  SDK: 'SDK', // falha inesperada dentro do próprio SDK, não classificável como as demais
  PERMISSION: 'PERMISSION', // Supabase respondeu proibindo o acesso (HTTP 403)
  UNKNOWN: 'UNKNOWN', // qualquer resposta que não se encaixe nas anteriores
});

class SupabaseAdapterError extends Error {
  constructor(category, message, options) {
    super(message, options);
    this.name = 'SupabaseAdapterError';
    this.category = category;
  }
}

// Registro interno das identidades devolvidas por verifyAccessToken.
//
// Uma VerifiedIdentity é EXATAMENTE um objeto que verifyAccessToken devolveu ao
// fim do caminho validado (o Supabase Auth confirmou o token e devolveu um
// user.id). A marca é por IDENTIDADE DE OBJETO, não por conteúdo: um literal,
// uma cópia, um clone ou um Proxy com os mesmos campos NÃO é reconhecido.
//
// Isto é uma fronteira arquitetural interna confiável (trusted internal
// architectural boundary), e NÃO um mecanismo criptográfico: serve para que o
// código de negócio não trate por engano — nem por ingenuidade — um objeto
// qualquer como identidade verificada, e para que essa violação apareça em
// teste. Não protege contra código malicioso que já tenha controle do mesmo
// processo: esse código pode importar este módulo, substituir funções ou
// fabricar o próprio registro. A prova real da identidade continua sendo a
// verificação feita pelo servidor do Supabase (getUser).
//
// Nenhuma função exportada permite marcar um objeto: só verifyAccessToken
// registra, e só no fim do caminho validado.
const VERIFIED_IDENTITIES = new WeakSet();

// true somente para um objeto que verifyAccessToken efetivamente devolveu.
// Nunca lança, seja qual for o valor recebido.
function isVerifiedIdentity(value) {
  return typeof value === 'object' && value !== null && VERIFIED_IDENTITIES.has(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Nunca deixa o access token aparecer em mensagens de erro/logs, mesmo que o
// Supabase o repita na própria mensagem.
function scrubToken(message, token) {
  return String(message == null ? '' : message).split(token).join('[token omitido]');
}

// Classifica um erro DEVOLVIDO pelo SDK ao verificar um access token.
// Token rejeitado/inválido/expirado (qualquer rejeição 4xx do Auth) => AUTH;
// falha de rede (o SDK a devolve como AuthRetryableFetchError) => NETWORK;
// erro 5xx do servidor de Auth => UNKNOWN (não é veredito sobre o token).
function classifyVerificationError(error) {
  if (error && error.name === 'AuthRetryableFetchError') return CONNECTIVITY_ERROR.NETWORK;
  if (error && typeof error.status === 'number' && error.status >= 500) return CONNECTIVITY_ERROR.UNKNOWN;
  return CONNECTIVITY_ERROR.AUTH;
}

function createSupabaseAuthAdapter(env = process.env) {
  let cachedClient = null;

  // Cria (ou reaproveita) o cliente Supabase. persistSession/autoRefreshToken
  // desligados de propósito: este é um adapter de backend/servidor, nunca um
  // cliente de navegador — não há localStorage aqui, e não devemos fingir
  // que existe. Isso também significa que este cliente, sozinho, nunca
  // "lembra" uma sessão entre chamadas — ele só resolve o que for
  // explicitamente entregue a ele no futuro (ex.: um token vindo de um
  // Dashboard), o que ainda não existe neste passo.
  function getClient() {
    if (cachedClient) return cachedClient;
    if (!isSupabaseConfigured(env)) {
      throw new SupabaseAdapterError(
        CONNECTIVITY_ERROR.CONFIGURACAO,
        'Supabase não configurado: SUPABASE_URL e/ou SUPABASE_ANON_KEY ausentes nas variáveis de ambiente.'
      );
    }
    // require() adiado: o SDK só é carregado quando de fato necessário.
    const { createClient } = require('@supabase/supabase-js');
    try {
      cachedClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
    } catch (err) {
      throw new SupabaseAdapterError(CONNECTIVITY_ERROR.CONFIGURACAO, `SUPABASE_URL/ANON_KEY inválidos: ${err.message}`, { cause: err });
    }
    return cachedClient;
  }

  // Consulta se existe uma sessão já carregada neste cliente. Como o
  // cliente nunca persiste nem recebe um token (ver getClient), o resultado
  // esperado hoje é sempre "sem sessão" — isso NÃO é um erro (Passo 0009.8,
  // seção 10, resultado D). Só lança se o próprio Supabase Auth retornar um
  // erro explícito (ex.: chave rejeitada) ou se o SDK falhar de forma
  // inesperada.
  async function getSessionStatus() {
    const client = getClient();
    let result;
    try {
      result = await client.auth.getSession();
    } catch (err) {
      throw new SupabaseAdapterError(CONNECTIVITY_ERROR.SDK, `Falha inesperada do SDK ao consultar sessão: ${err.message}`, { cause: err });
    }
    const { data, error } = result;
    if (error) {
      throw new SupabaseAdapterError(CONNECTIVITY_ERROR.AUTH, `Supabase Auth retornou erro ao consultar sessão: ${error.message}`, { cause: error });
    }
    if (!data.session) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      authUserId: data.session.user.id,
      email: data.session.user.email || null,
    };
  }

  // Verifica conectividade REAL com o Supabase Auth. getSession() sozinho
  // NÃO prova rede — com persistSession desligado, ele resolve localmente
  // em ~1ms mesmo apontando para um projeto inexistente (verificado durante
  // este passo). Esta função chama o endpoint público e somente-leitura
  // /auth/v1/settings (o mesmo que os SDKs oficiais usam para descobrir a
  // configuração de auth do projeto) — sem efeito colateral, sem criar
  // nada, sem autenticar ninguém.
  async function checkConnectivity() {
    if (!isSupabaseConfigured(env)) {
      return { status: CONNECTIVITY_ERROR.CONFIGURACAO, detail: 'SUPABASE_URL/SUPABASE_ANON_KEY ausentes.' };
    }
    let response;
    try {
      response = await fetch(`${String(env.SUPABASE_URL).replace(/\/$/, '')}/auth/v1/settings`, {
        headers: { apikey: env.SUPABASE_ANON_KEY },
      });
    } catch (err) {
      return { status: CONNECTIVITY_ERROR.NETWORK, detail: err.message };
    }
    if (response.status === 200) {
      return { status: 'OK' };
    }
    if (response.status === 401) {
      return { status: CONNECTIVITY_ERROR.AUTH, detail: `HTTP ${response.status}` };
    }
    if (response.status === 403) {
      return { status: CONNECTIVITY_ERROR.PERMISSION, detail: `HTTP ${response.status}` };
    }
    return { status: CONNECTIVITY_ERROR.UNKNOWN, detail: `HTTP ${response.status}` };
  }

  // Verifica um ACCESS TOKEN REAL emitido pelo Supabase Auth e devolve a
  // identidade verificada NO SERVIDOR do Supabase: { authUserId, email,
  // emailConfirmed }. Este é o caminho de identidade verificada — getSession()
  // NÃO é prova de identidade (lê estado local, sem validar nada no servidor).
  //
  // - Usa auth.getUser(accessToken): o SDK chama GET /auth/v1/user com o token
  //   explícito e NÃO lê nem grava a sessão do cliente (nada é "logado" neste
  //   cliente em cache — não há contaminação entre requisições).
  // - authUserId vem SÓ de user.id; email SÓ de user.email; emailConfirmed SÓ
  //   de user.email_confirmed_at (estado de confirmação do próprio Supabase).
  // - A única entrada é o token. Nenhum authUserId/email/role/permissions/status
  //   fornecido pelo chamador participa da identidade, e nenhum objeto USER é
  //   consultado. Nada aqui cria AuthorizationContext — isso é etapa futura.
  // - O objeto devolvido é registrado em VERIFIED_IDENTITIES (ver
  //   isVerifiedIdentity): só um objeto efetivamente devolvido por este caminho
  //   é reconhecido como identidade verificada — nunca uma cópia, um clone ou
  //   um literal equivalente. Isso NÃO é criptografia (ver o comentário do
  //   registro) e não altera a lógica de verificação abaixo.
  // - Só leitura (GET). Nenhuma escrita no Supabase.
  async function verifyAccessToken(accessToken) {
    if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
      throw new SupabaseAdapterError(
        CONNECTIVITY_ERROR.AUTH,
        'accessToken ausente, vazio ou não é uma string: nenhuma identidade pode ser verificada.'
      );
    }
    const token = accessToken.trim();
    const client = getClient(); // lança CONFIGURACAO se SUPABASE_URL/ANON_KEY estiverem ausentes

    let result;
    try {
      result = await client.auth.getUser(token);
    } catch (err) {
      const category = err && err.name === 'AuthRetryableFetchError' ? CONNECTIVITY_ERROR.NETWORK : CONNECTIVITY_ERROR.SDK;
      throw new SupabaseAdapterError(
        category,
        `Falha ao verificar o access token no Supabase Auth: ${scrubToken(err && err.message, token)}`
      );
    }

    const { data, error } = result || {};
    if (error) {
      const detalhe = [
        typeof error.status === 'number' && error.status > 0 ? `HTTP ${error.status}` : null,
        typeof error.code === 'string' ? error.code : null,
      ]
        .filter(Boolean)
        .join(', ');
      throw new SupabaseAdapterError(
        classifyVerificationError(error),
        `Supabase Auth não verificou o access token${detalhe ? ` (${detalhe})` : ''}: ${scrubToken(error.message, token)}`
      );
    }

    const user = data && data.user;
    if (!user || typeof user !== 'object') {
      throw new SupabaseAdapterError(
        CONNECTIVITY_ERROR.AUTH,
        'Supabase Auth não devolveu nenhum usuário para este access token: identidade não verificada.'
      );
    }
    if (!isNonEmptyString(user.id)) {
      throw new SupabaseAdapterError(
        CONNECTIVITY_ERROR.AUTH,
        'Resposta do Supabase Auth sem user.id válido: identidade não verificada.'
      );
    }

    const email = isNonEmptyString(user.email) ? user.email : null;
    // Sem e-mail não há e-mail a confirmar. Com e-mail, só vale o timestamp de
    // confirmação do próprio Supabase; qualquer coisa que não seja uma data
    // válida conta como NÃO confirmado (falha fechada).
    const emailConfirmed =
      email !== null && isNonEmptyString(user.email_confirmed_at) && Number.isFinite(Date.parse(user.email_confirmed_at));

    // Único ponto que registra uma identidade: o fim do caminho validado. Toda
    // falha acima lança antes de chegar aqui.
    const identity = Object.freeze({ authUserId: user.id, email, emailConfirmed });
    VERIFIED_IDENTITIES.add(identity);
    return identity;
  }

  // Devolve { authUserId, email } de uma sessão já autenticada NESTE cliente.
  // NÃO é prova de identidade (ver verifyAccessToken). Lança um
  // erro simples (não uma SupabaseAdapterError categorizada) quando não há
  // sessão — isso não é uma falha de conectividade, é só a ausência de
  // login, esperada enquanto nenhum Dashboard/fluxo de login existe.
  async function resolveAuthenticatedIdentity() {
    const status = await getSessionStatus();
    if (!status.authenticated) {
      throw new Error(
        'nenhuma sessão autenticada no Supabase Auth — não há identidade para resolver ' +
          '(isto não é um erro de conectividade, só ausência de login; nenhum fluxo de login existe ainda)'
      );
    }
    return { authUserId: status.authUserId, email: status.email };
  }

  return {
    isConfigured: () => isSupabaseConfigured(env),
    getClient,
    getSessionStatus,
    checkConnectivity,
    verifyAccessToken,
    resolveAuthenticatedIdentity,
  };
}

module.exports = {
  SUPABASE_ENV_VARS,
  isSupabaseConfigured,
  createSupabaseAuthAdapter,
  SupabaseAdapterError,
  CONNECTIVITY_ERROR,
  isVerifiedIdentity,
};
