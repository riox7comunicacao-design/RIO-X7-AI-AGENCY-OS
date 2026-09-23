// SEED DE DESENVOLVIMENTO — monta uma fila de aprovação com prospects FICTÍCIOS, só para ver o Dashboard funcionar.
//
//   node scripts/seed-dev-queue.js [--out <arquivo>] [--force]
//
// É explicitamente DEV e nunca roda sozinho (o servidor não o chama). Regras:
//   - só dados fictícios: nomes inventados e endereços de e-mail/sites SOMENTE em example.test (um domínio
//     reservado que nunca resolve para ninguém). Nenhum nome, telefone, e-mail ou site real; nada da prospecção
//     real; nenhuma rede social (um "@perfil" inventado poderia coincidir com uma conta real);
//   - grava em data/approval-queue.dev.json (ignorado pelo Git), NUNCA na fila real (data/approval-queue.json):
//     um --out que aponte para a fila real é recusado, mesmo com --force;
//   - não sobrescreve uma fila de desenvolvimento que já tenha itens, a menos que --force.
//
// Para usar essa fila no servidor: RIO_X7_QUEUE_PATH=data/approval-queue.dev.json (no .env ou no ambiente).
//
// Os prospects entram pelo pipeline de descoberta e por addProspect — o caminho de SISTEMA do domínio (uma operação
// que o Approval Queue Service não expõe, de propósito). Por isso este script fala direto com o domínio: ele é uma
// ferramenta de desenvolvimento, não o Dashboard.

const fs = require('node:fs');
const path = require('node:path');

const approvalQueue = require('../src/research-prospector/approvalQueue');
const { runDiscoveryPipeline, SOURCE_TYPE } = require('../src/research-prospector/discovery');

const DEFAULT_OUT = path.join(__dirname, '..', 'data', 'approval-queue.dev.json');
const RESEARCH_DATE = '2026-01-15';
const CITY = 'Vila Exemplo';
const UF = 'RJ';
const NICHE = 'Clínicas de exemplo';

const official = (valor, fonte = 'Site oficial (fictício)') => ({ valor, fonte, tipoFonte: SOURCE_TYPE.OFICIAL });
const secondary = (valor, fonte) => ({ valor, fonte, tipoFonte: SOURCE_TYPE.SECUNDARIA });
const source = (fonte, url, campo, observacao) => ({ fonte, url, dataConsulta: `${RESEARCH_DATE}T12:00:00Z`, campo, ...(observacao ? { observacao } : {}) });

function finding({ empresa, campos, fontes = [], observacoesBrutas, hipoteseDeOportunidade }) {
  return { empresa, tipo: 'Clínica', cidade: CITY, estado: UF, nicho: NICHE, campos, fontes, observacoesBrutas, hipoteseDeOportunidade };
}

// Sete prospects fictícios, um de cada situação que a tela precisa mostrar.
const RAW_FINDINGS = [
  finding({
    empresa: 'Clínica Aurora Exemplo',
    campos: {
      site: [official('aurora.example.test')],
      email: [official('contato@aurora.example.test')],
      endereco: [official('Rua Exemplo, 100 — Vila Exemplo/RJ')],
    },
    fontes: [source('Site oficial (fictício)', 'https://aurora.example.test/contato', 'email'), source('Diretório fictício', 'https://diretorio.example.test/aurora', 'endereco')],
    observacoesBrutas: 'Site simples, sem blog. Dado fictício de desenvolvimento.',
    hipoteseDeOportunidade: 'Site sem página de agendamento online.',
  }),
  finding({
    empresa: 'Consultório Horizonte Exemplo',
    campos: { site: [official('horizonte.example.test')] },
    fontes: [source('Site oficial (fictício)', 'https://horizonte.example.test/', 'site')],
    observacoesBrutas: 'Só o site foi encontrado. Dado fictício de desenvolvimento.',
  }),
  finding({
    empresa: 'Espaço Bem-Estar Exemplo',
    campos: {
      site: [secondary('bemestar.example.test', 'Diretório fictício A'), secondary('bemestar.example.test', 'Diretório fictício B')],
      email: [secondary('recepcao@bemestar.example.test', 'Diretório fictício A')],
    },
    fontes: [source('Diretório fictício A', 'https://diretorio-a.example.test/bemestar', 'site'), source('Diretório fictício B', 'https://diretorio-b.example.test/bemestar', 'site', 'Confirma o site do diretório A.')],
    hipoteseDeOportunidade: 'Presença digital só em diretórios.',
  }),
  // Mesmo nome e cidade de um registro do CRM fictício, mas site diferente: POSSÍVEL duplicado (segue para revisão).
  finding({
    empresa: 'Clínica Delta Exemplo',
    campos: { site: [official('delta-novo.example.test')], email: [official('oi@delta-novo.example.test')] },
    fontes: [source('Site oficial (fictício)', 'https://delta-novo.example.test/', 'site')],
    observacoesBrutas: 'Nome igual ao de um registro já existente no CRM fictício, com outro site.',
  }),
  // Site igual ao de um registro do CRM fictício: DUPLICADO (o sistema já o classificou).
  finding({ empresa: 'Clínica Épsilon Exemplo', campos: { site: [official('epsilon.example.test')] }, fontes: [source('Site oficial (fictício)', 'https://epsilon.example.test/', 'site')] }),
  // Site de um registro do CRM fictício marcado como DO NOT CONTACT: DNC.
  finding({ empresa: 'Clínica Zeta Exemplo', campos: { site: [official('zeta.example.test')] }, fontes: [source('Site oficial (fictício)', 'https://zeta.example.test/', 'site')] }),
  // Uma única fonte secundária: identidade não validada, dados insuficientes.
  finding({ empresa: 'Consultório Eta Exemplo', campos: { site: [secondary('eta.example.test', 'Diretório fictício C')] }, fontes: [source('Diretório fictício C', 'https://diretorio-c.example.test/eta', 'site')] }),
];

const CRM_RECORDS = [
  { empresa: 'Clínica Delta Exemplo', cidade: CITY, site: 'https://delta-antigo.example.test' },
  { empresa: 'Clínica Épsilon (cadastro antigo)', site: 'https://epsilon.example.test' },
  { empresa: 'Clínica Zeta (não contatar)', site: 'https://zeta.example.test', doNotContact: true },
];

// A fila fictícia, em memória (não grava nada).
function buildSeedQueue() {
  const { resultados } = runDiscoveryPipeline({
    briefing: { nicho: NICHE, regiao: `${CITY}/${UF}`, quantidadeDesejada: 10, exclusoes: [] },
    rawFindings: RAW_FINDINGS,
    crmRecords: CRM_RECORDS,
    dataDaPesquisa: RESEARCH_DATE,
  });
  const queue = approvalQueue.createEmptyQueue();
  for (const resultado of resultados) approvalQueue.addProspect(queue, resultado);
  return queue;
}

function countByState(queue) {
  const counts = {};
  for (const item of Object.values(queue.items)) counts[item.estado] = (counts[item.estado] || 0) + 1;
  return counts;
}

function parseArguments(argv) {
  const options = { out: DEFAULT_OUT, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--force') options.force = true;
    else if (argv[index] === '--out' && argv[index + 1]) options.out = path.resolve(process.cwd(), argv[(index += 1)]);
    else throw new Error(`argumento desconhecido: ${argv[index]} (uso: node scripts/seed-dev-queue.js [--out <arquivo>] [--force])`);
  }
  return options;
}

// Devolve o código de saída (0 = gravou).
function main(argv, log = console) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    log.error(error.message);
    return 2;
  }

  if (path.resolve(options.out) === path.resolve(approvalQueue.DEFAULT_QUEUE_PATH)) {
    log.error(`Recusado: ${options.out} é a fila REAL. Este seed só grava uma fila de desenvolvimento (padrão: data/approval-queue.dev.json).`);
    return 1;
  }
  if (fs.existsSync(options.out) && !options.force) {
    let existing = 0;
    try {
      existing = Object.keys(approvalQueue.loadQueueFromDisk(options.out).items).length;
    } catch {
      existing = 1; // um arquivo ilegível também não é sobrescrito sem --force
    }
    if (existing > 0) {
      log.error(`Recusado: ${options.out} já existe e tem itens. Use --force para recriá-la com os dados fictícios.`);
      return 1;
    }
  }

  const queue = buildSeedQueue();
  approvalQueue.saveQueueToDisk(queue, options.out);
  const counts = countByState(queue);
  log.log(`Fila de DESENVOLVIMENTO gravada em ${options.out}`);
  log.log(`${Object.keys(queue.items).length} prospects fictícios (${Object.entries(counts).map(([estado, total]) => `${estado}: ${total}`).join(', ')}).`);
  log.log('Para usar no servidor: RIO_X7_QUEUE_PATH=data/approval-queue.dev.json (no .env ou no ambiente).');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { buildSeedQueue, main, DEFAULT_OUT, RAW_FINDINGS, CRM_RECORDS };
