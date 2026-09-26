// O modelo do CRM no Dashboard (dashboard/crm-model.mjs, router.mjs, format.mjs): funções PURAS — vocabulário, busca, filtros,
// formulários, mensagens de erro, histórico e rotas.
//
// O Dashboard não pode importar src/ (regra R11), então o vocabulário (status, rótulos, campos, permissões) é uma cópia
// deliberada dos nomes do domínio. Os primeiros testes a comparam com o domínio REAL nos dois sentidos: se o domínio
// mudar um status, um rótulo, um campo ou o tipo de um campo, a suíte quebra aqui em vez de a tela mostrar algo defasado.

const test = require('node:test');
const assert = require('node:assert/strict');

const domain = require('../../src/crm');
const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');

const loadModel = () => import('../../dashboard/crm-model.mjs');
const loadRouter = () => import('../../dashboard/router.mjs');
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const nbsp = (text) => text.replace(/\u00a0/g, ' ');

// ===========================================================================
// Vocabulário: o Dashboard × o domínio
// ===========================================================================
test('[DASH-MODEL-1] os 13 status do Dashboard são exatamente os do domínio, na mesma ordem, com os mesmos rótulos (CRM_STATUS e CRM_STATUS_LABEL)', async () => {
  const { CRM_STATUSES, statusLabel, statusTone } = await loadModel();
  assert.deepEqual(CRM_STATUSES.map((status) => status.value), Object.values(domain.CRM_STATUS));
  for (const status of CRM_STATUSES) {
    assert.equal(status.label, domain.CRM_STATUS_LABEL[status.value], status.value);
    assert.ok(['neutral', 'info', 'warn', 'ok', 'bad'].includes(status.tone), `tom inválido em ${status.value}`);
    assert.equal(Object.isFrozen(status), true);
  }
  assert.equal(statusLabel('WON'), 'Won');
  assert.equal(statusLabel('ALGO_NOVO'), 'ALGO_NOVO', 'um status desconhecido aparece como veio');
  for (const estranho of [undefined, null, {}, []]) assert.equal(statusLabel(estranho), '—');
  assert.equal(statusTone('DO_NOT_CONTACT'), 'bad');
  assert.equal(statusTone('ALGO_NOVO'), 'neutral');
});

test('[DASH-MODEL-2] os campos do Dashboard são exatamente os 31 graváveis do domínio (CRM_WRITABLE_FIELDS), cada um em UM bloco, e os gerenciados são só exibidos', async () => {
  const { FIELD_GROUPS, EDITABLE_FIELDS, WRITABLE_KEYS, LIST_COLUMNS } = await loadModel();
  assert.equal(WRITABLE_KEYS.length, new Set(WRITABLE_KEYS).size, 'nenhum campo repetido');
  assert.deepEqual([...WRITABLE_KEYS].sort(), [...domain.CRM_WRITABLE_FIELDS].sort());
  assert.equal(WRITABLE_KEYS.length, 31);
  assert.deepEqual(FIELD_GROUPS.map((group) => group.title), ['Identificação', 'Contato', 'Presença digital', 'Comercial', 'Pipeline', 'Próxima ação']);
  const managed = FIELD_GROUPS.flatMap((group) => group.fields).filter((entry) => entry.managed === true).map((entry) => entry.key);
  assert.deepEqual(managed.sort(), ['dataDeEntrada', 'status']);
  for (const key of managed) assert.ok(domain.CRM_MANAGED_FIELDS.includes(key), `${key} é gerenciado pelo domínio`);
  for (const group of FIELD_GROUPS) assert.ok(group.fields.length > 0, group.title);
  assert.deepEqual(EDITABLE_FIELDS.map((entry) => entry.key), WRITABLE_KEYS);
  // As colunas da lista só usam campos que existem na API.
  const existentes = new Set([...domain.CRM_WRITABLE_FIELDS, ...domain.CRM_MANAGED_FIELDS]);
  for (const column of LIST_COLUMNS) assert.ok(existentes.has(column.key), `coluna inventada: ${column.key}`);
  assert.deepEqual(LIST_COLUMNS.map((column) => column.label), ['Empresa', 'Contato', 'Nicho', 'Cidade', 'Status', 'Serviço potencial', 'Responsável', 'Próxima ação', 'Valor da proposta']);
});

test('[DASH-MODEL-3] o tipo de cada campo bate com o do domínio: só os campos "number" aceitam número (>= 0) e todos os outros recusam', async () => {
  const { EDITABLE_FIELDS } = await loadModel();
  const aceita = async (key, value) => {
    try {
      await domain.createRecord(domain.createInMemoryCrmRepository(), { empresa: 'Base Teste', [key]: value });
      return true;
    } catch {
      return false;
    }
  };
  for (const entry of EDITABLE_FIELDS) {
    assert.equal(await aceita(entry.key, 5), entry.kind === 'number', `${entry.key}: número 5`);
    assert.equal(await aceita(entry.key, 'texto'), entry.kind !== 'number', `${entry.key}: texto`);
    if (entry.kind === 'number') assert.equal(await aceita(entry.key, -1), false, `${entry.key}: negativo`);
  }
});

test('[DASH-MODEL-4] as permissões do Dashboard são as do servidor: os nomes batem com PERMISSION e permissionsOf lê só o que /api/me devolveu (ADMIN escreve; COMMERCIAL_CLOSER só lê)', async () => {
  const { PERMISSIONS, permissionsOf } = await loadModel();
  assert.equal(PERMISSIONS.READ_CRM, authConstants.PERMISSION.READ_CRM);
  assert.equal(PERMISSIONS.WRITE_CRM, authConstants.PERMISSION.WRITE_CRM);
  assert.equal(PERMISSIONS.REVIEW, authConstants.PERMISSION.APPROVE_LEAD_APPROVAL);

  const admin = permissionsOf({ role: 'ADMIN', permissions: [...authConstants.getRolePermissions(authConstants.ROLE.ADMIN)] });
  const closer = permissionsOf({ role: 'COMMERCIAL_CLOSER', permissions: [...authConstants.getRolePermissions(authConstants.ROLE.COMMERCIAL_CLOSER)] });
  assert.deepEqual(admin, { canReadCrm: true, canWriteCrm: true, canReview: true });
  assert.deepEqual(closer, { canReadCrm: true, canWriteCrm: false, canReview: true });

  // A role NUNCA decide: um ADMIN sem WRITE:CRM na lista não escreve, e a role forjada de um closer não muda nada.
  assert.equal(permissionsOf({ role: 'ADMIN', permissions: ['READ:CRM'] }).canWriteCrm, false);
  assert.equal(permissionsOf({ role: 'ADMIN', permissions: [] }).canReadCrm, false);
  for (const estranho of [undefined, null, {}, { permissions: 'WRITE:CRM' }, { permissions: null }, 'ADMIN', 42]) {
    assert.deepEqual(permissionsOf(estranho), { canReadCrm: false, canWriteCrm: false, canReview: false });
  }
});

// ===========================================================================
// Busca e filtros
// ===========================================================================
async function conjunto() {
  const { crmRecord } = await loadFixtures();
  return [
    crmRecord({
      id: 'crm:a',
      empresa: 'Clínica Alfa',
      contato: 'Maria Souza',
      telefone: '(24) 90000-0001',
      whatsapp: '+55 24 90000-0002',
      email: 'contato@alfa.example.test',
      instagram: '@alfaclinica',
      cidade: 'Petrópolis',
      nicho: 'Psicologia',
      responsavel: 'Rafael',
      observacoes: 'texto secreto de teste',
      status: 'CONTACTED',
      dataDeEntrada: '2026-09-12T10:00:00.000Z',
    }),
    crmRecord({ id: 'crm:b', empresa: 'Odonto Beta', contato: 'João Pereira', telefone: '21 90000-0003', nicho: 'psicologia', responsavel: 'Breno', status: 'WON', dataDeEntrada: '2026-09-14T10:00:00.000Z' }),
    crmRecord({ id: 'crm:c', empresa: 'Ótica Gama', contato: 'Ana Lima', nicho: 'Óptica', responsavel: '', status: 'PROSPECT', dataDeEntrada: '2026-09-14T10:00:00.000Z' }),
  ];
}

test('[DASH-MODEL-5] busca: empresa, contato, telefone, WhatsApp, e-mail e Instagram; sem acento nem caixa; telefone por dígitos; todas as palavras precisam casar', async () => {
  const { matchesQuery, filterRecords } = await loadModel();
  const [alfa, beta] = await conjunto();
  const ids = (query) => filterRecords([alfa, beta], { query }).map((item) => item.id);

  assert.deepEqual(ids(''), ['crm:a', 'crm:b'], 'busca vazia = tudo');
  assert.deepEqual(ids('   '), ['crm:a', 'crm:b']);
  assert.deepEqual(ids('clinica'), ['crm:a'], 'sem acento');
  assert.deepEqual(ids('CLÍNICA ALFA'), ['crm:a'], 'sem diferença de caixa; palavras em qualquer ordem casam juntas');
  assert.deepEqual(ids('souza maria'), ['crm:a'], 'contato, em qualquer ordem');
  assert.deepEqual(ids('joao'), ['crm:b'], 'contato sem acento');
  assert.deepEqual(ids('alfa.example'), ['crm:a'], 'e-mail');
  assert.deepEqual(ids('@alfaclinica'), ['crm:a'], 'Instagram com @');
  assert.deepEqual(ids('alfaclinica'), ['crm:a'], 'Instagram sem @');
  // telefone e WhatsApp: a formatação da busca e a guardada não precisam ser iguais
  assert.deepEqual(ids('90000-0001'), ['crm:a']);
  assert.deepEqual(ids('(24) 90000-0001'), ['crm:a']);
  assert.deepEqual(ids('24900000001'), ['crm:a']);
  assert.deepEqual(ids('900000002'), ['crm:a'], 'WhatsApp por dígitos, com o +55 guardado');
  assert.deepEqual(ids('21 90000-0003'), ['crm:b']);
  assert.deepEqual(ids('49'), [], 'duas palavras de dígitos ainda não casam com o telefone pelos dígitos (o mínimo é 3)');
  assert.deepEqual(ids('4900'), ['crm:a'], 'com 3 ou mais dígitos, casa pelos dígitos do telefone (2 4 9 0 0...)');
  assert.deepEqual(ids('alfa joão'), [], 'todas as palavras precisam casar no MESMO registro');
  // O que NÃO é campo de busca não casa (a busca é sobre os seis campos pedidos).
  assert.deepEqual(ids('Petropolis'), [], 'cidade não é campo de busca');
  assert.deepEqual(ids('secreto'), [], 'observações não são campo de busca');
  // Valores que não são texto nunca derrubam a busca.
  assert.doesNotThrow(() => matchesQuery({ empresa: { a: 1 }, telefone: 123, whatsapp: ['x'], email: null }, 'x'));
  assert.equal(matchesQuery({ empresa: { a: 1 }, telefone: 123 }, '123'), true, 'um número guardado como número também é encontrado');
});

test('[DASH-MODEL-6] filtros: status, nicho e responsável (sem acento nem caixa), combinados entre si e com a busca; distinctValues junta as variações e ordena', async () => {
  const { filterRecords, distinctValues, sortRecords, countByStatus } = await loadModel();
  const itens = await conjunto();
  const ids = (criteria) => filterRecords(itens, criteria).map((item) => item.id);

  assert.deepEqual(ids({ status: 'WON' }), ['crm:b']);
  assert.deepEqual(ids({ status: 'DO_NOT_CONTACT' }), []);
  assert.deepEqual(ids({ nicho: 'Psicologia' }), ['crm:a', 'crm:b'], 'Psicologia e psicologia são o mesmo nicho');
  assert.deepEqual(ids({ nicho: 'optica' }), ['crm:c'], 'sem acento');
  assert.deepEqual(ids({ responsavel: 'BRENO' }), ['crm:b']);
  assert.deepEqual(ids({ nicho: 'Psicologia', responsavel: 'Rafael' }), ['crm:a']);
  assert.deepEqual(ids({ nicho: 'Psicologia', query: 'odonto' }), ['crm:b'], 'filtro + busca');
  assert.deepEqual(ids({ status: 'WON', nicho: 'Óptica' }), [], 'filtros combinam com E');
  assert.deepEqual(ids({}), ['crm:a', 'crm:b', 'crm:c']);

  assert.deepEqual(distinctValues(itens, 'nicho'), ['Óptica', 'Psicologia'], 'uma grafia por valor, ordem alfabética');
  assert.deepEqual(distinctValues(itens, 'responsavel'), ['Breno', 'Rafael'], 'vazio nunca vira opção');
  assert.deepEqual(distinctValues([], 'nicho'), []);

  assert.deepEqual(sortRecords(itens).map((item) => item.id), ['crm:b', 'crm:c', 'crm:a'], 'mais recente primeiro; empate pelo nome da empresa');
  assert.deepEqual(itens.map((item) => item.id), ['crm:a', 'crm:b', 'crm:c'], 'sortRecords não altera a lista original');

  const contagem = countByStatus(itens);
  assert.equal(contagem.length, 13);
  assert.deepEqual(contagem.filter((status) => status.count > 0).map((status) => `${status.value}:${status.count}`), ['PROSPECT:1', 'CONTACTED:1', 'WON:1']);
});

// ===========================================================================
// Formatação
// ===========================================================================
test('[DASH-MODEL-7] formatação: dinheiro em reais, datas, valores exibidos por tipo e as colunas da lista — nunca "[object Object]" nem exceção para dado estranho', async () => {
  const { formatMoney, formatDateValue, displayValue, listCells, FIELD_GROUPS } = await loadModel();
  assert.equal(nbsp(formatMoney(1500)), 'R$ 1.500,00');
  assert.equal(nbsp(formatMoney(0)), 'R$ 0,00');
  for (const naoNumero of ['1500', null, undefined, NaN, Infinity, {}, []]) assert.equal(formatMoney(naoNumero), '', String(naoNumero));

  assert.equal(formatDateValue('2026-09-25'), '25/09/2026');
  assert.match(formatDateValue('2026-09-25T13:00:00Z'), /25\/09\/2026/);
  assert.equal(formatDateValue('semana que vem'), 'semana que vem');
  assert.equal(formatDateValue({}), '');

  const campo = (key) => FIELD_GROUPS.flatMap((group) => group.fields).find((entry) => entry.key === key);
  assert.equal(nbsp(displayValue(campo('valorProposta'), { valorProposta: 2500.5 })), 'R$ 2.500,50');
  assert.equal(displayValue(campo('valorProposta'), { valorProposta: 'não é número' }), '');
  assert.equal(displayValue(campo('dataDaProximaAcao'), { dataDaProximaAcao: '2026-10-01' }), '01/10/2026');
  assert.equal(displayValue(campo('status'), { status: 'WON' }), 'Won');
  assert.equal(displayValue(campo('empresa'), { empresa: { hostil: true } }), '');
  assert.equal(displayValue(campo('empresa'), {}), '');
  assert.equal(displayValue(campo('empresa'), null), '');

  const celulas = listCells({ empresa: 'Clínica Alfa', cidade: 'Petrópolis', estado: 'RJ', proximaAcao: 'Ligar', dataDaProximaAcao: '2026-10-01', valorProposta: 1000, status: 'WON', nicho: 'X' });
  assert.equal(celulas.empresa, 'Clínica Alfa');
  assert.equal(celulas.cidade, 'Petrópolis/RJ');
  assert.equal(celulas.proximaAcao, 'Ligar · 01/10/2026');
  assert.equal(nbsp(celulas.valorProposta), 'R$ 1.000,00');
  assert.equal(listCells({ empresa: '   ' }).empresa, 'Sem nome');
  assert.equal(listCells({ empresa: 'X', cidade: 'Niterói' }).cidade, 'Niterói');
});

// ===========================================================================
// Formulários: do que a pessoa digita para o corpo da API
// ===========================================================================
test('[DASH-MODEL-8] validação e conversão: só a empresa é obrigatória; valores em dinheiro aceitam vírgula ou ponto e nunca negativo; vazio vira null e texto é aparado', async () => {
  const { parseAmount, validateForm, buildCreateRequest, WRITABLE_KEYS } = await loadModel();
  assert.deepEqual(parseAmount('1500'), { ok: true, value: 1500 });
  assert.deepEqual(parseAmount('1500,5'), { ok: true, value: 1500.5 });
  assert.deepEqual(parseAmount(' 12.75 '), { ok: true, value: 12.75 });
  assert.deepEqual(parseAmount(''), { ok: true, value: null });
  for (const invalido of ['abc', '-1', '1e999', 'NaN', '1,2,3', '12 reais']) assert.equal(parseAmount(invalido).ok, false, invalido);

  assert.deepEqual(validateForm({ empresa: 'X' }), {});
  assert.deepEqual(Object.keys(validateForm({ empresa: '   ' })), ['empresa']);
  assert.deepEqual(Object.keys(validateForm({})), ['empresa']);
  assert.deepEqual(Object.keys(validateForm({ empresa: 'X', valorProposta: 'abc', valorTotal: '-3' })).sort(), ['valorProposta', 'valorTotal']);

  const { fields, options } = buildCreateRequest(
    { empresa: '  Clínica Nova  ', cidade: '', telefone: '  ', valorProposta: '1500,5', site: 'nova.example.test', userId: 'user-atacante', role: 'ADMIN', permissions: 'WRITE:CRM', reviewedBy: 'x', actor: 'SYSTEM', status: 'WON', id: 'crm:forjado' },
    { status: 'CONTACTED', reason: '  indicação  ' }
  );
  assert.deepEqual(fields, { empresa: 'Clínica Nova', valorProposta: 1500.5, site: 'nova.example.test' }, 'vazios saem; valores são aparados; números viram número');
  assert.deepEqual(options, { status: 'CONTACTED', reason: 'indicação' });
  for (const chave of Object.keys(fields)) assert.ok(WRITABLE_KEYS.includes(chave), `${chave} não é um campo gravável`);
  assert.deepEqual(buildCreateRequest({ empresa: 'X' }, { status: '', reason: '   ' }).options, {}, 'opções vazias não são enviadas');
  assert.deepEqual(buildCreateRequest({ empresa: 'X' }).options, {});
});

test('[DASH-MODEL-9] o PATCH leva só o que a pessoa MUDOU em relação ao que o formulário mostrou ao abrir: campo esvaziado vai como null, espaços e números equivalentes não contam, e nenhum campo que a pessoa não tocou é sobrescrito', async () => {
  const { buildPatch, valuesFromRecord, WRITABLE_KEYS } = await loadModel();
  const { crmRecord } = await loadFixtures();
  const registro = crmRecord({ empresa: 'Alfa', cidade: 'Petrópolis', valorProposta: 1500, telefone: '24 90000-0001' });
  const inicial = valuesFromRecord(registro);
  assert.equal(inicial.valorProposta, '1500', 'número vira texto no formulário');
  assert.equal(inicial.site, '', 'null vira vazio');
  assert.deepEqual(Object.keys(inicial).sort(), [...WRITABLE_KEYS].sort());

  assert.deepEqual(buildPatch(inicial, { ...inicial }), {}, 'nada mudou: nada a salvar');
  assert.deepEqual(buildPatch(inicial, { ...inicial, cidade: 'Niterói' }), { cidade: 'Niterói' });
  assert.deepEqual(buildPatch(inicial, { ...inicial, cidade: '' }), { cidade: null }, 'esvaziar um campo é gravar null');
  assert.deepEqual(buildPatch(inicial, { ...inicial, cidade: '  Petrópolis  ' }), {}, 'espaços nas pontas não são mudança');
  assert.deepEqual(buildPatch(inicial, { ...inicial, valorProposta: '1500.00' }), {}, '1500 e 1500.00 são o mesmo número');
  assert.deepEqual(buildPatch(inicial, { ...inicial, valorProposta: '1600,5' }), { valorProposta: 1600.5 });
  assert.deepEqual(buildPatch(inicial, { ...inicial, valorProposta: '' }), { valorProposta: null });

  // Edição concorrente: o registro de AGORA (do servidor) tem outra cidade, mas a pessoa só mexeu no nicho — a cidade não é enviada.
  const agora = { ...registro, cidade: 'Teresópolis' };
  assert.equal(agora.cidade, 'Teresópolis');
  assert.deepEqual(buildPatch(inicial, { ...inicial, nicho: 'Psicologia' }), { nicho: 'Psicologia' });

  // Chaves que não são campos (identidade forjada, status, id) nunca entram no PATCH, mesmo presentes nos valores.
  const forjado = { ...inicial, nicho: 'X', userId: 'user-atacante', role: 'ADMIN', permissions: 'x', reviewedBy: 'x', actor: 'SYSTEM', status: 'WON', id: 'crm:outro', historico: [] };
  assert.deepEqual(buildPatch(inicial, forjado), { nicho: 'X' });
  assert.deepEqual(buildPatch(undefined, { empresa: 'Nova' }), { empresa: 'Nova' }, 'sem valores iniciais, tudo o que foi preenchido é mudança');
});

// ===========================================================================
// Erros da API -> frases
// ===========================================================================
test('[DASH-MODEL-10] mensagens de erro: 401 é da sessão (null); 403, 404, 409 (por código), 400 (a frase fixa do servidor), 413 e falha de rede têm frase própria; o resto é genérico e NUNCA repete o texto do servidor', async () => {
  const { messageForCrmError, GENERIC_ERROR } = await loadModel();
  const { ApiError } = await loadFixtures();
  const erro = (status, code, message) => new ApiError(status, code, message);

  assert.equal(messageForCrmError(erro(401, 'UNAUTHENTICATED', 'Sessão ausente.')), null);
  assert.match(messageForCrmError(erro(403, 'FORBIDDEN', 'Esta conta não possui acesso a esta área.')), /não tem permissão/);
  assert.match(messageForCrmError(erro(404, 'NOT_FOUND', 'Item não encontrado.')), /não encontrado/);
  assert.match(messageForCrmError(erro(409, 'DUPLICATE_RECORD', 'x')), /Já existe um registro com esta identidade/);
  assert.match(messageForCrmError(erro(409, 'DNC_BLOCKED', 'x')), /bloqueada como "Não contatar"/);
  assert.match(messageForCrmError(erro(409, 'RECORD_LOCKED', 'x')), /não pode mais ser alterado/);
  assert.match(messageForCrmError(erro(409, 'INVALID_TRANSITION', 'x')), /mudança de status não é permitida/);
  assert.match(messageForCrmError(erro(409, 'CODIGO_NOVO', 'x')), /estado atual do registro/, 'um 409 desconhecido tem uma frase segura');
  assert.equal(messageForCrmError(erro(400, 'INVALID_REQUEST', 'Informe a empresa.')), 'Informe a empresa.', 'a frase fixa do servidor para 400 é mostrada');
  assert.match(messageForCrmError(erro(400, 'INVALID_REQUEST', '')), /Dados inválidos/);
  assert.match(messageForCrmError(erro(413, 'PAYLOAD_TOO_LARGE', 'x')), /grandes demais/);
  assert.match(messageForCrmError(erro(0, 'NETWORK', '')), /Sem conexão/);

  for (const inesperado of [erro(500, 'INTERNAL', 'detalhe interno C:\\segredo\\crm.json'), erro(503, 'AUTH_UNAVAILABLE', 'x'), erro(418, 'X', 'x'), new Error('qualquer coisa'), undefined, null, 'texto']) {
    assert.equal(messageForCrmError(inesperado), GENERIC_ERROR, String(inesperado));
  }
  assert.doesNotMatch(messageForCrmError(erro(500, 'INTERNAL', 'detalhe interno C:\\segredo\\crm.json')), /segredo|crm\.json/);
});

// ===========================================================================
// Histórico
// ===========================================================================
test('[DASH-MODEL-11] histórico: só o que a API devolveu, do mais recente para o mais antigo; a criação, o sistema e a identidade ausente têm texto próprio; dado estranho nunca derruba', async () => {
  const { describeHistory } = await loadModel();
  const { roleLabel } = await import('../../dashboard/format.mjs');
  const entradas = [
    { timestamp: '2026-09-10T12:00:00.000Z', from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: { userId: 'user-breno', name: 'Breno Bento', role: 'ADMIN' }, motivo: null },
    { timestamp: '2026-09-11T12:00:00.000Z', from: 'PROSPECT', to: 'CONTACTED', actor: 'HUMAN', reviewedBy: { userId: 'user-rafael', name: 'Rafael Closer', role: 'COMMERCIAL_CLOSER' }, motivo: 'Primeiro contato' },
    { timestamp: '2026-09-12T12:00:00.000Z', from: 'CONTACTED', to: 'WON', actor: 'SYSTEM', reviewedBy: null, motivo: null },
  ];
  const linhas = describeHistory(entradas, roleLabel);
  assert.equal(linhas.length, 3);
  assert.deepEqual(linhas.map((linha) => linha.transition), ['Contacted → Won', 'Prospect → Contacted', 'Registro criado como Prospect'], 'do mais recente ao mais antigo');
  assert.equal(linhas[0].who, 'Sistema');
  assert.equal(linhas[1].who, 'Rafael Closer (Closer comercial)');
  assert.equal(linhas[1].reason, 'Primeiro contato');
  assert.equal(linhas[2].who, 'Breno Bento (Administrador)');
  assert.match(linhas[2].when, /10\/09\/2026/);
  assert.equal(describeHistory(entradas.slice(0, 1))[0].who, 'Breno Bento (ADMIN)', 'sem tradução de role, a role aparece como veio');

  assert.deepEqual(describeHistory(undefined), []);
  assert.deepEqual(describeHistory('x'), []);
  assert.deepEqual(describeHistory([]), []);
  const estranho = describeHistory([null, 42, 'x', {}, { to: 'WON', reviewedBy: 'x', from: {} }, { to: 'WON', motivo: { a: 1 }, timestamp: {} }]);
  assert.equal(estranho.length, 3, 'só objetos entram; nenhum evento é inventado');
  for (const linha of estranho) for (const valor of Object.values(linha)) assert.equal(typeof valor, 'string');
});

// ===========================================================================
// Formatação compartilhada
// ===========================================================================
test('[DASH-MODEL-12] format.mjs: roleLabel só traduz role CONHECIDA (nunca uma propriedade herdada do objeto), e as URLs seguem seguras', async () => {
  const { roleLabel, ROLE_LABELS, safeHttpUrl } = await import('../../dashboard/format.mjs');
  assert.equal(roleLabel('ADMIN'), 'Administrador');
  assert.equal(roleLabel('COMMERCIAL_CLOSER'), 'Closer comercial');
  assert.equal(roleLabel('OUTRA'), 'OUTRA');
  for (const herdada of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(roleLabel(herdada), herdada);
  for (const naoTexto of [undefined, null, 42, {}]) assert.equal(roleLabel(naoTexto), '');
  assert.equal(Object.isFrozen(ROLE_LABELS), true);
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
});

// ===========================================================================
// Rotas
// ===========================================================================
test('[DASH-MODEL-13] rotas: cada # vira a rota certa e volta (ida e volta), o id do registro é codificado, e qualquer coisa estranha é not-found — nunca uma exceção', async () => {
  const { parseRoute, buildHash, sectionOf } = await loadRouter();
  assert.deepEqual(parseRoute(''), { name: 'overview' });
  assert.deepEqual(parseRoute('#'), { name: 'overview' });
  assert.deepEqual(parseRoute('#/'), { name: 'overview' });
  assert.deepEqual(parseRoute('#/crm'), { name: 'crm-list' });
  assert.deepEqual(parseRoute('#/crm/'), { name: 'crm-list' }, 'barra final tolerada');
  assert.deepEqual(parseRoute('#/crm/novo'), { name: 'crm-new' });
  assert.deepEqual(parseRoute('#/aprovacoes'), { name: 'approvals' });
  assert.deepEqual(parseRoute('#/crm/registro/crm%3Aabc-123'), { name: 'crm-record', id: 'crm:abc-123' });

  for (const rota of [{ name: 'overview' }, { name: 'crm-list' }, { name: 'crm-new' }, { name: 'approvals' }, { name: 'crm-record', id: 'crm:abc/123 ?#' }]) {
    assert.deepEqual(parseRoute(buildHash(rota)), rota, JSON.stringify(rota));
  }
  assert.equal(buildHash({ name: 'crm-record', id: 'crm:a/b' }), '#/crm/registro/crm%3Aa%2Fb');
  assert.equal(buildHash({ name: 'qualquer' }), '#/');
  assert.equal(buildHash(undefined), '#/');

  for (const estranho of ['#/xyz', '#/crm/outro', '#/crm/registro', '#/crm/registro/', '#/crm/registro/%20', '#/crm/registro/%E0%A4%A', '#/crm/registro/a/b', '#/crm/novo/x', '#/aprovacoes/x', '#//crm', '#/CRM', 'javascript:alert(1)']) {
    assert.deepEqual(parseRoute(estranho), { name: 'not-found' }, estranho);
  }
  for (const naoTexto of [undefined, null, 42, {}]) assert.deepEqual(parseRoute(naoTexto), { name: 'overview' }, 'sem fragmento = Visão Geral');

  assert.equal(sectionOf({ name: 'crm-list' }), 'crm');
  assert.equal(sectionOf({ name: 'crm-new' }), 'crm');
  assert.equal(sectionOf({ name: 'crm-record', id: 'x' }), 'crm');
  assert.equal(sectionOf({ name: 'approvals' }), 'approvals');
  assert.equal(sectionOf({ name: 'overview' }), 'overview');
  assert.equal(sectionOf({ name: 'not-found' }), null);
  assert.equal(sectionOf(undefined), null);
});

test('[DASH-MODEL-14] browserNavigation: subscribe/unsubscribe, go muda o fragmento (o hashchange chega depois) e replace troca a entrada do histórico avisando na hora — o window só é tocado enquanto há assinantes', async () => {
  const { browserNavigation } = await loadRouter();
  const browser = createBrowser({ hash: '#/crm' });
  const navigation = browserNavigation(browser.window);
  assert.equal(navigation.current(), '#/crm');

  const avisos = [];
  const parar = navigation.subscribe(() => avisos.push(navigation.current()));
  assert.equal(browser.window._listeners.size, 1);
  navigation.go('#/aprovacoes');
  assert.deepEqual(avisos, [], 'assíncrono');
  await browser.flush();
  assert.deepEqual(avisos, ['#/aprovacoes']);
  navigation.replace('#/');
  assert.deepEqual(avisos, ['#/aprovacoes', '#/'], 'replace avisa na hora');

  const segundo = [];
  const pararSegundo = navigation.subscribe(() => segundo.push(1));
  assert.equal(browser.window._listeners.size, 1, 'um único ouvinte no window, mesmo com dois assinantes');
  parar();
  navigation.go('#/crm');
  await browser.flush();
  assert.equal(avisos.length, 2, 'quem parou de assinar não é mais avisado');
  assert.equal(segundo.length, 1);
  pararSegundo();
  assert.equal(browser.window._listeners.size, 0, 'sem assinantes, o window fica sem ouvinte');
});
