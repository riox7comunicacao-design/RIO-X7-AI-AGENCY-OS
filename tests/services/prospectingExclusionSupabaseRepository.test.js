'use strict';

// Fase 2B-3.2B — o adapter Supabase das Exclusões Permanentes (src/prospecting-adapters/prospectingExclusionSupabaseRepository.js): a leitura da
// lista tem de ser COMPLETA ou um erro. Quem decide sobre uma promoção com essa lista não pode ler "nada encontrado" de uma resposta
// truncada, malformada ou vazia por engano.
//
// Tudo com um `fetch` FALSO em memória que imita o PostgREST (limit/offset, teto de linhas por resposta, Content-Range): nenhuma rede, nenhum
// Supabase real, nenhuma chave real (a "chave" é um texto de teste). O adapter NUNCA foi exercitado contra o Supabase real nesta etapa.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSupabaseProspectingExclusionRepository } = require('../../src/prospecting-adapters/prospectingExclusionSupabaseRepository');
const { createProspectingExclusionService, ERROR } = require('../../src/services/prospectingExclusionService');
const { authorizeProspectingExclusionOperation } = require('../../src/auth');

const URL_BASE = 'https://exemplo-falso.example.test';
const CHAVE = 'chave-falsa-de-teste-nao-e-real';
const SEGREDO_NO_CORPO = 'segredo-que-so-existe-no-corpo-da-resposta';

const linha = (n, extra = {}) => ({
  id: `id-${String(n).padStart(5, '0')}`,
  empresa_nome: `Empresa Fictícia ${n}`,
  empresa_nome_normalizado: `empresa ficticia ${n}`,
  cidade: null,
  estado: null,
  pais: 'Brasil',
  dominio: null,
  motivo: 'motivo fictício',
  ativo: true,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  created_by_user_id: null,
  created_by_name: null,
  ...extra,
});
const linhas = (quantidade, deslocamento = 0) => Array.from({ length: quantidade }, (_, i) => linha(i + 1 + deslocamento));

// Resposta falsa no formato que o adapter lê: ok/status, headers.get e text().
function resposta({ status = 200, corpo = '[]', range = '*/0' } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (nome) => (String(nome).toLowerCase() === 'content-range' ? range : null) }, text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) };
}

// Um PostgREST falso: respeita limit/offset, aplica o TETO de linhas por resposta do servidor e informa o Content-Range com o total exato.
function servidorFalso({ todas, teto = 1000, total = todas.length, aoResponder } = {}) {
  const pedidos = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset'));
    pedidos.push({ url: u, init, limit, offset });
    const fatia = todas.slice(offset, offset + Math.min(limit, teto));
    let r = resposta({ corpo: fatia, range: fatia.length === 0 ? `*/${total}` : `${offset}-${offset + fatia.length - 1}/${total}`, status: fatia.length < total - offset ? 206 : 200 });
    if (aoResponder) r = aoResponder({ r, pedido: pedidos[pedidos.length - 1], fatia, offset, total }) || r;
    return r;
  };
  return { fetchImpl, pedidos };
}

const repo = (fetchImpl) => createSupabaseProspectingExclusionRepository({ url: URL_BASE, serviceRoleKey: CHAVE, fetchImpl });
const unico = (fetchImpl) => repo(async () => fetchImpl);

async function falha(promessa) {
  try {
    await promessa;
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava um erro e a leitura terminou com sucesso');
}

// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-ADP-1] tabela realmente vazia: corpo [] com Content-Range "*/0" é uma lista vazia VÁLIDA — e o pedido é o esperado', async () => {
  const s = servidorFalso({ todas: [] });
  assert.deepEqual(await repo(s.fetchImpl).list(), []);
  assert.equal(s.pedidos.length, 1);
  const { url, init } = s.pedidos[0];
  assert.equal(url.origin + url.pathname, `${URL_BASE}/rest/v1/prospecting_permanent_exclusions`);
  assert.equal(init.method, 'GET');
  assert.equal(url.searchParams.get('select'), '*');
  assert.equal(url.searchParams.get('order'), 'created_at.desc,id.asc', 'ordem estável: sem ela a paginação pode repetir ou pular linhas');
  assert.deepEqual([url.searchParams.get('limit'), url.searchParams.get('offset')], ['500', '0']);
  assert.equal(init.headers.Prefer, 'count=exact', 'pede o total exato');
  assert.equal(init.headers.apikey, CHAVE);
  assert.ok(init.signal, 'há um timeout');
});

test('[EXCL-ADP-2] PAGINAÇÃO: 1200 exclusões com o teto padrão de 1000 linhas do servidor — três páginas (offsets 0, 500, 1000), todas lidas, sem repetir', async () => {
  const todas = linhas(1200);
  const s = servidorFalso({ todas, teto: 1000 });
  const lidas = await repo(s.fetchImpl).list();
  assert.equal(lidas.length, 1200);
  assert.deepEqual(s.pedidos.map((p) => p.offset), [0, 500, 1000]);
  assert.equal(new Set(lidas.map((e) => e.id)).size, 1200);
  assert.deepEqual(lidas.map((e) => e.id), todas.map((l) => l.id), 'na ordem do servidor');
  assert.deepEqual(Object.keys(lidas[0]).sort(), ['ativo', 'atualizadoEm', 'cidade', 'criadoEm', 'criadoPorNome', 'criadoPorUserId', 'dominio', 'empresa', 'empresaNomeNormalizado', 'estado', 'id', 'motivo', 'pais']);
});

test('[EXCL-ADP-3] o servidor com teto MENOR que o pedido (100 por resposta, 500 pedidas): a leitura segue pelo total e só termina quando o total é atingido', async () => {
  const s = servidorFalso({ todas: linhas(250), teto: 100 });
  assert.equal((await repo(s.fetchImpl).list()).length, 250);
  assert.deepEqual(s.pedidos.map((p) => p.offset), [0, 100, 200], 'a página curta NÃO foi tomada como "última"');
});

test('[EXCL-ADP-4] limites de página: 500 exclusões = 1 pedido; 501 = 2 pedidos', async () => {
  const a = servidorFalso({ todas: linhas(500) });
  assert.equal((await repo(a.fetchImpl).list()).length, 500);
  assert.equal(a.pedidos.length, 1);
  const b = servidorFalso({ todas: linhas(501) });
  assert.equal((await repo(b.fetchImpl).list()).length, 501);
  assert.equal(b.pedidos.length, 2);
});

test('[EXCL-ADP-5] o status 206 (Partial Content) de uma página parcial é aceito — a leitura só vale pelo total comprovado', async () => {
  const s = servidorFalso({ todas: linhas(700), teto: 500 });
  assert.equal((await repo(s.fetchImpl).list()).length, 700);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Respostas TRUNCADAS ou incompletas — cada uma é um ERRO (nunca uma lista menor lida como completa)
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-ADP-6] TRUNCADA: o servidor para de entregar linhas antes do total (página vazia no meio) — erro', async () => {
  const todas = linhas(1200);
  const s = servidorFalso({ todas: todas.slice(0, 500), total: 1200 });
  const erro = await falha(repo(s.fetchImpl).list());
  assert.match(erro.message, /não pôde ser lida por completo \(a leitura terminou antes do total\)/);
});

test('[EXCL-ADP-7] INCOMPLETA: menos linhas no corpo do que a faixa do Content-Range afirma, ou faixa fora do que foi pedido — erro', async () => {
  const menos = servidorFalso({ todas: linhas(600), aoResponder: ({ r, fatia, offset, total }) => (offset === 0 ? resposta({ corpo: fatia.slice(0, 400), range: `0-${fatia.length - 1}/${total}`, status: 206 }) : r) });
  assert.match((await falha(repo(menos.fetchImpl).list())).message, /faixa devolvida não confere/);
  const ignoraOffset = servidorFalso({ todas: linhas(1200), aoResponder: ({ fatia, total, offset }) => (offset > 0 ? resposta({ corpo: linhas(500), range: `0-499/${total}`, status: 206 }) : undefined) });
  assert.match((await falha(repo(ignoraOffset.fetchImpl).list())).message, /faixa devolvida não confere/, 'o servidor ignorou o offset e repetiu a primeira página');
});

test('[EXCL-ADP-8] sem como comprovar o TOTAL: Content-Range ausente, com total desconhecido ("0-24/*"), malformado ou com faixa invertida — erro', async () => {
  for (const [nome, range] of [['ausente', null], ['total desconhecido', '0-24/*'], ['malformado', 'abc'], ['vazio', ''], ['faixa invertida', '9-3/20'], ['negativo', '-1-3/20']]) {
    const f = unico(resposta({ corpo: linhas(5), range }));
    assert.match((await falha(f.list())).message, /total de exclusões não pôde ser confirmado/, nome);
  }
});

test('[EXCL-ADP-9] o TOTAL muda entre as páginas (alguém cadastrou ou removeu no meio da leitura) — erro, nunca uma lista misturada', async () => {
  const s = servidorFalso({ todas: linhas(1200), aoResponder: ({ r, offset }) => (offset === 500 ? resposta({ corpo: linhas(500, 500), range: '500-999/1201', status: 206 }) : undefined) });
  assert.match((await falha(repo(s.fetchImpl).list())).message, /total mudou durante a leitura/);
});

test('[EXCL-ADP-10] a MESMA exclusão em duas páginas (ordem instável) — erro', async () => {
  const s = servidorFalso({ todas: linhas(1000), aoResponder: ({ offset }) => (offset === 500 ? resposta({ corpo: linhas(500, 0).map((l, i) => (i === 0 ? linha(1) : l)), range: '500-999/1000', status: 206 }) : undefined) });
  assert.match((await falha(repo(s.fetchImpl).list())).message, /apareceu duas vezes/);
});

test('[EXCL-ADP-11] lista grande demais (mais de 10 mil) ou servidor que devolve uma linha por página para sempre: a leitura é RECUSADA, nunca "a parte que coube"', async () => {
  const enorme = servidorFalso({ todas: linhas(10), total: 10001 });
  assert.match((await falha(repo(enorme.fetchImpl).list())).message, /exclusões demais/);
  assert.equal(enorme.pedidos.length, 1, 'recusou na primeira resposta');
  const lento = servidorFalso({ todas: linhas(10000), teto: 1 });
  assert.match((await falha(repo(lento.fetchImpl).list())).message, /não chegou ao total/);
  assert.ok(lento.pedidos.length <= 100, `no máximo 100 pedidos (${lento.pedidos.length})`);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Respostas INVÁLIDAS com status de sucesso — nunca equivalem a uma lista vazia
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-ADP-12] HTTP 200 com corpo inválido: vazio, null, objeto, texto, número, HTML e JSON malformado — todos erro (mesmo com Content-Range "*/0")', async () => {
  const corpos = { vazio: '', null: 'null', objeto: '{"message":"x"}', texto: '"[]"', numero: '42', html: '<html><body>entre no portal</body></html>', malformado: '[{"id":', 'objeto com lista dentro': '{"items":[]}', booleano: 'false' };
  for (const [nome, corpo] of Object.entries(corpos)) {
    const f = unico(resposta({ corpo, range: '*/0' }));
    const erro = await falha(f.list());
    assert.match(erro.message, /a resposta não é uma lista/, nome);
  }
});

test('[EXCL-ADP-13] linhas com formato inesperado (sem id, ativo que não é booleano, nome que não é texto, linha que não é objeto) — erro', async () => {
  const ruins = [
    ['sem id', (l) => ({ ...l, id: undefined })],
    ['id vazio', (l) => ({ ...l, id: '' })],
    ['ativo como texto', (l) => ({ ...l, ativo: 'true' })],
    ['ativo ausente', (l) => ({ ...l, ativo: undefined })],
    ['nome numérico', (l) => ({ ...l, empresa_nome: 42 })],
    ['nome normalizado nulo', (l) => ({ ...l, empresa_nome_normalizado: null })],
    ['linha numérica', () => 7],
    ['linha nula', () => null],
    ['linha lista', () => []],
  ];
  for (const [nome, estraga] of ruins) {
    const corpo = [linha(1), estraga(linha(2)), linha(3)];
    const f = unico(resposta({ corpo, range: '0-2/3' }));
    assert.match((await falha(f.list())).message, /formato inesperado/, nome);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Falhas de transporte e de status
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-ADP-14] 401, 403, 404 (tabela ausente), 429, 500 e 503: erro — e a mensagem traz só o status, nunca o corpo da resposta nem a chave', async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const f = unico(resposta({ status, corpo: JSON.stringify({ message: SEGREDO_NO_CORPO, hint: CHAVE }), range: null }));
    const erro = await falha(f.list());
    assert.match(erro.message, new RegExp(`HTTP ${status}`), String(status));
    assert.equal(erro.message.includes(SEGREDO_NO_CORPO), false, `${status}: o corpo não vaza`);
    assert.equal(erro.message.includes(CHAVE), false, `${status}: a chave não vaza`);
    assert.equal(erro.message.includes(URL_BASE), false, `${status}: o endereço não vaza`);
  }
});

test('[EXCL-ADP-15] falha de REDE e TIMEOUT (o fetch rejeita): erro, só com o tipo da falha — nunca a mensagem original, a chave ou o endereço', async () => {
  const rede = repo(async () => {
    throw Object.assign(new TypeError(`fetch failed contra ${URL_BASE} com ${CHAVE}`), { cause: new Error(SEGREDO_NO_CORPO) });
  });
  const erroRede = await falha(rede.list());
  assert.match(erroRede.message, /falha de rede/);
  const tempo = repo(async () => {
    throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  });
  const erroTempo = await falha(tempo.list());
  assert.match(erroTempo.message, /falha de rede ao falar com o PostgREST \(TimeoutError\)/);
  for (const erro of [erroRede, erroTempo]) {
    for (const proibido of [CHAVE, URL_BASE, SEGREDO_NO_CORPO]) assert.equal(erro.message.includes(proibido), false, proibido);
    assert.equal(erro.cause, undefined, 'nenhuma causa com detalhes internos anexada');
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Pelo Service: a falha NUNCA vira "nada encontrado"
// ---------------------------------------------------------------------------------------------------------------------------------
const servicoSobre = (fetchImpl) => createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository: repo(fetchImpl) });

test('[EXCL-ADP-16] pelo Service, TODA falha de leitura vira EXCLUSION_PERSISTENCE em verifyCandidate, isExcluded e list — nunca SEM_CORRESPONDENCIA nem false', async () => {
  const casos = {
    'corpo nulo': async () => resposta({ corpo: 'null', range: '*/0' }),
    'corpo HTML': async () => resposta({ corpo: '<html></html>', range: '*/0' }),
    'corpo vazio': async () => resposta({ corpo: '', range: '*/0' }),
    'sem Content-Range': async () => resposta({ corpo: '[]', range: null }),
    '404': async () => resposta({ status: 404, corpo: '{"message":"relation does not exist"}', range: null }),
    '500': async () => resposta({ status: 500, corpo: '', range: null }),
    rede: async () => {
      throw new TypeError('fetch failed');
    },
    truncada: servidorFalso({ todas: linhas(500), total: 1200 }).fetchImpl,
  };
  for (const [nome, fetchImpl] of Object.entries(casos)) {
    const servico = servicoSobre(fetchImpl);
    for (const operacao of [() => servico.verifyCandidate({ empresa: 'Empresa Fictícia 7' }), () => servico.isExcluded({ empresa: 'Empresa Fictícia 7' })]) {
      const erro = await falha(operacao());
      assert.equal(erro.code, ERROR.PERSISTENCE, nome);
      assert.equal(erro.message, 'Exclusões Permanentes: não foi possível consultar a lista.', `${nome}: mensagem fixa, sem detalhes`);
    }
  }
});

test('[EXCL-ADP-17] pelo Service, uma lista COMPLETA e paginada produz os vereditos certos (a exclusão que está na terceira página é encontrada)', async () => {
  const todas = linhas(1100);
  todas[1050] = linha(1051, { empresa_nome: 'Clínica Exemplo Alfa', empresa_nome_normalizado: 'clinica exemplo alfa', cidade: 'Petrópolis', estado: 'RJ', dominio: 'alfa-exemplo.example.test' });
  const servico = servicoSobre(servidorFalso({ todas }).fetchImpl);
  const confirmada = await servico.verifyCandidate({ empresa: 'Clínica Exemplo Alfa', cidade: 'Petrópolis', estado: 'RJ' });
  assert.deepEqual([confirmada.resultado, confirmada.exclusaoIds], ['CORRESPONDENCIA_CONFIRMADA', ['id-01051']]);
  assert.equal((await servico.verifyCandidate({ empresa: 'Clínica Exemplo Alfa' })).resultado, 'AMBIGUA');
  assert.equal((await servico.verifyCandidate({ empresa: 'Outro Nome', site: 'https://www.alfa-exemplo.example.test' })).resultado, 'CORRESPONDENCIA_CONFIRMADA', 'por domínio');
  assert.equal((await servico.verifyCandidate({ empresa: 'Empresa Que Não Existe' })).resultado, 'SEM_CORRESPONDENCIA');
});

test('[EXCL-ADP-18] a lista administrativa (list) tem a mesma garantia: uma lista incompleta é erro, não uma tela com "parte" das exclusões', async () => {
  const servico = servicoSobre(servidorFalso({ todas: linhas(500), total: 800 }).fetchImpl);
  const erro = await falha(servico.list(contextoAdmin()));
  assert.equal(erro.code, ERROR.PERSISTENCE);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// As demais operações do adapter não mudaram de comportamento
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-ADP-19] getById, insert e update seguem como antes — e uma leitura simples NÃO envia um cabeçalho Prefer inexistente', async () => {
  const visto = [];
  const fetchImpl = async (url, init) => {
    visto.push({ url: new URL(String(url)), init });
    return resposta({ corpo: [linha(1)], range: '0-0/1' });
  };
  const r = repo(fetchImpl);
  assert.equal((await r.getById('id-00001')).id, 'id-00001');
  assert.equal(visto[0].init.headers.Prefer, undefined, 'GET sem Prefer');
  assert.equal(visto[0].url.searchParams.get('id'), 'eq.id-00001');
  assert.equal((await r.insert({ id: 'id-00001', empresa: 'Empresa Fictícia 1', empresaNomeNormalizado: 'empresa ficticia 1', motivo: 'm', ativo: true })).id, 'id-00001');
  assert.equal(visto[1].init.method, 'POST');
  assert.equal(visto[1].init.headers.Prefer, 'return=representation');
  assert.equal((await r.update('id-00001', { ativo: false })).id, 'id-00001');
  assert.equal(visto[2].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(visto[2].init.body), { ativo: false });
  assert.deepEqual(visto.map((v) => v.init.method), ['GET', 'POST', 'PATCH'], 'nenhum DELETE em lugar nenhum');
});

// Um contexto de ADMIN para o list() administrativo (a autorização é a de sempre).
function contextoAdmin() {
  const { admin } = require('../helpers/promotionFixtures');
  return admin();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A INGESTÃO de Prospecção sobre o adapter novo: a regra de sempre (só a correspondência CONFIRMADA bloqueia) — e a leitura incompleta falha
// FECHADO também ali (uma resposta inválida nunca vira "sem exclusões")
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-ADP-20] INGESTÃO (Brief Service) sobre o adapter Supabase: a exclusão confirmada é barrada, a AMBÍGUA não bloqueia (regra de ingestão preservada) e uma resposta inválida derruba a ingestão inteira — nada chega ao Prospecting Service', async () => {
  const { authorizeProposerForLeadApproval } = require('../../src/auth');
  const { createProspectingBriefService } = require('../../src/services/prospectingBriefService');
  const { createInMemoryBriefRepository } = require('../../src/research-prospector/briefRepository');
  const { admin } = require('../helpers/promotionFixtures');

  const montar = async (fetchImpl) => {
    const chamadas = [];
    const prospecting = {
      chamadas,
      submitProspecting: async (contexto, submissao) => (chamadas.push(submissao), { loteId: 'lote:00000000-0000-4000-8000-000000000000', contagens: { encontrados: 1, validos: 1 } }),
      listBatches: async () => [],
      getBatch: async () => null,
    };
    const servicoExclusoes = servicoSobre(fetchImpl);
    const brief = createProspectingBriefService({
      authorizeProposer: authorizeProposerForLeadApproval,
      prospectingService: prospecting,
      repository: createInMemoryBriefRepository(),
      now: () => new Date('2026-09-29T12:00:00.000Z'),
      checkPermanentExclusion: (finding) => servicoExclusoes.isExcluded(finding),
    });
    const criado = await brief.createBrief(admin(), { nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis', quantidade: 5 });
    await brief.markReadyForResearch(admin(), criado.id);
    await brief.generateResearchPackage(admin(), criado.id);
    return { brief, id: criado.id, prospecting };
  };
  const achado = (empresa, extras = {}) => ({ empresa, tipo: 'clínica', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', campos: { site: [{ valor: `${empresa.toLowerCase().replace(/\W+/g, '-')}.example.test`, fonte: 'Fonte de teste', tipoFonte: 'OFICIAL' }] }, fontes: [], ...extras });

  const lista = [linha(1, { empresa_nome: 'Força Digital', empresa_nome_normalizado: 'forca digital', cidade: 'Petrópolis', estado: 'RJ', motivo: 'Exclusão permanente de prospecção' })];
  const a = await montar(servidorFalso({ todas: lista }).fetchImpl);
  const resultado = await a.brief.ingestFindings(admin(), a.id, [achado('Força Digital'), achado('Força Digital', { cidade: undefined, estado: undefined }), achado('Clínica Normal')]);
  assert.equal(resultado.excluidosPermanentemente, 1, 'só a confirmada foi barrada');
  assert.deepEqual(a.prospecting.chamadas[0].rawFindings.map((f) => [f.empresa, f.cidade]), [['Força Digital', undefined], ['Clínica Normal', 'Petrópolis']], 'a ambígua (sem cidade) segue para a revisão humana, como sempre');

  for (const [nome, fetchImpl] of Object.entries({
    'corpo HTML': async () => resposta({ corpo: '<html></html>', range: '*/0' }),
    'sem Content-Range': async () => resposta({ corpo: '[]', range: null }),
    truncada: servidorFalso({ todas: lista, total: 900 }).fetchImpl,
    '404': async () => resposta({ status: 404, corpo: '{}', range: null }),
  })) {
    const b = await montar(fetchImpl);
    const erro = await falha(b.brief.ingestFindings(admin(), b.id, [achado('Clínica Normal')]));
    assert.equal(erro.code, ERROR.PERSISTENCE, nome);
    assert.equal(b.prospecting.chamadas.length, 0, `${nome}: nada chegou ao Prospecting Service`);
    assert.equal((await b.brief.getBrief(admin(), b.id)).status, 'PESQUISANDO', `${nome}: o brief não avançou`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Auditoria final (pré-checkpoint): os limites exatos e a falha NO MEIO da paginação
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-ADP-21] LIMITES EXATOS: 10 mil exclusões (20 páginas) são lidas; 100 páginas exatas (servidor com teto de 100) são lidas; 101 páginas necessárias (teto de 99) são RECUSADAS — nunca uma lista parcial', async () => {
  const dezMil = servidorFalso({ todas: linhas(10000) });
  assert.equal((await repo(dezMil.fetchImpl).list()).length, 10000);
  assert.equal(dezMil.pedidos.length, 20);

  const cemPaginas = servidorFalso({ todas: linhas(10000), teto: 100 });
  assert.equal((await repo(cemPaginas.fetchImpl).list()).length, 10000);
  assert.equal(cemPaginas.pedidos.length, 100);

  const maisDeCem = servidorFalso({ todas: linhas(10000), teto: 99 });
  const erro = await falha(repo(maisDeCem.fetchImpl).list());
  assert.match(erro.message, /não chegou ao total/);
  assert.equal(maisDeCem.pedidos.length, 100, 'parou no teto de páginas');
});

test('[EXCL-ADP-22] FALHA NO MEIO da paginação (página 2 de 3): HTTP 401/500, rede, timeout, corpo HTML, linha malformada e página sem Content-Range — a leitura INTEIRA falha; nunca devolve a primeira página como se fosse a lista', async () => {
  const todas = linhas(1200);
  const naSegunda = (fabricaResposta) => {
    const s = servidorFalso({ todas });
    return async (url, init) => {
      const u = new URL(String(url));
      if (u.searchParams.get('offset') === '500') return fabricaResposta(await s.fetchImpl(url, init));
      return s.fetchImpl(url, init);
    };
  };
  const casos = {
    '401 na segunda página': naSegunda(() => resposta({ status: 401, corpo: '{}', range: null })),
    '500 na segunda página': naSegunda(() => resposta({ status: 500, corpo: '', range: null })),
    'rede na segunda página': naSegunda(() => { throw new TypeError('fetch failed'); }),
    'timeout na segunda página': naSegunda(() => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }),
    'HTML na segunda página': naSegunda(() => resposta({ corpo: '<html></html>', range: '500-999/1200', status: 206 })),
    'sem Content-Range na segunda página': naSegunda(() => resposta({ corpo: linhas(500, 500), range: null, status: 206 })),
    'linha malformada na segunda página': naSegunda(() => resposta({ corpo: [...linhas(499, 500), { id: 'x', ativo: 'sim' }], range: '500-999/1200', status: 206 })),
  };
  for (const [nome, fetchImpl] of Object.entries(casos)) {
    const erro = await falha(repo(fetchImpl).list());
    assert.match(erro.message, /Exclusão Permanente \(Supabase\)/, nome);
    const servico = servicoSobre(fetchImpl);
    const persistencia = await falha(servico.verifyCandidate({ empresa: 'Empresa Fictícia 700' }));
    assert.equal(persistencia.code, ERROR.PERSISTENCE, `${nome}: pelo Service nunca vira um veredito`);
  }
});

test('[EXCL-ADP-23] ALTERAÇÃO CONCORRENTE sem mudar o total (uma exclusão entra na frente e a leitura repete uma linha da fronteira entre páginas): detectada como linha repetida — erro, nunca lista inconsistente', async () => {
  const todas = linhas(1000);
  const deslocada = [linha(9999), ...todas.slice(0, 999)]; // a segunda página começa pela última linha da primeira
  const s = servidorFalso({ todas, aoResponder: ({ offset, total }) => (offset === 500 ? resposta({ corpo: deslocada.slice(499, 999), range: `500-999/${total}`, status: 206 }) : undefined) });
  assert.match((await falha(repo(s.fetchImpl).list())).message, /apareceu duas vezes/);
});
