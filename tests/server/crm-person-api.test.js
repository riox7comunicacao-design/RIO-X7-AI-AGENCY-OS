// API de CLIENTES PF/PJ (rotas /api/crm de src/server/app.js — CRM 5.0, Fase D2, decisão 0030) sobre peças REAIS: app, autenticação (Supabase falso só na borda), CRM Service, domínio e arquivo temporário; mais a
// integração com NEGOCIAÇÕES (cliente PF e PJ, várias negociações do mesmo cliente, nada copiado dos campos financeiros legados). Dados fictícios (documentos de exemplo); nenhum data/ real; nenhuma rede.
// O trecho de negociações roda nos dois modos de armazenamento comercial (arquivo e Supabase falso): crm-person-api.test.js e crm-person-api.supabase.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const crm = require('../../src/crm');
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

const MODO = process.env.NEG_TEST_STORAGE === 'supabase' ? 'supabase' : 'arquivo';
const CPF_A = '529.982.247-25';
const CPF_B = '111.444.777-35';
const CNPJ_A = '11.222.333/0001-81';
const rota = (id, sufixo = '') => `/api/crm/${encodeURIComponent(id)}${sufixo}`;
const bytes = (env) => (fs.existsSync(env.crmFilePath) ? fs.readFileSync(env.crmFilePath, 'utf8') : null);
const registros = (env) => createJsonFileCrmRepository(env.crmFilePath).list();
const operadorDe = (usuario) => ({ userId: usuario.userId, name: usuario.name, role: usuario.role });
const criarCliente = (env, corpo, usuario = BRENO) => chamar(env, usuario, { method: 'POST', url: '/api/crm', body: corpo });

// um registro ANTIGO (sem tipo e sem as chaves novas), gravado direto no arquivo como era antes da Fase D2
async function semearLegado(env, campos) {
  const repositorio = createJsonFileCrmRepository(env.crmFilePath);
  const { record } = await crm.createRecord(repositorio, campos, { actor: 'HUMAN', reviewedBy: { userId: 'user-semente', name: 'Semente', role: 'ADMIN' }, motivo: 'semente' });
  return record;
}

test('[PERSON-API-1] ADMIN cadastra uma Pessoa FÍSICA: 201, `empresa` vazia (nenhum nome de pessoa no campo errado), os 4 campos novos na resposta e no arquivo, auditoria pelo TOKEN', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const resposta = await criarCliente(env, { tipoPessoa: 'PF', nomeCompleto: '  Maria Souza  ', cpf: CPF_A, telefone: '24 90000-1111', email: 'maria@example.test', nicho: 'Psicologia', origem: 'Indicação', responsavel: 'Rafael' });
  assert.equal(resposta.status, 201);
  const item = resposta.json().item;
  assert.deepEqual([item.tipoPessoa, item.nomeCompleto, item.empresa, item.cpf, item.cnpj], ['PF', 'Maria Souza', null, '52998224725', null]);
  assert.deepEqual(Object.keys(item).sort(), ['id', ...crm.CRM_WRITABLE_FIELDS, 'status', 'dataDeEntrada', 'historico'].sort(), 'o contrato público tem os 35 campos + os gerenciados');
  const [gravado] = registros(env);
  assert.deepEqual([gravado.tipoPessoa, gravado.nomeCompleto, gravado.empresa, gravado.cpf], ['PF', 'Maria Souza', null, '52998224725']);
  assert.deepEqual(gravado.historico[0].reviewedBy, operadorDe(BRENO));
  assert.equal(gravado.historico[0].actor, 'HUMAN');
});

test('[PERSON-API-2] ADMIN cadastra uma Pessoa JURÍDICA: empresa + contato + CNPJ (guardado só com os caracteres do documento; o alfanumérico também vale)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const a = await criarCliente(env, { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', contato: 'Ana Lima', cnpj: CNPJ_A, site: 'aurora.example.test' });
  assert.equal(a.status, 201);
  assert.deepEqual([a.json().item.tipoPessoa, a.json().item.empresa, a.json().item.contato, a.json().item.cnpj, a.json().item.nomeCompleto], ['PJ', 'Clínica Aurora', 'Ana Lima', '11222333000181', null]);
  const b = await criarCliente(env, { tipoPessoa: 'PJ', empresa: 'Alfanumérica Ltda', cnpj: '12.abc.345/01de-35' });
  assert.equal(b.status, 201);
  assert.equal(b.json().item.cnpj, '12ABC34501DE35');
  assert.equal(registros(env).length, 2);
});

test('[PERSON-API-3] o tipo é OBRIGATÓRIO no cadastro humano: sem ele, 400 com a frase certa e nada é gravado (nem o contrato legado, só `empresa`, passa por aqui)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const antes = bytes(env);
  const TIPO = 'Informe se o cliente é Pessoa Física ou Pessoa Jurídica.';
  for (const corpo of [{}, { empresa: 'Só empresa' }, { empresa: 'X', cidade: 'Niterói' }, { tipoPessoa: null, empresa: 'X' }]) {
    const resposta = await criarCliente(env, corpo);
    assert.equal(resposta.status, 400, JSON.stringify(corpo));
    assert.deepEqual(resposta.json(), { error: { code: 'INVALID_REQUEST', message: TIPO } }, JSON.stringify(corpo));
  }
  assert.equal(bytes(env), antes, 'nada foi gravado');
});

test('[PERSON-API-4] campos obrigatórios CONDICIONAIS e documentos: cada recusa tem a sua frase fixa (400), sem repetir o valor digitado, e nada é gravado', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const antes = bytes(env);
  const casos = [
    [{ tipoPessoa: 'PF' }, 'Informe o nome completo da pessoa.'],
    [{ tipoPessoa: 'PF', nomeCompleto: '   ' }, 'Informe o nome completo da pessoa.'],
    [{ tipoPessoa: 'PF', empresa: 'Só empresa' }, 'Informe o nome completo da pessoa.'],
    [{ tipoPessoa: 'PJ' }, 'Informe a empresa.'],
    [{ tipoPessoa: 'PJ', empresa: '  ' }, 'Informe a empresa.'],
    [{ tipoPessoa: 'PJ', empresa: 'Aurora', nomeCompleto: 'Maria' }, 'O nome completo só vale para Pessoa Física; para uma empresa use o campo Empresa.'],
    [{ tipoPessoa: 'PJ', empresa: 'Aurora', cpf: CPF_A }, 'O CPF só pode ser informado para Pessoa Física.'],
    [{ tipoPessoa: 'PF', nomeCompleto: 'Maria', cnpj: CNPJ_A }, 'O CNPJ só pode ser informado para Pessoa Jurídica.'],
    [{ tipoPessoa: 'PF', nomeCompleto: 'Maria', cpf: '529.982.247-24' }, 'CPF inválido. Confira os 11 números.'],
    [{ tipoPessoa: 'PF', nomeCompleto: 'Maria', cpf: '111.111.111-11' }, 'CPF inválido. Confira os 11 números.'],
    [{ tipoPessoa: 'PJ', empresa: 'Aurora', cnpj: '11.222.333/0001-82' }, 'CNPJ inválido. Confira os 14 caracteres.'],
    [{ tipoPessoa: 'PJ', empresa: 'Aurora', cnpj: '00.000.000/0000-00' }, 'CNPJ inválido. Confira os 14 caracteres.'],
    [{ empresa: 'X', nomeCompleto: 'Maria' }, 'Informe se o cliente é Pessoa Física ou Pessoa Jurídica.'],
    [{ tipoPessoa: 'pf', nomeCompleto: 'Maria' }, 'Tipo de pessoa inválido: use Pessoa Física ou Pessoa Jurídica.'],
    [{ tipoPessoa: 'PESSOA', empresa: 'X' }, 'Tipo de pessoa inválido: use Pessoa Física ou Pessoa Jurídica.'],
    [{ tipoPessoa: 7, empresa: 'X' }, 'Tipo de pessoa inválido: use Pessoa Física ou Pessoa Jurídica.'],
    [{ tipoPessoa: 'PJ', empresa: 'X', exigirTipoPessoa: false }, 'Campos não permitidos na requisição.'],
  ];
  for (const [corpo, mensagem] of casos) {
    const resposta = await criarCliente(env, corpo);
    assert.equal(resposta.status, 400, JSON.stringify(corpo));
    assert.deepEqual(resposta.json(), { error: { code: 'INVALID_REQUEST', message: mensagem } }, JSON.stringify(corpo));
    for (const segredo of [CPF_A, '52998224725', CNPJ_A, '11222333000181']) assert.ok(!resposta.text.includes(segredo), 'a recusa não devolve o documento');
  }
  assert.equal(bytes(env), antes, 'nada foi gravado');
});

test('[PERSON-API-5] DUPLICIDADE e DNC por documento: o mesmo CPF/CNPJ -> 409 DUPLICATE_RECORD; o de um bloqueado -> 409 DNC_BLOCKED; mensagens fixas, sem o id do outro registro nem o documento', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const pf = (await criarCliente(env, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: CPF_A })).json().item;
  const pj = (await criarCliente(env, { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: CNPJ_A })).json().item;
  const antes = bytes(env);
  for (const corpo of [{ tipoPessoa: 'PF', nomeCompleto: 'Outra Pessoa Qualquer', cpf: '52998224725' }, { tipoPessoa: 'PJ', empresa: 'Nome Totalmente Outro', cnpj: '11222333000181' }]) {
    const r = await criarCliente(env, corpo);
    assert.equal(r.status, 409, JSON.stringify(corpo));
    assert.deepEqual(r.json(), { error: { code: 'DUPLICATE_RECORD', message: 'Já existe um registro com esta identidade.' } });
    for (const naoPodeSair of [pf.id, pj.id, 'Maria Souza', 'Clínica Aurora']) assert.ok(!r.text.includes(naoPodeSair), `"${naoPodeSair}" não sai na recusa`);
  }
  assert.equal(bytes(env), antes);
  // bloquear a PF: o mesmo CPF não volta por baixo
  assert.equal((await chamar(env, BRENO, { method: 'POST', url: rota(pf.id, '/dnc'), body: {} })).status, 200);
  const bloqueada = await criarCliente(env, { tipoPessoa: 'PF', nomeCompleto: 'Nome Novo', cpf: CPF_A });
  assert.equal(bloqueada.status, 409);
  assert.deepEqual(bloqueada.json(), { error: { code: 'DNC_BLOCKED', message: 'Esta identidade está bloqueada como "não contatar".' } });
  // editar OUTRO registro para o documento do bloqueado também é recusado
  const outro = (await criarCliente(env, { tipoPessoa: 'PF', nomeCompleto: 'Pessoa Livre', cpf: CPF_B })).json().item;
  const edicao = await chamar(env, BRENO, { method: 'PATCH', url: rota(outro.id), body: { cpf: CPF_A } });
  assert.equal(edicao.status, 409);
  assert.equal(edicao.json().error.code, 'DNC_BLOCKED');
});

test('[PERSON-API-6] CLIENTE LEGADO sem tipo: a lista e a ficha o devolvem com os 4 campos nulos (nunca inferidos); editar outro campo não perde nada; a revisão administrativa define o tipo e preserva a empresa original', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const antigo = await semearLegado(env, { empresa: 'Estúdio Dias', cidade: 'Niterói', nicho: 'Design', valorProposta: 900, valorTotal: 1800, observacoes: 'cliente antigo' });
  const lista = (await chamar(env, BRENO, { url: '/api/crm' })).json().items;
  assert.equal(lista.length, 1);
  assert.deepEqual([lista[0].tipoPessoa, lista[0].nomeCompleto, lista[0].cpf, lista[0].cnpj], [null, null, null, null]);

  const parcial = await chamar(env, BRENO, { method: 'PATCH', url: rota(antigo.id), body: { telefone: '24 90000-2222' } });
  assert.equal(parcial.status, 200);
  const depois = parcial.json().item;
  for (const campo of ['empresa', 'cidade', 'nicho', 'valorProposta', 'valorTotal', 'observacoes']) assert.equal(depois[campo], antigo[campo], `${campo} preservado`);
  assert.equal(depois.tipoPessoa, null, 'o tipo continua sem definir');
  assert.deepEqual(depois.historico, antigo.historico);

  const semNome = await chamar(env, BRENO, { method: 'PATCH', url: rota(antigo.id), body: { tipoPessoa: 'PF' } });
  assert.equal(semNome.status, 400);
  assert.equal(semNome.json().error.message, 'Informe o nome completo da pessoa.');
  const comNome = await chamar(env, BRENO, { method: 'PATCH', url: rota(antigo.id), body: { tipoPessoa: 'PF', nomeCompleto: 'Fulano Dias' } });
  assert.equal(comNome.status, 200);
  assert.deepEqual([comNome.json().item.tipoPessoa, comNome.json().item.nomeCompleto, comNome.json().item.empresa, comNome.json().item.valorProposta], ['PF', 'Fulano Dias', 'Estúdio Dias', 900]);

  const remover = await chamar(env, BRENO, { method: 'PATCH', url: rota(antigo.id), body: { tipoPessoa: null } });
  assert.equal(remover.status, 400);
  assert.equal(remover.json().error.message, 'O tipo de pessoa pode ser trocado entre PF e PJ, mas não removido.');
  assert.equal(registros(env)[0].tipoPessoa, 'PF');
});

test('[PERSON-API-7] RBAC: o COMMERCIAL_CLOSER lê a lista (com o tipo) mas não cadastra nem edita (403, arquivo intacto); sem login é 401; só o ADMIN cadastra', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true });
  const pf = (await criarCliente(env, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: CPF_A })).json().item;
  const antes = bytes(env);
  const doCloser = await criarCliente(env, { tipoPessoa: 'PF', nomeCompleto: 'Outra Pessoa' }, RAFAEL);
  assert.equal(doCloser.status, 403);
  assert.equal((await chamar(env, RAFAEL, { method: 'PATCH', url: rota(pf.id), body: { tipoPessoa: 'PJ' } })).status, 403);
  assert.equal((await chamar(env, null, { method: 'POST', url: '/api/crm', body: { tipoPessoa: 'PF', nomeCompleto: 'X' } })).status, 401);
  assert.equal(bytes(env), antes, 'nenhuma das três tentativas gravou');
  const leitura = await chamar(env, RAFAEL, { url: '/api/crm' });
  assert.equal(leitura.status, 200);
  assert.deepEqual([leitura.json().items[0].tipoPessoa, leitura.json().items[0].nomeCompleto], ['PF', 'Maria Souza']);
  // a recusa do closer vale mesmo com um corpo inválido (a autorização vem ANTES da validação)
  assert.equal((await criarCliente(env, {}, RAFAEL)).status, 403);
});

test('[PERSON-API-8] o corpo nunca decide a identidade nem as opções internas: userId/role/permissions/reviewedBy/actor e `exigirTipoPessoa` -> 400; o LOG não leva nome, documento nem corpo', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  for (const chave of ['userId', 'authUserId', 'role', 'permissions', 'reviewedBy', 'actor', 'exigirTipoPessoa']) {
    const r = await criarCliente(env, { tipoPessoa: 'PF', nomeCompleto: 'Maria', [chave]: chave === 'exigirTipoPessoa' ? false : 'forjado' });
    assert.equal(r.status, 400, chave);
    assert.equal(r.json().error.message, 'Campos não permitidos na requisição.', chave);
  }
  assert.equal(registros(env).length, 0);
  await criarCliente(env, { tipoPessoa: 'PF', nomeCompleto: 'Nome Que Nao Pode Ir Ao Log', cpf: CPF_A });
  assert.deepEqual(env.logs.at(-1), `POST /api/crm 201 user=${BRENO.userId}`);
  for (const linha of env.logs) for (const segredo of ['Nome Que Nao Pode Ir Ao Log', CPF_A, '52998224725']) assert.ok(!linha.includes(segredo), 'o log não carrega dado do cliente');
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// NEGOCIAÇÕES: o cliente (PF ou PJ) pelo ID estável, várias negociações, nada copiado dos campos financeiros legados
// ---------------------------------------------------------------------------------------------------------------------------------------
async function ambienteNegocios(t) {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, funnels: true, crmCatalogs: true, negotiations: true, commercialStorage: MODO });
  const funil = (await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'Inbound' } })).json().item;
  const etapa = (await chamar(env, BRENO, { method: 'POST', url: `/api/funnels/${encodeURIComponent(funil.id)}/stages`, body: { nome: 'Contato' } })).json().item;
  const servico = (await chamar(env, BRENO, { method: 'POST', url: '/api/crm-catalogs/servicos', body: { nome: 'Gestão de redes', precoReferencia: 1500, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL'] } })).json().item;
  const outroServico = (await chamar(env, BRENO, { method: 'POST', url: '/api/crm-catalogs/servicos', body: { nome: 'Site institucional', precoReferencia: 5000, permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [] } })).json().item;
  return { env, funil, etapa, servico, outroServico };
}
const negociar = (a, cliente, extras = {}, usuario = BRENO) =>
  chamar(a.env, usuario, { method: 'POST', url: '/api/negotiations', body: { crmRecordId: cliente.id, funnelId: a.funil.id, serviceId: a.servico.id, prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500, ...extras } });

test('[PERSON-API-9] NEGOCIAÇÃO para cliente PF e para cliente PJ: o nome certo aparece na negociação e no card do quadro (nome completo da PF, empresa da PJ), com o ID estável do cliente', async (t) => {
  const a = await ambienteNegocios(t);
  const pf = (await criarCliente(a.env, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: CPF_A })).json().item;
  const pj = (await criarCliente(a.env, { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: CNPJ_A })).json().item;
  const nPf = await negociar(a, pf);
  const nPj = await negociar(a, pj);
  assert.equal(nPf.status, 201);
  assert.equal(nPj.status, 201);
  assert.equal(nPf.json().item.crmRecordId, pf.id, 'vinculada ao ID estável do cliente');
  assert.deepEqual(nPf.json().item.cliente, { empresa: null, tipoPessoa: 'PF', nomeCompleto: 'Maria Souza' });
  assert.deepEqual(nPj.json().item.cliente, { empresa: 'Clínica Aurora', tipoPessoa: 'PJ', nomeCompleto: null });
  const quadro = (await chamar(a.env, BRENO, { url: '/api/funnel-board' })).json().quadro;
  const doPf = quadro.cards.find((card) => card.crmRecordId === pf.id);
  assert.deepEqual([doPf.crm.tipoPessoa, doPf.crm.nomeCompleto, doPf.crm.empresa], ['PF', 'Maria Souza', null]);
  assert.deepEqual(doPf.negociacao.cliente, { empresa: null, tipoPessoa: 'PF', nomeCompleto: 'Maria Souza' });
  // o cliente PF não tem CPF/CNPJ na projeção do quadro (só o necessário para mostrar o nome)
  assert.equal(Object.prototype.hasOwnProperty.call(doPf.crm, 'cpf'), false);
  assert.equal(JSON.stringify(quadro).includes('52998224725'), false, 'o quadro não leva o documento');
});

test('[PERSON-API-10] UM CLIENTE, VÁRIAS NEGOCIAÇÕES (serviços diferentes, no mesmo funil); cadastrar um cliente NÃO cria negociação; e valorProposta/valorTotal legados NÃO são copiados nem alterados', async (t) => {
  const a = await ambienteNegocios(t);
  const cliente = (await criarCliente(a.env, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', valorProposta: 777, valorTotal: 9999 })).json().item;
  assert.equal((await chamar(a.env, BRENO, { url: '/api/negotiations' })).json().items.length, 0, 'cadastrar o cliente não cria negociação');
  const primeira = await negociar(a, cliente);
  const segunda = await negociar(a, cliente, { serviceId: a.outroServico.id, formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 5000 });
  assert.deepEqual([primeira.status, segunda.status], [201, 201]);
  assert.notEqual(primeira.json().item.id, segunda.json().item.id);
  assert.notEqual(primeira.json().item.cardId, segunda.json().item.cardId, 'cada negociação tem o seu card');
  const doCliente = (await chamar(a.env, BRENO, { url: `/api/negotiations?crmRecordId=${encodeURIComponent(cliente.id)}` })).json().items;
  assert.equal(doCliente.length, 2);
  assert.deepEqual(doCliente.map((n) => n.valorNegociado).sort((x, y) => x - y), [1500, 5000]);
  // os campos legados do registro seguem como estavam (a negociação tem os seus próprios valores)
  const depois = registros(a.env).find((registro) => registro.id === cliente.id);
  assert.deepEqual([depois.valorProposta, depois.valorTotal], [777, 9999]);
  assert.equal(JSON.stringify(doCliente).includes('9999'), false, 'o valorTotal legado não vai para a negociação');
});

test('[PERSON-API-11] o COMMERCIAL_CLOSER abre negociação para qualquer cliente (PROPOSE:CRM), mas não cadastra cliente; um cliente BLOQUEADO (DNC) não recebe negociação nova', async (t) => {
  const a = await ambienteNegocios(t);
  const pf = (await criarCliente(a.env, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza' })).json().item;
  const doCloser = await negociar(a, pf, {}, RAFAEL);
  assert.equal(doCloser.status, 201);
  assert.equal(doCloser.json().item.responsavelNome, RAFAEL.name, 'o responsável é quem abriu (o token), nunca o corpo');
  assert.equal((await criarCliente(a.env, { tipoPessoa: 'PF', nomeCompleto: 'Outra' }, RAFAEL)).status, 403);
  assert.equal((await chamar(a.env, BRENO, { method: 'POST', url: rota(pf.id, '/dnc'), body: {} })).status, 200);
  const bloqueado = await negociar(a, pf);
  assert.equal(bloqueado.status, 400, 'cliente bloqueado não recebe negociação');
  assert.match(bloqueado.text, /CLIENTE_NAO_CONTATAR/);
});

test('[PERSON-API-12] a exclusão administrativa de uma PF (sem empresa) funciona pelo mesmo caminho de sempre — a PF não tem `empresa`, e a resposta confirma só o id', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const pf = (await criarCliente(env, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza' })).json().item;
  const r = await chamar(env, BRENO, { method: 'DELETE', url: rota(pf.id), body: { reason: 'cadastro duplicado de teste' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { deleted: true, id: pf.id });
  assert.equal(registros(env).length, 0);
});

test('[PERSON-API-13] o CARD AVULSO de um cliente PF/PJ no funil leva o tipo e o nome completo junto da empresa (para o nome certo aparecer), e nunca o documento', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true, funnels: true });
  const funil = (await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'Vendas' } })).json().item;
  await chamar(env, BRENO, { method: 'POST', url: `/api/funnels/${encodeURIComponent(funil.id)}/stages`, body: { nome: 'Contato' } });
  const pf = (await criarCliente(env, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: CPF_A })).json().item;
  const criado = await chamar(env, BRENO, { method: 'POST', url: `/api/funnels/${encodeURIComponent(funil.id)}/cards`, body: { crmRecordId: pf.id } });
  assert.equal(criado.status, 201);
  const card = criado.json().item;
  assert.deepEqual([card.crm.tipoPessoa, card.crm.nomeCompleto, card.crm.empresa], ['PF', 'Maria Souza', null]);
  assert.equal(Object.prototype.hasOwnProperty.call(card.crm, 'cpf'), false);
  assert.equal(criado.text.includes('52998224725'), false);
});
