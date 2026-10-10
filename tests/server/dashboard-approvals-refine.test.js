// Approval Queue — UX 4.0.1 (refinamento visual): linha inteira clicável (mouse e teclado), resumo do lead sem informação repetida e com hierarquia
// (identidade → situação comercial → responsável), nomes e cargos longos, estrutura da gaveta (cabeçalho e rodapé fixos, só o miolo rola) e as
// regras de CSS que sustentam isso em telas menores. DOM de teste e API falsa: nenhum navegador, nenhuma rede, nenhum Claude.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBrowser } = require('../helpers/fakeDom');

const loadView = () => import('../../dashboard/views/approvals.mjs');
const loadRouter = () => import('../../dashboard/router.mjs');

const NOME_LONGO = 'Clínica de Psicologia e Desenvolvimento Humano Integrado Dr. Fulano de Tal & Associados Ltda — Unidade Centro';
const RESPONSAVEL_LONGO = 'Dra. Maria Fernanda de Albuquerque Cavalcanti Nogueira de Sousa Lima';
const CARGO_LONGO = 'Sócia-fundadora e diretora clínica responsável técnica';

const lead = (i, extras = {}, snap = {}) => ({
  prospectId: `pid-${String(i).padStart(2, '0')}`,
  empresa: `Empresa ${String(i).padStart(2, '0')}`,
  estado: 'AGUARDANDO_REVISAO',
  discoverySnapshot: { empresa: `Empresa ${String(i).padStart(2, '0')}`, cidade: 'Niterói', estadoUf: 'RJ', nicho: 'Estética', tipoLead: 'EMPRESA', tipo: 'Clínica', dataDaPesquisa: '2026-10-12', hipoteseDeOportunidade: 'Sem tráfego pago.', observacoes: 'Fonte oficial.', telefone: '(24) 2222-3333', site: 'https://exemplo-alfa.com.br', fontes: [{ url: 'https://exemplo-alfa.com.br/', tipoFonte: 'OFICIAL' }], ...snap },
  historico: [{ timestamp: '2026-10-10T12:00:00.000Z', from: null, to: 'AGUARDANDO_REVISAO', actor: 'SYSTEM', motivo: 'Novo prospect descoberto' }],
  ...extras,
});

const perfil = (responsavel) => ({
  prospectId: 'pid-01',
  empresa: 'Empresa 01',
  responsavel,
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
});

function apiFalsa({ itens, responsavel }) {
  const chamadas = [];
  return {
    chamadas,
    listApprovals: async () => { chamadas.push('list'); return { items: [...itens] }; },
    approve: async () => ({}),
    reject: async () => ({}),
    getLeadProfile: async (id) => { chamadas.push(`perfil:${id}`); return { item: id === 'pid-01' ? perfil(responsavel) : null }; },
    getLeadResearchStatus: async () => ({ item: { status: 'NAO_EXECUTADO', camposPendentes: [], podeCompletar: false, disponivel: true } }),
    completeLeadResearch: async () => { throw new Error('nenhuma pesquisa deve começar sozinha'); },
  };
}

async function abrir({ itens, responsavel = { status: 'PENDENTE_DE_CONFIRMACAO', nome: RESPONSAVEL_LONGO, cargo: CARGO_LONGO }, canReview = true, comNavegacao = false, hash = '' } = {}) {
  const { createApprovalsView } = await loadView();
  const { browserNavigation, parseRoute } = await loadRouter();
  const browser = createBrowser({ hash });
  const api = apiFalsa({ itens, responsavel });
  const navigation = comNavegacao ? browserNavigation(browser.window) : null;
  const schedule = () => () => {};
  const view = createApprovalsView({ document: browser.document, root: browser.root, api, canReview, canPromote: true, canReadCrm: true, schedule, ...(navigation ? { navigation } : {}) });
  if (navigation) navigation.subscribe(() => view.show(parseRoute(navigation.current())));
  if (navigation) await view.show(parseRoute(navigation.current()));
  else await view.load();
  await browser.flush();
  return { browser, view, api, navigation };
}

const gaveta = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const linha = (s, nome) => s.browser.by.button(s.browser.root, nome).parentNode.parentNode.parentNode; // botão → company-cell → td → tr
const painelResumo = (s) => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tabpanel' && el.getAttribute('aria-labelledby') && /resumo/.test(el.getAttribute('aria-labelledby')));
const ocorrencias = (texto, trecho) => texto.split(trecho).length - 1;
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
const regra = (seletor) => {
  const inicio = css.indexOf(`${seletor} {`);
  assert.ok(inicio >= 0, `regra CSS ausente: ${seletor}`);
  return css.slice(inicio, css.indexOf('}', inicio));
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// LISTA: a linha inteira abre o lead
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[APR-REF-1] a LINHA INTEIRA abre o lead: clicar em qualquer célula funciona; o botão da empresa continua sendo o alvo do teclado (Enter e Espaço); o botão não parece link; a linha aberta fica marcada', async () => {
  const s = await abrir({ itens: [lead(1), lead(2), lead(3)] });
  const tr = linha(s, 'Empresa 02');
  assert.equal(tr.localName, 'tr');
  assert.match(tr.className, /\bqueue-row\b/);
  const celulaTipo = s.browser.find(tr, (el) => el.localName === 'td' && el.getAttribute('data-label') === 'Estado');
  s.browser.click(celulaTipo); // clique fora do botão
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'a linha inteira abre a gaveta');
  assert.equal(s.browser.find(gaveta(s), (el) => el.localName === 'h2').textContent, 'Empresa 02');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(gaveta(s), null);
  assert.match(linha(s, 'Empresa 02').className, /\bqueue-row\b/, 'continua sendo uma linha da fila');

  // teclado: o botão recebe o foco e Enter / Espaço abrem (uma única tabulação por linha: o botão)
  const botao = s.browser.by.button(s.browser.root, 'Empresa 03');
  botao.focus();
  assert.equal(s.browser.document.activeElement, botao);
  s.browser.press('Enter');
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'Enter abre');
  assert.equal(s.browser.find(gaveta(s), (el) => el.localName === 'h2').textContent, 'Empresa 03');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(s.browser.document.activeElement === s.browser.by.button(s.browser.root, 'Empresa 03'), true, 'o foco volta ao botão da linha');
  s.browser.press(' ');
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'Espaço abre');
  s.browser.press('Escape');
  await s.browser.flush(4);

  // só o botão da empresa entra na ordem de tabulação da linha (a linha em si não é focável)
  assert.equal(tr.getAttribute('tabindex'), null);
  assert.equal(s.browser.findAll(tr, (el) => el.localName === 'a').length, 0, 'nenhum link sublinhado na linha');
  assert.doesNotMatch(s.browser.by.button(s.browser.root, 'Empresa 01').className, /link-button/);
});

test('[APR-REF-2] cliques rápidos NÃO abrem várias vezes: uma gaveta, uma entrada no histórico, um único carregamento do perfil — mesmo misturando botão e célula', async () => {
  const s = await abrir({ itens: [lead(1), lead(2)], comNavegacao: true, hash: '#/aprovacoes' });
  const win = s.browser.window;
  const tr = linha(s, 'Empresa 01');
  const botao = s.browser.by.button(s.browser.root, 'Empresa 01');
  const celula = s.browser.find(tr, (el) => el.localName === 'td' && el.getAttribute('data-label') === 'Pesquisa');
  s.browser.click(botao);
  s.browser.click(celula);
  s.browser.click(botao);
  s.browser.click(tr);
  await s.browser.flush(8);
  assert.equal(s.browser.findAll(s.browser.root, (el) => el.getAttribute('role') === 'dialog').length, 1, 'uma gaveta só');
  assert.equal(win.history.length, 2, 'uma única entrada nova no histórico');
  assert.equal(win.location.hash, `#/aprovacoes/${encodeURIComponent('pid-01')}`);
  assert.equal(s.api.chamadas.filter((c) => c === 'perfil:pid-01').length, 1, 'o perfil é lido uma vez');

  // Voltar fecha a gaveta e fica no módulo; a linha segue clicável depois
  win.history.back();
  await s.browser.flush(6);
  assert.equal(gaveta(s), null);
  assert.equal(win.location.hash, '#/aprovacoes');
  s.browser.click(s.browser.find(linha(s, 'Empresa 01'), (el) => el.localName === 'td' && el.getAttribute('data-label') === 'Pesquisa'));
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'abre de novo depois do Voltar');
});

test('[APR-REF-3] a lista NÃO perde busca, ordem, página nem posição ao abrir pela linha inteira', async () => {
  const itens = Array.from({ length: 22 }, (_, i) => lead(i + 1));
  const s = await abrir({ itens });
  s.browser.click(s.browser.by.button(s.browser.root, 'Próxima'));
  await s.browser.flush();
  const pagina = s.browser.root.textContent.match(/Página \d+ de \d+/)[0];
  assert.equal(pagina, 'Página 2 de 2');
  s.browser.click(s.browser.find(linha(s, 'Empresa 16'), (el) => el.localName === 'td' && el.getAttribute('data-label') === 'Tipo'));
  await s.browser.flush(6);
  assert.ok(gaveta(s));
  assert.equal(s.browser.by.button(s.browser.root, 'Empresa 16').getAttribute('aria-current'), 'true', 'a linha aberta fica marcada');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(s.browser.root.textContent.match(/Página \d+ de \d+/)[0], pagina, 'a página ficou');
  assert.equal(s.api.chamadas.filter((c) => c === 'list').length, 1, 'sem recarregar a lista');

  const campo = s.browser.by.label(s.browser.root, 'Buscar lead');
  s.browser.type(campo, 'empresa 2');
  s.browser.click(s.browser.find(linha(s, 'Empresa 20'), (el) => el.localName === 'td' && el.getAttribute('data-label') === 'Dados'));
  await s.browser.flush(6);
  assert.equal(s.browser.find(gaveta(s), (el) => el.localName === 'h2').textContent, 'Empresa 20');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(campo.value, 'empresa 2', 'a busca ficou');
  assert.equal(s.browser.by.label(s.browser.root, 'Buscar lead'), campo, 'e o campo é o mesmo elemento');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// RESUMO: hierarquia e nenhuma informação repetida
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[APR-REF-4] o RESUMO segue a hierarquia (Identidade → Situação comercial → Responsável → Notas) e cada informação aparece UMA vez: sem cartões repetindo a lista de detalhes', async () => {
  const s = await abrir({ itens: [lead(1)] });
  s.browser.click(s.browser.by.button(s.browser.root, 'Empresa 01'));
  await s.browser.flush(8);
  const painel = painelResumo(s);
  assert.ok(painel, 'a aba Resumo existe');
  const titulos = s.browser.findAll(painel, (el) => el.localName === 'h3').map((el) => el.textContent);
  assert.deepEqual(titulos, ['Identidade', 'Situação comercial', 'Responsável', 'Notas da pesquisa']);

  assert.equal(s.browser.by.cls(painel, 'summary-card').length, 0, 'acabaram os cartões duplicados');
  assert.equal(s.browser.by.cls(painel, 'summary-grid').length, 0);
  assert.equal(s.browser.by.cls(painel, 'lead-badges').length, 0, 'e a fileira de selos repetidos');

  const texto = painel.textContent;
  for (const rotulo of ['Estado na fila', 'Verificação', 'Dados', 'Duplicidade', 'DNC', 'Tipo de lead', 'Pesquisado em', 'Hipótese de oportunidade', 'Observações']) {
    assert.equal(ocorrencias(texto, rotulo), 1, `"${rotulo}" aparece uma vez`);
  }
  assert.equal(ocorrencias(texto, 'Aguardando revisão'), 1, 'o estado aparece uma vez');
  assert.equal(ocorrencias(texto, 'Empresa'), 1, 'o tipo de lead aparece uma vez');
  // o local e o nicho ficam no CABEÇALHO da gaveta (uma vez), não repetidos no resumo
  assert.equal(ocorrencias(gaveta(s).textContent, 'Niterói/RJ · Estética'), 1);
  assert.equal(ocorrencias(texto, 'Niterói'), 0);
  assert.equal(s.browser.by.cls(painel, 'indicator').length, 5, 'só os cinco indicadores comerciais úteis');
  assert.equal(ocorrencias(texto, 'Sem tráfego pago.'), 1);
});

test('[APR-REF-5] tudo o que existia continua em algum lugar: telefone, site e endereço em Contatos; fontes e histórico nas suas abas; a pesquisa comercial na sua aba', async () => {
  const s = await abrir({ itens: [lead(1, {}, { endereco: 'Rua Exemplo, 100', email: 'contato@exemplo-alfa.com.br' })] });
  s.browser.click(s.browser.by.button(s.browser.root, 'Empresa 01'));
  await s.browser.flush(8);
  const painel = (chave) => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tabpanel' && new RegExp(chave).test(el.getAttribute('aria-labelledby') || ''));
  const contatos = painel('contatos').textContent;
  for (const trecho of ['(24) 2222-3333', 'exemplo-alfa.com.br', 'Rua Exemplo, 100', 'contato@exemplo-alfa.com.br']) assert.ok(contatos.includes(trecho), trecho);
  assert.match(painel('fontes').textContent, /exemplo-alfa\.com\.br/);
  assert.match(painel('historico').textContent, /Novo prospect descoberto/);
  assert.match(painel('pesquisa').textContent, /Análise comercial/);
});

test('[APR-REF-6] o RESPONSÁVEL tem espaço próprio: nome e cargo longos inteiros em elementos separados; PENDENTE_DE_CONFIRMACAO é destacado como aviso, nunca como validado, e explica o que falta', async () => {
  const s = await abrir({ itens: [lead(1, { empresa: NOME_LONGO }, { empresa: NOME_LONGO })] });
  s.browser.click(s.browser.by.button(s.browser.root, NOME_LONGO));
  await s.browser.flush(8);
  assert.equal(s.browser.find(gaveta(s), (el) => el.localName === 'h2').textContent, NOME_LONGO, 'o título mostra o nome longo inteiro');
  const cartao = s.browser.find(gaveta(s), (el) => /\bowner-card\b/.test(el.className));
  assert.ok(cartao);
  assert.match(cartao.className, /owner-warn/);
  assert.doesNotMatch(cartao.className, /owner-ok/);
  assert.equal(s.browser.find(cartao, (el) => el.className === 'owner-name').textContent, RESPONSAVEL_LONGO, 'nome inteiro, sem truncar');
  assert.equal(s.browser.find(cartao, (el) => el.className === 'owner-role').textContent, CARGO_LONGO, 'cargo inteiro, em linha própria');
  assert.match(cartao.textContent, /Pendente de confirmação/);
  assert.doesNotMatch(cartao.textContent, /Confirmado/);
  assert.match(cartao.textContent, /Ainda não validado/);
});

test('[APR-REF-7] responsável CONFIRMADO usa o selo "Confirmado" (sem aviso); sem responsável ou sem análise não afirma nada; quem não revisa não dispara a consulta do perfil', async () => {
  const confirmado = await abrir({ itens: [lead(1)], responsavel: { status: 'ENCONTRADO', nome: 'Ana Souza', cargo: 'Proprietária' } });
  confirmado.browser.click(confirmado.browser.by.button(confirmado.browser.root, 'Empresa 01'));
  await confirmado.browser.flush(8);
  const ok = confirmado.browser.find(gaveta(confirmado), (el) => /\bowner-card\b/.test(el.className));
  assert.match(ok.className, /owner-ok/);
  assert.match(ok.textContent, /Ana Souza.*Proprietária.*Confirmado/);
  assert.doesNotMatch(ok.textContent, /Ainda não validado/);

  const ausente = await abrir({ itens: [lead(1)], responsavel: { status: 'NAO_ENCONTRADO' } });
  ausente.browser.click(ausente.browser.by.button(ausente.browser.root, 'Empresa 01'));
  await ausente.browser.flush(8);
  const vazio = ausente.browser.find(gaveta(ausente), (el) => /\bowner-card\b/.test(el.className));
  assert.match(vazio.textContent, /Não encontrado.*Não verificado/);
  assert.doesNotMatch(vazio.className, /owner-ok|owner-warn/);

  const leitura = await abrir({ itens: [lead(1)], canReview: false });
  leitura.browser.click(leitura.browser.by.button(leitura.browser.root, 'Empresa 01'));
  await leitura.browser.flush(8);
  assert.equal(leitura.api.chamadas.some((c) => c.startsWith('perfil:')), false, 'sem permissão: nenhuma consulta de perfil');
  assert.match(leitura.browser.find(gaveta(leitura), (el) => /\bowner-card\b/.test(el.className)).textContent, /Disponível para quem revisa/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// GAVETA: estrutura e CSS (cabeçalho e rodapé fixos, só o miolo rola, telas menores)
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[APR-REF-8] a ESTRUTURA da gaveta: cabeçalho, miolo e rodapé são irmãos; as ações (Aprovar/Rejeitar) ficam no RODAPÉ fixo, nunca dentro do conteúdo que rola; o foco, o ESC e o X seguem funcionando', async () => {
  const s = await abrir({ itens: [lead(1)] });
  s.browser.click(s.browser.by.button(s.browser.root, 'Empresa 01'));
  await s.browser.flush(8);
  const d = gaveta(s);
  const filhos = d.childNodes.filter((n) => n.nodeType === 1).map((n) => n.className.split(' ')[0]);
  assert.deepEqual(filhos, ['overlay-head', 'overlay-body', 'overlay-footer']);
  const miolo = s.browser.find(d, (el) => /\boverlay-body\b/.test(el.className));
  const rodape = s.browser.find(d, (el) => /\boverlay-footer\b/.test(el.className));
  assert.ok(s.browser.by.button(rodape, 'Aprovar') && s.browser.by.button(rodape, 'Rejeitar'), 'as ações estão no rodapé');
  assert.equal(s.browser.by.button(miolo, 'Aprovar'), null, 'e não no miolo que rola');
  assert.equal(s.browser.by.button(miolo, 'Rejeitar'), null);
  assert.match(rodape.textContent, /não cria registro no CRM nem autoriza contato/, 'o aviso de triagem fica visível no rodapé');
  const x = s.browser.find(d, (el) => el.getAttribute('data-action') === 'close');
  assert.ok(x && s.browser.find(d, (el) => /\boverlay-head\b/.test(el.className)).contains(x), 'o X está no cabeçalho fixo');
  assert.equal(s.browser.document.activeElement === d || d.contains(s.browser.document.activeElement), true, 'o foco está dentro da gaveta');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(gaveta(s), null);
});

test('[APR-REF-9] CSS da gaveta: coluna flex com altura da tela, cabeçalho e rodapé que não encolhem, só o miolo com rolagem; largura limitada em telas menores; texto longo quebra', async () => {
  const dialogo = regra('.overlay-dialog');
  assert.match(dialogo, /display:\s*flex/);
  assert.match(dialogo, /flex-direction:\s*column/);
  const gavetaCss = regra('.overlay-dialog.drawer');
  assert.match(gavetaCss, /height:\s*100dvh/);
  assert.match(gavetaCss, /width:\s*min\(\d+px,\s*100%\)/, 'nunca mais larga que a tela');
  const fixos = regra('.overlay-dialog.drawer .overlay-head,\n.overlay-dialog.drawer .overlay-footer');
  assert.match(fixos, /flex:\s*none/);
  const miolo = regra('.overlay-body');
  assert.match(miolo, /overflow-y:\s*auto/);
  assert.match(miolo, /min-height:\s*0/, 'sem isto o flex não deixa o miolo rolar');
  assert.match(miolo, /flex:\s*1 1 auto/);
  assert.match(regra('.overlay-title'), /overflow-wrap:\s*anywhere/);
  assert.match(regra('.owner-name'), /overflow-wrap:\s*anywhere/);
  assert.match(regra('.owner-role'), /overflow-wrap:\s*anywhere/);
  assert.match(regra('.overlay-titles'), /min-width:\s*0/, 'o título longo não empurra o X para fora');
  // telas menores: duas faixas de largura ajustam a gaveta e os indicadores
  assert.match(css, /@media \(max-width: 1100px\) \{\n\s*\.overlay-dialog\.drawer \{ width: min\(640px, 100%\); \}/);
  const celular = css.slice(css.indexOf('@media (max-width: 760px) {\n  .overlay-dialog.drawer'));
  assert.match(celular, /\.overlay-dialog\.drawer \{ width: 100%;/);
  assert.match(celular, /\.indicator-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(celular, /\.overlay-body \{ padding: 14px 16px 20px; \}/);
});

test('[APR-REF-10] CSS da lista: sem sublinhado de link, cursor de clique, hover e seleção visíveis, foco visível no botão; identidade lime preservada', async () => {
  const nome = regra('table.list.queue .company-name');
  assert.match(nome, /text-decoration:\s*none/);
  assert.match(nome, /background:\s*none/);
  assert.match(regra('table.list.queue tr.queue-row'), /cursor:\s*pointer/);
  assert.match(css, /table\.list\.queue tr\.queue-row:hover \.company-name \{ color: var\(--brand-ink\)/);
  assert.match(css, /table\.list\.queue tr\.queue-row:focus-within td/);
  assert.match(css, /table\.list\.queue tr\.selected td:first-child \{ box-shadow: inset 3px 0 0 var\(--brand-strong\)/);
  assert.match(regra('table.list.queue .company-name:focus-visible'), /outline:\s*2px solid var\(--brand-strong\)/);
  // a identidade: verde-lima da marca nos indicadores de seleção e no contador do menu, sem sombras exageradas
  assert.match(css, /--brand:\s*#a3e635/);
  assert.match(css, /\.nav-link\[data-count\]::after/);
  assert.doesNotMatch(css, /box-shadow:[^;]*(?:0 (?:3\d|[4-9]\d)px)[^;]*rgba\(0, 0, 0/, 'nenhuma sombra pesada');
});
