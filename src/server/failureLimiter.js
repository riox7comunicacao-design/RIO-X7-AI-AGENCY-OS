// O LIMITADOR DE FALHAS DE AUTENTICAÇÃO (Fase WEB 1): conta, por cliente, as requisições à API recusadas por sessão ausente ou inválida e, passado o limite dentro da janela, bloqueia o
// cliente por um tempo (HTTP 429 com Retry-After). Só EM MEMÓRIA, de propósito: nenhum arquivo, nenhuma tabela, nenhum estado a recuperar — um reinício zera os contadores, o que é aceitável
// para uma defesa de borda (o limite principal das tentativas de SENHA é o do Supabase Auth, que recebe o login direto do navegador).
//
// Só falhas contam; um acerto não zera ninguém (senão o tráfego legítimo de um proxy compartilhado apagaria a contagem de quem insiste em falhar). O mapa é limitado (`maxKeys`):
// ao encher, descarta primeiro as chaves já expiradas e, se ainda for preciso, as mais antigas — a memória nunca cresce sem teto.
//
//   check(key) -> { blocked: false } | { blocked: true, retryAfterSeconds }
//   fail(key)  -> registra uma falha (e passa a bloquear ao atingir `maxFailures` dentro de `windowMs`)

function createFailureLimiter({ maxFailures, windowMs, blockMs, maxKeys = 5000, now = () => Date.now() }) {
  for (const [name, value] of Object.entries({ maxFailures, windowMs, blockMs, maxKeys })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`createFailureLimiter: ${name} deve ser um inteiro positivo`);
  }
  if (typeof now !== 'function') throw new Error('createFailureLimiter: now deve ser uma função');
  // key -> { failures: number[] (instantes), blockedUntil: number }
  const entries = new Map();

  function prune(instant) {
    for (const [key, entry] of entries) {
      const recent = entry.failures.filter((at) => instant - at < windowMs);
      if (recent.length === 0 && entry.blockedUntil <= instant) entries.delete(key);
      else entry.failures = recent;
    }
    // ainda cheio: o Map guarda a ordem de inserção, então as primeiras chaves são as mais antigas
    while (entries.size >= maxKeys) entries.delete(entries.keys().next().value);
  }

  function check(key) {
    const entry = entries.get(key);
    if (!entry) return { blocked: false };
    const instant = now();
    if (entry.blockedUntil > instant) return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.blockedUntil - instant) / 1000)) };
    return { blocked: false };
  }

  function fail(key) {
    const instant = now();
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxKeys) prune(instant);
      entry = { failures: [], blockedUntil: 0 };
      entries.set(key, entry);
    }
    entry.failures = entry.failures.filter((at) => instant - at < windowMs);
    entry.failures.push(instant);
    if (entry.failures.length >= maxFailures) {
      entry.blockedUntil = instant + blockMs;
      entry.failures = [];
    }
  }

  return { check, fail, size: () => entries.size };
}

module.exports = { createFailureLimiter };
