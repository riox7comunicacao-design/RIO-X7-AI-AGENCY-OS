// Testes da rota de ingestão de prospecção (POST /api/prospecting/submit de src/server/app.js): a camada HTTP FINA sobre o Prospecting Service.
//
// O que estes testes protegem: a rota autentica pelo fluxo que já existe (Bearer -> verifyAccessToken real, contra um Supabase falso só na
// borda de rede -> AuthorizationContext) e entrega ao serviço SÓ o contexto e o corpo — o serviço autoriza (PROPOSE:LEAD_APPROVAL e READ:CRM),
// valida, processa e grava. A rota não duplica nada disso. Nada que o navegador manda vira identidade, permissão ou decisão; o corpo aceita
// até 4 MiB só nesta rota; os erros PROSPECTING_* viram HTTP de forma determinística com mensagem FIXA; e nada interno (stack, caminho, valor
// recusado, token, authUserId) sai. A maioria roda sobre peças REAIS (serviço, CRM, fila e lote em arquivos temporários); os testes que
// provam a DELEGAÇÃO e o mapeamento de erros usam um double do serviço. Tudo fictício (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const crm = require('../../src/crm');
const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { createApp, mapErrorToHttp, MAX_BODY_BYTES, MAX_PROSPECTING_BODY_BYTES } = require('../../src/server/app');
const { ProspectingError, PROSPECTING_ERROR } = require('../../src/services/prospectingService');
const { isIssuedAuthorizationContext } = require('../helpers/authFixtures');
const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');
const { analyzeSource, listSourceFiles, toPosix } = require('../helpers/staticImports');

const OPERADOR = { actor: 'HUMAN', reviewedBy: { userId: 'user-teste', name: 'Teste', role: 'ADMIN' }, motivo: 'teste' };

function makeRequest({ method = 'GET', url = '/', headers = {}, body, stream } = {}) {
  const req = stream || (body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]));
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return req;
}

async function chamar(env, usuario, { method = 'POST', url = '/api/prospecting/submit', body, headers = {}, contentType = 'application/json', stream } = {}) {
  const base = {};
  if (usuario) base.Authorization = `Bearer ${env.tokenFor(usuario.userId)}`;
  if ((body !== undefined || stream) && contentType !== null) base['content-type'] = contentType;
  const response = await env.app.handle(makeRequest({ method, url, headers: { ...base, ...headers }, body, stream }));
  return { status: response.status, headers: response.headers, text: response.body, json: () => JSON.parse(response.body) };
}

const ambiente = (t, opcoes = {}) => montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, prospeccao: true, ...opcoes });

const evidencia = (valor, tipoFonte = 'OFICIAL') => ({ valor, fonte: 'Fonte de teste', tipoFonte });
const achado = (nome, slug, extras = {}) => ({
  empresa: nome,
  tipo: 'clínica',
  cidade: 'Petrópolis',
  estado: 'RJ',
  nicho: 'Psicologia',
  campos: { site: [evidencia(`${slug}.example.test`)], instagram: [evidencia(`@${slug.replace(/-/g, '_')}`)], telefone: [evidencia('(24) 98765-1000')] },
  fontes: [`https://${slug}.example.test`],
  ...extras,
});
const corpo = (achados, briefing = {}) => ({ briefing: { nicho: 'Psicologia', quantidadeDesejada: 3, regiao: 'Petrópolis/RJ', ...briefing }, rawFindings: achados });

const sementeCrm = (env, especificacoes) => {
  const repositorio = createJsonFileCrmRepository(env.crmFilePath);
  for (const { campos, dnc } of especificacoes) {
    const { record } = crm.createRecord(repositorio, campos, OPERADOR);
    if (dnc) crm.markDoNotContact(repositorio, record.id, OPERADOR);
  }
};
const arquivo = (caminho) => (fs.existsSync(caminho) ? fs.readFileSync(caminho, 'utf8') : null);
// A fila de teste já nasce com 3 itens (testEnv): "sem efeitos" é a MESMA fila de antes, byte a byte.
const semEfeitos = (env) => ({
  crm: env.crmFilePath && arquivo(env.crmFilePath),
  fila: arquivo(env.filePath),
  conferir() {
    assert.equal(arquivo(env.filePath), this.fila, 'a fila não mudou');
    assert.equal(fs.existsSync(env.batchPath), false, 'nenhum lote gravado');
    assert.equal(arquivo(env.crmFilePath), this.crm, 'o CRM não mudou');
  },
});

const ROTA = '/api/prospecting/submit';

test('[PRO-API-1] sem token: 401; token inválido: 401 — o serviço nem é chamado e nada é gravado', async (t) => {
  const chamadas = [];
  const env = ambiente(t, { prospectingService: { submitProspecting: (...args) => (chamadas.push(args), {}) }, prospeccao: false });
  assert.equal((await chamar(env, null, { body: corpo([]) })).status, 401);
  assert.equal((await chamar(env, null, { body: corpo([]), headers: { Authorization: 'Bearer token-invalido' } })).status, 401);
  assert.equal((await chamar(env, null, { body: corpo([]), headers: { Authorization: 'Basic abc' } })).status, 401);
  assert.equal(chamadas.length, 0);
});

test('[PRO-API-2] o ADMIN autenticado submete: 201 com o relatório do serviço, a fila e o lote gravados, e o CRM intacto', async (t) => {
  const env = ambiente(t);
  const crmAntes = arquivo(env.crmFilePath);
  const filaAntes = Object.keys(JSON.parse(arquivo(env.filePath)).items).length;
  const resposta = await chamar(env, BRENO, { body: corpo([achado('Clínica Alfa Teste', 'alfa-teste'), achado('Clínica Beta Teste', 'beta-teste')]) });
  assert.equal(resposta.status, 201);
  const relatorio = resposta.json();
  assert.match(relatorio.loteId, /^lote:[0-9a-f-]{36}$/);
  assert.equal(relatorio.contagens.encontrados, 2);
  assert.equal(relatorio.contagens.validos, 2);
  assert.equal(relatorio.prospectIds.length, 2);
  assert.equal(relatorio.criadoPor.userId, BRENO.userId);
  assert.equal(Object.keys(JSON.parse(arquivo(env.filePath)).items).length, filaAntes + 2, 'os dois elegíveis entraram na fila');
  assert.ok(relatorio.prospectIds.every((id) => id in JSON.parse(arquivo(env.filePath)).items));
  assert.ok(JSON.parse(arquivo(env.batchPath))[relatorio.loteId], 'o lote foi gravado');
  assert.equal(arquivo(env.crmFilePath), crmAntes, 'nenhuma escrita direta no CRM');
  assert.equal(resposta.headers['Cache-Control'], 'no-store');
});

test('[PRO-API-3] o COMMERCIAL_CLOSER (sem PROPOSE:LEAD_APPROVAL): 403 com a mensagem fixa e NADA é lido nem gravado', async (t) => {
  const env = ambiente(t);
  sementeCrm(env, [{ campos: { empresa: 'Registro Existente', site: 'existente.example.test' } }]);
  const efeitos = semEfeitos(env);
  const resposta = await chamar(env, RAFAEL, { body: corpo([achado('Clínica Alfa Teste', 'alfa-teste')]) });
  assert.equal(resposta.status, 403);
  assert.deepEqual(resposta.json(), { error: { code: 'FORBIDDEN', message: 'Esta conta não possui acesso a esta área.' } });
  efeitos.conferir();
  // e a recusa vem antes de qualquer validação do corpo: nem um corpo inválido revela nada ao closer
  const invalido = await chamar(env, RAFAEL, { body: { userId: 'x' } });
  assert.equal(invalido.status, 403);
});

test('[PRO-API-4] um corpo válido executa o serviço UMA vez com (contexto emitido, o corpo) — nada de cabeçalhos, query ou identidade extra', async (t) => {
  const chamadas = [];
  const duplo = { submitProspecting: (...args) => (chamadas.push(args), { loteId: 'lote:11111111-1111-4111-8111-111111111111', contagens: {}, prospectIds: [] }) };
  const env = ambiente(t, { prospectingService: duplo, prospeccao: false });
  const enviado = corpo([achado('Clínica Alfa Teste', 'alfa-teste')]);
  const resposta = await chamar(env, BRENO, { body: enviado, headers: { 'x-user-id': 'user-x', 'x-role': 'ADMIN', 'x-forwarded-user': 'y' } });
  assert.equal(resposta.status, 201);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].length, 2, 'só o contexto e o corpo');
  assert.equal(isIssuedAuthorizationContext(chamadas[0][0]), true, 'o contexto é o EMITIDO pelo fluxo de autenticação');
  assert.deepEqual(chamadas[0][1], enviado);
});

test('[PRO-API-5] o autor vem do contexto autenticado, nunca do corpo: o mesmo corpo enviado por dois usuários diferentes chega ao serviço com contextos diferentes, e o lote real registra o autor do token', async (t) => {
  const contextos = [];
  const duplo = { submitProspecting: (contexto) => (contextos.push(contexto), {}) };
  const env = ambiente(t, { prospectingService: duplo, prospeccao: false });
  await chamar(env, BRENO, { body: corpo([]) });
  await chamar(env, RAFAEL, { body: corpo([]) });
  assert.deepEqual(contextos.map((c) => c.userId), [BRENO.userId, RAFAEL.userId]);

  const real = ambiente(t);
  const relatorio = (await chamar(real, BRENO, { body: corpo([achado('Clínica Alfa Teste', 'alfa-teste')]) })).json();
  assert.deepEqual(relatorio.criadoPor, { userId: BRENO.userId, name: BRENO.name, role: 'ADMIN' });
  assert.equal(JSON.parse(arquivo(real.batchPath))[relatorio.loteId].criadoPor.userId, BRENO.userId);
});

test('[PRO-API-6] chave extra no corpo: 400 PROSPECTING_INVALID_INPUT, com o caminho da chave (nunca o valor), e nada é gravado', async (t) => {
  const env = ambiente(t);
  const efeitos = semEfeitos(env);
  const resposta = await chamar(env, BRENO, { body: { ...corpo([]), extra: 'SEGREDO-NAO-REPETIR' } });
  assert.equal(resposta.status, 400);
  const erro = resposta.json().error;
  assert.equal(erro.code, 'PROSPECTING_INVALID_INPUT');
  assert.deepEqual(erro.details, [{ path: 'extra', code: 'CAMPO_DESCONHECIDO' }]);
  assert.equal(resposta.text.includes('SEGREDO'), false);
  efeitos.conferir();
});

test('[PRO-API-7] campos de autorização, identidade ou decisão enviados pelo cliente — no corpo, no briefing ou num achado — são recusados (400) e nada é gravado', async (t) => {
  const env = ambiente(t);
  const efeitos = semEfeitos(env);
  const proibidos = ['userId', 'role', 'permissions', 'actor', 'reviewedBy', 'approvalId', 'status', 'loteId', 'criadoPor', 'criadoEm', 'contagens', 'authUserId', 'token', 'access_token', 'dataDaPesquisa', 'validos', 'prospectIds'];
  for (const chave of proibidos) {
    const noCorpo = await chamar(env, BRENO, { body: { ...corpo([achado('X Teste', 'x-teste')]), [chave]: 'forjado' } });
    assert.equal(noCorpo.status, 400, `corpo.${chave}`);
    assert.equal(noCorpo.json().error.code, 'PROSPECTING_INVALID_INPUT', `corpo.${chave}`);
    const noBriefing = await chamar(env, BRENO, { body: corpo([achado('X Teste', 'x-teste')], { [chave]: 'forjado' }) });
    assert.equal(noBriefing.status, 400, `briefing.${chave}`);
    assert.equal(noBriefing.json().error.code, 'PROSPECTING_BRIEFING_INVALID', `briefing.${chave}`);
    const noAchado = await chamar(env, BRENO, { body: corpo([{ ...achado('X Teste', 'x-teste'), [chave]: 'forjado' }]) });
    assert.equal(noAchado.status, 400, `achado.${chave}`);
    assert.equal(noAchado.json().error.code, 'PROSPECTING_RAW_FINDINGS_INVALID', `achado.${chave}`);
  }
  efeitos.conferir();
});

test('[PRO-API-8] corpo ausente, vazio, quebrado, que não é objeto, sem uma das chaves, ou com Content-Type errado: recusados (400/415), nada é gravado, e __proto__ não polui nada', async (t) => {
  const env = ambiente(t);
  const efeitos = semEfeitos(env);
  const ruim = async (opcoes, esperado, rotulo) => assert.equal((await chamar(env, BRENO, opcoes)).status, esperado, rotulo);
  await ruim({}, 415, 'sem corpo e sem Content-Type');
  await ruim({ body: '', contentType: 'application/json' }, 400, 'corpo vazio');
  await ruim({ body: '{ quebrado' }, 400, 'JSON quebrado');
  await ruim({ body: '[]' }, 400, 'lista');
  await ruim({ body: 'null' }, 400, 'null');
  await ruim({ body: '"texto"' }, 400, 'texto');
  await ruim({ body: '42' }, 400, 'número');
  await ruim({ body: {} }, 400, '{}');
  await ruim({ body: { briefing: { nicho: 'X Nicho', quantidadeDesejada: 1 } } }, 400, 'sem rawFindings');
  await ruim({ body: { rawFindings: [] } }, 400, 'sem briefing');
  await ruim({ body: corpo([]), contentType: 'text/plain' }, 415, 'text/plain');
  await ruim({ body: corpo([]), contentType: null }, 415, 'sem Content-Type');
  await ruim({ body: '{"briefing":{"nicho":"X Nicho","quantidadeDesejada":1},"rawFindings":[],"__proto__":{"polluted":true}}' }, 400, '__proto__');
  assert.equal({}.polluted, undefined);
  // bombas de aninhamento e de tamanho (dentro do limite de 4 MiB): recusadas como JSON inválido ou pelo esquema, sem travar nem estourar
  await ruim({ body: '['.repeat(1000000) }, 400, 'aninhamento de 1 milhão de níveis');
  await ruim({ body: JSON.stringify({ briefing: { nicho: 'X Nicho', quantidadeDesejada: 1 }, rawFindings: [{ empresa: 'X', campos: JSON.parse('{"a":'.repeat(50) + '1' + '}'.repeat(50)) }] }) }, 400, 'achado profundo');
  const comQuery = await chamar(env, BRENO, { url: `${ROTA}?loteId=1`, body: corpo([]) });
  assert.equal(comQuery.status, 400, 'query string não é aceita');
  efeitos.conferir();
});

test('[PRO-API-9] corpo acima de 4 MiB: 413, o corpo não é processado e o serviço nem é chamado — declarado no Content-Length ou só no fluxo; e o limite geral das outras rotas continua 16 KiB', async (t) => {
  assert.equal(MAX_PROSPECTING_BODY_BYTES, 4 * 1024 * 1024);
  assert.equal(MAX_BODY_BYTES, 16 * 1024, 'o limite geral NÃO mudou');
  const chamadas = [];
  const env = ambiente(t, { prospectingService: { submitProspecting: (...args) => (chamadas.push(args), {}) }, prospeccao: false });

  const declarado = await chamar(env, BRENO, { body: '{}', headers: { 'content-length': String(MAX_PROSPECTING_BODY_BYTES + 1) } });
  assert.equal(declarado.status, 413);
  assert.deepEqual(declarado.json(), { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Requisição grande demais.' } });
  assert.equal(declarado.headers.Connection, 'close');

  const naoDeclarado = await chamar(env, BRENO, { stream: Readable.from([Buffer.alloc(MAX_PROSPECTING_BODY_BYTES), Buffer.from('x')]) });
  assert.equal(naoDeclarado.status, 413);
  assert.equal(chamadas.length, 0, 'nada acima do limite é processado');

  // exatamente no limite (com JSON válido) é aceito pelo transporte; acima de 16 KiB é aceito aqui, mas não nas outras rotas
  const grande = JSON.stringify(corpo([achado('Clínica Alfa Teste', 'alfa-teste', { observacoesBrutas: 'x'.repeat(3000) })]));
  const grandeComLength = JSON.stringify(corpo(Array.from({ length: 60 }, (_, i) => achado(`Clínica ${i} Teste`, `grande-${i}-teste`, { observacoesBrutas: 'y'.repeat(900) }))));
  assert.ok(grandeComLength.length > MAX_BODY_BYTES && grandeComLength.length < MAX_PROSPECTING_BODY_BYTES);
  const comContentLength = await chamar(env, BRENO, { body: grandeComLength, headers: { 'content-length': String(Buffer.byteLength(grandeComLength)) } });
  assert.equal(comContentLength.status, 201, 'um Content-Length declarado dentro dos 4 MiB é aceito nesta rota');
  assert.ok(grande.length > 2 * 1024 && grande.length < MAX_PROSPECTING_BODY_BYTES);
  const aceito = await chamar(env, BRENO, { body: grande });
  assert.equal(aceito.status, 201);
  assert.equal(chamadas.length, 2, "os dois corpos aceitos chegaram ao serviço, uma vez cada");
  const outraRota = await chamar(env, BRENO, { url: '/api/approvals/x/approve', body: JSON.stringify({ reason: 'x'.repeat(20 * 1024) }) });
  assert.equal(outraRota.status, 413, 'as outras rotas continuam com 16 KiB');
});

test('[PRO-API-10] 150 achados de verdade cabem no limite: a submissão real de 150 candidatos (o modelo: ~100 pedidos + até 50 de reserva) passa pelo transporte e pelo serviço (e um a mais é recusado pelo esquema, não pelo transporte)', async (t) => {
  const env = ambiente(t);
  const achados = Array.from({ length: 150 }, (_, i) => achado(`Clínica Número ${i} Teste`, `numero-${i}-teste`, { observacoesBrutas: 'Atende adultos e adolescentes. '.repeat(20) }));
  const texto = JSON.stringify(corpo(achados, { quantidadeDesejada: 100 }));
  assert.ok(texto.length < MAX_PROSPECTING_BODY_BYTES, `150 achados ocupam ${texto.length} bytes`);
  const resposta = await chamar(env, BRENO, { body: texto });
  assert.equal(resposta.status, 201);
  assert.equal(resposta.json().contagens.encontrados, 150);
  assert.equal(resposta.json().status, 'META_ATINGIDA');
  const demais = await chamar(env, BRENO, { body: corpo([...achados, achado('Um a mais', 'um-a-mais')], { quantidadeDesejada: 100 }) });
  assert.equal(demais.status, 400);
  assert.equal(demais.json().error.code, 'PROSPECTING_RAW_FINDINGS_INVALID');
  assert.deepEqual(demais.json().error.details, [{ path: '', code: 'LOTE_EXCESSIVO' }]);
});

test('[PRO-API-11] cada código PROSPECTING_* vira o HTTP certo, com mensagem FIXA — e a lista da API não diverge do serviço', async (t) => {
  const tabela = {
    [PROSPECTING_ERROR.INVALID_INPUT]: 400,
    [PROSPECTING_ERROR.BRIEFING_INVALID]: 400,
    [PROSPECTING_ERROR.RAW_FINDINGS_INVALID]: 400,
    [PROSPECTING_ERROR.CANDIDATE_INVALID]: 422,
    [PROSPECTING_ERROR.CONFLICT]: 409,
    [PROSPECTING_ERROR.NOT_FOUND]: 404,
    [PROSPECTING_ERROR.CRM_INVALID]: 503,
    [PROSPECTING_ERROR.PERSISTENCE]: 503,
  };
  assert.deepEqual(Object.keys(tabela).sort(), Object.values(PROSPECTING_ERROR).sort(), 'todo código do serviço tem um mapeamento (e só eles)');
  const mensagens = new Set();
  for (const [codigo, status] of Object.entries(tabela)) {
    const duplo = { submitProspecting: () => { throw new ProspectingError(codigo, { errors: [{ path: 'briefing.nicho', code: 'CAMPO_OBRIGATORIO', message: 'texto' }], prospectIds: ['id:segredo.example.test'] }); } };
    const env = ambiente(t, { prospectingService: duplo, prospeccao: false });
    const resposta = await chamar(env, BRENO, { body: corpo([]) });
    assert.equal(resposta.status, status, codigo);
    const erro = resposta.json().error;
    assert.equal(erro.code, codigo);
    assert.match(erro.message, /[.]$/);
    mensagens.add(erro.message);
    assert.equal(resposta.text.includes('segredo'), false, `${codigo}: os ids dos prospects não saem no erro`);
    assert.equal(resposta.text.includes('Prospecção:'), false, 'a mensagem do serviço não é repetida (a da API é fixa)');
    if (status === 400) assert.deepEqual(erro.details, [{ path: 'briefing.nicho', code: 'CAMPO_OBRIGATORIO' }], codigo);
    else assert.equal('details' in erro, false, `${codigo}: sem detalhes fora da validação`);
  }
  assert.equal(mensagens.size, 8, 'cada código tem a sua mensagem');
});

test('[PRO-API-12] os detalhes de validação são reconferidos: caminho e código hostis, longos ou em excesso nunca saem como vieram (só forma segura, no máximo 50)', () => {
  const hostil = new ProspectingError(PROSPECTING_ERROR.RAW_FINDINGS_INVALID, {
    errors: [
      { path: 'rawFindings[0].empresa', code: 'CAMPO_OBRIGATORIO' },
      { path: '<script>alert(1)</script>', code: 'x<y>' },
      { path: 'a'.repeat(500), code: 'A'.repeat(500) },
      { path: 5, code: null },
      null,
      ...Array.from({ length: 80 }, () => ({ path: 'p', code: 'C' })),
    ],
  });
  const falha = mapErrorToHttp(hostil);
  assert.equal(falha.status, 400);
  assert.equal(falha.details.length, 50);
  assert.deepEqual(falha.details.slice(0, 5), [
    { path: 'rawFindings[0].empresa', code: 'CAMPO_OBRIGATORIO' },
    { path: '', code: 'INVALIDO' },
    { path: '', code: 'INVALIDO' },
    { path: '', code: 'INVALIDO' },
    { path: '', code: 'INVALIDO' },
  ]);
  assert.equal(JSON.stringify(falha).includes('script'), false);
  assert.equal('details' in mapErrorToHttp(new ProspectingError(PROSPECTING_ERROR.BRIEFING_INVALID)), false, 'sem detalhes no erro, nenhum campo details');
  assert.equal('details' in mapErrorToHttp(new ProspectingError(PROSPECTING_ERROR.BRIEFING_INVALID, { errors: 'não é lista' })), false);
});

test('[PRO-API-13] erro desconhecido: 500 genérico; um `code` que só PARECE do serviço, ou herdado do protótipo, também; a recusa de autorização nunca vira erro de candidato', async (t) => {
  const segredo = 'ENOENT C:\\dados\\fila.json token=abc123 authUserId=auth-breno';
  for (const erro of [new Error(segredo), Object.assign(new Error(segredo), { code: 'PROSPECTING_INVENTADO' }), Object.assign(new Error(segredo), { code: 'constructor' }), Object.assign(new Error(segredo), { code: '__proto__' }), 'texto solto', null, undefined, 42]) {
    const env = ambiente(t, { prospectingService: { submitProspecting: () => { throw erro; } }, prospeccao: false });
    const resposta = await chamar(env, BRENO, { body: corpo([]) });
    assert.equal(resposta.status, 500, String(erro && erro.code));
    assert.deepEqual(resposta.json(), { error: { code: 'INTERNAL', message: 'Erro interno. Tente novamente em instantes.' } });
  }
  // a recusa de autorização (mensagem do serviço de autorização) continua 403 — não vira 422 nem 500
  const negado = ambiente(t, { prospectingService: { submitProspecting: () => { throw new Error('acesso negado: userId=user-x não possui a permissão PROPOSE:LEAD_APPROVAL'); } }, prospeccao: false });
  const resposta = await chamar(negado, BRENO, { body: corpo([]) });
  assert.equal(resposta.status, 403);
  assert.equal(resposta.json().error.code, 'FORBIDDEN');
  assert.equal(resposta.text.includes('user-x'), false);
});

test('[PRO-API-14] nada interno sai: nem stack, caminho de arquivo, valor recusado, id de prospect, token, authUserId ou permissões — no sucesso e nos erros; e o token não vai para o log', async (t) => {
  const env = ambiente(t);
  const respostas = [
    await chamar(env, BRENO, { body: corpo([achado('Clínica Alfa Teste', 'alfa-teste')]) }),
    await chamar(env, BRENO, { body: { ...corpo([]), extra: 'VALOR-RECUSADO' } }),
    await chamar(env, BRENO, { body: corpo([{ empresa: 'X', fontes: ['javascript:VALOR-RECUSADO'] }]) }),
    await chamar(env, RAFAEL, { body: corpo([]) }),
    await chamar(env, BRENO, { body: '{ quebrado VALOR-RECUSADO' }),
  ];
  for (const resposta of respostas) {
    for (const proibido of ['VALOR-RECUSADO', 'authUserId', 'auth-breno', 'access_token', 'permissions', 'APPROVE:', 'WRITE:CRM', 'node_modules', '.js:', 'approval-queue', 'prospecting-batches', 'crm.json', env.dir || '@@', path.sep + 'Users' + path.sep, 'stack']) {
      assert.equal(resposta.text.includes(proibido), false, `${resposta.status}: "${proibido}" na resposta`);
    }
    assert.doesNotMatch(resposta.text, /\bat \w[\w.]*\s?\(/);
  }
  assert.equal(env.logs.join('\n').includes(env.tokenFor(BRENO.userId)), false, 'o token nunca vai para o log');
});

test('[PRO-API-15] só POST: GET, PUT, PATCH, DELETE, OPTIONS e HEAD recebem 405 com Allow: POST, sem executar o serviço — e não há CORS', async (t) => {
  const chamadas = [];
  const env = ambiente(t, { prospectingService: { submitProspecting: (...args) => (chamadas.push(args), {}) }, prospeccao: false });
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const resposta = await chamar(env, BRENO, { method, body: method === 'GET' || method === 'HEAD' ? undefined : corpo([]) });
    assert.equal(resposta.status, 405, method);
    assert.equal(resposta.headers.Allow, 'POST', method);
    assert.equal(Object.keys(resposta.headers).some((chave) => /^access-control-/i.test(chave)), false, `${method}: sem CORS`);
  }
  const sucesso = await chamar(env, BRENO, { body: corpo([]), headers: { Origin: 'https://outro-site.example.test' } });
  assert.equal(Object.keys(sucesso.headers).some((chave) => /^access-control-/i.test(chave)), false);
  assert.equal(chamadas.length, 1);
  // 405 só depois de o app existir: um caminho parecido é 404, não a rota
  assert.equal((await chamar(env, BRENO, { url: `${ROTA}/x`, body: corpo([]) })).status, 404);
  assert.equal((await chamar(env, BRENO, { url: '/api/prospecting', body: corpo([]) })).status, 404);
  assert.equal((await chamar(env, BRENO, { url: '/api/prospecting/lotes', method: 'GET' })).status, 404);
});

test('[PRO-API-16] sem o serviço injetado a rota NÃO existe (404), como antes — e a fábrica do app recusa um serviço inválido (falha fechada)', async (t) => {
  const env = montarAmbiente(t, { crm: true });
  assert.equal((await chamar(env, BRENO, { body: corpo([]) })).status, 404);
  const base = { verifyAccessToken: env.verifyAccessToken, userStore: env.userStore, approvalQueueService: env.approvalQueueService, crmService: env.crmService, publicConfig: env.publicConfig, staticRoot: env.staticRoot, staticFiles: env.staticFiles };
  for (const invalido of [null, {}, { submitProspecting: 'x' }, 42]) {
    assert.throws(() => createApp({ ...base, prospectingService: invalido }), /prospectingService/);
  }
});

test('[PRO-API-17] DNC do CRM real pela rota: o registro em DO_NOT_CONTACT NUNCA vira item da fila (o relatório o mostra como DNC), e o CRM não é escrito', async (t) => {
  const env = ambiente(t);
  sementeCrm(env, [{ campos: { empresa: 'Bloqueada Um', site: 'bloqueada-um.example.test', telefone: '24 90000-3333' }, dnc: true }]);
  const crmAntes = arquivo(env.crmFilePath);
  const resposta = await chamar(env, BRENO, { body: corpo([achado('Nome Diferente', 'bloqueada-um'), achado('Clínica Livre', 'livre-teste')]) });
  assert.equal(resposta.status, 201);
  const relatorio = resposta.json();
  const porNome = Object.fromEntries(relatorio.resultados.map((r) => [r.empresa, r]));
  assert.equal(porNome['Nome Diferente'].estadoOperacional, 'DNC');
  assert.equal(porNome['Nome Diferente'].naFila, false);
  assert.equal(porNome['Clínica Livre'].naFila, true);
  const nomesNaFila = Object.values(JSON.parse(arquivo(env.filePath)).items).map((i) => i.empresa);
  assert.ok(nomesNaFila.includes('Clínica Livre'));
  assert.equal(nomesNaFila.includes('Nome Diferente'), false, 'o candidato bloqueado não entrou');
  assert.deepEqual(relatorio.prospectIds.length, 1);
  assert.equal(arquivo(env.crmFilePath), crmAntes);
});

test('[PRO-API-18] a rota é só transporte e não abre um caminho até o CRM: app.js só importa o barrel de auth e o servidor de estáticos, nenhum arquivo de src/server importa src/crm, e a rota não usa nenhuma operação de escrita', () => {
  const raiz = path.join(__dirname, '..', '..');
  const arquivos = listSourceFiles(path.join(raiz, 'src', 'server')).filter((f) => f.endsWith('.js'));
  assert.ok(arquivos.length >= 3);
  for (const arquivoServidor of arquivos) {
    const analise = analyzeSource(fs.readFileSync(arquivoServidor, 'utf8'), toPosix(path.relative(raiz, arquivoServidor)));
    assert.deepEqual(analise.issues, []);
    for (const ref of analise.refs) {
      assert.doesNotMatch(ref.specifier, /(^|\/)crm(\/|$)/, `${path.basename(arquivoServidor)} não importa src/crm (${ref.specifier})`);
      assert.doesNotMatch(ref.specifier, /research-prospector/, `${path.basename(arquivoServidor)} não importa o domínio do Prospector (${ref.specifier})`);
    }
  }
  const app = analyzeSource(fs.readFileSync(path.join(raiz, 'src', 'server', 'app.js'), 'utf8'), 'src/server/app.js');
  assert.deepEqual(app.refs.map((r) => r.specifier).sort(), ['../auth', './static']);
  const codigo = fs.readFileSync(path.join(raiz, 'src', 'server', 'app.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const trecho = codigo.slice(codigo.indexOf("route.name === 'prospecting-submit'"), codigo.indexOf("route.name === 'prospecting-submit'") + 500);
  for (const proibido of [/createRecord|updateRecord|moveStatus|markDoNotContact/, /writeFile|saveQueue|\.add\(/, /approveProspect|rejectProspect|promoteProspect/, /PERMISSION|hasPermission|requirePermission/]) {
    assert.doesNotMatch(trecho, proibido, String(proibido));
  }
});

test('[PRO-API-19] a rota chama o serviço UMA vez por requisição, e uma requisição concorrente idêntica não compartilha estado (cada uma tem o seu contexto e o seu resultado)', async (t) => {
  const chamadas = [];
  const duplo = { submitProspecting: (contexto, corpoRecebido) => (chamadas.push([contexto.userId, corpoRecebido.briefing.nicho]), { loteId: `lote:${'a'.repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, nicho: corpoRecebido.briefing.nicho }) };
  const env = ambiente(t, { prospectingService: duplo, prospeccao: false });
  const [a, b] = await Promise.all([chamar(env, BRENO, { body: corpo([], { nicho: 'Nicho Um' }) }), chamar(env, BRENO, { body: corpo([], { nicho: 'Nicho Dois' }) })]);
  assert.deepEqual([a.json().nicho, b.json().nicho], ['Nicho Um', 'Nicho Dois']);
  assert.equal(chamadas.length, 2);
});

test('[PRO-API-20] servidor HTTP de verdade (socket): POST autenticado devolve 201; sem token, 401; corpo maior que 4 MiB é cortado com 413 sem ser processado', async (t) => {
  const http = require('node:http');
  const env = ambiente(t);
  const servidor = http.createServer(env.app.listener);
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => servidor.close(resolve)));
  const { port } = servidor.address();
  const pedir = (cabecalhos, texto) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: ROTA, method: 'POST', headers: cabecalhos }, (res) => {
        const partes = [];
        res.on('data', (parte) => partes.push(parte));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(partes).toString('utf8') }));
      });
      req.on('error', (erro) => (erro.code === 'ECONNRESET' || erro.code === 'EPIPE' ? resolve({ status: 'cortado', text: '' }) : reject(erro)));
      req.end(texto);
    });
  const autenticado = { 'content-type': 'application/json', Authorization: `Bearer ${env.tokenFor(BRENO.userId)}` };
  const ok = await pedir(autenticado, JSON.stringify(corpo([achado('Clínica Alfa Teste', 'alfa-teste')])));
  assert.equal(ok.status, 201);
  assert.equal((await pedir({ 'content-type': 'application/json' }, JSON.stringify(corpo([])))).status, 401);
  const gigante = await pedir(autenticado, 'x'.repeat(MAX_PROSPECTING_BODY_BYTES + 1024));
  assert.ok([413, 'cortado'].includes(gigante.status), `status ${gigante.status}`);
  assert.equal(Object.keys(JSON.parse(arquivo(env.batchPath))).length, 1, 'só o lote do primeiro pedido existe');
});
