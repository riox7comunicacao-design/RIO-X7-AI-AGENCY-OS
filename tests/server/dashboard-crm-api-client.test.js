// O cliente de API do Dashboard (dashboard/api.mjs), agora com o CRM: método, caminho e corpo de cada chamada; o token
// da sessão como ÚNICA identidade; e a recusa, ANTES de existir uma requisição, de qualquer chave que não seja um campo
// do registro (userId, authUserId, role, permissions, actor, reviewedBy, status, id, historico...).

const test = require('node:test');
const assert = require('node:assert/strict');

const loadApi = () => import('../../dashboard/api.mjs');

const ok = (body = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

// Um cliente com um fetch que registra as chamadas e responde com `responder`.
async function cliente(responder = () => ok({ items: [] }), extras = {}) {
  const { createApiClient } = await loadApi();
  const chamadas = [];
  const api = createApiClient({
    getAccessToken: async () => (extras.semToken ? null : 'token-de-teste-nao-real'),
    refreshAccessToken: extras.refresh || (async () => null),
    onSessionLost: extras.onSessionLost || (() => {}),
    fetchImpl: async (caminho, init) => {
      chamadas.push({ caminho, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body), cache: init.cache });
      return responder(chamadas.length, caminho, init);
    },
  });
  return { api, chamadas };
}

test('[DASH-API-1] cada chamada do CRM usa o método, o caminho e o corpo do contrato da CRM-API (o id vai codificado; motivo vazio não é enviado)', async () => {
  const { api, chamadas } = await cliente();
  await api.listCrm();
  await api.getCrm('crm:abc def/x');
  await api.getCrmHistory('crm:abc');
  await api.createCrm({ empresa: 'Clínica Nova', site: 'nova.example.test' }, { status: 'CONTACTED', reason: 'indicação' });
  await api.createCrm({ empresa: 'Sem Opções' });
  await api.updateCrm('crm:abc', { cidade: 'Niterói', valorProposta: null });
  await api.moveCrmStatus('crm:abc', 'WON', 'fechou');
  await api.moveCrmStatus('crm:abc', 'LOST', '   ');
  await api.moveCrmStatus('crm:abc', 'RESEARCH');
  await api.markCrmDnc('crm:abc', 'pediu para sair');
  await api.markCrmDnc('crm:abc', '');
  await api.markCrmDnc('crm:abc');

  assert.deepEqual(
    chamadas.map(({ method, caminho, body }) => [method, caminho, body]),
    [
      ['GET', '/api/crm', undefined],
      ['GET', '/api/crm/crm%3Aabc%20def%2Fx', undefined],
      ['GET', '/api/crm/crm%3Aabc/history', undefined],
      ['POST', '/api/crm', { empresa: 'Clínica Nova', site: 'nova.example.test', status: 'CONTACTED', reason: 'indicação' }],
      ['POST', '/api/crm', { empresa: 'Sem Opções' }],
      ['PATCH', '/api/crm/crm%3Aabc', { cidade: 'Niterói', valorProposta: null }],
      ['POST', '/api/crm/crm%3Aabc/status', { to: 'WON', reason: 'fechou' }],
      ['POST', '/api/crm/crm%3Aabc/status', { to: 'LOST' }],
      ['POST', '/api/crm/crm%3Aabc/status', { to: 'RESEARCH' }],
      ['POST', '/api/crm/crm%3Aabc/dnc', { reason: 'pediu para sair' }],
      ['POST', '/api/crm/crm%3Aabc/dnc', {}],
      ['POST', '/api/crm/crm%3Aabc/dnc', {}],
    ]
  );
});

test('[DASH-API-2] a identidade é só o token: todo pedido leva Authorization Bearer, sem cache e sem nenhum outro cabeçalho de identidade; escritas declaram JSON', async () => {
  const { api, chamadas } = await cliente();
  await api.listCrm();
  await api.createCrm({ empresa: 'X' });
  for (const chamada of chamadas) {
    assert.equal(chamada.headers.Authorization, 'Bearer token-de-teste-nao-real');
    assert.equal(chamada.cache, 'no-store');
    assert.deepEqual(Object.keys(chamada.headers).sort(), chamada.body === undefined ? ['Accept', 'Authorization'] : ['Accept', 'Authorization', 'Content-Type']);
  }
  assert.equal(chamadas[1].headers['Content-Type'], 'application/json');
});

test('[DASH-API-3] chaves que não são campos do registro (userId, authUserId, role, permissions, actor, reviewedBy, status, id, historico...) são RECUSADAS antes de existir uma requisição — na criação, na edição e nas opções', async () => {
  const proibidas = ['userId', 'authUserId', 'role', 'permissions', 'actor', 'reviewedBy', 'status', 'id', 'historico', 'dataDeEntrada', 'campoInventado', 'constructor'];
  for (const chave of proibidas) {
    const { api, chamadas } = await cliente();
    await assert.rejects(() => api.createCrm({ empresa: 'X', [chave]: 'valor' }), /campo não permitido/, `createCrm com ${chave}`);
    await assert.rejects(() => api.updateCrm('crm:a', { cidade: 'Y', [chave]: 'valor' }), /campo não permitido/, `updateCrm com ${chave}`);
    assert.equal(chamadas.length, 0, `${chave}: nada foi para a rede`);
  }
  // "__proto__" vindo de um JSON é uma chave PRÓPRIA (não troca o protótipo) e também é recusada.
  const { api, chamadas } = await cliente();
  await assert.rejects(() => api.createCrm(JSON.parse('{"empresa":"X","__proto__":{"role":"ADMIN"}}')), /campo não permitido/);
  await assert.rejects(() => api.updateCrm('crm:a', JSON.parse('{"__proto__":{"role":"ADMIN"}}')), /campo não permitido/);

  for (const opcao of ['userId', 'role', 'permissions', 'actor', 'reviewedBy', 'authUserId', 'id']) {
    await assert.rejects(() => api.createCrm({ empresa: 'X' }, { reason: 'ok', [opcao]: 'valor' }), /opção não permitida/, `opção ${opcao}`);
  }
  for (const invalido of [null, undefined, 'texto', 42, ['empresa']]) {
    await assert.rejects(() => api.createCrm(invalido), /campos devem ser um objeto/, String(invalido));
    await assert.rejects(() => api.updateCrm('crm:a', invalido), /campos devem ser um objeto/, String(invalido));
  }
  await assert.rejects(() => api.createCrm({ empresa: 'X' }, 'texto'), /opções devem ser um objeto/);
  assert.equal(chamadas.length, 0, 'nenhuma chamada recusada chegou à rede');
});

test('[DASH-API-4] o corpo da criação só leva as opções status e reason preenchidas (texto não vazio); um campo com o nome de uma opção nunca passa a ser opção', async () => {
  const { api, chamadas } = await cliente();
  await api.createCrm({ empresa: 'X' }, { status: '', reason: '   ' });
  await api.createCrm({ empresa: 'Y' }, { status: 'WON' });
  await api.createCrm({ empresa: 'Z' }, null);
  assert.deepEqual(chamadas.map((chamada) => chamada.body), [{ empresa: 'X' }, { empresa: 'Y', status: 'WON' }, { empresa: 'Z' }]);
});

test('[DASH-API-5] sessão: 401 renova UMA vez e repete UMA vez (nas rotas do CRM também); sem renovação, avisa a perda da sessão; 403 nunca renova; sem token nem tenta a rede', async () => {
  let perdas = 0;
  const renovado = await cliente((n) => (n === 1 ? new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'x' } }), { status: 401 }) : ok({ items: ['depois'] })), {
    refresh: async () => 'token-renovado',
    onSessionLost: () => (perdas += 1),
  });
  assert.deepEqual(await renovado.api.listCrm(), { items: ['depois'] });
  assert.equal(renovado.chamadas.length, 2);
  assert.equal(renovado.chamadas[1].headers.Authorization, 'Bearer token-renovado');
  assert.equal(perdas, 0);

  const perdida = await cliente(() => new Response('{}', { status: 401 }), { refresh: async () => null, onSessionLost: () => (perdas += 1) });
  await assert.rejects(() => perdida.api.getCrm('crm:a'), (erro) => erro.status === 401);
  assert.equal(perdas, 1);
  assert.equal(perdida.chamadas.length, 1);

  let renovacoes = 0;
  const proibida = await cliente(() => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Esta conta não possui acesso a esta área.' } }), { status: 403 }), {
    refresh: async () => {
      renovacoes += 1;
      return 'x';
    },
  });
  await assert.rejects(() => proibida.api.createCrm({ empresa: 'X' }), (erro) => erro.status === 403 && erro.code === 'FORBIDDEN');
  assert.equal(renovacoes, 0);

  const semToken = await cliente(() => ok(), { semToken: true, onSessionLost: () => (perdas += 1) });
  await assert.rejects(() => semToken.api.listCrm(), (erro) => erro.status === 401);
  assert.equal(semToken.chamadas.length, 0);
  assert.equal(perdas, 2);
});

test('[DASH-API-6] os erros do servidor chegam como ApiError com status, código e a frase fixa (409 de duplicidade, de bloqueio e de transição; 400 de validação); rede fora vira status 0; corpo que não é JSON vira INVALID_RESPONSE', async () => {
  const { ApiError } = await loadApi();
  const responder = (status, code, message) => () => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'Content-Type': 'application/json' } });

  const duplicado = await cliente(responder(409, 'DUPLICATE_RECORD', 'Já existe um registro com esta identidade.'));
  await assert.rejects(() => duplicado.api.createCrm({ empresa: 'X' }), (erro) => erro instanceof ApiError && erro.status === 409 && erro.code === 'DUPLICATE_RECORD' && erro.serverMessage === 'Já existe um registro com esta identidade.');
  const transicao = await cliente(responder(409, 'INVALID_TRANSITION', 'Esta mudança de status não é permitida.'));
  await assert.rejects(() => transicao.api.moveCrmStatus('crm:a', 'PROSPECT'), (erro) => erro.status === 409 && erro.code === 'INVALID_TRANSITION');
  const invalido = await cliente(responder(400, 'INVALID_REQUEST', 'Informe a empresa.'));
  await assert.rejects(() => invalido.api.createCrm({ cidade: 'X' }), (erro) => erro.status === 400 && erro.serverMessage === 'Informe a empresa.');

  const { createApiClient } = await loadApi();
  const semRede = createApiClient({ getAccessToken: async () => 't', refreshAccessToken: async () => null, onSessionLost() {}, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(() => semRede.listCrm(), (erro) => erro.status === 0 && erro.code === 'NETWORK' && !/Failed/.test(erro.message));

  const html = await cliente(() => new Response('<html>proxy</html>', { status: 200 }));
  await assert.rejects(() => html.api.listCrm(), (erro) => erro.code === 'INVALID_RESPONSE');
  const proxy = await cliente(() => new Response('<html>Bad gateway</html>', { status: 502 }));
  await assert.rejects(() => proxy.api.listCrm(), (erro) => erro.status === 502 && erro.code === 'HTTP_502' && erro.serverMessage === '');
});
