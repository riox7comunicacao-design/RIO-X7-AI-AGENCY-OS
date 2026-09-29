// Testes do domínio de Funis (src/crm/funnelDomain.js) — Etapa "Funis 1" da reestruturação Prospecção/CRM/Funis.
// Regras de negócio: criar/editar/copiar/excluir/reordenar funil e etapa, e os dois GUARDAS críticos de exclusão
// (seções 10/12 do comando de reestruturação: nunca excluir funil/etapa com cards vinculados).

const test = require('node:test');
const assert = require('node:assert/strict');

const funnelDomain = require('../../src/crm/funnelDomain');
const { createInMemoryFunnelRepository } = require('../../src/crm/funnelRepository');

const memRepo = () => createInMemoryFunnelRepository();

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
