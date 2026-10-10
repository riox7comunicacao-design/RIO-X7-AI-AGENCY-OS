// API do COMPLETAR PESQUISA depois do ajuste de CONFIABILIDADE 3.0.2 (rotas reais de src/server/app.js): o estado traz o resultado por campo; um COMPLETO antigo é lido como NÃO VERIFICADO/LEGADO sem
// escrita; a nova tentativa é manual, de UM lead, só dos campos não resolvidos; permissões e o fechamento sem lote. Peças REAIS (fila, Service, perfil, autorização); motor e leitura de página FAKES.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const { montarAmbiente, BRENO, RAFAEL, EX_COLABORADOR } = require('./testEnv');
const commercial = require('../../src/research-prospector/commercialProfile');
const digital = require('../../src/research-prospector/digitalPresence');

function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
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

const LIDA = 'https://clinica-alfa.com.br/sobre';
const url = (id, acao = 'completar-pesquisa') => `/api/leads/${encodeURIComponent(id)}/${acao}`;
const EXECUCAO_LEGADA = { iniciadoEm: '2026-10-09T01:09:39.465Z', concluidoEm: '2026-10-09T01:10:00.957Z', duracaoMs: 21492, custoUsd: 0.067777, webSearchRequests: 0, turnos: 5, camposSolicitados: ['emails', 'atividadeRecente'], camposObtidos: [], camposPendentes: [], resultado: 'COMPLETO', motivo: null, fontes: [] };

function motorFake(respostas) {
  const chamadas = [];
  return { chamadas, enrich: async (pedido) => { chamadas.push(pedido); return typeof respostas === 'function' ? respostas(pedido, chamadas.length) : respostas; } };
}
function montar(t, motor) {
  const env = montarAmbiente(t, {
    usuarios: [BRENO, RAFAEL, EX_COLABORADOR],
    crm: true,
    leadReconsideration: true,
    leadEnrichment: { ...(motor ? { enrichmentEngine: motor } : {}), createFetchPage: () => async (endereco) => (endereco === LIDA ? { ok: true, urlFinal: LIDA, texto: 'Consultório Alfa. Sobre nós, blog e novidades, equipe, fale conosco, endereço, instagram. Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt.' } : { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' }) },
  });
  const id = env.ids.alfa;
  const base = commercial.buildCommercialProfile({ empresa: 'Consultório Alfa', siteOficial: { status: 'ENCONTRADO', url: 'https://clinica-alfa.com.br/' }, presencaDigital: digital.buildPresence({ officialLinks: ['https://www.instagram.com/consultorioalfa'] }), pages: [], today: '2026-10-08' });
  env.perfisDeLeads.save(id, {
    ...base,
    contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínica de Psicologia' },
    enriquecimento: { status: 'COMPLETO', camposPendentes: [], camposNaoEncontrados: ['emails', 'atividadeRecente'], limiteDeTurnos: false, ultimaExecucao: { ...EXECUCAO_LEGADA }, execucoes: [{ ...EXECUCAO_LEGADA }] },
  });
  return { env, id };
}

test('[CONFAPI-1] GET do estado de um COMPLETO antigo: INCOMPLETO/LEGADO, campos NAO_VERIFICADO, custo e duração reais, podeCompletar; ler NÃO grava nada e NÃO inicia pesquisa', async (t) => {
  const motor = motorFake({ ok: true, resultados: [] });
  const { env, id } = montar(t, motor);
  const gravado = JSON.stringify(env.perfisDeLeads.getById(id));
  const fila = fs.readFileSync(env.filePath, 'utf8');
  for (let i = 0; i < 3; i += 1) {
    const r = await chamar(env, BRENO, { url: url(id) });
    assert.equal(r.status, 200, r.text);
  }
  const item = (await chamar(env, BRENO, { url: url(id) })).json().item;
  assert.deepEqual([item.status, item.statusRegistrado, item.origem, item.pesquisaCompleta, item.podeCompletar], ['INCOMPLETO', 'COMPLETO', 'LEGADO', false, true]);
  assert.deepEqual(item.camposPendentes, ['emails', 'atividadeRecente']);
  assert.deepEqual(item.camposNaoEncontrados, []);
  assert.deepEqual([item.resolucao.emails.status, item.resolucao.emails.origem], ['NAO_VERIFICADO', 'LEGADO']);
  assert.deepEqual([item.ultimaExecucao.origem, item.ultimaExecucao.duracaoMs, item.ultimaExecucao.custoUsd, item.custoUsd], ['LEGADO', 21492, 0.067777, 0.067777]);
  assert.equal(JSON.stringify(env.perfisDeLeads.getById(id)), gravado, 'o registro gravado não foi reescrito');
  assert.equal(fs.readFileSync(env.filePath, 'utf8'), fila);
  assert.equal(motor.chamadas.length, 0, 'ler o estado nunca inicia uma pesquisa');
});

test('[CONFAPI-2] POST: a nova tentativa pesquisa SÓ os campos não resolvidos, por usuário autorizado; o resultado por campo e a auditoria chegam pelo GET; um 2º POST durante a pesquisa é 409', async (t) => {
  let libera = () => {};
  const portao = new Promise((resolve) => { libera = resolve; });
  const motor = motorFake(async () => { await portao; return { ok: true, custoUsd: 0.09, turnos: 6, webSearchRequests: 2, resultados: [{ nome: 'Consultório Alfa', emails: [{ email: 'contato@clinica-alfa.com.br', origem: LIDA }], consultas: { atividadeRecente: [LIDA] } }] }; });
  const { env, id } = montar(t, motor);
  assert.equal((await chamar(env, null, { method: 'POST', url: url(id), body: {} })).status, 401);
  assert.ok([401, 403].includes((await chamar(env, EX_COLABORADOR, { method: 'POST', url: url(id), body: {} })).status));
  assert.equal(motor.chamadas.length, 0);

  const inicio = await chamar(env, RAFAEL, { method: 'POST', url: url(id), body: {} });
  assert.equal(inicio.status, 202, inicio.text);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: url(id), body: {} })).status, 409);
  libera();
  await env.leadEnrichmentService.waitFor(id);
  assert.deepEqual(motor.chamadas[0].leads[0].precisa, ['emails', 'atividadeRecente']);

  const item = (await chamar(env, BRENO, { url: url(id) })).json().item;
  assert.equal(item.status, 'COMPLETO', 'e-mail achado + atividade verificada com fonte lida: tudo resolvido');
  assert.deepEqual([item.resolucao.emails.status, item.resolucao.atividadeRecente.status], ['ENCONTRADO', 'NAO_ENCONTRADO_COM_VERIFICACAO']);
  assert.deepEqual(item.resolucao.atividadeRecente.fontes, [LIDA]);
  assert.deepEqual(item.ultimaExecucao.ferramentas, { webSearch: 2, webFetch: 'NAO_MEDIDO' });
  assert.deepEqual(item.ultimaExecucao.camposRetornados, ['emails']);
  assert.equal(item.ultimaExecucao.origem, undefined, 'a execução nova não é LEGADO');
  const perfil = env.perfisDeLeads.getById(id);
  assert.equal(perfil.enriquecimento.execucoes.length, 2);
  assert.deepEqual(perfil.enriquecimento.execucoes[0], { ...EXECUCAO_LEGADA }, 'o histórico real foi preservado, sem reescrita');
  assert.equal(perfil.enriquecimento.legado.statusAnterior, 'COMPLETO');
});

test('[CONFAPI-3] não existe pesquisa em lote nem por lista; o corpo não escolhe resolucao; nenhuma rota nova de escrita além das já existentes', async (t) => {
  const motor = motorFake({ ok: true, resultados: [] });
  const { env, id } = montar(t, motor);
  for (const caminho of ['/api/leads/completar-pesquisa', '/api/leads/lote/completar-pesquisa', '/api/leads/completar-pesquisa-lote']) {
    const r = await chamar(env, BRENO, { method: 'POST', url: caminho, body: { ids: [id] } });
    assert.ok([400, 404, 405].includes(r.status), `${caminho} -> ${r.status}`); // "lote" casaria como um :id; o corpo com `ids` é recusado e nada é pesquisado
  }
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: url(id), body: { resolucao: ['emails'] } })).status, 400);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: url(id), body: { ids: [id] } })).status, 400);
  assert.equal(motor.chamadas.length, 0);
});

test('[CONFAPI-4] o PERFIL servido pela API mostra um responsável sem vínculo comprovado como PENDENTE_DE_CONFIRMACAO (o registro em disco não muda); o estado da pesquisa traz o bloqueio da atividade sem canal confirmado', async (t) => {
  const { env, id } = montar(t, motorFake({ ok: true, resultados: [] }));
  const base = env.perfisDeLeads.getById(id);
  // sem canal confirmado e com um responsável gravado de um agregador (sem o vínculo demonstrado)
  env.perfisDeLeads.save(id, { ...base, presencaDigital: digital.emptyPresence(), responsavel: { status: 'ENCONTRADO', nome: 'Pessoa Teste Alfa', cargo: 'Sócio-Administrador', origem: 'https://agregador-exemplo.com.br/empresas/11111111000100', confianca: 'MEDIA' } });
  const emDisco = JSON.stringify(env.perfisDeLeads.getById(id));
  const perfil = (await chamar(env, BRENO, { url: url(id, 'perfil') })).json().item;
  assert.deepEqual([perfil.responsavel.status, perfil.responsavel.statusRegistrado, perfil.responsavel.vinculo.demonstrado], ['PENDENTE_DE_CONFIRMACAO', 'ENCONTRADO', false]);
  assert.equal(JSON.stringify(env.perfisDeLeads.getById(id)), emDisco, 'ler o perfil não regrava nada');
  const item = (await chamar(env, BRENO, { url: url(id) })).json().item;
  assert.equal(item.camposPendentes.includes('responsavel'), true);
  assert.deepEqual(item.camposBloqueados, ['atividadeRecente']);
  assert.equal(item.bloqueios[0].requer, 'CANAL_OFICIAL_CONFIRMADO');
});

test('[CONFAPI-5] CONSISTÊNCIA API x perfil x painel: o responsável gravado sem vínculo, com um registro histórico que o deu como "não encontrado", aparece PENDENTE no perfil E no estado da pesquisa (nunca em "não encontrado"), segue pesquisável, e o painel mostra a mesma coisa', async (t) => {
  const { env, id } = montar(t, motorFake({ ok: true, resultados: [] }));
  const base = env.perfisDeLeads.getById(id);
  const historico = { iniciadoEm: '2026-10-09T03:13:56.611Z', concluidoEm: '2026-10-09T03:14:25.414Z', duracaoMs: 28800, custoUsd: 0.0864, turnos: 5, subtype: 'success', terminalReason: 'completed', camposSolicitados: ['responsavel'], resultado: 'INCOMPLETO', encerramento: 'CONCLUIDA', resultadosPorCampo: {}, fontes: [], fontesNovas: [] };
  env.perfisDeLeads.save(id, { ...base, responsavel: { status: 'ENCONTRADO', nome: 'Pessoa Teste Alfa', cargo: 'Sócio-Administrador', origem: 'https://agregador-exemplo.com.br/empresas/1', confianca: 'MEDIA' }, enriquecimento: { status: 'INCOMPLETO', limiteDeTurnos: false, camposPendentes: [], camposNaoEncontrados: ['responsavel'], resolucao: { responsavel: { status: 'NAO_ENCONTRADO_COM_VERIFICACAO', resolvido: true, fontes: ['https://www.registro-exemplo.com.br/x'], citadas: ['https://www.registro-exemplo.com.br/x'], tentativas: [{ url: 'https://www.registro-exemplo.com.br/x', leitura: 'OK', pertinencia: 'PERTINENTE' }] } }, ultimaExecucao: historico, execucoes: [historico] } });
  const emDisco = JSON.stringify(env.perfisDeLeads.getById(id));
  const perfil = (await chamar(env, BRENO, { url: url(id, 'perfil') })).json().item;
  const estado = (await chamar(env, BRENO, { url: url(id) })).json().item;
  assert.equal(perfil.responsavel.status, 'PENDENTE_DE_CONFIRMACAO');
  assert.deepEqual([estado.resolucao.responsavel.status, estado.resolucao.responsavel.motivo], ['NAO_VERIFICADO', 'PENDENTE_DE_CONFIRMACAO']);
  assert.equal(estado.camposNaoEncontrados.includes('responsavel'), false);
  assert.equal(estado.camposPendentes.includes('responsavel'), true);
  assert.equal(estado.podeCompletar, true);
  assert.equal(JSON.stringify(env.perfisDeLeads.getById(id)), emDisco, 'nada foi reescrito');

  // o painel, alimentado com a MESMA resposta da API, diz o mesmo que o perfil
  const { createEnrichmentPanel } = await import('../../dashboard/views/leadEnrichmentPanel.mjs');
  const { createBrowser } = require('../helpers/fakeDom');
  const browser = createBrowser();
  const painel = createEnrichmentPanel({ document: browser.document, api: { getLeadResearchStatus: async () => ({ item: estado }), completeLeadResearch: async () => assert.fail('não pesquisa'), reviewLeadSite: async () => assert.fail('x'), decideLeadSiteProposal: async () => assert.fail('x') }, prospectId: id, schedule: () => () => {} });
  browser.root.append(painel.element);
  await painel.load();
  await browser.flush();
  const tela = browser.root.textContent.replace(/\s+/g, ' ');
  assert.match(tela, /responsável: não verificado — responsável encontrado, mas o vínculo da fonte com a empresa não está demonstrado \(pendente de confirmação\)/);
  assert.doesNotMatch(tela, /Não encontrado após verificação documentada: [^.]*responsável/);
});
