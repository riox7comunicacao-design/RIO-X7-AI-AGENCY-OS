const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runDiscoveryPipeline,
  identifyAndConfirm,
  screenExclusions,
  OPERATIONAL_STATE,
  SOURCE_TYPE,
  DNC_STATUS,
  computeIdentityStatus,
  computeDataStatus,
  IDENTITY_STATUS,
  IDENTITY_REASON,
  DATA_STATUS,
} = require('../../src/research-prospector/discovery');
const { INFO_STATUS, DUPLICATE_STATUS } = require('../../src/research-prospector/constants');

const briefingBase = {
  nicho: 'Psicologia',
  regiao: 'Petrópolis/RJ',
  quantidadeDesejada: 10,
  exclusoes: ['Agência Alfa Digital'],
};

function findingBase(overrides = {}) {
  return {
    empresa: 'Consultório Exemplo',
    tipo: 'profissional individual',
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Psicologia',
    campos: {},
    fontes: [],
    ...overrides,
  };
}

// A — candidato completo
// Nota (Passo 2.1): com identidade e dados separados, um candidato com
// âncoras de identidade confirmadas (sem conflito) E dados suficientes
// recebe o estado mais preciso VALIDADO_PARA_REVISAO, não mais o genérico
// AGUARDANDO_REVISAO — ver docs/decisions/0006-identity-vs-data-sufficiency.md.
test('[A] candidato completo: identidade confirmada + dados suficientes => VALIDADO_PARA_REVISAO, NOVO', () => {
  const finding = findingBase({
    empresa: 'Clínica Completa',
    campos: {
      site: [{ valor: 'clinicacompleta.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }],
      instagram: [{ valor: 'clinicacompleta', fonte: 'Instagram', tipoFonte: SOURCE_TYPE.OFICIAL }],
      telefone: [{ valor: '24999998888', fonte: 'Google Maps', tipoFonte: SOURCE_TYPE.OFICIAL }],
    },
  });
  const { resultados } = runDiscoveryPipeline({ briefing: briefingBase, rawFindings: [finding], crmRecords: [] });

  assert.equal(resultados[0].statusDuplicidade, DUPLICATE_STATUS.NOVO);
  assert.equal(resultados[0].statusIdentidade.status, 'VALIDADA');
  assert.equal(resultados[0].statusDados, 'SUFICIENTES');
  assert.equal(resultados[0].estadoOperacional, OPERATIONAL_STATE.VALIDADO_PARA_REVISAO);
});

// B — candidato com campos ausentes
test('[B] candidato com quase todos os campos ausentes => DADOS_INSUFICIENTES', () => {
  const finding = findingBase({ empresa: 'Perfil Incompleto', campos: {} });
  const { resultados } = runDiscoveryPipeline({ briefing: briefingBase, rawFindings: [finding], crmRecords: [] });

  assert.equal(resultados[0].estadoOperacional, OPERATIONAL_STATE.DADOS_INSUFICIENTES);
});

// C — fonte conflitante
test('[C] telefone com duas fontes divergentes => HIPOTESE + conflito, nenhum valor escolhido sozinho', () => {
  const finding = findingBase({
    campos: {
      telefone: [
        { valor: '24911112222', fonte: 'Google Maps', tipoFonte: SOURCE_TYPE.OFICIAL },
        { valor: '24933334444', fonte: 'Site institucional', tipoFonte: SOURCE_TYPE.OFICIAL },
      ],
    },
  });
  const identified = identifyAndConfirm(finding);

  assert.equal(identified.camposConfirmados.telefone.status, INFO_STATUS.HIPOTESE);
  assert.equal(identified.camposConfirmados.telefone.conflito, true);
  assert.equal(identified.camposConfirmados.telefone.valor, null);
  assert.equal(identified.camposConfirmados.telefone.evidencias.length, 2);
});

// D — domínio confirmado
test('[D] site com uma fonte oficial => VALIDADO', () => {
  const finding = findingBase({
    campos: { site: [{ valor: 'exemplo.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });
  const identified = identifyAndConfirm(finding);

  assert.equal(identified.camposConfirmados.site.status, INFO_STATUS.VALIDADO);
  assert.equal(identified.camposConfirmados.site.valor, 'exemplo.com.br');
});

// E — telefone confirmado
test('[E] telefone com fonte oficial única => VALIDADO', () => {
  const finding = findingBase({
    campos: { telefone: [{ valor: '24988887777', fonte: 'Google Maps', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });
  const identified = identifyAndConfirm(finding);

  assert.equal(identified.camposConfirmados.telefone.status, INFO_STATUS.VALIDADO);
});

// F — Instagram confirmado
test('[F] Instagram com fonte oficial única => VALIDADO', () => {
  const finding = findingBase({
    campos: { instagram: [{ valor: 'perfil.exemplo', fonte: 'Instagram', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });
  const identified = identifyAndConfirm(finding);

  assert.equal(identified.camposConfirmados.instagram.status, INFO_STATUS.VALIDADO);
});

// G — candidato duplicado
test('[G] site coincide com registro existente no CRM => DUPLICADO', () => {
  const finding = findingBase({
    empresa: 'Nome Diferente',
    campos: { site: [{ valor: 'https://existente.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });
  const crmRecords = [{ empresa: 'Já Cadastrado', site: 'https://existente.com.br', cidade: 'Petrópolis' }];
  const { resultados } = runDiscoveryPipeline({ briefing: briefingBase, rawFindings: [finding], crmRecords });

  assert.equal(resultados[0].statusDuplicidade, DUPLICATE_STATUS.DUPLICADO);
  assert.equal(resultados[0].estadoOperacional, OPERATIONAL_STATE.DUPLICADO);
});

// H — possível duplicado
test('[H] nome + cidade coincidem, sem identificador forte => POSSIVEL_DUPLICADO', () => {
  const finding = findingBase({ empresa: 'Consultório Ana', cidade: 'Petrópolis', campos: {} });
  const crmRecords = [{ empresa: 'Consultório Ana', cidade: 'Petrópolis' }];
  const { resultados } = runDiscoveryPipeline({ briefing: briefingBase, rawFindings: [finding], crmRecords });

  assert.equal(resultados[0].statusDuplicidade, DUPLICATE_STATUS.POSSIVEL_DUPLICADO);
  assert.equal(resultados[0].estadoOperacional, OPERATIONAL_STATE.POSSIVEL_DUPLICADO);
});

// I — candidato novo
test('[I] nenhum critério de identidade coincide com o CRM => NOVO', () => {
  const finding = findingBase({
    empresa: 'Totalmente Novo',
    campos: {
      site: [{ valor: 'totalmentenovo.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }],
      telefone: [{ valor: '24900001111', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }],
    },
  });
  const crmRecords = [{ empresa: 'Outro Qualquer', site: 'outro.com.br', cidade: 'Petrópolis' }];
  const { resultados } = runDiscoveryPipeline({ briefing: briefingBase, rawFindings: [finding], crmRecords });

  assert.equal(resultados[0].statusDuplicidade, DUPLICATE_STATUS.NOVO);
});

// J — DNC
test('[J] correspondência com registro DO NOT CONTACT => estado DNC, bloqueado', () => {
  const finding = findingBase({
    empresa: 'Bloqueado',
    campos: { telefone: [{ valor: '24955556666', fonte: 'Google Maps', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });
  const crmRecords = [{ empresa: 'Bloqueado Antigo', telefone: '24955556666', doNotContact: true }];
  const { resultados } = runDiscoveryPipeline({ briefing: briefingBase, rawFindings: [finding], crmRecords });

  assert.equal(resultados[0].statusDNC, DNC_STATUS.BLOQUEADO);
  assert.equal(resultados[0].estadoOperacional, OPERATIONAL_STATE.DNC);
});

// K — DNC não verificável
test('[K] CRM indisponível => DNC = NAO_VERIFICADO, nunca liberado por padrão', () => {
  const finding = findingBase({
    campos: { telefone: [{ valor: '24955556666', fonte: 'Google Maps', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });
  const { resultados } = runDiscoveryPipeline({
    briefing: briefingBase,
    rawFindings: [finding],
    crmRecords: [],
    crmDisponivel: false,
  });

  assert.equal(resultados[0].statusDNC, DNC_STATUS.NAO_VERIFICADO);
});

// L — Agência Alfa Digital excluída
test('[L] "Agência Alfa Digital" nunca entra no pipeline, mesmo com dados completos', () => {
  const findingBloqueado = findingBase({
    empresa: 'Agência Alfa Digital',
    campos: { site: [{ valor: 'agenciaalfa.exemplo.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });
  const findingNormal = findingBase({ empresa: 'Consultório Normal' });
  const { resultados, excluidos } = runDiscoveryPipeline({
    briefing: briefingBase,
    rawFindings: [findingBloqueado, findingNormal],
    crmRecords: [],
  });

  assert.equal(resultados.some((r) => r.empresa === 'Agência Alfa Digital'), false);
  assert.equal(excluidos.some((e) => e.empresa === 'Agência Alfa Digital'), true);
  assert.equal(resultados.length, 1);
});

test('screenExclusions: bloqueia por substring case-insensitive', () => {
  const { incluidos, excluidos } = screenExclusions(
    [{ empresa: 'AGÊNCIA ALFA DIGITAL MARKETING' }, { empresa: 'Outra Empresa' }],
    ['agência alfa digital']
  );
  assert.equal(incluidos.length, 1);
  assert.equal(excluidos.length, 1);
});

// M — dado não confirmado não pode virar VALIDADO
test('[M] campo sem nenhuma evidência nunca é VALIDADO', () => {
  const identified = identifyAndConfirm(findingBase({ campos: {} }));
  for (const campo of Object.keys(identified.camposConfirmados)) {
    assert.equal(identified.camposConfirmados[campo].status, INFO_STATUS.NAO_VERIFICADO);
    assert.equal(identified.camposConfirmados[campo].valor, null);
  }
});

// N — telefone não pode ser inferido
test('[N] telefone nunca é inferido a partir do site', () => {
  const finding = findingBase({
    campos: { site: [{ valor: 'exemplo.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });
  const identified = identifyAndConfirm(finding);

  assert.equal(identified.camposConfirmados.telefone.status, INFO_STATUS.NAO_VERIFICADO);
  assert.equal(identified.camposConfirmados.telefone.valor, null);
});

// O — e-mail não pode ser inferido
test('[O] e-mail nunca é inferido a partir do domínio do site', () => {
  const finding = findingBase({
    campos: { site: [{ valor: 'exemplo.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });
  const identified = identifyAndConfirm(finding);

  assert.equal(identified.camposConfirmados.email.status, INFO_STATUS.NAO_VERIFICADO);
  assert.equal(identified.camposConfirmados.email.valor, null);
});

// P — WhatsApp não pode ser inferido
test('[P] WhatsApp nunca é inferido a partir do telefone', () => {
  const finding = findingBase({
    campos: { telefone: [{ valor: '24988887777', fonte: 'Google Maps', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });
  const identified = identifyAndConfirm(finding);

  assert.equal(identified.camposConfirmados.whatsapp.status, INFO_STATUS.NAO_VERIFICADO);
  assert.equal(identified.camposConfirmados.whatsapp.valor, null);
});

// Q — CRM permanece sem escrita (nenhum efeito colateral nos registros lidos)
test('[Q] execução do pipeline nunca modifica os registros do CRM recebidos', () => {
  const crmRecords = [{ empresa: 'Registro Original', site: 'original.com.br', cidade: 'Petrópolis' }];
  const snapshot = JSON.parse(JSON.stringify(crmRecords));
  const finding = findingBase({
    campos: { site: [{ valor: 'outro.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });

  runDiscoveryPipeline({ briefing: briefingBase, rawFindings: [finding], crmRecords });

  assert.deepEqual(crmRecords, snapshot);
});

// R — nenhum contato é realizado (a próxima ação é sempre uma revisão humana, nunca um envio)
test('[R] próxima ação nunca é um envio/contato automático', () => {
  const finding = findingBase({});
  const { resultados } = runDiscoveryPipeline({ briefing: briefingBase, rawFindings: [finding], crmRecords: [] });

  assert.equal(resultados[0].proximaAcao, 'Revisar candidato e decidir se avança para aprovação humana');
  assert.doesNotMatch(resultados[0].proximaAcao.toLowerCase(), /enviar|contatar|whatsapp|e-mail|mensagem/);
});

test('briefing sem nicho é rejeitado, nunca presumido', () => {
  assert.throws(() => runDiscoveryPipeline({ briefing: {}, rawFindings: [], crmRecords: [] }), /nicho é obrigatório/);
});

// ============================================================
// Passo 2.1 — identidade confirmada não é sinônimo de contagem de campos
// (ver docs/decisions/0006-identity-vs-data-sufficiency.md)
// ============================================================

// [2.1-A] dois campos confirmados mas identidade explicitamente ambígua
test('[2.1-A] dois campos VALIDADO + identidade sinalizada como ambígua => NÃO validada', () => {
  const finding = identifyAndConfirm(
    findingBase({
      identidadeAmbigua: true,
      campos: {
        site: [{ valor: 'exemplo.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }],
        instagram: [{ valor: 'perfil.exemplo', fonte: 'Instagram', tipoFonte: SOURCE_TYPE.OFICIAL }],
      },
    })
  );
  const identidade = computeIdentityStatus(finding);

  assert.equal(identidade.status, IDENTITY_STATUS.NAO_VALIDADA);
  assert.equal(identidade.motivo, IDENTITY_REASON.AMBIGUA);
});

// [2.1-B] site oficial + cidade coerente confirma identidade mesmo com o resto NAO_VERIFICADO
test('[2.1-B] site oficial isolado confirma identidade, mesmo com todo o resto NAO_VERIFICADO', () => {
  const finding = identifyAndConfirm(
    findingBase({
      campos: { site: [{ valor: 'exemplo.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] },
    })
  );
  const identidade = computeIdentityStatus(finding);
  const dados = computeDataStatus(finding.camposConfirmados);

  assert.equal(identidade.status, IDENTITY_STATUS.VALIDADA);
  assert.equal(identidade.motivo, IDENTITY_REASON.CONFIRMADA);
  assert.notEqual(dados, DATA_STATUS.SUFICIENTES); // dados continuam parciais — dimensão independente
});

// [2.1-C] múltiplos NAO_VERIFICADO não invalidam uma identidade já bem confirmada
test('[2.1-C] identidade confirmada por 2 âncoras coerentes permanece válida apesar de vários campos ausentes', () => {
  const finding = identifyAndConfirm(
    findingBase({
      campos: {
        instagram: [{ valor: 'perfil.exemplo', fonte: 'Instagram', tipoFonte: SOURCE_TYPE.OFICIAL }],
        telefone: [{ valor: '24988887777', fonte: 'Google Maps', tipoFonte: SOURCE_TYPE.OFICIAL }],
      },
    })
  );
  const identidade = computeIdentityStatus(finding);

  assert.equal(identidade.status, IDENTITY_STATUS.VALIDADA);
  // facebook, linkedin, youtube, site, whatsapp, email, googlePerfil, endereco continuam NAO_VERIFICADO
  const naoVerificados = Object.values(finding.camposConfirmados).filter(
    (c) => c.status === INFO_STATUS.NAO_VERIFICADO
  ).length;
  assert.ok(naoVerificados >= 5);
});

// [2.1-D] conflito relevante entre fontes bloqueia a confirmação de identidade
test('[2.1-D] conflito em uma âncora impede identidade validada, mesmo com outra âncora confirmada', () => {
  const finding = identifyAndConfirm(
    findingBase({
      campos: {
        instagram: [{ valor: 'perfil.exemplo', fonte: 'Instagram', tipoFonte: SOURCE_TYPE.OFICIAL }],
        telefone: [
          { valor: '24911112222', fonte: 'Google Maps', tipoFonte: SOURCE_TYPE.OFICIAL },
          { valor: '24933334444', fonte: 'Site institucional', tipoFonte: SOURCE_TYPE.OFICIAL },
        ],
      },
    })
  );
  const identidade = computeIdentityStatus(finding);

  assert.equal(identidade.status, IDENTITY_STATUS.NAO_VALIDADA);
  assert.equal(identidade.motivo, IDENTITY_REASON.CONFLITO);
});

// [2.1-E] fonte fraca isolada não confirma identidade
test('[2.1-E] evidência única de fonte secundária não confirma identidade', () => {
  const finding = identifyAndConfirm(
    findingBase({
      campos: { googlePerfil: [{ valor: 'citado em busca, não confirmado', fonte: 'Resultado orgânico', tipoFonte: SOURCE_TYPE.SECUNDARIA }] },
    })
  );
  const identidade = computeIdentityStatus(finding);

  assert.equal(identidade.status, IDENTITY_STATUS.NAO_VALIDADA);
  assert.equal(identidade.motivo, IDENTITY_REASON.EVIDENCIA_FRACA);
});

// [2.1-F] nenhum score/ranking/temperatura é criado
test('[2.1-F] saída nunca contém score, ranking ou temperatura comercial', () => {
  const finding = findingBase({
    campos: { site: [{ valor: 'exemplo.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] },
  });
  const { resultados } = runDiscoveryPipeline({ briefing: briefingBase, rawFindings: [finding], crmRecords: [] });
  const chaves = Object.keys(resultados[0]).join(' ').toLowerCase();

  assert.doesNotMatch(chaves, /score|ranking|rank|temperatura|prioridade|nota\b/);
});

// [2.1-G] campos individuais continuam respeitando VALIDADO/HIPOTESE/NAO_VERIFICADO
test('[2.1-G] status por campo continua restrito a VALIDADO/HIPOTESE/NAO_VERIFICADO', () => {
  const finding = identifyAndConfirm(
    findingBase({
      campos: {
        site: [{ valor: 'exemplo.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }],
        telefone: [
          { valor: '24911112222', fonte: 'A', tipoFonte: SOURCE_TYPE.OFICIAL },
          { valor: '24933334444', fonte: 'B', tipoFonte: SOURCE_TYPE.OFICIAL },
        ],
      },
    })
  );
  const statusPermitidos = new Set([INFO_STATUS.VALIDADO, INFO_STATUS.HIPOTESE, INFO_STATUS.NAO_VERIFICADO]);
  for (const info of Object.values(finding.camposConfirmados)) {
    assert.ok(statusPermitidos.has(info.status));
  }
});
