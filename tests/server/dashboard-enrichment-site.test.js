// REVER SITE OFICIAL e COMPLETAR PESQUISA em Leads Reprovados (Implementação 3.0.2, decisões finais) no Dashboard. API FAKE em memória; agendador manual.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowser } = require('../helpers/fakeDom');

const PERFIL = { empresa: 'Clínica Alfa', responsavel: { status: 'ENCONTRADO', nome: 'Ana Souza', cargo: 'Proprietária', origem: 'https://a.com.br/', confianca: 'ALTA' }, endereco: { status: 'NAO_ENCONTRADO' }, siteOficial: { status: 'ENCONTRADO', url: 'https://a.com.br/' }, presencaDigital: {}, telefones: [], whatsapps: [], emails: [], trafegoPago: {}, atividadeRecente: {} };
const agendador = () => {
  const tarefas = [];
  return { schedule: (fn, ms) => { const tarefa = { fn, ms, cancelada: false }; tarefas.push(tarefa); return () => { tarefa.cancelada = true; }; }, proxima: () => tarefas.filter((x) => !x.cancelada && !x.feita).at(-1) };
};
const estadoBase = { status: 'NAO_EXECUTADO', camposPendentes: ['emails'], podeCompletar: true, podeRever: true, disponivel: true };

function apiFake(inicial, { aoRever = async () => ({ status: 'EM_ANDAMENTO', tipo: 'REVISAO_SITE', etapa: 'PESQUISANDO', elapsedMs: 1000 }), consultas = [] } = {}) {
  const chamadas = [];
  const fila = [...consultas];
  let atual = inicial;
  return {
    chamadas,
    api: {
      getLeadResearchStatus: async (id) => { chamadas.push(['status', id]); if (fila.length > 0) atual = fila.shift(); return { item: atual }; },
      completeLeadResearch: async (id) => { chamadas.push(['completar', id]); return { item: atual }; },
      reviewLeadSite: async (id) => { chamadas.push(['rever-site', id]); atual = await aoRever(); return { item: atual }; },
    },
  };
}

test('[DASH-SITE-1] REVER SITE OFICIAL: botão explícito; ao clicar uma única chamada, mostra a revisão em andamento, bloqueia os botões e, ao concluir, mostra o resultado, as fontes e o custo (site mantido/alterado), sem esconder o perfil', async () => {
  const { createEnrichmentPanel } = await import('../../dashboard/views/leadEnrichmentPanel.mjs');
  const concluida = { ...estadoBase, revisaoSite: { status: 'CONCLUIDA', ultimaRevisao: { resultado: 'SEM_COMPROVACAO', concluidoEm: '2026-10-08T12:00:00.000Z', custoUsd: 0.05, mensagem: 'Não houve comprovação suficiente para alterar: o site confirmado foi mantido.', fontes: ['https://a.com.br/', 'https://b.com.br/'] } } };
  const sim = apiFake(estadoBase, { consultas: [estadoBase, { status: 'EM_ANDAMENTO', tipo: 'REVISAO_SITE', etapa: 'VALIDANDO', elapsedMs: 4000 }, concluida] });
  const agenda = agendador();
  const browser = createBrowser();
  const painel = createEnrichmentPanel({ document: browser.document, api: sim.api, prospectId: 'pid-1', schedule: agenda.schedule });
  browser.root.append(painel.element);
  await painel.load();
  await browser.flush();
  const botao = browser.by.id(browser.root, 'enrich-review-site');
  assert.equal(botao.textContent, 'REVER SITE OFICIAL');
  assert.equal(botao.disabled, false);

  browser.click(botao);
  await browser.flush(8);
  assert.deepEqual(sim.chamadas.filter(([n]) => n === 'rever-site'), [['rever-site', 'pid-1']]);
  assert.equal(browser.by.id(browser.root, 'enrich-status').textContent, 'Em andamento');
  assert.match(browser.by.id(browser.root, 'enrich-elapsed').textContent, /Revisando o site oficial/);
  assert.equal(browser.by.id(browser.root, 'enrich-review-site').disabled, true);
  assert.equal(browser.by.id(browser.root, 'enrich-run').disabled, true, 'nada em paralelo');
  for (let i = 0; i < 2; i += 1) {
    const tarefa = agenda.proxima();
    tarefa.feita = true;
    await tarefa.fn();
    await browser.flush();
  }
  const texto = browser.root.textContent.replace(/\s+/g, ' ');
  assert.match(texto, /Revisão do site oficial: Sem comprovação suficiente \(o site confirmado foi mantido\)/);
  assert.match(texto, /custo informado pelo motor: US\$ 0\.05/);
  assert.match(texto, /Fontes conferidas: https:\/\/a\.com\.br\/ · https:\/\/b\.com\.br\//);
  assert.match(texto, /o site confirmado foi mantido\./);
});

test('[DASH-SITE-2] erros do servidor viram mensagem clara: outra pesquisa em andamento (ENRICH_BUSY) e lead em DNC (bloqueio); com DNC os dois botões ficam desabilitados', async () => {
  const { createEnrichmentPanel } = await import('../../dashboard/views/leadEnrichmentPanel.mjs');
  const ocupado = apiFake(estadoBase, { aoRever: async () => { throw Object.assign(new Error('x'), { status: 409, code: 'ENRICH_BUSY' }); } });
  const browser = createBrowser();
  const painel = createEnrichmentPanel({ document: browser.document, api: ocupado.api, prospectId: 'pid-1', schedule: agendador().schedule });
  browser.root.append(painel.element);
  await painel.load();
  await browser.flush();
  browser.click(browser.by.id(browser.root, 'enrich-review-site'));
  await browser.flush(8);
  assert.match(browser.by.id(browser.root, 'enrich-message').textContent, /outro lead/);

  const dnc = apiFake({ status: 'NAO_EXECUTADO', camposPendentes: ['emails'], podeCompletar: false, podeRever: false, disponivel: true, bloqueio: 'DNC', mensagem: 'Este lead está em DNC (não contatar): a pesquisa de contatos não é permitida.' });
  const outro = createBrowser();
  const p2 = createEnrichmentPanel({ document: outro.document, api: dnc.api, prospectId: 'pid-2', schedule: agendador().schedule });
  outro.root.append(p2.element);
  await p2.load();
  await outro.flush();
  assert.match(outro.by.id(outro.root, 'enrich-blocked').textContent, /DNC/);
  assert.equal(outro.by.id(outro.root, 'enrich-run').disabled, true);
  assert.equal(outro.by.id(outro.root, 'enrich-review-site').disabled, true);
});

test('[DASH-SITE-3] Leads Reprovados: o painel COMPLETAR PESQUISA / REVER SITE OFICIAL aparece no detalhe (só com permissão de revisão), não oferece reaprovar/aprovar/promover por conta própria e ao terminar a lista é recarregada', async () => {
  const { createRejectedLeadsView } = await import('../../dashboard/views/rejectedLeads.mjs');
  const lead = { prospectId: 'pid-rej', empresa: 'Clínica Alfa', estado: 'REJEITADO', reaprovavel: true, reprovadoEm: '2026-10-07T12:00:00.000Z', reprovadoPor: { userId: 'u1', name: 'Rafael', role: 'COMMERCIAL_CLOSER' }, origemDaDecisao: 'HUMANO', motivo: 'Sem fit', reaprovacoes: 0, jobOrigem: 'JOB-1', dadosComerciais: {}, perfil: PERFIL, historico: [] };
  const sim = apiFake(estadoBase, { consultas: [estadoBase, { status: 'EM_ANDAMENTO', etapa: 'PESQUISANDO', elapsedMs: 2000 }, { ...estadoBase, status: 'COMPLETO', podeCompletar: false }] });
  let listagens = 0;
  const api = { ...sim.api, completeLeadResearch: async (id) => { sim.chamadas.push(['completar', id]); return { item: { status: 'EM_ANDAMENTO', etapa: 'PESQUISANDO', elapsedMs: 1000 } }; }, listRejectedLeads: async () => { listagens += 1; return { items: [lead] }; }, reapproveLead: async () => assert.fail('pesquisar NÃO pode reaprovar') };
  const agenda = agendador();
  const browser = createBrowser();
  const view = createRejectedLeadsView({ document: browser.document, root: browser.root, api, permissions: { canReview: true }, schedule: agenda.schedule });
  await view.load();
  await browser.flush();
  const abrir = () => browser.find(browser.root, (el) => el.getAttribute('data-open') === 'pid-rej');
  browser.click(abrir());
  await browser.flush(10);
  assert.ok(browser.by.id(browser.root, 'enrich-run'), 'COMPLETAR PESQUISA em Leads Reprovados');
  assert.ok(browser.by.id(browser.root, 'enrich-review-site'), 'REVER SITE OFICIAL em Leads Reprovados');
  assert.match(browser.root.textContent, /Ana Souza — Proprietária/, 'o perfil continua à vista');

  browser.click(browser.by.id(browser.root, 'enrich-run'));
  await browser.flush(8);
  assert.deepEqual(sim.chamadas.filter(([n]) => n === 'completar'), [['completar', 'pid-rej']]);
  assert.equal(browser.by.id(browser.root, 'btn-reapprove').disabled, false, 'reaprovar continua sendo uma ação humana SEPARADA — a pesquisa não a executa');
  const antes = listagens;
  for (let i = 0; i < 2; i += 1) {
    const tarefa = agenda.proxima();
    if (!tarefa) break;
    tarefa.feita = true;
    await tarefa.fn();
    await browser.flush(8);
  }
  assert.ok(listagens > antes, 'ao terminar, a lista de reprovados é recarregada');
  view.destroy();

  const leitor = createBrowser();
  const semRevisao = createRejectedLeadsView({ document: leitor.document, root: leitor.root, api, permissions: { canReview: false } });
  await semRevisao.load();
  await leitor.flush();
  leitor.click(leitor.find(leitor.root, (el) => el.getAttribute('data-open') === 'pid-rej'));
  await leitor.flush(8);
  assert.equal(leitor.by.id(leitor.root, 'enrich-run'), null, 'sem permissão de revisão não há painel');
});
