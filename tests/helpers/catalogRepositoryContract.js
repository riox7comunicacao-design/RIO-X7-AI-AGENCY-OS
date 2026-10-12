// A SUÍTE DE CONTRATO da porta de catálogos (src/crm/catalogRepositoryPort.js) — roda IGUAL sobre o adapter de memória, o de arquivo e o
// Supabase (com um PostgREST falso): é assim que "contratos consistentes entre adaptadores" deixa de ser uma intenção e vira teste. NÃO é
// um arquivo de teste (sem *.test.js); quem a usa chama runCatalogRepositoryContract(rotulo, fabrica).
//
// fabrica(t) -> repositório NOVO e vazio (síncrono ou assíncrono); `t` é o contexto do teste (para registrar limpeza).

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCatalogName } = require('../../src/crm/catalogDomain');
const { CATALOG_REPOSITORY_ERROR } = require('../../src/crm/catalogRepositoryPort');
const { CATALOG_KEYS } = require('../../src/crm/catalogConstants');

const PREFIX = Object.freeze({ servicos: 'service', nichos: 'niche', origens: 'origin' });
const SPECIFIC_DEFAULTS = Object.freeze({
  servicos: Object.freeze({ categoria: null, precoReferencia: null, tipoCobranca: null, recorrencia: null }),
  nichos: Object.freeze({ cor: null }),
  origens: Object.freeze({ canal: null }),
});
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Um item válido e completo (o que o domínio entregaria ao adapter), com id estável por `n`.
function makeItem(catalog, n, overrides = {}) {
  const nome = overrides.nome || `Item ${n}`;
  return {
    id: `${PREFIX[catalog]}:${uuid(n)}`,
    nome,
    nomeNormalizado: normalizeCatalogName(nome),
    descricao: null,
    ativo: true,
    ordem: n,
    ...SPECIFIC_DEFAULTS[catalog],
    criadoEm: '2026-10-12T12:00:00.000Z',
    atualizadoEm: '2026-10-12T12:00:00.000Z',
    criadoPorUserId: 'user-a',
    criadoPorNome: 'Admin A',
    atualizadoPorUserId: 'user-a',
    atualizadoPorNome: 'Admin A',
    ...overrides,
  };
}

async function failsWithCode(task, code, mensagem) {
  let erro;
  try {
    await task();
  } catch (error) {
    erro = error;
  }
  assert.ok(erro, `${mensagem}: esperava uma falha`);
  assert.equal(erro.code, code, `${mensagem}: código`);
}
async function failsWithoutCode(task, mensagem) {
  let erro;
  try {
    await task();
  } catch (error) {
    erro = error;
  }
  assert.ok(erro, `${mensagem}: esperava uma falha`);
  assert.equal(erro.code, undefined, `${mensagem}: erro de programação, sem código de contrato`);
}

const byId = (items) => Object.fromEntries(items.map((item) => [item.id, item]));
const isIso = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

function runCatalogRepositoryContract(rotulo, fabrica) {
  const nome = (n, texto) => `[CATREPO-${rotulo}-${n}] ${texto}`;

  test(nome(1, 'um repositório novo está vazio nos três catálogos; getById de um id desconhecido é null; um catálogo desconhecido é erro de programação'), async (t) => {
    const repo = await fabrica(t);
    for (const catalog of CATALOG_KEYS) {
      assert.deepEqual(await repo.list(catalog), []);
      assert.equal(await repo.getById(catalog, `${PREFIX[catalog]}:${uuid(404)}`), null);
    }
    await failsWithoutCode(async () => repo.list('clientes'), 'list(catálogo desconhecido)');
    await failsWithoutCode(async () => repo.getById('clientes', 'x'), 'getById(catálogo desconhecido)');
  });

  test(nome(2, 'insert devolve o item gravado (todos os campos, inclusive os específicos de cada catálogo) e list/getById o devolvem igual, com datas ISO'), async (t) => {
    const repo = await fabrica(t);
    const casos = {
      servicos: makeItem('servicos', 1, { nome: 'Site institucional', descricao: 'Site de 5 páginas', categoria: 'Presença digital', precoReferencia: 1500.5, tipoCobranca: 'RECORRENTE', recorrencia: 'MENSAL' }),
      nichos: makeItem('nichos', 1, { nome: 'Estética', cor: 'azul' }),
      origens: makeItem('origens', 1, { nome: 'Indicação', canal: 'INDICACAO' }),
    };
    for (const catalog of CATALOG_KEYS) {
      const item = casos[catalog];
      const gravado = await repo.insert(catalog, item);
      assert.deepEqual(gravado, item, `${catalog}: o item gravado é o enviado`);
      assert.deepEqual(await repo.getById(catalog, item.id), item);
      assert.deepEqual(await repo.list(catalog), [item]);
      for (const campo of ['criadoEm', 'atualizadoEm']) assert.equal(isIso(gravado[campo]), true, `${catalog}.${campo} é ISO 8601 em UTC`);
    }
    // um catálogo nunca enxerga os itens do outro
    assert.equal(await repo.getById('nichos', casos.servicos.id), null);
  });

  test(nome(3, 'os campos opcionais nulos voltam nulos (nada de string vazia nem undefined) e o preço de referência volta como NÚMERO'), async (t) => {
    const repo = await fabrica(t);
    await repo.insert('servicos', makeItem('servicos', 1, { nome: 'Sem extras' }));
    const [lido] = await repo.list('servicos');
    for (const campo of ['descricao', 'categoria', 'precoReferencia', 'tipoCobranca', 'recorrencia']) assert.equal(lido[campo], null, campo);
    await repo.insert('servicos', makeItem('servicos', 2, { nome: 'Com preço', precoReferencia: 99.9 }));
    assert.equal(typeof (await repo.getById('servicos', makeItem('servicos', 2).id)).precoReferencia, 'number');
  });

  test(nome(4, 'UNICIDADE: dois itens do MESMO catálogo não têm o mesmo nome normalizado — o insert falha com o código DUPLICATE_NAME e nada é gravado'), async (t) => {
    const repo = await fabrica(t);
    await repo.insert('nichos', makeItem('nichos', 1, { nome: 'Estética' }));
    await failsWithCode(async () => repo.insert('nichos', makeItem('nichos', 2, { nome: 'estetica' })), CATALOG_REPOSITORY_ERROR.DUPLICATE_NAME, 'mesmo nome normalizado');
    assert.equal((await repo.list('nichos')).length, 1);
    assert.equal(await repo.getById('nichos', makeItem('nichos', 2).id), null);
  });

  test(nome(5, 'a unicidade vale também para itens DESATIVADOS, e o MESMO nome pode existir em catálogos diferentes'), async (t) => {
    const repo = await fabrica(t);
    const a = await repo.insert('origens', makeItem('origens', 1, { nome: 'Indicação' }));
    await repo.update('origens', a.id, { ativo: false, atualizadoEm: '2026-10-12T12:10:00.000Z', atualizadoPorUserId: 'user-b', atualizadoPorNome: 'Admin B' });
    await failsWithCode(async () => repo.insert('origens', makeItem('origens', 2, { nome: 'INDICAÇÃO' })), CATALOG_REPOSITORY_ERROR.DUPLICATE_NAME, 'colide com o desativado');
    await repo.insert('nichos', makeItem('nichos', 1, { nome: 'Indicação' }));
    await repo.insert('servicos', makeItem('servicos', 1, { nome: 'Indicação' }));
    assert.equal((await repo.list('nichos')).length + (await repo.list('servicos')).length, 2);
  });

  test(nome(6, 'um id repetido é recusado (erro de programação) e um id fora do formato do catálogo também'), async (t) => {
    const repo = await fabrica(t);
    const item = makeItem('nichos', 1, { nome: 'Um' });
    await repo.insert('nichos', item);
    await failsWithoutCode(async () => repo.insert('nichos', makeItem('nichos', 1, { nome: 'Outro nome' })), 'id repetido');
    await failsWithoutCode(async () => repo.insert('nichos', { ...makeItem('nichos', 3, { nome: 'Três' }), id: `service:${uuid(3)}` }), 'prefixo de outro catálogo');
    await failsWithoutCode(async () => repo.insert('nichos', { ...makeItem('nichos', 4, { nome: 'Quatro' }), id: '__proto__' }), 'id inseguro');
  });

  test(nome(7, 'update aplica SÓ os campos do patch e devolve o item atualizado; os demais campos ficam intactos; um id desconhecido devolve null'), async (t) => {
    const repo = await fabrica(t);
    const item = makeItem('servicos', 1, { nome: 'Gestão de redes', descricao: 'Texto original', categoria: 'Social', precoReferencia: 800 });
    await repo.insert('servicos', item);
    const atualizado = await repo.update('servicos', item.id, { descricao: 'Texto novo', atualizadoEm: '2026-10-12T12:20:00.000Z', atualizadoPorUserId: 'user-b', atualizadoPorNome: 'Admin B' });
    assert.equal(atualizado.descricao, 'Texto novo');
    assert.equal(atualizado.atualizadoPorNome, 'Admin B');
    assert.equal(atualizado.atualizadoPorUserId, 'user-b');
    for (const campo of ['id', 'nome', 'nomeNormalizado', 'ativo', 'ordem', 'categoria', 'precoReferencia', 'criadoEm', 'criadoPorUserId', 'criadoPorNome']) {
      assert.deepEqual(atualizado[campo], item[campo], `${campo} não mudou`);
    }
    assert.ok(Date.parse(atualizado.atualizadoEm) >= Date.parse(item.atualizadoEm), 'atualizadoEm nunca anda para trás');
    assert.deepEqual(await repo.getById('servicos', item.id), atualizado);
    assert.equal(await repo.update('servicos', `service:${uuid(999)}`, { descricao: 'x' }), null);
  });

  test(nome(8, 'update de nome: renomear para o nome normalizado de OUTRO item falha com DUPLICATE_NAME (e nada muda); manter o próprio nome normalizado é permitido'), async (t) => {
    const repo = await fabrica(t);
    const a = await repo.insert('nichos', makeItem('nichos', 1, { nome: 'Estética' }));
    const b = await repo.insert('nichos', makeItem('nichos', 2, { nome: 'Psicologia' }));
    const meta = { atualizadoEm: '2026-10-12T12:30:00.000Z', atualizadoPorUserId: 'user-b', atualizadoPorNome: 'Admin B' };
    await failsWithCode(async () => repo.update('nichos', b.id, { nome: 'ESTÉTICA', nomeNormalizado: 'estetica', ...meta }), CATALOG_REPOSITORY_ERROR.DUPLICATE_NAME, 'renomear colidindo');
    assert.equal((await repo.getById('nichos', b.id)).nome, 'Psicologia');
    const proprio = await repo.update('nichos', a.id, { nome: 'ESTÉTICA', nomeNormalizado: 'estetica', ...meta });
    assert.equal(proprio.nome, 'ESTÉTICA');
    assert.equal(proprio.nomeNormalizado, 'estetica');
  });

  test(nome(9, 'update recusa (erro de programação, sem código) campos que nunca mudam — id, criadoEm, criadoPor* — campos de OUTRO catálogo e um patch que não é objeto'), async (t) => {
    const repo = await fabrica(t);
    const item = await repo.insert('servicos', makeItem('servicos', 1, { nome: 'Serviço' }));
    for (const campo of ['id', 'criadoEm', 'criadoPorUserId', 'criadoPorNome', 'cor', 'canal', 'nomeInventado']) {
      await failsWithoutCode(async () => repo.update('servicos', item.id, { [campo]: 'x' }), `campo ${campo}`);
    }
    await failsWithoutCode(async () => repo.update('servicos', item.id, null), 'patch nulo');
    await failsWithoutCode(async () => repo.update('servicos', '__proto__', { descricao: 'x' }), 'id inseguro');
    assert.deepEqual(await repo.getById('servicos', item.id), item, 'nada foi alterado');
  });

  test(nome(10, 'desativar e reativar pelo update: o item continua em list() (ativo=false) e mantém tudo o que tinha'), async (t) => {
    const repo = await fabrica(t);
    const item = await repo.insert('origens', makeItem('origens', 1, { nome: 'Parceria', canal: 'PARCERIA' }));
    const meta = { atualizadoEm: '2026-10-12T12:40:00.000Z', atualizadoPorUserId: 'user-b', atualizadoPorNome: 'Admin B' };
    const off = await repo.update('origens', item.id, { ativo: false, ...meta });
    assert.equal(off.ativo, false);
    assert.equal(off.canal, 'PARCERIA');
    assert.equal((await repo.list('origens')).length, 1);
    const on = await repo.update('origens', item.id, { ativo: true, ...meta });
    assert.equal(on.ativo, true);
  });

  test(nome(11, 'reorder grava ordem = posição, atomicamente; só os itens cuja ordem MUDA recebem o responsável; um id inexistente falha com NOT_FOUND e NADA muda'), async (t) => {
    const repo = await fabrica(t);
    const [a, b, c] = [1, 2, 3].map((n) => makeItem('nichos', n, { nome: `Nicho ${n}`, ordem: n - 1 }));
    for (const item of [a, b, c]) await repo.insert('nichos', item);
    const meta = { atualizadoEm: '2026-10-12T12:50:00.000Z', atualizadoPorUserId: 'user-b', atualizadoPorNome: 'Admin B' };

    await repo.reorder('nichos', [c.id, b.id, a.id], meta);
    const depois = byId(await repo.list('nichos'));
    assert.equal(depois[c.id].ordem, 0);
    assert.equal(depois[b.id].ordem, 1);
    assert.equal(depois[a.id].ordem, 2);
    assert.equal(depois[b.id].atualizadoPorNome, 'Admin A', 'b não mudou de posição: não recebe o responsável');
    assert.equal(depois[c.id].atualizadoPorNome, 'Admin B');
    assert.equal(depois[a.id].atualizadoPorNome, 'Admin B');

    await failsWithCode(async () => repo.reorder('nichos', [a.id, b.id, `niche:${uuid(999)}`], meta), CATALOG_REPOSITORY_ERROR.NOT_FOUND, 'id inexistente');
    const intacto = byId(await repo.list('nichos'));
    assert.deepEqual([intacto[c.id].ordem, intacto[b.id].ordem, intacto[a.id].ordem], [0, 1, 2], 'a falha não gravou nada');
  });

  test(nome(12, 'reorder só mexe no catálogo pedido; uma lista que não é de textos é erro de programação'), async (t) => {
    const repo = await fabrica(t);
    const n1 = await repo.insert('nichos', makeItem('nichos', 1, { nome: 'Nicho', ordem: 0 }));
    const s1 = await repo.insert('servicos', makeItem('servicos', 1, { nome: 'Serviço', ordem: 5 }));
    await repo.reorder('nichos', [n1.id], { atualizadoEm: '2026-10-12T12:55:00.000Z', atualizadoPorUserId: 'user-b', atualizadoPorNome: 'Admin B' });
    assert.equal((await repo.getById('servicos', s1.id)).ordem, 5, 'outro catálogo intacto');
    await failsWithoutCode(async () => repo.reorder('nichos', [1, 2], {}), 'lista de números');
    await failsWithoutCode(async () => repo.reorder('nichos', 'x', {}), 'não é lista');
  });

  test(nome(13, 'list devolve CÓPIAS: alterar o que foi devolvido nunca altera o armazenado'), async (t) => {
    const repo = await fabrica(t);
    await repo.insert('nichos', makeItem('nichos', 1, { nome: 'Original' }));
    const [lido] = await repo.list('nichos');
    lido.nome = 'Adulterado';
    lido.ativo = false;
    const [novamente] = await repo.list('nichos');
    assert.equal(novamente.nome, 'Original');
    assert.equal(novamente.ativo, true);
  });
}

module.exports = { runCatalogRepositoryContract, makeItem, PREFIX, uuid };
