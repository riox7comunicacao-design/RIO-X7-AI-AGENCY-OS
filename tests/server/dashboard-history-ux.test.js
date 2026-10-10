// Histórico de prospecções na UX 4.0.3 (mesmo padrão da Approval Queue e de Leads Reprovados): lista com busca/filtro/ordem/paginação e linha inteira clicável,
// gaveta da prospecção (Resumo, Candidatos, Resultados e Auditoria) com URL, candidatos descartados SEPARADOS dos leads entregues à Approval Queue, REFAZER só
// depois de uma confirmação humana e atualização em segundo plano apenas enquanto há uma prospecção em andamento. DOM de teste e API falsa — nenhum navegador, nenhuma
// rede, nenhum Claude, nenhuma prospecção real, nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');

const loadView = () => import('../../dashboard/views/prospectingHistory.mjs');
const loadRouter = () => import('../../dashboard/router.mjs');
const loadUi = () => import('../../dashboard/ui/index.mjs');
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
const POLL = 7777;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------------------------------------
const cand = (nome, extras = {}) => ({ nome, url: `https://${nome.toLowerCase().replace(/[^a-z]/g, '')}.example.com.br/`, resultado: 'VALIDADO', ciclo: 1, empresa: nome, nicho: 'Estética', localizacao: 'Petrópolis/RJ', tipoLead: 'EMPRESA', siteOficial: { status: 'ENCONTRADO', url: `https://${nome.toLowerCase().replace(/[^a-z]/g, '')}.example.com.br/` }, presencaDigital: {}, outrasPresencas: [], fontesDescoberta: [{ url: 'https://diretorio.example.com.br/lista', tipo: 'DIRETORIO' }], ...extras });

const CANDIDATOS = [
  cand('Clínica Alfa', { entrega: { naFila: true, estadoOperacional: 'AGUARDANDO_REVISAO' } }),
  cand('Clínica Beta', { entrega: { naFila: false, estadoOperacional: 'DADOS_INSUFICIENTES', motivo: 'DADOS_INSUFICIENTES' } }),
  cand('Clínica Gama', { entrega: { naFila: false, jaExistiaNaFila: true, estadoOperacional: 'VALIDADO_PARA_REVISAO' } }),
  cand('Clínica Delta', { resultado: 'NAO_VERIFICADO', motivo: 'PAGINA_INACESSIVEL', causa: 'TLS', faltando: ['empresa', 'nicho', 'localizacao'], siteOficial: { status: 'NAO_ENCONTRADO', url: null }, fontesDescoberta: [{ url: 'https://diretorio.example.com.br/delta', tipo: 'DIRETORIO' }, { url: 'javascript:alert(1)', tipo: 'DIRETORIO' }] }),
  cand('Clínica Épsilon', { resultado: 'NAO_VERIFICADO', motivo: 'EVIDENCIA_INCOMPLETA', faltando: ['localizacao'] }),
  cand('Excluída Ltda', { resultado: 'DESCARTADO', motivo: 'EXCLUSAO_PERMANENTE', siteOficial: { status: 'NAO_ENCONTRADO', url: null } }),
];

const RESUMO = { solicitados: 3, limiteDeCandidatos: 50, candidatosProcessados: 6, descobertos: 6, novos: 6, repetidos: 0, validados: 3, naoValidados: 3, naApprovalQueue: 1, jaExistentes: 1, dadosInsuficientes: 1, duplicados: 0, dnc: 0, reposicoes: 0, enriquecidos: 0, tempoMs: 98000, descobertaSegundos: 41.5, validacaoSegundos: 8.2, ingestaoSegundos: 1.1, totalSegundos: 98, custoUsd: 0.31, aprovados: 0, rejeitados: 1, promovidos: 0 };

const job = (n, extras = {}) => ({
  id: `JOB-2026100${n}-001`,
  briefId: `PROS-${n}`,
  status: 'CONCLUIDO',
  createdAt: `2026-10-0${n}T12:00:00.000Z`,
  startedAt: `2026-10-0${n}T12:00:05.000Z`,
  finishedAt: `2026-10-0${n}T12:01:40.000Z`,
  criadoPor: { userId: 'u1', name: 'Rafael Closer', role: 'COMMERCIAL_CLOSER' },
  requestedQuantity: 3,
  candidatesDiscovered: 6,
  candidatesValidated: 3,
  candidatesRejected: 3,
  candidatesUnverified: 2,
  candidatesDiscarded: 1,
  leadsNaFila: 1,
  progress: 100,
  currentStep: 'FINALIZADO',
  limits: { maxCandidates: 50, maxDurationMs: 600000, maxCycles: 6 },
  candidatos: CANDIDATOS,
  lote: { loteId: 'lote:5a280fbe', naFila: 1, foraDaFila: 1, jaEstavamNaFila: 1, prospectIds: ['id:alfa'] },
  telemetria: { discoveryMs: 41500, custoUsd: 0.31, webSearchRequests: 4, discoveryRuns: 1, ciclosExecutados: 1, reposicoesNecessarias: 0, reposicoesRealizadas: 0, candidatosDescobertos: 6, candidatosNovos: 6, candidatosRepetidos: 0, repetidosPor: { fila: 0, duplicado: 0, dnc: 0, job: 0 }, descobertaSegundos: 41.5, validacaoSegundos: 8.2, ingestaoSegundos: 1.1, totalSegundos: 98, eventos: [{ codigo: 'CICLO_SEM_NOVOS', ciclo: 1 }] },
  elapsedMs: 95000,
  resumo: RESUMO,
  ...extras,
});

const BRIEFS = [
  { id: 'PROS-1', nicho: 'Estética', nivelGeografico: 'CIDADE', cidades: ['Petrópolis/RJ'], quantidade: 3, observacoes: 'Só clínicas com site' },
  { id: 'PROS-2', nicho: 'Psicologia', nivelGeografico: 'CIDADE', cidades: ['Niterói/RJ'], quantidade: 3 },
  { id: 'PROS-3', nicho: 'Odontologia', nivelGeografico: 'ESTADO', estados: ['SP'], quantidade: 3 },
];

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

// API falsa com a lista MUTÁVEL e o registro de tudo o que foi pedido: a tela do Histórico só pode LER (e refazer, depois de confirmar).
function apiFalsa({ jobs = [job(1), job(2), job(3)], briefs = BRIEFS, refazer, semBriefs = false } = {}) {
  const chamadas = [];
  const mem = { jobs: [...jobs], briefs };
  const api = {
    chamadas,
    mem,
    listProspectingJobs: async () => {
      chamadas.push(['jobs']);
      if (mem.falharLista) throw Object.assign(new Error('x'), { status: 500 });
      return { items: mem.jobs.map((item) => JSON.parse(JSON.stringify(item))) };
    },
    redoProspectingJob: async (id) => {
      chamadas.push(['refazer', id]);
      if (refazer) return refazer(id, mem);
      return { item: { id: 'JOB-NOVO' } };
    },
    // qualquer outra operação seria um defeito: o Histórico não cria lead, não aprova, não rejeita e não pesquisa
    approve: async () => { chamadas.push(['approve']); throw new Error('o Histórico não aprova'); },
    reject: async () => { chamadas.push(['reject']); throw new Error('o Histórico não rejeita'); },
    reapproveLead: async () => { chamadas.push(['reaprovar']); throw new Error('o Histórico não reconsidera'); },
    completeLeadResearch: async () => { chamadas.push(['pesquisar']); throw new Error('o Histórico não pesquisa'); },
    startProspectingJob: async () => { chamadas.push(['iniciar']); throw new Error('o Histórico não inicia prospecção ao abrir'); },
  };
  if (!semBriefs) {
    api.listProspectingBriefs = async () => {
      chamadas.push(['briefs']);
      if (mem.falharBriefs) throw Object.assign(new Error('x'), { status: 500 });
      return { items: mem.briefs };
    };
  }
  return api;
}

async function abrir({ api, canProposeLead = true, comNavegacao = false, hash = '', pageSize } = {}) {
  const { createProspectingHistoryView } = await loadView();
  const { createDataBus } = await loadUi();
  const { browserNavigation, parseRoute } = await loadRouter();
  const browser = createBrowser({ hash });
  const ag = agenda();
  const bus = createDataBus();
  const eventos = [];
  bus.subscribe('prospecting:changed', (p) => eventos.push([p.action, p.jobId]));
  const destinos = [];
  const navigation = comNavegacao ? browserNavigation(browser.window) : null;
  const view = createProspectingHistoryView({ document: browser.document, root: browser.root, api, navigate: (alvo) => destinos.push(alvo), canProposeLead, schedule: ag.schedule, bus, pollMs: POLL, ...(pageSize ? { pageSize } : {}), ...(navigation ? { navigation } : {}) });
  if (navigation) navigation.subscribe(() => view.show(parseRoute(navigation.current())));
  const s = { browser, view, api, ag, bus, eventos, destinos, navigation };
  if (comNavegacao) await view.show(parseRoute(navigation.current()));
  else await view.load();
  await browser.flush();
  return s;
}

const gaveta = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const confirmacao = (s) => s.browser.find(s.browser.root, (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className));
const botao = (s, nome) => s.browser.by.button(s.browser.root, nome);
const linha = (s, id) => botao(s, id).parentNode.parentNode.parentNode; // botão → company-cell → td → tr
const celula = (s, id, rotulo) => s.browser.find(linha(s, id), (el) => el.localName === 'td' && el.getAttribute('data-label') === rotulo);
const avisos = (s) => s.browser.findAll(s.browser.root, (el) => el.className === 'toast-message').map((el) => el.textContent);
const conta = (s, nome) => s.api.chamadas.filter(([n]) => n === nome).length;
const painelDaAba = (s, chave) => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tabpanel' && new RegExp(chave).test(el.getAttribute('aria-labelledby') || ''));
const clicar = async (s, el) => { s.browser.click(el); await s.browser.flush(6); };
const abrirJob = async (s, id) => { await clicar(s, botao(s, id)); return gaveta(s); };
const aba = async (s, chave) => { await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-tab') === chave)); return painelDaAba(s, chave); };
const ocorrencias = (texto, trecho) => texto.split(trecho).length - 1;
const J1 = 'JOB-20261001-001';
const J2 = 'JOB-20261002-001';
const J3 = 'JOB-20261003-001';

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A LISTA
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[HIST-UX-1] a lista: código, nicho e localidade (do briefing), situação, data e os indicadores REAIS (encontrados, validados, na fila, descartados); abrir a tela só LÊ', async () => {
  const s = await abrir({ api: apiFalsa() });
  assert.deepEqual(s.browser.by.tag(s.browser.root, 'th').map((el) => el.textContent), ['Prospecção', 'Situação', 'Data', 'Encontrados', 'Validados', 'Na fila', 'Descartados']);
  assert.match(s.browser.root.textContent, /3 prospecções/);
  const tr = linha(s, J1);
  assert.match(tr.className, /\bqueue-row\b/);
  assert.match(tr.textContent, /Estética · Petrópolis\/RJ/);
  assert.match(tr.textContent, /Concluída/);
  assert.equal(celula(s, J1, 'Encontrados').textContent, '6');
  assert.equal(celula(s, J1, 'Validados').textContent, '3');
  assert.equal(celula(s, J1, 'Na fila').textContent, '1');
  assert.equal(celula(s, J1, 'Descartados').textContent, '4', 'não validados (3) + retidos fora da fila (1)');
  assert.match(celula(s, J1, 'Data').textContent, /0?1\/10\/2026/);
  assert.match(linha(s, J3).textContent, /Odontologia · SP/, 'brief por estado');
  assert.deepEqual(s.api.chamadas.map(([n]) => n), ['jobs', 'briefs'], 'só duas LEITURAS; nenhuma pesquisa, aprovação ou prospecção');
});

test('[HIST-UX-2] linha INTEIRA clicável (mouse, Enter e Espaço), sem aparência de link; cliques rápidos abrem uma gaveta só e um carregamento', async () => {
  const s = await abrir({ api: apiFalsa() });
  assert.doesNotMatch(botao(s, J1).className, /link-button/);
  s.browser.click(celula(s, J2, 'Situação'));
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'a linha inteira abre');
  assert.equal(s.browser.find(gaveta(s), (el) => el.localName === 'h2').textContent, J2);
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(gaveta(s), null);
  const b = botao(s, J1);
  b.focus();
  s.browser.press('Enter');
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'Enter abre');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(s.browser.document.activeElement === botao(s, J1), true, 'o foco volta ao botão da linha');
  s.browser.press(' ');
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'Espaço abre');
  s.browser.press('Escape');
  await s.browser.flush(4);

  const b3 = botao(s, J3);
  s.browser.click(b3);
  s.browser.click(celula(s, J3, 'Data'));
  s.browser.click(b3);
  await s.browser.flush(8);
  assert.equal(s.browser.findAll(s.browser.root, (el) => el.getAttribute('role') === 'dialog').length, 1);
  assert.equal(conta(s, 'jobs'), 1, 'nenhum recarregamento');
});

test('[HIST-UX-3] BUSCA (código, nicho, cidade, quem iniciou), FILTRO de situação e ORDEM; busca, filtro, ordem e página sobrevivem a abrir/fechar a gaveta e a atualizar', async () => {
  const jobs = Array.from({ length: 22 }, (_, i) => job(1, { id: `JOB-202610${String(10 + i)}-001`, briefId: i % 2 ? 'PROS-2' : 'PROS-1', status: i % 5 === 0 ? 'PARCIAL' : 'CONCLUIDO', startedAt: `2026-10-${String(10 + (i % 18)).padStart(2, '0')}T10:00:00.000Z`, criadoPor: { userId: 'u', name: i === 3 ? 'Maria Gerente' : 'Rafael Closer', role: 'ADMIN' }, resumo: { ...RESUMO, naApprovalQueue: i } }));
  const s = await abrir({ api: apiFalsa({ jobs }) });
  assert.match(s.browser.root.textContent, /Página 1 de 2 · 1–15 de 22/);
  const campo = s.browser.by.label(s.browser.root, 'Buscar prospecção');
  const situacao = s.browser.by.label(s.browser.root, 'Situação');
  const ordem = s.browser.by.label(s.browser.root, 'Ordenar por');

  s.browser.type(campo, 'niteroi'); // cidade do brief, sem acento
  assert.match(s.browser.root.textContent, /22 prospecções · 11 no filtro/);
  s.browser.type(campo, 'PSICOLOGIA');
  assert.match(s.browser.root.textContent, /22 prospecções · 11 no filtro/);
  s.browser.type(campo, 'maria gerente'); // quem iniciou
  assert.match(s.browser.root.textContent, /22 prospecções · 1 no filtro/);
  s.browser.type(campo, 'JOB-20261012'); // código
  assert.match(s.browser.root.textContent, /22 prospecções · 1 no filtro/);
  s.browser.type(campo, 'nada disso existe');
  assert.match(s.browser.root.textContent, /Nenhuma prospecção encontrada/);
  s.browser.type(campo, '');

  s.browser.choose(situacao, 'PARCIAL');
  assert.match(s.browser.root.textContent, /22 prospecções · 5 no filtro/);
  s.browser.choose(situacao, 'TODAS');
  s.browser.choose(ordem, 'leads');
  const primeira = s.browser.by.tag(s.browser.root, 'tbody')[0].textContent;
  assert.ok(primeira.includes('JOB-20261031-001'), 'mais leads na fila primeiro');
  s.browser.choose(ordem, 'antigas');
  await clicar(s, botao(s, 'Próxima'));
  assert.match(s.browser.root.textContent, /Página 2 de 2/);
  const primeiroDaPagina2 = s.browser.by.tag(s.browser.root, 'button').find((el) => el.getAttribute('data-item'));
  await clicar(s, primeiroDaPagina2);
  assert.ok(gaveta(s));
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.match(s.browser.root.textContent, /Página 2 de 2/, 'a página sobreviveu à gaveta');
  assert.equal(ordem.value, 'antigas');
  await clicar(s, botao(s, 'Atualizar'));
  assert.match(s.browser.root.textContent, /Página 2 de 2/, 'e à atualização');
  assert.equal(conta(s, 'jobs'), 2);
  s.browser.type(campo, 'rafael');
  s.browser.choose(situacao, 'CONCLUIDO');
  await clicar(s, botao(s, 'Atualizar'));
  assert.equal(campo.value, 'rafael');
  assert.equal(situacao.value, 'CONCLUIDO');
  assert.equal(s.browser.by.label(s.browser.root, 'Buscar prospecção') === campo, true, 'o campo é o mesmo elemento');
});

test('[HIST-UX-4] ESTADOS VAZIOS e erros: sem prospecções (com o caminho para a Nova Prospecção), "nada encontrado", falha ao carregar (mensagem) e falha ao ATUALIZAR (a lista fica; aviso)', async () => {
  const vazio = await abrir({ api: apiFalsa({ jobs: [] }) });
  assert.ok(vazio.browser.by.id(vazio.browser.root, 'history-empty'));
  assert.match(vazio.browser.root.textContent, /Nenhuma prospecção executada ainda\./);
  assert.equal(vazio.browser.by.link(vazio.browser.root, 'Ir para Nova Prospecção').href, '#/prospeccao');

  const api = apiFalsa();
  api.mem.falharLista = true;
  const falha = await abrir({ api });
  assert.match(falha.browser.by.cls(falha.browser.root, 'message')[0].textContent, /Não foi possível concluir agora/);
  api.mem.falharLista = false;
  await clicar(falha, botao(falha, 'Atualizar'));
  assert.ok(botao(falha, J1));
  assert.equal(falha.browser.by.cls(falha.browser.root, 'message').length, 0);

  api.mem.falharLista = true;
  await clicar(falha, botao(falha, 'Atualizar'));
  assert.ok(botao(falha, J1), 'as linhas anteriores continuam');
  assert.ok(avisos(falha).some((t) => /Não foi possível concluir agora/.test(t)));

  // sem os briefs a lista continua útil: nicho e localidade viram "—" (nunca inventados)
  const semBrief = apiFalsa();
  semBrief.mem.falharBriefs = true;
  const t = await abrir({ api: semBrief });
  assert.ok(botao(t, J1));
  assert.match(linha(t, J1).textContent, /—/);
  assert.doesNotMatch(linha(t, J1).textContent, /Estética/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A GAVETA
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[HIST-UX-5] a gaveta abre na própria tela com as QUATRO abas; o RESUMO mostra situação, funil real, decisões humanas SEPARADAS dos não validados, briefing e datas — sem recarregar nem iniciar nada', async () => {
  const s = await abrir({ api: apiFalsa() });
  const d = await abrirJob(s, J1);
  assert.ok(d);
  assert.equal(d.getAttribute('aria-modal'), 'true');
  assert.equal(s.browser.find(d, (el) => el.localName === 'h2').textContent, J1);
  assert.match(d.textContent, /Estética · Petrópolis\/RJ/);
  assert.deepEqual(s.browser.findAll(d, (el) => el.getAttribute('role') === 'tab').map((el) => el.getAttribute('data-tab')), ['resumo', 'candidatos', 'resultados', 'auditoria']);
  assert.equal(conta(s, 'jobs'), 1, 'abrir a gaveta não recarrega a lista');
  assert.deepEqual(s.api.chamadas.map(([n]) => n), ['jobs', 'briefs'], 'abrir o detalhe só lê o que já está na tela');

  const resumo = painelDaAba(s, 'resumo');
  assert.deepEqual(s.browser.findAll(resumo, (el) => el.localName === 'h3').map((el) => el.textContent), ['Situação', 'Funil da prospecção', 'Decisões humanas sobre os leads entregues', 'Briefing', 'Datas']);
  const indicadores = s.browser.findAll(resumo, (el) => /\bindicator-number\b/.test(el.className)).map((el) => el.textContent);
  assert.deepEqual(indicadores.slice(0, 4), ['Encontrados6candidatos trazidos pela descoberta', 'Validados3comprovados pela página', 'Entregues à fila1de 3 solicitados', 'Descartados4não validados + retidos fora da fila']);
  assert.deepEqual(indicadores.slice(4), ['Aprovados0por uma pessoa', 'Rejeitados por uma pessoa1decisão humana na fila', 'Promovidos ao CRM0por uma pessoa']);
  assert.match(resumo.textContent, /Candidato não validado nunca foi decidido por ninguém/);
  assert.match(resumo.textContent, /Fora das contas acima \(não são entregas novas nem descartes\): 1 já existia\(m\) na fila ou no CRM\./);
  assert.match(resumo.textContent, /NichoEstética/);
  assert.match(resumo.textContent, /Quantidade pedida3/);
  assert.match(resumo.textContent, /Observações do briefingSó clínicas com site/);
  assert.match(resumo.textContent, /Iniciada por.*Rafael Closer \(COMMERCIAL_CLOSER\)/);
  assert.match(resumo.textContent, /Duração01:35/);
  assert.equal(s.browser.by.link(resumo, 'Abrir a Approval Queue').href, '#/aprovacoes');
  assert.equal(s.browser.by.link(resumo, 'Ver em Leads Reprovados').href, '#/prospeccao/leads-reprovados');
  s.browser.click(s.browser.find(d, (el) => el.getAttribute('data-action') === 'close'));
  await s.browser.flush(4);
  assert.equal(gaveta(s), null, 'o X fecha');
});

test('[HIST-UX-6] CANDIDATOS: cada um em UM grupo (entregue, já existia, retido fora da fila, não validado, descartado); motivos reais e fontes seguras; "não validado" NUNCA é chamado de rejeitado; o filtro do grupo funciona e é lembrado', async () => {
  const s = await abrir({ api: apiFalsa() });
  await abrirJob(s, J1);
  const painel = await aba(s, 'candidatos');
  const itens = s.browser.findAll(painel, (el) => /\bcandidate-item\b/.test(el.className));
  assert.equal(itens.length, 6);
  const grupoDe = (nome) => s.browser.find(painel, (el) => /\bcandidate-item\b/.test(el.className) && el.textContent.includes(nome)).getAttribute('data-group');
  assert.equal(grupoDe('Clínica Alfa'), 'ENTREGUE');
  assert.equal(grupoDe('Clínica Beta'), 'RETIDO');
  assert.equal(grupoDe('Clínica Gama'), 'JA_EXISTIA');
  assert.equal(grupoDe('Clínica Delta'), 'NAO_VALIDADO');
  assert.equal(grupoDe('Clínica Épsilon'), 'NAO_VALIDADO');
  assert.equal(grupoDe('Excluída Ltda'), 'DESCARTADO');

  const texto = painel.textContent;
  assert.match(texto, /Clínica Beta.*Dados insuficientes/s, 'o estado real em que o pipeline reteve o validado');
  assert.match(texto, /As páginas tentadas não abriram/);
  assert.match(texto, /causa: falha na conexão segura/);
  assert.match(texto, /faltou comprovar: empresa, nicho, localização/);
  assert.match(texto, /A página abriu, mas faltou comprovar dados da empresa/);
  assert.match(texto, /faltou comprovar: localização/);
  assert.match(texto, /Está nas exclusões permanentes/);
  assert.doesNotMatch(texto, /rejeitad/i, 'não validado e descartado nunca são "rejeitados": ninguém decidiu');
  assert.match(texto, /não aparecem em Leads Reprovados/);

  // fontes: só http(s); javascript: nunca vira link
  const delta = s.browser.find(painel, (el) => /\bcandidate-item\b/.test(el.className) && el.textContent.includes('Clínica Delta'));
  const links = s.browser.findAll(delta, (el) => el.localName === 'a').map((el) => el.href);
  assert.ok(links.includes('https://diretorio.example.com.br/delta'));
  assert.equal(links.some((href) => /^javascript:/i.test(href)), false);
  for (const a of s.browser.findAll(painel, (el) => el.localName === 'a')) assert.match(a.getAttribute('rel'), /noopener noreferrer/);

  // filtro por grupo, com contagens, lembrado ao reconstruir
  const filtro = s.browser.by.label(painel, 'Mostrar');
  assert.deepEqual(s.browser.findAll(filtro, (el) => el.localName === 'option').map((el) => el.textContent), ['Todos (6)', 'Entregues à Approval Queue (1)', 'Já estavam na fila (1)', 'Validados, retidos fora da fila (1)', 'Não validados (2)', 'Descartados por exclusão permanente (1)']);
  s.browser.choose(filtro, 'NAO_VALIDADO');
  await s.browser.flush(4);
  const filtrado = painelDaAba(s, 'candidatos');
  assert.equal(s.browser.findAll(filtrado, (el) => /\bcandidate-item\b/.test(el.className)).length, 2);
  assert.equal(s.browser.by.label(filtrado, 'Mostrar').value, 'NAO_VALIDADO');
  assert.equal(s.browser.document.activeElement.id, 'jobd-group', 'o foco fica no filtro');
});

test('[HIST-UX-7] RESULTADOS: o que foi ENTREGUE à Approval Queue, o que foi validado mas RETIDO (e por quê), o que já existia, e o resumo padronizado; nenhuma criação de lead', async () => {
  const s = await abrir({ api: apiFalsa() });
  await abrirJob(s, J1);
  const painel = await aba(s, 'resultados');
  const titulos = s.browser.findAll(painel, (el) => el.localName === 'h3').map((el) => el.textContent);
  assert.deepEqual(titulos, ['Entregues à Approval Queue (1)', 'Validados, mas retidos fora da fila (1)', 'Já estavam na fila (1)', 'Resumo padronizado']);
  const secao = (titulo) => s.browser.find(painel, (el) => el.localName === 'section' && el.textContent.startsWith(titulo));
  assert.match(secao('Entregues').textContent, /Clínica Alfa/);
  assert.doesNotMatch(secao('Entregues').textContent, /Clínica Beta|Clínica Delta/);
  assert.match(secao('Validados, mas retidos').textContent, /Clínica Beta — Dados insuficientes/);
  assert.match(secao('Validados, mas retidos').textContent, /Não viraram lead/);
  assert.match(secao('Já estavam').textContent, /Clínica Gama/);
  for (const rotulo of ['Solicitados', 'Candidatos processados', 'Na Approval Queue', 'Já existentes', 'Dados insuficientes', 'Tempo', 'Descoberta', 'Validação']) assert.ok(painel.textContent.includes(rotulo), rotulo);
  assert.match(painel.textContent, /US\$ 0\.31/);
  assert.deepEqual(s.api.chamadas.map(([n]) => n).filter((n) => !['jobs', 'briefs'].includes(n)), [], 'nenhum lead foi criado, aprovado, rejeitado ou pesquisado');

  // sem entrega nenhuma: estado vazio honesto
  const sem = await abrir({ api: apiFalsa({ jobs: [job(1, { candidatos: [cand('Só Delta', { resultado: 'NAO_VERIFICADO', motivo: 'SEM_FONTE_VERIFICAVEL' })], resumo: { ...RESUMO, naApprovalQueue: 0, validados: 0, jaExistentes: 0, dadosInsuficientes: 0, rejeitados: 0 } })] }) });
  await abrirJob(sem, J1);
  const vazio = await aba(sem, 'resultados');
  assert.match(vazio.textContent, /Nenhum lead foi entregue por esta prospecção/);
  assert.doesNotMatch(vazio.textContent, /retidos fora da fila/);
});

test('[HIST-UX-8] AUDITORIA: tempos, motor, contagens do pipeline, limites, eventos e identificação — só o que o job registrou; sem telemetria, estado vazio (nada inventado)', async () => {
  const s = await abrir({ api: apiFalsa() });
  await abrirJob(s, J1);
  const painel = await aba(s, 'auditoria');
  const titulos = s.browser.findAll(painel, (el) => el.localName === 'h3').map((el) => el.textContent);
  assert.deepEqual(titulos, ['Tempos', 'Motor de pesquisa', 'Contagens do pipeline', 'Limites da execução', 'Eventos registrados', 'Identificação']);
  const t = painel.textContent;
  assert.match(t, /Descoberta41\.5s/);
  assert.match(t, /Custo informado pelo motor.*US\$ 0\.31/);
  assert.match(t, /Buscas na web4/);
  assert.match(t, /Máximo de candidatos50/);
  assert.match(t, /Tempo máximo600s/);
  assert.match(t, /CICLO_SEM_NOVOS \(ciclo 1\)/);
  assert.match(t, /Código da prospecçãoJOB-20261001-001/);
  assert.match(t, /Loteslote:5a280fbe|Lotelote:5a280fbe/);

  const antigo = await abrir({ api: apiFalsa({ jobs: [job(1, { telemetria: undefined, limits: undefined, lote: undefined, resumo: undefined, candidatos: undefined, criadoPor: undefined, cancelRequested: undefined })] }) });
  await abrirJob(antigo, J1);
  const vazio = await aba(antigo, 'auditoria');
  assert.match(vazio.textContent, /Código da prospecção/);
  assert.doesNotMatch(vazio.textContent, /Tempos|Motor de pesquisa|US\$/);
  const resumo = painelDaAba(antigo, 'resumo');
  assert.match(resumo.textContent, /Encontrados6/, 'os totais do job (candidatesDiscovered) valem quando não há resumo');
  assert.doesNotMatch(resumo.textContent, /Rejeitados por uma pessoa\d/);
  assert.match(resumo.textContent, /Rejeitados por uma pessoa—/, 'sem o contador do servidor: "—", nunca um zero inventado');
  assert.match(painelDaAba(antigo, 'candidatos').textContent, /Nenhum candidato registrado/);
});

test('[HIST-UX-9] job que FALHOU, PARCIAL e CANCELADO explicam o que aconteceu com as palavras do sistema (sem código técnico) e sem inventar números', async () => {
  const jobs = [
    job(1, { id: 'JOB-ERRO', status: 'ERRO', error: { code: 'DISCOVERY_FAILED', message: 'x' }, candidatos: [], resumo: undefined, candidatesDiscovered: 0, candidatesValidated: 0, candidatesRejected: 0, leadsNaFila: 0 }),
    job(2, { id: 'JOB-PARCIAL', status: 'PARCIAL' }),
    job(3, { id: 'JOB-CANCELADO', status: 'CANCELADO' }),
  ];
  const s = await abrir({ api: apiFalsa({ jobs }) });
  await abrirJob(s, 'JOB-ERRO');
  assert.match(painelDaAba(s, 'resumo').textContent, /Não foi possível descobrir empresas\. A prospecção não chegou a validar candidatos\./);
  assert.doesNotMatch(painelDaAba(s, 'resumo').textContent, /DISCOVERY_FAILED/);
  assert.match(linha(s, 'JOB-ERRO').textContent, /Falhou/);
  s.browser.press('Escape');
  await s.browser.flush(4);
  await abrirJob(s, 'JOB-PARCIAL');
  assert.match(painelDaAba(s, 'resumo').textContent, /A quantidade pedida não foi atingida: nenhuma empresa fraca foi incluída para completar\./);
  s.browser.press('Escape');
  await s.browser.flush(4);
  await abrirJob(s, 'JOB-CANCELADO');
  assert.match(painelDaAba(s, 'resumo').textContent, /cancelada antes de terminar/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// NAVEGAÇÃO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[HIST-UX-10] URL: abrir muda o endereço; Voltar fecha a gaveta SEM sair do módulo e Avançar reabre; o X volta uma entrada (sem repetir); a lista (busca, página) e o foco ficam', async () => {
  const s = await abrir({ api: apiFalsa(), comNavegacao: true, hash: '#/prospeccao/historico' });
  const win = s.browser.window;
  s.browser.type(s.browser.by.label(s.browser.root, 'Buscar prospecção'), 'job-2026100');
  await abrirJob(s, J2);
  assert.equal(win.location.hash, `#/prospeccao/historico/${encodeURIComponent(J2)}`);
  assert.equal(win.history.length, 2);

  win.history.back();
  await s.browser.flush(6);
  assert.equal(win.location.hash, '#/prospeccao/historico', 'o Voltar fica no módulo');
  assert.equal(gaveta(s), null, 'e fecha a gaveta');
  assert.equal(conta(s, 'jobs'), 1, 'sem recarregar');
  assert.equal(s.browser.by.label(s.browser.root, 'Buscar prospecção').value, 'job-2026100');
  win.history.forward();
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'o Avançar reabre a mesma prospecção');
  assert.equal(s.browser.find(gaveta(s), (el) => el.localName === 'h2').textContent, J2);

  s.browser.click(s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  await s.browser.flush(6);
  assert.equal(win.location.hash, '#/prospeccao/historico');
  assert.equal(win.history.length, 2, 'fechar não cria entrada nova');
  assert.equal(s.browser.document.activeElement === botao(s, J2), true, 'o foco voltou à linha');
});

test('[HIST-UX-11] LINK DIRETO: abre a prospecção (carregando a lista antes); fechar troca a entrada; código inexistente avisa e volta à lista; trocar o endereço com a gaveta aberta troca de prospecção', async () => {
  const direto = await abrir({ api: apiFalsa(), comNavegacao: true, hash: `#/prospeccao/historico/${encodeURIComponent(J3)}` });
  assert.ok(gaveta(direto), 'o link direto abriu a gaveta');
  assert.equal(direto.browser.find(gaveta(direto), (el) => el.localName === 'h2').textContent, J3);
  assert.equal(conta(direto, 'jobs'), 1, 'uma carga só');
  direto.browser.press('Escape');
  await direto.browser.flush(6);
  assert.equal(direto.browser.window.location.hash, '#/prospeccao/historico');
  assert.equal(direto.browser.window.history.length, 1, 'sem entrada anterior no app: a entrada é trocada');

  const trocar = await abrir({ api: apiFalsa(), comNavegacao: true, hash: '#/prospeccao/historico' });
  await abrirJob(trocar, J1);
  trocar.browser.window.location.hash = `#/prospeccao/historico/${encodeURIComponent(J2)}`;
  await trocar.browser.flush(8);
  assert.equal(trocar.browser.find(gaveta(trocar), (el) => el.localName === 'h2').textContent, J2);
  assert.equal(trocar.browser.findAll(trocar.browser.root, (el) => el.getAttribute('role') === 'dialog').length, 1);

  const inexistente = await abrir({ api: apiFalsa(), comNavegacao: true, hash: `#/prospeccao/historico/${encodeURIComponent('JOB-99999999-999')}` });
  assert.equal(gaveta(inexistente), null);
  assert.ok(avisos(inexistente).some((t) => /não foi encontrada no histórico/.test(t)));
  assert.equal(inexistente.browser.window.location.hash, '#/prospeccao/historico');
  assert.ok(botao(inexistente, J1), 'a lista segue disponível');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// ATUALIZAÇÃO sem F5 e processos em segundo plano
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[HIST-UX-12] GAVETA ABERTA durante a atualização: o conteúdo muda SÓ se a prospecção mudou (aba e foco ficam); se ela sai da lista, avisa e fecha', async () => {
  const api = apiFalsa({ jobs: [job(1, { status: 'EXECUTANDO', currentStep: 'VALIDANDO', progress: 55, finishedAt: undefined, candidatos: [CANDIDATOS[0]], resumo: { ...RESUMO, naApprovalQueue: 0 } }), job(2)] });
  const s = await abrir({ api });
  await abrirJob(s, J1);
  assert.match(painelDaAba(s, 'resumo').textContent, /Validando as páginas das empresas\. Esta lista se atualiza sozinha/);
  assert.doesNotMatch(painelDaAba(s, 'resumo').textContent, /%/, 'nenhum percentual de progresso é inventado: só a etapa real');
  await aba(s, 'auditoria');
  const abaAtual = () => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true').getAttribute('data-tab');
  const conteudoAntes = gaveta(s).textContent;
  await s.view.refresh();
  await s.browser.flush(6);
  assert.equal(gaveta(s).textContent, conteudoAntes, 'nada mudou: a gaveta não foi reconstruída');

  api.mem.jobs = [job(1), job(2)]; // terminou
  await s.view.refresh();
  await s.browser.flush(6);
  assert.ok(gaveta(s));
  assert.equal(abaAtual(), 'auditoria', 'a aba escolhida foi mantida');
  assert.match(linha(s, J1).textContent, /Concluída/);
  await aba(s, 'resumo');
  assert.doesNotMatch(painelDaAba(s, 'resumo').textContent, /Esta lista se atualiza sozinha/);
  assert.ok(s.browser.by.link(painelDaAba(s, 'resumo'), 'Abrir a Approval Queue'));

  api.mem.jobs = [job(2)];
  await s.view.refresh();
  await s.browser.flush(6);
  assert.equal(gaveta(s), null);
  assert.ok(avisos(s).some((t) => /não está mais na lista/.test(t)));
});

test('[HIST-UX-13] SEGUNDO PLANO: com uma prospecção em andamento a lista se atualiza sozinha (intervalo mínimo, mesma consulta); ao terminar a atualização PARA; sem andamento nada é agendado; sair do módulo para tudo', async () => {
  const andamento = job(1, { status: 'EXECUTANDO', currentStep: 'DESCOBRINDO', progress: 20, finishedAt: undefined, candidatos: [], resumo: { ...RESUMO, naApprovalQueue: 0, validados: 0, descobertos: 0 } });
  const api = apiFalsa({ jobs: [andamento, job(2)] });
  const s = await abrir({ api, comNavegacao: true, hash: '#/prospeccao/historico' });
  assert.equal(conta(s, 'jobs'), 1);
  assert.equal(s.ag.pendentes().length, 1, 'há uma atualização agendada');
  assert.match(linha(s, J1).textContent, /Em execução/);
  await s.ag.rodar();
  await s.browser.flush(6);
  assert.equal(conta(s, 'jobs'), 2, 'uma consulta por rodada');
  assert.equal(s.ag.pendentes().length, 1, 'ainda em andamento: continua agendada');

  api.mem.jobs = [job(1), job(2)]; // terminou
  await s.ag.rodar();
  await s.browser.flush(6);
  assert.match(linha(s, J1).textContent, /Concluída/, 'a lista mudou sozinha, sem F5');
  assert.equal(s.ag.pendentes().length, 0, 'terminou: nada mais é agendado');
  assert.deepEqual(s.api.chamadas.map(([n]) => n).filter((n) => !['jobs', 'briefs'].includes(n)), []);

  // sem nada em andamento, nada é agendado; sair do módulo para a atualização
  const quieto = await abrir({ api: apiFalsa(), comNavegacao: true, hash: '#/prospeccao/historico' });
  assert.equal(quieto.ag.pendentes().length, 0);
  const ativo = await abrir({ api: apiFalsa({ jobs: [andamento] }), comNavegacao: true, hash: '#/prospeccao/historico' });
  assert.equal(ativo.ag.pendentes().length, 1);
  ativo.view.hide();
  assert.equal(ativo.ag.pendentes().length, 0, 'fora de cena: a atualização parou');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// REFAZER
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[HIST-UX-14] REFAZER: só na gaveta e só depois da confirmação humana (que explica que inicia uma prospecção real); clique triplo envia UMA vez; o sucesso leva à Nova Prospecção e avisa o barramento; o histórico não é alterado', async () => {
  const s = await abrir({ api: apiFalsa() });
  assert.equal(s.browser.find(s.browser.root, (el) => el.getAttribute('data-redo') !== null), null, 'a lista não tem o botão');
  await abrirJob(s, J1);
  assert.equal(conta(s, 'refazer'), 0, 'abrir a gaveta não refaz nada');
  const refazer = s.browser.by.id(s.browser.root, 'history-redo');
  assert.equal(refazer.textContent, 'Refazer prospecção');
  await clicar(s, refazer);
  assert.equal(conta(s, 'refazer'), 0, 'abrir a confirmação não inicia nada');
  const c = confirmacao(s);
  assert.match(c.textContent, /Refazer prospecção.*Prospecção: JOB-20261001-001.*cria e INICIA uma prospecção nova.*Claude deste computador.*nada é apagado/s);
  const confirmar = s.browser.find(c, (el) => el.getAttribute('data-action') === 'confirm');
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  await s.browser.flush(10);
  assert.deepEqual(s.api.chamadas.filter(([n]) => n === 'refazer'), [['refazer', J1]], 'uma única prospecção');
  assert.deepEqual(s.destinos, ['#/prospeccao'], 'leva à Nova Prospecção, onde o andamento é acompanhado');
  assert.equal(confirmacao(s), null);
  assert.equal(gaveta(s), null);
  assert.deepEqual(s.eventos, [['redo', J1]]);
  assert.equal(s.api.mem.jobs.length, 3, 'o histórico não foi alterado');
});

test('[HIST-UX-15] REFAZER com ERRO: a confirmação continua aberta com a mensagem do servidor e dá para tentar de novo; ESC com a confirmação aberta a fecha sem iniciar nada; sem permissão ou com a prospecção em andamento não há botão', async () => {
  let falhar = true;
  const refazer = () => {
    if (falhar) throw Object.assign(new Error('x'), { status: 409, serverMessage: 'Já existe uma prospecção em execução. Aguarde ela terminar ou cancele.' });
    return { item: { id: 'JOB-NOVO' } };
  };
  const s = await abrir({ api: apiFalsa({ refazer }) });
  await abrirJob(s, J2);
  await clicar(s, s.browser.by.id(s.browser.root, 'history-redo'));
  await clicar(s, s.browser.find(confirmacao(s), (el) => el.getAttribute('data-action') === 'confirm'));
  assert.ok(confirmacao(s), 'o erro não fecha a confirmação');
  assert.match(confirmacao(s).textContent, /Já existe uma prospecção em execução/);
  assert.deepEqual(s.destinos, []);
  assert.equal(s.browser.find(confirmacao(s), (el) => el.getAttribute('data-action') === 'confirm').disabled, false, 'dá para tentar de novo');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(confirmacao(s), null, 'ESC fecha a confirmação');
  assert.ok(gaveta(s), 'e a gaveta continua');
  assert.equal(conta(s, 'refazer'), 1);
  await clicar(s, s.browser.by.id(s.browser.root, 'history-redo'));
  falhar = false;
  await clicar(s, s.browser.find(confirmacao(s), (el) => el.getAttribute('data-action') === 'confirm'));
  assert.deepEqual(s.destinos, ['#/prospeccao']);

  const leitura = await abrir({ api: apiFalsa(), canProposeLead: false });
  await abrirJob(leitura, J1);
  assert.equal(leitura.browser.by.id(leitura.browser.root, 'history-redo'), null);
  assert.match(gaveta(leitura).textContent, /Sua conta não pode iniciar prospecções\./);
  assert.ok(painelDaAba(leitura, 'resumo'), 'a leitura continua disponível');

  const emAndamento = await abrir({ api: apiFalsa({ jobs: [job(1, { status: 'EXECUTANDO', finishedAt: undefined })] }) });
  await abrirJob(emAndamento, J1);
  assert.equal(emAndamento.browser.by.id(emAndamento.browser.root, 'history-redo'), null);
  assert.equal(emAndamento.browser.by.link(gaveta(emAndamento), 'Acompanhar na Nova Prospecção').href, '#/prospeccao');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// NO PAINEL INTEIRO
// ---------------------------------------------------------------------------------------------------------------------------------------------

const me = (role, name) => ({ userId: `user-${name.toLowerCase()}`, name, role, permissions: [...authConstants.getRolePermissions(role)], status: 'ACTIVE' });

async function painel({ hash = '#/prospeccao/historico', permissoes = null } = {}) {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await loadRouter();
  const { createFakeSdk, scriptedFetch, FAKE_SESSION } = await loadFixtures();
  const browser = createBrowser({ hash });
  const mem = { jobs: [job(1), job(2), job(3)] };
  const fetchImpl = scriptedFetch({
    'GET /config.json': { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' },
    'GET /api/me': permissoes ? { ...me('ADMIN', 'Breno'), permissions: permissoes } : me('ADMIN', 'Breno'),
    'GET /api/crm': { items: [] },
    'GET /api/prospecting/jobs': () => ({ items: mem.jobs }),
    'GET /api/prospecting/briefs': () => ({ items: BRIEFS }),
    'POST /api/prospecting/jobs/JOB-20261001-001/redo': () => ({ status: 202, body: { item: { id: 'JOB-NOVO' } } }),
    'GET /api/prospecting/jobs/JOB-NOVO': { item: { id: 'JOB-NOVO' } },
  });
  const navigation = browserNavigation(browser.window);
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk: createFakeSdk({ session: FAKE_SESSION }), navigation });
  await browser.flush(10);
  return { browser, fetchImpl, mem };
}
const linkMenu = (t, nome) => t.browser.by.link(t.browser.root, nome);
const chamadasDe = (t, metodo, prefixo) => t.fetchImpl.calls.filter((c) => c.method === metodo && c.path.startsWith(prefixo)).length;

test('[HIST-UX-16] NO PAINEL: o módulo é persistente (busca e filtros sobrevivem a trocar de módulo), a gaveta tem URL, abrir o detalhe só LÊ, e voltar ao módulo atualiza em silêncio (uma leitura)', async () => {
  const t = await painel();
  assert.equal(linkMenu(t, 'Histórico').getAttribute('aria-current'), 'page');
  assert.equal(t.browser.window.location.hash, '#/prospeccao/historico');
  t.browser.type(t.browser.by.label(t.browser.root, 'Buscar prospecção'), 'odonto');
  t.browser.choose(t.browser.by.label(t.browser.root, 'Situação'), 'CONCLUIDO');
  t.browser.click(t.browser.by.button(t.browser.root, J3));
  await t.browser.flush(10);
  assert.equal(t.browser.window.location.hash, `#/prospeccao/historico/${encodeURIComponent(J3)}`);
  const d = t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className));
  assert.ok(d);
  assert.equal(t.browser.find(t.browser.root, (el) => el.className === 'shell').hasAttribute('inert'), true, 'o menu e o conteúdo ficam inert');
  assert.equal(t.fetchImpl.calls.filter((c) => c.method !== 'GET').length, 0, 'nenhuma escrita: abrir só lê');
  const antes = chamadasDe(t, 'GET', '/api/prospecting/jobs');

  t.browser.press('Escape');
  await t.browser.flush(8);
  t.browser.click(linkMenu(t, 'CRM'));
  await t.browser.flush(8);
  assert.equal(t.browser.find(t.browser.root, (el) => el.className === 'shell').hasAttribute('inert'), false);
  t.browser.click(linkMenu(t, 'Histórico'));
  await t.browser.flush(10);
  assert.equal(t.browser.by.label(t.browser.root, 'Buscar prospecção').value, 'odonto', 'a busca sobreviveu a trocar de módulo');
  assert.equal(t.browser.by.label(t.browser.root, 'Situação').value, 'CONCLUIDO');
  assert.equal(chamadasDe(t, 'GET', '/api/prospecting/jobs') >= antes + 1, true, 'voltar atualiza');
});

test('[HIST-UX-17] NO PAINEL: sair do módulo com a gaveta aberta fecha a camada e nunca deixa o app inert; refazer pelo painel leva à Nova Prospecção; link direto funciona; sem permissão o módulo continua sem acesso e nada é pedido', async () => {
  const t = await painel({ hash: `#/prospeccao/historico/${encodeURIComponent(J1)}` });
  const d = t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className));
  assert.ok(d, 'o link direto abriu a gaveta');
  t.browser.click(t.browser.by.id(d, 'history-redo'));
  await t.browser.flush(6);
  t.browser.click(t.browser.find(t.browser.root, (el) => el.getAttribute('data-action') === 'confirm'));
  await t.browser.flush(12);
  assert.equal(chamadasDe(t, 'POST', '/api/prospecting/jobs/JOB-20261001-001/redo'), 1);
  assert.equal(t.browser.window.location.hash, '#/prospeccao', 'foi para a Nova Prospecção');
  assert.equal(t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className)), null);
  assert.equal(t.browser.find(t.browser.root, (el) => el.className === 'shell').hasAttribute('inert'), false);

  const fora = await painel();
  fora.browser.click(fora.browser.by.button(fora.browser.root, J2));
  await fora.browser.flush(10);
  assert.ok(fora.browser.find(fora.browser.root, (el) => el.getAttribute('role') === 'dialog'));
  fora.browser.window.location.hash = '#/agentes';
  await fora.browser.flush(10);
  assert.equal(fora.browser.find(fora.browser.root, (el) => el.getAttribute('role') === 'dialog'), null);
  assert.equal(fora.browser.find(fora.browser.root, (el) => el.className === 'shell').hasAttribute('inert'), false);
  assert.equal(fora.browser.document.listenerCount('keydown'), 0);

  const semAcesso = await painel({ permissoes: ['READ:CRM'], hash: `#/prospeccao/historico/${encodeURIComponent(J1)}` });
  assert.equal(semAcesso.browser.by.link(semAcesso.browser.root, 'Histórico'), null, 'o item some do menu');
  assert.match(semAcesso.browser.root.textContent, /Esta conta não possui acesso a esta área\./);
  assert.equal(semAcesso.fetchImpl.calls.some((c) => c.path.startsWith('/api/prospecting')), false, 'nada é pedido ao servidor');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// PURAS, CONTROLADOR COMPARTILHADO e ESTILO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[HIST-UX-18] as funções puras: indicadores reais (null quando o servidor não informou), classificação de candidatos em UM grupo, e o texto do porquê só com o que foi registrado', async () => {
  const { jobIndicators, classifyCandidate, candidateDetail, briefPlace, visibleJobs } = await loadView();
  assert.deepEqual(jobIndicators(job(1)), { solicitados: 3, encontrados: 6, processados: 6, validados: 3, naFila: 1, naoValidados: 3, retidos: 1, descartados: 4, jaExistentes: 1, repetidos: 0, aprovados: 0, rejeitados: 1, promovidos: 0 });
  const vazio = jobIndicators({ id: 'x' });
  for (const chave of Object.keys(vazio)) assert.equal(vazio[chave], null, `${chave}: sem dado do servidor = null`);
  assert.equal(jobIndicators({ resumo: { naoValidados: 5 } }).descartados, 5, 'sem os retidos informados, só os não validados');
  assert.equal(classifyCandidate({ resultado: 'VALIDADO', entrega: { naFila: true } }), 'ENTREGUE');
  assert.equal(classifyCandidate({ resultado: 'VALIDADO', entrega: { naFila: false, jaExistiaNaFila: true } }), 'JA_EXISTIA');
  assert.equal(classifyCandidate({ resultado: 'VALIDADO', entrega: { naFila: false, estadoOperacional: 'DNC' } }), 'RETIDO');
  assert.equal(classifyCandidate({ resultado: 'VALIDADO' }), 'SEM_ENTREGA');
  assert.equal(classifyCandidate({ resultado: 'NAO_VERIFICADO' }), 'NAO_VALIDADO');
  assert.equal(classifyCandidate({ resultado: 'DESCARTADO' }), 'DESCARTADO');
  assert.equal(classifyCandidate({}), 'NAO_PROCESSADO');
  assert.deepEqual(candidateDetail({ resultado: 'NAO_VERIFICADO', motivo: 'CODIGO_NOVO_DESCONHECIDO', causa: 'OUTRA' }), ['CODIGO_NOVO_DESCONHECIDO', 'causa: OUTRA'], 'um código que a tela não conhece aparece como veio (nunca é reescrito)');
  assert.deepEqual(candidateDetail({ resultado: 'VALIDADO', entrega: { naFila: true } }), [], 'entregue: nada a explicar');
  assert.equal(briefPlace({ nivelGeografico: 'NACIONAL' }), 'Brasil');
  assert.equal(briefPlace(null), '');
  const jobs = [job(1), job(2)];
  assert.deepEqual(visibleJobs(jobs, { 'PROS-1': BRIEFS[0], 'PROS-2': BRIEFS[1] }, { query: 'psicologia' }).map((j) => j.id), [J2]);
});

test('[HIST-UX-19] o CONTROLADOR COMPARTILHADO da gaveta com URL (dashboard/ui/routedDrawer.mjs): clique empilha uma entrada, rota não empilha, X volta ou troca, fechar por código não navega, foco e repintura', async () => {
  const { createRoutedDrawer, createOverlayManager } = Object.assign({}, await loadUi());
  const { browserNavigation } = await loadRouter();
  const browser = createBrowser({ hash: '#/lista' });
  const host = browser.document.createElement('div');
  browser.root.append(host);
  const overlays = createOverlayManager({ document: browser.document, host });
  const navigation = browserNavigation(browser.window);
  let repaints = 0;
  const botoes = new Map();
  const lista = browser.document.createElement('div');
  browser.root.append(lista);
  for (const id of ['a', 'b']) {
    const b = browser.document.createElement('button');
    b.setAttribute('data-item', id);
    b.textContent = id;
    lista.append(b);
    botoes.set(id, b);
  }
  const ctl = createRoutedDrawer({
    document: browser.document,
    navigation,
    hashFor: (id) => `#/lista/${id}`,
    listHash: '#/lista',
    rowButton: (id) => botoes.get(id) || null,
    repaint: () => { repaints += 1; },
    build: (id, hooks) => overlays.openDrawer({ key: `x:${id}`, title: id, content: browser.document.createElement('div'), getReturnFocus: hooks.getReturnFocus, onClose: hooks.onClose }),
  });
  const aberto = () => browser.findAll(browser.root, (el) => el.getAttribute('role') === 'dialog').length;

  botoes.get('a').focus();
  ctl.open('a');
  ctl.open('a');
  await browser.flush(4);
  assert.equal(aberto(), 1, 'abrir duas vezes o mesmo item abre uma camada');
  assert.equal(browser.window.location.hash, '#/lista/a');
  assert.equal(browser.window.history.length, 2, 'uma entrada empilhada');
  overlays.closeTop('button');
  await browser.flush(6);
  assert.equal(aberto(), 0);
  assert.equal(browser.window.location.hash, '#/lista', 'fechar pela interface volta uma entrada');
  assert.equal(browser.document.activeElement === botoes.get('a'), true, 'o foco volta à linha');
  assert.ok(repaints >= 1, 'a lista é repintada');

  // aberta pelo endereço: não empilha; fechar troca a entrada
  browser.window.location.hash = '#/lista/b';
  await browser.flush(4);
  assert.equal(ctl.openFromRoute('b'), true);
  assert.equal(aberto(), 1);
  const tamanho = browser.window.history.length;
  overlays.closeTop('button');
  await browser.flush(6);
  assert.equal(browser.window.location.hash, '#/lista');
  assert.equal(browser.window.history.length, tamanho, 'fechar uma gaveta do endereço troca a entrada: não empilha');

  // por código, sem mexer no endereço
  ctl.open('a');
  await browser.flush(4);
  const antes = browser.window.location.hash;
  ctl.listRoute();
  await browser.flush(4);
  assert.equal(aberto(), 0);
  assert.equal(browser.window.location.hash, antes, 'fechar por código não navega');
  ctl.leave(overlays);
  assert.equal(ctl.isOpen(), false);
});

test('[HIST-UX-20] o CSS reutiliza o padrão (linha clicável, gaveta, indicadores, candidatos) e no celular a lista vira cartões; colunas numéricas alinhadas; sem sombras pesadas', async () => {
  assert.match(css, /table\.list\.queue th\.num, table\.list\.queue td\.num \{[^}]*text-align: right/);
  assert.match(css, /\.indicator-number \.indicator-value \{[^}]*font-size: 24px/);
  assert.match(css, /\.candidate-item\[data-group="ENTREGUE"\] \{ border-left-color: var\(--brand-strong\)/);
  assert.match(css, /\.candidate-name \{[^}]*overflow-wrap: anywhere/);
  const celular = css.slice(css.indexOf('@media (max-width: 760px) {\n  .overlay-dialog.drawer'));
  assert.match(celular, /table\.queue td::before \{[^}]*content: attr\(data-label\)/);
  assert.match(celular, /table\.list\.queue td\.num \{ text-align: left; \}/);
  const s = await abrir({ api: apiFalsa() });
  assert.deepEqual(s.browser.findAll(linha(s, J1), (el) => el.localName === 'td').map((el) => el.getAttribute('data-label')), ['Prospecção', 'Situação', 'Data', 'Encontrados', 'Validados', 'Na fila', 'Descartados']);
});
