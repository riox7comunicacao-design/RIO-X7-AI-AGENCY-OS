// ResearchProvider — o CONTRATO de um provedor de pesquisa (Etapa "Prospecção 1"). Um provider recebe um brief
// validado (prospectingBrief.js) e devolve um PACOTE DE PESQUISA: instruções estruturadas o bastante para que uma
// pesquisa (humana, IA, ou uma API futura) saiba exatamente o que procurar, o que é permitido registrar e em que
// formato devolver o resultado.
//
//   { name, generateBriefPackage(brief) -> pacote }   (generateBriefPackage pode ser síncrona ou devolver uma Promise)
//
// NENHUM PROVIDER PAGO É IMPLEMENTADO AQUI, DE PROPÓSITO: nenhuma chave de API, nenhuma chamada de rede, nenhuma
// cobrança. Só existe `createManualBriefPackageProvider()` — não pesquisa nada: monta o PACOTE (texto + JSON) que
// um humano cola manualmente numa conversa com o Claude (ou outra ferramenta de pesquisa web), e cujo RESULTADO
// (uma lista de findings no formato já aceito por rawFindingV2.js) é ingerido de volta pelo sistema através do
// contrato de findings existente (src/services/prospectingBriefService.js#ingestFindings ->
// prospectingService.submitProspecting). A arquitetura fica pronta para, no futuro, registrar um SEGUNDO provider
// (Claude/Web, Brave, etc.) que gere esse mesmo pacote e devolva os findings automaticamente — decisão de produto
// e de custo que este módulo NÃO toma.
//
// O botão "Pesquisar" do Workbench nunca finge ter pesquisado a web: quando só o provider manual está disponível
// (sempre, nesta versão), a tela oferece o PACOTE para copiar e o formulário de ingestão do resultado — nunca uma
// lista de resultados fabricada.

const { GEO_LEVEL, summarizeGeografia } = require('./prospectingBrief');

// O formato de finding que o resultado da pesquisa PRECISA respeitar (documentado aqui; o schema real e definitivo
// é src/research-prospector/rawFindingSchema.js + rawFindingV2.js — este pacote só REPETE os nomes de campo para
// quem for pesquisar, nunca reimplementa a validação).
const FINDING_FIELDS = Object.freeze([
  'empresa', 'nicho', 'subnicho', 'cidade', 'estado', 'pais', 'site', 'telefone', 'whatsapp', 'email', 'instagram',
  'facebook', 'linkedin', 'youtube', 'google_profile', 'decisor_nome', 'decisor_cargo', 'decisor_contato_publico',
  'presenca_digital', 'anuncios', 'servicos', 'observacoes', 'fontes', 'data_pesquisa', 'confianca',
]);

const CONFIANCA_VALUES = Object.freeze(['VALIDADO', 'HIPOTESE', 'NAO_VERIFICADO']);

const REGRAS_DADOS = Object.freeze([
  'Nunca invente telefone, WhatsApp, e-mail, decisor, cargo, site, rede social, anúncios ou qualquer outro dado.',
  'Registre só o que foi encontrado em uma fonte PÚBLICA e verificável — preserve a fonte de cada informação relevante.',
  'Se não encontrou uma informação: registre confianca = NAO_VERIFICADO para aquele campo, nunca deixe de mencionar.',
  '"Não encontrei anúncios" NUNCA significa "a empresa não anuncia": registre anuncios = NAO_VERIFICADO, nunca "não possui".',
  'Se houver um indício que ainda precisa de confirmação: confianca = HIPOTESE.',
  'Se a evidência for clara e verificável: confianca = VALIDADO.',
  'Nunca invente uma URL (nem gere uma URL só a partir do nome da empresa).',
]);

// O pacote é um objeto simples — a tela mostra tanto o JSON quanto uma versão em texto corrido (mais fácil de
// colar numa conversa). Nada aqui chama rede: é só a MONTAGEM do pedido, a partir do brief já validado.
function buildBriefPackage(brief) {
  const geografia =
    brief.nivelGeografico === GEO_LEVEL.CIDADE
      ? { nivel: 'CIDADE', cidades: brief.cidades }
      : brief.nivelGeografico === GEO_LEVEL.ESTADO
        ? { nivel: 'ESTADO', estados: brief.estados }
        : { nivel: 'NACIONAL', pais: brief.pais };

  return {
    objetivo: brief.observacoes || `Encontrar empresas do nicho "${brief.nicho}" com potencial comercial para a Rio X7.`,
    nicho: brief.nicho,
    subnicho: brief.subnicho || null,
    localizacao: { ...geografia, resumo: summarizeGeografia(brief) },
    quantidadeDesejada: brief.quantidade,
    criterios: {
      apenasEmpresasReais: true,
      apenasFontesPublicas: true,
      excluirRegistrosJaContatados: 'a checagem de duplicidade e DNC é feita pelo sistema, depois da ingestão',
    },
    regrasDeDados: REGRAS_DADOS,
    regrasDeConfianca: {
      valores: CONFIANCA_VALUES,
      descricao: 'Cada campo relevante do finding (telefone, site, decisor, anúncios, presença digital...) precisa vir acompanhado de uma confiança — nunca um valor sem indicar a base.',
    },
    regrasDeExclusao: [
      'Não pesquisar, não incluir e não enviar para revisão nenhuma empresa que já esteja marcada como exclusão permanente do projeto (ex.: "Força Digital", em Petrópolis) — nem sob variação do nome.',
    ],
    formatoEsperado: {
      descricao: 'Uma LISTA de findings (um objeto por empresa encontrada), com exatamente estes campos (omita os que não têm valor — nunca invente):',
      nomesDosCampos: FINDING_FIELDS,
      exemploUmFinding: {
        empresa: 'Nome real da empresa encontrada',
        nicho: brief.nicho,
        subnicho: brief.subnicho || null,
        cidade: null,
        estado: null,
        pais: null,
        site: null,
        confianca: 'NAO_VERIFICADO',
        fontes: [{ tipo: 'site oficial', url: null, descricao: null }],
        data_pesquisa: null,
      },
    },
  };
}

function createManualBriefPackageProvider() {
  return Object.freeze({
    name: 'manual-claude-web',
    generateBriefPackage(brief) {
      return buildBriefPackage(brief);
    },
  });
}

module.exports = { FINDING_FIELDS, CONFIANCA_VALUES, createManualBriefPackageProvider };
