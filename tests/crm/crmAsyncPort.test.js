// A PORTA ASSÍNCRONA do CRM (decisão 0023, etapa 4.2 — Fase A). Nenhum adapter remoto existe: aqui o domínio e o Service rodam sobre
// repositórios que DEVOLVEM PROMESSAS (um invólucro de teste que cede a vez ao event loop em cada chamada, como faria a rede) e sobre
// o adapter de arquivo real, para provar que:
//   - o resultado é o MESMO do adapter síncrono (ids à parte): registros, histórico, DNC, duplicidade, null, números, ordem, cópias;
//   - as escritas de um mesmo repositório rodam uma por vez (nenhuma gravação perdida, nenhuma identidade duplicada) — o que a porta
//     síncrona dava de graça e que o `await` de uma porta assíncrona deixaria de dar;
//   - uma falha de gravação passa intacta, não deixa meia-escrita e não trava as escritas seguintes.
// A proteção ENTRE processos (transação, restrição única) NÃO é testada: não existe (é da persistência remota, ainda não feita).
// Tudo fictício (example.test); arquivos em diretório temporário.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crmDomain = require('../../src/crm/crmDomain');
const { createInMemoryCrmRepository, createJsonFileCrmRepository, assertValidRepository } = require('../../src/crm/crmRepository');
const { createCrmService } = require('../../src/services/crmService');
const { CRM_STATUS, ACTOR } = require('../../src/crm/constants');
const { ROLE, USER_STATUS, defineUser, authorizeCrmOperation } = require('../../src/auth');
const { createAuthorizationContext } = require('../helpers/authFixtures');

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Um repositório ASSÍNCRONO por cima de qualquer repositório síncrono: cada chamada cede a vez ao menos uma vez (como uma ida à rede)
// e devolve uma Promise. `falhar`: faz o save seguinte rejeitar (uma vez).
function assincrono(interno) {
  const estado = { falhar: null, chamadas: [] };
  return {
    estado,
    interno,
    async list() {
      estado.chamadas.push('list');
      await tick();
      return interno.list();
    },
    async getById(id) {
      estado.chamadas.push('getById');
      await tick();
      return interno.getById(id);
    },
    async save(registro) {
      estado.chamadas.push('save');
      await tick();
      if (estado.falhar) {
        const erro = estado.falhar;
        estado.falhar = null;
        throw erro;
      }
      await tick();
      interno.save(registro);
    },
  };
}

function arquivoTemporario(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-async-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'crm.json');
}

const OPERADOR = { actor: ACTOR.HUMAN, reviewedBy: { userId: 'user-teste', name: 'Teste', role: 'ADMIN' }, motivo: 'teste' };
// Os campos que definem o registro, sem o que é gerado (id e timestamps): para comparar dois repositórios diferentes.
const semGerados = (registro) => ({
  ...registro,
  id: undefined,
  dataDeEntrada: undefined,
  historico: registro.historico.map((h) => ({ ...h, timestamp: undefined })),
});

// O mesmo roteiro, contra qualquer repositório: devolve o que aconteceu, sem ids nem datas.
async function roteiro(repo) {
  const saida = {};
  const alfa = (await crmDomain.createRecord(repo, { empresa: 'Clínica Alfa Teste', site: 'alfa.example.test', telefone: '24 90000-0001', valorProposta: 1500.5, cidade: 'Petrópolis' }, OPERADOR)).record;
  const beta = (await crmDomain.createRecord(repo, { empresa: 'Clínica Beta Teste', site: 'beta.example.test' }, { ...OPERADOR, status: CRM_STATUS.RESEARCH })).record;
  saida.duplicado = await crmDomain.createRecord(repo, { empresa: 'Outra', site: 'alfa.example.test' }, OPERADOR).catch((e) => e.message.replace(alfa.id, '<id>'));
  saida.possivel = (await crmDomain.createRecord(repo, { empresa: 'Clínica Alfa Teste', cidade: 'Petrópolis' }, OPERADOR)).duplicidade !== null;
  await crmDomain.moveStatus(repo, alfa.id, CRM_STATUS.CONTACTED, { ...OPERADOR, motivo: 'contato' });
  await crmDomain.updateRecord(repo, beta.id, { observacoes: 'nota', valorTotal: 0 });
  await crmDomain.markDoNotContact(repo, alfa.id, OPERADOR);
  saida.editarBloqueado = await crmDomain.updateRecord(repo, alfa.id, { nicho: 'x' }).catch((e) => e.message.replace(alfa.id, '<id>'));
  saida.moverBloqueado = await crmDomain.moveStatus(repo, alfa.id, CRM_STATUS.PROSPECT).catch((e) => e.message);
  saida.recriarBloqueado = await crmDomain.createRecord(repo, { empresa: 'Nome Novo', site: 'alfa.example.test' }, OPERADOR).catch((e) => e.message.replace(alfa.id, '<id>'));
  saida.inexistente = await crmDomain.getRecord(repo, 'crm:nao-existe');
  saida.erroInexistente = await crmDomain.moveStatus(repo, 'crm:nao-existe', CRM_STATUS.WON).catch((e) => e.message);
  saida.lista = (await crmDomain.listRecords(repo)).map(semGerados);
  saida.nomesNaOrdem = saida.lista.map((r) => r.empresa);
  return saida;
}

test('[CRM-ASYNC-1] o MESMO roteiro (criar, duplicidade, DNC, edição, transição, inexistente, ordem) dá o MESMO resultado no repositório síncrono, no assíncrono e no de arquivo assíncrono', async (t) => {
  const base = await roteiro(createInMemoryCrmRepository());
  assert.equal(base.lista.length, 3, 'sanidade: alfa, beta e o possível duplicado (só nome+cidade) coexistem');
  assert.equal(base.possivel, true);
  assert.match(base.duplicado, /já existe um registro com a mesma identidade/);
  assert.match(base.editarBloqueado, /registro bloqueado \(DO_NOT_CONTACT\) não pode ser atualizado/);
  assert.match(base.moverBloqueado, /transição não permitida: DO_NOT_CONTACT -> PROSPECT/);
  assert.match(base.recriarBloqueado, /identidade já bloqueada como DO_NOT_CONTACT/);
  assert.equal(base.inexistente, null);
  assert.match(base.erroInexistente, /registro não encontrado: crm:nao-existe/);
  assert.deepEqual(base.nomesNaOrdem, ['Clínica Alfa Teste', 'Clínica Beta Teste', 'Clínica Alfa Teste'], 'a ordem é a de inserção');

  assert.deepEqual(await roteiro(assincrono(createInMemoryCrmRepository())), base, 'memória assíncrona');
  assert.deepEqual(await roteiro(assincrono(createJsonFileCrmRepository(arquivoTemporario(t)))), base, 'arquivo assíncrono');
  assert.deepEqual(await roteiro(createJsonFileCrmRepository(arquivoTemporario(t))), base, 'arquivo síncrono (o adapter de produção, inalterado)');
});

test('[CRM-ASYNC-2] contrato de dados sobre a porta assíncrona: null, números e texto exatos, id "crm:", histórico completo, cópias defensivas (alterar o retorno nunca altera o guardado)', async (t) => {
  for (const repo of [assincrono(createInMemoryCrmRepository()), assincrono(createJsonFileCrmRepository(arquivoTemporario(t)))]) {
    const { record } = await crmDomain.createRecord(repo, { empresa: '  Clínica Contrato Teste  ', valorProposta: 1500.5, valorTotal: 0, observacoes: '   ' }, OPERADOR);
    assert.match(record.id, /^crm:[0-9a-f-]{36}$/);
    assert.equal(record.empresa, 'Clínica Contrato Teste', 'espaços nas pontas removidos');
    assert.equal(record.valorProposta, 1500.5);
    assert.equal(record.valorTotal, 0, 'zero é um número, não vazio');
    assert.equal(record.observacoes, null, 'texto em branco vira null');
    assert.equal(record.telefone, null);
    assert.deepEqual(record.historico, [{ timestamp: record.dataDeEntrada, from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: OPERADOR.reviewedBy, motivo: 'teste' }]);
    record.empresa = 'ALTERADO';
    record.historico.push('lixo');
    const lido = await crmDomain.getRecord(repo, record.id);
    assert.equal(lido.empresa, 'Clínica Contrato Teste', 'o retorno de createRecord é uma cópia');
    assert.equal(lido.historico.length, 1);
    lido.empresa = 'ALTERADO 2';
    (await crmDomain.listRecords(repo))[0].historico.length = 0;
    assert.equal((await crmDomain.getRecord(repo, record.id)).empresa, 'Clínica Contrato Teste', 'getRecord e listRecords também devolvem cópias');
    assert.equal((await crmDomain.getRecord(repo, record.id)).historico.length, 1);
  }
});

test('[CRM-ASYNC-3] escritas CONCORRENTES do mesmo repositório rodam uma por vez: duas criações com a mesma identidade => uma só é criada; cinco mudanças de status ao mesmo tempo => cinco eventos encadeados, nenhuma gravação perdida', async () => {
  const repo = assincrono(createInMemoryCrmRepository());
  const resultados = await Promise.allSettled([
    crmDomain.createRecord(repo, { empresa: 'Corrida A', site: 'corrida.example.test' }, OPERADOR),
    crmDomain.createRecord(repo, { empresa: 'Corrida B', site: 'corrida.example.test' }, OPERADOR),
    crmDomain.createRecord(repo, { empresa: 'Corrida C', site: 'www.corrida.example.test' }, OPERADOR),
  ]);
  assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1, 'só uma criação passa; as outras veem a primeira e são recusadas por duplicidade');
  assert.equal(resultados.filter((r) => r.status === 'rejected' && /mesma identidade/.test(r.reason.message)).length, 2);
  assert.equal((await crmDomain.listRecords(repo)).length, 1);

  const id = resultados.find((r) => r.status === 'fulfilled').value.record.id;
  const destinos = [CRM_STATUS.RESEARCH, CRM_STATUS.CONTACTED, CRM_STATUS.RESPONDED, CRM_STATUS.QUALIFICATION, CRM_STATUS.PROPOSAL];
  await Promise.all(destinos.map((to) => crmDomain.moveStatus(repo, id, to, OPERADOR)));
  const final = await crmDomain.getRecord(repo, id);
  assert.equal(final.historico.length, 1 + destinos.length, 'nenhum evento foi perdido');
  final.historico.slice(1).forEach((evento, i) => {
    assert.equal(evento.from, final.historico[i].to, 'cada evento parte de onde o anterior chegou (sem "última gravação vence")');
  });
  assert.deepEqual(final.historico.slice(1).map((e) => e.to), destinos, 'na ordem de chegada');
  assert.equal(final.status, CRM_STATUS.PROPOSAL);
});

test('[CRM-ASYNC-4] a trava é por repositório: repositórios diferentes não se esperam; e as LEITURAS nunca esperam por uma escrita em andamento', async () => {
  const a = assincrono(createInMemoryCrmRepository());
  const b = assincrono(createInMemoryCrmRepository());
  const semente = (await crmDomain.createRecord(a, { empresa: 'Semente Teste' }, OPERADOR)).record;
  let liberar;
  const travado = new Promise((resolve) => { liberar = resolve; });
  const saveOriginal = a.save;
  a.save = async (registro) => { await travado; return saveOriginal(registro); }; // a escrita de `a` fica pendente
  const escritaPendente = crmDomain.moveStatus(a, semente.id, CRM_STATUS.CONTACTED, OPERADOR);
  await tick();
  const outra = await crmDomain.createRecord(b, { empresa: 'Em Outro Repositório' }, OPERADOR); // não espera a escrita de `a`
  assert.equal(outra.record.empresa, 'Em Outro Repositório');
  assert.equal((await crmDomain.getRecord(a, semente.id)).status, 'PROSPECT', 'a leitura não espera a escrita e vê o estado anterior');
  assert.equal((await crmDomain.listRecords(a)).length, 1);
  liberar();
  await escritaPendente;
  assert.equal((await crmDomain.getRecord(a, semente.id)).status, 'CONTACTED');
});

test('[CRM-ASYNC-5] uma gravação que FALHA passa intacta (mesmo erro), não deixa meia-escrita e não trava as escritas seguintes', async () => {
  const repo = assincrono(createInMemoryCrmRepository());
  const { record } = await crmDomain.createRecord(repo, { empresa: 'Falha Teste' }, OPERADOR);
  const erro = new Error('disco cheio (teste)');
  repo.estado.falhar = erro;
  await assert.rejects(() => crmDomain.moveStatus(repo, record.id, CRM_STATUS.CONTACTED, OPERADOR), (e) => e === erro, 'o erro do repositório passa intacto');
  const depois = await crmDomain.getRecord(repo, record.id);
  assert.equal(depois.status, 'PROSPECT');
  assert.equal(depois.historico.length, 1, 'nada foi gravado pela metade');
  // a fila de escritas não ficou envenenada: a próxima operação funciona
  assert.equal((await crmDomain.moveStatus(repo, record.id, CRM_STATUS.CONTACTED, OPERADOR)).status, 'CONTACTED');
  // e uma falha no meio de várias escritas simultâneas só derruba a que falhou
  repo.estado.falhar = erro;
  const varias = await Promise.allSettled([
    crmDomain.updateRecord(repo, record.id, { observacoes: 'primeira falha' }),
    crmDomain.updateRecord(repo, record.id, { observacoes: 'segunda passa' }),
  ]);
  assert.deepEqual(varias.map((r) => r.status), ['rejected', 'fulfilled']);
  assert.equal((await crmDomain.getRecord(repo, record.id)).observacoes, 'segunda passa');
});

test('[CRM-ASYNC-6] a validação da entrada continua ANTES de tudo: um pedido inválido nunca toca o repositório assíncrono (nem lê, nem grava) e a mensagem é a de sempre', async () => {
  const repo = assincrono(createInMemoryCrmRepository());
  await assert.rejects(() => crmDomain.createRecord(repo, { empresa: '' }, OPERADOR), /exige "empresa"/);
  await assert.rejects(() => crmDomain.createRecord(repo, { empresa: 'X' }, { status: 'NAO_EXISTE' }), /status desconhecido/);
  await assert.rejects(() => crmDomain.createRecord(repo, { empresa: 'X', campoInventado: 1 }, OPERADOR), /campos desconhecidos/);
  await assert.rejects(() => crmDomain.createRecord(null, { empresa: 'X' }), /repositório inválido/);
  await assert.rejects(() => crmDomain.moveStatus(repo, 'crm:x', 'NAO_EXISTE'), /status desconhecido/);
  await assert.rejects(() => crmDomain.getRecord(repo, '  '), /id deve ser um texto não vazio/);
  assert.deepEqual(repo.estado.chamadas, [], 'nenhuma chamada ao repositório');
});

test('[CRM-ASYNC-7] o CRM Service sobre a porta assíncrona: o repositório é aceito, e criar, mudar status, DNC e histórico dão o resultado de sempre, com a identidade do CONTEXTO', async (t) => {
  const admin = createAuthorizationContext(defineUser({ userId: 'user-admin-async', authUserId: 'auth-admin-async', name: 'Admin Async', email: 'admin-async@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE }));
  const closer = createAuthorizationContext(defineUser({ userId: 'user-closer-async', authUserId: 'auth-closer-async', name: 'Closer Async', email: 'closer-async@example.test', role: ROLE.COMMERCIAL_CLOSER, status: USER_STATUS.ACTIVE }));
  for (const repository of [assincrono(createInMemoryCrmRepository()), assincrono(createJsonFileCrmRepository(arquivoTemporario(t)))]) {
    assertValidRepository(repository);
    const servico = createCrmService({ authorizeOperation: authorizeCrmOperation, repository });
    const { record } = await servico.createRecord(admin, { empresa: 'Clínica Serviço Teste', site: 'servico.example.test' }, { reason: 'entrada' });
    assert.equal(record.status, 'PROSPECT');
    assert.deepEqual(record.historico[0].reviewedBy, { userId: 'user-admin-async', name: 'Admin Async', role: 'ADMIN' });
    assert.equal((await servico.moveStatus(admin, record.id, 'CONTACTED', { reason: 'contato' })).status, 'CONTACTED');
    await assert.rejects(() => servico.moveStatus(closer, record.id, 'WON'), /acesso negado/);
    assert.equal((await servico.listRecords(closer)).length, 1, 'o closer lê');
    assert.equal((await servico.markDoNotContact(admin, record.id, {})).status, 'DO_NOT_CONTACT');
    const historico = await servico.getHistory(admin, record.id);
    assert.deepEqual(historico.map((h) => h.to), ['PROSPECT', 'CONTACTED', 'DO_NOT_CONTACT']);
    await assert.rejects(() => servico.createRecord(admin, { empresa: 'Outro Nome', site: 'servico.example.test' }), /identidade já bloqueada como DO_NOT_CONTACT/);
    assert.equal(await servico.getRecord(admin, 'crm:nao-existe'), null);
    await assert.rejects(() => servico.getHistory(admin, 'crm:nao-existe'), /registro não encontrado/);
  }
});
