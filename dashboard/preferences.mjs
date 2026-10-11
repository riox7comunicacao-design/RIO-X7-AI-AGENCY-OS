// As PREFERÊNCIAS VISUAIS do Dashboard guardadas no navegador — hoje, uma só: o menu lateral está recolhido ou expandido.
//
// ESTA É A ÚNICA EXCEÇÃO À REGRA "o Dashboard não guarda nada no navegador" (tests/server/dashboard-static-guards.test.js, [DASH-GUARD-3]), autorizada pelo proprietário na
// Fase 2A do CRM 5.0 e vigiada por testes: este é o ÚNICO arquivo que pode conter a palavra localStorage, e ele só lê e grava UMA chave, com UM entre dois valores ('1' ou '0').
//
// O QUE NUNCA ENTRA AQUI: usuário, e-mail, role, permissões, token, registro, cliente, filtro, busca, rascunho ou qualquer dado comercial. É só "o menu está recolhido?".
//
// ARMAZENAMENTO INDISPONÍVEL (navegação privada, site bloqueado, cota cheia, localStorage que lança erro até ao ser acessado): nada quebra. A preferência vale só enquanto a
// página está aberta (fica na memória) e o menu continua funcionando.
//
// Quem usa recebe o objeto por parâmetro (app.mjs cria com o `globalThis`; os testes passam um armazenamento falso).

export const SIDEBAR_COLLAPSED_KEY = 'riox7.sidebar.collapsed';

// globalObject: onde procurar o armazenamento (o `window`); só é lido DENTRO de try/catch, porque até acessar `localStorage` pode lançar erro.
export function createVisualPreferences(globalObject) {
  let remembered = false; // o valor desta página, mesmo sem armazenamento

  function storage() {
    try {
      const candidate = globalObject ? globalObject.localStorage : null;
      return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function' ? candidate : null;
    } catch {
      return null;
    }
  }

  return {
    getSidebarCollapsed() {
      try {
        const store = storage();
        if (!store) return remembered;
        const value = store.getItem(SIDEBAR_COLLAPSED_KEY);
        if (value === '1') return true;
        if (value === '0') return false;
        return remembered; // ausente ou qualquer outra coisa: ignora (nunca interpreta um valor estranho)
      } catch {
        return remembered;
      }
    },
    setSidebarCollapsed(collapsed) {
      remembered = Boolean(collapsed);
      try {
        const store = storage();
        if (store) store.setItem(SIDEBAR_COLLAPSED_KEY, remembered ? '1' : '0');
      } catch {
        // cota cheia ou bloqueado: a preferência vale só nesta página
      }
    },
  };
}
