// robots.txt (RFC 9309, o subconjunto que importa) — função pura: interpreta o TEXTO de um robots.txt já obtido (sem rede aqui).
//
// parseRobots(texto) -> { grupos: [{ agentes: [...], regras: [{ permite, padrao }] }] }
// isAllowed(parsed, produto, caminho) -> boolean
//
// Regras: o grupo aplicável é o do `User-agent` que casa com o nosso produto (o mais específico, por substring do token); se nenhum casa,
// o `*`; se não há grupo, é permitido. Dentro do grupo vale a regra de padrão MAIS LONGO; empate = permitir. `*` casa qualquer sequência e
// `$` ancora o fim; um Disallow vazio não bloqueia nada. Limites: 10000 linhas e 500 caracteres por padrão (o resto é ignorado — um
// robots.txt gigante não vira uma negação de serviço).

const MAX_LINES = 10000;
const MAX_PATTERN = 500;

function parseRobots(text) {
  const groups = [];
  let current = null;
  let collectingAgents = false;
  const lines = String(text).split(/\r\n|\r|\n/).slice(0, MAX_LINES);
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!collectingAgents || current === null) {
        current = { agentes: [], regras: [] };
        groups.push(current);
      }
      current.agentes.push(value.toLowerCase());
      collectingAgents = true;
    } else if ((field === 'allow' || field === 'disallow') && current !== null) {
      collectingAgents = false;
      if (value.length <= MAX_PATTERN) current.regras.push({ permite: field === 'allow', padrao: value });
    } else {
      collectingAgents = false;
    }
  }
  return { grupos: groups };
}

// Casamento por curinga (*) SEM expressão regular: laço de dois ponteiros, tempo polinomial (nenhum retrocesso catastrófico, mesmo com um
// robots.txt hostil). `$` no fim ancora; sem ele, o padrão casa por prefixo.
function matches(pattern, pathname) {
  const anchored = pattern.endsWith('$');
  const glob = anchored ? pattern.slice(0, -1) : `${pattern}*`;
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < pathname.length) {
    if (p < glob.length && glob[p] === '*') {
      star = p;
      mark = s;
      p += 1;
    } else if (p < glob.length && glob[p] === pathname[s]) {
      p += 1;
      s += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      s = mark;
    } else return false;
  }
  while (p < glob.length && glob[p] === '*') p += 1;
  return p === glob.length;
}

function isAllowed(parsed, product, pathname) {
  const token = String(product).toLowerCase();
  const named = parsed.grupos.filter((g) => g.agentes.some((agent) => agent !== '*' && agent !== '' && token.includes(agent)));
  const group = named.length > 0 ? named.sort((a, b) => Math.max(...b.agentes.map((x) => x.length)) - Math.max(...a.agentes.map((x) => x.length)))[0] : parsed.grupos.find((g) => g.agentes.includes('*'));
  if (!group) return true;
  let best = null;
  for (const rule of group.regras) {
    if (rule.padrao === '') continue; // "Disallow:" vazio não bloqueia; "Allow:" vazio não diz nada
    if (!matches(rule.padrao, pathname)) continue;
    if (best === null || rule.padrao.length > best.padrao.length || (rule.padrao.length === best.padrao.length && rule.permite)) best = rule;
  }
  return best === null ? true : best.permite;
}

module.exports = { parseRobots, isAllowed, MAX_LINES, MAX_PATTERN };
