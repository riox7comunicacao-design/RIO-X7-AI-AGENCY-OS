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
// Passo 0009.2 trocou o antigo parâmetro `reviewer` (texto livre) por uma
// identidade estruturada. A Fase E do fechamento da fronteira de identidade e
// autorização (R1) foi além: aprovar/rejeitar deixou de depender de um objeto
// de identidade que o chamador apresenta e que este módulo só conferia pela
// FORMA. Este módulo não decide mais quem pode revisar — recebe essa decisão
// de uma PORTA injetada (inversão de dependência):
//
//   createApprovalReviewActions({ authorizeReviewer })
//   authorizeReviewer(context, requiredPermission) -> { userId, name, role }
//
// O domínio não importa src/auth e não conhece AuthorizationContext, USER,
// sessão nem token: `context` é opaco para ele — só é repassado ao
// autorizador, que recusa lançando erro. Do autorizador o domínio aceita de
// volta somente uma identidade MÍNIMA { userId, name, role }, e a registra em
// `reviewedBy`. Sem autorizador injetado não existe caminho de aprovação nem de
// rejeição: as funções soltas approveProspect/rejectProspect exportadas aqui
// só existem para falhar fechado. Quem liga o autorizador real
// (src/auth/approvalQueueBridge.js) a este módulo é o chamador — hoje, os
// testes; depois, a camada de Services.
//
// Limite honesto: o domínio CONFIA no autorizador que recebe. Isso é uma
// fronteira arquitetural interna confiável (trusted internal architectural
// boundary), não criptografia — código que controle o mesmo processo pode
// injetar um autorizador que sempre autoriza; esta fronteira não o impede.

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

// Permissão que este módulo exige para revisar (aprovar/rejeitar), no formato
// conceitual {AÇÃO}:{DOMÍNIO} definido em 0009. É só um VALOR repassado à porta
// authorizeReviewer — quem a verifica é o autorizador injetado, não este
// módulo. Duplica de propósito o literal de src/auth/constants (o domínio não
// importa src/auth); um teste vigia que os dois não divirjam. Nenhuma outra
// permissão é criada aqui.
const PERMISSION = Object.freeze({
  APPROVE_LEAD_APPROVAL: 'APPROVE:LEAD_APPROVAL',
});

// Promoção para o CRM (etapa CRM-INTEGRATION, decisão 0016). A promoção NÃO é um estado novo da fila: o item
// continua APROVADO_PARA_CRM (o estado histórico da aprovação humana) e a promoção fica registrada numa entrada de
// histórico e num resumo (`item.promocao`). Quem cria o registro no CRM não é este módulo — é a camada de Services
// (src/services/crmIntegrationService.js), sobre o CRM Service; este módulo só GUARDA o que aconteceu.
//   PROMOTION_RESULT — como o item chegou a "promovido": criou-se um registro novo (CRIADO) ou já existia um registro
//                      que esta mesma promoção tinha criado antes de uma falha (RECONCILIADO).
//   PROMOTION_BLOCK  — por que uma tentativa foi bloqueada (só auditoria; o estado do item nunca muda por isso).
const PROMOTION_RESULT = Object.freeze({ CRIADO: 'CRIADO', RECONCILIADO: 'RECONCILIADO' });
const PROMOTION_BLOCK = Object.freeze({ DNC: 'DNC', DUPLICADO: 'DUPLICADO', DADOS_INSUFICIENTES: 'DADOS_INSUFICIENTES' });
const MAX_CRM_RECORD_ID_LENGTH = 200;
const MAX_BLOCK_REASON_LENGTH = 500;

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

const REVIEWER_IDENTITY_FIELDS = Object.freeze(['userId', 'name', 'role']);

// Valida o que o AUTORIZADOR devolveu (a porta authorizeReviewer). O domínio só
// aceita de volta uma identidade MÍNIMA: exatamente { userId, name, role }, com
// textos não vazios, e nada além disso. Em especial nenhuma lista de
// permissions: o domínio nunca deve receber nem registrar permissões, e a
// antiga identidade { userId, name, role, permissions } NÃO é aceita como
// resposta de um autorizador (é o que impede que um adaptador legado, que
// ignora a permissão exigida, seja injetado como autorizador).
//
// A role SYSTEM (o actor de IA deste módulo, ACTOR.SYSTEM) nunca é um revisor:
// aprovar/rejeitar é sempre um ato humano. Antes, quem garantia que a role
// vinha de um USER definido era o contexto apresentado ao próprio domínio;
// agora essa garantia é do autorizador — e o domínio mantém a sua parte.
//
// Devolve uma cópia NOVA só com os três campos: é ela que vira `reviewedBy`.
function assertReviewerIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error('autorizador devolveu uma identidade inválida: esperava um objeto { userId, name, role }');
  }
  if (typeof identity.then === 'function') {
    throw new Error('autorizador devolveu uma Promise: a porta authorizeReviewer é síncrona');
  }
  const { userId, name, role } = identity;
  for (const [field, value] of [['userId', userId], ['name', name], ['role', role]]) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`autorizador devolveu uma identidade inválida: ${field} é obrigatório`);
    }
  }
  const extras = Object.keys(identity).filter((key) => !REVIEWER_IDENTITY_FIELDS.includes(key));
  if (extras.length > 0) {
    throw new Error(
      `autorizador devolveu uma identidade inválida: só { userId, name, role } é aceito (campos não permitidos: ${extras.join(', ')})`
    );
  }
  if (role.trim().toUpperCase() === ACTOR.SYSTEM) {
    throw new Error('autorizador devolveu uma identidade inválida: SYSTEM não é um revisor — aprovação e rejeição são sempre atos humanos');
  }
  return { userId: userId.trim(), name: name.trim(), role: role.trim() };
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

// Ações de revisão humana (aprovar/rejeitar). Só existem através desta fábrica:
// sem um `authorizeReviewer` (função) injetado nada é criado — a falha fechada
// acontece na criação, não na primeira chamada. O autorizador é capturado aqui:
// trocar `options.authorizeReviewer` depois não altera as ações já criadas.
//
// A ordem é sempre (1) autorizar, (2) só então olhar a fila. Uma chamada não
// autorizada lança antes de tocar em qualquer item — nem sequer revela se o
// prospect existe — e a fila permanece exatamente como estava.
//
// `context` é opaco para o domínio (ver o cabeçalho): quem o interpreta é o
// autorizador. Substitui o antigo `identity`/`reviewer` (Passos 0009.2 e 0009.6).
function createApprovalReviewActions(options) {
  const authorizeReviewer = options && options.authorizeReviewer;
  if (typeof authorizeReviewer !== 'function') {
    throw new Error(
      'createApprovalReviewActions exige { authorizeReviewer } (função): sem autorizador injetado não existe caminho de aprovação/rejeição'
    );
  }

  function authorize(context) {
    return assertReviewerIdentity(authorizeReviewer(context, PERMISSION.APPROVE_LEAD_APPROVAL));
  }

  // Aprovação: sempre um ato humano explícito. Nunca cria/edita nada no CRM —
  // só marca que este prospect PODE, futuramente, ser encaminhado para lá.
  function approve(queue, id, context, reason) {
    const reviewedBy = authorize(context);
    const item = requireItem(queue, id);
    const now = new Date().toISOString();
    transitionState(item, QUEUE_STATE.APROVADO_PARA_CRM, ACTOR.HUMAN, reason || null, now, { reviewedBy });
    return item;
  }

  // Rejeição: também sempre um ato humano explícito, sempre com motivo. A
  // exigência de motivo vem DEPOIS da autorização: quem não está autorizado
  // recebe a recusa de autorização, nunca detalhes de validação.
  function reject(queue, id, context, reason) {
    const reviewedBy = authorize(context);
    if (!reason || !String(reason).trim()) {
      throw new Error('rejeição exige um motivo');
    }
    const item = requireItem(queue, id);
    const now = new Date().toISOString();
    transitionState(item, QUEUE_STATE.REJEITADO, ACTOR.HUMAN, reason, now, { reviewedBy });
    return item;
  }

  return Object.freeze({ approveProspect: approve, rejectProspect: reject });
}

// Ações de AUDITORIA da promoção para o CRM (etapa CRM-INTEGRATION, decisão 0016). Uma fábrica À PARTE da de revisão
// (createApprovalReviewActions, cujo conjunto de ações — só aprovar e rejeitar — continua exatamente o mesmo): quem
// tem as ações de revisão não ganha, por isso, a de registrar promoção. Mesma porta, mesmo autorizador
// (APPROVE:LEAD_APPROVAL): o domínio nunca registra nada sem uma identidade humana devolvida pelo autorizador, e essa
// identidade vira `reviewedBy` da entrada — nunca vem do chamador. Nenhuma ação daqui muda o ESTADO do item, e
// nenhuma escreve no CRM (quem escreve no CRM é a camada de Services; este módulo só GUARDA o que aconteceu).
//
// Como na fábrica de revisão: sem `authorizeReviewer` (função) nada é criado — a falha fechada acontece na criação — e
// o autorizador é capturado aqui.
function createApprovalPromotionActions(options) {
  const authorizeReviewer = options && options.authorizeReviewer;
  if (typeof authorizeReviewer !== 'function') {
    throw new Error(
      'createApprovalPromotionActions exige { authorizeReviewer } (função): sem autorizador injetado não existe caminho de registro de promoção'
    );
  }

  function authorize(context) {
    return assertReviewerIdentity(authorizeReviewer(context, PERMISSION.APPROVE_LEAD_APPROVAL));
  }

  // Só um item que O PRÓPRIO DOMÍNIO tem como próprio (propriedade própria de queue.items) e que está APROVADO_PARA_CRM:
  // um id herdado do protótipo ("constructor", "__proto__") nunca é um item.
  function requireApprovedItem(queue, id) {
    if (!queue || typeof queue !== 'object' || !queue.items || !Object.prototype.hasOwnProperty.call(queue.items, id)) {
      throw new Error(`prospect não encontrado na fila: ${String(id)}`);
    }
    const item = queue.items[id];
    if (!item || typeof item !== 'object' || item.estado !== QUEUE_STATE.APROVADO_PARA_CRM) {
      throw new Error(
        `promoção só se registra em um prospect ${QUEUE_STATE.APROVADO_PARA_CRM}: ${String(id)} está em ${item && typeof item === 'object' ? String(item.estado) : 'estado desconhecido'}`
      );
    }
    if (!Array.isArray(item.historico)) {
      throw new Error(`item da fila corrompido (histórico ausente ou inválido): ${String(id)}`);
    }
    return item;
  }

  // Lê só PROPRIEDADES PRÓPRIAS de `details` (uma propriedade herdada do protótipo nunca participa do registro).
  function readOwn(details, key) {
    return details && typeof details === 'object' && Object.prototype.hasOwnProperty.call(details, key) ? details[key] : undefined;
  }

  function readCrmRecordId(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_CRM_RECORD_ID_LENGTH) {
      throw new Error(`crmRecordId deve ser um texto não vazio (até ${MAX_CRM_RECORD_ID_LENGTH} caracteres)`);
    }
    return value.trim();
  }

  // Registra que o prospect aprovado FOI promovido: `item.promocao` (resumo) + uma entrada de histórico. Idempotente
  // para o MESMO registro do CRM (não duplica a entrada); recusa registrar um SEGUNDO registro para o mesmo prospect.
  // `possivelDuplicadoDe` (opcional) guarda só o id do outro registro do CRM que coincidiu por nome+cidade — uma
  // SINALIZAÇÃO, nunca um bloqueio (regra 0005/0006).
  function recordPromotion(queue, id, context, details) {
    const promotedBy = authorize(context);
    const resultado = readOwn(details, 'resultado');
    if (!Object.values(PROMOTION_RESULT).includes(resultado)) {
      throw new Error(`resultado de promoção desconhecido: ${String(resultado)}`);
    }
    const crmRecordId = readCrmRecordId(readOwn(details, 'crmRecordId'));
    const possivel = readOwn(details, 'possivelDuplicadoDe');
    const possivelDuplicadoDe = possivel === undefined || possivel === null ? null : readCrmRecordId(possivel);
    const item = requireApprovedItem(queue, id);

    if (Object.prototype.hasOwnProperty.call(item, 'promocao') && item.promocao) {
      if (item.promocao.crmRecordId === crmRecordId) return item;
      throw new Error(`prospect já promovido para outro registro do CRM: ${String(id)}`);
    }
    const now = new Date().toISOString();
    item.promocao = { crmRecordId, resultado, promovidoEm: now, promovidoPor: promotedBy };
    item.historico.push({
      timestamp: now,
      from: QUEUE_STATE.APROVADO_PARA_CRM,
      to: QUEUE_STATE.APROVADO_PARA_CRM,
      actor: ACTOR.HUMAN,
      motivo: 'Promovido para o CRM',
      reviewedBy: { ...promotedBy },
      promocao: { resultado, crmRecordId, possivelDuplicadoDe },
    });
    return item;
  }

  // Registra uma tentativa de promoção BLOQUEADA (DNC, duplicidade, dados insuficientes) — só auditoria: o item
  // continua APROVADO_PARA_CRM, sem `promocao`, e pode ser promovido depois (se o bloqueio deixar de existir).
  function recordPromotionBlocked(queue, id, context, details) {
    const blockedBy = authorize(context);
    const codigo = readOwn(details, 'codigo');
    if (!Object.values(PROMOTION_BLOCK).includes(codigo)) {
      throw new Error(`código de bloqueio de promoção desconhecido: ${String(codigo)}`);
    }
    const motivo = readOwn(details, 'motivo');
    if (typeof motivo !== 'string' || !motivo.trim() || motivo.trim().length > MAX_BLOCK_REASON_LENGTH) {
      throw new Error(`motivo do bloqueio deve ser um texto não vazio (até ${MAX_BLOCK_REASON_LENGTH} caracteres)`);
    }
    const existente = readOwn(details, 'crmRecordId');
    const crmRecordId = existente === undefined || existente === null ? null : readCrmRecordId(existente);
    const item = requireApprovedItem(queue, id);
    const now = new Date().toISOString();
    item.historico.push({
      timestamp: now,
      from: QUEUE_STATE.APROVADO_PARA_CRM,
      to: QUEUE_STATE.APROVADO_PARA_CRM,
      actor: ACTOR.HUMAN,
      motivo: `Promoção bloqueada: ${motivo.trim()}`,
      reviewedBy: { ...blockedBy },
      promocao: { resultado: 'BLOQUEADO', codigo, crmRecordId },
    });
    return item;
  }

  return Object.freeze({ recordPromotion, recordPromotionBlocked });
}

// approveProspect/rejectProspect SOLTOS: existem só para falhar fechado. Antes
// da Fase E aprovavam a partir de um objeto de identidade que o próprio chamador
// apresentava; agora não há caminho de aprovação/rejeição sem um autorizador
// injetado. Não leem nenhum argumento e nunca tocam na fila.
function failClosedWithoutAuthorizer(actionName) {
  throw new Error(
    `${actionName} solto está desativado (falha fechada): aprovar/rejeitar exige um autorizador injetado — ` +
      `use createApprovalReviewActions({ authorizeReviewer }).${actionName}`
  );
}

function approveProspect() {
  return failClosedWithoutAuthorizer('approveProspect');
}

function rejectProspect() {
  return failClosedWithoutAuthorizer('rejectProspect');
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
  PROMOTION_RESULT,
  PROMOTION_BLOCK,
  ALLOWED_TRANSITIONS,
  DEFAULT_QUEUE_PATH,
  createEmptyQueue,
  loadQueueFromDisk,
  saveQueueToDisk,
  buildStableId,
  addProspect,
  createApprovalReviewActions,
  createApprovalPromotionActions,
  approveProspect,
  rejectProspect,
  markDuplicado,
  markDnc,
  markDadosInsuficientes,
  getProspect,
  listQueue,
  getHistory,
};
