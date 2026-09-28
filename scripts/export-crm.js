// scripts/export-crm.js — export lógico, SOMENTE LEITURA, de public.crm_records (Supabase) para um arquivo JSON
// local em backups/crm/ (etapa 3L, docs/operations/crm-data-policy.md).
//
// NÃO é um backup do arquivo local (data/crm.json) nem uma migração — é uma cópia lógica dos registros que hoje
// vivem no Supabase, para um caminho de recuperação futuro. Restauração/importação ainda NÃO existe (de propósito
// — ver a política); este script nunca ganha uma função de import.
//
// READ-ONLY por construção: usa createConfiguredCrmRepository (a MESMA fábrica de composição que
// src/server/index.js usa — nada duplicado aqui), forçando REPOSITORY_MODE=supabase só DENTRO da configuração
// passada a esta chamada, neste processo — nunca escrito em .env. Isso reaproveita toda a validação de
// configuração (readSupabaseCrmConfig, que exige SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY e nunca lança um valor,
// só o nome da variável ausente) e o adapter real (createSupabaseCrmRepository). O script só chama list() — o
// único método que faz uma requisição, e é sempre um GET (ver src/crm-adapters/crmSupabaseRepository.js) — nunca
// getById()/save(), então nenhum método HTTP mutável é usado aqui.
//
// SEGREDO: a service_role nunca é impressa, nunca escrita no arquivo de export, nunca sai deste processo além do
// cabeçalho Authorization que o adapter já monta (e que este script não vê — ele só chama repository.list()).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createConfiguredCrmRepository } = require('../src/services/crmRepositoryFactory');

const ROOT = path.join(__dirname, '..');
const DEFAULT_BACKUP_DIR = path.join(ROOT, 'backups', 'crm');

// crm-export-YYYYMMDD-HHmmss.json — sempre em UTC, para não depender do fuso da máquina que roda o export.
function nomeDoArquivo(data) {
  const pad = (numero) => String(numero).padStart(2, '0');
  const dataParte = `${data.getUTCFullYear()}${pad(data.getUTCMonth() + 1)}${pad(data.getUTCDate())}`;
  const horaParte = `${pad(data.getUTCHours())}${pad(data.getUTCMinutes())}${pad(data.getUTCSeconds())}`;
  return `crm-export-${dataParte}-${horaParte}.json`;
}

// { env }: de onde ler SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY (padrão: process.env; nunca .env é escrito).
// { outDir }: onde salvar o arquivo (padrão: backups/crm/, fora do Git — ver .gitignore).
// { repository }: SÓ para teste — injeta um repositório (real ou fake) no lugar de construir um pela fábrica;
// nunca usado pela CLI real (main() abaixo nunca passa isto).
async function exportarCrm({ env = process.env, outDir = DEFAULT_BACKUP_DIR, repository } = {}) {
  const repo = repository || createConfiguredCrmRepository({ env: { ...env, REPOSITORY_MODE: 'supabase' } });
  const records = await repo.list();

  const agora = new Date();
  const payload = {
    format: 'rio-x7-crm-export',
    version: 1,
    source: 'supabase',
    table: 'public.crm_records',
    exportedAt: agora.toISOString(),
    recordCount: records.length,
    records,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const arquivo = path.join(outDir, nomeDoArquivo(agora));
  fs.writeFileSync(arquivo, JSON.stringify(payload, null, 2));
  return { arquivo, recordCount: records.length };
}

async function main() {
  try {
    const { arquivo, recordCount } = await exportarCrm();
    // Nunca imprimir os registros nem qualquer valor de configuração — só o que a etapa pediu.
    console.log('CRM export completed.');
    console.log(`Records exported: ${recordCount}`);
    console.log(`Output: ${arquivo}`);
  } catch (erro) {
    // As mensagens que podem chegar aqui (readSupabaseCrmConfig, ou o adapter recusando) já são garantidamente
    // sem segredo — nunca citam um valor, só o nome de uma variável ou o texto que o PostgREST devolveu.
    console.error(`CRM export failed: ${erro.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { exportarCrm, nomeDoArquivo, DEFAULT_BACKUP_DIR };
