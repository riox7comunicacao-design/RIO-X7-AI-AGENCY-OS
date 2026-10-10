'use strict';

// Implementação 3.0.2 (decisões finais): REVER SITE OFICIAL, COMPLETAR PESQUISA em leads reprovados e a PROIBIÇÃO de enriquecimento em lote. Peças REAIS: Approval Queue em arquivo temporário,
// autorizador, perfil comercial, verifyOfficialSite; FAKES: o motor de enriquecimento e a leitura de página. Nenhuma rede, nenhum `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createLeadEnrichmentService, ENRICH_ERROR } = require('../../src/services/leadEnrichmentService');
const { createInMemoryLeadProfileRepository } = require('../../src/research-prospector/leadProfileRepository');
const { buildPrompt } = require('../../src/prospecting-adapters/claudeEnrichmentEngine');
const commercial = require('../../src/research-prospector/commercialProfile');
const digital = require('../../src/research-prospector/digitalPresence');
const { novoAmbiente, achado, admin, closer, inativo } = require('../helpers/promotionFixtures');

const HOJE = '2026-10-08';
const SITE = 'https://clinicaalfa.com.br/';
const NOVO = 'https://alfaestetica.com.br/';
const NOTICIA = 'https://portal.exemplo-noticias.com.br/';

const paginaDaEmpresa = (url, extras = {}) => ({ ok: true, urlFinal: url, links: [{ href: 'mailto:contato@clinicaalfa.com.br' }, { href: 'https://www.instagram.com/clinicaalfa' }], texto: 'Clínica Alfa\nClínica de estética e harmonização facial\nRua das Flores, 10 - Petrópolis - RJ, CEP 25600-000\nTel (24) 2222-3333', identidade: 'Clínica Alfa | Clínica de estética', ...extras });
const paginaDeOutraCoisa = (url) => ({ ok: true, urlFinal: url, links: [], texto: 'Notícias e política de Petrópolis', identidade: 'Portal de notícias' });

const perfilComSite = (extras = {}) => ({
  ...commercial.buildCommercialProfile({ empresa: 'Clínica Alfa', siteOficial: { status: 'ENCONTRADO', url: SITE }, presencaDigital: digital.buildPresence({ officialLinks: ['https://www.instagram.com/clinicaalfa'] }), pages: [], fontesValidacao: [{ url: SITE, tipo: 'OFICIAL' }], today: HOJE }),
  contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' },
  enriquecimento: { status: 'NAO_EXECUTADO', camposPendentes: ['responsavel'], limiteDeTurnos: false, motivo: 'SOB_DEMANDA' },
  jobId: 'JOB-20261008-001',
  ...extras,
});
const perfilSemSite = () => ({ ...commercial.buildCommercialProfile({ empresa: 'Clínica Alfa', siteOficial: { status: 'NAO_ENCONTRADO', url: null }, pages: [], today: HOJE }), contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' } });

function motorFake(resposta) {
  const chamadas = [];
  let liberar = () => {};
  const portao = new Promise((resolve) => { liberar = resolve; });
  return { chamadas, liberar: () => liberar(), enrich: async (pedido) => { chamadas.push(pedido); return typeof resposta === 'function' ? resposta(pedido, chamadas.length, portao) : resposta; } };
}
const comSite = (url, extras = {}) => ({ ok: true, custoUsd: 0.05, webSearchRequests: 3, turnos: 4, resultados: [{ nome: 'Clínica Alfa', ...(url === null ? {} : { siteOficial: { url } }), ...extras }] });

function montar(t, { motor, paginas = {}, perfil = perfilComSite(), entradas, preparar } = {}) {
  const env = novoAmbiente(t, entradas || { alfa: { finding: achado('Clínica Alfa', 'clinica-alfa') } });
  if (preparar) preparar(env);
  const perfis = createInMemoryLeadProfileRepository();
  const id = env.ids.alfa;
  if (perfil) perfis.save(id, perfil);
  const servico = createLeadEnrichmentService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    queuePath: env.queuePath,
    profileRepository: perfis,
    ...(motor ? { enrichmentEngine: motor } : {}),
    createFetchPage: () => async (url) => paginas[url] || { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' },
    now: (() => { let t0 = Date.parse(`${HOJE}T12:00:00.000Z`); return () => new Date((t0 += 300)); })(),
  });
  return { env, perfis, servico, id };
}
const erroDe = async (fn) => {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava que lançasse');
};
const rever = async (x) => {
  const inicio = await x.servico.reviewSite(admin(), x.id);
  await x.servico.waitFor(x.id);
  return inicio;
};
const revisao = (x) => x.perfis.getById(x.id).revisaoSite;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// REVER SITE OFICIAL
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[SITE-1] REVER SITE OFICIAL confirma o vínculo por evidência pública: pede SÓ o site (marcado como revisão), lê a página real, registra resultado, fontes, duração e custo — e a fila fica intacta', async (t) => {
  const motor = motorFake(comSite(SITE));
  const x = montar(t, { motor, paginas: { [SITE]: paginaDaEmpresa(SITE) } });
  const filaAntes = x.env.textoDaFila();
  const inicio = await rever(x);
  assert.equal(inicio.status, 'EM_ANDAMENTO');
  assert.equal(inicio.tipo, 'REVISAO_SITE');

  const [lead] = motor.chamadas[0].leads;
  assert.deepEqual([lead.precisa, lead.revisarSite, lead.site], [['siteOficial'], true, SITE]);
  assert.equal(motor.chamadas[0].leads.length, 1);
  assert.match(buildPrompt(motor.chamadas[0].leads), /REVISÃO DO SITE/);

  const r = revisao(x);
  assert.equal(r.status, 'CONCLUIDA');
  assert.equal(r.ultimaRevisao.resultado, 'CONFIRMADO');
  assert.deepEqual([r.ultimaRevisao.siteAtual, r.ultimaRevisao.siteFinal], [SITE, SITE]);
  assert.ok(r.ultimaRevisao.vinculo && typeof r.ultimaRevisao.vinculo === 'object', 'o vínculo (domínio/título) fica registrado');
  assert.deepEqual(r.ultimaRevisao.fontes, [SITE]);
  assert.ok(r.ultimaRevisao.concluidoEm && r.ultimaRevisao.duracaoMs > 0);
  assert.deepEqual([r.ultimaRevisao.custoUsd, r.ultimaRevisao.webSearchRequests, r.ultimaRevisao.turnos], [0.05, 3, 4]);
  const p = x.perfis.getById(x.id);
  assert.deepEqual([p.siteOficial.status, p.siteOficial.url], ['ENCONTRADO', SITE]);
  assert.deepEqual(p.emails.map((e) => e.email), ['contato@clinicaalfa.com.br'], 'a página verificada só COMPLETA o que faltava');
  assert.equal(p.enriquecimento.status, 'NAO_EXECUTADO', 'a pesquisa geral não foi tocada');
  assert.equal(x.env.textoDaFila(), filaAntes, 'Approval Queue intacta');
  assert.equal(x.servico.getStatus(admin(), x.id).revisaoSite.ultimaRevisao.resultado, 'CONFIRMADO');
});

test('[SITE-2] sem comprovação suficiente o site confirmado é PRESERVADO: motor sem resposta, candidato de terceiro/sem vínculo, página atual inacessível — resultado SEM_COMPROVACAO ou CONFIRMADO, nunca perda', async (t) => {
  // a) o motor não achou nada e a página atual está fora do ar: não dá para reconfirmar, mas nada é apagado
  const a = montar(t, { motor: motorFake(comSite(null)), paginas: {} });
  await rever(a);
  assert.equal(revisao(a).ultimaRevisao.resultado, 'SEM_COMPROVACAO');
  assert.equal(revisao(a).ultimaRevisao.motivo, 'PAGINA_INACESSIVEL');
  assert.deepEqual([a.perfis.getById(a.id).siteOficial.status, a.perfis.getById(a.id).siteOficial.url], ['ENCONTRADO', SITE]);

  // b) a página atual se sustenta; o candidato é uma página que não tem a ver com a empresa: o atual fica e o candidato é descartado
  const b = montar(t, { motor: motorFake(comSite(NOVO)), paginas: { [SITE]: paginaDaEmpresa(SITE), [NOVO]: paginaDeOutraCoisa(NOVO) } });
  await rever(b);
  assert.equal(revisao(b).ultimaRevisao.resultado, 'CONFIRMADO');
  assert.equal(b.perfis.getById(b.id).siteOficial.url, SITE);

  // c) o atual não se sustenta e o candidato também não: preserva o confirmado
  const c = montar(t, { motor: motorFake(comSite(NOVO)), paginas: { [SITE]: paginaDeOutraCoisa(SITE), [NOVO]: paginaDeOutraCoisa(NOVO) } });
  await rever(c);
  assert.equal(revisao(c).ultimaRevisao.resultado, 'SEM_COMPROVACAO');
  assert.equal(c.perfis.getById(c.id).siteOficial.url, SITE);
  assert.match(revisao(c).ultimaRevisao.mensagem, /site confirmado foi mantido/);

  // d) rede social/diretório/notícia nunca é site oficial
  const d = montar(t, { motor: motorFake(comSite('https://www.facebook.com/clinicaalfa')), paginas: {} });
  await rever(d);
  assert.equal(d.perfis.getById(d.id).siteOficial.url, SITE);
  assert.equal(revisao(d).ultimaRevisao.siteCandidato, null);
});

test('[SITE-3] NENHUMA troca automática de domínio: outro domínio comprovado vira PROPOSTA PENDENTE (o atual fica, com as evidências dos dois), mesmo se o atual não se sustentar; sem site anterior, um site comprovado entra direto', async (t) => {
  // o atual NÃO se sustenta e o novo é comprovado: antes trocava sozinho; agora só propõe
  const insustentavel = montar(t, { motor: motorFake(comSite(NOVO)), paginas: { [SITE]: paginaDeOutraCoisa(SITE), [NOVO]: paginaDaEmpresa(NOVO) } });
  await rever(insustentavel);
  const p = insustentavel.perfis.getById(insustentavel.id);
  assert.equal(revisao(insustentavel).ultimaRevisao.resultado, 'PROPOSTA_PENDENTE');
  assert.equal(p.siteOficial.url, SITE, 'o domínio anterior NÃO foi substituído');
  assert.equal(p.propostaSite.status, 'PENDENTE');
  assert.deepEqual([p.propostaSite.dominioAtual, p.propostaSite.dominioNovo, p.propostaSite.atualSustentado], [SITE, NOVO, false]);
  assert.equal(p.propostaSite.evidencias.atual.comprovado, false);
  assert.equal(p.propostaSite.evidencias.novo.comprovado, true);
  assert.ok(p.propostaSite.evidencias.novo.vinculo, 'o vínculo do novo domínio fica registrado');
  assert.equal(p.propostaSite.evidencias.atual.titulo, 'Portal de notícias');
  assert.deepEqual(p.emails, [], 'os contatos do domínio novo NÃO entram no perfil antes da confirmação');
  assert.equal(p.fontesEnriquecimento.some((f) => f.url === NOVO), false);

  // os dois comprovados: o confirmado fica, a escolha é humana
  const dois = montar(t, { motor: motorFake(comSite(NOVO)), paginas: { [SITE]: paginaDaEmpresa(SITE), [NOVO]: paginaDaEmpresa(NOVO) } });
  await rever(dois);
  assert.equal(revisao(dois).ultimaRevisao.resultado, 'PROPOSTA_PENDENTE');
  assert.equal(dois.perfis.getById(dois.id).siteOficial.url, SITE);
  const proposta = dois.perfis.getById(dois.id).propostaSite;
  assert.deepEqual([proposta.atualSustentado, proposta.evidencias.atual.comprovado, proposta.evidencias.novo.comprovado], [true, true, true]);
  assert.deepEqual(proposta.fontes, [SITE, NOVO]);
  const status = dois.servico.getStatus(admin(), dois.id);
  assert.equal(status.podeDecidirSite, true);
  assert.equal(status.propostaSite.dominioNovo, NOVO);
  assert.equal('dadosDoNovo' in status.propostaSite, false, 'o status não expõe os dados internos usados para completar o perfil');

  // sem site anterior: o site comprovado entra direto
  const novo = montar(t, { motor: motorFake(comSite(NOVO)), paginas: { [NOVO]: paginaDaEmpresa(NOVO) }, perfil: perfilSemSite() });
  await rever(novo);
  assert.equal(revisao(novo).ultimaRevisao.resultado, 'ENCONTRADO');
  assert.deepEqual([novo.perfis.getById(novo.id).siteOficial.status, novo.perfis.getById(novo.id).siteOficial.url], ['ENCONTRADO', NOVO]);
  assert.equal(novo.perfis.getById(novo.id).propostaSite == null, true, 'sem site anterior não há proposta');
});

test('[SITE-4] falhas e interrupção da revisão: Claude indisponível/limite de uso/erro -> FALHOU com mensagem e site preservado; "em andamento" órfão vira INTERROMPIDO; histórico limitado a 10', async (t) => {
  for (const [code, mensagem] of [['SPAWN_FAILED', /não está disponível/], ['USAGE_LIMIT', /limite de uso/], ['TIMEOUT', /tempo limite/]]) {
    const x = montar(t, { motor: motorFake({ ok: false, code }), paginas: { [SITE]: paginaDaEmpresa(SITE) } });
    await rever(x);
    const r = revisao(x);
    assert.equal(r.status, 'FALHOU', code);
    assert.equal(r.ultimaRevisao.motivo, code);
    assert.match(r.ultimaRevisao.mensagem, mensagem);
    assert.equal(x.perfis.getById(x.id).siteOficial.url, SITE);
    assert.equal(x.servico.getStatus(admin(), x.id).podeRever, true, 'nova tentativa liberada');
  }
  const orfao = montar(t, { motor: motorFake(comSite(SITE)), perfil: perfilComSite({ revisaoSite: { status: 'EM_ANDAMENTO', iniciadoEm: `${HOJE}T11:00:00.000Z` } }) });
  const s = orfao.servico.getStatus(admin(), orfao.id);
  assert.deepEqual([s.revisaoSite.status, s.revisaoSite.motivo], ['FALHOU', 'INTERROMPIDO']);
  const muitos = montar(t, { motor: motorFake({ ok: false, code: 'TIMEOUT' }) });
  for (let i = 0; i < 12; i += 1) await rever(muitos);
  assert.equal(revisao(muitos).historico.length, 10);
  const lancou = montar(t, { motor: { enrich: async () => { throw new Error('boom'); } } });
  await rever(lancou);
  assert.equal(revisao(lancou).ultimaRevisao.motivo, 'ERRO_INTERNO');
  assert.equal(lancou.perfis.getById(lancou.id).siteOficial.url, SITE);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// SEM LOTE, UMA POR VEZ, SEM DNC
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[LOTE-1] proibido enriquecimento em lote: o Service só tem operações de UM lead; vários ids/array/objeto são recusados; outro lead durante uma pesquisa é recusado (ENRICH_BUSY); o mesmo lead, ALREADY_RUNNING', async (t) => {
  const motor = motorFake((pedido, n, portao) => portao.then(() => comSite(null)));
  const x = montar(t, { motor, entradas: { alfa: { finding: achado('Clínica Alfa', 'clinica-alfa') }, beta: { finding: achado('Clínica Beta', 'clinica-beta') } } });
  assert.deepEqual(Object.keys(x.servico).sort(), ['decideSiteProposal', 'getStatus', 'reviewSite', 'start', 'waitFor'], 'nenhuma operação de lote');
  for (const invalido of [['a', 'b'], { id: 'a' }, null, 5, 'a,b']) {
    assert.equal((await erroDe(() => x.servico.start(admin(), invalido))).code === ENRICH_ERROR.INVALID_INPUT || (await erroDe(() => x.servico.start(admin(), invalido))).code === ENRICH_ERROR.NOT_FOUND, true, JSON.stringify(invalido));
    assert.ok(await erroDe(() => x.servico.reviewSite(admin(), invalido)));
  }
  assert.equal(motor.chamadas.length, 0, 'nada foi pesquisado por entrada inválida');

  await x.servico.start(admin(), x.id);
  assert.equal((await erroDe(() => x.servico.start(admin(), x.id))).code, ENRICH_ERROR.ALREADY_RUNNING);
  assert.equal((await erroDe(() => x.servico.reviewSite(admin(), x.id))).code, ENRICH_ERROR.ALREADY_RUNNING, 'nem a revisão do site em paralelo com a pesquisa do MESMO lead');
  const outro = x.env.ids.beta;
  perfisParaBeta(x, outro);
  assert.equal((await erroDe(() => x.servico.start(admin(), outro))).code, ENRICH_ERROR.BUSY, 'uma pesquisa por vez, lead a lead');
  assert.equal((await erroDe(() => x.servico.reviewSite(closer(), outro))).code, ENRICH_ERROR.BUSY);
  assert.equal(x.servico.getStatus(admin(), outro).podeCompletar, false);
  assert.equal(motor.chamadas.length, 1, 'só UMA pesquisa foi disparada');
  motor.liberar();
  await x.servico.waitFor(x.id);
  // livre de novo: agora o outro lead pode (por ação explícita)
  assert.equal((await x.servico.start(admin(), outro)).status, 'EM_ANDAMENTO');
  await x.servico.waitFor(outro);
});
function perfisParaBeta(x, outro) {
  x.perfis.save(outro, { ...perfilComSite(), empresa: 'Clínica Beta' });
}

test('[LOTE-2] a prospecção automática NÃO enriquece: o job não conhece o Service de enriquecimento nem o motor, e nenhum módulo de job/agendamento o chama', () => {
  const raiz = path.resolve(__dirname, '..', '..', 'src');
  const jobs = fs.readFileSync(path.join(raiz, 'services', 'prospectingJobService.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(jobs, /leadEnrichment|enrichmentEngine|enrichDelivered|\.enrich\(/, 'o job não chama enriquecimento');
  const usos = [];
  for (const arquivo of fs.readdirSync(path.join(raiz, 'services'))) {
    const codigo = fs.readFileSync(path.join(raiz, 'services', arquivo), 'utf8').replace(/\/\/.*$/gm, '');
    if (/leadEnrichmentService|createLeadEnrichmentService/.test(codigo)) usos.push(arquivo);
  }
  assert.deepEqual(usos.sort(), ['leadEnrichmentService.js', 'prospectingJobFileService.js'], 'só a definição e a composição (que cria o Service para a API)');
  const app = fs.readFileSync(path.join(raiz, 'server', 'app.js'), 'utf8');
  assert.equal((app.match(/leadEnrichmentService\.(start|reviewSite)\(/g) || []).length, 2, 'só as duas rotas POST de UM lead chamam');
  assert.doesNotMatch(app, /for \(const [^)]*\) *\{?[^}]*leadEnrichmentService\.(start|reviewSite)/, 'nenhum laço sobre leads');
  assert.doesNotMatch(app, /setInterval|cron/i);
});

test('[LOTE-3] lead em DNC não é enriquecido (nem a pesquisa nem a revisão do site); o estado informa o bloqueio; nada é chamado', async (t) => {
  const motor = motorFake(comSite(null));
  const x = montar(t, { motor, perfil: null, entradas: { dnc: { finding: achado('Clínica DNC', 'clinica-dnc'), crmRecords: [{ empresa: 'DNC', site: 'https://clinica-dnc.example.test', doNotContact: true }] } } });
  const id = x.env.ids.dnc;
  assert.equal(x.env.itemDaFila('dnc').estado, 'DNC');
  assert.equal((await erroDe(() => x.servico.start(admin(), id))).code, ENRICH_ERROR.NOT_ALLOWED);
  assert.equal((await erroDe(() => x.servico.reviewSite(admin(), id))).code, ENRICH_ERROR.NOT_ALLOWED);
  const status = x.servico.getStatus(admin(), id);
  assert.deepEqual([status.bloqueio, status.podeCompletar, status.podeRever], ['DNC', false, false]);
  assert.match(status.mensagem, /DNC/);
  assert.equal(motor.chamadas.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// LEADS REPROVADOS: a pesquisa não muda decisão nenhuma
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[REJ-1] em lead REJEITADO a pesquisa e a revisão do site funcionam e NÃO alteram o estado, o histórico, o CRM nem reaprovam/aprovam/promovem: o arquivo da fila fica byte a byte igual', async (t) => {
  const motor = motorFake((pedido) => comSite(NOVO, { emails: [{ email: 'contato@alfa.com.br', origem: 'https://alfa.com.br/contato' }] }));
  const x = montar(t, { motor, paginas: { [SITE]: paginaDaEmpresa(SITE), [NOVO]: paginaDaEmpresa(NOVO) }, preparar: (env) => env.fila.rejectProspect(closer(), env.ids.alfa, { reason: 'Sem fit agora' }) });
  assert.equal(x.env.itemDaFila('alfa').estado, 'REJEITADO');
  const filaAntes = x.env.textoDaFila();
  const crmAntes = x.env.textoDoCrm();
  await x.servico.start(closer(), x.id);
  await x.servico.waitFor(x.id);
  await rever(x);
  assert.equal(x.env.textoDaFila(), filaAntes, 'estado e histórico intactos: continua REJEITADO, sem entrada de reaprovação/aprovação/promoção');
  assert.equal(x.env.textoDoCrm(), crmAntes, 'nada foi promovido ao CRM');
  assert.equal(x.env.itemDaFila('alfa').estado, 'REJEITADO');
  assert.equal(x.env.itemDaFila('alfa').reaprovacoes, undefined);
  assert.equal(x.env.itemDaFila('alfa').promocao, undefined);
  const p = x.perfis.getById(x.id);
  assert.equal(p.enriquecimento.status !== undefined, true);
  assert.equal(p.revisaoSite.ultimaRevisao.resultado, 'PROPOSTA_PENDENTE');
  assert.equal(p.propostaSite.status, 'PENDENTE', 'a proposta fica pendente: o lead reprovado continua com o site atual');
});

test('[SEG-1] autorização: sem APPROVE:LEAD_APPROVAL (usuário inativo) nada é lido nem chamado; id desconhecido/ inválido é recusado ANTES de qualquer pesquisa; o closer COM a permissão pode', async (t) => {
  const motor = motorFake(comSite(null));
  const x = montar(t, { motor });
  const filaAntes = x.env.textoDaFila();
  for (const operacao of [() => x.servico.start(inativo(), x.id), () => x.servico.reviewSite(inativo(), x.id), () => Promise.resolve().then(() => x.servico.getStatus(inativo(), x.id))]) assert.ok(await erroDe(operacao));
  assert.ok(await erroDe(() => x.servico.start(undefined, x.id)));
  assert.ok(await erroDe(() => x.servico.start({ userId: 'admin', role: 'ADMIN' }, x.id)), 'um objeto qualquer NÃO é um contexto autorizado');
  assert.equal((await erroDe(() => x.servico.reviewSite(admin(), 'nao-existe'))).code, ENRICH_ERROR.NOT_FOUND);
  assert.equal((await erroDe(() => x.servico.reviewSite(admin(), '  '))).code, ENRICH_ERROR.INVALID_INPUT);
  assert.equal(motor.chamadas.length, 0);
  assert.equal(x.env.textoDaFila(), filaAntes);
  assert.equal((await x.servico.reviewSite(closer(), x.id)).status, 'EM_ANDAMENTO');
  await x.servico.waitFor(x.id);
});
