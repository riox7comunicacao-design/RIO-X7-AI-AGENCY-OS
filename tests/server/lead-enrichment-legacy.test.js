// CORREÇÃO 3.0.2 — "Lead não encontrado." no painel COMPLETAR PESQUISA de um lead EXISTENTE da Approval Queue.
//
// CAUSA RAIZ comprovada: (1) o servidor em execução era anterior às rotas /api/leads/:id/completar-pesquisa (sem Authorization já respondia 404 ROUTE_NOT_FOUND, enquanto /perfil respondia 401); e
// (2) o painel traduzia QUALQUER 404 em "Lead não encontrado." — a rota ausente era apresentada como se o lead não existisse. O ID, o repositório e o Service estavam corretos: com o código atual a
// mesma requisição, com o ID real (espaços, "|" e ":"), devolve 200. Estes testes: (a) provam a resolução do ID com o formato REAL; (b) a compatibilidade com perfis ANTIGOS (3.0.1) e novos, inclusive
// de leads reprovados; (c) um lead realmente inexistente continua 404 ENRICH_NOT_FOUND; (d) a tela distingue as duas causas do 404.
// Peças REAIS (fila em arquivo, Service, perfil, autorização); motor FAKE. Nenhuma rede, nenhum `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const domain = require('../../src/research-prospector/approvalQueue');
const { montarAmbiente, BRENO, RAFAEL, EX_COLABORADOR, descoberta } = require('./testEnv');
const { achado: achadoRico } = require('../helpers/promotionFixtures');
const { createBrowser } = require('../helpers/fakeDom');

// O ID REAL do lead do relato: "id:<nome normalizado>|<cidade>" — espaços, ":" e "|" (tudo precisa sobreviver ao caminho da URL)
const ID_REAL = 'id:empresa exemplo alfa centro estetico|petropolis';

function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return req;
}
async function chamar(env, usuario, { method = 'GET', url, body } = {}) {
  const headers = {};
  if (usuario) headers.Authorization = `Bearer ${env.tokenFor(usuario.userId)}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await env.app.handle(makeRequest({ method, url, headers, body }));
  return { status: response.status, text: response.body, json: () => JSON.parse(response.body) };
}

// o perfil como o JOB DA 3.0.1 o gravou (formato real de data/prospecting-profiles.json): SEM `contexto`, com o enriquecimento antigo INCOMPLETO por limite de turnos
const perfilLegado3_0_1 = () => ({
  versao: 1,
  empresa: 'Empresa Exemplo Alfa Centro Estético',
  tipoLead: { tipo: 'EMPRESA' },
  responsavel: { status: 'NAO_ENCONTRADO', nome: null, cargo: null, origem: null, confianca: null },
  endereco: { status: 'ENCONTRADO', rua: 'Rua do Imperador, 100', cidade: 'Petrópolis', estado: 'RJ', cep: '25620-000', origem: 'https://empresaexemploalfa.com.br/' },
  siteOficial: { status: 'ENCONTRADO', url: 'https://empresaexemploalfa.com.br/' },
  presencaDigital: { instagram: { status: 'ENCONTRADO', url: 'https://www.instagram.com/empresaexemploalfa', confirmacao: 'CONFIRMADO', regra: 'link_no_site_oficial' } },
  telefones: [{ numero: '+552422223333', celular: false, origem: 'https://empresaexemploalfa.com.br/' }],
  whatsapps: [{ numero: '+5524988887777', origem: 'https://empresaexemploalfa.com.br/' }],
  emails: [],
  trafegoPago: { meta: { status: 'NAO_VERIFICADO' }, google: { status: 'NAO_VERIFICADO' }, tiktok: { status: 'NAO_VERIFICADO' } },
  atividadeRecente: { ultimaPostagem: null, janelas: {}, dataPesquisa: '2026-10-08' },
  fontesDescoberta: [{ url: 'https://www.guiamais.com.br/empresa-exemplo-alfa', tipo: 'DIRETORIO' }],
  fontesValidacao: [{ url: 'https://empresaexemploalfa.com.br/', tipo: 'OFICIAL' }],
  fontesEnriquecimento: [{ url: 'https://empresaexemploalfa.com.br/', tipo: 'OFICIAL' }],
  outrasPresencas: [],
  dataPesquisa: '2026-10-08',
  enriquecimento: { status: 'INCOMPLETO', camposPendentes: ['responsavel', 'emails', 'atividadeRecente'], limiteDeTurnos: true, camposNaoEncontrados: [] },
  jobId: 'JOB-20261008-002',
  briefId: 'PROS-20261008-002',
});

// uma fila com o lead de ID real (comprovado por código, sem canais — como o do relato) + um segundo lead
function filaComLeadReal(t, { rejeitar = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'approval-queue.json');
  const queue = domain.createEmptyQueue();
  const semCanais = { comprovadoPorCodigo: true, campos: { site: [], instagram: [], telefone: [], whatsapp: [], email: [], facebook: [], linkedin: [], youtube: [], endereco: [] } };
  const real = domain.addProspect(queue, descoberta(achadoRico('Empresa Exemplo Alfa Centro Estético', 'empresa-exemplo-alfa', semCanais)));
  const novo = domain.addProspect(queue, descoberta(achadoRico('Clínica Recente', 'clinica-recente', semCanais)));
  assert.equal(real.prospectId, ID_REAL, 'o ID gerado pelo pipeline é o do relato');
  if (rejeitar) {
    real.estado = 'REJEITADO';
    real.historico.push({ timestamp: '2026-10-08T12:00:00.000Z', from: 'AGUARDANDO_REVISAO', to: 'REJEITADO', actor: 'HUMAN', motivo: 'Sem fit', reviewedBy: { userId: 'u1', name: 'Rafael', role: 'COMMERCIAL_CLOSER' } });
  }
  domain.saveQueueToDisk(queue, filePath);
  return { filePath, ids: { real: real.prospectId, novo: novo.prospectId, alfa: real.prospectId } };
}

function motorFake(resposta = (pedido) => ({ ok: true, resultados: [{ nome: pedido.leads[0].nome, emails: [{ email: 'contato@empresaexemploalfa.com.br', origem: 'https://empresaexemploalfa.com.br/contato' }] }] })) {
  const chamadas = [];
  return { chamadas, enrich: async (pedido) => { chamadas.push(pedido); return resposta(pedido); } };
}
function montar(t, { motor = motorFake(), rejeitar = false, perfis = true } = {}) {
  const fila = filaComLeadReal(t, { rejeitar });
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL, EX_COLABORADOR], crm: true, leadReconsideration: true, queue: fila, leadEnrichment: { enrichmentEngine: motor } });
  if (perfis) env.perfisDeLeads.save(fila.ids.real, perfilLegado3_0_1());
  return { env, fila, motor };
}
const rota = (id, acao = 'completar-pesquisa') => `/api/leads/${encodeURIComponent(id)}/${acao}`;

test('[LEG-1] ID REAL (espaços, ":" e "|"): o mesmo prospectId da Approval Queue resolve nas rotas de enriquecimento; o estado do perfil ANTIGO da 3.0.1 é lido sem erro, preservado e compatível', async (t) => {
  const { env } = montar(t);
  // 1) o ID que a Approval Queue entrega ao abrir o detalhe é o que o painel envia
  const lista = (await chamar(env, BRENO, { url: '/api/approvals' })).json().items;
  const doDetalhe = lista.find((i) => i.empresa === 'Empresa Exemplo Alfa Centro Estético');
  assert.equal(doDetalhe.prospectId, ID_REAL);
  // 2) o estado do painel (GET) e o perfil (GET) com esse ID
  const estado = await chamar(env, BRENO, { url: rota(doDetalhe.prospectId) });
  assert.equal(estado.status, 200, estado.text);
  const item = estado.json().item;
  assert.equal(item.prospectId, ID_REAL);
  assert.deepEqual([item.status, item.limiteDeTurnos, item.podeCompletar, item.podeRever, item.disponivel], ['INCOMPLETO', true, true, true, true], 'o estado antigo (INCOMPLETO por limite de turnos) é preservado');
  assert.deepEqual(item.camposPendentes, ['responsavel', 'emails', 'atividadeRecente']);
  const perfil = (await chamar(env, BRENO, { url: rota(doDetalhe.prospectId, 'perfil') })).json().item;
  assert.equal(perfil.empresa, 'Empresa Exemplo Alfa Centro Estético');
  assert.equal(perfil.prospectId, ID_REAL);
});

test('[LEG-2] perfil ANTIGO sem metadados da 3.0.2: ao completar, o contexto é inicializado do snapshot da fila, NADA confirmado é apagado, a pesquisa pede SÓ os pendentes antigos, e não nasce outro perfil nem outro lead', async (t) => {
  const { env, fila, motor } = montar(t);
  const antes = env.perfisDeLeads.getById(fila.ids.real);
  assert.equal(antes.contexto, undefined);
  const filaAntes = fs.readFileSync(fila.filePath, 'utf8');
  const inicio = await chamar(env, RAFAEL, { method: 'POST', url: rota(fila.ids.real), body: {} });
  assert.equal(inicio.status, 202, inicio.text);
  await env.leadEnrichmentService.waitFor(fila.ids.real);

  const [pedido] = motor.chamadas;
  assert.deepEqual(pedido.leads[0].precisa, ['responsavel', 'emails', 'atividadeRecente'], 'só o que ficou pendente na 3.0.1 (e ainda falta)');
  assert.deepEqual([pedido.leads[0].cidade, pedido.leads[0].uf], ['Petrópolis', 'RJ'], 'cidade/UF do snapshot, já que o perfil antigo não tinha contexto');
  assert.equal(pedido.leads[0].site, 'https://empresaexemploalfa.com.br/');
  assert.equal(JSON.stringify(pedido).includes('Rua do Imperador'), false, 'sem texto de página/dados do perfil no pedido');

  const depois = env.perfisDeLeads.getById(fila.ids.real);
  assert.deepEqual(depois.contexto, { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínica de Psicologia' }, 'metadados inicializados a partir do snapshot');
  for (const campo of ['empresa', 'tipoLead', 'endereco', 'siteOficial', 'telefones', 'whatsapps', 'fontesDescoberta', 'fontesValidacao', 'outrasPresencas', 'jobId', 'briefId', 'dataPesquisa', 'versao']) {
    assert.deepEqual(depois[campo], antes[campo], `${campo} preservado`);
  }
  assert.equal(depois.presencaDigital.instagram.confirmacao, 'CONFIRMADO');
  assert.deepEqual(depois.emails.map((e) => e.email), ['contato@empresaexemploalfa.com.br'], 'o que o motor trouxe foi ACRESCENTADO');
  // o motor só trouxe um e-mail e NÃO documentou consulta alguma: o resto fica NAO_VERIFICADO (a execução sem erro não é uma pesquisa completa)
  assert.deepEqual([depois.enriquecimento.status, depois.enriquecimento.ultimaExecucao.resultado], ['INCOMPLETO', 'INCOMPLETO']);
  assert.deepEqual(depois.enriquecimento.camposPendentes, ['responsavel', 'atividadeRecente']);
  // a origem LEGADO do registro 3.0.1 foi preservada (o estado geral foi sobrescrito pela nova execução; o histórico real não)
  assert.deepEqual([depois.enriquecimento.legado.origem, depois.enriquecimento.legado.statusAnterior, depois.enriquecimento.legado.limiteDeTurnosAnterior], ['LEGADO', 'INCOMPLETO', true]);
  assert.deepEqual(depois.enriquecimento.legado.camposPendentesAnterior, ['responsavel', 'emails', 'atividadeRecente']);
  assert.equal(depois.enriquecimento.execucoes.length, 1, 'nenhuma execução antiga foi inventada: só a real, desta');
  assert.equal(env.perfisDeLeads.list().length, 1, 'nenhum perfil duplicado');
  assert.equal(fs.readFileSync(fila.filePath, 'utf8'), filaAntes, 'nenhum lead novo, nenhum estado alterado na Approval Queue');
});

test('[LEG-3] lead NOVO (perfil da 3.0.2 com contexto), lead SEM perfil e lead REPROVADO com perfil antigo: o painel resolve os três; a pesquisa NÃO altera o estado nem o histórico do reprovado', async (t) => {
  // novo (com contexto e estado NAO_EXECUTADO/SOB_DEMANDA)
  const novo = montar(t, { perfis: false });
  novo.env.perfisDeLeads.save(novo.fila.ids.novo, { ...perfilLegado3_0_1(), empresa: 'Clínica Recente', contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' }, enriquecimento: { status: 'NAO_EXECUTADO', camposPendentes: ['emails'], limiteDeTurnos: false, motivo: 'SOB_DEMANDA' } });
  const a = (await chamar(novo.env, BRENO, { url: rota(novo.fila.ids.novo) })).json().item;
  assert.deepEqual([a.status, a.podeCompletar], ['NAO_EXECUTADO', true]);

  // sem perfil nenhum (veio de pesquisa manual): perfil-base do snapshot
  const semPerfil = (await chamar(novo.env, BRENO, { url: rota(novo.fila.ids.real) })).json().item;
  assert.equal(semPerfil.status, 'NAO_EXECUTADO');
  assert.ok(semPerfil.camposPendentes.length > 0);
  assert.equal(novo.env.perfisDeLeads.getById(novo.fila.ids.real), null, 'ler o estado NÃO grava nada');

  // REPROVADO com perfil antigo
  const rej = montar(t, { rejeitar: true });
  const filaAntes = fs.readFileSync(rej.fila.filePath, 'utf8');
  const estado = await chamar(rej.env, BRENO, { url: rota(rej.fila.ids.real) });
  assert.equal(estado.status, 200);
  assert.equal(estado.json().item.podeCompletar, true);
  assert.equal((await chamar(rej.env, BRENO, { method: 'POST', url: rota(rej.fila.ids.real), body: {} })).status, 202);
  await rej.env.leadEnrichmentService.waitFor(rej.fila.ids.real);
  assert.equal(fs.readFileSync(rej.fila.filePath, 'utf8'), filaAntes, 'o reprovado continua REJEITADO, sem reaprovação/aprovação/promoção');
  const reprovados = (await chamar(rej.env, BRENO, { url: '/api/leads/reprovados?filtro=REPROVADOS' })).json().items;
  assert.equal(reprovados.length, 1);
  assert.equal(reprovados[0].prospectId, ID_REAL);
  assert.equal(reprovados[0].perfil.emails.length, 1, 'o painel de Leads Reprovados vê o que a pesquisa acrescentou');
});

test('[LEG-4] lead REALMENTE inexistente: 404 ENRICH_NOT_FOUND (nas 3 rotas), sem criar nada; id com caracteres especiais que não existe também; permissões e métodos intactos', async (t) => {
  const { env, fila, motor } = montar(t);
  const filaAntes = fs.readFileSync(fila.filePath, 'utf8');
  for (const [method, acao, body] of [['GET', 'completar-pesquisa'], ['POST', 'completar-pesquisa', {}], ['POST', 'rever-site', {}], ['POST', 'proposta-site', { decisao: 'MANTER' }]]) {
    for (const id of ['id:nao existe|petropolis', 'inexistente', ID_REAL.toUpperCase()]) {
      const r = await chamar(env, BRENO, { method, url: rota(id, acao), body });
      assert.equal(r.status, 404, `${method} ${acao} ${id}`);
      assert.equal(r.json().error.code, 'ENRICH_NOT_FOUND', `${acao} ${id}`);
    }
  }
  assert.equal(motor.chamadas.length, 0);
  assert.equal(env.perfisDeLeads.list().length, 1, 'nenhum perfil novo');
  assert.equal(fs.readFileSync(fila.filePath, 'utf8'), filaAntes);
  assert.equal((await chamar(env, null, { url: rota(ID_REAL) })).status, 401);
  assert.ok([401, 403].includes((await chamar(env, EX_COLABORADOR, { url: rota(ID_REAL) })).status));
  assert.equal((await chamar(env, BRENO, { method: 'DELETE', url: rota(ID_REAL) })).status, 405);
});

test('[LEG-5] a TELA distingue as duas causas do 404: rota ausente neste servidor (ROUTE_NOT_FOUND) NUNCA vira "lead não encontrado"; ENRICH_NOT_FOUND sim; o painel segue legível e sem botões habilitados', async () => {
  const { createEnrichmentPanel } = await import('../../dashboard/views/leadEnrichmentPanel.mjs');
  const casos = [
    [{ status: 404, code: 'ROUTE_NOT_FOUND' }, /ainda não está disponível neste servidor.*Reinicie o servidor/s, /Lead não encontrado/],
    [{ status: 404, code: 'HTTP_404' }, /Reinicie o servidor/, /Lead não encontrado/],
    [{ status: 404, code: 'ENRICH_NOT_FOUND' }, /Lead não encontrado na Approval Queue/, /Reinicie/],
  ];
  for (const [erro, esperado, proibido] of casos) {
    const browser = createBrowser();
    const painel = createEnrichmentPanel({ document: browser.document, api: { getLeadResearchStatus: async () => { throw Object.assign(new Error('x'), erro); } }, prospectId: ID_REAL, schedule: () => () => {} });
    browser.root.append(painel.element);
    await painel.load();
    await browser.flush();
    const mensagem = browser.by.id(browser.root, 'enrich-message').textContent;
    assert.match(mensagem, esperado, JSON.stringify(erro));
    assert.doesNotMatch(mensagem, proibido, JSON.stringify(erro));
    assert.equal(browser.by.id(browser.root, 'enrich-run').disabled, true);
    assert.equal(browser.by.id(browser.root, 'enrich-review-site').disabled, true);
  }
});
