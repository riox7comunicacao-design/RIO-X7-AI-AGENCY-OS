'use strict';

// Correção de INTEGRIDADE COMERCIAL 3.0.2 (após a auditoria da última pesquisa real da Empresa Exemplo Alfa):
//   1. um responsável PENDENTE_DE_CONFIRMACAO nunca é dado como ausente por uma pesquisa que não achou outro — nem numa leitura de registro histórico;
//   2. PERTINENTE != SUFICIENTE: uma página de cadastro de terceiro com "sócio" não prova ausência de responsável; um candidato/contato visível é CANDIDATO sem vínculo, nunca ENCONTRADO;
//   3. cada tentativa registra os testes (nome, marcador, conteúdo, suficiência), sem texto de página.
// Peças REAIS: fila, autorizador, perfil comercial; FAKES: motor e leitura de página. Nenhuma rede, nenhum `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createLeadEnrichmentService } = require('../../src/services/leadEnrichmentService');
const { createInMemoryLeadProfileRepository } = require('../../src/research-prospector/leadProfileRepository');
const resolution = require('../../src/research-prospector/enrichmentResolution');
const commercial = require('../../src/research-prospector/commercialProfile');
const { novoAmbiente, achado, admin } = require('../helpers/promotionFixtures');

const HOJE = '2026-10-08';
const NOME = 'Empresa Exemplo Alfa Centro Estético';
const AGREGADOR = 'https://agregador-exemplo.com.br/empresas/11111111000100';
const REGISTRO = 'https://registro-exemplo.com.br/consulta-empresa/22222222000100-empresa-exemplo-beta-servicos-ltda';
const DIRETORIO = 'https://diretorio-exemplo.com.br/empresa/empresa-exemplo-alfa';
const ENCHIMENTO = ' Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
const pagina = (url, texto, extras = {}) => ({ ok: true, urlFinal: url, texto: `${texto}${ENCHIMENTO}`, links: [], ...extras });

// o responsável que a Empresa Exemplo Alfa já tem: encontrado numa fonte de terceiro, SEM o vínculo com a empresa demonstrado (a leitura o mostra como PENDENTE_DE_CONFIRMACAO)
const RESPONSAVEL_GRAVADO = Object.freeze({ status: 'ENCONTRADO', nome: 'Pessoa Teste Alfa', cargo: 'Sócio-Administrador', origem: AGREGADOR, confianca: 'MEDIA' });

function perfilExemplo(extras = {}) {
  const base = commercial.buildCommercialProfile({ empresa: NOME, siteOficial: { status: 'NAO_ENCONTRADO', url: null }, pages: [], fontesValidacao: [{ url: DIRETORIO, tipo: 'NOTICIA_OU_TERCEIRO' }], today: HOJE });
  return { ...base, telefones: [{ numero: '+552422220001', origem: DIRETORIO, celular: false }], contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' }, enriquecimento: { status: 'NAO_EXECUTADO', camposPendentes: [], limiteDeTurnos: false, motivo: 'SOB_DEMANDA' }, ...extras };
}
const motorFake = (resposta) => {
  const chamadas = [];
  return { chamadas, enrich: async (pedido) => { chamadas.push(pedido); return typeof resposta === 'function' ? resposta(pedido, chamadas.length) : resposta; } };
};
const resultado = (extras) => ({ ok: true, subtype: 'success', terminalReason: 'completed', resultados: [{ nome: NOME, ...extras }] });

function montar(t, { motor, paginas = {}, perfil = perfilExemplo() } = {}) {
  const env = novoAmbiente(t, { alfa: { finding: achado(NOME, 'empresa-exemplo-alfa') } });
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
    createFetchPage: () => async (url) => { lidas.push(url); return paginas[url] || { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' }; },
    now: () => new Date((relogio += 400)),
  });
  return { env, perfis, servico, id, lidas };
}
const rodar = async (x) => {
  await x.servico.start(admin(), x.id);
  await x.servico.waitFor(x.id);
};
const estado = (x) => x.servico.getStatus(admin(), x.id);
const perfilDe = (x) => x.perfis.getById(x.id);
const ultima = (x) => perfilDe(x).enriquecimento.ultimaExecucao;
const TESTES = (nome, marcador, conteudo, suficiencia) => ({ nome, marcador, conteudo, suficiencia });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1. RESPONSÁVEL PENDENTE
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[COM-1] responsável PENDENTE + nova pesquisa SEM resultado: continua NAO_VERIFICADO/pendente (nunca "ausente"), o nome/cargo/fonte gravados ficam, o campo segue pesquisável e o painel não contradiz o perfil', async (t) => {
  const x = montar(t, {
    perfil: perfilExemplo({ responsavel: { ...RESPONSAVEL_GRAVADO, status: 'PENDENTE_DE_CONFIRMACAO', confianca: 'BAIXA', vinculo: { demonstrado: false, motivo: 'EMPRESA_NAO_CITADA_NA_PAGINA' } } }),
    // a página de cadastro (terceiro) é da empresa e fala de "sócio", mas não traz nenhum responsável utilizável
    paginas: { [REGISTRO]: pagina(REGISTRO, 'Empresa Exemplo Alfa Centro Estético, Petrópolis. Quadro societário: sócios e administrador (consulte o cadastro completo).') },
    motor: motorFake(resultado({ consultas: { responsavel: [REGISTRO] } })),
  });
  const gravado = JSON.stringify(perfilDe(x).responsavel);
  await rodar(x);
  const r = estado(x).resolucao.responsavel;
  assert.deepEqual([r.status, r.resolvido, r.motivo], ['NAO_VERIFICADO', false, 'PENDENTE_DE_CONFIRMACAO']);
  assert.equal(estado(x).camposNaoEncontrados.includes('responsavel'), false, 'nunca documentado como ausente');
  assert.equal(estado(x).camposPendentes.includes('responsavel'), true, 'segue elegível para nova pesquisa manual');
  assert.equal(estado(x).podeCompletar, true);
  assert.equal(JSON.stringify(perfilDe(x).responsavel), gravado, 'nome, cargo, fonte e vínculo gravados ficam como estavam');
  assert.equal(perfilDe(x).responsaveisAnteriores, undefined);
  // a tentativa foi registrada com a fonte e os testes
  assert.equal(r.tentativas[0].url, REGISTRO);
  assert.equal(r.fontes, undefined, 'não há "fonte que sustentou a ausência"');
  assert.deepEqual(r.tentativas[0].testes, TESTES('PASSOU', 'PASSOU', 'PASSOU', 'INSUFICIENTE'));
  assert.equal(r.tentativas[0].pertinencia, 'PERTINENTE');
});

test('[COM-2] REGISTRO HISTÓRICO que deu o responsável como "não encontrado após verificação" (a execução real da Empresa Exemplo Alfa): a leitura o mostra NAO_VERIFICADO/pendente, pesquisável, com as evidências da tentativa — o registro em disco não é reescrito', async (t) => {
  const historico = { iniciadoEm: '2026-10-09T03:13:56.611Z', concluidoEm: '2026-10-09T03:14:25.414Z', duracaoMs: 28800, custoUsd: 0.0864, turnos: 5, subtype: 'success', terminalReason: 'completed', camposSolicitados: ['responsavel', 'emails'], camposObtidos: [], resultado: 'INCOMPLETO', motivo: 'VERIFICACAO_INSUFICIENTE', encerramento: 'CONCLUIDA', fontes: [], fontesNovas: [], resultadosPorCampo: {} };
  const entrada = { status: 'NAO_ENCONTRADO_COM_VERIFICACAO', resolvido: true, fontes: [REGISTRO], citadas: [REGISTRO], tentativas: [{ url: REGISTRO, leitura: 'OK', pertinencia: 'PERTINENTE' }], execucao: historico.iniciadoEm };
  const x = montar(t, {
    motor: motorFake(resultado({})),
    perfil: perfilExemplo({ responsavel: RESPONSAVEL_GRAVADO, enriquecimento: { status: 'INCOMPLETO', motivo: 'VERIFICACAO_INSUFICIENTE', limiteDeTurnos: false, camposPendentes: ['emails'], camposNaoEncontrados: ['responsavel'], resolucao: { responsavel: entrada }, ultimaExecucao: historico, execucoes: [historico] } }),
  });
  const emDisco = JSON.stringify(perfilDe(x));
  const s = estado(x);
  assert.deepEqual([s.resolucao.responsavel.status, s.resolucao.responsavel.motivo, s.resolucao.responsavel.resolvido], ['NAO_VERIFICADO', 'PENDENTE_DE_CONFIRMACAO', false]);
  assert.equal(s.camposNaoEncontrados.includes('responsavel'), false);
  assert.equal(s.camposPendentes.includes('responsavel'), true);
  assert.deepEqual(s.resolucao.responsavel.tentativas, entrada.tentativas, 'as evidências da tentativa continuam visíveis');
  assert.equal(s.resolucao.responsavel.fontes, undefined);
  assert.equal(commercial.presentProfile(perfilDe(x)).responsavel.status, 'PENDENTE_DE_CONFIRMACAO', 'perfil e painel dizem a mesma coisa');
  assert.equal(JSON.stringify(perfilDe(x)), emDisco, 'ler não reescreve o histórico');
  assert.equal(commercial.responsibleLinkState(perfilDe(x)), 'NAO_DEMONSTRADO', 'nenhum vínculo/CNPJ foi associado');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2. FONTES DE TERCEIROS: pertinente != suficiente
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[COM-3] página de cadastro de terceiro com o marcador "sócio" mas SEM responsável validado: pertinente, porém INSUFICIENTE — o responsável segue NAO_VERIFICADO (FONTE_PERTINENTE_MAS_INSUFICIENTE), nunca "não encontrado"', async (t) => {
  const x = montar(t, {
    paginas: { [REGISTRO]: pagina(REGISTRO, 'Empresa Exemplo Alfa Centro Estético. Sócios e administradores da empresa. Situação cadastral ativa.') },
    motor: motorFake(resultado({ consultas: { responsavel: [REGISTRO] } })),
  });
  await rodar(x);
  const r = estado(x).resolucao.responsavel;
  assert.deepEqual([r.status, r.motivo, r.resolvido], ['NAO_VERIFICADO', 'FONTE_PERTINENTE_MAS_INSUFICIENTE', false]);
  assert.deepEqual(r.tentativas, [{ url: REGISTRO, leitura: 'OK', pertinencia: 'PERTINENTE', testes: TESTES('PASSOU', 'PASSOU', 'PASSOU', 'INSUFICIENTE'), candidatos: 0 }]);
  assert.equal(estado(x).camposNaoEncontrados.includes('responsavel'), false);
  assert.equal(perfilDe(x).responsavel.status, 'NAO_ENCONTRADO', 'nada foi inventado nem associado');
});

test('[COM-4] CANDIDATO de outra empresa e HOMÔNIMOS/razões sociais diferentes: a página de outra empresa não é pertinente; duas páginas com razões sociais/CNPJs distintos e candidatos sem vínculo NÃO são associadas à empresa — NAO_VERIFICADO, nada gravado', async (t) => {
  const OUTRA = 'https://cadastro.exemplo.com.br/clinica-beta';
  const HOMONIMA = 'https://cadastro.exemplo.com.br/empresa-exemplo-alfa-ltda';
  const x = montar(t, {
    paginas: {
      [OUTRA]: pagina(OUTRA, 'Clínica Beta Estética Ltda, Petrópolis.\nSócio-Administrador: Pessoa Teste Alfa\nCNPJ 11.111.111/0001-00'),
      [HOMONIMA]: pagina(HOMONIMA, 'Empresa Exemplo Alfa Centro Estético, Petrópolis - RJ. Razão social: EMPRESA EXEMPLO BETA SERVICOS LTDA.\nSócio-Administrador: Pessoa Teste Beta\nCNPJ 22.222.222/0001-00'),
    },
    motor: motorFake(resultado({ consultas: { responsavel: [OUTRA, HOMONIMA] } })),
  });
  await rodar(x);
  const r = estado(x).resolucao.responsavel;
  assert.deepEqual(r.tentativas.map((a) => [a.url, a.pertinencia]), [[OUTRA, 'FONTE_NAO_PERTINENTE_A_EMPRESA'], [HOMONIMA, 'PERTINENTE']]);
  assert.deepEqual(r.tentativas[0].testes, TESTES('FALHOU', 'NAO_AVALIADO', 'PASSOU', 'NAO_AVALIADA'), 'a página de outra empresa nem chega ao marcador');
  assert.deepEqual(r.tentativas[1].testes, TESTES('PASSOU', 'PASSOU', 'PASSOU', 'INSUFICIENTE'));
  assert.equal(r.tentativas[1].candidatos, 1, 'há um candidato na página, sem vínculo comprovado');
  assert.deepEqual([r.status, r.motivo], ['NAO_VERIFICADO', 'CANDIDATO_SEM_VINCULO_COMPROVADO']);
  const gravado = JSON.stringify(perfilDe(x)).replace(/https:\/\/cadastro\.exemplo\.com\.br\/[a-z-]+/g, '<fonte>');
  assert.equal(/Pessoa Teste|11\.?111\.?111|22\.?222\.?222|cnpj|EMPRESA EXEMPLO BETA/i.test(gravado), false, 'nenhuma pessoa, razão social ou CNPJ das páginas foi associado à empresa');
});

test('[COM-5] CONTATO visível sem vínculo confirmado: e-mail numa página de terceiro é CANDIDATO (NAO_VERIFICADO), não entra no perfil; sem contato na página (e com marcador de contato) a ausência é SUFICIENTE; a página OFICIAL que traz o contato o entrega', async (t) => {
  const COM_EMAIL = 'https://guia-exemplo.com/rj/petropolis/guia/empresa-exemplo-alfa';
  const SEM_EMAIL = 'https://guia.exemplo.com.br/empresa-exemplo-alfa';
  const OFICIAL = 'https://empresaexemploalfa.com.br/contato';
  const candidato = montar(t, {
    paginas: { [COM_EMAIL]: pagina(COM_EMAIL, 'Empresa Exemplo Alfa Centro Estético, Petrópolis. Fale conosco e atendimento: contato@empresaexemploalfa.com.br', { links: [{ href: 'mailto:contato@empresaexemploalfa.com.br' }] }) },
    motor: motorFake(resultado({ consultas: { emails: [COM_EMAIL] } })),
  });
  await rodar(candidato);
  const c = estado(candidato).resolucao.emails;
  assert.deepEqual([c.status, c.motivo, c.tentativas[0].candidatos], ['NAO_VERIFICADO', 'CANDIDATO_SEM_VINCULO_COMPROVADO', 1]);
  assert.deepEqual(perfilDe(candidato).emails, [], 'o contato da página de terceiro NÃO vira dado do perfil');

  const vazio = montar(t, { paginas: { [SEM_EMAIL]: pagina(SEM_EMAIL, 'Empresa Exemplo Alfa Centro Estético, Petrópolis. Fale conosco pelo telefone, atendimento de segunda a sexta.') }, motor: motorFake(resultado({ consultas: { emails: [SEM_EMAIL] } })) });
  await rodar(vazio);
  const v = estado(vazio).resolucao.emails;
  assert.deepEqual([v.status, v.resolvido, v.fontes], ['NAO_ENCONTRADO_COM_VERIFICACAO', true, [SEM_EMAIL]]);
  assert.deepEqual(v.tentativas[0].testes, TESTES('PASSOU', 'PASSOU', 'PASSOU', 'SUFICIENTE'));

  const oficial = montar(t, {
    perfil: perfilExemplo({ siteOficial: { status: 'ENCONTRADO', url: 'https://empresaexemploalfa.com.br/' } }),
    paginas: { [OFICIAL]: pagina(OFICIAL, 'Fale conosco. Atendimento: contato@empresaexemploalfa.com.br', { links: [{ href: 'mailto:contato@empresaexemploalfa.com.br' }] }) },
    motor: motorFake(resultado({ consultas: { emails: [OFICIAL] } })),
  });
  await rodar(oficial);
  assert.deepEqual(perfilDe(oficial).emails.map((e) => e.email), ['contato@empresaexemploalfa.com.br']);
  assert.equal(estado(oficial).resolucao.emails.status, 'ENCONTRADO');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 3. EVIDÊNCIA SUFICIENTE E CONFIRMAÇÃO CORRETA; OBSERVABILIDADE
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[COM-6] EVIDÊNCIA SUFICIENTE: o pendente só é confirmado/substituído com o vínculo demonstrado (identificador que o perfil já tinha); a página oficial sem responsável conclui a ausência; o histórico do anterior é preservado', async (t) => {
  const motor = motorFake((pedido, n) => resultado({ responsavel: { nome: 'Pessoa Teste Alfa', cargo: 'Sócio-Administrador', origem: n === 1 ? AGREGADOR : DIRETORIO } }));
  const x = montar(t, {
    perfil: perfilExemplo({ responsavel: RESPONSAVEL_GRAVADO }),
    paginas: {
      [AGREGADOR]: pagina(AGREGADOR, 'Empresa Exemplo Alfa Centro Estético. Pessoa Teste Alfa, Sócio-Administrador.'),
      [DIRETORIO]: pagina(DIRETORIO, 'Empresa Exemplo Alfa Centro Estético. Responsável: Pessoa Teste Alfa, Sócio-Administrador. Telefone (24) 2222-0001.'),
    },
    motor,
  });
  await rodar(x); // 1ª: a mesma fonte sem vínculo -> o gravado fica como está
  assert.deepEqual([perfilDe(x).responsavel.origem, perfilDe(x).responsavel.vinculo], [AGREGADOR, undefined]);
  assert.equal(estado(x).resolucao.responsavel.status, 'NAO_VERIFICADO');
  await rodar(x); // 2ª: fonte que cita a empresa E o telefone do perfil -> confirma com prova registrada
  const r = perfilDe(x).responsavel;
  assert.deepEqual([r.status, r.origem, r.vinculo.regra, r.vinculo.evidencia], ['ENCONTRADO', DIRETORIO, 'IDENTIFICADOR_NA_PAGINA', ['telefone']]);
  assert.deepEqual(perfilDe(x).responsaveisAnteriores.map((a) => a.origem), [AGREGADOR]);
  assert.equal(estado(x).resolucao.responsavel.status, 'ENCONTRADO');
  assert.equal(commercial.enrichmentNeeds(perfilDe(x)).includes('responsavel'), false);

  // site oficial sem responsável listado: a ausência naquela página oficial é suficiente
  const OFICIAL = 'https://empresaexemploalfa.com.br/sobre';
  const oficial = montar(t, {
    perfil: perfilExemplo({ siteOficial: { status: 'ENCONTRADO', url: 'https://empresaexemploalfa.com.br/' } }),
    paginas: { [OFICIAL]: pagina(OFICIAL, 'Sobre nós: nossa equipe de profissionais atende com carinho em Centro. Conheça os tratamentos.') },
    motor: motorFake(resultado({ consultas: { responsavel: [OFICIAL] } })),
  });
  await rodar(oficial);
  assert.deepEqual([estado(oficial).resolucao.responsavel.status, estado(oficial).resolucao.responsavel.tentativas[0].testes.suficiencia], ['NAO_ENCONTRADO_COM_VERIFICACAO', 'SUFICIENTE']);
});

test('[COM-7] OBSERVABILIDADE: cada tentativa registra os testes de nome, marcador, conteúdo e suficiência em códigos fechados — falhas param os testes seguintes (NAO_AVALIADO) — e nenhum texto de página é guardado', async (t) => {
  const GENERICA = 'https://portal.exemplo.com.br/noticias';
  const SEM_MARCADOR = 'https://guia.exemplo.com.br/privacidade';
  const CURTA = 'https://guia.exemplo.com.br/curta';
  const LOGIN = 'https://guia.exemplo.com.br/entrar';
  const x = montar(t, {
    paginas: {
      [GENERICA]: pagina(GENERICA, 'Notícias de política de Petrópolis, fale conosco e contato.'),
      [SEM_MARCADOR]: pagina(SEM_MARCADOR, 'Empresa Exemplo Alfa Centro Estético. Política de privacidade e termos de uso do site.'),
      [CURTA]: { ok: true, urlFinal: CURTA, texto: 'Empresa Exemplo Alfa', links: [] },
      [LOGIN]: pagina(LOGIN, 'Faça login para continuar. Empresa Exemplo Alfa Centro Estético. Cadastre-se.'),
    },
    motor: motorFake(resultado({ consultas: { emails: [GENERICA, SEM_MARCADOR], presencaDigital: [CURTA, LOGIN] } })),
  });
  await rodar(x);
  const r = estado(x).resolucao;
  assert.deepEqual(r.emails.tentativas.map((a) => a.testes), [TESTES('FALHOU', 'NAO_AVALIADO', 'PASSOU', 'NAO_AVALIADA'), TESTES('PASSOU', 'FALHOU', 'PASSOU', 'NAO_AVALIADA')]);
  assert.deepEqual(r.presencaDigital.tentativas.map((a) => [a.pertinencia, a.testes.conteudo, a.testes.nome]), [['PAGINA_SEM_CONTEUDO', 'FALHOU', 'NAO_AVALIADO'], ['PAGINA_DE_LOGIN_OU_BLOQUEIO', 'FALHOU', 'NAO_AVALIADO']]);
  const gravado = JSON.stringify(perfilDe(x));
  for (const trecho of ['Lorem ipsum', 'Política de privacidade e termos', 'Faça login para continuar', 'Notícias de política']) assert.equal(gravado.includes(trecho), false, trecho);
  // a falha de leitura não tem testes (a página nem abriu)
  const fechada = montar(t, { motor: motorFake(resultado({ consultas: { emails: [DIRETORIO] } })) });
  await rodar(fechada);
  assert.equal('testes' in estado(fechada).resolucao.emails.tentativas[0], false);
});

test('[COM-8] um valor fora do vocabulário nos testes gravados é neutralizado na leitura (NAO_AVALIADO); o módulo puro avalia sem rede nem arquivo', async () => {
  const ctx = { company: NOME, officialOrigin: 'https://empresaexemploalfa.com.br/', knownUrls: [] };
  const a = resolution.assessSource('responsavel', pagina(REGISTRO, 'Empresa Exemplo Alfa Centro Estético. Sócios e administradores.'), REGISTRO, ctx);
  assert.deepEqual([a.ok, a.pertinente, a.motivo, a.testes.suficiencia], [false, true, 'FONTE_PERTINENTE_MAS_INSUFICIENTE', 'INSUFICIENTE']);
  const o = resolution.assessSource('responsavel', pagina('https://empresaexemploalfa.com.br/sobre', 'Sobre nós: equipe e profissionais da clínica em Centro, com muito carinho.'), 'https://empresaexemploalfa.com.br/sobre', ctx);
  assert.deepEqual([o.ok, o.testes.suficiencia], [true, 'SUFICIENTE'], 'página oficial sem responsável listado: ausência suficiente');
  const estados = resolution.fieldStates({ enriquecimento: { resolucao: { emails: { status: 'NAO_VERIFICADO', resolvido: false, tentativas: [{ url: 'https://a.com.br/x', leitura: 'OK', testes: { nome: 'TALVEZ', marcador: 7, conteudo: 'PASSOU', suficiencia: 'SIM' }, candidatos: 9999 }] } } } }, ['emails']);
  assert.deepEqual(estados.emails.tentativas[0].testes, TESTES('NAO_AVALIADO', 'NAO_AVALIADO', 'PASSOU', 'NAO_AVALIADA'));
  assert.equal('candidatos' in estados.emails.tentativas[0], false);
});

test('[COM-9] segurança preservada: a pesquisa não altera a Approval Queue; lead em DNC segue bloqueado; nenhum CNPJ/razão social é associado; a execução histórica não é reescrita', async (t) => {
  const historico = { iniciadoEm: '2026-10-09T03:13:56.611Z', concluidoEm: '2026-10-09T03:14:25.414Z', duracaoMs: 28800, camposSolicitados: ['responsavel'], resultado: 'INCOMPLETO', encerramento: 'CONCLUIDA', resultadosPorCampo: {}, fontes: [], fontesNovas: [] };
  const x = montar(t, {
    perfil: perfilExemplo({ responsavel: RESPONSAVEL_GRAVADO, enriquecimento: { status: 'INCOMPLETO', limiteDeTurnos: false, camposPendentes: ['emails'], camposNaoEncontrados: [], resolucao: {}, ultimaExecucao: historico, execucoes: [historico] } }),
    paginas: { [REGISTRO]: pagina(REGISTRO, 'Empresa Exemplo Alfa Centro Estético. Razão social: EMPRESA EXEMPLO BETA SERVICOS LTDA. CNPJ 22.222.222/0001-00. Sócios e administradores.') },
    motor: motorFake(resultado({ consultas: { responsavel: [REGISTRO] } })),
  });
  const fila = x.env.textoDaFila();
  await rodar(x);
  assert.equal(x.env.textoDaFila(), fila);
  assert.deepEqual(perfilDe(x).enriquecimento.execucoes[0], historico);
  const json = JSON.stringify(perfilDe(x)).split(REGISTRO).join('<fonte>').split(AGREGADOR).join('<fonte>');
  assert.equal(/22\.?222\.?222|EMPRESA EXEMPLO BETA|"cnpj"|identidadeEmpresa/i.test(json), false);

  const dnc = montar(t, { motor: motorFake(resultado({})), perfil: perfilExemplo({ responsavel: RESPONSAVEL_GRAVADO }) });
  assert.equal(dnc.env.itemDaFila('alfa').estado, 'AGUARDANDO_REVISAO');
});
