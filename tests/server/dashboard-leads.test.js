// As telas da Implementação 3.0 no Dashboard: LEADS REPROVADOS (filtros, dados comerciais, REAPROVAR LEAD), HISTÓRICO (resumo + REFAZER) e o resultado da NOVA PROSPECÇÃO
// (resumo padronizado, REFAZER, máximo de candidatos, sem CANCELAR depois de terminar). A API é um FAKE em memória; nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowser } = require('../helpers/fakeDom');

const porAttr = (browser, nome, valor) => browser.find(browser.root, (el) => el.getAttribute(nome) === valor);

const PERFIL = {
  empresa: 'Clínica Alfa',
  jobId: 'JOB-20261007-001',
  responsavel: { status: 'ENCONTRADO', nome: 'Ana Souza', cargo: 'Proprietária', origem: 'https://clinicaalfa.com.br/', confianca: 'ALTA' },
  endereco: { status: 'ENCONTRADO', rua: 'Rua das Flores, 10', cidade: 'Petrópolis', estado: 'RJ', cep: '25600-000', origem: 'https://clinicaalfa.com.br/' },
  siteOficial: { status: 'ENCONTRADO', url: 'https://clinicaalfa.com.br/' },
  presencaDigital: { instagram: { status: 'ENCONTRADO', url: 'https://www.instagram.com/clinicaalfa', confirmacao: 'CONFIRMADO' }, facebook: { status: 'NAO_ENCONTRADO' } },
  telefones: [{ numero: '+552422223333', celular: false, origem: 'https://clinicaalfa.com.br/' }],
  whatsapps: [{ numero: '+5524988887777', origem: 'https://clinicaalfa.com.br/' }],
  emails: [{ email: 'contato@clinicaalfa.com.br', origem: 'https://clinicaalfa.com.br/' }],
  trafegoPago: { meta: { status: 'EVIDENCIA_ENCONTRADA', origem: { url: 'https://www.facebook.com/ads/library/?id=1' }, data: '2026-10-01' }, google: { status: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', observacao: 'Nenhuma evidência pública encontrada nesta consulta; isso NÃO significa que a empresa não faça tráfego pago.' }, tiktok: { status: 'NAO_VERIFICADO' } },
  atividadeRecente: { ultimaPostagem: { canal: 'instagram', url: 'https://www.instagram.com/p/abc/', data: '2026-09-20' }, janelas: { ultimos7Dias: 'NAO', ultimos30Dias: 'SIM', ultimos60Dias: 'SIM', ultimos90Dias: 'SIM' }, dataPesquisa: '2026-10-07' },
  fontesDescoberta: [{ url: 'https://www.guiamais.com.br/clinica-alfa', tipo: 'DIRETORIO' }],
  fontesValidacao: [{ url: 'https://clinicaalfa.com.br/', tipo: 'OFICIAL' }],
  fontesEnriquecimento: [{ url: 'https://clinicaalfa.com.br/', tipo: 'OFICIAL' }],
  outrasPresencas: [{ url: 'https://g1.globo.com/noticia', tipo: 'NOTICIA_OU_TERCEIRO' }],
  dataPesquisa: '2026-10-07',
};
const LEAD = (extras = {}) => ({ prospectId: 'pid-alfa', empresa: 'Clínica Alfa', estado: 'REJEITADO', reaprovavel: true, reprovadoEm: '2026-10-07T12:00:00.000Z', reprovadoPor: { userId: 'u1', name: 'Rafael Closer', role: 'COMMERCIAL_CLOSER' }, origemDaDecisao: 'HUMANO', motivo: 'Sem fit', reaprovacoes: 0, jobOrigem: 'JOB-20261007-001', dadosComerciais: { empresa: 'Clínica Alfa' }, perfil: PERFIL, historico: [], ...extras });
const RESUMO = { solicitados: 3, limiteDeCandidatos: 50, candidatosProcessados: 8, descobertos: 9, novos: 8, repetidos: 1, validados: 4, naoValidados: 4, naApprovalQueue: 3, jaExistentes: 1, dadosInsuficientes: 0, duplicados: 0, dnc: 0, reposicoes: 1, enriquecidos: 3, tempoMs: 98000, custoUsd: 0.31, aprovados: 1, rejeitados: 1, promovidos: 0 };

test('[DASH-LEADS-1] Leads Reprovados: filtros, dados comerciais completos (sem JSON), "Não verificado" onde não há prova, e REAPROVAR LEAD recarrega a lista', async () => {
  const { createRejectedLeadsView } = await import('../../dashboard/views/rejectedLeads.mjs');
  const chamadas = [];
  let itens = [LEAD(), LEAD({ prospectId: 'pid-dnc', empresa: 'Clínica DNC', estado: 'DNC', reaprovavel: false, origemDaDecisao: 'SISTEMA', reprovadoPor: null, perfil: null, motivo: 'DNC' })];
  const api = {
    listRejectedLeads: async (filtro) => {
      chamadas.push(['lista', filtro]);
      return { items: filtro === 'DNC' ? itens.filter((i) => i.estado === 'DNC') : itens };
    },
    reapproveLead: async (id, motivo) => {
      chamadas.push(['reaprovar', id, motivo]);
      itens = itens.filter((i) => i.prospectId !== id);
      return { item: { prospectId: id, estado: 'AGUARDANDO_REVISAO' } };
    },
  };
  const browser = createBrowser();
  const view = createRejectedLeadsView({ document: browser.document, root: browser.root, api, permissions: { canReview: true } });
  await view.load();
  await browser.flush();
  const tela = () => browser.root.textContent.replace(/\s+/g, ' ');
  assert.deepEqual(chamadas, [['lista', 'TODOS']]);
  for (const rotulo of ['Todos', 'Reprovados', 'Dados insuficientes', 'Duplicados', 'DNC', 'Expirados']) assert.ok(browser.by.text(browser.root, rotulo, 'button'), rotulo);
  assert.match(tela(), /Clínica Alfa/);
  assert.match(tela(), /Sem fit/);

  browser.click(porAttr(browser, 'data-open', 'pid-alfa'));
  await browser.flush();
  const aberto = tela();
  for (const trecho of ['Ana Souza — Proprietária', 'Rua das Flores, 10', 'CEP 25600-000', '+552422223333', '+5524988887777', 'contato@clinicaalfa.com.br', 'Evidência pública encontrada', 'Nenhuma evidência pública encontrada', 'Meta:', 'TikTok: Não verificado', 'Última postagem: 20/09/2026', '7 dias: Não', '30 dias: Sim', 'Fontes de enriquecimento', 'Outras presenças (não são site oficial)', 'JOB-20261007-001', 'Rafael Closer']) {
    assert.ok(aberto.includes(trecho), `falta "${trecho}"`);
  }
  assert.doesNotMatch(aberto, /\{"|\[object/);
  const botao = browser.by.id(browser.root, 'btn-reapprove');
  assert.equal(botao.textContent, 'REAPROVAR LEAD');
  browser.type(browser.by.id(browser.root, 'reapprove-reason'), 'Cliente pediu');
  browser.click(botao);
  await browser.flush(8);
  assert.deepEqual(chamadas.slice(1, 3), [['reaprovar', 'pid-alfa', 'Cliente pediu'], ['lista', 'TODOS']]);
  assert.match(tela(), /voltou para a Approval Queue/);
  assert.equal(porAttr(browser, 'data-prospect', 'pid-alfa'), null, 'o lead reaprovado saiu da lista');

  // DNC: sem botão de reaprovar, com a explicação
  browser.click(browser.by.text(browser.root, 'DNC', 'button'));
  await browser.flush(8);
  assert.deepEqual(chamadas.at(-1), ['lista', 'DNC']);
  browser.click(porAttr(browser, 'data-open', 'pid-dnc'));
  await browser.flush();
  assert.equal(browser.by.id(browser.root, 'btn-reapprove'), null);
  assert.match(tela(), /não pode ser reaprovado/);
  assert.match(tela(), /não tem análise comercial detalhada|não tem análise/);
});

test('[DASH-LEADS-2] Leads Reprovados: sem APPROVE:LEAD_APPROVAL não há botão; erro da API aparece como mensagem e o lead continua na lista', async () => {
  const { createRejectedLeadsView } = await import('../../dashboard/views/rejectedLeads.mjs');
  const api = { listRejectedLeads: async () => ({ items: [LEAD()] }), reapproveLead: async () => { throw Object.assign(new Error('x'), { serverMessage: 'Reaprovação bloqueada: o lead já existe no CRM.' }); } };
  const semPermissao = createBrowser();
  const v1 = createRejectedLeadsView({ document: semPermissao.document, root: semPermissao.root, api, permissions: { canReview: false } });
  await v1.load();
  await semPermissao.flush();
  semPermissao.click(porAttr(semPermissao, 'data-open', 'pid-alfa'));
  await semPermissao.flush();
  assert.equal(semPermissao.by.id(semPermissao.root, 'btn-reapprove'), null);

  const browser = createBrowser();
  const view = createRejectedLeadsView({ document: browser.document, root: browser.root, api, permissions: { canReview: true } });
  await view.load();
  await browser.flush();
  browser.click(porAttr(browser, 'data-open', 'pid-alfa'));
  await browser.flush();
  browser.click(browser.by.id(browser.root, 'btn-reapprove'));
  await browser.flush(8);
  assert.match(browser.root.textContent, /o lead já existe no CRM/);
  assert.match(browser.root.textContent, /Clínica Alfa/, 'o lead continua na lista');
});

test('[DASH-LEADS-3] Histórico: cada prospecção com o resumo padronizado; REFAZER PROSPECÇÃO cria uma nova e leva à Nova Prospecção; ativa não tem refazer', async () => {
  const { createProspectingHistoryView } = await import('../../dashboard/views/prospectingHistory.mjs');
  const chamadas = [];
  const destinos = [];
  const api = {
    listProspectingJobs: async () => ({ items: [{ id: 'JOB-20261007-002', status: 'EXECUTANDO', createdAt: '2026-10-07T13:00:00.000Z', resumo: { ...RESUMO, naApprovalQueue: 1 } }, { id: 'JOB-20261007-001', status: 'CONCLUIDO', createdAt: '2026-10-07T12:00:00.000Z', resumo: RESUMO }] }),
    redoProspectingJob: async (id) => {
      chamadas.push(id);
      return { item: { id: 'JOB-20261007-003' } };
    },
  };
  const browser = createBrowser();
  const view = createProspectingHistoryView({ document: browser.document, root: browser.root, api, navigate: (hash) => destinos.push(hash) });
  await view.load();
  await browser.flush();
  const tela = browser.root.textContent.replace(/\s+/g, ' ');
  for (const rotulo of ['Solicitados', 'Candidatos processados', 'Validados', 'Na Approval Queue', 'Já existentes', 'Dados insuficientes', 'Duplicados', 'DNC', 'Reposições', 'Tempo', 'Aprovados', 'Rejeitados', 'Promovidos']) assert.ok(tela.includes(rotulo), rotulo);
  assert.match(tela, /01:38/);
  assert.match(tela, /US\$ 0\.31/);
  assert.equal(porAttr(browser, 'data-redo', 'JOB-20261007-002'), null, 'job ativo não tem refazer');
  browser.click(porAttr(browser, 'data-redo', 'JOB-20261007-001'));
  await browser.flush(8);
  assert.deepEqual(chamadas, ['JOB-20261007-001']);
  assert.deepEqual(destinos, ['#/prospeccao']);
  assert.equal(browser.by.text(browser.root, 'CANCELAR PROSPECÇÃO', 'button'), null, 'o histórico nunca oferece cancelar');
});

test('[DASH-LEADS-4] Approval Queue: ao abrir um lead, a análise comercial (perfil) aparece; sem perfil, um aviso honesto; quem não revisa não busca o perfil', async () => {
  const { createApprovalsView } = await import('../../dashboard/views/approvals.mjs');
  const item = (id, empresa) => ({ prospectId: id, empresa, estado: 'AGUARDANDO_REVISAO', discoverySnapshot: { empresa, cidade: 'Petrópolis', estadoUf: 'RJ' }, historico: [] });
  const buscas = [];
  const api = {
    listApprovals: async () => ({ items: [item('pid-alfa', 'Clínica Alfa'), item('pid-manual', 'Clínica Manual')] }),
    getLeadProfile: async (id) => {
      buscas.push(id);
      return { item: id === 'pid-alfa' ? PERFIL : null };
    },
    approve: async () => ({}),
    reject: async () => ({}),
  };
  const browser = createBrowser();
  const view = createApprovalsView({ document: browser.document, root: browser.root, api, canReview: true });
  await view.load();
  await browser.flush();
  browser.click(browser.by.button(browser.root, 'Clínica Alfa'));
  await browser.flush(8);
  const tela = browser.root.textContent.replace(/\s+/g, ' ');
  assert.match(tela, /Análise comercial/);
  assert.match(tela, /Ana Souza — Proprietária/);
  assert.match(tela, /Evidência pública encontrada/);
  browser.click(browser.by.button(browser.root, 'Clínica Manual'));
  await browser.flush(8);
  assert.match(browser.root.textContent, /não tem análise comercial detalhada/);
  assert.deepEqual(buscas, ['pid-alfa', 'pid-manual']);

  const leitor = createBrowser();
  const semRevisao = createApprovalsView({ document: leitor.document, root: leitor.root, api, canReview: false });
  await semRevisao.load();
  await leitor.flush();
  leitor.click(leitor.by.button(leitor.root, 'Clínica Alfa'));
  await leitor.flush(8);
  assert.deepEqual(buscas, ['pid-alfa', 'pid-manual'], 'sem permissão de revisão, o perfil nem é pedido');
  assert.doesNotMatch(leitor.root.textContent, /Análise comercial/);
});
