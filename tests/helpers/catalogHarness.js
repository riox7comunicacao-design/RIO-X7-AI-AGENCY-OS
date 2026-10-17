// Ferramentas dos testes das TELAS DOS CATÁLOGOS do CRM (CRM 5.0, Fase 2B-2): uma API falsa em memória (com erros e pausas injetáveis, e o registro de tudo o que foi pedido), a montagem da tela
// sobre o DOM de teste e consultas ao que a pessoa vê. Nenhum navegador, nenhuma rede, nenhum dado real, nenhum arquivo — tudo em memória.

const { createBrowser } = require('./fakeDom');

const loadCatalogs = () => import('../../dashboard/views/catalogs.mjs');
const loadRouter = () => import('../../dashboard/router.mjs');
const loadUi = () => import('../../dashboard/ui/index.mjs');
const loadApi = () => import('../../dashboard/api.mjs');

const ROTAS = Object.freeze({ servicos: '#/crm/configuracoes/servicos', nichos: '#/crm/configuracoes/nichos', origens: '#/crm/configuracoes/origens' });
const ADMIN = Object.freeze({ canReadCrm: true, canManageCrmCatalogs: true, canManageFunnels: true });
const VENDEDOR = Object.freeze({ canReadCrm: true, canManageCrmCatalogs: false, canManageFunnels: false });

const clone = (valor) => JSON.parse(JSON.stringify(valor));
const AUDITORIA = { criadoEm: '2026-10-01T12:00:00.000Z', atualizadoEm: '2026-10-02T15:30:00.000Z', criadoPorUserId: 'user-breno', criadoPorNome: 'Breno Bento', atualizadoPorUserId: 'user-breno', atualizadoPorNome: 'Breno Bento' };
const normalizar = (texto) => texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const servico = (n, extras = {}) => ({ id: `service:${n}`, nome: `Serviço ${n}`, nomeNormalizado: `servico ${n}`, descricao: null, ativo: true, ordem: n - 1, categoria: null, precoReferencia: null, permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [], tipoCobranca: null, recorrencia: null, ...AUDITORIA, ...extras });
const nicho = (n, extras = {}) => ({ id: `niche:${n}`, nome: `Nicho ${n}`, nomeNormalizado: `nicho ${n}`, descricao: null, ativo: true, ordem: n - 1, cor: 'azul', ...AUDITORIA, ...extras });
const origem = (n, extras = {}) => ({ id: `origin:${n}`, nome: `Origem ${n}`, nomeNormalizado: `origem ${n}`, descricao: null, ativo: true, ordem: n - 1, canal: 'INDICACAO', ...AUDITORIA, ...extras });
const PREFIXO = { servicos: 'service', nichos: 'niche', origens: 'origin' };

// Erros no formato do cliente de API (ApiError): status, código, mensagem e os detalhes de validação.
async function erroApi(status, code = '', details = [], message = '') {
  const { ApiError } = await loadApi();
  return new ApiError(status, code, message, details);
}

// API falsa. `mem.falhas.<operacao>` (um erro, ou uma função que devolve o erro) faz a PRÓXIMA chamada daquela operação falhar (use `mem.sempre` para falhar sempre);
// `pausar('criar')` segura a operação até `liberar()` (para provar que nada é confirmado antes da resposta). Operações: listar, obter, criar, atualizar, ativar, desativar, reordenar.
function apiFalsa({ servicos = [], nichos = [], origens = [], emUso = {} } = {}) {
  const chamadas = [];
  const mem = { servicos: clone(servicos), nichos: clone(nichos), origens: clone(origens), emUso, falhas: {}, sempre: {}, pausas: {} };
  const passar = async (operacao) => {
    const pausa = mem.pausas[operacao];
    if (pausa) await pausa.promessa;
    const falha = mem.sempre[operacao] || mem.falhas[operacao];
    if (falha) {
      if (!mem.sempre[operacao]) delete mem.falhas[operacao];
      throw typeof falha === 'function' ? falha() : falha;
    }
  };
  const achar = (catalogo, id) => mem[catalogo].find((item) => item.id === id);
  const api = {
    chamadas,
    mem,
    pausar(operacao) {
      let liberar;
      const promessa = new Promise((resolve) => {
        liberar = resolve;
      });
      mem.pausas[operacao] = { promessa };
      return {
        liberar: () => {
          delete mem.pausas[operacao];
          liberar();
        },
      };
    },
    quantas: (nome) => chamadas.filter(([n]) => n === nome).length,
    escritas: () => chamadas.filter(([n]) => ['criar', 'atualizar', 'ativar', 'desativar', 'reordenar'].includes(n)),
    listCatalog: async (catalogo, opcoes) => {
      chamadas.push(['listar', catalogo, opcoes]);
      await passar('listar');
      return { items: clone(mem[catalogo]) };
    },
    getCatalogItem: async (catalogo, id) => {
      chamadas.push(['obter', catalogo, id]);
      await passar('obter');
      const item = achar(catalogo, id);
      if (!item) throw await erroApi(404, 'CRM_CATALOG_NOT_FOUND');
      return { item: { ...clone(item), emUso: Object.prototype.hasOwnProperty.call(mem.emUso, id) ? mem.emUso[id] : 0 } };
    },
    createCatalogItem: async (catalogo, corpo) => {
      chamadas.push(['criar', catalogo, clone(corpo)]);
      await passar('criar');
      const proxima = mem[catalogo].reduce((maior, item) => Math.max(maior, item.ordem), -1) + 1;
      const base = { id: `${PREFIXO[catalogo]}:novo-${proxima}`, nome: corpo.nome, nomeNormalizado: normalizar(corpo.nome), descricao: null, ativo: true, ordem: proxima, ...AUDITORIA };
      const especificos = catalogo === 'servicos' ? { categoria: null, precoReferencia: null, permitePagamentoUnico: false, permitePagamentoRecorrente: false, periodicidades: [], tipoCobranca: null, recorrencia: null } : catalogo === 'nichos' ? { cor: null } : { canal: null };
      const item = { ...base, ...especificos, ...clone(corpo) };
      mem[catalogo].push(item);
      return { item: clone(item) };
    },
    updateCatalogItem: async (catalogo, id, corpo) => {
      chamadas.push(['atualizar', catalogo, id, clone(corpo)]);
      await passar('atualizar');
      const item = achar(catalogo, id);
      if (!item) throw await erroApi(404, 'CRM_CATALOG_NOT_FOUND');
      Object.assign(item, clone(corpo));
      if (corpo.nome) item.nomeNormalizado = normalizar(corpo.nome);
      return { item: clone(item) };
    },
    activateCatalogItem: async (catalogo, id) => {
      chamadas.push(['ativar', catalogo, id]);
      await passar('ativar');
      const item = achar(catalogo, id);
      if (!item) throw await erroApi(404, 'CRM_CATALOG_NOT_FOUND');
      item.ativo = true;
      return { item: clone(item) };
    },
    deactivateCatalogItem: async (catalogo, id) => {
      chamadas.push(['desativar', catalogo, id]);
      await passar('desativar');
      const item = achar(catalogo, id);
      if (!item) throw await erroApi(404, 'CRM_CATALOG_NOT_FOUND');
      item.ativo = false;
      return { item: clone(item) };
    },
    reorderCatalog: async (catalogo, ids) => {
      chamadas.push(['reordenar', catalogo, [...ids]]);
      await passar('reordenar');
      mem[catalogo] = ids.map((id, posicao) => ({ ...achar(catalogo, id), ordem: posicao }));
      return { items: clone(mem[catalogo]) };
    },
  };
  return api;
}

// Monta o gerenciador das telas sobre o DOM de teste, com a navegação REAL do Dashboard (hash, Voltar/Avançar), o barramento de dados e a própria camada de avisos/painéis.
async function abrir({ catalogo = 'servicos', api = apiFalsa(), permissions = ADMIN, hash = ROTAS[catalogo], carregar = true } = {}) {
  const { createCatalogsView } = await loadCatalogs();
  const { browserNavigation, parseRoute } = await loadRouter();
  const { createDataBus } = await loadUi();
  const browser = createBrowser({ hash });
  browser.document.body.append(browser.root);
  const bus = createDataBus();
  const eventos = [];
  bus.subscribe('crm-catalogs:changed', (evento) => eventos.push([evento.catalog, evento.action, evento.id]));
  const navigation = browserNavigation(browser.window);
  const view = createCatalogsView({ document: browser.document, root: browser.root, api, permissions, bus, navigation });
  navigation.subscribe(() => view.show(parseRoute(navigation.current())));
  const s = { browser, view, api, bus, eventos, navigation, parseRoute };
  if (carregar) {
    await view.show(parseRoute(navigation.current()));
    await browser.flush(8);
  }
  return s;
}

// --- o que a pessoa vê ------------------------------------------------------------------------------------------------------------------------
const gaveta = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const confirmacao = (s) => s.browser.find(s.browser.root, (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className));
const botao = (s, texto, escopo) => s.browser.by.button(escopo || s.browser.root, texto);
const campo = (s, campoNome) => s.browser.by.id(s.browser.root, `catalog-field-${campoNome}`);
const erroDoCampo = (s, campoNome) => s.browser.by.id(s.browser.root, `catalog-field-${campoNome}-error`);
const linhas = (s) => s.browser.by.cls(s.browser.root, 'catalog-row');
const linhaDe = (s, id) => s.browser.find(s.browser.root, (el) => el.localName === 'li' && el.getAttribute('data-id') === id);
const nomes = (s) => linhas(s).map((li) => s.browser.find(li, (el) => el.localName === 'button' && el.getAttribute('data-action') === 'edit').textContent);
const acao = (s, id, nomeDaAcao) => s.browser.find(s.browser.root, (el) => el.localName === 'button' && el.getAttribute('data-item') === id && el.getAttribute('data-action') === nomeDaAcao);
const avisos = (s) => s.browser.findAll(s.browser.root, (el) => el.className === 'toast-message').map((el) => el.textContent);
const texto = (s) => s.browser.root.textContent.replace(/\s+/g, ' ');
const hash = (s) => s.browser.window.location.hash;
const clicar = async (s, el) => {
  s.browser.click(el);
  await s.browser.flush(8);
};
const digitar = (s, el, valor) => s.browser.type(el, valor);
// Marca (ou desmarca) uma caixa de seleção do formulário pelo nome do campo, como a pessoa faz (clique de verdade, que dispara os efeitos da tela).
const marcar = (s, campoNome, marcado = true) => s.browser.check(campo(s, campoNome), marcado);
const salvar = async (s) => clicar(s, botao(s, 'Salvar', gaveta(s)));
const emFoco = (s) => s.browser.document.activeElement;

module.exports = { ROTAS, ADMIN, VENDEDOR, clone, servico, nicho, origem, erroApi, apiFalsa, abrir, gaveta, confirmacao, botao, campo, erroDoCampo, linhas, linhaDe, nomes, acao, avisos, texto, hash, clicar, digitar, marcar, salvar, emFoco, loadRouter, loadApi };
