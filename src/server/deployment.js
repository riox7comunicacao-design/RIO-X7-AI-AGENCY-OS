// A CONFIGURAÇÃO DE IMPLANTAÇÃO (Fase WEB 1, decisão 0033): o mesmo código roda de dois jeitos, escolhidos EXPLICITAMENTE por RIO_X7_DEPLOYMENT_MODE.
//
//   "local" (padrão; variável ausente ou vazia)  o sistema completo, exatamente como sempre foi: CRM, Approval Queue, prospecção, com os arquivos de data/ ao lado do código.
//   "crm-only"                                   a instância HOSPEDADA (Hostinger Web Apps): só o CRM Comercial. A persistência é a do Supabase; a Approval Queue, a prospecção, os briefs, os jobs, os
//                                                perfis e tudo o que guarda estado em arquivo ficam DESATIVADOS no servidor — nenhum repositório de arquivo é criado, nenhum job antigo é recuperado,
//                                                nenhum arquivo é lido ou criado em data/, e as rotas desses módulos respondem MODULE_DISABLED (ver app.js).
//
// Qualquer outro valor derruba a subida (falha segura): nunca se cai para "local" por engano numa hospedagem de disco efêmero.
//
// Só dados e funções puras: nada aqui lê o ambiente do processo, o disco ou a rede (quem passa `env` é index.js).

const DEPLOYMENT_MODE = Object.freeze({ LOCAL: 'local', CRM_ONLY: 'crm-only' });

// Os prefixos de /api dos módulos que dependem de arquivos locais. No modo "crm-only" qualquer método em qualquer um deles é recusado ANTES da autenticação e de qualquer Service.
const CRM_ONLY_DISABLED_PREFIXES = Object.freeze(['/api/approvals', '/api/prospecting', '/api/leads']);

const HEALTH_PATH = '/healthz';

// Falhas de autenticação toleradas por cliente antes do bloqueio temporário (só no modo "crm-only"). O LOGIN em si é do Supabase Auth (o navegador fala direto com ele): os limites de
// tentativas de senha vivem lá (docs/operations/web-hostinger.md); este limite protege a API própria contra quem insiste com sessões ausentes ou inválidas.
const AUTH_FAILURE_LIMIT = Object.freeze({ maxFailures: 30, windowMs: 10 * 60 * 1000, blockMs: 10 * 60 * 1000 });

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

function readDeploymentMode(env) {
  const raw = env && env.RIO_X7_DEPLOYMENT_MODE;
  if (isBlank(raw)) return DEPLOYMENT_MODE.LOCAL;
  const value = String(raw).trim();
  if (value === DEPLOYMENT_MODE.LOCAL || value === DEPLOYMENT_MODE.CRM_ONLY) return value;
  throw new Error('RIO_X7_DEPLOYMENT_MODE inválido: use "local" (padrão) ou "crm-only".');
}

// A origem pública (https) da instância hospedada: usada só para redirecionar HTTP -> HTTPS. Nunca se monta um redirecionamento a partir do cabeçalho Host da requisição.
function readPublicOrigin(env) {
  const raw = env && env.RIO_X7_PUBLIC_URL;
  const failure = new Error('RIO_X7_PUBLIC_URL inválida: informe só a origem https do site (ex.: https://crm.seudominio.com.br), sem caminho, consulta, usuário ou porta fora do padrão não https.');
  if (isBlank(raw)) throw new Error('RIO_X7_PUBLIC_URL é obrigatória com RIO_X7_DEPLOYMENT_MODE=crm-only: informe a origem https do site (ex.: https://crm.seudominio.com.br).');
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw failure;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/' || url.hostname === '') throw failure;
  return url.origin;
}

function readTrustProxy(env) {
  const raw = env && env.RIO_X7_TRUST_PROXY;
  if (isBlank(raw)) return false;
  const value = String(raw).trim();
  if (value === '0') return false;
  if (value === '1') return true;
  throw new Error('RIO_X7_TRUST_PROXY inválido: use 0 (padrão) ou 1.');
}

// -> { mode, hosted, publicOrigin, trustProxy }. Lança com uma mensagem clara (sem repetir o valor recebido) se algo estiver inválido.
function readDeploymentConfig(env) {
  const mode = readDeploymentMode(env);
  if (mode === DEPLOYMENT_MODE.LOCAL) return Object.freeze({ mode, hosted: false, publicOrigin: null, trustProxy: false });
  return Object.freeze({ mode, hosted: true, publicOrigin: readPublicOrigin(env), trustProxy: readTrustProxy(env) });
}

function isDisabledInCrmOnly(pathname) {
  return CRM_ONLY_DISABLED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

const header = (req, name) => {
  const value = req && req.headers ? req.headers[name] : undefined;
  return typeof value === 'string' ? value : undefined;
};

// O protocolo que o PROXY da plataforma diz ter recebido: o último valor de X-Forwarded-Proto (o do proxy mais próximo). Sem o cabeçalho: null (não se sabe, e nada é redirecionado).
function forwardedProto(req) {
  const value = header(req, 'x-forwarded-proto');
  if (value === undefined) return null;
  const parts = value.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

const IP_TEXT = /^[0-9A-Fa-f:.]{2,45}$/;

// A chave do limitador de falhas: com RIO_X7_TRUST_PROXY=1, o ÚLTIMO endereço de X-Forwarded-For (o que o proxy da plataforma acrescentou; um valor que o cliente tenha mandado vem antes e é
// ignorado); sem ele (ou sem o cabeçalho), o endereço do socket. Atrás de um proxy sem confiança todos compartilham a mesma chave — por isso o limite é generoso e só conta FALHAS.
function clientKey(req, trustProxy) {
  if (trustProxy) {
    const forwarded = header(req, 'x-forwarded-for');
    if (forwarded !== undefined) {
      const last = forwarded.split(',').map((part) => part.trim()).filter(Boolean).pop();
      if (last !== undefined && IP_TEXT.test(last)) return last.toLowerCase();
    }
  }
  const address = req && req.socket && typeof req.socket.remoteAddress === 'string' ? req.socket.remoteAddress : '';
  return address !== '' ? address.toLowerCase() : 'desconhecido';
}

module.exports = {
  DEPLOYMENT_MODE,
  CRM_ONLY_DISABLED_PREFIXES,
  HEALTH_PATH,
  AUTH_FAILURE_LIMIT,
  readDeploymentMode,
  readPublicOrigin,
  readTrustProxy,
  readDeploymentConfig,
  isDisabledInCrmOnly,
  forwardedProto,
  clientKey,
};
