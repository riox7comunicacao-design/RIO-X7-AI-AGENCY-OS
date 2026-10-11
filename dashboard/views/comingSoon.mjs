// A página de uma área FUTURA do CRM (Dashboard Comercial, Metas e Indicadores, Configurações do CRM e seus cadastros).
//
// Diz com clareza que a área ainda NÃO EXISTE: EM DESENVOLVIMENTO. Não mostra número, gráfico, tabela, formulário nem botão de ação — nenhum dado simulado, nenhuma operação
// que não existe. Só explica o que a área vai ser e leva para o que já funciona (Clientes e Funis de Vendas).
//
// Não recebe `api`: não tem o que buscar. Todo texto entra por dom.mjs (textContent).

import { h, fill } from '../dom.mjs';
import { buildHash } from '../router.mjs';
import { FUTURE_PAGES, TERMS } from '../i18n/pt-BR.mjs';

export function createComingSoonView({ document, root, pageName, canReadCrm = true }) {
  const page = Object.prototype.hasOwnProperty.call(FUTURE_PAGES, pageName) ? FUTURE_PAGES[pageName] : null;
  const el = (tag, props, ...children) => h(document, tag, props, ...children);

  function render() {
    if (!page) {
      fill(root, el('p', { className: 'message error', role: 'alert', text: 'Esta página não existe.' }));
      return;
    }
    fill(
      root,
      el(
        'section',
        { className: 'coming-soon', id: 'coming-soon', 'aria-labelledby': 'coming-soon-title' },
        el('header', { className: 'page-title-row' }, el('div', { className: 'page-title-block' }, el('h2', { id: 'coming-soon-title', text: page.title }), el('p', { className: 'muted page-subtitle', text: page.summary }))),
        el(
          'div',
          { className: 'empty-state coming-soon-card', role: 'status' },
          el('strong', { className: 'empty-title coming-soon-flag', text: TERMS.comingSoon }),
          el('p', { className: 'empty-text', text: 'Esta área ainda não foi construída. Nada aqui é real: não há dados, números nem ações de demonstração.' }),
          page.plans.length > 0
            ? el('div', { className: 'coming-soon-plans' }, el('p', { className: 'muted', text: 'O que está previsto:' }), el('ul', { className: 'plain' }, ...page.plans.map((plan) => el('li', { text: plan }))))
            : null,
          canReadCrm
            ? el(
                'div',
                { className: 'actions' },
                el('a', { className: 'btn primary', href: buildHash({ name: 'crm-clients' }), text: 'Ir para Clientes' }),
                el('a', { className: 'btn secondary', href: buildHash({ name: 'funnels' }), text: 'Ver os Funis de Vendas' })
              )
            : null
        )
      )
    );
  }

  return {
    render,
    destroy() {
      fill(root);
    },
  };
}
