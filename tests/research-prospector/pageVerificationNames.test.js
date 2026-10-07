// Nome-núcleo e site oficial em pageVerification.js (Implementação 2): comparação DETERMINÍSTICA entre o nome do candidato e o nome da página — sem IA, sem
// validar por uma palavra genérica que coincide — e o vínculo de uma página com a empresa como SITE OFICIAL (nunca só HTTP 200).

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyOnPage, verifyOfficialSite, coreName, GENERIC_TERMS } = require('../../src/research-prospector/pageVerification');

const CTX = { nicho: 'Clínicas de estética', cidade: 'Petrópolis', uf: 'RJ' };
const empresa = (texto, nome, extras = {}) => verifyOnPage(texto, { nome, ...CTX, ...extras }).empresa;
const SEM = { status: 'NAO_VERIFICADO', evidencia: null, regra: null };

test('[NUC-1] coreName: tira parênteses, o que vem depois de " - ", " – ", " — " e " | ", qualificador de unidade/filial, sufixo jurídico e título; separa os tokens DISTINTIVOS dos genéricos', () => {
  assert.deepEqual(coreName('Espaço Facial (Unidade Pátio Petrópolis)'), { tokens: ['espaco', 'facial'], distinctive: [] });
  assert.deepEqual(coreName('Instituto Granja Brasil de Saúde e Estética'), { tokens: ['instituto', 'granja', 'brasil', 'de', 'saude', 'e', 'estetica'], distinctive: ['granja', 'brasil'] });
  assert.deepEqual(coreName('Marilza Estética'), { tokens: ['marilza', 'estetica'], distinctive: ['marilza'] });
  assert.deepEqual(coreName('Clínica Alfa - Unidade Centro').distinctive, ['alfa']);
  assert.deepEqual(coreName('Clínica Alfa – Dermatologia e Estética').distinctive, ['alfa']);
  assert.deepEqual(coreName('Clínica Alfa — Matriz').distinctive, ['alfa']);
  assert.deepEqual(coreName('Clínica Alfa | Estética Avançada').distinctive, ['alfa']);
  assert.deepEqual(coreName('Clínica Alfa Unidade Centro').distinctive, ['alfa'], 'qualificador de unidade sem hífen');
  assert.deepEqual(coreName('Clínica Alfa Filial Teresópolis').distinctive, ['alfa']);
  assert.deepEqual(coreName('Alfa Estética Ltda').tokens, ['alfa', 'estetica'], 'sufixo jurídico');
  assert.deepEqual(coreName('Beta Odontologia ME').tokens, ['beta', 'odontologia']);
  assert.deepEqual(coreName('Dra. Ana Souza').distinctive, ['ana', 'souza'], 'título');
  assert.deepEqual(coreName('CLÍNICA  ÁLFA   (Centro)').tokens, ['clinica', 'alfa'], 'acentos, caixa e espaços normalizados');
  assert.deepEqual(coreName('Clínica Alfa (unidade sem fechar').tokens, ['clinica', 'alfa']);
  for (const nulo of [undefined, null, 5, '', '   ', '(só parênteses)', ' - ']) assert.equal(coreName(nulo), null, String(nulo));
  // os termos genéricos iniciais pedidos
  for (const termo of ['clinica', 'estetica', 'instituto', 'espaco', 'centro', 'saude', 'dermatologia', 'odonto', 'odontologia', 'studio', 'spa', 'avancada', 'facial', 'medicina']) assert.ok(GENERIC_TERMS.has(termo), termo);
});

test('[NUC-2] Granja Brasil: o nome do candidato é MAIOR que o da página; os tokens distintivos "granja brasil" aparecem na mesma ordem, como palavras inteiras -> nome_nucleo', () => {
  const nome = 'Instituto Granja Brasil de Saúde e Estética';
  assert.deepEqual(empresa('O Spa Granja Brasil inaugura o instituto.', nome), { status: 'VALIDADO', evidencia: 'Granja Brasil', regra: 'nome_nucleo' });
  assert.equal(empresa('GRANJA   BRASIL', nome).regra, 'nome_nucleo', 'caixa e espaços');
  assert.equal(empresa('Granja do Brasil: novidades', nome).regra, 'nome_nucleo', 'uma palavra de ligação entre os distintivos é tolerada');
  assert.equal(empresa('o nome completo: Instituto Granja Brasil de Saúde e Estética', nome).regra, 'nome', 'o nome inteiro continua valendo (a regra mais forte vem primeiro)');
  assert.deepEqual(empresa('Brasil Granja', nome), SEM, 'fora de ordem não vale');
  assert.deepEqual(empresa('Granja Paraíso e Brasil são cidades', nome), SEM, 'separados não valem');
  assert.deepEqual(empresa('Superbrasilgranja', nome), SEM, 'só palavras inteiras');
});

test('[NUC-3] Marilza, parênteses, unidade, hífen e acentos: o núcleo é o que se compara', () => {
  assert.deepEqual(empresa('Marilza Estética - Centro de estética avançada', 'Marilza Estética'), { status: 'VALIDADO', evidencia: 'Marilza Estética', regra: 'nome' });
  assert.equal(empresa('Bem-vindo ao studio da Marilza', 'Marilza Estética').regra, 'nome_nucleo', 'só o token distintivo (a página não repete "Estética")');
  assert.equal(empresa('CLINICA ALFA ESTETICA em Petropolis', 'Clínica Alfa Estética (Unidade Centro)').regra, 'nome_nucleo', 'sem os parênteses, com acentos diferentes');
  assert.equal(empresa('Clínica Alfa atende aqui', 'Clínica Alfa - Unidade Pátio Petrópolis').status, 'VALIDADO');
  assert.equal(empresa('Clínica Alfa atende aqui', 'Clínica Alfa – Unidade Pátio Petrópolis').status, 'VALIDADO');
  assert.equal(empresa('Clínica Alfa atende aqui', 'Clínica Alfa | Estética').status, 'VALIDADO');
  assert.equal(empresa('Alfa Estética atende', 'Alfa Estética Ltda').status, 'VALIDADO');
});

test('[NUC-4] NUNCA valida por palavra genérica isolada: só termos genéricos exigem domínio + título/H1; um único token distintivo curto demais não vale', () => {
  const texto = 'Somos uma clínica de estética e espaço de saúde facial em Petrópolis, o melhor centro de dermatologia, odontologia e medicina.';
  // "Espaço Facial": só genéricos -> nem a frase inteira vale sozinha; sem host/título não há corroboração
  assert.deepEqual(empresa('Visite o Espaço Facial hoje. Petrópolis.', 'Espaço Facial (Unidade Pátio Petrópolis)'), SEM);
  assert.deepEqual(empresa('Visite o Espaço Facial hoje.', 'Espaço Facial'), SEM, 'o nome inteiro, só de genéricos, também não vale sozinho');
  assert.deepEqual(empresa(texto, 'Clínica Estética'), SEM, 'palavras genéricas que coincidem não provam nada');
  assert.deepEqual(empresa(texto, 'Centro de Saúde'), SEM);
  // com corroboração (rótulo do domínio + título/H1) vale
  const ok = empresa('Visite o Espaço Facial hoje.', 'Espaço Facial (Unidade Pátio Petrópolis)', { host: 'espacofacial.com.br', identidade: 'Espaço Facial | Harmonização' });
  assert.deepEqual(ok, { status: 'VALIDADO', evidencia: 'Espaço Facial', regra: 'nome_nucleo' });
  // só o domínio ou só o título NÃO bastam
  assert.deepEqual(empresa('Visite o Espaço Facial hoje.', 'Espaço Facial', { host: 'espacofacial.com.br', identidade: 'Bem-vindo' }), SEM);
  assert.deepEqual(empresa('Visite o Espaço Facial hoje.', 'Espaço Facial', { host: 'franquia.com.br', identidade: 'Espaço Facial | Harmonização' }), SEM);
  assert.deepEqual(empresa('Visite o Espaço Facial hoje.', 'Espaço Facial', { host: 'portal.com.br', identidade: 'Espaço Facial' }), SEM);
  // token distintivo curtíssimo (< 5 letras juntas): só o nome inteiro, nunca o núcleo
  assert.deepEqual(empresa('A Ana é simpática', 'Ana Estética'), SEM);
  assert.equal(empresa('Clínica Ana Estética aqui', 'Ana Estética').regra, 'nome');
});

test('[NUC-5] verifyOfficialSite: o vínculo do domínio com a empresa — nome na página + (domínio com os tokens OU nome no título/H1) + conteúdo institucional; HTTP 200 sozinho não prova nada', () => {
  const pagina = 'Marilza Estética — estética avançada. Rua das Flores, 10 - Petrópolis - RJ';
  const v = (extras) => verifyOfficialSite(pagina, { nome: 'Marilza Estética', identidade: 'Marilza Estética | Início', ...CTX, ...extras });
  assert.deepEqual(v({ url: 'https://www.marilzaestetica.com.br/' }), { status: 'VALIDADO', regra: 'dominio_e_nome', vinculos: { dominio: true, titulo: true }, evidencia: 'Marilza Estética' });
  // o domínio não carrega o nome, mas o título/H1 sim
  assert.equal(v({ url: 'https://clinicaxyz.com.br/' }).regra, 'titulo_e_nome');
  // nem domínio nem título: a página cita a empresa, mas isso não a faz o site dela
  const sem = v({ url: 'https://clinicaxyz.com.br/', identidade: 'Notícias da cidade' });
  assert.deepEqual([sem.status, sem.motivo, sem.vinculos], ['NAO_VERIFICADO', 'VINCULO_NAO_CONFIRMADO', { dominio: false, titulo: false }]);
  // hosts de terceiros por lista fechada
  for (const host of ['https://www.instagram.com/marilzaestetica', 'https://www.facebook.com/marilzaestetica', 'https://www.guiamais.com.br/marilza-estetica', 'https://g1.globo.com/marilza-estetica', 'https://marilza-estetica.blogspot.com/']) {
    assert.deepEqual([v({ url: host }).status, v({ url: host }).motivo], ['NAO_VERIFICADO', 'HOST_DE_TERCEIRO'], host);
  }
  // nome ausente da página, conteúdo sem relação, URL e nome inválidos
  assert.equal(verifyOfficialSite('Notícias de Petrópolis.', { nome: 'Marilza Estética', url: 'https://www.marilzaestetica.com.br/', identidade: 'Marilza Estética', ...CTX }).motivo, 'NOME_NAO_ENCONTRADO');
  assert.equal(verifyOfficialSite('Marilza Beleza aqui.', { nome: 'Marilza Beleza', url: 'https://www.marilzabeleza.com.br/', identidade: 'Marilza Beleza', ...CTX }).motivo, 'SEM_CONTEUDO_INSTITUCIONAL', 'a página só cita o nome: sem nicho nem localização não é institucional');
  assert.equal(v({ url: 'http://www.marilzaestetica.com.br/' }).motivo, 'URL_INVALIDA');
  assert.equal(v({ url: undefined }).motivo, 'URL_INVALIDA');
  assert.equal(verifyOfficialSite(pagina, { nome: '', url: 'https://www.marilzaestetica.com.br/', ...CTX }).motivo, 'NOME_INVALIDO');
  for (const lixo of [undefined, null, 5, 'x']) assert.equal(verifyOfficialSite('texto', lixo).status, 'NAO_VERIFICADO');
});

test('[NUC-6] nome só de termos genéricos como site oficial exige os DOIS vínculos (domínio E título/H1); "Granja Brasil" na RAIZ de um portal de notícias não é site oficial', () => {
  const pagina = 'Espaço Facial: harmonização facial. Petrópolis - RJ';
  const f = (extras) => verifyOfficialSite(pagina, { nome: 'Espaço Facial (Unidade Pátio Petrópolis)', ...CTX, ...extras });
  assert.equal(f({ url: 'https://espacofacial.com.br/', identidade: 'Espaço Facial | Harmonização' }).status, 'VALIDADO');
  assert.equal(f({ url: 'https://espacofacial.com.br/', identidade: 'Bem-vindo' }).status, 'NAO_VERIFICADO', 'só o domínio');
  assert.equal(f({ url: 'https://franquiaxyz.com.br/', identidade: 'Espaço Facial | Harmonização' }).status, 'NAO_VERIFICADO', 'só o título');
  const portal = verifyOfficialSite('Notícias de Petrópolis: política e cultura.', { nome: 'Instituto Granja Brasil de Saúde e Estética Avançada', url: 'https://soupetropolis.com.br/', identidade: 'Sou Petrópolis | Notícias', ...CTX });
  assert.deepEqual([portal.status, portal.motivo], ['NAO_VERIFICADO', 'NOME_NAO_ENCONTRADO']);
});
