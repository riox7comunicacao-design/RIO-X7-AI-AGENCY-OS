'use strict';

// Fase 2B-3.2B — verifyCandidate (src/services/prospectingExclusionService.js): a verificação OBRIGATÓRIA da promoção. Os quatro vereditos, a
// precedência, "só ids" (nunca o motivo, o nome ou o domínio da exclusão), a falha FECHADA para tudo o que não é uma lista inteira de objetos
// válidos, e a garantia de que só LÊ. Repositório em memória; nenhum arquivo, nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProspectingExclusionService, ERROR, ProspectingExclusionError } = require('../../src/services/prospectingExclusionService');
const { createInMemoryPermanentExclusionRepository } = require('../../src/research-prospector/permanentExclusionRepository');
const { normalizeCompanyName } = require('../../src/research-prospector/permanentExclusion');
const { authorizeProspectingExclusionOperation } = require('../../src/auth');

const MOTIVO = 'MOTIVO-PRIVADO-verify-4e21';

const linha = (id, empresa, extra = {}) => ({ id, empresa, empresaNomeNormalizado: normalizeCompanyName(empresa), cidade: null, estado: null, pais: 'Brasil', dominio: null, motivo: MOTIVO, ativo: true, ...extra });

function servicoCom(repositorio) {
  return createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository: repositorio });
}
const emMemoria = (linhas) => createInMemoryPermanentExclusionRepository(linhas);
// um repositório cuja leitura devolve exatamente `devolve` (ou lança)
const repositorioQueDevolve = (devolve) => ({ list: typeof devolve === 'function' ? devolve : () => devolve, getById: () => null, insert: () => null, update: () => null });

test('[EXCL-VER-1] os quatro vereditos — confirmada, ambígua, sem correspondência e dados insuficientes — e SÓ ids (nada da exclusão)', async () => {
  const servico = servicoCom(emMemoria([
    linha('ex-1', 'Clínica Alfa', { cidade: 'Petrópolis', estado: 'RJ' }),
    linha('ex-2', 'Clínica Beta', { cidade: 'Niterói' }),
    linha('ex-3', 'Nome Que Nao Existe No Candidato', { dominio: 'gama.example.test' }),
  ]));
  const confirmada = await servico.verifyCandidate({ empresa: 'clinica alfa', cidade: 'Petrópolis', estado: 'RJ' });
  assert.deepEqual({ ...confirmada, exclusaoIds: [...confirmada.exclusaoIds] }, { resultado: 'CORRESPONDENCIA_CONFIRMADA', exclusaoIds: ['ex-1'] });
  const porDominio = await servico.verifyCandidate({ empresa: 'Outra', site: 'https://www.gama.example.test/x' });
  assert.deepEqual([porDominio.resultado, [...porDominio.exclusaoIds]], ['CORRESPONDENCIA_CONFIRMADA', ['ex-3']]);
  const ambigua = await servico.verifyCandidate({ empresa: 'Clínica Beta' });
  assert.deepEqual([ambigua.resultado, [...ambigua.exclusaoIds]], ['AMBIGUA', ['ex-2']]);
  const sem = await servico.verifyCandidate({ empresa: 'Clínica Delta', cidade: 'Petrópolis' });
  assert.deepEqual([sem.resultado, [...sem.exclusaoIds]], ['SEM_CORRESPONDENCIA', []]);
  const insuficiente = await servico.verifyCandidate({ empresa: '!!!', site: 'gama.example.test' });
  assert.deepEqual([insuficiente.resultado, [...insuficiente.exclusaoIds]], ['DADOS_INSUFICIENTES', []]);

  for (const veredito of [confirmada, porDominio, ambigua, sem, insuficiente]) {
    assert.deepEqual(Object.keys(veredito).sort(), ['exclusaoIds', 'resultado']);
    assert.equal(Object.isFrozen(veredito), true);
    assert.equal(JSON.stringify(veredito).includes(MOTIVO), false, 'nunca o motivo');
    assert.equal(/Clínica Alfa|gama\.example\.test|Petrópolis/.test(JSON.stringify(veredito)), false, 'nunca o nome, o domínio nem a cidade da exclusão');
  }
});

test('[EXCL-VER-2] PRECEDÊNCIA: a correspondência confirmada vence a ambígua (todas as confirmadas são listadas); a ambígua vence o "sem correspondência"', async () => {
  const servico = servicoCom(emMemoria([
    linha('ex-amb', 'Clínica Alfa', { cidade: 'Petrópolis' }),
    linha('ex-conf-1', 'Clínica Alfa'),
    linha('ex-conf-2', 'Outro Nome', { dominio: 'alfa.example.test' }),
  ]));
  const veredito = await servico.verifyCandidate({ empresa: 'Clínica Alfa', site: 'alfa.example.test' });
  assert.equal(veredito.resultado, 'CORRESPONDENCIA_CONFIRMADA');
  assert.deepEqual([...veredito.exclusaoIds].sort(), ['ex-conf-1', 'ex-conf-2']);
  const soAmbigua = await servicoCom(emMemoria([linha('ex-amb', 'Clínica Alfa', { cidade: 'Petrópolis' })])).verifyCandidate({ empresa: 'Clínica Alfa' });
  assert.equal(soAmbigua.resultado, 'AMBIGUA');
});

test('[EXCL-VER-3] exclusão INATIVA nunca conta (confirmada, ambígua ou por domínio); lista vazia é SEM_CORRESPONDENCIA', async () => {
  const servico = servicoCom(emMemoria([
    linha('i-1', 'Clínica Alfa', { ativo: false }),
    linha('i-2', 'Clínica Beta', { ativo: false, cidade: 'Petrópolis' }),
    linha('i-3', 'Nome X', { ativo: false, dominio: 'alfa.example.test' }),
  ]));
  assert.equal((await servico.verifyCandidate({ empresa: 'Clínica Alfa', site: 'alfa.example.test' })).resultado, 'SEM_CORRESPONDENCIA');
  assert.equal((await servico.verifyCandidate({ empresa: 'Clínica Beta' })).resultado, 'SEM_CORRESPONDENCIA');
  assert.equal((await servicoCom(emMemoria([])).verifyCandidate({ empresa: 'Clínica Alfa' })).resultado, 'SEM_CORRESPONDENCIA');
});

test('[EXCL-VER-4] FALHA FECHADA: leitura que lança, lista que não é lista, linha que não é objeto e exclusão ATIVA sem nome utilizável viram EXCLUSION_PERSISTENCE — nunca "sem correspondência"', async () => {
  const casos = {
    'leitura lança': repositorioQueDevolve(() => { throw new Error('banco fora SEGREDO'); }),
    'leitura rejeita': repositorioQueDevolve(async () => { throw new Error('banco fora SEGREDO'); }),
    undefined: repositorioQueDevolve(undefined),
    null: repositorioQueDevolve(null),
    objeto: repositorioQueDevolve({ items: [] }),
    texto: repositorioQueDevolve('[]'),
    numero: repositorioQueDevolve(0),
    'linha nula': repositorioQueDevolve([linha('a', 'X'), null]),
    'linha texto': repositorioQueDevolve(['x']),
    'linha lista': repositorioQueDevolve([[]]),
    'ativa sem nome': repositorioQueDevolve([{ id: 'z', ativo: true, empresa: '!!!', empresaNomeNormalizado: '' }]),
    'ativa sem nada': repositorioQueDevolve([{ id: 'z', ativo: true }]),
  };
  for (const [nome, repositorio] of Object.entries(casos)) {
    let erro;
    try {
      await servicoCom(repositorio).verifyCandidate({ empresa: 'Clínica Alfa' });
    } catch (e) {
      erro = e;
    }
    assert.ok(erro instanceof ProspectingExclusionError, nome);
    assert.equal(erro.code, ERROR.PERSISTENCE, nome);
    assert.equal(erro.message, 'Exclusões Permanentes: não foi possível consultar a lista.', `${nome}: mensagem fixa`);
    assert.equal(/SEGREDO/.test(erro.message), false, nome);
  }
  // uma linha INATIVA sem nome utilizável não impede a verificação (não participa de nada)
  const tolerada = await servicoCom(repositorioQueDevolve([{ id: 'z', ativo: false, empresa: '!!!', empresaNomeNormalizado: '' }])).verifyCandidate({ empresa: 'Clínica Alfa' });
  assert.equal(tolerada.resultado, 'SEM_CORRESPONDENCIA');
});

test('[EXCL-VER-5] DADOS INSUFICIENTES: sem nome verificável a lista NEM é lida (nenhuma consulta é feita, nem pode falhar)', async () => {
  let leituras = 0;
  const servico = servicoCom(repositorioQueDevolve(() => { leituras += 1; throw new Error('não deveria ser lida'); }));
  for (const candidato of [{}, { empresa: '' }, { empresa: '   ' }, { empresa: '!!!' }, { empresa: 7 }, { site: 'alfa.example.test' }, null, undefined, 'texto', []]) {
    assert.equal((await servico.verifyCandidate(candidato)).resultado, 'DADOS_INSUFICIENTES', JSON.stringify(candidato));
  }
  assert.equal(leituras, 0);
});

test('[EXCL-VER-6] só LÊ: a verificação nunca insere, atualiza, desativa nem relê por id — e não exige autorização (checagem interna, como isExcluded); a lista é a mesma depois', async () => {
  const base = emMemoria([linha('ex-1', 'Clínica Alfa')]);
  const chamadas = { list: 0, getById: 0, insert: 0, update: 0 };
  const observado = { list: () => ((chamadas.list += 1), base.list()), getById: (id) => ((chamadas.getById += 1), base.getById(id)), insert: (l) => ((chamadas.insert += 1), base.insert(l)), update: (id, p) => ((chamadas.update += 1), base.update(id, p)) };
  const antes = JSON.stringify(base.list());
  const servico = servicoCom(observado);
  for (const candidato of [{ empresa: 'Clínica Alfa' }, { empresa: 'Outra' }, { empresa: '!!!' }]) await servico.verifyCandidate(candidato);
  assert.deepEqual(chamadas, { list: 2, getById: 0, insert: 0, update: 0 });
  assert.equal(JSON.stringify(base.list()), antes);
});

test('[EXCL-VER-7] a ingestão NÃO mudou: isExcluded continua devolvendo a exclusão que bateu (ou false) — a ambígua não bloqueia — e verifyCandidate não a afeta', async () => {
  const servico = servicoCom(emMemoria([linha('ex-1', 'Clínica Alfa', { cidade: 'Petrópolis' })]));
  assert.equal((await servico.isExcluded({ empresa: 'Clínica Alfa', cidade: 'Petrópolis' })).id, 'ex-1');
  assert.equal(await servico.isExcluded({ empresa: 'Clínica Alfa' }), false, 'ambígua: a ingestão deixa passar');
  assert.equal((await servico.verifyCandidate({ empresa: 'Clínica Alfa' })).resultado, 'AMBIGUA', 'e a promoção a vê');
  assert.equal(await servico.isExcluded({ empresa: 'Clínica Beta' }), false);
});
