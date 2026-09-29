// Testes do domínio de Funis (src/crm/funnelDomain.js) — Etapa "Funis 1" da reestruturação Prospecção/CRM/Funis.
// Regras de negócio: criar/editar/copiar/excluir/reordenar funil e etapa, e os dois GUARDAS críticos de exclusão
// (seções 10/12 do comando de reestruturação: nunca excluir funil/etapa com cards vinculados).

const test = require('node:test');
const assert = require('node:assert/strict');

const funnelDomain = require('../../src/crm/funnelDomain');
const { createInMemoryFunnelRepository } = require('../../src/crm/funnelRepository');
const crmDomain = require('../../src/crm/crmDomain');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');

const memRepo = () => createInMemoryFunnelRepository();
const OPERADOR = { userId: 'user-1', name: 'Alguém', role: 'ADMIN' };

// Um registro do CRM real (para os testes de Card — a existência do registro é verificada de verdade, nunca fingida).
async function crmRecord(crmRepo, empresa = 'Clínica Teste') {
  return (await crmDomain.createRecord(crmRepo, { empresa })).record;
}

// ===========================================================================
// FUNIL
// ===========================================================================
test('[FUNNEL-DOM-1] createFunnel exige "nome" (texto não vazio); demais campos são opcionais e têm um default correto', async () => {
  const repo = memRepo();
  await assert.rejects(() => funnelDomain.createFunnel(repo, {}), /exige "nome"/);
  await assert.rejects(() => funnelDomain.createFunnel(repo, { nome: '   ' }), /exige "nome"/);

  const funnel = await funnelDomain.createFunnel(repo, { nome: 'Outbound' });
  assert.match(funnel.id, /^funnel:[0-9a-f-]{36}$/);
  assert.equal(funnel.nome, 'Outbound');
  assert.equal(funnel.descricao, null);
  assert.equal(funnel.finalidade, null);
  assert.equal(funnel.ativo, true);
  assert.equal(funnel.ordem, 0);
  assert.deepEqual(funnel.config, {});
  assert.equal((await repo.getFunnel(funnel.id)).nome, 'Outbound');
});

test('[FUNNEL-DOM-2] cada novo funil nasce com a próxima ordem (0, 1, 2, ...); listFunnels() devolve na ordem', async () => {
  const repo = memRepo();
  const a = await funnelDomain.createFunnel(repo, { nome: 'A' });
  const b = await funnelDomain.createFunnel(repo, { nome: 'B' });
  const c = await funnelDomain.createFunnel(repo, { nome: 'C' });
  assert.deepEqual([a.ordem, b.ordem, c.ordem], [0, 1, 2]);
  assert.deepEqual((await funnelDomain.listFunnels(repo)).map((f) => f.nome), ['A', 'B', 'C']);
});

test('[FUNNEL-DOM-3] updateFunnel altera só os campos enviados; recusa nome vazio; getFunnel de um id inexistente devolve null', async () => {
  const repo = memRepo();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'Original', descricao: 'desc' });
  const editado = await funnelDomain.updateFunnel(repo, funnel.id, { nome: 'Editado' });
  assert.equal(editado.nome, 'Editado');
  assert.equal(editado.descricao, 'desc', 'campo não enviado é preservado');
  await assert.rejects(() => funnelDomain.updateFunnel(repo, funnel.id, { nome: '' }), /exige "nome"/);
  assert.equal(await funnelDomain.getFunnel(repo, 'funnel:nao-existe'), null);
  await assert.rejects(() => funnelDomain.updateFunnel(repo, 'funnel:nao-existe', { nome: 'x' }), /funil não encontrado/);
});

test('[FUNNEL-DOM-4] REGRA CRÍTICA: deleteFunnel recusa (FUNNEL_HAS_CARDS) quando há cards vinculados, e nada é apagado', async () => {
  const repo = memRepo();
  repo.countCardsByFunnel = () => 1; // simula um card vinculado
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'Com Cards' });
  const erro = await funnelDomain.deleteFunnel(repo, funnel.id).catch((e) => e);
  assert.ok(erro instanceof Error);
  assert.equal(erro.code, 'FUNNEL_HAS_CARDS');
  assert.match(erro.message, /cards vinculados/);
  assert.notEqual(await repo.getFunnel(funnel.id), null, 'o funil continua existindo');
});

test('[FUNNEL-DOM-5] deleteFunnel sem cards apaga o funil E as etapas dele; devolve o funil como estava', async () => {
  const repo = memRepo();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'Vazio' });
  await funnelDomain.createStage(repo, funnel.id, { nome: 'Etapa 1' });
  await funnelDomain.createStage(repo, funnel.id, { nome: 'Etapa 2' });
  const devolvido = await funnelDomain.deleteFunnel(repo, funnel.id);
  assert.equal(devolvido.id, funnel.id);
  assert.equal(await repo.getFunnel(funnel.id), null);
  assert.deepEqual(await repo.listStages(funnel.id), []);
});

test('[FUNNEL-DOM-6] copyFunnel clona funil + etapas com NOVOS ids, na mesma ordem; NUNCA copia cards (não há nenhum a copiar nesta etapa) nem histórico; o original permanece intacto', async () => {
  const repo = memRepo();
  const original = await funnelDomain.createFunnel(repo, { nome: 'Original', descricao: 'd', finalidade: 'f', config: { checklist: ['a'] } });
  const s1 = await funnelDomain.createStage(repo, original.id, { nome: 'Etapa 1' });
  const s2 = await funnelDomain.createStage(repo, original.id, { nome: 'Etapa 2' });

  const copia = await funnelDomain.copyFunnel(repo, original.id);
  assert.notEqual(copia.id, original.id);
  assert.equal(copia.nome, 'Original (cópia)');
  assert.equal(copia.descricao, 'd');
  assert.equal(copia.finalidade, 'f');
  assert.deepEqual(copia.config, { checklist: ['a'] });
  assert.equal(copia.ativo, true);

  const copiaStages = await repo.listStages(copia.id);
  assert.equal(copiaStages.length, 2);
  assert.deepEqual(copiaStages.map((s) => s.nome).sort(), ['Etapa 1', 'Etapa 2']);
  assert.ok(copiaStages.every((s) => s.id !== s1.id && s.id !== s2.id), 'ids novos, nunca os do original');

  // O original continua com as suas próprias etapas, intocado.
  assert.equal((await repo.listStages(original.id)).length, 2);
});

test('[FUNNEL-DOM-7] copyFunnel aceita um nome novo explícito', async () => {
  const repo = memRepo();
  const original = await funnelDomain.createFunnel(repo, { nome: 'Original' });
  const copia = await funnelDomain.copyFunnel(repo, original.id, 'Renovação 2027');
  assert.equal(copia.nome, 'Renovação 2027');
});

test('[FUNNEL-DOM-8] reorderFunnels exige a lista EXATA dos funis existentes (cada um uma vez); aplica a nova ordem', async () => {
  const repo = memRepo();
  const a = await funnelDomain.createFunnel(repo, { nome: 'A' });
  const b = await funnelDomain.createFunnel(repo, { nome: 'B' });
  const reordenados = await funnelDomain.reorderFunnels(repo, [b.id, a.id]);
  assert.deepEqual(reordenados.map((f) => f.id), [b.id, a.id]);

  await assert.rejects(() => funnelDomain.reorderFunnels(repo, [a.id]), /a lista de reordenação precisa conter exatamente/);
  await assert.rejects(() => funnelDomain.reorderFunnels(repo, [a.id, b.id, 'funnel:fantasma']), /a lista de reordenação precisa conter exatamente/);
  await assert.rejects(() => funnelDomain.reorderFunnels(repo, 'não é lista'), /exige uma lista de ids/);
});

// ===========================================================================
// ETAPA
// ===========================================================================
test('[FUNNEL-DOM-9] createStage exige um funil existente e "nome"; etapas nascem com a próxima ordem', async () => {
  const repo = memRepo();
  await assert.rejects(() => funnelDomain.createStage(repo, 'funnel:nao-existe', { nome: 'x' }), /funil não encontrado/);
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'F' });
  await assert.rejects(() => funnelDomain.createStage(repo, funnel.id, {}), /exige "nome"/);
  const s1 = await funnelDomain.createStage(repo, funnel.id, { nome: 'Etapa 1' });
  const s2 = await funnelDomain.createStage(repo, funnel.id, { nome: 'Etapa 2' });
  assert.deepEqual([s1.ordem, s2.ordem], [0, 1]);
  assert.equal(s1.funnelId, funnel.id);
});

test('[FUNNEL-DOM-10] as etapas são INDEPENDENTES entre funis: criar/reordenar num funil nunca afeta o outro', async () => {
  const repo = memRepo();
  const a = await funnelDomain.createFunnel(repo, { nome: 'A' });
  const b = await funnelDomain.createFunnel(repo, { nome: 'B' });
  const a1 = await funnelDomain.createStage(repo, a.id, { nome: 'A1' });
  const a2 = await funnelDomain.createStage(repo, a.id, { nome: 'A2' });
  const b1 = await funnelDomain.createStage(repo, b.id, { nome: 'B1' });

  await funnelDomain.reorderStages(repo, a.id, [a2.id, a1.id]);
  assert.deepEqual((await funnelDomain.listStages(repo, a.id)).map((s) => s.id), [a2.id, a1.id]);
  assert.deepEqual((await funnelDomain.listStages(repo, b.id)).map((s) => s.id), [b1.id], 'o funil B não mudou');

  await assert.rejects(() => funnelDomain.reorderStages(repo, a.id, [b1.id]), /a lista de reordenação precisa conter exatamente/, 'uma etapa de OUTRO funil não entra na reordenação deste');
});

test('[FUNNEL-DOM-11] updateStage altera só os campos enviados; getStage de um id inexistente lança "etapa não encontrada"', async () => {
  const repo = memRepo();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'F' });
  const stage = await funnelDomain.createStage(repo, funnel.id, { nome: 'Original' });
  const editada = await funnelDomain.updateStage(repo, stage.id, { ativo: false });
  assert.equal(editada.nome, 'Original', 'preservado');
  assert.equal(editada.ativo, false);
  await assert.rejects(() => funnelDomain.updateStage(repo, 'stage:nao-existe', { nome: 'x' }), /etapa não encontrada/);
});

test('[FUNNEL-DOM-12] REGRA CRÍTICA: deleteStage recusa (STAGE_HAS_CARDS) quando há cards vinculados, e nada é apagado', async () => {
  const repo = memRepo();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'F' });
  const stage = await funnelDomain.createStage(repo, funnel.id, { nome: 'Com Cards' });
  repo.countCardsByStage = () => 1;
  const erro = await funnelDomain.deleteStage(repo, stage.id).catch((e) => e);
  assert.equal(erro.code, 'STAGE_HAS_CARDS');
  assert.match(erro.message, /cards vinculados/);
  assert.notEqual(await repo.getStage(stage.id), null);
});

test('[FUNNEL-DOM-13] deleteStage sem cards apaga normalmente', async () => {
  const repo = memRepo();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'F' });
  const stage = await funnelDomain.createStage(repo, funnel.id, { nome: 'Vazia' });
  const devolvida = await funnelDomain.deleteStage(repo, stage.id);
  assert.equal(devolvida.id, stage.id);
  assert.equal(await repo.getStage(stage.id), null);
});

test('[FUNNEL-DOM-14] ids inválidos (vazio, só espaços, não-texto) são recusados em toda operação por id, antes de tocar o repositório', async () => {
  const repo = memRepo();
  for (const ruim of ['', '   ', null, undefined, 42, {}]) {
    await assert.rejects(() => funnelDomain.getFunnel(repo, ruim), /id de funil deve ser um texto não vazio/, String(ruim));
    await assert.rejects(() => funnelDomain.deleteFunnel(repo, ruim), /id de funil deve ser um texto não vazio/, String(ruim));
    await assert.rejects(() => funnelDomain.deleteStage(repo, ruim), /id de etapa deve ser um texto não vazio/, String(ruim));
  }
});

test('[FUNNEL-DOM-15] um repositório inválido é recusado em toda operação (defesa de composição)', async () => {
  for (const ruim of [null, undefined, {}, { listFunnels: () => [] }]) {
    await assert.rejects(() => funnelDomain.listFunnels(ruim), /repositório inválido/, JSON.stringify(ruim));
  }
});

// ===========================================================================
// CARD (Etapa "Funis 2")
// ===========================================================================
test('[FUNNEL-DOM-16] createCard exige um funil existente e um registro do CRM existente; posiciona o card na etapa de MENOR ordem; registra a movimentação inicial (stageFrom null)', async () => {
  const repo = memRepo();
  const crmRepo = createInMemoryCrmRepository();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'Outbound' });
  await funnelDomain.createStage(repo, funnel.id, { nome: 'Sem contato' });
  const segunda = await funnelDomain.createStage(repo, funnel.id, { nome: 'Contatado' });
  await funnelDomain.reorderStages(repo, funnel.id, [segunda.id, (await funnelDomain.listStages(repo, funnel.id)).find((s) => s.nome === 'Sem contato').id]);
  // Depois de reordenar, "Contatado" é a de MENOR ordem — deve ser a primeira etapa do card.

  await assert.rejects(() => funnelDomain.createCard(repo, crmRepo, { funnelId: 'funnel:nao-existe', crmRecordId: 'crm:x' }), /funil não encontrado/);

  const record = await crmRecord(crmRepo, 'Clínica Alfa');
  await assert.rejects(() => funnelDomain.createCard(repo, crmRepo, { funnelId: funnel.id, crmRecordId: 'crm:nao-existe' }), /registro do CRM não encontrado/);

  const card = await funnelDomain.createCard(repo, crmRepo, { funnelId: funnel.id, crmRecordId: record.id }, { reviewedBy: OPERADOR });
  assert.match(card.id, /^card:[0-9a-f-]{36}$/);
  assert.equal(card.funnelId, funnel.id);
  assert.equal(card.crmRecordId, record.id);
  assert.equal(card.stageId, segunda.id, 'a etapa de MENOR ordem, mesmo depois de reordenar');
  assert.equal(card.removedAt, null);

  const historico = await funnelDomain.getCardHistory(repo, card.id);
  assert.equal(historico.length, 1);
  assert.equal(historico[0].stageFrom, null);
  assert.equal(historico[0].stageTo, segunda.id);
  assert.deepEqual(historico[0].movedBy, OPERADOR);
});

test('[FUNNEL-DOM-17] createCard recusa (FUNNEL_HAS_NO_STAGES) um funil sem nenhuma etapa', async () => {
  const repo = memRepo();
  const crmRepo = createInMemoryCrmRepository();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'Vazio' });
  const record = await crmRecord(crmRepo);
  const erro = await funnelDomain.createCard(repo, crmRepo, { funnelId: funnel.id, crmRecordId: record.id }).catch((e) => e);
  assert.equal(erro.code, 'FUNNEL_HAS_NO_STAGES');
});

test('[FUNNEL-DOM-18] REGRA DE IDENTIDADE (seção 3): 1 CRM Record + 1 Funil = no máximo 1 card ATIVO — a segunda tentativa recusa (FUNNEL_CARD_DUPLICATE); o mesmo registro PODE ter um card em OUTRO funil', async () => {
  const repo = memRepo();
  const crmRepo = createInMemoryCrmRepository();
  const funnelA = await funnelDomain.createFunnel(repo, { nome: 'Outbound' });
  await funnelDomain.createStage(repo, funnelA.id, { nome: 'Etapa 1' });
  const funnelB = await funnelDomain.createFunnel(repo, { nome: 'Renovação' });
  await funnelDomain.createStage(repo, funnelB.id, { nome: 'Etapa 1' });
  const record = await crmRecord(crmRepo, 'Clínica ABC');

  await funnelDomain.createCard(repo, crmRepo, { funnelId: funnelA.id, crmRecordId: record.id });
  const erro = await funnelDomain.createCard(repo, crmRepo, { funnelId: funnelA.id, crmRecordId: record.id }).catch((e) => e);
  assert.equal(erro.code, 'FUNNEL_CARD_DUPLICATE');

  // Mas o MESMO registro pode ter um card em OUTRO funil — isso é permitido (seção 3).
  const cardB = await funnelDomain.createCard(repo, crmRepo, { funnelId: funnelB.id, crmRecordId: record.id });
  assert.equal(cardB.funnelId, funnelB.id);
  assert.equal((await funnelDomain.listCardsByFunnel(repo, funnelA.id)).length, 1);
  assert.equal((await funnelDomain.listCardsByFunnel(repo, funnelB.id)).length, 1);
});

test('[FUNNEL-DOM-19] moveCard troca a etapa e registra o histórico (stageFrom/stageTo); é IDEMPOTENTE (mover para a mesma etapa não duplica histórico)', async () => {
  const repo = memRepo();
  const crmRepo = createInMemoryCrmRepository();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'F' });
  const s1 = await funnelDomain.createStage(repo, funnel.id, { nome: 'S1' });
  const s2 = await funnelDomain.createStage(repo, funnel.id, { nome: 'S2' });
  const record = await crmRecord(crmRepo);
  const card = await funnelDomain.createCard(repo, crmRepo, { funnelId: funnel.id, crmRecordId: record.id });
  assert.equal(card.stageId, s1.id);

  const movido = await funnelDomain.moveCard(repo, card.id, s2.id, { reviewedBy: OPERADOR, motivo: 'avançou' });
  assert.equal(movido.stageId, s2.id);
  let historico = await funnelDomain.getCardHistory(repo, card.id);
  assert.equal(historico.length, 2, 'criação + 1 movimentação');
  assert.equal(historico[1].stageFrom, s1.id);
  assert.equal(historico[1].stageTo, s2.id);
  assert.equal(historico[1].motivo, 'avançou');

  const repetido = await funnelDomain.moveCard(repo, card.id, s2.id);
  assert.equal(repetido.stageId, s2.id);
  historico = await funnelDomain.getCardHistory(repo, card.id);
  assert.equal(historico.length, 2, 'mover para a MESMA etapa não cria uma nova entrada — idempotente');
});

test('[FUNNEL-DOM-20] moveCard recusa (FUNNEL_STAGE_MISMATCH) mover para uma etapa de OUTRO funil; recusa etapa/card inexistente', async () => {
  const repo = memRepo();
  const crmRepo = createInMemoryCrmRepository();
  const funnelA = await funnelDomain.createFunnel(repo, { nome: 'A' });
  await funnelDomain.createStage(repo, funnelA.id, { nome: 'A1' });
  const funnelB = await funnelDomain.createFunnel(repo, { nome: 'B' });
  const stageB = await funnelDomain.createStage(repo, funnelB.id, { nome: 'B1' });
  const record = await crmRecord(crmRepo);
  const card = await funnelDomain.createCard(repo, crmRepo, { funnelId: funnelA.id, crmRecordId: record.id });

  const erro = await funnelDomain.moveCard(repo, card.id, stageB.id).catch((e) => e);
  assert.equal(erro.code, 'FUNNEL_STAGE_MISMATCH');

  await assert.rejects(() => funnelDomain.moveCard(repo, 'card:nao-existe', stageB.id), /card não encontrado/);
  await assert.rejects(() => funnelDomain.moveCard(repo, card.id, 'stage:nao-existe'), /etapa não encontrada/);
});

test('[FUNNEL-DOM-21] deleteCard ARQUIVA (nunca apaga fisicamente): o card some de listCardsByFunnel, mas getCard e o histórico continuam acessíveis; arquivar de novo é um no-op idempotente', async () => {
  const repo = memRepo();
  const crmRepo = createInMemoryCrmRepository();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'F' });
  await funnelDomain.createStage(repo, funnel.id, { nome: 'S1' });
  const record = await crmRecord(crmRepo);
  const card = await funnelDomain.createCard(repo, crmRepo, { funnelId: funnel.id, crmRecordId: record.id });

  const arquivado = await funnelDomain.deleteCard(repo, card.id);
  assert.equal(arquivado.id, card.id);
  assert.equal((await funnelDomain.listCardsByFunnel(repo, funnel.id)).length, 0, 'some das listagens ativas');
  const lido = await funnelDomain.getCard(repo, card.id);
  assert.notEqual(lido, null, 'mas o card continua acessível por id');
  assert.notEqual(lido.removedAt, null);
  assert.equal((await funnelDomain.getCardHistory(repo, card.id)).length, 1, 'o histórico nunca é apagado');

  await assert.doesNotReject(() => funnelDomain.deleteCard(repo, card.id), 'arquivar de novo é idempotente');
  await assert.rejects(() => funnelDomain.deleteCard(repo, 'card:nao-existe'), /card não encontrado/);
});

test('[FUNNEL-DOM-22] depois de ARQUIVAR um card, o MESMO par (funil, registro) pode ganhar um card NOVO (a regra de duplicidade só vale entre cards ATIVOS)', async () => {
  const repo = memRepo();
  const crmRepo = createInMemoryCrmRepository();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'F' });
  await funnelDomain.createStage(repo, funnel.id, { nome: 'S1' });
  const record = await crmRecord(crmRepo);
  const primeiro = await funnelDomain.createCard(repo, crmRepo, { funnelId: funnel.id, crmRecordId: record.id });
  await funnelDomain.deleteCard(repo, primeiro.id);

  const segundo = await funnelDomain.createCard(repo, crmRepo, { funnelId: funnel.id, crmRecordId: record.id });
  assert.notEqual(segundo.id, primeiro.id);
  assert.equal((await funnelDomain.listCardsByFunnel(repo, funnel.id)).length, 1);
});

test('[FUNNEL-DOM-23] um card ARQUIVADO nunca bloqueia excluir o funil/etapa (os guardas de exclusão só contam cards ATIVOS)', async () => {
  const repo = memRepo();
  const crmRepo = createInMemoryCrmRepository();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'F' });
  const stage = await funnelDomain.createStage(repo, funnel.id, { nome: 'S1' });
  const record = await crmRecord(crmRepo);
  const card = await funnelDomain.createCard(repo, crmRepo, { funnelId: funnel.id, crmRecordId: record.id });
  await funnelDomain.deleteCard(repo, card.id);

  await assert.doesNotReject(() => funnelDomain.deleteStage(repo, stage.id));
  await assert.doesNotReject(() => funnelDomain.deleteFunnel(repo, funnel.id));
});

test('[FUNNEL-DOM-24] um card ATIVO BLOQUEIA excluir o funil (FUNNEL_HAS_CARDS) e a etapa (STAGE_HAS_CARDS) — os guardas da Etapa "Funis 1" agora valem de verdade', async () => {
  const repo = memRepo();
  const crmRepo = createInMemoryCrmRepository();
  const funnel = await funnelDomain.createFunnel(repo, { nome: 'F' });
  const stage = await funnelDomain.createStage(repo, funnel.id, { nome: 'S1' });
  const record = await crmRecord(crmRepo);
  await funnelDomain.createCard(repo, crmRepo, { funnelId: funnel.id, crmRecordId: record.id });

  const erroEtapa = await funnelDomain.deleteStage(repo, stage.id).catch((e) => e);
  assert.equal(erroEtapa.code, 'STAGE_HAS_CARDS');
  const erroFunil = await funnelDomain.deleteFunnel(repo, funnel.id).catch((e) => e);
  assert.equal(erroFunil.code, 'FUNNEL_HAS_CARDS');
});
