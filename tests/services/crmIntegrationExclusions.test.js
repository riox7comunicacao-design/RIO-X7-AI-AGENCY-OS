'use strict';

// Fase 2B-3.2B — EXCLUSÕES PERMANENTES NA PROMOÇÃO (src/services/crmIntegrationService.js, regra 7; decisão 0016).
//
// A brecha provada na auditoria: um lead aprovado por um humano era promovido ao CRM mesmo com uma Exclusão Permanente ativa para a empresa —
// a lista só era consultada na ingestão de achados. Agora, imediatamente antes de CRIAR um registro novo, no servidor, a promoção confere a
// lista inteira com os dados que seriam gravados. O que estes testes protegem:
//   - quatro resultados que NÃO são equivalentes (confirmada / ambígua / sem correspondência / dados insuficientes) e a consulta que falha;
//   - ZERO criação no CRM quando bloqueado, ambíguo, insuficiente ou indisponível;
//   - autorização, aprovação humana e DNC continuam ANTES da consulta; JA_PROMOVIDO e a reconciliação não consultam;
//   - nada da exclusão (nome, motivo, domínio, id) vai para a mensagem ou para o histórico da fila; o snapshot aprovado não muda;
//   - a verificação só LÊ a lista; o histórico de bloqueios não cresce sem limite; falha transitória não grava decisão nenhuma.
//
// Peças REAIS: a fila (domínio e Services), o pipeline de descoberta, o CRM Service sobre o adapter de arquivo, o Service de Exclusões
// Permanentes (repositório em memória OBSERVÁVEL, ou o adapter Supabase real sobre um fetch FALSO). Diretórios temporários, dados fictícios
// (example.test), nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createCrmIntegrationService, PROMOTION_OUTCOME, PROMOTION_ERROR, EXCLUSIONS_CHECK } = require('../../src/services/crmIntegrationService');
const { createProspectingExclusionService } = require('../../src/services/prospectingExclusionService');
const { createInMemoryPermanentExclusionRepository } = require('../../src/research-prospector/permanentExclusionRepository');
const { createSupabaseProspectingExclusionRepository } = require('../../src/prospecting-adapters/prospectingExclusionSupabaseRepository');
const { createEnforcedPermanentExclusionGuard, FILE_MODE_UNVERIFIED } = require('../../src/services/permanentExclusionGuard');
const { authorizeProspectingExclusionOperation, authorizeCrmOperation } = require('../../src/auth');
const queueDomain = require('../../src/research-prospector/approvalQueue');
const { admin, closer, inativo, achado, novoAmbiente, criarServicos, aprovar } = require('../helpers/promotionFixtures');

const { QUEUE_STATE, PROMOTION_BLOCK } = queueDomain;

// Textos que NUNCA podem aparecer numa mensagem de erro, no histórico da fila ou no retorno: tudo o que é da exclusão.
const MOTIVO_PRIVADO = 'MOTIVO-PRIVADO-DA-EXCLUSAO-9f3a';
const DOMINIO_PRIVADO = 'dominio-privado-da-exclusao.example.test';
const NOME_PRIVADO_PARECIDO = 'Nome Privado Cadastrado Na Exclusao';

const MENSAGEM = Object.freeze({
  confirmada: 'Promoção: esta empresa consta nas Exclusões Permanentes de Prospecção',
  ambigua: 'Promoção: há uma Exclusão Permanente com o mesmo nome e a localização deste prospect não permite confirmar se é a mesma empresa — a promoção foi suspensa até uma revisão humana',
  insuficiente: 'Promoção: o prospect não tem dados suficientes (um nome verificável) para conferir as Exclusões Permanentes',
  indisponivel: 'Promoção: não foi possível verificar as Exclusões Permanentes agora; por segurança a promoção foi bloqueada e nenhum registro foi criado no CRM — tente novamente em instantes',
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------------------------------------------

// Um repositório de exclusões em memória que CONTA o que lhe pedem e pode FALHAR sob comando.
function repositorioObservado(inicial = []) {
  const base = createInMemoryPermanentExclusionRepository(inicial);
  const estado = { list: 0, getById: 0, insert: 0, update: 0, falhas: 0, aposListar: null };
  return {
    estado,
    base,
    list() {
      estado.list += 1;
      if (estado.falhas > 0) {
        estado.falhas -= 1;
        throw new Error('banco fora — detalhe interno que não pode vazar');
      }
      return base.list();
    },
    getById: (id) => ((estado.getById += 1), base.getById(id)),
    insert: (linha) => ((estado.insert += 1), base.insert(linha)),
    update: (id, patch) => ((estado.update += 1), base.update(id, patch)),
  };
}

// O CRM Service real, só com a criação CONTADA.
function crmEspiado(crm) {
  const estado = { criacoes: 0 };
  return {
    estado,
    servico: {
      listRecords: (...a) => crm.listRecords(...a),
      getRecord: (...a) => crm.getRecord(...a),
      createRecord: (...a) => ((estado.criacoes += 1), crm.createRecord(...a)),
    },
  };
}

// Um ambiente: a fila e o CRM em arquivos temporários, o Service de exclusões sobre um repositório observável e a PROMOÇÃO com a guarda
// ENFORCED sobre ele. `entradas`: os prospects da fila. `guarda`: troca a guarda (dublês de veredito).
function ambiente(t, entradas, { repositorio = repositorioObservado(), guarda, promocaoDeAuditoria } = {}) {
  const env = novoAmbiente(t, entradas);
  const exclusoes = createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository: repositorio });
  const espiao = crmEspiado(env.crm);
  const servicos = criarServicos(env.queuePath, env.crmPath, { exclusoes: guarda || createEnforcedPermanentExclusionGuard(exclusoes), crm: espiao.servico, ...(promocaoDeAuditoria ? { promocao: promocaoDeAuditoria(env.promocao) } : {}) });
  return {
    ...env,
    repositorio,
    exclusoes,
    crmEspiado: espiao.estado,
    integracao: servicos.integracao,
    excluir: (dados) => exclusoes.create(admin(), { motivo: MOTIVO_PRIVADO, ...dados }),
    promover: (chave, contexto = admin()) => servicos.integracao.promoteProspect(contexto, env.ids[chave]),
    editarFila: (alterar) => {
      const fila = JSON.parse(fs.readFileSync(env.queuePath, 'utf8'));
      alterar(fila);
      fs.writeFileSync(env.queuePath, JSON.stringify(fila, null, 2), 'utf8');
    },
  };
}

const alfa = () => ({ finding: achado('Clínica Alfa', 'clinica-alfa') });
const beta = () => ({ finding: achado('Clínica Beta', 'clinica-beta', { campos: { telefone: [{ valor: '(24) 98765-3000', fonte: 'Fonte de teste', tipoFonte: 'OFICIAL' }], whatsapp: [{ valor: '+55 24 98765-4000', fonte: 'Fonte de teste', tipoFonte: 'OFICIAL' }] } }) });
// um prospect SEM cidade nem estado (a geografia é opcional no achado)
const alfaSemGeografia = () => ({ finding: achado('Clínica Alfa', 'clinica-alfa', { cidade: undefined, estado: undefined }) });

async function recusa(fn, codigo, mensagem) {
  let erro;
  try {
    await fn();
  } catch (e) {
    erro = e;
  }
  assert.ok(erro, 'esperava uma recusa e a operação terminou');
  assert.equal(erro.code, codigo, `code esperado ${codigo}, veio ${erro.code}: ${erro.message}`);
  if (mensagem) assert.equal(erro.message, mensagem);
  return erro;
}

const ultimaEntrada = (item) => item.historico[item.historico.length - 1];
const entradasDeBloqueio = (item) => item.historico.filter((e) => e.promocao && e.promocao.resultado === 'BLOQUEADO');
const semDadosDaExclusao = (valor, rotulo) => {
  const texto = JSON.stringify(valor);
  for (const privado of [MOTIVO_PRIVADO, DOMINIO_PRIVADO, NOME_PRIVADO_PARECIDO, 'banco fora']) assert.equal(texto.includes(privado), false, `${rotulo}: "${privado}" não pode aparecer`);
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Correspondência CONFIRMADA
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-PROMO-1] exclusão cadastrada ANTES da aprovação: o humano aprova, a promoção é BLOQUEADA — nada é criado no CRM, o item continua aprovado e a recusa fica auditada sem nenhum dado da exclusão', async (t) => {
  const env = ambiente(t, { a: alfa() });
  const exclusao = await env.excluir({ empresa: 'Clínica Alfa', cidade: 'Petrópolis', estado: 'RJ' });
  aprovar(env, 'a'); // a aprovação humana em si continua possível
  const snapshotAntes = JSON.parse(JSON.stringify(env.itemDaFila('a').discoverySnapshot));

  const erro = await recusa(async () => await env.promover('a'), PROMOTION_ERROR.BLOCKED_EXCLUSION, MENSAGEM.confirmada);
  assert.equal(erro.auditoriaGravada, true);
  assert.equal(env.crmEspiado.criacoes, 0, 'createRecord nem foi chamado');
  assert.deepEqual(env.registrosDoCrm(), [], 'nenhum registro no CRM');
  const item = env.itemDaFila('a');
  assert.equal(item.estado, QUEUE_STATE.APROVADO_PARA_CRM, 'a máquina de estados não mudou');
  assert.equal(item.promocao, undefined);
  assert.deepEqual(item.discoverySnapshot, snapshotAntes, 'o snapshot aprovado não foi tocado');
  const bloqueios = entradasDeBloqueio(item);
  assert.equal(bloqueios.length, 1);
  assert.deepEqual(bloqueios[0].promocao, { resultado: 'BLOQUEADO', codigo: PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, crmRecordId: null });
  assert.equal(bloqueios[0].motivo, 'Promoção bloqueada: esta empresa consta nas Exclusões Permanentes de Prospecção');
  semDadosDaExclusao([erro.message, bloqueios, item.historico], 'confirmada');
  assert.equal(JSON.stringify([erro.message, item.historico]).includes(exclusao.id), false, 'nem o id da exclusão');
});

test('[EXCL-PROMO-2] exclusão cadastrada DEPOIS da aprovação também bloqueia; e a consulta é ao vivo — desativada a exclusão, a MESMA aprovação é promovida (nada foi gravado como decisão sobre a empresa)', async (t) => {
  const env = ambiente(t, { a: alfa() });
  aprovar(env, 'a');
  const exclusao = await env.excluir({ empresa: 'clinica alfa' }); // só nome (sem geografia), com outra grafia
  await recusa(async () => await env.promover('a'), PROMOTION_ERROR.BLOCKED_EXCLUSION, MENSAGEM.confirmada);
  assert.equal(env.crmEspiado.criacoes, 0);

  await env.exclusoes.deactivate(admin(), exclusao.id);
  const promovido = await env.promover('a');
  assert.equal(promovido.outcome, PROMOTION_OUTCOME.CRIADO);
  assert.equal(promovido.exclusoes, EXCLUSIONS_CHECK.VERIFICADA);
  assert.equal(env.registrosDoCrm().length, 1);
  assert.equal(env.crmEspiado.criacoes, 1);
});

test('[EXCL-PROMO-3] a verificação só LÊ: nenhuma tentativa de promoção insere, atualiza ou desativa exclusão — a lista é a mesma depois', async (t) => {
  const env = ambiente(t, { a: alfa() });
  await env.excluir({ empresa: 'Clínica Alfa' });
  aprovar(env, 'a');
  const listaAntes = JSON.parse(JSON.stringify(env.repositorio.base.list()));
  const escritasAntes = { insert: env.repositorio.estado.insert, update: env.repositorio.estado.update };
  for (let i = 0; i < 3; i += 1) await recusa(async () => await env.promover('a'), PROMOTION_ERROR.BLOCKED_EXCLUSION);
  assert.deepEqual(env.repositorio.base.list(), listaAntes, 'a lista de exclusões é idêntica');
  assert.deepEqual({ insert: env.repositorio.estado.insert, update: env.repositorio.estado.update }, escritasAntes);
  assert.equal(env.repositorio.base.list()[0].ativo, true, 'a exclusão continua ativa: nenhuma é retirada automaticamente');
});

test('[EXCL-PROMO-4] correspondência por NOME + GEOGRAFIA: bate quando cidade e estado conferem; a mesma empresa em OUTRA cidade ou estado não é bloqueada', async (t) => {
  const outraCidade = ambiente(t, { a: alfa() });
  await outraCidade.excluir({ empresa: 'Clínica Alfa', cidade: 'Niterói', estado: 'RJ' });
  aprovar(outraCidade, 'a');
  assert.equal((await outraCidade.promover('a')).outcome, PROMOTION_OUTCOME.CRIADO, 'o prospect é de Petrópolis: a exclusão de Niterói não se aplica');

  const outroEstado = ambiente(t, { a: alfa() });
  await outroEstado.excluir({ empresa: 'Clínica Alfa', cidade: 'Petrópolis', estado: 'SP' });
  aprovar(outroEstado, 'a');
  assert.equal((await outroEstado.promover('a')).outcome, PROMOTION_OUTCOME.CRIADO);

  const igual = ambiente(t, { a: alfa() });
  await igual.excluir({ empresa: 'Clínica Alfa', cidade: 'PETRÓPOLIS', estado: 'rj' });
  aprovar(igual, 'a');
  await recusa(async () => await igual.promover('a'), PROMOTION_ERROR.BLOCKED_EXCLUSION);
  assert.equal(igual.crmEspiado.criacoes, 0);
});

test('[EXCL-PROMO-5] correspondência por DOMÍNIO: o site do snapshot aprovado bate com o domínio da exclusão mesmo com outro nome — e o domínio da exclusão não vaza', async (t) => {
  const env = ambiente(t, { a: alfa() });
  await env.excluir({ empresa: NOME_PRIVADO_PARECIDO, dominio: 'clinica-alfa.example.test' });
  aprovar(env, 'a');
  const erro = await recusa(async () => await env.promover('a'), PROMOTION_ERROR.BLOCKED_EXCLUSION, MENSAGEM.confirmada);
  semDadosDaExclusao([erro.message, env.itemDaFila('a').historico], 'domínio');
  assert.equal(env.crmEspiado.criacoes, 0);
});

test('[EXCL-PROMO-6] nome PARECIDO sem correspondência: a promoção segue (resultado VERIFICADA — e isso nunca é gravado como "liberado")', async (t) => {
  const env = ambiente(t, { a: alfa() });
  await env.excluir({ empresa: 'Clínica Alfa Plus' });
  await env.excluir({ empresa: 'Alfa' });
  await env.excluir({ empresa: 'Nome Totalmente Diferente', dominio: DOMINIO_PRIVADO });
  aprovar(env, 'a');
  const promovido = await env.promover('a');
  assert.equal(promovido.outcome, PROMOTION_OUTCOME.CRIADO);
  assert.equal(promovido.exclusoes, EXCLUSIONS_CHECK.VERIFICADA);
  assert.equal(JSON.stringify(env.itemDaFila('a')).includes('LIBERADO'), false, 'nenhuma decisão "liberado" é gravada');
  assert.equal(entradasDeBloqueio(env.itemDaFila('a')).length, 0);
});

test('[EXCL-PROMO-7] exclusão INATIVA e lista realmente VAZIA: a promoção segue; a lista foi consultada uma vez', async (t) => {
  const inativa = ambiente(t, { a: alfa() });
  const criada = await inativa.excluir({ empresa: 'Clínica Alfa' });
  await inativa.exclusoes.deactivate(admin(), criada.id);
  aprovar(inativa, 'a');
  assert.equal((await inativa.promover('a')).exclusoes, EXCLUSIONS_CHECK.VERIFICADA);

  const vazia = ambiente(t, { a: alfa() });
  aprovar(vazia, 'a');
  vazia.repositorio.estado.list = 0;
  assert.equal((await vazia.promover('a')).exclusoes, EXCLUSIONS_CHECK.VERIFICADA);
  assert.equal(vazia.repositorio.estado.list, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// AMBÍGUA e DADOS INSUFICIENTES
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-PROMO-8] identidade AMBÍGUA: o prospect não tem a cidade que a exclusão de mesmo nome exige — a promoção é SUSPENSA (código próprio, auditoria própria), nunca registrada como correspondência confirmada', async (t) => {
  const env = ambiente(t, { a: alfaSemGeografia() });
  const exclusao = await env.excluir({ empresa: 'Clínica Alfa', cidade: 'Petrópolis', estado: 'RJ' });
  aprovar(env, 'a');
  const snapshot = env.itemDaFila('a').discoverySnapshot;
  assert.ok(!snapshot.cidade && !snapshot.estadoUf, 'pré-condição: o prospect aprovado não tem geografia');

  const erro = await recusa(async () => await env.promover('a'), PROMOTION_ERROR.EXCLUSION_AMBIGUOUS, MENSAGEM.ambigua);
  assert.notEqual(erro.code, PROMOTION_ERROR.BLOCKED_EXCLUSION, 'não é uma exclusão confirmada');
  assert.equal(env.crmEspiado.criacoes, 0);
  assert.deepEqual(env.registrosDoCrm(), []);
  const bloqueios = entradasDeBloqueio(env.itemDaFila('a'));
  assert.equal(bloqueios.length, 1);
  assert.equal(bloqueios[0].promocao.codigo, PROMOTION_BLOCK.EXCLUSAO_AMBIGUA, 'a auditoria diz AMBÍGUA, não EXCLUSAO_PERMANENTE');
  assert.equal(env.itemDaFila('a').estado, QUEUE_STATE.APROVADO_PARA_CRM);
  semDadosDaExclusao([erro.message, bloqueios], 'ambígua');
  assert.equal(JSON.stringify(bloqueios).includes(exclusao.id), false);

  // a revisão humana: o ADMIN desativa (ou ajusta) a exclusão e a MESMA aprovação segue
  await env.exclusoes.deactivate(admin(), exclusao.id);
  assert.equal((await env.promover('a')).outcome, PROMOTION_OUTCOME.CRIADO);
});

test('[EXCL-PROMO-9] a ambiguidade NÃO bloqueia na ingestão (regra preservada) mas bloqueia na promoção; uma contradição geográfica confirmada a desfaz', async (t) => {
  const { matchesExclusion } = require('../../src/research-prospector/permanentExclusion');
  const exclusaoComGeo = { ativo: true, empresa: 'Clínica Alfa', empresaNomeNormalizado: 'clinica alfa', cidade: 'Petrópolis', estado: 'RJ', dominio: null };
  assert.equal(matchesExclusion({ empresa: 'Clínica Alfa' }, exclusaoComGeo), false, 'a ingestão deixa passar');
  const env = ambiente(t, { a: { finding: achado('Clínica Alfa', 'clinica-alfa', { cidade: 'Niterói', estado: undefined }) } });
  await env.excluir({ empresa: 'Clínica Alfa', cidade: 'Petrópolis', estado: 'RJ' });
  aprovar(env, 'a');
  assert.equal((await env.promover('a')).outcome, PROMOTION_OUTCOME.CRIADO, 'cidade DIFERENTE (e estado ausente) é outra cidade, não ambiguidade');
});

test('[EXCL-PROMO-10] DADOS INSUFICIENTES para verificar a identidade (sem um nome verificável): bloqueio próprio, a lista NEM é consultada, nada é criado', async (t) => {
  const env = ambiente(t, { a: alfa() });
  await env.excluir({ empresa: 'Qualquer Outra Empresa' });
  aprovar(env, 'a');
  env.editarFila((fila) => {
    const item = fila.items[env.ids.a];
    item.empresa = '!!!';
    item.discoverySnapshot.empresa = '!!!';
  });
  env.repositorio.estado.list = 0;

  const erro = await recusa(async () => await env.promover('a'), PROMOTION_ERROR.EXCLUSION_IDENTITY_INSUFFICIENT, MENSAGEM.insuficiente);
  assert.equal(env.repositorio.estado.list, 0, 'sem nome verificável não há o que consultar');
  assert.equal(env.crmEspiado.criacoes, 0);
  const bloqueios = entradasDeBloqueio(env.itemDaFila('a'));
  assert.equal(bloqueios.length, 1);
  assert.equal(bloqueios[0].promocao.codigo, PROMOTION_BLOCK.EXCLUSAO_NAO_VERIFICAVEL);
  semDadosDaExclusao(erro.message, 'insuficiente');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Consulta que FALHA (indisponível) — bloqueia, sem registro e sem decisão gravada
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-PROMO-11] FALHA DE PERSISTÊNCIA na consulta: 503 estável, ZERO registros, NENHUMA linha de auditoria (uma falha transitória não é uma decisão sobre a empresa) — e depois da recuperação a MESMA aprovação é promovida', async (t) => {
  const env = ambiente(t, { a: alfa() });
  aprovar(env, 'a');
  env.repositorio.estado.falhas = 3;
  const filaAntes = env.textoDaFila();
  const crmAntes = env.textoDoCrm();
  for (let i = 0; i < 3; i += 1) {
    const erro = await recusa(async () => await env.promover('a'), PROMOTION_ERROR.EXCLUSION_CHECK_UNAVAILABLE, MENSAGEM.indisponivel);
    semDadosDaExclusao(erro.message, 'indisponível');
    assert.equal(erro.cause, undefined, 'nenhuma causa com detalhes internos');
  }
  assert.equal(env.crmEspiado.criacoes, 0);
  assert.equal(env.textoDaFila(), filaAntes, 'a fila ficou byte a byte igual: nada foi auditado');
  assert.equal(env.textoDoCrm(), crmAntes);
  assert.equal(env.itemDaFila('a').promocao, undefined);

  assert.equal((await env.promover('a')).outcome, PROMOTION_OUTCOME.CRIADO, 'a lista voltou: a promoção segue');
});

test('[EXCL-PROMO-12] ERROS INESPERADOS e vereditos inválidos da guarda (null, vazio, texto, objeto desconhecido, promessa rejeitada com texto): todos viram INDISPONÍVEL — nunca "liberado"', async (t) => {
  const invalidos = [
    ['undefined', async () => undefined],
    ['null', async () => null],
    ['texto', async () => 'SEM_CORRESPONDENCIA'],
    ['lista', async () => [{ resultado: 'SEM_CORRESPONDENCIA' }]],
    ['objeto vazio', async () => ({})],
    ['veredito desconhecido', async () => ({ resultado: 'LIBERADO' })],
    ['booleano', async () => false],
    ['lança Error', async () => { throw new Error('boom'); }],
    ['lança texto', async () => { throw 'texto solto'; }],
    ['lança null', async () => { throw null; }],
    ['síncrona que lança', () => { throw new TypeError('x'); }],
  ];
  for (const [nome, verify] of invalidos) {
    const env = ambiente(t, { a: alfa() }, { guarda: { mode: 'ENFORCED', verify } });
    aprovar(env, 'a');
    await recusa(async () => await env.promover('a'), PROMOTION_ERROR.EXCLUSION_CHECK_UNAVAILABLE, MENSAGEM.indisponivel);
    assert.equal(env.crmEspiado.criacoes, 0, nome);
    assert.deepEqual(env.registrosDoCrm(), [], nome);
  }
  // o veredito válido de um dublê segue normalmente
  const ok = ambiente(t, { a: alfa() }, { guarda: { mode: 'ENFORCED', verify: async () => ({ resultado: 'SEM_CORRESPONDENCIA', exclusaoIds: [] }) } });
  aprovar(ok, 'a');
  assert.equal((await ok.promover('a')).outcome, PROMOTION_OUTCOME.CRIADO);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Ordem: autorização, aprovação e DNC ANTES da consulta
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-PROMO-13] AUTORIZAÇÃO antes da consulta: o closer (sem WRITE:CRM), um usuário inativo e um prospect não aprovado/inexistente são recusados SEM tocar a lista de exclusões — quem não pode promover não consegue sondá-la', async (t) => {
  const env = ambiente(t, { a: alfa(), b: beta() });
  await env.excluir({ empresa: 'Clínica Alfa' });
  aprovar(env, 'a');
  env.repositorio.estado.list = 0;
  const filaAntes = env.textoDaFila();

  await assert.rejects(async () => await env.promover('a', closer()), /WRITE:CRM|permiss|autoriza/i, 'o closer');
  await assert.rejects(async () => await env.promover('a', inativo()), /inativ|autoriza|negado/i, 'usuário inativo');
  await recusa(async () => await env.promover('b'), PROMOTION_ERROR.NOT_APPROVED); // pendente
  await recusa(async () => await env.integracao.promoteProspect(admin(), 'id:inexistente'), PROMOTION_ERROR.PROSPECT_NOT_FOUND);
  await recusa(async () => await env.integracao.promoteProspect(admin(), ''), PROMOTION_ERROR.INVALID_INPUT);
  await recusa(async () => await env.integracao.promoteProspect(admin(), env.ids.a, { reviewedBy: 'x' }), PROMOTION_ERROR.INVALID_INPUT);
  assert.equal(env.repositorio.estado.list, 0, 'a lista de exclusões nunca foi consultada');
  assert.equal(env.textoDaFila(), filaAntes, 'e nada foi auditado');
  assert.equal(env.crmEspiado.criacoes, 0);
});

test('[EXCL-PROMO-14] aprovação HUMANA antes da consulta: um item que só DIZ "aprovado" no arquivo (sem a entrada humana) é recusado sem consultar a lista', async (t) => {
  const env = ambiente(t, { a: alfa() });
  env.editarFila((fila) => {
    fila.items[env.ids.a].estado = QUEUE_STATE.APROVADO_PARA_CRM; // forjado: sem aprovação no histórico
  });
  await recusa(async () => await env.promover('a'), PROMOTION_ERROR.APPROVAL_MISSING);
  assert.equal(env.repositorio.estado.list, 0);
  assert.equal(env.crmEspiado.criacoes, 0);
});

test('[EXCL-PROMO-15] DNC antes da consulta: o snapshot BLOQUEADO é recusado como DNC sem consultar a lista; e o DNC do CRM (recusa do domínio na criação) continua valendo depois de uma consulta sem correspondência', async (t) => {
  const porSnapshot = ambiente(t, { a: alfa() });
  aprovar(porSnapshot, 'a');
  porSnapshot.editarFila((fila) => {
    fila.items[porSnapshot.ids.a].discoverySnapshot.statusDNC = 'BLOQUEADO';
  });
  porSnapshot.repositorio.estado.list = 0;
  await recusa(async () => await porSnapshot.promover('a'), PROMOTION_ERROR.BLOCKED_DNC);
  assert.equal(porSnapshot.repositorio.estado.list, 0, 'o DNC vem antes');
  assert.equal(porSnapshot.crmEspiado.criacoes, 0);

  const porCrm = ambiente(t, { a: alfa() });
  aprovar(porCrm, 'a');
  const bloqueado = (await porCrm.crm.createRecord(admin(), { empresa: 'Registro bloqueado', site: 'clinica-alfa.example.test' })).record;
  await porCrm.crm.markDoNotContact(admin(), bloqueado.id, { reason: 'pediu para não ser contatado' });
  porCrm.repositorio.estado.list = 0;
  await recusa(async () => await porCrm.promover('a'), PROMOTION_ERROR.BLOCKED_DNC);
  assert.equal(porCrm.repositorio.estado.list, 1, 'a consulta aconteceu (sem correspondência) e o domínio do CRM recusou na criação');
  assert.equal(porCrm.crmEspiado.criacoes, 1, 'foi a recusa do domínio do CRM, não a das exclusões');
});

test('[EXCL-PROMO-16] a duplicidade do CRM continua recusada pelo domínio do CRM (depois da consulta sem correspondência): nenhum registro duplicado', async (t) => {
  const env = ambiente(t, { a: alfa() });
  aprovar(env, 'a');
  await env.crm.createRecord(admin(), { empresa: 'Já existente', site: 'clinica-alfa.example.test' });
  await recusa(async () => await env.promover('a'), PROMOTION_ERROR.BLOCKED_DUPLICATE);
  assert.equal(env.registrosDoCrm().length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// JA_PROMOVIDO, reconciliação e idempotência
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-PROMO-17] JA_PROMOVIDO: depois de promovida, uma exclusão nova NÃO reabre nem remove o registro — a promoção repetida devolve JA_PROMOVIDO sem consultar a lista nem gravar nada', async (t) => {
  const env = ambiente(t, { a: alfa() });
  aprovar(env, 'a');
  const primeira = await env.promover('a');
  assert.equal(primeira.outcome, PROMOTION_OUTCOME.CRIADO);
  await env.excluir({ empresa: 'Clínica Alfa' });
  env.repositorio.estado.list = 0;
  const crmAntes = env.textoDoCrm();
  const filaAntes = env.textoDaFila();

  const repetida = await env.promover('a');
  assert.equal(repetida.outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
  assert.equal(repetida.crmRecordId, primeira.crmRecordId);
  assert.equal(repetida.exclusoes, null, 'nada foi verificado: nenhum registro novo');
  assert.equal(env.repositorio.estado.list, 0);
  assert.equal(env.textoDoCrm(), crmAntes);
  assert.equal(env.textoDaFila(), filaAntes);
});

test('[EXCL-PROMO-18] RECONCILIAÇÃO: o CRM foi gravado e a fila não (falha no meio); uma exclusão aparece antes da repetição — a repetição RECONCILIA a fila com o registro que já existe, sem consultar a lista e sem criar outro', async (t) => {
  let falhas = 1;
  const env = ambiente(t, { a: alfa() }, {
    promocaoDeAuditoria: (promocao) => ({
      recordPromotion: (...args) => {
        if (falhas > 0) {
          falhas -= 1;
          throw new Error('falha de gravação da fila (simulada)');
        }
        return promocao.recordPromotion(...args);
      },
      recordPromotionBlocked: (...args) => promocao.recordPromotionBlocked(...args),
    }),
  });
  aprovar(env, 'a');
  await recusa(async () => await env.promover('a'), PROMOTION_ERROR.PARTIAL);
  assert.equal(env.registrosDoCrm().length, 1, 'o registro existe');
  assert.equal(env.repositorio.estado.list, 1);

  await env.excluir({ empresa: 'Clínica Alfa' });
  const crmAntes = env.textoDoCrm();
  const reconciliado = await env.promover('a');
  assert.equal(reconciliado.outcome, PROMOTION_OUTCOME.RECONCILIADO);
  assert.equal(env.repositorio.estado.list, 1, 'a reconciliação não consultou a lista');
  assert.equal(env.textoDoCrm(), crmAntes, 'o registro do CRM não foi tocado');
  assert.equal(env.registrosDoCrm().length, 1);
  assert.equal((await env.promover('a')).outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Modo arquivo: o marcador explícito
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-PROMO-19] MODO ARQUIVO (marcador explícito): a promoção segue, o resultado diz que a verificação NÃO está disponível — e nenhuma lista é consultada', async (t) => {
  const env = ambiente(t, { a: alfa(), b: beta() }, { guarda: FILE_MODE_UNVERIFIED });
  await env.excluir({ empresa: 'Clínica Alfa' }); // existe no repositório de teste, mas o modo arquivo não o consulta
  aprovar(env, 'a');
  aprovar(env, 'b');
  env.repositorio.estado.list = 0;
  const promovido = await env.promover('a');
  assert.equal(promovido.outcome, PROMOTION_OUTCOME.CRIADO);
  assert.equal(promovido.exclusoes, EXCLUSIONS_CHECK.NAO_DISPONIVEL_MODO_ARQUIVO);
  assert.equal(env.repositorio.estado.list, 0);
  assert.notEqual(promovido.exclusoes, EXCLUSIONS_CHECK.VERIFICADA, 'não comprova a ausência de exclusões');
});

test('[EXCL-PROMO-20] sem a guarda o serviço NÃO existe (nada de dependência opcional silenciosa), em qualquer forma de omissão', (t) => {
  const env = novoAmbiente(t, { a: alfa() });
  const base = { approvalQueueService: env.fila, approvalPromotionService: env.promocao, crmService: env.crm, authorizeOperation: authorizeCrmOperation };
  for (const omissao of [{}, { permanentExclusions: undefined }, { permanentExclusions: null }, { permanentExclusions: false }, { permanentExclusions: {} }, { permanentExclusions: { mode: 'FILE_MODE_UNVERIFIED' } }]) {
    assert.throws(() => createCrmIntegrationService({ ...base, ...omissao }), /exige \{ permanentExclusions \}/, JSON.stringify(omissao));
  }
  assert.doesNotThrow(() => createCrmIntegrationService({ ...base, permanentExclusions: FILE_MODE_UNVERIFIED }));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// O que é enviado à verificação, auditoria proporcional e concorrência
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-PROMO-21] a verificação recebe SÓ o que seria gravado como identidade — empresa, cidade, estado e site do snapshot aprovado; telefone, e-mail, canais e observações nunca', async (t) => {
  const recebidos = [];
  const env = ambiente(t, { a: beta() }, { guarda: { mode: 'ENFORCED', verify: async (candidato) => (recebidos.push(candidato), { resultado: 'SEM_CORRESPONDENCIA', exclusaoIds: [] }) } });
  aprovar(env, 'a');
  await env.promover('a');
  assert.equal(recebidos.length, 1);
  assert.deepEqual(recebidos[0], { empresa: 'Clínica Beta', cidade: 'Petrópolis', estado: 'RJ', site: 'clinica-beta.example.test' });
  const registro = env.registrosDoCrm()[0];
  assert.equal(registro.empresa, recebidos[0].empresa, 'é o mesmo que foi gravado');
  assert.equal(registro.site, recebidos[0].site);
  assert.equal(Object.isFrozen(recebidos[0]), false);
});

test('[EXCL-PROMO-22] AUDITORIA PROPORCIONAL: tentativas repetidas da MESMA recusa, pela mesma pessoa, viram UMA linha com contador; outra pessoa ou outro motivo abrem linha própria; falhas transitórias não gravam linha nenhuma', async (t) => {
  const env = ambiente(t, { a: alfa() });
  await env.excluir({ empresa: 'Clínica Alfa' });
  aprovar(env, 'a');
  const inicial = env.itemDaFila('a').historico.length;

  for (let i = 0; i < 10; i += 1) await recusa(async () => await env.promover('a'), PROMOTION_ERROR.BLOCKED_EXCLUSION);
  let item = env.itemDaFila('a');
  assert.equal(item.historico.length, inicial + 1, 'dez tentativas, uma linha');
  assert.equal(ultimaEntrada(item).promocao.tentativas, 10);
  assert.ok(typeof ultimaEntrada(item).promocao.ultimaTentativaEm === 'string');
  assert.equal(ultimaEntrada(item).motivo, 'Promoção bloqueada: esta empresa consta nas Exclusões Permanentes de Prospecção (10 tentativas)');
  assert.equal(ultimaEntrada(item).reviewedBy.userId, 'user-admin-promo');

  // outra pessoa: linha própria
  const outroAdmin = admin({ userId: 'user-admin-outro', authUserId: 'auth-admin-outro', name: 'Outro Administrador', email: 'outro-admin@example.test' });
  await recusa(async () => await env.promover('a', outroAdmin), PROMOTION_ERROR.BLOCKED_EXCLUSION);
  item = env.itemDaFila('a');
  assert.equal(item.historico.length, inicial + 2);
  assert.equal(ultimaEntrada(item).reviewedBy.userId, 'user-admin-outro');
  assert.equal(ultimaEntrada(item).promocao.tentativas, undefined, 'a nova linha começa sem contador');

  // falhas transitórias: nenhuma linha
  env.repositorio.estado.falhas = 20;
  const antes = env.textoDaFila();
  for (let i = 0; i < 20; i += 1) await recusa(async () => await env.promover('a'), PROMOTION_ERROR.EXCLUSION_CHECK_UNAVAILABLE);
  assert.equal(env.textoDaFila(), antes);
});

test('[EXCL-PROMO-23] a soma de tentativas vale só para as recusas de exclusão: o DNC repetido continua uma linha por tentativa (comportamento de antes)', async (t) => {
  const env = ambiente(t, { a: alfa() });
  aprovar(env, 'a');
  env.editarFila((fila) => {
    fila.items[env.ids.a].discoverySnapshot.statusDNC = 'BLOQUEADO';
  });
  const inicial = env.itemDaFila('a').historico.length;
  for (let i = 0; i < 3; i += 1) await recusa(async () => await env.promover('a'), PROMOTION_ERROR.BLOCKED_DNC);
  assert.equal(env.itemDaFila('a').historico.length, inicial + 3);
});

test('[EXCL-PROMO-24] CONCORRÊNCIA entre duas solicitações do mesmo prospect: sem exclusão, um CRIADO e um JA_PROMOVIDO (uma só consulta, um só registro); com exclusão, as duas bloqueadas, nada criado e UMA linha de auditoria com 2 tentativas', async (t) => {
  const livre = ambiente(t, { a: alfa() });
  aprovar(livre, 'a');
  livre.repositorio.estado.list = 0;
  const [x, y] = await Promise.all([livre.promover('a'), livre.promover('a')]);
  assert.deepEqual([x.outcome, y.outcome].sort(), [PROMOTION_OUTCOME.CRIADO, PROMOTION_OUTCOME.JA_PROMOVIDO]);
  assert.equal(livre.registrosDoCrm().length, 1);
  assert.equal(livre.repositorio.estado.list, 1, 'a segunda solicitação viu a primeira e não consultou de novo');

  const barrado = ambiente(t, { a: alfa() });
  await barrado.excluir({ empresa: 'Clínica Alfa' });
  aprovar(barrado, 'a');
  const inicial = barrado.itemDaFila('a').historico.length;
  const resultados = await Promise.allSettled([barrado.promover('a'), barrado.promover('a')]);
  assert.deepEqual(resultados.map((r) => [r.status, r.reason && r.reason.code]), [['rejected', PROMOTION_ERROR.BLOCKED_EXCLUSION], ['rejected', PROMOTION_ERROR.BLOCKED_EXCLUSION]]);
  assert.equal(barrado.crmEspiado.criacoes, 0);
  assert.equal(barrado.itemDaFila('a').historico.length, inicial + 1);
  assert.equal(ultimaEntrada(barrado.itemDaFila('a')).promocao.tentativas, 2);
});

test('[EXCL-PROMO-25] LIMITAÇÃO DOCUMENTADA (decisão 0016): uma exclusão cadastrada ENTRE a consulta e a criação NÃO impede a criação desse registro — não há transação entre o repositório de exclusões e o CRM; a janela é a de uma chamada, e nada a fecha. Depois disso a exclusão não retira o registro e a promoção repetida é JA_PROMOVIDO', async (t) => {
  const repositorio = repositorioObservado();
  const exclusoes = createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository: repositorio });
  const real = createEnforcedPermanentExclusionGuard(exclusoes);
  const env = ambiente(t, { a: alfa() }, {
    repositorio,
    guarda: {
      mode: 'ENFORCED',
      verify: async (candidato) => {
        const veredito = await real.verify(candidato); // a consulta termina "sem correspondência"...
        await exclusoes.create(admin(), { empresa: 'Clínica Alfa', motivo: MOTIVO_PRIVADO }); // ...e a exclusão aparece logo depois dela
        return veredito;
      },
    },
  });
  aprovar(env, 'a');
  const promovido = await env.promover('a');
  assert.equal(promovido.outcome, PROMOTION_OUTCOME.CRIADO, 'a janela existe');
  assert.equal(env.registrosDoCrm().length, 1);
  assert.equal(repositorio.base.list().filter((e) => e.ativo).length, 1, 'a exclusão ficou ativa');

  const repetida = await env.promover('a');
  assert.equal(repetida.outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
  assert.equal(env.registrosDoCrm().length, 1, 'nada é removido nem duplicado');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Supabase: o adapter REAL sobre um fetch FALSO, pela promoção inteira
// ---------------------------------------------------------------------------------------------------------------------------------
function postgrestFalso({ todas = [], teto = 1000, total = todas.length, falha, corpo, range } = {}) {
  const pedidos = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    pedidos.push(u);
    if (falha === 'rede') throw new TypeError('fetch failed');
    if (typeof falha === 'number') return { ok: false, status: falha, headers: { get: () => null }, text: async () => '{"message":"detalhe interno do supabase"}' };
    const offset = Number(u.searchParams.get('offset'));
    const limit = Number(u.searchParams.get('limit'));
    const fatia = todas.slice(offset, offset + Math.min(limit, teto));
    const texto = corpo !== undefined ? corpo : JSON.stringify(fatia);
    const faixa = range !== undefined ? range : fatia.length === 0 ? `*/${total}` : `${offset}-${offset + fatia.length - 1}/${total}`;
    return { ok: true, status: 200, headers: { get: (nome) => (String(nome).toLowerCase() === 'content-range' ? faixa : null) }, text: async () => texto };
  };
  return { fetchImpl, pedidos };
}
const linhaSupabase = (n, extra = {}) => ({ id: `id-${String(n).padStart(5, '0')}`, empresa_nome: `Empresa Fictícia ${n}`, empresa_nome_normalizado: `empresa ficticia ${n}`, cidade: null, estado: null, pais: 'Brasil', dominio: null, motivo: MOTIVO_PRIVADO, ativo: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', created_by_user_id: null, created_by_name: null, ...extra });

function ambienteSupabase(t, falso) {
  const repository = createSupabaseProspectingExclusionRepository({ url: 'https://exemplo-falso.example.test', serviceRoleKey: 'chave-falsa-de-teste', fetchImpl: falso.fetchImpl });
  const exclusoes = createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository });
  const env = ambiente(t, { a: alfa() }, { guarda: createEnforcedPermanentExclusionGuard(exclusoes) });
  aprovar(env, 'a');
  return env;
}

test('[EXCL-PROMO-26] SUPABASE (adapter real, fetch falso): a exclusão que está na SEGUNDA página (acima do teto de 1000 linhas do servidor) bloqueia a promoção', async (t) => {
  const todas = Array.from({ length: 1100 }, (_, i) => linhaSupabase(i + 1));
  todas[1050] = linhaSupabase(1051, { empresa_nome: 'Clínica Alfa', empresa_nome_normalizado: 'clinica alfa' });
  const falso = postgrestFalso({ todas, teto: 1000 });
  const env = ambienteSupabase(t, falso);
  const erro = await recusa(async () => await env.promover('a'), PROMOTION_ERROR.BLOCKED_EXCLUSION, MENSAGEM.confirmada);
  assert.equal(falso.pedidos.length, 3, 'a lista inteira foi lida (offsets 0, 500, 1000)');
  assert.equal(env.crmEspiado.criacoes, 0);
  semDadosDaExclusao(erro.message, 'supabase');
});

test('[EXCL-PROMO-27] SUPABASE: tabela vazia ("*/0") libera; resposta 200 INVÁLIDA, truncada, sem Content-Range, 401/404/500 e falha de rede bloqueiam como INDISPONÍVEL — com ZERO registros e sem vazar o corpo da resposta', async (t) => {
  const vazia = ambienteSupabase(t, postgrestFalso({ todas: [] }));
  assert.equal((await vazia.promover('a')).exclusoes, EXCLUSIONS_CHECK.VERIFICADA);

  const todas = Array.from({ length: 1200 }, (_, i) => linhaSupabase(i + 1));
  const casos = {
    'HTTP 200 com HTML': { corpo: '<html>portal</html>', range: '*/0' },
    'HTTP 200 com null': { corpo: 'null', range: '*/0' },
    'HTTP 200 com objeto': { corpo: '{"message":"x"}', range: '*/0' },
    'HTTP 200 com corpo vazio': { corpo: '', range: '*/0' },
    'JSON malformado': { corpo: '[{"id":', range: '*/0' },
    'sem Content-Range': { todas: [], range: null },
    truncada: { todas: todas.slice(0, 500), total: 1200 },
    '401': { falha: 401 },
    '404 (tabela ausente)': { falha: 404 },
    '500': { falha: 500 },
    rede: { falha: 'rede' },
  };
  for (const [nome, config] of Object.entries(casos)) {
    const env = ambienteSupabase(t, postgrestFalso(config));
    const erro = await recusa(async () => await env.promover('a'), PROMOTION_ERROR.EXCLUSION_CHECK_UNAVAILABLE, MENSAGEM.indisponivel);
    assert.equal(env.crmEspiado.criacoes, 0, nome);
    assert.deepEqual(env.registrosDoCrm(), [], nome);
    for (const proibido of ['detalhe interno do supabase', 'chave-falsa-de-teste', 'exemplo-falso', 'portal']) assert.equal(erro.message.includes(proibido), false, `${nome}: "${proibido}"`);
    assert.equal(entradasDeBloqueio(env.itemDaFila('a')).length, 0, `${nome}: nenhuma decisão gravada`);
  }
});

test('[EXCL-PROMO-28] nenhuma chamada externa: durante estes testes o fetch global nunca é usado (o fetch do adapter é sempre o falso injetado)', async (t) => {
  let usado = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    usado += 1;
    throw new Error('rede proibida');
  });
  const env = ambienteSupabase(t, postgrestFalso({ todas: [] }));
  await env.promover('a');
  const barrado = ambiente(t, { a: alfa() });
  await barrado.excluir({ empresa: 'Clínica Alfa' });
  aprovar(barrado, 'a');
  await recusa(async () => await barrado.promover('a'), PROMOTION_ERROR.BLOCKED_EXCLUSION);
  assert.equal(usado, 0);
});

test('[EXCL-PROMO-29] se a própria AUDITORIA do bloqueio falhar, a recusa continua valendo (nunca vira sucesso), o erro acusa auditoriaGravada: false e nada é criado no CRM — para a exclusão confirmada e para a ambígua', async (t) => {
  for (const [entrada, dados, codigo] of [[alfa(), { empresa: 'Clínica Alfa' }, PROMOTION_ERROR.BLOCKED_EXCLUSION], [alfaSemGeografia(), { empresa: 'Clínica Alfa', cidade: 'Petrópolis' }, PROMOTION_ERROR.EXCLUSION_AMBIGUOUS]]) {
    const env = ambiente(t, { a: entrada }, {
      promocaoDeAuditoria: (promocao) => ({
        recordPromotion: (...args) => promocao.recordPromotion(...args),
        recordPromotionBlocked: () => {
          throw new Error('falha de gravação da fila (simulada)');
        },
      }),
    });
    await env.excluir(dados);
    aprovar(env, 'a');
    const erro = await recusa(async () => await env.promover('a'), codigo);
    assert.equal(erro.auditoriaGravada, false);
    assert.equal(env.crmEspiado.criacoes, 0);
    assert.deepEqual(env.registrosDoCrm(), []);
    assert.equal(entradasDeBloqueio(env.itemDaFila('a')).length, 0, 'nada foi gravado na fila');
  }
});

test('[EXCL-PROMO-30] AUTORIA pela promoção REAL: três administradores clicando em "Promover" — 24 alternadas entre dois, mais 56 de um deles, mais 10 de um terceiro — o histórico da fila atribui a cada um exatamente o que ele fez (12 / 68 / 10), com a soma total correta e sem dado da exclusão', async (t) => {
  const env = ambiente(t, { a: alfa() });
  await env.excluir({ empresa: 'Clínica Alfa' });
  aprovar(env, 'a');
  const pessoa = (sufixo) => admin({ userId: `user-admin-${sufixo}`, authUserId: `auth-admin-${sufixo}`, name: `Administrador ${sufixo.toUpperCase()}`, email: `admin-${sufixo}@example.test` });
  const A = pessoa('a');
  const B = pessoa('b');
  const C = pessoa('c');
  const feitas = {};
  const tentar = async (contexto, userId) => {
    feitas[userId] = (feitas[userId] || 0) + 1;
    await recusa(async () => await env.promover('a', contexto), PROMOTION_ERROR.BLOCKED_EXCLUSION);
  };
  for (let i = 0; i < 24; i += 1) await (i % 2 === 0 ? tentar(A, 'user-admin-a') : tentar(B, 'user-admin-b'));
  for (let i = 0; i < 56; i += 1) await tentar(B, 'user-admin-b');
  for (let i = 0; i < 10; i += 1) await tentar(C, 'user-admin-c');
  assert.deepEqual(feitas, { 'user-admin-a': 12, 'user-admin-b': 68, 'user-admin-c': 10 });

  const atribuido = {};
  for (const entrada of entradasDeBloqueio(env.itemDaFila('a'))) atribuido[entrada.reviewedBy.userId] = (atribuido[entrada.reviewedBy.userId] || 0) + (entrada.promocao.tentativas || 1);
  assert.deepEqual(atribuido, { 'user-admin-a': 12, 'user-admin-b': 68, 'user-admin-c': 10 }, 'cada pessoa responde só pelo que fez');
  assert.equal(Object.values(atribuido).reduce((a, b) => a + b, 0), 90);
  assert.equal(entradasDeBloqueio(env.itemDaFila('a')).length, 21, 'o teto de 20 + a linha de quem chegou depois dele');
  assert.equal(env.crmEspiado.criacoes, 0);
  semDadosDaExclusao(env.itemDaFila('a').historico, 'autoria');
  assert.equal(env.itemDaFila('a').estado, QUEUE_STATE.APROVADO_PARA_CRM);
});
