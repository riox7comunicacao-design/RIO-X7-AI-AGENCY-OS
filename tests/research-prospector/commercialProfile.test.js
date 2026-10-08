'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('../../src/research-prospector/commercialProfile');

const HOJE = '2026-10-07';
const ORIGEM = 'https://clinicaalfa.com.br/';

test('[PROFILE-1] telefones, WhatsApps e e-mails: vários, com origem; WhatsApp só por link explícito; lixo e duplicados fora', () => {
  const c = cp.extractContacts({
    origem: ORIGEM,
    texto: 'Ligue (24) 2222-3333 ou (24) 99999-8888. contato@clinicaalfa.com.br  foto@2x.png',
    links: [{ href: 'tel:+552422223333' }, { href: 'https://wa.me/5524988887777' }, { href: 'mailto:Contato@ClinicaAlfa.com.br?subject=x' }, { href: 'https://api.whatsapp.com/send?phone=5524977776666' }, { href: 'https://wa.me/123' }],
  });
  assert.deepEqual(c.telefones.map((t) => t.numero), ['+552422223333', '+5524999998888']);
  assert.deepEqual(c.whatsapps.map((t) => t.numero), ['+5524988887777', '+5524977776666']);
  assert.deepEqual(c.emails.map((e) => e.email), ['contato@clinicaalfa.com.br']);
  for (const item of [...c.telefones, ...c.whatsapps, ...c.emails]) assert.equal(item.origem, ORIGEM);
  assert.deepEqual(cp.extractContacts({ origem: 'não é url', texto: '(24) 2222-3333', links: [] }), { telefones: [], whatsapps: [], emails: [] });
});

test('[PROFILE-2] endereço só com rua + CEP no mesmo trecho; cidade/UF só se o trecho trouxer; nada é inventado', () => {
  const a = cp.extractAddress({ origem: ORIGEM, texto: 'Rua das Flores, 123 - Centro, Petrópolis - RJ, CEP 25600-000' });
  assert.deepEqual([a.rua, a.cidade, a.estado, a.cep, a.origem], ['Rua das Flores, 123', 'Petrópolis', 'RJ', '25600-000', ORIGEM]);
  assert.equal(cp.extractAddress({ origem: ORIGEM, texto: 'CEP 25600-000 sem rua' }), null);
  assert.equal(cp.extractAddress({ origem: ORIGEM, texto: 'Rua das Flores, 123 sem cep' }), null);
});

test('[PROFILE-3] responsável: só com cargo explícito e nome de pessoa; nunca deduzido', () => {
  assert.deepEqual(cp.extractResponsavel({ origem: ORIGEM, texto: 'Responsável técnica: Dra. Ana Souza Lima. CRM 123' }), { nome: 'Dra. Ana Souza Lima', cargo: 'Responsável técnica', origem: ORIGEM, confianca: 'ALTA' });
  assert.equal(cp.extractResponsavel({ origem: ORIGEM, texto: 'Clínica Alfa Estética - atendimento de segunda a sexta' }), null);
  assert.equal(cp.extractResponsavel({ origem: ORIGEM, texto: 'Fundador: Clínica Alfa Estética' }), null, 'nome de empresa não é pessoa');
  assert.equal(cp.extractResponsavel({ origem: ORIGEM, texto: 'contato: joao.silva@clinica.com' }), null);
});

test('[PROFILE-4] tráfego pago: evidência exige biblioteca pública; "nenhuma evidência" nunca vira "não anuncia"; o resto NAO_VERIFICADO', () => {
  const ads = cp.normalizeAds({
    meta: { resultado: 'EVIDENCIA_ENCONTRADA', url: 'https://www.facebook.com/ads/library/?id=1', data: '2026-10-01' },
    google: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://adstransparency.google.com/?q=alfa' },
    tiktok: { resultado: 'EVIDENCIA_ENCONTRADA', url: 'https://exemplo.com/anuncio' },
  }, HOJE);
  assert.equal(ads.meta.status, 'EVIDENCIA_ENCONTRADA');
  assert.equal(ads.meta.data, '2026-10-01');
  assert.equal(ads.google.status, 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA');
  assert.match(ads.google.observacao, /NÃO significa/);
  assert.equal(ads.tiktok.status, 'NAO_VERIFICADO', 'URL fora da biblioteca não vale');
  assert.equal(cp.normalizeAds(null, HOJE).meta.status, 'NAO_VERIFICADO');
  assert.equal(cp.normalizeAds({ meta: { resultado: 'EVIDENCIA_ENCONTRADA', url: 'https://facebook.com/clinica' } }, HOJE).meta.status, 'NAO_VERIFICADO', 'página de perfil não é a biblioteca');
});

test('[PROFILE-5] atividade recente: janelas derivadas da data real; sem data tudo NAO_VERIFICADO; data futura/inválida ignorada', () => {
  const a = cp.deriveActivity({ canal: 'instagram', url: 'https://www.instagram.com/p/abc/', data: '2026-09-20' }, HOJE);
  assert.deepEqual(a.janelas, { ultimos7Dias: 'NAO', ultimos30Dias: 'SIM', ultimos60Dias: 'SIM', ultimos90Dias: 'SIM' });
  assert.equal(a.ultimaPostagem.data, '2026-09-20');
  assert.equal(a.dataPesquisa, HOJE);
  for (const raw of [null, {}, { canal: 'instagram', url: 'https://www.instagram.com/p/abc/' }, { canal: 'instagram', url: 'https://www.instagram.com/p/abc/', data: '2027-01-01' }, { url: 'https://x.com/', data: 'ontem' }]) {
    const v = cp.deriveActivity(raw, HOJE);
    assert.equal(v.ultimaPostagem, null);
    assert.deepEqual(Object.values(v.janelas), ['NAO_VERIFICADO', 'NAO_VERIFICADO', 'NAO_VERIFICADO', 'NAO_VERIFICADO']);
  }
});

test('[PROFILE-6] enriquecimento do motor: o responsável só passa se a origem foi CONFIRMADA por quem chama', () => {
  const raw = { responsavel: { nome: 'Ana Souza', cargo: 'Proprietária', origem: 'https://www.instagram.com/clinicaalfa/' } };
  assert.equal(cp.normalizeEnrichment(raw, { today: HOJE }).responsavel, null);
  const ok = cp.normalizeEnrichment(raw, { today: HOJE, confirmedSources: new Set(['https://www.instagram.com/clinicaalfa/']) });
  assert.deepEqual([ok.responsavel.nome, ok.responsavel.confianca], ['Ana Souza', 'MEDIA']);
  assert.equal(cp.normalizeEnrichment(undefined, { today: HOJE }).ads.google.status, 'NAO_VERIFICADO');
});

test('[PROFILE-7] perfil completo e perfil mínimo (lead sem site): nada inventado, fontes separadas, "não encontrado" nunca vira "não possui"', () => {
  const pages = [{ origem: ORIGEM, oficial: true, texto: 'Rua das Flores, 123, Petrópolis - RJ 25600-000. Proprietário: Carlos Mendes. (24) 2222-3333', links: [{ href: 'https://wa.me/5524988887777' }] }];
  const cheio = cp.buildCommercialProfile({ empresa: 'Clínica Alfa', siteOficial: { status: 'ENCONTRADO', url: ORIGEM }, fontesDescoberta: [{ url: 'https://guiamais.com.br/x', tipo: 'DIRETORIO' }], fontesValidacao: [{ url: ORIGEM, tipo: 'OFICIAL' }], outrasPresencas: [], pages, today: HOJE });
  assert.equal(cheio.responsavel.nome, 'Carlos Mendes');
  assert.equal(cheio.endereco.cep, '25600-000');
  assert.equal(cheio.whatsapps[0].numero, '+5524988887777');
  assert.equal(cheio.siteOficial.status, 'ENCONTRADO');
  assert.deepEqual(cheio.fontesEnriquecimento.map((f) => f.url), [ORIGEM]);
  assert.equal(cheio.trafegoPago.meta.status, 'NAO_VERIFICADO');
  assert.equal(cheio.atividadeRecente.janelas.ultimos7Dias, 'NAO_VERIFICADO');

  const sem = cp.buildCommercialProfile({ empresa: 'Studio Beta', siteOficial: { status: 'NAO_ENCONTRADO', url: null }, pages: [], today: HOJE });
  assert.equal(sem.siteOficial.status, 'NAO_ENCONTRADO');
  assert.equal(sem.responsavel.status, 'NAO_ENCONTRADO');
  assert.deepEqual([sem.telefones, sem.whatsapps, sem.emails], [[], [], []]);
  assert.equal(sem.endereco.status, 'NAO_ENCONTRADO');
  assert.deepEqual(Object.keys(cp.SITE_STATUS).sort(), ['ENCONTRADO', 'NAO_ENCONTRADO'], 'só dois estados: não encontrado nunca significa não possui');
});

test('[PROFILE-8] tipoLead (Implementação 3.0): classificado pelo nome e, quando há, pelo título/H1 da página oficial já lida — nunca uma busca nova', () => {
  assert.equal(cp.buildCommercialProfile({ empresa: 'Clínica Alfa', pages: [], today: HOJE }).tipoLead, 'EMPRESA');
  assert.equal(cp.buildCommercialProfile({ empresa: 'Dra. Maria Silva', pages: [], today: HOJE }).tipoLead, 'PROFISSIONAL');

  const pages = [{ origem: ORIGEM, oficial: true, texto: 'Grupo Alfa é uma unidade da rede Grupo Alfa.', identidade: 'Grupo Alfa | Unidade Petrópolis' }];
  const comPagina = cp.buildCommercialProfile({ empresa: 'Grupo Alfa', siteOficial: { status: 'ENCONTRADO', url: ORIGEM }, pages, today: HOJE });
  assert.equal(comPagina.tipoLead, 'UNIDADE_FRANQUIA', 'o nome sozinho não bastaria; a página confirma a unidade/rede');
  assert.equal(cp.LEAD_TYPE.UNIDADE_FRANQUIA, 'UNIDADE_FRANQUIA');
});
