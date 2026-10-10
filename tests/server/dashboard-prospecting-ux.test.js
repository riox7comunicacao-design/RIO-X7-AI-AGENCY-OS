// Nova Prospecção na UX 4.0.4: formulário em seções com validação ANTES do envio, contrato briefing (sem maxCandidates) + job (briefId + maxCandidates), confirmação humana
// antes de iniciar (e de refazer), cliques duplicados, erros que preservam o digitado, acompanhamento por etapas reais com consulta moderada que PARA quando não é mais
// necessária, gaveta da execução com URL (ESC, X, Voltar, Avançar, link direto) reutilizando o detalhe do Histórico, e a tela persistente na sessão. DOM de teste e API
// falsa — nenhum navegador, nenhuma rede, nenhum Claude, nenhuma prospecção real, nenhum dado real.

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
const BRIEF2 = { ...BRIEF, id: 'PROS-20261007-002', nicho: 'Psicologia', subnicho: undefined, cidades: ['Niterói/RJ'], quantidade: 5, status: 'AGUARDANDO_REVISAO' };

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

// API falsa com o "servidor" mutável e o registro de tudo o que foi pedido: a tela só pode ler, criar o briefing e — depois de confirmar — iniciar/refazer.
function apiFalsa({ briefs = [BRIEF], jobs = [], respostas = [], criar, iniciar, refazer, cancelar } = {}) {
  const chamadas = [];
  const mem = { briefs: [...briefs], jobs: [...jobs], respostas: [...respostas] };
  const api = {
    chamadas,
    mem,
    listProspectingBriefs: async () => { chamadas.push(['briefs']); if (mem.falharBriefs) throw Object.assign(new Error('x'), { status: 500 }); return { items: [...mem.briefs] }; },
    createProspectingBrief: async (fields) => {
      chamadas.push(['create', fields]);
      if (criar) return criar(fields, mem);
      const novo = { ...BRIEF, id: 'PROS-20261008-009', ...fields, cidades: [fields.cidades], contagens: null };
      mem.briefs = [novo, ...mem.briefs];
      return { item: novo };
    },
    getProspectingBrief: async (id) => { chamadas.push(['brief', id]); return { item: mem.briefs.find((b) => b.id === id) }; },
    listProspectingJobs: async (briefId) => { chamadas.push(['jobs', briefId]); return { items: mem.jobs.filter((j) => briefId === undefined || j.briefId === briefId) }; },
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
    markProspectingBriefReady: async (id) => { chamadas.push(['ready', id]); mem.briefs = mem.briefs.map((b) => (b.id === id ? { ...b, status: 'PRONTO_PARA_PESQUISA' } : b)); return { item: {} }; },
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
const avisos = (s) => s.browser.findAll(raiz(s), (el) => el.className === 'toast-message').map((el) => el.textContent);
const gaveta = (s) => s.browser.find(raiz(s), (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const modal = (s) => s.browser.find(raiz(s), (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className));
const botaoConfirmar = (s) => s.browser.find(raiz(s), (el) => el.getAttribute('data-action') === 'confirm');
const clicar = async (s, el) => { s.browser.click(el); await s.browser.flush(6); };
const selecionar = async (s, id = BRIEF.id) => { await clicar(s, s.browser.by.button(raiz(s), id)); };
const tela = (s) => raiz(s).textContent.replace(/\s+/g, ' ');
const painelDaAba = (s, chave) => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tabpanel' && new RegExp(chave).test(el.getAttribute('aria-labelledby') || ''));
const erroDe = (s, id) => porId(s, `${id}-error`);
const preencherValido = (s, extras = {}) => {
  digitar(s, 'pros-nicho', extras.nicho || 'Clínicas de estética');
  digitar(s, 'pros-locais', extras.locais || 'Petrópolis, Teresópolis');
  if (extras.quantidade !== undefined) digitar(s, 'pros-quantidade', String(extras.quantidade));
  if (extras.maximo !== undefined) digitar(s, 'pros-max-candidates', String(extras.maximo));
};
const criar = async (s) => { await clicar(s, porId(s, 'pros-create')); };

// ---------------------------------------------------------------------------------------------------------------------------------------------
// O FORMULÁRIO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[PROS-UX-1] o formulário em SEÇÕES (O que prospectar, Onde, Quantidades, Informações adicionais), com campos identificados, obrigatórios marcados e ajudas curtas; "leads novos desejados" e "máximo de candidatos" nunca se confundem', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [] }) });
  const legendas = s.browser.by.tag(porId(s, 'pros-form'), 'legend').map((el) => el.textContent);
  assert.deepEqual(legendas, ['O que prospectar', 'Onde', 'Quantidades', 'Informações adicionais']);
  assert.equal(porId(s, 'pros-form-title').textContent, 'Novo briefing');
  const rotulos = s.browser.by.tag(porId(s, 'pros-form'), 'label').map((el) => el.textContent);
  assert.deepEqual(rotulos, ['Nicho', 'Subnicho (opcional)', 'Abrangência geográfica', 'Cidade(s) — separadas por vírgula', 'País', 'Quantidade de leads novos desejados (1–300)', 'Máximo de candidatos examinados (1–100)', 'Observações / objetivo (opcional)']);
  for (const id of ['pros-nicho', 'pros-nivel', 'pros-locais', 'pros-quantidade', 'pros-max-candidates']) {
    assert.equal(s.browser.find(porId(s, 'pros-form'), (el) => el.localName === 'label' && el.getAttribute('for') === id).className, 'required', `${id} é obrigatório`);
    assert.equal(porId(s, id).getAttribute('aria-required'), 'true');
  }
  assert.equal(s.browser.find(porId(s, 'pros-form'), (el) => el.localName === 'label' && el.getAttribute('for') === 'pros-subnicho').className, '', 'subnicho é opcional');
  assert.match(porId(s, 'pros-quantidade-help').textContent, /NOVOS leads.*Approval Queue\. Não é o número de candidatos examinados\./);
  assert.match(porId(s, 'pros-max-candidates-help').textContent, /Limite de empresas que a pesquisa poderá examinar/);
  assert.match(porId(s, 'pros-quantidade').getAttribute('aria-describedby'), /pros-quantidade-help pros-quantidade-error/);
  assert.deepEqual([porId(s, 'pros-quantidade').value, porId(s, 'pros-max-candidates').value], ['50', '50']);
  assert.equal(porId(s, 'pros-form').getAttribute('novalidate'), 'novalidate', 'a validação é da tela (mensagens em português), não do navegador');

  // abrangência: cidade/estado mostram a lista de locais (com o rótulo certo); nacional mostra o país
  const nivel = porId(s, 'pros-nivel');
  assert.deepEqual(s.browser.findAll(nivel, (el) => el.localName === 'option').map((o) => o.textContent), ['Cidade', 'Estado', 'Nacional']);
  s.browser.choose(nivel, 'ESTADO');
  assert.equal(porId(s, 'pros-locais').parentNode.hidden, false);
  assert.equal(s.browser.find(porId(s, 'pros-form'), (el) => el.localName === 'label' && el.getAttribute('for') === 'pros-locais').textContent, 'Estado(s) — separados por vírgula');
  assert.equal(porId(s, 'pros-pais').parentNode.hidden, true);
  s.browser.choose(nivel, 'NACIONAL');
  assert.equal(porId(s, 'pros-locais').parentNode.hidden, true);
  assert.equal(porId(s, 'pros-pais').parentNode.hidden, false);
  assert.equal(porId(s, 'pros-pais').value, 'Brasil');
  assert.ok(css.includes('.form-field[hidden] { display: none; }'), 'o campo escondido some de verdade (display do .field não vence o hidden)');
});

test('[PROS-UX-2] VALIDAÇÃO antes do envio: mensagens por campo, foco no primeiro erro, aviso; nenhuma chamada à API; depois da primeira tentativa o erro some assim que o campo fica certo', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [] }) });
  await criar(s);
  assert.equal(conta(s, 'create'), 0, 'formulário vazio não chama a API');
  assert.equal(erroDe(s, 'pros-nicho').textContent, 'Informe o nicho que será prospectado.');
  assert.equal(erroDe(s, 'pros-nicho').hidden, false);
  assert.equal(porId(s, 'pros-nicho').getAttribute('aria-invalid'), 'true');
  assert.equal(erroDe(s, 'pros-locais').textContent, 'Informe ao menos uma cidade.');
  assert.equal(s.browser.document.activeElement.id, 'pros-nicho', 'o foco vai ao primeiro campo com erro');
  assert.ok(avisos(s).includes('Revise os campos destacados antes de criar o briefing.'));
  assert.equal(erroDe(s, 'pros-quantidade').hidden, true, 'os campos certos não mostram erro');

  digitar(s, 'pros-nicho', 'Clínicas');
  assert.equal(erroDe(s, 'pros-nicho').hidden, true, 'o erro some ao corrigir');
  assert.equal(porId(s, 'pros-nicho').hasAttribute('aria-invalid'), false);
  s.browser.choose(porId(s, 'pros-nivel'), 'ESTADO');
  assert.equal(erroDe(s, 'pros-locais').textContent, 'Informe ao menos um estado.', 'a mensagem acompanha a abrangência');
  digitar(s, 'pros-locais', 'RJ');
  assert.equal(erroDe(s, 'pros-locais').hidden, true);
  assert.equal(conta(s, 'create'), 0);
});

test('[PROS-UX-3] os LIMITES vêm do servidor (nicho/subnicho/local 120, país 60, observações 2000, 20 locais, quantidade 1–300) e o máximo de candidatos 1–100; nenhum outro limite é inventado', async () => {
  const { validateForm, BRIEF_LIMITS, MAX_CANDIDATES_MAX, MAX_CANDIDATES_MIN, splitLocais, emptyForm } = await loadView();
  assert.deepEqual({ ...BRIEF_LIMITS }, { NICHO: 120, SUBNICHO: 120, LOCAL: 120, PAIS: 60, OBSERVACOES: 2000, MAX_LOCAIS: 20, QUANTIDADE_MIN: 1, QUANTIDADE_MAX: 300 });
  assert.deepEqual([MAX_CANDIDATES_MIN, MAX_CANDIDATES_MAX], [1, 100]);
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
});

test('[PROS-UX-4] o CONTRATO: o briefing leva só os campos que o endpoint aceita (nunca maxCandidates); estado/nacional usam estados/pais; subnicho e observações só se preenchidos; maxCandidates só vai ao INICIAR o job', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [] }) });
  preencherValido(s, { quantidade: 4, maximo: 12 });
  digitar(s, 'pros-subnicho', '  Harmonização ');
  digitar(s, 'pros-observacoes', '  Só clínicas com site  ');
  await criar(s);
  const [, campos] = s.api.chamadas.find(([n]) => n === 'create');
  assert.deepEqual(campos, { nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', quantidade: 4, subnicho: 'Harmonização', observacoes: 'Só clínicas com site', cidades: 'Petrópolis, Teresópolis' });
  assert.equal('maxCandidates' in campos, false);
  assert.equal(conta(s, 'start'), 0, 'criar o briefing não inicia pesquisa');

  const estado = await abrir({ api: apiFalsa({ briefs: [] }) });
  s.browser.choose(porId(estado, 'pros-nivel'), 'ESTADO');
  estado.browser.choose(porId(estado, 'pros-nivel'), 'ESTADO');
  digitar(estado, 'pros-nicho', 'Odontologia');
  digitar(estado, 'pros-locais', 'SP, RJ');
  await criar(estado);
  assert.deepEqual(estado.api.chamadas.find(([n]) => n === 'create')[1], { nicho: 'Odontologia', nivelGeografico: 'ESTADO', quantidade: 50, estados: 'SP, RJ' });

  const nacional = await abrir({ api: apiFalsa({ briefs: [] }) });
  nacional.browser.choose(porId(nacional, 'pros-nivel'), 'NACIONAL');
  digitar(nacional, 'pros-nicho', 'Contabilidade');
  digitar(nacional, 'pros-pais', '');
  await criar(nacional);
  assert.deepEqual(nacional.api.chamadas.find(([n]) => n === 'create')[1], { nicho: 'Contabilidade', nivelGeografico: 'NACIONAL', quantidade: 50, pais: 'Brasil' }, 'país em branco vale Brasil');
});

test('[PROS-UX-5] o RASCUNHO é protegido: o que foi digitado fica ao trocar de módulo; um ERRO do servidor não apaga nada; "Limpar" pergunta antes de descartar; criar com sucesso limpa e avisa só depois da resposta', async () => {
  let falhar = true;
  const criarFalso = (fields, mem) => {
    if (falhar) throw Object.assign(new Error('x'), { status: 400, serverMessage: 'O nicho informado não é aceito.' });
    const novo = { ...BRIEF, id: 'PROS-20261008-009', ...fields, cidades: [fields.cidades], contagens: null };
    mem.briefs = [novo, ...mem.briefs];
    return { item: novo };
  };
  const s = await abrir({ api: apiFalsa({ briefs: [], criar: criarFalso }) });
  assert.equal(porId(s, 'pros-clear').disabled, false);
  assert.equal(s.browser.by.cls(raiz(s), 'draft-hint')[0].hidden, true, 'sem alterações: sem aviso de rascunho');
  preencherValido(s, { quantidade: 9, maximo: 20 });
  digitar(s, 'pros-observacoes', 'Texto importante');
  assert.equal(s.browser.by.cls(raiz(s), 'draft-hint')[0].hidden, false);
  assert.equal(porId(s, 'pros-observacoes').parentNode.textContent.includes('16/2000'), true, 'contador de caracteres');

  // sair e voltar ao módulo: o rascunho continua
  s.view.hide();
  await s.view.show({ name: 'prospecting' });
  await s.browser.flush(6);
  assert.deepEqual([porId(s, 'pros-nicho').value, porId(s, 'pros-quantidade').value, porId(s, 'pros-max-candidates').value, porId(s, 'pros-observacoes').value], ['Clínicas de estética', '9', '20', 'Texto importante']);

  // erro do servidor: nada é apagado e a mensagem é compreensível; nenhum sucesso
  await criar(s);
  assert.equal(conta(s, 'create'), 1);
  assert.deepEqual([porId(s, 'pros-nicho').value, porId(s, 'pros-locais').value, porId(s, 'pros-quantidade').value, porId(s, 'pros-max-candidates').value, porId(s, 'pros-observacoes').value], ['Clínicas de estética', 'Petrópolis, Teresópolis', '9', '20', 'Texto importante'], 'tudo o que foi digitado fica');
  assert.ok(avisos(s).includes('O nicho informado não é aceito.'));
  assert.equal(avisos(s).some((t) => /criado/.test(t)), false, 'nenhum sucesso antes da confirmação do servidor');
  assert.equal(porId(s, 'pros-create').disabled, false, 'dá para tentar de novo');

  // limpar: pergunta antes; "Continuar editando" mantém; "Descartar" limpa
  await clicar(s, porId(s, 'pros-clear'));
  assert.ok(modal(s));
  assert.match(modal(s).textContent, /Descartar o rascunho\?.*será perdido/s);
  await clicar(s, s.browser.find(raiz(s), (el) => el.localName === 'button' && el.textContent === 'Continuar editando'));
  assert.equal(porId(s, 'pros-nicho').value, 'Clínicas de estética');
  await clicar(s, porId(s, 'pros-clear'));
  await clicar(s, botaoConfirmar(s));
  assert.deepEqual([porId(s, 'pros-nicho').value, porId(s, 'pros-quantidade').value, porId(s, 'pros-observacoes').value], ['', '50', '']);
  assert.equal(s.browser.by.cls(raiz(s), 'draft-hint')[0].hidden, true);
  await clicar(s, porId(s, 'pros-clear'));
  assert.equal(modal(s), null, 'sem rascunho, nada a perguntar');

  // sucesso: avisa depois da resposta, limpa e seleciona o briefing novo
  falhar = false;
  preencherValido(s, { quantidade: 3, maximo: 10 });
  await criar(s);
  assert.ok(avisos(s).some((t) => /Briefing PROS-20261008-009 criado/.test(t)));
  assert.equal(porId(s, 'pros-nicho').value, '');
  assert.ok(porId(s, 'pros-start-job'), 'o briefing novo já aparece selecionado, pronto para iniciar');
});

test('[PROS-UX-6] duplo clique em "Criar briefing" cria UM briefing; o botão fica desabilitado enquanto envia', async () => {
  let liberar;
  const espera = new Promise((resolve) => { liberar = resolve; });
  const criarLento = async (fields, mem) => {
    await espera;
    const novo = { ...BRIEF, id: 'PROS-20261008-009', ...fields, cidades: [fields.cidades], contagens: null };
    mem.briefs = [novo, ...mem.briefs];
    return { item: novo };
  };
  const s = await abrir({ api: apiFalsa({ briefs: [], criar: criarLento }) });
  preencherValido(s);
  const botao = porId(s, 'pros-create');
  s.browser.click(botao);
  await s.browser.flush(2);
  s.browser.click(botao);
  s.browser.click(botao);
  assert.equal(botao.disabled, true);
  assert.equal(botao.textContent, 'Criando…');
  liberar();
  await s.browser.flush(10);
  assert.equal(conta(s, 'create'), 1);
  assert.equal(botao.textContent, 'Criar briefing');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// INICIAR: confirmação humana
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[PROS-UX-7] a CONFIRMAÇÃO antes de iniciar: resume nicho, local, leads desejados e máximo; avisa do Claude Code local e do limite de uso; deixa claro que não aprova, não promove e não inicia contato; abrir não inicia nada', async () => {
  const s = await abrir({ api: apiFalsa() });
  await selecionar(s);
  assert.equal(conta(s, 'start'), 0);
  await clicar(s, porId(s, 'pros-start-job'));
  const m = modal(s);
  assert.ok(m, 'o modal de confirmação abriu');
  assert.equal(conta(s, 'start'), 0, 'abrir a confirmação não inicia a prospecção');
  const texto = m.textContent.replace(/\s+/g, ' ');
  assert.match(texto, /Iniciar prospecção.*Briefing PROS-20261006-001/);
  assert.match(texto, /NichoClínicas de estética \/ Harmonização/);
  assert.match(texto, /LocalPetrópolis\/RJ/);
  assert.match(texto, /Leads novos desejados3/);
  assert.match(texto, /Máximo de candidatos examinados50/);
  assert.match(texto, /usa o Claude Code instalado neste computador e pode consumir o seu limite de uso/);
  assert.match(texto, /não aprova leads, não promove nada ao CRM e não inicia nenhum contato/);
  assert.match(texto, /Só uma prospecção roda por vez/);
  assert.ok(s.browser.by.button(m, 'Iniciar prospecção'));
  assert.ok(s.browser.by.button(m, 'Cancelar'));
});

test('[PROS-UX-8] CANCELAR a confirmação (Cancelar ou ESC) não executa nada e a tela fica como estava; o foco volta ao botão', async () => {
  const s = await abrir({ api: apiFalsa() });
  await selecionar(s);
  await clicar(s, porId(s, 'pros-start-job'));
  await clicar(s, s.browser.by.button(modal(s), 'Cancelar'));
  assert.equal(modal(s), null);
  assert.equal(conta(s, 'start'), 0);
  assert.ok(porId(s, 'pros-start-job'), 'continua pronto para iniciar');
  assert.equal(s.browser.document.activeElement === porId(s, 'pros-start-job'), true, 'o foco volta ao botão que abriu');
  await clicar(s, porId(s, 'pros-start-job'));
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(modal(s), null);
  assert.equal(conta(s, 'start'), 0);
  assert.equal(s.ag.pendentes().length, 0, 'nenhuma consulta de status foi agendada');
});

test('[PROS-UX-9] confirmar com cliques triplos inicia UMA prospecção, só depois da resposta há sucesso (aviso), o job aparece em andamento, o acompanhamento começa e o barramento é avisado', async () => {
  let liberar;
  const espera = new Promise((resolve) => { liberar = resolve; });
  const iniciarLento = async (briefId, max, mem) => {
    await espera;
    const criado = job({ briefId });
    mem.jobs = [criado, ...mem.jobs];
    return { item: criado };
  };
  const s = await abrir({ api: apiFalsa({ iniciar: iniciarLento, respostas: [job()] }) });
  await selecionar(s);
  digitar(s, 'pros-start-max', '25');
  await clicar(s, porId(s, 'pros-start-job'));
  const confirmar = botaoConfirmar(s);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  await s.browser.flush(4);
  assert.equal(avisos(s).some((t) => /Prospecção iniciada/.test(t)), false, 'nada de sucesso antes da resposta do servidor');
  assert.equal(confirmar.disabled, true);
  liberar();
  await s.browser.flush(10);
  assert.deepEqual(s.api.chamadas.filter(([n]) => n === 'start'), [['start', BRIEF.id, 25]], 'uma única prospecção, com o máximo editado');
  assert.equal(modal(s), null);
  assert.ok(avisos(s).includes('Prospecção iniciada. Acompanhe o andamento abaixo; nenhum lead é aprovado ou enviado ao CRM por isso.'));
  assert.deepEqual(s.eventos, [['start', 'JOB-20261006-001']]);
  assert.equal(s.ag.pendentes().length, 1, 'o acompanhamento começou');
  assert.equal(porId(s, 'pros-start-job'), null);
  assert.equal(s.browser.document.activeElement === porId(s, 'pros-job-details'), true, 'o foco vai ao cartão da execução');
});

test('[PROS-UX-10] ERROS do backend ao iniciar (409 "já existe uma em execução"): a confirmação continua aberta com a mensagem, sem sucesso, dá para tentar de novo; o máximo editado é validado ANTES (1–100)', async () => {
  let falhar = true;
  const iniciarComErro = (briefId, max, mem) => {
    if (falhar) throw Object.assign(new Error('x'), { status: 409, serverMessage: 'Já existe uma prospecção em execução. Aguarde ela terminar ou cancele.' });
    const criado = job({ briefId });
    mem.jobs = [criado];
    return { item: criado };
  };
  const s = await abrir({ api: apiFalsa({ iniciar: iniciarComErro, respostas: [job()] }) });
  await selecionar(s);

  digitar(s, 'pros-start-max', '101');
  await clicar(s, porId(s, 'pros-start-job'));
  assert.equal(modal(s), null, 'máximo inválido: nem abre a confirmação');
  assert.equal(conta(s, 'start'), 0);
  assert.equal(porId(s, 'pros-start-max-error').textContent, 'Informe um número inteiro de 1 a 100 candidatos.');
  assert.equal(s.browser.document.activeElement.id, 'pros-start-max');
  digitar(s, 'pros-start-max', '0');
  digitar(s, 'pros-start-max', '30');
  assert.equal(porId(s, 'pros-start-max-error').hidden, true, 'o erro some ao corrigir');

  await clicar(s, porId(s, 'pros-start-job'));
  await clicar(s, botaoConfirmar(s));
  assert.ok(modal(s), 'o erro NÃO fecha a confirmação');
  assert.match(modal(s).textContent, /Já existe uma prospecção em execução/);
  assert.equal(avisos(s).some((t) => /Prospecção iniciada/.test(t)), false);
  assert.equal(botaoConfirmar(s).disabled, false, 'dá para tentar de novo');
  assert.equal(s.ag.pendentes().length, 0, 'sem job, nenhum acompanhamento');
  falhar = false;
  await clicar(s, botaoConfirmar(s));
  assert.equal(modal(s), null);
  assert.deepEqual(s.api.chamadas.filter(([n]) => n === 'start').map(([, , max]) => max), [30, 30]);
  assert.match(tela(s), /Em execução/);
});

test('[PROS-UX-11] NADA começa sozinho: abrir a tela, selecionar um briefing pronto, trocar de módulo e voltar, abrir a gaveta ou o link direto nunca inicia, refaz, aprova, rejeita, reconsidera nem pesquisa', async () => {
  const s = await abrir({ api: apiFalsa({ briefs: [BRIEF, BRIEF2], jobs: [jobFinal()] }), comNavegacao: true, hash: '#/prospeccao' });
  await selecionar(s, BRIEF2.id);
  await selecionar(s);
  s.view.hide();
  await s.view.show({ name: 'prospecting' });
  await s.browser.flush(6);
  await clicar(s, porId(s, 'pros-job-details'));
  assert.ok(gaveta(s));
  s.browser.press('Escape');
  await s.browser.flush(6);
  s.browser.window.location.hash = '#/prospeccao/execucao/JOB-20261006-001';
  await s.browser.flush(10);
  assert.ok(gaveta(s));
  for (const proibida of ['start', 'redo', 'approve', 'reject', 'reaprovar', 'pesquisar', 'create', 'cancel', 'cancelBrief', 'ready']) assert.equal(conta(s, proibida), 0, proibida);
  assert.equal(s.ag.pendentes().length, 0, 'job terminado: nenhuma consulta agendada');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// ACOMPANHAMENTO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[PROS-UX-12] a EXECUÇÃO por etapas reais: Descoberta, Validação e Envio à aprovação com seu estado (concluída, em andamento, aguardando); sem percentual; indicadores de encontrados, validados, entregues, retidos e não validados', async () => {
  const andamento = job({ currentStep: 'INGERINDO', candidatesDiscovered: 7, candidatesValidated: 3, candidatesRejected: 4, leadsNaFila: 1, elapsedMs: 83000, telemetria: { custoUsd: 0.12, reposicoesRealizadas: 1 }, lote: { naFila: 1, foraDaFila: 2 } });
  const s = await abrir({ api: apiFalsa({ jobs: [andamento], respostas: [andamento] }) });
  await s.browser.flush(6);
  assert.deepEqual(s.browser.by.cls(raiz(s), 'step').map((li) => [li.getAttribute('data-step'), li.className, li.textContent]), [
    ['DESCOBRINDO', 'step done', 'Descobertaconcluída'],
    ['VALIDANDO', 'step done', 'Validaçãoconcluída'],
    ['INGERINDO', 'step current', 'Envio à aprovaçãoem andamento'],
  ]);
  assert.equal(s.browser.find(raiz(s), (el) => el.getAttribute('data-step') === 'INGERINDO').getAttribute('aria-current'), 'step');
  assert.match(tela(s), /Enviando para a aprovação/);
  const valor = (rotulo) => s.browser.find(s.browser.find(raiz(s), (el) => /\bindicator-number\b/.test(el.className) && el.textContent.startsWith(rotulo)), (el) => el.className === 'indicator-value').textContent;
  assert.deepEqual(['Encontrados', 'Validados', 'Entregues à fila', 'Retidos fora da fila', 'Não validados'].map(valor), ['7', '3', '1', '2', '4']);
  assert.equal(porId(s, 'pros-job-meta').textContent, 'Tempo decorrido: 01:23 · Custo informado pelo motor: US$ 0.12 · Reposições realizadas: 1');
  assert.equal(s.browser.by.tag(raiz(s), 'progress').length, 0);
  assert.doesNotMatch(tela(s), /\d\s?%/, 'nenhum percentual');
  assert.equal(porId(s, 'pros-cancel-job'), null, 'durante o envio à aprovação não se cancela');

  const falhou = await abrir({ api: apiFalsa({ jobs: [job({ status: 'ERRO', currentStep: 'FINALIZADO', error: { code: 'JOB_INTERRUPTED' } })] }) });
  await selecionar(falhou);
  assert.equal(falhou.browser.by.cls(raiz(falhou), 'step').length, 0, 'job que falhou não afirma etapas');
  assert.match(tela(falhou), /o servidor foi reiniciado/);
});

test('[PROS-UX-13] o ACOMPANHAMENTO só roda para job em andamento, com a tela à vista, em intervalo moderado; atualiza os indicadores sem recarregar; ao concluir avisa (sucesso real), atualiza o briefing e a lista e PARA', async () => {
  const s = await abrir({ api: apiFalsa({ respostas: [job({ currentStep: 'VALIDANDO', candidatesDiscovered: 4 }), jobFinal()] }) });
  await selecionar(s);
  assert.equal(s.ag.pendentes().length, 0, 'sem job: nenhum acompanhamento');
  await clicar(s, porId(s, 'pros-start-job'));
  await clicar(s, botaoConfirmar(s));
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
  assert.ok(conta(s, 'briefs') > briefsAntes, 'a lista de briefings foi atualizada ao terminar');
  assert.deepEqual(s.eventos.at(-1), ['finish', 'JOB-20261006-001']);
  assert.equal(conta(s, 'status'), 2);
});

test('[PROS-UX-14] o acompanhamento PARA ao falhar, ao cancelar e ao SAIR da tela (e volta ao voltar se ainda roda); nunca consulta job terminado', async () => {
  for (const [final, aviso] of [[job({ status: 'ERRO', currentStep: 'FINALIZADO', error: { code: 'JOB_INTERNAL' } }), /A prospecção falhou/], [job({ status: 'CANCELADO', currentStep: 'FINALIZADO' }), /Prospecção cancelada/], [jobFinal({ status: 'PARCIAL' }), /Prospecção parcial/]]) {
    const s = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [final] }) });
    await s.browser.flush(6);
    assert.equal(s.ag.pendentes().length, 1);
    await s.ag.rodar();
    await s.browser.flush(8);
    assert.equal(s.ag.pendentes().length, 0, final.status);
    assert.ok(avisos(s).some((t) => aviso.test(t)), final.status);
  }
  const s = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [job()] }) });
  await s.browser.flush(6);
  assert.equal(s.ag.pendentes().length, 1);
  s.view.hide();
  assert.equal(s.ag.pendentes().length, 0, 'saiu da tela: parou');
  const antes = conta(s, 'status');
  await s.view.show({ name: 'prospecting' });
  await s.browser.flush(8);
  assert.equal(s.ag.pendentes().length, 1, 'voltou e o job ainda roda: o acompanhamento retoma');
  assert.equal(conta(s, 'status'), antes, 'sem consulta extra ao voltar (só a leitura da lista)');
});

test('[PROS-UX-15] falhas SEGUIDAS de rede: tenta de novo, desiste depois de 4 com uma mensagem clara, e "Atualizar" retoma; nada é inventado nesse meio tempo', async () => {
  const api = apiFalsa({ jobs: [job({ candidatesDiscovered: 3 })], respostas: [job({ candidatesDiscovered: 3 })] });
  const s = await abrir({ api });
  await s.browser.flush(6);
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
});

test('[PROS-UX-16] CANCELAR a prospecção (existente): chama só o id, mostra "Cancelando…", não duplica; o briefing em RASCUNHO/PRONTO pode ser cancelado SÓ depois de confirmar', async () => {
  const s = await abrir({ api: apiFalsa({ jobs: [job()], respostas: [job({ status: 'CANCELAMENTO_SOLICITADO' }), job({ status: 'CANCELADO', currentStep: 'FINALIZADO' })] }) });
  await s.browser.flush(6);
  const cancelar = porId(s, 'pros-cancel-job');
  s.browser.click(cancelar);
  s.browser.click(cancelar);
  await s.browser.flush(8);
  assert.deepEqual(s.api.chamadas.filter(([n]) => n === 'cancel'), [['cancel', 'JOB-20261006-001']]);
  assert.match(tela(s), /Cancelando…/);
  assert.equal(porId(s, 'pros-cancel-job').disabled, true);

  const b = await abrir({ api: apiFalsa() });
  await selecionar(b);
  await clicar(b, b.browser.by.button(raiz(b), 'Cancelar briefing'));
  assert.equal(conta(b, 'cancelBrief'), 0, 'pede confirmação antes');
  assert.match(modal(b).textContent, /Cancelar briefing.*não poderá ser usado para uma nova pesquisa/s);
  await clicar(b, b.browser.by.button(modal(b), 'Voltar'));
  assert.equal(conta(b, 'cancelBrief'), 0);
  await clicar(b, b.browser.by.button(raiz(b), 'Cancelar briefing'));
  await clicar(b, botaoConfirmar(b));
  assert.equal(conta(b, 'cancelBrief'), 1);
  assert.ok(avisos(b).includes('Briefing cancelado.'));
  assert.match(tela(b), /Cancelado/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A GAVETA da execução
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[PROS-UX-17] a gaveta da EXECUÇÃO reutiliza o detalhe do Histórico: quatro abas; candidatos em grupos que não se misturam (entregue, já existia, retido, não validado, descartado); nenhum candidato é chamado de "rejeitado"; só leitura', async () => {
  const s = await abrir({ api: apiFalsa({ jobs: [jobFinal()] }) });
  await selecionar(s);
  await clicar(s, porId(s, 'pros-job-details'));
  const d = gaveta(s);
  assert.ok(d);
  assert.equal(s.browser.find(d, (el) => el.localName === 'h2').textContent, 'JOB-20261006-001');
  assert.deepEqual(s.browser.findAll(d, (el) => el.getAttribute('role') === 'tab').map((el) => el.getAttribute('data-tab')), ['resumo', 'candidatos', 'resultados', 'auditoria']);
  assert.match(d.textContent, /Clínicas de estética \/ Harmonização|Clínicas de estética/);

  const resumo = painelDaAba(s, 'resumo').textContent;
  assert.match(resumo, /Entregues à fila1de 3 solicitados/);
  assert.match(resumo, /Descartados3não validados \+ retidos fora da fila/);
  assert.match(resumo, /Candidato não validado nunca foi decidido por ninguém/);
  assert.match(resumo, /Rejeitados por uma pessoa0decisão humana na fila/);

  await clicar(s, s.browser.find(d, (el) => el.getAttribute('data-tab') === 'candidatos'));
  const itens = s.browser.findAll(painelDaAba(s, 'candidatos'), (el) => /\bcandidate-item\b/.test(el.className));
  const grupo = (nome) => itens.find((el) => el.textContent.includes(nome)).getAttribute('data-group');
  assert.deepEqual(['Clínica Alfa', 'Clínica Beta', 'Clínica Gama', 'Clínica Delta', 'Excluída Ltda'].map(grupo), ['ENTREGUE', 'RETIDO', 'JA_EXISTIA', 'NAO_VALIDADO', 'DESCARTADO']);
  assert.doesNotMatch(painelDaAba(s, 'candidatos').textContent, /rejeitad/i, 'candidato descartado/não validado nunca é "rejeitado por uma pessoa"');
  assert.match(painelDaAba(s, 'candidatos').textContent, /As páginas tentadas não abriram.*causa: falha na conexão segura.*faltou comprovar: empresa, nicho, localização/s);
  assert.match(painelDaAba(s, 'candidatos').textContent, /Está nas exclusões permanentes/);
  await clicar(s, s.browser.find(d, (el) => el.getAttribute('data-tab') === 'resultados'));
  assert.deepEqual(s.browser.findAll(painelDaAba(s, 'resultados'), (el) => el.localName === 'h3').map((el) => el.textContent), ['Entregues à Approval Queue (1)', 'Validados, mas retidos fora da fila (1)', 'Já estavam na fila (1)', 'Resumo padronizado']);
  await clicar(s, s.browser.find(d, (el) => el.getAttribute('data-tab') === 'auditoria'));
  assert.match(painelDaAba(s, 'auditoria').textContent, /Custo informado pelo motor.*US\$ 0\.31/);
  for (const proibida of ['start', 'redo', 'approve', 'reject', 'reaprovar', 'pesquisar']) assert.equal(conta(s, proibida), 0, proibida);
});

test('[PROS-UX-18] NAVEGAÇÃO da gaveta: abrir muda o endereço (#/prospeccao/execucao/<id>); ESC e X fecham; Voltar fecha SEM sair do módulo e Avançar reabre; o foco volta ao botão; a lista de briefings e o formulário ficam', async () => {
  const s = await abrir({ api: apiFalsa({ jobs: [jobFinal()] }), comNavegacao: true, hash: '#/prospeccao' });
  await selecionar(s);
  const win = s.browser.window;
  digitar(s, 'pros-nicho', 'Rascunho em andamento');
  const botao = porId(s, 'pros-job-details');
  botao.focus();
  await clicar(s, botao);
  assert.equal(win.location.hash, '#/prospeccao/execucao/JOB-20261006-001');
  assert.equal(win.history.length, 2);
  assert.ok(gaveta(s));

  s.browser.press('Escape');
  await s.browser.flush(6);
  assert.equal(gaveta(s), null, 'ESC fecha');
  assert.equal(win.location.hash, '#/prospeccao');
  assert.equal(s.browser.document.activeElement === porId(s, 'pros-job-details'), true, 'o foco voltou ao botão que abriu');

  await clicar(s, porId(s, 'pros-job-details'));
  win.history.back();
  await s.browser.flush(8);
  assert.equal(win.location.hash, '#/prospeccao', 'o Voltar fica no módulo');
  assert.equal(gaveta(s), null, 'e fecha a gaveta');
  win.history.forward();
  await s.browser.flush(8);
  assert.ok(gaveta(s), 'o Avançar reabre');
  s.browser.click(s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  await s.browser.flush(8);
  assert.equal(gaveta(s), null, 'o X fecha');
  assert.equal(win.location.hash, '#/prospeccao');
  assert.equal(porId(s, 'pros-nicho').value, 'Rascunho em andamento', 'o rascunho do formulário ficou');
  assert.equal(conta(s, 'status'), 0, 'job terminado: nada consultado');
});

test('[PROS-UX-19] LINK DIRETO para a execução: seleciona o briefing dela e abre a gaveta (mesmo de outro briefing); fechar troca a entrada; código inexistente avisa e volta; sem nada ser iniciado', async () => {
  const outro = jobFinal({ id: 'JOB-20261007-002', briefId: BRIEF2.id });
  const api = apiFalsa({ briefs: [BRIEF, BRIEF2], jobs: [outro, jobFinal()] });
  const direto = await abrir({ api, comNavegacao: true, hash: `#/prospeccao/execucao/${encodeURIComponent('JOB-20261007-002')}` });
  assert.ok(gaveta(direto), 'o link direto abriu a gaveta');
  assert.equal(direto.browser.find(gaveta(direto), (el) => el.localName === 'h2').textContent, 'JOB-20261007-002');
  assert.equal(direto.view.state.selectedId, BRIEF2.id, 'o briefing dele foi selecionado');
  direto.browser.press('Escape');
  await direto.browser.flush(8);
  assert.equal(direto.browser.window.location.hash, '#/prospeccao');
  assert.equal(direto.browser.window.history.length, 1, 'sem entrada anterior no app: a entrada é trocada');
  for (const proibida of ['start', 'redo', 'create']) assert.equal(conta(direto, proibida), 0);

  const inexistente = await abrir({ api: apiFalsa({ briefs: [BRIEF], jobs: [jobFinal()] }), comNavegacao: true, hash: `#/prospeccao/execucao/${encodeURIComponent('JOB-99999999-999')}` });
  assert.equal(gaveta(inexistente), null);
  assert.ok(avisos(inexistente).some((t) => /não foi encontrada\. Procure-a no Histórico/.test(t)));
  assert.equal(inexistente.browser.window.location.hash, '#/prospeccao');
  assert.ok(inexistente.browser.by.button(raiz(inexistente), BRIEF.id), 'a lista segue disponível');
});

test('[PROS-UX-20] GAVETA ABERTA durante o acompanhamento: os números mudam sozinhos (aba e foco ficam); só reconstrói se algo mudou; ao terminar, o rodapé passa a oferecer "Refazer" e o Resumo mostra os leads entregues', async () => {
  const s = await abrir({ api: apiFalsa({ jobs: [job({ candidatesDiscovered: 2 })], respostas: [job({ candidatesDiscovered: 2 }), job({ candidatesDiscovered: 4, candidatesValidated: 1 }), jobFinal()] }) });
  await s.browser.flush(6);
  await clicar(s, porId(s, 'pros-job-details'));
  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-tab') === 'auditoria'));
  const aba = () => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true').getAttribute('data-tab');
  assert.equal(s.browser.by.id(gaveta(s), 'pros-drawer-redo'), null, 'em andamento: sem refazer');
  assert.match(gaveta(s).textContent, /Os números se atualizam sozinhos enquanto a prospecção roda/);
  const antes = gaveta(s).textContent;
  await s.ag.rodar();
  await s.browser.flush(6);
  assert.equal(gaveta(s).textContent, antes, 'nada mudou: a gaveta não foi reconstruída');
  await s.ag.rodar();
  await s.browser.flush(6);
  assert.equal(aba(), 'auditoria', 'a aba escolhida ficou');
  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-tab') === 'resumo'));
  assert.match(painelDaAba(s, 'resumo').textContent, /Encontrados4/);
  await s.ag.rodar();
  await s.browser.flush(10);
  assert.ok(gaveta(s), 'a gaveta continua aberta');
  assert.match(painelDaAba(s, 'resumo').textContent, /Entregues à fila1de 3 solicitados/);
  assert.ok(s.browser.by.id(gaveta(s), 'pros-drawer-redo'), 'terminou: o rodapé oferece refazer');
  assert.equal(s.ag.pendentes().length, 0);
});

test('[PROS-UX-21] REFAZER (cartão ou gaveta) só depois da confirmação, que explica o que será iniciado; clique triplo cria UMA; erro mantém a confirmação aberta; a tela passa a acompanhar o job novo', async () => {
  let falhar = true;
  const refazer = (id, mem) => {
    if (falhar) throw Object.assign(new Error('x'), { status: 409, serverMessage: 'Já existe uma prospecção em execução. Aguarde ela terminar ou cancele.' });
    const criado = job({ id: 'JOB-20261006-009' });
    mem.jobs = [criado, ...mem.jobs];
    return { item: criado };
  };
  const s = await abrir({ api: apiFalsa({ jobs: [jobFinal()], refazer, respostas: [job({ id: 'JOB-20261006-009' })] }) });
  await selecionar(s);
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
  assert.equal(conta(s, 'redo'), 2, 'uma tentativa que falhou + UMA que deu certo (cliques triplos não duplicam)');
  assert.equal(modal(s), null);
  assert.match(tela(s), /Em execução/);
  assert.ok(porId(s, 'pros-cancel-job'));
  assert.equal(s.ag.pendentes().length, 1, 'acompanha o job novo');
  assert.deepEqual(s.eventos.at(-1), ['redo', 'JOB-20261006-009']);

  // pela gaveta
  const g = await abrir({ api: apiFalsa({ jobs: [jobFinal()] }) });
  await selecionar(g);
  await clicar(g, porId(g, 'pros-job-details'));
  await clicar(g, g.browser.by.id(gaveta(g), 'pros-drawer-redo'));
  assert.equal(conta(g, 'redo'), 0);
  await clicar(g, botaoConfirmar(g));
  assert.equal(conta(g, 'redo'), 1);
  assert.equal(gaveta(g), null, 'a gaveta fechou: a tela acompanha o job novo');
});

test('[PROS-UX-22] a seleção de briefings: lista com busca de leitura (linha inteira clicável), paginação; selecionar não perde o rascunho; briefing concluído/pesquisando não oferece iniciar; sem permissão a tela é só o aviso', async () => {
  const muitos = Array.from({ length: 12 }, (_, i) => ({ ...BRIEF, id: `PROS-2026100${i % 10}-0${String(i).padStart(2, '0')}`, status: i === 0 ? 'PRONTO_PARA_PESQUISA' : 'AGUARDANDO_REVISAO' }));
  const s = await abrir({ api: apiFalsa({ briefs: muitos }) });
  assert.match(tela(s), /Página 1 de 2 · 1–8 de 12/);
  digitar(s, 'pros-nicho', 'Rascunho');
  const linha = s.browser.find(raiz(s), (el) => el.getAttribute('data-brief') === muitos[0].id);
  s.browser.click(s.browser.find(linha, (el) => el.getAttribute('data-label') === 'Local')); // fora do botão
  await s.browser.flush(8);
  assert.ok(porId(s, 'pros-start-job'), 'a linha inteira seleciona o briefing');
  assert.equal(porId(s, 'pros-nicho').value, 'Rascunho', 'selecionar não perde o rascunho');
  await clicar(s, s.browser.by.button(raiz(s), 'Próxima'));
  assert.match(tela(s), /Página 2 de 2/);
  const concluido = s.browser.by.button(raiz(s), muitos[10].id);
  await clicar(s, concluido);
  assert.equal(porId(s, 'pros-start-job'), null, 'AGUARDANDO_REVISAO não inicia outra pesquisa');

  const sem = await abrir({ api: apiFalsa(), canPropose: false });
  assert.match(tela(sem), /Seu perfil não pode usar o Workbench de Prospecção\./);
  assert.equal(porId(sem, 'pros-form'), null);
  assert.equal(conta(sem, 'briefs'), 0, 'sem permissão nada é pedido');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// NO PAINEL INTEIRO e ESTILO
// ---------------------------------------------------------------------------------------------------------------------------------------------

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
    'GET /api/prospecting/briefs': () => ({ items: [BRIEF] }),
    [`GET /api/prospecting/briefs/${BRIEF.id}`]: () => ({ item: BRIEF }),
    'GET /api/prospecting/jobs': () => ({ items: mem.jobs }),
    'GET /api/prospecting/jobs/JOB-20261006-001/status': () => ({ item: mem.jobs[0] }),
  });
  const navigation = browserNavigation(browser.window);
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk: createFakeSdk({ session: FAKE_SESSION }), navigation });
  await browser.flush(12);
  return { browser, fetchImpl, mem };
}
const linkMenu = (t, nome) => t.browser.by.link(t.browser.root, nome);

test('[PROS-UX-23] NO PAINEL: o módulo é persistente (o rascunho sobrevive a trocar de módulo), nada é iniciado ao abrir, o link direto da execução funciona e sem permissão não há acesso nem chamadas', async () => {
  const t = await painel({ jobs: [jobFinal()] });
  assert.equal(linkMenu(t, 'Nova Prospecção').getAttribute('aria-current'), 'page');
  t.browser.type(t.browser.by.id(t.browser.root, 'pros-nicho'), 'Meu rascunho');
  t.browser.type(t.browser.by.id(t.browser.root, 'pros-quantidade'), '12');
  t.browser.click(linkMenu(t, 'CRM'));
  await t.browser.flush(8);
  t.browser.click(linkMenu(t, 'Nova Prospecção'));
  await t.browser.flush(10);
  assert.equal(t.browser.by.id(t.browser.root, 'pros-nicho').value, 'Meu rascunho', 'o rascunho sobreviveu a trocar de módulo');
  assert.equal(t.browser.by.id(t.browser.root, 'pros-quantidade').value, '12');
  assert.equal(t.fetchImpl.calls.filter((c) => c.method !== 'GET').length, 0, 'nenhuma escrita: nada foi criado nem iniciado');

  const direto = await painel({ hash: '#/prospeccao/execucao/JOB-20261006-001', jobs: [jobFinal()] });
  assert.ok(direto.browser.find(direto.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className)), 'o link direto abriu a gaveta');
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

test('[PROS-UX-24] NO PAINEL: um job em andamento é retomado e acompanhado pela tela à vista; sair do módulo para a consulta', async () => {
  const t = await painel({ jobs: [job({ currentStep: 'VALIDANDO', candidatesDiscovered: 3 })] });
  assert.match(t.browser.root.textContent, /Em execução/);
  assert.match(t.browser.root.textContent, /Validando as páginas das empresas/);
  t.browser.click(linkMenu(t, 'CRM'));
  await t.browser.flush(8);
  const consultas = t.fetchImpl.calls.filter((c) => c.path.endsWith('/status')).length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(t.fetchImpl.calls.filter((c) => c.path.endsWith('/status')).length, consultas, 'fora da tela: nenhuma consulta nova');
});

test('[PROS-UX-25] o CSS: formulário em seções responsivo (duas colunas e uma no celular), etapas, cartões de início/execução, erro de campo e campo escondido; sem sombras pesadas', async () => {
  assert.ok(css.includes('.pros-layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);'));
  assert.ok(css.includes('@media (max-width: 1000px) { .pros-layout { grid-template-columns: minmax(0, 1fr); } }'));
  assert.ok(css.includes('@media (max-width: 560px) { .stepper { grid-template-columns: minmax(0, 1fr); }'));
  assert.ok(css.includes('.step.done { border-top-color: var(--brand-strong); }'));
  assert.ok(css.includes('.form-field [aria-invalid="true"]'));
  assert.ok(css.includes('.form-field label.required::after { content: " *"'));
  assert.ok(css.includes('.pros-start-card { border-left: 4px solid var(--brand-strong); }'));
  assert.doesNotMatch(css, /box-shadow:[^;]*(?:0 (?:3\d|[4-9]\d)px)[^;]*rgba\(0, 0, 0/, 'nenhuma sombra pesada');
});
