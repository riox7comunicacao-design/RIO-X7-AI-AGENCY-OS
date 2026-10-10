// API da decisão humana sobre a PROPOSTA de novo site oficial (POST /api/leads/:id/proposta-site — Implementação 3.0.2, decisão final): nenhuma troca automática; CONFIRMAR / MANTER sem nova pesquisa;
// o usuário vem do token; uma decisão por proposta. Peças REAIS (fila, Service, perfil, autorização); nenhum motor, nenhuma rede, nenhum `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const { montarAmbiente, BRENO, RAFAEL, EX_COLABORADOR } = require('./testEnv');
const commercial = require('../../src/research-prospector/commercialProfile');

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

const ATUAL = 'https://consultorio-alfa.example.test/';
const NOVO = 'https://alfa-consultorio.com.br/';
const url = (id) => `/api/leads/${encodeURIComponent(id)}/proposta-site`;
const status = (id) => `/api/leads/${encodeURIComponent(id)}/completar-pesquisa`;

function montar(t) {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL, EX_COLABORADOR], crm: true, leadReconsideration: true, leadEnrichment: {} });
  const id = env.ids.alfa;
  const base = commercial.buildCommercialProfile({ empresa: 'Consultório Alfa', siteOficial: { status: 'ENCONTRADO', url: ATUAL }, pages: [], today: '2026-10-08' });
  env.perfisDeLeads.save(id, {
    ...base,
    propostaSite: { status: 'PENDENTE', criadaEm: '2026-10-08T12:00:00.000Z', dominioAtual: ATUAL, dominioNovo: NOVO, atualSustentado: true, evidencias: { atual: { url: ATUAL, comprovado: true, motivo: null, titulo: 'Consultório Alfa', vinculo: { dominio: true, titulo: true }, regra: 'dominio_e_nome' }, novo: { url: NOVO, comprovado: true, motivo: null, titulo: 'Consultório Alfa | Psicologia', vinculo: { dominio: true, titulo: true }, regra: 'dominio_e_nome' } }, fontes: [ATUAL, NOVO], dadosDoNovo: { telefones: [{ numero: '+552422223333', origem: NOVO }], whatsapps: [], emails: [], endereco: null, responsavel: null, presencaConfirmada: {} } },
  });
  return { env, id };
}

test('[PROPAPI-1] o estado mostra a proposta com as evidências dos DOIS domínios (sem os dados internos); CONFIRMAR troca o domínio, registra quem/quando, e a fila não muda; a 2ª decisão é 409', async (t) => {
  const { env, id } = montar(t);
  const filaAntes = fs.readFileSync(env.filePath, 'utf8');
  const antes = (await chamar(env, BRENO, { url: status(id) })).json().item;
  assert.equal(antes.podeDecidirSite, true);
  assert.deepEqual([antes.propostaSite.dominioAtual, antes.propostaSite.dominioNovo], [ATUAL, NOVO]);
  assert.equal(antes.propostaSite.evidencias.atual.comprovado, true);
  assert.equal(antes.propostaSite.evidencias.novo.titulo, 'Consultório Alfa | Psicologia');
  assert.equal('dadosDoNovo' in antes.propostaSite, false);
  assert.equal(env.perfisDeLeads.getById(id).siteOficial.url, ATUAL, 'antes da decisão o atual fica');

  const ok = await chamar(env, RAFAEL, { method: 'POST', url: url(id), body: { decisao: 'CONFIRMAR' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json().item.propostaSite, null);
  const perfil = (await chamar(env, BRENO, { url: `/api/leads/${encodeURIComponent(id)}/perfil` })).json().item;
  assert.equal(perfil.siteOficial.url, NOVO);
  assert.deepEqual([perfil.decisoesSite[0].decisao, perfil.decisoesSite[0].usuario.userId, perfil.decisoesSite[0].dominioAnterior, perfil.decisoesSite[0].dominioNovo], ['CONFIRMADA', RAFAEL.userId, ATUAL, NOVO]);
  assert.deepEqual(perfil.telefones.map((x) => x.numero), ['+552422223333']);
  assert.equal(fs.readFileSync(env.filePath, 'utf8'), filaAntes, 'Approval Queue intacta');

  const segunda = await chamar(env, BRENO, { method: 'POST', url: url(id), body: { decisao: 'CONFIRMAR' } });
  assert.equal(segunda.status, 409);
  assert.equal(segunda.json().error.code, 'ENRICH_NO_PROPOSAL');
  assert.equal(env.perfisDeLeads.getById(id).decisoesSite.length, 1);
});

test('[PROPAPI-2] MANTER preserva o domínio; o usuário NÃO vem do corpo (campo extra = 400); decisão inválida 400; sem login 401; conta inativa recusada; GET 405; lead inexistente 404; sem proposta 409', async (t) => {
  const { env, id } = montar(t);
  const antes = JSON.stringify(env.perfisDeLeads.getById(id));
  assert.equal((await chamar(env, null, { method: 'POST', url: url(id), body: { decisao: 'CONFIRMAR' } })).status, 401);
  assert.ok([401, 403].includes((await chamar(env, EX_COLABORADOR, { method: 'POST', url: url(id), body: { decisao: 'CONFIRMAR' } })).status));
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: url(id), body: { decisao: 'CONFIRMAR', usuario: 'outra-pessoa' } })).status, 400, 'a identidade nunca vem do corpo');
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: url(id), body: {} })).status, 400);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: url(id), body: { decisao: 'TALVEZ' } })).status, 400);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: url(id), body: { decisao: 5 } })).status, 400);
  assert.equal((await chamar(env, BRENO, { url: url(id) })).status, 405);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: url('nao-existe'), body: { decisao: 'MANTER' } })).status, 404);
  assert.equal(JSON.stringify(env.perfisDeLeads.getById(id)), antes, 'nenhuma tentativa recusada alterou o perfil');

  const mantida = await chamar(env, BRENO, { method: 'POST', url: url(id), body: { decisao: 'MANTER' } });
  assert.equal(mantida.status, 200);
  assert.equal(env.perfisDeLeads.getById(id).siteOficial.url, ATUAL);
  assert.equal(env.perfisDeLeads.getById(id).decisoesSite[0].decisao, 'MANTIDA');
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: url(env.ids.beta), body: { decisao: 'MANTER' } })).json().error.code, 'ENRICH_NO_PROPOSAL');
});
