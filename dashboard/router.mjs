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
    default:
      return '#/';
  }
}

// A seção do menu a que uma rota pertence (o item que fica "ativo").
export function sectionOf(route) {
  const name = route && route.name;
  if (name === 'crm-list' || name === 'crm-new' || name === 'crm-record') return 'crm';
  if (name === 'approvals') return 'approvals';
  if (name === 'overview') return 'overview';
  return null;
}

// O adaptador do `window` do navegador: { current(), subscribe(fn), go(hash), replace(hash) }. É a única parte que toca
// no `window`; os testes usam um `window` falso com a mesma forma. `replace` troca a entrada do histórico (um redirecionamento
// não deve virar uma volta a ser desfeita com o botão "Voltar") e avisa quem assinou.
export function browserNavigation(win) {
  const listeners = new Set();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    current: () => win.location.hash,
    subscribe(listener) {
      if (listeners.size === 0) win.addEventListener('hashchange', notify);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) win.removeEventListener('hashchange', notify);
      };
    },
    go(hash) {
      win.location.hash = hash;
    },
    replace(hash) {
      win.history.replaceState(null, '', hash);
      notify();
    },
  };
}
