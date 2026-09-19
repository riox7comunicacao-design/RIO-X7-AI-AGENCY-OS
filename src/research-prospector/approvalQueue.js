// Fila persistente de aprovação humana (Passo 3).
//
// DESCOBERTA ≠ APROVAÇÃO ≠ CRM ≠ CONTATO
//
// Este módulo consome a saída já produzida por discovery.js — nunca refaz
// pesquisa, normalização, deduplicação ou verificação de DO NOT CONTACT.
// Reaproveita identityKeys() de normalize.js só para construir um ID estável
// por entidade; não existe aqui nenhum algoritmo paralelo de deduplicação.
//
// Nenhuma função deste módulo escreve no CRM, envia mensagem ou realiza
// contato — estruturalmente, nem existe código de rede/escrita externa aqui.
//
// Passo 0009.2: o antigo parâmetro `reviewer` (texto livre) foi substituído
// por um contexto de identidade estruturado `{ userId, name, role,
// permissions }`, seguindo o modelo USER de
// docs/decisions/0009-identity-roles-and-authorization-model.md. Isto NÃO é
// autenticação real — não há sessão, login, senha, token ou banco de
// usuários aqui; é só a validação da FORMA exigida e da presença da
// permissão necessária no contexto que o chamador apresenta. Resolver essa
// identidade a partir de um usuário de fato autenticado continua sendo
// decisão futura, fora do escopo deste módulo.

const fs = require('fs');
const path = require('path');
const { identityKeys } = require('./normalize');

const QUEUE_STATE = Object.freeze({
  AGUARDANDO_REVISAO: 'AGUARDANDO_REVISAO',
  APROVADO_PARA_CRM: 'APROVADO_PARA_CRM',
  REJEITADO: 'REJEITADO',
  DUPLICADO: 'DUPLICADO',
  DNC: 'DNC',
  DADOS_INSUFICIENTES: 'DADOS_INSUFICIENTES',
  EXPIRADO: 'EXPIRADO',
});

const ACTOR = Object.freeze({ HUMAN: 'HUMAN', SYSTEM: 'SYSTEM' });

// Permissões reconhecidas por este módulo, no formato conceitual
// {AÇÃO}:{DOMÍNIO} definido em 0009. Este módulo só conhece (e só precisa
// conhecer) a permissão do seu próprio domínio — Lead Approval. Nenhuma
// outra permissão é criada aqui.
const PERMISSION = Object.freeze({
  APPROVE_LEAD_APPROVAL: 'APPROVE:LEAD_APPROVAL',
});

// Único mapa de transições permitidas. Qualquer estado sem entrada aqui é
// terminal — nenhuma função deste módulo consegue transicionar a partir dele.
// Isso implementa, com um único mecanismo, tanto "não permitir transições
// arbitrárias" quanto "nunca sobrescrever automaticamente uma decisão humana
// ou um bloqueio de DNC/duplicidade": APROVADO_PARA_CRM, REJEITADO, DNC,
// DUPLICADO e DADOS_INSUFICIENTES simplesmente não têm saída definida.
//
// EXPIRADO existe no modelo (enum acima) mas não aparece como destino de
// nenhuma transição — nenhuma automação de expiração foi implementada neste
// passo (ver docs/decisions/0007-human-approval-queue.md).
const ALLOWED_TRANSITIONS = Object.freeze({
  [QUEUE_STATE.AGUARDANDO_REVISAO]: [
    QUEUE_STATE.APROVADO_PARA_CRM,
    QUEUE_STATE.REJEITADO,
    QUEUE_STATE.DADOS_INSUFICIENTES,
    QUEUE_STATE.DNC,
    QUEUE_STATE.DUPLICADO,
  ],
});

const DEFAULT_QUEUE_PATH = path.join(__dirname, '..', '..', 'data', 'approval-queue.json');

function createEmptyQueue() {
  return { items: {} };
}

// Passo 0009.2: só a ausência do arquivo (ENOENT) é tratada como fila vazia.
// Qualquer outro problema — JSON inválido, estrutura inesperada, ou erro de
// leitura de outra natureza (ex.: permissão) — lança um erro explícito.
// Nunca mascara corrupção como se fosse "fila vazia": um arquivo existente e
// inválido pode significar dado real perdido/truncado, e isso precisa ser
// visível a quem chama, não silenciado.
function loadQueueFromDisk(filePath = DEFAULT_QUEUE_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return createEmptyQueue();
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`arquivo de fila corrompido (JSON inválido) em ${filePath}: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.items || typeof parsed.items !== 'object') {
    throw new Error(`arquivo de fila corrompido (estrutura inválida, esperava { items: {...} }) em ${filePath}`);
  }
  return parsed;
}

// Passo 0009.2: escrita atômica (arquivo temporário no mesmo diretório +
// fsync + rename) para que uma interrupção do processo durante a escrita
// nunca deixe o arquivo final truncado ou parcialmente gravado — o arquivo
// final só existe, a qualquer momento, em sua versão anterior completa ou na
// nova versão completa, nunca em um estado intermediário.
function saveQueueToDisk(queue, filePath = DEFAULT_QUEUE_PATH) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const data = JSON.stringify(queue, null, 2);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);

  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // arquivo temporário pode nunca ter sido criado — nada a limpar.
    }
    throw err;
  }
}

function requireItem(queue, id) {
  const item = queue.items[id];
  if (!item) throw new Error(`prospect não encontrado na fila: ${id}`);
  return item;
}

function assertTransitionAllowed(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`transição não permitida: ${from} -> ${to}`);
  }
}

function transitionState(item, to, actor, motivo, timestamp, extra = {}) {
  assertTransitionAllowed(item.estado, to);
  if (to === QUEUE_STATE.APROVADO_PARA_CRM && actor !== ACTOR.HUMAN) {
    // Reforço estrutural: mesmo uma chamada interna incorreta nunca aprova
    // como SYSTEM — aprovação é sempre e só um ato humano.
    throw new Error('SYSTEM não pode aprovar um prospect — aprovação exige actor HUMAN');
  }
  const from = item.estado;
  item.estado = to;
  item.historico.push({ timestamp, from, to, actor, motivo: motivo || null, ...extra });
  return item;
}

// Camada mínima de autorização (Passo 0009.2). Recebe o contexto de
// identidade apresentado pelo chamador e valida só duas coisas: (1) a FORMA
// exigida pelo modelo conceitual USER de 0009 — userId, name e role não
// vazios, permissions uma lista; (2) que a permissão necessária para a ação
// (escopada por domínio, formato {AÇÃO}:{DOMÍNIO}) está presente nessa
// lista. Isso não é autenticação: nada aqui prova que o userId informado
// corresponde a um usuário real, ativo, autenticado — não existe base de
// usuários, sessão, login ou token neste módulo, e não é este módulo que
// deveria criar isso. Uma string simples (o antigo `reviewer`) nunca passa
// nesta checagem, porque não é um objeto com esses campos.
function assertValidIdentity(identity, requiredPermission) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error(
      'identidade inválida: esta ação exige um contexto estruturado { userId, name, role, permissions } — texto livre não é mais aceito'
    );
  }
  if (!identity.userId || typeof identity.userId !== 'string' || !identity.userId.trim()) {
    throw new Error('identidade inválida: userId é obrigatório');
  }
  if (!identity.name || typeof identity.name !== 'string' || !identity.name.trim()) {
    throw new Error('identidade inválida: name é obrigatório');
  }
  if (!identity.role || typeof identity.role !== 'string' || !identity.role.trim()) {
    throw new Error('identidade inválida: role é obrigatório');
  }
  if (!Array.isArray(identity.permissions)) {
    throw new Error('identidade inválida: permissions deve ser uma lista de permissões concedidas');
  }
  if (!identity.permissions.includes(requiredPermission)) {
    throw new Error(`identidade sem permissão necessária: ${requiredPermission}`);
  }
  return {
    userId: String(identity.userId).trim(),
    name: String(identity.name).trim(),
    role: String(identity.role).trim(),
  };
}

// ID estável por entidade, reaproveitando identityKeys() já existente em
// normalize.js — mesma ordem de prioridade oficial (domínio → telefone →
// Instagram → nome+cidade). Isso garante que o mesmo prospect, redescoberto
// em outra execução, caia sempre na mesma chave, sem depender só do nome.
function buildStableId(discoveryResult) {
  const keys = identityKeys({
    site: discoveryResult.site,
    telefone: discoveryResult.telefone,
    whatsapp: discoveryResult.whatsapp,
    instagram: discoveryResult.instagram,
    empresa: discoveryResult.empresa,
    cidade: discoveryResult.cidade,
  });
  const strongKey = keys.domain || keys.phone || keys.instagram;
  if (strongKey) return `id:${strongKey}`;
  if (keys.nameCity) return `id:${keys.nameCity}`;
  return `id:${String(discoveryResult.empresa || 'desconhecido').trim().toLowerCase()}`;
}

// Deriva o estado de sistema esperado a partir do resultado já produzido por
// discovery.js — nunca recalcula duplicidade/DNC/identidade, só lê o veredito
// já existente. POSSIVEL_DUPLICADO nunca vira DUPLICADO aqui.
//
// Ordem de prioridade idêntica à já usada em discovery.js (buildOutputRecord):
// DNC vem antes de duplicidade, por ser o bloqueio mais severo — um prospect
// pode simultaneamente coincidir com um registro DUPLICADO e ser DO NOT
// CONTACT; nesse caso, DNC sempre prevalece.
function deriveSystemState(discoveryResult) {
  if (discoveryResult.statusDNC === 'BLOQUEADO') return QUEUE_STATE.DNC;
  if (discoveryResult.statusDuplicidade === 'DUPLICADO') return QUEUE_STATE.DUPLICADO;
  if (discoveryResult.estadoOperacional === 'DADOS_INSUFICIENTES') return QUEUE_STATE.DADOS_INSUFICIENTES;
  return QUEUE_STATE.AGUARDANDO_REVISAO;
}

function motivoParaEstadoSistema(estado, discoveryResult) {
  if (estado === QUEUE_STATE.DUPLICADO) {
    const criterios = (discoveryResult.matchedOn || []).join(', ') || 'critério não informado';
    return `Duplicidade confirmada pela deduplicação (${criterios})`;
  }
  if (estado === QUEUE_STATE.DNC) return 'DO NOT CONTACT confirmado pela verificação de CRM';
  if (estado === QUEUE_STATE.DADOS_INSUFICIENTES) return 'Identidade não confirmada ou dados insuficientes (discovery.js)';
  return 'Novo prospect descoberto';
}

// Só os campos relevantes para revisão/CRM futuro são guardados — nunca
// senha, token, credencial ou dado pessoal desnecessário (Regra 8 do
// RULES.md). Os campos aqui são exatamente dados públicos/comerciais já
// produzidos por discovery.js.
function sanitizeSnapshot(discoveryResult) {
  return {
    empresa: discoveryResult.empresa,
    tipo: discoveryResult.tipo,
    cidade: discoveryResult.cidade,
    estadoUf: discoveryResult.estadoUf,
    nicho: discoveryResult.nicho,
    site: discoveryResult.site,
    instagram: discoveryResult.instagram,
    facebook: discoveryResult.facebook,
    linkedin: discoveryResult.linkedin,
    youtube: discoveryResult.youtube,
    telefone: discoveryResult.telefone,
    whatsapp: discoveryResult.whatsapp,
    email: discoveryResult.email,
    endereco: discoveryResult.endereco,
    statusIdentidade: discoveryResult.statusIdentidade,
    statusDados: discoveryResult.statusDados,
    statusDuplicidade: discoveryResult.statusDuplicidade,
    matchedOn: discoveryResult.matchedOn,
    statusDNC: discoveryResult.statusDNC,
    fontes: discoveryResult.fontes,
    dataDaPesquisa: discoveryResult.dataDaPesquisa,
    observacoes: discoveryResult.observacoes,
    hipoteseDeOportunidade: discoveryResult.hipoteseDeOportunidade,
    estadoOperacionalDiscovery: discoveryResult.estadoOperacional,
  };
}

// Adiciona um prospect novo, ou trata reentrada de um já conhecido.
// Nunca escreve no CRM. Nunca envia mensagem. Nunca aprova sozinho.
function addProspect(queue, discoveryResult) {
  if (!discoveryResult || !discoveryResult.empresa) {
    throw new Error('discoveryResult inválido: empresa é obrigatória');
  }

  const id = buildStableId(discoveryResult);
  const now = new Date().toISOString();
  const existing = queue.items[id];

  if (existing) {
    existing.lastSeenAt = now;
    existing.discoverySnapshot = sanitizeSnapshot(discoveryResult);

    const podeReclassificar = Boolean(ALLOWED_TRANSITIONS[existing.estado]);
    if (!podeReclassificar) {
      // Estado terminal (aprovado/rejeitado/DNC/duplicado/dados insuficientes)
      // — decisão preservada, apenas registra que foi redescoberto.
      existing.historico.push({
        timestamp: now,
        from: existing.estado,
        to: existing.estado,
        actor: ACTOR.SYSTEM,
        motivo: 'Redescoberto — estado já decidido/travado, nenhuma alteração automática',
      });
      return existing;
    }

    const novoEstado = deriveSystemState(discoveryResult);
    if (novoEstado === existing.estado) {
      existing.historico.push({
        timestamp: now,
        from: existing.estado,
        to: existing.estado,
        actor: ACTOR.SYSTEM,
        motivo: 'Redescoberto — mesma classificação de sistema',
      });
    } else {
      transitionState(existing, novoEstado, ACTOR.SYSTEM, motivoParaEstadoSistema(novoEstado, discoveryResult), now);
    }
    return existing;
  }

  const item = {
    prospectId: id,
    empresa: discoveryResult.empresa,
    estado: QUEUE_STATE.AGUARDANDO_REVISAO,
    criadoEm: now,
    lastSeenAt: now,
    discoverySnapshot: sanitizeSnapshot(discoveryResult),
    historico: [
      { timestamp: now, from: null, to: QUEUE_STATE.AGUARDANDO_REVISAO, actor: ACTOR.SYSTEM, motivo: 'Novo prospect descoberto' },
    ],
  };
  queue.items[id] = item;

  const estadoSistema = deriveSystemState(discoveryResult);
  if (estadoSistema !== QUEUE_STATE.AGUARDANDO_REVISAO) {
    transitionState(item, estadoSistema, ACTOR.SYSTEM, motivoParaEstadoSistema(estadoSistema, discoveryResult), now);
  }
  return item;
}

// Aprovação: sempre um ato humano explícito. Nunca cria/edita nada no CRM —
// só marca que este prospect PODE, futuramente, ser encaminhado para lá.
// `identity` substitui o antigo `reviewer` de texto livre (Passo 0009.2).
function approveProspect(queue, id, identity, reason) {
  const reviewedBy = assertValidIdentity(identity, PERMISSION.APPROVE_LEAD_APPROVAL);
  const item = requireItem(queue, id);
  const now = new Date().toISOString();
  transitionState(item, QUEUE_STATE.APROVADO_PARA_CRM, ACTOR.HUMAN, reason || null, now, { reviewedBy });
  return item;
}

// Rejeição: também sempre um ato humano explícito, sempre com motivo.
// `identity` substitui o antigo `reviewer` de texto livre (Passo 0009.2).
function rejectProspect(queue, id, identity, reason) {
  const reviewedBy = assertValidIdentity(identity, PERMISSION.APPROVE_LEAD_APPROVAL);
  if (!reason || !String(reason).trim()) {
    throw new Error('rejeição exige um motivo');
  }
  const item = requireItem(queue, id);
  const now = new Date().toISOString();
  transitionState(item, QUEUE_STATE.REJEITADO, ACTOR.HUMAN, reason, now, { reviewedBy });
  return item;
}

// Transições de sistema explícitas (uso típico: um recheck posterior de
// deduplicação/DNC sobre um item que já está na fila).
function markDuplicado(queue, id, matchedOn = []) {
  const item = requireItem(queue, id);
  const now = new Date().toISOString();
  const criterios = matchedOn.join(', ') || 'critério não informado';
  transitionState(item, QUEUE_STATE.DUPLICADO, ACTOR.SYSTEM, `Duplicidade confirmada (${criterios})`, now, { matchedOn });
  return item;
}

function markDnc(queue, id) {
  const item = requireItem(queue, id);
  const now = new Date().toISOString();
  transitionState(item, QUEUE_STATE.DNC, ACTOR.SYSTEM, 'DO NOT CONTACT confirmado', now);
  return item;
}

function markDadosInsuficientes(queue, id, motivo) {
  const item = requireItem(queue, id);
  const now = new Date().toISOString();
  transitionState(item, QUEUE_STATE.DADOS_INSUFICIENTES, ACTOR.SYSTEM, motivo || 'Dados insuficientes para revisão', now);
  return item;
}

function getProspect(queue, id) {
  return queue.items[id] || null;
}

function listQueue(queue, filterEstado) {
  const all = Object.values(queue.items);
  return filterEstado ? all.filter((item) => item.estado === filterEstado) : all;
}

function getHistory(queue, id) {
  return requireItem(queue, id).historico;
}

module.exports = {
  QUEUE_STATE,
  ACTOR,
  PERMISSION,
  ALLOWED_TRANSITIONS,
  DEFAULT_QUEUE_PATH,
  createEmptyQueue,
  loadQueueFromDisk,
  saveQueueToDisk,
  buildStableId,
  addProspect,
  approveProspect,
  rejectProspect,
  markDuplicado,
  markDnc,
  markDadosInsuficientes,
  getProspect,
  listQueue,
  getHistory,
};
