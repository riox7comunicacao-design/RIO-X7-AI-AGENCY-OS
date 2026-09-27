// Configuração centralizada do futuro adapter Postgres/Supabase do CRM (decisão 0024, etapa 2; realocada para
// src/crm-adapters/ na etapa 2.1 — a configuração de infraestrutura mora com o adapter, nunca com o domínio).
//
// REGRAS que este arquivo nunca viola:
//   - só é lido por código de SERVIDOR (nada aqui é importável/usável pelo navegador — dashboard/ é ESM
//     separado e nunca importa nada de src/, como já vale para todo o resto do backend);
//   - a service_role NUNCA é logada, nunca aparece numa mensagem de erro, nunca tem valor de exemplo real em
//     nenhuma documentação (ver .env.example) — as mensagens abaixo citam só o NOME da variável ausente;
//   - ler esta configuração não tem NENHUM efeito sobre o CRM local (data/crm.json): nada a chama
//     automaticamente — só quem constrói explicitamente o adapter Supabase (crmSupabaseRepository.js) precisa
//     dela, e nada em src/server/ faz isso ainda (a fábrica de produção continua só com o arquivo local).
//
// SUPABASE_URL é a MESMA variável já usada pela autenticação (src/auth/authAdapter.js) — é o mesmo projeto
// Supabase, uma URL só. SUPABASE_SERVICE_ROLE_KEY é NOVA: nenhum outro código do projeto a lê hoje.

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

// Lança um erro CLARO citando só o NOME da variável que falta — nunca um valor, nem mesmo parcial.
function readSupabaseCrmConfig(env = process.env) {
  const rawUrl = env && isNonEmptyString(env.SUPABASE_URL) ? env.SUPABASE_URL.trim() : '';
  if (!rawUrl) {
    throw new Error('CRM (Supabase): SUPABASE_URL não está configurada.');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('CRM (Supabase): SUPABASE_URL não é uma URL válida.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('CRM (Supabase): SUPABASE_URL deve ser https.');
  }

  const serviceRoleKey = env && isNonEmptyString(env.SUPABASE_SERVICE_ROLE_KEY) ? env.SUPABASE_SERVICE_ROLE_KEY.trim() : '';
  if (!serviceRoleKey) {
    throw new Error(
      'CRM (Supabase): SUPABASE_SERVICE_ROLE_KEY não está configurada (necessária só para o adapter Postgres do CRM — não para o CRM local em data/crm.json).'
    );
  }

  return Object.freeze({ url: rawUrl.replace(/\/+$/, ''), serviceRoleKey });
}

// Versão que nunca lança — para composição futura decidir "existe configuração Supabase para o CRM?" sem ter
// que capturar exceção. Mesmo padrão de isSupabaseConfigured() em src/auth/authAdapter.js.
function isSupabaseCrmConfigured(env = process.env) {
  try {
    readSupabaseCrmConfig(env);
    return true;
  } catch {
    return false;
  }
}

module.exports = { readSupabaseCrmConfig, isSupabaseCrmConfigured };
