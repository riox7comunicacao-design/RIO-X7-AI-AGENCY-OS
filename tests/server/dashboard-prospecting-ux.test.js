// Nova Prospecção na UX 4.0.5: TRÊS ABAS (Nova pesquisa, Briefings salvos, Em andamento); o assistente em 3 etapas (O que prospectar → Onde e quanto → Revisar e iniciar) com validação
// por etapa; criar o briefing SÓ ao salvar ou ao confirmar o início; contrato briefing (sem maxCandidates) + job (briefId + maxCandidates); confirmação humana antes de iniciar;
// a lista de briefings salvos e a gaveta do briefing (ESC, X, Voltar, Avançar, link direto); em andamento com etapas reais e acompanhamento moderado que PARA quando não é mais
// necessário; a gaveta da execução; permissões; o painel completo; layout responsivo. DOM de teste e API falsa — nenhum navegador, nenhuma rede, nenhum Claude, nenhuma
// prospecção real, nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');

const loadView = () => import('../../dashboard/views/prospecting.mjs');
const loadRouter = () => import('../../dashboard/router.mjs');
const loadUi = () => import('../../dashboard/ui/index.mjs');
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
const POLL = 4000;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------------------------------------
const BRIEF = { id: 'PROS-20261006-001', status: 'PRONTO_PARA_PESQUISA', nicho: 'Clínicas de estética', subnicho: 'Harmonização', nivelGeografico: 'CIDADE', cidades: ['Petrópolis/RJ'], quantidade: 3, observacoes: null, pacotePesquisa: null, loteRealId: null, contagens: null, criadoEm: '2026-10-06T12:00:00.000Z' };
const BRIEF2 = { ...BRIEF, id: 'PROS-20261007-002', nicho: 'Psicologia', subnicho: undefined, cidades: ['Niterói/RJ'], quantidade: 5, status: 'AGUARDANDO_REVISAO', criadoEm: '2026-10-07T12:00:00.000Z' };

const cand = (nome, extras = {}) => ({ nome, url: `https://${nome.toLowerCase().replace(/[^a-z]/g, '')}.example.com.br/`, resultado: 'VALIDADO', empresa: nome, nicho: 'Estética', localizacao: 'Petrópolis/RJ', tipoLead: 'EMPRESA', siteOficial: { status: 'ENCONTRADO', url: `https://${nome.toLowerCase().replace(/[^a-z]/g, '')}.example.com.br/` }, presencaDigital: {}, fontesDescoberta: [{ url: 'https://diretorio.example.com.br/lista', tipo: 'DIRETORIO' }], ...extras });
const CANDIDATOS = [
  cand('Clínica Alfa', { entrega: { naFila: true, estadoOperacional: 'AGUARDANDO_REVISAO' } }),
  cand('Clínica Beta', { entrega: { naFila: false, estadoOperacional: 'DADOS_INSUFICIENTES', motivo: 'DADOS_INSUFICIENTES' } }),
  cand('Clínica Gama', { entrega: { naFila: false, jaExistiaNaFila: true, estadoOperacional: 'VALIDADO_PARA_REVISAO' } }),
  cand('Clínica Delta', { resultado: 'NAO_VERIFICADO', motivo: 'PAGINA_INACESSIVEL', causa: 'TLS', faltando: ['empresa', 'nicho', 'localizacao'] }),
  cand('Excluída Ltda', { resultado: 'DESCARTADO', motivo: 'EXCLUSAO_PERMANENTE' }),
];
const job = (extras = {}) => ({ id: 'JOB-20261006-001', briefId: BRIEF.id, status: 'EXECUTANDO', currentStep: 'DESCOBRINDO', progress: 15, requestedQuantity: 3, candidatesDiscovered: 0, candidatesValidated: 0, candidatesRejected: 0, leadsNaFila: 0, elapsedMs: 0, createdAt: '2026-10-06T12:00:00.000Z', startedAt: '2026-10-06T12:00:05.000Z', criadoPor: { name: 'Rafael Closer', role: 'COMMERCIAL_CLOSER' }, error: null, ...extras });
const jobFinal = (extras = {}) => job({ status: 'CONCLUIDO', currentStep: 'FINALIZADO', progress: 100, candidatesDiscovered: 5, candidatesValidated: 3, candidatesRejected: 2, leadsNaFila: 1, elapsedMs: 98000, finishedAt: '2026-10-06T12:01:40.000Z', candidatos: CANDIDATOS, lote: { loteId: 'lote:x', naFila: 1, foraDaFila: 1, jaEstavamNaFila: 1, prospectIds: ['id:alfa'] }, telemetria: { custoUsd: 0.31, webSearchRequests: 4, eventos: [{ codigo: 'CICLO_SEM_NOVOS', ciclo: 1 }] }, resumo: { solicitados: 3, descobertos: 5, candidatosProcessados: 5, validados: 3, naoValidados: 2, naApprovalQueue: 1, jaExistentes: 1, dadosInsuficientes: 1, duplicados: 0, dnc: 0, repetidos: 0, aprovados: 0, rejeitados: 0, promovidos: 0, tempoMs: 98000, custoUsd: 0.31 }, ...extras });

const agenda = () => {
  const tarefas = [];
  return {
    tarefas,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelada: false, feita: false };
      tarefas.push(t);
      return () => { t.cancelada = true; };
    },
    pendentes: () => tarefas.filter((t) => t.ms === POLL && !t.cancelada && !t.feita),
    async rodar() {
      const t = this.pendentes().at(-1);
      if (!t) return false;
      t.feita = true;
      await t.fn();
      return true;
    },
  };
};

// API falsa com o "servidor" mutável e o registro de tudo o que foi pedido: a tela só pode ler, criar o briefing e — depois de confirmar — marcar pronto/iniciar/refazer.
function apiFalsa({ briefs = [BRIEF], jobs = [], respostas = [], criar, iniciar, refazer, cancelar, statusNovo = 'RASCUNHO' } = {}) {
  const chamadas = [];
  const mem = { briefs: [...briefs], jobs: [...jobs], respostas: [...respostas] };
  const api = {
    chamadas,
    mem,
    listProspectingBriefs: async () => { chamadas.push(['briefs']); if (mem.falharBriefs) throw Object.assign(new Error('x'), { status: 500 }); return { items: [...mem.briefs] }; },
    createProspectingBrief: async (fields) => {
      chamadas.push(['create', fields]);
      if (criar) return criar(fields, mem);
      const novo = { ...BRIEF, id: `PROS-20261008-0${String(9 + mem.briefs.length).padStart(2, '0')}`, ...fields, status: statusNovo, cidades: [fields.cidades], contagens: null, criadoEm: '2026-10-08T12:00:00.000Z' };
      mem.briefs = [novo, ...mem.briefs];
      return { item: novo };
    },
    getProspectingBrief: async (id) => { chamadas.push(['brief', id]); return { item: mem.briefs.find((b) => b.id === id) }; },
    listProspectingJobs: async (briefId) => { chamadas.push(['jobs', briefId]); return { items: mem.jobs.filter((j) => briefId === undefined || j.briefId === briefId) }; },
    markProspectingBriefReady: async (id) => { chamadas.push(['ready', id]); mem.briefs = mem.briefs.map((b) => (b.id === id ? { ...b, status: 'PRONTO_PARA_PESQUISA' } : b)); return { item: {} }; },
    startProspectingJob: async (briefId, maxCandidates) => {
      chamadas.push(['start', briefId, maxCandidates]);
      if (iniciar) return iniciar(briefId, maxCandidates, mem);
      const criado = job({ briefId });
      mem.jobs = [criado, ...mem.jobs];
      return { item: criado };
    },
    redoProspectingJob: async (id) => {
      chamadas.push(['redo', id]);
      if (refazer) return refazer(id, mem);
      const criado = job({ id: 'JOB-20261006-009' });
      mem.jobs = [criado, ...mem.jobs];
      return { item: criado };
    },
    getProspectingJobStatus: async (id) => {
      chamadas.push(['status', id]);
      if (mem.falharStatus) throw Object.assign(new Error('rede'), { status: 503 });
      const item = mem.respostas.length > 1 ? mem.respostas.shift() : mem.respostas[0];
      mem.jobs = [item, ...mem.jobs.filter((j) => j.id !== item.id)];
      return { item };
    },
    cancelProspectingJob: async (id) => { chamadas.push(['cancel', id]); return cancelar ? cancelar(id, mem) : { item: job({ status: 'CANCELAMENTO_SOLICITADO', cancelRequested: true }) }; },
    cancelProspectingBrief: async (id) => { chamadas.push(['cancelBrief', id]); mem.briefs = mem.briefs.map((b) => (b.id === id ? { ...b, status: 'CANCELADO' } : b)); return { item: {} }; },
    concludeProspectingBrief: async () => ({ item: {} }),
    getProspectingBatch: async () => ({ item: { resultados: [] } }),
    // qualquer uma destas seria um defeito: esta tela não aprova, não rejeita, não reconsidera e não pesquisa leads
    approve: async () => { chamadas.push(['approve']); throw new Error('não aprova'); },
    reject: async () => { chamadas.push(['reject']); throw new Error('não rejeita'); },
    reapproveLead: async () => { chamadas.push(['reaprovar']); throw new Error('não reconsidera'); },
    completeLeadResearch: async () => { chamadas.push(['pesquisar']); throw new Error('não pesquisa'); },
  };
  return api;
}

async function abrir({ api, canPropose = true, comNavegacao = false, hash = '', mostrar = true } = {}) {
  const { createProspectingView } = await loadView();
  const { createDataBus } = await loadUi();
  const { browserNavigation, parseRoute } = await loadRouter();
  const browser = createBrowser({ hash });
  const ag = agenda();
  const bus = createDataBus();
  const eventos = [];
  bus.subscribe('prospecting:changed', (p) => eventos.push([p.action, p.jobId]));
  const navigation = comNavegacao ? browserNavigation(browser.window) : null;
  const view = createProspectingView({ document: browser.document, root: browser.root, api, permissions: { canProposeLead: canPropose }, schedule: ag.schedule, bus, ...(navigation ? { navigation } : {}) });
  if (navigation) navigation.subscribe(() => view.show(parseRoute(navigation.current())));
  const s = { browser, view, api, ag, bus, eventos, navigation };
  if (mostrar) {
    if (comNavegacao) await view.show(parseRoute(navigation.current()));
    else await view.show({ name: 'prospecting' });
  }
  await browser.flush(6);
  return s;
}

const raiz = (s) => s.browser.root;
const porId = (s, id) => s.browser.by.id(raiz(s), id);
const digitar = (s, id, texto) => s.browser.type(porId(s, id), texto);
const conta = (s, nome) => s.api.chamadas.filter(([n]) => n === nome).length;
const nomes = (s) => s.api.chamadas.map(([n]) => n);
const avisos = (s) => s.browser.findAll(raiz(s), (el) => el.className === 'toast-message').map((el) => el.textContent);
const gaveta = (s) => s.browser.find(raiz(s), (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const modal = (s) => s.browser.find(raiz(s), (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className));
const botaoConfirmar = (s) => s.browser.find(raiz(s), (el) => el.getAttribute('data-action') === 'confirm');
const clicar = async (s, el) => { s.browser.click(el); await s.browser.flush(6); };
const tela = (s) => raiz(s).textContent.replace(/\s+/g, ' ');
const abaBotao = (s, chave) => s.browser.find(raiz(s), (el) => el.getAttribute('role') === 'tab' && el.getAttribute('data-tab') === chave && /^pros-tab-/.test(el.id));
const painelAba = (s, chave) => porId(s, `pros-panel-${chave}`);
const aba = async (s, chave) => { await clicar(s, abaBotao(s, chave)); };
const abaAtiva = (s) => s.browser.find(raiz(s), (el) => el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true' && /^pros-tab-/.test(el.id)).getAttribute('data-tab');
const erroDe = (s, id) => porId(s, `${id}-error`);
const proximo = async (s) => { await clicar(s, porId(s, 'pros-next')); };
const etapaAtual = (s) => Number(s.browser.find(raiz(s), (el) => /\bwizard-step-item\b/.test(el.className) && el.getAttribute('aria-current') === 'step').getAttribute('data-wizard-step'));
// preenche o assistente até a etapa 3
const ate3 = async (s, extras = {}) => {
  digitar(s, 'pros-nicho', extras.nicho || 'Clínicas de estética');
  if (extras.subnicho) digitar(s, 'pros-subnicho', extras.subnicho);
  if (extras.observacoes) digitar(s, 'pros-observacoes', extras.observacoes);
  await proximo(s);
  digitar(s, 'pros-locais', extras.locais || 'Petrópolis, Teresópolis');
  if (extras.quantidade !== undefined) digitar(s, 'pros-quantidade', String(extras.quantidade));
  if (extras.maximo !== undefined) digitar(s, 'pros-max-candidates', String(extras.maximo));
  await proximo(s);
};
const abrirBriefing = async (s, id = BRIEF.id) => { await aba(s, 'briefings'); await clicar(s, s.browser.by.button(raiz(s), id)); };
const painelDaAbaGaveta = (s, chave) => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tabpanel' && new RegExp(chave).test(el.getAttribute('aria-labelledby') || ''));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// ABAS
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[PROS-UX-1] as TRÊS ABAS (Nova pesquisa, Briefings salvos, Em andamento): a selecionada é identificada (aria-selected); trocar de aba não recarrega nada nem chama a API; o formulário e a lista são os MESMOS elementos', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [BRIEF, BRIEF2] }) });
  const tablist = s.browser.find(raiz(s), (el) => el.getAttribute('role') === 'tablist');
  assert.equal(tablist.getAttribute('aria-label'), 'Seções da Nova Prospecção');
  assert.deepEqual(['nova', 'briefings', 'andamento'].map((k) => abaBotao(s, k).textContent.replace(/\d+$/, '')), ['Nova pesquisa', 'Briefings salvos', 'Em andamento']);
  assert.equal(abaAtiva(s), 'nova');
  assert.equal(painelAba(s, 'nova').hidden, false);
  assert.equal(painelAba(s, 'briefings').hidden, true);
  assert.equal(painelAba(s, 'andamento').hidden, true);
  assert.match(s.browser.find(raiz(s), (el) => /\btabs-main\b/.test(el.className)).className, /tabs-main/);

  const chamadasAntes = s.api.chamadas.length;
  const nicho = porId(s, 'pros-nicho');
  digitar(s, 'pros-nicho', 'Meu rascunho');
  const linhas = s.browser.by.tag(raiz(s), 'tbody')[0];
  await aba(s, 'briefings');
  assert.equal(abaAtiva(s), 'briefings');
  assert.equal(painelAba(s, 'briefings').hidden, false);
  assert.equal(painelAba(s, 'nova').hidden, true);
  await aba(s, 'andamento');
  assert.equal(abaAtiva(s), 'andamento');
  await aba(s, 'nova');
  assert.equal(s.api.chamadas.length, chamadasAntes, 'trocar de aba não chama a API');
  assert.equal(porId(s, 'pros-nicho') === nicho, true, 'o formulário é o mesmo elemento (foco e texto ficam)');
  assert.equal(nicho.value, 'Meu rascunho');
  assert.equal(s.browser.by.tag(raiz(s), 'tbody')[0] === linhas, true, 'a lista não foi recriada');

  // teclado: setas e Home/End movem a aba
  abaBotao(s, 'nova').focus();
  s.browser.press('ArrowRight');
  assert.equal(abaAtiva(s), 'briefings');
  s.browser.press('End');
  assert.equal(abaAtiva(s), 'andamento');
  s.browser.press('Home');
  assert.equal(abaAtiva(s), 'nova');
});

test('[PROS-UX-2] os CONTADORES nas abas: briefings salvos, prospecções em andamento e "rascunho" quando há alterações não salvas', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [BRIEF, BRIEF2], jobs: [job()], respostas: [job()] }) });
  assert.equal(abaBotao(s, 'briefings').textContent, 'Briefings salvos2');
  assert.equal(abaBotao(s, 'andamento').textContent, 'Em andamento1');
  assert.equal(abaBotao(s, 'nova').textContent, 'Nova pesquisa');
  await aba(s, 'nova');
  digitar(s, 'pros-nicho', 'Algo');
  assert.equal(abaBotao(s, 'nova').textContent, 'Nova pesquisarascunho');
  s.browser.type(porId(s, 'pros-nicho'), '');
  assert.equal(abaBotao(s, 'nova').textContent, 'Nova pesquisa', 'sem alterações: sem aviso');
  const vazio = await abrir({ api: apiFalsa({ briefs: [] }) });
  assert.equal(abaBotao(vazio, 'briefings').textContent, 'Briefings salvos');
  assert.equal(abaBotao(vazio, 'andamento').textContent, 'Em andamento');
});

test('[PROS-UX-3] a ABA INICIAL: "Nova pesquisa"; se há prospecção em andamento ao abrir, a tela vai para "Em andamento" (só LEITURA), a menos que haja rascunho ou a pessoa já tenha escolhido outra aba', async () => {
  const s = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [job()] }) });
  assert.equal(abaAtiva(s), 'andamento');
  assert.equal(conta(s, 'start'), 0);
  const quieto = await abrir({ api: apiFalsa() });
  assert.equal(abaAtiva(quieto), 'nova');
  const comRascunho = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [job()] }), mostrar: false });
  digitar(comRascunho, 'pros-nicho', 'Rascunho antes de carregar');
  await comRascunho.view.show({ name: 'prospecting' });
  await comRascunho.browser.flush(6);
  assert.equal(abaAtiva(comRascunho), 'nova', 'o rascunho da pessoa nunca é escondido');
  const escolheu = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [job()] }), mostrar: false });
  await aba(escolheu, 'briefings');
  await escolheu.view.show({ name: 'prospecting' });
  await escolheu.browser.flush(6);
  assert.equal(abaAtiva(escolheu), 'briefings', 'a escolha da pessoa é respeitada');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// O ASSISTENTE
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[PROS-UX-4] o ASSISTENTE em 3 ETAPAS: indicador da etapa atual, uma etapa por vez, botões Voltar/Próximo; valores iniciais CONSERVADORES (3 leads, 10 candidatos); passar de etapa não cria nada', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [] }) });
  const itens = s.browser.findAll(raiz(s), (el) => /\bwizard-step-item\b/.test(el.className)).map((el) => [el.getAttribute('data-wizard-step'), el.textContent.replace(/^\d/, '')]);
  assert.deepEqual(itens, [['1', 'O que prospectar'], ['2', 'Onde e quanto'], ['3', 'Revisar e iniciar']]);
  assert.equal(etapaAtual(s), 1);
  const legendas = s.browser.by.tag(porId(s, 'pros-form'), 'legend').map((el) => el.textContent);
  assert.deepEqual(legendas, ['Etapa 1 de 3 — O que prospectar', 'Etapa 2 de 3 — Onde e quanto', 'Etapa 3 de 3 — Revisar e iniciar']);
  const painel = (n) => s.browser.find(porId(s, 'pros-form'), (el) => el.localName === 'fieldset' && el.getAttribute('data-step') === String(n));
  const visiveis = () => [1, 2, 3].map((n) => !painel(n).hidden);
  assert.deepEqual(visiveis(), [true, false, false]);
  assert.equal(porId(s, 'pros-prev').hidden, true, 'etapa 1: sem Voltar');
  assert.equal(porId(s, 'pros-next').hidden, false);
  assert.equal(porId(s, 'pros-save').hidden, true);
  assert.equal(porId(s, 'pros-start-wizard').hidden, true);
  assert.deepEqual([porId(s, 'pros-quantidade').value, porId(s, 'pros-max-candidates').value], ['3', '10'], 'valores iniciais conservadores de um formulário novo');

  digitar(s, 'pros-nicho', 'Clínicas');
  await proximo(s);
  assert.equal(etapaAtual(s), 2);
  assert.deepEqual(visiveis(), [false, true, false]);
  assert.equal(porId(s, 'pros-prev').hidden, false);
  assert.equal(s.browser.document.activeElement.id, 'pros-nivel', 'o foco vai ao primeiro campo da etapa');
  digitar(s, 'pros-locais', 'Petrópolis');
  await proximo(s);
  assert.equal(etapaAtual(s), 3);
  assert.deepEqual(visiveis(), [false, false, true]);
  assert.equal(porId(s, 'pros-next').hidden, true, 'etapa 3: sem Próximo');
  assert.equal(porId(s, 'pros-save').hidden, false);
  assert.equal(porId(s, 'pros-start-wizard').hidden, false);
  await clicar(s, porId(s, 'pros-prev'));
  assert.equal(etapaAtual(s), 2);
  assert.equal(porId(s, 'pros-locais').value, 'Petrópolis', 'Voltar mantém o que foi digitado');
  await clicar(s, porId(s, 'pros-prev'));
  assert.equal(etapaAtual(s), 1);
  assert.equal(porId(s, 'pros-nicho').value, 'Clínicas');
  assert.deepEqual(nomes(s).filter((n) => ['create', 'ready', 'start'].includes(n)), [], 'passar de etapa NUNCA cria briefing nem job');
});

test('[PROS-UX-5] VALIDAÇÃO POR ETAPA: "Próximo" confere só os campos da etapa (mensagem, foco, aviso) e não avança; o erro some ao corrigir; Enter nos campos avança em vez de enviar', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [] }) });
  await proximo(s);
  assert.equal(etapaAtual(s), 1, 'etapa 1 inválida: não avança');
  assert.equal(erroDe(s, 'pros-nicho').textContent, 'Informe o nicho que será prospectado.');
  assert.equal(porId(s, 'pros-nicho').getAttribute('aria-invalid'), 'true');
  assert.equal(s.browser.document.activeElement.id, 'pros-nicho');
  assert.ok(avisos(s).includes('Revise os campos destacados antes de continuar.'));
  assert.equal(erroDe(s, 'pros-locais').hidden, true, 'os campos da etapa 2 ainda não são cobrados');
  digitar(s, 'pros-nicho', 'Clínicas');
  assert.equal(erroDe(s, 'pros-nicho').hidden, true, 'o erro some ao corrigir');
  // Enter dentro do formulário = Próximo (nunca envia nada)
  s.browser.submit(porId(s, 'pros-form'));
  await s.browser.flush(4);
  assert.equal(etapaAtual(s), 2);

  await proximo(s);
  assert.equal(etapaAtual(s), 2, 'etapa 2 inválida: não avança');
  assert.equal(erroDe(s, 'pros-locais').textContent, 'Informe ao menos uma cidade.');
  digitar(s, 'pros-quantidade', '0');
  digitar(s, 'pros-max-candidates', '101');
  await proximo(s);
  assert.match(erroDe(s, 'pros-quantidade').textContent, /inteiro de 1 a 300 leads/);
  assert.match(erroDe(s, 'pros-max-candidates').textContent, /inteiro de 1 a 100 candidatos/);
  assert.equal(s.browser.document.activeElement.id, 'pros-locais', 'o foco vai ao primeiro erro da etapa');
  s.browser.choose(porId(s, 'pros-nivel'), 'ESTADO');
  assert.equal(erroDe(s, 'pros-locais').textContent, 'Informe ao menos um estado.', 'a mensagem acompanha a abrangência');
  digitar(s, 'pros-locais', 'RJ');
  digitar(s, 'pros-quantidade', '4');
  digitar(s, 'pros-max-candidates', '12');
  await proximo(s);
  assert.equal(etapaAtual(s), 3);
  s.browser.submit(porId(s, 'pros-form'));
  await s.browser.flush(4);
  assert.equal(etapaAtual(s), 3, 'Enter na etapa 3 não faz nada (não inicia, não salva)');
  assert.equal(conta(s, 'create'), 0);
});

test('[PROS-UX-6] os LIMITES vêm do servidor (nicho/subnicho/local 120, país 60, observações 2000, 20 locais, quantidade 1–300) e o máximo de candidatos 1–100; validateStep confere só a etapa', async () => {
  const { validateForm, validateStep, BRIEF_LIMITS, MAX_CANDIDATES_MAX, MAX_CANDIDATES_MIN, DEFAULT_QUANTIDADE, DEFAULT_MAX_CANDIDATES, splitLocais, emptyForm, isDirtyForm } = await loadView();
  assert.deepEqual({ ...BRIEF_LIMITS }, { NICHO: 120, SUBNICHO: 120, LOCAL: 120, PAIS: 60, OBSERVACOES: 2000, MAX_LOCAIS: 20, QUANTIDADE_MIN: 1, QUANTIDADE_MAX: 300 });
  assert.deepEqual([MAX_CANDIDATES_MIN, MAX_CANDIDATES_MAX, DEFAULT_QUANTIDADE, DEFAULT_MAX_CANDIDATES], [1, 100, 3, 10]);
  assert.deepEqual(emptyForm(), { nicho: '', subnicho: '', nivelGeografico: 'CIDADE', locais: '', pais: 'Brasil', quantidade: '3', maxCandidates: '10', observacoes: '' });
  assert.equal(isDirtyForm(emptyForm()), false);
  assert.equal(isDirtyForm({ ...emptyForm(), nicho: 'x' }), true);
  const base = { ...emptyForm(), nicho: 'Estética', locais: 'Petrópolis' };
  const erros = (extras) => validateForm({ ...base, ...extras }).errors;
  assert.deepEqual(erros({}), {});
  assert.match(erros({ nicho: 'x'.repeat(121) }).nicho, /até 120 caracteres/);
  assert.deepEqual(erros({ nicho: 'x'.repeat(120) }), {});
  assert.match(erros({ subnicho: 'x'.repeat(121) }).subnicho, /até 120/);
  assert.match(erros({ locais: Array.from({ length: 21 }, (_, i) => `Cidade${i}`).join(',') }).locais, /no máximo 20 locais/);
  assert.deepEqual(erros({ locais: Array.from({ length: 20 }, (_, i) => `Cidade${i}`).join(',') }), {});
  assert.match(erros({ locais: 'x'.repeat(121) }).locais, /Cada local aceita até 120/);
  assert.match(erros({ nivelGeografico: 'NACIONAL', pais: 'x'.repeat(61) }).pais, /até 60/);
  assert.match(erros({ observacoes: 'x'.repeat(2001) }).observacoes, /até 2000/);
  for (const invalida of ['0', '301', '', '2.5', '-1', 'abc', ' ']) assert.match(erros({ quantidade: invalida }).quantidade || '', /inteiro de 1 a 300 leads/, `quantidade "${invalida}"`);
  for (const valida of ['1', '300', ' 7 ']) assert.equal(erros({ quantidade: valida }).quantidade, undefined, `quantidade "${valida}"`);
  for (const invalido of ['0', '101', '', '7.5']) assert.match(erros({ maxCandidates: invalido }).maxCandidates || '', /inteiro de 1 a 100 candidatos/, `máximo "${invalido}"`);
  assert.equal(erros({ maxCandidates: '100' }).maxCandidates, undefined);
  assert.deepEqual(splitLocais(' Petrópolis, petrópolis ,, Niterói '), ['Petrópolis', 'Niterói'], 'sem vazios nem repetidos (como o servidor)');
  assert.deepEqual(Object.keys(validateStep(emptyForm(), 1).errors), ['nicho']);
  assert.deepEqual(Object.keys(validateStep(emptyForm(), 2).errors), ['locais']);
  assert.equal(validateStep({ ...emptyForm(), nicho: 'x' }, 1).ok, true);
  assert.equal(validateStep({ ...emptyForm(), nicho: 'x', maxCandidates: '0' }, 1).ok, true, 'a etapa 1 não olha o máximo de candidatos');
  assert.equal(validateStep({ ...emptyForm(), locais: 'x', maxCandidates: '0' }, 2).ok, false);
});

test('[PROS-UX-7] a ETAPA 3 (Revisar e iniciar): resumo legível das escolhas, a diferença entre leads desejados e candidatos examinados, o aviso do Claude Code e que não aprova/promove/contata; o resumo acompanha as mudanças', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [] }) });
  await ate3(s, { subnicho: 'Harmonização', observacoes: 'Só com site', quantidade: 4, maximo: 12 });
  const resumo = porId(s, 'pros-summary').textContent;
  assert.match(resumo, /NichoClínicas de estética \/ Harmonização/);
  assert.match(resumo, /LocalCidade: Petrópolis, Teresópolis/);
  assert.match(resumo, /Leads novos desejados4/);
  assert.match(resumo, /Máximo de candidatos examinados12/);
  assert.match(resumo, /ObservaçõesSó com site/);
  assert.match(porId(s, 'pros-explain').textContent, /Leads desejados são os NOVOS leads que você quer receber na Approval Queue\. Candidatos examinados são as empresas que a pesquisa analisa/);
  assert.match(porId(s, 'pros-consumption').textContent, /Claude Code instalado neste computador e pode consumir o seu limite de uso/);
  assert.match(painelAba(s, 'nova').textContent, /não aprova leads, não promove nada ao CRM e não inicia nenhum contato/);
  // voltar, mudar e avançar: o resumo reflete
  await clicar(s, porId(s, 'pros-prev'));
  digitar(s, 'pros-max-candidates', '20');
  await proximo(s);
  assert.match(porId(s, 'pros-summary').textContent, /Máximo de candidatos examinados20/);
  await clicar(s, porId(s, 'pros-prev'));
  s.browser.choose(porId(s, 'pros-nivel'), 'NACIONAL');
  await proximo(s);
  assert.match(porId(s, 'pros-summary').textContent, /LocalNacional: Brasil/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// CONTRATO e CRIAÇÃO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[PROS-UX-8] "SALVAR BRIEFING" cria SÓ o briefing (campos aceitos, nunca maxCandidates), não inicia nada, avisa depois da resposta, limpa o assistente e leva a "Briefings salvos"; estado/nacional usam estados/pais', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [] }) });
  await ate3(s, { subnicho: '  Harmonização ', observacoes: '  Só clínicas com site  ', quantidade: 4, maximo: 12 });
  await clicar(s, porId(s, 'pros-save'));
  assert.deepEqual(s.api.chamadas.find(([n]) => n === 'create')[1], { nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', quantidade: 4, subnicho: 'Harmonização', observacoes: 'Só clínicas com site', cidades: 'Petrópolis, Teresópolis' });
  assert.equal('maxCandidates' in s.api.chamadas.find(([n]) => n === 'create')[1], false);
  assert.deepEqual(nomes(s).filter((n) => ['ready', 'start'].includes(n)), [], 'salvar não marca pronto nem inicia pesquisa');
  assert.ok(avisos(s).some((t) => /Briefing PROS-\d{8}-\d{3} salvo\. Ele aparece em Briefings salvos; nada foi pesquisado\./.test(t)));
  assert.equal(abaAtiva(s), 'briefings');
  assert.match(tela(s), /Clínicas de estética/);
  assert.deepEqual([porId(s, 'pros-nicho').value, porId(s, 'pros-quantidade').value, porId(s, 'pros-max-candidates').value], ['', '3', '10'], 'o assistente voltou ao início');
  assert.equal(etapaAtual(s), 1);
  assert.equal(s.ag.pendentes().length, 0);

  const estado = await abrir({ api: apiFalsa({ briefs: [] }) });
  digitar(estado, 'pros-nicho', 'Odontologia');
  await proximo(estado);
  estado.browser.choose(porId(estado, 'pros-nivel'), 'ESTADO');
  digitar(estado, 'pros-locais', 'SP, RJ');
  await proximo(estado);
  await clicar(estado, porId(estado, 'pros-save'));
  assert.deepEqual(estado.api.chamadas.find(([n]) => n === 'create')[1], { nicho: 'Odontologia', nivelGeografico: 'ESTADO', quantidade: 3, estados: 'SP, RJ' });

  const nacional = await abrir({ api: apiFalsa({ briefs: [] }) });
  digitar(nacional, 'pros-nicho', 'Contabilidade');
  await proximo(nacional);
  nacional.browser.choose(porId(nacional, 'pros-nivel'), 'NACIONAL');
  assert.equal(porId(nacional, 'pros-locais').parentNode.hidden, true);
  assert.equal(porId(nacional, 'pros-pais').parentNode.hidden, false);
  digitar(nacional, 'pros-pais', '');
  await proximo(nacional);
  await clicar(nacional, porId(nacional, 'pros-save'));
  assert.deepEqual(nacional.api.chamadas.find(([n]) => n === 'create')[1], { nicho: 'Contabilidade', nivelGeografico: 'NACIONAL', quantidade: 3, pais: 'Brasil' }, 'país em branco vale Brasil');
});

test('[PROS-UX-9] a CONFIRMAÇÃO antes de iniciar: resume nicho, local, leads desejados e máximo; avisa do Claude Code e do limite de uso; deixa claro que não aprova, não promove e não inicia contato; abrir NÃO cria nada', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [] }) });
  await ate3(s, { subnicho: 'Harmonização', quantidade: 4, maximo: 12 });
  await clicar(s, porId(s, 'pros-start-wizard'));
  const m = modal(s);
  assert.ok(m, 'o modal de confirmação abriu');
  assert.deepEqual(nomes(s).filter((n) => ['create', 'ready', 'start'].includes(n)), [], 'abrir a confirmação não cria nada');
  const texto = m.textContent.replace(/\s+/g, ' ');
  assert.match(texto, /Iniciar pesquisa.*Confira antes de iniciar/);
  assert.match(texto, /NichoClínicas de estética \/ Harmonização/);
  assert.match(texto, /LocalCidade: Petrópolis, Teresópolis/);
  assert.match(texto, /Leads novos desejados4/);
  assert.match(texto, /Máximo de candidatos examinados12/);
  assert.match(texto, /usa o Claude Code instalado neste computador e pode consumir o seu limite de uso/);
  assert.match(texto, /não aprova leads, não promove nada ao CRM e não inicia nenhum contato/);
  assert.match(texto, /Só uma prospecção roda por vez/);
  assert.ok(s.browser.by.button(m, 'Iniciar pesquisa'));
  assert.ok(s.browser.by.button(m, 'Cancelar'));
});

test('[PROS-UX-10] CANCELAR a confirmação (Cancelar ou ESC) não executa nada: o assistente fica na etapa 3 com tudo preenchido e o foco volta ao botão', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [] }) });
  await ate3(s, { quantidade: 5, maximo: 15 });
  await clicar(s, porId(s, 'pros-start-wizard'));
  await clicar(s, s.browser.by.button(modal(s), 'Cancelar'));
  assert.equal(modal(s), null);
  assert.deepEqual(nomes(s).filter((n) => ['create', 'ready', 'start'].includes(n)), []);
  assert.equal(etapaAtual(s), 3);
  assert.equal(porId(s, 'pros-quantidade').value, '5');
  assert.equal(s.browser.document.activeElement === porId(s, 'pros-start-wizard'), true, 'o foco volta ao botão que abriu');
  await clicar(s, porId(s, 'pros-start-wizard'));
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(modal(s), null);
  assert.deepEqual(nomes(s).filter((n) => ['create', 'ready', 'start'].includes(n)), []);
  assert.equal(s.ag.pendentes().length, 0, 'nenhum acompanhamento foi agendado');
});

test('[PROS-UX-11] CONFIRMAR: cria o briefing, marca pronto e inicia o job — com cliques triplos UMA vez —, o sucesso só aparece depois da resposta, a tela vai para "Em andamento", o assistente é limpo e o barramento é avisado; o contrato é briefId + maxCandidates', async () => {
  let liberar;
  const espera = new Promise((resolve) => { liberar = resolve; });
  const iniciarLento = async (briefId, max, mem) => {
    await espera;
    const criado = job({ briefId });
    mem.jobs = [criado, ...mem.jobs];
    return { item: criado };
  };
  const s = await abrir({ api: apiFalsa({ briefs: [], iniciar: iniciarLento, respostas: [job()] }) });
  await ate3(s, { quantidade: 4, maximo: 12 });
  await clicar(s, porId(s, 'pros-start-wizard'));
  const confirmar = botaoConfirmar(s);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  await s.browser.flush(6);
  assert.equal(avisos(s).some((t) => /Prospecção iniciada/.test(t)), false, 'nada de sucesso antes da resposta do servidor');
  assert.equal(confirmar.disabled, true);
  liberar();
  await s.browser.flush(12);
  assert.equal(conta(s, 'create'), 1, 'um único briefing');
  assert.equal(conta(s, 'ready'), 1, 'marcado pronto (o briefing nasce RASCUNHO)');
  const [, briefId, max] = s.api.chamadas.find(([n]) => n === 'start');
  assert.match(briefId, /^PROS-\d{8}-\d{3}$/);
  assert.equal(max, 12);
  assert.equal(conta(s, 'start'), 1, 'uma única prospecção');
  assert.equal('maxCandidates' in s.api.chamadas.find(([n]) => n === 'create')[1], false);
  assert.deepEqual(nomes(s).filter((n) => ['create', 'ready', 'start'].includes(n)), ['create', 'ready', 'start'], 'a ordem: criar, marcar pronto, iniciar');
  assert.equal(modal(s), null);
  assert.equal(abaAtiva(s), 'andamento');
  assert.ok(avisos(s).includes('Prospecção iniciada. Acompanhe o andamento nesta aba; nenhum lead é aprovado ou enviado ao CRM por isso.'));
  assert.deepEqual(s.eventos, [['start', 'JOB-20261006-001']]);
  assert.equal(s.ag.pendentes().length, 1, 'o acompanhamento começou');
  assert.deepEqual([porId(s, 'pros-nicho').value, porId(s, 'pros-quantidade').value], ['', '3'], 'o assistente foi limpo');
  assert.match(tela(s), /Em execução/);
});

test('[PROS-UX-12] ERROS do backend ao iniciar: a confirmação continua aberta com a mensagem e o formulário intacto; uma nova tentativa NÃO duplica o briefing já criado; nenhum sucesso falso', async () => {
  let falhar = true;
  const iniciarComErro = (briefId, max, mem) => {
    if (falhar) throw Object.assign(new Error('x'), { status: 409, serverMessage: 'Já existe uma prospecção em execução. Aguarde ela terminar ou cancele.' });
    const criado = job({ briefId });
    mem.jobs = [criado];
    return { item: criado };
  };
  const s = await abrir({ api: apiFalsa({ briefs: [], iniciar: iniciarComErro, respostas: [job()] }) });
  await ate3(s, { quantidade: 6, maximo: 14 });
  await clicar(s, porId(s, 'pros-start-wizard'));
  await clicar(s, botaoConfirmar(s));
  assert.ok(modal(s), 'o erro NÃO fecha a confirmação');
  assert.match(modal(s).textContent, /Já existe uma prospecção em execução/);
  assert.equal(avisos(s).some((t) => /Prospecção iniciada/.test(t)), false);
  assert.equal(botaoConfirmar(s).disabled, false, 'dá para tentar de novo');
  assert.equal(conta(s, 'create'), 1);
  assert.equal(porId(s, 'pros-quantidade').value, '6', 'o formulário não foi apagado');
  assert.equal(s.ag.pendentes().length, 0, 'sem job, nenhum acompanhamento');
  falhar = false;
  await clicar(s, botaoConfirmar(s));
  assert.equal(modal(s), null);
  assert.equal(conta(s, 'create'), 1, 'a nova tentativa reaproveita o briefing criado: sem duplicar');
  assert.equal(conta(s, 'ready'), 1);
  assert.equal(conta(s, 'start'), 2);
  assert.deepEqual(s.api.chamadas.filter(([n]) => n === 'start').map(([, , max]) => max), [14, 14]);
  assert.match(tela(s), /Em execução/);

  // erro ao criar o briefing (400): nada mais é chamado e o texto digitado fica
  const criarFalha = () => { throw Object.assign(new Error('x'), { status: 400, serverMessage: 'O nicho informado não é aceito.' }); };
  const t = await abrir({ api: apiFalsa({ briefs: [], criar: criarFalha }) });
  await ate3(t, { nicho: 'Meu nicho' });
  await clicar(t, porId(t, 'pros-start-wizard'));
  await clicar(t, botaoConfirmar(t));
  assert.match(modal(t).textContent, /O nicho informado não é aceito\./);
  assert.deepEqual(nomes(t).filter((n) => ['ready', 'start'].includes(n)), []);
  await clicar(t, t.browser.by.button(modal(t), 'Cancelar'));
  assert.equal(porId(t, 'pros-nicho').value, 'Meu nicho');
});

test('[PROS-UX-13] "Salvar briefing" com cliques duplos cria UM briefing; um erro do servidor mantém tudo o que foi digitado e não fecha nada', async () => {
  let liberar;
  const espera = new Promise((resolve) => { liberar = resolve; });
  const criarLento = async (fields, mem) => {
    await espera;
    const novo = { ...BRIEF, id: 'PROS-20261008-009', ...fields, cidades: [fields.cidades], contagens: null };
    mem.briefs = [novo, ...mem.briefs];
    return { item: novo };
  };
  const s = await abrir({ api: apiFalsa({ briefs: [], criar: criarLento }) });
  await ate3(s);
  const botao = porId(s, 'pros-save');
  s.browser.click(botao);
  await s.browser.flush(2);
  s.browser.click(botao);
  s.browser.click(botao);
  assert.equal(botao.disabled, true);
  assert.equal(botao.textContent, 'Salvando…');
  liberar();
  await s.browser.flush(10);
  assert.equal(conta(s, 'create'), 1);
  assert.equal(botao.textContent, 'Salvar briefing');

  const erro = await abrir({ api: apiFalsa({ briefs: [], criar: () => { throw Object.assign(new Error('x'), { status: 500 }); } }) });
  await ate3(erro, { quantidade: 8 });
  await clicar(erro, porId(erro, 'pros-save'));
  assert.ok(avisos(erro).includes('Não foi possível concluir a operação agora. Tente novamente.'));
  assert.equal(etapaAtual(erro), 3);
  assert.equal(porId(erro, 'pros-quantidade').value, '8', 'nada foi apagado');
  assert.equal(abaAtiva(erro), 'nova');
  assert.equal(porId(erro, 'pros-save').disabled, false);
});

test('[PROS-UX-14] o RASCUNHO é protegido: o que foi digitado (campos e etapa) fica ao trocar de aba e de módulo; "Limpar" pergunta antes de descartar; o aviso de rascunho aparece e some', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [] }) });
  assert.equal(s.browser.by.cls(raiz(s), 'draft-hint')[0].hidden, true);
  assert.equal(porId(s, 'pros-clear').hidden, true, 'sem rascunho: sem "Limpar"');
  await ate3(s, { quantidade: 9, maximo: 20, observacoes: 'Texto importante' });
  assert.equal(s.browser.by.cls(raiz(s), 'draft-hint')[0].hidden, false);
  assert.match(s.browser.by.cls(raiz(s), 'draft-hint')[0].textContent, /O rascunho é mantido se você trocar de aba ou de tela/);
  assert.equal(porId(s, 'pros-observacoes').parentNode.textContent.includes('16/2000'), true, 'contador de caracteres');

  await aba(s, 'briefings');
  await aba(s, 'andamento');
  await aba(s, 'nova');
  assert.equal(etapaAtual(s), 3, 'a etapa também fica');
  s.view.hide();
  await s.view.show({ name: 'prospecting' });
  await s.browser.flush(6);
  assert.equal(etapaAtual(s), 3);
  assert.deepEqual([porId(s, 'pros-nicho').value, porId(s, 'pros-quantidade').value, porId(s, 'pros-max-candidates').value, porId(s, 'pros-observacoes').value], ['Clínicas de estética', '9', '20', 'Texto importante']);

  await clicar(s, porId(s, 'pros-clear'));
  assert.match(modal(s).textContent, /Descartar o rascunho\?.*será perdido/s);
  await clicar(s, s.browser.find(raiz(s), (el) => el.localName === 'button' && el.textContent === 'Continuar editando'));
  assert.equal(porId(s, 'pros-nicho').value, 'Clínicas de estética');
  await clicar(s, porId(s, 'pros-clear'));
  await clicar(s, botaoConfirmar(s));
  assert.deepEqual([porId(s, 'pros-nicho').value, porId(s, 'pros-quantidade').value, porId(s, 'pros-observacoes').value], ['', '3', '']);
  assert.equal(etapaAtual(s), 1);
  assert.equal(s.browser.by.cls(raiz(s), 'draft-hint')[0].hidden, true);
  assert.equal(porId(s, 'pros-clear').hidden, true);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// BRIEFINGS SALVOS
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[PROS-UX-15] BRIEFINGS SALVOS: tabela de largura total com código, nicho, localização, leads desejados, situação e data; busca, situação, paginação; linha inteira clicável (mouse e teclado); sem texto cortado nem tabela espremida', async () => {
  const muitos = Array.from({ length: 23 }, (_, i) => ({ ...BRIEF, id: `PROS-202610${String(10 + (i % 18))}-0${String(i).padStart(2, '0')}`, nicho: i % 2 ? 'Psicologia' : 'Estética', cidades: [i % 3 ? 'Niterói/RJ' : 'Petrópolis/RJ'], quantidade: i + 1, status: i === 0 ? 'PRONTO_PARA_PESQUISA' : i % 5 === 0 ? 'RASCUNHO' : 'AGUARDANDO_REVISAO', criadoEm: `2026-10-${String(10 + (i % 18))}T12:00:00.000Z` }));
  const s = await abrir({ api: apiFalsa({ briefs: muitos }) });
  await aba(s, 'briefings');
  assert.deepEqual(s.browser.by.tag(porId(s, 'pros-recent'), 'th').map((el) => el.textContent), ['Código', 'Nicho', 'Localização', 'Leads desejados', 'Situação', 'Criado em']);
  assert.match(tela(s), /Página 1 de 3 · 1–10 de 23/);
  assert.equal(s.browser.by.tag(porId(s, 'pros-recent'), 'tr').length, 11);
  assert.match(painelAba(s, 'briefings').textContent, /23 briefings/);
  const primeira = s.browser.by.tag(porId(s, 'pros-recent'), 'tbody')[0].childNodes[0];
  assert.deepEqual(s.browser.findAll(primeira, (el) => el.localName === 'td').map((el) => el.getAttribute('data-label')), ['Código', 'Nicho', 'Localização', 'Leads desejados', 'Situação', 'Criado em'], 'cada célula tem o rótulo (no celular vira cartão)');
  assert.match(primeira.textContent, /\d{2}\/10\/2026/);

  const busca = s.browser.by.label(raiz(s), 'Buscar briefing');
  s.browser.type(busca, 'psicologia');
  assert.match(painelAba(s, 'briefings').textContent, /23 briefings · 11 no filtro/);
  s.browser.type(busca, 'petropolis'); // sem acento
  assert.match(painelAba(s, 'briefings').textContent, /23 briefings · 8 no filtro/);
  s.browser.type(busca, 'nada disso');
  assert.match(tela(s), /Nenhum briefing encontrado/);
  s.browser.type(busca, '');
  s.browser.choose(s.browser.by.label(raiz(s), 'Situação'), 'RASCUNHO');
  assert.match(painelAba(s, 'briefings').textContent, /23 briefings · 4 no filtro/);
  s.browser.choose(s.browser.by.label(raiz(s), 'Situação'), 'TODOS');
  await clicar(s, s.browser.by.button(raiz(s), 'Próxima'));
  assert.match(tela(s), /Página 2 de 3/);

  // a linha inteira abre a gaveta; Enter/Espaço no botão do código também
  const linha = s.browser.find(raiz(s), (el) => el.localName === 'tr' && el.getAttribute('data-brief') !== null);
  const id = linha.getAttribute('data-brief');
  s.browser.click(s.browser.find(linha, (el) => el.getAttribute('data-label') === 'Situação'));
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'clicar fora do botão abre');
  s.browser.press('Escape');
  await s.browser.flush(6);
  const botao = s.browser.by.button(raiz(s), id);
  botao.focus();
  s.browser.press('Enter');
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'Enter abre');
  s.browser.press('Escape');
  await s.browser.flush(6);
  assert.equal(s.browser.document.activeElement === s.browser.by.button(raiz(s), id), true, 'o foco volta à linha');
  assert.match(tela(s), /Página 2 de 3/, 'a página ficou');
});

test('[PROS-UX-16] a GAVETA DO BRIEFING abre sem sair da aba, com os dados, as ações e o início da pesquisa; abrir NUNCA inicia, cria nem pesquisa; ESC e X fecham', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [BRIEF, BRIEF2] }) });
  await abrirBriefing(s);
  const d = gaveta(s);
  assert.ok(d);
  assert.equal(d.getAttribute('aria-modal'), 'true');
  assert.equal(s.browser.find(d, (el) => el.localName === 'h2').textContent, BRIEF.id);
  assert.match(d.textContent, /Clínicas de estética · Petrópolis\/RJ/);
  assert.match(d.textContent, /NichoClínicas de estética \/ Harmonização/);
  assert.match(d.textContent, /AbrangênciaCidade: Petrópolis\/RJ/);
  assert.match(d.textContent, /Leads novos desejados3/);
  assert.equal(abaAtiva(s), 'briefings', 'a gaveta abre sem trocar de aba');
  assert.ok(s.browser.by.id(d, 'pros-start-job'));
  assert.equal(s.browser.by.id(d, 'pros-start-max').value, '10');
  for (const proibida of ['start', 'create', 'ready', 'redo', 'cancel', 'cancelBrief', 'approve', 'reject', 'reaprovar', 'pesquisar']) assert.equal(conta(s, proibida), 0, proibida);
  assert.equal(s.ag.pendentes().length, 0);
  s.browser.press('Escape');
  await s.browser.flush(6);
  assert.equal(gaveta(s), null, 'ESC fecha');
  await clicar(s, s.browser.by.button(raiz(s), BRIEF2.id));
  assert.equal(s.browser.by.id(gaveta(s), 'pros-start-job'), null, 'AGUARDANDO_REVISAO não oferece iniciar outra pesquisa');
  s.browser.click(s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  await s.browser.flush(6);
  assert.equal(gaveta(s), null, 'o X fecha');
});

test('[PROS-UX-17] NAVEGAÇÃO da gaveta do briefing: abrir muda o endereço (#/prospeccao/briefing/<id>); Voltar fecha SEM sair do módulo e Avançar reabre; o X volta uma entrada; o foco volta à linha; a lista e a busca ficam', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [BRIEF, BRIEF2] }), comNavegacao: true, hash: '#/prospeccao' });
  const win = s.browser.window;
  await aba(s, 'briefings');
  s.browser.type(s.browser.by.label(raiz(s), 'Buscar briefing'), 'psicologia');
  await clicar(s, s.browser.by.button(raiz(s), BRIEF2.id));
  assert.equal(win.location.hash, `#/prospeccao/briefing/${encodeURIComponent(BRIEF2.id)}`);
  assert.equal(win.history.length, 2);
  assert.ok(gaveta(s));
  win.history.back();
  await s.browser.flush(8);
  assert.equal(win.location.hash, '#/prospeccao', 'o Voltar fica no módulo');
  assert.equal(gaveta(s), null, 'e fecha a gaveta');
  assert.equal(s.browser.by.label(raiz(s), 'Buscar briefing').value, 'psicologia', 'a busca ficou');
  win.history.forward();
  await s.browser.flush(8);
  assert.ok(gaveta(s), 'o Avançar reabre');
  assert.equal(s.browser.find(gaveta(s), (el) => el.localName === 'h2').textContent, BRIEF2.id);
  s.browser.click(s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  await s.browser.flush(8);
  assert.equal(win.location.hash, '#/prospeccao');
  assert.equal(win.history.length, 2, 'fechar não cria entrada nova');
  assert.equal(s.browser.document.activeElement === s.browser.by.button(raiz(s), BRIEF2.id), true, 'o foco voltou à linha');
  assert.equal(abaAtiva(s), 'briefings');
  assert.deepEqual(nomes(s).filter((n) => ['start', 'create', 'ready'].includes(n)), []);
});

test('[PROS-UX-18] LINK DIRETO para um briefing abre a gaveta (na aba certa); código inexistente avisa e volta; nada é iniciado', async () => {
  const direto = await abrir({ api: apiFalsa({ briefs: [BRIEF, BRIEF2] }), comNavegacao: true, hash: `#/prospeccao/briefing/${encodeURIComponent(BRIEF2.id)}` });
  assert.ok(gaveta(direto), 'o link direto abriu a gaveta');
  assert.equal(direto.browser.find(gaveta(direto), (el) => el.localName === 'h2').textContent, BRIEF2.id);
  assert.equal(abaAtiva(direto), 'briefings');
  direto.browser.press('Escape');
  await direto.browser.flush(8);
  assert.equal(direto.browser.window.location.hash, '#/prospeccao');
  assert.equal(direto.browser.window.history.length, 1, 'sem entrada anterior no app: a entrada é trocada');
  assert.deepEqual(nomes(direto).filter((n) => ['start', 'create', 'ready', 'redo'].includes(n)), []);

  const inexistente = await abrir({ api: apiFalsa({ briefs: [BRIEF] }), comNavegacao: true, hash: `#/prospeccao/briefing/${encodeURIComponent('PROS-99999999-999')}` });
  assert.equal(gaveta(inexistente), null);
  assert.ok(avisos(inexistente).some((t) => /Este briefing não foi encontrado em Briefings salvos\./.test(t)));
  assert.equal(inexistente.browser.window.location.hash, '#/prospeccao');
});

test('[PROS-UX-19] as AÇÕES do briefing na gaveta: "Marcar pronto" (RASCUNHO), cancelar briefing SÓ depois de confirmar; iniciar pela gaveta valida o máximo (1–100), confirma, e leva a "Em andamento" (cliques triplos = uma prospecção)', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [{ ...BRIEF, status: 'RASCUNHO' }], respostas: [job()] }) });
  await abrirBriefing(s);
  assert.equal(s.browser.by.id(gaveta(s), 'pros-start-job'), null, 'RASCUNHO não inicia');
  await clicar(s, s.browser.by.button(gaveta(s), 'Marcar pronto para pesquisa'));
  assert.equal(conta(s, 'ready'), 1);
  assert.ok(s.browser.by.id(gaveta(s), 'pros-start-job'), 'agora está pronto para iniciar');
  assert.match(gaveta(s).textContent, /Pronto para pesquisa/);

  // validar o máximo antes de abrir a confirmação
  digitar(s, 'pros-start-max', '101');
  await clicar(s, porId(s, 'pros-start-job'));
  assert.equal(modal(s), null);
  assert.equal(erroDe(s, 'pros-start-max').textContent, 'Informe um número inteiro de 1 a 100 candidatos.');
  assert.equal(s.browser.document.activeElement.id, 'pros-start-max');
  digitar(s, 'pros-start-max', '25');
  assert.equal(erroDe(s, 'pros-start-max').hidden, true);

  await clicar(s, porId(s, 'pros-start-job'));
  assert.match(modal(s).textContent, /Briefing PROS-20261006-001.*Máximo de candidatos examinados25/s);
  assert.equal(conta(s, 'start'), 0);
  const confirmar = botaoConfirmar(s);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  await s.browser.flush(12);
  assert.deepEqual(s.api.chamadas.filter(([n]) => n === 'start'), [['start', BRIEF.id, 25]], 'uma única prospecção, com o máximo editado');
  assert.equal(gaveta(s), null, 'a gaveta fechou');
  assert.equal(abaAtiva(s), 'andamento');
  assert.match(tela(s), /Em execução/);
  assert.equal(s.ag.pendentes().length, 1);

  const c = await abrir({ api: apiFalsa() });
  await abrirBriefing(c);
  await clicar(c, c.browser.by.button(gaveta(c), 'Cancelar briefing'));
  assert.equal(conta(c, 'cancelBrief'), 0, 'pede confirmação antes');
  assert.match(modal(c).textContent, /Cancelar briefing.*não poderá ser usado para uma nova pesquisa/s);
  await clicar(c, c.browser.by.button(modal(c), 'Voltar'));
  assert.equal(conta(c, 'cancelBrief'), 0);
  await clicar(c, c.browser.by.button(gaveta(c), 'Cancelar briefing'));
  await clicar(c, botaoConfirmar(c));
  assert.equal(conta(c, 'cancelBrief'), 1);
  assert.ok(avisos(c).includes('Briefing cancelado.'));
  assert.match(gaveta(c).textContent, /Cancelado/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// EM ANDAMENTO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[PROS-UX-20] EM ANDAMENTO mostra SÓ execuções realmente ativas: sem execução ativa, estado vazio claro (com o caminho para "Nova pesquisa" e para o Histórico); uma execução antiga do histórico NUNCA aparece; a que terminou nesta sessão aparece à parte e pode ser fechada', async () => {
  const s = await abrir({ api: apiFalsa() });
  await aba(s, 'andamento');
  assert.match(painelAba(s, 'andamento').textContent, /Nenhuma prospecção em andamento.*Quando você iniciar uma pesquisa, o andamento aparece aqui\. Nada é pesquisado sem a sua confirmação\. Prospecções anteriores ficam no Histórico\./);
  assert.equal(s.browser.by.link(painelAba(s, 'andamento'), 'Ver o Histórico de prospecções').href, '#/prospeccao/historico');
  assert.equal(s.ag.pendentes().length, 0);
  assert.equal(conta(s, 'status'), 0);
  await clicar(s, s.browser.by.button(painelAba(s, 'andamento'), 'Nova pesquisa'));
  assert.equal(abaAtiva(s), 'nova');

  // uma execução ANTIGA (terminada) no histórico não é "em andamento": nada de cartão, nada de acompanhamento, a aba inicial continua sendo Nova pesquisa
  const antiga = await abrir({ api: apiFalsa({ jobs: [jobFinal()] }) });
  assert.equal(abaAtiva(antiga), 'nova');
  await aba(antiga, 'andamento');
  assert.ok(porId(antiga, 'pros-run-empty'));
  assert.equal(porId(antiga, 'pros-auto'), null, 'nenhum cartão de execução');
  assert.equal(porId(antiga, 'pros-job-details'), null);
  assert.equal(antiga.browser.by.cls(antiga.browser.root, 'run-last-title').length, 0);
  assert.doesNotMatch(painelAba(antiga, 'andamento').textContent, /PROSPECÇÃO CONCLUÍDA|JOB-20261006-001/);
  assert.equal(abaBotao(antiga, 'andamento').textContent, 'Em andamento', 'sem contador');
  assert.equal(antiga.ag.pendentes().length, 0);

  // a que ACABOU DE TERMINAR nesta sessão (vista em andamento) aparece à parte, com o resultado, e pode ser fechada
  const sessao = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [jobFinal()] }) });
  assert.ok(porId(sessao, 'pros-cancel-job'), 'ativa: o cartão normal');
  await sessao.ag.rodar();
  await sessao.browser.flush(8);
  assert.ok(porId(sessao, 'pros-run-empty'), 'terminou: o vazio diz que nada está em andamento');
  assert.equal(sessao.browser.by.cls(sessao.browser.root, 'run-last-title')[0].textContent, 'Execução finalizada nesta sessão');
  assert.match(tela(sessao), /PROSPECÇÃO CONCLUÍDA/);
  assert.match(tela(sessao), /1 de 3 lead\(s\) solicitado\(s\) chegaram à Approval Queue/);
  assert.equal(porId(sessao, 'pros-open-approvals').getAttribute('href'), '#/aprovacoes');
  assert.equal(sessao.ag.pendentes().length, 0, 'terminada: nada a acompanhar');
  await clicar(sessao, porId(sessao, 'pros-run-dismiss'));
  assert.equal(porId(sessao, 'pros-auto'), null, 'fechado: some');
  assert.ok(porId(sessao, 'pros-run-empty'));
});

test('[PROS-UX-21] a EXECUÇÃO por etapas reais: Descoberta, Validação e Envio à aprovação com seu estado; sem percentual; indicadores de encontrados, validados, entregues, retidos e não validados; tempo, custo e eventos só quando existem', async () => {
  const andamento = job({ currentStep: 'INGERINDO', candidatesDiscovered: 7, candidatesValidated: 3, candidatesRejected: 4, leadsNaFila: 1, elapsedMs: 83000, telemetria: { custoUsd: 0.12, reposicoesRealizadas: 1 }, lote: { naFila: 1, foraDaFila: 2 } });
  const s = await abrir({ api: apiFalsa({ jobs: [andamento], respostas: [andamento] }) });
  assert.equal(abaAtiva(s), 'andamento');
  assert.deepEqual(s.browser.by.cls(raiz(s), 'step').map((li) => [li.getAttribute('data-step'), li.className, li.textContent]), [
    ['DESCOBRINDO', 'step done', 'Descobertaconcluída'],
    ['VALIDANDO', 'step done', 'Validaçãoconcluída'],
    ['INGERINDO', 'step current', 'Envio à aprovaçãoem andamento'],
  ]);
  assert.match(tela(s), /Enviando para a aprovação/);
  assert.match(tela(s), /Clínicas de estética · Petrópolis\/RJ/, 'o briefing da execução aparece');
  const valor = (rotulo) => s.browser.find(s.browser.find(raiz(s), (el) => /\bindicator-number\b/.test(el.className) && el.textContent.startsWith(rotulo)), (el) => el.className === 'indicator-value').textContent;
  assert.deepEqual(['Encontrados', 'Validados', 'Entregues à fila', 'Retidos fora da fila', 'Não validados'].map(valor), ['7', '3', '1', '2', '4']);
  assert.equal(porId(s, 'pros-job-meta').textContent, 'Tempo decorrido: 01:23 · Custo informado pelo motor: US$ 0.12 · Reposições realizadas: 1');
  assert.equal(s.browser.by.tag(raiz(s), 'progress').length, 0);
  assert.doesNotMatch(painelAba(s, 'andamento').textContent, /\d\s?%/, 'nenhum percentual');
  assert.equal(porId(s, 'pros-cancel-job'), null, 'durante o envio à aprovação não se cancela');
  assert.equal(porId(s, 'pros-job-details').textContent, 'Ver detalhes da execução');
  assert.equal(s.browser.by.link(painelAba(s, 'andamento'), 'Ver no Histórico').href, '#/prospeccao/historico/JOB-20261006-001');

  const falhou = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [job({ status: 'ERRO', currentStep: 'FINALIZADO', error: { code: 'JOB_INTERRUPTED' } })] }) });
  await falhou.ag.rodar();
  await falhou.browser.flush(8);
  assert.equal(falhou.browser.by.cls(raiz(falhou), 'step').length, 0, 'job que falhou não afirma etapas');
  assert.match(tela(falhou), /o servidor foi reiniciado/);
});

test('[PROS-UX-22] o ACOMPANHAMENTO só roda para job em andamento, com a tela à vista, em intervalo moderado; atualiza os indicadores E o contador da aba sem recarregar; ao concluir avisa (sucesso real), atualiza as listas e PARA', async () => {
  const s = await abrir({ api: apiFalsa({ jobs: [job({ currentStep: 'DESCOBRINDO' })], respostas: [job({ currentStep: 'VALIDANDO', candidatesDiscovered: 4 }), jobFinal()] }) });
  assert.equal(abaBotao(s, 'andamento').textContent, 'Em andamento1');
  assert.equal(s.ag.pendentes().length, 1);
  assert.equal(s.ag.pendentes()[0].ms, 4000, 'intervalo moderado (4 s)');
  const briefsAntes = conta(s, 'briefs');
  await s.ag.rodar();
  await s.browser.flush(6);
  assert.match(tela(s), /Validando as páginas das empresas/);
  assert.equal(conta(s, 'status'), 1, 'uma consulta por rodada');
  assert.equal(s.ag.pendentes().length, 1, 'continua em andamento: continua agendado');
  await s.ag.rodar();
  await s.browser.flush(10);
  assert.match(tela(s), /PROSPECÇÃO CONCLUÍDA/);
  assert.ok(avisos(s).some((t) => /Prospecção concluída: 1 lead\(s\) chegaram à Approval Queue/.test(t)));
  assert.equal(s.ag.pendentes().length, 0, 'terminou: o acompanhamento parou');
  assert.equal(abaBotao(s, 'andamento').textContent, 'Em andamento', 'o contador da aba voltou a zero');
  assert.ok(conta(s, 'briefs') > briefsAntes, 'a lista de briefings foi atualizada ao terminar');
  assert.deepEqual(s.eventos.at(-1), ['finish', 'JOB-20261006-001']);
  assert.equal(conta(s, 'status'), 2);
});

test('[PROS-UX-23] o acompanhamento PARA ao falhar, ao cancelar, ao concluir parcial e ao SAIR da tela (e volta ao voltar se ainda roda); nunca consulta job terminado; a aba escolhida não muda sozinha', async () => {
  for (const [final, aviso] of [[job({ status: 'ERRO', currentStep: 'FINALIZADO', error: { code: 'JOB_INTERNAL' } }), /A prospecção falhou/], [job({ status: 'CANCELADO', currentStep: 'FINALIZADO' }), /Prospecção cancelada/], [jobFinal({ status: 'PARCIAL' }), /Prospecção parcial/]]) {
    const s = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [final] }) });
    assert.equal(s.ag.pendentes().length, 1);
    await s.ag.rodar();
    await s.browser.flush(8);
    assert.equal(s.ag.pendentes().length, 0, final.status);
    assert.ok(avisos(s).some((t) => aviso.test(t)), final.status);
  }
  const s = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [job()] }) });
  await aba(s, 'nova');
  assert.equal(s.ag.pendentes().length, 1, 'a aba não importa: a execução continua acompanhada');
  s.view.hide();
  assert.equal(s.ag.pendentes().length, 0, 'saiu da tela: parou');
  const antes = conta(s, 'status');
  await s.view.show({ name: 'prospecting' });
  await s.browser.flush(8);
  assert.equal(s.ag.pendentes().length, 1, 'voltou e o job ainda roda: o acompanhamento retoma');
  assert.equal(conta(s, 'status'), antes, 'sem consulta extra ao voltar (só a leitura das listas)');
  assert.equal(abaAtiva(s), 'nova', 'a aba escolhida ficou');
});

test('[PROS-UX-24] falhas SEGUIDAS de rede: tenta de novo, desiste depois de 4 com uma mensagem clara, e "Atualizar" retoma; CANCELAR a prospecção chama só o id e não duplica', async () => {
  const api = apiFalsa({ jobs: [job({ candidatesDiscovered: 3 })], respostas: [job({ candidatesDiscovered: 3 })] });
  const s = await abrir({ api });
  api.mem.falharStatus = true;
  for (let i = 0; i < 3; i += 1) {
    await s.ag.rodar();
    await s.browser.flush(4);
    assert.equal(s.ag.pendentes().length, 1, `falha ${i + 1}: ainda tenta`);
  }
  await s.ag.rodar();
  await s.browser.flush(6);
  assert.equal(s.ag.pendentes().length, 0, 'quarta falha: desiste');
  assert.ok(avisos(s).includes('Perdi o acompanhamento da prospecção. Use "Atualizar" para ver o resultado.'));
  assert.match(tela(s), /O acompanhamento automático parou depois de falhas seguidas/);
  assert.match(tela(s), /Em execução/, 'o último estado conhecido continua na tela');
  api.mem.falharStatus = false;
  await clicar(s, s.browser.by.button(raiz(s), 'Atualizar'));
  assert.equal(s.ag.pendentes().length, 1, 'Atualizar retoma o acompanhamento');
  assert.doesNotMatch(tela(s), /O acompanhamento automático parou/);

  const c = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [job({ status: 'CANCELAMENTO_SOLICITADO' }), job({ status: 'CANCELADO', currentStep: 'FINALIZADO' })] }) });
  const cancelar = porId(c, 'pros-cancel-job');
  c.browser.click(cancelar);
  c.browser.click(cancelar);
  await c.browser.flush(8);
  assert.deepEqual(c.api.chamadas.filter(([n]) => n === 'cancel'), [['cancel', 'JOB-20261006-001']]);
  assert.match(tela(c), /Cancelando…/);
  assert.equal(porId(c, 'pros-cancel-job').disabled, true);
});

test('[PROS-UX-25] a gaveta da EXECUÇÃO reutiliza o detalhe do Histórico: quatro abas; candidatos em grupos que não se misturam; nenhum candidato é "rejeitado"; só leitura; URL, ESC, X, Voltar, Avançar e link direto', async () => {
  const s = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [jobFinal()] }), comNavegacao: true, hash: '#/prospeccao' });
  const win = s.browser.window;
  await s.ag.rodar(); // a execução (vista em andamento) termina; o cartão do resultado fica à mão
  await s.browser.flush(8);
  await aba(s, 'andamento');
  const botao = porId(s, 'pros-job-details');
  botao.focus();
  await clicar(s, botao);
  assert.equal(win.location.hash, '#/prospeccao/execucao/JOB-20261006-001');
  const d = gaveta(s);
  assert.ok(d);
  assert.deepEqual(s.browser.findAll(d, (el) => el.getAttribute('role') === 'tab').map((el) => el.getAttribute('data-tab')), ['resumo', 'candidatos', 'resultados', 'auditoria']);
  assert.match(painelDaAbaGaveta(s, 'resumo').textContent, /Entregues à fila1de 3 solicitados/);
  await clicar(s, s.browser.find(d, (el) => el.getAttribute('data-tab') === 'candidatos'));
  const itens = s.browser.findAll(painelDaAbaGaveta(s, 'candidatos'), (el) => /\bcandidate-item\b/.test(el.className));
  const grupo = (nome) => itens.find((el) => el.textContent.includes(nome)).getAttribute('data-group');
  assert.deepEqual(['Clínica Alfa', 'Clínica Beta', 'Clínica Gama', 'Clínica Delta', 'Excluída Ltda'].map(grupo), ['ENTREGUE', 'RETIDO', 'JA_EXISTIA', 'NAO_VALIDADO', 'DESCARTADO']);
  assert.doesNotMatch(painelDaAbaGaveta(s, 'candidatos').textContent, /rejeitad/i, 'candidato descartado/não validado nunca é "rejeitado por uma pessoa"');

  s.browser.press('Escape');
  await s.browser.flush(8);
  assert.equal(gaveta(s), null, 'ESC fecha');
  assert.equal(win.location.hash, '#/prospeccao');
  assert.equal(s.browser.document.activeElement === porId(s, 'pros-job-details'), true, 'o foco volta ao botão');
  await clicar(s, porId(s, 'pros-job-details'));
  win.history.back();
  await s.browser.flush(8);
  assert.equal(gaveta(s), null, 'Voltar fecha sem sair do módulo');
  win.history.forward();
  await s.browser.flush(8);
  assert.ok(gaveta(s), 'Avançar reabre');
  s.browser.click(s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  await s.browser.flush(8);
  assert.equal(gaveta(s), null, 'o X fecha');
  for (const proibida of ['start', 'redo', 'approve', 'reject', 'reaprovar', 'pesquisar']) assert.equal(conta(s, proibida), 0, proibida);

  const outro = jobFinal({ id: 'JOB-20261007-002', briefId: BRIEF2.id });
  const direto = await abrir({ api: apiFalsa({ briefs: [BRIEF, BRIEF2], jobs: [outro, jobFinal()] }), comNavegacao: true, hash: `#/prospeccao/execucao/${encodeURIComponent('JOB-20261007-002')}` });
  assert.ok(gaveta(direto), 'o link direto abriu a gaveta');
  assert.equal(abaAtiva(direto), 'andamento');
  assert.equal(direto.browser.find(gaveta(direto), (el) => el.localName === 'h2').textContent, 'JOB-20261007-002');
  direto.browser.press('Escape');
  await direto.browser.flush(8);
  assert.equal(direto.browser.window.location.hash, '#/prospeccao');
  assert.equal(direto.browser.window.history.length, 1);
  const inexistente = await abrir({ api: apiFalsa({ briefs: [BRIEF], jobs: [jobFinal()] }), comNavegacao: true, hash: `#/prospeccao/execucao/${encodeURIComponent('JOB-99999999-999')}` });
  assert.equal(gaveta(inexistente), null);
  assert.ok(avisos(inexistente).some((t) => /não foi encontrada\. Procure-a no Histórico/.test(t)));
  assert.equal(inexistente.browser.window.location.hash, '#/prospeccao');
});

test('[PROS-UX-26] GAVETA DA EXECUÇÃO ABERTA durante o acompanhamento: os números mudam sozinhos (aba e foco ficam); só reconstrói se algo mudou; ao terminar o rodapé oferece "Refazer"', async () => {
  const s = await abrir({ api: apiFalsa({ jobs: [job({ candidatesDiscovered: 2 })], respostas: [job({ candidatesDiscovered: 2 }), job({ candidatesDiscovered: 4, candidatesValidated: 1 }), jobFinal()] }) });
  await clicar(s, porId(s, 'pros-job-details'));
  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-tab') === 'auditoria'));
  const abaDaGaveta = () => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true').getAttribute('data-tab');
  assert.equal(s.browser.by.id(gaveta(s), 'pros-drawer-redo'), null, 'em andamento: sem refazer');
  const antes = gaveta(s).textContent;
  await s.ag.rodar();
  await s.browser.flush(6);
  assert.equal(gaveta(s).textContent, antes, 'nada mudou: a gaveta não foi reconstruída');
  await s.ag.rodar();
  await s.browser.flush(6);
  assert.equal(abaDaGaveta(), 'auditoria', 'a aba escolhida ficou');
  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-tab') === 'resumo'));
  assert.match(painelDaAbaGaveta(s, 'resumo').textContent, /Encontrados4/);
  await s.ag.rodar();
  await s.browser.flush(10);
  assert.ok(gaveta(s), 'a gaveta continua aberta');
  assert.match(painelDaAbaGaveta(s, 'resumo').textContent, /Entregues à fila1de 3 solicitados/);
  assert.ok(s.browser.by.id(gaveta(s), 'pros-drawer-redo'), 'terminou: o rodapé oferece refazer');
  assert.equal(s.ag.pendentes().length, 0);
});

test('[PROS-UX-27] REFAZER (cartão ou gaveta) só depois da confirmação; clique triplo cria UMA; erro mantém a confirmação aberta; a tela passa a acompanhar o job novo', async () => {
  let falhar = true;
  const refazer = (id, mem) => {
    if (falhar) throw Object.assign(new Error('x'), { status: 409, serverMessage: 'Já existe uma prospecção em execução. Aguarde ela terminar ou cancele.' });
    const criado = job({ id: 'JOB-20261006-009' });
    mem.jobs = [criado, ...mem.jobs];
    return { item: criado };
  };
  const s = await abrir({ api: apiFalsa({ jobs: [job()], refazer, respostas: [jobFinal(), job({ id: 'JOB-20261006-009' })] }) });
  await s.ag.rodar();
  await s.browser.flush(8);
  await aba(s, 'andamento');
  await clicar(s, porId(s, 'pros-redo-job'));
  assert.equal(conta(s, 'redo'), 0, 'abrir a confirmação não refaz nada');
  assert.match(modal(s).textContent, /Refazer prospecção.*cria e INICIA uma prospecção nova.*Claude Code deste computador.*Não aprova leads, não promove ao CRM e não inicia contato/s);
  await clicar(s, botaoConfirmar(s));
  assert.ok(modal(s), 'erro: a confirmação continua aberta');
  assert.match(modal(s).textContent, /Já existe uma prospecção em execução/);
  falhar = false;
  const confirmar = botaoConfirmar(s);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  await s.browser.flush(12);
  assert.equal(conta(s, 'redo'), 2, 'uma tentativa que falhou + UMA que deu certo');
  assert.equal(modal(s), null);
  assert.match(tela(s), /Em execução/);
  assert.ok(porId(s, 'pros-cancel-job'));
  assert.equal(s.ag.pendentes().length, 1, 'acompanha o job novo');
  assert.deepEqual(s.eventos.at(-1), ['redo', 'JOB-20261006-009']);

  const g = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [jobFinal()] }) });
  await g.ag.rodar();
  await g.browser.flush(8);
  await aba(g, 'andamento');
  await clicar(g, porId(g, 'pros-job-details'));
  await clicar(g, g.browser.by.id(gaveta(g), 'pros-drawer-redo'));
  assert.equal(conta(g, 'redo'), 0);
  await clicar(g, botaoConfirmar(g));
  assert.equal(conta(g, 'redo'), 1);
  assert.equal(gaveta(g), null, 'a gaveta fechou: a tela acompanha o job novo');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// PERMISSÕES, NADA AUTOMÁTICO, PAINEL e ESTILO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[PROS-UX-28] NADA começa sozinho e as PERMISSÕES: abrir, trocar de aba, de etapa, de módulo, abrir gavetas ou links diretos nunca inicia, refaz, cria, aprova, rejeita nem pesquisa; sem permissão a tela é só o aviso e nada é pedido', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [BRIEF, BRIEF2], jobs: [jobFinal()] }), comNavegacao: true, hash: '#/prospeccao' });
  await aba(s, 'briefings');
  await clicar(s, s.browser.by.button(raiz(s), BRIEF2.id));
  s.browser.press('Escape');
  await s.browser.flush(6);
  await aba(s, 'andamento');
  await aba(s, 'nova');
  digitar(s, 'pros-nicho', 'x');
  await proximo(s);
  await clicar(s, porId(s, 'pros-prev'));
  s.view.hide();
  await s.view.show({ name: 'prospecting' });
  await s.browser.flush(6);
  s.browser.window.location.hash = '#/prospeccao/execucao/JOB-20261006-001';
  await s.browser.flush(10);
  assert.ok(gaveta(s));
  s.browser.window.location.hash = `#/prospeccao/briefing/${encodeURIComponent(BRIEF.id)}`;
  await s.browser.flush(10);
  assert.equal(s.browser.findAll(raiz(s), (el) => el.getAttribute('role') === 'dialog').length, 1, 'só uma gaveta por vez');
  for (const proibida of ['start', 'redo', 'create', 'ready', 'cancel', 'cancelBrief', 'approve', 'reject', 'reaprovar', 'pesquisar']) assert.equal(conta(s, proibida), 0, proibida);
  assert.equal(s.ag.pendentes().length, 0);

  const sem = await abrir({ api: apiFalsa(), canPropose: false });
  assert.match(tela(sem), /Seu perfil não pode usar o Workbench de Prospecção\./);
  assert.equal(porId(sem, 'pros-form'), null);
  assert.equal(conta(sem, 'briefs'), 0, 'sem permissão nada é pedido');
});

const me = (role, name) => ({ userId: `user-${name.toLowerCase()}`, name, role, permissions: [...authConstants.getRolePermissions(role)], status: 'ACTIVE' });

async function painel({ hash = '#/prospeccao', permissoes = null, jobs = [] } = {}) {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await loadRouter();
  const { createFakeSdk, scriptedFetch, FAKE_SESSION } = await loadFixtures();
  const browser = createBrowser({ hash });
  const mem = { jobs: [...jobs] };
  const fetchImpl = scriptedFetch({
    'GET /config.json': { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' },
    'GET /api/me': permissoes ? { ...me('ADMIN', 'Breno'), permissions: permissoes } : me('ADMIN', 'Breno'),
    'GET /api/crm': { items: [] },
    'GET /api/prospecting/briefs': () => ({ items: [BRIEF, BRIEF2] }),
    [`GET /api/prospecting/briefs/${BRIEF.id}`]: () => ({ item: BRIEF }),
    [`GET /api/prospecting/briefs/${BRIEF2.id}`]: () => ({ item: BRIEF2 }),
    'GET /api/prospecting/jobs': () => ({ items: mem.jobs }),
    'GET /api/prospecting/jobs/JOB-20261006-001/status': () => ({ item: mem.jobs[0] }),
  });
  const navigation = browserNavigation(browser.window);
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk: createFakeSdk({ session: FAKE_SESSION }), navigation });
  await browser.flush(12);
  return { browser, fetchImpl, mem };
}
const linkMenu = (t, nome) => t.browser.by.link(t.browser.root, nome);

test('[PROS-UX-29] NO PAINEL: o módulo é persistente (aba, etapa e rascunho sobrevivem a trocar de módulo), nada é iniciado ao abrir, os links diretos do briefing e da execução funcionam e sem permissão não há acesso nem chamadas', async () => {
  const t = await painel({ jobs: [jobFinal()] });
  assert.equal(linkMenu(t, 'Nova Prospecção').getAttribute('aria-current'), 'page');
  t.browser.type(t.browser.by.id(t.browser.root, 'pros-nicho'), 'Meu rascunho');
  t.browser.click(t.browser.by.id(t.browser.root, 'pros-next'));
  await t.browser.flush(4);
  t.browser.type(t.browser.by.id(t.browser.root, 'pros-quantidade'), '12');
  t.browser.click(linkMenu(t, 'CRM'));
  await t.browser.flush(8);
  t.browser.click(linkMenu(t, 'Nova Prospecção'));
  await t.browser.flush(10);
  assert.equal(t.browser.by.id(t.browser.root, 'pros-nicho').value, 'Meu rascunho', 'o rascunho sobreviveu a trocar de módulo');
  assert.equal(t.browser.by.id(t.browser.root, 'pros-quantidade').value, '12');
  assert.equal(Number(t.browser.find(t.browser.root, (el) => /\bwizard-step-item\b/.test(el.className) && el.getAttribute('aria-current') === 'step').getAttribute('data-wizard-step')), 2, 'e a etapa');
  assert.equal(t.fetchImpl.calls.filter((c) => c.method !== 'GET').length, 0, 'nenhuma escrita: nada foi criado nem iniciado');

  const brief = await painel({ hash: `#/prospeccao/briefing/${encodeURIComponent(BRIEF2.id)}` });
  const gavetaBrief = brief.browser.find(brief.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className));
  assert.ok(gavetaBrief, 'o link direto do briefing abriu a gaveta');
  assert.equal(brief.browser.find(gavetaBrief, (el) => el.localName === 'h2').textContent, BRIEF2.id);
  assert.equal(brief.fetchImpl.calls.filter((c) => c.method !== 'GET').length, 0);

  const direto = await painel({ hash: '#/prospeccao/execucao/JOB-20261006-001', jobs: [jobFinal()] });
  assert.ok(direto.browser.find(direto.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className)), 'o link direto da execução abriu a gaveta');
  assert.equal(direto.browser.find(direto.browser.root, (el) => el.className === 'shell').hasAttribute('inert'), true);
  direto.browser.window.location.hash = '#/agentes';
  await direto.browser.flush(10);
  assert.equal(direto.browser.find(direto.browser.root, (el) => el.getAttribute('role') === 'dialog'), null, 'sair do módulo fecha a camada');
  assert.equal(direto.browser.find(direto.browser.root, (el) => el.className === 'shell').hasAttribute('inert'), false);
  assert.equal(direto.fetchImpl.calls.filter((c) => c.method !== 'GET').length, 0);

  const semAcesso = await painel({ permissoes: ['READ:CRM'] });
  assert.equal(semAcesso.browser.by.link(semAcesso.browser.root, 'Nova Prospecção'), null);
  assert.match(semAcesso.browser.root.textContent, /Esta conta não possui acesso a esta área\./);
  assert.equal(semAcesso.fetchImpl.calls.some((c) => c.path.startsWith('/api/prospecting')), false, 'nada é pedido ao servidor');
});

test('[PROS-UX-30] NO PAINEL: uma prospecção em andamento é retomada e acompanhada na aba "Em andamento"; sair do módulo para a consulta', async () => {
  const t = await painel({ jobs: [job({ currentStep: 'VALIDANDO', candidatesDiscovered: 3 })] });
  assert.match(t.browser.root.textContent, /Em execução/);
  assert.match(t.browser.root.textContent, /Validando as páginas das empresas/);
  const selecionada = t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true' && /^pros-tab-/.test(el.id));
  assert.equal(selecionada.getAttribute('data-tab'), 'andamento');
  t.browser.click(linkMenu(t, 'CRM'));
  await t.browser.flush(8);
  const consultas = t.fetchImpl.calls.filter((c) => c.path.endsWith('/status')).length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(t.fetchImpl.calls.filter((c) => c.path.endsWith('/status')).length, consultas, 'fora da tela: nenhuma consulta nova');
});

test('[PROS-UX-31] LAYOUT RESPONSIVO (CSS): abas principais com a selecionada em destaque; assistente de largura limitada (uma coluna no celular); a lista de briefings usa a largura toda e vira cartões abaixo de 900 px (sem rolagem horizontal); etapas e indicadores em coluna no celular; sem sombras pesadas', async () => {
  assert.ok(css.includes('.tabs-main .tab[aria-selected="true"] {'), 'a aba selecionada tem estilo próprio');
  assert.ok(css.includes('box-shadow: inset 0 3px 0 var(--brand-strong)'), 'identidade lime na aba e na etapa atual');
  assert.ok(css.includes('.pros-wizard-card { width: 100%; max-width: 820px; min-width: 0; margin-inline: auto;'), 'o assistente é centralizado e não se espalha em telas largas');
  assert.ok(css.includes('.wizard-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));'));
  assert.ok(css.includes('.wizard-step-item.current {'));
  assert.ok(css.includes('.pros-form-actions [hidden] { display: none; }'), 'os botões de etapa escondidos somem de verdade');
  assert.ok(css.includes('.form-field[hidden] { display: none; }'));
  const bloco900 = css.slice(css.indexOf('@media (max-width: 900px) {\n  table.briefs-table thead'));
  assert.ok(bloco900.includes('table.briefs-table, table.briefs-table tbody, table.briefs-table tr, table.briefs-table td { display: block; width: 100%; }'), 'cartões abaixo de 900 px');
  assert.ok(bloco900.includes('table.briefs-table td::before { flex: 0 0 34%; content: attr(data-label);'));
  assert.ok(bloco900.includes('overflow-wrap: anywhere'), 'texto longo quebra em vez de cortar');
  assert.ok(css.includes('@media (max-width: 760px) { .tabs-main .tab { padding: 10px 12px; font-size: 14px; } .wizard-steps { grid-template-columns: minmax(0, 1fr); }'));
  assert.ok(css.includes('@media (max-width: 560px) { .stepper { grid-template-columns: minmax(0, 1fr); } .pros-wizard-card { padding: 14px; } .pros-form-actions .btn { flex: 1 1 100%; } }'));
  assert.ok(css.includes('.tab-list { display: flex; gap: 2px; border-bottom: 1px solid var(--line); overflow-x: auto; }'), 'as abas rolam sozinhas em telas muito estreitas');
  assert.doesNotMatch(css, /\.pros-layout/, 'o layout em duas colunas (formulário × lista) saiu');
  assert.doesNotMatch(css, /box-shadow:[^;]*(?:0 (?:3\d|[4-9]\d)px)[^;]*rgba\(0, 0, 0/, 'nenhuma sombra pesada');
  assert.ok(css.includes('table.list { width: 100%; border-collapse: collapse; }'), 'as 6 colunas ocupam a largura do cartão');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// UX 4.0.5 — REFINAMENTO: formulário centralizado, proteção do rascunho ao sair da página, localidades padronizadas, só jobs ativos
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[PROS-UX-32] o formulário de Nova pesquisa é CENTRALIZADO, com largura confortável (não estica em monitores grandes) e responsivo: margem automática, teto de 820 px, largura total abaixo disso; os campos ficam dentro do cartão', async () => {
  const bloco = css.slice(css.indexOf('.pros-wizard-card {'), css.indexOf('}', css.indexOf('.pros-wizard-card {')));
  assert.match(bloco, /margin-inline:\s*auto/, 'centralizado');
  assert.match(bloco, /max-width:\s*820px/, 'o teto de largura: campos não se esticam em tela grande');
  assert.match(bloco, /width:\s*100%/, 'em telas menores ocupa a largura toda');
  assert.match(bloco, /min-width:\s*0/, 'nada empurra o cartão para fora da tela');
  assert.ok(css.includes('.pros-wizard-card { padding: 14px; }') || css.includes('.pros-wizard-card { padding: 14px; } .pros-form-actions'), 'menos respiro no celular');
  assert.doesNotMatch(css, /\.pros-wizard-card \{[^}]*margin-left:\s*0/, 'nada o cola à esquerda');
  const s = await abrir({ api: apiFalsa({ briefs: [] }) });
  const cartao = s.browser.find(raiz(s), (el) => /\bpros-wizard-card\b/.test(el.className));
  assert.ok(cartao.contains(porId(s, 'pros-form')), 'o formulário inteiro está dentro do cartão centralizado');
  assert.equal(s.browser.by.tag(cartao, 'form').length, 1);
});

test('[PROS-UX-33] PROTEÇÃO DO RASCUNHO ao ATUALIZAR ou FECHAR a aba: com alterações não salvas pede o aviso nativo (beforeunload); sem alterações não pede nada; some depois de salvar/iniciar/limpar e ao destruir a tela; o texto não promete que o aviso sempre aparece', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [] }), comNavegacao: true, hash: '#/prospeccao' });
  const win = s.browser.window;
  assert.equal(win.listenerCount('beforeunload'), 1, 'o guarda está registrado no window (pelo adaptador de navegação)');
  assert.deepEqual(win.fireBeforeUnload(), { prevented: false, returnValue: undefined }, 'sem alterações: nada é pedido e a navegação normal não é bloqueada');

  digitar(s, 'pros-nicho', 'Meu rascunho');
  const alterado = win.fireBeforeUnload();
  assert.equal(alterado.prevented, true, 'com rascunho: o aviso nativo é pedido');
  assert.equal(alterado.returnValue, '');

  // as outras mudanças de estado do rascunho: voltar ao estado inicial desliga o pedido
  digitar(s, 'pros-nicho', '');
  assert.equal(win.fireBeforeUnload().prevented, false, 'voltar ao valor inicial: sem pedido');
  digitar(s, 'pros-quantidade', '7');
  assert.equal(win.fireBeforeUnload().prevented, true, 'qualquer campo alterado conta');
  digitar(s, 'pros-quantidade', '3');

  // continua valendo mesmo com a tela fora de cena (o rascunho é guardado) e com o assistente em outra etapa/aba
  digitar(s, 'pros-nicho', 'Clínicas');
  await proximo(s);
  await aba(s, 'briefings');
  s.view.hide();
  assert.equal(win.fireBeforeUnload().prevented, true, 'o rascunho guardado também é protegido');

  // salvar com sucesso limpa o rascunho: o pedido some
  await s.view.show({ name: 'prospecting' });
  await aba(s, 'nova');
  assert.equal(etapaAtual(s), 2, 'o rascunho voltou na mesma etapa');
  digitar(s, 'pros-locais', 'Petrópolis');
  await proximo(s);
  await clicar(s, porId(s, 'pros-save'));
  assert.equal(conta(s, 'create'), 1);
  assert.equal(win.fireBeforeUnload().prevented, false, 'salvo: nada mais a proteger');

  // limpar o formulário (confirmado) também
  await aba(s, 'nova');
  digitar(s, 'pros-nicho', 'Outro');
  assert.equal(win.fireBeforeUnload().prevented, true);
  await clicar(s, porId(s, 'pros-clear'));
  await clicar(s, botaoConfirmar(s));
  assert.equal(win.fireBeforeUnload().prevented, false);

  // destruir a tela remove o guarda
  digitar(s, 'pros-nicho', 'Ainda outro');
  assert.equal(win.fireBeforeUnload().prevented, true);
  s.view.destroy();
  assert.equal(win.fireBeforeUnload().prevented, false, 'sem a tela, sem guarda');
  assert.equal(win.listenerCount('beforeunload'), 0, 'o ouvinte foi removido (nada vaza)');
});

test('[PROS-UX-34] a PROTEÇÃO não bloqueia a navegação normal e não promete nada: o início confirmado limpa o rascunho; o aviso da tela diz que o navegador "pode" pedir confirmação; sem permissão não há guarda; o adaptador só age quando o guarda responde true', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [], respostas: [job()] }), comNavegacao: true, hash: '#/prospeccao' });
  await ate3(s, { quantidade: 4, maximo: 12 });
  assert.equal(s.browser.window.fireBeforeUnload().prevented, true);
  const dica = s.browser.by.cls(raiz(s), 'draft-hint')[0].textContent;
  assert.match(dica, /Ao atualizar ou fechar a página, o navegador pode pedir confirmação\./);
  assert.doesNotMatch(dica, /sempre|garant/i, 'não alega que o aviso sempre aparece: isso é decisão do navegador');
  await clicar(s, porId(s, 'pros-start-wizard'));
  await clicar(s, botaoConfirmar(s));
  assert.equal(s.browser.window.fireBeforeUnload().prevented, false, 'a prospecção foi iniciada: o rascunho foi consumido, nada a proteger');
  // trocar de aba e de rota (navegação normal) nunca depende do guarda
  await aba(s, 'briefings');
  s.browser.window.location.hash = '#/agentes';
  await s.browser.flush(6);
  assert.equal(s.browser.window.location.hash, '#/agentes');

  const sem = await abrir({ api: apiFalsa(), canPropose: false, comNavegacao: true, hash: '#/prospeccao' });
  assert.equal(sem.browser.window.fireBeforeUnload().prevented, false, 'sem permissão: sem formulário, sem guarda');

  // o adaptador: guarda que não responde exatamente true nunca bloqueia
  const { browserNavigation } = await loadRouter();
  const b = createBrowser();
  const nav = browserNavigation(b.window);
  const solta = nav.setLeaveGuard(() => 'sim');
  assert.equal(b.window.fireBeforeUnload().prevented, false, 'só true bloqueia');
  solta();
  const solta2 = nav.setLeaveGuard(() => true);
  assert.equal(b.window.fireBeforeUnload().prevented, true);
  solta2();
  assert.equal(b.window.fireBeforeUnload().prevented, false);
  assert.equal(b.window.listenerCount('beforeunload'), 0);
});

test('[PROS-UX-35] LOCALIDADES padronizadas SÓ NA EXIBIÇÃO: "petrópolis/rj", "NITERÓI - RJ", "rio de janeiro" e "sp" aparecem como "Petrópolis/RJ", "Niterói/RJ", "Rio de Janeiro" e "SP" na lista, na gaveta, na execução e no resumo; o valor guardado e o enviado ao servidor não mudam', async () => {
  const { formatLocation, formatLocations } = await import('../../dashboard/format.mjs');
  const casos = [['petrópolis/rj', 'Petrópolis/RJ'], ['NITERÓI - RJ', 'Niterói/RJ'], ['rio de janeiro', 'Rio de Janeiro'], ['sp', 'SP'], ['  teresópolis   /  rj ', 'Teresópolis/RJ'], ['Nova Friburgo-RJ', 'Nova Friburgo/RJ'], ['são josé do vale do rio preto/rj', 'São José do Vale do Rio Preto/RJ'], ['conceição-de-macabu', 'Conceição-de-Macabu'], ['brasil', 'Brasil'], ['Petrópolis/RJ', 'Petrópolis/RJ'], ['', '']];
  for (const [entrada, esperado] of casos) assert.equal(formatLocation(entrada), esperado, JSON.stringify(entrada));
  assert.equal(formatLocation(formatLocation('NITERÓI - RJ')), 'Niterói/RJ', 'idempotente');
  assert.doesNotMatch(formatLocation('Xx/ZZ'), /ZZ$/, 'só vira UF maiúscula o que é UF brasileira de verdade');
  assert.equal(formatLocation('petropolis'), 'Petropolis', 'nunca inventa acento');
  assert.equal(formatLocation(42), '42');
  assert.equal(formatLocation({}), '');
  assert.equal(formatLocations(['petrópolis/rj', 'NITERÓI - RJ', '']), 'Petrópolis/RJ, Niterói/RJ');
  assert.equal(formatLocations(null), '');

  const bruto = { ...BRIEF, id: 'PROS-20261001-007', cidades: ['petrópolis/rj', 'NITERÓI - RJ'], nicho: 'clínicas' };
  const estados = { ...BRIEF2, id: 'PROS-20261002-008', nivelGeografico: 'ESTADO', cidades: undefined, estados: ['rio de janeiro', 'sp'], status: 'RASCUNHO' };
  const copia = JSON.stringify([bruto, estados]);
  const s = await abrir({ api: apiFalsa({ briefs: [bruto, estados], jobs: [job({ briefId: bruto.id })], respostas: [job({ briefId: bruto.id })] }) });
  assert.match(painelAba(s, 'andamento').textContent, /Petrópolis\/RJ, Niterói\/RJ/, 'na execução em andamento');
  await aba(s, 'briefings');
  const linha = (id) => s.browser.find(raiz(s), (el) => el.localName === 'tr' && el.getAttribute('data-brief') === id);
  assert.equal(s.browser.find(linha(bruto.id), (el) => el.getAttribute('data-label') === 'Localização').textContent, 'Petrópolis/RJ, Niterói/RJ', 'na lista');
  assert.equal(s.browser.find(linha(estados.id), (el) => el.getAttribute('data-label') === 'Localização').textContent, 'Rio de Janeiro, SP');
  await clicar(s, s.browser.by.button(raiz(s), bruto.id));
  assert.match(gaveta(s).textContent, /AbrangênciaCidade: Petrópolis\/RJ, Niterói\/RJ/, 'na gaveta do briefing');
  s.browser.press('Escape');
  await s.browser.flush(6);
  await clicar(s, s.browser.by.button(raiz(s), estados.id));
  assert.match(gaveta(s).textContent, /AbrangênciaEstado: Rio de Janeiro, SP/);
  s.browser.press('Escape');
  await s.browser.flush(6);
  // a busca continua achando pelo texto como foi guardado (sem acento, minúsculas) e pelo padronizado
  s.browser.type(s.browser.by.label(raiz(s), 'Buscar briefing'), 'niteroi');
  assert.match(painelAba(s, 'briefings').textContent, /2 briefings · 1 no filtro/);
  s.browser.type(s.browser.by.label(raiz(s), 'Buscar briefing'), 'NITERÓI - RJ');
  assert.match(painelAba(s, 'briefings').textContent, /1 no filtro/);
  assert.equal(JSON.stringify(s.api.mem.briefs.filter((b) => [bruto.id, estados.id].includes(b.id)).sort((a, b) => a.id.localeCompare(b.id))), copia, 'os briefings guardados NÃO foram alterados (nem regravados)');
  assert.equal(conta(s, 'create'), 0);

  // o assistente: o resumo mostra padronizado; o que vai ao servidor é exatamente o que foi digitado
  const w = await abrir({ api: apiFalsa({ briefs: [] }) });
  await ate3(w, { locais: 'petrópolis/rj, NITERÓI - RJ' });
  assert.match(porId(w, 'pros-summary').textContent, /LocalCidade: Petrópolis\/RJ, Niterói\/RJ/);
  await clicar(w, porId(w, 'pros-save'));
  assert.equal(w.api.chamadas.find(([n]) => n === 'create')[1].cidades, 'petrópolis/rj, NITERÓI - RJ', 'o valor enviado é o digitado, sem padronização');
});

test('[PROS-UX-36] a localização dos CANDIDATOS e do Histórico também é só exibição padronizada (briefPlace e a gaveta da execução); dados originais intactos', async () => {
  const { briefPlace } = await import('../../dashboard/views/jobDetails.mjs');
  const brief = { nivelGeografico: 'CIDADE', cidades: ['petrópolis/rj', 'TERESÓPOLIS - RJ'] };
  assert.equal(briefPlace(brief), 'Petrópolis/RJ, Teresópolis/RJ');
  assert.deepEqual(brief.cidades, ['petrópolis/rj', 'TERESÓPOLIS - RJ'], 'o brief original não é mutado');
  assert.equal(briefPlace({ nivelGeografico: 'ESTADO', estados: ['sp', 'rio de janeiro'] }), 'SP, Rio de Janeiro');
  assert.equal(briefPlace({ nivelGeografico: 'NACIONAL', pais: 'brasil' }), 'Brasil');
  assert.equal(briefPlace({ nivelGeografico: 'NACIONAL' }), 'Brasil');
  assert.equal(briefPlace(null), '');
  const candidatos = [cand('Clínica Zeta', { localizacao: 'petrópolis - rj', entrega: { naFila: true } })];
  const s = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [job()] }) });
  s.api.mem.jobs = [job({ candidatos: candidatos })];
  await s.view.refresh();
  await s.browser.flush(6);
  await clicar(s, porId(s, 'pros-job-details'));
  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-tab') === 'candidatos'));
  assert.match(painelDaAbaGaveta(s, 'candidatos').textContent, /Estética · Petrópolis\/RJ/);
  assert.equal(candidatos[0].localizacao, 'petrópolis - rj', 'o dado original do candidato continua como veio');
});

test('[PROS-UX-37] IDENTIFICAÇÃO DE JOBS ATIVOS: só o STATUS DO JOB conta; um briefing antigo "Pesquisando" não é prova de execução (aba, contador, acompanhamento, vazio e aviso na gaveta); cada status de job não ativo fica de fora', async () => {
  const antigo = { ...BRIEF, status: 'PESQUISANDO' };
  const s = await abrir({ api: apiFalsa({ briefs: [antigo, BRIEF2] }) });
  assert.equal(abaAtiva(s), 'nova', 'não salta para "Em andamento" por causa do status de um briefing');
  assert.equal(abaBotao(s, 'andamento').textContent, 'Em andamento', 'sem contador');
  assert.equal(s.ag.pendentes().length, 0, 'nenhum acompanhamento');
  assert.equal(conta(s, 'status'), 0);
  await aba(s, 'andamento');
  assert.ok(porId(s, 'pros-run-empty'), 'o estado vazio correto');
  assert.match(painelAba(s, 'andamento').textContent, /Nenhuma prospecção em andamento/);
  assert.equal(porId(s, 'pros-auto'), null);
  assert.equal(porId(s, 'pros-job-details'), null);
  await aba(s, 'briefings');
  assert.match(painelAba(s, 'briefings').textContent, /Pesquisando/, 'o status do briefing continua visível como o que é: o status do briefing');
  await clicar(s, s.browser.by.button(raiz(s), antigo.id));
  assert.match(porId(s, 'pros-stale-note').textContent, /consta como "Pesquisando", mas não há nenhuma prospecção em andamento registrada para ele\. O status do briefing não é uma execução\./);
  assert.equal(s.browser.by.id(gaveta(s), 'pros-start-job'), null, 'não oferece iniciar outra (a regra de estados continua)');
  assert.equal(conta(s, 'start'), 0);

  // job com status ativo de verdade, e cada status que NÃO é ativo
  const ativos = ['CRIADO', 'EXECUTANDO', 'CANCELAMENTO_SOLICITADO'];
  for (const status of ativos) {
    const t = await abrir({ api: apiFalsa({ jobs: [job({ status })], respostas: [job({ status })] }) });
    assert.equal(abaAtiva(t), 'andamento', status);
    assert.equal(abaBotao(t, 'andamento').textContent, 'Em andamento1', status);
    assert.equal(t.ag.pendentes().length, 1, status);
  }
  for (const status of ['CONCLUIDO', 'PARCIAL', 'ERRO', 'CANCELADO']) {
    const t = await abrir({ api: apiFalsa({ jobs: [job({ status, currentStep: 'FINALIZADO' })] }) });
    assert.equal(abaAtiva(t), 'nova', status);
    assert.equal(abaBotao(t, 'andamento').textContent, 'Em andamento', status);
    assert.equal(t.ag.pendentes().length, 0, status);
    await aba(t, 'andamento');
    assert.equal(porId(t, 'pros-auto'), null, status);
  }

  // o briefing "Pesquisando" COM job ativo é reconhecido pelo job, não pelo status
  const comJob = await abrir({ api: apiFalsa({ briefs: [antigo], jobs: [job({ briefId: antigo.id })], respostas: [job({ briefId: antigo.id })] }) });
  assert.equal(abaAtiva(comJob), 'andamento');
  await aba(comJob, 'briefings');
  await clicar(comJob, comJob.browser.by.button(raiz(comJob), antigo.id));
  assert.equal(porId(comJob, 'pros-stale-note'), null, 'há job ativo: o aviso não se aplica');
  assert.match(gaveta(comJob).textContent, /Há uma prospecção em andamento para este briefing/);
});

test('[PROS-UX-38] a ATUALIZAÇÃO AUTOMÁTICA continua moderada e se interrompe: só com job ativo e tela à vista; para ao terminar; ao sair; um job antigo ou um briefing "Pesquisando" nunca a liga; o resultado da execução que acabou de terminar não reinicia a consulta', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [{ ...BRIEF, status: 'PESQUISANDO' }], jobs: [job({ status: 'ERRO', currentStep: 'FINALIZADO' })] }) });
  assert.equal(s.ag.pendentes().length, 0);
  s.view.hide();
  await s.view.show({ name: 'prospecting' });
  await s.browser.flush(6);
  assert.equal(s.ag.pendentes().length, 0, 'voltar à tela também não liga a consulta');
  assert.equal(conta(s, 'status'), 0);

  const t = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [job({ candidatesDiscovered: 2 }), jobFinal()] }) });
  assert.equal(t.ag.pendentes()[0].ms, 4000, 'intervalo moderado');
  await t.ag.rodar();
  await t.browser.flush(6);
  assert.equal(t.ag.pendentes().length, 1);
  await t.ag.rodar();
  await t.browser.flush(10);
  assert.equal(t.ag.pendentes().length, 0, 'terminou: parou');
  t.view.hide();
  await t.view.show({ name: 'prospecting' });
  await t.browser.flush(8);
  assert.equal(t.ag.pendentes().length, 0, 'job terminado não religa a consulta');
  assert.equal(conta(t, 'status'), 2);
});
