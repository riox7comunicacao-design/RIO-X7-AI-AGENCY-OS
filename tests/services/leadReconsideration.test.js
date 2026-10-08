'use strict';

// Implementação 3.0 — LEADS REPROVADOS e REAPROVAR LEAD. Peças REAIS: o domínio da fila, os Services da fila e da promoção, o CRM em arquivo temporário, as pontes de
// autorização. Dados fictícios (example.test); nenhum arquivo do projeto é tocado.

const test = require('node:test');
const assert = require('node:assert/strict');

const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createLeadReconsiderationService } = require('../../src/services/leadReconsiderationService');
const { createInMemoryLeadProfileRepository } = require('../../src/research-prospector/leadProfileRepository');
const { novoAmbiente, achado: achadoBase, evidencia, admin, closer, inativo } = require('../helpers/promotionFixtures');

// telefones e Instagram DISTINTOS por empresa: a identidade (domínio, telefone, Instagram, nome+cidade) não pode colidir entre os leads do teste
let serie = 0;
const achado = (empresa, slug, extras = {}) => {
  serie += 1;
  const n = String(1000 + serie);
  return achadoBase(empresa, slug, { ...extras, campos: { telefone: [evidencia(`(24) 98765-${n}`)], whatsapp: [evidencia(`+55 24 98766-${n}`)], instagram: [evidencia(`@${slug.replace(/-/g, '_')}_${n}`)], ...(extras.campos || {}) } });
};

function servicoDe(env, extras = {}) {
  const perfis = createInMemoryLeadProfileRepository();
  const servico = createLeadReconsiderationService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: env.queuePath, crmService: env.crm, profileRepository: perfis, ...extras });
  return { servico, perfis };
}

const ENTRADAS = () => ({
  alfa: { finding: achado('Clínica Alfa', 'clinica-alfa') },
  beta: { finding: achado('Clínica Beta', 'clinica-beta') },
  dnc: { finding: achado('Clínica DNC', 'clinica-dnc'), crmRecords: [{ empresa: 'DNC', site: 'https://clinica-dnc.example.test', doNotContact: true }] },
  dup: { finding: achado('Clínica Dup', 'clinica-dup'), crmRecords: [{ empresa: 'Clínica Dup', site: 'https://clinica-dup.example.test' }] },
});

const erroDe = async (fn) => {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava que lançasse');
};

test('[RECON-1] fluxo completo: REJEITAR -> LEADS REPROVADOS (dados preservados) -> REAPROVAR -> AGUARDANDO_REVISAO -> APROVAR -> PROMOVER -> CRM (e promover de novo não duplica)', async (t) => {
  const env = novoAmbiente(t, ENTRADAS());
  const { servico, perfis } = servicoDe(env);
  perfis.save(env.ids.alfa, { empresa: 'Clínica Alfa', jobId: 'JOB-20261007-001', telefones: [{ numero: '+552422223333', origem: 'https://x.example.test/' }] });
  env.fila.rejectProspect(closer(), env.ids.alfa, { reason: 'Sem fit no momento' });

  const lista = servico.listReprovados(admin(), { filtro: 'REPROVADOS' });
  assert.equal(lista.length, 1);
  const lead = lista[0];
  assert.deepEqual([lead.prospectId, lead.estado, lead.reaprovavel, lead.origemDaDecisao, lead.motivo, lead.jobOrigem], [env.ids.alfa, 'REJEITADO', true, 'HUMANO', 'Sem fit no momento', 'JOB-20261007-001']);
  assert.equal(lead.reprovadoPor.role, 'COMMERCIAL_CLOSER');
  assert.ok(lead.reprovadoEm);
  assert.equal(lead.dadosComerciais.empresa, 'Clínica Alfa', 'os dados comerciais já pesquisados continuam lá');
  assert.deepEqual(lead.perfil.telefones.map((x) => x.numero), ['+552422223333']);

  const antes = JSON.stringify(env.itemDaFila('alfa').discoverySnapshot);
  const volta = await servico.reconsiderLead(admin(), env.ids.alfa, { reason: 'Cliente pediu de novo' });
  assert.equal(volta.estado, 'AGUARDANDO_REVISAO');
  assert.equal(volta.reaprovacoes, 1);
  assert.equal(JSON.stringify(env.itemDaFila('alfa').discoverySnapshot), antes, 'NENHUMA pesquisa nova: o snapshot é o mesmo');
  const historico = env.itemDaFila('alfa').historico.map((h) => [h.from, h.to, h.actor]);
  assert.deepEqual(historico.slice(-2), [['AGUARDANDO_REVISAO', 'REJEITADO', 'HUMAN'], ['REJEITADO', 'AGUARDANDO_REVISAO', 'HUMAN']], 'o histórico é preservado e só cresce');
  assert.equal(env.itemDaFila('alfa').historico.at(-1).tipo, 'REAPROVACAO');
  assert.equal(env.registrosDoCrm().length, 0, 'reaprovar NÃO cria nada no CRM');
  assert.equal(servico.listReprovados(admin()).some((l) => l.prospectId === env.ids.alfa), false, 'saiu de LEADS REPROVADOS');

  // aprovar NÃO promove; promover é explícito
  env.fila.approveProspect(closer(), env.ids.alfa, { reason: 'Aprovado' });
  assert.equal(env.registrosDoCrm().length, 0, 'aprovar não cria CRM');
  const promovido = await env.integracao.promoteProspect(admin(), env.ids.alfa);
  assert.ok(promovido);
  assert.equal(env.registrosDoCrm().length, 1);
  assert.equal(env.registrosDoCrm()[0].status, 'PROSPECT', 'o lead entra no CRM como PROSPECT');
  await env.integracao.promoteProspect(admin(), env.ids.alfa);
  assert.equal(env.registrosDoCrm().length, 1, 'promover duas vezes não duplica');
});

test('[RECON-2] rejeitar de novo depois de reaprovar: o ciclo se repete, com contador e histórico completo', async (t) => {
  const env = novoAmbiente(t, ENTRADAS());
  const { servico } = servicoDe(env);
  env.fila.rejectProspect(closer(), env.ids.alfa, { reason: 'primeira' });
  await servico.reconsiderLead(admin(), env.ids.alfa);
  env.fila.rejectProspect(closer(), env.ids.alfa, { reason: 'segunda' });
  const lead = servico.listReprovados(admin(), { filtro: 'REPROVADOS' })[0];
  assert.equal(lead.motivo, 'segunda');
  assert.equal(lead.reaprovacoes, 1);
  await servico.reconsiderLead(admin(), env.ids.alfa);
  assert.equal(env.itemDaFila('alfa').reaprovacoes, 2);
  assert.equal(env.itemDaFila('alfa').historico.filter((h) => h.tipo === 'REAPROVACAO').length, 2);
});

test('[RECON-3] DNC, duplicado, dados insuficientes, aprovado e aguardando NÃO são reaprováveis; aparecem nos filtros certos e nada é apagado', async (t) => {
  const env = novoAmbiente(t, ENTRADAS());
  const { servico } = servicoDe(env);
  assert.equal(env.itemDaFila('dnc').estado, 'DNC');
  assert.equal(env.itemDaFila('dup').estado, 'DUPLICADO');
  for (const chave of ['dnc', 'dup', 'alfa']) {
    const erro = await erroDe(() => servico.reconsiderLead(admin(), env.ids[chave]));
    assert.equal(erro.code, 'NAO_REAPROVAVEL', chave);
  }
  assert.match((await erroDe(() => servico.reconsiderLead(admin(), env.ids.dnc))).message, /DNC/);
  assert.deepEqual(servico.listReprovados(admin(), { filtro: 'DNC' }).map((l) => [l.estado, l.reaprovavel, l.origemDaDecisao]), [['DNC', false, 'SISTEMA']]);
  assert.deepEqual(servico.listReprovados(admin(), { filtro: 'DUPLICADOS' }).map((l) => l.estado), ['DUPLICADO']);
  assert.deepEqual(servico.listReprovados(admin(), { filtro: 'TODOS' }).map((l) => l.estado).sort(), ['DNC', 'DUPLICADO']);
  assert.deepEqual(servico.listReprovados(admin(), { filtro: 'EXPIRADOS' }), []);
  assert.equal((await erroDe(() => servico.listReprovados(admin(), { filtro: 'qualquer' }))).code, 'FILTRO_INVALIDO');
  env.fila.approveProspect(closer(), env.ids.beta, {});
  assert.equal((await erroDe(() => servico.reconsiderLead(admin(), env.ids.beta))).code, 'NAO_REAPROVAVEL', 'aprovado não volta');
});

test('[RECON-4] SÓ DUAS barreiras: (A) o lead já existe no CRM; (B) é duplicado de outro lead ativo — cada uma bloqueia com motivo claro e o lead continua REJEITADO', async (t) => {
  const env = novoAmbiente(t, ENTRADAS());
  const { servico } = servicoDe(env);
  env.fila.rejectProspect(closer(), env.ids.alfa, { reason: 'x' });
  await env.crm.createRecord(admin(), { empresa: 'Clínica Alfa', site: 'https://clinica-alfa.example.test' });
  const jaNoCrm = await erroDe(() => servico.reconsiderLead(admin(), env.ids.alfa));
  assert.equal(jaNoCrm.code, 'JA_NO_CRM');
  assert.match(jaNoCrm.message, /já existe no CRM/);
  assert.equal(env.itemDaFila('alfa').estado, 'REJEITADO', 'a fila não mudou');
  assert.equal(env.itemDaFila('alfa').historico.at(-1).to, 'REJEITADO', 'nenhuma entrada de histórico foi criada');
});

test('[RECON-5] NÃO bloqueiam a reaprovação (a decisão comercial é humana): exclusão permanente, DNC do contato no CRM por outra identidade, falta de site/rede/telefone — e nenhuma nova pesquisa', async (t) => {
  const semCanais = { comprovadoPorCodigo: true, campos: { site: [], instagram: [], telefone: [], whatsapp: [], email: [], facebook: [], linkedin: [], youtube: [] } };
  const env = novoAmbiente(t, { sem: { finding: achado('Clínica Sem Canais', 'clinica-sem-canais', semCanais) }, alfa: { finding: achado('Clínica Alfa', 'clinica-alfa') } });
  // o serviço nem recebe uma consulta de exclusões: reaprovar não olha para elas
  const { servico } = servicoDe(env);
  env.fila.rejectProspect(closer(), env.ids.sem, { reason: 'sem fit' });
  env.fila.rejectProspect(closer(), env.ids.alfa, { reason: 'sem fit' });
  // um contato DNC no CRM que NÃO é este lead (outra identidade): não interfere
  const outro = (await env.crm.createRecord(admin(), { empresa: 'Outra Empresa Qualquer', site: 'https://outra-empresa.example.test', telefone: '(21) 97000-0000' })).record;
  await env.crm.markDoNotContact(admin(), outro.id, { reason: 'pediu para sair' });
  const antes = JSON.stringify([env.itemDaFila('sem').discoverySnapshot, env.itemDaFila('alfa').discoverySnapshot]);
  assert.equal((await servico.reconsiderLead(admin(), env.ids.sem)).estado, 'AGUARDANDO_REVISAO', 'sem site, rede nem telefone: volta');
  assert.equal((await servico.reconsiderLead(admin(), env.ids.alfa)).estado, 'AGUARDANDO_REVISAO');
  assert.equal(JSON.stringify([env.itemDaFila('sem').discoverySnapshot, env.itemDaFila('alfa').discoverySnapshot]), antes, 'nenhuma nova pesquisa nem reavaliação: o snapshot é idêntico');
  assert.equal(env.itemDaFila('alfa').historico.at(-1).tipo, 'REAPROVACAO');
  assert.equal(env.itemDaFila('alfa').historico.filter((h) => h.to === 'REJEITADO').length, 1, 'a rejeição original continua no histórico');
});

test('[RECON-6] autorização: sem APPROVE:LEAD_APPROVAL ou usuário inativo, nada é lido nem alterado; opções com identidade soltas são recusadas; sem autorizador não nasce', async (t) => {
  const env = novoAmbiente(t, ENTRADAS());
  const { servico } = servicoDe(env);
  env.fila.rejectProspect(closer(), env.ids.alfa, { reason: 'x' });
  const antes = env.textoDaFila();
  const semPermissao = await erroDe(() => servico.reconsiderLead(inativo(), env.ids.alfa));
  assert.ok(semPermissao);
  assert.throws(() => servico.listReprovados(inativo()));
  assert.equal(env.textoDaFila(), antes);
  assert.match((await erroDe(() => servico.reconsiderLead(admin(), env.ids.alfa, { reviewedBy: 'x' }))).message, /não reconhecidas/);
  assert.throws(() => createLeadReconsiderationService({ crmService: env.crm }), /authorizeReviewer/);
  assert.throws(() => createLeadReconsiderationService({ authorizeReviewer: authorizeReviewerForApprovalQueue }), /crmService/);
});

test('[RECON-7] a redescoberta automática NÃO reabre uma decisão humana: o mapa ALLOWED_TRANSITIONS continua sem saída para REJEITADO', () => {
  const dominio = require('../../src/research-prospector/approvalQueue');
  assert.deepEqual(Object.keys(dominio.ALLOWED_TRANSITIONS), ['AGUARDANDO_REVISAO']);
  assert.deepEqual(dominio.RECONSIDERATION_TRANSITIONS, { REJEITADO: ['AGUARDANDO_REVISAO'] });
  const fila = dominio.createEmptyQueue();
  const item = dominio.addProspect(fila, require('../helpers/promotionFixtures').descoberta(achado('Clínica Alfa', 'clinica-alfa')));
  item.estado = 'REJEITADO';
  dominio.addProspect(fila, require('../helpers/promotionFixtures').descoberta(achado('Clínica Alfa', 'clinica-alfa')));
  assert.equal(fila.items[item.prospectId].estado, 'REJEITADO');
});

test('[RECON-8] outro item ATIVO na fila com a mesma identidade (mesmo telefone) bloqueia a reaprovação', async (t) => {
  const mesmoTelefone = { campos: { telefone: [evidencia('(24) 98000-0001')], whatsapp: [evidencia('+55 24 98000-0001')] } };
  const env = novoAmbiente(t, { a: { finding: achado('Clínica Um', 'clinica-um', mesmoTelefone) }, b: { finding: achado('Clínica Dois', 'clinica-dois', mesmoTelefone) } });
  const { servico } = servicoDe(env);
  env.fila.rejectProspect(closer(), env.ids.a, { reason: 'x' });
  assert.equal((await erroDe(() => servico.reconsiderLead(admin(), env.ids.a))).code, 'DUPLICADO_NA_FILA');
  assert.equal(env.itemDaFila('a').estado, 'REJEITADO');
  env.fila.rejectProspect(closer(), env.ids.b, { reason: 'x' });
  assert.equal((await servico.reconsiderLead(admin(), env.ids.a)).estado, 'AGUARDANDO_REVISAO', 'sem o outro ativo, a barreira cai');
});
