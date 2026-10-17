'use strict';

// Fase 2B-3.2B-H2 — o CONTRATO do identificador do usuário (userId) nas Exclusões Permanentes.
//
// O userId do projeto é um TEXTO LIVRE não vazio (src/auth/user.js#defineUser: só `trim`); nunca é convertido para UUID. O serviço grava o userId do
// administrador em `criadoPorUserId` e o adapter o envia ao PostgREST como `created_by_user_id`, EXATAMENTE como veio. Estes testes provam isso com
// o código REAL (serviço, adapter, guarda) e um PostgREST FALSO tipado que aplica as migrations versionadas a um simulador de esquema
// (tests/helpers/migrationSchemaSimulator.js): nenhuma rede, nenhum Supabase, nenhuma chave real, nenhum arquivo de dados, nenhum usuário real
// (todos os nomes, e-mails e ids são fictícios). Provam o CONTRATO VERSIONADO — o tipo da coluna no banco OPERACIONAL não foi consultado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSupabaseProspectingExclusionRepository } = require('../../src/prospecting-adapters/prospectingExclusionSupabaseRepository');
const { createProspectingExclusionService, ERROR, ProspectingExclusionError } = require('../../src/services/prospectingExclusionService');
const { createInMemoryPermanentExclusionRepository } = require('../../src/research-prospector/permanentExclusionRepository');
const { createEnforcedPermanentExclusionGuard } = require('../../src/services/permanentExclusionGuard');
const { authorizeProspectingExclusionOperation, defineUser, ROLE, USER_STATUS } = require('../../src/auth');
const { createAuthorizationContext } = require('../helpers/authFixtures');
const { newSchema, applyMigrations, postgrestTipado } = require('../helpers/migrationSchemaSimulator');

const ORIGINAL = '20260930090000_prospecting_permanent_exclusions.sql';
const CORRETIVA = '20261017090000_prospecting_permanent_exclusions_created_by_text.sql';
const TABELA = 'prospecting_permanent_exclusions';
const SRC = path.join(__dirname, '..', '..', 'src');

const UUID_V4 = '3f2b8c1e-9d4a-4e6b-8a7c-5d1e2f3a4b5c';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Um administrador FICTÍCIO com o userId pedido; o authUserId (a identidade do provedor de login) é sempre outro valor.
const admin = (userId, nome = 'Administrador Fictício') =>
  createAuthorizationContext(defineUser({ userId, authUserId: `auth-diferente-de-${userId}`, name: nome, email: 'admin-ficticio@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE }));

const ENTRADA = { empresa: 'Clínica Fictícia Alfa', cidade: 'Petrópolis', estado: 'RJ', motivo: 'motivo fictício de teste' };

function servicoSobre(schema) {
  const servidor = postgrestTipado({ schema });
  const repository = createSupabaseProspectingExclusionRepository({ url: 'https://exemplo-falso.example.test', serviceRoleKey: 'chave-falsa-de-teste', fetchImpl: servidor.fetchImpl });
  const servico = createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository });
  return { servico, servidor, schema };
}
const comMigrations = (arquivos) => servicoSobre(applyMigrations(arquivos, newSchema()));

async function falha(promessa) {
  try {
    await promessa;
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava um erro e a operação terminou com sucesso');
}

test('[EXCL-UID-1] o contrato do userId: qualquer texto não vazio é aceito (com trim), nada o converte para UUID, e o serviço grava o userId — nunca o authUserId — como autoria', async () => {
  for (const userId of ['user-breno', 'breno', 'rafael', UUID_V4, UUID_V4.toUpperCase()]) {
    const contexto = admin(userId);
    assert.equal(authorizeProspectingExclusionOperation(contexto, 'MANAGE:PROSPECTING_EXCLUSIONS').userId, userId, 'o autorizador devolve o userId como está');
    const servico = createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository: createInMemoryPermanentExclusionRepository([]) });
    const criada = await servico.create(contexto, ENTRADA);
    assert.equal(criada.criadoPorUserId, userId);
    assert.notEqual(criada.criadoPorUserId, `auth-diferente-de-${userId}`, 'a autoria nunca é o authUserId');
  }
  // as pontas são aparadas (defineUser) — e só isso
  assert.equal(admin('  user-breno  ').userId, 'user-breno');
  // sem userId não há USER (o contrato exige texto não vazio, não um UUID)
  assert.throws(() => defineUser({ userId: '   ', authUserId: 'a', name: 'n', email: 'x@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE }), /userId é obrigatório/);

  // "userId não vazio" é regra da APLICAÇÃO (a migration corretiva não cria nenhuma regra de banco): mesmo um autorizador defeituoso que devolva
  // um userId em branco é recusado pelo serviço ANTES de qualquer gravação.
  for (const userIdInvalido of ['', '   ', null, undefined, 42]) {
    let gravacoes = 0;
    const repositorio = { ...createInMemoryPermanentExclusionRepository([]), insert: async () => { gravacoes += 1; return null; } };
    const servicoDefeituoso = createProspectingExclusionService({ authorizeOperation: () => ({ userId: userIdInvalido, name: 'Nome Fictício', role: 'ADMIN' }), repository: repositorio });
    await assert.rejects(servicoDefeituoso.create(admin('user-breno'), ENTRADA), /identidade inválida/, String(userIdInvalido));
    assert.equal(gravacoes, 0, 'nada foi gravado');
  }
});

test('[EXCL-UID-2] PAYLOAD do adapter real: o created_by_user_id enviado é IDÊNTICO ao userId (texto, UUID e UUID em maiúsculas), sem normalizar; o conjunto de campos não mudou e o id da linha é um UUID gerado pela aplicação', async () => {
  const CAMPOS = ['ativo', 'cidade', 'created_by_name', 'created_by_user_id', 'dominio', 'empresa_nome', 'empresa_nome_normalizado', 'estado', 'id', 'motivo', 'pais'];
  for (const userId of ['user-breno', UUID_V4, UUID_V4.toUpperCase()]) {
    const pedidos = [];
    const fetchImpl = async (url, init) => {
      const corpo = JSON.parse(init.body);
      pedidos.push({ metodo: init.method, corpo });
      return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify(corpo.map((l) => ({ ...l, created_at: 'x', updated_at: 'x' }))) };
    };
    const repository = createSupabaseProspectingExclusionRepository({ url: 'https://exemplo-falso.example.test', serviceRoleKey: 'chave-falsa-de-teste', fetchImpl });
    const servico = createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository });
    const criada = await servico.create(admin(userId, 'Nome Fictício Do Admin'), ENTRADA);
    assert.equal(pedidos.length, 1);
    assert.equal(pedidos[0].metodo, 'POST');
    const linha = pedidos[0].corpo[0];
    assert.equal(linha.created_by_user_id, userId, 'idêntico, sem converter nem mudar a caixa');
    assert.equal(linha.created_by_name, 'Nome Fictício Do Admin');
    assert.deepEqual(Object.keys(linha).sort(), CAMPOS, 'o conjunto de campos enviados não mudou');
    assert.match(linha.id, UUID_RE, 'o id da linha é um UUID gerado pela aplicação (a coluna id continua UUID)');
    const texto = JSON.stringify(linha);
    assert.equal(/authUserId|auth-diferente|admin-ficticio@example\.test|ADMIN/.test(texto), false, 'nem o authUserId, nem o e-mail, nem a role vão para o banco');
    assert.equal(criada.criadoPorUserId, userId, 'e a leitura de volta devolve o mesmo valor');
  }
});

test('[EXCL-UID-3] CONTRATO ORIGINAL (só a 20260930090000 aplicada ao simulador): um userId UUID é aceito; um userId TEXTUAL é recusado pelo banco (HTTP 400) e o serviço responde EXCLUSION_PERSISTENCE, sem gravar nada — a incompatibilidade confirmada', async () => {
  const { servico, servidor, schema } = comMigrations([ORIGINAL]);
  const uuidOk = await servico.create(admin(UUID_V4), ENTRADA);
  assert.equal(uuidOk.criadoPorUserId, UUID_V4);

  const erro = await falha(servico.create(admin('user-breno'), { ...ENTRADA, empresa: 'Clínica Fictícia Beta' }));
  assert.ok(erro instanceof ProspectingExclusionError);
  assert.equal(erro.code, ERROR.PERSISTENCE);
  const post = servidor.pedidos.filter((p) => p.metodo === 'POST').at(-1);
  assert.equal(post.corpo[0].created_by_user_id, 'user-breno', 'o adapter enviou o userId tal como é: o recusado é o TIPO da coluna, não o payload');
  assert.equal(schema.tables.get(TABELA).rows.length, 1, 'nada foi gravado pela tentativa recusada');
  assert.equal(/user-breno|22P02|uuid/i.test(erro.message), false, 'a mensagem ao chamador não vaza o userId nem o erro do banco');
});

test('[EXCL-UID-4] CONTRATO CORRIGIDO (a original e depois a corretiva): userId textual, UUID e UUID em maiúsculas são gravados e lidos de volta IDÊNTICOS; a leitura completa e a paginação seguem iguais', async () => {
  const { servico, schema } = comMigrations([ORIGINAL, CORRETIVA]);
  const usuarios = ['user-breno', 'breno', UUID_V4, UUID_V4.toUpperCase()];
  const criadas = [];
  for (const [i, userId] of usuarios.entries()) criadas.push(await servico.create(admin(userId), { ...ENTRADA, empresa: `Clínica Fictícia ${i}`, cidade: 'Niterói' }));
  assert.deepEqual(criadas.map((c) => c.criadoPorUserId), usuarios);
  const lidas = await servico.list(admin('user-breno'));
  assert.equal(lidas.length, 4);
  assert.deepEqual(lidas.map((l) => l.criadoPorUserId).sort(), [...usuarios].sort());
  assert.deepEqual(schema.tables.get(TABELA).rows.map((l) => l.created_by_user_id), usuarios, 'no banco simulado, como texto, sem normalizar');
  assert.equal(new Set(lidas.map((l) => l.id)).size, 4);
  for (const l of lidas) assert.match(l.id, UUID_RE, 'o id continua UUID');

  // editar, desativar e reativar não tocam a autoria
  const alvo = criadas[0];
  const desativada = await servico.deactivate(admin('outro-admin'), alvo.id);
  assert.equal(desativada.ativo, false);
  assert.equal(desativada.criadoPorUserId, 'user-breno', 'quem desativa não vira o autor');
  const reativada = await servico.activate(admin('outro-admin'), alvo.id);
  assert.equal(reativada.criadoPorUserId, 'user-breno');
  const editada = await servico.update(admin('outro-admin'), alvo.id, { motivo: 'motivo fictício novo' });
  assert.equal(editada.criadoPorUserId, 'user-breno');
});

test('[EXCL-UID-5] a autoria é só DADO: a verificação da promoção dá os MESMOS vereditos sobre o Supabase simulado (corrigido) e sobre a memória — confirmada, ambígua, sem correspondência, dados insuficientes — e a guarda obrigatória continua fechada', async () => {
  const { servico } = comMigrations([ORIGINAL, CORRETIVA]);
  const memoria = createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository: createInMemoryPermanentExclusionRepository([]) });
  const cadastros = [
    { empresa: 'Clínica Fictícia Alfa', cidade: 'Petrópolis', estado: 'RJ', motivo: 'm1' },
    { empresa: 'Clínica Fictícia Beta', cidade: 'Niterói', motivo: 'm2' },
    { empresa: 'Nome Que Não Aparece No Candidato', dominio: 'gama.example.test', motivo: 'm3' },
  ];
  for (const [i, c] of cadastros.entries()) {
    await servico.create(admin(i === 0 ? 'user-breno' : UUID_V4), c);
    await memoria.create(admin(i === 0 ? 'user-breno' : UUID_V4), c);
  }
  const candidatos = [
    { empresa: 'Clínica Fictícia Alfa', cidade: 'Petrópolis', estado: 'RJ' }, // confirmada
    { empresa: 'Outra Empresa', site: 'https://www.gama.example.test/pagina' }, // confirmada por domínio
    { empresa: 'Clínica Fictícia Beta' }, // ambígua (falta a cidade que a exclusão exige)
    { empresa: 'Clínica Fictícia Delta', cidade: 'Petrópolis' }, // sem correspondência
    { empresa: '!!!', site: 'gama.example.test' }, // dados insuficientes
  ];
  const esperados = ['CORRESPONDENCIA_CONFIRMADA', 'CORRESPONDENCIA_CONFIRMADA', 'AMBIGUA', 'SEM_CORRESPONDENCIA', 'DADOS_INSUFICIENTES'];
  for (const [i, candidato] of candidatos.entries()) {
    const doSupabase = await servico.verifyCandidate(candidato);
    const daMemoria = await memoria.verifyCandidate(candidato);
    assert.equal(doSupabase.resultado, esperados[i], `candidato ${i}`);
    assert.deepEqual([doSupabase.resultado, doSupabase.exclusaoIds.length], [daMemoria.resultado, daMemoria.exclusaoIds.length], `paridade com a memória no candidato ${i}`);
    assert.deepEqual(Object.keys(doSupabase).sort(), ['exclusaoIds', 'resultado'], 'só ids, como antes');
  }
  // a guarda ENFORCED sobre o mesmo serviço decide igual (confirmada bloqueia; vazio libera)
  const guarda = createEnforcedPermanentExclusionGuard(servico);
  const veredito = await guarda.verify({ empresa: 'Clínica Fictícia Alfa', cidade: 'Petrópolis', estado: 'RJ' });
  assert.equal(veredito.resultado, 'CORRESPONDENCIA_CONFIRMADA');
  const vazio = createEnforcedPermanentExclusionGuard(comMigrations([ORIGINAL, CORRETIVA]).servico);
  assert.equal((await vazio.verify({ empresa: 'Qualquer Empresa Fictícia', cidade: 'Petrópolis', estado: 'RJ' })).resultado, 'SEM_CORRESPONDENCIA');
});

test('[EXCL-UID-6] a LEITURA não depende do tipo: linhas com created_by_user_id textual, UUID ou nulo são lidas (as linhas antigas, gravadas antes da correção com UUID, continuam legíveis)', async () => {
  const schema = applyMigrations([ORIGINAL], newSchema());
  const antiga = comMigrationsJa(schema);
  await antiga.servico.create(admin(UUID_V4), ENTRADA); // gravada ANTES da corretiva, com UUID
  applyMigrations([CORRETIVA], schema); // a corretiva é aplicada com a linha já existente
  const depois = comMigrationsJa(schema);
  await depois.servico.create(admin('user-breno'), { ...ENTRADA, empresa: 'Clínica Fictícia Beta' });
  const lidas = await depois.servico.list(admin('user-breno'));
  assert.deepEqual(lidas.map((l) => l.criadoPorUserId).sort(), [UUID_V4, 'user-breno'].sort());
  assert.equal(lidas.length, 2, 'a linha antiga continua lá, com o mesmo id e a mesma autoria');
});
function comMigrationsJa(schema) {
  return servicoSobre(schema);
}

test('[EXCL-UID-7] a tabela AUSENTE continua identificável pelo caminho real: sem a tabela (nenhuma migration aplicada), ler e gravar falham como indisponíveis (HTTP 404 do PostgREST → EXCLUSION_PERSISTENCE) e nada é criado em silêncio', async () => {
  const { servico, servidor, schema } = servicoSobre(newSchema());
  assert.equal((await falha(servico.list(admin('user-breno')))).code, ERROR.PERSISTENCE);
  assert.equal((await falha(servico.create(admin('user-breno'), ENTRADA))).code, ERROR.PERSISTENCE);
  assert.equal((await falha(servico.verifyCandidate({ empresa: 'Clínica Fictícia Alfa', cidade: 'Petrópolis' }))).code, ERROR.PERSISTENCE, 'a promoção bloquearia (503), nunca liberaria');
  assert.equal(schema.tables.size, 0, 'nenhuma tabela nasceu');
  assert.ok(servidor.pedidos.length >= 3);
});

test('[EXCL-UID-8] NENHUMA conversão ou validação de UUID nos módulos das Exclusões: o userId nunca é checado como UUID (só o id da linha é gerado com randomUUID e o banco usa gen_random_uuid como rede de segurança)', () => {
  const modulos = ['prospecting-adapters/prospectingExclusionSupabaseRepository.js', 'services/prospectingExclusionService.js', 'services/prospectingExclusionRepositoryFactory.js', 'services/permanentExclusionGuard.js', 'research-prospector/permanentExclusion.js', 'research-prospector/permanentExclusionRepository.js', 'auth/prospectingExclusionBridge.js', 'auth/user.js'];
  for (const modulo of modulos) {
    const texto = fs.readFileSync(path.join(SRC, modulo), 'utf8').replace(/randomUUID|gen_random_uuid/g, '');
    assert.doesNotMatch(texto, /uuid/i, `${modulo}: sem tratamento de UUID`);
    assert.doesNotMatch(texto, /[0-9a-f]{8}-\[?[0-9a-f]/i, `${modulo}: sem padrão de UUID`);
  }
});
