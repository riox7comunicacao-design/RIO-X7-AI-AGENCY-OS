// Arquivos estáticos do Dashboard (dashboard/) — só leitura, só o que é da interface.
//
// Este módulo NÃO conhece autenticação, USER, Service nem domínio: ele só entrega arquivos. Três tipos de
// recurso, e nada além disso:
//   1. os arquivos de `root` (a pasta dashboard/), por um caminho estritamente validado;
//   2. `files`: um mapa EXATO caminho-da-URL -> arquivo (hoje, só o bundle do supabase-js para o navegador,
//      que já está instalado como dependência — nenhum CDN);
//   3. `/config.json`: os valores PÚBLICOS que o cliente Supabase do navegador precisa (URL do projeto e chave
//      anon). Vem de um objeto já montado por quem compõe o servidor: este módulo nunca lê o ambiente.
//
// SEGURANÇA DO CAMINHO. O caminho da URL é tratado como hostil:
//   - cada segmento, depois de decodificado, só pode ter letras, números, ponto, hífen e sublinhado — nada de
//     "..", barra, barra invertida, NUL, ":" (fluxos alternativos do NTFS), espaço, nem segmento que comece por
//     ponto (arquivos e pastas ocultos); nomes reservados do Windows (CON, NUL, COM1...) também são recusados;
//   - só extensões conhecidas são servidas (html, mjs, js, css); o resto é 404 sem tocar no disco;
//   - o caminho resolvido precisa continuar dentro de `root`, e o caminho REAL (depois de seguir links
//     simbólicos) também — um link que aponte para fora não vira uma porta de saída;
//   - só arquivos comuns são servidos (nunca diretório nem dispositivo).
// Tudo o que falha vira o mesmo 404, sem dizer por quê.

const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
});

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const NOT_FOUND = Object.freeze({
  status: 404,
  headers: Object.freeze({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }),
  body: 'Não encontrado.',
});

function notFound() {
  return { status: NOT_FOUND.status, headers: { ...NOT_FOUND.headers }, body: NOT_FOUND.body };
}

// Devolve os segmentos seguros do caminho da URL, ou null se qualquer coisa nele for suspeita.
function safeSegments(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/')) return null;
  const segments = decoded.split('/').slice(1);
  // "/" vira "index.html"; uma barra final ("/views/") não é um arquivo.
  if (segments.length === 1 && segments[0] === '') return ['index.html'];
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment)) return null;
    if (segment.startsWith('.')) return null;
    if (WINDOWS_RESERVED.test(segment.split('.')[0])) return null;
  }
  return segments;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function fileResponse(contentType, body, cacheControl = 'no-cache') {
  return { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': cacheControl }, body };
}

// root: a pasta dos arquivos da interface. files: { '/caminho/exato': '/arquivo/no/disco' }.
// config: o objeto público servido em /config.json (ou null para não servir).
function createStaticHandler({ root, files = {}, config = null }) {
  if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) {
    throw new Error('createStaticHandler exige { root } (caminho absoluto da pasta de arquivos estáticos)');
  }
  const exactFiles = new Map(Object.entries(files));
  const configBody = config === null ? null : JSON.stringify(config);

  // pathname: o caminho da URL, ainda codificado (como veio na requisição, sem a query).
  async function serve(pathname) {
    if (pathname === '/config.json' && configBody !== null) {
      return fileResponse('application/json; charset=utf-8', configBody, 'no-store');
    }

    if (exactFiles.has(pathname)) {
      try {
        const extension = path.extname(exactFiles.get(pathname)).toLowerCase();
        const contentType = MIME_TYPES[extension];
        if (!contentType) return notFound();
        return fileResponse(contentType, await fs.promises.readFile(exactFiles.get(pathname)));
      } catch {
        return notFound();
      }
    }

    const segments = safeSegments(pathname);
    if (segments === null) return notFound();
    const contentType = MIME_TYPES[path.extname(segments[segments.length - 1]).toLowerCase()];
    if (!contentType) return notFound();

    const target = path.join(root, ...segments);
    if (!isInside(root, target)) return notFound();
    try {
      const [realRoot, realTarget] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(target)]);
      if (!isInside(realRoot, realTarget)) return notFound();
      const stats = await fs.promises.stat(realTarget);
      if (!stats.isFile()) return notFound();
      return fileResponse(contentType, await fs.promises.readFile(realTarget));
    } catch {
      return notFound();
    }
  }

  return { serve };
}

module.exports = { createStaticHandler };
