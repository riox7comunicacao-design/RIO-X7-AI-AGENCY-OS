// digitalPresence.js (Implementação 2): site oficial x presença digital x fontes de terceiros — tudo PURO e determinístico (sem rede, banco, LLM).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dp = require('../../src/research-prospector/digitalPresence');
const { analyzeSource, toPosix } = require('../helpers/staticImports');

test('[DP-1] hostOf / normalizeToOrigin / registrableLabel: só https público, na RAIZ; o rótulo do domínio (sem www, sem .com.br) para o vínculo com o nome', () => {
  assert.equal(dp.hostOf('https://www.Marilza-Estetica.com.br/servicos?x=1#a'), 'marilza-estetica.com.br');
  assert.equal(dp.normalizeToOrigin('https://www.alfa.com.br/tratamentos/facial?x=1#topo'), 'https://www.alfa.com.br/');
  for (const ruim of ['http://alfa.com.br/', 'ftp://alfa.com.br', 'javascript:alert(1)', '//alfa.com.br', 'https://10.0.0.1/', 'https://localhost/', 'https://u:p@alfa.com.br/', 'https://alfa.com.br:8443/', 'texto', '', null, undefined, 5]) {
    assert.equal(dp.normalizeToOrigin(ruim), null, String(ruim));
  }
  assert.deepEqual(['marilzaestetica.com.br', 'www.clinica-alfa.com', 'espacofacial.med.br', 'alfa.net.br', 'sub.alfa.com.br', 'granja.com'].map(dp.registrableLabel), ['marilzaestetica', 'clinicaalfa', 'espacofacial', 'alfa', 'alfa', 'granja']);
  assert.equal(dp.registrableLabel(''), '');
  assert.equal(dp.registrableLabel(null), '');
});

test('[DP-2] classifyHost: redes sociais (com o canal), diretórios, portais/notícias/marketplaces; um host desconhecido NÃO é terceiro "por lista" (o vínculo é provado por outra regra)', () => {
  const casos = [
    ['instagram.com', 'REDE_SOCIAL', 'instagram'], ['m.facebook.com', 'REDE_SOCIAL', 'facebook'], ['fb.me', 'REDE_SOCIAL', 'facebook'], ['linkedin.com', 'REDE_SOCIAL', 'linkedin'],
    ['youtube.com', 'REDE_SOCIAL', 'youtube'], ['tiktok.com', 'REDE_SOCIAL', 'tiktok'], ['wa.me', 'REDE_SOCIAL', 'whatsapp'], ['g.page', 'REDE_SOCIAL', 'googleMeuNegocio'],
    ['x.com', 'REDE_SOCIAL', null], ['twitter.com', 'REDE_SOCIAL', null], ['pt.pinterest.com', 'REDE_SOCIAL', null],
    ['guiamais.com.br', 'DIRETORIO', undefined], ['telelistas.net', 'DIRETORIO', undefined], ['www2.doctoralia.com.br', 'DIRETORIO', undefined], ['linktr.ee', 'DIRETORIO', undefined],
    ['g1.globo.com', 'NOTICIA_OU_TERCEIRO', undefined], ['noticias.uol.com.br', 'NOTICIA_OU_TERCEIRO', undefined], ['pt.wikipedia.org', 'NOTICIA_OU_TERCEIRO', undefined], ['produto.mercadolivre.com.br', 'NOTICIA_OU_TERCEIRO', undefined], ['alfa.blogspot.com', 'NOTICIA_OU_TERCEIRO', undefined],
  ];
  for (const [host, tipo, canal] of casos) {
    const r = dp.classifyHost(host);
    assert.equal(r.tipo, tipo, host);
    assert.equal(r.canal, canal, host);
    assert.equal(dp.isKnownThirdPartyHost(host), true, host);
  }
  for (const desconhecido of ['marilzaestetica.com.br', 'soupetropolis.com.br', 'espacofacial.com.br', 'instagram.com.alfa.com.br.evil.com', 'notinstagram.com', '', null]) {
    assert.equal(dp.classifyHost(desconhecido), null, String(desconhecido));
  }
});

test('[DP-3] classifySource / classifySources: o TIPO é por código; OFICIAL só para o host do site CONFIRMADO; sem repetição; só https públicas; no máximo 10', () => {
  assert.equal(dp.classifySource('https://alfa.com.br/x', 'alfa.com.br'), 'OFICIAL');
  assert.equal(dp.classifySource('https://alfa.com.br/x', null), 'NOTICIA_OU_TERCEIRO', 'sem site confirmado, um host desconhecido é "terceiro"');
  assert.equal(dp.classifySource('https://www.instagram.com/alfa', 'alfa.com.br'), 'REDE_SOCIAL');
  assert.equal(dp.classifySource('https://www.guiamais.com.br/x'), 'DIRETORIO');
  assert.equal(dp.classifySource('http://alfa.com.br/'), null);
  const lista = dp.classifySources(['https://alfa.com.br/', 'https://alfa.com.br/#topo', 'https://g1.globo.com/a', 'http://x.com.br/', 'lixo', 5, 'https://www.guiamais.com.br/x'], 'alfa.com.br');
  assert.deepEqual(lista, [{ url: 'https://alfa.com.br/', tipo: 'OFICIAL' }, { url: 'https://g1.globo.com/a', tipo: 'NOTICIA_OU_TERCEIRO' }, { url: 'https://www.guiamais.com.br/x', tipo: 'DIRETORIO' }]);
  assert.equal(dp.classifySources(Array.from({ length: 30 }, (_, i) => `https://s${i}.com.br/`)).length, dp.MAX_SOURCES);
  assert.deepEqual(dp.classifySources(undefined), []);
});

test('[DP-4] profileFor: a URL canônica de um PERFIL do canal (Instagram, Facebook, Google Meu Negócio, LinkedIn, YouTube, TikTok, WhatsApp); login, compartilhamento, postagem e URL de outro canal são recusados', () => {
  assert.equal(dp.profileFor('instagram', 'https://instagram.com/clinica.alfa?hl=pt'), 'https://www.instagram.com/clinica.alfa');
  assert.equal(dp.profileFor('facebook', 'https://facebook.com/clinicaalfa'), 'https://www.facebook.com/clinicaalfa');
  assert.equal(dp.profileFor('googleMeuNegocio', 'https://g.page/clinica-alfa'), 'https://g.page/clinica-alfa');
  assert.equal(dp.profileFor('googleMeuNegocio', 'https://www.google.com/maps/place/Clinica+Alfa'), 'https://www.google.com/maps/place/Clinica+Alfa');
  assert.equal(dp.profileFor('linkedin', 'https://www.linkedin.com/company/clinica-alfa/about'), null, 'caminho profundo não é o perfil');
  assert.equal(dp.profileFor('linkedin', 'https://www.linkedin.com/company/clinica-alfa'), 'https://www.linkedin.com/company/clinica-alfa');
  assert.equal(dp.profileFor('youtube', 'https://www.youtube.com/@clinicaalfa'), 'https://www.youtube.com/@clinicaalfa');
  assert.equal(dp.profileFor('tiktok', 'https://tiktok.com/@clinicaalfa'), 'https://www.tiktok.com/@clinicaalfa');
  assert.equal(dp.profileFor('whatsapp', 'https://wa.me/5524987651000'), 'https://wa.me/5524987651000');
  assert.equal(dp.profileFor('whatsapp', 'https://api.whatsapp.com/send?phone=5524987651000&text=oi'), 'https://wa.me/5524987651000');
  for (const [canal, ruim] of [['instagram', 'https://www.instagram.com/p/abc'], ['instagram', 'https://www.instagram.com/accounts/login'], ['instagram', 'https://www.facebook.com/clinicaalfa'], ['facebook', 'https://www.facebook.com/sharer/sharer.php?u=x'], ['tiktok', 'https://www.tiktok.com/video/123'], ['tiktok', 'https://www.instagram.com/clinicaalfa'], ['youtube', 'https://www.youtube.com/watch?v=abc'], ['whatsapp', 'https://wa.me/abc'], ['instagram', 'http://instagram.com/alfa'], ['instagram', 5], ['outro', 'https://instagram.com/alfa']]) {
    assert.equal(dp.profileFor(canal, ruim), null, `${canal} ${ruim}`);
  }
});

test('[DP-5] readProfileHints: o que o agente SUGERIU por canal — url válida do canal, null (procurou e não achou) ou ausente (não procurou); perfil de outro canal e texto solto somem', () => {
  const dicas = dp.readProfileHints({ instagram: 'https://instagram.com/alfa', facebook: null, linkedin: 'https://www.instagram.com/alfa', youtube: 'texto', tiktok: 'https://tiktok.com/@alfa', whatsapp: 'https://wa.me/5524987651000', outro: 'https://x.com/alfa' });
  assert.deepEqual(dicas, { instagram: 'https://www.instagram.com/alfa', facebook: null, tiktok: 'https://www.tiktok.com/@alfa', whatsapp: 'https://wa.me/5524987651000' });
  for (const lixo of [undefined, null, 5, 'x', [], [1]]) assert.deepEqual(dp.readProfileHints(lixo), {});
});

test('[DP-6] buildPresence: link no site oficial = CONFIRMADO; link cruzado = CONFIRMADO; só sugerido = ENCONTRADO/NAO_CONFIRMADO; null = NAO_ENCONTRADO; ausente = NAO_VERIFICADO; WhatsApp só do site oficial; nunca por nome parecido', () => {
  const p = dp.buildPresence({
    hints: { instagram: 'https://www.instagram.com/outro', facebook: 'https://www.facebook.com/alfa', linkedin: null, tiktok: 'https://www.tiktok.com/@alfa', googleMeuNegocio: 'https://g.page/alfa', whatsapp: 'https://wa.me/5511999999999' },
    officialLinks: ['https://www.instagram.com/alfa', 'https://wa.me/5524987651000', 'https://alfa.com.br/contato', 'https://www.youtube.com/@alfa'],
    crossLinks: ['https://www.facebook.com/alfa', 'https://www.tiktok.com/@outra_pessoa'],
    otherSources: [{ url: 'https://x.com/alfa', tipo: 'REDE_SOCIAL' }],
  });
  assert.deepEqual(p.instagram, { status: 'ENCONTRADO', url: 'https://www.instagram.com/alfa', confirmacao: 'CONFIRMADO', regra: 'link_no_site_oficial' });
  assert.deepEqual(p.facebook, { status: 'ENCONTRADO', url: 'https://www.facebook.com/alfa', confirmacao: 'CONFIRMADO', regra: 'link_cruzado' });
  assert.deepEqual(p.youtube, { status: 'ENCONTRADO', url: 'https://www.youtube.com/@alfa', confirmacao: 'CONFIRMADO', regra: 'link_no_site_oficial' });
  assert.deepEqual(p.whatsapp, { status: 'ENCONTRADO', url: 'https://wa.me/5524987651000', confirmacao: 'CONFIRMADO', regra: 'link_no_site_oficial' }, 'o WhatsApp só vem do site oficial, nunca da sugestão');
  assert.deepEqual(p.linkedin, { status: 'NAO_ENCONTRADO', url: null, confirmacao: 'NAO_CONFIRMADO' });
  assert.deepEqual(p.tiktok, { status: 'ENCONTRADO', url: 'https://www.tiktok.com/@alfa', confirmacao: 'NAO_CONFIRMADO' }, 'o link cruzado era de OUTRO perfil: não confirma');
  assert.deepEqual(p.googleMeuNegocio, { status: 'ENCONTRADO', url: 'https://g.page/alfa', confirmacao: 'NAO_CONFIRMADO' });
  assert.deepEqual(p.outros, [{ url: 'https://x.com/alfa', tipo: 'REDE_SOCIAL' }]);
  assert.deepEqual(Object.keys(p), ['instagram', 'facebook', 'googleMeuNegocio', 'linkedin', 'youtube', 'tiktok', 'whatsapp', 'outros']);
  assert.deepEqual(dp.confirmedChannels(p).map((c) => c.canal), ['instagram', 'facebook', 'youtube', 'whatsapp']);

  const vazia = dp.buildPresence();
  for (const canal of dp.CHANNELS) assert.deepEqual(vazia[canal], { status: 'NAO_VERIFICADO', url: null, confirmacao: 'NAO_CONFIRMADO' }, canal);
  assert.deepEqual(vazia, dp.emptyPresence());
  assert.deepEqual(dp.confirmedChannels(null), []);
  assert.equal(dp.buildPresence({ otherSources: Array.from({ length: 20 }, (_, i) => ({ url: `https://x.com/p${i}` })) }).outros.length, 5);
});

test('[DP-7] é PURO: só importa researchPolicy (a leitura de links); sem rede, banco, LLM, disco, processo ou relógio', () => {
  const arquivo = path.join(__dirname, '..', '..', 'src', 'research-prospector', 'digitalPresence.js');
  const codigo = fs.readFileSync(arquivo, 'utf8');
  const estatica = analyzeSource(codigo, toPosix(path.relative(path.join(__dirname, '..', '..'), arquivo)));
  assert.deepEqual(estatica.issues, []);
  assert.deepEqual(estatica.refs.map((ref) => ref.specifier), ['./researchPolicy']);
  assert.doesNotMatch(codigo.replace(/\/\/.*$/gm, ''), /\b(fetch|https?\.request|process\.|Date\.now|new Date|Math\.random|child_process|node:|anthropic|claude)\b/i);
});
