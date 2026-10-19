// A migration dos Clientes PF/PJ (supabase/migrations/20261020090000_crm_client_person_type.sql — CRM 5.0, Fase D2, decisão 0030). NÃO há PostgreSQL nesta fase: estes testes só LEEM o texto do arquivo e o
// confrontam com o contrato REAL do domínio (src/crm). Um AVALIADOR mínimo das expressões CHECK (lógica de TRÊS valores, como o SQL: um CHECK desconhecido APROVA a linha) prova que a restrição de coerência do
// BANCO concorda com a regra do DOMÍNIO em todas as combinações — e que a armadilha do NULL (`NULL = 'PF'`) é pega. Nenhuma rede, nenhum banco, nenhum dado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FIELD_COLUMNS } = require('../../src/crm-adapters/crmSupabaseMapping');
const { CRM_PERSON_FIELDS } = require('../../src/crm/constants');
const { resolvePersonFields, normalizeDocument } = require('../../src/crm/clientIdentity');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const NOME = '20261020090000_crm_client_person_type.sql';
const SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, NOME), 'utf8').replace(/\r\n/g, '\n');
const ORIGINAL_AUDITORIA = fs.readFileSync(path.join(MIGRATIONS_DIR, '20260928090000_crm_delete_audit.sql'), 'utf8').replace(/\r\n/g, '\n');
const read = (...partes) => fs.readFileSync(path.join(ROOT, ...partes), 'utf8');

const semComentarios = (texto) => texto.split('\n').map((linha) => linha.replace(/--.*$/, '')).join('\n');
// o texto sem os comentários e sem o CORPO das funções ($$ ... $$): o que sobra são os comandos da migration
const comandos = (texto) => semComentarios(texto).replace(/\$\$[\s\S]*?\$\$/g, '$$$$');
const corpoDaFuncao = (texto) => /\$\$([\s\S]*?)\$\$/.exec(semComentarios(texto))[1];

test('[MIG-PERSON-1] o arquivo existe, segue a convenção do CLI do Supabase, vem depois da D1.1 e se declara NÃO APLICADA, com a ordem segura e o desfazer', () => {
  assert.match(NOME, /^\d{14}_[a-z0-9_]+\.sql$/);
  const todas = fs.readdirSync(MIGRATIONS_DIR).filter((nome) => nome.endsWith('.sql')).sort();
  assert.equal(todas.at(-2), NOME, 'só a do prazo indeterminado (D3) é mais nova');
  assert.equal(todas.at(-1), '20261021090000_crm_negotiation_indefinite_term.sql');
  assert.equal(todas.at(-3), '20261019090000_crm_negotiations.sql', 'logo depois das Negociações (D1.1)');
  assert.match(SQL.split('\n').slice(0, 8).join('\n'), /NÃO APLICADA/);
  assert.match(SQL, /decisão 0030/);
  assert.match(SQL, /Aplicar é uma ação humana e consciente do proprietário/);
  assert.match(SQL, /ORDEM SEGURA DE IMPLANTAÇÃO/);
  assert.match(SQL, /PARAR o servidor operacional/);
  assert.match(SQL, /DESFAZER/);
  assert.match(SQL, /O código novo grava as quatro colunas em TODO registro/, 'avisa que o código novo exige a migration antes');
});

test('[MIG-PERSON-2] ADITIVA: só quatro colunas novas em crm_records (nomes = os do mapeamento do adapter), nenhum DROP de tabela/coluna, nenhum TRUNCATE/DELETE/UPDATE e nenhum dado inserido fora do corpo da função', () => {
  const c = comandos(SQL);
  const adds = [...c.matchAll(/ADD COLUMN\s+(\w+)\s+(\w+)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(adds, [['tipo_pessoa', 'TEXT'], ['nome_completo', 'TEXT'], ['cpf', 'TEXT'], ['cnpj', 'TEXT']]);
  assert.deepEqual(adds.map(([nome]) => nome), CRM_PERSON_FIELDS.map((campo) => FIELD_COLUMNS[campo]), 'os mesmos nomes de coluna que o adapter grava');
  for (const proibido of [/\bDROP\s+TABLE\b/i, /\bDROP\s+COLUMN\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+public\./i, /\bINSERT\s+INTO\b/i, /\bDROP\s+INDEX\b/i, /\bCREATE\s+TABLE\b/i, /\bCREATE\s+POLICY\b/i]) {
    assert.doesNotMatch(c, proibido, String(proibido));
  }
  assert.equal([...c.matchAll(/ALTER TABLE public\.(\w+)/g)].every((m) => m[1] === 'crm_records'), true, 'só crm_records é alterada');
  assert.doesNotMatch(c, /crm_funnel|crm_negotiation|crm_services|crm_niches|crm_lead_origins|prospecting_/, 'nada de funis, negociações, catálogos nem prospecção');
});

test('[MIG-PERSON-3] o PRIMEIRO comando confere os pré-requisitos e ABORTA (crm_records, a auditoria de exclusão e a função) — ou se a migration já foi aplicada; nada é alterado antes disso', () => {
  const sem = semComentarios(SQL).trim();
  assert.match(sem, /^DO \$\$/, 'o primeiro comando é o bloco de pré-requisitos');
  const bloco = /^DO \$\$([\s\S]*?)\$\$;/.exec(sem)[1];
  assert.match(bloco, /to_regclass\('public\.crm_records'\) IS NULL/);
  assert.match(bloco, /to_regclass\('public\.crm_record_deletions'\) IS NULL/);
  assert.match(bloco, /to_regprocedure\('public\.delete_crm_record_with_audit\(text,text,text,text,text\)'\) IS NULL/);
  assert.match(bloco, /column_name IN \('tipo_pessoa', 'nome_completo', 'cpf', 'cnpj'\)/);
  assert.match(bloco, /esta migration já foi aplicada/);
  assert.match(bloco, /to_regclass\('public\.crm_records_seq_seq'\) IS NULL OR to_regclass\('public\.crm_record_deletions_id_seq'\) IS NULL OR to_regprocedure\('public\.crm_records_bump_version\(\)'\) IS NULL/, 'a seção de privilégios nomeia sequências e uma função: o pré-requisito as confere');
  assert.equal([...bloco.matchAll(/RAISE EXCEPTION/g)].length, 4);
  assert.doesNotMatch(bloco, /ALTER|CREATE|DROP|INSERT|UPDATE|DELETE/);
  assert.ok(sem.indexOf('ADD COLUMN') > sem.indexOf('DO $$'), 'as colunas só vêm depois da conferência');
});

test('[MIG-PERSON-4] as restrições de FORMATO batem com a validação do domínio: tipo PF/PJ/NULL, nome completo não vazio, CPF de 11 dígitos e CNPJ de 12 caracteres 0-9/A-Z + 2 dígitos', () => {
  assert.match(SQL, /crm_records_tipo_pessoa_check\s+CHECK \(tipo_pessoa IS NULL OR tipo_pessoa IN \('PF', 'PJ'\)\)/);
  assert.match(SQL, /crm_records_nome_completo_check\s+CHECK \(nome_completo IS NULL OR btrim\(nome_completo\) <> ''\)/);
  const cpf = /crm_records_cpf_check\s+CHECK \(cpf IS NULL OR cpf ~ '([^']+)'\)/.exec(SQL);
  const cnpj = /crm_records_cnpj_check\s+CHECK \(cnpj IS NULL OR cnpj ~ '([^']+)'\)/.exec(SQL);
  assert.ok(cpf && cnpj, 'as duas restrições de formato existem');
  const reCpf = new RegExp(cpf[1]);
  const reCnpj = new RegExp(cnpj[1]);
  // o que o DOMÍNIO aceita e guarda (normalizado) sempre passa na restrição do banco...
  for (const valido of ['529.982.247-25', '111.444.777-35']) assert.match(normalizeDocument(valido), reCpf, valido);
  for (const valido of ['11.222.333/0001-81', '12.ABC.345/01DE-35', '12abc34501de35']) assert.match(normalizeDocument(valido), reCnpj, valido);
  // ...e o que o banco recusa o domínio também nunca guardaria (tamanho e alfabeto)
  for (const ruim of ['5299822472', '529982247250', '5299822472X', '529.982.247-25']) assert.doesNotMatch(ruim, reCpf, ruim);
  for (const ruim of ['1122233300018', '112223330001811', '1122233300018A', '11.222.333/0001-81', '12abc34501de35']) assert.doesNotMatch(ruim, reCnpj, ruim);
});

// ---- um avaliador mínimo de CHECK, com a lógica de TRÊS valores do SQL (true, false, null=desconhecido) ----
function tokens(texto) {
  const out = [];
  const re = /\s*(\(|\)|'[^']*'|=|[A-Za-z_][A-Za-z_0-9]*)/gy;
  let m;
  while ((m = re.exec(texto)) !== null) out.push(m[1]);
  return out;
}
function avaliar(expressao, linha) {
  const t = tokens(expressao);
  let i = 0;
  const peek = () => t[i];
  const take = (esperado) => {
    const x = t[i];
    if (esperado && x !== esperado) throw new Error(`esperava ${esperado} e veio ${x}`);
    i += 1;
    return x;
  };
  const e3 = (a, b, op) => (op === 'AND' ? (a === false || b === false ? false : a === null || b === null ? null : true) : a === true || b === true ? true : a === null || b === null ? null : false);
  function atom() {
    if (peek() === '(') {
      take('(');
      const v = or();
      take(')');
      return v;
    }
    const coluna = take();
    const valor = linha[coluna];
    if (peek() === '=') {
      take('=');
      const literal = take().slice(1, -1);
      return valor === null ? null : valor === literal;
    }
    take('IS');
    let nega = false;
    if (peek() === 'NOT') {
      take('NOT');
      nega = true;
    }
    if (peek() === 'DISTINCT') {
      take('DISTINCT');
      take('FROM');
      const literal = take().slice(1, -1);
      return nega ? valor === literal : valor !== literal;
    }
    take('NULL');
    return nega ? valor !== null : valor === null;
  }
  function and() {
    let v = atom();
    while (peek() === 'AND') {
      take('AND');
      v = e3(v, atom(), 'AND');
    }
    return v;
  }
  function or() {
    let v = and();
    while (peek() === 'OR') {
      take('OR');
      v = e3(v, and(), 'OR');
    }
    return v;
  }
  const resultado = or();
  assert.equal(i, t.length, 'a expressão foi lida inteira');
  return resultado;
}
const checkAprova = (resultado) => resultado !== false; // no SQL um CHECK desconhecido (NULL) APROVA a linha
const IDENTIFICACAO = (sql) => {
  const m = /ADD CONSTRAINT crm_records_identificacao_check CHECK \(([\s\S]*?)\n  \);/.exec(semComentarios(sql));
  assert.ok(m, 'a restrição de coerência existe');
  return m[1].replace(/\s+/g, ' ').trim();
};

function* combinacoes() {
  for (const tipo of [null, 'PF', 'PJ']) {
    for (const empresa of [null, 'Clínica X']) {
      for (const nome of [null, 'Maria Souza']) {
        for (const cpf of [null, '52998224725']) {
          for (const cnpj of [null, '11222333000181']) yield { tipo_pessoa: tipo, empresa, nome_completo: nome, cpf, cnpj };
        }
      }
    }
  }
}
function dominioAceita(linha) {
  try {
    const pessoa = resolvePersonFields({ tipoPessoa: linha.tipo_pessoa, nomeCompleto: linha.nome_completo, cpf: linha.cpf, cnpj: linha.cnpj }, 'createRecord');
    return pessoa.tipoPessoa === 'PF' || linha.empresa !== null;
  } catch {
    return false;
  }
}

test('[MIG-PERSON-5] PARIDADE banco x domínio: a restrição de coerência do banco aprova EXATAMENTE as combinações (tipo, empresa, nome completo, CPF, CNPJ) que o domínio aceita — as 48', () => {
  const expressao = IDENTIFICACAO(SQL);
  let total = 0;
  let aceitas = 0;
  for (const linha of combinacoes()) {
    total += 1;
    const banco = checkAprova(avaliar(expressao, linha));
    const dominio = dominioAceita(linha);
    if (banco) aceitas += 1;
    assert.equal(banco, dominio, `banco=${banco} domínio=${dominio} para ${JSON.stringify(linha)}`);
  }
  assert.equal(total, 48);
  assert.ok(aceitas > 0 && aceitas < total, `a restrição aceita ${aceitas} de ${total}: não é trivial`);
});

test('[MIG-PERSON-6] a ARMADILHA DO NULL: com `=` no lugar de `IS NOT DISTINCT FROM`, um registro SEM tipo e SEM empresa passaria no CHECK (NULL = \'PF\' é desconhecido e aprova) — o avaliador pega, e a migration usa a forma segura', () => {
  const expressao = IDENTIFICACAO(SQL);
  assert.match(expressao, /tipo_pessoa IS NOT DISTINCT FROM 'PF'/);
  assert.match(expressao, /tipo_pessoa IS NOT DISTINCT FROM 'PJ'/);
  assert.doesNotMatch(expressao, /tipo_pessoa = /);
  const mutante = expressao.replace(/IS NOT DISTINCT FROM/g, '=');
  const armadilha = { tipo_pessoa: null, empresa: null, nome_completo: 'Maria Souza', cpf: null, cnpj: null };
  assert.equal(checkAprova(avaliar(expressao, armadilha)), false, 'a migration recusa registro sem tipo, com nome completo e sem empresa');
  assert.equal(checkAprova(avaliar(mutante, armadilha)), true, 'o mutante o aprovaria (a armadilha)');
  const divergencias = [...combinacoes()].filter((linha) => checkAprova(avaliar(mutante, linha)) !== dominioAceita(linha));
  assert.ok(divergencias.length > 0, 'a paridade teria quebrado com o mutante');
});

test('[MIG-PERSON-7] todo registro que EXISTE hoje (tipo NULL, com empresa, sem os campos novos) satisfaz a restrição de coerência — a migration não invalida nenhuma linha', () => {
  const expressao = IDENTIFICACAO(SQL);
  const antigo = { tipo_pessoa: null, empresa: 'Clínica Antiga', nome_completo: null, cpf: null, cnpj: null };
  assert.equal(avaliar(expressao, antigo), true);
});

test('[MIG-PERSON-8] `empresa` deixa de ser NOT NULL (só isso muda nela): o DROP NOT NULL vem ANTES da restrição de coerência e a de formato original (btrim <> \'\') não é tocada', () => {
  const c = comandos(SQL);
  assert.match(c, /ALTER TABLE public\.crm_records ALTER COLUMN empresa DROP NOT NULL;/);
  assert.equal([...c.matchAll(/ALTER COLUMN/g)].length, 1, 'nenhuma outra coluna é alterada');
  assert.ok(c.indexOf('DROP NOT NULL') < c.indexOf('crm_records_identificacao_check'), 'o NOT NULL sai antes de a coerência entrar');
  assert.doesNotMatch(c, /btrim\(empresa\)/, 'a restrição de formato de empresa continua a original, fora desta migration');
});

test('[MIG-PERSON-9] AUDITORIA DA EXCLUSÃO: delete_crm_record_with_audit mantém assinatura, SECURITY INVOKER e o corpo de sempre — só o nome gravado muda para empresa OU nome completo — e o EXECUTE é nominal (só service_role)', () => {
  const nova = corpoDaFuncao(SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION')));
  const original = corpoDaFuncao(ORIGINAL_AUDITORIA.slice(ORIGINAL_AUDITORIA.indexOf('CREATE FUNCTION public.delete_crm_record_with_audit')));
  const limpo = (corpo) => corpo.split('\n').map((linha) => linha.trimEnd()).filter((linha) => linha !== '').join('\n');
  assert.equal(limpo(nova.replace('COALESCE(v_row.empresa, v_row.nome_completo)', 'v_row.empresa')), limpo(original), 'o corpo é o original, exceto pela expressão do nome');
  assert.match(nova, /COALESCE\(v_row\.empresa, v_row\.nome_completo\)/);
  assert.match(SQL, /CREATE OR REPLACE FUNCTION public\.delete_crm_record_with_audit\(\s*p_id TEXT,\s*p_deleted_by_user_id TEXT,\s*p_deleted_by_name TEXT,\s*p_deleted_by_role TEXT,\s*p_reason TEXT\s*\) RETURNS JSONB\s*LANGUAGE plpgsql\s*SECURITY INVOKER/);
  assert.doesNotMatch(SQL, /SECURITY DEFINER/);
  assert.match(SQL, /REVOKE ALL ON FUNCTION public\.delete_crm_record_with_audit\(TEXT, TEXT, TEXT, TEXT, TEXT\) FROM PUBLIC, anon, authenticated;/);
  assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.delete_crm_record_with_audit\(TEXT, TEXT, TEXT, TEXT, TEXT\) TO service_role;/);
  assert.ok(SQL.indexOf('CREATE OR REPLACE FUNCTION') < SQL.indexOf('REVOKE ALL ON FUNCTION'), 'o EXECUTE é restabelecido DEPOIS de recriar a função');
  assert.ok([...comandos(SQL).matchAll(/\bGRANT\b[^;]*;/g)].every((m) => /\bTO service_role;$/.test(m[0])), 'todo GRANT da migration é para service_role (nunca anon, authenticated ou PUBLIC)');
});

test('[MIG-PERSON-10] a RLS de crm_records (ligada, SEM policy) não é tocada: nenhuma policy criada/removida, RLS nem ligada nem desligada, nenhum GRANT a anon/authenticated/PUBLIC', () => {
  const c = comandos(SQL);
  assert.doesNotMatch(c, /GRANT[^;]*\b(anon|authenticated|PUBLIC)\b/);
  assert.doesNotMatch(c, /ENABLE ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|ALTER POLICY/);
});

// ---- os PRIVILÉGIOS (correção de segurança: o banco real concede SELECT/INSERT/UPDATE/DELETE a anon e authenticated em crm_records) ----
const REVOKE_TABELA = (nome) => `REVOKE ALL ON TABLE public.${nome} FROM PUBLIC, anon, authenticated;`;
const PRIVILEGIOS = [
  REVOKE_TABELA('crm_records'),
  'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_records TO service_role;',
  REVOKE_TABELA('crm_record_deletions'),
  'GRANT SELECT, INSERT ON TABLE public.crm_record_deletions TO service_role;',
  'REVOKE ALL ON SEQUENCE public.crm_records_seq_seq FROM PUBLIC, anon, authenticated;',
  'GRANT USAGE, SELECT ON SEQUENCE public.crm_records_seq_seq TO service_role;',
  'REVOKE ALL ON SEQUENCE public.crm_record_deletions_id_seq FROM PUBLIC, anon, authenticated;',
  'GRANT USAGE, SELECT ON SEQUENCE public.crm_record_deletions_id_seq TO service_role;',
  'REVOKE ALL ON FUNCTION public.crm_records_bump_version() FROM PUBLIC, anon, authenticated;',
];

test('[MIG-PERSON-13] PRIVILÉGIOS: crm_records e a auditoria perdem TODO acesso direto de PUBLIC, anon e authenticated (nominalmente, os três) e o service_role fica com o que o servidor usa; o mesmo para as duas sequências e a função de gatilho — o conjunto EXATO de comandos', () => {
  const c = comandos(SQL);
  const achados = [...c.matchAll(/\b(?:REVOKE|GRANT)\b[^;]*;/g)].map((m) => m[0].replace(/\s+/g, ' ').trim());
  const doSql = achados.filter((comando) => !/delete_crm_record_with_audit/.test(comando));
  assert.deepEqual(doSql, PRIVILEGIOS, 'exatamente estes REVOKE/GRANT (fora os da função de exclusão), nesta ordem');
  for (const comando of PRIVILEGIOS) assert.ok(SQL.includes(comando), comando);
  // todo REVOKE nomeia os TRÊS: PUBLIC, anon e authenticated (REVOKE FROM PUBLIC sozinho não retira as concessões explícitas do Supabase)
  for (const revoke of achados.filter((comando) => comando.startsWith('REVOKE'))) assert.match(revoke, /FROM PUBLIC, anon, authenticated;$/, revoke);
  // nunca se revoga nada de service_role
  assert.doesNotMatch(c, /REVOKE[^;]*service_role/);
  // ordem: o corpo novo da função de exclusão e os privilégios vêm DEPOIS de a coluna e a restrição existirem
  assert.ok(c.indexOf('crm_records_identificacao_check') < c.indexOf('REVOKE ALL ON TABLE public.crm_records'));
  // sem DROP/CREATE de tabela, sem alterar dado, sem tocar na RLS
  assert.doesNotMatch(c, /ALTER TABLE public\.crm_record_deletions|ALTER TABLE public\.crm_records ENABLE|ALTER TABLE public\.crm_records DISABLE/);
});

test('[MIG-PERSON-14] os privilégios são MÍNIMOS e o backend não depende de anon/authenticated: todo acesso a tabelas do CRM no servidor é pelo PostgREST com a chave service_role; a chave anon só autentica', () => {
  const ler = (...partes) => fs.readFileSync(path.join(ROOT, ...partes), 'utf8');
  // o cliente PostgREST dos adapters manda a chave de SERVIÇO (apikey e Bearer); nenhuma chave anon passa por ele
  const cliente = ler('src', 'crm-adapters', 'postgrestClient.js');
  assert.match(cliente, /apikey: serviceRoleKey, Authorization: `Bearer \$\{serviceRoleKey\}`/);
  assert.doesNotMatch(cliente, /ANON/i);
  const config = ler('src', 'crm-adapters', 'crmSupabaseConfig.js');
  assert.match(config, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(config, /ANON/i);
  // a chave anon só existe na autenticação (auth.getUser/getSession), nunca num acesso a tabela
  const auth = ler('src', 'auth', 'authAdapter.js');
  assert.doesNotMatch(auth, /\.from\(|rest\/v1/);
  // o navegador usa o SDK só para autenticar; nenhuma consulta a tabela no Dashboard
  const principal = ler('dashboard', 'main.mjs');
  assert.doesNotMatch(principal, /\.from\(['"]|rest\/v1/);
  // e a única chave que o servidor entrega ao navegador é a anon (já pública por definição); a de serviço nunca
  assert.doesNotMatch(ler('src', 'server', 'index.js').split('\n').filter((linha) => /publicConfig/.test(linha)).join('\n'), /service/i);
});

test('[MIG-PERSON-11] NADA EXECUTA a migration: nenhum arquivo de src/ ou scripts/ a lê ou a cita, e o package.json não tem script de migration; só testes a leem', () => {
  const procurar = (pasta) => {
    const alvo = path.join(ROOT, pasta);
    if (!fs.existsSync(alvo)) return [];
    const achados = [];
    const andar = (dir) => {
      for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
        const completo = path.join(dir, entrada.name);
        if (entrada.isDirectory()) andar(completo);
        else if (/\.(js|mjs|cjs)$/.test(entrada.name) && fs.readFileSync(completo, 'utf8').includes('crm_client_person_type')) achados.push(path.relative(ROOT, completo));
      }
    };
    andar(alvo);
    return achados;
  };
  // (comentários de src/ podem CITAR o arquivo; o que conta é nenhum deles importar fs, processos ou drivers de banco, nem o dashboard)
  const mencionam = [...procurar('src'), ...procurar('scripts'), ...procurar('dashboard')];
  for (const arquivo of mencionam) {
    const fonte = read(arquivo);
    assert.doesNotMatch(fonte, /require\(['"](?:node:)?(?:fs|child_process|net|http|https)['"]\)|from ['"](?:node:)?(?:fs|child_process)['"]/, `${arquivo} cita a migration mas não pode lê-la nem executá-la`);
    assert.doesNotMatch(fonte, /supabase[\\/]migrations/, `${arquivo}: nenhum caminho da pasta de migrations`);
  }
  assert.equal(mencionam.filter((arquivo) => arquivo.startsWith('dashboard')).length, 0, 'o navegador nunca conhece a migration');
  assert.doesNotMatch(read('package.json'), /migrat|supabase db|psql/i);
});

test('[MIG-PERSON-12] a decisão 0030 existe, descreve a migration como NÃO APLICADA e registra as escolhas (empresa nullable, tipo não inferido, CNPJ alfanumérico, sem desativação)', () => {
  const decisao = read('docs', 'decisions', '0030-crm-clients-person-type.md');
  assert.match(decisao, /NÃO APLICADA/);
  assert.match(decisao, /crm_client_person_type/);
  assert.match(decisao, /nunca inferido|não é inferido|nunca se infere/i);
  assert.match(decisao, /alfanumérico/i);
  assert.match(decisao, /Desativar/);
});
