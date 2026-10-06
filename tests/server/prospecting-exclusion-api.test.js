// Testes da API de Exclusões Permanentes de Prospecção (rotas /api/prospecting/exclusions de src/server/app.js —
// Workbench, Etapa 2). Sobre peças REAIS (Service real, ponte de autorização real, repositório de memória — esta
// funcionalidade não tem adapter de arquivo, ver testEnv.js).

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

async function chamar(env, usuario, { method = 'GET', url, body, headers = {}, contentType = 'application/json' } = {}) {
  const base = {};
  if (usuario) base.Authorization = `Bearer ${env.tokenFor(usuario.userId)}`;
  if (body !== undefined && contentType !== null) base['content-type'] = contentType;
  const response = await env.app.handle(makeRequest({ method, url, headers: { ...base, ...headers }, body }));
  return { status: response.status, headers: response.headers, text: response.body, json: () => JSON.parse(response.body) };
}

const forcaDigital = { empresa: 'Força Digital', motivo: 'Exclusão permanente de prospecção', cidade: 'Petrópolis', estado: 'RJ' };

function ambiente(t, extra = {}) {
  return montarAmbiente(t, { usuarios: [BRENO, RAFAEL], prospectingExclusion: true, ...extra });
}

test('[EXCL-API-1] sem Authorization -> 401; ADMIN cria (201), lista (200) e detalha (200) uma exclusão', async (t) => {
  const env = ambiente(t);
  assert.equal((await chamar(env, null, { url: '/api/prospecting/exclusions' })).status, 401);

  const criado = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/exclusions', body: forcaDigital });
  assert.equal(criado.status, 201);
  const exclusao = criado.json().item;
  assert.equal(exclusao.ativo, true);
  assert.equal(exclusao.empresaNomeNormalizado, 'forca digital');

  const lista = await chamar(env, BRENO, { url: '/api/prospecting/exclusions' });
  assert.equal(lista.status, 200);
  assert.equal(lista.json().items.length, 1);

  const detalhe = await chamar(env, BRENO, { url: `/api/prospecting/exclusions/${exclusao.id}` });
  assert.equal(detalhe.status, 200);
  assert.equal(detalhe.json().item.id, exclusao.id);
});

test('[EXCL-API-2] COMMERCIAL_CLOSER (sem MANAGE:PROSPECTING_EXCLUSIONS) recebe 403 em toda rota de gestão', async (t) => {
  const env = ambiente(t);
  const criado = (await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/exclusions', body: forcaDigital })).json().item;

  for (const requisicao of [
    { method: 'GET', url: '/api/prospecting/exclusions' },
    { method: 'POST', url: '/api/prospecting/exclusions', body: forcaDigital },
    { method: 'GET', url: `/api/prospecting/exclusions/${criado.id}` },
    { method: 'PATCH', url: `/api/prospecting/exclusions/${criado.id}`, body: { cidade: 'x' } },
    { method: 'POST', url: `/api/prospecting/exclusions/${criado.id}/deactivate`, body: {} },
    { method: 'POST', url: `/api/prospecting/exclusions/${criado.id}/activate`, body: {} },
  ]) {
    const resposta = await chamar(env, RAFAEL, requisicao);
    assert.equal(resposta.status, 403, `${requisicao.method} ${requisicao.url}`);
    assert.equal(resposta.json().error.code, 'FORBIDDEN');
  }
});

test('[EXCL-API-3] editar (PATCH), desativar e reativar; created_by_user_id nunca vem do cliente', async (t) => {
  const env = ambiente(t);
  // O corpo com campo forjado é INVÁLIDO (campo desconhecido) — recusado ANTES de gravar.
  const tentativaForjada = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/exclusions', body: { ...forcaDigital, criadoPorUserId: 'forjado' } });
  assert.equal(tentativaForjada.status, 400);

  const real = (await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/exclusions', body: forcaDigital })).json().item;
  assert.notEqual(real.criadoPorUserId, 'forjado');

  const editado = await chamar(env, BRENO, { method: 'PATCH', url: `/api/prospecting/exclusions/${real.id}`, body: { cidade: 'Teresópolis' } });
  assert.equal(editado.status, 200);
  assert.equal(editado.json().item.cidade, 'Teresópolis');

  const desativado = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/exclusions/${real.id}/deactivate`, body: {} });
  assert.equal(desativado.status, 200);
  assert.equal(desativado.json().item.ativo, false);

  const reativado = await chamar(env, BRENO, { method: 'POST', url: `/api/prospecting/exclusions/${real.id}/activate`, body: {} });
  assert.equal(reativado.status, 200);
  assert.equal(reativado.json().item.ativo, true);
});

test('[EXCL-API-4] erros: 404 (id inexistente), 400 (empresa/motivo ausente)', async (t) => {
  const env = ambiente(t);
  assert.equal((await chamar(env, BRENO, { url: '/api/prospecting/exclusions/00000000-0000-4000-8000-000000000000' })).status, 404);
  const invalido = await chamar(env, BRENO, { method: 'POST', url: '/api/prospecting/exclusions', body: { empresa: '' } });
  assert.equal(invalido.status, 400);
  assert.equal(invalido.json().error.code, 'EXCLUSION_INVALID_INPUT');
});

test('[EXCL-API-5] sem prospectingExclusionService injetado, as rotas não existem (404) — mesmo padrão de Funis/CRM/Workbench opcionais', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO] });
  const resposta = await chamar(env, BRENO, { url: '/api/prospecting/exclusions' });
  assert.equal(resposta.status, 404);
});
