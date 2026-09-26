// Cliente da WEB PÚBLICA do Researcher (decisão 0022): tudo o que um adaptador de rede precisa, sem nenhum detalhe de provedor.
//
//   createPublicWeb({ transport, userAgent, ... }) -> { fetchPage(url), getJson(url), estatisticas() }
//
// SÓ CONTEÚDO PÚBLICO. Nunca: login, credencial, cookie, sessão autenticada, captcha resolvido, bloqueio contornado, robots.txt ignorado,
// proxy, dado privado. Os cabeçalhos enviados são exatamente quatro (User-Agent identificado, Accept, Accept-Language, Accept-Encoding:
// identity) — não existe opção, campo ou caminho de código para Cookie, Authorization, Referer ou proxy. TLS sempre validado.
//
// LIMITES (todos explícitos, validados na criação; nada é infinito): tempo por requisição, bytes por resposta, redirecionamentos por
// pedido, requisições no total (o robots.txt também conta), intervalo mínimo por host (cortesia; o relógio e o `sleep` são injetáveis).
// NENHUMA nova tentativa: cada pedido é feito UMA vez; uma falha é devolvida, não repetida.
//
// ROBOTS: antes de qualquer página, o robots.txt do host é lido (uma vez por host) e a URL só é buscada se ele PERMITIR. 404/410 = sem
// robots.txt (permitido). Qualquer outra coisa que impeça uma verificação adequada (401/403, 5xx, erro de rede, tempo, tamanho, redirecionamento
// externo) = NÃO se acessa (falha ROBOTS, motivo determinístico). Não há opção para desligar essa verificação.
//
// REDIRECIONAMENTOS: seguidos à mão, cada salto revalidado pela política existente (https público, sem login) e, por padrão, só dentro do
// MESMO host; um salto para uma tela de login é LOGIN (evento REDIRECT_TO_LOGIN) e a pesquisa daquela página termina ali.
//
// SAÍDA — o contrato do Researcher, sem alteração: fetchPage devolve { ok: true, urlFinal, links, temFormularioContato } ou
// { ok: false, falha } com falha ∈ researchPolicy.FAILURE. Os DETALHES (por que exatamente) ficam nos EVENTOS do adaptador (códigos
// estáveis e o host, nunca uma URL completa, cabeçalho, corpo ou mensagem de rede), lidos por estatisticas().

const { parsePublicUrl, bareHost, isLoginWall, FAILURE } = require('../research-prospector/researchPolicy');
const { TransportError } = require('./httpsTransport');
const { parseRobots, isAllowed } = require('./robots');
const { extractPage } = require('./htmlExtract');

const DEFAULTS = Object.freeze({
  timeoutMs: 10000,
  maxBytes: 1024 * 1024,
  robotsMaxBytes: 512 * 1024,
  maxRedirects: 3,
  maxRequests: 60,
  minIntervalMs: 1000,
  maxEvents: 200,
});
const BOUNDS = Object.freeze({
  timeoutMs: [1, 60000],
  maxBytes: [1024, 5 * 1024 * 1024],
  robotsMaxBytes: [1024, 1024 * 1024],
  maxRedirects: [0, 5],
  maxRequests: [1, 500],
  minIntervalMs: [0, 60000],
  maxEvents: [1, 1000],
});

const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)\b/i;
const JSON_TYPE = /^application\/(json|[a-z0-9.+-]+\+json)\b/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readLimit(name, value) {
  const [min, max] = BOUNDS[name];
  const chosen = value === undefined ? DEFAULTS[name] : value;
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) throw new Error(`createPublicWeb: ${name} deve ser um inteiro entre ${min} e ${max} (nenhum limite é infinito)`);
  return chosen;
}

function createPublicWeb(options) {
  const allowed = ['transport', 'userAgent', 'now', 'sleep', 'allowCrossHostRedirects', ...Object.keys(DEFAULTS)];
  for (const key of Object.keys(options || {})) if (!allowed.includes(key)) throw new Error(`createPublicWeb: opção desconhecida "${key.slice(0, 40)}" (o adaptador não aceita credenciais nem contornos de controle de acesso)`);
  const { transport, userAgent, now = () => new Date(), sleep = defaultSleep, allowCrossHostRedirects = false } = options || {};
  if (!transport || typeof transport.request !== 'function') throw new Error('createPublicWeb exige { transport } com request()');
  if (typeof userAgent !== 'string' || !/^[\x20-\x7E]{10,200}$/.test(userAgent)) throw new Error('createPublicWeb exige { userAgent } (10 a 200 caracteres ASCII que identifiquem o pesquisador)');
  if (typeof now !== 'function' || typeof sleep !== 'function') throw new Error('createPublicWeb: now e sleep devem ser funções');
  if (typeof allowCrossHostRedirects !== 'boolean') throw new Error('createPublicWeb: allowCrossHostRedirects deve ser booleano');
  const limits = Object.fromEntries(Object.keys(DEFAULTS).map((name) => [name, readLimit(name, options[name])]));
  const product = userAgent.split(/[/\s]/)[0].toLowerCase();

  const stats = { requisicoes: 0, robotsConsultados: 0, redirecionamentos: 0, falhas: {}, eventos: [] };
  const lastRequestAt = new Map();
  const robotsByOrigin = new Map();

  const event = (codigo, host) => {
    if (stats.eventos.length < limits.maxEvents) stats.eventos.push(host ? { codigo, host } : { codigo });
  };
  const failure = (falha, codigo, host) => {
    stats.falhas[falha] = (stats.falhas[falha] || 0) + 1;
    event(codigo, host);
    return { ok: false, falha };
  };

  // exatamente estes cabeçalhos — nada de Cookie, Authorization, Referer, Proxy-*
  const headersFor = (accept) => ({ 'user-agent': userAgent, accept, 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.5', 'accept-encoding': 'identity' });

  // UMA requisição ao transporte, com orçamento, cortesia por host e mapeamento dos erros. { response } ou { falha, codigo }.
  async function send(url, accept, maxBytes) {
    const parsed = parsePublicUrl(url);
    if (parsed === null) return { falha: FAILURE.ERRO, codigo: 'URL_INVALIDA' };
    if (stats.requisicoes >= limits.maxRequests) return { falha: FAILURE.ERRO, codigo: 'LIMITE_DE_REQUISICOES' };
    stats.requisicoes += 1;
    const host = bareHost(parsed);
    const previous = lastRequestAt.get(host);
    if (previous !== undefined) {
      const wait = limits.minIntervalMs - (now().getTime() - previous);
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, now().getTime());
    try {
      const response = await transport.request({ url: parsed.toString(), headers: headersFor(accept), timeoutMs: limits.timeoutMs, maxBytes });
      if (!response || !Number.isInteger(response.status) || !Buffer.isBuffer(response.body)) return { falha: FAILURE.ERRO, codigo: 'RESPOSTA_INVALIDA' };
      return { response, host };
    } catch (error) {
      const code = error instanceof TransportError ? error.code : 'INTERNO';
      if (code === 'TIMEOUT') return { falha: FAILURE.TEMPO_ESGOTADO, codigo: 'TIMEOUT', host };
      if (code === 'TOO_LARGE') return { falha: FAILURE.ERRO, codigo: 'RESPOSTA_GRANDE', host };
      if (code === 'SSRF') return { falha: FAILURE.BLOQUEADO, codigo: 'ENDERECO_NAO_PUBLICO', host };
      if (code === 'TLS') return { falha: FAILURE.ERRO, codigo: 'TLS', host };
      if (code === 'NETWORK') return { falha: FAILURE.FORA_DO_AR, codigo: 'ERRO_DE_REDE', host };
      return { falha: FAILURE.ERRO, codigo: code === 'INVALID_URL' ? 'URL_INVALIDA' : 'ERRO_INTERNO', host };
    }
  }

  // O robots.txt de uma origem (uma consulta por origem): { permite(caminho) } ou { naoVerificavel: true }.
  function robotsFor(origin, host) {
    if (!robotsByOrigin.has(origin)) {
      robotsByOrigin.set(origin, (async () => {
        stats.robotsConsultados += 1;
        let url = `${origin}/robots.txt`;
        for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
          const sent = await send(url, 'text/plain', limits.robotsMaxBytes);
          if (!sent.response) return { naoVerificavel: true };
          const { status, headers, body } = sent.response;
          if (status >= 300 && status < 400 && headers.location) {
            let next = null;
            try {
              next = new URL(headers.location, url);
            } catch {
              return { naoVerificavel: true };
            }
            if (next.origin !== origin || parsePublicUrl(next.toString()) === null) return { naoVerificavel: true };
            url = next.toString();
            continue;
          }
          if (status === 404 || status === 410) return { permite: () => true };
          if (status >= 200 && status < 300 && (!headers['content-encoding'] || /^identity$/i.test(headers['content-encoding']))) {
            const parsed = parseRobots(body.toString('utf8'));
            return { permite: (pathname) => isAllowed(parsed, product, pathname) };
          }
          return { naoVerificavel: true };
        }
        return { naoVerificavel: true };
      })());
    }
    return robotsByOrigin.get(origin).then((robots) => {
      if (robots.naoVerificavel) event('ROBOTS_NAO_VERIFICADO', host);
      return robots;
    });
  }

  // GET com robots, redirecionamentos e classificação. { ok: true, urlFinal, headers, body } ou { ok: false, falha }.
  async function get(rawUrl, accept) {
    let url = rawUrl;
    for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
      const parsed = typeof url === 'string' ? parsePublicUrl(url) : null;
      if (parsed === null) return failure(FAILURE.ERRO, 'URL_INVALIDA');
      const host = bareHost(parsed);
      if (isLoginWall(url)) return failure(FAILURE.LOGIN, hop === 0 ? 'URL_DE_LOGIN' : 'REDIRECT_TO_LOGIN', host);

      const robots = await robotsFor(parsed.origin, host);
      if (robots.naoVerificavel) return failure(FAILURE.ROBOTS, 'ROBOTS_NAO_VERIFICADO', host);
      if (!robots.permite(`${parsed.pathname}${parsed.search}`)) return failure(FAILURE.ROBOTS, 'ROBOTS_BLOQUEIA', host);

      const sent = await send(url, accept, limits.maxBytes);
      if (!sent.response) return failure(sent.falha, sent.codigo, host);
      const { status, headers } = sent.response;

      if (status >= 300 && status < 400) {
        if (!headers.location) return failure(FAILURE.ERRO, 'REDIRECT_SEM_DESTINO', host);
        let next;
        try {
          next = new URL(headers.location, url);
        } catch {
          return failure(FAILURE.ERRO, 'REDIRECT_INVALIDO', host);
        }
        const target = parsePublicUrl(next.toString());
        if (target === null) return failure(FAILURE.ERRO, 'REDIRECT_INVALIDO', host);
        if (isLoginWall(next.toString())) return failure(FAILURE.LOGIN, 'REDIRECT_TO_LOGIN', host);
        if (!allowCrossHostRedirects && bareHost(target) !== host) return failure(FAILURE.ERRO, 'REDIRECT_EXTERNO', host);
        stats.redirecionamentos += 1;
        url = target.toString();
        continue;
      }
      if (status === 401) return failure(FAILURE.LOGIN, 'HTTP_401', host);
      if (headers['cf-mitigated'] && /challenge/i.test(headers['cf-mitigated'])) return failure(FAILURE.CAPTCHA, 'DESAFIO', host);
      if (status === 403) return failure(FAILURE.BLOQUEADO, 'HTTP_403', host);
      if (status === 429) return failure(FAILURE.BLOQUEADO, 'HTTP_429', host);
      if (status === 404 || status === 410) return failure(FAILURE.REMOVIDA, `HTTP_${status}`, host);
      if (status >= 500) return failure(FAILURE.FORA_DO_AR, 'HTTP_5XX', host);
      if (status < 200 || status >= 300) return failure(FAILURE.ERRO, 'HTTP_INESPERADO', host);
      if (headers['content-encoding'] && !/^identity$/i.test(headers['content-encoding'])) return failure(FAILURE.ERRO, 'CODIFICACAO', host);
      return { ok: true, urlFinal: url, headers, body: sent.response.body, host };
    }
    return failure(FAILURE.ERRO, 'REDIRECTS_EXCESSIVOS', bareHost(parsePublicUrl(rawUrl) || new URL('https://x.invalid')));
  }

  function decode(headers, body) {
    const charset = /charset\s*=\s*"?([A-Za-z0-9_-]{1,40})/i.exec(headers['content-type'] || '');
    try {
      return new TextDecoder(charset ? charset[1] : 'utf-8').decode(body);
    } catch {
      return body.toString('utf8');
    }
  }

  async function fetchPage(url) {
    const got = await get(url, 'text/html,application/xhtml+xml;q=0.9');
    if (!got.ok) return got;
    if (!HTML_TYPE.test(got.headers['content-type'] || '')) return failure(FAILURE.ERRO, 'CONTEUDO_INVALIDO', got.host);
    const page = extractPage(decode(got.headers, got.body), got.urlFinal);
    if (page.desafioForte || (page.marcadorCaptcha && page.totalLinks <= 3)) return failure(FAILURE.CAPTCHA, 'DESAFIO_NA_PAGINA', got.host);
    if (page.temSenha && page.totalLinks <= 3) return failure(FAILURE.LOGIN, 'MURO_DE_LOGIN', got.host);
    if (page.linksTruncados > 0) event('LINKS_TRUNCADOS', got.host);
    return { ok: true, urlFinal: got.urlFinal, links: page.links, temFormularioContato: page.temFormularioContato };
  }

  async function getJson(url) {
    const got = await get(url, 'application/json');
    if (!got.ok) return got;
    if (!JSON_TYPE.test(got.headers['content-type'] || '')) return failure(FAILURE.ERRO, 'CONTEUDO_INVALIDO', got.host);
    try {
      return { ok: true, data: JSON.parse(got.body.toString('utf8')) };
    } catch {
      return failure(FAILURE.ERRO, 'CONTEUDO_INVALIDO', got.host);
    }
  }

  return Object.freeze({
    fetchPage,
    getJson,
    estatisticas: () => structuredClone({ ...stats, limites: limits }),
  });
}

module.exports = { createPublicWeb, DEFAULTS, BOUNDS };
