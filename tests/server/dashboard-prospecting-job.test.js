// A tela de Prospecção (dashboard/views/prospecting.mjs) com o botão "INICIAR PROSPECÇÃO" (Fase 2): iniciar, acompanhar o status, cancelar e ver o
// resultado — sem JSON técnico para o usuário. A API é um FAKE em memória (nenhuma rede); o agendador da consulta de status é manual.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowser } = require('../helpers/fakeDom');

const loadView = () => import('../../dashboard/views/prospecting.mjs');

const BRIEF = { id: 'PROS-20261006-001', status: 'PRONTO_PARA_PESQUISA', nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', cidades: ['Petrópolis/RJ'], quantidade: 3, observacoes: null, pacotePesquisa: null, loteRealId: null, contagens: null, criadoEm: '2026-10-06T12:00:00.000Z' };
const job = (extras = {}) => ({ id: 'JOB-20261006-001', briefId: BRIEF.id, status: 'EXECUTANDO', currentStep: 'DESCOBRINDO', progress: 15, requestedQuantity: 3, candidatesDiscovered: 0, candidatesValidated: 0, candidatesRejected: 0, elapsedMs: 0, error: null, ...extras });

function criar({ briefs = [BRIEF], jobs = [], respostas = [], canPropose = true } = {}) {
  const chamadas = [];
  const fila = [...respostas];
  let briefAtual = briefs;
  let jobsNoServidor = [...jobs]; // o "servidor": o que a listagem devolve acompanha o que o status já informou
  const api = {
    listProspectingBriefs: async () => ({ items: briefAtual }),
    createProspectingBrief: async (fields) => {
      chamadas.push(['create', fields]);
      const novo = { ...BRIEF, id: 'PROS-20261008-009', ...fields, cidades: [fields.cidades], contagens: null };
      briefAtual = [novo, ...briefAtual];
      return { item: novo };
    },
    getProspectingBrief: async (id) => ({ item: briefAtual.find((b) => b.id === id) }),
    listProspectingJobs: async (briefId) => {
      chamadas.push(['listJobs', briefId]);
      return { items: jobsNoServidor.filter((j) => briefId === undefined || j.briefId === briefId) };
    },
    redoProspectingJob: async (id) => {
      chamadas.push(['redo', id]);
      const criado = job({ id: 'JOB-20261006-009' });
      jobsNoServidor = [criado, ...jobsNoServidor];
      return { item: criado };
    },
    startProspectingJob: async (briefId, maxCandidates) => {
      chamadas.push(['start', briefId]);
      chamadas.push(['max', maxCandidates]);
      const criado = job();
      jobsNoServidor = [criado, ...jobsNoServidor];
      return { item: criado };
    },
    getProspectingJobStatus: async (id) => {
      chamadas.push(['status', id]);
      const item = fila.length > 1 ? fila.shift() : fila[0];
      jobsNoServidor = [item, ...jobsNoServidor.filter((j) => j.id !== item.id)];
      return { item };
    },
    cancelProspectingJob: async (id) => {
      chamadas.push(['cancel', id]);
      return { item: job({ status: 'CANCELAMENTO_SOLICITADO', cancelRequested: true }) };
    },
    getProspectingBatch: async () => ({ item: { resultados: [] } }),
  };
  const agendadas = [];
  const schedule = (fn, ms) => {
    const tarefa = { fn, ms, cancelada: false };
    agendadas.push(tarefa);
    return () => {
      tarefa.cancelada = true;
    };
  };
  const proximaAgendada = () => agendadas.filter((a) => !a.cancelada && !a.executada).at(-1);
  return { api, chamadas, agendadas, schedule, proximaAgendada, trocarBriefs: (novos) => { briefAtual = novos; } };
}

async function montar(opcoes = {}) {
  const { createProspectingView } = await loadView();
  const ambiente = criar(opcoes);
  const browser = createBrowser();
  const view = createProspectingView({ document: browser.document, root: browser.root, api: ambiente.api, permissions: { canProposeLead: opcoes.canPropose !== false }, schedule: ambiente.schedule });
  await view.load();
  await browser.flush();
  const rodarAgendada = async () => {
    const tarefa = ambiente.proximaAgendada();
    assert.ok(tarefa, 'há uma consulta de status agendada');
    tarefa.executada = true;
    await tarefa.fn();
    await browser.flush();
  };
  return { ...ambiente, browser, view, rodarAgendada, tela: () => browser.root.textContent.replace(/\s+/g, ' ') };
}

async function selecionar(t) {
  const link = t.browser.by.text(t.browser.root, BRIEF.id, 'button');
  t.browser.click(link);
  await t.browser.flush(8);
}

test('[DASH-JOB-1] com o brief PRONTO aparece o botão "INICIAR PROSPECÇÃO"; clicar cria o job (UMA chamada com só o briefId) e a tela passa a mostrar o andamento', async () => {
  const t = await montar();
  await selecionar(t);
  const botao = t.browser.by.id(t.browser.root, 'pros-start-job');
  assert.ok(botao);
  assert.equal(botao.textContent, 'INICIAR PROSPECÇÃO');
  t.browser.click(botao);
  await t.browser.flush(8);

  assert.deepEqual(t.chamadas.filter(([nome]) => nome === 'start'), [['start', BRIEF.id]]);
  assert.equal(t.browser.by.id(t.browser.root, 'pros-start-job'), null, 'o botão some enquanto há uma prospecção ativa');
  assert.match(t.tela(), /Em execução/);
  assert.match(t.tela(), /Descobrindo empresas na web/);
  assert.match(t.tela(), /Empresas descobertas: 0 · Validadas pela página: 0 · Não validadas: 0 · Solicitadas: 3/);
  assert.match(t.tela(), /Tempo decorrido: 00:00/);
  assert.ok(t.browser.by.tag(t.browser.root, 'progress')[0], 'há uma barra de progresso');
  assert.equal(t.browser.by.tag(t.browser.root, 'progress')[0].getAttribute('value'), '15');
  assert.ok(t.browser.by.id(t.browser.root, 'pros-cancel-job'), 'e o botão de cancelar');
  assert.equal(t.proximaAgendada().ms, 2500, 'a consulta de status é agendada');
});

test('[DASH-JOB-2] a tela consulta /status periodicamente: mostra etapa, contagens, progresso e tempo; ao CONCLUIR mostra "PROSPECÇÃO CONCLUÍDA", o resumo e o link para as Aprovações, e PARA de consultar', async () => {
  const t = await montar({
    respostas: [
      job({ currentStep: 'VALIDANDO', progress: 55, candidatesDiscovered: 6, candidatesValidated: 2, candidatesRejected: 1, elapsedMs: 75000 }),
      job({ status: 'CONCLUIDO', currentStep: 'FINALIZADO', progress: 100, candidatesDiscovered: 6, candidatesValidated: 3, candidatesRejected: 2, elapsedMs: 98000, lote: { loteId: 'lote:x', validadosPeloMotor: 3, naFila: 3, foraDaFila: 0 } }),
    ],
  });
  await selecionar(t);
  t.browser.click(t.browser.by.id(t.browser.root, 'pros-start-job'));
  await t.browser.flush(8);

  await t.rodarAgendada();
  assert.match(t.tela(), /Validando as páginas das empresas/);
  assert.match(t.tela(), /Empresas descobertas: 6 · Validadas pela página: 2 · Não validadas: 1/);
  assert.match(t.tela(), /Tempo decorrido: 01:15/);
  assert.equal(t.browser.by.tag(t.browser.root, 'progress')[0].getAttribute('value'), '55');

  await t.rodarAgendada();
  assert.match(t.tela(), /PROSPECÇÃO CONCLUÍDA/);
  assert.match(t.tela(), /3 de 3 lead\(s\) solicitado\(s\) chegaram à Approval Queue/);
  assert.doesNotMatch(t.tela(), /não foi\(ram\) entregue\(s\)/, 'nada ficou fora da fila');
  assert.equal(t.browser.by.id(t.browser.root, 'pros-cancel-job'), null, 'sem cancelar depois de terminar');
  const link = t.browser.by.id(t.browser.root, 'pros-open-approvals');
  assert.equal(link.getAttribute('href'), '#/aprovacoes');
  assert.equal(link.textContent, 'Abrir Aprovações');
  assert.equal(t.proximaAgendada(), undefined, 'terminou: nenhuma nova consulta agendada');
});

test('[DASH-JOB-3] PARCIAL: "PROSPECÇÃO PARCIAL" diz que a quantidade não foi atingida e que nada foi incluído para completar; sem nenhum válido, não há link para a aprovação', async () => {
  const parcial = await montar({ respostas: [job({ status: 'PARCIAL', currentStep: 'FINALIZADO', progress: 100, candidatesDiscovered: 6, candidatesValidated: 2, candidatesRejected: 4, lote: { loteId: 'lote:p', validadosPeloMotor: 2, naFila: 2, foraDaFila: 0 } })] });
  await selecionar(parcial);
  parcial.browser.click(parcial.browser.by.id(parcial.browser.root, 'pros-start-job'));
  await parcial.browser.flush(8);
  await parcial.rodarAgendada();
  assert.match(parcial.tela(), /PROSPECÇÃO PARCIAL/);
  assert.match(parcial.tela(), /2 de 3 lead\(s\) solicitado\(s\) chegaram à Approval Queue/);
  assert.match(parcial.tela(), /nenhuma empresa fraca foi incluída para completar/);
  assert.ok(parcial.browser.by.id(parcial.browser.root, 'pros-open-approvals'));

  const vazia = await montar({ respostas: [job({ status: 'PARCIAL', currentStep: 'FINALIZADO', progress: 100, candidatesDiscovered: 4, candidatesValidated: 0, candidatesRejected: 4 })] });
  await selecionar(vazia);
  vazia.browser.click(vazia.browser.by.id(vazia.browser.root, 'pros-start-job'));
  await vazia.browser.flush(8);
  await vazia.rodarAgendada();
  assert.match(vazia.tela(), /Nenhuma empresa pôde ser comprovada pela página; nada foi enviado para a aprovação/);
  assert.equal(vazia.browser.by.id(vazia.browser.root, 'pros-open-approvals'), null);

  // validados pelo motor, mas NENHUM chegou à fila: PARCIAL, sem link para as Aprovações e com a distinção explícita
  const retidos = await montar({ respostas: [job({ status: 'PARCIAL', currentStep: 'FINALIZADO', progress: 100, candidatesDiscovered: 5, candidatesValidated: 3, candidatesRejected: 2, lote: { loteId: 'lote:r', validadosPeloMotor: 3, naFila: 0, foraDaFila: 3 } })] });
  await selecionar(retidos);
  retidos.browser.click(retidos.browser.by.id(retidos.browser.root, 'pros-start-job'));
  await retidos.browser.flush(8);
  await retidos.rodarAgendada();
  assert.match(retidos.tela(), /Nenhum lead chegou à Approval Queue/);
  assert.match(retidos.tela(), /3 empresa\(s\) comprovada\(s\) pela pesquisa, mas 3 não foi\(ram\) entregue\(s\) à fila/);
  assert.equal(retidos.browser.by.id(retidos.browser.root, 'pros-open-approvals'), null, 'sem lead na fila não há o que abrir');
});

test('[DASH-JOB-4] ERRO e CANCELADO: mensagens em português, nunca o código técnico nem JSON; ERRO por interrupção do servidor também', async () => {
  for (const [extras, texto] of [
    [{ status: 'ERRO', currentStep: 'FINALIZADO', error: { code: 'DISCOVERY_FAILED', message: 'x', cause: 'TIMEOUT' } }, /A PROSPECÇÃO FALHOU.*Não foi possível descobrir empresas agora/],
    [{ status: 'ERRO', currentStep: 'FINALIZADO', error: { code: 'JOB_INTERRUPTED', message: 'x' } }, /o servidor foi reiniciado/],
    [{ status: 'ERRO', currentStep: 'FINALIZADO', error: { code: 'INGESTION_FAILED', message: 'x' } }, /Nada foi promovido ao CRM/],
    [{ status: 'CANCELADO', currentStep: 'FINALIZADO' }, /PROSPECÇÃO CANCELADA/],
  ]) {
    const t = await montar({ respostas: [job(extras)] });
    await selecionar(t);
    t.browser.click(t.browser.by.id(t.browser.root, 'pros-start-job'));
    await t.browser.flush(8);
    await t.rodarAgendada();
    assert.match(t.tela(), texto);
    assert.doesNotMatch(t.tela(), /DISCOVERY_FAILED|JOB_INTERRUPTED|INGESTION_FAILED|TIMEOUT|\{|"code"/);
  }
});

test('[DASH-JOB-5] CANCELAR PROSPECÇÃO: chama a API do job (só o id), mostra "Cancelando…" e continua acompanhando até CANCELADO; durante a ingestão o botão NÃO existe', async () => {
  const t = await montar({ respostas: [job({ status: 'CANCELAMENTO_SOLICITADO' }), job({ status: 'CANCELADO', currentStep: 'FINALIZADO' })] });
  await selecionar(t);
  t.browser.click(t.browser.by.id(t.browser.root, 'pros-start-job'));
  await t.browser.flush(8);
  t.browser.click(t.browser.by.id(t.browser.root, 'pros-cancel-job'));
  await t.browser.flush(8);
  assert.deepEqual(t.chamadas.filter(([nome]) => nome === 'cancel'), [['cancel', 'JOB-20261006-001']]);
  assert.match(t.tela(), /Cancelando…/);
  assert.equal(t.browser.by.id(t.browser.root, 'pros-cancel-job').disabled, true, 'não dá para pedir duas vezes');
  await t.rodarAgendada();
  await t.rodarAgendada();
  assert.match(t.tela(), /PROSPECÇÃO CANCELADA/);

  const ingerindo = await montar({ jobs: [job({ currentStep: 'INGERINDO', progress: 95 })] });
  await selecionar(ingerindo);
  assert.match(ingerindo.tela(), /Enviando para a aprovação/);
  assert.equal(ingerindo.browser.by.id(ingerindo.browser.root, 'pros-cancel-job'), null, 'depois que a ingestão começa, não se cancela');
});

test('[DASH-JOB-6] recuperação após refresh: ao abrir a tela com uma prospecção ativa no servidor, ela é selecionada sozinha e o acompanhamento volta (sem clicar em nada)', async () => {
  const t = await montar({ jobs: [job({ currentStep: 'VALIDANDO', progress: 40, candidatesDiscovered: 5, candidatesValidated: 1 })], respostas: [job({ status: 'CONCLUIDO', currentStep: 'FINALIZADO', progress: 100, candidatesValidated: 3 })] });
  await t.browser.flush(8);
  assert.match(t.tela(), /Em execução/);
  assert.match(t.tela(), /Validadas pela página: 1/);
  assert.equal(t.browser.by.id(t.browser.root, 'pros-start-job'), null);
  await t.rodarAgendada();
  assert.match(t.tela(), /PROSPECÇÃO CONCLUÍDA/);

  const parado = await montar({ jobs: [] });
  await parado.browser.flush(8);
  assert.equal(parado.proximaAgendada(), undefined, 'sem job ativo nada é agendado');
});

test('[DASH-JOB-7] brief em RASCUNHO não tem o botão; sem permissão a tela nem mostra o botão; o brief PESQUISANDO (sem job) NÃO oferece iniciar outra prospecção', async () => {
  const rascunho = await montar({ briefs: [{ ...BRIEF, status: 'RASCUNHO' }] });
  await selecionar(rascunho);
  assert.equal(rascunho.browser.by.id(rascunho.browser.root, 'pros-start-job'), null);
  assert.equal(rascunho.browser.by.id(rascunho.browser.root, 'pros-manual'), null, 'RASCUNHO não tem nada a pesquisar nem pacote: sem modo manual');

  const pesquisando = await montar({ briefs: [{ ...BRIEF, status: 'PESQUISANDO' }] });
  await selecionar(pesquisando);
  assert.equal(pesquisando.browser.by.id(pesquisando.browser.root, 'pros-start-job'), null, 'PESQUISANDO não inicia um novo job (máquina de estados explícita)');

  const sem = await montar({ canPropose: false });
  assert.match(sem.tela(), /não pode usar o Workbench/);
  assert.equal(sem.browser.by.id(sem.browser.root, 'pros-start-job'), null);
});

test('[DASH-JOB-7b] com prospecção AUTOMÁTICA (job ativo ou terminado) a tela mostra SÓ o fluxo automático: nenhum pacote JSON, nenhum "copiar", nenhuma ingestão manual e nenhum "Modo manual"', async () => {
  const comPacote = { ...BRIEF, status: 'PESQUISANDO', pacotePesquisa: { objetivo: 'x', formatoEsperado: { rawFindings: [] } }, pacoteGeradoEm: '2026-10-06T12:00:00.000Z' };
  for (const estado of [job(), job({ status: 'PARCIAL', currentStep: 'FINALIZADO', progress: 100 }), job({ status: 'CONCLUIDO', currentStep: 'FINALIZADO', progress: 100, candidatesValidated: 3 })]) {
    const t = await montar({ briefs: [comPacote], jobs: [estado] });
    await selecionar(t);
    assert.equal(t.browser.by.id(t.browser.root, 'pros-manual'), null, estado.status);
    assert.equal(t.browser.by.id(t.browser.root, 'pros-findings'), null, 'sem o campo de colar JSON');
    assert.equal(t.browser.by.tag(t.browser.root, 'textarea').filter((el) => el.id !== 'pros-observacoes').length, 0, 'nenhum textarea de pacote nem de achados');
    assert.doesNotMatch(t.tela(), /Pacote de pesquisa|copie e cole|Ingerir achados|Gerar pacote|formatoEsperado|rawFindings|\{/);
  }
});

test('[DASH-JOB-7c] MODO MANUAL: sem job, um bloco discreto e recolhido; ao abrir, o fluxo antigo continua disponível (gerar pacote; pacote existente; colar achados) — e o pacote antigo de um brief só aparece aí', async () => {
  const pronto = await montar({ briefs: [BRIEF] });
  await selecionar(pronto);
  assert.ok(pronto.browser.by.id(pronto.browser.root, 'pros-start-job'), 'o automático é o caminho principal');
  const alternar = pronto.browser.by.id(pronto.browser.root, 'pros-manual-toggle');
  assert.equal(alternar.textContent, 'Modo manual');
  assert.equal(pronto.browser.by.text(pronto.browser.root, 'Gerar pacote de pesquisa', 'button'), null, 'recolhido: nenhum botão do fluxo antigo à vista');
  pronto.browser.click(alternar);
  await pronto.browser.flush(4);
  assert.ok(pronto.browser.by.text(pronto.browser.root, 'Gerar pacote de pesquisa', 'button'), 'aberto: o fluxo manual segue disponível');
  assert.equal(pronto.browser.by.id(pronto.browser.root, 'pros-manual-toggle').textContent, 'Ocultar modo manual');

  const pesquisando = await montar({ briefs: [{ ...BRIEF, status: 'PESQUISANDO', pacotePesquisa: { objetivo: 'x' } }] });
  await selecionar(pesquisando);
  assert.equal(pesquisando.browser.by.id(pesquisando.browser.root, 'pros-findings'), null, 'recolhido');
  pesquisando.browser.click(pesquisando.browser.by.id(pesquisando.browser.root, 'pros-manual-toggle'));
  await pesquisando.browser.flush(4);
  assert.ok(pesquisando.browser.by.id(pesquisando.browser.root, 'pros-findings'), 'a ingestão manual continua possível no modo manual');
  assert.match(pesquisando.tela(), /Pacote de pesquisa/);
});

test('[DASH-JOB-7d] o resultado por empresa (sem JSON): Validada/Não verificada, site oficial encontrado ou não, e só os canais públicos CONFIRMADOS', async () => {
  const candidatos = [
    { nome: 'Clínica Alfa', resultado: 'VALIDADO', siteOficial: { status: 'ENCONTRADO', url: 'https://alfa.com.br/' }, entrega: { naFila: true, estadoOperacional: 'VALIDADO_PARA_REVISAO' }, presencaDigital: { instagram: { status: 'ENCONTRADO', url: 'https://www.instagram.com/alfa', confirmacao: 'CONFIRMADO' }, facebook: { status: 'ENCONTRADO', url: 'https://www.facebook.com/alfa', confirmacao: 'NAO_CONFIRMADO' }, googleMeuNegocio: { status: 'ENCONTRADO', url: 'https://g.page/alfa', confirmacao: 'CONFIRMADO' } } },
    { nome: 'Instituto Granja', resultado: 'VALIDADO', siteOficial: { status: 'NAO_ENCONTRADO', url: null }, presencaDigital: {}, entrega: { naFila: false, estadoOperacional: 'DADOS_INSUFICIENTES', motivo: 'DADOS_INSUFICIENTES' } },
    { nome: 'Clínica Fora', resultado: 'NAO_VERIFICADO', siteOficial: { status: 'NAO_ENCONTRADO', url: null } },
  ];
  const t = await montar({ respostas: [job({ status: 'CONCLUIDO', currentStep: 'FINALIZADO', progress: 100, candidatesValidated: 2, candidatos })] });
  await selecionar(t);
  t.browser.click(t.browser.by.id(t.browser.root, 'pros-start-job'));
  await t.browser.flush(8);
  await t.rodarAgendada();
  const tabela = t.browser.by.id(t.browser.root, 'pros-job-candidates');
  assert.ok(tabela);
  const linhas = t.browser.by.tag(tabela, 'tr').slice(1).map((linha) => t.browser.by.tag(linha, 'td').map((celula) => celula.textContent));
  assert.deepEqual(linhas, [['Clínica Alfa', 'Não verificado', 'Validada', 'Encontrado', 'Instagram, Google Meu Negócio', 'Na fila'], ['Instituto Granja', 'Não verificado', 'Validada', 'Não encontrado', '—', 'Fora da fila: Dados insuficientes'], ['Clínica Fora', 'Não verificado', 'Não verificada', 'Não encontrado', '—', '—']]);
  assert.doesNotMatch(t.tela(), /https:\/\/|\{|"status"/, 'nenhuma URL técnica nem JSON na tabela');
});
test('[DASH-JOB-8] destroy() para o acompanhamento (trocar de tela não deixa consulta pendurada) e falhas passageiras de rede não derrubam a tela', async () => {
  const t = await montar({ respostas: [job()] });
  await selecionar(t);
  t.browser.click(t.browser.by.id(t.browser.root, 'pros-start-job'));
  await t.browser.flush(8);
  const pendente = t.proximaAgendada();
  assert.ok(pendente);
  t.view.destroy();
  assert.equal(pendente.cancelada, true);

  const instavel = await montar({ respostas: [job()] });
  await selecionar(instavel);
  instavel.browser.click(instavel.browser.by.id(instavel.browser.root, 'pros-start-job'));
  await instavel.browser.flush(8);
  const original = instavel.api.getProspectingJobStatus;
  let falhas = 0;
  instavel.api.getProspectingJobStatus = async (id) => {
    falhas += 1;
    if (falhas <= 2) throw Object.assign(new Error('rede'), { status: 503 });
    return original(id);
  };
  await instavel.rodarAgendada();
  await instavel.rodarAgendada();
  assert.ok(instavel.proximaAgendada(), 'duas falhas seguidas ainda não desistem');
  await instavel.rodarAgendada();
  assert.match(instavel.tela(), /Em execução/);
});

test('[DASH-JOB-9] nenhum dado externo vira HTML: nomes e erros entram só como texto (a tela do job não usa innerHTML) e nenhum elemento tem estilo inline', async () => {
  const t = await montar({ respostas: [job({ status: 'ERRO', currentStep: 'FINALIZADO', error: { code: '<img src=x onerror=alert(1)>', message: '<script>alert(1)</script>' } })] });
  await selecionar(t);
  t.browser.click(t.browser.by.id(t.browser.root, 'pros-start-job'));
  await t.browser.flush(8);
  await t.rodarAgendada();
  assert.equal(t.browser.by.tag(t.browser.root, 'script').length + t.browser.by.tag(t.browser.root, 'img').length, 0);
  assert.doesNotMatch(t.tela(), /<img|<script|alert\(1\)/);
  assert.match(t.tela(), /A prospecção falhou por um erro interno/);
});

test('[DASH-JOB-REP] reposição (2.2): durante a execução mostra "Leads na Approval Queue: N de Q", os candidatos processados e as reposições; ao terminar, "Reposições realizadas: N" de forma discreta (só se houve)', async () => {
  const t = await montar({
    respostas: [
      job({ currentStep: 'VALIDANDO', progress: 60, candidatesDiscovered: 9, candidatesValidated: 3, candidatesRejected: 4, leadsNaFila: 2, telemetria: { reposicoesRealizadas: 1 } }),
      job({ status: 'PARCIAL', currentStep: 'FINALIZADO', progress: 100, candidatesDiscovered: 12, candidatesValidated: 4, candidatesRejected: 8, leadsNaFila: 2, telemetria: { reposicoesRealizadas: 2 }, lote: { loteId: 'lote:z', validadosPeloMotor: 4, naFila: 2, foraDaFila: 2 } }),
    ],
  });
  await selecionar(t);
  t.browser.click(t.browser.by.id(t.browser.root, 'pros-start-job'));
  await t.browser.flush(8);
  await t.rodarAgendada();
  assert.equal(t.browser.by.id(t.browser.root, 'pros-job-queue').textContent, 'Leads na Approval Queue: 2 de 3 · Candidatos processados: 7 · Reposições: 1');
  assert.equal(t.browser.by.id(t.browser.root, 'pros-job-replenish'), null, 'em execução não há o resumo final');
  await t.rodarAgendada();
  assert.match(t.tela(), /2 de 3 lead\(s\) solicitado\(s\) chegaram à Approval Queue/);
  assert.equal(t.browser.by.id(t.browser.root, 'pros-job-replenish').textContent, 'Reposições realizadas: 2');

  const sem = await montar({ respostas: [job({ status: 'CONCLUIDO', currentStep: 'FINALIZADO', progress: 100, candidatesValidated: 3, leadsNaFila: 3, lote: { loteId: 'lote:w', validadosPeloMotor: 3, naFila: 3, foraDaFila: 0 } })] });
  await selecionar(sem);
  sem.browser.click(sem.browser.by.id(sem.browser.root, 'pros-start-job'));
  await sem.browser.flush(8);
  await sem.rodarAgendada();
  assert.equal(sem.browser.by.id(sem.browser.root, 'pros-job-replenish'), null, 'sem reposição nada é mostrado');
});

test('[DASH-JOB-3.0] resultado padronizado, máximo de candidatos (padrão 50, até 100) e REFAZER PROSPECÇÃO (sem CANCELAR depois de terminar)', async () => {
  const resumo = { solicitados: 3, limiteDeCandidatos: 50, candidatosProcessados: 8, descobertos: 9, novos: 8, repetidos: 1, validados: 4, naoValidados: 4, naApprovalQueue: 3, jaExistentes: 1, dadosInsuficientes: 0, duplicados: 0, dnc: 0, reposicoes: 1, enriquecidos: 3, tempoMs: 98000, custoUsd: 0.31, aprovados: 1, rejeitados: 0, promovidos: 0 };
  const t = await montar({ respostas: [job({ status: 'CONCLUIDO', currentStep: 'FINALIZADO', progress: 100, candidatesDiscovered: 9, candidatesValidated: 4, candidatesRejected: 4, elapsedMs: 98000, resumo, lote: { loteId: 'lote:x', naFila: 3, foraDaFila: 1 } })] });
  await selecionar(t);
  assert.equal(t.browser.by.tag(t.browser.root, 'input').filter((el) => el.id === 'pros-max-candidates').length, 1, 'um único campo de máximo (no formulário), nenhum duplicado no bloco de iniciar');
  t.browser.click(t.browser.by.id(t.browser.root, 'pros-start-job'));
  await t.browser.flush(8);
  assert.deepEqual(t.chamadas.filter(([nome]) => nome === 'max'), [['max', 50]]);
  await t.rodarAgendada();

  const resumoNaTela = t.browser.by.id(t.browser.root, 'pros-job-summary');
  assert.ok(resumoNaTela);
  const texto = resumoNaTela.textContent.replace(/\s+/g, ' ');
  for (const rotulo of ['Solicitados', 'Candidatos processados', 'Validados', 'Na Approval Queue', 'Já existentes', 'Dados insuficientes', 'Duplicados', 'DNC', 'Reposições', 'Tempo', 'Custo das pesquisas']) assert.ok(texto.includes(rotulo), rotulo);
  assert.equal(t.browser.by.id(t.browser.root, 'pros-cancel-job'), null, 'sem CANCELAR depois de terminar');

  t.browser.click(t.browser.by.id(t.browser.root, 'pros-redo-job'));
  await t.browser.flush(8);
  assert.deepEqual(t.chamadas.filter(([nome]) => nome === 'redo'), [['redo', 'JOB-20261006-001']]);
  assert.match(t.tela(), /Em execução/, 'a tela passa a acompanhar o job novo');
  assert.equal(t.browser.by.id(t.browser.root, 'pros-redo-job'), null, 'o job novo está ativo: sem refazer');
  assert.ok(t.browser.by.id(t.browser.root, 'pros-cancel-job'), 'e agora, ativo, pode ser cancelado');

});

// ---- MÁXIMO DE CANDIDATOS no formulário "Novo lote" -------------------------------------------------------------------------------------------------------------
async function preencher(t, { quantidade, maximo }) {
  const raiz = t.browser.root;
  t.browser.type(t.browser.by.id(raiz, 'pros-nicho'), 'Clínicas de estética');
  t.browser.type(t.browser.by.id(raiz, 'pros-locais'), 'Petrópolis/RJ');
  if (quantidade !== undefined) t.browser.type(t.browser.by.id(raiz, 'pros-quantidade'), String(quantidade));
  if (maximo !== undefined) t.browser.type(t.browser.by.id(raiz, 'pros-max-candidates'), String(maximo));
}
const criarLote = async (t) => {
  t.browser.click(t.browser.by.text(t.browser.root, 'Criar lote', 'button'));
  await t.browser.flush(10);
};

test('[DASH-MAXCAND-1] o campo MÁXIMO DE CANDIDATOS aparece no formulário, ao lado da quantidade desejada, com mín. 1, máx. 100, padrão 50 e o texto auxiliar', async () => {
  const t = await montar({ briefs: [] });
  const campo = t.browser.by.id(t.browser.root, 'pros-max-candidates');
  assert.ok(campo);
  assert.deepEqual([campo.getAttribute('type'), campo.getAttribute('min'), campo.getAttribute('max'), campo.value], ['number', '1', '100', '50']);
  assert.ok(t.browser.by.text(t.browser.root, 'MÁXIMO DE CANDIDATOS (1–100)', 'label'));
  assert.equal(t.browser.by.id(t.browser.root, 'pros-max-candidates-help').textContent, 'Máximo de candidatos que o motor poderá processar nesta prospecção. A execução pode terminar antes quando atingir a quantidade desejada.');
  const quantidade = t.browser.by.id(t.browser.root, 'pros-quantidade');
  assert.equal(quantidade.value, '50', 'a quantidade desejada continua com o seu campo e o seu padrão');
  assert.equal(quantidade.getAttribute('max'), '300', 'e com o seu limite (1–300), diferente do máximo de candidatos');
  assert.equal(campo.parentNode.parentNode, quantidade.parentNode.parentNode, 'os dois campos ficam lado a lado na mesma grade do formulário');
});

test('[DASH-MAXCAND-2] quantidade 3 + máximo 10: o lote é criado só com os campos do brief (quantidade 3) e a prospecção iniciada leva maxCandidates = 10 (quantidade e máximo nunca se confundem)', async () => {
  const t = await montar({ briefs: [] });
  await preencher(t, { quantidade: 3, maximo: 10 });
  await criarLote(t);
  const criacao = t.chamadas.filter(([nome]) => nome === 'create');
  assert.equal(criacao.length, 1);
  assert.equal(criacao[0][1].quantidade, 3);
  assert.equal('maxCandidates' in criacao[0][1], false, 'o brief não conhece maxCandidates (a API de briefs recusa campos desconhecidos)');
  assert.deepEqual(Object.keys(criacao[0][1]).sort(), ['cidades', 'nicho', 'nivelGeografico', 'quantidade']);

  t.browser.click(t.browser.by.id(t.browser.root, 'pros-start-job'));
  await t.browser.flush(8);
  assert.deepEqual(t.chamadas.filter(([nome]) => nome === 'start'), [['start', 'PROS-20261008-009']]);
  assert.deepEqual(t.chamadas.filter(([nome]) => nome === 'max'), [['max', 10]], 'maxCandidates = 10 chega à API');
});

test('[DASH-MAXCAND-3] aceita 1 a 100 (inclusive os limites); 0, 101, vazio e decimal são recusados na tela, sem criar lote nem chamar a API', async () => {
  for (const [maximo, esperado] of [[1, 1], [100, 100], [50, 50]]) {
    const t = await montar({ briefs: [] });
    await preencher(t, { quantidade: 3, maximo });
    await criarLote(t);
    t.browser.click(t.browser.by.id(t.browser.root, 'pros-start-job'));
    await t.browser.flush(8);
    assert.deepEqual(t.chamadas.filter(([nome]) => nome === 'max'), [['max', esperado]], String(maximo));
  }
  for (const invalido of ['0', '101', '', '7.5', '-3']) {
    const t = await montar({ briefs: [] });
    await preencher(t, { quantidade: 3, maximo: invalido });
    await criarLote(t);
    assert.deepEqual(t.chamadas.filter(([nome]) => nome === 'create'), [], `"${invalido}" não cria o lote`);
    assert.match(t.tela(), /máximo de candidatos entre 1 e 100/);
  }
});

test('[DASH-MAXCAND-4] sem mexer no campo o padrão 50 é enviado; os demais campos do formulário seguem como antes (nicho, locais, quantidade) e o formulário volta ao padrão depois de criar', async () => {
  const t = await montar({ briefs: [] });
  await preencher(t, { quantidade: 7 });
  await criarLote(t);
  const [, campos] = t.chamadas.find(([nome]) => nome === 'create');
  assert.deepEqual({ nicho: campos.nicho, nivelGeografico: campos.nivelGeografico, quantidade: campos.quantidade, cidades: campos.cidades }, { nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', quantidade: 7, cidades: 'Petrópolis/RJ' });
  t.browser.click(t.browser.by.id(t.browser.root, 'pros-start-job'));
  await t.browser.flush(8);
  assert.deepEqual(t.chamadas.filter(([nome]) => nome === 'max'), [['max', 50]]);
  assert.equal(t.browser.by.id(t.browser.root, 'pros-max-candidates').value, '50', 'o formulário volta ao padrão depois de criar');
  assert.equal(t.browser.by.id(t.browser.root, 'pros-quantidade').value, '50');
});
