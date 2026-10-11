// As rotas do Dashboard — só funções puras (e um adaptador fino para o `window` do navegador).
//
// O Dashboard é uma página só, servida como arquivo estático: a rota vive no FRAGMENTO da URL (#/crm), que o navegador
// nunca envia ao servidor. Assim nenhuma rota nova é preciso no servidor, a proteção é a mesma de sempre (sem sessão,
// qualquer fragmento leva ao login) e o botão "Voltar" do navegador funciona.
//
//   #/                        Visão Geral
//   #/crm                     lista do CRM
//   #/crm/novo                formulário de novo registro
//   #/crm/registro/<id>       ficha de um registro (o id vai codificado: crm%3A...)
//   #/aprovacoes              a fila de aprovação
//   #/aprovacoes/<id>         a fila com a GAVETA do lead aberta (UX 4.0; o id vai codificado). Abrir por link direto funciona e o Voltar do navegador fecha a gaveta
//   #/agentes                 a Central de Agentes IA (só a estrutura visual)
//   #/funis                   o Kanban de Funis (reestruturação Prospecção/CRM/Funis, Etapa "Funis 2")
//   #/prospeccao              o Workbench de Prospecção (Etapa "Prospecção 1") — "Nova Prospecção"
//   #/prospeccao/historico    o histórico das prospecções automáticas (Implementação 3.0)
//   #/prospeccao/leads-reprovados   os leads reprovados e a reaprovação (Implementação 3.0)
//
// Um fragmento que não é nenhum destes é "not-found" (uma tela amigável), nunca um erro.

const CRM_RECORD_SEGMENT = 'registro';

export function parseRoute(hash) {
  const raw = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  const segments = raw.split('/').filter((segment, index) => !(index === 0 && segment === ''));
  while (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();

  if (segments.length === 0) return { name: 'overview' };
  if (segments.length === 1 && segments[0] === 'crm') return { name: 'crm-list' };
  if (segments.length === 2 && segments[0] === 'crm' && segments[1] === 'novo') return { name: 'crm-new' };
  if (segments.length === 3 && segments[0] === 'crm' && segments[1] === CRM_RECORD_SEGMENT && segments[2] !== '') {
    try {
      const id = decodeURIComponent(segments[2]);
      if (id.trim() !== '') return { name: 'crm-record', id };
    } catch {
      // um "%" solto: cai em not-found, como qualquer rota que não existe.
    }
    return { name: 'not-found' };
  }
  if (segments.length === 1 && segments[0] === 'aprovacoes') return { name: 'approvals' };
  if (segments.length === 2 && segments[0] === 'aprovacoes' && segments[1] !== '') {
    try {
      const id = decodeURIComponent(segments[1]);
      if (id.trim() !== '') return { name: 'approval-lead', id };
    } catch {
      // um "%" solto: not-found, como qualquer rota que não existe.
    }
    return { name: 'not-found' };
  }
  if (segments.length === 1 && segments[0] === 'agentes') return { name: 'agents' };
  if (segments.length === 1 && segments[0] === 'funis') return { name: 'funnels' };
  if (segments.length === 1 && segments[0] === 'prospeccao') return { name: 'prospecting' };
  if (segments.length === 3 && segments[0] === 'prospeccao' && segments[1] === 'briefing' && segments[2] !== '') {
    try {
      const id = decodeURIComponent(segments[2]);
      if (id.trim() !== '') return { name: 'prospecting-brief', id };
    } catch {
      // um '%' solto: not-found, como qualquer rota que não existe.
    }
    return { name: 'not-found' };
  }
  if (segments.length === 3 && segments[0] === 'prospeccao' && segments[1] === 'execucao' && segments[2] !== '') {
    try {
      const id = decodeURIComponent(segments[2]);
      if (id.trim() !== '') return { name: 'prospecting-run', id };
    } catch {
      // um '%' solto: not-found, como qualquer rota que não existe.
    }
    return { name: 'not-found' };
  }
  if (segments.length === 2 && segments[0] === 'prospeccao' && segments[1] === 'historico') return { name: 'prospecting-history' };
  if (segments.length === 3 && segments[0] === 'prospeccao' && segments[1] === 'historico' && segments[2] !== '') {
    try {
      const id = decodeURIComponent(segments[2]);
      if (id.trim() !== '') return { name: 'prospecting-job', id };
    } catch {
      // um '%' solto: not-found, como qualquer rota que não existe.
    }
    return { name: 'not-found' };
  }
  if (segments.length === 2 && segments[0] === 'prospeccao' && segments[1] === 'leads-reprovados') return { name: 'rejected-leads' };
  if (segments.length === 3 && segments[0] === 'prospeccao' && segments[1] === 'leads-reprovados' && segments[2] !== '') {
    try {
      const id = decodeURIComponent(segments[2]);
      if (id.trim() !== '') return { name: 'rejected-lead', id };
    } catch {
      // um '%' solto: not-found, como qualquer rota que não existe.
    }
    return { name: 'not-found' };
  }
  if (segments.length === 1 && segments[0] === 'exclusoes-permanentes') return { name: 'prospecting-exclusions' };
  return { name: 'not-found' };
}

export function buildHash(route) {
  switch (route && route.name) {
    case 'overview':
      return '#/';
    case 'crm-list':
      return '#/crm';
    case 'crm-new':
      return '#/crm/novo';
    case 'crm-record':
      return `#/crm/${CRM_RECORD_SEGMENT}/${encodeURIComponent(route.id)}`;
    case 'approvals':
      return '#/aprovacoes';
    case 'approval-lead':
      return `#/aprovacoes/${encodeURIComponent(route.id)}`;
    case 'agents':
      return '#/agentes';
    case 'funnels':
      return '#/funis';
    case 'prospecting':
      return '#/prospeccao';
    case 'prospecting-brief':
      return `#/prospeccao/briefing/${encodeURIComponent(route.id)}`;
    case 'prospecting-run':
      return `#/prospeccao/execucao/${encodeURIComponent(route.id)}`;
    case 'prospecting-history':
      return '#/prospeccao/historico';
    case 'prospecting-job':
      return `#/prospeccao/historico/${encodeURIComponent(route.id)}`;
    case 'rejected-leads':
      return '#/prospeccao/leads-reprovados';
    case 'rejected-lead':
      return `#/prospeccao/leads-reprovados/${encodeURIComponent(route.id)}`;
    case 'prospecting-exclusions':
      return '#/exclusoes-permanentes';
    default:
      return '#/';
  }
}

// A seção do menu a que uma rota pertence (o item que fica "ativo").
export function sectionOf(route) {
  const name = route && route.name;
  if (name === 'crm-list' || name === 'crm-new' || name === 'crm-record') return 'crm';
  if (name === 'approvals' || name === 'approval-lead') return 'approvals';
  if (name === 'agents') return 'agents';
  if (name === 'funnels') return 'funnels';
  if (name === 'prospecting' || name === 'prospecting-run' || name === 'prospecting-brief') return 'prospecting';
  if (name === 'prospecting-history' || name === 'prospecting-job') return 'prospecting-history';
  if (name === 'rejected-leads' || name === 'rejected-lead') return 'rejected-leads';
  if (name === 'prospecting-exclusions') return 'prospecting-exclusions';
  if (name === 'overview') return 'overview';
  return null;
}

// O adaptador do `window` do navegador: { current(), subscribe(fn), go(hash), back(), replace(hash), restore(hash), setLeaveGuard(fn) }. É a única parte que toca
// no `window`; os testes usam um `window` falso com a mesma forma. `replace` troca a entrada do histórico (um redirecionamento
// não deve virar uma volta a ser desfeita com o botão "Voltar") e avisa quem assinou.
//
// DESFAZER UMA NAVEGAÇÃO (restore): o navegador não deixa cancelar o "Voltar"/"Avançar"/clique num link — o endereço já mudou quando o aviso chega. Quando uma tela precisa
// ficar onde estava (há uma edição não salva e a pessoa escolheu "Continuar editando"), `restore(hash)` leva o endereço de volta SEM criar entradas novas:
//   - se a entrada vizinha do histórico é a que se quer (o caso comum: o "Voltar" de uma ficha aberta por clique), anda uma entrada com history.go(±1);
//   - senão, troca a entrada atual (replaceState) — nunca empilha.
// Para saber quem é vizinho, o adaptador numera as entradas em history.state ({ rxIdx }) e guarda o endereço de cada uma enquanto a página vive; a numeração sobrevive a recarregar a
// página (o history.state fica na entrada). Uma entrada que o navegador criou sozinho (clique num <a href="#...">) nasce sem número e é numerada ao chegar.
export function browserNavigation(win) {
  const listeners = new Set();
  const hashes = new Map(); // rxIdx -> endereço
  let index = null; // o número da entrada atual
  const stamp = (n, hash) => {
    hashes.set(n, hash);
    win.history.replaceState({ rxIdx: n }, '', hash);
  };
  // numera a entrada atual na primeira vez que o adaptador é usado
  const ensureInit = () => {
    if (index !== null) return;
    const state = win.history.state;
    const hash = win.location.hash;
    if (state && Number.isInteger(state.rxIdx)) {
      index = state.rxIdx;
      hashes.set(index, hash);
    } else {
      index = 0;
      stamp(0, hash);
    }
  };
  // Um hashchange chegou: descobre se a pessoa andou no histórico (entrada já numerada) ou se o navegador criou uma entrada nova.
  const sync = () => {
    ensureInit();
    const state = win.history.state;
    const hash = win.location.hash;
    if (state && Number.isInteger(state.rxIdx)) {
      index = state.rxIdx;
      hashes.set(index, hash);
    } else {
      index += 1;
      for (const key of [...hashes.keys()]) if (key >= index) hashes.delete(key); // uma entrada nova descarta o "avançar"
      stamp(index, hash);
    }
  };
  const notify = () => {
    sync();
    for (const listener of [...listeners]) listener();
  };
  // PROTEÇÃO CONTRA PERDA ao atualizar ou fechar a aba: com um guarda que responde "há alteração não salva", o evento `beforeunload` pede ao navegador o aviso nativo. Sem
  // alteração o guarda não faz nada (a navegação normal nunca é bloqueada). Se o aviso aparece ou não, e com que texto, é decisão do navegador: ele pode até ignorar o pedido.
  // Várias telas podem ter o seu guarda ao mesmo tempo (CRM e Nova Prospecção): basta UM responder true.
  const guards = new Set();
  const onBeforeUnload = (event) => {
    let dirty = false;
    for (const guard of [...guards]) if (guard() === true) dirty = true;
    if (!dirty) return undefined;
    event.preventDefault();
    event.returnValue = '';
    return '';
  };
  return {
    // fn() -> true quando há alteração não salva; devolve a função que remove SÓ o seu guarda
    setLeaveGuard(fn) {
      if (typeof fn !== 'function') return () => {};
      if (guards.size === 0) win.addEventListener('beforeunload', onBeforeUnload);
      guards.add(fn);
      return () => {
        if (!guards.delete(fn)) return;
        if (guards.size === 0) win.removeEventListener('beforeunload', onBeforeUnload);
      };
    },
    current: () => win.location.hash,
    subscribe(listener) {
      ensureInit();
      if (listeners.size === 0) win.addEventListener('hashchange', notify);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) win.removeEventListener('hashchange', notify);
      };
    },
    go(hash) {
      ensureInit();
      if (win.location.hash === hash) return;
      win.location.hash = hash; // uma entrada nova (o hashchange chega depois)
      index += 1;
      for (const key of [...hashes.keys()]) if (key >= index) hashes.delete(key);
      stamp(index, win.location.hash);
    },
    // voltar uma entrada do histórico (o hashchange chega depois): fechar uma gaveta aberta por clique volta à lista sem deixar entradas repetidas
    back() {
      win.history.back();
    },
    replace(hash) {
      ensureInit();
      stamp(index, hash);
      notify();
    },
    // leva o endereço de volta a `hash` sem empilhar nada (ver o cabeçalho). Se já está lá, não faz nada.
    restore(hash) {
      ensureInit();
      if (win.location.hash === hash) return;
      if (hashes.get(index + 1) === hash) win.history.go(1);
      else if (index > 0 && hashes.get(index - 1) === hash) win.history.go(-1);
      else {
        stamp(index, hash);
        notify();
      }
    },
  };
}
