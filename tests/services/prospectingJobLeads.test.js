// Regras de LEAD do job de prospecção (Implementação 2 — motor comercial): site oficial como HIPÓTESE confirmada por código, lead válido SEM site oficial,
// páginas de terceiros só como descoberta/evidência (nunca "site oficial"), presença digital separada e confirmada só por vínculo público.
// Peças REAIS e FAKES: ver tests/helpers/jobFixtures.js (nenhuma rede, nenhum `claude`).

const test = require('node:test');
const assert = require('node:assert/strict');

const { JOB_STATUS, CANDIDATE_RESULT, CANDIDATE_REASON } = require('../../src/research-prospector/prospectingJob');
const { admin } = require('../helpers/promotionFixtures');
const { siteDe, paginaBoa, paginaTerceiro, candidato, motorFake, ambiente, iniciar, FONTE_BUSCA } = require('../helpers/jobFixtures');

const DIRETORIO = 'https://www.guiamais.com.br/petropolis-rj/clinica-alfa';
const TEXTO_BOM = 'Clínica Alfa — clínica de estética e harmonização facial. Rua das Flores, 10 - Petrópolis - RJ';

// Roda UM candidato (quantidade 1) e devolve o job final + o ambiente.
async function rodar(t, candidatos, paginas, extras = {}) {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos }, { candidatos: [] }] }), paginas, ...extras });
  const { job } = await iniciar(env, { quantidade: 1 });
  const fim = await env.servico.waitFor(job.id);
  return { env, fim, c: fim.candidatos[0] };
}

test('[LEAD-1] empresa + nicho + localização COMPROVADOS e site oficial NÃO ENCONTRADO = lead VALIDADO (a oportunidade pode ser a criação de um site); a evidência vem de um diretório e nunca vira "site oficial"', async (t) => {
  const semSite = candidato('Clínica Alfa', 'alfa', { siteOficial: null, fontesDescoberta: [{ url: DIRETORIO, tipo: 'DIRETORIO' }] });
  const { env, fim, c } = await rodar(t, [semSite], { [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto: TEXTO_BOM }) });
  // REGRA DE PRODUTO (definitiva): empresa + nicho + localização comprovados = VALIDADO e ENTREGUE à Approval Queue, mesmo sem site, rede social ou telefone
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual([fim.lote.validadosPeloMotor, fim.lote.naFila, fim.lote.foraDaFila], [1, 1, 0]);
  assert.equal(c.entrega.naFila, true);
  assert.notEqual(c.entrega.estadoOperacional, 'DADOS_INSUFICIENTES');
  assert.deepEqual([c.resultado, c.empresa, c.nicho, c.localizacao], [CANDIDATE_RESULT.VALIDADO, 'VALIDADO', 'VALIDADO', 'VALIDADO']);
  assert.deepEqual(c.siteOficial, { status: 'NAO_ENCONTRADO', url: null, motivo: 'NAO_INFORMADO' });
  assert.deepEqual(c.fonteDaValidacao, { url: DIRETORIO, tipo: 'DIRETORIO' });
  assert.deepEqual(c.fontesDescoberta, [{ url: DIRETORIO, tipo: 'DIRETORIO' }]);
  assert.deepEqual(c.outrasPresencas, [{ url: DIRETORIO, tipo: 'DIRETORIO' }], 'o diretório é só contexto e rastreabilidade');
  assert.equal(c.fontesDescoberta.some((fonte) => fonte.tipo === 'OFICIAL'), false);
  // o achado que foi ao caminho oficial: sem site e sem nenhum canal inventado; a fonte (o diretório) vai como rastro
  assert.deepEqual(env.ingestoes, [1]);
  const achado = env.achadosIngeridos[0];
  assert.equal(achado.empresa, 'Clínica Alfa');
  assert.equal(achado.campos, undefined, 'nenhuma evidência de canal foi inventada');
  assert.deepEqual(achado.fontes, [DIRETORIO]);
  assert.equal(achado.comprovadoPorCodigo, true, 'a marca vem do job, depois de comprovar empresa + nicho + localização');
});

test('[LEAD-2] com site oficial CONFIRMADO (domínio + nome + conteúdo): VALIDADO, siteOficial ENCONTRADO na RAIZ do domínio, e a fonte do site vira OFICIAL por código', async (t) => {
  const { env, fim, c } = await rodar(t, [candidato('Clínica Alfa', 'alfa', { siteOficial: `${siteDe('alfa')}tratamentos/facial?x=1` })], { [siteDe('alfa')]: paginaBoa('Clínica Alfa', 'alfa') });
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual(c.siteOficial, { status: 'ENCONTRADO', url: siteDe('alfa'), regra: 'dominio_e_nome' });
  assert.equal(c.url, siteDe('alfa'));
  assert.deepEqual(c.fonteDaValidacao, { url: siteDe('alfa'), tipo: 'OFICIAL' });
  assert.deepEqual(c.fontesDescoberta[0], { url: siteDe('alfa'), tipo: 'OFICIAL' });
  assert.deepEqual(env.paginasChamadas.filter((url) => url.includes('tratamentos')), [], 'só a RAIZ do domínio é lida (o vínculo se prova na página inicial)');
  assert.ok(env.achadosIngeridos[0].campos.site.some((e) => e.valor === siteDe('alfa') && e.tipoFonte === 'OFICIAL'));
});

test('[LEAD-3] SEM nicho = NAO_VERIFICADO e SEM localização = NAO_VERIFICADO — mesmo com site, e nada é completado por inferência', async (t) => {
  const semNicho = await rodar(t, [candidato('Clínica Alfa', 'alfa')], { [siteDe('alfa')]: paginaBoa('Clínica Alfa', 'alfa', { sem: ['nicho'] }) });
  assert.deepEqual([semNicho.c.resultado, semNicho.c.motivo, semNicho.c.faltando], [CANDIDATE_RESULT.NAO_VERIFICADO, CANDIDATE_REASON.EVIDENCIA_INCOMPLETA, ['nicho']]);
  assert.deepEqual(semNicho.env.ingestoes, []);
  const semLocal = await rodar(t, [candidato('Clínica Alfa', 'alfa')], { [siteDe('alfa')]: paginaBoa('Clínica Alfa', 'alfa', { sem: ['localizacao'] }) });
  assert.deepEqual([semLocal.c.resultado, semLocal.c.faltando], [CANDIDATE_RESULT.NAO_VERIFICADO, ['localizacao']]);
  // sem site e com um diretório que cita só a empresa
  const parcial = candidato('Clínica Alfa', 'alfa', { siteOficial: null, fontesDescoberta: [{ url: DIRETORIO, tipo: 'DIRETORIO' }] });
  const soNome = await rodar(t, [parcial], { [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto: 'Clínica Alfa está listada aqui.' }) });
  assert.deepEqual([soNome.c.resultado, soNome.c.empresa, soNome.c.nicho, soNome.c.localizacao], [CANDIDATE_RESULT.NAO_VERIFICADO, 'VALIDADO', 'NAO_VERIFICADO', 'NAO_VERIFICADO']);
});

test('[LEAD-4] uma MATÉRIA descobre a empresa (Instituto Granja Brasil): fonte NOTICIA_OU_TERCEIRO, nunca site oficial; o site hipotético (a raiz do portal) é rejeitado; o lead só é válido se a matéria comprovar os três aspectos', async (t) => {
  const materia = 'https://soupetropolis.com.br/2022/02/08/spa-granja-brasil-inaugura-instituto-de-saude-e-estetica-avancada/';
  const nome = 'Instituto Granja Brasil de Saúde e Estética Avançada';
  const hipotese = candidato(nome, 'soupetropolis', { siteOficial: 'https://soupetropolis.com.br/', fontesDescoberta: [{ url: materia, tipo: 'NOTICIA_OU_TERCEIRO' }] });
  const paginas = {
    'https://soupetropolis.com.br/': { ...paginaTerceiro('https://soupetropolis.com.br/', { texto: 'Notícias de Petrópolis: política, esportes e cultura.' }), identidade: 'Sou Petrópolis | Notícias' },
    [materia]: paginaTerceiro(materia, { texto: 'O Spa Granja Brasil inaugura instituto de saúde e estética avançada em Petrópolis, na Rua Teresa, 100.' }),
  };
  const { env, fim, c } = await rodar(t, [hipotese], paginas);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO, 'validada pela matéria, sem site nem canal: entra na Approval Queue');
  assert.equal(c.entrega.naFila, true);
  assert.deepEqual([c.resultado, c.empresa, c.nicho, c.localizacao], [CANDIDATE_RESULT.VALIDADO, 'VALIDADO', 'VALIDADO', 'VALIDADO']);
  assert.equal(c.evidencias.empresa.regra, 'nome_nucleo');
  assert.equal(c.evidencias.empresa.trecho, 'Granja Brasil');
  assert.equal(c.siteOficial.status, 'NAO_ENCONTRADO', 'a matéria NÃO é o site oficial');
  assert.equal(c.siteOficial.motivo, 'NOME_NAO_ENCONTRADO');
  assert.deepEqual(c.fonteDaValidacao, { url: materia, tipo: 'NOTICIA_OU_TERCEIRO' });
  assert.ok(c.fontesDescoberta.some((fonte) => fonte.url === materia && fonte.tipo === 'NOTICIA_OU_TERCEIRO'));
  assert.equal(c.fontesDescoberta.some((fonte) => fonte.tipo === 'OFICIAL'), false);
  assert.ok(c.outrasPresencas.some((fonte) => fonte.url === materia));
  assert.equal(env.achadosIngeridos[0].campos, undefined, 'a matéria nunca entra como evidência de site');
  assert.deepEqual(env.achadosIngeridos[0].fontes, [materia]);

  // e se a matéria NÃO comprovar a empresa, não vale (descoberta não é validação)
  const fraca = { ...paginas, [materia]: paginaTerceiro(materia, { texto: 'Notícia sobre outra coisa em Petrópolis.' }) };
  const sem = await rodar(t, [hipotese], fraca);
  assert.equal(sem.c.resultado, CANDIDATE_RESULT.NAO_VERIFICADO);
  assert.equal(sem.fim.status, JOB_STATUS.PARCIAL);
});

test('[LEAD-5] o `siteOficial` do agente é uma HIPÓTESE: rede social, diretório, portal, http, IP e URL inválida são rejeitados antes de qualquer leitura (siteOficial = NAO_ENCONTRADO)', async (t) => {
  for (const hipotese of ['https://www.instagram.com/clinicaalfa', 'https://www.facebook.com/clinicaalfa', 'https://www.guiamais.com.br/clinica-alfa', 'https://g1.globo.com/x', 'https://www.linkedin.com/company/alfa', 'http://clinicaalfa.com.br/', 'https://10.0.0.1/', 'javascript:alert(1)', 5, '']) {
    const alvo = candidato('Clínica Alfa', 'alfa', { siteOficial: hipotese });
    const { env, c } = await rodar(t, [alvo], { [siteDe('alfa')]: paginaBoa('Clínica Alfa', 'alfa') });
    assert.equal(c.siteOficial.status, 'NAO_ENCONTRADO', String(hipotese));
    assert.equal(c.siteOficial.url, null);
    assert.equal(env.paginasChamadas.includes(siteDe('alfa')), false, 'nenhuma página foi lida em nome de um site rejeitado');
    assert.equal(env.paginasChamadas.some((url) => /instagram|facebook|guiamais|globo|linkedin|10\.0\.0\.1/.test(url)), false);
  }
});

test('[LEAD-6] site inexistente (DNS) ou com certificado inválido (TLS): a causa técnica é preservada e NUNCA vira "empresa inexistente"; sem outra evidência o lead é NAO_VERIFICADO, com outra página que comprove ele segue VALIDADO sem site', async (t) => {
  const dns = await rodar(t, [candidato('Clínica Alfa', 'alfa')], {});
  assert.deepEqual([dns.c.resultado, dns.c.motivo, dns.c.causa], [CANDIDATE_RESULT.NAO_VERIFICADO, CANDIDATE_REASON.PAGINA_INACESSIVEL, 'DNS']);
  assert.deepEqual(dns.c.siteOficial, { status: 'NAO_ENCONTRADO', url: null, motivo: 'PAGINA_INACESSIVEL', causa: 'DNS' });
  assert.doesNotMatch(JSON.stringify(dns.c), /inexistente|n[ãa]o existe/i);

  const tls = await rodar(t, [candidato('Clínica Alfa', 'alfa')], { [siteDe('alfa')]: { ok: false, falha: 'ROBOTS', causa: 'TLS' } });
  assert.equal(tls.c.causa, 'TLS');
  assert.equal(tls.c.siteOficial.causa, 'TLS');

  const comDiretorio = candidato('Clínica Alfa', 'alfa', { fontesDescoberta: [{ url: DIRETORIO, tipo: 'DIRETORIO' }] });
  const salvo = await rodar(t, [comDiretorio], { [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto: TEXTO_BOM }) });
  assert.equal(salvo.c.resultado, CANDIDATE_RESULT.VALIDADO, 'o site caiu, mas o diretório comprova empresa, nicho e localização');
  assert.equal(salvo.c.siteOficial.status, 'NAO_ENCONTRADO');
});

test('[LEAD-7] o vínculo do domínio com a empresa é CONFIRMADO por código: um domínio que não carrega o nome (e sem nome no título/H1) NÃO vira site oficial, mesmo que a página responda 200 e cite a empresa', async (t) => {
  const outroDominio = candidato('Clínica Alfa', 'alfa', { siteOficial: 'https://qualquercoisa.com.br/' });
  const pagina = { ...paginaBoa('Clínica Alfa', 'qualquercoisa'), identidade: 'Bem-vindo' };
  const rejeitado = await rodar(t, [outroDominio], { 'https://qualquercoisa.com.br/': pagina });
  assert.equal(rejeitado.c.siteOficial.status, 'NAO_ENCONTRADO');
  assert.equal(rejeitado.c.siteOficial.motivo, 'VINCULO_NAO_CONFIRMADO');
  assert.equal(rejeitado.c.resultado, CANDIDATE_RESULT.NAO_VERIFICADO, 'a página isolada não vale: ela não é o site comprovado nem uma fonte de terceiro');
  // com o nome no título/H1 o vínculo se confirma, mesmo com o domínio sem o nome
  const comTitulo = await rodar(t, [outroDominio], { 'https://qualquercoisa.com.br/': { ...pagina, identidade: 'Clínica Alfa | Estética' } });
  assert.deepEqual(comTitulo.c.siteOficial, { status: 'ENCONTRADO', url: 'https://qualquercoisa.com.br/', regra: 'titulo_e_nome' });
  assert.equal(comTitulo.c.resultado, CANDIDATE_RESULT.VALIDADO);
});

test('[LEAD-8] PRESENÇA DIGITAL separada do site: link no site oficial = CONFIRMADO; perfil só sugerido pelo agente = ENCONTRADO/NAO_CONFIRMADO (nunca por nome parecido); null = NAO_ENCONTRADO; ausente = NAO_VERIFICADO; só os CONFIRMADOS viram evidência do achado', async (t) => {
  const links = ['https://www.instagram.com/clinicaalfa', 'https://www.facebook.com/clinica.alfa', 'https://www.youtube.com/@clinicaalfa', 'https://g.page/clinica-alfa-petropolis', 'https://www.tiktok.com/@clinicaalfa', 'https://wa.me/5524987651000', 'https://api.whatsapp.com/send?phone=5524987651000'];
  const alvo = candidato('Clínica Alfa', 'alfa', { presencaDigital: { instagram: 'https://www.instagram.com/outro_perfil', linkedin: 'https://www.linkedin.com/company/clinica-alfa-estetica', youtube: null } });
  const { env, c } = await rodar(t, [alvo], { [siteDe('alfa')]: paginaBoa('Clínica Alfa', 'alfa', { links }) });
  const p = c.presencaDigital;
  assert.deepEqual(p.instagram, { status: 'ENCONTRADO', url: 'https://www.instagram.com/clinicaalfa', confirmacao: 'CONFIRMADO', regra: 'link_no_site_oficial' }, 'o link publicado no site oficial vence a sugestão do agente');
  assert.equal(p.facebook.confirmacao, 'CONFIRMADO');
  assert.deepEqual([p.youtube.status, p.youtube.confirmacao], ['ENCONTRADO', 'CONFIRMADO'], 'o link no site oficial vale mais que o "null" do agente');
  assert.deepEqual(p.googleMeuNegocio, { status: 'ENCONTRADO', url: 'https://g.page/clinica-alfa-petropolis', confirmacao: 'CONFIRMADO', regra: 'link_no_site_oficial' });
  assert.deepEqual([p.tiktok.status, p.tiktok.url, p.tiktok.confirmacao], ['ENCONTRADO', 'https://www.tiktok.com/@clinicaalfa', 'CONFIRMADO']);
  assert.deepEqual([p.whatsapp.status, p.whatsapp.url, p.whatsapp.confirmacao], ['ENCONTRADO', 'https://wa.me/5524987651000', 'CONFIRMADO']);
  assert.deepEqual(p.linkedin, { status: 'ENCONTRADO', url: 'https://www.linkedin.com/company/clinica-alfa-estetica', confirmacao: 'NAO_CONFIRMADO' }, 'só sugerido: nome parecido NÃO é vínculo');
  assert.deepEqual(p.outros, []);
  // só os CONFIRMADOS entraram no achado; o LinkedIn sugerido não
  const campos = env.achadosIngeridos[0].campos;
  assert.ok(campos.instagram.some((e) => e.valor === 'https://www.instagram.com/clinicaalfa' && e.tipoFonte === 'OFICIAL'));
  assert.equal(JSON.stringify(campos).includes('linkedin.com/company/clinica-alfa-estetica'), false);
  assert.equal(JSON.stringify(campos).includes('outro_perfil'), false);

  // ausente = NAO_VERIFICADO; null = NAO_ENCONTRADO; sem site e sem hipótese nenhuma
  const vazio = await rodar(t, [candidato('Clínica Alfa', 'alfa', { presencaDigital: { facebook: null } })], { [siteDe('alfa')]: paginaBoa('Clínica Alfa', 'alfa') });
  assert.deepEqual([vazio.c.presencaDigital.facebook.status, vazio.c.presencaDigital.instagram.status, vazio.c.presencaDigital.tiktok.status], ['NAO_ENCONTRADO', 'NAO_VERIFICADO', 'NAO_VERIFICADO']);
  assert.deepEqual([vazio.c.presencaDigital.instagram.url, vazio.c.presencaDigital.instagram.confirmacao], [null, 'NAO_CONFIRMADO']);
});

test('[LEAD-9] vínculo por LINK CRUZADO: um perfil sugerido que aparece como link na página (diretório) que COMPROVA a empresa fica CONFIRMADO; o perfil de OUTRA empresa nunca é associado', async (t) => {
  const perfilCerto = 'https://www.instagram.com/clinicaalfa';
  const perfilOutro = 'https://www.instagram.com/clinica_beta_estetica';
  const alvo = candidato('Clínica Alfa', 'alfa', { siteOficial: null, fontesDescoberta: [{ url: DIRETORIO, tipo: 'DIRETORIO' }], presencaDigital: { instagram: perfilCerto, facebook: 'https://www.facebook.com/clinicabeta' } });
  const { env, c } = await rodar(t, [alvo], { [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto: TEXTO_BOM, links: [perfilCerto, 'https://www.facebook.com/outra.pagina'] }) });
  assert.deepEqual(c.presencaDigital.instagram, { status: 'ENCONTRADO', url: perfilCerto, confirmacao: 'CONFIRMADO', regra: 'link_cruzado' });
  assert.deepEqual([c.presencaDigital.facebook.status, c.presencaDigital.facebook.confirmacao], ['ENCONTRADO', 'NAO_CONFIRMADO'], 'o Facebook sugerido não aparece em nenhum vínculo: continua só uma hipótese');
  assert.ok(env.achadosIngeridos[0].campos.instagram.some((e) => e.valor === perfilCerto));
  assert.equal(JSON.stringify(env.achadosIngeridos[0]).includes('clinicabeta'), false, 'o perfil não confirmado nunca vai ao achado');

  // um perfil que só PARECE da empresa (mesmo nome) e que não está em nenhum vínculo
  const semVinculo = candidato('Clínica Alfa', 'alfa', { siteOficial: null, fontesDescoberta: [{ url: DIRETORIO, tipo: 'DIRETORIO' }], presencaDigital: { instagram: perfilOutro } });
  const { c: c2 } = await rodar(t, [semVinculo], { [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto: TEXTO_BOM, links: ['https://www.instagram.com/clinicaalfa'] }) });
  assert.equal(c2.presencaDigital.instagram.confirmacao, 'NAO_CONFIRMADO');
  assert.equal(c2.presencaDigital.instagram.url, perfilOutro);
});

test('[LEAD-10] o TIPO de cada fonte é decidido POR CÓDIGO: o tipo que o agente declarar é ignorado (uma matéria dita OFICIAL continua NOTICIA_OU_TERCEIRO); redes sociais sem canal próprio vão para `outros`', async (t) => {
  const materia = 'https://www.folha.uol.com.br/cotidiano/2026/clinica-alfa.shtml';
  const alvo = candidato('Clínica Alfa', 'alfa', {
    fontesDescoberta: [{ url: materia, tipo: 'OFICIAL' }, { url: 'https://www.tripadvisor.com.br/x', tipo: 'NOTICIA_OU_TERCEIRO' }, { url: 'https://www.instagram.com/p/abc', tipo: 'OFICIAL' }, { url: 'https://x.com/clinicaalfa', tipo: 'OFICIAL' }, { url: 'https://blog-qualquer.com.br/post', tipo: 'REDE_SOCIAL' }],
  });
  const { c } = await rodar(t, [alvo], { [siteDe('alfa')]: paginaBoa('Clínica Alfa', 'alfa') });
  const tipoDe = (parte) => c.fontesDescoberta.find((fonte) => fonte.url.includes(parte)).tipo;
  assert.equal(tipoDe('folha'), 'NOTICIA_OU_TERCEIRO');
  assert.equal(tipoDe('tripadvisor'), 'DIRETORIO');
  assert.equal(tipoDe('instagram.com/p/abc'), 'REDE_SOCIAL');
  assert.equal(tipoDe('x.com'), 'REDE_SOCIAL');
  assert.equal(tipoDe('blog-qualquer'), 'NOTICIA_OU_TERCEIRO', 'um host desconhecido nunca é "oficial" por declaração');
  assert.equal(tipoDe('alfa.com.br'), 'OFICIAL', 'só o site CONFIRMADO é OFICIAL');
  assert.deepEqual(c.presencaDigital.outros, [{ url: 'https://x.com/clinicaalfa', tipo: 'REDE_SOCIAL' }]);
  assert.deepEqual(c.outrasPresencas.map((fonte) => fonte.tipo).sort(), ['DIRETORIO', 'NOTICIA_OU_TERCEIRO', 'NOTICIA_OU_TERCEIRO']);
});

test('[LEAD-11] nomes compostos: "Espaço Facial (Unidade Pátio Petrópolis)" (só termos genéricos) exige domínio + título/H1; "Marilza Estética" valida pelo nome; um domínio de terceiro com o mesmo nome genérico não valida', async (t) => {
  const espaco = 'Espaço Facial (Unidade Pátio Petrópolis)';
  const pagina = { ...paginaBoa('Espaço Facial', 'espacofacial'), identidade: 'Espaço Facial | Harmonização' };
  const ok = await rodar(t, [candidato(espaco, 'espacofacial')], { [siteDe('espacofacial')]: pagina });
  assert.equal(ok.c.resultado, CANDIDATE_RESULT.VALIDADO);
  assert.equal(ok.c.evidencias.empresa.regra, 'nome_nucleo');
  assert.equal(ok.c.siteOficial.status, 'ENCONTRADO');

  // outro domínio (sem o nome) e sem título: nenhuma corroboração -> NAO_VERIFICADO
  const outro = await rodar(t, [candidato(espaco, 'franquiaxyz')], { [siteDe('franquiaxyz')]: { ...paginaBoa('Espaço Facial', 'franquiaxyz'), identidade: 'Bem-vindo' } });
  assert.equal(outro.c.resultado, CANDIDATE_RESULT.NAO_VERIFICADO);

  const marilza = await rodar(t, [candidato('Marilza Estética', 'marilzaestetica')], { [siteDe('marilzaestetica')]: paginaBoa('Marilza Estética', 'marilzaestetica') });
  assert.equal(marilza.c.resultado, CANDIDATE_RESULT.VALIDADO);
});

test('[LEAD-12] regressão: exclusão permanente, DNC, duplicidade e Approval Queue continuam no CAMINHO OFICIAL — um lead SEM site também passa por eles e NADA é promovido ao CRM', async (t) => {
  const semSite = candidato('Clínica Alfa', 'alfa', { siteOficial: null, fontesDescoberta: [{ url: DIRETORIO, tipo: 'DIRETORIO' }] });
  const env = ambiente(t, {
    motor: motorFake({ rodadas: [{ candidatos: [semSite, candidato('Clínica Beta', 'beta')] }, { candidatos: [] }] }),
    paginas: { [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto: TEXTO_BOM }), [siteDe('beta')]: paginaBoa('Clínica Beta', 'beta') },
    exclusao: async (finding) => (finding.empresa === 'Clínica Beta' ? { motivo: 'excluída' } : false),
  });
  const { brief, job } = await iniciar(env, { quantidade: 2 });
  const fim = await env.servico.waitFor(job.id);
  const beta = fim.candidatos.find((c) => c.nome === 'Clínica Beta');
  assert.deepEqual([beta.resultado, beta.motivo], [CANDIDATE_RESULT.DESCARTADO, CANDIDATE_REASON.EXCLUSAO_PERMANENTE]);
  assert.equal(env.paginasChamadas.includes(siteDe('beta')), false, 'a exclusão vem ANTES da leitura de qualquer página');
  const lote = env.prospectingService.getBatch(admin(), (await env.briefService.getBrief(admin(), brief.id)).loteRealId);
  assert.equal(lote.resultados.length, 1);
  assert.equal(lote.resultados[0].empresa, 'Clínica Alfa');
  assert.equal((await env.crmService.listRecords(admin(), {})).length, 0, 'nenhuma promoção automática');
  assert.equal(FONTE_BUSCA.startsWith('https://'), true);
});
