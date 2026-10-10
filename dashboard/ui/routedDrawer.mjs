// Gaveta COM URL: o ciclo de vida compartilhado de uma tela "lista + gaveta de detalhe" (Histórico de prospecções; a Approval Queue e Leads Reprovados têm
// uma cópia anterior desta lógica e podem migrar para cá quando for seguro). Aqui mora só o que é ORQUESTRAÇÃO, sem nenhum conteúdo de negócio:
//
//   - abrir pelo clique (o endereço muda: #/…/<id>) e pelo endereço (link direto, Voltar/Avançar: o endereço já mudou, nada é empilhado);
//   - fechar pela interface (X, ESC, fundo): volta UMA entrada do histórico se a gaveta foi aberta por clique; senão, TROCA a entrada (sem repetir);
//   - fechar por código (rota da lista, outro item, módulo que sai de cena) sem mexer no endereço;
//   - devolver o foco à linha que abriu (e a repintura da lista não o perde);
//   - nunca abrir duas vezes pelo mesmo item (cliques rápidos) nem empilhar entradas repetidas.
//
// A tela dona entrega: `build(id, hooks)` — abre a camada com overlays.openDrawer(...) usando hooks.onClose e hooks.getReturnFocus e devolve o handle —,
// `hashFor(id)` / `listHash` (os endereços), `rowButton(id)` (o alvo do foco na lista) e `repaint()` (redesenha a lista depois de fechar).
// Tudo aqui é testável com um DOM de teste; nada toca `window`: a navegação vem pelo adaptador { go, replace, back } do router.

export function createRoutedDrawer({ document, navigation = null, hashFor, listHash, build, rowButton = () => null, repaint = () => {}, onClosed = () => {} }) {
  const state = { selectedId: null, open: false, routeId: null, openedByPush: false };
  let handle = null;
  let suppressNav = false;

  const hooks = {
    getReturnFocus: () => (state.selectedId === null ? null : rowButton(state.selectedId)),
    onClose: () => closed(),
  };

  function closed() {
    const id = state.selectedId;
    state.open = false;
    state.selectedId = null;
    handle = null;
    onClosed(id);
    // fechar pela interface com endereço de item: volta ao da lista — Voltar do navegador, se o item foi aberto por clique; senão, troca a entrada
    if (!suppressNav && navigation && state.routeId !== null) {
      state.routeId = null;
      if (state.openedByPush) navigation.back();
      else navigation.replace(listHash);
      state.openedByPush = false;
    }
    // o foco já voltou à linha; repintar a lista a substitui — então devolve o foco à linha nova
    const focused = document.activeElement;
    const hadRowFocus = Boolean(id !== null && focused && typeof focused.getAttribute === 'function' && focused.getAttribute('data-item') === String(id));
    repaint();
    if (hadRowFocus) {
      const row = rowButton(id);
      if (row) row.focus();
    }
  }

  // Fecha por código: `silent` = não mexe no endereço.
  function close({ silent = false, reason = 'api' } = {}) {
    if (!handle) return;
    const previous = suppressNav;
    suppressNav = silent;
    const current = handle;
    current.close(reason, { force: true });
    suppressNav = previous;
  }

  // Abre a camada do item (sem mexer no endereço).
  function openOverlay(id) {
    if (state.open && handle) close({ silent: true, reason: 'switch' });
    state.selectedId = id;
    state.open = true;
    handle = build(id, hooks);
    if (!handle) {
      state.open = false;
      state.selectedId = null;
    }
    return handle;
  }

  return {
    state,
    hooks,
    isOpen: () => state.open,
    get handle() {
      return handle;
    },
    // clique na lista: abre e muda o endereço (o Voltar do navegador fecha a gaveta)
    open(id) {
      if (state.open && state.selectedId === id) return;
      if (!openOverlay(id)) return;
      if (navigation && state.routeId !== id) {
        state.openedByPush = true;
        state.routeId = id;
        navigation.go(hashFor(id));
      }
    },
    // o endereço pediu o item (link direto, Voltar/Avançar): abre sem empilhar nada
    openFromRoute(id) {
      state.routeId = id;
      if (state.open && state.selectedId === id) return true;
      return Boolean(openOverlay(id));
    },
    setRoute(id) {
      state.routeId = id;
    },
    // a rota da lista chegou: fecha a gaveta (se aberta) sem mexer no endereço
    listRoute() {
      state.routeId = null;
      state.openedByPush = false;
      if (state.open) close({ silent: true, reason: 'route' });
    },
    close,
    // o módulo saiu de cena: as camadas fecham sem navegar de volta (o endereço já mudou)
    leave(overlays) {
      state.routeId = null;
      state.openedByPush = false;
      const previous = suppressNav;
      suppressNav = true;
      overlays.closeAll();
      suppressNav = previous;
    },
    // o item aberto saiu da lista / foi decidido por outro caminho: fecha e volta ao endereço da lista
    dismiss(reason = 'gone') {
      close({ silent: false, reason });
    },
  };
}
