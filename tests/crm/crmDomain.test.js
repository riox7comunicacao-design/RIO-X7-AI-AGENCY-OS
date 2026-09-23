// Testes do CRM Domain (decisão 0012) — modelo de dados, os 13 status oficiais, a máquina de
// estados, DNC, deduplicação e o limite de pureza do domínio (sem auth, sem I/O de rede, sem
// acoplamento a um mecanismo de persistência específico).
//
// Isolamento: os testes usam SEMPRE o repositório em memória real (createInMemoryCrmRepository) —
// não é um mock do domínio; é a mesma peça que um consumidor real usaria em desenvolvimento. Uma
// seção dedicada roda a MESMA bateria de cenários de dedup/DNC/transição sobre o adapter de
// arquivo JSON, para prova de que o domínio realmente não depende de qual repositório recebe.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crmDomain = require('../../src/crm/crmDomain');
const { createInMemoryCrmRepository, createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { CRM_STATUS, CRM_STATUS_LABEL, PIPELINE_STATUSES, ALLOWED_TRANSITIONS, ACTOR, CRM_WRITABLE_FIELDS, CRM_MANAGED_FIELDS } = require('../../src/crm/constants');
const { analyzeSource, listSourceFiles, toPosix } = require('../helpers/staticImports');

const memRepo = () => createInMemoryCrmRepository();

// ===========================================================================
// 1) Os 13 status oficiais
// ===========================================================================
test('[CRM-STATUS-1] existem exatamente os 13 status oficiais confirmados no schema real do CRM (PROJECT_CONTEXT.md)', () => {
  const esperados = [
    'PROSPECT', 'RESEARCH', 'QUALIFIED_PROSPECT', 'CONTACTED', 'RESPONDED', 'QUALIFICATION',
    'MEETING_SCHEDULED', 'MEETING_COMPLETED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST', 'DO_NOT_CONTACT',
  ];
  assert.deepEqual(Object.values(CRM_STATUS).sort(), esperados.sort());
  assert.equal(Object.values(CRM_STATUS).length, 13);
  // Rótulo de exibição existe para cada um, e a decisão de negócio (o identificador) nunca muda.
  for (const status of Object.values(CRM_STATUS)) assert.ok(CRM_STATUS_LABEL[status], status);
});

test('[CRM-STATUS-2] nenhum score/ranking/temperatura automática existe: "temperatura" é um campo comum, gravável e legível como qualquer outro, nunca calculado pelo domínio', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'Empresa Temp' });
  assert.equal(record.temperatura, null, 'nasce null, nunca um valor inventado');
  const atualizado = crmDomain.updateRecord(repo, record.id, { temperatura: 'QUENTE' });
  assert.equal(atualizado.temperatura, 'QUENTE', 'só muda se o chamador informar explicitamente');
});

// ===========================================================================
// 2) createRecord — modelo de dados
// ===========================================================================
test('[CRM-CREATE-1] cria com sucesso: empresa é o único campo obrigatório; o resto nasce null; status padrão é PROSPECT', () => {
  const repo = memRepo();
  const { record, duplicidade } = crmDomain.createRecord(repo, { empresa: 'Consultório Exemplo' });
  assert.equal(duplicidade, null);
  assert.match(record.id, /^crm:/);
  assert.equal(record.empresa, 'Consultório Exemplo');
  assert.equal(record.status, CRM_STATUS.PROSPECT);
  assert.ok(record.dataDeEntrada);
  assert.equal(record.historico.length, 1);
  assert.deepEqual(record.historico[0], { timestamp: record.dataDeEntrada, from: null, to: CRM_STATUS.PROSPECT, actor: ACTOR.HUMAN, reviewedBy: null, motivo: null });
  for (const campo of CRM_WRITABLE_FIELDS) {
    if (campo !== 'empresa') assert.equal(record[campo], null, campo);
  }
});

test('[CRM-CREATE-2] "empresa" é obrigatória: ausente, vazia ou só espaço em branco são todas recusadas', () => {
  const repo = memRepo();
  for (const entrada of [{}, { empresa: '' }, { empresa: '   ' }, { empresa: null }, { empresa: 42 }]) {
    assert.throws(() => crmDomain.createRecord(repo, entrada), /empresa/, JSON.stringify(entrada));
  }
  assert.equal(crmDomain.listRecords(repo).length, 0, 'nenhuma tentativa inválida criou registro');
});

test('[CRM-CREATE-3] campos desconhecidos são recusados; campos gerenciados (id/status/historico/dataDeEntrada) não podem ser fornecidos na criação', () => {
  const repo = memRepo();
  assert.throws(() => crmDomain.createRecord(repo, { empresa: 'x', bogus: 1 }), /desconhecid/);
  for (const gerenciado of CRM_MANAGED_FIELDS) {
    assert.throws(() => crmDomain.createRecord(repo, { empresa: 'x', [gerenciado]: 'qualquer coisa' }), /gerenciados/, gerenciado);
  }
});

test('[CRM-CREATE-4] valorProposta/valorTotal aceitam número (>= 0) ou null; recusam texto, negativo, NaN e Infinity', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'x', valorProposta: 1500.5, valorTotal: 0 });
  assert.equal(record.valorProposta, 1500.5);
  assert.equal(record.valorTotal, 0);
  for (const ruim of ['1500', -1, NaN, Infinity, {}]) {
    assert.throws(() => crmDomain.createRecord(repo, { empresa: 'y', valorProposta: ruim }), /valorProposta/, String(ruim));
  }
});

test('[CRM-CREATE-5] campos de texto recusam número/objeto/lista (só texto ou null)', () => {
  const repo = memRepo();
  for (const campo of ['contato', 'telefone', 'observacoes', 'responsavel']) {
    assert.throws(() => crmDomain.createRecord(repo, { empresa: 'x', [campo]: 42 }), new RegExp(campo));
  }
});

test('[CRM-CREATE-6] createRecord aceita um status inicial explícito diferente de PROSPECT, mas recusa um status inventado', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'x' }, { status: CRM_STATUS.RESEARCH });
  assert.equal(record.status, CRM_STATUS.RESEARCH);
  assert.equal(record.historico[0].to, CRM_STATUS.RESEARCH);
  assert.throws(() => crmDomain.createRecord(repo, { empresa: 'y' }, { status: 'INVENTADO' }), /status desconhecido/);
});

test('[CRM-CREATE-7] "actor" só aceita HUMAN/SYSTEM — qualquer outro valor é recusado (sem virar HUMAN por padrão silencioso quando fornecido errado)', () => {
  const repo = memRepo();
  assert.throws(() => crmDomain.createRecord(repo, { empresa: 'x' }, { actor: 'IA' }), /actor desconhecido/);
  const { record } = crmDomain.createRecord(repo, { empresa: 'y' }, { actor: ACTOR.SYSTEM });
  assert.equal(record.historico[0].actor, ACTOR.SYSTEM);
});

// ===========================================================================
// 3) Deduplicação (reaproveitando duplicateCheck.js)
// ===========================================================================
test('[CRM-DEDUPE-1] identidade FORTE idêntica (mesmo domínio/site) impede a criação de um segundo registro', () => {
  const repo = memRepo();
  crmDomain.createRecord(repo, { empresa: 'Clínica Original', site: 'clinica.example.test' });
  assert.throws(() => crmDomain.createRecord(repo, { empresa: 'Clínica Copiada Ltda', site: 'clinica.example.test' }), /mesma identidade/);
  assert.equal(crmDomain.listRecords(repo).length, 1, 'a tentativa bloqueada não criou nada');
});

test('[CRM-DEDUPE-2] identidade forte por TELEFONE e por INSTAGRAM também impedem a criação (não é só domínio)', () => {
  for (const [campo, valor] of [['telefone', '24999998888'], ['whatsapp', '24999997777'], ['instagram', 'clinica.exemplo']]) {
    const repo = memRepo();
    crmDomain.createRecord(repo, { empresa: 'Original', [campo]: valor });
    assert.throws(() => crmDomain.createRecord(repo, { empresa: 'Outro Nome', [campo]: valor }), /mesma identidade/, campo);
  }
});

test('[CRM-DEDUPE-3] nome + cidade NUNCA vira DUPLICADO automaticamente: a criação é PERMITIDA, só sinalizada como POSSIVEL_DUPLICADO', () => {
  const repo = memRepo();
  const { record: primeiro } = crmDomain.createRecord(repo, { empresa: 'Consultório Igual', cidade: 'Petrópolis' });
  const { record: segundo, duplicidade } = crmDomain.createRecord(repo, { empresa: 'Consultório Igual', cidade: 'Petrópolis' });
  assert.notEqual(primeiro.id, segundo.id, 'os dois foram criados de fato — falso positivo nunca bloqueia');
  assert.equal(duplicidade.status, 'POSSIVEL_DUPLICADO');
  assert.equal(duplicidade.matchedRecord.id, primeiro.id);
  assert.equal(crmDomain.listRecords(repo).length, 2);
});

test('[CRM-DEDUPE-4] sem nenhum critério de identidade em comum, dois registros distintos coexistem sem aviso nenhum', () => {
  const repo = memRepo();
  const { duplicidade: d1 } = crmDomain.createRecord(repo, { empresa: 'Empresa Sem Dados Em Comum A' });
  const { duplicidade: d2 } = crmDomain.createRecord(repo, { empresa: 'Empresa Sem Dados Em Comum B' });
  assert.equal(d1, null);
  assert.equal(d2, null);
  assert.equal(crmDomain.listRecords(repo).length, 2);
});

// ===========================================================================
// 4) DO NOT CONTACT — barreira operacional
// ===========================================================================
test('[CRM-DNC-1] markDoNotContact bloqueia o registro; DO_NOT_CONTACT é TERMINAL — nenhuma transição de saída existe', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'x' });
  const bloqueado = crmDomain.markDoNotContact(repo, record.id, { motivo: 'pediu para não ser mais contatado' });
  assert.equal(bloqueado.status, CRM_STATUS.DO_NOT_CONTACT);
  assert.deepEqual(ALLOWED_TRANSITIONS[CRM_STATUS.DO_NOT_CONTACT], undefined, 'nenhuma entrada no mapa de transições = terminal');
  for (const destino of Object.values(CRM_STATUS)) {
    assert.throws(() => crmDomain.moveStatus(repo, record.id, destino), /transição não permitida/, `DNC -> ${destino}`);
  }
});

test('[CRM-DNC-2] DO_NOT_CONTACT é alcançável a partir de QUALQUER outro status, inclusive WON e LOST (a barreira nunca depende de onde o lead está no funil)', () => {
  for (const partida of [...PIPELINE_STATUSES, CRM_STATUS.WON, CRM_STATUS.LOST]) {
    const repo = memRepo();
    const { record } = crmDomain.createRecord(repo, { empresa: 'x' }, { status: partida });
    const bloqueado = crmDomain.moveStatus(repo, record.id, CRM_STATUS.DO_NOT_CONTACT);
    assert.equal(bloqueado.status, CRM_STATUS.DO_NOT_CONTACT, partida);
  }
});

test('[CRM-DNC-3] um registro bloqueado (DO_NOT_CONTACT) não pode ser "atualizado" como se o contato comercial continuasse ativo', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'x' });
  crmDomain.markDoNotContact(repo, record.id);
  assert.throws(() => crmDomain.updateRecord(repo, record.id, { observacoes: 'nova nota' }), /bloqueado/);
});

test('[CRM-DNC-4] criar um registro NOVO para uma identidade já bloqueada é recusado — a proteção não pode ser burlada criando outro registro em vez de reabrir o antigo', () => {
  const repo = memRepo();
  const { record: original } = crmDomain.createRecord(repo, { empresa: 'Bloqueada Ltda', site: 'bloqueada.example.test' });
  crmDomain.markDoNotContact(repo, original.id);
  assert.throws(
    () => crmDomain.createRecord(repo, { empresa: 'Bloqueada — Nova Entrada', site: 'bloqueada.example.test' }),
    /bloqueada como DO_NOT_CONTACT/
  );
  // A mesma proteção vale para telefone/instagram, não só site.
  const repo2 = memRepo();
  const { record: original2 } = crmDomain.createRecord(repo2, { empresa: 'Bloqueada Fone', telefone: '24988887777' });
  crmDomain.markDoNotContact(repo2, original2.id);
  assert.throws(() => crmDomain.createRecord(repo2, { empresa: 'Reentrada por telefone', telefone: '24988887777' }), /bloqueada como DO_NOT_CONTACT/);
});

test('[CRM-DNC-5] diferente de checkDuplicate, o checkDoNotContact JÁ existente também considera nome+cidade um match pleno (não "possível") — comportamento herdado, não inventado por este domínio: reaproveitar a função significa reaproveitar essa regra tal como está', () => {
  const repo = memRepo();
  const { record: original } = crmDomain.createRecord(repo, { empresa: 'Nome Comum', cidade: 'Petrópolis' });
  crmDomain.markDoNotContact(repo, original.id);
  assert.throws(() => crmDomain.createRecord(repo, { empresa: 'Nome Comum', cidade: 'Petrópolis' }), /bloqueada como DO_NOT_CONTACT/);
});

// ===========================================================================
// 5) Máquina de estados (transições do funil)
// ===========================================================================
test('[CRM-TRANSITION-1] os 10 status de funil podem ir livremente para qualquer OUTRO status de funil (inclusive "voltar")', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'x' }, { status: CRM_STATUS.NEGOTIATION });
  const voltou = crmDomain.moveStatus(repo, record.id, CRM_STATUS.QUALIFICATION);
  assert.equal(voltou.status, CRM_STATUS.QUALIFICATION);
  assert.equal(voltou.historico.at(-1).from, CRM_STATUS.NEGOTIATION);
});

test('[CRM-TRANSITION-2] qualquer status de funil pode fechar como WON ou LOST', () => {
  for (const partida of PIPELINE_STATUSES) {
    for (const fechamento of [CRM_STATUS.WON, CRM_STATUS.LOST]) {
      const repo = memRepo();
      const { record } = crmDomain.createRecord(repo, { empresa: 'x' }, { status: partida });
      const fechado = crmDomain.moveStatus(repo, record.id, fechamento);
      assert.equal(fechado.status, fechamento, `${partida} -> ${fechamento}`);
    }
  }
});

test('[CRM-TRANSITION-3] WON e LOST são quase terminais: só podem ir para DO_NOT_CONTACT, nunca de volta ao funil', () => {
  for (const fechado of [CRM_STATUS.WON, CRM_STATUS.LOST]) {
    const repo = memRepo();
    const { record } = crmDomain.createRecord(repo, { empresa: 'x' }, { status: fechado });
    for (const destino of PIPELINE_STATUSES) {
      assert.throws(() => crmDomain.moveStatus(repo, record.id, destino), /transição não permitida/, `${fechado} -> ${destino}`);
    }
    assert.throws(() => crmDomain.moveStatus(repo, record.id, fechado === CRM_STATUS.WON ? CRM_STATUS.LOST : CRM_STATUS.WON), /transição não permitida/);
    assert.equal(crmDomain.moveStatus(repo, record.id, CRM_STATUS.DO_NOT_CONTACT).status, CRM_STATUS.DO_NOT_CONTACT);
  }
});

test('[CRM-TRANSITION-4] moveStatus recusa um status de destino desconhecido, e recusa mover um registro inexistente', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'x' });
  assert.throws(() => crmDomain.moveStatus(repo, record.id, 'NAO_EXISTE'), /status desconhecido/);
  assert.throws(() => crmDomain.moveStatus(repo, 'id-que-nao-existe', CRM_STATUS.RESEARCH), /não encontrado/);
});

test('[CRM-TRANSITION-5] toda transição gera uma entrada de histórico — nenhuma mudança de status é silenciosa; reviewedBy/motivo são registrados como fornecidos', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'x' });
  const reviewedBy = { userId: 'user-1', name: 'Alguém', role: 'ADMIN' };
  const movido = crmDomain.moveStatus(repo, record.id, CRM_STATUS.RESEARCH, { reviewedBy, motivo: 'começou a pesquisa' });
  assert.equal(movido.historico.length, 2);
  const ultimo = movido.historico.at(-1);
  assert.equal(ultimo.from, CRM_STATUS.PROSPECT);
  assert.equal(ultimo.to, CRM_STATUS.RESEARCH);
  assert.deepEqual(ultimo.reviewedBy, reviewedBy);
  assert.equal(ultimo.motivo, 'começou a pesquisa');
  assert.ok(ultimo.timestamp);
});

test('[CRM-TRANSITION-6] "actor" em moveStatus só aceita HUMAN/SYSTEM', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'x' });
  assert.throws(() => crmDomain.moveStatus(repo, record.id, CRM_STATUS.RESEARCH, { actor: 'ROBO' }), /actor desconhecido/);
});

// ===========================================================================
// 6) getRecord / listRecords / updateRecord — leitura, cópias, ausência de efeitos colaterais
// ===========================================================================
test('[CRM-READ-1] getRecord devolve null para um id inexistente, e uma CÓPIA para um id existente', () => {
  const repo = memRepo();
  assert.equal(crmDomain.getRecord(repo, 'nao-existe'), null);
  const { record } = crmDomain.createRecord(repo, { empresa: 'x' });
  const lido = crmDomain.getRecord(repo, record.id);
  lido.empresa = 'Adulterada';
  lido.historico.push({ falso: true });
  assert.equal(crmDomain.getRecord(repo, record.id).empresa, 'x');
  assert.equal(crmDomain.getRecord(repo, record.id).historico.length, 1);
});

test('[CRM-READ-2] listRecords devolve todos os registros, todos como cópias', () => {
  const repo = memRepo();
  crmDomain.createRecord(repo, { empresa: 'A' });
  crmDomain.createRecord(repo, { empresa: 'B' });
  const lista = crmDomain.listRecords(repo);
  assert.equal(lista.length, 2);
  lista[0].empresa = 'Adulterada';
  const listaDeNovo = crmDomain.listRecords(repo);
  assert.ok(listaDeNovo.every((r) => r.empresa === 'A' || r.empresa === 'B'));
});

test('[CRM-UPDATE-1] updateRecord altera só os campos enviados, preserva o resto (inclusive status e historico, que updateRecord nunca toca)', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'x', cidade: 'Petrópolis' });
  const atualizado = crmDomain.updateRecord(repo, record.id, { telefone: '24999990000', observacoes: 'nota' });
  assert.equal(atualizado.telefone, '24999990000');
  assert.equal(atualizado.observacoes, 'nota');
  assert.equal(atualizado.cidade, 'Petrópolis', 'campo não enviado permanece');
  assert.equal(atualizado.status, CRM_STATUS.PROSPECT);
  assert.equal(atualizado.historico.length, 1, 'updateRecord não mexe no histórico de status');
});

test('[CRM-UPDATE-2] updateRecord recusa campos gerenciados (id/status/historico/dataDeEntrada) e campos desconhecidos', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'x' });
  for (const gerenciado of CRM_MANAGED_FIELDS) {
    assert.throws(() => crmDomain.updateRecord(repo, record.id, { [gerenciado]: 'x' }), /gerenciados/, gerenciado);
  }
  assert.throws(() => crmDomain.updateRecord(repo, record.id, { bogus: 1 }), /desconhecid/);
});

test('[CRM-UPDATE-3] updateRecord recusa um id inexistente', () => {
  const repo = memRepo();
  assert.throws(() => crmDomain.updateRecord(repo, 'nao-existe', { observacoes: 'x' }), /não encontrado/);
});

// ===========================================================================
// 7) Ids herdados de Object (mesma classe de risco já conhecida em approvalQueue.js) — aqui já
//    mitigado no REPOSITÓRIO (ver crmRepository.test.js); confirmação de que o domínio também não
//    trata esses ids como um registro válido "por acaso".
// ===========================================================================
test('[CRM-SAFETY-1] ids herdados do protótipo do Object nunca são tratados como um registro existente', () => {
  const repo = memRepo();
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(crmDomain.getRecord(repo, id), null, id);
    assert.throws(() => crmDomain.moveStatus(repo, id, CRM_STATUS.RESEARCH), /não encontrado/, id);
    assert.throws(() => crmDomain.updateRecord(repo, id, { observacoes: 'x' }), /não encontrado/, id);
  }
});

// ===========================================================================
// 8) Ausência de efeitos colaterais / imutabilidade das entradas
// ===========================================================================
test('[CRM-SAFETY-2] createRecord nunca muta o objeto de entrada que o chamador passou', () => {
  const repo = memRepo();
  const input = Object.freeze({ empresa: 'x', observacoes: 'nota' });
  assert.doesNotThrow(() => crmDomain.createRecord(repo, input));
});

test('[CRM-SAFETY-3] o histórico é sempre estritamente crescente: nenhuma operação encolhe ou reescreve entradas antigas', () => {
  const repo = memRepo();
  const { record } = crmDomain.createRecord(repo, { empresa: 'x' });
  const depois1 = crmDomain.moveStatus(repo, record.id, CRM_STATUS.RESEARCH);
  const depois2 = crmDomain.moveStatus(repo, record.id, CRM_STATUS.CONTACTED);
  assert.equal(depois2.historico.length, 3);
  assert.deepEqual(depois2.historico.slice(0, 2), depois1.historico);
});

// ===========================================================================
// 9) Pureza do domínio — nenhuma dependência proibida
// ===========================================================================
const CRM_SRC_FILES = listSourceFiles(path.join(__dirname, '..', '..', 'src', 'crm'));
test('[CRM-PURITY-1] src/crm/*.js não importa src/auth, src/server, dashboard, tests, nem qualquer SDK/pacote externo (só node: built-ins e o próprio research-prospector)', () => {
  const ALLOWED_RELATIVE_PREFIXES = ['./', '../research-prospector/'];
  for (const file of CRM_SRC_FILES) {
    const rel = toPosix(path.relative(path.join(__dirname, '..', '..'), file));
    const analysis = analyzeSource(fs.readFileSync(file, 'utf8'), rel);
    assert.deepEqual(analysis.issues, [], `${rel}: carregamento não analisável`);
    for (const ref of analysis.refs) {
      const especificador = ref.specifier;
      const éBuiltinNode = especificador.startsWith('node:');
      const éRelativoPermitido = ALLOWED_RELATIVE_PREFIXES.some((prefixo) => especificador.startsWith(prefixo));
      assert.ok(éBuiltinNode || éRelativoPermitido, `${rel}: import não permitido: ${especificador}`);
      assert.doesNotMatch(especificador, /^(\.\.\/)?(auth|server|services)\//, `${rel}: não pode importar ${especificador}`);
      assert.doesNotMatch(especificador, /dashboard|tests|supabase|notion/i, `${rel}: não pode importar ${especificador}`);
    }
  }
  assert.ok(CRM_SRC_FILES.length >= 4, 'sanidade: a varredura realmente encontrou os arquivos do domínio');
});

test('[CRM-PURITY-2] nenhum arquivo de src/crm/ faz chamada de rede (fetch) nem usa eval/Function — o domínio é síncrono e determinístico', () => {
  for (const file of CRM_SRC_FILES) {
    const rel = toPosix(path.relative(path.join(__dirname, '..', '..'), file));
    const analysis = analyzeSource(fs.readFileSync(file, 'utf8'), rel);
    const identificadores = new Set(analysis.tokens.filter((t) => t.type === 'id').map((t) => t.value));
    for (const proibido of ['fetch', 'XMLHttpRequest', 'eval', 'Function', 'require']) {
      if (proibido === 'require') continue; // require() em si é esperado (é CommonJS); o que se veta são os ALVOS, checado acima.
      assert.equal(identificadores.has(proibido), false, `${rel}: não pode usar ${proibido}`);
    }
  }
});

// ===========================================================================
// 10) Mesma bateria de cenários críticos, agora sobre o adapter de ARQUIVO JSON — prova de que o
//     domínio não depende de qual repositório está por trás.
// ===========================================================================
function jsonRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-domain-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createJsonFileCrmRepository(path.join(dir, 'crm.json'));
}

test('[CRM-JSON-1] criar, listar, mover status e persistir — tudo sobre o repositório de arquivo, sem nenhuma mudança de comportamento', (t) => {
  const repo = jsonRepo(t);
  const { record } = crmDomain.createRecord(repo, { empresa: 'Persistente Ltda', site: 'persistente.example.test' });
  assert.equal(crmDomain.listRecords(repo).length, 1);
  const movido = crmDomain.moveStatus(repo, record.id, CRM_STATUS.QUALIFICATION);
  assert.equal(movido.status, CRM_STATUS.QUALIFICATION);
  assert.equal(crmDomain.getRecord(repo, record.id).status, CRM_STATUS.QUALIFICATION);
});

test('[CRM-JSON-2] deduplicação forte e DNC bloqueiam criação também sobre o arquivo JSON', (t) => {
  const repo = jsonRepo(t);
  crmDomain.createRecord(repo, { empresa: 'Original', site: 'original.example.test' });
  assert.throws(() => crmDomain.createRecord(repo, { empresa: 'Copiada', site: 'original.example.test' }), /mesma identidade/);

  const { record: bloqueada } = crmDomain.createRecord(repo, { empresa: 'Vai Bloquear', telefone: '24911112222' });
  crmDomain.markDoNotContact(repo, bloqueada.id);
  assert.throws(() => crmDomain.createRecord(repo, { empresa: 'Reentrada', telefone: '24911112222' }), /bloqueada como DO_NOT_CONTACT/);
});

test('[CRM-JSON-3] DO_NOT_CONTACT continua terminal sobre o arquivo JSON, mesmo relendo do disco', (t) => {
  const repo = jsonRepo(t);
  const { record } = crmDomain.createRecord(repo, { empresa: 'x' });
  crmDomain.markDoNotContact(repo, record.id);
  assert.throws(() => crmDomain.moveStatus(repo, record.id, CRM_STATUS.PROSPECT), /transição não permitida/);
});
