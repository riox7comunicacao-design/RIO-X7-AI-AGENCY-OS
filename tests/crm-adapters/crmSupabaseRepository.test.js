// Adapter Postgres/Supabase do CRM (decisão 0024, etapa 2) — NENHUM teste aqui toca a rede real: todo `fetch` é
// um DOUBLE injetado. Como cinto e suspensório, o fetch GLOBAL é substituído por uma função que lança, para todo
// o arquivo — se qualquer código (do adapter ou de um teste mal escrito) chamar `fetch` sem passar por
// `fetchImpl`, o teste falha imediatamente em vez de tentar uma conexão de verdade.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { assertValidRepository } = require('../../src/crm/crmRepositoryPort');
const { createSupabaseCrmRepository, DEFAULT_TABLE, CRM_REPOSITORY_ERROR } = require('../../src/crm-adapters/crmSupabaseRepository');
const { recordToRow } = require('../../src/crm-adapters/crmSupabaseMapping');

const REPO_ROOT = path.join(__dirname, '..', '..');
const URL_DE_TESTE = 'https://projeto-de-teste.supabase.co';
const CHAVE_DE_TESTE = 'service-role-de-teste-nao-real';

let fetchOriginal;
before(() => {
  fetchOriginal = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('teste tentou acessar a rede real via fetch global — todo fetch precisa ser injetado (fetchImpl)');
  };
});
after(() => {
  globalThis.fetch = fetchOriginal;
});

// Um `fetch` falso: registra cada chamada e devolve a resposta programada em ordem (ou a última, se só houver uma).
function fetchFalso(...respostas) {
  const chamadas = [];
  let indice = 0;
  const fn = async (url, init) => {
    chamadas.push({ url: url instanceof URL ? url : new URL(String(url)), init });
    const resposta = respostas[Math.min(indice, respostas.length - 1)];
    indice += 1;
    return typeof resposta === 'function' ? resposta() : resposta;
  };
  fn.chamadas = chamadas;
  return fn;
}
const jsonResposta = (corpo, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(corpo) });

const registro = (overrides = {}) => ({
  id: 'crm:22222222-2222-4222-8222-222222222222',
  status: 'PROSPECT',
  dataDeEntrada: '2026-09-27T10:00:00.000Z',
  historico: [{ timestamp: '2026-09-27T10:00:00.000Z', from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: null, motivo: null }],
  empresa: 'Clínica Repositório Teste',
  contato: null, cargo: null, telefone: null, whatsapp: null, email: null, site: null, instagram: null, facebook: null,
  googlePerfil: null, cidade: null, estado: null, nicho: null, origem: null, temperatura: null, servicoPotencial: null,
  problemaIdentificado: null, raioXDeNicho: null, raioXPersonalizado: null, statusDoDiagnostico: null, linkDoRaioX: null,
  dataDaAnalise: null, dataDaReuniao: null, linkDoMeet: null, proximaAcao: null, dataDaProximaAcao: null, responsavel: null,
  ultimaInteracao: null, valorProposta: null, valorTotal: null, observacoes: null,
  ...overrides,
});

// ===========================================================================
// Composição / configuração
// ===========================================================================
test('[SBR-1] sem config explícita e sem env: recusa citando a variável ausente, e NUNCA chama fetch', () => {
  const fetch1 = fetchFalso();
  assert.throws(() => createSupabaseCrmRepository({ env: {}, fetchImpl: fetch1 }), /SUPABASE_URL não está configurada/);
  const fetch2 = fetchFalso();
  assert.throws(() => createSupabaseCrmRepository({ env: { SUPABASE_URL: URL_DE_TESTE }, fetchImpl: fetch2 }), /SUPABASE_SERVICE_ROLE_KEY não está configurada/);
  assert.deepEqual(fetch1.chamadas, []);
  assert.deepEqual(fetch2.chamadas, []);
});

test('[SBR-2] config explícita (url + serviceRoleKey) tem prioridade sobre o ambiente — e o repositório criado satisfaz o contrato da porta (assertValidRepository)', () => {
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, env: {}, fetchImpl: fetchFalso() });
  assert.equal(assertValidRepository(repo), repo);
  assert.equal(typeof repo.list, 'function');
  assert.equal(typeof repo.getById, 'function');
  assert.equal(typeof repo.save, 'function');
  assert.equal(typeof repo.delete, 'function');
});

test('[SBR-3] fetchImpl inválido é recusado antes de qualquer outra coisa', () => {
  assert.throws(() => createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl: 'não é função' }), /fetchImpl deve ser uma função/);
});

// ===========================================================================
// list()
// ===========================================================================
test('[SBR-4] list(): GET com select=* e order=seq.asc, cabeçalhos apikey/Authorization com a chave, e cada linha vira um registro (sem seq/version/updated_at)', async (t) => {
  const linha1 = recordToRow(registro({ id: 'crm:33333333-3333-4333-8333-333333333333', empresa: 'Alfa' }));
  const linha2 = { ...recordToRow(registro({ id: 'crm:44444444-4444-4444-8444-444444444444', empresa: 'Beta' })), seq: 2, version: 3, updated_at: '2026-09-27T00:00:00Z' };
  const fetchImpl = fetchFalso(jsonResposta([linha1, linha2]));
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });

  const registros = await repo.list();
  assert.equal(fetchImpl.chamadas.length, 1);
  const { url, init } = fetchImpl.chamadas[0];
  assert.equal(init.method, 'GET');
  assert.equal(url.pathname, `/rest/v1/${DEFAULT_TABLE}`);
  assert.equal(url.searchParams.get('select'), '*');
  assert.equal(url.searchParams.get('order'), 'seq.asc');
  assert.equal(init.headers.apikey, CHAVE_DE_TESTE);
  assert.equal(init.headers.Authorization, `Bearer ${CHAVE_DE_TESTE}`);

  assert.equal(registros.length, 2);
  assert.deepEqual(registros.map((r) => r.empresa), ['Alfa', 'Beta']);
  for (const r of registros) for (const chave of ['seq', 'version', 'updated_at']) assert.equal(Object.prototype.hasOwnProperty.call(r, chave), false);
});

test('[SBR-5] list(): resposta vazia vira lista vazia', async () => {
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl: fetchFalso(jsonResposta([])) });
  assert.deepEqual(await repo.list(), []);
});

// ===========================================================================
// getById()
// ===========================================================================
test('[SBR-6] getById(): filtra por id=eq.<id>&limit=1, devolve o registro mapeado, ou null se a lista vier vazia', async () => {
  const alvo = registro({ id: 'crm:55555555-5555-4555-8555-555555555555', empresa: 'Encontrado' });
  const fetchImpl = fetchFalso(jsonResposta([recordToRow(alvo)]));
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });

  const achado = await repo.getById(alvo.id);
  const { url, init } = fetchImpl.chamadas[0];
  assert.equal(init.method, 'GET');
  assert.equal(url.searchParams.get('id'), `eq.${alvo.id}`);
  assert.equal(url.searchParams.get('limit'), '1');
  assert.deepEqual(achado, alvo);

  const repoVazio = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl: fetchFalso(jsonResposta([])) });
  assert.equal(await repoVazio.getById('crm:00000000-0000-4000-8000-000000000000'), null);
});

test('[SBR-7] getById() com id vazio ou que não é texto devolve null SEM chamar fetch', async () => {
  const fetchImpl = fetchFalso();
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });
  for (const id of ['', null, undefined, 42]) assert.equal(await repo.getById(id), null, String(id));
  assert.deepEqual(fetchImpl.chamadas, []);
});

// ===========================================================================
// save()
// ===========================================================================
test('[SBR-8] save(): POST com Prefer de upsert (merge-duplicates) e return=minimal, corpo é [linha], nada é devolvido', async () => {
  const reg = registro();
  const fetchImpl = fetchFalso({ ok: true, status: 201, text: async () => '' });
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });

  const resultado = await repo.save(reg);
  assert.equal(resultado, undefined, 'save() não devolve nada, como os outros adapters');
  const { url, init } = fetchImpl.chamadas[0];
  assert.equal(init.method, 'POST');
  assert.equal(url.pathname, `/rest/v1/${DEFAULT_TABLE}`);
  assert.equal(init.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), [recordToRow(reg)]);
});

test('[SBR-9] save() recusa um registro sem id, ou com id inseguro (__proto__/constructor/prototype) — SEM chamar fetch', async () => {
  const fetchImpl = fetchFalso();
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });
  for (const invalido of [null, {}, { id: '' }, { id: 42 }]) {
    await assert.rejects(() => repo.save(invalido), /save\(\) exige um registro com id/);
  }
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    await assert.rejects(() => repo.save(registro({ id })), /id de registro não permitido/);
  }
  assert.deepEqual(fetchImpl.chamadas, []);
});

// ===========================================================================
// delete() — exclusão ADMINISTRATIVA e IRREVERSÍVEL, via RPC transacional (decisão 0025)
// ===========================================================================
const OPERADOR = Object.freeze({ userId: 'user-admin-1', name: 'Administradora', role: 'ADMIN' });

test('[SBR-21] delete(): chama o RPC delete_crm_record_with_audit por POST — NUNCA um DELETE simples do PostgREST —, com os cinco parâmetros certos e a service_role só no cabeçalho', async () => {
  const fetchImpl = fetchFalso({ ok: true, status: 200, text: async () => '' });
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });
  const id = 'crm:55555555-5555-4555-8555-555555555555';

  const resultado = await repo.delete(id, { reviewedBy: OPERADOR, motivo: 'registro de teste, duplicado' });
  assert.equal(resultado, undefined, 'delete() não devolve nada, como os outros adapters');
  assert.equal(fetchImpl.chamadas.length, 1);
  const { url, init } = fetchImpl.chamadas[0];
  assert.equal(init.method, 'POST');
  assert.equal(url.pathname, '/rest/v1/rpc/delete_crm_record_with_audit');
  assert.equal(init.headers.apikey, CHAVE_DE_TESTE);
  assert.equal(init.headers.Authorization, `Bearer ${CHAVE_DE_TESTE}`);
  assert.deepEqual(JSON.parse(init.body), {
    p_id: id,
    p_deleted_by_user_id: OPERADOR.userId,
    p_deleted_by_name: OPERADOR.name,
    p_deleted_by_role: OPERADOR.role,
    p_reason: 'registro de teste, duplicado',
  });
  assert.equal(JSON.stringify(init.body).includes(CHAVE_DE_TESTE), false, 'a service_role nunca vai no CORPO, só no cabeçalho');
});

test('[SBR-22] delete() exige um id (texto não vazio) e recusa ids inseguros (__proto__/constructor/prototype) — SEM chamar fetch', async () => {
  const fetchImpl = fetchFalso();
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });
  for (const invalido of [undefined, null, 42, '', {}, []]) {
    await assert.rejects(() => repo.delete(invalido, { reviewedBy: OPERADOR, motivo: 'x' }), /delete\(\) exige um id/, String(invalido));
  }
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    await assert.rejects(() => repo.delete(id, { reviewedBy: OPERADOR, motivo: 'x' }), /id de registro não permitido/, id);
  }
  assert.deepEqual(fetchImpl.chamadas, []);
});

test('[SBR-23] delete() exige meta.reviewedBy = { userId, name, role } (defesa em profundidade — o Service já valida antes) — ausente ou incompleto recusa SEM chamar fetch', async () => {
  const fetchImpl = fetchFalso();
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });
  const id = 'crm:11111111-1111-4111-8111-111111111111';
  for (const reviewedBy of [undefined, null, {}, { userId: 'u' }, { userId: 'u', name: 'n' }, { userId: '', name: 'n', role: 'ADMIN' }, { userId: 'u', name: 'n', role: '' }, 'texto']) {
    await assert.rejects(() => repo.delete(id, { reviewedBy, motivo: 'x' }), /delete\(\) exige meta\.reviewedBy/, JSON.stringify(reviewedBy));
  }
  assert.deepEqual(fetchImpl.chamadas, []);
});

test('[SBR-24] delete() exige meta.motivo (texto não vazio) — ausente, vazio ou só espaços recusa SEM chamar fetch', async () => {
  const fetchImpl = fetchFalso();
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });
  const id = 'crm:11111111-1111-4111-8111-111111111112';
  for (const motivo of [undefined, null, '', '   ', 42, {}]) {
    await assert.rejects(() => repo.delete(id, { reviewedBy: OPERADOR, motivo }), /delete\(\) exige meta\.motivo/, String(motivo));
  }
  assert.deepEqual(fetchImpl.chamadas, []);
});

test('[SBR-25] o RPC de exclusão recusando (ex.: 404 "registro não encontrado", simulando a rede de segurança da função SQL) vira um erro com a mensagem do PostgREST — mas a chave de teste NUNCA aparece', async () => {
  const fetchImpl = fetchFalso(jsonResposta({ message: 'delete_crm_record_with_audit: registro crm:x não encontrado' }, 404));
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });
  await assert.rejects(
    () => repo.delete('crm:11111111-1111-4111-8111-111111111113', { reviewedBy: OPERADOR, motivo: 'x' }),
    (erro) => {
      assert.match(erro.message, /PostgREST recusou a operação/);
      assert.match(erro.message, /não encontrado/);
      assert.doesNotMatch(erro.message, new RegExp(CHAVE_DE_TESTE));
      return true;
    }
  );
});

test('[SBR-26] falha de REDE no RPC de exclusão: erro estável, sem repassar a mensagem bruta nem a chave de teste — e o registro fica como estava (a chamada nunca "meio aconteceu")', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND projeto-de-teste.supabase.co'); };
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });
  await assert.rejects(() => repo.delete('crm:11111111-1111-4111-8111-111111111114', { reviewedBy: OPERADOR, motivo: 'x' }), (erro) => {
    assert.match(erro.message, /CRM \(Supabase\): falha de rede/);
    assert.doesNotMatch(erro.message, /ENOTFOUND/);
    assert.doesNotMatch(erro.message, new RegExp(CHAVE_DE_TESTE));
    return true;
  });
});

// ===========================================================================
// Erros — nunca vazam o segredo, nunca repassam texto bruto e não-JSON
// ===========================================================================
test('[SBR-10] o PostgREST recusando (ex.: 409 de UNIQUE) vira um erro com a mensagem dele — mas a chave de teste NUNCA aparece em nenhum erro', async () => {
  const fetchImpl = fetchFalso(jsonResposta({ message: 'duplicate key value violates unique constraint' }, 409));
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });
  await assert.rejects(
    () => repo.save(registro()),
    (erro) => {
      assert.match(erro.message, /PostgREST recusou a operação/);
      assert.match(erro.message, /duplicate key value violates unique constraint/);
      assert.doesNotMatch(erro.message, new RegExp(CHAVE_DE_TESTE));
      return true;
    }
  );
});

test('[SBR-11] resposta de erro que NÃO é JSON (ex.: HTML de um proxy): o texto bruto nunca é repassado, só o status', async () => {
  const fetchImpl = fetchFalso({ ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' });
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });
  await assert.rejects(() => repo.list(), (erro) => {
    assert.match(erro.message, /HTTP 502/);
    assert.doesNotMatch(erro.message, /<html>/i);
    return true;
  });
});

test('[SBR-12] falha de REDE (fetch lança): erro estável, sem repassar a mensagem bruta do erro original, e sem a chave de teste', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND projeto-de-teste.supabase.co'); };
  const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl });
  await assert.rejects(() => repo.getById('crm:66666666-6666-4666-8666-666666666666'), (erro) => {
    assert.match(erro.message, /CRM \(Supabase\): falha de rede/);
    assert.doesNotMatch(erro.message, /ENOTFOUND/);
    assert.doesNotMatch(erro.message, new RegExp(CHAVE_DE_TESTE));
    return true;
  });
});

// ===========================================================================
// Contrato de erro comum entre adapters (etapa 3F, corrige o BLOCKER 2 da etapa 3E): o `code` anexado ao erro é a
// única coisa que src/server/app.js (mapErrorToHttp) reconhece — nunca a mensagem "CRM (Supabase): ...", que
// continua igual, só para leitura humana/log. Só os dois casos que o PostgREST sinaliza por CÓDIGO, nunca por
// adivinhação de texto, ganham um `code`; qualquer outra falha (rede, tabela ausente, permissão, 5xx) fica SEM
// `code` — o mesmo INTERNAL/500 de hoje, de propósito (ver a auditoria da etapa 3E: nunca inventamos uma
// classificação para o que não temos certeza).
// ===========================================================================
test('[SBR-17] uma violação de restrição de DADO (CHECK/NOT NULL/tipo — status 400, ou o código Postgres correspondente) ganha code CRM_REPOSITORY_INVALID_REQUEST', async () => {
  const porStatus = fetchFalso(jsonResposta({ message: 'null value in column "empresa" violates not-null constraint' }, 400));
  const repoPorStatus = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl: porStatus });
  await assert.rejects(() => repoPorStatus.save(registro()), (erro) => {
    assert.equal(erro.code, CRM_REPOSITORY_ERROR.INVALID_REQUEST);
    assert.doesNotMatch(erro.message, new RegExp(CHAVE_DE_TESTE));
    return true;
  });

  // Mesmo com um status genérico (ex.: 422, incomum mas possível), o CÓDIGO do Postgres já basta para classificar.
  for (const codigoPostgres of ['22P02', '23502', '23514']) {
    const porCodigo = fetchFalso(jsonResposta({ code: codigoPostgres, message: 'restrição violada' }, 422));
    const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl: porCodigo });
    await assert.rejects(() => repo.save(registro()), (erro) => {
      assert.equal(erro.code, CRM_REPOSITORY_ERROR.INVALID_REQUEST, codigoPostgres);
      return true;
    });
  }
});

test('[SBR-18] uma violação de UNICIDADE (status 409, ou o código Postgres 23505 — não alcançável hoje, já que save() faz upsert e não há UNIQUE além da chave primária, mas pronta para D-IDENTITY-FUTURA) ganha code CRM_REPOSITORY_CONFLICT', async () => {
  const porStatus = fetchFalso(jsonResposta({ message: 'duplicate key value violates unique constraint' }, 409));
  const repoPorStatus = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl: porStatus });
  await assert.rejects(() => repoPorStatus.save(registro()), (erro) => {
    assert.equal(erro.code, CRM_REPOSITORY_ERROR.CONFLICT);
    return true;
  });

  const porCodigo = fetchFalso(jsonResposta({ code: '23505', message: 'chave duplicada' }, 400));
  const repoPorCodigo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl: porCodigo });
  await assert.rejects(() => repoPorCodigo.save(registro()), (erro) => {
    assert.equal(erro.code, CRM_REPOSITORY_ERROR.CONFLICT, '23505 classifica como conflito mesmo com status 400 — o código do Postgres é mais específico que o status genérico');
    return true;
  });
});

test('[SBR-19] o que NÃO é classificável (tabela ausente/PGRST205, permissão negada, 5xx do Postgres, resposta sem "code" reconhecível) fica SEM code — cai no INTERNAL genérico de sempre, nunca inventamos uma classificação', async () => {
  const casos = [
    jsonResposta({ code: 'PGRST205', message: "Could not find the table 'public.crm_records' in the schema cache" }, 404),
    jsonResposta({ code: '42501', message: 'permission denied for table crm_records' }, 401),
    jsonResposta({ message: 'internal server error' }, 500),
    { ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' },
  ];
  for (const resposta of casos) {
    const repo = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl: fetchFalso(resposta) });
    await assert.rejects(() => repo.list(), (erro) => {
      assert.equal(erro.code, undefined, JSON.stringify(resposta));
      return true;
    });
  }
  // falha de rede: também sem code.
  const semRede = async () => { throw new TypeError('rede fora'); };
  const repoSemRede = createSupabaseCrmRepository({ url: URL_DE_TESTE, serviceRoleKey: CHAVE_DE_TESTE, fetchImpl: semRede });
  await assert.rejects(() => repoSemRede.list(), (erro) => {
    assert.equal(erro.code, undefined);
    return true;
  });
});

test('[SBR-20] CRM_REPOSITORY_ERROR (o contrato exportado) tem exatamente os dois códigos documentados — nenhum a mais, nenhum a menos (um teste espelhado, [CRM-ERRMAP-9] em tests/server/crm-error-mapping.test.js, garante que src/server/app.js reconhece cada um deles)', () => {
  assert.deepEqual(Object.keys(CRM_REPOSITORY_ERROR).sort(), ['CONFLICT', 'INVALID_REQUEST']);
  assert.deepEqual(Object.values(CRM_REPOSITORY_ERROR).sort(), ['CRM_REPOSITORY_CONFLICT', 'CRM_REPOSITORY_INVALID_REQUEST']);
});

// ===========================================================================
// Estático: nada disto roda sozinho, e o segredo nunca chega perto do navegador
// ===========================================================================
test('[SBR-13] o adapter e a config nunca chamam console.* (nenhum log pode carregar a chave)', () => {
  for (const arquivo of ['crmSupabaseRepository.js', 'crmSupabaseConfig.js', 'crmSupabaseMapping.js']) {
    const fonte = fs.readFileSync(path.join(REPO_ROOT, 'src', 'crm-adapters', arquivo), 'utf8');
    const semComentarios = fonte.replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(semComentarios, /\bconsole\s*\./, arquivo);
  }
});

test('[SBR-14] nada em src/server/ inicializa o adapter Supabase do CRM, nem LÊ SUPABASE_SERVICE_ROLE_KEY do ambiente — a composição de produção continua só com o arquivo local (comentários podem CITAR o nome da variável em prosa; o que conta é um uso de verdade, ex.: env.SUPABASE_SERVICE_ROLE_KEY)', () => {
  for (const arquivo of ['index.js', 'app.js', 'static.js']) {
    const fonte = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', arquivo), 'utf8');
    const semComentarios = fonte.replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(semComentarios, /createSupabaseCrmRepository/, arquivo);
    assert.doesNotMatch(semComentarios, /env\.SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE_KEY\s*[:=]/, arquivo);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const script of Object.values(pkg.scripts || {})) assert.doesNotMatch(script, /crmSupabaseRepository|SUPABASE_SERVICE_ROLE_KEY/i, script);
});

test('[SBR-15] "SERVICE_ROLE" (em qualquer caixa) nunca aparece em dashboard/ — código client-side nunca conhece essa chave', () => {
  const dir = path.join(REPO_ROOT, 'dashboard');
  const buscar = (pasta) => {
    for (const entrada of fs.readdirSync(pasta, { withFileTypes: true })) {
      const completo = path.join(pasta, entrada.name);
      if (entrada.isDirectory()) { buscar(completo); continue; }
      if (!/\.(mjs|js|html|css)$/.test(entrada.name)) continue;
      const conteudo = fs.readFileSync(completo, 'utf8');
      assert.doesNotMatch(conteudo, /service_role/i, completo);
    }
  };
  buscar(dir);
});

test('[SBR-16] o publicConfig que o servidor manda ao navegador (src/server/index.js) só tem as duas chaves de sempre — nunca um campo de service role', () => {
  const fonte = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', 'index.js'), 'utf8');
  const bloco = /publicConfig:\s*\{([^}]*)\}/.exec(fonte);
  assert.ok(bloco, 'bloco publicConfig não encontrado em src/server/index.js — o teste precisa ser revisto se o formato mudou');
  assert.doesNotMatch(bloco[1], /service/i);
  assert.match(bloco[1], /supabaseUrl/);
  assert.match(bloco[1], /supabaseAnonKey/);
});
