# 0004 — Pesquisa Web Controlada (Especificação)

## Status

Especificado (documentação conceitual). **Nenhuma pesquisa real na internet foi implementada ou executada.** Nenhuma empresa real foi pesquisada. Registrado em 2026-09-16, com base em [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md), [RULES.md](../../RULES.md), [docs/architecture/README.md](../architecture/README.md), [0002-execution-architecture.md](./0002-execution-architecture.md), [0003-research-prospector-module.md](./0003-research-prospector-module.md), e no código já existente em `src/research-prospector/` e `tests/research-prospector/` (23 testes, todos passando, confirmados antes deste documento).

## Contexto

O Passo 1.0 criou a estrutura técnica local do módulo RESEARCH + PROSPECTOR (`createCandidate`, `checkDuplicate`, `checkDoNotContact`, `runPipeline`), mas a etapa `research()` do pipeline é hoje um placeholder — não pesquisa nada de verdade, apenas repassa o candidato adiante. Este documento especifica **como** essa etapa deverá pesquisar informação pública real quando for implementada, sem ainda implementá-la.

## Problema

Sem uma especificação prévia, uma implementação futura de pesquisa real corre o risco de: inventar dados quando uma fonte não responde; presumir telefone/WhatsApp/e-mail a partir de outro dado; perder rastreabilidade de onde e quando cada informação foi encontrada; ou depender de uma ferramenta paga sem que isso passe por decisão humana.

## Decisão

Adotar a arquitetura abaixo como especificação obrigatória para uma futura implementação da camada de pesquisa real. Nenhuma parte é implementada nesta etapa.

---

## 1. Objetivo da pesquisa

Encontrar e/ou confirmar, exclusivamente a partir de fontes públicas e permitidas, quando disponível: nome da empresa, site, Instagram, Google Perfil/Maps, telefone público, WhatsApp público, e-mail comercial público, cidade, estado, nicho, e informações relevantes para a pesquisa comercial (ex.: atividade recente, sinais de maturidade digital) — sempre com fontes e data de pesquisa registradas. **Nunca inventar informação** — regra herdada das duas Skills nativas (SDR e Raio-X Engine) e da Regra 1 do [RULES.md](../../RULES.md).

## 2. Fontes

| Fonte | O que pode ser encontrado | Confiabilidade relativa | Limitações | Quando utilizar | Registro da fonte | Registro da data | Bloqueio/indisponibilidade |
|---|---|---|---|---|---|---|---|
| Busca na web (motor de busca) | Ponto de partida para localizar site, redes e menções públicas | Média — depende do que o resultado aponta | Resultados podem estar desatualizados ou ambíguos | Primeira etapa, para localizar as demais fontes | URL do resultado usado | Data da busca | Se a busca não retornar nada relevante, registrar como fonte consultada sem resultado — nunca inventar um resultado |
| Site oficial | Serviços, contato, endereço, atualidade | Alta — fonte primária da própria empresa | Pode não existir; pode estar desatualizado ou fora do ar | Sempre que uma URL de site for encontrada | URL exata da página consultada | Data da consulta | Site fora do ar/erro 404: registrar como indisponível na data, nunca simular conteúdo |
| Google Perfil da Empresa / Maps | Endereço, avaliações, categoria, telefone público | Alta para dados operacionais (endereço, categoria) | Pode não existir para autônomos/profissionais liberais | Sempre que o nicho tiver presença local relevante | URL/identificador do perfil | Data da consulta | Perfil inexistente: registrar ausência, não presumir endereço |
| Instagram | Atividade, bio, contato, frequência de posts | Média — depende de quão ativo/verificável é o perfil | Perfis privados limitam a leitura pública | Quase sempre relevante para os nichos atuais (Psicologia) | URL do perfil | Data da consulta | Perfil privado/bloqueado: registrar como não acessível, nunca supor conteúdo |
| Facebook | Atividade, avaliações, contato institucional | Média, decrescente em alguns nichos | Uso desigual entre nichos | Quando complementar ao Instagram/site | URL da página | Data da consulta | Página inexistente/indisponível: registrar como tal |
| LinkedIn | Cargo, formação, atividade profissional | Alta para dados profissionais B2B | Menos relevante para autônomos B2C (ex.: psicólogos individuais) | Nichos com componente profissional/corporativo mais forte | URL do perfil | Data da consulta | Perfil não encontrado: registrar ausência |
| YouTube | Conteúdo, frequência, alcance aparente | Média | Nem todo nicho usa este canal | Quando houver canal identificável | URL do canal | Data da consulta | Canal inexistente: registrar ausência |
| Outras fontes públicas relevantes | Contexto adicional específico do nicho | Variável — avaliar caso a caso antes de usar | Deve ser julgada como confiável antes do uso (mesma regra da Skill Raio-X, seção 19 dela) | Quando as fontes acima não cobrirem uma lacuna relevante | URL ou descrição precisa da fonte | Data da consulta | Fonte duvidosa: não usar, ou usar e marcar como HIPÓTESE/NÃO VERIFICADO conforme seção 5 |

**Regra fixa:** nenhuma informação pode ser atribuída a uma fonte que não foi realmente consultada. Se uma fonte não foi acessada, ela simplesmente não aparece na lista de "fontes consultadas" daquele candidato.

## 3. Método de pesquisa (pipeline)

```
INPUT
↓
BUSCA
↓
IDENTIFICAÇÃO
↓
CONFIRMAÇÃO
↓
NORMALIZAÇÃO
↓
DUPLICIDADE
↓
DO NOT CONTACT
↓
VALIDAÇÃO
↓
RESULTADO
```

- **INPUT:** recebe o critério de pesquisa (nome/empresa conhecido, ou um candidato já parcialmente identificado) — reaproveita `createCandidate()` (já implementado) para garantir o formato mínimo.
- **BUSCA:** percorre as fontes da seção 2, na ordem de prioridade documentada em 0003 (site oficial → Google Perfil/Maps → Instagram → Facebook → LinkedIn → YouTube → outras), registrando o que foi de fato consultado.
- **IDENTIFICAÇÃO:** a partir do que a busca retornou, identifica candidatos a valor para cada campo (ex.: um número de telefone encontrado no rodapé do site).
- **CONFIRMAÇÃO:** confronta o valor identificado com pelo menos a fonte de origem antes de aceitá-lo — nenhum valor é aceito sem essa checagem mínima (ver seção 5, sobre múltiplas fontes/conflito).
- **NORMALIZAÇÃO:** reaproveita `normalize.js` (já implementado) para gerar as chaves de comparação (domínio, telefone, Instagram, nome+cidade) usadas nas duas etapas seguintes.
- **DUPLICIDADE:** reaproveita `checkDuplicate()` (já implementado) contra os registros do CRM disponíveis/autorizados para esta consulta (leitura, nunca escrita) — ver seção 7.
- **DO NOT CONTACT:** reaproveita `checkDoNotContact()` (já implementado) antes de qualquer preparação para contato — ver seção 8.
- **VALIDAÇÃO:** aplica os invariantes já existentes em `pipeline.js` (empresa presente, `statusValidacao` nunca setado pelo próprio módulo) mais os novos invariantes de confiabilidade da seção 5 (nunca aceitar valor sem fonte registrada).
- **RESULTADO:** a mesma saída estruturada já definida em 0003 (seção 6), com o acréscimo do detalhamento de fontes por campo (seção 10 deste documento).

## 4. Confiabilidade

| Situação | Classificação |
|---|---|
| Informação encontrada diretamente em fonte oficial (ex.: telefone no site oficial da empresa) | **VALIDADO** |
| Informação encontrada apenas em fonte pública secundária (ex.: telefone citado em um diretório de terceiros, não confirmado no site/Instagram da própria empresa) | **HIPÓTESE** — precisa de confirmação adicional antes de virar VALIDADO |
| Informação confirmada em múltiplas fontes independentes e coerentes entre si | **VALIDADO**, com todas as fontes registradas |
| Informação conflitante entre fontes (ex.: dois telefones diferentes) | Nenhuma das duas vira VALIDADO sozinha — ambas são registradas, cada uma com sua fonte, e o campo entra como **HIPÓTESE** com a contradição explicitada em Observações; a resolução fica para revisão humana |
| Informação não encontrada em nenhuma fonte consultada | **NÃO VERIFICADO** |

**Regra fixa:** ausência de informação nunca vira suposição. Um campo não encontrado permanece `null` com confiança `NAO_VERIFICADO` — nunca é preenchido com um valor "provável".

## 5. Telefone / WhatsApp / E-mail

- **Telefone:** só é registrado se encontrado literalmente em uma fonte pública consultada (site, Google Perfil, Instagram, etc.). Nunca derivado de outro dado.
- **WhatsApp:** só é marcado como disponível se houver evidência pública direta disso (ex.: um link `wa.me/...` ou texto explícito "agende pelo WhatsApp" associado a um número). **Nunca presumido a partir de um telefone comum** — ter telefone não implica ter WhatsApp naquele número.
- **E-mail:** só é registrado se encontrado literalmente em uma fonte pública. **Nunca gerado por padrão** (ex.: nunca compor `contato@dominio.com` só porque o domínio existe).
- Nenhuma transformação implícita é permitida: site → telefone presumido, nome → e-mail presumido, telefone → WhatsApp presumido são todas **proibidas**.
- Sem evidência direta, o campo correspondente permanece `null` com confiança `NAO_VERIFICADO` — nunca `HIPÓTESE` "porque é comum ter WhatsApp hoje em dia" ou raciocínio equivalente.

## 6. Duplicidade

A verificação de duplicidade (regra oficial: domínio → telefone → Instagram → nome+cidade, já implementada em `checkDuplicate()`) acontece **depois** da etapa de Normalização e **antes** da Validação final, dentro do próprio pipeline de pesquisa — o mesmo ponto onde já acontece hoje no pipeline técnico do Passo 1.0 (`duplicateCheckStage`). Nesta fase, a verificação consulta apenas os dados de CRM já disponíveis/autorizados para a execução (uma leitura pontual, nunca uma escrita); o módulo **não altera o CRM automaticamente** em nenhuma circunstância — criar ou corrigir um registro continua sendo decisão humana, conforme já definido em 0002 e 0003.

## 7. DO NOT CONTACT

Antes de qualquer preparação para contato, a pesquisa real deve rodar a mesma proteção já implementada (`checkDoNotContact()`), que casa a identidade do candidato contra qualquer um dos 4 critérios de identidade — não só o canal usado originalmente para marcar a restrição. Se houver match: excluir da lista de candidatos preparados para contato; não procurar outro canal; não contornar; não criar outro registro (mesmas regras já fixadas em 0003, seção 5).

**Quando o CRM estiver conectado de verdade (leitura real via API/MCP):** a lista de registros `DO NOT CONTACT` passa a vir diretamente do Notion em tempo de consulta, nunca de uma cópia local estática — reaproveitando o mesmo princípio de "nunca duplicar fonte de verdade" já registrado em 0002. Antes de qualquer execução real de pesquisa, o módulo deve obter a leitura mais atual possível do CRM; uma leitura desatualizada é preferível a nenhuma leitura, mas nunca deve ser tratada como garantia absoluta — é responsabilidade humana confirmar `DO NOT CONTACT` antes do envio real de qualquer mensagem (etapa que já exige aprovação humana, conforme 0002, seção 4).

## 8. Privacidade

A pesquisa se limita a informação pública, profissional/comercial, e necessária à finalidade comercial (mesma regra já fixada na Skill SDR, seção 12 dela, e na Regra 8 do RULES.md). Explicitamente fora de escopo, em qualquer circunstância:

- Senhas ou credenciais de qualquer tipo.
- Dados privados (não publicamente acessíveis).
- Informação pessoal não necessária à finalidade comercial (ex.: vida pessoal, família, opiniões não relacionadas ao negócio).
- Dados obtidos por invasão, bypass de autenticação, ou qualquer contorno de controle de acesso (ex.: perfil privado, área logada).
- Informação protegida por acesso privado de qualquer tipo.

## 9. Rastreabilidade

Cada informação relevante deve poder responder "onde" e "quando" foi encontrada. Formato de registro por campo pesquisado:

```
Fonte: <nome da fonte, ex.: "Instagram", "Site oficial">
URL: <endereço exato consultado>
Data da consulta: <ISO 8601>
Campo suportado: <qual campo do candidato essa fonte confirma>
Observação: <qualquer nota relevante — ex.: "citado apenas em diretório de terceiros", "conflita com o telefone do site">
```

Esse formato estende o campo `fontesConsultadas` já existente no modelo de dados (`candidate.js`), sem quebrar sua estrutura atual — cada entrada de `fontesConsultadas` passa a poder referenciar o campo específico que ela suporta.

## 10. Limitações

Situações abaixo **nunca** resultam em invenção de dado — sempre em registro explícito da limitação:

- Site fora do ar.
- Instagram bloqueado/privado.
- Google indisponível ou sem resultado.
- Página removida.
- Informação contraditória entre fontes (ver seção 4).
- Fonte visivelmente desatualizada.
- Empresa sem presença digital encontrável.
- Dados insuficientes para completar o candidato.

Em todos os casos, o campo afetado permanece `null`/`NAO_VERIFICADO`, e a limitação é registrada em Observações — nunca omitida silenciosamente.

## 11. Custo e ferramentas

O projeto prioriza, nesta fase: ferramentas já disponíveis no ambiente, recursos gratuitos, execução local, e APIs gratuitas apenas quando sua gratuidade for confirmada (nunca assumida). **Nenhuma ferramenta foi instalada e nenhuma assinatura foi contratada neste passo.** Qualquer necessidade futura de:

- uma API paga de busca/dados;
- um serviço de scraping de terceiros;
- uma ferramenta de enriquecimento de dados (ex.: um provedor de dados de empresas);

é **DECISÃO HUMANA NECESSÁRIA** antes de qualquer contratação ou integração — consistente com a lista de ações que sempre exigem aprovação humana já registrada em 0002 ("Contratar ferramentas", "Gastar dinheiro").

## 12. Primeiro teste real controlado (proposto, não executado)

Quando autorizado como etapa própria (fora deste passo):

- Usar **poucas empresas reais** (sugestão: 2 a 3), escolhidas manualmente por Breno, dentro do ICP já documentado (Psicologia, Petrópolis/RJ ou remoto).
- **Não criar nenhum registro no CRM** — resultado fica só como saída local (JSON), para inspeção manual.
- **Não enviar nenhuma mensagem** e **não contatar** nenhuma das empresas testadas.
- Registrar todas as fontes efetivamente consultadas, com URL e data, para cada uma das empresas de teste.
- Permitir auditoria manual: Breno (ou quem ele designar) confere manualmente cada dado encontrado contra a fonte indicada.
- Comparar o dado extraído com o que está realmente na fonte, um a um, antes de considerar o teste bem-sucedido.
- Validar duplicidade rodando o teste contra uma cópia de leitura do CRM real (sem escrever nada).
- Validar `DO NOT CONTACT` incluindo, no conjunto de teste, pelo menos uma empresa fictícia marcada como `DO NOT CONTACT` para confirmar que ela é corretamente excluída.

Este teste **não foi executado nesta etapa** — é apenas a proposta de como ele deverá ser conduzido quando autorizado.

## 13. Testes automatizados propostos para a futura camada de pesquisa

Nenhum destes foi implementado; ficam aqui como especificação, seguindo o mesmo padrão dos testes já existentes em `tests/research-prospector/`:

| Caso | O que o teste deve confirmar |
|---|---|
| Fonte oficial | Dado encontrado em fonte oficial é classificado como VALIDADO |
| Fonte secundária | Dado encontrado só em fonte secundária é classificado como HIPÓTESE, não VALIDADO |
| Fonte indisponível | Fonte fora do ar/inacessível é registrada como tal, sem gerar dado nenhum |
| Informação ausente | Campo não encontrado em nenhuma fonte fica `null` com NAO_VERIFICADO |
| Informação conflitante | Duas fontes com valores diferentes para o mesmo campo geram HIPÓTESE + registro da contradição, nunca escolha silenciosa de uma delas |
| Telefone encontrado | Telefone de fonte pública é aceito e associado à fonte exata |
| Telefone não encontrado | Nunca gera telefone derivado de outro campo (ex.: do domínio do site) |
| E-mail encontrado | E-mail de fonte pública é aceito e associado à fonte exata |
| E-mail não encontrado | Nunca gera e-mail padrão a partir do nome/domínio |
| Múltiplas fontes | Quando 2+ fontes confirmam o mesmo valor, o campo vira VALIDADO com todas as fontes listadas |
| URL inválida | URL malformada/inacessível é tratada como fonte não consultável, nunca derruba o pipeline nem gera dado falso |
| DO NOT CONTACT | Candidato correspondente a um registro DO NOT CONTACT nunca chega à lista final de contato (mesmo teste já validado no nível do pipeline técnico, reexecutado no contexto de pesquisa real) |
| Duplicidade | Resultado da pesquisa real é corretamente classificado (DUPLICADO/POSSÍVEL/NAO_VERIFICADO/NOVO) ao ser cruzado com uma base de CRM de teste |

## Consequências

- Existe uma especificação clara de como a pesquisa pública real deve funcionar antes de qualquer implementação, reduzindo o risco de invenção de dado ou de presunções entre campos (telefone→WhatsApp, site→e-mail).
- Fica definido que a confiabilidade de um dado depende de onde ele foi encontrado (fonte oficial vs. secundária vs. múltiplas fontes vs. conflito), não apenas de "foi encontrado ou não".
- Qualquer dependência de ferramenta paga fica bloqueada por aprovação humana antes de existir, coerente com o restante da arquitetura de autonomia já definida em 0002.

## Alternativas consideradas

- **Aceitar qualquer fonte secundária como VALIDADO, para simplificar.** Rejeitada: misturaria dado confirmado com dado apenas mencionado por terceiros, violando a disciplina de confiabilidade já usada pela Skill Raio-X Engine (DADO/ANÁLISE/HIPÓTESE/NÃO VERIFICADO).
- **Permitir inferência de WhatsApp a partir do telefone e de e-mail a partir do domínio, por serem "prováveis".** Rejeitada explicitamente na seção 5 — violaria a Regra 1 do RULES.md (não inventar) mesmo sendo uma inferência "razoável".
- **Adotar desde já uma API paga de enriquecimento de dados para acelerar a pesquisa.** Rejeitada nesta etapa: qualquer gasto ou nova assinatura é decisão humana, não técnica (seção 11).
