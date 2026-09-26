// Transporte HTTPS do adaptador de pesquisa (decisão 0022): UMA requisição GET, sem seguir redirecionamento, com limites duros.
//
// O que garante: só https (a URL passa pela mesma política do rawFinding — https público, sem usuário/senha, sem porta, sem IP/host local);
// validação de certificado LIGADA (nunca rejectUnauthorized: false); conexão só a endereço público (netGuard); tempo total explícito
// (nunca infinito); tamanho máximo do corpo (aborta ao estourar, sem ler o resto); nenhum cookie, credencial, sessão ou proxy (nenhum
// desses existe aqui); sem agente compartilhado (uma conexão por requisição, sem estado entre elas). Não interpreta nada do que recebe:
// devolve status, cabeçalhos (só os de texto) e os bytes.
//
// Erros: TransportError com `code` estável (TIMEOUT, TOO_LARGE, SSRF, TLS, NETWORK, INVALID_URL) — nunca a mensagem da rede.
// O módulo `https` é injetável (os testes automatizados NÃO usam a internet).

const httpsModule = require('node:https');

const { parsePublicUrl } = require('../research-prospector/researchPolicy');
const { createGuardedLookup } = require('./netGuard');

class TransportError extends Error {
  constructor(code) {
    super(`transporte: ${code}`);
    this.name = 'TransportError';
    this.code = code;
  }
}

const TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_WRONG_VERSION_NUMBER']);

// Só estes cabeçalhos de resposta são lidos (texto curto); Set-Cookie e o resto são ignorados.
const KEPT_HEADERS = ['content-type', 'content-length', 'content-encoding', 'location', 'retry-after', 'cf-mitigated'];

function createHttpsTransport({ https = httpsModule, lookup = createGuardedLookup() } = {}) {
  return {
    request({ url, headers, timeoutMs, maxBytes }) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
        const parsed = typeof url === 'string' ? parsePublicUrl(url) : null;
        if (parsed === null || parsed.protocol !== 'https:') return reject(new TransportError('INVALID_URL'));
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxBytes) || maxBytes < 1) return reject(new TransportError('INVALID_URL'));

        let request;
        const abort = (code) => {
          finish(reject, new TransportError(code));
          if (request) request.destroy();
        };
        const timer = setTimeout(() => abort('TIMEOUT'), timeoutMs);
        try {
          request = https.request(parsed, { method: 'GET', headers, lookup, agent: false }, (response) => {
            const chunks = [];
            let size = 0;
            const declared = Number(response.headers['content-length']);
            if (Number.isFinite(declared) && declared > maxBytes) return abort('TOO_LARGE');
            response.on('data', (chunk) => {
              size += chunk.length;
              if (size > maxBytes) return abort('TOO_LARGE');
              chunks.push(chunk);
              return undefined;
            });
            response.on('end', () => {
              const kept = {};
              for (const name of KEPT_HEADERS) if (typeof response.headers[name] === 'string') kept[name] = response.headers[name].slice(0, 2048);
              finish(resolve, { status: response.statusCode, headers: kept, body: Buffer.concat(chunks) });
            });
            response.on('error', () => abort('NETWORK'));
            response.on('aborted', () => abort('NETWORK'));
            return undefined;
          });
        } catch {
          return finish(reject, new TransportError('NETWORK'));
        }
        request.on('error', (error) => {
          const code = error && error.code;
          if (code === 'ESSRF') return finish(reject, new TransportError('SSRF'));
          if (TLS_CODES.has(code) || (typeof code === 'string' && code.startsWith('ERR_SSL'))) return finish(reject, new TransportError('TLS'));
          return finish(reject, new TransportError('NETWORK'));
        });
        request.end();
        return undefined;
      });
    },
  };
}

module.exports = { createHttpsTransport, TransportError };
