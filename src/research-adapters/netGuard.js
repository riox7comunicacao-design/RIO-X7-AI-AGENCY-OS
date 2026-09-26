// Guarda de REDE do adaptador de pesquisa (decisão 0022): só se conecta a endereços PÚBLICOS.
//
// O esquema do rawFinding já recusa IPs literais e hosts locais na URL; mas um NOME público pode RESOLVER para um endereço interno (SSRF,
// DNS rebinding). Por isso a resolução é feita AQUI, pelo `lookup` que o cliente https usa para CONECTAR (o mesmo endereço que foi
// validado é o que recebe a conexão): se qualquer endereço resolvido não for público, a conexão é recusada (ESSRF).
//
// Funções sem estado; o `dns` é injetável nos testes.

const net = require('node:net');
const dnsModule = require('node:dns');

function ipv4Parts(ip) {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function isPublicIPv4(ip) {
  const p = ipv4Parts(ip);
  if (p === null) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return false; // este host, privada, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local (inclui metadata de nuvem)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast e reservado
  return true;
}

// Expande um IPv6 para 8 grupos de 16 bits (ou null).
function expandIPv6(ip) {
  let text = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = ipv4Parts(dotted[1]);
    if (v4 === null) return null;
    text = `${text.slice(0, -dotted[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isPublicIPv6(ip) {
  const g = expandIPv6(ip);
  if (g === null) return false;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicIPv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return false; // ::a.b.c.d compatível (obsoleto)
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 (ULA)
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 (link-local)
  if ((g[0] & 0xff00) === 0xff00) return false; // ff00::/8 (multicast)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentação
  if (g[0] === 0x0064 && g[1] === 0xff9b) return false; // NAT64
  if (g[0] === 0x2002) return false; // 6to4
  return true;
}

function isPublicAddress(ip) {
  if (typeof ip !== 'string') return false;
  const family = net.isIP(ip);
  if (family === 4) return isPublicIPv4(ip);
  if (family === 6) return isPublicIPv6(ip);
  return false;
}

// O `lookup` do cliente https: resolve TODOS os endereços e só entrega se TODOS forem públicos.
function createGuardedLookup({ dns = dnsModule } = {}) {
  return function guardedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options || {};
    dns.lookup(hostname, { ...opts, all: true, verbatim: true }, (error, addresses) => {
      if (error) return cb(error);
      if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every((entry) => entry && isPublicAddress(entry.address))) {
        const blocked = new Error('endereço não público');
        blocked.code = 'ESSRF';
        return cb(blocked);
      }
      return opts.all ? cb(null, addresses) : cb(null, addresses[0].address, addresses[0].family);
    });
  };
}

module.exports = { isPublicAddress, createGuardedLookup };
