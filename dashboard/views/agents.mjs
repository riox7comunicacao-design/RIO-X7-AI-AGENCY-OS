// Tela AGENTES IA — a Central de Agentes: só a ESTRUTURA VISUAL da futura equipe de especialistas digitais.
//
// Nenhum agente existe ainda: nada aqui executa, simula execução, chama a rede ou mostra métrica. Cada cartão diz o que o
// especialista fará e que o status atual é "Em desenvolvimento". A lista espelha a equipe descrita em
// docs/architecture/specialist-matrix.md; quando um agente existir, ele ganha o seu estado real aqui — nunca antes.
//
// Todo texto entra no DOM por dom.mjs (textContent). A tela não recebe `api`: não tem o que buscar.

import { h, fill } from '../dom.mjs';

export const AGENT_STATUS = 'Em desenvolvimento';

// [nome, descrição] — a ordem da apresentação.
export const AGENTS = Object.freeze(
  [
    ['Prospector', 'Pesquisa e descoberta de empresas.'],
    ['SDR', 'Qualificação e abordagem comercial.'],
    ['Raio-X Digital', 'Diagnóstico comercial e digital.'],
    ['Closer', 'Apoio à preparação e condução comercial.'],
    ['Gestor de Tráfego', 'Meta Ads, Google Ads e TikTok Ads.'],
    ['Copywriter', 'Copies, anúncios e mensagens.'],
    ['Designer', 'Criativos e identidade visual.'],
    ['Editor de Vídeo', 'Reels, vídeos e conteúdos.'],
    ['Web Developer', 'Sites e landing pages.'],
    ['Administrativo', 'Processos e organização interna.'],
    ['Financeiro', 'Controle e análise financeira.'],
    ['Jurídico', 'Apoio documental e jurídico.'],
    ['Customer Success', 'Onboarding, acompanhamento e retenção.'],
    ['COO / Orquestrador', 'Coordenação dos especialistas.'],
  ].map(([name, description]) => Object.freeze({ name, description }))
);

export function createAgentsView({ document, root }) {
  const el = (tag, props, ...children) => h(document, tag, props, ...children);

  function render() {
    fill(
      root,
      el(
        'section',
        { className: 'agents', 'aria-labelledby': 'agents-title' },
        el('div', { className: 'page-head' }, el('h2', { id: 'agents-title', text: 'Agentes IA' }), el('p', { className: 'muted', text: 'Especialistas digitais da operação Rio X7.' })),
        el('p', { className: 'notice', text: 'Esta área prepara a estrutura visual da equipe de agentes. Nenhum agente está ativo ainda: nada é executado e nenhuma métrica é exibida.' }),
        el(
          'ul',
          { className: 'plain agent-grid' },
          ...AGENTS.map((agent) =>
            el(
              'li',
              { className: 'card agent-card' },
              el('h3', { text: agent.name }),
              el('p', { className: 'muted agent-desc', text: agent.description }),
              el('span', { className: 'badge neutral', text: AGENT_STATUS })
            )
          )
        )
      )
    );
  }

  return { render, destroy() {} };
}
