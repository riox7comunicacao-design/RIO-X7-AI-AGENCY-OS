# 0005 — Correspondência Conservadora de Telefone e de Nome+Cidade

## Status

Implementado. Registrado em 2026-09-17, após o Passo 1.8 (teste de reentrada) ter encontrado duas fragilidades reais na normalização usada pela deduplicação.

## Contexto

O Passo 1.8 testou o mecanismo de deduplicação (especificado em [0003-research-prospector-module.md](./0003-research-prospector-module.md), seção 4, e implementado desde o Passo 1.0) contra variações realistas dos dados de um prospect real (Helena Duarte, criado no CRM no Passo 1.7). Dois problemas objetivos apareceram:

1. **Telefone:** `+55 24 98765-4321` e `(24) 98765-4321` são, na prática, o mesmo número — mas a normalização antiga só removia caracteres não numéricos, sem tratar o código de país `55` como opcional. Isso não chegou a causar uma falha visível no Passo 1.8 porque outros critérios (domínio, Instagram) cobriram o caso, mas o critério telefone, sozinho, teria falhado.
2. **Nome + cidade:** a comparação exigia igualdade exata de string. "Helena Duarte" e "Helena Duarte Psicóloga" — claramente a mesma pessoa, mesma cidade — foram classificadas como **NOVO** em vez de **POSSÍVEL_DUPLICADO**, violando a própria regra já documentada em 0003 ("não considerar novo automaticamente" quando há dúvida).

## Problema

Sem corrigir isso, o módulo poderia deixar passar prospects que já existem no CRM só porque o nome ou o formato do telefone variou ligeiramente entre a pesquisa e o registro original — na prática, uma falha de proteção contra duplicidade, o oposto do que o módulo existe para fazer.

## Decisão

Corrigir as duas normalizações de forma **conservadora**: preferir sempre um falso negativo (não detectar uma duplicidade real) a um falso positivo (fundir duas entidades diferentes por engano). A arquitetura de classificação em dois níveis, já definida em 0003, foi mantida sem alteração:

- **DUPLICADO** continua reservado exclusivamente para identificadores fortes e objetivos: domínio, telefone equivalente, ou Instagram equivalente.
- **POSSÍVEL_DUPLICADO** é o teto para qualquer correspondência baseada só em nome + cidade — nome nunca produz DUPLICADO sozinho, não importa quão forte pareça a semelhança.

## 1. Normalização de telefone

**Antes:** apenas removia caracteres não numéricos (`replace(/\D/g, '')`).

**Depois:** remove o prefixo de código de país `55` **apenas quando o comprimento total do número deixa isso objetivamente claro** — um número nacional brasileiro tem 10 dígitos (DDD + fixo de 8) ou 11 (DDD + celular de 9); com `55` na frente, o total sobe para exatamente 12 ou 13. Fora dessa condição de comprimento, nenhum dígito é removido.

```
normalizePhone("+55 24 98765-4321")  → "24987654321"
normalizePhone("(24) 98765-4321")     → "24987654321"   // mesmo resultado → equivalente
normalizePhone("5524987654321")       → "24987654321"
normalizePhone("+55 21 98765-4321")   → "21987654321"   // DDD diferente → NUNCA equivalente
normalizePhone("55988887777")         → "55988887777"   // DDD 55 real (RS) não é confundido com o código de país
```

Isso evita dois riscos opostos: (a) tratar números de DDDs diferentes como iguais, e (b) confundir um DDD que começa com "55" (ex.: região de Santa Maria/RS) com a presença do código de país — o comprimento total do número resolve essa ambiguidade sem suposição.

## 2. Normalização de nome + cidade

**Antes:** `trim()` + `toLowerCase()`, exigindo igualdade exata de string.

**Depois:** normalização conservadora em etapas fixas, documentadas e testadas:
1. Minúsculas e remoção de acentos.
2. Remoção de pontuação (mantendo espaços no lugar).
3. Colapso de espaços múltiplos.
4. Remoção de **no máximo um** título profissional no início, apenas se isolado como primeiro token: `dr`, `dra`, `prof`, `profa`.
5. Remoção de **no máximo um** qualificador profissional no final, apenas se isolado como último token: `psicologa`, `psicologo` (lista fixa, ligada ao nicho hoje ativo — não é uma lista genérica de profissões).

```
"Helena Duarte"              → "helena duarte"
"Helena Duarte Psicóloga"    → "helena duarte"   // qualificador removido → mesmo resultado
"Dra. Helena Duarte"         → "helena duarte"   // título removido → mesmo resultado
"Mariana Duarte"             → "mariana duarte"  // nome realmente diferente → nunca igual a "helena duarte"
"Helena Duarte Silva"        → "helena duarte silva"  // sobrenome real preservado → nunca igual a "helena duarte"
```

**O que a normalização NUNCA faz:**
- Não usa fuzzy matching (distância de edição, similaridade fonética, IA externa) — só remoção de um título e um qualificador de listas fixas.
- Não remove sobrenomes reais — "Silva" em "Helena Duarte Silva" não está em nenhuma lista de remoção, então permanece, e o nome deixa de coincidir com "Helena Duarte". Isso é uma escolha consciente: preferir um falso negativo (não detectar que talvez seja a mesma pessoa) a um falso positivo (assumir que duas pessoas com sobrenomes diferentes são a mesma).
- Não amplia a lista de títulos/qualificadores automaticamamente — qualquer adição futura a essas listas é uma decisão consciente, não um efeito colateral de um matching mais "esperto".

## Diferença entre DUPLICADO e POSSÍVEL_DUPLICADO (reafirmado)

| | DUPLICADO | POSSÍVEL_DUPLICADO |
|---|---|---|
| Critério | Domínio, telefone ou Instagram — correspondência exata após normalização objetiva | Nome + cidade — correspondência após normalização conservadora |
| Ação do sistema | Impede a criação de um novo registro | Sinaliza para revisão humana; nunca cria nem impede sozinho |
| Nível de confiança | Alto — identificador técnico difícil de coincidir por acaso | Moderado — nomes podem ser parecidos por coincidência real |

Essa distinção não mudou nesta correção — apenas a qualidade da normalização de cada critério individual melhorou.

## Assimetria consciente com DO NOT CONTACT

`checkDoNotContact()` (não alterado nesta correção) continua bloqueando com base em **qualquer** um dos 4 critérios de identidade, incluindo nome+cidade sozinho — diferente da deduplicação, que reserva DUPLICADO só para os 3 critérios fortes. Isso é intencional: errar bloqueando contato demais (falso positivo de bloqueio) é seguro — o pior caso é um prospect legítimo precisar de revisão manual antes de ser contatado. Errar não bloqueando um pedido real de "não me contate" (falso negativo de bloqueio) é o risco que a Regra 5 do [RULES.md](../../RULES.md) trata como inaceitável. Por isso a tolerância a falso positivo é invertida entre os dois mecanismos, de propósito.

## Testes

Adicionados sem remover ou enfraquecer nenhum teste existente:
- [tests/research-prospector/normalize.test.js](../../tests/research-prospector/normalize.test.js) — testes unitários de `normalizePhone` e `normalizeNameCity`.
- [tests/research-prospector/duplicateCheck.test.js](../../tests/research-prospector/duplicateCheck.test.js) — 7 novos testes de integração (`[1.9-A]` a `[1.9-G]`), cobrindo exatamente os cenários exigidos nesta correção.

Total: 23 testes originais + 14 novos = 37 testes, todos passando.

## Consequências

- A deduplicação agora reconhece variações realistas de telefone e nome que antes gerariam falsos "NOVO" — reduzindo o risco de recriar um prospect que já existe.
- A lista fixa de títulos/qualificadores é deliberadamente pequena hoje (ligada só a Psicologia); expandi-la para outros nichos no futuro é uma decisão consciente a ser tomada quando esses nichos forem ativados, não uma tarefa automática.
- Nenhuma escrita foi feita no CRM para validar esta correção — a verificação foi feita comparando os novos resultados com o registro real da Helena Duarte já existente, em modo leitura.

## Alternativas consideradas

- **Usar fuzzy matching (ex.: distância de Levenshtein) para nome.** Rejeitada: abriria a porta para falsos positivos entre pessoas com nomes parecidos mas diferentes (ex.: "Helena Duarte" e "Helena Nunis"), contrariando a regra central deste passo de preferir falso negativo a falso positivo.
- **Tratar qualquer prefixo de 2 dígitos como possível código de país.** Rejeitada: colidiria com DDDs reais que começam com "55" (ex.: região de Santa Maria/RS) — por isso a decisão de usar o comprimento total do número como condição, não apenas o prefixo.
- **Elevar nome+cidade a critério de DUPLICADO quando a correspondência for "muito forte".** Rejeitada: não existe um limiar objetivo e sem IA externa para medir "muito forte" sem introduzir julgamento subjetivo — a arquitetura de 0003 (nome+cidade nunca vira DUPLICADO sozinho) foi mantida integralmente.
