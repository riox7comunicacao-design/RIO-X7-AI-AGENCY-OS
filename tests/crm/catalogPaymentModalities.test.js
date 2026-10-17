// Modalidades de pagamento dos Serviços (CRM 5.0, Fase C1 — decisão 0027), do ponto de vista do NEGÓCIO: serviço legado sem informação nunca é
// inferido nem apagado; os cinco serviços já cadastrados continuam idênticos; o preço de referência é só informativo e não se mistura com nada
// comercial; e o que o Service devolve a cada papel. Peças REAIS (domínio, repositório em arquivo temporário e em memória, Service com autorização
// real); nenhuma rede, nenhum dado de data/. As regras de validação campo a campo estão em catalogDomain.test.js (CATDOM-5/18); a paridade com o
// banco, em tests/db/crmServicesPaymentModalitiesMigration.test.js; os dois adapters passam pelo mesmo contrato em catalogRepositoryContract.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const domain = require('../../src/crm/catalogDomain');
const { createInMemoryCatalogRepository, createJsonFileCatalogRepository } = require('../../src/crm/catalogRepository');
const { createCatalogService } = require('../../src/services/catalogService');
const { authorizeCatalogOperation } = require('../../src/auth');
const { CATALOG_DEFINITIONS, PAYMENT_MODALITY_FIELDS } = require('../../src/crm/catalogConstants');
const { admin, closer } = require('../helpers/promotionFixtures');

const REPO_ROOT = path.join(__dirname, '..', '..');
const OP = Object.freeze({ userId: 'user-admin', name: 'Admin Teste' });
const T = '2026-09-01T10:00:00.000Z';
const sha = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

// Os "cinco serviços já cadastrados" do proprietário, no formato ANTIGO (só tipoCobranca/recorrencia, sem as modalidades). Nomes e preços fictícios.
const legado = (n, extras) => ({
  id: `service:00000000-0000-4000-8000-00000000000${n}`, nome: `Serviço legado ${n}`, nomeNormalizado: `servico legado ${n}`, descricao: n === 1 ? 'Descrição antiga' : null,
  ativo: n !== 4, ordem: n - 1, categoria: n === 1 ? 'Marketing' : null, precoReferencia: null, tipoCobranca: null, recorrencia: null,
  criadoEm: T, atualizadoEm: T, criadoPorUserId: 'user-antigo', criadoPorNome: 'Quem criou', atualizadoPorUserId: 'user-antigo', atualizadoPorNome: 'Quem criou', ...extras,
});
const CINCO = () => [
  legado(1, { precoReferencia: 1500, tipoCobranca: 'RECORRENTE', recorrencia: 'MENSAL' }),
  legado(2, { precoReferencia: 4800.5, tipoCobranca: 'UNICA' }),
  legado(3, { tipoCobranca: 'RECORRENTE', recorrencia: 'ANUAL' }),
  legado(4, { precoReferencia: 900 }), // desativado, sem tipoCobranca
  legado(5),
];

function arquivoComOsCinco(t) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-c1-'));
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }));
  const caminho = path.join(pasta, 'crm-catalogs.json');
  const servicos = Object.fromEntries(CINCO().map((item) => [item.id, item]));
  fs.writeFileSync(caminho, JSON.stringify({ version: 1, servicos, nichos: {}, origens: {} }, null, 2));
  return caminho;
}

test('[CATMOD-1] os cinco serviços LEGADOS (sem modalidades) continuam legíveis e idênticos: nada é inferido do tipo antigo, nada é gravado só por ler, e o arquivo não muda um byte', async (t) => {
  const caminho = arquivoComOsCinco(t);
  const antes = sha(fs.readFileSync(caminho, 'utf8'));
  const repo = createJsonFileCatalogRepository(caminho);
  const lidos = await domain.listItems(repo, 'servicos', { includeInactive: true });
  assert.equal(lidos.length, 5);
  assert.deepEqual(lidos.map((i) => [i.id.slice(-1), i.nome, i.precoReferencia, i.ativo, i.ordem]), [['1', 'Serviço legado 1', 1500, true, 0], ['2', 'Serviço legado 2', 4800.5, true, 1], ['3', 'Serviço legado 3', null, true, 2], ['4', 'Serviço legado 4', 900, false, 3], ['5', 'Serviço legado 5', null, true, 4]]);
  for (const item of lidos) assert.deepEqual([item.permitePagamentoUnico, item.permitePagamentoRecorrente, item.periodicidades], [false, false, []], `${item.nome}: nenhuma modalidade inferida do legado`);
  assert.deepEqual(lidos.map((i) => [i.tipoCobranca, i.recorrencia]), [['RECORRENTE', 'MENSAL'], ['UNICA', null], ['RECORRENTE', 'ANUAL'], [null, null], [null, null]], 'o legado continua à vista (só leitura)');
  const um = await domain.getItem(repo, 'servicos', lidos[0].id);
  assert.deepEqual(um, lidos[0]);
  assert.equal(sha(fs.readFileSync(caminho, 'utf8')), antes, 'ler não grava');
});

test('[CATMOD-2] EDITAR um serviço legado: nome, descrição, categoria e preço seguem editáveis SEM obrigar a escolher modalidade; o legado e as modalidades não enviadas ficam como estão; o ADMIN completa quando quiser', async (t) => {
  const caminho = arquivoComOsCinco(t);
  const repo = createJsonFileCatalogRepository(caminho);
  const id = (n) => legado(n).id;
  // 1) edição comum: preço e nome — nenhuma modalidade aparece, o tipo antigo fica
  const editado = await domain.updateItem(repo, 'servicos', id(1), { nome: 'Gestão de redes', precoReferencia: 1800 }, OP);
  assert.deepEqual([editado.nome, editado.precoReferencia, editado.tipoCobranca, editado.recorrencia], ['Gestão de redes', 1800, 'RECORRENTE', 'MENSAL']);
  assert.deepEqual([editado.permitePagamentoUnico, editado.permitePagamentoRecorrente, editado.periodicidades], [false, false, []], 'não gerou modalidade a partir do tipo antigo');
  // 2) o campo legado NUNCA é gravável: uma aba antiga recebe erro claro e nada muda
  for (const patch of [{ tipoCobranca: 'UNICA' }, { recorrencia: 'MENSAL' }, { tipoCobranca: null, recorrencia: null }]) {
    await assert.rejects(() => domain.updateItem(repo, 'servicos', id(1), { ...patch, nome: 'Outro' }, OP), (e) => e.code === 'CRM_CATALOG_INVALID_INPUT' && e.details.errors.every((x) => x.code === 'CAMPO_NAO_EDITAVEL'));
  }
  assert.equal((await domain.getItem(repo, 'servicos', id(1))).nome, 'Gestão de redes', 'a recusa não gravou o resto do patch');
  // 3) enviar "nenhuma" para quem nunca teve é uma não-mudança permitida (o legado pode seguir sem modalidade)
  const mesmo = await domain.updateItem(repo, 'servicos', id(5), { permitePagamentoUnico: false, permitePagamentoRecorrente: false, periodicidades: [] }, OP);
  assert.deepEqual([mesmo.permitePagamentoUnico, mesmo.permitePagamentoRecorrente, mesmo.periodicidades], [false, false, []]);
  // 4) o ADMIN completa: único + recorrente (mensal, anual) — e o preço e o tipo antigo continuam como estavam
  const completo = await domain.updateItem(repo, 'servicos', id(2), { permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['ANUAL', 'MENSAL'] }, OP);
  assert.deepEqual([completo.permitePagamentoUnico, completo.permitePagamentoRecorrente, completo.periodicidades, completo.precoReferencia, completo.tipoCobranca], [true, true, ['MENSAL', 'ANUAL'], 4800.5, 'UNICA']);
  // 5) depois de completo, não pode ficar sem nenhuma
  await assert.rejects(() => domain.updateItem(repo, 'servicos', id(2), { permitePagamentoUnico: false, permitePagamentoRecorrente: false, periodicidades: [] }, OP), (e) => e.details.errors.some((x) => x.code === 'MODALIDADE_OBRIGATORIA'));
  // 6) os outros serviços não foram tocados por nada disso
  const tres = await domain.getItem(repo, 'servicos', id(3));
  assert.deepEqual([tres.nome, tres.tipoCobranca, tres.recorrencia, tres.permitePagamentoRecorrente, tres.periodicidades], ['Serviço legado 3', 'RECORRENTE', 'ANUAL', false, []]);
  // desativar/reativar um legado também devolve os padrões (falso, falso, lista vazia) — o mesmo formato da leitura
  const desativado = await domain.setItemActive(repo, 'servicos', id(3), false, OP);
  assert.deepEqual([desativado.ativo, desativado.permitePagamentoUnico, desativado.permitePagamentoRecorrente, desativado.periodicidades, desativado.tipoCobranca], [false, false, false, [], 'RECORRENTE']);
  const quatro = await domain.getItem(repo, 'servicos', id(4));
  assert.deepEqual([quatro.ativo, quatro.precoReferencia, quatro.ordem], [false, 900, 3]);
});

test('[CATMOD-3] um serviço NOVO nasce só com o que foi enviado: sem tipo/recorrência legados; cada combinação permitida é gravada e lida igual; sem modalidade é recusado', async () => {
  const repo = createInMemoryCatalogRepository();
  const casos = [
    ['só único', { permitePagamentoUnico: true }, [true, false, []]],
    ['só recorrente, uma periodicidade', { permitePagamentoRecorrente: true, periodicidades: ['MENSAL'] }, [false, true, ['MENSAL']]],
    ['só recorrente, várias', { permitePagamentoRecorrente: true, periodicidades: ['ANUAL', 'TRIMESTRAL', 'MENSAL', 'SEMESTRAL'] }, [false, true, ['MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL']]],
    ['os dois', { permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['SEMESTRAL'] }, [true, true, ['SEMESTRAL']]],
  ];
  for (const [rotulo, entrada, esperado] of casos) {
    const criado = await domain.createItem(repo, 'servicos', { nome: rotulo, ...entrada }, OP);
    assert.deepEqual([criado.permitePagamentoUnico, criado.permitePagamentoRecorrente, criado.periodicidades], esperado, rotulo);
    assert.deepEqual([criado.tipoCobranca ?? null, criado.recorrencia ?? null], [null, null], `${rotulo}: o legado não é gravado`);
    assert.deepEqual(await domain.getItem(repo, 'servicos', criado.id), criado, `${rotulo}: lido igual ao gravado`);
  }
  await assert.rejects(() => domain.createItem(repo, 'servicos', { nome: 'Sem modalidade' }, OP), (e) => e.details.errors.some((x) => x.path === 'modalidades' && x.code === 'MODALIDADE_OBRIGATORIA'));
  assert.equal((await domain.listItems(repo, 'servicos', { includeInactive: true })).length, 4, 'a recusa não gravou nada');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// o preço de referência é só informativo e não se mistura com nada comercial
// ---------------------------------------------------------------------------------------------------------------------------------

test('[CATMOD-4] PREÇO x MODALIDADES: são independentes — mudar um nunca mexe no outro; o preço não vira TCV, MRR nem valor de proposta; nenhum campo comercial existe no catálogo', async () => {
  const repo = createInMemoryCatalogRepository();
  const s = await domain.createItem(repo, 'servicos', { nome: 'Site', precoReferencia: 2500, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL'] }, OP);
  const soModalidade = await domain.updateItem(repo, 'servicos', s.id, { periodicidades: ['MENSAL', 'ANUAL'] }, OP);
  assert.equal(soModalidade.precoReferencia, 2500, 'trocar a periodicidade não recalcula o preço');
  const soPreco = await domain.updateItem(repo, 'servicos', s.id, { precoReferencia: 3000 }, OP);
  assert.deepEqual([soPreco.permitePagamentoUnico, soPreco.permitePagamentoRecorrente, soPreco.periodicidades], [true, true, ['MENSAL', 'ANUAL']]);
  const semPreco = await domain.updateItem(repo, 'servicos', s.id, { precoReferencia: null }, OP);
  assert.deepEqual([semPreco.precoReferencia, semPreco.periodicidades], [null, ['MENSAL', 'ANUAL']], 'o preço é opcional: sem ele, as modalidades valem do mesmo jeito');
  // os campos do catálogo de serviços: nada de valor, TCV, MRR, prazo ou desconto
  const campos = [...CATALOG_DEFINITIONS.servicos.specificFields, ...CATALOG_DEFINITIONS.servicos.legacyFields];
  assert.deepEqual(campos, ['categoria', 'precoReferencia', ...PAYMENT_MODALITY_FIELDS, 'tipoCobranca', 'recorrencia']);
  assert.equal(campos.some((c) => /valor|tcv|mrr|prazo|desconto|parcela|total|receb/i.test(c)), false);
  assert.equal(Object.keys(s).some((c) => /valor|tcv|mrr|prazo|desconto|parcela|total|receb/i.test(c)), false, 'e o item gravado também não');
});

test('[CATMOD-5] ISOLAMENTO ESTÁTICO: o código dos catálogos nunca lê nem grava os campos comerciais do CRM (valorProposta, valorTotal…), e o CRM nunca lê o preço nem as modalidades do catálogo', () => {
  const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const lerCodigo = (arquivo) => semComentarios(fs.readFileSync(path.join(REPO_ROOT, arquivo), 'utf8'));
  const arquivosDoCatalogo = ['src/crm/catalogConstants.js', 'src/crm/catalogDomain.js', 'src/crm/catalogRepository.js', 'src/crm/catalogRepositoryPort.js', 'src/services/catalogService.js', 'src/crm-adapters/crmSupabaseCatalogRepository.js', 'dashboard/catalog-model.mjs', 'dashboard/views/catalogForm.mjs', 'dashboard/views/catalogs.mjs'];
  for (const arquivo of arquivosDoCatalogo) {
    const codigo = lerCodigo(arquivo);
    assert.doesNotMatch(codigo, /valorProposta|valorTotal|valor_proposta|valor_total|\bTCV\b|\bMRR\b|valorRecebido|prazoContratado|prazo_contratado/, `${arquivo} não pode tocar em campos comerciais`);
  }
  // o CRM (domínio, repositórios, adapter e ponte) não usa o preço nem as modalidades do catálogo
  for (const arquivo of ['src/crm/crmDomain.js', 'src/crm/crmRepository.js', 'src/crm/constants.js', 'src/crm-adapters/crmSupabaseRepository.js', 'src/crm-adapters/crmSupabaseMapping.js']) {
    const codigo = lerCodigo(arquivo);
    assert.doesNotMatch(codigo, /precoReferencia|preco_referencia|permitePagamento|permite_pagamento|periodicidades|tipoCobranca|tipo_cobranca/, `${arquivo} não usa dados do catálogo de serviços`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// o que o Service devolve a cada papel
// ---------------------------------------------------------------------------------------------------------------------------------

test('[CATMOD-6] o Service devolve as modalidades (e o legado, só leitura) a quem lê e o gerente grava; um papel sem permissão de administrar não grava; sem modalidade num cadastro novo é recusado com o caminho certo', async () => {
  const repository = createInMemoryCatalogRepository();
  const service = createCatalogService({ authorizeOperation: authorizeCatalogOperation, repository, countUsage: async () => 0, now: () => new Date(T) });
  const criado = await service.create(admin(), 'servicos', { nome: 'Consultoria', precoReferencia: 700, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['TRIMESTRAL', 'MENSAL'] });
  assert.deepEqual([criado.permitePagamentoUnico, criado.permitePagamentoRecorrente, criado.periodicidades, criado.tipoCobranca, criado.recorrencia], [true, true, ['MENSAL', 'TRIMESTRAL'], null, null]);
  const lidoPorQuemLe = await service.list(closer(), 'servicos');
  assert.deepEqual(lidoPorQuemLe.map((i) => [i.nome, i.permitePagamentoUnico, i.permitePagamentoRecorrente, i.periodicidades]), [['Consultoria', true, true, ['MENSAL', 'TRIMESTRAL']]]);
  await assert.rejects(() => service.update(closer(), 'servicos', criado.id, { permitePagamentoUnico: false }), (e) => /FORBIDDEN|permiss/i.test(`${e.code} ${e.message}`));
  assert.deepEqual((await service.get(admin(), 'servicos', criado.id)).periodicidades, ['MENSAL', 'TRIMESTRAL'], 'a tentativa sem permissão não mudou nada');
  const erro = await service.create(admin(), 'servicos', { nome: 'Sem forma de pagamento' }).catch((e) => e);
  assert.equal(erro.code, 'CRM_CATALOG_INVALID_INPUT');
  assert.deepEqual(erro.details.errors, [{ path: 'modalidades', code: 'MODALIDADE_OBRIGATORIA' }]);
});
