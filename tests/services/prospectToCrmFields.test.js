'use strict';

// O MAPEAMENTO de um prospect da Approval Queue para os campos do CRM (etapa CRM-INTEGRATION, decisão 0016).
//
// O que estes testes protegem: cada campo do CRM vem de UMA origem nomeada; o valor é preservado EXATAMENTE (caixa,
// acento, formato — o mapeamento nunca normaliza); nada é inventado (ausente/vazio/não-texto é omitido, nunca null nem
// um valor "adivinhado"); só chaves que o CRM aceita saem (CRM_WRITABLE_FIELDS, o contrato REAL do domínio); o que a
// fila tem e o CRM não tem campo próprio vai, rotulado, para `observacoes` — e a HIPÓTESE nunca vira
// `problemaIdentificado`; metadado de revisão da fila não é copiado; e nada herdado do protótipo participa.
//
// Funções puras, sem disco e sem rede. Nenhum dado real (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mapProspectToCrmFields, DIRECT_FIELDS, NOTE_LINES, MAX_NOTES_LENGTH } = require('../../src/services/prospectToCrmFields');
const { CRM_WRITABLE_FIELDS, CRM_MANAGED_FIELDS } = require('../../src/crm/constants');
const { analyzeSource } = require('../helpers/staticImports');

const SOURCE = path.join(__dirname, '..', '..', 'src', 'services', 'prospectToCrmFields.js');

const snapshotCompleto = () => ({
  empresa: 'Snapshot Ltda',
  tipo: 'CLINICA',
  cidade: 'Petrópolis',
  estadoUf: 'RJ',
  nicho: 'Clínica de Psicologia',
  site: 'https://www.exemplo-mapa.example.test/inicio',
  instagram: '@exemplo_mapa',
  facebook: 'https://facebook.example.test/exemplo-mapa',
  linkedin: 'https://linkedin.example.test/company/exemplo-mapa',
  youtube: 'https://youtube.example.test/@exemplo-mapa',
  telefone: '(24) 98765-1000',
  whatsapp: '+55 24 98765-2000',
  email: 'contato@exemplo-mapa.example.test',
  endereco: 'Rua de Teste, 10 — Petrópolis/RJ',
  statusIdentidade: { status: 'VALIDADA', motivo: 'CONFIRMADA' },
  statusDados: 'SUFICIENTES',
  statusDuplicidade: 'NOVO',
  matchedOn: [],
  statusDNC: 'NAO_ENCONTRADO',
  fontes: ['https://www.exemplo-mapa.example.test', 'Google Maps (consulta manual)'],
  dataDaPesquisa: '2026-09-20',
  observacoes: 'Atende adultos e adolescentes.',
  hipoteseDeOportunidade: 'HIPOTESE — Sem agendamento online no site',
  estadoOperacionalDiscovery: 'AGUARDANDO_REVISAO',
});
const prospect = (snapshot = snapshotCompleto(), extras = {}) => ({ prospectId: 'id:exemplo-mapa.example.test', empresa: 'Exemplo Mapa Clínica', estado: 'APROVADO_PARA_CRM', discoverySnapshot: snapshot, historico: [], ...extras });

test('[MAP-1] cada campo do CRM vem da sua origem, com o valor PRESERVADO exatamente: cidade, estado (estadoUf), nicho, telefone, WhatsApp, e-mail, site, Instagram e Facebook', () => {
  const fields = mapProspectToCrmFields(prospect());
  assert.equal(fields.empresa, 'Exemplo Mapa Clínica', 'a empresa é a do ITEM (a que a fila lista e o humano revisou)');
  assert.equal(fields.cidade, 'Petrópolis');
  assert.equal(fields.estado, 'RJ', 'estadoUf da fila vira `estado` do CRM');
  assert.equal(fields.nicho, 'Clínica de Psicologia');
  assert.equal(fields.telefone, '(24) 98765-1000');
  assert.equal(fields.whatsapp, '+55 24 98765-2000');
  assert.equal(fields.email, 'contato@exemplo-mapa.example.test');
  assert.equal(fields.site, 'https://www.exemplo-mapa.example.test/inicio', 'o site NÃO é normalizado (a normalização é só para comparar, no domínio)');
  assert.equal(fields.instagram, '@exemplo_mapa');
  assert.equal(fields.facebook, 'https://facebook.example.test/exemplo-mapa');
  assert.deepEqual(
    DIRECT_FIELDS.map(([crm, fila]) => `${crm}<-${fila}`),
    ['cidade<-cidade', 'estado<-estadoUf', 'nicho<-nicho', 'origem<-origem', 'site<-site', 'instagram<-instagram', 'facebook<-facebook', 'telefone<-telefone', 'whatsapp<-whatsapp', 'email<-email'],
    'a tabela de mapeamento direto é fechada'
  );
});

test('[MAP-2] o mapeamento NUNCA muda caixa nem acento: "rj", "clinica", "Petrópolis", "PETRÓPOLIS" e "  espaços  " (só as pontas) saem como entraram', () => {
  const casos = [
    { estadoUf: 'rj', nicho: 'clinica', cidade: 'petropolis' },
    { estadoUf: 'RJ', nicho: 'Clínica', cidade: 'Petrópolis' },
    { estadoUf: 'Rj', nicho: 'CLÍNICA', cidade: 'PETRÓPOLIS' },
  ];
  for (const caso of casos) {
    const fields = mapProspectToCrmFields(prospect({ ...snapshotCompleto(), ...caso }));
    assert.equal(fields.estado, caso.estadoUf);
    assert.equal(fields.nicho, caso.nicho);
    assert.equal(fields.cidade, caso.cidade);
  }
  const fields = mapProspectToCrmFields(prospect({ ...snapshotCompleto(), cidade: '  Nova Friburgo  ' }));
  assert.equal(fields.cidade, 'Nova Friburgo');
});

test('[MAP-3] nada é inventado: campo ausente, null, vazio, só espaços ou que não seja texto é OMITIDO (nunca null, nunca um valor adivinhado, nunca String(objeto))', () => {
  const vazio = mapProspectToCrmFields(prospect({}, { empresa: 'Só o Nome' }));
  assert.deepEqual(vazio, { empresa: 'Só o Nome' });

  const naoTexto = mapProspectToCrmFields(
    prospect(
      { ...snapshotCompleto(), cidade: null, estadoUf: '', nicho: '   ', telefone: 24987651000, whatsapp: { numero: '24' }, email: ['a@b.example.test'], site: true, instagram: undefined, facebook: 0 },
      { empresa: 'Sem Contatos' }
    )
  );
  for (const campo of ['cidade', 'estado', 'nicho', 'telefone', 'whatsapp', 'email', 'site', 'instagram', 'facebook']) {
    assert.equal(Object.prototype.hasOwnProperty.call(naoTexto, campo), false, `${campo} não deveria existir`);
  }
  assert.ok(Object.values(naoTexto).every((valor) => typeof valor === 'string'), 'todo valor de saída é texto');
  assert.ok(!JSON.stringify(naoTexto).includes('[object Object]') && !JSON.stringify(naoTexto).includes('undefined') && !JSON.stringify(naoTexto).includes('null'));
});

test('[MAP-4] só saem chaves que o CRM aceita (CRM_WRITABLE_FIELDS), e nunca as gerenciadas pelo domínio, o status, o histórico, nem campos que a fila não tem (contato, cargo, googlePerfil, temperatura, problemaIdentificado...)', () => {
  const fields = mapProspectToCrmFields(prospect());
  for (const chave of Object.keys(fields)) assert.ok(CRM_WRITABLE_FIELDS.includes(chave), `${chave} não é um campo gravável do CRM`);
  for (const gerenciado of [...CRM_MANAGED_FIELDS, 'status', 'historico', 'reviewedBy', 'actor', 'userId', 'authUserId', 'permissions']) {
    assert.equal(Object.prototype.hasOwnProperty.call(fields, gerenciado), false, gerenciado);
  }
  for (const semOrigem of ['contato', 'cargo', 'googlePerfil', 'temperatura', 'servicoPotencial', 'problemaIdentificado', 'raioXDeNicho', 'raioXPersonalizado', 'valorProposta', 'valorTotal', 'responsavel', 'dataDaAnalise', 'proximaAcao', 'origem']) {
    assert.equal(Object.prototype.hasOwnProperty.call(fields, semOrigem), false, `${semOrigem}: a fila não tem esse dado, então o CRM não o recebe`);
  }
});

test('[MAP-5] o que a fila tem e o CRM não tem campo próprio vai para `observacoes`, ROTULADO e em ordem; a HIPÓTESE continua marcada e NUNCA vira problemaIdentificado', () => {
  const fields = mapProspectToCrmFields(prospect());
  assert.equal(
    fields.observacoes,
    [
      'Observações da pesquisa: Atende adultos e adolescentes.',
      'Hipótese de oportunidade: HIPOTESE — Sem agendamento online no site',
      'Tipo: CLINICA',
      'LinkedIn: https://linkedin.example.test/company/exemplo-mapa',
      'YouTube: https://youtube.example.test/@exemplo-mapa',
      'Endereço: Rua de Teste, 10 — Petrópolis/RJ',
      'Pesquisado em: 2026-09-20',
      'Fontes consultadas: https://www.exemplo-mapa.example.test; Google Maps (consulta manual)',
    ].join('\n')
  );
  assert.equal(fields.problemaIdentificado, undefined, 'uma hipótese nunca é apresentada como problema identificado (Regra 2)');
  assert.deepEqual(
    NOTE_LINES.map(([rotulo]) => rotulo),
    ['Observações da pesquisa', 'Hipótese de oportunidade', 'Tipo', 'LinkedIn', 'YouTube', 'Endereço', 'Pesquisado em']
  );

  // sem nada disso, `observacoes` não existe
  assert.equal(Object.prototype.hasOwnProperty.call(mapProspectToCrmFields(prospect({ cidade: 'Petrópolis' })), 'observacoes'), false);
});

test('[MAP-6] as fontes consultadas: só textos, no máximo 10, cada uma até 300 caracteres; não-textos e vazios são descartados; e `observacoes` tem um teto de tamanho', () => {
  const muitas = Array.from({ length: 15 }, (_, i) => `https://fonte-${i}.example.test`);
  const fields = mapProspectToCrmFields(prospect({ fontes: [...muitas.slice(0, 2), '', '  ', 42, null, { url: 'x' }, ...muitas.slice(2)] }));
  const linha = fields.observacoes.split('\n').find((l) => l.startsWith('Fontes consultadas: '));
  assert.equal(linha.replace('Fontes consultadas: ', '').split('; ').length, 10);
  assert.ok(!linha.includes('fonte-10') && linha.includes('fonte-9'));

  const longa = mapProspectToCrmFields(prospect({ fontes: ['x'.repeat(1000)] }));
  assert.ok(longa.observacoes.split('\n')[0].length <= 'Fontes consultadas: '.length + 300);
  assert.ok(longa.observacoes.endsWith('…'));

  const enorme = mapProspectToCrmFields(prospect({ observacoes: 'texto '.repeat(2000), hipoteseDeOportunidade: 'HIPOTESE — ' + 'h'.repeat(3000) }));
  assert.equal(enorme.observacoes.length, MAX_NOTES_LENGTH);
  assert.ok(enorme.observacoes.endsWith('…'));

  assert.equal(Object.prototype.hasOwnProperty.call(mapProspectToCrmFields(prospect({ fontes: 'https://uma-string.example.test' })), 'observacoes'), false, 'fontes que não é uma lista é ignorada');
});

test('[MAP-7] a empresa: a do ITEM; senão a do snapshot; senão o campo não existe (quem chama trata como dados insuficientes — nada é fabricado)', () => {
  assert.equal(mapProspectToCrmFields(prospect(snapshotCompleto(), { empresa: '  Nome do Item  ' })).empresa, 'Nome do Item');
  assert.equal(mapProspectToCrmFields(prospect(snapshotCompleto(), { empresa: '   ' })).empresa, 'Snapshot Ltda');
  assert.equal(mapProspectToCrmFields(prospect(snapshotCompleto(), { empresa: null })).empresa, 'Snapshot Ltda');
  const sem = mapProspectToCrmFields(prospect({ ...snapshotCompleto(), empresa: '' }, { empresa: undefined }));
  assert.equal(Object.prototype.hasOwnProperty.call(sem, 'empresa'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(mapProspectToCrmFields({}), 'empresa'), false);
});

test('[MAP-8] o metadado de REVISÃO da fila não é copiado (identidade, dados, duplicidade, DNC, matchedOn, estado operacional): não é dado do lead, e a duplicidade/DNC são do domínio do CRM', () => {
  const fields = mapProspectToCrmFields(prospect());
  const texto = JSON.stringify(fields);
  for (const metadado of ['VALIDADA', 'CONFIRMADA', 'SUFICIENTES', 'NAO_ENCONTRADO', 'AGUARDANDO_REVISAO', 'APROVADO_PARA_CRM', 'id:exemplo-mapa.example.test']) {
    assert.ok(!texto.includes(metadado), `"${metadado}" não deve aparecer nos campos do CRM`);
  }
});

test('[MAP-9] nada herdado participa: Object.prototype poluído (cidade, empresa, observacoes...), objetos sem protótipo, chaves perigosas do JSON e entradas que não são objetos', () => {
  Object.prototype.cidade = 'HERDADA';
  Object.prototype.estadoUf = 'HERDADO';
  Object.prototype.empresa = 'Empresa Herdada';
  Object.prototype.observacoes = 'obs herdada';
  Object.prototype.discoverySnapshot = { cidade: 'HERDADA' };
  try {
    assert.deepEqual(mapProspectToCrmFields({}), {});
    assert.deepEqual(mapProspectToCrmFields({ discoverySnapshot: {} }), {});
    const fields = mapProspectToCrmFields({ empresa: 'Própria', discoverySnapshot: { nicho: 'Própria' } });
    assert.deepEqual(fields, { empresa: 'Própria', nicho: 'Própria' });
    // um item com protótipo herdado (Object.create) não empresta os campos do protótipo
    assert.deepEqual(mapProspectToCrmFields(Object.create({ empresa: 'Do Protótipo', discoverySnapshot: { cidade: 'X' } })), {});
  } finally {
    delete Object.prototype.cidade;
    delete Object.prototype.estadoUf;
    delete Object.prototype.empresa;
    delete Object.prototype.observacoes;
    delete Object.prototype.discoverySnapshot;
  }

  const semProtótipo = Object.create(null);
  semProtótipo.empresa = 'Sem Protótipo';
  semProtótipo.discoverySnapshot = Object.assign(Object.create(null), { cidade: 'Niterói' });
  assert.deepEqual(mapProspectToCrmFields(semProtótipo), { empresa: 'Sem Protótipo', cidade: 'Niterói' });

  const doJson = JSON.parse('{"empresa":"Do JSON","__proto__":{"cidade":"ENVENENADA"},"discoverySnapshot":{"__proto__":{"nicho":"ENVENENADO"},"authUserId":"auth-x","token":"t","site":"json.example.test"}}');
  assert.deepEqual(mapProspectToCrmFields(doJson), { empresa: 'Do JSON', site: 'json.example.test' });

  for (const naoObjeto of [null, undefined, 'texto', 42, [], () => ({})]) assert.deepEqual(mapProspectToCrmFields(naoObjeto), {}, String(naoObjeto));
  assert.deepEqual(mapProspectToCrmFields({ empresa: 'X', discoverySnapshot: 'texto' }), { empresa: 'X' });
  assert.deepEqual(mapProspectToCrmFields({ empresa: 'X', discoverySnapshot: [1, 2] }), { empresa: 'X' });
});

test('[MAP-10] é uma função PURA e determinística: não altera a entrada, devolve um objeto NOVO a cada chamada e o resultado não compartilha nada com a entrada', () => {
  const entrada = prospect();
  const antes = JSON.stringify(entrada);
  const a = mapProspectToCrmFields(entrada);
  const b = mapProspectToCrmFields(entrada);
  assert.equal(JSON.stringify(entrada), antes);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  a.cidade = 'alterada';
  assert.equal(entrada.discoverySnapshot.cidade, 'Petrópolis');
  assert.equal(mapProspectToCrmFields(entrada).cidade, 'Petrópolis');
  const congelada = Object.freeze({ ...entrada, discoverySnapshot: Object.freeze(snapshotCompleto()) });
  assert.doesNotThrow(() => mapProspectToCrmFields(congelada));
});

test('[MAP-11] o módulo não depende de nada: nenhuma importação, nenhum disco, nenhuma rede, nenhum processo', () => {
  const analise = analyzeSource(fs.readFileSync(SOURCE, 'utf8'), 'src/services/prospectToCrmFields.js');
  assert.deepEqual(analise.issues, []);
  assert.deepEqual(analise.refs, [], 'nenhuma importação');
  const identificadores = new Set(analise.tokens.filter((token) => token.type === 'id').map((token) => token.value));
  for (const proibido of ['fetch', 'require', 'process', 'eval', 'Function', 'readFileSync', 'writeFileSync']) {
    assert.equal(identificadores.has(proibido), false, `o mapeamento não pode usar ${proibido}`);
  }
});
