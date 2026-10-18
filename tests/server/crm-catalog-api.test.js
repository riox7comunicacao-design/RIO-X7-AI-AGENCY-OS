// A API dos catálogos do CRM — Serviços, Nichos e Origens dos Leads (rotas /api/crm-catalogs/... de src/server/app.js — CRM 5.0, Fase 2B-1): a camada
// HTTP FINA sobre o Catalog Service. Peças REAIS: o Catalog Service de produção (fábrica em modo "file", env explícito), a ponte de autorização,
// o CRM Service e a autenticação (o único "double" é o fetch falso do Supabase Auth, na borda de rede). Nenhum arquivo do projeto é tocado: tudo
// vive em diretórios temporários. NUNCA o Supabase real.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const { montarAmbiente, BRENO, RAFAEL, EX_COLABORADOR } = require('./testEnv');
const { mapErrorToHttp, createApp } = require('../../src/server/app');
const { CatalogError } = require('../../src/crm/catalogDomain');
const { CATALOG_ERROR, CATALOG_KEYS } = require('../../src/crm/catalogConstants');

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

const base = (catalogo) => `/api/crm-catalogs/${catalogo}`;
const ambiente = (t, extras = {}) => montarAmbiente(t, { usuarios: [BRENO, RAFAEL, EX_COLABORADOR], crmCatalogs: true, ...extras });
const sha = (arquivo) => (fs.existsSync(arquivo) ? crypto.createHash('sha256').update(fs.readFileSync(arquivo)).digest('hex') : null);

const CASOS = Object.freeze({
  servicos: { nome: 'Site institucional', categoria: 'Web', precoReferencia: 1500, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'] },
  nichos: { nome: 'Estética', cor: 'azul' },
  origens: { nome: 'Indicação', canal: 'INDICACAO' },
});

test('[CATAPI-1] sem o Service injetado as rotas NÃO existem (404 ROUTE_NOT_FOUND, até autenticado) e o resto da API segue funcionando', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO] });
  for (const catalogo of CATALOG_KEYS) {
    const resposta = await chamar(env, BRENO, { url: base(catalogo) });
    assert.equal(resposta.status, 404);
    assert.equal(resposta.json().error.code, 'ROUTE_NOT_FOUND');
  }
  assert.equal((await chamar(env, BRENO, { url: '/api/me' })).status, 200);
});

test('[CATAPI-2] sem Authorization (ou com token inválido) -> 401 em TODA rota e método, antes de olhar o corpo', async (t) => {
  const env = ambiente(t);
  const id = encodeURIComponent('niche:00000000-0000-4000-8000-000000000001');
  const rotas = [
    ['GET', base('nichos')], ['POST', base('nichos')], ['POST', `${base('nichos')}/reorder`],
    ['GET', `${base('nichos')}/${id}`], ['PATCH', `${base('nichos')}/${id}`],
    ['POST', `${base('nichos')}/${id}/activate`], ['POST', `${base('nichos')}/${id}/deactivate`],
  ];
  for (const [method, url] of rotas) {
    const semAuth = await chamar(env, null, { method, url, body: method === 'GET' ? undefined : { nome: 'x' } });
    assert.equal(semAuth.status, 401, `${method} ${url}`);
    assert.equal(semAuth.json().error.code, 'UNAUTHENTICATED');
    const lixo = await chamar(env, null, { method, url, headers: { Authorization: 'Bearer token-que-nao-existe' }, body: method === 'GET' ? undefined : '{ isto não é json' });
    assert.equal(lixo.status, 401, `${method} ${url} com token inválido`);
  }
});

test('[CATAPI-3] ADMIN percorre o ciclo completo nos TRÊS catálogos: criar (201), listar, consultar com `emUso`, editar, desativar, reativar e reordenar', async (t) => {
  const env = ambiente(t);
  for (const catalogo of CATALOG_KEYS) {
    const criado = await chamar(env, BRENO, { method: 'POST', url: base(catalogo), body: CASOS[catalogo] });
    assert.equal(criado.status, 201, catalogo);
    const item = criado.json().item;
    assert.match(item.id, new RegExp(`^${{ servicos: 'service', nichos: 'niche', origens: 'origin' }[catalogo]}:`));
    assert.equal(item.ativo, true);
    assert.equal(item.ordem, 0);
    assert.equal(item.criadoPorNome, BRENO.name);
    const segundo = (await chamar(env, BRENO, { method: 'POST', url: base(catalogo), body: { nome: `Outro de ${catalogo}`, ...(catalogo === 'servicos' ? { permitePagamentoUnico: true } : {}) } })).json().item;
    assert.equal(segundo.ordem, 1);

    const lista = await chamar(env, BRENO, { url: base(catalogo) });
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.json().items.map((i) => i.id), [item.id, segundo.id]);
    const um = await chamar(env, BRENO, { url: `${base(catalogo)}/${encodeURIComponent(item.id)}` });
    assert.equal(um.status, 200);
    assert.equal(um.json().item.emUso, 0);

    const editado = await chamar(env, BRENO, { method: 'PATCH', url: `${base(catalogo)}/${encodeURIComponent(item.id)}`, body: { descricao: 'Texto novo' } });
    assert.equal(editado.status, 200);
    assert.equal(editado.json().item.descricao, 'Texto novo');
    assert.equal(editado.json().item.id, item.id);

    const off = await chamar(env, BRENO, { method: 'POST', url: `${base(catalogo)}/${encodeURIComponent(item.id)}/deactivate`, body: {} });
    assert.equal(off.status, 200);
    assert.equal(off.json().item.ativo, false);
    assert.deepEqual((await chamar(env, BRENO, { url: base(catalogo) })).json().items.map((i) => i.id), [segundo.id], 'o desativado sai da lista padrão');
    assert.deepEqual((await chamar(env, BRENO, { url: `${base(catalogo)}?todos=1` })).json().items.map((i) => i.id), [item.id, segundo.id]);
    const on = await chamar(env, BRENO, { method: 'POST', url: `${base(catalogo)}/${encodeURIComponent(item.id)}/activate`, body: {} });
    assert.equal(on.json().item.ativo, true);

    const reordenado = await chamar(env, BRENO, { method: 'POST', url: `${base(catalogo)}/reorder`, body: { orderedIds: [segundo.id, item.id] } });
    assert.equal(reordenado.status, 200);
    assert.deepEqual(reordenado.json().items.map((i) => [i.id, i.ordem]), [[segundo.id, 0], [item.id, 1]]);
  }
});

test('[CATAPI-4] COMMERCIAL_CLOSER lê os ATIVOS (sem auditoria nem `emUso`), não vê desativados (404) e recebe 403 em toda escrita e no `?todos=1` — mesmo chamando a API direto', async (t) => {
  const env = ambiente(t);
  const ativo = (await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: 'Ativo' } })).json().item;
  const inativo = (await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: 'Desativado' } })).json().item;
  await chamar(env, BRENO, { method: 'POST', url: `${base('nichos')}/${encodeURIComponent(inativo.id)}/deactivate`, body: {} });

  const lista = await chamar(env, RAFAEL, { url: base('nichos') });
  assert.equal(lista.status, 200);
  assert.deepEqual(lista.json().items.map((i) => i.nome), ['Ativo']);
  for (const campo of ['criadoPorUserId', 'criadoPorNome', 'atualizadoPorUserId', 'atualizadoPorNome']) assert.equal(campo in lista.json().items[0], false, campo);
  const um = await chamar(env, RAFAEL, { url: `${base('nichos')}/${encodeURIComponent(ativo.id)}` });
  assert.equal(um.status, 200);
  assert.equal('emUso' in um.json().item, false);
  const oculto = await chamar(env, RAFAEL, { url: `${base('nichos')}/${encodeURIComponent(inativo.id)}` });
  assert.equal(oculto.status, 404);
  assert.equal(oculto.json().error.code, 'CRM_CATALOG_NOT_FOUND');

  const id = encodeURIComponent(ativo.id);
  for (const [method, url, body] of [
    ['POST', base('nichos'), { nome: 'Invasor' }],
    ['PATCH', `${base('nichos')}/${id}`, { descricao: 'x' }],
    ['POST', `${base('nichos')}/${id}/deactivate`, {}],
    ['POST', `${base('nichos')}/${id}/activate`, {}],
    ['POST', `${base('nichos')}/reorder`, { orderedIds: [ativo.id] }],
    ['GET', `${base('nichos')}?todos=1`, undefined],
  ]) {
    const resposta = await chamar(env, RAFAEL, { method, url, body });
    assert.equal(resposta.status, 403, `${method} ${url}`);
    assert.equal(resposta.json().error.code, 'FORBIDDEN');
    assert.equal(resposta.json().error.message, 'Esta conta não possui acesso a esta área.');
  }
  assert.deepEqual((await chamar(env, BRENO, { url: `${base('nichos')}?todos=1` })).json().items.map((i) => [i.nome, i.ativo]), [['Ativo', true], ['Desativado', false]], 'nada foi alterado pelas tentativas');
});

test('[CATAPI-5] usuário INATIVO recebe 403 INACTIVE em toda rota, leitura inclusive', async (t) => {
  const env = ambiente(t);
  for (const [method, url, body] of [['GET', base('origens'), undefined], ['POST', base('origens'), { nome: 'x' }], ['GET', `${base('origens')}?todos=1`, undefined]]) {
    const resposta = await chamar(env, EX_COLABORADOR, { method, url, body });
    assert.equal(resposta.status, 403, `${method} ${url}`);
    assert.equal(resposta.json().error.code, 'INACTIVE');
  }
});

test('[CATAPI-6] ROTEAMENTO: catálogo desconhecido, caixa diferente, barra final e caminhos fundos são 404; método errado é 405 com Allow; NÃO existe rota DELETE em lugar nenhum (excluir é desativar)', async (t) => {
  const env = ambiente(t);
  const id = encodeURIComponent('niche:00000000-0000-4000-8000-000000000001');
  for (const url of ['/api/crm-catalogs', '/api/crm-catalogs/', '/api/crm-catalogs/clientes', '/api/crm-catalogs/NICHOS', '/api/crm-catalogs/nichos/', `/api/crm-catalogs/nichos/${id}/extra`, `/api/crm-catalogs/nichos/${id}/activate/x`, '/api/crm-catalogs/nichos/reorder/x', '/api/crm-catalogs/__proto__', '/api/crm-catalogs/constructor']) {
    const resposta = await chamar(env, BRENO, { url });
    assert.equal(resposta.status, 404, url);
    assert.equal(resposta.json().error.code, 'ROUTE_NOT_FOUND', url);
  }
  const metodos = [
    ['DELETE', base('nichos'), 'GET, POST'], ['PUT', base('nichos'), 'GET, POST'], ['PATCH', base('nichos'), 'GET, POST'],
    ['DELETE', `${base('nichos')}/${id}`, 'GET, PATCH'], ['PUT', `${base('nichos')}/${id}`, 'GET, PATCH'], ['POST', `${base('nichos')}/${id}`, 'GET, PATCH'],
    ['GET', `${base('nichos')}/reorder`, 'POST'], ['DELETE', `${base('nichos')}/reorder`, 'POST'],
    ['GET', `${base('nichos')}/${id}/activate`, 'POST'], ['DELETE', `${base('nichos')}/${id}/deactivate`, 'POST'], ['PATCH', `${base('nichos')}/${id}/activate`, 'POST'],
  ];
  for (const [method, url, permitidos] of metodos) {
    const resposta = await chamar(env, BRENO, { method, url, body: {} });
    assert.equal(resposta.status, 405, `${method} ${url}`);
    assert.equal(resposta.headers.Allow, permitidos, `${method} ${url}`);
    assert.equal(resposta.json().error.code, 'METHOD_NOT_ALLOWED');
  }
});

test('[CATAPI-7] SEM CONFLITO com /api/crm: /api/crm/catalogs continua sendo a rota de um REGISTRO (id "catalogs" -> 404 do CRM, nunca a lista de catálogos); o CRM segue igual', async (t) => {
  const env = ambiente(t, { crm: true });
  await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: 'Estética' } });
  const comoRegistro = await chamar(env, BRENO, { url: '/api/crm/catalogs' });
  assert.equal(comoRegistro.status, 404);
  assert.equal(comoRegistro.json().error.code, 'NOT_FOUND', 'o erro é o do CRM, não CRM_CATALOG_NOT_FOUND');
  assert.equal(JSON.stringify(comoRegistro.json()).includes('Estética'), false, 'e nada do catálogo vaza por ali');
  for (const url of ['/api/crm/catalogs/nichos', '/api/crm/nichos', '/api/crm/catalogs/reorder']) assert.equal((await chamar(env, BRENO, { url })).status, 404, url);
  const lista = await chamar(env, BRENO, { url: '/api/crm' });
  assert.equal(lista.status, 200);
  assert.deepEqual(lista.json(), { items: [] });
  const criado = await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { tipoPessoa: 'PJ', empresa: 'Empresa Teste' } });
  assert.equal(criado.status, 201);
  assert.equal((await chamar(env, BRENO, { url: `/api/crm/${encodeURIComponent(criado.json().item.id)}` })).json().item.empresa, 'Empresa Teste');
});

test('[CATAPI-8] QUERY: só `?todos=0|1` na listagem, uma vez; qualquer outro parâmetro ou valor, e qualquer query nas demais rotas, é 400', async (t) => {
  const env = ambiente(t);
  const item = (await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: 'Estética' } })).json().item;
  const id = encodeURIComponent(item.id);
  for (const url of [`${base('nichos')}?todos=0`, `${base('nichos')}?todos=1`, base('nichos')]) assert.equal((await chamar(env, BRENO, { url })).status, 200, url);
  for (const url of [`${base('nichos')}?todos=2`, `${base('nichos')}?todos=true`, `${base('nichos')}?todos=`, `${base('nichos')}?foo=1`, `${base('nichos')}?todos=1&todos=0`, `${base('nichos')}?todos=1&x=1`, `${base('nichos')}/${id}?todos=1`, `${base('nichos')}/${id}?x=1`]) {
    const resposta = await chamar(env, BRENO, { url });
    assert.equal(resposta.status, 400, url);
    assert.equal(resposta.json().error.code, 'INVALID_REQUEST');
    assert.equal(resposta.json().error.message, 'Parâmetros não permitidos.');
  }
  for (const [method, url] of [['POST', `${base('nichos')}?todos=1`], ['POST', `${base('nichos')}/reorder?x=1`], ['PATCH', `${base('nichos')}/${id}?x=1`], ['POST', `${base('nichos')}/${id}/deactivate?x=1`]]) {
    assert.equal((await chamar(env, BRENO, { method, url, body: {} })).status, 400, `${method} ${url}`);
  }
});

test('[CATAPI-9] CORPO ESTRITO: sem content-type JSON é 415; JSON inválido, corpo que não é objeto e corpo grande demais são 400/413; ações aceitam só {}; reordenar aceita só `orderedIds`', async (t) => {
  const env = ambiente(t);
  const item = (await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: 'Estética' } })).json().item;
  const id = encodeURIComponent(item.id);
  for (const contentType of [null, 'text/plain', 'application/x-www-form-urlencoded', 'application/xml']) {
    const resposta = await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: 'Outro' }, contentType });
    assert.equal(resposta.status, 415, String(contentType));
    assert.equal(resposta.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
  }
  const invalido = await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: '{ isto não é json' });
  assert.equal(invalido.status, 400);
  assert.equal(invalido.json().error.message, 'JSON inválido.');
  for (const naoObjeto of ['[]', 'null', '"texto"', '12', 'true']) {
    const resposta = await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: naoObjeto });
    assert.equal(resposta.status, 400, naoObjeto);
    assert.equal(resposta.json().error.message, 'O corpo deve ser um objeto JSON.');
  }
  const grande = await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: 'x', descricao: 'a'.repeat(20000) } });
  assert.equal(grande.status, 413);
  assert.equal(grande.json().error.code, 'PAYLOAD_TOO_LARGE');
  // ações: só o objeto vazio
  for (const acao of ['activate', 'deactivate']) {
    const comCampo = await chamar(env, BRENO, { method: 'POST', url: `${base('nichos')}/${id}/${acao}`, body: { ativo: false } });
    assert.equal(comCampo.status, 400, acao);
    assert.equal(comCampo.json().error.message, 'Campos não permitidos na requisição.');
    assert.equal((await chamar(env, BRENO, { method: 'POST', url: `${base('nichos')}/${id}/${acao}`, body: {} })).status, 200, acao);
  }
  // reordenar: só `orderedIds`
  const extra = await chamar(env, BRENO, { method: 'POST', url: `${base('nichos')}/reorder`, body: { orderedIds: [item.id], userId: 'x' } });
  assert.equal(extra.status, 400);
  assert.equal(extra.json().error.message, 'Campos não permitidos na requisição.');
  for (const corpo of [{}, { orderedIds: 'x' }, { orderedIds: [item.id, item.id] }, { orderedIds: [] }, { orderedIds: [5] }, { orderedIds: null }]) {
    const resposta = await chamar(env, BRENO, { method: 'POST', url: `${base('nichos')}/reorder`, body: corpo });
    assert.equal(resposta.status, 400, JSON.stringify(corpo));
    assert.equal(resposta.json().error.code, 'CRM_CATALOG_INVALID_INPUT');
    assert.deepEqual(resposta.json().error.details, [{ path: 'orderedIds', code: 'LISTA_INVALIDA' }]);
  }
});

test('[CATAPI-10] VALIDAÇÃO: 400 CRM_CATALOG_INVALID_INPUT com mensagem fixa e `details` = só { path, code } — nunca o valor recusado; campos de identidade e de auditoria no corpo são recusados', async (t) => {
  const env = ambiente(t);
  const segredo = 'VALOR-SECRETO-NAO-PODE-VAZAR';
  const resposta = await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: segredo.repeat(5), cor: segredo, descricao: 5, desconhecido: segredo } });
  assert.equal(resposta.status, 400);
  const erro = resposta.json().error;
  assert.equal(erro.code, 'CRM_CATALOG_INVALID_INPUT');
  assert.equal(erro.message, 'Os dados do cadastro são inválidos.');
  assert.deepEqual(erro.details.map((d) => `${d.path}:${d.code}`).sort(), ['cor:VALOR_INVALIDO', 'desconhecido:CAMPO_DESCONHECIDO', 'descricao:TIPO_INVALIDO', 'nome:MUITO_LONGO']);
  for (const detalhe of erro.details) assert.deepEqual(Object.keys(detalhe).sort(), ['code', 'path']);
  assert.equal(resposta.text.includes('SECRETO'), false, 'nada do que foi enviado volta na resposta');
  for (const campo of ['id', 'ativo', 'ordem', 'criadoEm', 'criadoPorNome', 'atualizadoPorUserId', 'nomeNormalizado', 'userId', 'role', 'permissions', 'reviewedBy']) {
    const r = await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: `Item ${campo}`, [campo]: 'Impostor' } });
    assert.equal(r.status, 400, campo);
    assert.equal(r.json().error.code, 'CRM_CATALOG_INVALID_INPUT', campo);
  }
  assert.deepEqual((await chamar(env, BRENO, { url: base('nichos') })).json().items, [], 'nenhuma das tentativas criou um item');
});

test('[CATAPI-11] ERROS DE ESTADO: nome duplicado (mesmo de desativado) é 409; item inexistente é 404; id mal codificado é 400; mensagens fixas em português', async (t) => {
  const env = ambiente(t);
  const item = (await chamar(env, BRENO, { method: 'POST', url: base('origens'), body: { nome: 'Indicação' } })).json().item;
  const duplicado = await chamar(env, BRENO, { method: 'POST', url: base('origens'), body: { nome: 'INDICAÇÃO' } });
  assert.equal(duplicado.status, 409);
  assert.equal(duplicado.json().error.code, 'CRM_CATALOG_DUPLICATE_NAME');
  assert.equal(duplicado.json().error.message, 'Já existe um item com este nome (mesmo desativado).');
  assert.equal(duplicado.text.includes(item.id), false, 'o id do outro item não vaza');
  await chamar(env, BRENO, { method: 'POST', url: `${base('origens')}/${encodeURIComponent(item.id)}/deactivate`, body: {} });
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: base('origens'), body: { nome: 'indicacao' } })).status, 409, 'o desativado segura o nome');
  const outro = (await chamar(env, BRENO, { method: 'POST', url: base('origens'), body: { nome: 'Parceria' } })).json().item;
  const renomeado = await chamar(env, BRENO, { method: 'PATCH', url: `${base('origens')}/${encodeURIComponent(outro.id)}`, body: { nome: 'Indicação!' } });
  assert.equal(renomeado.status, 409);
  assert.equal(renomeado.json().error.code, 'CRM_CATALOG_DUPLICATE_NAME');

  for (const [method, url, body] of [['GET', `${base('origens')}/origin%3Ainexistente`], ['PATCH', `${base('origens')}/origin%3Ainexistente`, { descricao: 'x' }], ['POST', `${base('origens')}/origin%3Ainexistente/activate`, {}], ['POST', `${base('origens')}/origin%3Ainexistente/deactivate`, {}]]) {
    const resposta = await chamar(env, BRENO, { method, url, body });
    assert.equal(resposta.status, 404, `${method} ${url}`);
    assert.equal(resposta.json().error.code, 'CRM_CATALOG_NOT_FOUND');
    assert.equal(resposta.json().error.message, 'Item do cadastro não encontrado.');
  }
  const malCodificado = await chamar(env, BRENO, { url: `${base('origens')}/%E0%A4%A` });
  assert.equal(malCodificado.status, 400);
  assert.equal(malCodificado.json().error.message, 'Identificador inválido.');
});

test('[CATAPI-12] TRAVA DE RENOMEAÇÃO de ponta a ponta (decisão D3): um nicho usado por um registro do CRM não muda de nome (409 NAME_IN_USE, com o `emUso` visível); liberado o registro, o nome pode mudar — e o id continua o mesmo', async (t) => {
  const env = ambiente(t, { crm: true });
  const nicho = (await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: 'Estética' } })).json().item;
  const url = `${base('nichos')}/${encodeURIComponent(nicho.id)}`;
  assert.equal((await chamar(env, BRENO, { url })).json().item.emUso, 0);
  const registro = (await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { tipoPessoa: 'PJ', empresa: 'Clínica Bella', nicho: 'ESTÉTICA' } })).json().item;
  assert.equal((await chamar(env, BRENO, { url })).json().item.emUso, 1, 'o uso conta com a mesma normalização do nome');

  const bloqueado = await chamar(env, BRENO, { method: 'PATCH', url, body: { nome: 'Beleza' } });
  assert.equal(bloqueado.status, 409);
  assert.equal(bloqueado.json().error.code, 'CRM_CATALOG_NAME_IN_USE');
  assert.equal(bloqueado.json().error.message, 'Este item já é usado em registros do CRM e o nome não pode ser alterado nesta fase.');
  assert.equal((await chamar(env, BRENO, { url })).json().item.nome, 'Estética');
  // o resto da edição, a desativação e a ordem seguem livres
  assert.equal((await chamar(env, BRENO, { method: 'PATCH', url, body: { cor: 'rosa', descricao: 'Livre' } })).status, 200);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: `${url}/deactivate`, body: {} })).status, 200);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: `${url}/activate`, body: {} })).status, 200);

  // liberando o registro (outro valor no campo legado), o nome pode mudar
  const livre = await chamar(env, BRENO, { method: 'PATCH', url: `/api/crm/${encodeURIComponent(registro.id)}`, body: { nicho: 'Outro texto livre' } });
  assert.equal(livre.status, 200);
  assert.equal((await chamar(env, BRENO, { url })).json().item.emUso, 0);
  const renomeado = await chamar(env, BRENO, { method: 'PATCH', url, body: { nome: 'Beleza' } });
  assert.equal(renomeado.status, 200);
  assert.equal(renomeado.json().item.nome, 'Beleza');
  assert.equal(renomeado.json().item.id, nicho.id, 'o identificador é estável');
});

test('[CATAPI-13] COMPATIBILIDADE COM O CRM LEGADO: os campos nicho, origem e servicoPotencial seguem TEXTO LIVRE — o CRM aceita e devolve exatamente o digitado, existam ou não itens nos catálogos — e operar os catálogos nunca altera o arquivo do CRM', async (t) => {
  const env = ambiente(t, { crm: true });
  for (const catalogo of CATALOG_KEYS) await chamar(env, BRENO, { method: 'POST', url: base(catalogo), body: CASOS[catalogo] });
  const livre = { tipoPessoa: 'PJ', empresa: 'Empresa Livre', nicho: 'Clinica de EStética', origem: 'Boca a boca', servicoPotencial: 'Qualquer coisa que não está em catálogo' };
  const criado = await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: livre });
  assert.equal(criado.status, 201, 'o CRM não valida contra os catálogos');
  const lido = (await chamar(env, BRENO, { url: `/api/crm/${encodeURIComponent(criado.json().item.id)}` })).json().item;
  for (const campo of ['nicho', 'origem', 'servicoPotencial']) assert.equal(lido[campo], livre[campo], campo);
  const editado = await chamar(env, BRENO, { method: 'PATCH', url: `/api/crm/${encodeURIComponent(lido.id)}`, body: { nicho: 'Estética', origem: 'Indicação' } });
  assert.equal(editado.status, 200);
  assert.equal(editado.json().item.nicho, 'Estética');
  // nenhum campo novo no registro (nada de nicheId/serviceId/originId)
  for (const campo of Object.keys(lido)) assert.doesNotMatch(campo, /^(niche|service|origin|nicho|servico|origem)Id$/);

  const antes = sha(env.crmFilePath);
  assert.ok(antes, 'o arquivo do CRM existe');
  const nicho = (await chamar(env, BRENO, { url: base('nichos') })).json().items[0];
  const url = `${base('nichos')}/${encodeURIComponent(nicho.id)}`;
  await chamar(env, BRENO, { method: 'POST', url: base('origens'), body: { nome: 'Nova origem' } });
  await chamar(env, BRENO, { method: 'PATCH', url, body: { descricao: 'Alterada' } });
  await chamar(env, BRENO, { method: 'POST', url: `${url}/deactivate`, body: {} });
  await chamar(env, BRENO, { method: 'POST', url: `${url}/activate`, body: {} });
  assert.equal(sha(env.crmFilePath), antes, 'o arquivo do CRM não mudou um byte');
  assert.notEqual(env.crmFilePath, env.crmCatalogFilePath, 'catálogos e CRM têm arquivos distintos');
});

test('[CATAPI-14] NÃO INTERFERE em Prospecção, Fila de Aprovação, Funis nem no CRM: com o Service de catálogos presente, essas rotas funcionam e NUNCA o chamam', async (t) => {
  const chamadas = [];
  const espiao = Object.fromEntries(['list', 'get', 'create', 'update', 'activate', 'deactivate', 'reorder'].map((nome) => [nome, async (...args) => (chamadas.push(nome), args.length ? { id: 'x' } : null)]));
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, funnels: true, integracao: true, prospeccao: true, crmCatalogService: espiao });
  const fila = await chamar(env, BRENO, { url: '/api/approvals' });
  assert.equal(fila.status, 200);
  assert.equal(fila.json().items.length, 2, 'a Fila de Aprovação continua mostrando os itens aguardando revisão');
  assert.equal((await chamar(env, BRENO, { url: '/api/me' })).status, 200);
  assert.equal((await chamar(env, BRENO, { url: '/api/crm' })).status, 200);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { tipoPessoa: 'PJ', empresa: 'Empresa Qualquer', nicho: 'Texto livre' } })).status, 201);
  assert.equal((await chamar(env, BRENO, { url: '/api/funnels' })).status, 200);
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'Outbound' } })).status, 201);
  const promocao = await chamar(env, BRENO, { method: 'POST', url: `/api/approvals/${encodeURIComponent(env.ids.alfa)}/approve`, body: {} });
  assert.equal(promocao.status, 200);
  const promovido = await chamar(env, BRENO, { method: 'POST', url: `/api/approvals/${encodeURIComponent(env.ids.alfa)}/promote`, body: {} });
  assert.equal(promovido.status, 200, 'a promoção Fila -> CRM funciona como sempre');
  assert.deepEqual(chamadas, [], 'nenhuma dessas operações chamou o Service de catálogos');
  // as rotas de catálogo chamam exatamente a operação correspondente
  await chamar(env, BRENO, { url: base('nichos') });
  await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: 'x' } });
  assert.deepEqual(chamadas, ['list', 'create']);
});

test('[CATAPI-15] tradução de erros: cada código do domínio tem status e mensagem FIXOS; uma validação carrega só caminho e código; falha de armazenamento é 503; erro desconhecido (inclusive um `code` parecido) é 500 genérico — sem vazar o texto original', async (t) => {
  const esperado = {
    [CATALOG_ERROR.INVALID_INPUT]: [400, 'Os dados do cadastro são inválidos.'],
    [CATALOG_ERROR.NOT_FOUND]: [404, 'Item do cadastro não encontrado.'],
    [CATALOG_ERROR.DUPLICATE_NAME]: [409, 'Já existe um item com este nome (mesmo desativado).'],
    [CATALOG_ERROR.NAME_IN_USE]: [409, 'Este item já é usado em registros do CRM e o nome não pode ser alterado nesta fase.'],
    [CATALOG_ERROR.PERSISTENCE]: [503, 'Não foi possível ler ou gravar os cadastros agora. Tente novamente em instantes.'],
  };
  assert.deepEqual(Object.keys(esperado).sort(), Object.values(CATALOG_ERROR).sort(), 'todo código do domínio está coberto');
  for (const [code, [status, message]] of Object.entries(esperado)) {
    const falha = mapErrorToHttp(new CatalogError(code, 'TEXTO INTERNO SEGREDO'));
    assert.equal(falha.status, status, code);
    assert.equal(falha.code, code);
    assert.equal(falha.message, message);
    assert.doesNotMatch(JSON.stringify(falha), /SEGREDO/);
  }
  const comDetalhes = mapErrorToHttp(new CatalogError(CATALOG_ERROR.INVALID_INPUT, 'x', { errors: [{ path: 'nome', code: 'OBRIGATORIO' }, { path: '<script>', code: 'x-y', valor: 'SEGREDO' }] }));
  assert.deepEqual(comDetalhes.details, [{ path: 'nome', code: 'OBRIGATORIO' }, { path: '', code: 'INVALIDO' }], 'caminho e código são conferidos de novo, e o resto nunca passa');
  assert.equal(mapErrorToHttp(new CatalogError(CATALOG_ERROR.PERSISTENCE, 'x', { errors: [{ path: 'a', code: 'B' }] })).details, undefined, 'só a recusa de validação leva detalhes');
  for (const estranho of [{ code: 'CRM_CATALOG_OUTRA_COISA' }, { code: '__proto__' }, { code: 'constructor' }, { code: 'CRM_CATALOG' }, new Error('CRM_CATALOG_NOT_FOUND'), { code: ['CRM_CATALOG_NOT_FOUND'] }]) {
    const falha = mapErrorToHttp(estranho);
    assert.equal(falha.status, 500, JSON.stringify(estranho));
    assert.equal(falha.code, 'INTERNAL');
  }

  // pela API, com um Service que lança
  const quebrado = { list: async () => { throw new CatalogError(CATALOG_ERROR.PERSISTENCE, 'Cadastro: não foi possível ler ou gravar os dados.'); }, get: async () => { throw new Error('boom SEGREDO-DE-INFRA'); }, create: async () => ({}), update: async () => ({}), activate: async () => ({}), deactivate: async () => ({}), reorder: async () => [] };
  const env = montarAmbiente(t, { usuarios: [BRENO], crmCatalogService: quebrado });
  const persistencia = await chamar(env, BRENO, { url: base('nichos') });
  assert.equal(persistencia.status, 503);
  assert.equal(persistencia.json().error.code, 'CRM_CATALOG_PERSISTENCE');
  const interno = await chamar(env, BRENO, { url: `${base('nichos')}/niche%3Ax` });
  assert.equal(interno.status, 500);
  assert.equal(interno.json().error.code, 'INTERNAL');
  assert.equal(interno.text.includes('SEGREDO'), false);
});

test('[CATAPI-16] a rota só existe se o Service injetado é COMPLETO (as 7 operações): faltar uma, ou ser nulo, derruba a criação do app; `undefined` simplesmente desliga as rotas', (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO] });
  const completo = Object.fromEntries(['list', 'get', 'create', 'update', 'activate', 'deactivate', 'reorder'].map((nome) => [nome, async () => ({})]));
  const dependencias = { verifyAccessToken: env.verifyAccessToken, userStore: env.userStore, approvalQueueService: env.approvalQueueService, publicConfig: env.publicConfig, staticRoot: env.staticRoot, staticFiles: env.staticFiles };
  assert.ok(createApp({ ...dependencias, crmCatalogService: completo }));
  assert.ok(createApp({ ...dependencias, crmCatalogService: undefined }));
  for (const operacao of Object.keys(completo)) {
    const parcial = { ...completo };
    delete parcial[operacao];
    assert.throws(() => createApp({ ...dependencias, crmCatalogService: parcial }), new RegExp(`exige \\{ crmCatalogService \\} com ${operacao}\\(\\)`));
  }
  assert.throws(() => createApp({ ...dependencias, crmCatalogService: null }), /exige \{ crmCatalogService \}/);
});

test('[CATAPI-17] as chaves da URL são exatamente as do domínio (servicos | nichos | origens) — e só elas', async (t) => {
  const env = ambiente(t);
  for (const catalogo of CATALOG_KEYS) assert.equal((await chamar(env, BRENO, { url: base(catalogo) })).status, 200, catalogo);
  for (const naoCatalogo of ['clientes', 'servico', 'niche', 'origem', 'funis', 'leads', 'catalogos']) assert.equal((await chamar(env, BRENO, { url: base(naoCatalogo) })).status, 404, naoCatalogo);
});

test('[CATAPI-18] toda resposta sai com os cabeçalhos de segurança e o CSP (style-src \'self\'), JSON em UTF-8 e sem cache — os dados dos catálogos nunca são armazenados em cache', async (t) => {
  const env = ambiente(t);
  for (const resposta of [await chamar(env, BRENO, { url: base('nichos') }), await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: 'Estética' } }), await chamar(env, null, { url: base('nichos') }), await chamar(env, BRENO, { url: '/api/crm-catalogs/x' })]) {
    assert.match(resposta.headers['Content-Type'], /^application\/json; charset=utf-8$/);
    assert.equal(resposta.headers['Cache-Control'], 'no-store');
    assert.match(resposta.headers['Content-Security-Policy'], /style-src 'self'/);
    assert.equal(resposta.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(resposta.headers['X-Frame-Options'], 'DENY');
  }
});

test('[CATAPI-19] CONCORRÊNCIA pela API: 12 criações simultâneas do mesmo nome resultam em um 201 e onze 409; o catálogo fica com um item só', async (t) => {
  const env = ambiente(t);
  const respostas = await Promise.all(Array.from({ length: 12 }, (_, i) => chamar(env, BRENO, { method: 'POST', url: base('origens'), body: { nome: i % 2 ? 'Meta Ads' : 'meta-ads' } })));
  assert.equal(respostas.filter((r) => r.status === 201).length, 1);
  assert.equal(respostas.filter((r) => r.status === 409).length, 11);
  assert.equal((await chamar(env, BRENO, { url: base('origens') })).json().items.length, 1);
});

test('[CATAPI-20] o LOG de acesso registra só método, rota com :catalogo/:id no lugar dos valores, status e usuário — nunca o id do item, o nome digitado nem o token', async (t) => {
  const env = ambiente(t);
  const item = (await chamar(env, BRENO, { method: 'POST', url: base('nichos'), body: { nome: 'Nome Muito Específico' } })).json().item;
  await chamar(env, BRENO, { method: 'PATCH', url: `${base('nichos')}/${encodeURIComponent(item.id)}`, body: { descricao: 'Texto sigiloso' } });
  await chamar(env, BRENO, { method: 'POST', url: `${base('nichos')}/${encodeURIComponent(item.id)}/deactivate`, body: {} });
  const log = env.logs.join('\n');
  assert.match(log, /POST \/api\/crm-catalogs\/:catalogo 201 user=user-breno/);
  assert.match(log, /PATCH \/api\/crm-catalogs\/:catalogo\/:id 200/);
  assert.match(log, /POST \/api\/crm-catalogs\/:catalogo\/:id\/deactivate 200/);
  assert.equal(log.includes(item.id), false);
  assert.equal(log.includes('Específico'), false);
  assert.equal(log.includes('sigiloso'), false);
  assert.equal(log.includes(env.tokenFor(BRENO.userId)), false);
});
