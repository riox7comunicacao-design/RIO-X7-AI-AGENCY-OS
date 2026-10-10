// A PROPOSTA de novo site oficial no Dashboard (Implementação 3.0.2, decisão final): as evidências dos dois domínios, CONFIRMAR ALTERAÇÃO e MANTER SITE ATUAL — decisão humana, sem pesquisa. API FAKE.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowser } = require('../helpers/fakeDom');

const proposta = {
  status: 'PENDENTE',
  dominioAtual: 'https://clinicaalfa.com.br/',
  dominioNovo: 'https://alfaestetica.com.br/',
  atualSustentado: false,
  evidencias: {
    atual: { url: 'https://clinicaalfa.com.br/', comprovado: false, motivo: 'VINCULO_NAO_CONFIRMADO', titulo: 'Portal de notícias', vinculo: { dominio: false, titulo: false } },
    novo: { url: 'https://alfaestetica.com.br/', comprovado: true, titulo: 'Clínica Alfa | Estética', vinculo: { dominio: true, titulo: true }, regra: 'dominio_e_nome' },
  },
  fontes: ['https://clinicaalfa.com.br/', 'https://alfaestetica.com.br/'],
};
const estado = { status: 'NAO_EXECUTADO', camposPendentes: [], podeCompletar: false, podeRever: true, disponivel: true, propostaSite: proposta, podeDecidirSite: true, decisoesSite: [] };

function montar(aoDecidir) {
  const chamadas = [];
  let atual = estado;
  const api = {
    getLeadResearchStatus: async () => ({ item: atual }),
    completeLeadResearch: async () => assert.fail('decidir NÃO pesquisa'),
    reviewLeadSite: async () => assert.fail('decidir NÃO revisa o site de novo'),
    decideLeadSiteProposal: async (id, decisao) => {
      chamadas.push([id, decisao]);
      atual = await aoDecidir(decisao);
      return { item: atual };
    },
  };
  return { api, chamadas };
}

test('[DASH-PROP-1] a proposta mostra as evidências dos DOIS domínios e os botões; CONFIRMAR ALTERAÇÃO chama a decisão (uma vez), mostra quem/quando e recarrega o perfil; sem nova pesquisa', async () => {
  const { createEnrichmentPanel } = await import('../../dashboard/views/leadEnrichmentPanel.mjs');
  const sim = montar(async (decisao) => ({ ...estado, propostaSite: null, podeDecidirSite: false, decisoesSite: [{ decisao: 'CONFIRMADA', usuario: { name: 'Rafael Closer' }, data: '2026-10-08T12:30:00.000Z', dominioAnterior: proposta.dominioAtual, dominioNovo: proposta.dominioNovo }] }));
  const browser = createBrowser();
  const terminou = [];
  const painel = createEnrichmentPanel({ document: browser.document, api: sim.api, prospectId: 'pid-1', onFinished: (info) => terminou.push(info.decisoesSite.length), schedule: () => () => {} });
  browser.root.append(painel.element);
  await painel.load();
  await browser.flush();
  const texto = () => browser.root.textContent.replace(/\s+/g, ' ');
  assert.match(browser.by.id(browser.root, 'enrich-proposal-current').textContent, /Site atual: https:\/\/clinicaalfa\.com\.br\/ — não comprovado \(VINCULO_NAO_CONFIRMADO\).*título da página: "Portal de notícias"/);
  assert.match(browser.by.id(browser.root, 'enrich-proposal-new').textContent, /Site proposto: https:\/\/alfaestetica\.com\.br\/ — vínculo com a empresa comprovado.*vínculo: domínio sim, título sim.*regra: dominio_e_nome/);
  assert.match(texto(), /Fontes conferidas: https:\/\/clinicaalfa\.com\.br\/ · https:\/\/alfaestetica\.com\.br\//);
  assert.match(texto(), /O site atual continua valendo até uma confirmação/);
  const confirmar = browser.by.id(browser.root, 'enrich-site-confirm');
  assert.equal(confirmar.textContent, 'CONFIRMAR ALTERAÇÃO');
  assert.equal(browser.by.id(browser.root, 'enrich-site-keep').textContent, 'MANTER SITE ATUAL');

  browser.click(confirmar);
  await browser.flush(8);
  assert.deepEqual(sim.chamadas, [['pid-1', 'CONFIRMAR']]);
  assert.equal(browser.by.id(browser.root, 'enrich-site-proposal'), null, 'a proposta saiu da tela');
  assert.match(texto(), /Alteração confirmada: o novo domínio passou a ser o site oficial/);
  assert.match(browser.by.id(browser.root, 'enrich-site-decision').textContent, /alteração confirmada por Rafael Closer.*https:\/\/clinicaalfa\.com\.br\/ → https:\/\/alfaestetica\.com\.br\//);
  assert.deepEqual(terminou, [1], 'o perfil é recarregado depois da decisão');
});

test('[DASH-PROP-2] MANTER SITE ATUAL descarta a proposta; "já decidida" (409) vira mensagem clara e a tela se atualiza; sem permissão (canRun=false) não há botões de decisão', async () => {
  const { createEnrichmentPanel } = await import('../../dashboard/views/leadEnrichmentPanel.mjs');
  const mantida = montar(async () => ({ ...estado, propostaSite: null, podeDecidirSite: false, decisoesSite: [{ decisao: 'MANTIDA', usuario: { name: 'Breno' }, data: '2026-10-08T12:30:00.000Z', dominioAnterior: proposta.dominioAtual, dominioNovo: proposta.dominioNovo }] }));
  const b1 = createBrowser();
  const p1 = createEnrichmentPanel({ document: b1.document, api: mantida.api, prospectId: 'pid-1', schedule: () => () => {} });
  b1.root.append(p1.element);
  await p1.load();
  await b1.flush();
  b1.click(b1.by.id(b1.root, 'enrich-site-keep'));
  await b1.flush(8);
  assert.deepEqual(mantida.chamadas, [['pid-1', 'MANTER']]);
  assert.match(b1.root.textContent, /O site atual foi mantido e a proposta foi descartada/);
  assert.match(b1.by.id(b1.root, 'enrich-site-decision').textContent, /site atual mantido por Breno/);

  const jaDecidida = montar(async () => { throw Object.assign(new Error('x'), { status: 409, code: 'ENRICH_NO_PROPOSAL' }); });
  const b2 = createBrowser();
  const p2 = createEnrichmentPanel({ document: b2.document, api: jaDecidida.api, prospectId: 'pid-1', schedule: () => () => {} });
  b2.root.append(p2.element);
  await p2.load();
  await b2.flush();
  b2.click(b2.by.id(b2.root, 'enrich-site-confirm'));
  await b2.flush(8);
  assert.match(b2.by.id(b2.root, 'enrich-message').textContent, /Esta proposta já foi decidida/);

  const somenteLeitura = montar(async () => estado);
  const b3 = createBrowser();
  const p3 = createEnrichmentPanel({ document: b3.document, api: somenteLeitura.api, prospectId: 'pid-1', canRun: false, schedule: () => () => {} });
  b3.root.append(p3.element);
  await p3.load();
  await b3.flush();
  assert.ok(b3.by.id(b3.root, 'enrich-site-proposal'), 'a proposta e as evidências ficam visíveis');
  assert.equal(b3.by.id(b3.root, 'enrich-site-confirm'), null);
  assert.equal(b3.by.id(b3.root, 'enrich-site-keep'), null);
});
