// Approval Queue na UX 4.0 (primeira tela de referência): gaveta do lead, busca/ordem/paginação, decisões por confirmação humana, URL do lead
// (link direto, Voltar/Avançar), atualização sem F5 (lista, contadores, menu), erros que preservam o digitado, cliques duplos, processos em segundo
// plano e o módulo persistente na sessão. DOM de teste e API falsa — nenhum navegador, nenhuma rede, nenhum Claude.

const test = require('node:test');
const assert = require('node:assert/strict');

const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');

const loadView = () => import('../../dashboard/views/approvals.mjs');
const loadRouter = () => import('../../dashboard/router.mjs');
const loadUi = () => import('../../dashboard/ui/index.mjs');
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');

// ---------------------------------------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------------------------------------
const lead = (i, extras = {}) => ({
  prospectId: `pid-${String(i).padStart(2, '0')}`,
  empresa: `Empresa ${String(i).padStart(2, '0')}`,
  estado: 'AGUARDANDO_REVISAO',
  discoverySnapshot: { empresa: `Empresa ${String(i).padStart(2, '0')}`, cidade: i % 2 === 0 ? 'Petrópolis' : 'Niterói', estadoUf: 'RJ', nicho: i % 3 === 0 ? 'Psicologia' : 'Estética', dataDaPesquisa: `2026-10-${String(10 + (i % 9)).padStart(2, '0')}`, telefone: '(24) 2222-3333', site: 'https://exemplo-alfa.com.br', fontes: [{ url: 'https://exemplo-alfa.com.br/', tipoFonte: 'OFICIAL' }] },
  historico: [{ timestamp: '2026-10-10T12:00:00.000Z', from: null, to: 'AGUARDANDO_REVISAO', actor: 'SYSTEM', motivo: 'Novo prospect descoberto' }],
  ...extras,
});
const PERFIL = {
  prospectId: 'pid-01',
  empresa: 'Empresa 01',
  responsavel: { status: 'PENDENTE_DE_CONFIRMACAO', nome: 'Pessoa Teste Alfa', cargo: 'Sócio', origem: 'https://agregador-exemplo.com.br/x', confianca: 'BAIXA' },
  siteOficial: { status: 'ENCONTRADO', url: 'https://exemplo-alfa.com.br/' },
  telefones: [],
  emails: [],
  presencaDigital: {},
  trafegoPago: {},
  atividadeRecente: {},
  fontesDescoberta: [],
  fontesValidacao: [],
  fontesEnriquecimento: [],
  outrasPresencas: [],
};

const agenda = () => {
  const tarefas = [];
  return {
    tarefas,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelada: false, feita: false };
      tarefas.push(t);
      return () => { t.cancelada = true; };
    },
    pendentes: () => tarefas.filter((t) => !t.cancelada && !t.feita),
    async rodarUltima() {
      const t = this.pendentes().at(-1);
      if (!t) return false;
      t.feita = true;
      await t.fn();
      return true;
    },
  };
};

// API falsa com listas MUTÁVEIS (o servidor "muda" entre uma chamada e outra) e o registro de tudo o que foi pedido.
function apiFalsa({ pendentes = [], aprovados = [], perfil = PERFIL, aprovar, rejeitar, promover, pesquisa } = {}) {
  const chamadas = [];
  const mem = { pendentes: [...pendentes], aprovados: [...aprovados] };
  const api = {
    chamadas,
    mem,
    listApprovals: async (estado) => {
      chamadas.push(['list', estado || 'PENDENTES']);
      if (mem.falharLista) throw Object.assign(new Error('x'), { status: 500 });
      return { items: estado === 'APROVADO_PARA_CRM' ? [...mem.aprovados] : [...mem.pendentes] };
    },
    approve: async (id, motivo) => {
      chamadas.push(['approve', id, motivo]);
      if (aprovar) return aprovar(id, motivo, mem);
      mem.pendentes = mem.pendentes.filter((item) => item.prospectId !== id);
      return {};
    },
    reject: async (id, motivo) => {
      chamadas.push(['reject', id, motivo]);
      if (rejeitar) return rejeitar(id, motivo, mem);
      mem.pendentes = mem.pendentes.filter((item) => item.prospectId !== id);
      return {};
    },
    promoteApproval: async (id) => {
      chamadas.push(['promote', id]);
      return promover ? promover(id, mem) : { outcome: 'CRIADO', prospectId: id, crmRecordId: 'crm:11111111-1111-1111-1111-111111111111', possivelDuplicidade: false };
    },
    getLeadProfile: async (id) => {
      chamadas.push(['perfil', id]);
      return { item: id === 'pid-01' ? perfil : null };
    },
    getLeadResearchStatus: async (id) => {
      chamadas.push(['pesquisa', id]);
      return { item: pesquisa ? pesquisa() : { status: 'NAO_EXECUTADO', camposPendentes: ['emails'], podeCompletar: true, disponivel: true } };
    },
    completeLeadResearch: async (id) => {
      chamadas.push(['completar', id]);
      return { item: { status: 'EM_ANDAMENTO', etapa: 'PESQUISANDO', elapsedMs: 0, camposSolicitados: ['emails'], podeCompletar: false } };
    },
  };
  return api;
}

async function abrir({ api, canReview = true, canPromote = true, canReadCrm = true, comNavegacao = false, hash = '', filtro = null } = {}) {
  const { createApprovalsView } = await loadView();
  const { createDataBus } = await loadUi();
  const { browserNavigation, parseRoute } = await loadRouter();
  const browser = createBrowser({ hash });
  const ag = agenda();
  const bus = createDataBus();
  const eventos = [];
  bus.subscribe('approvals:counts', (p) => eventos.push(['counts', p.pending]));
  bus.subscribe('approvals:changed', (p) => eventos.push(['changed', p.action, p.prospectId]));
  bus.subscribe('crm:changed', (p) => eventos.push(['crm', p.prospectId]));
  const navigation = comNavegacao ? browserNavigation(browser.window) : null;
  const view = createApprovalsView({ document: browser.document, root: browser.root, api, canReview, canPromote, canReadCrm, schedule: ag.schedule, bus, ...(navigation ? { navigation } : {}) });
  if (navigation) navigation.subscribe(() => view.show(parseRoute(navigation.current())));
  const s = { browser, view, api, ag, bus, eventos, navigation, parseRoute };
  if (comNavegacao) await view.show(parseRoute(navigation.current()));
  else await view.load();
  await browser.flush();
  if (filtro) {
    browser.click(browser.by.button(browser.root, filtro));
    await browser.flush();
  }
  return s;
}

const gaveta = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const confirmacao = (s) => s.browser.find(s.browser.root, (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className));
const linha = (s, nome) => s.browser.by.button(s.browser.root, nome);
const avisos = (s) => s.browser.findAll(s.browser.root, (el) => el.className === 'toast-message').map((el) => el.textContent);
const contagem = (s, nome, estado) => s.api.chamadas.filter(([n, e]) => n === nome && (estado === undefined || e === estado)).length;
const botaoDe = (raiz, texto) => require('../helpers/fakeDom').by.button(raiz, texto);
const clicar = async (s, el) => { s.browser.click(el); await s.browser.flush(6); };
const abrirLead = async (s, nome) => { await clicar(s, linha(s, nome)); return gaveta(s); };

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A LISTA e a GAVETA
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[APR-UX-1] clicar na empresa abre a GAVETA na própria tela (sem recarregar): cabeçalho com empresa/local/nicho/status, abas, resumo; ESC e X fecham e devolvem o foco à linha; o fundo fica inert', async () => {
  const s = await abrir({ api: apiFalsa({ pendentes: [lead(1), lead(2), lead(3)] }) });
  assert.equal(contagem(s, 'list'), 1);
  const botao = linha(s, 'Empresa 01');
  botao.focus();
  const d = await abrirLead(s, 'Empresa 01');
  assert.ok(d, 'a gaveta abriu');
  assert.equal(d.getAttribute('aria-modal'), 'true');
  assert.equal(contagem(s, 'list'), 1, 'abrir o lead NÃO recarrega a lista');
  assert.equal(s.browser.find(d, (el) => el.localName === 'h2').textContent, 'Empresa 01');
  assert.match(d.textContent, /Niterói\/RJ · Estética/, 'localidade e nicho no cabeçalho');
  assert.match(d.textContent, /Aguardando revisão/, 'status no cabeçalho');
  const abas = s.browser.findAll(d, (el) => el.getAttribute('role') === 'tab').map((el) => el.getAttribute('data-tab'));
  assert.deepEqual(abas, ['resumo', 'contatos', 'pesquisa', 'fontes', 'historico']);
  assert.match(d.textContent, /Pessoa Teste Alfa.*Pendente de confirmação/, 'responsável e nível de verificação no resumo');
  assert.equal(botao.parentNode.parentNode.parentNode.parentNode.hasAttribute('inert'), false, 'a lista fica no mesmo documento');
  assert.equal(s.browser.find(s.browser.root, (el) => el.className === 'approvals-view').hasAttribute('inert'), true, 'o fundo está inert');

  s.browser.press('Escape');
  assert.equal(gaveta(s), null, 'ESC fecha');
  const ativo = s.browser.document.activeElement;
  assert.equal(ativo === linha(s, 'Empresa 01'), true, 'o foco voltou à linha que abriu (ativo: ' + (ativo && ativo.localName) + ' ' + (ativo && ativo.textContent) + ')');
  assert.equal(s.browser.find(s.browser.root, (el) => el.className === 'approvals-view').hasAttribute('inert'), false);

  await abrirLead(s, 'Empresa 02');
  s.browser.click(s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  assert.equal(gaveta(s), null, 'o X fecha');
  assert.equal(contagem(s, 'list'), 1, 'nenhum recarregamento em todo o ciclo');

  // clique duplo na empresa: uma gaveta só
  s.browser.click(linha(s, 'Empresa 03'));
  s.browser.click(linha(s, 'Empresa 03'));
  await s.browser.flush(6);
  assert.equal(s.browser.findAll(s.browser.root, (el) => el.getAttribute('role') === 'dialog').length, 1);
});

test('[APR-UX-2] BUSCA, ORDEM e PAGINAÇÃO: o campo mantém o texto, a página e a ordem sobrevivem a abrir/fechar a gaveta e a atualizar a lista; estado vazio claro quando nada combina', async () => {
  const itens = Array.from({ length: 22 }, (_, i) => lead(i + 1));
  const s = await abrir({ api: apiFalsa({ pendentes: itens }) });
  assert.match(s.browser.by.tag(s.browser.root, 'tbody')[0].textContent, /Empresa 01/);
  assert.equal(s.browser.by.tag(s.browser.root, 'tr').length, 16, '15 linhas + cabeçalho');
  assert.match(s.browser.root.textContent, /Página 1 de 2 · 1–15 de 22/);

  await clicar(s, botaoDe(s.browser.root, 'Próxima'));
  assert.match(s.browser.root.textContent, /Página 2 de 2 · 16–22 de 22/);
  assert.equal(linha(s, 'Empresa 01'), null);
  const campo = s.browser.by.label(s.browser.root, 'Buscar lead');
  const ordem = s.browser.by.label(s.browser.root, 'Ordenar por');
  s.browser.choose(ordem, 'empresa-desc');
  assert.match(s.browser.root.textContent, /Página 1 de 2/, 'mudar a ordem volta à página 1');
  await clicar(s, botaoDe(s.browser.root, 'Próxima'));
  assert.ok(linha(s, 'Empresa 01'), 'na ordem Z–A a última página tem a Empresa 01');

  await abrirLead(s, 'Empresa 01');
  s.browser.press('Escape');
  await s.browser.flush();
  assert.match(s.browser.root.textContent, /Página 2 de 2/, 'a página sobreviveu à gaveta');
  assert.equal(ordem.value, 'empresa-desc');

  await clicar(s, botaoDe(s.browser.root, 'Atualizar'));
  assert.match(s.browser.root.textContent, /Página 2 de 2/, 'e à atualização da lista');
  assert.equal(contagem(s, 'list'), 2);

  s.browser.type(campo, 'niterói');
  assert.equal(s.browser.by.label(s.browser.root, 'Buscar lead'), campo, 'o campo de busca é o MESMO elemento (o foco e o texto ficam)');
  assert.match(s.browser.root.textContent, /22 pendentes · 11 na busca/, 'a busca ignora acento e caixa');
  assert.equal(s.browser.by.tag(s.browser.root, 'tr').length, 12);
  await clicar(s, botaoDe(s.browser.root, 'Atualizar'));
  assert.equal(campo.value, 'niterói', 'a busca sobrevive à atualização');
  assert.match(s.browser.root.textContent, /11 na busca/);

  s.browser.type(campo, 'nada disso existe');
  assert.match(s.browser.root.textContent, /Nenhum lead encontrado/);
  assert.equal(s.browser.by.tag(s.browser.root, 'table').length, 0);
  s.browser.type(campo, '');
  assert.equal(s.browser.by.tag(s.browser.root, 'tr').length, 16);
});

test('[APR-UX-3] sem permissão de revisão a gaveta abre só para LEITURA: nenhum botão de decisão, nenhuma consulta de perfil ou de pesquisa, e a mensagem honesta', async () => {
  const s = await abrir({ api: apiFalsa({ pendentes: [lead(1)] }), canReview: false });
  const d = await abrirLead(s, 'Empresa 01');
  assert.ok(d);
  assert.equal(botaoDe(d, 'Aprovar'), null);
  assert.equal(botaoDe(d, 'Rejeitar'), null);
  assert.match(d.textContent, /Sua conta não pode aprovar ou rejeitar prospects\./);
  assert.deepEqual(s.browser.findAll(d, (el) => el.getAttribute('role') === 'tab').map((el) => el.getAttribute('data-tab')), ['resumo', 'contatos', 'fontes', 'historico'], 'sem a aba da pesquisa comercial');
  assert.equal(contagem(s, 'perfil'), 0);
  assert.equal(contagem(s, 'pesquisa'), 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// DECISÕES humanas, ATUALIZAÇÃO sem F5, ERROS que preservam o digitado
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[APR-UX-4] APROVAR: nada acontece sem a confirmação; três cliques seguidos enviam UMA vez; só depois da resposta há sucesso (aviso + linha de status); a lista, o contador e o menu atualizam sozinhos e o foco volta à lista', async () => {
  const s = await abrir({ api: apiFalsa({ pendentes: [lead(1), lead(2), lead(3)] }) });
  assert.match(s.browser.root.textContent, /3 pendentes/);
  await abrirLead(s, 'Empresa 01');
  await clicar(s, botaoDe(gaveta(s), 'Aprovar'));
  assert.equal(contagem(s, 'approve'), 0, 'abrir a confirmação não aprova nada');
  const c = confirmacao(s);
  assert.match(c.textContent, /Confirmar aprovação.*Prospect: Empresa 01.*triagem interna/);
  assert.equal(s.browser.document.activeElement.id, 'reason-input');
  const motivo = s.browser.by.label(s.browser.root, 'Motivo (opcional)');
  s.browser.type(motivo, 'Perfil aderente');
  const confirmar = botaoDe(c, 'Confirmar aprovação');
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  await s.browser.flush(8);
  assert.deepEqual(s.api.chamadas.filter(([n]) => n === 'approve'), [['approve', 'pid-01', 'Perfil aderente']], 'uma única aprovação');
  assert.equal(confirmacao(s), null);
  assert.equal(gaveta(s), null, 'a gaveta fechou (o lead saiu da lista de pendentes)');
  assert.deepEqual(avisos(s), ['Prospect aprovado.']);
  assert.equal(s.browser.by.cls(s.browser.root, 'message')[0].textContent, 'Prospect aprovado.');
  assert.equal(linha(s, 'Empresa 01'), null, 'a lista foi atualizada sem F5');
  assert.match(s.browser.root.textContent, /2 pendentes/, 'o contador também');
  assert.equal(contagem(s, 'list'), 2, 'uma requisição de atualização (sem recarregar a página)');
  assert.deepEqual(s.eventos.filter(([tipo]) => tipo !== 'counts'), [['changed', 'approve', 'pid-01']]);
  assert.deepEqual(s.eventos.filter(([tipo]) => tipo === 'counts').map(([, n]) => n), [3, 2], 'o menu recebe os contadores novos');
});

test('[APR-UX-5] REJEITAR: motivo obrigatório (sem ele nada é enviado); erro do servidor mantém a confirmação aberta e o MOTIVO digitado; nova tentativa funciona; ESC com motivo digitado pergunta antes de descartar', async () => {
  let falhar = true;
  const s = await abrir({ api: apiFalsa({ pendentes: [lead(1), lead(2)], rejeitar: (id, motivo, mem) => { if (falhar) throw Object.assign(new Error('x'), { status: 500 }); mem.pendentes = mem.pendentes.filter((i) => i.prospectId !== id); return {}; } }) });
  await abrirLead(s, 'Empresa 01');
  await clicar(s, botaoDe(gaveta(s), 'Rejeitar'));
  await clicar(s, botaoDe(confirmacao(s), 'Confirmar rejeição'));
  assert.match(confirmacao(s).textContent, /Informe o motivo da rejeição\./);
  assert.equal(contagem(s, 'reject'), 0);

  s.browser.type(s.browser.by.label(s.browser.root, 'Motivo (obrigatório)'), 'Fora do perfil');
  await clicar(s, botaoDe(confirmacao(s), 'Confirmar rejeição'));
  assert.equal(contagem(s, 'reject'), 1);
  assert.ok(confirmacao(s), 'o erro NÃO fecha a confirmação');
  assert.match(confirmacao(s).textContent, /Não foi possível concluir a operação agora/);
  assert.equal(s.browser.by.label(s.browser.root, 'Motivo (obrigatório)').value, 'Fora do perfil', 'o motivo digitado foi preservado');
  assert.ok(gaveta(s), 'a gaveta continua aberta');
  assert.equal(avisos(s).includes('Prospect rejeitado.'), false, 'nenhum sucesso antes da confirmação do servidor');

  // ESC com texto digitado: pergunta
  s.browser.press('Escape');
  assert.ok(confirmacao(s), 'não fechou: perguntou antes de descartar');
  assert.ok(s.browser.find(s.browser.root, (el) => el.localName === 'button' && el.textContent === 'Descartar'));
  await clicar(s, s.browser.find(s.browser.root, (el) => el.localName === 'button' && el.textContent === 'Continuar editando'));
  assert.equal(s.browser.by.label(s.browser.root, 'Motivo (obrigatório)').value, 'Fora do perfil');

  falhar = false;
  await clicar(s, botaoDe(confirmacao(s), 'Confirmar rejeição'));
  assert.equal(contagem(s, 'reject'), 2);
  assert.equal(confirmacao(s), null);
  assert.equal(gaveta(s), null);
  assert.ok(avisos(s).includes('Prospect rejeitado.'));
  assert.match(s.browser.root.textContent, /1 pendente(?!s)/);
});

test('[APR-UX-6] 409/404 (o lead já foi decidido por outra pessoa): erro claro, a confirmação e a gaveta fecham e a lista é recarregada sem F5', async () => {
  const s = await abrir({ api: apiFalsa({ pendentes: [lead(1), lead(2)], aprovar: (id, motivo, mem) => { mem.pendentes = mem.pendentes.filter((i) => i.prospectId !== id); throw Object.assign(new Error('x'), { status: 409, code: 'ALREADY_DECIDED' }); } }) });
  await abrirLead(s, 'Empresa 01');
  await clicar(s, botaoDe(gaveta(s), 'Aprovar'));
  await clicar(s, botaoDe(confirmacao(s), 'Confirmar aprovação'));
  assert.equal(confirmacao(s), null);
  assert.equal(gaveta(s), null);
  assert.ok(avisos(s).includes('Este item já foi decidido. A lista foi atualizada.'));
  assert.equal(linha(s, 'Empresa 01'), null);
  assert.equal(contagem(s, 'list'), 2);
  assert.equal(avisos(s).includes('Prospect aprovado.'), false);
});

test('[APR-UX-7] PROMOVER (aprovados): confirmação humana, clique duplo envia UMA vez, sucesso só depois da resposta; a gaveta continua aberta e passa a mostrar "Ver no CRM"; o CRM é avisado; erro 409 mostra o motivo fixo do servidor', async () => {
  const aprovado = lead(7, { estado: 'APROVADO_PARA_CRM' });
  const s = await abrir({ api: apiFalsa({ aprovados: [aprovado] }), filtro: 'Aprovados' });
  await abrirLead(s, 'Empresa 07');
  assert.equal(botaoDe(gaveta(s), 'Aprovar'), null);
  await clicar(s, botaoDe(gaveta(s), 'Promover para CRM'));
  assert.equal(contagem(s, 'promote'), 0);
  assert.match(confirmacao(s).textContent, /Este prospect será incluído no CRM e poderá entrar no pipeline comercial\./);
  const promover = botaoDe(confirmacao(s), 'Promover');
  s.browser.click(promover);
  s.browser.click(promover);
  await s.browser.flush(8);
  assert.equal(contagem(s, 'promote'), 1, 'clique duplo = uma promoção');
  assert.equal(confirmacao(s), null);
  assert.ok(gaveta(s), 'a gaveta segue aberta para mostrar o resultado');
  const ver = s.browser.by.link(gaveta(s), 'Ver no CRM');
  assert.equal(ver.href, `#/crm/registro/${encodeURIComponent('crm:11111111-1111-1111-1111-111111111111')}`);
  assert.ok(avisos(s).includes('Prospect promovido para o CRM.'));
  assert.deepEqual(s.eventos.filter(([tipo]) => tipo !== 'counts').map(([tipo, a]) => [tipo, a]), [['changed', 'promote'], ['crm', 'pid-07']]);

  const bloqueado = await abrir({ api: apiFalsa({ aprovados: [aprovado], promover: () => { throw Object.assign(new Error('x'), { status: 409, code: 'PROMOTION_DUPLICATE', serverMessage: 'Este prospect parece já existir no CRM. A promoção foi bloqueada para não duplicar o registro.' }); } }), filtro: 'Aprovados' });
  await abrirLead(bloqueado, 'Empresa 07');
  await clicar(bloqueado, botaoDe(gaveta(bloqueado), 'Promover para CRM'));
  await clicar(bloqueado, botaoDe(confirmacao(bloqueado), 'Promover'));
  assert.ok(avisos(bloqueado).includes('Este prospect parece já existir no CRM. A promoção foi bloqueada para não duplicar o registro.'));
  assert.equal(confirmacao(bloqueado), null);
  assert.ok(gaveta(bloqueado));
  assert.equal(bloqueado.eventos.filter(([tipo]) => tipo === 'crm').length, 0, 'bloqueada: o CRM não foi avisado de nada');
});

test('[APR-UX-8] ERROS DE API: se a lista falha ao atualizar, as linhas que já estavam na tela ficam, o erro aparece (aviso + status) e "Atualizar" tenta de novo; o botão fica desabilitado enquanto carrega', async () => {
  const api = apiFalsa({ pendentes: [lead(1), lead(2)] });
  const s = await abrir({ api });
  api.mem.falharLista = true;
  await clicar(s, botaoDe(s.browser.root, 'Atualizar'));
  assert.ok(linha(s, 'Empresa 01'), 'as linhas anteriores continuam');
  assert.ok(avisos(s).includes('Não foi possível concluir a operação agora. Tente novamente em instantes.'));
  assert.match(s.browser.by.cls(s.browser.root, 'message')[0].textContent, /Não foi possível concluir/);
  api.mem.falharLista = false;
  api.mem.pendentes = [lead(1), lead(2), lead(3)];
  await clicar(s, botaoDe(s.browser.root, 'Atualizar'));
  assert.ok(linha(s, 'Empresa 03'));
  assert.match(s.browser.root.textContent, /3 pendentes/);
  assert.equal(s.browser.by.cls(s.browser.root, 'message').length, 0, 'a mensagem de erro some depois de um sucesso');
});

test('[APR-UX-9] GAVETA ABERTA durante a atualização: o conteúdo se atualiza sem fechar nem perder a aba; se o lead sai da lista (decidido por outra pessoa), avisa e fecha', async () => {
  const api = apiFalsa({ pendentes: [lead(1), lead(2)] });
  const s = await abrir({ api });
  await abrirLead(s, 'Empresa 01');
  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-tab') === 'fontes'));
  const aba = () => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true').getAttribute('data-tab');
  assert.equal(aba(), 'fontes');
  api.mem.pendentes = [lead(1, { empresa: 'Empresa 01 Atualizada' }), lead(2)];
  await s.view.refresh();
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'continua aberta');
  assert.equal(aba(), 'fontes', 'a aba escolhida foi mantida');

  api.mem.pendentes = [lead(2)];
  await s.view.refresh();
  await s.browser.flush(6);
  assert.equal(gaveta(s), null, 'o lead saiu da lista: a gaveta fecha');
  assert.ok(avisos(s).some((texto) => /não está mais nesta lista/.test(texto)));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// URL do lead: link direto, Voltar/Avançar
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[APR-UX-10] URL: abrir muda o endereço (#/aprovacoes/<id>); Voltar fecha a gaveta SEM sair do módulo, Avançar reabre; o X volta uma entrada do histórico (sem entradas repetidas)', async () => {
  const s = await abrir({ api: apiFalsa({ pendentes: [lead(1), lead(2)] }), comNavegacao: true, hash: '#/aprovacoes' });
  const win = s.browser.window;
  assert.equal(win.location.hash, '#/aprovacoes');
  await abrirLead(s, 'Empresa 02');
  assert.equal(win.location.hash, `#/aprovacoes/${encodeURIComponent('pid-02')}`);
  assert.ok(gaveta(s));
  assert.equal(win.history.length, 2);

  win.history.back();
  await s.browser.flush(6);
  assert.equal(win.location.hash, '#/aprovacoes', 'o Voltar fica no módulo');
  assert.equal(gaveta(s), null, 'e fecha a gaveta');
  assert.equal(contagem(s, 'list'), 1, 'sem recarregar');

  win.history.forward();
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'o Avançar reabre o mesmo lead');
  assert.equal(s.browser.find(gaveta(s), (el) => el.localName === 'h2').textContent, 'Empresa 02');

  s.browser.click(s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  await s.browser.flush(6);
  assert.equal(win.location.hash, '#/aprovacoes');
  assert.equal(gaveta(s), null);
  assert.equal(win.history.length, 2, 'fechar não cria entrada nova (volta uma)');
  win.history.back();
  await s.browser.flush(4);
  assert.equal(win.location.hash, '#/aprovacoes', 'não há entrada duplicada da lista');
});

test('[APR-UX-11] LINK DIRETO: abrir #/aprovacoes/<id> carrega a lista e abre o lead (inclusive um já aprovado, que está na outra lista); fechar troca a entrada (o Voltar não repete a gaveta); lead inexistente avisa e volta à lista', async () => {
  const api = apiFalsa({ pendentes: [lead(1)], aprovados: [lead(5, { estado: 'APROVADO_PARA_CRM' })] });
  const direto = await abrir({ api, comNavegacao: true, hash: `#/aprovacoes/${encodeURIComponent('pid-01')}` });
  assert.ok(gaveta(direto), 'o link direto abriu a gaveta');
  assert.equal(direto.browser.find(gaveta(direto), (el) => el.localName === 'h2').textContent, 'Empresa 01');
  direto.browser.press('Escape');
  await direto.browser.flush(6);
  assert.equal(direto.browser.window.location.hash, '#/aprovacoes', 'sem entrada anterior no app: a entrada é trocada, não empilhada');
  assert.equal(direto.browser.window.history.length, 1);

  const aprovado = await abrir({ api: apiFalsa({ pendentes: [lead(1)], aprovados: [lead(5, { estado: 'APROVADO_PARA_CRM' })] }), comNavegacao: true, hash: `#/aprovacoes/${encodeURIComponent('pid-05')}` });
  assert.ok(gaveta(aprovado), 'achou o lead na lista de aprovados');
  assert.equal(aprovado.view.state.filter, 'APROVADO_PARA_CRM');

  const inexistente = await abrir({ api: apiFalsa({ pendentes: [lead(1)] }), comNavegacao: true, hash: `#/aprovacoes/${encodeURIComponent('pid-99')}` });
  assert.equal(gaveta(inexistente), null);
  assert.ok(avisos(inexistente).some((texto) => /não foi encontrado na fila/.test(texto)));
  assert.equal(inexistente.browser.window.location.hash, '#/aprovacoes');
  assert.ok(linha(inexistente, 'Empresa 01'), 'a lista segue disponível');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Processos em segundo plano
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[APR-UX-12] PROCESSOS EM SEGUNDO PLANO: a consulta de estado da pesquisa só corre com a gaveta aberta e o processo rodando; fechar a gaveta PARA a consulta; reabrir retoma; ao terminar, o perfil é recarregado e a consulta termina — nada começa sozinho', async () => {
  let estado = { status: 'EM_ANDAMENTO', etapa: 'PESQUISANDO', elapsedMs: 3000, camposSolicitados: ['emails'], podeCompletar: false, disponivel: true };
  const s = await abrir({ api: apiFalsa({ pendentes: [lead(1)], pesquisa: () => estado }) });
  assert.equal(contagem(s, 'pesquisa'), 0, 'listar a fila não consulta pesquisa alguma');
  assert.equal(contagem(s, 'completar'), 0, 'nenhuma pesquisa é iniciada pela interface sozinha');
  await abrirLead(s, 'Empresa 01');
  assert.equal(contagem(s, 'pesquisa'), 1);
  assert.equal(s.ag.pendentes().length, 1, 'rodando: há uma consulta agendada');

  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(s.ag.pendentes().length, 0, 'gaveta fechada: a consulta parou (nada agendado)');

  await abrirLead(s, 'Empresa 01');
  assert.equal(contagem(s, 'pesquisa'), 2, 'reabrir consulta uma vez e retoma');
  assert.equal(s.ag.pendentes().length, 1);
  const perfisAntes = contagem(s, 'perfil');
  estado = { status: 'COMPLETO', camposPendentes: [], podeCompletar: false, disponivel: true, ultimaExecucao: { iniciadoEm: '2026-10-10T12:00:00.000Z', duracaoMs: 1000 } };
  await s.ag.rodarUltima();
  await s.browser.flush(8);
  assert.equal(s.ag.pendentes().length, 0, 'terminou: a consulta termina e nada mais é agendado');
  assert.equal(contagem(s, 'perfil'), perfisAntes + 1, 'o perfil foi recarregado ao terminar');
  assert.equal(contagem(s, 'completar'), 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// No painel inteiro: módulo persistente, menu, contadores, gaveta por URL
// ---------------------------------------------------------------------------------------------------------------------------------------------

const me = (role, name) => ({ userId: `user-${name.toLowerCase()}`, name, role, permissions: [...authConstants.getRolePermissions(role)], status: 'ACTIVE' });

async function painel({ hash = '#/aprovacoes', itens }) {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await loadRouter();
  const { createFakeSdk, scriptedFetch, FAKE_SESSION } = await loadFixtures();
  const browser = createBrowser({ hash });
  const lista = { pendentes: [...itens] };
  const fetchImpl = scriptedFetch({
    'GET /config.json': { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' },
    'GET /api/me': me('ADMIN', 'Breno'),
    'GET /api/crm': { items: [] },
    'GET /api/approvals': () => ({ estado: 'AGUARDANDO_REVISAO', items: [...lista.pendentes] }),
    'POST /api/approvals/pid-01/approve': () => { lista.pendentes = lista.pendentes.filter((i) => i.prospectId !== 'pid-01'); return {}; },
    'GET /api/leads/pid-01/perfil': { item: PERFIL },
    'GET /api/leads/pid-01/completar-pesquisa': { item: { status: 'NAO_EXECUTADO', camposPendentes: ['emails'], podeCompletar: true, disponivel: true } },
  });
  const navigation = browserNavigation(browser.window);
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk: createFakeSdk({ session: FAKE_SESSION }), navigation });
  await browser.flush(8);
  return { browser, fetchImpl, lista };
}
const chamadasLista = (t) => t.fetchImpl.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/approvals')).length;
const linkAprovacoes = (t) => t.browser.by.link(t.browser.root, 'Approval Queue');

test('[APR-UX-13] NO PAINEL: o menu mostra o contador de pendentes (sem mudar o texto do link) e o atualiza sozinho depois de aprovar; a gaveta abre por URL e, ao trocar de módulo, fecha sem deixar nada inert; busca e página sobrevivem a sair e voltar', async () => {
  const t = await painel({ itens: [lead(1), lead(2), lead(3)] });
  assert.equal(linkAprovacoes(t).textContent, 'Approval Queue', 'o texto do link não muda');
  assert.equal(linkAprovacoes(t).getAttribute('data-count'), '3');
  assert.equal(linkAprovacoes(t).getAttribute('aria-label'), 'Approval Queue, 3 pendentes');
  const campo = t.browser.by.label(t.browser.root, 'Buscar lead');
  t.browser.type(campo, 'empresa 0');

  t.browser.click(t.browser.by.button(t.browser.root, 'Empresa 01'));
  await t.browser.flush(8);
  assert.equal(t.browser.window.location.hash, `#/aprovacoes/${encodeURIComponent('pid-01')}`);
  const d = t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className));
  assert.ok(d);
  assert.ok(t.browser.find(t.browser.root, (el) => el.localName === 'aside').hasAttribute('inert') || t.browser.find(t.browser.root, (el) => el.className === 'shell').hasAttribute('inert'), 'o menu e o conteúdo ficam inert');

  // aprovar pela gaveta: o contador do menu cai de 3 para 2 sem recarregar a página
  t.browser.click(t.browser.by.button(d, 'Aprovar'));
  await t.browser.flush(6);
  t.browser.click(t.browser.by.button(t.browser.root, 'Confirmar aprovação'));
  await t.browser.flush(10);
  assert.equal(linkAprovacoes(t).getAttribute('data-count'), '2');
  assert.equal(linkAprovacoes(t).getAttribute('aria-label'), 'Approval Queue, 2 pendentes');
  assert.equal(t.browser.window.location.hash, '#/aprovacoes', 'o endereço voltou à lista');

  // sair para o CRM e voltar: a busca fica; a lista é atualizada em silêncio (uma requisição)
  const antes = chamadasLista(t);
  t.browser.click(t.browser.by.link(t.browser.root, 'CRM'));
  await t.browser.flush(8);
  assert.equal(t.browser.find(t.browser.root, (el) => el.className === 'shell').hasAttribute('inert'), false);
  t.browser.click(linkAprovacoes(t));
  await t.browser.flush(10);
  assert.equal(t.browser.by.label(t.browser.root, 'Buscar lead').value, 'empresa 0', 'a busca sobreviveu a trocar de módulo');
  assert.equal(chamadasLista(t), antes + 1, 'voltar ao módulo atualiza com uma requisição');
});

test('[APR-UX-14] NO PAINEL: sair do módulo com a gaveta aberta (Voltar do navegador para outra tela) fecha a camada e nunca deixa o app inert; uma conta sem acesso à fila continua sem o contador', async () => {
  const t = await painel({ itens: [lead(1), lead(2)] });
  t.browser.click(t.browser.by.button(t.browser.root, 'Empresa 02'));
  await t.browser.flush(8);
  assert.ok(t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog'));
  // navegação por fora do app (endereço digitado): o módulo sai de cena e as camadas fecham
  t.browser.window.location.hash = '#/agentes';
  await t.browser.flush(8);
  assert.equal(t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog'), null, 'nenhuma camada sobrou');
  assert.equal(t.browser.find(t.browser.root, (el) => el.className === 'shell').hasAttribute('inert'), false, 'o app não ficou travado');
  assert.equal(t.browser.document.listenerCount('keydown'), 0, 'o ouvinte de teclado foi removido');
  assert.equal(t.browser.window.location.hash, '#/agentes');
});
