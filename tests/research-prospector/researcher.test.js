// Researcher V1 (src/research-prospector/researcher.js + researchPolicy.js) — decisão 0021.
// NENHUMA pesquisa real: as três portas (busca, página, anúncios) são FAKES em memória. Tudo fictício (example.test), sem rede.
// O que se prova: a saída é SEMPRE rawFinding V2 válido; toda informação tem fonte https pública e data; falhas viram NAO_VERIFICADO com
// motivo (nunca uma negativa); nada é inferido, contornado, decidido, pontuado ou gravado; nada é cortado em silêncio.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createResearcher, LIMITS, ERROR, OMISSAO } = require('../../src/research-prospector/researcher');
const policy = require('../../src/research-prospector/researchPolicy');
const { validateRawFindingsV2 } = require('../../src/research-prospector/rawFindingV2');
const { buildDossier } = require('../../src/research-prospector/dossier');
const { factsFromFinding } = require('../../src/research-prospector/dossierFromFinding');
const { MOTIVO } = require('../../src/research-prospector/signalSchema');
const { analyzeSource, toPosix } = require('../helpers/staticImports');

const AGORA = new Date('2026-09-25T15:00:00.000Z');
const HOJE = '2026-09-25';
const BUSCA = 'https://busca.example.test/resultados';
const briefing = (extras = {}) => ({ nicho: 'Psicologia', quantidadeDesejada: 2, regiao: 'Petrópolis/RJ', tipo: 'clínica', ...extras });

const SITE = 'https://alfa-teste.example.test/';
const IG = 'https://www.instagram.com/alfa_teste';
const GOOGLE = 'https://www.google.com/maps/place/alfa-teste';
const paginaSite = (extras = {}) => ({
  ok: true,
  urlFinal: SITE,
  links: [
    { href: IG },
    { href: 'https://facebook.com/alfa.teste' },
    { href: 'https://www.linkedin.com/company/alfa-teste' },
    { href: 'https://www.youtube.com/@alfa_teste' },
    { href: 'https://wa.me/5524987651000' },
    { href: 'tel:+552433331111' },
    { href: 'mailto:contato@alfa-teste.example.test' },
    { href: 'https://alfa-teste.example.test/agendar', texto: 'Agende sua consulta' },
  ],
  temFormularioContato: true,
  ...extras,
});
const paginaPerfil = (perfil = {}) => ({ ok: true, urlFinal: IG, links: [], perfil: { postagens: ['2026-09-01', '2026-09-10', '2026-09-20'], ctaBio: 'Agende pelo link da bio', ...perfil } });
const adsMeta = (anunciantes = [{ nome: 'Clínica Alfa Teste' }]) => ({ ok: true, url: 'https://www.facebook.com/ads/library/?q=alfa', anunciantes });
const adsGoogle = (anunciantes = []) => ({ ok: true, url: 'https://adstransparency.google.com/?q=alfa', anunciantes });
const resultadosAlfa = () => [
  { nome: 'Clínica Alfa Teste', url: SITE, tipoResultado: 'SITE', fonteUrl: BUSCA, cidade: 'Petrópolis', estado: 'RJ' },
  { nome: 'Clínica Alfa Teste', url: IG, tipoResultado: 'INSTAGRAM', fonteUrl: BUSCA },
  { nome: 'Clínica Alfa Teste', url: GOOGLE, tipoResultado: 'GOOGLE_PERFIL', fonteUrl: BUSCA },
];

// Um "mundo" fake: resultados da busca, páginas por URL e respostas de anúncios; registra toda chamada.
function mundo(spec = {}) {
  const chamadas = { search: [], fetch: [], ads: [] };
  const paginas = { [SITE]: paginaSite(), [IG]: paginaPerfil(), ...(spec.paginas || {}) };
  const ports = {
    search: async (arg) => {
      chamadas.search.push(arg);
      if (spec.search) return spec.search(arg);
      return { ok: true, resultados: spec.resultados || resultadosAlfa() };
    },
    fetchPage: async (url) => {
      chamadas.fetch.push(url);
      if (spec.fetch) return spec.fetch(url);
      return paginas[url] || { ok: false, falha: 'FORA_DO_AR' };
    },
  };
  if (spec.ads !== false) {
    ports.lookupAds = async (arg) => {
      chamadas.ads.push(arg);
      if (spec.lookupAds) return spec.lookupAds(arg);
      return arg.plataforma === 'META' ? adsMeta() : adsGoogle();
    };
  }
  return { ports, chamadas };
}
const pesquisar = async (spec, brief = briefing(), options = {}) => {
  const m = mundo(spec);
  const researcher = createResearcher(m.ports, { now: () => AGORA, ...options });
  return { ...m, saida: await researcher.research(brief) };
};
const fatosDe = (achado) => (achado.dossie ? achado.dossie.fatos : []);
const fato = (achado, campo) => fatosDe(achado).find((f) => f.campo === campo);
const dossieDe = (achado) => {
  const r = buildDossier({ prospectId: 'id:teste', fatos: [...factsFromFinding(achado, HOJE), ...fatosDe(achado)], analises: achado.dossie ? achado.dossie.analises : [] }, { now: AGORA });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.value;
};

// ---------------------------------------------------------------------------------------------------------------------------------
test('[RES-1] a criação exige as portas (busca e página); anúncios é opcional; relógio e duração validados', () => {
  const { ports } = mundo();
  assert.doesNotThrow(() => createResearcher(ports));
  assert.doesNotThrow(() => createResearcher({ search: ports.search, fetchPage: ports.fetchPage }));
  assert.throws(() => createResearcher(), /search/);
  assert.throws(() => createResearcher({ fetchPage: ports.fetchPage }), /search/);
  assert.throws(() => createResearcher({ search: ports.search }), /fetchPage/);
  assert.throws(() => createResearcher({ ...ports, lookupAds: 5 }), /lookupAds/);
  assert.throws(() => createResearcher(ports, { now: 5 }), /now/);
  for (const ruim of [0, -1, 1.5, '1', null]) assert.throws(() => createResearcher(ports, { maxDurationMs: ruim }), /maxDurationMs/);
  assert.deepEqual(Object.keys(createResearcher(ports)), ['research'], 'a única operação é pesquisar: sem escrever, aprovar, promover, enviar');
});

test('[RES-2] briefing inválido é recusado sem chamar nenhuma porta (nem lançar); o briefing aceito é o do Prospecting Service', async () => {
  assert.equal((await createResearcher(mundo().ports).research()).erro.code, ERROR.BRIEFING_INVALIDO);
  for (const ruim of [null, 'x', 5, [], {}, { nicho: '' }, { nicho: 'Psicologia' }, { nicho: 'Psicologia', quantidadeDesejada: 0 }, { nicho: 'Psicologia', quantidadeDesejada: 1.5 }, { nicho: 'Psicologia', quantidadeDesejada: 1001 }, { nicho: 5, quantidadeDesejada: 2 }, { nicho: 'x'.repeat(121), quantidadeDesejada: 2 }, { nicho: 'Psicologia', quantidadeDesejada: 2, regiao: 5 }, { nicho: 'Psicologia', quantidadeDesejada: 2, tipo: 'a\u0000b' }]) {
    const { saida, chamadas } = await pesquisar({}, ruim);
    assert.deepEqual([saida.ok, saida.erro.code, saida.achados, saida.relatorio], [false, ERROR.BRIEFING_INVALIDO, [], null], JSON.stringify(ruim));
    assert.deepEqual([chamadas.search.length, chamadas.fetch.length, chamadas.ads.length], [0, 0, 0]);
  }
  const getter = {};
  Object.defineProperty(getter, 'nicho', { enumerable: true, get() { throw new Error('não deve executar'); } });
  assert.equal((await pesquisar({}, getter)).saida.erro.code, ERROR.BRIEFING_INVALIDO);
  assert.equal((await pesquisar({}, { nicho: 'Psicologia', quantidadeDesejada: 1000 })).saida.ok, true);
});

test('[RES-3] caminho feliz: um candidato vira UM achado rawFinding V2 válido, só com o que foi observado (canais, contatos publicados, observações do site e do Instagram, anúncios)', async () => {
  const { saida } = await pesquisar();
  assert.equal(saida.ok, true);
  assert.equal(saida.achados.length, 1);
  const achado = saida.achados[0];
  // é V2 válido e idêntico ao que o validador devolveria (nenhuma chave de decisão, análise, hipótese ou observação bruta)
  assert.equal(validateRawFindingsV2(saida.achados, { now: AGORA }).ok, true);
  assert.deepEqual(Object.keys(achado).sort(), ['campos', 'cidade', 'dataDaPesquisa', 'dossie', 'empresa', 'estado', 'fontes', 'nicho', 'tipo'].sort());
  assert.deepEqual([achado.empresa, achado.cidade, achado.estado, achado.tipo, achado.nicho, achado.dataDaPesquisa], ['Clínica Alfa Teste', 'Petrópolis', 'RJ', 'clínica', 'Psicologia', HOJE]);
  for (const proibida of ['observacoesBrutas', 'hipoteseDeOportunidade', 'identidadeAmbigua', 'status', 'score', 'ranking', 'temperatura', 'prioridade', 'estadoOperacional', 'prospectId', 'loteId']) assert.equal(proibida in achado, false, proibida);
  assert.deepEqual(achado.dossie.analises, [], 'sem análises nem hipóteses (o Researcher V1 não as gera)');

  const ev = (campo) => achado.campos[campo].map((e) => [e.valor, e.tipoFonte, e.url]);
  assert.deepEqual(ev('site'), [[SITE, 'OFICIAL', SITE]]);
  assert.deepEqual(ev('instagram'), [[IG, 'OFICIAL', SITE], [IG, 'SECUNDARIA', BUSCA]]);
  assert.deepEqual(ev('facebook'), [['https://www.facebook.com/alfa.teste', 'OFICIAL', SITE]]);
  assert.deepEqual(ev('linkedin'), [['https://www.linkedin.com/company/alfa-teste', 'OFICIAL', SITE]]);
  assert.deepEqual(ev('youtube'), [['https://www.youtube.com/@alfa_teste', 'OFICIAL', SITE]]);
  assert.deepEqual(ev('googlePerfil'), [[GOOGLE, 'SECUNDARIA', BUSCA]], 'só a busca apontou: SECUNDARIA');
  assert.deepEqual(ev('whatsapp'), [['5524987651000', 'OFICIAL', SITE]]);
  assert.deepEqual(ev('telefone'), [['+552433331111', 'OFICIAL', SITE]]);
  assert.deepEqual(ev('email'), [['contato@alfa-teste.example.test', 'OFICIAL', SITE]]);
  for (const evidencias of Object.values(achado.campos)) for (const e of evidencias) assert.deepEqual([e.dataConsulta, typeof e.fonte, e.url.startsWith('https://')], [HOJE, 'string', true]);

  assert.deepEqual(achado.dossie.fatos.map((f) => [f.campo, f.status, f.valor]).sort(), [
    ['anuncios.google', 'DADO', 'NAO_ENCONTRADO_NA_VERIFICACAO'],
    ['anuncios.meta', 'DADO', 'IDENTIFICADO'],
    ['instagram.cta', 'DADO', 'Agende pelo link da bio'],
    ['instagram.postagensObservadas', 'DADO', ['2026-09-01', '2026-09-10', '2026-09-20']],
    ['site.ctaAgendamento', 'DADO', true],
    ['site.ctaWhatsapp', 'DADO', true],
    ['site.formularioContato', 'DADO', true],
  ]);
  assert.equal(fato(achado, 'instagram.cta').fonte.url, IG);
  assert.equal(fato(achado, 'anuncios.meta').fonte.tipo, 'OFICIAL');
  assert.deepEqual(saida.relatorio.omissoes, []);
  assert.deepEqual([saida.relatorio.paginasConsultadas, saida.relatorio.consultasDeAnuncios, saida.relatorio.candidatos, saida.relatorio.achadosGerados], [2, 2, 1, 1]);

  // o dossiê deriva os sinais (o Researcher não cria nenhum)
  const dossie = dossieDe(achado);
  const sinais = Object.fromEntries(dossie.sinais.map((s) => [s.tipo, s]));
  assert.equal(sinais.INSTAGRAM_ATIVIDADE.valor.diasDesdeUltimaPostagem, 5);
  assert.equal(sinais.ANUNCIO_META.valor, 'IDENTIFICADO');
  assert.equal(sinais.CTA_AGENDAMENTO.status, 'DADO');
});

test('[RES-4] a PRIORIDADE das fontes é a documentada e o site é lido antes do Instagram; só se visita o site e o perfil (no máximo 2 páginas por candidato)', async () => {
  assert.deepEqual(policy.SOURCE_PRIORITY, ['SITE_OFICIAL', 'GOOGLE_PERFIL', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'OUTRAS_FONTES_PUBLICAS']);
  const { chamadas } = await pesquisar();
  assert.deepEqual(chamadas.fetch, [SITE, IG]);
  assert.deepEqual(chamadas.ads.map((a) => a.plataforma), ['META', 'GOOGLE']);
  assert.deepEqual(chamadas.ads[0], { plataforma: 'META', nome: 'Clínica Alfa Teste', regiao: 'Petrópolis/RJ' });
  assert.equal(LIMITS.PAGINAS_POR_CANDIDATO, 2);
  assert.match(chamadas.search[0].consulta, /^Psicologia clínica Petrópolis\/RJ$/);
});

test('[RES-5] falhas viram NAO_VERIFICADO com motivo e a pesquisa SEGUE; nada é contornado; nada é afirmado ("site não existe", "não anuncia", "inativo" nunca aparecem)', async () => {
  const casos = [['FORA_DO_AR', MOTIVO.SITE_FORA_DO_AR], ['LOGIN', MOTIVO.BLOQUEADO], ['CAPTCHA', MOTIVO.BLOQUEADO], ['BLOQUEADO', MOTIVO.BLOQUEADO], ['ROBOTS', MOTIVO.BLOQUEADO], ['REMOVIDA', MOTIVO.PAGINA_REMOVIDA], ['SEM_RESULTADO', MOTIVO.SEM_RESULTADO], ['DESATUALIZADA', MOTIVO.DESATUALIZADA], ['TEMPO_ESGOTADO', MOTIVO.NAO_CONSULTADO], ['ERRO', MOTIVO.NAO_CONSULTADO], ['INVENTADA', MOTIVO.NAO_CONSULTADO], [undefined, MOTIVO.NAO_CONSULTADO]];
  for (const [falha, motivo] of casos) {
    const { saida, chamadas } = await pesquisar({ paginas: { [SITE]: { ok: false, falha } } });
    const achado = saida.achados[0];
    assert.ok(achado, `${falha}: o achado existe (o site veio da busca)`);
    assert.deepEqual(achado.campos.site.map((e) => [e.valor, e.tipoFonte, e.url]), [[SITE, 'SECUNDARIA', BUSCA]], falha);
    assert.deepEqual(achado.dossie.fatos.filter((f) => f.campo.startsWith('site.')).map((f) => [f.campo, f.status, f.valor, f.motivo, 'fonte' in f]), [['site.ctaWhatsapp', 'NAO_VERIFICADO', null, motivo, false], ['site.ctaAgendamento', 'NAO_VERIFICADO', null, motivo, false], ['site.formularioContato', 'NAO_VERIFICADO', null, motivo, false]], String(falha));
    assert.deepEqual(chamadas.fetch, [SITE, IG], 'a pesquisa segue: o Instagram (da busca) ainda é visitado');
    assert.equal(saida.relatorio.falhas[falha === undefined || falha === 'INVENTADA' ? 'DESCONHECIDA' : falha], 1, falha);
    const texto = JSON.stringify(saida);
    for (const negativa of [/n[ãa]o anuncia/i, /n[ãa]o existe/i, /inativ/i, /sem site/i, /n[ãa]o tem/i]) assert.doesNotMatch(texto, negativa, `${falha}: ${negativa}`);
    assert.equal(validateRawFindingsV2(saida.achados, { now: AGORA }).ok, true);
  }
  // uma porta que LANÇA é a falha ERRO (a mensagem nunca é copiada); resposta que não é objeto é DESCONHECIDA
  const lanca = await pesquisar({ fetch: async () => { throw new Error('C:\\segredo\\caminho.json'); } });
  assert.equal(lanca.saida.ok, true);
  assert.equal(lanca.saida.relatorio.falhas.ERRO, 2, 'a exceção vira ERRO (uma por página), e é contada');
  assert.equal(JSON.stringify(lanca.saida).includes('segredo'), false);
  for (const lixo of [null, undefined, 5, 'x', [], { ok: 'sim' }, { ok: true }, { ok: true, urlFinal: 5 }]) {
    const r = await pesquisar({ fetch: async () => lixo });
    assert.equal(r.saida.ok, true, JSON.stringify(lixo));
    assert.equal(fato(r.saida.achados[0], 'site.formularioContato').status, 'NAO_VERIFICADO');
  }
});

test('[RES-6] login/captcha por REDIRECIONAMENTO: se a página final é uma tela de login, nada dela é lido e o motivo é BLOQUEADO', async () => {
  const { saida } = await pesquisar({ paginas: { [SITE]: paginaSite({ urlFinal: 'https://alfa-teste.example.test/login?next=/' }), [IG]: paginaPerfil({}) } });
  const achado = saida.achados[0];
  assert.deepEqual(achado.campos.site.map((e) => e.tipoFonte), ['SECUNDARIA']);
  assert.equal(fato(achado, 'site.formularioContato').motivo, MOTIVO.BLOQUEADO);
  assert.equal('facebook' in achado.campos, false, 'os links da tela de login não foram lidos');
  assert.equal(saida.relatorio.falhas.LOGIN, 1);
  // o perfil que redireciona para o login
  const ig = await pesquisar({ paginas: { [IG]: { ...paginaPerfil(), urlFinal: 'https://www.instagram.com/accounts/login/' } } });
  assert.equal(fato(ig.saida.achados[0], 'instagram.ultimaPostagemEm').motivo, MOTIVO.BLOQUEADO);
  // o perfil que redireciona para OUTRA página que não é o perfil
  const outro = await pesquisar({ paginas: { [IG]: { ...paginaPerfil(), urlFinal: 'https://outro.example.test/x' } } });
  assert.equal(fato(outro.saida.achados[0], 'instagram.ultimaPostagemEm').motivo, MOTIVO.NAO_CONSULTADO);
  assert.equal(fato(outro.saida.achados[0], 'instagram.cta'), undefined);
});

test('[RES-7] Instagram: perfil privado = NAO_VERIFICADO (PERFIL_PRIVADO), nenhuma postagem afirmada; falha de leitura = motivo; nunca "inativo"', async () => {
  const privado = await pesquisar({ paginas: { [IG]: paginaPerfil({ privado: true }) } });
  const a = privado.saida.achados[0];
  assert.deepEqual(a.dossie.fatos.filter((f) => f.campo.startsWith('instagram.')).map((f) => [f.campo, f.status, f.valor, f.motivo]), [['instagram.ultimaPostagemEm', 'NAO_VERIFICADO', null, MOTIVO.PERFIL_PRIVADO]]);
  const falha = await pesquisar({ paginas: { [IG]: { ok: false, falha: 'PRIVADO' } } });
  assert.equal(fato(falha.saida.achados[0], 'instagram.ultimaPostagemEm').motivo, MOTIVO.PERFIL_PRIVADO);
  const vazio = await pesquisar({ paginas: { [IG]: paginaPerfil({ postagens: [], ctaBio: undefined }) } });
  assert.deepEqual(vazio.saida.achados[0].dossie.fatos.filter((f) => f.campo.startsWith('instagram.')), [], 'sem postagens observadas: nenhum fato (ausência não é afirmação)');
  const semPerfil = await pesquisar({ paginas: { [IG]: { ok: true, urlFinal: IG, links: [] } } });
  assert.deepEqual(semPerfil.saida.achados[0].dossie.fatos.filter((f) => f.campo.startsWith('instagram.')), []);
  for (const r of [privado, falha, vazio, semPerfil]) assert.doesNotMatch(JSON.stringify(r.saida), /inativ|ativo/i);
});

test('[RES-8] Instagram: 1 data = última postagem; 2+ = postagens observadas (ordenadas, sem repetição); datas futuras e inválidas são omitidas COM código; no máximo as 30 mais recentes (declarado); CTA só como a bio mostra', async () => {
  const uma = await pesquisar({ paginas: { [IG]: paginaPerfil({ postagens: ['2026-09-20'] }) } });
  assert.deepEqual([fato(uma.saida.achados[0], 'instagram.ultimaPostagemEm').valor, fato(uma.saida.achados[0], 'instagram.postagensObservadas')], ['2026-09-20', undefined]);
  const varias = await pesquisar({ paginas: { [IG]: paginaPerfil({ postagens: ['2026-09-20', '2026-09-01', '2026-09-01', '2026-09-10T10:00:00Z', 'ontem', 5, null, '2026-09-26', '2027-01-01'] }) } });
  const v = varias.saida.achados[0];
  assert.deepEqual(fato(v, 'instagram.postagensObservadas').valor, ['2026-09-01', '2026-09-10', '2026-09-20']);
  assert.deepEqual(varias.saida.relatorio.omissoes, [{ campo: 'instagram.postagensObservadas', codigo: OMISSAO.DATA_FUTURA, quantidade: 1 }, { campo: 'instagram.postagensObservadas', codigo: OMISSAO.DATA_INVALIDA, quantidade: 4 }]);
  const muitas = Array.from({ length: 35 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`.replace('2026-08-32', '2026-09-01').replace('2026-08-33', '2026-09-02').replace('2026-08-34', '2026-09-03').replace('2026-08-35', '2026-09-04'));
  const trinta = await pesquisar({ paginas: { [IG]: paginaPerfil({ postagens: muitas }) } });
  const datas = fato(trinta.saida.achados[0], 'instagram.postagensObservadas').valor;
  assert.equal(datas.length, 30);
  assert.equal(datas[29], '2026-09-04', 'as mais recentes');
  assert.deepEqual(trinta.saida.relatorio.omissoes, [{ campo: 'instagram.postagensObservadas', codigo: OMISSAO.AMOSTRA_LIMITADA, quantidade: 5 }]);
  const cta = await pesquisar({ paginas: { [IG]: paginaPerfil({ ctaBio: 'x'.repeat(201) }) } });
  assert.equal(fato(cta.saida.achados[0], 'instagram.cta'), undefined, 'CTA inválida não é registrada nem ajustada');
  assert.equal(validateRawFindingsV2(trinta.saida.achados, { now: AGORA }).ok, true);
});

test('[RES-9] a fonte de uma observação do Instagram é a do próprio perfil e o tipo segue a origem do perfil: linkado pelo site = OFICIAL; só pela busca = SECUNDARIA', async () => {
  const oficial = await pesquisar();
  assert.equal(fato(oficial.saida.achados[0], 'instagram.cta').fonte.tipo, 'OFICIAL');
  const soBusca = await pesquisar({ paginas: { [SITE]: paginaSite({ links: [] }) } });
  const a = soBusca.saida.achados[0];
  assert.deepEqual(a.campos.instagram.map((e) => e.tipoFonte), ['SECUNDARIA']);
  assert.equal(fato(a, 'instagram.cta').fonte.tipo, 'SECUNDARIA');
});

test('[RES-10] conflito de canal é PRESERVADO: dois perfis diferentes = duas evidências, o perfil NÃO é visitado, nenhuma observação é feita, e o relatório diz CANAL_AMBIGUO', async () => {
  const { saida, chamadas } = await pesquisar({ paginas: { [SITE]: paginaSite({ links: [{ href: IG }, { href: 'https://www.instagram.com/outro_perfil' }] }) } });
  const a = saida.achados[0];
  assert.deepEqual([...new Set(a.campos.instagram.map((e) => e.valor))].sort(), [IG, 'https://www.instagram.com/outro_perfil'].sort());
  assert.deepEqual(chamadas.fetch, [SITE]);
  assert.equal(a.dossie.fatos.some((f) => f.campo.startsWith('instagram.')), false);
  assert.deepEqual(saida.relatorio.omissoes, [{ campo: 'instagram', codigo: OMISSAO.CANAL_AMBIGUO, quantidade: 2 }]);
  const dossie = dossieDe(a);
  assert.deepEqual([dossie.sinais.find((s) => s.tipo === 'INSTAGRAM_EXISTENTE').status, dossie.sinais.find((s) => s.tipo === 'INSTAGRAM_EXISTENTE').valor], ['NAO_VERIFICADO', null], 'o dossiê mostra o conflito');
});

test('[RES-11] identidade ambígua: dois sites de hosts diferentes para o mesmo nome = ambos como SECUNDARIA, sem visitar nenhum, identidadeAmbigua = true (o discovery decide o resto)', async () => {
  const { saida, chamadas } = await pesquisar({ resultados: [{ nome: 'Clínica Alfa Teste', url: SITE, tipoResultado: 'SITE', fonteUrl: BUSCA }, { nome: 'Clínica Alfa Teste', url: 'https://alfa-outro.example.test/', tipoResultado: 'SITE', fonteUrl: BUSCA }] });
  const a = saida.achados[0];
  assert.equal(a.identidadeAmbigua, true);
  assert.deepEqual(a.campos.site.map((e) => [e.valor, e.tipoFonte]), [[SITE, 'SECUNDARIA'], ['https://alfa-outro.example.test/', 'SECUNDARIA']]);
  assert.deepEqual(chamadas.fetch, []);
  assert.equal(a.dossie.fatos.some((f) => f.campo.startsWith('site.') || f.campo.startsWith('instagram.')), false, 'sem página lida, sem observação de site nem de Instagram');
});

test('[RES-12] anúncios: IDENTIFICADO só com nome IGUAL (mesma normalização do discovery); verificação feita sem o anunciante = NAO_ENCONTRADO_NA_VERIFICACAO (biblioteca + data); falha = NAO_VERIFICADO; nunca "não anuncia"', async () => {
  const cenario = (meta, google) => pesquisar({ lookupAds: async ({ plataforma }) => (plataforma === 'META' ? meta : google) });
  const parecido = await cenario(adsMeta([{ nome: 'Clínica Alfa Teste Filial' }, { nome: 'Alfa' }]), adsGoogle([{ nome: 'clinica alfa teste' }]));
  const a = parecido.saida.achados[0];
  assert.equal(fato(a, 'anuncios.meta').valor, 'NAO_ENCONTRADO_NA_VERIFICACAO', 'nome parecido NÃO é o mesmo anunciante');
  assert.equal(fato(a, 'anuncios.google').valor, 'IDENTIFICADO', 'maiúsculas/acentos não importam');
  assert.deepEqual(fato(a, 'anuncios.meta').fonte, { url: 'https://www.facebook.com/ads/library/?q=alfa', tipo: 'OFICIAL', observadoEm: HOJE, nome: 'Biblioteca de anúncios' });
  const falhas = await cenario({ ok: false, falha: 'CAPTCHA' }, { ok: false, falha: 'SEM_RESULTADO' });
  assert.deepEqual([fato(falhas.saida.achados[0], 'anuncios.meta').motivo, fato(falhas.saida.achados[0], 'anuncios.google').motivo], [MOTIVO.BLOQUEADO, MOTIVO.SEM_RESULTADO]);
  assert.equal(fato(falhas.saida.achados[0], 'anuncios.meta').valor, null);
  // a fonte DEVE ser a biblioteca certa: qualquer outra url, host errado, http ou login vira NAO_VERIFICADO (não consultado)
  for (const url of ['https://outro.example.test/ads/library', 'http://www.facebook.com/ads/library/', 'https://www.facebook.com/alfa', 'https://www.facebook.com/login?next=/ads/library', 'javascript:alert(1)', 5, undefined]) {
    const r = await cenario({ ...adsMeta(), url }, adsGoogle());
    assert.deepEqual([fato(r.saida.achados[0], 'anuncios.meta').status, fato(r.saida.achados[0], 'anuncios.meta').motivo], ['NAO_VERIFICADO', MOTIVO.NAO_CONSULTADO], String(url));
  }
  const googleNoMeta = await cenario(adsGoogle(), adsMeta());
  assert.equal(fato(googleNoMeta.saida.achados[0], 'anuncios.meta').status, 'NAO_VERIFICADO', 'a biblioteca de uma plataforma não serve para a outra');
  for (const lixo of [{ ...adsMeta(), anunciantes: 'x' }, { ...adsMeta(), anunciantes: Array.from({ length: 201 }, () => ({ nome: 'X' })) }, null, 5]) {
    assert.equal(fato((await cenario(lixo, adsGoogle())).saida.achados[0], 'anuncios.meta').status, 'NAO_VERIFICADO');
  }
  // sem a porta de anúncios: nenhuma afirmação sobre anúncios
  const sem = await pesquisar({ ads: false });
  assert.equal(sem.saida.achados[0].dossie.fatos.some((f) => f.campo.startsWith('anuncios.')), false);
  assert.equal(sem.saida.relatorio.consultasDeAnuncios, 0);
  assert.doesNotMatch(JSON.stringify([parecido.saida, falhas.saida, sem.saida]), /n[ãa]o anuncia/i);
});

test('[RES-13] nada é INFERIDO: telefone, WhatsApp e e-mail só existem como link explícito publicado (tel:, mailto:, wa.me/api.whatsapp.com); texto solto, links relativos e outros esquemas são ignorados; nenhum proprietário/responsável', async () => {
  const { saida } = await pesquisar({ paginas: { [SITE]: paginaSite({ links: [{ href: '/contato', texto: 'Ligue (24) 98765-1000 falar com Dra. Maria, proprietária' }, { href: 'ftp://x.example.test' }, { href: 'javascript:alert(1)' }, { href: 'data:text/html,x' }, { href: 'tel:123' }, { href: 'mailto:sem-arroba' }, { href: 'https://wa.me/abc' }, { href: 'https://api.whatsapp.com/send?phone=5524987651000' }] }) } });
  const a = saida.achados[0];
  assert.deepEqual(Object.keys(a.campos).sort(), ['googlePerfil', 'instagram', 'site', 'whatsapp'].sort());
  assert.deepEqual(a.campos.whatsapp.map((e) => e.valor), ['5524987651000']);
  assert.doesNotMatch(JSON.stringify(a), /Maria|propriet|respons|98765-1000/);
  for (const campo of ['contato', 'cargo', 'proprietario', 'responsavel']) assert.equal(campo in a, false, campo);
});

test('[RES-14] só fontes PÚBLICAS por https: resultado de busca com http, javascript:, data:, host local/IP, porta, usuário/senha, login ou fora do vocabulário é descartado e contado; nenhuma dessas URLs é visitada', async () => {
  const ruins = [
    { nome: 'A Http', url: 'http://a-http.example.test/', tipoResultado: 'SITE', fonteUrl: BUSCA },
    { nome: 'A Js', url: 'javascript:alert(1)', tipoResultado: 'SITE', fonteUrl: BUSCA },
    { nome: 'A Data', url: 'data:text/html,x', tipoResultado: 'SITE', fonteUrl: BUSCA },
    { nome: 'A Local', url: 'https://localhost/x', tipoResultado: 'SITE', fonteUrl: BUSCA },
    { nome: 'A Ip', url: 'https://10.0.0.5/x', tipoResultado: 'SITE', fonteUrl: BUSCA },
    { nome: 'A Porta', url: 'https://a-porta.example.test:8443/', tipoResultado: 'SITE', fonteUrl: BUSCA },
    { nome: 'A Senha', url: 'https://u:p@a-senha.example.test/', tipoResultado: 'SITE', fonteUrl: BUSCA },
    { nome: 'A Login', url: 'https://a-login.example.test/login', tipoResultado: 'SITE', fonteUrl: BUSCA },
    { nome: 'A Fonte', url: 'https://a-fonte.example.test/', tipoResultado: 'SITE', fonteUrl: 'http://busca.example.test/' },
    { nome: 'A Tipo', url: 'https://a-tipo.example.test/', tipoResultado: 'BLOG', fonteUrl: BUSCA },
    { nome: 'A Proto', url: 'https://a-proto.example.test/', tipoResultado: '__proto__', fonteUrl: BUSCA },
    { nome: '', url: 'https://a-vazio.example.test/', tipoResultado: 'SITE', fonteUrl: BUSCA },
    { nome: 'A Extra', url: 'https://a-extra.example.test/', tipoResultado: 'SITE', fonteUrl: BUSCA, cidade: 5 },
    null,
    'texto',
    { nome: 'Clínica Alfa Teste', url: 'https://www.instagram.com/p/abc', tipoResultado: 'INSTAGRAM', fonteUrl: BUSCA },
  ];
  const { saida, chamadas } = await pesquisar({ resultados: ruins });
  assert.deepEqual([saida.ok, saida.achados.length, saida.relatorio.resultadosRecebidos, saida.relatorio.resultadosInvalidos], [true, 0, 16, 16]);
  assert.deepEqual(chamadas.fetch, []);
  for (const url of chamadas.fetch) assert.match(url, /^https:\/\//);
  // tudo o que foi visitado no caminho feliz é https público
  const feliz = await pesquisar();
  for (const url of feliz.chamadas.fetch) assert.equal(policy.parsePublicUrl(url) !== null, true, url);
});

test('[RES-15] a busca: falha, resposta inválida ou lançada = RESEARCHER_BUSCA_FALHOU (sem achados, com a falha contada); resultados demais (> 300) recusados por inteiro, sem cortar', async () => {
  for (const busca of [{ ok: false, falha: 'BLOQUEADO' }, null, 5, { ok: true }, { ok: true, resultados: 'x' }, { ok: true, resultados: [,] }]) {
    const { saida } = await pesquisar({ search: async () => busca });
    assert.deepEqual([saida.ok, saida.erro.code, saida.achados], [false, ERROR.BUSCA_FALHOU, []], JSON.stringify(busca));
    assert.ok(saida.relatorio);
  }
  assert.equal((await pesquisar({ search: async () => { throw new Error('segredo'); } })).saida.erro.code, ERROR.BUSCA_FALHOU);
  const demais = await pesquisar({ search: async () => ({ ok: true, resultados: Array.from({ length: 301 }, (_, i) => ({ nome: `Empresa ${i}`, url: `https://e${i}.example.test/`, tipoResultado: 'SITE', fonteUrl: BUSCA })) }) });
  assert.equal(demais.saida.erro.code, ERROR.BUSCA_FALHOU);
  assert.deepEqual(demais.chamadas.fetch, []);
  assert.equal((await pesquisar({ search: async () => ({ ok: false, falha: 'BLOQUEADO' }) })).saida.relatorio.falhas.BLOQUEADO, 1);
});

test('[RES-16] o alvo: pedidos + metade de reserva, no máximo 150 (o teto de uma submissão); a pesquisa PARA no alvo e a saída nunca passa de 150', async () => {
  assert.equal(LIMITS.MAX_ACHADOS, 150);
  const muitos = Array.from({ length: 200 }, (_, i) => ({ nome: `Empresa Número ${i} Teste`, url: `https://empresa-${i}.example.test/`, tipoResultado: 'SITE', fonteUrl: BUSCA }));
  const paginas = Object.fromEntries(muitos.map((r) => [r.url, { ok: true, urlFinal: r.url, links: [] }]));
  const pequeno = await pesquisar({ resultados: muitos, paginas, ads: false }, briefing({ quantidadeDesejada: 4 }));
  assert.deepEqual([pequeno.saida.relatorio.alvo, pequeno.saida.achados.length, pequeno.chamadas.fetch.length], [6, 6, 6]);
  const cem = await pesquisar({ resultados: muitos, paginas, ads: false }, briefing({ quantidadeDesejada: 100 }));
  assert.deepEqual([cem.saida.relatorio.alvo, cem.saida.achados.length], [150, 150]);
  const mil = await pesquisar({ resultados: muitos, paginas, ads: false }, briefing({ quantidadeDesejada: 1000 }));
  assert.equal(mil.saida.achados.length, 150);
  assert.equal(mil.chamadas.search[0].limite, 300);
  assert.equal(validateRawFindingsV2(mil.saida.achados, { now: AGORA }).ok, true);
  const impar = await pesquisar({ resultados: muitos, paginas, ads: false }, briefing({ quantidadeDesejada: 3 }));
  assert.equal(impar.saida.relatorio.alvo, 5);
});

test('[RES-17] resultados do mesmo candidato (site + canais) viram UM achado; empresas diferentes viram achados diferentes, na ordem da busca; nome+cidade agrupam, cidades diferentes separam', async () => {
  const resultados = [
    { nome: 'Clínica Alfa Teste', url: SITE, tipoResultado: 'SITE', fonteUrl: BUSCA, cidade: 'Petrópolis' },
    { nome: 'CLINICA ALFA TESTE', url: IG, tipoResultado: 'INSTAGRAM', fonteUrl: BUSCA, cidade: 'petropolis' },
    { nome: 'Clínica Alfa Teste', url: 'https://beta-teste.example.test/', tipoResultado: 'SITE', fonteUrl: BUSCA, cidade: 'Niterói' },
    { nome: 'Sem Cidade Teste', url: 'https://sem-cidade.example.test/', tipoResultado: 'SITE', fonteUrl: BUSCA },
  ];
  const { saida } = await pesquisar({ resultados, ads: false, paginas: { 'https://beta-teste.example.test/': { ok: true, urlFinal: 'https://beta-teste.example.test/', links: [] }, 'https://sem-cidade.example.test/': { ok: true, urlFinal: 'https://sem-cidade.example.test/', links: [] } } }, briefing({ quantidadeDesejada: 10 }));
  assert.deepEqual(saida.achados.map((a) => [a.empresa, a.cidade || null]), [['Clínica Alfa Teste', 'Petrópolis'], ['Clínica Alfa Teste', 'Niterói'], ['Sem Cidade Teste', null]]);
  assert.equal(saida.achados[0].campos.instagram.length >= 1, true);
});

test('[RES-18] NADA é cortado em silêncio: mais de 5 evidências de um campo, links demais e fontes demais são omitidos COM código no relatório (o campo inteiro sai, nunca metade)', async () => {
  const seis = Array.from({ length: 6 }, (_, i) => ({ href: `https://www.facebook.com/pagina.${i}` }));
  const a = await pesquisar({ paginas: { [SITE]: paginaSite({ links: [...seis, { href: IG }] }) } });
  assert.equal('facebook' in a.saida.achados[0].campos, false);
  assert.deepEqual(a.saida.relatorio.omissoes, [{ campo: 'facebook', codigo: OMISSAO.EVIDENCIAS_EXCESSIVAS, quantidade: 6 }]);
  const cinco = await pesquisar({ paginas: { [SITE]: paginaSite({ links: seis.slice(0, 5) }) } });
  assert.equal(cinco.saida.achados[0].campos.facebook.length, 5, '5 é o teto e passa (conflito preservado)');
  const links = Array.from({ length: 501 }, (_, i) => ({ href: `https://x${i}.example.test/` }));
  const l = await pesquisar({ paginas: { [SITE]: paginaSite({ links: [...links, { href: IG }] }) } });
  assert.deepEqual(l.saida.relatorio.omissoes, [{ campo: 'site', codigo: OMISSAO.LINKS_EXCESSIVOS, quantidade: 2 }]);
  assert.equal(LIMITS.EVIDENCIAS_POR_CAMPO, 5);
});

test('[RES-19] um candidato sem NENHUMA evidência utilizável não vira achado (SEM_EVIDENCIA no relatório); o achado só carrega o que foi observado', async () => {
  const { saida } = await pesquisar({ resultados: [{ nome: 'Só Instagram Errado', url: 'https://www.instagram.com/p/abc', tipoResultado: 'INSTAGRAM', fonteUrl: BUSCA }, ...resultadosAlfa()] });
  assert.equal(saida.achados.length, 1);
  assert.equal(saida.relatorio.candidatos, 2);
  assert.deepEqual(saida.relatorio.omissoes, [{ campo: 'achado', codigo: OMISSAO.SEM_EVIDENCIA }]);
  assert.equal(saida.relatorio.resultadosInvalidos, 1);
});

test('[RES-20] o tempo: passada a duração máxima a pesquisa PARA (sem afirmar nada), o relatório diz interrompidaPorTempo, e o que já foi feito continua válido; anúncios e páginas param antes', async () => {
  let agora = AGORA.getTime();
  const m = mundo();
  const original = m.ports.fetchPage;
  m.ports.fetchPage = async (url) => { agora += 400; return original(url); };
  const researcher = createResearcher(m.ports, { now: () => new Date(agora), maxDurationMs: 500 });
  const saida = await researcher.research(briefing());
  assert.equal(saida.ok, true);
  assert.equal(validateRawFindingsV2(saida.achados, { now: new Date(agora) }).ok, true);
  assert.ok(m.chamadas.fetch.length <= 2);
  const cedo = createResearcher(mundo({ resultados: [...resultadosAlfa(), { nome: 'Outra Empresa Teste', url: 'https://outra.example.test/', tipoResultado: 'SITE', fonteUrl: BUSCA }] }).ports, { now: (() => { let n = 0; return () => new Date(AGORA.getTime() + (n++ > 3 ? 10000 : 0)); })(), maxDurationMs: 1000 });
  const parcial = await cedo.research(briefing({ quantidadeDesejada: 10 }));
  assert.equal(parcial.relatorio.interrompidaPorTempo, true);
});

test('[RES-21] portas hostis: getters, Symbol, protótipo, listas com lacunas e estruturas gigantes nunca lançam nem são executadas; o resultado é sempre válido ou um erro estável', async () => {
  let executou = false;
  const comGetter = { ok: true, urlFinal: SITE };
  Object.defineProperty(comGetter, 'links', { enumerable: true, get() { executou = true; return []; } });
  const hostis = [comGetter, { ok: true, urlFinal: SITE, links: [,] }, { ok: true, urlFinal: SITE, links: 'x' }, { ok: true, urlFinal: SITE, links: Array.from({ length: 5000 }, () => ({ href: 'https://a.example.test/' })) }, JSON.parse('{"ok":true,"urlFinal":"https://alfa-teste.example.test/","__proto__":{"polluted":true},"links":[{"href":"https://www.instagram.com/x","__proto__":{"polluted":true}}]}'), { ok: true, urlFinal: SITE, [Symbol('s')]: 1 }];
  for (const pagina of hostis) {
    const r = await pesquisar({ paginas: { [SITE]: pagina } });
    assert.equal(r.saida.ok, true);
    assert.equal(validateRawFindingsV2(r.saida.achados, { now: AGORA }).ok, true);
  }
  assert.equal(executou, false);
  assert.equal({}.polluted, undefined);
  const hostilBusca = [{ nome: 'X', url: SITE, tipoResultado: 'SITE', fonteUrl: BUSCA, get extra() { executou = true; return 1; } }];
  assert.equal((await pesquisar({ resultados: hostilBusca })).saida.achados.length, 0);
  assert.equal(executou, false);
});

test('[RES-22] determinístico e sem efeito colateral: as mesmas portas dão a mesma saída; o briefing de entrada não é alterado; a saída é uma cópia independente das respostas das portas', async () => {
  const brief = briefing();
  const copia = structuredClone(brief);
  const a = await pesquisar({}, brief);
  const b = await pesquisar({}, brief);
  assert.deepEqual(a.saida, b.saida);
  assert.deepEqual(brief, copia);
  const resposta = paginaSite();
  const c = await pesquisar({ paginas: { [SITE]: resposta } });
  resposta.links.length = 0;
  resposta.urlFinal = 'https://mutado.example.test/';
  assert.equal(c.saida.achados[0].campos.site[0].valor, SITE);
});

test('[RES-23] classifyLink: reconhece só o que um link publicado É (regras fixas); compartilhamento, login, caminhos de postagem e relativos são ignorados', () => {
  const c = policy.classifyLink;
  assert.deepEqual(c('https://instagram.com/alfa_teste/?hl=pt#x'), { canal: 'instagram', url: 'https://www.instagram.com/alfa_teste' });
  assert.deepEqual(c('https://www.instagram.com/alfa_teste/'), { canal: 'instagram', url: 'https://www.instagram.com/alfa_teste' });
  for (const nao of ['https://www.instagram.com/p/abc', 'https://www.instagram.com/reel/abc', 'https://www.instagram.com/explore', 'https://www.instagram.com/accounts/login/', 'https://www.instagram.com/alfa/p/abc', 'https://www.instagram.com/', 'https://www.instagram.com/nome com espaco']) assert.equal(c(nao), null, nao);
  assert.deepEqual(c('https://facebook.com/alfa.teste'), { canal: 'facebook', url: 'https://www.facebook.com/alfa.teste' });
  for (const nao of ['https://www.facebook.com/sharer/sharer.php?u=x', 'https://www.facebook.com/sharer.php', 'https://www.facebook.com/login', 'https://www.facebook.com/ads/library', 'https://www.facebook.com/profile.php?id=1', 'https://www.facebook.com/ab']) assert.equal(c(nao), null, nao);
  assert.deepEqual(c('https://www.linkedin.com/company/alfa-teste/'), { canal: 'linkedin', url: 'https://www.linkedin.com/company/alfa-teste' });
  assert.deepEqual(c('https://www.linkedin.com/in/maria-teste'), { canal: 'linkedin', url: 'https://www.linkedin.com/in/maria-teste' });
  assert.equal(c('https://www.linkedin.com/login'), null);
  assert.equal(c('https://www.linkedin.com/jobs/view/1'), null);
  assert.deepEqual(c('https://www.youtube.com/@alfa_teste'), { canal: 'youtube', url: 'https://www.youtube.com/@alfa_teste' });
  assert.deepEqual(c('https://youtube.com/channel/UC123'), { canal: 'youtube', url: 'https://www.youtube.com/channel/UC123' });
  assert.equal(c('https://www.youtube.com/watch?v=abc'), null);
  assert.deepEqual(c('https://www.google.com/maps/place/alfa/'), { canal: 'googlePerfil', url: 'https://www.google.com/maps/place/alfa' });
  assert.equal(c('https://www.google.com/search?q=x'), null);
  assert.deepEqual(c('https://wa.me/5524987651000'), { canal: 'whatsapp', numero: '5524987651000' });
  assert.deepEqual(c('https://wa.me/+5524987651000'), { canal: 'whatsapp', numero: '5524987651000' });
  assert.deepEqual(c('https://api.whatsapp.com/send?phone=5524987651000&text=oi'), { canal: 'whatsapp', numero: '5524987651000' });
  assert.equal(c('https://api.whatsapp.com/send?text=oi'), null);
  assert.deepEqual(c('tel:+55 24 3333-1111'), { canal: 'telefone', numero: '+55 24 3333-1111' });
  assert.deepEqual(c('mailto:contato@x.example.test?subject=oi'), { canal: 'email', endereco: 'contato@x.example.test' });
  for (const nao of [undefined, null, 5, {}, '', '/instagram', 'www.instagram.com/x', 'http://www.instagram.com/x', 'ftp://a.example.test', 'javascript:alert(1)', 'https://127.0.0.1/x', `https://www.instagram.com/${'a'.repeat(3000)}`, 'tel:1', 'mailto:x']) assert.equal(c(nao), null, String(nao).slice(0, 40));
});

test('[RES-24] motivoFor: cada falha de porta tem UM motivo do vocabulário fechado (FORA_DO_AR só é "site fora do ar" para o site); falha desconhecida = NAO_CONSULTADO; chaves herdadas não valem', () => {
  assert.equal(policy.motivoFor('FORA_DO_AR', { site: true }), MOTIVO.SITE_FORA_DO_AR);
  assert.equal(policy.motivoFor('FORA_DO_AR'), MOTIVO.NAO_CONSULTADO);
  for (const ruim of ['__proto__', 'constructor', 'toString', 5, null, undefined, {}]) assert.equal(policy.motivoFor(ruim), MOTIVO.NAO_CONSULTADO, String(ruim));
  assert.deepEqual(Object.keys(policy.FAILURE), ['FORA_DO_AR', 'PRIVADO', 'LOGIN', 'CAPTCHA', 'BLOQUEADO', 'ROBOTS', 'REMOVIDA', 'SEM_RESULTADO', 'DESATUALIZADA', 'TEMPO_ESGOTADO', 'ERRO']);
  for (const falha of Object.keys(policy.FAILURE)) assert.ok(Object.values(MOTIVO).includes(policy.motivoFor(falha, { site: true })), falha);
  assert.equal(policy.isLoginWall('https://a.example.test/login'), true);
  assert.equal(policy.isLoginWall('https://a.example.test/accounts/login/?next=/'), true);
  assert.equal(policy.isLoginWall('https://a.example.test/checkpoint/1'), true);
  assert.equal(policy.isLoginWall('https://a.example.test/blog/login-dicas'), false);
  assert.equal(policy.isLoginWall('nao-e-url'), false);
  assert.equal(policy.isSchedulingLink({ href: 'https://calendly.com/alfa', texto: '' }), true);
  assert.equal(policy.isSchedulingLink({ href: 'https://a.example.test/x', texto: 'Agende agora' }), true);
  assert.equal(policy.isSchedulingLink({ href: 'https://a.example.test/x', texto: 'Quem somos' }), false);
  assert.equal(policy.isSchedulingLink({ href: 'x', texto: 5 }), false);
});

test('[RES-25] o Researcher NÃO decide nem grava: sem score/ranking/temperatura/prioridade/decisão comercial no vocabulário e na saída; sem CRM, fila, aprovação, promoção, serviço, autorização, rede, disco ou relógio próprio; só importa irmãos', async () => {
  const raiz = path.join(__dirname, '..', '..');
  for (const nome of ['researcher.js', 'researchPolicy.js']) {
    const arquivo = path.join(raiz, 'src', 'research-prospector', nome);
    const codigo = fs.readFileSync(arquivo, 'utf8');
    const estatica = analyzeSource(codigo, toPosix(path.relative(raiz, arquivo)));
    assert.deepEqual(estatica.issues, [], nome);
    for (const ref of estatica.refs) assert.match(ref.specifier, /^\.\/(rawFindingSchema|rawFindingV2|signalSchema|normalize|researchPolicy)$/, `${nome} importa ${ref.specifier}`);
    const semComentarios = codigo.replace(/\/\/.*$/gm, '');
    for (const proibido of [/node:/, /\bfetch\(/, /XMLHttpRequest|WebSocket|child_process/, /process\./, /Date\.now|Math\.random|crypto/, /\beval\(|new Function/, /approveProspect|rejectProspect|promoteProspect|proposeProspect|addProspect/, /createRecord|updateRecord|moveStatus|markDoNotContact|writeRecord/, /\bscore\b|ranking|temperatura|prioridade/i, /enviar|sendMessage|sendEmail/]) assert.doesNotMatch(semComentarios, proibido, `${nome}: ${proibido}`);
  }
  const { saida } = await pesquisar();
  assert.doesNotMatch(JSON.stringify(saida), /score|ranking|temperatura|prioridade|aprovad|promov|problemaIdentificado/i);
  for (const outro of ['approvalQueue.js', 'discovery.js', 'crmAdapter.js', 'batchAccounting.js', 'dossier.js', 'signalSchema.js', 'rawFindingSchema.js', 'rawFindingV2.js']) assert.doesNotMatch(fs.readFileSync(path.join(raiz, 'src', 'research-prospector', outro), 'utf8'), /require\('\.\/(researcher|researchPolicy)'\)/, `${outro} não conhece o Researcher`);
  assert.doesNotMatch(fs.readFileSync(path.join(raiz, 'src', 'services', 'prospectingService.js'), 'utf8'), /researcher|researchPolicy/i, 'o Researcher NÃO foi ligado ao serviço');
  assert.equal(fs.existsSync(path.join(raiz, 'src', 'services', 'researchService.js')), false, 'nenhum serviço/rota do Researcher nesta etapa');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Lacunas fechadas pela mutação
// ---------------------------------------------------------------------------------------------------------------------------------
test('[RES-26] só o que a página publica: sem link de WhatsApp/agendamento e sem formulário (false), NENHUM fato de CTA/formulário — ausência não é afirmação', async () => {
  const semNada = await pesquisar({ paginas: { [SITE]: paginaSite({ links: [{ href: IG }], temFormularioContato: false }) } });
  assert.deepEqual(semNada.saida.achados[0].dossie.fatos.filter((f) => f.campo.startsWith('site.')), []);
  for (const valor of [undefined, 'sim', 1, null]) {
    const r = await pesquisar({ paginas: { [SITE]: paginaSite({ links: [{ href: IG }], temFormularioContato: valor }) } });
    assert.equal(fato(r.saida.achados[0], 'site.formularioContato'), undefined, String(valor));
  }
  const soZap = await pesquisar({ paginas: { [SITE]: paginaSite({ links: [{ href: IG }, { href: 'https://wa.me/5524987651000' }], temFormularioContato: false }) } });
  assert.deepEqual(soZap.saida.achados[0].dossie.fatos.filter((f) => f.campo.startsWith('site.')).map((f) => f.campo), ['site.ctaWhatsapp']);
  const soAgenda = await pesquisar({ paginas: { [SITE]: paginaSite({ links: [{ href: IG }, { href: 'https://calendly.com/alfa' }], temFormularioContato: false }) } });
  assert.deepEqual(soAgenda.saida.achados[0].dossie.fatos.filter((f) => f.campo.startsWith('site.')).map((f) => f.campo), ['site.ctaAgendamento']);
});

test('[RES-27] a busca só vale com ok === true; a lista de links respeita o limite e a evidência repetida conta uma vez; um canal só aceita a URL do próprio canal', async () => {
  const validos = { resultados: resultadosAlfa() };
  assert.equal((await pesquisar({ search: async () => ({ ok: false, ...validos }) })).saida.erro.code, ERROR.BUSCA_FALHOU);
  assert.equal((await pesquisar({ search: async () => ({ ok: 'sim', ...validos }) })).saida.erro.code, ERROR.BUSCA_FALHOU);
  const repetido = await pesquisar({ paginas: { [SITE]: paginaSite({ links: [{ href: IG }, { href: 'https://instagram.com/alfa_teste/' }, { href: 'https://www.instagram.com/alfa_teste?hl=pt' }] }) } });
  assert.equal(repetido.saida.achados[0].campos.instagram.filter((e) => e.tipoFonte === 'OFICIAL').length, 1);
  const links = Array.from({ length: 501 }, (_, i) => ({ href: `https://x${i}.example.test/` }));
  const l = await pesquisar({ paginas: { [SITE]: paginaSite({ links: [...links, { href: IG }] }) } });
  assert.deepEqual(l.saida.achados[0].campos.instagram.map((e) => e.tipoFonte), ['SECUNDARIA'], 'o 502º link (além do limite) NÃO foi lido');
  const trocado = await pesquisar({ paginas: { [SITE]: { ok: true, urlFinal: SITE, links: [] } }, resultados: [{ nome: 'Clínica Alfa Teste', url: SITE, tipoResultado: 'SITE', fonteUrl: BUSCA }, { nome: 'Clínica Alfa Teste', url: 'https://www.facebook.com/alfa.teste', tipoResultado: 'INSTAGRAM', fonteUrl: BUSCA }] });
  assert.equal('instagram' in trocado.saida.achados[0].campos, false, 'uma página do Facebook não é um Instagram');
  assert.equal(trocado.saida.relatorio.resultadosInvalidos, 1);
});

test('[RES-28] tipo de resultado fora do vocabulário nem forma candidato; resultado sem cidade herda o grupo, mas cidade diferente é outra empresa', async () => {
  const r = await pesquisar({ resultados: [{ nome: 'Um Blog', url: 'https://blog.example.test/', tipoResultado: 'BLOG', fonteUrl: BUSCA }, { nome: 'Um Proto', url: 'https://proto.example.test/', tipoResultado: '__proto__', fonteUrl: BUSCA }] });
  assert.deepEqual([r.saida.relatorio.candidatos, r.saida.relatorio.resultadosInvalidos], [0, 2]);
  const cidades = await pesquisar({ ads: false, resultados: [
    { nome: 'Clínica Alfa Teste', url: SITE, tipoResultado: 'SITE', fonteUrl: BUSCA },
    { nome: 'Clínica Alfa Teste', url: IG, tipoResultado: 'INSTAGRAM', fonteUrl: BUSCA, cidade: 'Petrópolis' },
    { nome: 'Clínica Alfa Teste', url: 'https://www.instagram.com/alfa_niteroi', tipoResultado: 'INSTAGRAM', fonteUrl: BUSCA, cidade: 'Niterói' },
  ] }, briefing({ quantidadeDesejada: 10 }));
  assert.equal(cidades.saida.relatorio.candidatos, 2, 'o segundo grupo (Niterói) NÃO herdou a cidade do primeiro');
  assert.deepEqual(cidades.saida.achados.map((a) => a.cidade || null), ['Petrópolis', 'Niterói']);
});

test('[RES-29] Instagram: 2 datas já são "postagens observadas"; a fonte da observação é a URL FINAL da página lida; achado sem observação não leva bloco `dossie`', async () => {
  const duas = await pesquisar({ paginas: { [IG]: paginaPerfil({ postagens: ['2026-09-10', '2026-09-01'] }) } });
  assert.deepEqual(fato(duas.saida.achados[0], 'instagram.postagensObservadas').valor, ['2026-09-01', '2026-09-10']);
  assert.equal(fato(duas.saida.achados[0], 'instagram.ultimaPostagemEm'), undefined);
  const final = await pesquisar({ paginas: { [IG]: { ...paginaPerfil(), urlFinal: 'https://www.instagram.com/alfa_teste/' } } });
  assert.equal(fato(final.saida.achados[0], 'instagram.cta').fonte.url, 'https://www.instagram.com/alfa_teste/');
  const sem = await pesquisar({ ads: false, paginas: { [SITE]: { ok: true, urlFinal: SITE, links: [] } }, resultados: [{ nome: 'Clínica Alfa Teste', url: SITE, tipoResultado: 'SITE', fonteUrl: BUSCA }] });
  assert.equal('dossie' in sem.saida.achados[0], false);
});

test('[RES-30] evidências e fontes demais: o campo inteiro sai (com código) e as observações que dependiam dele também; fontes acima de 50 são omitidas COM código', async () => {
  const seis = Array.from({ length: 6 }, (_, i) => ({ nome: 'Clínica Alfa Teste', url: IG, tipoResultado: 'INSTAGRAM', fonteUrl: `https://busca.example.test/r${i}` }));
  const { saida } = await pesquisar({ ads: false, resultados: [{ nome: 'Clínica Alfa Teste', url: SITE, tipoResultado: 'SITE', fonteUrl: BUSCA }, ...seis], paginas: { [SITE]: { ok: true, urlFinal: SITE, links: [] } } });
  const a = saida.achados[0];
  assert.ok(a, 'o achado existe (o site basta) e é válido');
  assert.equal('instagram' in a.campos, false);
  assert.equal(a.dossie === undefined || a.dossie.fatos.every((f) => !f.campo.startsWith('instagram.')), true, 'a observação de um canal que saiu também sai (senão o V2 recusaria)');
  assert.ok(saida.relatorio.omissoes.some((o) => o.campo === 'instagram' && o.codigo === OMISSAO.EVIDENCIAS_EXCESSIVAS));
  const muitas = Array.from({ length: 55 }, (_, i) => ({ nome: 'Clínica Alfa Teste', url: IG, tipoResultado: 'INSTAGRAM', fonteUrl: `https://busca.example.test/r${i}` }));
  const fontes = await pesquisar({ ads: false, resultados: [{ nome: 'Clínica Alfa Teste', url: SITE, tipoResultado: 'SITE', fonteUrl: BUSCA }, ...muitas], paginas: { [SITE]: { ok: true, urlFinal: SITE, links: [] } } });
  assert.equal(fontes.saida.achados.length, 1, 'com mais de 50 fontes o achado continua válido');
  assert.equal(fontes.saida.achados[0].fontes.length, 50);
  assert.ok(fontes.saida.relatorio.omissoes.some((o) => o.codigo === OMISSAO.FONTES_EXCESSIVAS && o.campo === 'fontes' && o.quantidade > 0));
});

test('[RES-31] política: LinkedIn só empresa/pessoa (2 segmentos); telefone precisa de dígitos; login em qualquer canal é ignorado; a biblioteca de anúncios é a da PLATAFORMA e sem login; o canal do redirecionamento tem de ser o do perfil', async () => {
  const c = policy.classifyLink;
  assert.equal(c('https://www.linkedin.com/feed/update'), null);
  assert.equal(c('https://www.linkedin.com/pulse/artigo'), null);
  assert.equal(c('tel:(((((((('), null);
  assert.equal(c('https://www.google.com/maps/login'), null);
  assert.equal(c('https://www.google.com/maps/place/x/login/'), null);
  assert.equal(policy.isAdsLibraryUrl('META', 'https://www.facebook.com/ads/library/login'), false);
  assert.equal(policy.isAdsLibraryUrl('GOOGLE', 'https://adstransparency.google.com/login'), false);
  assert.equal(policy.isAdsLibraryUrl('GOOGLE', 'https://www.facebook.com/ads/library/?q=x'), false);
  assert.equal(policy.isAdsLibraryUrl('GOOGLE', 'https://outro.example.test/'), false);
  assert.equal(policy.isAdsLibraryUrl('META', 'https://adstransparency.google.com/?q=x'), false);
  assert.equal(policy.isAdsLibraryUrl('TIKTOK', 'https://adstransparency.google.com/'), false);
  assert.equal(policy.isAdsLibraryUrl('GOOGLE', 'https://adstransparency.google.com/?q=alfa'), true);
  assert.equal(policy.isChannelPage('instagram', 'https://www.facebook.com/alfa.teste'), false);
  assert.equal(policy.isChannelPage('instagram', IG), true);
  const m = mundo({ lookupAds: async ({ plataforma }) => (plataforma === 'META' ? adsGoogle() : adsMeta()) });
  const google = await createResearcher(m.ports, { now: () => AGORA }).research(briefing());
  assert.deepEqual([fato(google.achados[0], 'anuncios.meta').status, fato(google.achados[0], 'anuncios.google').status], ['NAO_VERIFICADO', 'NAO_VERIFICADO'], 'a biblioteca de uma plataforma não serve para a outra (nos dois sentidos)');
  const loginAds = await pesquisar({ lookupAds: async () => ({ ...adsMeta(), url: 'https://www.facebook.com/ads/library/login' }) });
  assert.equal(fato(loginAds.saida.achados[0], 'anuncios.meta').status, 'NAO_VERIFICADO');
  const facebook = await pesquisar({ paginas: { [IG]: { ...paginaPerfil(), urlFinal: 'https://www.facebook.com/alfa.teste' } } });
  assert.equal(fato(facebook.saida.achados[0], 'instagram.ultimaPostagemEm').motivo, MOTIVO.NAO_CONSULTADO);
  assert.equal(fato(facebook.saida.achados[0], 'instagram.cta'), undefined, 'nada da página de outro canal é lido');
});
