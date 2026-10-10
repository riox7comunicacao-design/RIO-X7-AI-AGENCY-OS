'use strict';

// Auditoria final de EFICIÊNCIA e CONFIABILIDADE da pesquisa sob demanda (3.0.2): o orçamento de leituras de verificação (padrão conservador, configurável, com parada antecipada), a PERTINÊNCIA
// da fonte (empresa + campo; leitura genérica não prova nada), tráfego pago só quando solicitado, redes sociais inacessíveis = NAO_VERIFICADO e compatibilidade com o histórico. Peças REAIS: Approval
// Queue em arquivo temporário, autorizador, perfil comercial; FAKES: motor e leitura de página. Nenhuma rede, nenhum `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createLeadEnrichmentService } = require('../../src/services/leadEnrichmentService');
const { createInMemoryLeadProfileRepository } = require('../../src/research-prospector/leadProfileRepository');
const { buildPrompt } = require('../../src/prospecting-adapters/claudeEnrichmentEngine');
const resolution = require('../../src/research-prospector/enrichmentResolution');
const { integerFromEnv, ENRICHMENT_MAX_REQUESTS, ENRICHMENT_MAX_READS } = require('../../src/services/prospectingJobFileService');
const commercial = require('../../src/research-prospector/commercialProfile');
const digital = require('../../src/research-prospector/digitalPresence');
const { novoAmbiente, achado, admin } = require('../helpers/promotionFixtures');

const HOJE = '2026-10-08';
const SITE = 'https://clinicaalfa.com.br/';
const ORIGEM = 'https://clinicaalfa.com.br/contato';
// uma página PERTINENTE: da empresa e com os lugares onde cada campo apareceria — sem nenhum dado concreto
const TEXTO = 'Clínica Alfa. Sobre nós: nossa equipe e profissionais. Fale conosco e atendimento por e-mail. Endereço e localização. Siga nossas redes sociais no Instagram. Blog, novidades e eventos.';
// uma página real tem corpo: o texto é completado com um enchimento neutro (sem nenhum marcador de campo), porque telas quase vazias são recusadas como genéricas
const ENCHIMENTO = ' Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
const pagina = (url, texto = TEXTO, extras = {}) => ({ ok: true, urlFinal: url, texto: `${texto}${ENCHIMENTO}`, links: [], ...extras });

function perfilAutomatico(extras = {}) {
  const base = commercial.buildCommercialProfile({
    empresa: 'Clínica Alfa',
    siteOficial: { status: 'ENCONTRADO', url: SITE },
    presencaDigital: digital.buildPresence({ officialLinks: ['https://www.instagram.com/clinicaalfa', 'https://wa.me/5524988887777'] }),
    pages: [{ origem: SITE, oficial: true, texto: 'Clínica Alfa\nRua das Flores, 10 - Centro, Petrópolis - RJ, CEP 25600-000\nProprietária: Ana Souza Lima\nTel (24) 2222-3333', links: [{ href: 'https://wa.me/5524988887777' }, { href: 'https://www.instagram.com/clinicaalfa' }] }],
    fontesDescoberta: [{ url: 'https://www.guiamais.com.br/clinica-alfa', tipo: 'DIRETORIO' }],
    fontesValidacao: [{ url: SITE, tipo: 'OFICIAL' }],
    today: HOJE,
  });
  return { ...base, contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' }, enriquecimento: { status: 'NAO_EXECUTADO', camposPendentes: commercial.enrichmentNeeds(base), limiteDeTurnos: false, motivo: 'SOB_DEMANDA' }, jobId: 'JOB-20261008-001', ...extras };
}
const perfilVazio = () => ({ ...commercial.buildCommercialProfile({ empresa: 'Clínica Alfa', siteOficial: { status: 'NAO_ENCONTRADO', url: null }, pages: [], today: HOJE }), contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' } });

const motorFake = (resposta) => {
  const chamadas = [];
  return { chamadas, enrich: async (pedido) => { chamadas.push(pedido); return typeof resposta === 'function' ? resposta(pedido, chamadas.length) : resposta; } };
};
const resultado = (extras, telemetria = {}) => ({ ok: true, ...telemetria, resultados: [{ nome: 'Clínica Alfa', ...extras }] });

// `paginas`: url -> página; `lidas`: cada leitura que o leitor FAKE recebeu (o orçamento é medido aqui)
function montar(t, { motor, paginas = {}, perfil = perfilAutomatico(), leitor = true, opcoes = {} } = {}) {
  const env = novoAmbiente(t, { alfa: { finding: achado('Clínica Alfa', 'clinica-alfa') } });
  const perfis = createInMemoryLeadProfileRepository();
  const id = env.ids.alfa;
  if (perfil) perfis.save(id, perfil);
  const lidas = [];
  let relogio = Date.parse(`${HOJE}T12:00:00.000Z`);
  const servico = createLeadEnrichmentService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    queuePath: env.queuePath,
    profileRepository: perfis,
    enrichmentEngine: motor,
    ...(leitor ? { createFetchPage: () => async (url) => { lidas.push(url); return paginas[url] || { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' }; } } : {}),
    now: () => new Date((relogio += 400)),
    ...opcoes,
  });
  return { env, perfis, servico, id, lidas };
}
const rodar = async (x) => {
  await x.servico.start(admin(), x.id);
  await x.servico.waitFor(x.id);
};
const estado = (x) => x.servico.getStatus(admin(), x.id);
const ultima = (x) => x.perfis.getById(x.id).enriquecimento.ultimaExecucao;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// PERTINÊNCIA DA FONTE
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[EFI-1] uma fonte LIDA só sustenta "não encontrado" se for da empresa E pertinente ao campo: leitura genérica, página de outra empresa e página sem relação com o campo viram NAO_VERIFICADO com o motivo', async (t) => {
  const GENERICA = 'https://portal-noticias.com.br/politica';
  const SEM_CAMPO = 'https://clinicaalfa.com.br/privacidade';
  const TERCEIRO = 'https://www.guiamais.com.br/clinica-alfa/contato';
  const x = montar(t, {
    paginas: {
      [GENERICA]: pagina(GENERICA, 'Notícias de política, fale conosco e contato com a redação. Endereço e e-mail do jornal.'),
      [SEM_CAMPO]: pagina(SEM_CAMPO, 'Clínica Alfa. Política de privacidade e termos de uso.'),
      [TERCEIRO]: pagina(TERCEIRO, 'Clínica Alfa em Petrópolis. Contato, atendimento e e-mail.'),
    },
    motor: motorFake(resultado({ consultas: { emails: [GENERICA, SEM_CAMPO], presencaDigital: [SEM_CAMPO], atividadeRecente: [TERCEIRO] } })),
  });
  await rodar(x);
  const s = estado(x);
  assert.deepEqual([s.resolucao.emails.status, s.resolucao.emails.motivo], ['NAO_VERIFICADO', 'FONTE_NAO_PERTINENTE_AO_CAMPO'], 'a última fonte tentada era da empresa mas sem relação com e-mail');
  assert.deepEqual([s.resolucao.presencaDigital.status, s.resolucao.presencaDigital.motivo], ['NAO_VERIFICADO', 'FONTE_NAO_PERTINENTE_AO_CAMPO']);
  assert.deepEqual([s.resolucao.atividadeRecente.status, s.resolucao.atividadeRecente.motivo], ['NAO_VERIFICADO', 'FONTE_NAO_PERTINENTE_AO_CAMPO'], 'atividade só se conclui no site oficial ou em perfil já confirmado');
  assert.deepEqual(s.camposNaoEncontrados, []);
  assert.equal(s.status, 'INCOMPLETO');

  // a página genérica sozinha: nem é da empresa
  const so = montar(t, { paginas: { [GENERICA]: pagina(GENERICA, 'Notícias de política, fale conosco e contato.') }, motor: motorFake(resultado({ consultas: { emails: [GENERICA] } })) });
  await rodar(so);
  assert.equal(estado(so).resolucao.emails.motivo, 'FONTE_NAO_PERTINENTE_A_EMPRESA');
});

test('[EFI-2] fonte pertinente: página de terceiro que cita a empresa e traz o contato documenta e-mail; o site oficial com blog/novidades documenta a atividade; tráfego pago NUNCA se documenta por leitura de página', async (t) => {
  const TERCEIRO = 'https://www.guiamais.com.br/clinica-alfa/contato';
  const BLOG = 'https://clinicaalfa.com.br/blog';
  const x = montar(t, {
    paginas: { [TERCEIRO]: pagina(TERCEIRO, 'Clínica Alfa em Petrópolis. Contato, atendimento e e-mail.'), [BLOG]: pagina(BLOG, 'Clínica Alfa — blog, novidades e artigos.') },
    motor: motorFake(resultado({ consultas: { emails: [TERCEIRO], atividadeRecente: [BLOG], trafegoPago: [BLOG] } })),
  });
  await rodar(x);
  const s = estado(x);
  assert.deepEqual([s.resolucao.emails.status, s.resolucao.emails.fontes], ['NAO_ENCONTRADO_COM_VERIFICACAO', [TERCEIRO]]);
  assert.deepEqual([s.resolucao.atividadeRecente.status, s.resolucao.atividadeRecente.fontes], ['NAO_ENCONTRADO_COM_VERIFICACAO', [BLOG]]);
  assert.equal(s.resolucao.trafegoPago.status, 'NAO_VERIFICADO', 'consulta de tráfego pago por página não vale');
  assert.equal(x.lidas.includes(BLOG), true);
  assert.equal(x.lidas.filter((url) => url === BLOG).length, 1);
  assert.equal(resolution.assessSource('trafegoPago', pagina(BLOG), BLOG, { company: 'Clínica Alfa', officialOrigin: 'https://clinicaalfa.com.br', knownUrls: [] }).motivo, 'FONTE_NAO_APLICAVEL');
});

test('[EFI-3] se a PÁGINA OFICIAL lida traz o dado que o motor deixou de fora (e-mail), ele entra por código e o campo é ENCONTRADO — a ausência nunca é "documentada" contra a evidência', async (t) => {
  const CONTATO = 'https://clinicaalfa.com.br/fale-conosco';
  const x = montar(t, {
    paginas: { [CONTATO]: pagina(CONTATO, 'Clínica Alfa. Fale conosco: contato@clinicaalfa.com.br. Atendimento de segunda a sexta.', { links: [{ href: 'mailto:contato@clinicaalfa.com.br' }] }) },
    motor: motorFake(resultado({ consultas: { emails: [CONTATO] } })),
  });
  await rodar(x);
  const s = estado(x);
  assert.equal(s.resolucao.emails.status, 'ENCONTRADO', 'o perfil agora tem o e-mail: o campo saiu das pendências');
  assert.deepEqual(x.perfis.getById(x.id).emails.map((e) => e.email), ['contato@clinicaalfa.com.br']);
  assert.ok(ultima(x).camposObtidos.includes('emails'));
  assert.equal(s.camposNaoEncontrados.includes('emails'), false);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// ORÇAMENTO DE LEITURAS e PARADA ANTECIPADA
// ---------------------------------------------------------------------------------------------------------------------------------------------

const paginasDeTodosOsCampos = () => {
  const paginas = {};
  const consultas = {};
  for (const campo of ['siteOficial', 'responsavel', 'endereco', 'telefones', 'whatsapps', 'emails', 'presencaDigital', 'atividadeRecente']) {
    const url = `https://clinicaalfa.com.br/${campo.toLowerCase()}`;
    paginas[url] = pagina(url);
    consultas[campo] = [url];
  }
  return { paginas, consultas };
};

test('[EFI-4] o orçamento padrão é CONSERVADOR (4 páginas distintas): ao esgotar, o resto vira NAO_VERIFICADO/LIMITE_DE_LEITURAS e o registro mostra leituras, limite e o encerramento; configurável, inclusive 0', async (t) => {
  const { paginas, consultas } = paginasDeTodosOsCampos();
  const padrao = montar(t, { perfil: perfilVazio(), paginas, motor: motorFake(resultado({ consultas })) });
  await rodar(padrao);
  assert.equal(padrao.lidas.length, 4, 'o padrão lê no máximo 4 páginas distintas');
  assert.deepEqual(ultima(padrao).verificacao, { leituras: 4, limite: 4, encerramento: 'ORCAMENTO_ESGOTADO' });
  const s = estado(padrao);
  assert.equal(s.camposNaoEncontrados.length, 3, 'o responsável numa página de terceiro é pertinente mas INSUFICIENTE: não conta como ausência documentada');
  const cortados = Object.entries(s.resolucao).filter(([, e]) => e.motivo === 'LIMITE_DE_LEITURAS').map(([campo]) => campo);
  assert.ok(cortados.length >= 3, 'os campos que ficaram sem conferir dizem por quê');
  assert.equal(s.status, 'INCOMPLETO');

  const dois = montar(t, { perfil: perfilVazio(), paginas, motor: motorFake(resultado({ consultas })), opcoes: { maxVerificationReads: 2 } });
  await rodar(dois);
  assert.deepEqual([dois.lidas.length, ultima(dois).verificacao.limite], [2, 2]);

  const zero = montar(t, { perfil: perfilVazio(), paginas, motor: motorFake(resultado({ consultas })), opcoes: { maxVerificationReads: 0 } });
  await rodar(zero);
  assert.equal(zero.lidas.length, 0, '0 desliga a verificação');
  assert.equal(estado(zero).camposNaoEncontrados.length, 0);
  assert.equal(estado(zero).resolucao.emails.motivo, 'LIMITE_DE_LEITURAS');
  assert.equal(ultima(zero).verificacao.encerramento, 'ORCAMENTO_ESGOTADO');

  for (const invalido of [{ maxVerificationReads: -1 }, { maxVerificationReads: 11 }, { maxVerificationReads: 1.5 }, { maxReadsPerField: 0 }, { maxReadsPerField: 4 }]) {
    assert.throws(() => montar(t, { motor: motorFake(resultado({})), opcoes: invalido }), /deve ser um inteiro/, JSON.stringify(invalido));
  }
});

test('[EFI-5] PARADA ANTECIPADA: para na primeira fonte pertinente de cada campo; a mesma página para dois campos é lida uma vez; nenhuma leitura se tudo foi achado, se a execução foi cortada, se o dado foi descartado ou se não há fonte citada', async (t) => {
  const A = 'https://clinicaalfa.com.br/a';
  const B = 'https://clinicaalfa.com.br/b';
  const C = 'https://clinicaalfa.com.br/c';
  const ruim = 'https://portal-noticias.com.br/x';
  const x = montar(t, {
    paginas: { [A]: pagina(A), [B]: pagina(B), [C]: pagina(C), [ruim]: pagina(ruim, 'Notícias de política.') },
    motor: motorFake(resultado({ consultas: { emails: [A, B], presencaDigital: [A, C], atividadeRecente: [ruim, B] } })),
  });
  await rodar(x);
  assert.deepEqual(x.lidas, [A, ruim, B], 'e-mails: A basta (B não é lida); presença: A já está no cache; atividade: a ruim é recusada e B (já lida) basta');
  assert.deepEqual(ultima(x).verificacao, { leituras: 3, limite: 4, encerramento: 'CAMPOS_RESOLVIDOS' });

  const tudoAchado = montar(t, { paginas: { [A]: pagina(A) }, motor: motorFake(resultado({ emails: [{ email: 'a@clinicaalfa.com.br', origem: ORIGEM }], presencaDigital: { facebook: 'https://www.facebook.com/clinicaalfa', youtube: 'https://www.youtube.com/@clinicaalfa', linkedin: 'https://www.linkedin.com/company/clinicaalfa', tiktok: 'https://www.tiktok.com/@clinicaalfa' }, trafegoPago: { meta: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://www.facebook.com/ads/library/?q=a' }, google: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://adstransparency.google.com/?q=a' }, tiktok: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://library.tiktok.com/ads?q=a' } }, atividadeRecente: { canal: 'instagram', url: 'https://www.instagram.com/clinicaalfa/p/1', data: '2026-10-05' }, consultas: { emails: [A] } })) });
  await rodar(tudoAchado);
  assert.equal(tudoAchado.lidas.length, 0, 'nada a conferir: nenhuma leitura');
  assert.equal(ultima(tudoAchado).verificacao.encerramento, 'NENHUMA_LEITURA_NECESSARIA');

  const cortada = montar(t, { paginas: { [A]: pagina(A) }, motor: motorFake({ ...resultado({ consultas: { emails: [A] } }), limiteDeTurnos: true }) });
  await rodar(cortada);
  assert.equal(cortada.lidas.length, 0, 'execução cortada: nada é conferido nem documentado');

  const descartado = montar(t, { perfil: perfilVazio(), paginas: { [A]: pagina(A) }, motor: motorFake(resultado({ emails: [{ email: 'sem-origem@x.com' }], consultas: { emails: [A] } })) });
  await rodar(descartado);
  assert.equal(descartado.lidas.length, 0, 'o dado descartado não vira "não encontrado" por uma leitura');
  assert.equal(estado(descartado).resolucao.emails.motivo, 'FORMATO_OU_ORIGEM_INVALIDOS');

  const semFonte = montar(t, { motor: motorFake(resultado({})) });
  await rodar(semFonte);
  assert.equal(semFonte.lidas.length, 0, 'sem fonte citada, sem leitura');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// TRÁFEGO PAGO SÓ QUANDO SOLICITADO; REDES SOCIAIS
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[EFI-6] tráfego pago NÃO solicitado: o prompt não descreve nem cita bibliotecas de anúncios, a resposta sobre anúncios é ignorada e a conclusão não exige consulta alguma a plataformas', async (t) => {
  const sem = buildPrompt([{ nome: 'Clínica Alfa', cidade: 'Petrópolis', uf: 'RJ', precisa: ['emails', 'atividadeRecente'] }]);
  assert.equal(/ads\/library|adstransparency|library\.tiktok|trafegoPago/.test(sem.replace(/PROCURAR:[^\n]*/g, '')), false, 'nenhuma regra de anúncios no pedido');
  assert.equal(/trafegoPago/.test(sem), false);
  const com = buildPrompt([{ nome: 'Clínica Alfa', cidade: 'Petrópolis', uf: 'RJ', precisa: ['trafegoPago'] }]);
  assert.match(com, /facebook\.com\/ads\/library/);
  assert.equal(/- responsavel:|- telefones\/whatsapps\/emails:/.test(com), false, 'só as regras do que foi pedido');

  // registro antigo que pediu só 3 campos (sem tráfego pago): a nova tentativa não pede nem exige anúncios, e o que o motor disser sobre anúncios é ignorado
  const A = 'https://clinicaalfa.com.br/a';
  const antigo = { iniciadoEm: '2026-10-09T01:09:39.465Z', concluidoEm: '2026-10-09T01:10:00.957Z', duracaoMs: 21492, custoUsd: 0.067777, turnos: 5, camposSolicitados: ['emails', 'atividadeRecente'], camposObtidos: [], camposPendentes: [], resultado: 'COMPLETO', motivo: null, fontes: [] };
  const motor = motorFake(resultado({ trafegoPago: { meta: { resultado: 'EVIDENCIA_ENCONTRADA', url: 'https://www.facebook.com/ads/library/?id=1', data: '2026-10-01' } }, consultas: { emails: [A], atividadeRecente: [A], trafegoPago: [A] } }));
  const x = montar(t, {
    paginas: { [A]: pagina(A) },
    perfil: perfilAutomatico({ enriquecimento: { status: 'COMPLETO', camposPendentes: [], camposNaoEncontrados: ['emails', 'atividadeRecente'], limiteDeTurnos: false, ultimaExecucao: antigo, execucoes: [antigo] } }),
    motor,
  });
  await rodar(x);
  assert.deepEqual(x.lidas, [A]);
  assert.deepEqual(motor.chamadas[0].leads[0].precisa, ['emails', 'atividadeRecente'], 'tráfego pago não foi pedido ao motor');
  assert.equal(/ads\/library/.test(buildPrompt(motor.chamadas[0].leads)), false);
  const s = estado(x);
  assert.deepEqual([s.status, s.pesquisaCompleta], ['COMPLETO', true], 'tráfego pago nunca foi pedido: não bloqueia a conclusão');
  assert.equal(x.perfis.getById(x.id).trafegoPago.meta.status === 'EVIDENCIA_ENCONTRADA', false, 'a resposta sobre anúncios não pedida foi ignorada');
});

test('[EFI-7] REDES SOCIAIS e outras fontes inacessíveis: Instagram/Facebook que não abrem, páginas de login e leitor ausente mantêm NAO_VERIFICADO (com o motivo), nunca "não encontrado"', async (t) => {
  const INSTA = 'https://www.instagram.com/clinicaalfa/';
  const FACE = 'https://www.facebook.com/clinicaalfa';
  const LOGIN = 'https://www.instagram.com/accounts/login/';
  const inacessivel = montar(t, { motor: motorFake(resultado({ consultas: { presencaDigital: [INSTA, FACE], atividadeRecente: [INSTA] } })) });
  await rodar(inacessivel);
  const a = estado(inacessivel);
  assert.deepEqual([a.resolucao.presencaDigital.status, a.resolucao.presencaDigital.motivo], ['NAO_VERIFICADO', 'FONTES_NAO_CONFIRMADAS']);
  assert.deepEqual([a.resolucao.atividadeRecente.status, a.resolucao.atividadeRecente.motivo], ['NAO_VERIFICADO', 'FONTES_NAO_CONFIRMADAS']);
  assert.deepEqual(a.camposNaoEncontrados, []);

  // abre, mas é uma página de login (não é da empresa): não documenta nada
  const parede = montar(t, { paginas: { [LOGIN]: pagina(LOGIN, 'Entrar no Instagram. Faça login para continuar. Cadastre-se.') }, motor: motorFake(resultado({ consultas: { presencaDigital: [LOGIN] } })) });
  await rodar(parede);
  assert.deepEqual([estado(parede).resolucao.presencaDigital.status, estado(parede).resolucao.presencaDigital.motivo], ['NAO_VERIFICADO', 'PAGINA_DE_LOGIN_OU_BLOQUEIO']);

  const semLeitor = montar(t, { leitor: false, motor: motorFake(resultado({ consultas: { presencaDigital: [INSTA] } })) });
  await rodar(semLeitor);
  assert.equal(estado(semLeitor).resolucao.presencaDigital.motivo, 'SEM_LEITURA_DE_PAGINA');
  assert.equal(estado(semLeitor).status, 'INCOMPLETO');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// COMPATIBILIDADE e CONFIGURAÇÃO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[EFI-8] compatibilidade: o histórico real de um registro antigo fica intacto depois de uma nova execução com orçamento; registros novos trazem `verificacao`, os antigos não ganham nada', async (t) => {
  const A = 'https://clinicaalfa.com.br/a';
  const antigo = { iniciadoEm: '2026-10-09T01:09:39.465Z', concluidoEm: '2026-10-09T01:10:00.957Z', duracaoMs: 21492, custoUsd: 0.067777, webSearchRequests: 0, turnos: 5, camposSolicitados: ['emails', 'atividadeRecente'], camposObtidos: [], camposPendentes: [], resultado: 'COMPLETO', motivo: null, fontes: [] };
  const x = montar(t, {
    paginas: { [A]: pagina(A) },
    perfil: perfilAutomatico({ enriquecimento: { status: 'COMPLETO', camposPendentes: [], camposNaoEncontrados: ['emails', 'atividadeRecente'], limiteDeTurnos: false, ultimaExecucao: { ...antigo }, execucoes: [{ ...antigo }] } }),
    motor: motorFake(resultado({ consultas: { emails: [A], atividadeRecente: [A] } })),
  });
  assert.equal('verificacao' in estado(x).ultimaExecucao, false, 'ler não acrescenta nada ao registro antigo');
  await rodar(x);
  const info = x.perfis.getById(x.id).enriquecimento;
  assert.deepEqual(info.execucoes[0], antigo);
  assert.deepEqual(info.legado && [info.legado.origem, info.legado.statusAnterior], ['LEGADO', 'COMPLETO']);
  assert.deepEqual(info.ultimaExecucao.verificacao, { leituras: 1, limite: 4, encerramento: 'CAMPOS_RESOLVIDOS' });
  assert.equal(estado(x).status, 'COMPLETO');
});

test('[EFI-9] configuração por ambiente: padrões conservadores (16 requisições, 4 leituras), valores inválidos ou fora da faixa voltam ao padrão, valores válidos são respeitados', () => {
  assert.deepEqual([ENRICHMENT_MAX_REQUESTS, ENRICHMENT_MAX_READS], [16, 4]);
  const requisicoes = (valor) => integerFromEnv(valor === undefined ? {} : { X: valor }, 'X', ENRICHMENT_MAX_REQUESTS, 8, 60);
  assert.deepEqual([undefined, '', 'abc', '7', '61', '-1', '4.5', '1e2', ' 20 ', '8', '60'].map(requisicoes), [16, 16, 16, 16, 16, 16, 16, 16, 20, 8, 60]);
  const leituras = (valor) => integerFromEnv({ X: valor }, 'X', ENRICHMENT_MAX_READS, 0, 10);
  assert.deepEqual(['0', '3', '10', '11', 'x'].map(leituras), [0, 3, 10, 4, 4]);
});
