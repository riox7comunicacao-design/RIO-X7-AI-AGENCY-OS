// A página CONFIGURAÇÕES DO CRM (CRM 5.0, Fase 2B-2, refinamento): a porta de entrada dos cadastros que organizam o CRM — #/crm/configuracoes.
//
// O QUE ELA É: um índice. Cada cartão leva à rota REAL de um cadastro (Serviços, Nichos e Cores, Origens dos Leads); a Gestão de Funis e Etapas (Fase D1) também é uma tela real. Uma entrada sem rota aparece como um cartão
// desabilitado, marcado EM DESENVOLVIMENTO (sem link). O QUE ELA NÃO É: nenhuma informação simulada — nada de contagens, gráficos ou exemplos — e nenhuma chamada de API: não há nada a buscar.
//
// PERMISSÕES (só para MOSTRAR; o servidor decide de verdade em cada tela): os três cadastros exigem MANAGE:CRM_CATALOGS (`canManageCrmCatalogs`) e a Gestão de Funis e Etapas exige
// MANAGE:FUNNELS (`canManageFunnels`). Um cartão que a conta não pode usar NÃO aparece (nem como link, nem como aviso).
// Todo texto entra por dom.mjs (textContent); nenhum estilo inline.

import { h, fill } from '../dom.mjs';
import { buildHash } from '../router.mjs';
import { NAV_LABELS, TERMS } from '../i18n/pt-BR.mjs';
import { pageHeader } from '../ui/components.mjs';

// Os acessos da página, na ordem em que aparecem. `route`: a rota REAL (ausente = ainda não existe). `needs`: a permissão de `permissionsOf`.
export const SETTINGS_ENTRIES = Object.freeze([
  Object.freeze({ id: 'servicos', title: NAV_LABELS.crmServices, text: 'O catálogo de serviços que a agência oferece, com o preço de referência de cada um.', route: Object.freeze({ name: 'crm-settings-services' }), needs: 'canManageCrmCatalogs' }),
  Object.freeze({ id: 'nichos', title: NAV_LABELS.crmNiches, text: 'Os nichos de atuação dos clientes e a cor que identifica cada um.', route: Object.freeze({ name: 'crm-settings-niches' }), needs: 'canManageCrmCatalogs' }),
  Object.freeze({ id: 'origens', title: NAV_LABELS.crmOrigins, text: 'De onde os leads chegam: prospecção ativa, anúncio, indicação e outros canais.', route: Object.freeze({ name: 'crm-settings-origins' }), needs: 'canManageCrmCatalogs' }),
  Object.freeze({ id: 'funis', title: NAV_LABELS.crmFunnelAdmin, text: 'A administração dos funis de vendas e das etapas de cada um.', route: Object.freeze({ name: 'crm-settings-funnels' }), needs: 'canManageFunnels' }),
]);

// Os acessos que ESTA conta pode ver (só o booleano verdadeiro vale).
export function visibleSettingsEntries(permissions) {
  return SETTINGS_ENTRIES.filter((entry) => Boolean(permissions) && permissions[entry.needs] === true);
}

export function createCrmSettingsView({ document, root, permissions }) {
  const el = (tag, props, ...children) => h(document, tag, props, ...children);

  function card(entry) {
    if (entry.route) {
      return el(
        'a',
        { className: 'settings-card', href: buildHash(entry.route), 'data-entry': entry.id },
        el('span', { className: 'settings-card-title', text: entry.title }),
        el('span', { className: 'settings-card-text muted', text: entry.text }),
        el('span', { className: 'settings-card-go', 'aria-hidden': 'true', text: 'Abrir →' })
      );
    }
    // ainda não existe: um cartão desabilitado, sem link, que diz com clareza que está EM DESENVOLVIMENTO
    return el(
      'div',
      { className: 'settings-card is-soon', 'aria-disabled': 'true', 'data-entry': entry.id },
      el('span', { className: 'settings-card-title', text: entry.title }),
      el('span', { className: 'settings-card-text muted', text: entry.text }),
      el('span', { className: 'badge neutral settings-card-soon', text: TERMS.comingSoon })
    );
  }

  function render() {
    const entries = visibleSettingsEntries(permissions);
    fill(
      root,
      el(
        'section',
        { className: 'settings-page', id: 'crm-settings', 'aria-labelledby': 'crm-settings-title' },
        pageHeader(document, { title: NAV_LABELS.crmSettings, titleId: 'crm-settings-title', subtitle: 'Os cadastros que organizam o CRM. Escolha o que você quer administrar.' }),
        entries.length > 0 ? el('div', { className: 'settings-grid' }, ...entries.map(card)) : el('p', { className: 'message info', role: 'status', text: 'Sua conta não tem nenhuma configuração para administrar.' })
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
