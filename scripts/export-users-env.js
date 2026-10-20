#!/usr/bin/env node
// Gera o valor da variável RIO_X7_USERS_JSON (instância hospedada, decisão 0033) a partir de um arquivo de usuários no formato de data/users.json — o MESMO conteúdo (mesmos userId, authUserId,
// papéis e status), sem criar nenhum usuário novo.
//
//   node scripts/export-users-env.js [caminho-do-arquivo]        (padrão: data/users.json)
//
// SAÍDA: só o valor (base64 do JSON, uma linha) vai para a saída padrão, para ser colado no painel da hospedagem (variável RIO_X7_USERS_JSON). A confirmação ("N usuário(s) validado(s)") vai
// para a saída de erro e nunca traz nome, e-mail nem identificador. O arquivo é validado pelas MESMAS regras do servidor (campos permitidos, papéis, status) antes de qualquer saída; qualquer
// defeito termina com código 1 e uma mensagem que não repete o conteúdo. Nada é gravado em disco por este script.
//
// ATENÇÃO: o valor contém os e-mails e identificadores dos usuários — trate-o como dado pessoal: cole-o só no painel da hospedagem; nunca em Git, chat, log ou relatório.

const fs = require('node:fs');
const path = require('node:path');

const { loadUsers } = require('../src/server/index');

function run(argv) {
  const file = path.resolve(process.cwd(), argv[0] || path.join(__dirname, '..', 'data', 'users.json'));
  let users;
  try {
    users = loadUsers(file);
  } catch (error) {
    return { code: 1, stderr: `${error.message}\n` };
  }
  // loadUsers valida (campos, papéis, status); o que vai para a variável é o JSON ORIGINAL do arquivo, campo a campo, sem acrescentar nada.
  const entries = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const value = Buffer.from(JSON.stringify(entries), 'utf8').toString('base64');
  return { code: 0, stdout: `${value}\n`, stderr: `${users.length} usuário(s) validado(s). Cole a linha acima em RIO_X7_USERS_JSON, só no painel da hospedagem.\n` };
}

if (module.id === '.') {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

module.exports = { run };
