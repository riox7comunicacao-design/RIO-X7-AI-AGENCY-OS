// O MODELO dos catálogos no Dashboard (CRM 5.0, Fase 2B-2): dashboard/catalog-model.mjs e as chamadas de catálogo do cliente de API (dashboard/api.mjs).
// O contrato é conferido contra o do SERVIDOR (src/crm/catalogConstants.js) — se um mudar e o outro não, o teste falha. DOM de teste e API falsa: nenhuma rede, nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');

const server = require('../../src/crm/catalogConstants');

const loadModel = () => import('../../dashboard/catalog-model.mjs');
const loadApi = () => import('../../dashboard/api.mjs');
const loadI18n = () => import('../../dashboard/i18n/pt-BR.mjs');

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o contrato
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATMODEL-1] O CONTRATO: catálogos, campos graváveis, enumerações e limites do Dashboard são IDÊNTICOS aos do servidor', async () => {
  const m = await loadModel();
  assert.deepEqual([...m.CATALOG_KEYS], [...server.CATALOG_KEYS]);
  for (const chave of server.CATALOG_KEYS) {
    assert.deepEqual([...m.CATALOG_WRITABLE_FIELDS[chave]], ['nome', 'descricao', ...server.CATALOG_DEFINITIONS[chave].specificFields], chave);
  }
  assert.equal(m.LIMITS.NOME, server.LIMITS.NOME);
  assert.equal(m.LIMITS.DESCRICAO, server.LIMITS.DESCRICAO);
  assert.equal(m.LIMITS.CATEGORIA, server.LIMITS.CATEGORIA);
  assert.equal(m.LIMITS.PRECO_MAXIMO, server.LIMITS.PRECO_REFERENCIA_MAXIMO);
  assert.deepEqual(m.BILLING_OPTIONS.map((o) => o.value), [...server.BILLING_TYPES]);
  assert.deepEqual(m.RECURRENCE_OPTIONS.map((o) => o.value), [...server.RECURRENCES]);
  assert.deepEqual(m.CHANNEL_OPTIONS.map((o) => o.value), [...server.LEAD_CHANNELS], 'a taxonomia de canais é a REAL do backend, na mesma ordem');
  for (const lista of [m.BILLING_OPTIONS, m.RECURRENCE_OPTIONS, m.CHANNEL_OPTIONS]) for (const o of lista) assert.ok(o.label.length > 0 && o.label !== o.value, `${o.value} tem rótulo em português`);
  // os códigos de erro que o Dashboard reconhece são os do servidor
  assert.equal(server.CATALOG_ERROR.DUPLICATE_NAME, 'CRM_CATALOG_DUPLICATE_NAME');
  assert.equal(server.CATALOG_ERROR.NAME_IN_USE, 'CRM_CATALOG_NAME_IN_USE');
});

test('[CATMODEL-2] DINHEIRO em reais: o formato brasileiro e o ponto decimal de 1 ou 2 casas valem; milhar com ponto; mais de 2 casas, negativo, letras e acima do teto são recusados', async () => {
  const { parseMoney } = await loadModel();
  const ok = { '': null, '   ': null, '0': 0, '0,00': 0, '99': 99, 'R$ 99': 99, 'R$99,90': 99.9, '1500': 1500, '1500,5': 1500.5, '1.500': 1500, '1.500,00': 1500, '12.345.678,90': 12345678.9, '1500.50': 1500.5, '12.5': 12.5, '1000000000': 1000000000 };
  for (const [texto, valor] of Object.entries(ok)) {
    const r = parseMoney(texto);
    assert.equal(r.ok, true, `"${texto}"`);
    assert.equal(r.value, valor, `"${texto}"`);
  }
  assert.equal(parseMoney(undefined).value, null);
  assert.equal(parseMoney(15).value, null, 'só texto vem do formulário');
  const ruins = { '12,345': 'MAIS_DE_DUAS_CASAS', '1.234,567': 'MAIS_DE_DUAS_CASAS', '12.345,6789': 'MAIS_DE_DUAS_CASAS', '-5': 'NEGATIVO', '-0,01': 'NEGATIVO', 'abc': 'FORMATO_INVALIDO', '1,2,3': 'FORMATO_INVALIDO', '1..5': 'FORMATO_INVALIDO', 'R$': null, '1e5': 'FORMATO_INVALIDO', '1000000000,01': 'VALOR_FORA_DO_LIMITE', '1000000001': 'VALOR_FORA_DO_LIMITE' };
  for (const [texto, codigo] of Object.entries(ruins)) {
    const r = parseMoney(texto);
    if (codigo === null) {
      assert.equal(r.ok, true, 'só "R$" vale como campo vazio');
      continue;
    }
    assert.equal(r.ok, false, `"${texto}"`);
    assert.equal(r.code, codigo, `"${texto}"`);
  }
});

test('[CATMODEL-3] a exibição do preço: o campo mostra 1.500,00 e a lista mostra R$ 1.500,00; sem valor, vazio', async () => {
  const { moneyFieldText, priceText, parseMoney } = await loadModel();
  assert.equal(moneyFieldText(1500), '1.500,00');
  assert.equal(moneyFieldText(0.5), '0,50');
  assert.equal(moneyFieldText(1234567.89), '1.234.567,89');
  assert.equal(moneyFieldText(null), '');
  assert.equal(moneyFieldText('1500'), '');
  assert.match(priceText(1500), /^R\$\s1\.500,00$/);
  assert.equal(priceText(null), '');
  for (const valor of [0, 0.5, 99.9, 1500, 1234567.89]) assert.equal(parseMoney(moneyFieldText(valor)).value, valor, `ida e volta de ${valor}`);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o que vai para o servidor
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATMODEL-4] CRIAR: vai o nome e só os campos opcionais preenchidos; o nome é obrigatório; o preço vira número; o texto é limpo', async () => {
  const m = await loadModel();
  const vazio = m.emptyFormValues('servicos');
  assert.deepEqual(vazio, { nome: '', descricao: '', categoria: '', precoReferencia: '', tipoCobranca: '', recorrencia: '' });

  const so = m.buildCreateBody('servicos', { ...vazio, nome: '  Gestão   de redes  ' });
  assert.deepEqual(so, { ok: true, body: { nome: 'Gestão de redes' }, errors: {} });

  const completo = m.buildCreateBody('servicos', { nome: 'Site', descricao: '  Um site\r\ncompleto  ', categoria: ' Web ', precoReferencia: '2.500,00', tipoCobranca: 'RECORRENTE', recorrencia: 'MENSAL' });
  assert.equal(completo.ok, true);
  assert.deepEqual(completo.body, { nome: 'Site', descricao: 'Um site\ncompleto', categoria: 'Web', precoReferencia: 2500, tipoCobranca: 'RECORRENTE', recorrencia: 'MENSAL' });

  const semNome = m.buildCreateBody('servicos', { ...vazio, nome: '   ' });
  assert.equal(semNome.ok, false);
  assert.equal(semNome.errors.nome, 'Informe o nome.');

  const precoRuim = m.buildCreateBody('servicos', { ...vazio, nome: 'X', precoReferencia: 'dez' });
  assert.equal(precoRuim.ok, false);
  assert.match(precoRuim.errors.precoReferencia, /reais/);
  assert.equal(Object.prototype.hasOwnProperty.call(precoRuim.body, 'precoReferencia'), false);

  assert.deepEqual(m.buildCreateBody('nichos', { nome: 'Clínicas', descricao: '', cor: 'azul' }).body, { nome: 'Clínicas', cor: 'azul' });
  assert.deepEqual(m.buildCreateBody('origens', { nome: 'Indicação', descricao: 'Boca a boca', canal: 'INDICACAO' }).body, { nome: 'Indicação', descricao: 'Boca a boca', canal: 'INDICACAO' });
  // nunca um campo fora do contrato
  for (const catalogo of m.CATALOG_KEYS) {
    const corpo = m.buildCreateBody(catalogo, { ...m.emptyFormValues(catalogo), nome: 'Algo' }).body;
    for (const campo of Object.keys(corpo)) assert.ok(m.CATALOG_WRITABLE_FIELDS[catalogo].includes(campo), `${catalogo}.${campo}`);
  }
});

test('[CATMODEL-5] EDITAR: vai SÓ o que mudou; sem mudança nada é enviado; espaços a mais não contam; limpar vira null; mudar a cobrança leva a recorrência junto', async () => {
  const m = await loadModel();
  const item = { nome: 'Gestão de redes', descricao: 'Posts', categoria: 'Marketing', precoReferencia: 1500, tipoCobranca: 'RECORRENTE', recorrencia: 'MENSAL' };
  const inicial = m.formValuesFromItem('servicos', item);
  assert.deepEqual(inicial, { nome: 'Gestão de redes', descricao: 'Posts', categoria: 'Marketing', precoReferencia: '1.500,00', tipoCobranca: 'RECORRENTE', recorrencia: 'MENSAL' });

  const igual = m.buildPatchBody('servicos', inicial, { ...inicial });
  assert.equal(igual.empty, true);
  assert.deepEqual(igual.body, {});
  assert.equal(m.buildPatchBody('servicos', inicial, { ...inicial, nome: '  Gestão  de redes ', descricao: 'Posts  ' }).empty, true, 'espaços a mais não são alteração');

  const preco = m.buildPatchBody('servicos', inicial, { ...inicial, precoReferencia: '1.800,50' });
  assert.deepEqual(preco.body, { precoReferencia: 1800.5 });
  assert.equal(preco.empty, false);

  const limpar = m.buildPatchBody('servicos', inicial, { ...inicial, descricao: '', categoria: '', precoReferencia: '' });
  assert.deepEqual(limpar.body, { descricao: null, categoria: null, precoReferencia: null });

  // pagamento único: a recorrência sai junto (o servidor confere a coerência do estado final)
  const unica = m.buildPatchBody('servicos', inicial, { ...inicial, tipoCobranca: 'UNICA', recorrencia: '' });
  assert.deepEqual(unica.body, { tipoCobranca: 'UNICA', recorrencia: null });
  const trimestral = m.buildPatchBody('servicos', inicial, { ...inicial, recorrencia: 'TRIMESTRAL' });
  assert.deepEqual(trimestral.body, { tipoCobranca: 'RECORRENTE', recorrencia: 'TRIMESTRAL' });

  const nomeVazio = m.buildPatchBody('servicos', inicial, { ...inicial, nome: ' ' });
  assert.equal(nomeVazio.ok, false);
  assert.equal(nomeVazio.errors.nome, 'Informe o nome.');
  const precoRuim = m.buildPatchBody('servicos', inicial, { ...inicial, precoReferencia: '12,345' });
  assert.equal(precoRuim.ok, false);
  assert.match(precoRuim.errors.precoReferencia, /duas casas/);

  const nicho = m.formValuesFromItem('nichos', { nome: 'Clínicas', descricao: null, cor: null });
  assert.deepEqual(nicho, { nome: 'Clínicas', descricao: '', cor: '' }, 'um nicho legado sem cor abre sem cor escolhida');
  assert.deepEqual(m.buildPatchBody('nichos', nicho, { ...nicho, cor: 'verde' }).body, { cor: 'verde' });
  assert.equal(m.buildPatchBody('nichos', nicho, { ...nicho }).empty, true, 'abrir e salvar sem mexer não força uma cor');
  assert.deepEqual(m.buildPatchBody('origens', m.formValuesFromItem('origens', { nome: 'X', canal: null }), { nome: 'X', descricao: '', canal: 'OUTRO' }).body, { canal: 'OUTRO' });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// mensagens
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATMODEL-6] ERROS da API viram mensagens em português, por campo quando possível, e NUNCA repetem o valor digitado', async () => {
  const m = await loadModel();
  const { ApiError } = await loadApi();

  const validacao = m.catalogErrorInfo(new ApiError(400, 'CRM_CATALOG_INVALID_INPUT', 'Os dados do cadastro são inválidos.', [{ path: 'nome', code: 'MUITO_LONGO' }, { path: 'precoReferencia', code: 'MAIS_DE_DUAS_CASAS' }, { path: 'recorrencia', code: 'RECORRENCIA_OBRIGATORIA' }, { path: '', code: 'TIPO_INVALIDO' }]));
  assert.equal(validacao.kind, 'validation');
  assert.equal(validacao.fields.nome, 'O nome pode ter no máximo 80 caracteres.');
  assert.equal(validacao.fields.precoReferencia, 'Use no máximo duas casas decimais (os centavos).');
  assert.equal(validacao.fields.recorrencia, 'Escolha a recorrência: a cobrança é recorrente.');
  assert.deepEqual(Object.keys(validacao.fields).sort(), ['nome', 'precoReferencia', 'recorrencia']);

  assert.equal(m.catalogErrorInfo(new ApiError(400, 'CRM_CATALOG_INVALID_INPUT', '', [{ path: '', code: 'NADA_A_ALTERAR' }])).message, 'Nenhuma alteração foi feita.');
  assert.match(m.catalogErrorInfo(new ApiError(400, 'CRM_CATALOG_INVALID_INPUT', '', [{ path: 'orderedIds', code: 'LISTA_INVALIDA' }])).message, /Atualize a página/);

  const duplicado = m.catalogErrorInfo(new ApiError(409, 'CRM_CATALOG_DUPLICATE_NAME', 'x'));
  assert.equal(duplicado.kind, 'duplicate');
  assert.match(duplicado.fields.nome, /mesmo desativado/);
  const emUso = m.catalogErrorInfo(new ApiError(409, 'CRM_CATALOG_NAME_IN_USE', 'x'));
  assert.equal(emUso.kind, 'in-use');
  assert.match(emUso.fields.nome, /não pode ser alterado nesta fase/);

  assert.equal(m.catalogErrorInfo(new ApiError(404, 'CRM_CATALOG_NOT_FOUND', '')).kind, 'not-found');
  assert.equal(m.catalogErrorInfo(new ApiError(403, 'FORBIDDEN', '')).kind, 'forbidden');
  const indisponivel = m.catalogErrorInfo(new ApiError(503, 'CRM_CATALOG_PERSISTENCE', ''));
  assert.equal(indisponivel.kind, 'unavailable');
  assert.match(indisponivel.message, /ainda não foi preparada/, 'a estrutura de dados ausente é explicada com clareza');
  assert.match(indisponivel.message, /Nada foi alterado/);
  assert.equal(m.catalogErrorInfo(new ApiError(0, 'NETWORK', '')).kind, 'network');
  assert.equal(m.catalogErrorInfo(new ApiError(401, 'UNAUTHENTICATED', '')), null, '401: o fluxo de login cuida');
  assert.equal(m.catalogErrorInfo(new ApiError(500, 'INTERNAL', 'segredo-do-servidor')).message, m.MESSAGES.generic, 'um erro desconhecido nunca repete o texto do servidor');
  assert.equal(m.catalogErrorInfo(new Error('qualquer')).kind, 'other');
  assert.equal(m.catalogErrorInfo(null).kind, 'other');

  // um caminho estranho vindo do servidor nunca vira campo
  const estranho = m.catalogErrorInfo(new ApiError(400, 'CRM_CATALOG_INVALID_INPUT', '', [{ path: '__proto__', code: 'X' }, { path: 'id', code: 'CAMPO_NAO_EDITAVEL' }]));
  assert.deepEqual(estranho.fields, {});
});

test('[CATMODEL-7] BUSCA e FILTRO: a busca é pelo nome (sem acento, sem diferenciar maiúsculas) e o filtro separa ativos e inativos; a ordem do servidor é mantida', async () => {
  const { visibleCatalogItems, STATUS_FILTERS } = await loadModel();
  const itens = [
    { id: 'a', nome: 'Estética Facial', ativo: true },
    { id: 'b', nome: 'Odontologia', ativo: false },
    { id: 'c', nome: 'Estetica Corporal', ativo: true },
    { id: 'd', nome: 'Psicologia', ativo: false },
  ];
  assert.deepEqual(visibleCatalogItems(itens).map((i) => i.id), ['a', 'b', 'c', 'd'], 'padrão: todos, na ordem recebida');
  assert.deepEqual(visibleCatalogItems(itens, { query: 'ESTÉTICA' }).map((i) => i.id), ['a', 'c']);
  assert.deepEqual(visibleCatalogItems(itens, { query: '  odonto ' }).map((i) => i.id), ['b']);
  assert.deepEqual(visibleCatalogItems(itens, { status: 'ATIVOS' }).map((i) => i.id), ['a', 'c']);
  assert.deepEqual(visibleCatalogItems(itens, { status: 'INATIVOS' }).map((i) => i.id), ['b', 'd']);
  assert.deepEqual(visibleCatalogItems(itens, { status: 'INATIVOS', query: 'psi' }).map((i) => i.id), ['d']);
  assert.deepEqual(visibleCatalogItems(itens, { query: 'zzz' }), []);
  assert.deepEqual(visibleCatalogItems(null), []);
  assert.deepEqual(STATUS_FILTERS.map((o) => o.value), ['ATIVOS', 'INATIVOS', 'TODOS']);
});

test('[CATMODEL-8] VOCABULÁRIO: nenhum texto do modelo contém um termo em inglês proibido', async () => {
  const m = await loadModel();
  const { findForbiddenTerm } = await loadI18n();
  const textos = [...Object.values(m.MESSAGES), ...[...m.BILLING_OPTIONS, ...m.RECURRENCE_OPTIONS, ...m.CHANNEL_OPTIONS, ...m.STATUS_FILTERS].map((o) => o.label)];
  for (const campo of ['nome', 'descricao', 'categoria', 'precoReferencia', 'tipoCobranca', 'recorrencia', 'cor', 'canal']) {
    for (const codigo of ['OBRIGATORIO', 'MUITO_LONGO', 'CARACTERE_INVALIDO', 'NOME_SEM_LETRAS', 'TIPO_INVALIDO', 'VALOR_INVALIDO', 'VALOR_FORA_DO_LIMITE', 'MAIS_DE_DUAS_CASAS', 'RECORRENCIA_OBRIGATORIA', 'RECORRENCIA_NAO_PERMITIDA', 'DESCONHECIDO']) textos.push(m.fieldMessage(campo, codigo));
  }
  for (const texto of textos) {
    assert.equal(findForbiddenTerm(texto), null, texto);
    assert.doesNotMatch(texto, /\b(undefined|null|NaN|\[object)\b/, texto);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o cliente de API
// ---------------------------------------------------------------------------------------------------------------------------------------------

function clienteFalso(respostas = []) {
  const chamadas = [];
  const fila = [...respostas];
  const fetchImpl = async (caminho, init) => {
    chamadas.push({ caminho, metodo: init.method, corpo: init.body === undefined ? undefined : JSON.parse(init.body), autorizacao: init.headers.Authorization });
    const resposta = fila.length > 0 ? fila.shift() : { status: 200, corpo: { items: [] } };
    return { ok: resposta.status >= 200 && resposta.status < 300, status: resposta.status, json: async () => resposta.corpo };
  };
  return { chamadas, fetchImpl };
}

async function api(respostas) {
  const { createApiClient } = await loadApi();
  const f = clienteFalso(respostas);
  const cliente = createApiClient({ getAccessToken: async () => 'token-de-teste', refreshAccessToken: async () => null, onSessionLost: () => {}, fetchImpl: f.fetchImpl });
  return { cliente, ...f };
}

test('[CATAPI-1] as chamadas de catálogo usam os caminhos e métodos REAIS do servidor, com o token da sessão e sem identidade no corpo', async () => {
  const { cliente, chamadas } = await api();
  await cliente.listCatalog('servicos');
  await cliente.listCatalog('nichos', { todos: true });
  await cliente.getCatalogItem('origens', 'origin:abc/1');
  await cliente.createCatalogItem('servicos', { nome: 'Site', precoReferencia: 10 });
  await cliente.updateCatalogItem('nichos', 'niche:1', { cor: 'azul' });
  await cliente.activateCatalogItem('origens', 'origin:1');
  await cliente.deactivateCatalogItem('servicos', 'service:1');
  await cliente.reorderCatalog('nichos', ['niche:2', 'niche:1']);
  assert.deepEqual(
    chamadas.map((c) => [c.metodo, c.caminho]),
    [
      ['GET', '/api/crm-catalogs/servicos'],
      ['GET', '/api/crm-catalogs/nichos?todos=1'],
      ['GET', '/api/crm-catalogs/origens/origin%3Aabc%2F1'],
      ['POST', '/api/crm-catalogs/servicos'],
      ['PATCH', '/api/crm-catalogs/nichos/niche%3A1'],
      ['POST', '/api/crm-catalogs/origens/origin%3A1/activate'],
      ['POST', '/api/crm-catalogs/servicos/service%3A1/deactivate'],
      ['POST', '/api/crm-catalogs/nichos/reorder'],
    ]
  );
  assert.deepEqual(chamadas[3].corpo, { nome: 'Site', precoReferencia: 10 });
  assert.deepEqual(chamadas[4].corpo, { cor: 'azul' });
  assert.deepEqual(chamadas[5].corpo, {});
  assert.deepEqual(chamadas[7].corpo, { orderedIds: ['niche:2', 'niche:1'] });
  assert.equal(chamadas[0].corpo, undefined, 'uma leitura não leva corpo');
  assert.ok(chamadas.every((c) => c.autorizacao === 'Bearer token-de-teste'));
  assert.ok(!chamadas.some((c) => c.metodo === 'DELETE'), 'não existe exclusão de catálogo');
});

test('[CATAPI-2] o corpo só leva campos GRAVÁVEIS do catálogo: id, ordem, ativo, datas, quem alterou, userId, role e permissions são recusados ANTES de existir uma requisição', async () => {
  const { cliente, chamadas } = await api();
  for (const proibido of ['id', 'ordem', 'ativo', 'nomeNormalizado', 'criadoEm', 'atualizadoEm', 'criadoPorUserId', 'atualizadoPorNome', 'userId', 'role', 'permissions', 'emUso']) {
    await assert.rejects(() => cliente.createCatalogItem('servicos', { nome: 'X', [proibido]: 'y' }), /campo não permitido/, proibido);
    await assert.rejects(() => cliente.updateCatalogItem('servicos', 'service:1', { [proibido]: 'y' }), /campo não permitido/, proibido);
  }
  // um campo de OUTRO catálogo também é recusado
  await assert.rejects(() => cliente.createCatalogItem('nichos', { nome: 'X', precoReferencia: 1 }), /campo não permitido/);
  await assert.rejects(() => cliente.createCatalogItem('origens', { nome: 'X', cor: 'azul' }), /campo não permitido/);
  await assert.rejects(() => cliente.createCatalogItem('servicos', null), /objeto/);
  await assert.rejects(() => cliente.createCatalogItem('servicos', []), /objeto/);
  await assert.rejects(() => cliente.listCatalog('clientes'), /catálogo desconhecido/);
  await assert.rejects(() => cliente.listCatalog('__proto__'), /catálogo desconhecido/);
  assert.equal(chamadas.length, 0, 'nenhuma requisição saiu');
});

test('[CATAPI-3] uma recusa do servidor chega com status, código e os DETALHES de validação (só caminho e código); detalhes malformados são descartados', async () => {
  const { cliente } = await api([
    { status: 400, corpo: { error: { code: 'CRM_CATALOG_INVALID_INPUT', message: 'Os dados do cadastro são inválidos.', details: [{ path: 'nome', code: 'OBRIGATORIO' }, { path: 'x'.repeat(200), code: 'A' }, { code: 'SEM_CAMINHO' }, 'texto', null, { path: 'cor', code: 'y'.repeat(200) }, { path: 'descricao', code: 'MUITO_LONGO', valor: 'segredo' }] } } },
    { status: 409, corpo: { error: { code: 'CRM_CATALOG_DUPLICATE_NAME', message: 'Já existe.' } } },
    { status: 503, corpo: { error: { code: 'CRM_CATALOG_PERSISTENCE', message: 'x', details: 'não é lista' } } },
  ]);
  const primeiro = await cliente.createCatalogItem('servicos', { nome: '' }).catch((e) => e);
  assert.equal(primeiro.status, 400);
  assert.equal(primeiro.code, 'CRM_CATALOG_INVALID_INPUT');
  // um caminho longo demais perde o caminho (fica ''), um código longo demais descarta a entrada, e o que não é objeto some
  assert.deepEqual(primeiro.details, [{ path: 'nome', code: 'OBRIGATORIO' }, { path: '', code: 'A' }, { path: '', code: 'SEM_CAMINHO' }, { path: 'descricao', code: 'MUITO_LONGO' }]);
  assert.equal(JSON.stringify(primeiro.details).includes('segredo'), false, 'nunca um valor');
  const segundo = await cliente.createCatalogItem('servicos', { nome: 'X' }).catch((e) => e);
  assert.deepEqual([segundo.status, segundo.code, segundo.details], [409, 'CRM_CATALOG_DUPLICATE_NAME', []]);
  const terceiro = await cliente.listCatalog('servicos', { todos: true }).catch((e) => e);
  assert.deepEqual([terceiro.status, terceiro.code, terceiro.details], [503, 'CRM_CATALOG_PERSISTENCE', []]);
});
