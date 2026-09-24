// Teste de CONTRATO do mapeamento de erro do CRM -> HTTP (decisão 0015; mesmo desenho de error-mapping.test.js, D5).
//
// src/server/app.js reconhece os erros do CRM Service e do domínio do CRM PELO TEXTO da mensagem (eles não têm código, e
// o Service e o domínio não foram alterados para ganhar um). Este arquivo PRODUZ cada erro real, com os módulos reais
// (nunca digita a mensagem à mão), e prova que mapErrorToHttp() os traduz para o status e a mensagem FIXA esperados. Se
// uma mensagem de origem mudar, é aqui que quebra — de propósito: sem isto o app.js pararia de reconhecer o erro e
// devolveria 500 em vez do status certo.
//
// O último grupo é uma VARREDURA: toda mensagem "CRM: ..." que o código-fonte do domínio, do repositório e do Service pode
// lançar precisa estar classificada — ou mapeada para um status de cliente, ou declarada aqui como interna por desenho
// (500). Uma mensagem NOVA, sem classificação, derruba o teste até alguém decidir o que ela é.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const constants = require('../../src/auth/constants');
const { authorizeCrmOperation, PERMISSION, defineUser, ROLE, USER_STATUS } = require('../../src/auth');
const { createCrmService } = require('../../src/services/crmService');
const { createFileBackedCrmService } = require('../../src/services/crmFileService');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
const { createAuthorizationContext } = require('../helpers/authFixtures');
const { mapErrorToHttp } = require('../../src/server/app');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function erroDe(fn) {
  try {
    fn();
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava que a função lançasse, e ela não lançou');
}

const mapeado = (erro) => {
  const { status, code, message } = mapErrorToHttp(erro);
  return { status, code, message };
};

const usuario = (extras = {}) => defineUser({ userId: 'u1', authUserId: 'a1', name: 'Um', email: 'um-teste@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE, ...extras });

// Um Service REAL (ponte real, repositório em memória) e um contexto EMITIDO de ADMIN.
function ambiente() {
  const repository = createInMemoryCrmRepository();
  const service = createCrmService({ authorizeOperation: authorizeCrmOperation, repository });
  return { service, ctx: createAuthorizationContext(usuario()), repository };
}

const ALFA = { empresa: 'Alfa Teste', site: 'alfa.example.test', telefone: '24 90000-0001', cidade: 'Petrópolis' };
const BETA = { empresa: 'Beta Teste', site: 'beta.example.test', telefone: '21 90000-0002', cidade: 'Niterói' };

const FIXAS = Object.freeze({
  naoEncontrado: { status: 404, code: 'NOT_FOUND', message: 'Item não encontrado.' },
  duplicado: { status: 409, code: 'DUPLICATE_RECORD', message: 'Já existe um registro com esta identidade.' },
  bloqueado: { status: 409, code: 'DNC_BLOCKED', message: 'Esta identidade está bloqueada como "não contatar".' },
  travado: { status: 409, code: 'RECORD_LOCKED', message: 'Este registro está bloqueado como "não contatar" e não pode ser alterado.' },
  transicao: { status: 409, code: 'INVALID_TRANSITION', message: 'Esta mudança de status não é permitida.' },
  interno: { status: 500, code: 'INTERNAL', message: 'Erro interno. Tente novamente em instantes.' },
});
const invalido = (message) => ({ status: 400, code: 'INVALID_REQUEST', message });

test('[CRM-ERRMAP-1] "registro não encontrado" (domínio e Service, em todas as operações que buscam por id) -> 404 NOT_FOUND com mensagem fixa, sem repetir o id', () => {
  const { service, ctx } = ambiente();
  const erros = [
    erroDe(() => service.getHistory(ctx, 'crm:inexistente')),
    erroDe(() => service.updateRecord(ctx, 'crm:inexistente', {})),
    erroDe(() => service.moveStatus(ctx, 'crm:inexistente', 'RESEARCH')),
    erroDe(() => service.markDoNotContact(ctx, 'crm:inexistente')),
  ];
  for (const erro of erros) {
    assert.match(erro.message, /^CRM: registro não encontrado/);
    assert.deepEqual(mapeado(erro), FIXAS.naoEncontrado, erro.message);
    assert.ok(!mapErrorToHttp(erro).message.includes('inexistente'));
  }
});

test('[CRM-ERRMAP-2] identidade já bloqueada (DNC) na criação e na edição -> 409 DNC_BLOCKED; identidade já existente na criação e na edição -> 409 DUPLICATE_RECORD; nenhum id sai', () => {
  const { service, ctx } = ambiente();
  const bloqueado = service.createRecord(ctx, ALFA).record;
  service.markDoNotContact(ctx, bloqueado.id);
  const beta = service.createRecord(ctx, BETA).record;

  const dncNaCriacao = erroDe(() => service.createRecord(ctx, { empresa: 'Outro Nome', site: ALFA.site }));
  const dncNaEdicao = erroDe(() => service.updateRecord(ctx, beta.id, { site: ALFA.site }));
  assert.match(dncNaCriacao.message, /^CRM: não é possível criar — identidade já bloqueada/);
  assert.match(dncNaEdicao.message, /^CRM: não é possível atualizar — a nova identidade coincide com a de um registro bloqueado/);
  for (const erro of [dncNaCriacao, dncNaEdicao]) {
    assert.deepEqual(mapeado(erro), FIXAS.bloqueado);
    assert.ok(erro.message.includes(bloqueado.id), 'sanidade: a mensagem ORIGINAL cita o id do outro registro');
    assert.ok(!mapErrorToHttp(erro).message.includes('crm:'), 'a mensagem mapeada não cita id nenhum');
  }

  const gama = service.createRecord(ctx, { empresa: 'Gama Teste', site: 'gama.example.test' }).record;
  const duplicadoNaCriacao = erroDe(() => service.createRecord(ctx, { empresa: 'Outro Nome', site: 'gama.example.test' }));
  const duplicadoNaEdicao = erroDe(() => service.updateRecord(ctx, beta.id, { site: 'gama.example.test' }));
  assert.match(duplicadoNaCriacao.message, /^CRM: não é possível criar — já existe um registro com a mesma identidade/);
  assert.match(duplicadoNaEdicao.message, /^CRM: não é possível atualizar — a nova identidade coincide com a de outro registro/);
  for (const erro of [duplicadoNaCriacao, duplicadoNaEdicao]) {
    assert.deepEqual(mapeado(erro), FIXAS.duplicado);
    assert.ok(erro.message.includes(gama.id), 'sanidade: a mensagem ORIGINAL cita o id do outro registro');
    assert.ok(!mapErrorToHttp(erro).message.includes('crm:'));
  }
});

test('[CRM-ERRMAP-3] editar um registro DO_NOT_CONTACT -> 409 RECORD_LOCKED; transição não permitida (a partir de WON, de DO_NOT_CONTACT) -> 409 INVALID_TRANSITION, sem repetir os status', () => {
  const { service, ctx } = ambiente();
  const bloqueado = service.createRecord(ctx, ALFA).record;
  service.markDoNotContact(ctx, bloqueado.id);
  const editar = erroDe(() => service.updateRecord(ctx, bloqueado.id, { cidade: 'Outra' }));
  assert.match(editar.message, /^CRM: registro bloqueado \(DO_NOT_CONTACT\) não pode ser atualizado/);
  assert.deepEqual(mapeado(editar), FIXAS.travado);

  const ganho = service.createRecord(ctx, BETA).record;
  service.moveStatus(ctx, ganho.id, 'WON');
  for (const erro of [
    erroDe(() => service.moveStatus(ctx, ganho.id, 'PROSPECT')),
    erroDe(() => service.moveStatus(ctx, bloqueado.id, 'PROSPECT')),
    erroDe(() => service.markDoNotContact(ctx, bloqueado.id)),
  ]) {
    assert.match(erro.message, /^CRM: transição não permitida/);
    assert.deepEqual(mapeado(erro), FIXAS.transicao);
    assert.ok(!mapErrorToHttp(erro).message.includes('WON') && !mapErrorToHttp(erro).message.includes('->'));
  }
});

test('[CRM-ERRMAP-4] entrada inválida (id, campos, valores, empresa, status, motivo) -> 400 INVALID_REQUEST com a mensagem fixa de cada caso', () => {
  const { service, ctx } = ambiente();
  const alfa = service.createRecord(ctx, ALFA).record;
  const CAMPOS = invalido('Campos não permitidos na requisição.');
  const VALOR = invalido('Valor inválido em um dos campos.');
  const STATUS = invalido('Status inválido.');
  const casos = [
    [() => service.getRecord(ctx, '   '), invalido('Identificador inválido.'), /^CRM: id deve ser um texto não vazio/],
    [() => service.getHistory(ctx, ''), invalido('Identificador inválido.'), /^CRM: id deve ser um texto não vazio/],
    [() => service.createRecord(ctx, { empresa: 'X', campoInventado: 1 }), CAMPOS, /^CRM: createRecord tem campos desconhecidos/],
    [() => service.updateRecord(ctx, alfa.id, { campoInventado: 1 }), CAMPOS, /^CRM: updateRecord tem campos desconhecidos/],
    [() => service.createRecord(ctx, { empresa: 'X', id: 'crm:forjado' }), CAMPOS, /^CRM: createRecord não aceita campos gerenciados/],
    [() => service.updateRecord(ctx, alfa.id, { status: 'WON' }), CAMPOS, /^CRM: updateRecord não aceita campos gerenciados/],
    [() => service.createRecord(ctx, { empresa: 'X', valorProposta: 'muito' }), VALOR, /^CRM: createRecord — campo "valorProposta"/],
    [() => service.updateRecord(ctx, alfa.id, { valorTotal: -1 }), VALOR, /^CRM: updateRecord — campo "valorTotal"/],
    [() => service.createRecord(ctx, {}), invalido('Informe a empresa.'), /^CRM: createRecord exige "empresa"/],
    [() => service.updateRecord(ctx, alfa.id, { empresa: '  ' }), invalido('A empresa não pode ficar vazia.'), /^CRM: updateRecord não pode deixar "empresa" vazia/],
    [() => service.createRecord(ctx, { empresa: 'X' }, { status: 'NAO_EXISTE' }), STATUS, /^CRM: status desconhecido/],
    [() => service.moveStatus(ctx, alfa.id, 'NAO_EXISTE'), STATUS, /^CRM: status desconhecido/],
    [() => service.createRecord(ctx, { empresa: 'X' }, { status: 42 }), STATUS, /^CRM: status deve ser um texto/],
    [() => service.moveStatus(ctx, alfa.id, undefined), STATUS, /^CRM: o status de destino deve ser um texto/],
    [() => service.moveStatus(ctx, alfa.id, 'RESEARCH', { reason: 42 }), invalido('O motivo deve ser um texto.'), /^CRM: reason deve ser um texto/],
    [() => service.markDoNotContact(ctx, alfa.id, { reason: {} }), invalido('O motivo deve ser um texto.'), /^CRM: reason deve ser um texto/],
  ];
  for (const [fn, esperado, origem] of casos) {
    const erro = erroDe(fn);
    assert.match(erro.message, origem);
    assert.deepEqual(mapeado(erro), esperado, erro.message);
  }
});

test('[CRM-ERRMAP-5] a autorização do CRM (ponte real): usuário inativo -> 403 INACTIVE; contexto sem a permissão -> 403 FORBIDDEN', (t) => {
  const inativo = createAuthorizationContext(usuario({ userId: 'u2', authUserId: 'a2', status: USER_STATUS.INACTIVE }));
  const { service } = ambiente();
  const erroInativo = erroDe(() => service.listRecords(inativo));
  assert.deepEqual(mapeado(erroInativo), { status: 403, code: 'INACTIVE', message: 'Esta conta não possui acesso a esta área.' });

  const derivacao = t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.APPROVE_LEAD_APPROVAL]));
  const semPermissao = createAuthorizationContext(usuario({ userId: 'u3', authUserId: 'a3' }));
  derivacao.mock.restore();
  for (const erro of [erroDe(() => service.listRecords(semPermissao)), erroDe(() => service.createRecord(semPermissao, ALFA))]) {
    assert.deepEqual(mapeado(erro), { status: 403, code: 'FORBIDDEN', message: 'Esta conta não possui acesso a esta área.' });
  }
});

test('[CRM-ERRMAP-6] o que é INTERNO por desenho -> 500 genérico: arquivo corrompido, registro inválido no armazenamento, autorizador defeituoso, permissão que a ponte não suporta, opções que a API nunca envia', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-errmap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { ctx } = ambiente();

  const arquivo = path.join(dir, 'crm.json');
  fs.writeFileSync(arquivo, '{ "trecho-do-conteudo": ');
  const doArquivo = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: arquivo });
  const corrompido = erroDe(() => doArquivo.listRecords(ctx));
  assert.match(corrompido.message, /^CRM: arquivo de dados corrompido/);
  assert.ok(corrompido.message.includes('trecho-do-conteudo') || corrompido.message.includes(arquivo), 'sanidade: a mensagem ORIGINAL cita conteúdo ou caminho — por isso nunca vai à resposta');
  fs.writeFileSync(arquivo, '[]');
  const estruturaInvalida = erroDe(() => doArquivo.listRecords(ctx));
  assert.match(estruturaInvalida.message, /^CRM: arquivo de dados corrompido/);

  const adulterado = createCrmService({ authorizeOperation: authorizeCrmOperation, repository: { list: () => [{ semId: true }], getById: () => null, save() {} } });
  const registroInvalido = erroDe(() => adulterado.listRecords(ctx));
  assert.match(registroInvalido.message, /^CRM: registro inválido no armazenamento/);

  const defeituoso = createCrmService({ authorizeOperation: () => undefined, repository: createInMemoryCrmRepository() });
  const autorizadorDefeituoso = erroDe(() => defeituoso.listRecords(ctx));
  assert.match(autorizadorDefeituoso.message, /^autorização recusada/);

  const naoSuportada = erroDe(() => authorizeCrmOperation(ctx, PERMISSION.WRITE_CRM.replace('WRITE', 'DELETE')));
  assert.match(naoSuportada.message, /^ponte do CRM só autoriza/);

  const { service } = ambiente();
  const opcoes = erroDe(() => service.listRecords(ctx, { filtro: 'x' }));
  assert.match(opcoes.message, /^CRM: opções não reconhecidas/);

  for (const erro of [corrompido, estruturaInvalida, registroInvalido, autorizadorDefeituoso, naoSuportada, opcoes]) {
    assert.deepEqual(mapeado(erro), FIXAS.interno, erro.message);
  }
});

test('[CRM-ERRMAP-7] nenhuma resposta mapeada repete texto da mensagem original: o que o cliente controla (um id, um status, um nome de campo) nunca sai', () => {
  const { service, ctx } = ambiente();
  const hostil = 'crm:<script>alert(1)</script>';
  const erros = [
    erroDe(() => service.getHistory(ctx, hostil)),
    erroDe(() => service.updateRecord(ctx, hostil, {})),
    erroDe(() => service.createRecord(ctx, { empresa: 'X' }, { status: '<img src=x onerror=alert(1)>' })),
    erroDe(() => service.createRecord(ctx, { empresa: 'X', '<b>campo</b>': 1 })),
    erroDe(() => service.moveStatus(ctx, hostil, 'RESEARCH')),
  ];
  for (const erro of erros) {
    assert.ok(/script|<img|<b>/.test(erro.message), 'sanidade: a mensagem ORIGINAL contém o texto hostil');
    const { message } = mapErrorToHttp(erro);
    assert.doesNotMatch(message, /script|<img|<b>|alert|crm:/);
  }
});

test('[CRM-ERRMAP-7b] só o COMEÇO da mensagem classifica: um texto controlado pelo cliente no fim de uma mensagem nunca a reclassifica, e uma mensagem interna com uma frase conhecida no meio continua interna', () => {
  assert.deepEqual(mapeado(new Error('CRM: registro não encontrado: acesso negado')), FIXAS.naoEncontrado);
  assert.deepEqual(mapeado(new Error('CRM: registro não encontrado: CRM: transição não permitida')), FIXAS.naoEncontrado);
  assert.deepEqual(mapeado(new Error('CRM: registro inválido no armazenamento: CRM: registro não encontrado')), FIXAS.interno);
  assert.deepEqual(mapeado(new Error('falha: CRM: registro não encontrado')), FIXAS.interno);
  assert.deepEqual(mapeado(new Error('\nCRM: registro não encontrado')), FIXAS.interno, 'a âncora é o início do texto, não o início de uma linha');
  assert.deepEqual(mapeado(new Error('crm: registro não encontrado')), FIXAS.interno, 'o prefixo é exato, com maiúsculas');
});

// ---------------------------------------------------------------------------
// Varredura: toda mensagem "CRM: ..." possível do código-fonte está classificada
// ---------------------------------------------------------------------------
const FONTES = ['src/crm/crmDomain.js', 'src/crm/crmRepository.js', 'src/crm/crmRepositoryPort.js', 'src/services/crmService.js'];

// As mensagens que NÃO viram um status de cliente — cada uma com o porquê. Qualquer outra "CRM: ..." precisa estar
// mapeada em src/server/app.js (KNOWN_MESSAGES).
const INTERNAS_POR_DESENHO = Object.freeze([
  [/^CRM: registro inválido em /, 'registro sem forma de registro: armazenamento adulterado'],
  [/^CRM: registro corrompido em /, 'registro sem histórico: armazenamento adulterado (falha fechada)'],
  [/^CRM: repositório inválido/, 'defeito de composição/adapter: o servidor injeta um repositório válido'],
  [/^CRM: actor desconhecido/, 'o Service sempre passa HUMAN: só um bug chega aqui'],
  [/^CRM: (?:createRecord|updateRecord|input|patch) deve ser um objeto/, 'a API só entrega objetos simples ao Service'],
  [/^CRM: id de registro não permitido/, 'só o save() com um id gerado pelo domínio, que nunca é um id inseguro'],
  [/^CRM: registro inicial inválido/, 'só na criação do adapter em memória (testes)'],
  [/^CRM: save\(\) exige um registro com id/, 'defeito interno: o domínio sempre grava com id'],
  [/^CRM: arquivo de dados corrompido/, 'armazenamento corrompido: 500 com dica no log (nunca o conteúdo nem o caminho)'],
  [/^CRM: createJsonFileCrmRepository exige/, 'defeito de composição'],
  [/^CRM: as opções devem ser um objeto simples/, 'a API só entrega objetos simples ao Service'],
  [/^CRM: opções não reconhecidas/, 'a API só envia as opções que conhece (status, reason)'],
  [/^CRM: registro inválido no armazenamento/, 'a projeção do Service recusa um registro adulterado'],
]);

// Substituições dos marcadores que só existem no código: cada mensagem é testada com todos os valores possíveis.
const VALORES_DOS_MARCADORES = Object.freeze({ context: ['createRecord', 'updateRecord'], name: ['input', 'patch'], method: ['list', 'getById', 'save'] });

function variantes(modelo) {
  let textos = [modelo];
  for (const [marcador, valores] of Object.entries(VALORES_DOS_MARCADORES)) {
    const token = `\${${marcador}}`;
    textos = textos.flatMap((texto) => (texto.includes(token) ? valores.map((valor) => texto.split(token).join(valor)) : [texto]));
  }
  return textos.map((texto) => texto.replace(/\$\{[^}]*\}/g, 'x'));
}

// Cada `new Error('CRM: ...')` / `new Error(`CRM: ...`)` do código (linhas de comentário ignoradas).
function mensagensLancadas(rel) {
  const codigo = fs
    .readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    .split('\n')
    .filter((linha) => !linha.trim().startsWith('//'))
    .join('\n');
  const modelos = [];
  for (const achado of codigo.matchAll(/new Error\(\s*(['`])(CRM: [\s\S]*?)\1/g)) modelos.push(achado[2]);
  return modelos;
}

test('[CRM-ERRMAP-8] VARREDURA: toda mensagem "CRM: ..." que o domínio, o repositório e o Service podem lançar está classificada — mapeada para um status de cliente ou declarada interna por desenho (500); nenhuma fica sem dono', () => {
  const modelos = FONTES.flatMap((rel) => mensagensLancadas(rel).map((modelo) => ({ rel, modelo })));
  assert.ok(modelos.length >= 35, `a varredura enxergou ${modelos.length} mensagens (esperava pelo menos 35): o extrator quebrou?`);

  const usadasComoInternas = new Set();
  for (const { rel, modelo } of modelos) {
    for (const texto of variantes(modelo)) {
      const interna = INTERNAS_POR_DESENHO.find(([padrao]) => padrao.test(texto));
      const { code } = mapErrorToHttp(new Error(texto));
      if (interna) {
        usadasComoInternas.add(interna[0].source);
        assert.equal(code, 'INTERNAL', `${rel}: "${texto}" está declarada interna, mas o app.js a mapeia para ${code}`);
      } else {
        assert.notEqual(code, 'INTERNAL', `${rel}: "${texto}" não está mapeada em app.js nem declarada interna aqui — decida o que ela é`);
      }
    }
  }
  const obsoletas = INTERNAS_POR_DESENHO.filter(([padrao]) => !usadasComoInternas.has(padrao.source)).map(([padrao]) => padrao.source);
  assert.deepEqual(obsoletas, [], 'toda declaração "interna por desenho" precisa ainda existir no código-fonte');
});

test('[CRM-ERRMAP-9] todo código de erro do CRM que o app.js emite tem status de cliente (4xx) ou 500, mensagem fixa e nenhum campo extra', () => {
  const { service, ctx } = ambiente();
  const alfa = service.createRecord(ctx, ALFA).record;
  const erros = [
    erroDe(() => service.getHistory(ctx, 'crm:x')),
    erroDe(() => service.createRecord(ctx, { empresa: 'X', site: ALFA.site })),
    erroDe(() => service.moveStatus(ctx, alfa.id, 'NAO_EXISTE')),
    erroDe(() => service.updateRecord(ctx, alfa.id, { id: 'x' })),
    new Error('qualquer coisa não catalogada'),
  ];
  for (const erro of erros) {
    const resultado = mapErrorToHttp(erro);
    assert.deepEqual(Object.keys(resultado).sort(), ['code', 'headers', 'message', 'status']);
    assert.ok(resultado.status === 500 || (resultado.status >= 400 && resultado.status < 500));
    assert.equal(typeof resultado.message, 'string');
    assert.ok(resultado.message.length > 0 && resultado.message.length < 120, 'mensagens são curtas e fixas');
  }
});
