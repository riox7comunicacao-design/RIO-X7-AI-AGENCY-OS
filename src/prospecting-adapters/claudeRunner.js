// Executor ISOLADO de `claude -p` (o único lugar que sabe iniciar o processo filho do Claude Code). Compartilhado pelos motores de DESCOBERTA e de
// ENRIQUECIMENTO: cada um só monta o prompt e valida a saída; o isolamento é um só.
//
// ISOLAMENTO (o processo filho):
//   - SÓ as ferramentas WebSearch e WebFetch (`--tools` e `--allowedTools`): nenhum Bash, Read, Write, Edit, nenhuma ferramenta de arquivo,
//     nenhum MCP (`--strict-mcp-config` sem configuração), nenhuma skill (`--disable-slash-commands`);
//   - diretório de trabalho TEMPORÁRIO e vazio, criado só para esta chamada e removido no fim;
//   - ambiente MÍNIMO (lista fechada): nenhuma credencial do Supabase, do CRM, do projeto nem ANTHROPIC_API_KEY (nenhuma API paga: vale o login da
//     assinatura que já existe no computador);
//   - entrada pelo stdin (nada de texto livre na linha de comando), tempo limite, tamanho máximo de saída e cancelamento (AbortSignal).
//
//   run({ prompt, maxTurns, signal, timeoutMs, parse }) -> { ok: true, ...parse(result), custoUsd?, webSearchRequests?, turnos? } | { ok: false, code }
//   `parse(texto)` devolve um objeto (validado por quem chama) ou null (saída inválida).

const { spawn: nodeSpawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOOLS = 'WebSearch,WebFetch';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

// As ÚNICAS variáveis do ambiente que o processo filho recebe (o que o sistema operacional e o login do Claude Code precisam).
const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'USERNAME', 'USER', 'LOGNAME', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
]);

function childEnvironment(env) {
  const out = {};
  if (!env || typeof env !== 'object') return out;
  for (const name of ENV_ALLOWLIST) if (typeof env[name] === 'string') out[name] = env[name];
  return out;
}

const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function telemetryOf(output) {
  const out = {};
  if (typeof output.total_cost_usd === 'number' && Number.isFinite(output.total_cost_usd) && output.total_cost_usd >= 0) out.custoUsd = output.total_cost_usd;
  if (Number.isInteger(output.num_turns) && output.num_turns >= 0) out.turnos = output.num_turns;
  if (isPlainObject(output.modelUsage)) {
    let searches = 0;
    for (const usage of Object.values(output.modelUsage)) if (isPlainObject(usage) && Number.isInteger(usage.webSearchRequests)) searches += usage.webSearchRequests;
    out.webSearchRequests = searches;
  }
  return out;
}

// options:
//   env       o ambiente de onde sai a lista MÍNIMA para o filho (quem compõe passa process.env; aqui nada o lê)
//   command   o executável (padrão "claude")
//   spawn, platform, tmpRoot, prefix — injetáveis (os testes não usam o programa real)
function createClaudeRunner(options = {}) {
  const { env = {}, command = 'claude', spawn = nodeSpawn, platform = process.platform, tmpRoot = os.tmpdir(), maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, prefix = 'rio-x7-claude-' } = options;
  if (typeof command !== 'string' || command.trim() === '') throw new Error('createClaudeRunner: command deve ser um texto não vazio');
  if (typeof spawn !== 'function') throw new Error('createClaudeRunner: spawn deve ser uma função');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new Error('createClaudeRunner: maxOutputBytes inválido');

  function kill(child) {
    try {
      child.kill('SIGKILL');
    } catch {
      // o processo pode já ter terminado
    }
    // no Windows o programa roda atrás de um shell: encerrar a ÁRVORE inteira
    if (platform === 'win32' && Number.isInteger(child.pid)) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        // melhor esforço
      }
    }
  }

  async function run({ prompt, maxTurns, signal, timeoutMs = DEFAULT_TIMEOUT_MS, parse }) {
    if (signal && signal.aborted) return { ok: false, code: 'ABORTED' };
    const workDir = fs.mkdtempSync(path.join(tmpRoot, prefix));
    try {
      const args = ['-p', '--tools', TOOLS, '--allowedTools', TOOLS, '--no-session-persistence', '--output-format', 'json', '--max-turns', String(maxTurns), '--strict-mcp-config', '--disable-slash-commands'];
      return await new Promise((resolve) => {
        let child;
        let settled = false;
        let timer = null;
        const chunks = [];
        let size = 0;
        const onAbort = () => finish({ ok: false, code: 'ABORTED' }, true);
        function finish(result, killChild = false) {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          if (killChild && child) kill(child);
          resolve(result);
        }
        try {
          // shell só no Windows (o programa é um atalho .cmd); os argumentos são CONSTANTES e o texto do usuário vai pelo stdin
          // (com shell, uma linha de comando só — todos os argumentos são constantes sem espaço —, para o Node não avisar sobre args + shell)
          const useShell = platform === 'win32';
          child = useShell
            ? spawn([command, ...args].join(' '), [], { cwd: workDir, env: childEnvironment(env), shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
            : spawn(command, args, { cwd: workDir, env: childEnvironment(env), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        } catch {
          return finish({ ok: false, code: 'SPAWN_FAILED' });
        }
        timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT' }, true), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        child.on('error', () => finish({ ok: false, code: 'SPAWN_FAILED' }));
        child.stdout.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxOutputBytes) return finish({ ok: false, code: 'OUTPUT_TOO_LARGE' }, true);
          chunks.push(chunk);
          return undefined;
        });
        child.on('close', (code) => {
          if (settled) return;
          if (code !== 0) return finish({ ok: false, code: 'EXIT_NONZERO' });
          let output;
          try {
            output = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return finish({ ok: false, code: 'OUTPUT_INVALID' });
          }
          if (!isPlainObject(output)) return finish({ ok: false, code: 'OUTPUT_INVALID' });
          if (output.is_error === true) return finish({ ok: false, code: 'AGENT_ERROR' });
          const parsed = parse(output.result);
          if (parsed === null || parsed === undefined) return finish({ ok: false, code: 'OUTPUT_INVALID' });
          return finish({ ok: true, ...parsed, ...telemetryOf(output) });
        });
        try {
          child.stdin.on('error', () => {});
          child.stdin.end(prompt);
        } catch {
          finish({ ok: false, code: 'SPAWN_FAILED' }, true);
        }
        return undefined;
      });
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // melhor esforço: é um diretório temporário vazio
      }
    }
  }

  return Object.freeze({ run });
}

module.exports = { createClaudeRunner, childEnvironment, telemetryOf, TOOLS, ENV_ALLOWLIST, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES };
