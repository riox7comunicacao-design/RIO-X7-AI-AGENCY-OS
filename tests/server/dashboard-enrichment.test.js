// COMPLETAR PESQUISA (Implementação 3.0.2) no Dashboard: o painel de enriquecimento sob demanda dentro da Análise comercial. A API é um FAKE em memória; o agendador da consulta é manual.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowser } = require('../helpers/fakeDom');

const PERFIL = {
  empresa: 'Clínica Alfa',
  responsavel: { status: 'ENCONTRADO', nome: 'Ana Souza', cargo: 'Proprietária', origem: 'https://clinicaalfa.com.br/', confianca: 'ALTA' },
  endereco: { status: 'NAO_ENCONTRADO' },
  siteOficial: { status: 'ENCONTRADO', url: 'https://clinicaalfa.com.br/' },
  presencaDigital: {},
  telefones: [],
  whatsapps: [],
  emails: [],
  trafegoPago: { meta: { status: 'NAO_VERIFICADO' }, google: { status: 'NAO_VERIFICADO' }, tiktok: { status: 'NAO_VERIFICADO' } },
  atividadeRecente: { ultimaPostagem: null, janelas: {} },
};

function apiDePesquisa({ inicial, aoIniciar, consultas = [] }) {
  const chamadas = [];
  const fila = [...consultas];
  let atual = inicial;
  return {
    chamadas,
    api: {
      getLeadResearchStatus: async (id) => {
        chamadas.push(['status', id]);
        if (fila.length > 0) atual = fila.shift();
        return { item: atual };
      },
      completeLeadResearch: async (id) => {
        chamadas.push(['completar', id]);
        atual = await aoIniciar();
        return { item: atual };
      },
    },
  };
}
const agendador = () => {
  const tarefas = [];
  return {
    tarefas,
    schedule: (fn, ms) => {
      const tarefa = { fn, ms, cancelada: false };
      tarefas.push(tarefa);
      return () => {
        tarefa.cancelada = true;
      };
    },
    proxima: () => tarefas.filter((x) => !x.cancelada && !x.feita).at(-1),
  };
};

test('[DASH-ENRICH-1] COMPLETAR PESQUISA: "Não executado" + campos pendentes + botão; clicar inicia (uma chamada), mostra Em andamento com etapa e tempo, bloqueia o botão, consulta o estado e, ao terminar, mostra Completo, custo e fontes e recarrega o perfil', async () => {
  const { createEnrichmentPanel } = await import('../../dashboard/views/leadEnrichmentPanel.mjs');
  const naoExecutado = { status: 'NAO_EXECUTADO', camposPendentes: ['emails', 'trafegoPago', 'atividadeRecente'], podeCompletar: true, disponivel: true };
  const andando = { status: 'EM_ANDAMENTO', etapa: 'PESQUISANDO', elapsedMs: 12000, camposSolicitados: ['emails', 'trafegoPago'], podeCompletar: false };
  const completo = { status: 'COMPLETO', camposPendentes: [], camposNaoEncontrados: ['atividadeRecente'], resolucao: { atividadeRecente: { status: 'NAO_ENCONTRADO_COM_VERIFICACAO', resolvido: true, fontes: ['https://a.com.br/sobre'] } }, podeCompletar: false, disponivel: true, ultimaExecucao: { iniciadoEm: '2026-10-08T12:00:00.000Z', duracaoMs: 48000, custoUsd: 0.12, turnos: 7, ferramentas: { webSearch: 4, webFetch: 'NAO_MEDIDO' }, encerramento: 'CONCLUIDA', fontesNovas: ['https://b.com.br/'], fontes: ['https://a.com.br/', 'https://b.com.br/'] } };
  const sim = apiDePesquisa({ inicial: naoExecutado, aoIniciar: async () => andando, consultas: [naoExecutado, andando, completo] });
  const agenda = agendador();
  const browser = createBrowser();
  const terminou = [];
  const painel = createEnrichmentPanel({ document: browser.document, api: sim.api, prospectId: 'pid-1', onFinished: (info) => terminou.push(info.status), schedule: agenda.schedule });
  browser.root.append(painel.element);
  await painel.load();
  await browser.flush();
  const texto = () => browser.root.textContent.replace(/\s+/g, ' ');
  assert.equal(browser.by.id(browser.root, 'enrich-status').textContent, 'Não executado');
  assert.match(texto(), /Campos que ainda podem ser pesquisados: e-mails, tráfego pago, atividade recente/);
  const botao = browser.by.id(browser.root, 'enrich-run');
  assert.equal(botao.textContent, 'COMPLETAR PESQUISA');
  assert.equal(botao.disabled, false);

  browser.click(botao);
  await browser.flush(8);
  assert.deepEqual(sim.chamadas.filter(([n]) => n === 'completar'), [['completar', 'pid-1']]);
  assert.equal(browser.by.id(browser.root, 'enrich-status').textContent, 'Em andamento');
  assert.match(browser.by.id(browser.root, 'enrich-elapsed').textContent, /Pesquisando na web · 00:12/);
  assert.ok(browser.by.id(browser.root, 'enrich-progress'), 'há indicador de progresso');
  assert.equal(browser.by.id(browser.root, 'enrich-run').disabled, true, 'sem múltiplas execuções para o mesmo lead');
  browser.click(browser.by.id(browser.root, 'enrich-run'));
  await browser.flush(4);
  assert.equal(sim.chamadas.filter(([n]) => n === 'completar').length, 1, 'o clique no botão desabilitado não dispara outra pesquisa');
  assert.equal(agenda.proxima().ms, 2000, 'a consulta de estado é agendada');

  for (let i = 0; i < 2; i += 1) {
    const tarefa = agenda.proxima();
    tarefa.feita = true;
    await tarefa.fn();
    await browser.flush();
  }
  assert.equal(browser.by.id(browser.root, 'enrich-status').textContent, 'Completo');
  assert.match(texto(), /custo informado pelo motor: US\$ 0\.12/);
  assert.match(texto(), /duração 00:48/);
  assert.match(texto(), /1 fonte\(s\) nova\(s\), 2 acumulada\(s\)/, 'fontes novas separadas das acumuladas');
  assert.match(texto(), /WebSearch: 4 · WebFetch: NÃO MEDIDO/, 'ferramenta que o executor não mede aparece como NÃO MEDIDO');
  assert.match(texto(), /7 turno\(s\)/);
  assert.match(texto(), /Não encontrado após verificação documentada: atividade recente/);
  assert.match(texto(), /não prova que a informação não exista/);
  assert.doesNotMatch(texto(), /não encontrado publicamente|não existe/i, 'sem afirmação definitiva');
  assert.equal(browser.by.id(browser.root, 'enrich-run').disabled, true, 'tudo resolvido: não repete a mesma pesquisa');
  assert.deepEqual(terminou, ['COMPLETO'], 'o perfil é recarregado ao terminar');
  assert.equal(agenda.proxima(), undefined, 'terminou: nenhuma nova consulta agendada');
});

test('[DASH-ENRICH-2] Incompleto e Falhou mostram pendências, motivo e a mensagem clara (limite de turnos / limite de uso / Claude indisponível); nova tentativa liberada; erros da API viram mensagem', async () => {
  const { createEnrichmentPanel } = await import('../../dashboard/views/leadEnrichmentPanel.mjs');
  const montar = async (inicial, aoIniciar = async () => inicial) => {
    const sim = apiDePesquisa({ inicial, aoIniciar });
    const browser = createBrowser();
    const painel = createEnrichmentPanel({ document: browser.document, api: sim.api, prospectId: 'pid-1', schedule: agendador().schedule });
    browser.root.append(painel.element);
    await painel.load();
    await browser.flush();
    return { browser };
  };
  const incompleto = await montar({ status: 'INCOMPLETO', camposPendentes: ['responsavel', 'trafegoPago'], limiteDeTurnos: true, mensagem: 'A pesquisa atingiu o limite de turnos do motor antes de terminar.', podeCompletar: true, disponivel: true, ultimaExecucao: { iniciadoEm: '2026-10-08T12:00:00.000Z', duracaoMs: 21000, custoUsd: 0.07 } });
  assert.equal(incompleto.browser.by.id(incompleto.browser.root, 'enrich-status').textContent, 'Pesquisa incompleta');
  assert.match(incompleto.browser.root.textContent, /Campos que ainda podem ser pesquisados: responsável, tráfego pago/);
  assert.match(incompleto.browser.root.textContent, /Limite de turnos do motor atingido/);
  assert.match(incompleto.browser.root.textContent, /somente os campos não verificados/);
  assert.equal(incompleto.browser.by.id(incompleto.browser.root, 'enrich-run').disabled, false);

  const limite = await montar({ status: 'FALHOU', motivo: 'USAGE_LIMIT', mensagem: 'O limite de uso do Claude foi atingido. Tente novamente mais tarde.', camposPendentes: ['emails'], podeCompletar: true, disponivel: true });
  assert.equal(limite.browser.by.id(limite.browser.root, 'enrich-status').textContent, 'Falhou');
  assert.match(limite.browser.by.id(limite.browser.root, 'enrich-error').textContent, /limite de uso do Claude/);

  const indisponivel = await montar({ status: 'NAO_EXECUTADO', camposPendentes: ['emails'], podeCompletar: false, disponivel: false });
  assert.match(indisponivel.browser.by.id(indisponivel.browser.root, 'enrich-unavailable').textContent, /Claude não está disponível/);
  assert.equal(indisponivel.browser.by.id(indisponivel.browser.root, 'enrich-run').disabled, true);

  const recusado = await montar({ status: 'NAO_EXECUTADO', camposPendentes: ['emails'], podeCompletar: true, disponivel: true }, async () => { throw Object.assign(new Error('x'), { status: 409 }); });
  recusado.browser.click(recusado.browser.by.id(recusado.browser.root, 'enrich-run'));
  await recusado.browser.flush(8);
  assert.match(recusado.browser.by.id(recusado.browser.root, 'enrich-message').textContent, /Já existe uma pesquisa em andamento/);
  const semClaude = await montar({ status: 'NAO_EXECUTADO', camposPendentes: ['emails'], podeCompletar: true, disponivel: true }, async () => { throw Object.assign(new Error('x'), { status: 503 }); });
  semClaude.browser.click(semClaude.browser.by.id(semClaude.browser.root, 'enrich-run'));
  await semClaude.browser.flush(8);
  assert.match(semClaude.browser.by.id(semClaude.browser.root, 'enrich-message').textContent, /Claude não está disponível/);
});

test('[DASH-ENRICH-3] na Approval Queue o painel fica DENTRO da Análise comercial sem bloquear a leitura do perfil; sem permissão de revisão não há painel; ao terminar o perfil é recarregado', async () => {
  const { createApprovalsView } = await import('../../dashboard/views/approvals.mjs');
  const item = { prospectId: 'pid-alfa', empresa: 'Clínica Alfa', estado: 'AGUARDANDO_REVISAO', discoverySnapshot: { empresa: 'Clínica Alfa', cidade: 'Petrópolis', estadoUf: 'RJ' }, historico: [] };
  let perfisLidos = 0;
  const agenda = agendador();
  const pendente = { status: 'NAO_EXECUTADO', camposPendentes: ['emails'], podeCompletar: true, disponivel: true };
  const sim = apiDePesquisa({ inicial: pendente, aoIniciar: async () => ({ status: 'EM_ANDAMENTO', etapa: 'PESQUISANDO', elapsedMs: 1000, camposSolicitados: ['emails'] }), consultas: [pendente, { status: 'EM_ANDAMENTO', etapa: 'PESQUISANDO', elapsedMs: 3000 }, { status: 'COMPLETO', camposPendentes: [], camposNaoEncontrados: [], podeCompletar: false, disponivel: true }] });
  const api = { ...sim.api, listApprovals: async () => ({ items: [item] }), getLeadProfile: async () => { perfisLidos += 1; return { item: PERFIL }; }, approve: async () => ({}), reject: async () => ({}) };
  const browser = createBrowser();
  const view = createApprovalsView({ document: browser.document, root: browser.root, api, canReview: true, schedule: agenda.schedule });
  await view.load();
  await browser.flush();
  browser.click(browser.by.button(browser.root, 'Clínica Alfa'));
  await browser.flush(10);
  const tela = () => browser.root.textContent.replace(/\s+/g, ' ');
  assert.match(tela(), /Análise comercial/);
  assert.match(tela(), /Ana Souza — Proprietária/, 'o perfil está legível');
  assert.ok(browser.by.id(browser.root, 'enrich-run'), 'o botão COMPLETAR PESQUISA está na Análise comercial');
  // UX 4.0: a gaveta organiza o lead em abas; o botão fica na aba da pesquisa comercial (aberta pelo usuário)
  browser.click(browser.find(browser.root, (node) => node.getAttribute('role') === 'tab' && node.getAttribute('data-tab') === 'pesquisa'));
  await browser.flush();

  browser.click(browser.by.id(browser.root, 'enrich-run'));
  await browser.flush(10);
  assert.equal(browser.by.id(browser.root, 'enrich-status').textContent, 'Em andamento');
  assert.match(tela(), /Ana Souza — Proprietária/, 'durante a pesquisa o perfil continua visível');
  const lidosAntes = perfisLidos;
  for (let i = 0; i < 3; i += 1) {
    const tarefa = agenda.proxima();
    if (!tarefa) break;
    tarefa.feita = true;
    await tarefa.fn();
    await browser.flush(6);
  }
  assert.equal(browser.by.id(browser.root, 'enrich-status').textContent, 'Completo');
  assert.ok(perfisLidos > lidosAntes, 'o perfil foi recarregado quando a pesquisa terminou');
  view.destroy();

  const leitor = createBrowser();
  const semRevisao = createApprovalsView({ document: leitor.document, root: leitor.root, api, canReview: false });
  await semRevisao.load();
  await leitor.flush();
  leitor.click(leitor.by.button(leitor.root, 'Clínica Alfa'));
  await leitor.flush(8);
  assert.equal(leitor.by.id(leitor.root, 'enrich-run'), null, 'sem APPROVE:LEAD_APPROVAL não há painel');
});
