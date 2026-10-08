// API dos leads reprovados e da reaprovação (rotas /api/leads/... de src/server/app.js — Implementação 3.0), mais o REFAZER do job e os contadores de decisão do
// resultado. Peças REAIS (fila, CRM, promoção, Service de reaprovação, ponte de autorização) em diretório temporário; nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

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

const ambiente = (t, opcoes = {}) => montarAmbiente(t, { crm: true, integracao: true, leadReconsideration: true, usuarios: [BRENO, RAFAEL], ...opcoes });

test('[LEADAPI-1] fluxo HTTP: rejeitar -> LEADS REPROVADOS -> perfil -> REAPROVAR -> aprovar (sem CRM) -> PROMOVER -> CRM, e promover de novo não duplica', async (t) => {
  const env = ambiente(t);
  const { alfa } = env.ids;
  env.perfisDeLeads.save(alfa, { empresa: 'Consultório Alfa', jobId: 'JOB-20261007-001', telefones: [{ numero: '+552422223333', origem: 'https://x.example.test/' }] });

  const rejeitado = await chamar(env, RAFAEL, { method: 'POST', url: `/api/approvals/${alfa}/reject`, body: { reason: 'Fora do ICP' } });
  assert.equal(rejeitado.status, 200);

  const lista = await chamar(env, BRENO, { url: '/api/leads/reprovados?filtro=REPROVADOS' });
  assert.equal(lista.status, 200);
  const itens = lista.json().items;
  assert.equal(itens.length, 1);
  assert.deepEqual([itens[0].prospectId, itens[0].estado, itens[0].reaprovavel, itens[0].motivo, itens[0].jobOrigem, itens[0].origemDaDecisao], [alfa, 'REJEITADO', true, 'Fora do ICP', 'JOB-20261007-001', 'HUMANO']);
  assert.equal(itens[0].reprovadoPor.userId, RAFAEL.userId);
  assert.equal(itens[0].perfil.telefones[0].numero, '+552422223333');

  const todos = await chamar(env, BRENO, { url: '/api/leads/reprovados' });
  assert.deepEqual(todos.json().items.map((l) => l.estado).sort(), ['DNC', 'REJEITADO'], 'o bloqueado por DNC aparece, mas como não reaprovável');
  assert.equal(todos.json().items.find((l) => l.estado === 'DNC').reaprovavel, false);

  const perfil = await chamar(env, BRENO, { url: `/api/leads/${encodeURIComponent(alfa)}/perfil` });
  assert.equal(perfil.json().item.empresa, 'Consultório Alfa');
  assert.equal((await chamar(env, BRENO, { url: `/api/leads/${encodeURIComponent(env.ids.beta)}/perfil` })).json().item, null);

  const volta = await chamar(env, BRENO, { method: 'POST', url: `/api/leads/reprovados/${encodeURIComponent(alfa)}/reaprovar`, body: { reason: 'Cliente pediu' } });
  assert.equal(volta.status, 200);
  assert.equal(volta.json().item.estado, 'AGUARDANDO_REVISAO');
  assert.equal((await chamar(env, BRENO, { url: '/api/leads/reprovados?filtro=REPROVADOS' })).json().items.length, 0);

  assert.equal((await chamar(env, RAFAEL, { method: 'POST', url: `/api/approvals/${alfa}/approve`, body: { reason: 'ok' } })).status, 200);
  assert.equal(require('node:fs').existsSync(env.crmFilePath), false, 'aprovar não cria CRM (o arquivo do CRM nem existe ainda)');
  const promovido = await chamar(env, BRENO, { method: 'POST', url: `/api/approvals/${alfa}/promote`, body: {} });
  assert.ok([200, 201].includes(promovido.status), promovido.text);
  await chamar(env, BRENO, { method: 'POST', url: `/api/approvals/${alfa}/promote`, body: {} });
  const crm = (await chamar(env, BRENO, { url: '/api/crm' })).json();
  assert.equal((crm.items || crm.records || []).length, 1, 'promover duas vezes não duplica');
});

test('[LEADAPI-2] erros estáveis: DNC e aprovado não são reaprováveis (409), filtro inválido (400), corpo com campo extra (400), id inexistente, sem login (401), método errado (405)', async (t) => {
  const env = ambiente(t);
  const dnc = await chamar(env, BRENO, { method: 'POST', url: `/api/leads/reprovados/${encodeURIComponent(env.ids.bloqueado)}/reaprovar`, body: {} });
  assert.equal(dnc.status, 409);
  assert.equal(dnc.json().error.code, 'RECON_NAO_REAPROVAVEL');
  assert.equal((await chamar(env, BRENO, { url: '/api/leads/reprovados?filtro=XYZ' })).status, 400);
  assert.equal((await chamar(env, BRENO, { url: '/api/leads/reprovados?outro=1' })).status, 400);
  const extra = await chamar(env, BRENO, { method: 'POST', url: `/api/leads/reprovados/${encodeURIComponent(env.ids.alfa)}/reaprovar`, body: { reviewedBy: 'x' } });
  assert.equal(extra.status, 400);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: '/api/leads/reprovados/inexistente/reaprovar', body: {} })).status >= 400, true);
  assert.equal((await chamar(env, null, { url: '/api/leads/reprovados' })).status, 401);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: '/api/leads/reprovados' })).status, 405);
});

test('[LEADAPI-3] sem o Service injetado as rotas não existem (404)', async (t) => {
  const env = ambiente(t, { leadReconsideration: false });
  assert.equal((await chamar(env, BRENO, { url: '/api/leads/reprovados' })).status, 404);
});

test('[LEADAPI-4] o campo comprovadoPorCodigo é reservado ao job: a colagem manual de achados (briefs/:id/findings e prospecting/submit) o RECUSA', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, prospeccao: true, prospectingBrief: true });
  const achado = { empresa: 'Clínica Falsa', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', fontes: ['https://x.example.test/'], comprovadoPorCodigo: true };
  const criado = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/briefs', body: { nicho: 'Estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis/RJ', quantidade: 3 } });
  const brief = criado.json().item;
  await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${encodeURIComponent(brief.id)}/ready`, body: {} });
  const manual = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${encodeURIComponent(brief.id)}/findings`, body: { rawFindings: [achado] } });
  assert.equal(manual.status, 400);
  assert.match(manual.text, /reservado ao sistema/);
  const submit = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/submit', body: { briefing: { nicho: 'Estética', regiao: 'Petrópolis/RJ', quantidadeDesejada: 3 }, rawFindings: [achado] } });
  assert.equal(submit.status, 400);
  assert.match(submit.text, /reservado ao sistema/);
});

test('[LEADAPI-5] o campo tipoLead (Implementação 3.0 — classificação EMPRESA/PROFISSIONAL/UNIDADE_FRANQUIA) também é reservado ao job: a colagem manual o RECUSA', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, prospeccao: true, prospectingBrief: true });
  const achado = { empresa: 'Clínica Falsa', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', fontes: ['https://x.example.test/'], tipoLead: 'EMPRESA' };
  const criado = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/briefs', body: { nicho: 'Estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis/RJ', quantidade: 3 } });
  const brief = criado.json().item;
  await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${encodeURIComponent(brief.id)}/ready`, body: {} });
  const manual = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/briefs/${encodeURIComponent(brief.id)}/findings`, body: { rawFindings: [achado] } });
  assert.equal(manual.status, 400);
  assert.match(manual.text, /reservado ao sistema/);
  const submit = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/submit', body: { briefing: { nicho: 'Estética', regiao: 'Petrópolis/RJ', quantidadeDesejada: 3 }, rawFindings: [achado] } });
  assert.equal(submit.status, 400);
  assert.match(submit.text, /reservado ao sistema/);
});
