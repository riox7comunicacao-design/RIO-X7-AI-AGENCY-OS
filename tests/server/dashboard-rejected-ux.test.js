// Leads Reprovados na UX 4.0.2 (mesmo padrão da Approval Queue): lista com busca/ordem/paginação e linha inteira clicável, gaveta do lead (abas, decisão
// com motivo/data/responsável, nada afirmado sobre dado ausente), URL do lead (link direto, Voltar/Avançar), RECONSIDERAR com confirmação humana
// (uma única requisição, sucesso só depois do servidor, erro que preserva o digitado) e atualização sem F5, inclusive o contador da Approval Queue.
// DOM de teste e API falsa — nenhum navegador, nenhuma rede, nenhum Claude, nenhuma operação real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');

const loadView = () => import('../../dashboard/views/rejectedLeads.mjs');
const loadRouter = () => import('../../dashboard/router.mjs');
const loadUi = () => import('../../dashboard/ui/index.mjs');
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------------------------------------
const nn = (i) => String(i).padStart(2, '0');
const rej = (i, extras = {}, snap = {}) => ({
  prospectId: `rej-${nn(i)}`,
  empresa: `Lead ${nn(i)}`,
  estado: 'REJEITADO',
  reaprovavel: true,
  reprovadoEm: `2026-10-${String(10 + (i % 9)).padStart(2, '0')}T12:00:00.000Z`,
  reprovadoPor: { userId: 'u1', name: 'Rafael Closer', role: 'COMMERCIAL_CLOSER' },
  origemDaDecisao: 'HUMANO',
  motivo: 'Sem fit com o serviço',
  reaprovacoes: 0,
  jobOrigem: 'JOB-20261007-001',
  dadosComerciais: { empresa: `Lead ${nn(i)}`, cidade: i % 2 ? 'Petrópolis' : 'Niterói', estadoUf: 'RJ', nicho: i % 3 === 0 ? 'Psicologia' : 'Estética', tipoLead: 'EMPRESA', tipo: 'Clínica', statusDados: 'SUFICIENTES', statusDuplicidade: 'NOVO', statusDNC: 'NAO_ENCONTRADO', statusIdentidade: { status: 'VALIDADA', motivo: 'CONFIRMADA' }, dataDaPesquisa: '2026-10-05', telefone: '(24) 2222-3333', site: 'https://exemplo-alfa.com.br', hipoteseDeOportunidade: 'Sem tráfego pago.', fontes: [{ url: 'https://exemplo-alfa.com.br/', tipoFonte: 'OFICIAL' }], ...snap },
  perfil: null,
  historico: [
    { timestamp: '2026-10-07T10:00:00.000Z', from: null, to: 'AGUARDANDO_REVISAO', actor: 'SYSTEM', motivo: 'Novo prospect descoberto' },
    { timestamp: '2026-10-07T12:00:00.000Z', from: 'AGUARDANDO_REVISAO', to: 'REJEITADO', actor: 'HUMAN', reviewedBy: { userId: 'u1', name: 'Rafael Closer', role: 'COMMERCIAL_CLOSER' }, motivo: 'Sem fit com o serviço' },
  ],
  ...extras,
});

const RESPONSAVEL_LONGO = 'Dra. Maria Fernanda de Albuquerque Cavalcanti Nogueira de Sousa Lima';
const perfilApresentado = (responsavel) => ({ prospectId: 'rej-01', empresa: 'Lead 01', responsavel, siteOficial: { status: 'ENCONTRADO', url: 'https://exemplo-alfa.com.br/' }, telefones: [], emails: [], presencaDigital: {}, trafegoPago: {}, atividadeRecente: {}, fontesDescoberta: [], fontesValidacao: [], fontesEnriquecimento: [], outrasPresencas: [] });

const agenda = () => {
  const tarefas = [];
  return {
    tarefas,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelada: false };
      tarefas.push(t);
      return () => { t.cancelada = true; };
    },
    pendentes: () => tarefas.filter((t) => !t.cancelada),
  };
};

// API falsa com a lista MUTÁVEL (o servidor "muda" entre uma chamada e outra) e o registro de tudo o que foi pedido.
function apiFalsa({ itens = [], responsavel = { status: 'PENDENTE_DE_CONFIRMACAO', nome: RESPONSAVEL_LONGO, cargo: 'Sócia-fundadora' }, reaprovar, semPerfil = false } = {}) {
  const chamadas = [];
  const mem = { itens: [...itens] };
  const api = {
    chamadas,
    mem,
    listRejectedLeads: async (filtro) => {
      chamadas.push(['lista', filtro]);
      if (mem.falharLista) throw Object.assign(new Error('x'), { status: 500 });
      const estados = { TODOS: null, REPROVADOS: ['REJEITADO'], DADOS_INSUFICIENTES: ['DADOS_INSUFICIENTES'], DUPLICADOS: ['DUPLICADO'], DNC: ['DNC'], EXPIRADOS: ['EXPIRADO'] }[filtro || 'TODOS'];
      return { items: mem.itens.filter((item) => estados === null || estados.includes(item.estado)) };
    },
    reapproveLead: async (id, motivo) => {
      chamadas.push(['reaprovar', id, motivo]);
      if (reaprovar) return reaprovar(id, motivo, mem);
      mem.itens = mem.itens.filter((item) => item.prospectId !== id);
      return { item: { prospectId: id, estado: 'AGUARDANDO_REVISAO' } };
    },
    getLeadResearchStatus: async (id) => {
      chamadas.push(['pesquisa', id]);
      return { item: { status: 'NAO_EXECUTADO', camposPendentes: [], podeCompletar: false, disponivel: true } };
    },
    completeLeadResearch: async (id) => {
      chamadas.push(['completar', id]);
      throw new Error('nenhuma pesquisa deve começar sozinha');
    },
  };
  if (!semPerfil) {
    api.getLeadProfile = async (id) => {
      chamadas.push(['perfil', id]);
      return { item: id === 'rej-01' ? perfilApresentado(responsavel) : null };
    };
  }
  return api;
}

async function abrir({ api, canReview = true, comNavegacao = false, hash = '', filtro = null } = {}) {
  const { createRejectedLeadsView } = await loadView();
  const { createDataBus } = await loadUi();
  const { browserNavigation, parseRoute } = await loadRouter();
  const browser = createBrowser({ hash });
  const ag = agenda();
  const bus = createDataBus();
  const eventos = [];
  bus.subscribe('approvals:changed', (p) => eventos.push([p.action, p.prospectId]));
  const navigation = comNavegacao ? browserNavigation(browser.window) : null;
  const view = createRejectedLeadsView({ document: browser.document, root: browser.root, api, permissions: { canReview }, schedule: ag.schedule, bus, ...(navigation ? { navigation } : {}) });
  if (navigation) navigation.subscribe(() => view.show(parseRoute(navigation.current())));
  const s = { browser, view, api, ag, bus, eventos, navigation };
  if (comNavegacao) await view.show(parseRoute(navigation.current()));
  else await view.load();
  await browser.flush();
  if (filtro) {
    browser.click(browser.by.button(browser.root, filtro));
    await browser.flush(6);
  }
  return s;
}

const gaveta = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const confirmacao = (s) => s.browser.find(s.browser.root, (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className));
const botao = (s, nome) => s.browser.by.button(s.browser.root, nome);
const linha = (s, nome) => botao(s, nome).parentNode.parentNode.parentNode; // botão → company-cell → td → tr
const celula = (s, nome, rotulo) => s.browser.find(linha(s, nome), (el) => el.localName === 'td' && el.getAttribute('data-label') === rotulo);
const avisos = (s) => s.browser.findAll(s.browser.root, (el) => el.className === 'toast-message').map((el) => el.textContent);
const conta = (s, nome) => s.api.chamadas.filter(([n]) => n === nome).length;
const painelDaAba = (s, chave) => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tabpanel' && new RegExp(chave).test(el.getAttribute('aria-labelledby') || ''));
const clicar = async (s, el) => { s.browser.click(el); await s.browser.flush(6); };
const abrirLead = async (s, nome) => { await clicar(s, botao(s, nome)); return gaveta(s); };
const ocorrencias = (texto, trecho) => texto.split(trecho).length - 1;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A LISTA
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[REJ-UX-1] a lista: colunas legíveis, selo de situação, motivo e responsável pela decisão; linha INTEIRA clicável (mouse, Enter e Espaço), sem aparência de link; cliques rápidos abrem uma gaveta só', async () => {
  const s = await abrir({ api: apiFalsa({ itens: [rej(1), rej(2), rej(3, { estado: 'DNC', reaprovavel: false, origemDaDecisao: 'SISTEMA', reprovadoPor: null, motivo: 'DNC' })] }) });
  const cabecalhos = s.browser.by.tag(s.browser.root, 'th').map((el) => el.textContent);
  assert.deepEqual(cabecalhos, ['Empresa', 'Situação', 'Motivo', 'Data', 'Decidido por']);
  assert.match(s.browser.root.textContent, /3 leads/);
  const tr = linha(s, 'Lead 01');
  assert.match(tr.className, /\bqueue-row\b/);
  assert.match(tr.textContent, /Petrópolis\/RJ · Estética/);
  assert.match(tr.textContent, /Reprovado/);
  assert.match(tr.textContent, /Sem fit com o serviço/);
  assert.match(tr.textContent, /Rafael Closer/);
  assert.match(linha(s, 'Lead 03').textContent, /DNC.*Sistema/s);
  assert.doesNotMatch(botao(s, 'Lead 01').className, /link-button/);
  assert.equal(s.browser.findAll(tr, (el) => el.localName === 'a').length, 0);

  s.browser.click(celula(s, 'Lead 02', 'Motivo')); // fora do botão
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'a linha inteira abre a gaveta');
  assert.equal(s.browser.find(gaveta(s), (el) => el.localName === 'h2').textContent, 'Lead 02');
  s.browser.press('Escape');
  await s.browser.flush(4);

  const b = botao(s, 'Lead 01');
  b.focus();
  s.browser.press('Enter');
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'Enter abre');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(s.browser.document.activeElement === botao(s, 'Lead 01'), true, 'o foco volta ao botão da linha');
  s.browser.press(' ');
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'Espaço abre');
  s.browser.press('Escape');
  await s.browser.flush(4);

  const botao3 = botao(s, 'Lead 03');
  s.browser.click(botao3);
  s.browser.click(celula(s, 'Lead 03', 'Data'));
  s.browser.click(botao3);
  await s.browser.flush(8);
  assert.equal(s.browser.findAll(s.browser.root, (el) => el.getAttribute('role') === 'dialog').length, 1, 'uma gaveta só');
  assert.equal(conta(s, 'lista'), 1, 'nenhum recarregamento');
});

test('[REJ-UX-2] BUSCA por empresa, cidade e nicho (sem acento/caixa), ORDEM e PAGINAÇÃO; busca, página e ordem sobrevivem a abrir/fechar a gaveta e a atualizar; vazio e "nada encontrado" são claros', async () => {
  const itens = Array.from({ length: 22 }, (_, i) => rej(i + 1));
  const s = await abrir({ api: apiFalsa({ itens }) });
  assert.match(s.browser.root.textContent, /Página 1 de 2 · 1–15 de 22/);
  assert.equal(s.browser.by.tag(s.browser.root, 'tr').length, 16);
  const campo = s.browser.by.label(s.browser.root, 'Buscar lead');
  const ordem = s.browser.by.label(s.browser.root, 'Ordenar por');

  s.browser.type(campo, 'petropolis'); // cidade, sem acento
  assert.match(s.browser.root.textContent, /22 leads · 11 na busca/);
  s.browser.type(campo, 'PSICOLOGIA'); // nicho, caixa alta
  assert.match(s.browser.root.textContent, /22 leads · 7 na busca/);
  s.browser.type(campo, 'lead 05'); // empresa
  assert.match(s.browser.root.textContent, /22 leads · 1 na busca/);
  s.browser.type(campo, 'nada disso existe');
  assert.match(s.browser.root.textContent, /Nenhum lead encontrado/);
  assert.equal(s.browser.by.tag(s.browser.root, 'table').length, 0);
  s.browser.type(campo, '');

  s.browser.choose(ordem, 'empresa-desc');
  assert.equal(s.browser.by.tag(s.browser.root, 'tbody')[0].textContent.includes('Lead 22'), true);
  await clicar(s, botao(s, 'Próxima'));
  assert.match(s.browser.root.textContent, /Página 2 de 2/);
  assert.ok(botao(s, 'Lead 01'), 'Z–A: a última página tem o Lead 01');

  await abrirLead(s, 'Lead 01');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.match(s.browser.root.textContent, /Página 2 de 2/, 'a página sobreviveu à gaveta');
  assert.equal(ordem.value, 'empresa-desc');
  await clicar(s, botao(s, 'Atualizar'));
  assert.match(s.browser.root.textContent, /Página 2 de 2/, 'e à atualização');
  assert.equal(conta(s, 'lista'), 2);
  s.browser.type(campo, 'niterói');
  await clicar(s, botao(s, 'Atualizar'));
  assert.equal(campo.value, 'niterói');
  assert.equal(s.browser.by.label(s.browser.root, 'Buscar lead') === campo, true, 'o campo é o mesmo elemento (foco e texto ficam)');

  const vazio = await abrir({ api: apiFalsa({ itens: [] }) });
  assert.ok(vazio.browser.by.id(vazio.browser.root, 'rejected-empty'));
  assert.match(vazio.browser.root.textContent, /Nenhum lead nesta categoria/);
});

test('[REJ-UX-3] FILTROS por categoria vêm do servidor: o botão ativo fica marcado, trocar de filtro recarrega UMA vez, e busca/ordem permanecem; erro de carga sem lista mostra a mensagem e "Atualizar" tenta de novo', async () => {
  const itens = [rej(1), rej(2, { estado: 'DUPLICADO', reaprovavel: false, motivo: 'Duplicado' }), rej(3, { estado: 'DADOS_INSUFICIENTES', reaprovavel: false })];
  const api = apiFalsa({ itens });
  const s = await abrir({ api });
  for (const rotulo of ['Todos', 'Reprovados', 'Dados insuficientes', 'Duplicados', 'DNC', 'Expirados']) assert.ok(botao(s, rotulo), rotulo);
  assert.equal(botao(s, 'Todos').getAttribute('aria-pressed'), 'true');
  s.browser.type(s.browser.by.label(s.browser.root, 'Buscar lead'), 'lead');
  await clicar(s, botao(s, 'Duplicados'));
  assert.deepEqual(api.chamadas.at(-1), ['lista', 'DUPLICADOS']);
  assert.equal(botao(s, 'Duplicados').getAttribute('aria-pressed'), 'true');
  assert.equal(botao(s, 'Todos').getAttribute('aria-pressed'), 'false');
  assert.ok(botao(s, 'Lead 02') && !s.browser.by.button(s.browser.root, 'Lead 01'));
  assert.equal(s.browser.by.label(s.browser.root, 'Buscar lead').value, 'lead', 'a busca ficou');
  await clicar(s, botao(s, 'Duplicados'));
  assert.equal(conta(s, 'lista'), 2, 'clicar no filtro já ativo não recarrega');

  const falha = apiFalsa({ itens: [rej(1)] });
  falha.mem.falharLista = true;
  const t = await abrir({ api: falha });
  assert.match(t.browser.by.cls(t.browser.root, 'message')[0].textContent, /Não foi possível concluir agora/);
  falha.mem.falharLista = false;
  await clicar(t, botao(t, 'Atualizar'));
  assert.ok(botao(t, 'Lead 01'));
  assert.equal(t.browser.by.cls(t.browser.root, 'message').length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A GAVETA
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[REJ-UX-4] a GAVETA abre na própria tela com as cinco abas e a DECISÃO em destaque: situação, motivo, data, quem decidiu, job e reconsiderações anteriores — sem recarregar a lista', async () => {
  const s = await abrir({ api: apiFalsa({ itens: [rej(1), rej(2)] }) });
  const d = await abrirLead(s, 'Lead 01');
  assert.ok(d);
  assert.equal(d.getAttribute('aria-modal'), 'true');
  assert.equal(conta(s, 'lista'), 1, 'abrir o lead NÃO recarrega a lista');
  assert.equal(s.browser.find(d, (el) => el.localName === 'h2').textContent, 'Lead 01');
  assert.match(d.textContent, /Petrópolis\/RJ · Estética/);
  assert.deepEqual(s.browser.findAll(d, (el) => el.getAttribute('role') === 'tab').map((el) => el.getAttribute('data-tab')), ['resumo', 'contatos', 'pesquisa', 'fontes', 'historico']);
  const resumo = painelDaAba(s, 'resumo');
  const titulos = s.browser.findAll(resumo, (el) => el.localName === 'h3').map((el) => el.textContent);
  assert.deepEqual(titulos, ['Decisão', 'Identidade', 'Situação comercial', 'Responsável', 'Notas da pesquisa']);
  const decisao = s.browser.find(resumo, (el) => /\bdecision-card\b/.test(el.className));
  assert.match(decisao.className, /decision-bad/);
  assert.equal(s.browser.find(decisao, (el) => /\bdecision-reason\b/.test(el.className)).textContent, 'Sem fit com o serviço');
  assert.match(decisao.textContent, /Reprovado/);
  assert.match(decisao.textContent, /\d{2}\/\d{2}\/2026/, 'a data da decisão');
  assert.match(decisao.textContent, /Decidido porRafael Closer \(COMMERCIAL_CLOSER\)/);
  assert.match(decisao.textContent, /Job de origemJOB-20261007-001/);
  assert.match(decisao.textContent, /Reconsiderações anteriores0/);
  // cada informação uma vez: nada de cartões repetindo a lista
  assert.equal(ocorrencias(resumo.textContent, 'Sem fit com o serviço'), 1);
  assert.equal(s.browser.by.cls(resumo, 'summary-card').length, 0);
  assert.equal(s.browser.by.cls(resumo, 'indicator').length, 4);
  // o que existia continua em alguma aba
  assert.match(painelDaAba(s, 'contatos').textContent, /\(24\) 2222-3333/);
  assert.match(painelDaAba(s, 'contatos').textContent, /exemplo-alfa\.com\.br/);
  assert.match(painelDaAba(s, 'fontes').textContent, /exemplo-alfa\.com\.br/);
  assert.match(painelDaAba(s, 'historico').textContent, /Aguardando revisão → Rejeitado.*Rafael Closer \(COMMERCIAL_CLOSER\): Sem fit com o serviço/s);
  assert.match(painelDaAba(s, 'pesquisa').textContent, /Análise comercial/);

  s.browser.click(s.browser.find(d, (el) => el.getAttribute('data-action') === 'close'));
  await s.browser.flush(4);
  assert.equal(gaveta(s), null, 'o X fecha');
});

test('[REJ-UX-5] DADOS AUSENTES não são afirmados: sem motivo, data, responsável, perfil ou dados comerciais a gaveta diz "não registrado"/"sem análise" e omite as seções vazias', async () => {
  const sem = rej(1, { motivo: null, reprovadoEm: null, reprovadoPor: null, origemDaDecisao: 'HUMANO', jobOrigem: null, historico: [], dadosComerciais: { empresa: 'Lead 01' } });
  const s = await abrir({ api: apiFalsa({ itens: [sem], responsavel: null }) });
  await abrirLead(s, 'Lead 01');
  const resumo = painelDaAba(s, 'resumo');
  assert.deepEqual(s.browser.findAll(resumo, (el) => el.localName === 'h3').map((el) => el.textContent), ['Decisão', 'Responsável'], 'sem identidade, indicadores nem notas');
  assert.match(resumo.textContent, /Motivo não registrado\./);
  assert.match(resumo.textContent, /Data não registrada/);
  assert.match(resumo.textContent, /Decidido porNão registrado/, 'humano sem identidade informada: nunca inventa uma pessoa');
  assert.doesNotMatch(resumo.textContent, /Job de origem/);
  assert.match(resumo.textContent, /Sem análise comercial/);
  assert.doesNotMatch(resumo.textContent, /Confirmado|Pendente/);
  assert.match(painelDaAba(s, 'contatos').textContent, /Sem contatos informados/);
  assert.match(painelDaAba(s, 'fontes').textContent, /Sem fontes registradas/);
  assert.match(painelDaAba(s, 'historico').textContent, /Sem histórico/);
  assert.match(linha(s, 'Lead 01').textContent, /—/, 'a lista também mostra "—" no que falta');

  // decisão automática do sistema: "Sistema (automático)"
  const auto = await abrir({ api: apiFalsa({ itens: [rej(2, { estado: 'EXPIRADO', reaprovavel: false, origemDaDecisao: 'SISTEMA', reprovadoPor: null, motivo: 'Prazo vencido' })] }) });
  await abrirLead(auto, 'Lead 02');
  assert.match(painelDaAba(auto, 'resumo').textContent, /Decidido porSistema \(automático\)/);
});

test('[REJ-UX-6] o RESPONSÁVEL vem do perfil apresentado pelo servidor: PENDENTE_DE_CONFIRMACAO em aviso (nunca validado), CONFIRMADO sem aviso; nome longo inteiro; quem não revisa não dispara consulta de perfil', async () => {
  const pendente = await abrir({ api: apiFalsa({ itens: [rej(1)] }) });
  await abrirLead(pendente, 'Lead 01');
  await pendente.browser.flush(6);
  const cartao = pendente.browser.find(gaveta(pendente), (el) => /\bowner-card\b/.test(el.className));
  assert.match(cartao.className, /owner-warn/);
  assert.equal(pendente.browser.find(cartao, (el) => el.className === 'owner-name').textContent, RESPONSAVEL_LONGO);
  assert.match(cartao.textContent, /Pendente de confirmação/);
  assert.doesNotMatch(cartao.textContent, /Confirmado/);
  assert.match(cartao.textContent, /Ainda não validado/);
  assert.equal(conta(pendente, 'perfil'), 1, 'o perfil é lido uma vez');

  const ok = await abrir({ api: apiFalsa({ itens: [rej(1)], responsavel: { status: 'ENCONTRADO', nome: 'Ana Souza', cargo: 'Proprietária' } }) });
  await abrirLead(ok, 'Lead 01');
  await ok.browser.flush(6);
  const confirmado = ok.browser.find(gaveta(ok), (el) => /\bowner-card\b/.test(el.className));
  assert.match(confirmado.className, /owner-ok/);
  assert.match(confirmado.textContent, /Ana Souza.*Proprietária.*Confirmado/s);

  const leitura = await abrir({ api: apiFalsa({ itens: [rej(1)] }), canReview: false });
  await abrirLead(leitura, 'Lead 01');
  assert.equal(conta(leitura, 'perfil'), 0, 'sem permissão: nenhuma consulta de perfil');
  assert.equal(conta(leitura, 'pesquisa'), 0);
});

test('[REJ-UX-7] DNC e leads que não são reprovados por humano NUNCA têm o botão: o rodapé explica; sem permissão a explicação é de permissão', async () => {
  const s = await abrir({ api: apiFalsa({ itens: [rej(1, { estado: 'DNC', reaprovavel: false, origemDaDecisao: 'SISTEMA', reprovadoPor: null, motivo: 'DNC' }), rej(2, { estado: 'DUPLICADO', reaprovavel: false, origemDaDecisao: 'SISTEMA', reprovadoPor: null }), rej(3)] }) });
  await abrirLead(s, 'Lead 01');
  assert.equal(s.browser.by.id(s.browser.root, 'btn-reapprove'), null);
  assert.match(gaveta(s).textContent, /Este contato está em DNC \(restrição de contato\)\. Não é uma rejeição comercial e não pode ser reconsiderado\./);
  s.browser.press('Escape');
  await s.browser.flush(4);
  await abrirLead(s, 'Lead 02');
  assert.equal(s.browser.by.id(s.browser.root, 'btn-reapprove'), null);
  assert.match(gaveta(s).textContent, /Só um lead reprovado por um humano pode ser reconsiderado\./);
  s.browser.press('Escape');
  await s.browser.flush(4);
  await abrirLead(s, 'Lead 03');
  assert.ok(s.browser.by.id(s.browser.root, 'btn-reapprove'), 'reprovado por humano: tem o botão');
  s.browser.press('Escape');
  await s.browser.flush(4);

  const leitura = await abrir({ api: apiFalsa({ itens: [rej(3)] }), canReview: false });
  await abrirLead(leitura, 'Lead 03');
  assert.equal(leitura.browser.by.id(leitura.browser.root, 'btn-reapprove'), null);
  assert.match(gaveta(leitura).textContent, /Sua conta não pode reconsiderar leads\./);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// NAVEGAÇÃO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[REJ-UX-8] URL: abrir muda o endereço; Voltar fecha a gaveta SEM sair do módulo e Avançar reabre; o X volta uma entrada (sem repetir); foco e posição da lista são restaurados', async () => {
  const itens = Array.from({ length: 22 }, (_, i) => rej(i + 1));
  const s = await abrir({ api: apiFalsa({ itens }), comNavegacao: true, hash: '#/prospeccao/leads-reprovados' });
  const win = s.browser.window;
  await clicar(s, botao(s, 'Próxima'));
  s.browser.type(s.browser.by.label(s.browser.root, 'Buscar lead'), 'lead 2');
  await abrirLead(s, 'Lead 20');
  assert.equal(win.location.hash, `#/prospeccao/leads-reprovados/${encodeURIComponent('rej-20')}`);
  assert.equal(win.history.length, 2);

  win.history.back();
  await s.browser.flush(6);
  assert.equal(win.location.hash, '#/prospeccao/leads-reprovados', 'o Voltar fica no módulo');
  assert.equal(gaveta(s), null, 'e fecha a gaveta');
  assert.equal(conta(s, 'lista'), 1, 'sem recarregar');
  assert.equal(s.browser.by.label(s.browser.root, 'Buscar lead').value, 'lead 2', 'a busca ficou');
  win.history.forward();
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'o Avançar reabre o mesmo lead');
  assert.equal(s.browser.find(gaveta(s), (el) => el.localName === 'h2').textContent, 'Lead 20');

  s.browser.click(s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  await s.browser.flush(6);
  assert.equal(win.location.hash, '#/prospeccao/leads-reprovados');
  assert.equal(win.history.length, 2, 'fechar não cria entrada nova');
  assert.equal(s.browser.document.activeElement === botao(s, 'Lead 20'), true, 'o foco voltou à linha');
});

test('[REJ-UX-9] LINK DIRETO: abre o lead (mesmo em outra categoria: busca em "Todos" uma vez); fechar troca a entrada; lead inexistente avisa e volta à lista', async () => {
  const itens = [rej(1), rej(2, { estado: 'DUPLICADO', reaprovavel: false })];
  const direto = await abrir({ api: apiFalsa({ itens }), comNavegacao: true, hash: `#/prospeccao/leads-reprovados/${encodeURIComponent('rej-01')}` });
  assert.ok(gaveta(direto));
  assert.equal(direto.browser.find(gaveta(direto), (el) => el.localName === 'h2').textContent, 'Lead 01');
  direto.browser.press('Escape');
  await direto.browser.flush(6);
  assert.equal(direto.browser.window.location.hash, '#/prospeccao/leads-reprovados');
  assert.equal(direto.browser.window.history.length, 1, 'sem entrada anterior no app: a entrada é trocada');

  const outra = await abrir({ api: apiFalsa({ itens }), comNavegacao: true, hash: '#/prospeccao/leads-reprovados' });
  await clicar(outra, botao(outra, 'Reprovados'));
  assert.equal(outra.view.state.filtro, 'REPROVADOS');
  assert.equal(outra.browser.by.button(outra.browser.root, 'Lead 02'), null, 'não está nesta categoria');
  outra.browser.window.location.hash = `#/prospeccao/leads-reprovados/${encodeURIComponent('rej-02')}`;
  await outra.browser.flush(10);
  assert.ok(gaveta(outra), 'o lead de outra categoria foi localizado');
  assert.equal(outra.view.state.filtro, 'TODOS');

  const inexistente = await abrir({ api: apiFalsa({ itens }), comNavegacao: true, hash: `#/prospeccao/leads-reprovados/${encodeURIComponent('rej-99')}` });
  assert.equal(gaveta(inexistente), null);
  assert.ok(avisos(inexistente).some((texto) => /não foi encontrado em Leads Reprovados/.test(texto)));
  assert.equal(inexistente.browser.window.location.hash, '#/prospeccao/leads-reprovados');
  assert.ok(botao(inexistente, 'Lead 01'), 'a lista segue disponível');
});

test('[REJ-UX-10] A GAVETA ABERTA durante a atualização: o conteúdo se atualiza sem fechar nem perder a aba; se o lead sai da lista (reconsiderado por outra pessoa), avisa e fecha', async () => {
  const api = apiFalsa({ itens: [rej(1), rej(2)] });
  const s = await abrir({ api });
  await abrirLead(s, 'Lead 01');
  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-tab') === 'fontes'));
  const aba = () => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true').getAttribute('data-tab');
  assert.equal(aba(), 'fontes');
  api.mem.itens = [rej(1, { motivo: 'Motivo atualizado' }), rej(2)];
  await s.view.refresh();
  await s.browser.flush(6);
  assert.ok(gaveta(s));
  assert.equal(aba(), 'fontes', 'a aba escolhida foi mantida');
  assert.match(gaveta(s).textContent, /Motivo atualizado/);

  api.mem.itens = [rej(2)];
  await s.view.refresh();
  await s.browser.flush(6);
  assert.equal(gaveta(s), null);
  assert.ok(avisos(s).some((texto) => /não está mais nesta lista/.test(texto)));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// RECONSIDERAR
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[REJ-UX-11] RECONSIDERAR: abrir a confirmação não envia nada; ela mostra o MOTIVO ORIGINAL e o que a ação NÃO faz; clique triplo envia UMA vez; sucesso só depois do servidor; lista, contador e aviso atualizam sem F5 e o Approval Queue é avisado — sem aprovar nem promover', async () => {
  const s = await abrir({ api: apiFalsa({ itens: [rej(1), rej(2), rej(3)] }) });
  assert.match(s.browser.root.textContent, /3 leads/);
  await abrirLead(s, 'Lead 01');
  const reconsiderar = s.browser.by.id(s.browser.root, 'btn-reapprove');
  assert.equal(reconsiderar.textContent, 'Reconsiderar lead');
  assert.match(gaveta(s).textContent, /Não pesquisa de novo, não aprova e não cria registro no CRM/);
  await clicar(s, reconsiderar);
  assert.equal(conta(s, 'reaprovar'), 0, 'abrir a confirmação não reconsidera nada');
  const c = confirmacao(s);
  assert.match(c.textContent, /Reconsiderar lead.*Lead: Lead 01.*Motivo original da rejeição: Sem fit com o serviço.*não cria registro no CRM/s);
  assert.equal(s.browser.document.activeElement.id, 'reapprove-reason', 'o foco vai ao campo da justificativa');
  s.browser.type(s.browser.by.label(s.browser.root, 'Justificativa (opcional)'), 'Cliente pediu');
  const confirmar = s.browser.by.button(c, 'Reconsiderar');
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  await s.browser.flush(10);
  assert.deepEqual(s.api.chamadas.filter(([n]) => n === 'reaprovar'), [['reaprovar', 'rej-01', 'Cliente pediu']], 'uma única reconsideração');
  assert.equal(confirmacao(s), null);
  assert.equal(gaveta(s), null, 'a gaveta fechou: o lead saiu desta lista');
  assert.deepEqual(avisos(s), ['Lead 01 voltou para a Approval Queue (aguardando revisão). Nada foi enviado ao CRM.']);
  assert.equal(botao(s, 'Lead 01') === null || s.browser.by.button(s.browser.root, 'Lead 01') === null, true, 'a lista foi atualizada sem F5');
  assert.match(s.browser.root.textContent, /2 leads/, 'o contador também');
  assert.equal(conta(s, 'lista'), 2, 'uma requisição de atualização');
  assert.deepEqual(s.eventos, [['reconsider', 'rej-01']], 'a Approval Queue é avisada');
  assert.equal(conta(s, 'completar'), 0, 'nenhuma pesquisa começou');
});

test('[REJ-UX-12] a JUSTIFICATIVA é OPCIONAL (regra do serviço): vazia envia sem motivo; ESC com texto digitado PERGUNTA antes de descartar e "Continuar editando" mantém o texto', async () => {
  const s = await abrir({ api: apiFalsa({ itens: [rej(1)] }) });
  await abrirLead(s, 'Lead 01');
  await clicar(s, s.browser.by.id(s.browser.root, 'btn-reapprove'));
  s.browser.type(s.browser.by.label(s.browser.root, 'Justificativa (opcional)'), 'rascunho da justificativa');
  s.browser.press('Escape');
  assert.ok(confirmacao(s), 'não fechou: perguntou antes');
  assert.ok(s.browser.find(s.browser.root, (el) => el.localName === 'button' && el.textContent === 'Descartar'));
  await clicar(s, s.browser.find(s.browser.root, (el) => el.localName === 'button' && el.textContent === 'Continuar editando'));
  assert.equal(s.browser.by.label(s.browser.root, 'Justificativa (opcional)').value, 'rascunho da justificativa');
  s.browser.type(s.browser.by.label(s.browser.root, 'Justificativa (opcional)'), '');
  await clicar(s, s.browser.by.button(confirmacao(s), 'Reconsiderar'));
  assert.deepEqual(s.api.chamadas.filter(([n]) => n === 'reaprovar'), [['reaprovar', 'rej-01', undefined]], 'sem justificativa: nenhum motivo é enviado');
  assert.equal(conta(s, 'lista'), 2);
});

test('[REJ-UX-13] ERROS: falha do servidor mantém a confirmação aberta e o TEXTO digitado (sem sucesso antes da hora) e permite tentar de novo; barreira 409 (já está no CRM) mostra a mensagem do servidor e atualiza a lista; 404 fecha tudo', async () => {
  let modo = 'falha';
  const reaprovar = (id, motivo, mem) => {
    if (modo === 'falha') throw Object.assign(new Error('x'), { status: 500 });
    if (modo === 'barreira') throw Object.assign(new Error('x'), { status: 409, code: 'RECON_JA_NO_CRM', serverMessage: 'Reaprovação bloqueada: o lead já existe no CRM.' });
    if (modo === 'sumiu') throw Object.assign(new Error('x'), { status: 404, serverMessage: 'Lead não encontrado.' });
    mem.itens = mem.itens.filter((item) => item.prospectId !== id);
    return { item: {} };
  };
  const s = await abrir({ api: apiFalsa({ itens: [rej(1), rej(2)], reaprovar }) });
  await abrirLead(s, 'Lead 01');
  await clicar(s, s.browser.by.id(s.browser.root, 'btn-reapprove'));
  s.browser.type(s.browser.by.label(s.browser.root, 'Justificativa (opcional)'), 'texto importante');
  await clicar(s, s.browser.by.button(confirmacao(s), 'Reconsiderar'));
  assert.equal(conta(s, 'reaprovar'), 1);
  assert.ok(confirmacao(s), 'o erro NÃO fecha a confirmação');
  assert.match(confirmacao(s).textContent, /Não foi possível concluir agora/);
  assert.equal(s.browser.by.label(s.browser.root, 'Justificativa (opcional)').value, 'texto importante', 'o texto digitado ficou');
  assert.equal(s.browser.by.button(confirmacao(s), 'Reconsiderar').disabled, false, 'dá para tentar de novo');
  assert.ok(gaveta(s));
  assert.equal(avisos(s).some((t) => /voltou para a Approval Queue/.test(t)), false, 'nenhum sucesso antes da confirmação do servidor');

  modo = 'barreira';
  await clicar(s, s.browser.by.button(confirmacao(s), 'Reconsiderar'));
  assert.match(confirmacao(s).textContent, /Reaprovação bloqueada: o lead já existe no CRM\./);
  assert.equal(s.browser.by.label(s.browser.root, 'Justificativa (opcional)').value, 'texto importante');
  assert.ok(botao(s, 'Lead 01'), 'o lead continua reprovado na lista');
  assert.equal(conta(s, 'lista'), 2, 'o 409 atualiza a lista');
  assert.equal(avisos(s).some((t) => /voltou para a Approval Queue/.test(t)), false);
  assert.deepEqual(s.eventos, [], 'a Approval Queue não foi avisada de nada');

  modo = 'sumiu';
  await clicar(s, s.browser.by.button(confirmacao(s), 'Reconsiderar'));
  assert.equal(confirmacao(s), null);
  assert.equal(gaveta(s), null);
  assert.ok(avisos(s).includes('Lead não encontrado.'));
  assert.equal(conta(s, 'lista'), 3);

  modo = 'ok';
  await abrirLead(s, 'Lead 02');
  await clicar(s, s.browser.by.id(s.browser.root, 'btn-reapprove'));
  await clicar(s, s.browser.by.button(confirmacao(s), 'Reconsiderar'));
  assert.ok(avisos(s).some((t) => /Lead 02 voltou para a Approval Queue/.test(t)));
});

test('[REJ-UX-14] COMPLETAR PESQUISA continua uma ação humana separada: só corre a consulta de estado (e só com a gaveta aberta), nada de pesquisa sozinha; fechar a gaveta PARA a consulta; reconsiderar nunca executa pesquisa', async () => {
  const api = apiFalsa({ itens: [rej(1)] });
  api.getLeadResearchStatus = async (id) => {
    api.chamadas.push(['pesquisa', id]);
    return { item: { status: 'EM_ANDAMENTO', etapa: 'PESQUISANDO', elapsedMs: 3000, camposSolicitados: ['emails'], podeCompletar: false, disponivel: true } };
  };
  const s = await abrir({ api });
  assert.equal(conta(s, 'pesquisa'), 0, 'listar não consulta pesquisa alguma');
  await abrirLead(s, 'Lead 01');
  assert.equal(conta(s, 'pesquisa'), 1);
  assert.equal(s.ag.pendentes().length, 1, 'rodando: há uma consulta agendada');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(s.ag.pendentes().length, 0, 'gaveta fechada: a consulta parou');
  await abrirLead(s, 'Lead 01');
  assert.equal(conta(s, 'pesquisa'), 2, 'reabrir retoma, uma consulta');
  assert.equal(conta(s, 'completar'), 0);
  assert.equal(conta(s, 'reaprovar'), 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// NO PAINEL INTEIRO
// ---------------------------------------------------------------------------------------------------------------------------------------------

const me = (role, name) => ({ userId: `user-${name.toLowerCase()}`, name, role, permissions: [...authConstants.getRolePermissions(role)], status: 'ACTIVE' });

async function painel({ hash = '#/prospeccao/leads-reprovados', role = 'ADMIN', permissoes = null } = {}) {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await loadRouter();
  const { createFakeSdk, scriptedFetch, FAKE_SESSION } = await loadFixtures();
  const browser = createBrowser({ hash });
  const mem = { reprovados: [rej(1), rej(2), rej(3)], pendentes: [{ prospectId: 'pid-77', empresa: 'Já Pendente', estado: 'AGUARDANDO_REVISAO', discoverySnapshot: { empresa: 'Já Pendente' }, historico: [] }] };
  const fetchImpl = scriptedFetch({
    'GET /config.json': { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' },
    'GET /api/me': permissoes ? { ...me(role, 'Breno'), permissions: permissoes } : me(role, 'Breno'),
    'GET /api/crm': { items: [] },
    'GET /api/leads/reprovados': () => ({ items: [...mem.reprovados] }),
    'POST /api/leads/reprovados/rej-01/reaprovar': () => {
      const lead = mem.reprovados.find((item) => item.prospectId === 'rej-01');
      mem.reprovados = mem.reprovados.filter((item) => item.prospectId !== 'rej-01');
      mem.pendentes = [...mem.pendentes, { prospectId: 'rej-01', empresa: lead.empresa, estado: 'AGUARDANDO_REVISAO', discoverySnapshot: lead.dadosComerciais, historico: [] }];
      return { item: { prospectId: 'rej-01', estado: 'AGUARDANDO_REVISAO' } };
    },
    'GET /api/approvals': () => ({ estado: 'AGUARDANDO_REVISAO', items: [...mem.pendentes] }),
    'GET /api/leads/rej-01/perfil': { item: perfilApresentado({ status: 'PENDENTE_DE_CONFIRMACAO', nome: 'Pessoa Teste', cargo: 'Sócio' }) },
    'GET /api/leads/rej-01/completar-pesquisa': { item: { status: 'NAO_EXECUTADO', camposPendentes: [], podeCompletar: false, disponivel: true } },
  });
  const navigation = browserNavigation(browser.window);
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk: createFakeSdk({ session: FAKE_SESSION }), navigation });
  await browser.flush(10);
  return { browser, fetchImpl, mem };
}
const linkMenu = (t, nome) => t.browser.by.link(t.browser.root, nome);
const chamadasDe = (t, metodo, prefixo) => t.fetchImpl.calls.filter((c) => c.method === metodo && c.path.startsWith(prefixo)).length;

test('[REJ-UX-15] NO PAINEL: o módulo é persistente (busca e filtro sobrevivem a trocar de módulo), a gaveta tem URL, e RECONSIDERAR atualiza a lista E o contador da Approval Queue no menu sem F5 — uma leitura da fila, nenhuma pesquisa', async () => {
  const t = await painel();
  assert.equal(linkMenu(t, 'Approval Queue').getAttribute('data-count'), null, 'a fila ainda não foi carregada: nenhum contador inventado');
  const campo = t.browser.by.label(t.browser.root, 'Buscar lead');
  t.browser.type(campo, 'lead 0');
  t.browser.click(t.browser.by.button(t.browser.root, 'Lead 01'));
  await t.browser.flush(10);
  assert.equal(t.browser.window.location.hash, `#/prospeccao/leads-reprovados/${encodeURIComponent('rej-01')}`);
  const d = t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className));
  assert.ok(d);
  assert.equal(t.browser.find(t.browser.root, (el) => el.className === 'shell').hasAttribute('inert'), true, 'o menu e o conteúdo ficam inert');

  t.browser.click(t.browser.by.id(d, 'btn-reapprove'));
  await t.browser.flush(6);
  t.browser.click(t.browser.by.button(t.browser.root, 'Reconsiderar'));
  await t.browser.flush(14);
  assert.equal(t.browser.window.location.hash, '#/prospeccao/leads-reprovados', 'o endereço voltou à lista');
  assert.equal(t.browser.by.button(t.browser.root, 'Lead 01'), null, 'a lista foi atualizada sem F5');
  assert.equal(linkMenu(t, 'Approval Queue').getAttribute('data-count'), '2', 'o contador da fila acompanha (1 pendente + o lead reconsiderado)');
  assert.equal(linkMenu(t, 'Approval Queue').textContent, 'Approval Queue', 'o texto do link não muda');
  assert.equal(chamadasDe(t, 'POST', '/api/leads/reprovados/rej-01/reaprovar'), 1);
  assert.equal(chamadasDe(t, 'POST', '/api/approvals'), 0, 'nada foi aprovado');
  assert.equal(t.fetchImpl.calls.some((c) => c.path.includes('completar-pesquisa') && c.method === 'POST'), false, 'nenhuma pesquisa');

  // sair e voltar: a busca e a lista persistem; a fila mostra o lead devolvido
  t.browser.click(linkMenu(t, 'Approval Queue'));
  await t.browser.flush(10);
  assert.ok(t.browser.by.button(t.browser.root, 'Lead 01'), 'o lead reconsiderado está na Approval Queue');
  t.browser.click(linkMenu(t, 'Leads Reprovados'));
  await t.browser.flush(10);
  assert.equal(t.browser.by.label(t.browser.root, 'Buscar lead').value, 'lead 0', 'a busca sobreviveu a trocar de módulo');
});

test('[REJ-UX-16] NO PAINEL: sair do módulo com a gaveta aberta (endereço por fora) fecha a camada e nunca deixa o app inert nem o ouvinte de teclado ligado', async () => {
  const t = await painel();
  t.browser.click(t.browser.by.button(t.browser.root, 'Lead 02'));
  await t.browser.flush(10);
  assert.ok(t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog'));
  t.browser.window.location.hash = '#/agentes';
  await t.browser.flush(10);
  assert.equal(t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog'), null);
  assert.equal(t.browser.find(t.browser.root, (el) => el.className === 'shell').hasAttribute('inert'), false);
  assert.equal(t.browser.document.listenerCount('keydown'), 0);
  assert.equal(t.browser.window.location.hash, '#/agentes');
});

test('[REJ-UX-17] NO PAINEL: link direto para um lead reprovado abre a gaveta; sem a permissão de revisão o módulo continua sem acesso (e nada é pedido ao servidor)', async () => {
  const direto = await painel({ hash: `#/prospeccao/leads-reprovados/${encodeURIComponent('rej-02')}` });
  const d = direto.browser.find(direto.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className));
  assert.ok(d, 'o link direto abriu a gaveta');
  assert.equal(direto.browser.find(d, (el) => el.localName === 'h2').textContent, 'Lead 02');

  const semAcesso = await painel({ permissoes: ['READ:CRM'], hash: `#/prospeccao/leads-reprovados/${encodeURIComponent('rej-02')}` });
  assert.equal(semAcesso.browser.by.link(semAcesso.browser.root, 'Leads Reprovados'), null, 'o item some do menu');
  assert.match(semAcesso.browser.root.textContent, /Esta conta não possui acesso a esta área\./);
  assert.equal(semAcesso.fetchImpl.calls.some((c) => c.path.startsWith('/api/leads/reprovados')), false, 'nada é pedido ao servidor');
  assert.equal(semAcesso.browser.find(semAcesso.browser.root, (el) => el.getAttribute('role') === 'dialog'), null);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// ESTILO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[REJ-UX-18] o CSS reutiliza o padrão (linha clicável, gaveta, cartão de decisão) e no celular a lista vira cartões com o rótulo de cada campo; o motivo longo é limitado a duas linhas SEM quebrar a tabela', async () => {
  assert.match(css, /table\.list\.queue tr\.queue-row \{ cursor: pointer; \}/);
  assert.match(css, /\.decision-card \{[^}]*border-left-width: 4px/);
  assert.match(css, /\.decision-card\.decision-bad \{[^}]*border-left-color: var\(--danger\)/);
  const motivo = css.slice(css.indexOf('table.list.queue .reason-text {'), css.indexOf('}', css.indexOf('table.list.queue .reason-text {')));
  assert.match(motivo, /-webkit-line-clamp: 2/);
  assert.match(motivo, /overflow-wrap: anywhere/);
  assert.doesNotMatch(css, /\.reason-cell/, 'o clamp fica num elemento interno, nunca no td (display:-webkit-box quebra a tabela)');
  const celular = css.slice(css.indexOf('@media (max-width: 760px) {\n  .overlay-dialog.drawer'));
  assert.match(celular, /table\.queue td::before \{[^}]*content: attr\(data-label\)/);
  assert.match(celular, /\.overlay-dialog\.drawer \{ width: 100%;/);

  // cada célula da lista tem o rótulo para o modo celular
  const s = await abrir({ api: apiFalsa({ itens: [rej(1)] }) });
  const rotulos = s.browser.findAll(linha(s, 'Lead 01'), (el) => el.localName === 'td').map((el) => el.getAttribute('data-label'));
  assert.deepEqual(rotulos, ['Empresa', 'Situação', 'Motivo', 'Data', 'Decidido por']);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// UX 4.0.3 — FASE 1: barra de ferramentas em duas linhas e estado vazio que orienta
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[REJ-UX-19] a BARRA de ferramentas tem duas linhas: categorias em cima; busca, ordem e contador embaixo (o contador não fica espremido entre os campos); o CSS empilha, alinha o contador à direita e no celular usa a largura toda', async () => {
  const s = await abrir({ api: apiFalsa({ itens: [rej(1), rej(2)] }) });
  const barra = s.browser.find(s.browser.root, (el) => /\btoolbar-stacked\b/.test(el.className));
  const linhas = barra.childNodes.filter((n) => n.nodeType === 1);
  assert.equal(linhas.length, 2);
  assert.match(linhas[0].className, /toolbar-filters/);
  assert.match(linhas[1].className, /toolbar-tools/);
  const categorias = s.browser.findAll(linhas[0], (el) => el.localName === 'button').map((el) => el.textContent);
  assert.deepEqual(categorias, ['Todos', 'Reprovados', 'Dados insuficientes', 'Duplicados', 'DNC', 'Expirados']);
  assert.ok(s.browser.by.label(linhas[1], 'Buscar lead'), 'a busca fica na segunda linha');
  assert.ok(s.browser.by.label(linhas[1], 'Ordenar por'), 'a ordem também');
  const contador = s.browser.find(linhas[1], (el) => /\btoolbar-count\b/.test(el.className));
  assert.ok(contador && contador.textContent === '2 leads', 'o contador fica na segunda linha, depois dos campos');
  assert.equal(s.browser.find(linhas[0], (el) => /\btoolbar-count\b/.test(el.className)), null, 'e nunca junto das categorias');
  assert.ok(css.includes('.toolbar.toolbar-stacked { display: grid;'));
  assert.ok(css.includes('.toolbar-count { margin: 0; margin-left: auto;'));
  assert.ok(css.includes('white-space: nowrap'), 'o contador não quebra');
  assert.ok(css.includes('.toolbar-tools .search-field { flex: 1 1 280px; }'));
  const celular = css.slice(css.indexOf('@media (max-width: 760px) {'));
  assert.ok(celular.includes('.toolbar-count { margin-left: 0; flex: 1 0 100%;'));
  assert.ok(celular.includes('.toolbar-tools .search-field, .toolbar-tools .select-field { flex: 1 1 100%; }'));
});

test('[REJ-UX-20] o ESTADO VAZIO explica que a área reúne leads que passaram pela Approval Queue e saíram dela, e ORIENTA para o Histórico de prospecções quem procura candidatos descartados — sem misturar as duas populações nem chamar nenhum endpoint novo', async () => {
  const s = await abrir({ api: apiFalsa({ itens: [] }) });
  const vazio = s.browser.by.id(s.browser.root, 'rejected-empty');
  assert.ok(vazio);
  const texto = vazio.textContent;
  assert.ok(texto.includes('Nenhum lead nesta categoria.'));
  assert.ok(texto.includes('passaram pela Approval Queue e saíram dela'));
  assert.ok(texto.includes('reprovados por uma pessoa, expirados ou bloqueados'));
  assert.ok(texto.includes('Candidatos que a prospecção descartou ANTES de chegar à fila'));
  assert.ok(texto.includes('ficam no Histórico de prospecções, não aqui'));
  const atalho = s.browser.by.id(s.browser.root, 'rejected-empty-history');
  assert.equal(atalho.href, '#/prospeccao/historico');
  assert.equal(atalho.textContent, 'Ver o Histórico de prospecções');
  assert.ok(s.browser.root.textContent.includes('Candidatos descartados durante a prospecção ficam no Histórico de prospecções.'), 'o subtítulo da página também orienta');
  assert.deepEqual(s.api.chamadas.map(([n]) => n), ['lista'], 'nenhuma chamada nova: só a lista de sempre');

  // com leads na lista o estado vazio some; em outra categoria vazia ele reaparece
  const cheio = await abrir({ api: apiFalsa({ itens: [rej(1)] }) });
  assert.equal(cheio.browser.by.id(cheio.browser.root, 'rejected-empty'), null);
  await clicar(cheio, botao(cheio, 'Duplicados'));
  assert.ok(cheio.browser.by.id(cheio.browser.root, 'rejected-empty'), 'categoria vazia: a mesma orientação');
  assert.deepEqual(cheio.api.chamadas.map(([n, f]) => [n, f]), [['lista', 'TODOS'], ['lista', 'DUPLICADOS']]);
});
