// Atualização de dados depois de uma operação (UX 4.0): um BARRAMENTO simples e um ACOMPANHADOR de processos em segundo plano.
//
// POR QUE: antes, cada tela só sabia que algo mudou se a pessoa apertasse F5. Agora, quem muda um registro (aprovar, reprovar, reconsiderar,
// promover, salvar) PUBLICA um aviso (`publish('approvals:changed', {...})`) e quem mostra aquele dado (contador do menu, lista, outra
// tela montada) ASSINA e se atualiza — sem recarregar a página, sem perder filtro nem posição. O barramento NÃO move dado nenhum: só avisa.
// Um ouvinte que falha nunca derruba os outros nem quem publicou.
//
// O acompanhador (`createPoller`) usa os endpoints de status que JÁ existem: chama `tick()` de tempos em tempos SÓ enquanto `shouldContinue()`
// disser que há o que acompanhar, nunca duas chamadas ao mesmo tempo, pausa com a aba escondida, desiste depois de falhas seguidas e para
// na hora com `stop()`. Nada de consulta agressiva: o intervalo mínimo é 1 s.

const MIN_INTERVAL_MS = 1000;

const defaultSchedule = (fn, ms) => {
  const timer = globalThis.setTimeout(fn, ms);
  return () => globalThis.clearTimeout(timer);
};

export function createDataBus() {
  const topics = new Map();
  return {
    subscribe(topic, listener) {
      if (typeof listener !== 'function') throw new Error('dataBus: o ouvinte deve ser uma função');
      if (!topics.has(topic)) topics.set(topic, new Set());
      topics.get(topic).add(listener);
      return () => {
        const set = topics.get(topic);
        if (set) set.delete(listener);
      };
    },
    publish(topic, payload) {
      for (const listener of [...(topics.get(topic) || [])]) {
        try {
          listener(payload);
        } catch {
          // um ouvinte com defeito não impede os demais nem quem publicou
        }
      }
    },
    listenerCount: (topic) => (topics.get(topic) ? topics.get(topic).size : 0),
  };
}

// tick(): async () => resultado. shouldContinue(resultado): continua? (false -> para). onGiveUp(): depois de maxFailures falhas seguidas.
// isHidden(): a aba está escondida? (pausa sem chamar o servidor). schedule(fn, ms) -> cancelar().
export function createPoller({ tick, shouldContinue, intervalMs = 2000, maxFailures = 4, onGiveUp = () => {}, isHidden = () => false, schedule = defaultSchedule }) {
  if (typeof tick !== 'function' || typeof shouldContinue !== 'function') throw new Error('poller: tick e shouldContinue são obrigatórios');
  const interval = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || MIN_INTERVAL_MS);
  let cancel = null;
  let running = false;
  let inFlight = false;
  let failures = 0;

  function plan() {
    if (!running) return;
    cancel = schedule(run, interval);
  }

  async function run() {
    cancel = null;
    if (!running) return;
    if (isHidden()) {
      plan();
      return;
    }
    if (inFlight) return;
    inFlight = true;
    let result;
    try {
      result = await tick();
      failures = 0;
    } catch {
      failures += 1;
      inFlight = false;
      if (failures >= maxFailures) {
        running = false;
        onGiveUp();
        return;
      }
      plan();
      return;
    }
    inFlight = false;
    if (!running) return;
    if (shouldContinue(result)) plan();
    else running = false;
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      plan();
    },
    stop() {
      running = false;
      if (cancel) cancel();
      cancel = null;
    },
    get running() {
      return running;
    },
  };
}
