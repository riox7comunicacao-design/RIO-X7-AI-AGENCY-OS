// Os adapters LOCAIS da porta de catálogos (src/crm/catalogRepository.js): memória e arquivo JSON. Os dois passam pela MESMA suíte de
// contrato dos adapters (tests/helpers/catalogRepositoryContract.js) — a que também roda sobre o Supabase —, e o de arquivo tem casos
// próprios: escrita preguiçosa e atômica, persistência entre instâncias e falha fechada diante de um arquivo corrompido. TODO arquivo é
// criado em diretório temporário isolado e removido ao fim: nenhum data/*.json é lido nem escrito.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createInMemoryCatalogRepository, createJsonFileCatalogRepository } = require('../../src/crm/catalogRepository');
const { runCatalogRepositoryContract, makeItem } = require('../helpers/catalogRepositoryContract');

function pastaTemporaria(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// O contrato comum, sobre os dois adapters locais.
runCatalogRepositoryContract('MEMORIA', () => createInMemoryCatalogRepository());
runCatalogRepositoryContract('ARQUIVO', (t) => createJsonFileCatalogRepository(path.join(pastaTemporaria(t), 'crm-catalogs.json')));

test('[CATFILE-1] o arquivo é PREGUIÇOSO: criar o adapter e LER não cria nem toca nenhum arquivo; o primeiro insert o cria, dentro de um diretório que ainda não existia', (t) => {
  const dir = pastaTemporaria(t);
  const caminho = path.join(dir, 'novo', 'subpasta', 'crm-catalogs.json');
  const repo = createJsonFileCatalogRepository(caminho);
  assert.deepEqual(repo.list('nichos'), []);
  assert.equal(repo.getById('nichos', 'niche:00000000-0000-4000-8000-000000000001'), null);
  assert.equal(fs.existsSync(path.dirname(caminho)), false, 'nada foi criado só por ler');
  repo.insert('nichos', makeItem('nichos', 1, { nome: 'Primeiro' }));
  assert.equal(fs.existsSync(caminho), true);
});

test('[CATFILE-2] o formato do arquivo é { version, servicos, nichos, origens } com os itens por id; sem arquivos temporários sobrando; os dados sobrevivem a uma nova instância', (t) => {
  const dir = pastaTemporaria(t);
  const caminho = path.join(dir, 'crm-catalogs.json');
  const a = createJsonFileCatalogRepository(caminho);
  const nicho = makeItem('nichos', 1, { nome: 'Estética', cor: 'azul' });
  const servico = makeItem('servicos', 1, { nome: 'Site', precoReferencia: 1500, permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [] });
  a.insert('nichos', nicho);
  a.insert('servicos', servico);
  const conteudo = JSON.parse(fs.readFileSync(caminho, 'utf8'));
  assert.deepEqual(Object.keys(conteudo), ['version', 'servicos', 'nichos', 'origens']);
  assert.equal(conteudo.version, 1);
  assert.deepEqual(conteudo.nichos, { [nicho.id]: nicho });
  assert.deepEqual(conteudo.servicos, { [servico.id]: servico });
  assert.deepEqual(conteudo.origens, {});
  assert.deepEqual(fs.readdirSync(dir), ['crm-catalogs.json'], 'a escrita atômica não deixa arquivos temporários');

  const b = createJsonFileCatalogRepository(caminho);
  assert.deepEqual(b.list('nichos'), [nicho]);
  assert.deepEqual(b.getById('servicos', servico.id), servico);
  b.update('nichos', nicho.id, { ativo: false, atualizadoEm: '2026-10-12T14:00:00.000Z', atualizadoPorUserId: 'u', atualizadoPorNome: 'n' });
  assert.equal(a.getById('nichos', nicho.id).ativo, false, 'a primeira instância relê o disco e enxerga a alteração');
});

test('[CATFILE-3] uma operação que FALHA não altera o arquivo (duplicidade, id desconhecido na reordenação, campo proibido): os bytes ficam iguais', (t) => {
  const caminho = path.join(pastaTemporaria(t), 'crm-catalogs.json');
  const repo = createJsonFileCatalogRepository(caminho);
  const a = makeItem('nichos', 1, { nome: 'Estética', ordem: 0 });
  repo.insert('nichos', a);
  const antes = fs.readFileSync(caminho, 'utf8');
  assert.throws(() => repo.insert('nichos', makeItem('nichos', 2, { nome: 'estetica' })));
  assert.throws(() => repo.reorder('nichos', [a.id, 'niche:00000000-0000-4000-8000-000000000999'], {}));
  assert.throws(() => repo.update('nichos', a.id, { criadoEm: 'x' }));
  assert.throws(() => repo.update('nichos', a.id, { cor: 'azul', canal: 'OUTRO' }));
  assert.equal(fs.readFileSync(caminho, 'utf8'), antes);
  // uma reordenação que não muda nada também não regrava o arquivo
  repo.reorder('nichos', [a.id], { atualizadoEm: '2026-10-12T15:00:00.000Z', atualizadoPorUserId: 'u', atualizadoPorNome: 'n' });
  assert.equal(fs.readFileSync(caminho, 'utf8'), antes);
});

test('[CATFILE-4] FALHA FECHADA: JSON inválido, estrutura errada, um item que não é objeto ou um id perigoso fazem a operação falhar — o arquivo nunca é "consertado" nem sobrescrito', (t) => {
  const dir = pastaTemporaria(t);
  const casos = {
    'json-invalido.json': '{ isto não é json',
    'sem-grupo.json': JSON.stringify({ version: 1, servicos: {}, nichos: {} }),
    'grupo-lista.json': JSON.stringify({ version: 1, servicos: [], nichos: {}, origens: {} }),
    'raiz-lista.json': '[]',
    'item-texto.json': JSON.stringify({ version: 1, servicos: {}, nichos: { 'niche:x': 'texto' }, origens: {} }),
    'id-perigoso.json': '{"version":1,"servicos":{},"nichos":{"__proto__":{"id":"x"}},"origens":{}}',
  };
  for (const [nome, conteudo] of Object.entries(casos)) {
    const caminho = path.join(dir, nome);
    fs.writeFileSync(caminho, conteudo);
    const repo = createJsonFileCatalogRepository(caminho);
    assert.throws(() => repo.list('nichos'), /arquivo de dados corrompido/, `${nome}: list`);
    assert.throws(() => repo.insert('nichos', makeItem('nichos', 1, { nome: 'Novo' })), /arquivo de dados corrompido/, `${nome}: insert`);
    assert.equal(fs.readFileSync(caminho, 'utf8'), conteudo, `${nome}: o arquivo não foi tocado`);
  }
});

test('[CATFILE-5] argumentos inválidos: o caminho é obrigatório; um id perigoso ou um catálogo desconhecido é erro de programação em qualquer adapter', (t) => {
  for (const ruim of [undefined, null, '', '   ', 5]) assert.throws(() => createJsonFileCatalogRepository(ruim), /exige um filePath/);
  const repos = [createInMemoryCatalogRepository(), createJsonFileCatalogRepository(path.join(pastaTemporaria(t), 'c.json'))];
  for (const repo of repos) {
    for (const id of ['__proto__', 'constructor', 'prototype', '', null, 5]) assert.throws(() => repo.getById('nichos', id), /id/i, String(id));
    assert.throws(() => repo.list('__proto__'), /catálogo desconhecido/);
    assert.throws(() => repo.list('toString'), /catálogo desconhecido/);
    assert.throws(() => repo.insert('nichos', null), /exige um item/);
    assert.throws(() => repo.insert('nichos', { id: 'niche:00000000-0000-4000-8000-000000000001', nome: 'x' }), /nomeNormalizado/);
  }
});

test('[CATFILE-6] os dados de teste vivem SÓ em diretório temporário: o caminho usado fica sob o diretório temporário do sistema e nunca em data/', (t) => {
  const dir = pastaTemporaria(t);
  assert.ok(dir.startsWith(os.tmpdir()), 'sob o diretório temporário');
  assert.doesNotMatch(dir.replace(/\\/g, '/'), /\/data(\/|$)/);
  const repo = createJsonFileCatalogRepository(path.join(dir, 'crm-catalogs.json'));
  repo.insert('origens', makeItem('origens', 1, { nome: 'Indicação' }));
  assert.equal(fs.readdirSync(dir).length, 1);
});
