// Domínio dos CATÁLOGOS do CRM (src/crm/catalogDomain.js — CRM 5.0, Fase 2B-1): normalização, validação rigorosa, unicidade (inclusive de
// itens desativados e sob concorrência), atualização segura, trava de renomeação, ativação/desativação, reordenação e falhas de
// armazenamento. Só o adapter de MEMÓRIA — nenhum arquivo, nenhuma rede. Caracteres de controle são montados por código (String.fromCharCode)
// para o arquivo de teste nunca conter um caractere invisível.

const test = require('node:test');
const assert = require('node:assert/strict');

const domain = require('../../src/crm/catalogDomain');
const { CatalogError, normalizeCatalogName, validateCreateInput, validatePatch } = domain;
const { createInMemoryCatalogRepository } = require('../../src/crm/catalogRepository');
const { CATALOG_ERROR, CATALOG_KEYS, NICHE_COLOR_KEYS } = require('../../src/crm/catalogConstants');

const OP = Object.freeze({ userId: 'user-admin', name: 'Admin Teste' });
const OP2 = Object.freeze({ userId: 'user-outro', name: 'Outro Admin' });
const T0 = new Date('2026-10-12T12:00:00.000Z');
const T1 = new Date('2026-10-12T12:30:00.000Z');
const clockAt = (date) => ({ now: () => date });

const ZERO = String.fromCharCode(0);
const ZERO_WIDTH = String.fromCharCode(0x200b);
const BIDI = String.fromCharCode(0x202e);
const TAB = String.fromCharCode(9);

async function erroDe(task) {
  try {
    await task();
  } catch (error) {
    return error;
  }
  throw new Error('esperava uma falha e não houve');
}
const errorsOf = (error) => (error.details && error.details.errors) || [];

// Um repositório que CONTA as chamadas (para provar "não grava nada" e "não consulta duas vezes").
function spyRepository() {
  const base = createInMemoryCatalogRepository();
  const calls = { insert: 0, update: 0, reorder: 0, list: 0, getById: 0 };
  const repo = {
    list: (catalog) => (calls.list++, base.list(catalog)),
    getById: (catalog, id) => (calls.getById++, base.getById(catalog, id)),
    insert: (catalog, item) => (calls.insert++, base.insert(catalog, item)),
    update: (catalog, id, patch) => (calls.update++, base.update(catalog, id, patch)),
    reorder: (catalog, ids, meta) => (calls.reorder++, base.reorder(catalog, ids, meta)),
  };
  return { repo, calls, base };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------------------------------------------------------------
test('[CATDOM-1] normalizeCatalogName: minúsculas, sem acento, pontuação vira espaço, espaços colapsados; só letras e números latinos contam', () => {
  const casos = [
    ['Estética', 'estetica'],
    ['ESTÉTICA', 'estetica'],
    ['  Instituições   de  Ensino ', 'instituicoes de ensino'],
    ['Meta-Ads!', 'meta ads'],
    ['Ação & Reação', 'acao reacao'],
    ['Escritórios (contabilidade)', 'escritorios contabilidade'],
    ['Site 2.0', 'site 2 0'],
    ['C++', 'c'],
    ['!!!', ''],
    ['日本', ''],
    ['', ''],
  ];
  for (const [entrada, esperado] of casos) assert.equal(normalizeCatalogName(entrada), esperado, JSON.stringify(entrada));
  for (const naoTexto of [null, undefined, 12, {}, []]) assert.equal(normalizeCatalogName(naoTexto), '');
  // idempotente, e nunca produz espaços nas pontas nem repetidos
  for (const [, saida] of casos) assert.equal(normalizeCatalogName(saida), saida);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------------------------------------------------------------
test('[CATDOM-2] NOME: obrigatório; espaços das pontas saem e os internos colapsam; até 80 caracteres (pontos de código); caractere de controle, invisível ou de direção é recusado', () => {
  const ok = validateCreateInput('nichos', { nome: '  Nicho   de   Teste  ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.nome, 'Nicho de Teste');

  for (const [valor, codigo] of [
    [undefined, 'OBRIGATORIO'],
    [null, 'OBRIGATORIO'],
    ['', 'OBRIGATORIO'],
    ['   ', 'OBRIGATORIO'],
    [12, 'TIPO_INVALIDO'],
    [{}, 'TIPO_INVALIDO'],
    [['a'], 'TIPO_INVALIDO'],
    [`Nome${ZERO}`, 'CARACTERE_INVALIDO'],
    [`Nome${ZERO_WIDTH}`, 'CARACTERE_INVALIDO'],
    [`Nome${BIDI}`, 'CARACTERE_INVALIDO'],
    ['a'.repeat(81), 'MUITO_LONGO'],
    ['!!!', 'NOME_SEM_LETRAS'],
    ['日本語', 'NOME_SEM_LETRAS'],
  ]) {
    const entrada = valor === undefined ? {} : { nome: valor };
    const resultado = validateCreateInput('nichos', entrada);
    assert.equal(resultado.ok, false, JSON.stringify(valor));
    assert.deepEqual(resultado.errors, [{ path: 'nome', code: codigo }], JSON.stringify(valor));
  }
  assert.equal(validateCreateInput('nichos', { nome: 'a'.repeat(80) }).ok, true, '80 é o limite, e cabe');
  // o limite é em pontos de código: 80 emojis cabem (nome só de emoji falha por outro motivo, então misturamos com letras)
  assert.equal(validateCreateInput('nichos', { nome: `${'ação'.repeat(20)}` }).ok, true, '80 letras acentuadas cabem');
  assert.equal(validateCreateInput('nichos', { nome: `${'ação'.repeat(20)}x` }).ok, false, '81 não cabe');
  // tabulação e quebra de linha no meio do nome viram um espaço
  assert.equal(validateCreateInput('nichos', { nome: `Um${TAB}Dois\nTrês` }).value.nome, 'Um Dois Três');
});

test('[CATDOM-3] DESCRIÇÃO: opcional (vazia vira null); aceita quebra de linha e tabulação; recusa controle; até 500; não é texto -> erro', () => {
  assert.equal(validateCreateInput('nichos', { nome: 'A' }).value.descricao, null);
  assert.equal(validateCreateInput('nichos', { nome: 'A', descricao: '   ' }).value.descricao, null);
  assert.equal(validateCreateInput('nichos', { nome: 'A', descricao: null }).value.descricao, null);
  assert.equal(validateCreateInput('nichos', { nome: 'A', descricao: '  linha 1\r\nlinha 2\n\tlinha 3  ' }).value.descricao, 'linha 1\nlinha 2\n\tlinha 3');
  assert.equal(validateCreateInput('nichos', { nome: 'A', descricao: 'x'.repeat(500) }).ok, true);
  for (const [valor, codigo] of [['x'.repeat(501), 'MUITO_LONGO'], [`a${ZERO}b`, 'CARACTERE_INVALIDO'], [`a${BIDI}b`, 'CARACTERE_INVALIDO'], [5, 'TIPO_INVALIDO'], [true, 'TIPO_INVALIDO']]) {
    assert.deepEqual(validateCreateInput('nichos', { nome: 'A', descricao: valor }).errors, [{ path: 'descricao', code: codigo }], JSON.stringify(valor));
  }
});

test('[CATDOM-4] campos desconhecidos, de OUTRO catálogo ou que só o domínio define são recusados, cada um com o seu código — e os caminhos nunca ecoam o que foi enviado', () => {
  const erros = validateCreateInput('nichos', { nome: 'A', ativo: true, ordem: 3, id: 'x', criadoEm: 'x', nomeNormalizado: 'a', atualizadoPorNome: 'x', categoria: 'x', canal: 'OUTRO', invasor: 1 }).errors;
  assert.deepEqual(
    erros.map((e) => `${e.path}:${e.code}`).sort(),
    ['ativo:CAMPO_NAO_EDITAVEL', 'atualizadoPorNome:CAMPO_NAO_EDITAVEL', 'canal:CAMPO_DESCONHECIDO', 'categoria:CAMPO_DESCONHECIDO', 'criadoEm:CAMPO_NAO_EDITAVEL', 'id:CAMPO_NAO_EDITAVEL', 'invasor:CAMPO_DESCONHECIDO', 'nomeNormalizado:CAMPO_NAO_EDITAVEL', 'ordem:CAMPO_NAO_EDITAVEL']
  );
  // um nome de campo esquisito não vira "caminho": fica vazio
  const esquisito = validateCreateInput('nichos', { nome: 'A', ['<script>alert(1)</script>']: 1 }).errors;
  assert.deepEqual(esquisito, [{ path: '', code: 'CAMPO_DESCONHECIDO' }]);
  // o corpo não é um objeto simples
  for (const naoObjeto of [null, undefined, 'texto', 12, [], new Map(), new (class X {})()]) {
    assert.deepEqual(validateCreateInput('nichos', naoObjeto).errors, [{ path: '', code: 'TIPO_INVALIDO' }], String(naoObjeto));
  }
  // "__proto__" como chave própria (o que um JSON.parse produz) é só mais um campo desconhecido — nunca troca o protótipo de nada
  const envenenado = JSON.parse('{"nome":"A","__proto__":{"ativo":false}}');
  assert.deepEqual(validateCreateInput('nichos', envenenado).errors, [{ path: '__proto__', code: 'CAMPO_DESCONHECIDO' }]);
  assert.equal(validateCreateInput('nichos', envenenado).ok, false);
  assert.equal(({}).ativo, undefined, 'o Object.prototype continua limpo');
});

test('[CATDOM-5] SERVIÇO: categoria (até 60); preço de referência (número >= 0, até 2 casas, até o teto); modalidades de pagamento coerentes (Fase C1: o mínimo é o nome e UMA modalidade)', () => {
  const base = { nome: 'Gestão de redes', permitePagamentoUnico: true };
  const bom = validateCreateInput('servicos', { ...base, categoria: '  Social  media ', precoReferencia: 1500.5, permitePagamentoRecorrente: true, periodicidades: ['TRIMESTRAL', 'MENSAL'] });
  assert.equal(bom.ok, true);
  assert.deepEqual(bom.value, { nome: 'Gestão de redes', descricao: null, categoria: 'Social media', precoReferencia: 1500.5, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'] }, 'as periodicidades saem na ordem canônica');
  // o mínimo de um cadastro novo: o nome e uma modalidade; o resto é opcional e a ausência de uma permissão é "não permitido"
  assert.deepEqual(validateCreateInput('servicos', base).value, { nome: 'Gestão de redes', descricao: null, categoria: null, precoReferencia: null, permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [] });

  assert.equal(validateCreateInput('servicos', { ...base, categoria: 'x'.repeat(61) }).errors[0].code, 'MUITO_LONGO');
  const preco = (valor) => validateCreateInput('servicos', { ...base, precoReferencia: valor });
  for (const aceito of [0, 0.01, 19.99, 1500, 1e9]) assert.equal(preco(aceito).ok, true, String(aceito));
  assert.equal(preco(0.1 + 0.2).value.precoReferencia, 0.3, 'a imprecisão do ponto flutuante (0.30000000000000004) vira o valor em centavos');
  assert.ok(Object.is(preco(-0).value.precoReferencia, 0), '-0 vira 0');
  assert.equal(preco(19.99).value.precoReferencia, 19.99);
  for (const [recusado, codigo] of [[-0.01, 'VALOR_FORA_DO_LIMITE'], [1e9 + 0.01, 'VALOR_FORA_DO_LIMITE'], [1e12, 'VALOR_FORA_DO_LIMITE'], [10.005, 'MAIS_DE_DUAS_CASAS'], [1 / 3, 'MAIS_DE_DUAS_CASAS'], ['100', 'TIPO_INVALIDO'], [NaN, 'TIPO_INVALIDO'], [Infinity, 'TIPO_INVALIDO'], [true, 'TIPO_INVALIDO'], [{}, 'TIPO_INVALIDO']]) {
    assert.deepEqual(preco(recusado).errors, [{ path: 'precoReferencia', code: codigo }], String(recusado));
  }
  // listas fechadas e tipos
  assert.deepEqual(validateCreateInput('servicos', { ...base, permitePagamentoRecorrente: true, periodicidades: ['QUINZENAL'] }).errors, [{ path: 'periodicidades', code: 'VALOR_INVALIDO' }]);
  assert.deepEqual(validateCreateInput('servicos', { ...base, permitePagamentoRecorrente: true, periodicidades: ['mensal'] }).errors, [{ path: 'periodicidades', code: 'VALOR_INVALIDO' }], 'é sensível à caixa: é um código');
  assert.deepEqual(validateCreateInput('servicos', { ...base, periodicidades: 'MENSAL' }).errors, [{ path: 'periodicidades', code: 'TIPO_INVALIDO' }]);
  assert.deepEqual(validateCreateInput('servicos', { ...base, permitePagamentoUnico: 'sim' }).errors, [{ path: 'permitePagamentoUnico', code: 'TIPO_INVALIDO' }]);
  assert.deepEqual(validateCreateInput('servicos', { ...base, permitePagamentoRecorrente: null }).errors, [{ path: 'permitePagamentoRecorrente', code: 'TIPO_INVALIDO' }], 'null não vira false em silêncio');
  // os campos LEGADOS não são mais graváveis: uma aba antiga que os envie recebe um erro claro, nunca grava uma modalidade divergente
  assert.deepEqual(validateCreateInput('servicos', { ...base, tipoCobranca: 'UNICA' }).errors, [{ path: 'tipoCobranca', code: 'CAMPO_NAO_EDITAVEL' }]);
  assert.deepEqual(validateCreateInput('servicos', { ...base, recorrencia: 'MENSAL' }).errors, [{ path: 'recorrencia', code: 'CAMPO_NAO_EDITAVEL' }]);
  // coerência: recorrente exige periodicidade; sem recorrente não pode haver periodicidade; cadastro novo exige uma modalidade
  assert.deepEqual(validateCreateInput('servicos', { ...base, permitePagamentoRecorrente: true }).errors, [{ path: 'periodicidades', code: 'PERIODICIDADE_OBRIGATORIA' }]);
  assert.deepEqual(validateCreateInput('servicos', { ...base, periodicidades: ['MENSAL'] }).errors, [{ path: 'periodicidades', code: 'PERIODICIDADE_NAO_PERMITIDA' }]);
  assert.deepEqual(validateCreateInput('servicos', { nome: 'X' }).errors, [{ path: 'modalidades', code: 'MODALIDADE_OBRIGATORIA' }]);
  assert.deepEqual(validateCreateInput('servicos', { nome: 'X', permitePagamentoUnico: false, permitePagamentoRecorrente: false }).errors, [{ path: 'modalidades', code: 'MODALIDADE_OBRIGATORIA' }]);
  for (const periodicidade of ['MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL']) assert.equal(validateCreateInput('servicos', { nome: 'X', permitePagamentoRecorrente: true, periodicidades: [periodicidade] }).ok, true, periodicidade);
});

test('[CATDOM-6] NICHO: a cor é uma das 20 chaves da paleta (ou ausente); um valor de cor (hex, nome em maiúsculas, classe de CSS) é recusado — o que se guarda é só a CHAVE', () => {
  for (const chave of NICHE_COLOR_KEYS) assert.equal(validateCreateInput('nichos', { nome: `Nicho ${chave}`, cor: chave }).value.cor, chave);
  assert.equal(validateCreateInput('nichos', { nome: 'Sem cor' }).value.cor, null);
  assert.equal(validateCreateInput('nichos', { nome: 'Sem cor', cor: null }).value.cor, null);
  for (const invalida of ['#125bd9', 'AZUL', 'Azul', 'cor-azul', 'rosado', '', 'azul ', 'red', 'rgb(0,0,0)']) {
    assert.deepEqual(validateCreateInput('nichos', { nome: 'X', cor: invalida }).errors, [{ path: 'cor', code: 'VALOR_INVALIDO' }], JSON.stringify(invalida));
  }
  assert.deepEqual(validateCreateInput('nichos', { nome: 'X', cor: 5 }).errors, [{ path: 'cor', code: 'TIPO_INVALIDO' }]);
  // a cor só existe em nichos
  assert.deepEqual(validateCreateInput('servicos', { nome: 'X', cor: 'azul' }).errors, [{ path: 'cor', code: 'CAMPO_DESCONHECIDO' }]);
  assert.deepEqual(validateCreateInput('origens', { nome: 'X', cor: 'azul' }).errors, [{ path: 'cor', code: 'CAMPO_DESCONHECIDO' }]);
});

test('[CATDOM-7] ORIGEM: o canal de aquisição é uma das seis opções (ou ausente) e existe só em origens; o catálogo não tem nenhum campo de URL ou de integração', () => {
  for (const canal of ['PROSPECCAO_ATIVA', 'ANUNCIO_PAGO', 'INDICACAO', 'ORGANICO', 'PARCERIA', 'OUTRO']) assert.equal(validateCreateInput('origens', { nome: `Origem ${canal}`, canal }).value.canal, canal);
  assert.equal(validateCreateInput('origens', { nome: 'Sem canal' }).value.canal, null);
  assert.deepEqual(validateCreateInput('origens', { nome: 'X', canal: 'INSTAGRAM' }).errors, [{ path: 'canal', code: 'VALOR_INVALIDO' }]);
  assert.deepEqual(validateCreateInput('nichos', { nome: 'X', canal: 'OUTRO' }).errors, [{ path: 'canal', code: 'CAMPO_DESCONHECIDO' }]);
  // a origem COMERCIAL do lead não é a URL de fonte da prospecção: nenhum campo de URL, fonte ou integração é aceito
  for (const campo of ['url', 'fonte', 'origem', 'site', 'integracao', 'fontes']) {
    assert.deepEqual(validateCreateInput('origens', { nome: 'X', [campo]: 'https://exemplo.test' }).errors, [{ path: campo, code: 'CAMPO_DESCONHECIDO' }], campo);
  }
});

test('[CATDOM-8] as mensagens de erro nunca repetem o valor recusado: só caminho e código (a API devolve esta lista ao navegador)', async () => {
  const segredo = 'VALOR-SECRETO-NAO-PODE-VAZAR';
  const repo = createInMemoryCatalogRepository();
  const erro = await erroDe(() => domain.createItem(repo, 'nichos', { nome: segredo, cor: segredo, descricao: 5 }, OP));
  assert.equal(erro.code, CATALOG_ERROR.INVALID_INPUT);
  assert.equal(erro instanceof CatalogError, true);
  assert.doesNotMatch(JSON.stringify({ message: erro.message, details: erro.details }), /SECRETO/);
  assert.match(erro.message, /^Cadastro: dados inválidos \(/);
  for (const item of errorsOf(erro)) assert.deepEqual(Object.keys(item).sort(), ['code', 'path']);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------------------------------------------------------------
test('[CATDOM-9] createItem: id ESTÁVEL por catálogo (prefixo + UUID), ativo, ordem 0,1,2..., datas do relógio injetado, responsável do operador, específicos nulos por padrão — e o objeto de entrada não é alterado', async () => {
  const repo = createInMemoryCatalogRepository();
  const entrada = Object.freeze({ nome: '  Estética ', descricao: 'Clínicas', cor: 'azul' });
  const a = await domain.createItem(repo, 'nichos', entrada, OP, clockAt(T0));
  const b = await domain.createItem(repo, 'nichos', { nome: 'Psicologia' }, OP2, clockAt(T1));
  assert.match(a.id, /^niche:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(a, {
    id: a.id, nome: 'Estética', nomeNormalizado: 'estetica', descricao: 'Clínicas', ativo: true, ordem: 0, cor: 'azul',
    criadoEm: T0.toISOString(), atualizadoEm: T0.toISOString(), criadoPorUserId: 'user-admin', criadoPorNome: 'Admin Teste', atualizadoPorUserId: 'user-admin', atualizadoPorNome: 'Admin Teste',
  });
  assert.equal(b.ordem, 1);
  assert.equal(b.cor, null);
  assert.equal(b.criadoPorNome, 'Outro Admin');
  assert.deepEqual(entrada, { nome: '  Estética ', descricao: 'Clínicas', cor: 'azul' }, 'a entrada não foi tocada');

  const s = await domain.createItem(repo, 'servicos', { nome: 'Site', permitePagamentoUnico: true }, OP);
  const o = await domain.createItem(repo, 'origens', { nome: 'Indicação' }, OP);
  assert.match(s.id, /^service:/);
  assert.match(o.id, /^origin:/);
  assert.equal(s.ordem, 0, 'cada catálogo conta a sua ordem');
  for (const campo of ['categoria', 'precoReferencia']) assert.equal(s[campo], null, campo);
  assert.deepEqual([s.permitePagamentoUnico, s.permitePagamentoRecorrente, s.periodicidades], [true, false, []]);
  for (const campo of ['tipoCobranca', 'recorrencia']) assert.equal(campo in s, false, `${campo} (legado) nunca é gravado por um cadastro novo`);
  assert.equal(o.canal, null);
  // o id NÃO depende do nome
  const x = await domain.createItem(repo, 'nichos', { nome: 'Nome Qualquer' }, OP);
  assert.doesNotMatch(x.id, /nome|qualquer/i);
});

test('[CATDOM-10] o item devolvido é uma CÓPIA: alterá-lo nunca altera o que está guardado', async () => {
  const repo = createInMemoryCatalogRepository();
  const criado = await domain.createItem(repo, 'nichos', { nome: 'Original' }, OP);
  criado.nome = 'Adulterado';
  criado.ativo = false;
  const lido = await domain.getItem(repo, 'nichos', criado.id);
  assert.equal(lido.nome, 'Original');
  assert.equal(lido.ativo, true);
  lido.nome = 'Outra vez';
  assert.equal((await domain.getItem(repo, 'nichos', criado.id)).nome, 'Original');
  const [da] = await domain.listItems(repo, 'nichos');
  da.nome = 'Mais uma';
  assert.equal((await domain.listItems(repo, 'nichos'))[0].nome, 'Original');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Unicidade
// ---------------------------------------------------------------------------------------------------------------------------------
test('[CATDOM-11] UNICIDADE: o mesmo nome normalizado não se repete no catálogo — mesmo com outra caixa, acento ou pontuação; vale para DESATIVADOS; catálogos diferentes podem repetir o nome', async () => {
  const repo = createInMemoryCatalogRepository();
  const base = await domain.createItem(repo, 'nichos', { nome: 'Estética' }, OP);
  for (const repetido of ['estetica', 'ESTÉTICA', '  Estética  ', 'Estética!', '(Estética)', 'estetica...']) {
    const erro = await erroDe(() => domain.createItem(repo, 'nichos', { nome: repetido }, OP));
    assert.equal(erro.code, CATALOG_ERROR.DUPLICATE_NAME, repetido);
  }
  assert.equal((await domain.listItems(repo, 'nichos')).length, 1);
  // desativado continua ocupando o nome
  await domain.setItemActive(repo, 'nichos', base.id, false, OP);
  assert.equal((await erroDe(() => domain.createItem(repo, 'nichos', { nome: 'estetica' }, OP))).code, CATALOG_ERROR.DUPLICATE_NAME);
  // outro catálogo: pode
  await domain.createItem(repo, 'servicos', { nome: 'Estética', permitePagamentoUnico: true }, OP);
  await domain.createItem(repo, 'origens', { nome: 'Estética' }, OP);
});

test('[CATDOM-12] CONCORRÊNCIA: 25 criações simultâneas do MESMO nome resultam em exatamente UM item (as escritas de um repositório rodam uma por vez)', async () => {
  const repo = createInMemoryCatalogRepository();
  const resultados = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => domain.createItem(repo, 'origens', { nome: i % 2 ? 'Indicação' : 'indicacao' }, OP)));
  assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(resultados.filter((r) => r.status === 'rejected' && r.reason.code === CATALOG_ERROR.DUPLICATE_NAME).length, 24);
  assert.equal((await domain.listItems(repo, 'origens')).length, 1);
  // criações de nomes DIFERENTES simultâneas: todas entram, com ordens distintas e sequenciais
  const varias = await Promise.all(Array.from({ length: 10 }, (_, i) => domain.createItem(repo, 'nichos', { nome: `Nicho ${i}` }, OP)));
  assert.deepEqual(varias.map((item) => item.ordem).sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('[CATDOM-13] a unicidade também é imposta pelo ARMAZENAMENTO: um repositório que acusa DUPLICATE_NAME no insert (a corrida entre processos) vira o mesmo erro de domínio', async () => {
  const repo = {
    ...createInMemoryCatalogRepository(),
    insert: () => {
      const erro = new Error('texto do banco que não pode vazar');
      erro.code = 'CRM_CATALOG_REPOSITORY_DUPLICATE_NAME';
      throw erro;
    },
  };
  const erro = await erroDe(() => domain.createItem(repo, 'nichos', { nome: 'Corrida' }, OP));
  assert.equal(erro.code, CATALOG_ERROR.DUPLICATE_NAME);
  assert.doesNotMatch(erro.message, /banco/);
});

test('[CATDOM-13b] a regra de unicidade é do PRÓPRIO domínio (não só do armazenamento): sobre um repositório que NÃO impõe unicidade, criar ou renomear para o nome de um item ATIVO ou DESATIVADO ainda é recusado', async () => {
  // um armazenamento ingênuo: guarda tudo, sem checar nada
  const guardado = new Map();
  const ingenuo = {
    list: () => [...guardado.values()].map((item) => structuredClone(item)),
    getById: (catalog, id) => (guardado.has(id) ? structuredClone(guardado.get(id)) : null),
    insert: (catalog, item) => (guardado.set(item.id, structuredClone(item)), structuredClone(item)),
    update: (catalog, id, patch) => (guardado.has(id) ? (guardado.set(id, { ...guardado.get(id), ...patch }), structuredClone(guardado.get(id))) : null),
    reorder: () => {},
  };
  const a = await domain.createItem(ingenuo, 'nichos', { nome: 'Estética' }, OP);
  const b = await domain.createItem(ingenuo, 'nichos', { nome: 'Psicologia' }, OP);
  assert.equal((await erroDe(() => domain.createItem(ingenuo, 'nichos', { nome: 'ESTÉTICA' }, OP))).code, CATALOG_ERROR.DUPLICATE_NAME, 'colide com um ativo');
  await domain.setItemActive(ingenuo, 'nichos', a.id, false, OP);
  assert.equal((await erroDe(() => domain.createItem(ingenuo, 'nichos', { nome: 'estetica' }, OP))).code, CATALOG_ERROR.DUPLICATE_NAME, 'colide com um DESATIVADO');
  assert.equal((await erroDe(() => domain.updateItem(ingenuo, 'nichos', b.id, { nome: 'Estetica' }, OP))).code, CATALOG_ERROR.DUPLICATE_NAME, 'renomear para o nome de um desativado');
  assert.equal([...guardado.values()].length, 2, 'nada foi gravado pelas tentativas');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Edição
// ---------------------------------------------------------------------------------------------------------------------------------
test('[CATDOM-14] updateItem é PARCIAL e seguro: só os campos enviados mudam; o responsável e a data de atualização mudam; id, criação, ativo e ordem nunca', async () => {
  const repo = createInMemoryCatalogRepository();
  const original = await domain.createItem(repo, 'servicos', { nome: 'Site', descricao: 'Antiga', categoria: 'Web', precoReferencia: 1000, permitePagamentoUnico: true }, OP, clockAt(T0));
  const editado = await domain.updateItem(repo, 'servicos', original.id, { descricao: '  Nova  ', precoReferencia: 1200.5 }, OP2, clockAt(T1));
  assert.equal(editado.descricao, 'Nova');
  assert.equal(editado.precoReferencia, 1200.5);
  assert.equal(editado.atualizadoEm, T1.toISOString());
  assert.equal(editado.atualizadoPorUserId, 'user-outro');
  assert.equal(editado.atualizadoPorNome, 'Outro Admin');
  for (const campo of ['id', 'nome', 'nomeNormalizado', 'categoria', 'permitePagamentoUnico', 'permitePagamentoRecorrente', 'periodicidades', 'ativo', 'ordem', 'criadoEm', 'criadoPorUserId', 'criadoPorNome']) {
    assert.deepEqual(editado[campo], original[campo], `${campo} não mudou`);
  }
  // limpar um campo opcional é explícito: null (ou vazio)
  const limpo = await domain.updateItem(repo, 'servicos', original.id, { categoria: null, descricao: '   ' }, OP, clockAt(T1));
  assert.equal(limpo.categoria, null);
  assert.equal(limpo.descricao, null);
  assert.equal(limpo.precoReferencia, 1200.5, 'o que não foi enviado ficou');
});

test('[CATDOM-15] um patch que não muda nada devolve o item SEM gravar (e sem mexer na data de atualização); um patch vazio é erro; ativo, ordem, id e datas nunca vêm por edição', async () => {
  const { repo, calls } = spyRepository();
  const item = await domain.createItem(repo, 'nichos', { nome: 'Estética', descricao: 'Igual', cor: 'verde' }, OP, clockAt(T0));
  const antes = calls.update;
  const igual = await domain.updateItem(repo, 'nichos', item.id, { descricao: 'Igual', cor: 'verde', nome: 'Estética' }, OP2, clockAt(T1));
  assert.deepEqual(igual, item);
  assert.equal(calls.update, antes, 'nenhuma gravação');
  assert.equal(igual.atualizadoEm, T0.toISOString());
  assert.equal(igual.atualizadoPorNome, 'Admin Teste');

  const vazio = await erroDe(() => domain.updateItem(repo, 'nichos', item.id, {}, OP, clockAt(T1)));
  assert.equal(vazio.code, CATALOG_ERROR.INVALID_INPUT);
  assert.deepEqual(errorsOf(vazio), [{ path: '', code: 'NADA_A_ALTERAR' }]);

  for (const campo of ['ativo', 'ordem', 'id', 'nomeNormalizado', 'criadoEm', 'atualizadoEm', 'criadoPorNome']) {
    const erro = await erroDe(() => domain.updateItem(repo, 'nichos', item.id, { [campo]: 'x' }, OP, clockAt(T1)));
    assert.deepEqual(errorsOf(erro), [{ path: campo, code: 'CAMPO_NAO_EDITAVEL' }], campo);
  }
  assert.deepEqual(await domain.getItem(repo, 'nichos', item.id), item, 'nada mudou');
  assert.equal((await erroDe(() => domain.updateItem(repo, 'nichos', 'niche:nao-existe', { descricao: 'x' }, OP))).code, CATALOG_ERROR.NOT_FOUND);
});

test('[CATDOM-16] RENOMEAR: o nome normalizado acompanha o nome; colidir com OUTRO item é recusado (mesmo desativado); manter a própria identidade (só a caixa) é permitido', async () => {
  const repo = createInMemoryCatalogRepository();
  const a = await domain.createItem(repo, 'nichos', { nome: 'Estética' }, OP);
  const b = await domain.createItem(repo, 'nichos', { nome: 'Psicologia' }, OP);
  const renomeado = await domain.updateItem(repo, 'nichos', a.id, { nome: 'ESTÉTICA E BELEZA' }, OP, clockAt(T1));
  assert.equal(renomeado.nome, 'ESTÉTICA E BELEZA');
  assert.equal(renomeado.nomeNormalizado, 'estetica e beleza');
  assert.equal(renomeado.id, a.id, 'o id é estável: o nome mudou, a identidade não');
  assert.equal((await erroDe(() => domain.updateItem(repo, 'nichos', b.id, { nome: 'estetica e beleza' }, OP))).code, CATALOG_ERROR.DUPLICATE_NAME);
  await domain.setItemActive(repo, 'nichos', a.id, false, OP);
  assert.equal((await erroDe(() => domain.updateItem(repo, 'nichos', b.id, { nome: 'Estética e Beleza' }, OP))).code, CATALOG_ERROR.DUPLICATE_NAME, 'o desativado segura o nome');
  const soCaixa = await domain.updateItem(repo, 'nichos', b.id, { nome: 'PSICOLOGIA' }, OP);
  assert.equal(soCaixa.nome, 'PSICOLOGIA');
  assert.equal(soCaixa.nomeNormalizado, 'psicologia');
});

test('[CATDOM-17] TRAVA DE RENOMEAÇÃO (decisão D3): com nameLocked, mudar o nome — até só a caixa — é recusado com NAME_IN_USE; qualquer outra edição segue livre; repetir o mesmo nome não é "mudar"', async () => {
  const repo = createInMemoryCatalogRepository();
  const item = await domain.createItem(repo, 'nichos', { nome: 'Estética', cor: 'rosa' }, OP, clockAt(T0));
  const locked = { ...clockAt(T1), nameLocked: true };
  for (const novoNome of ['Beleza', 'ESTÉTICA', 'estetica']) {
    const erro = await erroDe(() => domain.updateItem(repo, 'nichos', item.id, { nome: novoNome }, OP, locked));
    assert.equal(erro.code, CATALOG_ERROR.NAME_IN_USE, novoNome);
  }
  assert.equal((await domain.getItem(repo, 'nichos', item.id)).nome, 'Estética', 'nada mudou');
  // o que continua livre
  const livre = await domain.updateItem(repo, 'nichos', item.id, { descricao: 'Nova', cor: 'azul' }, OP, locked);
  assert.equal(livre.descricao, 'Nova');
  assert.equal(livre.cor, 'azul');
  assert.equal(livre.nome, 'Estética');
  // mandar o MESMO nome junto com outra edição não é uma mudança de nome
  const mesmo = await domain.updateItem(repo, 'nichos', item.id, { nome: 'Estética', descricao: 'Outra' }, OP, locked);
  assert.equal(mesmo.descricao, 'Outra');
  // desativar e reativar também seguem livres
  assert.equal((await domain.setItemActive(repo, 'nichos', item.id, false, OP, locked)).ativo, false);
  // sem a trava, o mesmo pedido de renomear funciona
  const aberto = await domain.updateItem(repo, 'nichos', item.id, { nome: 'Beleza' }, OP, clockAt(T1));
  assert.equal(aberto.nome, 'Beleza');
});

test('[CATDOM-18] MODALIDADES na edição de serviços: a coerência vale para o estado RESULTANTE — nada apaga modalidades em silêncio (o que não foi enviado é preservado)', async () => {
  const repo = createInMemoryCatalogRepository();
  const s = await domain.createItem(repo, 'servicos', { nome: 'Tráfego', permitePagamentoRecorrente: true, periodicidades: ['MENSAL'] }, OP);
  const falha = async (patch) => errorsOf(await erroDe(() => domain.updateItem(repo, 'servicos', s.id, patch, OP)));
  // desligar o recorrente sem limpar as periodicidades NÃO apaga nada em silêncio: é recusado (e, sendo a única modalidade, também a deixaria sem nenhuma)
  assert.deepEqual(await falha({ permitePagamentoRecorrente: false }), [{ path: 'periodicidades', code: 'PERIODICIDADE_NAO_PERMITIDA' }, { path: 'modalidades', code: 'MODALIDADE_OBRIGATORIA' }]);
  assert.deepEqual(await falha({ periodicidades: [] }), [{ path: 'periodicidades', code: 'PERIODICIDADE_OBRIGATORIA' }], 'esvaziar as periodicidades de um recorrente');
  assert.deepEqual(await falha({ permitePagamentoRecorrente: false, periodicidades: [] }), [{ path: 'modalidades', code: 'MODALIDADE_OBRIGATORIA' }], 'nunca se remove a última modalidade');
  // acrescentar o pagamento único NÃO mexe nas periodicidades (não foram enviadas) — o serviço passa a ter as duas modalidades
  const ambos = await domain.updateItem(repo, 'servicos', s.id, { permitePagamentoUnico: true }, OP);
  assert.deepEqual([ambos.permitePagamentoUnico, ambos.permitePagamentoRecorrente, ambos.periodicidades], [true, true, ['MENSAL']]);
  // trocar o nome ou o preço nunca toca nas modalidades
  const renomeado = await domain.updateItem(repo, 'servicos', s.id, { nome: 'Tráfego pago', precoReferencia: 900 }, OP);
  assert.deepEqual([renomeado.permitePagamentoUnico, renomeado.permitePagamentoRecorrente, renomeado.periodicidades], [true, true, ['MENSAL']]);
  // várias periodicidades (a ordem canônica) e, com as duas modalidades, dá para tirar só uma delas
  const varias = await domain.updateItem(repo, 'servicos', s.id, { periodicidades: ['ANUAL', 'MENSAL', 'SEMESTRAL'] }, OP);
  assert.deepEqual(varias.periodicidades, ['MENSAL', 'SEMESTRAL', 'ANUAL']);
  assert.deepEqual((await repo.getById('servicos', s.id)).periodicidades, ['MENSAL', 'SEMESTRAL', 'ANUAL'], 'o que fica ARMAZENADO já está na ordem canônica, não só o que é devolvido');
  const criadoEmDesordem = await domain.createItem(repo, 'servicos', { nome: 'Desordem', permitePagamentoRecorrente: true, periodicidades: ['ANUAL', 'MENSAL'] }, OP);
  assert.deepEqual((await repo.getById('servicos', criadoEmDesordem.id)).periodicidades, ['MENSAL', 'ANUAL'], 'o cadastro novo também grava na ordem canônica');
  const soUnico = await domain.updateItem(repo, 'servicos', s.id, { permitePagamentoRecorrente: false, periodicidades: [] }, OP);
  assert.deepEqual([soUnico.permitePagamentoUnico, soUnico.permitePagamentoRecorrente, soUnico.periodicidades], [true, false, []]);
  assert.deepEqual(await falha({ permitePagamentoUnico: false }), [{ path: 'modalidades', code: 'MODALIDADE_OBRIGATORIA' }], 'o único que sobrou não pode ser removido');
  // um patch com as MESMAS periodicidades (até em outra ordem) não é mudança: nada é gravado e a data de atualização não se mexe
  const { repo: espiao, calls } = spyRepository();
  const e = await domain.createItem(espiao, 'servicos', { nome: 'Espiado', permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'ANUAL'] }, OP, clockAt(T0));
  const gravacoes = calls.update;
  const igual = await domain.updateItem(espiao, 'servicos', e.id, { periodicidades: ['ANUAL', 'MENSAL'], permitePagamentoUnico: true }, OP2, clockAt(T1));
  assert.deepEqual(igual, e);
  assert.equal(calls.update, gravacoes, 'as mesmas periodicidades não gravam');
  assert.equal(igual.atualizadoEm, T0.toISOString());
  // editar o NOME de um serviço nunca esbarra nas modalidades que não foram enviadas — mesmo que o armazenado esteja incoerente (uma gravação por fora das regras)
  const incoerente = await repo.insert('servicos', { id: 'service:00000000-0000-4000-8000-0000000000aa', nome: 'Incoerente', nomeNormalizado: 'incoerente', descricao: null, ativo: true, ordem: 99, categoria: null, precoReferencia: null, permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: [], criadoEm: T0.toISOString(), atualizadoEm: T0.toISOString(), criadoPorUserId: null, criadoPorNome: null, atualizadoPorUserId: null, atualizadoPorNome: null });
  const renomeadoIncoerente = await domain.updateItem(repo, 'servicos', incoerente.id, { nome: 'Incoerente renomeado' }, OP);
  assert.equal(renomeadoIncoerente.nome, 'Incoerente renomeado', 'só a coerência de um patch que TOCA as modalidades é conferida');
  assert.deepEqual(errorsOf(await erroDe(() => domain.updateItem(repo, 'servicos', incoerente.id, { permitePagamentoUnico: true }, OP))), [{ path: 'periodicidades', code: 'PERIODICIDADE_OBRIGATORIA' }], 'mas ao tocar nelas, o estado resultante tem de ser coerente');
  // validatePatch é puro: não altera o item atual que recebe
  const atual = Object.freeze({ permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: Object.freeze(['MENSAL']) });
  assert.equal(validatePatch('servicos', { periodicidades: ['ANUAL'] }, atual).ok, true);
  assert.deepEqual([...atual.periodicidades], ['MENSAL']);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Ativação e desativação
// ---------------------------------------------------------------------------------------------------------------------------------
test('[CATDOM-19] ATIVAR/DESATIVAR: o item continua existindo (e em list sem filtro); mantém todos os campos; é idempotente (pedir o estado atual não grava); só aceita booleano', async () => {
  const { repo, calls } = spyRepository();
  const item = await domain.createItem(repo, 'origens', { nome: 'Parceria', canal: 'PARCERIA', descricao: 'Parceiros' }, OP, clockAt(T0));
  const off = await domain.setItemActive(repo, 'origens', item.id, false, OP2, clockAt(T1));
  assert.equal(off.ativo, false);
  assert.equal(off.atualizadoPorNome, 'Outro Admin');
  assert.equal(off.atualizadoEm, T1.toISOString());
  for (const campo of ['id', 'nome', 'nomeNormalizado', 'descricao', 'canal', 'ordem', 'criadoEm', 'criadoPorNome']) assert.deepEqual(off[campo], item[campo], campo);
  assert.equal((await domain.listItems(repo, 'origens')).length, 1, 'continua na lista completa');
  assert.equal((await domain.listItems(repo, 'origens', { onlyActive: true })).length, 0, 'e some da lista de escolha');
  const gravacoes = calls.update;
  assert.deepEqual(await domain.setItemActive(repo, 'origens', item.id, false, OP, clockAt(T1)), off, 'repetir não muda nada');
  assert.equal(calls.update, gravacoes, 'e não grava');
  const on = await domain.setItemActive(repo, 'origens', item.id, true, OP, clockAt(T1));
  assert.equal(on.ativo, true);
  assert.equal((await domain.listItems(repo, 'origens', { onlyActive: true })).length, 1);
  for (const naoBooleano of ['true', 1, 0, null, undefined]) {
    await assert.rejects(() => domain.setItemActive(repo, 'origens', item.id, naoBooleano, OP), /booleano/);
  }
  assert.equal((await erroDe(() => domain.setItemActive(repo, 'origens', 'origin:nao-existe', true, OP))).code, CATALOG_ERROR.NOT_FOUND);
});

test('[CATDOM-20] NÃO EXISTE exclusão física: nem o domínio nem a porta têm uma operação de apagar (decisão D4)', () => {
  assert.deepEqual(Object.keys(domain).sort(), ['CatalogError', 'createItem', 'getItem', 'listItems', 'normalizeCatalogName', 'reorderItems', 'setItemActive', 'updateItem', 'validateCreateInput', 'validatePatch']);
  const port = require('../../src/crm/catalogRepositoryPort');
  assert.deepEqual([...port.REQUIRED_CATALOG_REPOSITORY_METHODS], ['list', 'getById', 'insert', 'update', 'reorder']);
  assert.deepEqual(Object.keys(createInMemoryCatalogRepository()).sort(), ['getById', 'insert', 'list', 'reorder', 'update']);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Ordem de exibição
// ---------------------------------------------------------------------------------------------------------------------------------
test('[CATDOM-21] REORDENAR: a lista tem de conter EXATAMENTE os itens (ativos e desativados), cada um uma vez; a nova ordem é a posição; devolve a lista já ordenada', async () => {
  const repo = createInMemoryCatalogRepository();
  for (const nome of ['Alfa', 'Beta', 'Gama', 'Delta']) await domain.createItem(repo, 'nichos', { nome }, OP);
  const itens = await domain.listItems(repo, 'nichos');
  const [ia, ib, ic, id] = itens.map((item) => item.id);
  await domain.setItemActive(repo, 'nichos', ic, false, OP);

  const nova = await domain.reorderItems(repo, 'nichos', [id, ic, ia, ib], OP2, clockAt(T1));
  assert.deepEqual(nova.map((item) => item.nome), ['Delta', 'Gama', 'Alfa', 'Beta']);
  assert.deepEqual(nova.map((item) => item.ordem), [0, 1, 2, 3]);
  assert.equal(nova.find((item) => item.id === ic).ativo, false, 'o desativado entra na ordenação e continua desativado');
  const gravada = await domain.listItems(repo, 'nichos');
  assert.deepEqual(gravada.map((item) => item.nome), ['Delta', 'Gama', 'Alfa', 'Beta']);

  const lista = (ids) => erroDe(() => domain.reorderItems(repo, 'nichos', ids, OP));
  for (const invalida of [[ia, ib, ic], [ia, ib, ic, id, 'niche:extra'], [ia, ia, ib, ic], [], 'texto', null, [ia, ib, ic, 5], [ia, ib, ic, ''], undefined]) {
    const erro = await lista(invalida);
    assert.equal(erro.code, CATALOG_ERROR.INVALID_INPUT, JSON.stringify(invalida));
    assert.deepEqual(errorsOf(erro), [{ path: 'orderedIds', code: 'LISTA_INVALIDA' }]);
  }
  assert.deepEqual((await domain.listItems(repo, 'nichos')).map((item) => item.nome), ['Delta', 'Gama', 'Alfa', 'Beta'], 'as listas inválidas não mudaram nada');
});

test('[CATDOM-22] reordenar na mesma ordem não grava; o desempate de listagem é estável (ordem, depois nome normalizado, depois id); um catálogo vazio aceita a lista vazia', async () => {
  const { repo, calls } = spyRepository();
  for (const nome of ['Zeta', 'Alfa']) await domain.createItem(repo, 'origens', { nome }, OP);
  const atual = (await domain.listItems(repo, 'origens')).map((item) => item.id);
  const antes = calls.reorder;
  await domain.reorderItems(repo, 'origens', atual, OP);
  assert.equal(calls.reorder, antes, 'a ordem não mudou: nada a gravar');
  assert.deepEqual(await domain.reorderItems(createInMemoryCatalogRepository(), 'origens', [], OP), []);

  // itens com a MESMA ordem (um armazenamento externo pode produzir isso) saem por nome normalizado e depois por id
  const base = createInMemoryCatalogRepository();
  const mk = (id, nome, ordem) => ({ id, nome, nomeNormalizado: normalizeCatalogName(nome), descricao: null, ativo: true, ordem, cor: null, criadoEm: T0.toISOString(), atualizadoEm: T0.toISOString(), criadoPorUserId: null, criadoPorNome: null, atualizadoPorUserId: null, atualizadoPorNome: null });
  base.insert('nichos', mk('niche:00000000-0000-4000-8000-000000000002', 'Beta', 0));
  base.insert('nichos', mk('niche:00000000-0000-4000-8000-000000000001', 'Alfa', 0));
  base.insert('nichos', mk('niche:00000000-0000-4000-8000-000000000003', 'Gama', -1));
  assert.deepEqual((await domain.listItems(base, 'nichos')).map((item) => item.nome), ['Gama', 'Alfa', 'Beta']);
});

test('[CATDOM-23] leitura: getItem devolve o item ou null; um id mal formado é erro de entrada; listItems filtra os ativos; um catálogo desconhecido é erro de entrada', async () => {
  const repo = createInMemoryCatalogRepository();
  const item = await domain.createItem(repo, 'servicos', { nome: 'Site', permitePagamentoUnico: true }, OP);
  assert.deepEqual(await domain.getItem(repo, 'servicos', item.id), item);
  assert.equal(await domain.getItem(repo, 'servicos', 'service:00000000-0000-4000-8000-000000000999'), null);
  assert.equal(await domain.getItem(repo, 'nichos', item.id), null, 'o id de um catálogo não existe em outro');
  for (const ruim of ['', '   ', 5, null, undefined, 'x'.repeat(201)]) {
    const erro = await erroDe(() => domain.getItem(repo, 'servicos', ruim));
    assert.equal(erro.code, CATALOG_ERROR.INVALID_INPUT);
    assert.deepEqual(errorsOf(erro), [{ path: 'id', code: 'ID_INVALIDO' }]);
  }
  for (const operacao of [() => domain.listItems(repo, 'clientes'), () => domain.getItem(repo, 'clientes', 'x'), () => domain.createItem(repo, 'clientes', { nome: 'x' }, OP), () => domain.reorderItems(repo, 'clientes', [], OP)]) {
    const erro = await erroDe(operacao);
    assert.equal(erro.code, CATALOG_ERROR.INVALID_INPUT);
    assert.deepEqual(errorsOf(erro), [{ path: 'catalogo', code: 'CATALOGO_INVALIDO' }]);
  }
  // prototype-keys como catálogo
  for (const chave of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal((await erroDe(() => domain.listItems(repo, chave))).code, CATALOG_ERROR.INVALID_INPUT, chave);
  assert.deepEqual([...CATALOG_KEYS], ['servicos', 'nichos', 'origens']);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Falhas
// ---------------------------------------------------------------------------------------------------------------------------------
test('[CATDOM-24] FALHA DE ARMAZENAMENTO: qualquer erro do repositório vira CRM_CATALOG_PERSISTENCE com mensagem FIXA (a causa fica só em `cause`); uma resposta malformada do armazenamento falha fechada', async () => {
  const quebrado = {
    list: () => { throw new Error('ECONNRESET detalhe de infraestrutura SEGREDO'); },
    getById: async () => { throw new Error('boom SEGREDO'); },
    insert: () => { throw new Error('boom SEGREDO'); },
    update: () => { throw new Error('boom SEGREDO'); },
    reorder: () => { throw new Error('boom SEGREDO'); },
  };
  for (const operacao of [() => domain.listItems(quebrado, 'nichos'), () => domain.getItem(quebrado, 'nichos', 'niche:x'), () => domain.createItem(quebrado, 'nichos', { nome: 'A' }, OP)]) {
    const erro = await erroDe(operacao);
    assert.equal(erro.code, CATALOG_ERROR.PERSISTENCE);
    assert.equal(erro.message, 'Cadastro: não foi possível ler ou gravar os dados.');
    assert.doesNotMatch(erro.message, /SEGREDO|ECONNRESET/);
    assert.match(erro.cause.message, /SEGREDO/, 'a causa fica disponível para o log do servidor');
  }
  const malformados = [
    { ...createInMemoryCatalogRepository(), list: () => 'não é lista' },
    { ...createInMemoryCatalogRepository(), list: () => [{ id: 5 }] },
    { ...createInMemoryCatalogRepository(), list: () => [null] },
    { ...createInMemoryCatalogRepository(), getById: () => ({ semId: true }) },
  ];
  assert.equal((await erroDe(() => domain.listItems(malformados[0], 'nichos'))).code, CATALOG_ERROR.PERSISTENCE);
  assert.equal((await erroDe(() => domain.listItems(malformados[1], 'nichos'))).code, CATALOG_ERROR.PERSISTENCE);
  assert.equal((await erroDe(() => domain.listItems(malformados[2], 'nichos'))).code, CATALOG_ERROR.PERSISTENCE);
  assert.equal((await erroDe(() => domain.getItem(malformados[3], 'nichos', 'niche:x'))).code, CATALOG_ERROR.PERSISTENCE);
  // um repositório que não segue a porta nem chega a ser usado
  await assert.rejects(() => domain.listItems({ list() {} }, 'nichos'), /repositório inválido/);
  await assert.rejects(() => domain.createItem(null, 'nichos', { nome: 'A' }, OP), /repositório inválido/);
});

test('[CATDOM-25] o operador é obrigatório e vem do chamador autorizado: sem { userId, name } válidos a operação de escrita não existe (erro de programação, nada é gravado)', async () => {
  const { repo, calls } = spyRepository();
  for (const operador of [undefined, null, {}, { userId: 'u' }, { name: 'n' }, { userId: '', name: 'n' }, { userId: 'u', name: '   ' }, { userId: 5, name: 'n' }, 'admin']) {
    await assert.rejects(() => domain.createItem(repo, 'nichos', { nome: 'A' }, operador), /operador inválido/);
  }
  assert.equal(calls.insert, 0);
  const item = await domain.createItem(repo, 'nichos', { nome: 'A' }, { userId: '  u1 ', name: '  Fulano  ' });
  assert.equal(item.criadoPorUserId, 'u1', 'espaços das pontas saem');
  assert.equal(item.criadoPorNome, 'Fulano');
});
