'use strict';

// Peças de teste do job de prospecção (Fase 2 / Implementação 2) — USO SOMENTE EM TESTES (src/ nunca importa este arquivo).
// REAIS: contextos emitidos, a ponte real de PROPOSE:LEAD_APPROVAL, o Brief Service, o Prospecting Service (caminho oficial de ingestão: exclusões ->
// deduplicação -> DNC -> Approval Queue), o CRM Service e a verificação por código — tudo em diretório temporário.
// FAKES: só o motor externo (o `claude -p`) e a leitura de página (a rede). Nenhuma pesquisa real, nenhuma rede, nenhum `claude`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { authorizeProposerForLeadApproval, authorizeCrmOperation } = require('../../src/auth');
const { createProspectingJobService } = require('../../src/services/prospectingJobService');
const { createProspectingBriefService } = require('../../src/services/prospectingBriefService');
const { createFileBackedProspectingService } = require('../../src/services/prospectingFileService');
const { createFileBackedCrmService } = require('../../src/services/crmFileService');
const { createInMemoryBriefRepository } = require('../../src/research-prospector/briefRepository');
const { createInMemoryJobRepository } = require('../../src/research-prospector/jobRepository');
const { createKnownLeadIdentities } = require('../../src/services/knownLeadIdentities');
const { createInMemoryLeadProfileRepository } = require('../../src/research-prospector/leadProfileRepository');
const { admin } = require('./promotionFixtures');

const AGORA = new Date('2026-10-06T12:00:00.000Z');
const MARCADOR = 'MARCADOR-DE-TEXTO-DA-PAGINA-NAO-PERSISTIR';

const briefInput = (extra = {}) => ({ nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis/RJ', quantidade: 3, ...extra });

// O site de uma empresa fictícia: https://<slug>.com.br/ (o rótulo do domínio é o slug).
const siteDe = (slug) => `https://${slug}.com.br/`;
const FONTE_BUSCA = 'https://busca.example.test/r';

// Uma página que SE COMPROVA (nome, nicho e cidade no texto, nome também na identidade); `sem` tira evidências; `links` são os links publicados na página.
function paginaBoa(nome, slug, { sem = [], links = [], semIdentidade = false, urlFinal } = {}) {
  const linhas = [nome, `${MARCADOR} ${slug}`];
  if (!sem.includes('nicho')) linhas.push('Clínica de estética e harmonização facial');
  if (!sem.includes('localizacao')) linhas.push('Rua das Flores, 10 - Petrópolis - RJ');
  return {
    ok: true,
    urlFinal: urlFinal || siteDe(slug),
    links: links.map((href) => ({ href })),
    temFormularioContato: false,
    texto: sem.includes('empresa') ? linhas.slice(1).join('\n') : linhas.join('\n'),
    identidade: semIdentidade || sem.includes('empresa') ? 'Bem-vindo' : `${nome} | Clínica`,
  };
}

// Uma página de TERCEIRO (diretório/notícia): o texto menciona a empresa, o nicho e a cidade; a identidade é a da própria página.
function paginaTerceiro(url, { texto, links = [] } = {}) {
  return { ok: true, urlFinal: url, links: links.map((href) => ({ href })), temFormularioContato: false, texto, identidade: 'Portal de notícias' };
}

// O candidato como o motor o devolve (contrato novo): site oficial (hipótese), fontes e perfis sugeridos.
const candidato = (nome, slug, extras = {}) => ({ nome, siteOficial: siteDe(slug), fontesDescoberta: [{ url: FONTE_BUSCA, tipo: 'NOTICIA_OU_TERCEIRO' }], presencaDigital: {}, ...extras });

// Motor de descoberta FAKE: devolve as rodadas na ordem; registra cada pedido; `espera` segura a resposta até ser liberada ou abortada.
function motorFake({ rodadas = [], falha, espera, porPedido } = {}) {
  const pedidos = [];
  return {
    pedidos,
    discover: async (pedido) => {
      pedidos.push(pedido);
      if (espera) {
        const abortado = await espera(pedido);
        if (abortado) return { ok: false, code: 'ABORTED' };
      }
      if (falha) return { ok: false, code: falha };
      const rodada = porPedido ? porPedido(pedidos.length, pedido) : rodadas[pedidos.length - 1] || { candidatos: [] };
      return { ok: true, candidatos: rodada.candidatos, invalidos: 0, ...(rodada.telemetria || {}) };
    },
  };
}

// Espera que só termina quando o pedido é ABORTADO (devolve true) ou liberada (devolve false).
function esperaAteAbortar() {
  let liberar;
  const liberada = new Promise((resolve) => {
    liberar = resolve;
  });
  const espera = (pedido) =>
    new Promise((resolve) => {
      if (pedido.signal.aborted) return resolve(true);
      pedido.signal.addEventListener('abort', () => resolve(true), { once: true });
      liberada.then(() => resolve(false));
      return undefined;
    });
  return { espera, liberar };
}

function ambiente(t, { motor, paginas = {}, fetchPage: fetchPageProprio, exclusao, limits, briefService: briefServiceProprio, repository, now, enriquecimento, conhecidos } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-svc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const crmService = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: path.join(dir, 'crm.json') });
  const prospectingService = createFileBackedProspectingService({
    authorizeProposer: authorizeProposerForLeadApproval,
    authorizeOperation: authorizeCrmOperation,
    queuePath: path.join(dir, 'approval-queue.json'),
    crmService,
    batchPath: path.join(dir, 'prospecting-batches.json'),
    dossierPath: path.join(dir, 'prospecting-dossiers.json'),
  });
  const briefRepo = createInMemoryBriefRepository();
  const briefService = createProspectingBriefService({ authorizeProposer: authorizeProposerForLeadApproval, prospectingService, repository: briefRepo, now: () => AGORA, checkPermanentExclusion: exclusao });
  const paginasChamadas = [];
  const fetchPage = fetchPageProprio || (async (url) => {
    paginasChamadas.push(url);
    return paginas[url] || { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' };
  });
  const jobs = repository || createInMemoryJobRepository();
  // o Brief Service real é congelado: o espião é um invólucro que registra cada ingestão (tamanho e achados) e repassa ao real
  const ingestoes = [];
  const achadosIngeridos = [];
  const pacotes = [];
  const espiao = {
    getBrief: briefService.getBrief,
    markResearching: briefService.markResearching,
    createBrief: briefService.createBrief,
    markReadyForResearch: briefService.markReadyForResearch,
    generateResearchPackage: async (...args) => {
      pacotes.push(args[1]);
      return briefService.generateResearchPackage(...args);
    },
    ingestFindings: async (...args) => {
      ingestoes.push(args[2].length);
      achadosIngeridos.push(...args[2]);
      return briefService.ingestFindings(...args);
    },
    ingestReplacementFindings: async (...args) => {
      ingestoes.push(args[2].length);
      achadosIngeridos.push(...args[2]);
      return briefService.ingestReplacementFindings(...args);
    },
  };
  const perfis = createInMemoryLeadProfileRepository();
  const servico = createProspectingJobService({
    profileRepository: perfis,
    // a lista de identidades JÁ CONHECIDAS (fila + CRM reais do ambiente) que a descoberta recebe: só com `conhecidos: true` (3.0.1). Sem ela é o fluxo ANTERIOR, em que a deduplicação
    // do pipeline (DNC, duplicado, já na fila) é quem barra — os testes dessa barreira continuam valendo e provam que ela segue sendo a autoridade final.
    ...(typeof conhecidos === 'function' ? { knownIdentities: conhecidos } : conhecidos !== true ? {} : { knownIdentities: createKnownLeadIdentities({ queuePath: path.join(dir, 'approval-queue.json'), crmService }) }),
    ...(enriquecimento ? { enrichmentEngine: enriquecimento } : {}),
    authorizeProposer: authorizeProposerForLeadApproval,
    briefService: briefServiceProprio ? briefServiceProprio(briefService) : espiao,
    repository: jobs,
    discoveryEngine: motor || motorFake(),
    createFetchPage: () => fetchPage,
    checkPermanentExclusion: exclusao,
    now: now || (() => new Date()),
    limits,
  });
  return { dir, perfis, crmService, prospectingService, briefService, briefRepo, jobs, servico, paginasChamadas, fetchPage, ingestoes, achadosIngeridos, pacotes };
}

async function briefPronto(env, input = {}) {
  const brief = await env.briefService.createBrief(admin(), briefInput(input));
  await env.briefService.markReadyForResearch(admin(), brief.id);
  return brief;
}

async function iniciar(env, input) {
  const brief = await briefPronto(env, input);
  const job = await env.servico.startJob(admin(), { briefId: brief.id });
  return { brief, job };
}

async function erroDe(fn) {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava que lançasse, e não lançou');
}

const tresBons = () => [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Beta', 'beta'), candidato('Clínica Gama', 'gama')];
const paginasBoas = () => ({
  [siteDe('alfa')]: paginaBoa('Clínica Alfa', 'alfa'),
  [siteDe('beta')]: paginaBoa('Clínica Beta', 'beta'),
  [siteDe('gama')]: paginaBoa('Clínica Gama', 'gama'),
  [siteDe('delta')]: paginaBoa('Clínica Delta', 'delta'),
});

module.exports = {
  AGORA,
  MARCADOR,
  FONTE_BUSCA,
  briefInput,
  siteDe,
  paginaBoa,
  paginaTerceiro,
  candidato,
  motorFake,
  esperaAteAbortar,
  ambiente,
  briefPronto,
  iniciar,
  erroDe,
  tresBons,
  paginasBoas,
};
