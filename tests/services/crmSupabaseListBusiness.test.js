'use strict';

// Fase H3.2 — PROVAS DE NEGÓCIO da leitura completa de list() no CRM Supabase. Serviços REAIS (CRM Service, domínio, promoção, ingestão, contador de
// catálogo, export, API) sobre o adapter REAL e um PostgREST FALSO que corta as respostas em 1000 linhas, com 1.100 registros fictícios: os que
// importam (DNC, duplicidade, o registro recém-promovido) ficam DEPOIS do 1000º — exatamente onde o list() antigo não via (auditoria H3.1).
// Nenhuma rede, nenhum Supabase real, nenhum dado real; a fila, o arquivo do modo arquivo e o export são TEMPORÁRIOS e removidos ao fim.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { createSupabaseCrmRepository } = require('../../src/crm-adapters/crmSupabaseRepository');
const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { createCrmService } = require('../../src/services/crmService');
const { createCrmCatalogUsageCounter } = require('../../src/services/catalogUsage');
const { authorizeCrmOperation } = require('../../src/auth');
const { exportarCrm } = require('../../scripts/export-crm');
const { novoAmbiente, aprovar, admin, achado, descoberta } = require('../helpers/promotionFixtures');
const { montarAmbiente, BRENO } = require('../server/testEnv');
const { postgrestCrm, enchimento, registro, idDe } = require('../helpers/fakePostgrestCrmList');

const BLOQUEADA = { empresa: 'Clinica Bloqueada Exemplo', site: 'bloqueada-exemplo.example.test' };
const DUPLICADA = { empresa: 'Clinica Duplicada Exemplo', site: 'duplicada-exemplo.example.test' };

// 1.100 registros; o DNC, a duplicidade e um nicho em uso ficam nas posições 1051 a 1053 (depois do 1000º)
function cenario() {
  const linhas = enchimento(1100);
  linhas[1050] = registro({ id: idDe(1051), ...BLOQUEADA, status: 'DO_NOT_CONTACT' });
  linhas[1051] = registro({ id: idDe(1052), ...DUPLICADA });
  linhas[1052] = registro({ id: idDe(1053), empresa: 'Clinica Estetica Exemplo', site: 'estetica-exemplo.example.test', nicho: 'Estética' });
  return linhas;
}
const supabaseCom = (falso) => createSupabaseCrmRepository({ url: 'https://exemplo-falso.example.test', serviceRoleKey: 'chave-falsa', fetchImpl: falso.fetchImpl });
const servicoSobre = (repository) => createCrmService({ authorizeOperation: authorizeCrmOperation, repository });
const comCorte = () => postgrestCrm({ linhas: cenario(), maxRows: 1000 });
// o mesmo CRM no MODO ARQUIVO (arquivo temporário, objeto indexado por id) — a referência do que "completo" significa
function repositorioDeArquivo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-h32-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivo = path.join(dir, 'crm.json');
  fs.writeFileSync(arquivo, JSON.stringify(Object.fromEntries(cenario().map((r) => [r.id, r]))));
  return createJsonFileCrmRepository(arquivo);
}
async function erroDe(fn) {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  return null;
}
const OPCOES = { reason: 'demonstracao ficticia' };

test('[SBN-1] DNC localizado DEPOIS da primeira página bloqueia a criação — igual ao modo arquivo; nada é criado', async (t) => {
  const falso = comCorte();
  const erroSupabase = await erroDe(() => servicoSobre(supabaseCom(falso)).createRecord(admin(), { empresa: 'Outra Grafia', site: BLOQUEADA.site }, OPCOES));
  const erroArquivo = await erroDe(() => servicoSobre(repositorioDeArquivo(t)).createRecord(admin(), { empresa: 'Outra Grafia', site: BLOQUEADA.site }, OPCOES));
  assert.match(erroSupabase.message, /identidade já bloqueada como DO_NOT_CONTACT/);
  assert.equal(erroSupabase.message, erroArquivo.message, 'a mesma decisão e a mesma mensagem do modo arquivo');
  assert.equal(falso.tabela.size, 1100, 'nenhum registro foi criado');
});

test('[SBN-2] DUPLICIDADE localizada depois da primeira página bloqueia a criação e a edição de identidade — igual ao modo arquivo', async (t) => {
  const falso = comCorte();
  const servico = servicoSobre(supabaseCom(falso));
  const criar = await erroDe(() => servico.createRecord(admin(), { empresa: 'Outra Grafia', site: DUPLICADA.site }, OPCOES));
  const criarArquivo = await erroDe(() => servicoSobre(repositorioDeArquivo(t)).createRecord(admin(), { empresa: 'Outra Grafia', site: DUPLICADA.site }, OPCOES));
  assert.match(criar.message, /já existe um registro com a mesma identidade/);
  assert.equal(criar.message, criarArquivo.message);
  // editar o site de um registro da PRIMEIRA página para o de um registro bloqueado/duplicado da SEGUNDA também é recusado
  const editarDnc = await erroDe(() => servico.updateRecord(admin(), idDe(1), { site: BLOQUEADA.site }));
  assert.match(editarDnc.message, /registro bloqueado como DO_NOT_CONTACT/);
  const editarDup = await erroDe(() => servico.updateRecord(admin(), idDe(2), { site: DUPLICADA.site }));
  assert.match(editarDup.message, /coincide com a de outro registro/);
  assert.equal(falso.tabela.size, 1100);
  assert.equal(falso.linhas()[0].site, 'enchimento-1.example.test', 'o registro editado não mudou');
});

test('[SBN-3] a INGESTÃO enxerga o DNC fora da primeira página (a primeira barreira, antes da fila)', async () => {
  const lista = await servicoSobre(supabaseCom(comCorte())).listRecords(admin());
  const resultado = descoberta(achado(BLOQUEADA.empresa, 'bloqueada-exemplo'), lista);
  assert.equal(resultado.statusDNC, 'BLOQUEADO');
});

test('[SBN-4] PROMOÇÃO real preserva a barreira DNC: um lead aprovado cuja identidade está bloqueada fora da primeira página NÃO é promovido', async (t) => {
  const falso = comCorte();
  const env = novoAmbiente(t, { a: { finding: achado(BLOQUEADA.empresa, 'bloqueada-exemplo') } }, { crm: servicoSobre(supabaseCom(falso)) });
  aprovar(env, 'a');
  const erro = await erroDe(() => env.integracao.promoteProspect(admin(), env.ids.a));
  assert.match(erro.message, /já está bloqueada como DO_NOT_CONTACT no CRM/);
  assert.equal(falso.tabela.size, 1100, 'nenhum registro criado no CRM');
  assert.equal(falso.chamadas.filter((c) => c.metodo === 'POST').length, 0, 'nenhuma escrita no CRM');
});

test('[SBN-5] RECONCILIAÇÃO e idempotência: o registro criado por uma promoção interrompida, FORA da primeira página, é encontrado — não se cria um segundo', async (t) => {
  const falso = postgrestCrm({ linhas: enchimento(1100), maxRows: 1000 });
  const env = novoAmbiente(t, { a: { finding: achado('Clinica Nova Exemplo', 'nova-exemplo') } }, { crm: servicoSobre(supabaseCom(falso)) });
  aprovar(env, 'a');
  const filaAntes = env.textoDaFila();
  const primeira = await env.integracao.promoteProspect(admin(), env.ids.a);
  assert.equal(primeira.outcome, 'CRIADO');
  assert.equal(falso.tabela.size, 1101, 'o novo é o 1101º: antes estava além do corte');
  fs.writeFileSync(env.queuePath, filaAntes); // "o CRM foi gravado, mas a fila não"
  const segunda = await env.integracao.promoteProspect(admin(), env.ids.a);
  assert.equal(segunda.outcome, 'RECONCILIADO');
  assert.equal(falso.tabela.size, 1101, 'nenhum segundo registro');
  assert.equal(segunda.crmRecordId, primeira.crmRecordId);
});

test('[SBN-6] FALHA de leitura impede a criação: se uma página falha no meio da promoção, nada é gravado (CRM e fila intactos) — e repetir depois funciona', async (t) => {
  let quebrar = true;
  const falso = postgrestCrm({ linhas: enchimento(1100), maxRows: 1000, aoResponder: (n, init) => (quebrar && init.method === 'GET' && n === 2 ? { ok: false, status: 500, headers: { get: () => null }, text: async () => '{"message":"detalhe interno"}' } : null) });
  const env = novoAmbiente(t, { a: { finding: achado('Clinica Nova Exemplo', 'nova-exemplo') } }, { crm: servicoSobre(supabaseCom(falso)) });
  aprovar(env, 'a');
  const filaAntes = env.textoDaFila();
  const erro = await erroDe(() => env.integracao.promoteProspect(admin(), env.ids.a));
  assert.match(erro.message, /HTTP 500/);
  assert.equal(erro.message.includes('detalhe interno'), false);
  assert.equal(falso.tabela.size, 1100, 'nada criado no CRM');
  assert.equal(env.textoDaFila(), filaAntes, 'a fila não foi tocada');
  quebrar = false;
  assert.equal((await env.integracao.promoteProspect(admin(), env.ids.a)).outcome, 'CRIADO');
  assert.equal(falso.tabela.size, 1101);
});

test('[SBN-7] a criação direta também falha sem gravar: leitura incompleta = nenhuma escrita, nunca "CRM vazio"', async () => {
  const falso = postgrestCrm({ linhas: enchimento(1100), maxRows: 1000, aoResponder: (n) => (n === 2 ? { ok: true, status: 200, headers: { get: () => '*/1100' }, text: async () => '[]' } : null) });
  const erro = await erroDe(() => servicoSobre(supabaseCom(falso)).createRecord(admin(), { empresa: 'Qualquer Empresa Fictícia', site: 'qualquer.example.test' }, OPCOES));
  assert.match(erro.message, /não pôde ser lida por completo/);
  assert.equal(falso.chamadas.filter((c) => c.metodo === 'POST').length, 0);
});

test('[SBN-8] a CONTAGEM DE USO dos catálogos enxerga todos os registros (o que está na 2ª página conta) — e uma leitura incompleta falha em vez de contar 0', async () => {
  const item = { nome: 'Estética', nomeNormalizado: 'estetica' };
  assert.equal(await createCrmCatalogUsageCounter({ crmRepository: supabaseCom(comCorte()) })('nichos', item), 1);
  const quebrado = postgrestCrm({ linhas: cenario(), maxRows: 1000, aoResponder: (n) => (n === 3 ? { ok: false, status: 500, headers: { get: () => null }, text: async () => '' } : null) });
  await assert.rejects(() => createCrmCatalogUsageCounter({ crmRepository: supabaseCom(quebrado) })('nichos', item), /HTTP 500/);
});

test('[SBN-9] o EXPORT inclui o conjunto completo (1.100, não 1.000) ou falha explicitamente — e uma falha não deixa arquivo parcial', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h32-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const completo = await exportarCrm({ repository: supabaseCom(comCorte()), outDir: dir });
  const arquivo = JSON.parse(fs.readFileSync(completo.arquivo, 'utf8'));
  assert.deepEqual([completo.recordCount, arquivo.recordCount, arquivo.records.length], [1100, 1100, 1100]);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'h32-export2-'));
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  const quebrado = postgrestCrm({ linhas: cenario(), maxRows: 1000, aoResponder: (n) => (n === 2 ? { ok: false, status: 500, headers: { get: () => null }, text: async () => '' } : null) });
  await assert.rejects(() => exportarCrm({ repository: supabaseCom(quebrado), outDir: dir2 }), /HTTP 500/);
  assert.deepEqual(fs.existsSync(dir2) ? fs.readdirSync(dir2) : [], [], 'nenhum arquivo parcial');
});

function requisicao(env, usuario, method, url) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = { authorization: `Bearer ${env.tokenFor(usuario.userId)}` };
  return req;
}

test('[SBN-10] GET /api/crm devolve os 1.100 registros (nunca uma lista truncada como se fosse completa); com uma leitura incompleta responde o ERRO GENÉRICO de sempre, sem a lista e sem detalhe', async (t) => {
  const ok = montarAmbiente(t, { crmService: servicoSobre(supabaseCom(comCorte())) });
  const r = await ok.app.handle(requisicao(ok, BRENO, 'GET', '/api/crm'));
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).items.length, 1100);

  const quebrado = postgrestCrm({ linhas: cenario(), maxRows: 1000, aoResponder: (n) => (n === 2 ? { ok: false, status: 500, headers: { get: () => null }, text: async () => '{"message":"SEGREDO-INTERNO"}' } : null) });
  const env2 = montarAmbiente(t, { crmService: servicoSobre(supabaseCom(quebrado)) });
  const e = await env2.app.handle(requisicao(env2, BRENO, 'GET', '/api/crm'));
  assert.equal(e.status, 500);
  assert.deepEqual(JSON.parse(e.body).error.message, 'Erro interno. Tente novamente em instantes.');
  assert.equal(e.body.includes('SEGREDO-INTERNO'), false);
  assert.equal(e.body.includes('items'), false, 'nenhuma lista parcial');
});

test('[SBN-11] MODO ARQUIVO inalterado: o repositório de arquivo devolve tudo, na ordem, e as mesmas decisões de negócio valem (a listagem segura só mudou o adapter Supabase)', async (t) => {
  const arquivo = repositorioDeArquivo(t);
  const lidos = arquivo.list();
  assert.equal(lidos.length, 1100);
  const supabase = await supabaseCom(comCorte()).list();
  assert.deepEqual(supabase.map((r) => r.id), lidos.map((r) => r.id), 'a mesma ordem pública');
  assert.deepEqual(supabase.map((r) => r.empresa), lidos.map((r) => r.empresa));
  const arquivoBloqueia = await erroDe(() => servicoSobre(arquivo).createRecord(admin(), { empresa: 'X', site: BLOQUEADA.site }, OPCOES));
  assert.match(arquivoBloqueia.message, /DO_NOT_CONTACT/);
});
