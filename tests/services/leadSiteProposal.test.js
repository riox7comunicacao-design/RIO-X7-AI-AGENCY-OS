'use strict';

// Implementação 3.0.2 (decisão final): NENHUMA substituição automática de domínio já confirmado. Outro domínio comprovado vira PROPOSTA PENDENTE; só a decisão humana (CONFIRMAR / MANTER) troca o domínio,
// sem nova pesquisa, registrando usuário, data, domínios, fontes e decisão. Peças REAIS: Approval Queue em arquivo, autorizador, perfil, verifyOfficialSite; FAKES: motor e leitura de página.

const test = require('node:test');
const assert = require('node:assert/strict');

const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createLeadEnrichmentService, ENRICH_ERROR } = require('../../src/services/leadEnrichmentService');
const { createInMemoryLeadProfileRepository } = require('../../src/research-prospector/leadProfileRepository');
const commercial = require('../../src/research-prospector/commercialProfile');
const digital = require('../../src/research-prospector/digitalPresence');
const { novoAmbiente, achado, admin, closer, inativo } = require('../helpers/promotionFixtures');

const HOJE = '2026-10-08';
const SITE = 'https://clinicaalfa.com.br/';
const NOVO = 'https://alfaestetica.com.br/';
const OUTRO = 'https://alfaclinica.com.br/';

const paginaDaEmpresa = (url) => ({ ok: true, urlFinal: url, links: [{ href: url === SITE ? 'mailto:contato@clinicaalfa.com.br' : 'mailto:contato@alfaestetica.com.br' }], texto: 'Clínica Alfa\nClínica de estética e harmonização facial\nRua das Flores, 10 - Petrópolis - RJ, CEP 25600-000\nTel (24) 2222-3333', identidade: 'Clínica Alfa | Clínica de estética' });
const perfilComSite = () => ({
  ...commercial.buildCommercialProfile({ empresa: 'Clínica Alfa', siteOficial: { status: 'ENCONTRADO', url: SITE }, presencaDigital: digital.buildPresence({ officialLinks: [] }), pages: [], fontesValidacao: [{ url: SITE, tipo: 'OFICIAL' }], today: HOJE }),
  contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' },
  jobId: 'JOB-20261008-001',
});
const respostaCom = (url) => ({ ok: true, custoUsd: 0.04, resultados: [{ nome: 'Clínica Alfa', siteOficial: { url } }] });

function montar(t, { respostas = [respostaCom(NOVO)], paginas = { [SITE]: paginaDaEmpresa(SITE), [NOVO]: paginaDaEmpresa(NOVO) }, perfil = perfilComSite(), repositorio } = {}) {
  const env = novoAmbiente(t, { alfa: { finding: achado('Clínica Alfa', 'clinica-alfa') } });
  const perfis = repositorio || createInMemoryLeadProfileRepository();
  const id = env.ids.alfa;
  if (perfil) perfis.save(id, perfil);
  const contagem = { motor: 0, paginas: 0 };
  const fila = [...respostas];
  const motor = { enrich: async () => { contagem.motor += 1; return fila.length > 1 ? fila.shift() : fila[0]; } };
  let tempo = Date.parse(`${HOJE}T12:00:00.000Z`);
  const criar = (extras = {}) => createLeadEnrichmentService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    queuePath: env.queuePath,
    profileRepository: perfis,
    enrichmentEngine: motor,
    createFetchPage: () => async (url) => { contagem.paginas += 1; return paginas[url] || { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' }; },
    now: () => new Date((tempo += 500)),
    ...extras,
  });
  return { env, perfis, id, contagem, servico: criar(), criar, motor };
}
const erroDe = async (fn) => {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava que lançasse');
};
const comProposta = async (t, opcoes) => {
  const x = montar(t, opcoes);
  await x.servico.reviewSite(admin(), x.id);
  await x.servico.waitFor(x.id);
  assert.equal(x.perfis.getById(x.id).propostaSite.status, 'PENDENTE');
  return x;
};
const perfil = (x) => x.perfis.getById(x.id);

test('[PROP-1] CONFIRMAR ALTERAÇÃO (decisão humana): troca o domínio, completa o perfil só com o que a revisão já tinha visto e REGISTRA usuário, data, domínio anterior, domínio novo, fontes, evidências e decisão — sem nova pesquisa nem leitura de página, e sem tocar a fila/CRM', async (t) => {
  const x = await comProposta(t);
  assert.equal(perfil(x).siteOficial.url, SITE, 'antes da decisão o atual fica');
  assert.deepEqual(perfil(x).emails.map((e) => e.email), ['contato@clinicaalfa.com.br'], 'antes da decisão só o que veio do site atual');
  const antes = { ...x.contagem };
  const filaAntes = x.env.textoDaFila();
  const crmAntes = x.env.textoDoCrm();
  const resposta = await x.servico.decideSiteProposal(closer(), x.id, 'CONFIRMAR');

  const p = perfil(x);
  assert.deepEqual([p.siteOficial.status, p.siteOficial.url], ['ENCONTRADO', NOVO]);
  assert.equal(p.propostaSite, null, 'a proposta foi resolvida');
  assert.deepEqual(p.emails.map((e) => e.email), ['contato@clinicaalfa.com.br', 'contato@alfaestetica.com.br'], 'o perfil só COMPLETA (sem apagar nada) com o que a página do novo domínio já mostrou');
  assert.equal(p.endereco.cep, '25600-000');
  assert.ok(p.fontesEnriquecimento.some((f) => f.url === NOVO));
  assert.equal(p.decisoesSite.length, 1);
  const d = p.decisoesSite[0];
  assert.equal(d.decisao, 'CONFIRMADA');
  assert.deepEqual([d.usuario.userId, d.usuario.role], ['user-closer-promo', 'COMMERCIAL_CLOSER'], 'o usuário vem do contexto autorizado');
  assert.ok(d.usuario.name && d.data && d.propostaCriadaEm);
  assert.deepEqual([d.dominioAnterior, d.dominioNovo], [SITE, NOVO]);
  assert.deepEqual(d.fontes, [SITE, NOVO]);
  assert.equal(d.evidencias.novo.comprovado, true);
  assert.deepEqual(x.contagem, antes, 'nenhuma nova pesquisa (motor) nem leitura de página ao confirmar');
  assert.equal(x.env.textoDaFila(), filaAntes, 'Approval Queue intacta');
  assert.equal(x.env.textoDoCrm(), crmAntes, 'CRM intacto');
  assert.equal(resposta.propostaSite, null);
  assert.equal(resposta.decisoesSite.at(-1).decisao, 'CONFIRMADA');
  assert.equal(x.servico.getStatus(admin(), x.id).podeDecidirSite, false);
});

test('[PROP-2] MANTER SITE ATUAL (recusa): preserva o domínio, descarta a proposta, NÃO aplica nada do domínio novo e registra a decisão', async (t) => {
  const x = await comProposta(t);
  const antes = { ...x.contagem };
  await x.servico.decideSiteProposal(admin(), x.id, 'MANTER');
  const p = perfil(x);
  assert.equal(p.siteOficial.url, SITE);
  assert.equal(p.propostaSite, null);
  assert.deepEqual(p.emails.map((e) => e.email), ['contato@clinicaalfa.com.br'], 'nada do domínio recusado entrou no perfil');
  assert.equal(p.fontesEnriquecimento.some((f) => f.url === NOVO), false);
  assert.deepEqual([p.decisoesSite[0].decisao, p.decisoesSite[0].dominioAnterior, p.decisoesSite[0].dominioNovo], ['MANTIDA', SITE, NOVO]);
  assert.deepEqual(x.contagem, antes);
  // depois de recusar, uma nova decisão não existe
  assert.equal((await erroDe(() => x.servico.decideSiteProposal(admin(), x.id, 'CONFIRMAR'))).code, ENRICH_ERROR.NO_PROPOSAL);
  assert.equal(perfil(x).siteOficial.url, SITE);
});

test('[PROP-3] sem permissão ninguém decide: conta inativa, sem contexto ou objeto qualquer são recusados ANTES de ler o perfil; decisão inválida e id inexistente também; a proposta fica intacta', async (t) => {
  const x = await comProposta(t);
  const antes = JSON.stringify(perfil(x));
  for (const contexto of [inativo(), undefined, null, { userId: 'admin', role: 'ADMIN' }]) assert.ok(await erroDe(() => x.servico.decideSiteProposal(contexto, x.id, 'CONFIRMAR')), String(contexto));
  assert.equal((await erroDe(() => x.servico.decideSiteProposal(admin(), x.id, 'TALVEZ'))).code, ENRICH_ERROR.INVALID_INPUT);
  assert.equal((await erroDe(() => x.servico.decideSiteProposal(admin(), x.id, undefined))).code, ENRICH_ERROR.INVALID_INPUT);
  assert.equal((await erroDe(() => x.servico.decideSiteProposal(admin(), 'nao-existe', 'CONFIRMAR'))).code, ENRICH_ERROR.NOT_FOUND);
  assert.equal(JSON.stringify(perfil(x)), antes, 'nada mudou');
  assert.equal(perfil(x).siteOficial.url, SITE);
  const semProposta = montar(t);
  assert.equal((await erroDe(() => semProposta.servico.decideSiteProposal(admin(), semProposta.id, 'CONFIRMAR'))).code, ENRICH_ERROR.NO_PROPOSAL);
});

test('[PROP-4] duas confirmações não criam duplicidade: simultâneas ou em sequência, só UMA vale — a outra recebe ENRICH_NO_PROPOSAL; um registro de decisão, o domínio trocado uma vez', async (t) => {
  const x = await comProposta(t);
  const resultados = await Promise.allSettled([x.servico.decideSiteProposal(admin(), x.id, 'CONFIRMAR'), x.servico.decideSiteProposal(closer(), x.id, 'CONFIRMAR')]);
  assert.deepEqual(resultados.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(resultados.find((r) => r.status === 'rejected').reason.code, ENRICH_ERROR.NO_PROPOSAL);
  assert.equal(perfil(x).decisoesSite.length, 1);
  assert.equal(perfil(x).siteOficial.url, NOVO);
  assert.equal(perfil(x).emails.length, 2, 'os contatos do novo domínio entraram uma vez só (sem duplicar)');
  assert.equal((await erroDe(() => x.servico.decideSiteProposal(admin(), x.id, 'CONFIRMAR'))).code, ENRICH_ERROR.NO_PROPOSAL);
  assert.equal((await erroDe(() => x.servico.decideSiteProposal(admin(), x.id, 'MANTER'))).code, ENRICH_ERROR.NO_PROPOSAL, 'confirmada não vira recusada depois');
  assert.equal(perfil(x).decisoesSite.length, 1);
});

test('[PROP-5] falha ou reinício preserva a proposta e o site atual: nova instância do Service (reinício), revisão que falha, "em andamento" órfão e COMPLETAR PESQUISA não perdem nem aplicam a proposta', async (t) => {
  const repositorio = createInMemoryLeadProfileRepository();
  const x = await comProposta(t, { repositorio });
  // reinício: outra instância do Service sobre o MESMO repositório vê a proposta pendente e o site atual
  const reiniciado = x.criar();
  const status = reiniciado.getStatus(admin(), x.id);
  assert.deepEqual([status.podeDecidirSite, status.propostaSite.dominioNovo, perfil(x).siteOficial.url], [true, NOVO, SITE]);

  // uma revisão que FALHA depois não apaga a proposta
  const falha = x.criar({ enrichmentEngine: { enrich: async () => ({ ok: false, code: 'USAGE_LIMIT' }) } });
  await falha.reviewSite(admin(), x.id);
  await falha.waitFor(x.id);
  assert.equal(perfil(x).revisaoSite.ultimaRevisao.motivo, 'USAGE_LIMIT');
  assert.equal(perfil(x).propostaSite.status, 'PENDENTE');
  assert.equal(perfil(x).siteOficial.url, SITE);

  // "em andamento" órfão (queda no meio): vira INTERROMPIDO, e a proposta continua decidível
  perfis(x).save(x.id, { ...perfil(x), revisaoSite: { status: 'EM_ANDAMENTO', iniciadoEm: `${HOJE}T11:00:00.000Z` } });
  const apos = x.criar().getStatus(admin(), x.id);
  assert.deepEqual([apos.revisaoSite.motivo, apos.podeDecidirSite], ['INTERROMPIDO', true]);

  // COMPLETAR PESQUISA não aplica nem apaga a proposta, e o site segue o atual
  const geral = x.criar({ enrichmentEngine: { enrich: async (pedido) => ({ ok: true, resultados: [{ nome: pedido.leads[0].nome }] }) } });
  await geral.start(admin(), x.id);
  await geral.waitFor(x.id);
  assert.equal(perfil(x).propostaSite.status, 'PENDENTE');
  assert.equal(perfil(x).siteOficial.url, SITE);

  // a decisão ainda funciona depois de tudo isso
  await x.criar().decideSiteProposal(admin(), x.id, 'CONFIRMAR');
  assert.equal(perfil(x).siteOficial.url, NOVO);
});
const perfis = (x) => x.perfis;

test('[PROP-6] revisões seguintes: outro domínio SUBSTITUI a proposta pendente (registrado como SUBSTITUIDA); revisão que reconfirma o atual deixa a proposta como está; o mesmo domínio só atualiza; decidir durante uma revisão é recusado', async (t) => {
  const paginas = { [SITE]: paginaDaEmpresa(SITE), [NOVO]: paginaDaEmpresa(NOVO), [OUTRO]: paginaDaEmpresa(OUTRO) };
  const x = montar(t, { paginas, respostas: [respostaCom(NOVO), respostaCom(NOVO), respostaCom(OUTRO), { ok: true, resultados: [{ nome: 'Clínica Alfa' }] }] });
  const rever = async () => { await x.servico.reviewSite(admin(), x.id); await x.servico.waitFor(x.id); };
  await rever();
  const primeira = perfil(x).propostaSite.criadaEm;
  await rever(); // o mesmo domínio: atualiza
  assert.equal(perfil(x).propostaSite.dominioNovo, NOVO);
  assert.equal((perfil(x).decisoesSite || []).length, 0);
  assert.notEqual(perfil(x).propostaSite.criadaEm, primeira);
  await rever(); // outro domínio: substitui
  assert.equal(perfil(x).propostaSite.dominioNovo, OUTRO);
  assert.deepEqual(perfil(x).decisoesSite.map((d) => [d.decisao, d.dominioNovo, d.usuario]), [['SUBSTITUIDA', NOVO, null]]);
  await rever(); // o motor não achou nada: a proposta fica
  assert.equal(perfil(x).propostaSite.dominioNovo, OUTRO);
  assert.equal(perfil(x).siteOficial.url, SITE);

  // decidir enquanto uma revisão roda é recusado (a revisão regravaria o perfil)
  let liberar = () => {};
  const portao = new Promise((resolve) => { liberar = resolve; });
  const lenta = x.criar({ enrichmentEngine: { enrich: async () => { await portao; return respostaCom(OUTRO); } } });
  await lenta.reviewSite(admin(), x.id);
  assert.equal((await erroDe(() => lenta.decideSiteProposal(admin(), x.id, 'CONFIRMAR'))).code, ENRICH_ERROR.ALREADY_RUNNING);
  assert.equal(lenta.getStatus(admin(), x.id).podeDecidirSite, false);
  liberar();
  await lenta.waitFor(x.id);
  assert.equal(perfil(x).siteOficial.url, SITE);
});

test('[PROP-7] fluxos antigos: sem site anterior o site comprovado entra direto; revisão que confirma o atual, sem comprovação ou com falha continua como era; lead em DNC segue bloqueado', async (t) => {
  const direto = montar(t, { perfil: { ...commercial.buildCommercialProfile({ empresa: 'Clínica Alfa', siteOficial: { status: 'NAO_ENCONTRADO', url: null }, pages: [], today: HOJE }), contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' } } });
  await direto.servico.reviewSite(admin(), direto.id);
  await direto.servico.waitFor(direto.id);
  assert.equal(perfil(direto).siteOficial.url, NOVO);
  assert.equal(perfil(direto).propostaSite == null, true);
  assert.equal(direto.servico.getStatus(admin(), direto.id).podeDecidirSite, false);

  const confirma = montar(t, { respostas: [respostaCom(SITE)] });
  await confirma.servico.reviewSite(admin(), confirma.id);
  await confirma.servico.waitFor(confirma.id);
  assert.equal(perfil(confirma).revisaoSite.ultimaRevisao.resultado, 'CONFIRMADO');
  assert.equal(perfil(confirma).propostaSite == null, true);

  const dnc = novoAmbiente(t, { dnc: { finding: achado('Clínica DNC', 'clinica-dnc'), crmRecords: [{ empresa: 'DNC', site: 'https://clinica-dnc.example.test', doNotContact: true }] } });
  const servico = createLeadEnrichmentService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: dnc.queuePath, profileRepository: createInMemoryLeadProfileRepository(), enrichmentEngine: { enrich: async () => assert.fail('DNC não pesquisa') } });
  assert.equal((await erroDe(() => servico.reviewSite(admin(), dnc.ids.dnc))).code, ENRICH_ERROR.NOT_ALLOWED);
});
