# 0021 — Researcher V1

## Status

Implementado em 2026-09-25, sobre o commit 282f63c. **Só o módulo e os testes:** nenhuma pesquisa real foi executada, nenhum lote foi criado, o `submitProspecting` não é chamado, não há rota, serviço, Dashboard, adaptador de rede nem alteração no CRM, na Approval Queue, no Promotion Service, no discovery, no dossiê ou no contrato `rawFinding V2` (0020). Nenhuma dependência nova.

## Auditoria (somente leitura) e conclusão

Auditados: `rawFindingSchema`, `rawFindingV2`, `signalSchema`, `dossier`, `dossierFromFinding`, `prospectingService`, `discovery`, `batchAccounting`, `normalize`, `pipeline` (o `research()` dele é um placeholder que não pesquisa nada; não foi tocado) e as decisões 0003, 0004, 0018, 0019 e 0020. O contrato V2 **já comporta** tudo o que o pesquisador precisa (evidências por canal em `campos`; observações do Instagram, CTA/formulário do site e anúncios em `dossie.fatos`; `motivo` para o não verificado; limites 150/5/25/10). **Nenhuma alteração de contrato foi necessária**, então não houve motivo para parar.

## Arquitetura

```
briefing --> [porta search] --> candidatos (agrupados por nome+cidade) --> [porta fetchPage] --> evidências e observações
                                                                           [porta lookupAds]        |
                                                                                                    v
                                                          rawFinding V2 (cada achado revalidado por validateRawFindingsV2) + relatório
```

`src/research-prospector/researcher.js` (`createResearcher(portas, { now, maxDurationMs }).research(briefing)`, assíncrono) e `researchPolicy.js` (política de fontes: funções puras). O Researcher **só importa irmãos** (`rawFindingSchema`, `rawFindingV2`, `signalSchema`, `normalize`, `researchPolicy`) e é puro: **sem rede, disco, CRM, fila, serviço, autorização, `process`, relógio próprio ou aleatoriedade** (o relógio é injetado). Nenhum outro módulo o conhece e o Prospecting Service não foi ligado a ele (testado).

Por que portas: o adaptador real (HTTP, navegador, robots.txt, taxa, timeout) é uma etapa futura e **não existe**; o Researcher decide **quais fontes valem e como uma observação vira evidência**, e as portas só entregam o que viram. A saída de toda porta é **dado não confiável**: lida só como dado puro (sem getter, sem Symbol, sem protótipo), com limites, e revalidada.

### Portas (contrato)

| Porta | Entrada | Saída |
|---|---|---|
| `search` | `{ consulta, limite }` | `{ ok: true, resultados: [{ nome, url, tipoResultado, fonteUrl, cidade?, estado?, tipo?, nicho? }] }` ou `{ ok: false, falha }` (até 300 resultados) |
| `fetchPage` | uma URL https pública | `{ ok: true, urlFinal, links: [{ href, texto? }], temFormularioContato?, perfil?: { privado?, postagens?, ctaBio? } }` ou `{ ok: false, falha }` |
| `lookupAds` (opcional) | `{ plataforma: META\|GOOGLE, nome, regiao? }` | `{ ok: true, url, anunciantes: [{ nome }] }` ou `{ ok: false, falha }` |

`tipoResultado` ∈ `SITE, GOOGLE_PERFIL, INSTAGRAM, FACEBOOK, LINKEDIN, YOUTUBE`. `falha` ∈ `FORA_DO_AR, PRIVADO, LOGIN, CAPTCHA, BLOQUEADO, ROBOTS, REMOVIDA, SEM_RESULTADO, DESATUALIZADA, TEMPO_ESGOTADO, ERRO`. **Contrato do adaptador futuro:** só páginas públicas por https; respeitar `robots.txt` (devolver `ROBOTS`); devolver `LOGIN`/`CAPTCHA`/`BLOQUEADO` em vez de tentar passar; limite de taxa e de tempo por chamada; nunca executar um login.

## Entrada e saída

Entrada: o briefing (`nicho`, `quantidadeDesejada` inteiro 1–1000, `regiao?`, `tipo?`; o mesmo que o Prospecting Service valida — quem chamar no futuro valida com `validateBriefing`). Saída: `{ ok: true, achados: [rawFinding V2], relatorio }` ou `{ ok: false, erro: { code }, achados: [], relatorio }` com `RESEARCHER_BRIEFING_INVALIDO` ou `RESEARCHER_BUSCA_FALHOU`; **nunca lança** por conteúdo. Cada achado é **sempre válido** (passou por `validateRawFindingsV2`); o que não passa é descartado e listado no relatório (caminho e código, sem conteúdo). O achado só tem `empresa, tipo, cidade, estado, nicho, campos, fontes, identidadeAmbigua?, dataDaPesquisa, dossie: { fatos, analises: [] }`: **sem** `observacoesBrutas`, `hipoteseDeOportunidade`, análises, hipóteses, status, score ou decisão.

O relatório traz: consulta, alvo, resultados recebidos/inválidos, candidatos, achados gerados/descartados, páginas e consultas de anúncios, falhas por código, omissões por código e se foi interrompida por tempo. Sem URL de página, sem token, sem caminho, sem mensagem de erro.

## Regras (todas determinísticas)

- **Fontes permitidas** e prioridade (0003/0004): site oficial, Google Perfil, Instagram, Facebook, LinkedIn, YouTube, outras fontes públicas. Só https público (`checkUrl`: sem usuário/senha, porta, IP ou host local); URL de login, redirecionamento para login e páginas de outro tipo são recusadas. **Nada de login, captcha, robots, dado privado.** Só o site e o perfil do Instagram são visitados (no máximo 2 páginas por candidato e 300 no total); os demais canais viram evidência pelos links publicados.
- **Evidência:** todo valor externo vira `{ valor, fonte, tipoFonte, url https, dataConsulta }`. `OFICIAL` = o próprio site lido e o que ele linka; `SECUNDARIA` = o que só a busca apontou (a URL da busca é a fonte). A data é a do relógio injetado no momento da consulta (nunca a informada por uma porta).
- **Nada é inferido.** Telefone, WhatsApp e e-mail só existem como link explícito publicado (`tel:`, `mailto:`, `wa.me`, `api.whatsapp.com/send?phone=`); texto solto, links relativos e outros esquemas são ignorados; nenhum proprietário, responsável ou contato pessoal é buscado. CTA de WhatsApp = link para o WhatsApp na página; CTA de agendamento = link cujo texto/destino casa uma regra fixa e curta (agend…, marcar consulta, calendly); formulário = o que o adaptador informa (`temFormularioContato === true`).
- **Instagram:** só datas de postagens observadas (1 = `ultimaPostagemEm`; 2+ = `postagensObservadas`, ordenadas e sem repetição, **no máximo as 30 mais recentes**, declarado no relatório) e o CTA da bio que a página mostra (≤200). Perfil privado = `NAO_VERIFICADO` (`PERFIL_PRIVADO`). **Nenhuma "atividade" é afirmada**: o sinal é derivado pelo dossiê. A fonte da observação é a página do próprio perfil.
- **Anúncios:** `IDENTIFICADO` só se o nome do anunciante for **igual** ao da empresa (mesma normalização do discovery — nome parecido não vale); uma verificação feita sem esse anunciante é `NAO_ENCONTRADO_NA_VERIFICACAO` (com a biblioteca e a data); uma falha é `NAO_VERIFICADO` com motivo. Só a biblioteca pública certa vale como fonte (Meta: `facebook.com/ads/library`; Google: `adstransparency.google.com`). Sem a porta de anúncios, nenhum fato de anúncio é produzido. **Nunca** "não anuncia".
- **Falhas** (login, captcha, robots, privado, fora do ar, removido, tempo, erro da porta ou resposta inválida) viram fato `NAO_VERIFICADO` com `motivo` (vocabulário fechado da 0020) e a pesquisa **segue**; nada é contornado e nada é afirmado. "Site não existe", "não anuncia" e "Instagram inativo" **nunca** são produzidos.
- **Conflito preservado:** dois sites de hosts diferentes = ambos como `SECUNDARIA`, sem visitar nenhum, `identidadeAmbigua: true`; dois perfis diferentes do Instagram = as duas evidências, o perfil não é visitado e o relatório diz `CANAL_AMBIGUO`. O discovery e o dossiê tratam o conflito; o Researcher nunca escolhe.
- **DADO / HIPÓTESE / NÃO VERIFICADO:** o Researcher V1 produz **só DADO e NÃO VERIFICADO** (com motivo). **Não gera análise nem hipótese** (não há IA aqui); o bloco `dossie.analises` vai sempre vazio. Uma futura camada de análise usaria o mesmo bloco, sob as regras da 0020. Nenhum resultado carrega autoridade de aprovação ou de CRM: o Researcher não conhece a fila, o CRM nem o serviço.
- **Nunca corta em silêncio:** o que não coube é omitido **com código** no relatório — mais de 5 evidências de um campo (`EVIDENCIAS_EXCESSIVAS`, o campo inteiro sai), mais de 500 links (`LINKS_EXCESSIVOS`), datas futuras/inválidas (`DATA_FUTURA`, `DATA_INVALIDA`), amostra de postagens (`AMOSTRA_LIMITADA`), fontes (`FONTES_EXCESSIVAS`), candidato sem evidência (`SEM_EVIDENCIA`), orçamento (`ORCAMENTO_ESGOTADO`).

## Limites

Alvo = pedidos + metade de reserva, no máximo **150** (o teto de uma submissão, 0020); até 300 resultados de busca (mais que isso recusa a busca inteira); 2 páginas por candidato e 300 no total; 500 links por página; 30 postagens; 200 anunciantes por consulta; 50 fontes por achado; duração máxima padrão de 15 minutos (`maxDurationMs`; passado o tempo a pesquisa **para** e o relatório diz `interrompidaPorTempo`). O Researcher é sequencial e não implementa taxa/timeout de rede (responsabilidade do adaptador).

## O que NÃO foi implementado

Adaptador real (HTTP/navegador), extração de HTML, execução de qualquer pesquisa, serviço/rota do Researcher, ligação ao `submitProspecting`, geração de análise/hipótese, IA, existência negativa de canal, dados numéricos (seguidores, avaliações), proprietário/responsável, e qualquer escrita (CRM, fila, lote, dossiê).

## Próximos passos (a decidir)

1. Adaptador de portas com rede (robots, taxa, timeout, User-Agent identificado) — com decisão própria e um primeiro teste real controlado (0004 §12).
2. Um serviço que chame o Researcher e entregue os achados ao `submitProspecting` (autorização própria).
3. Análises/hipóteses (camada separada, sob as regras da 0020).

## Testes e mutação

`tests/research-prospector/researcher.test.js` (31 testes, portas fake em memória, nenhuma rede): criação e briefing, caminho feliz (V2 válido + sinais derivados pelo dossiê), prioridade e páginas visitadas, matriz de falhas com motivo, login por redirecionamento, Instagram (privado, datas, amostra, CTA, fonte), conflito preservado, identidade ambígua, anúncios (nome igual, biblioteca certa, falhas), nada inferido, fontes públicas, busca, alvo/150, agrupamento, omissões com código, tempo, portas hostis, determinismo, `classifyLink`/`motivoFor`, e arquitetura (só irmãos, sem CRM/fila/aprovação/promoção/score/rede, não ligado ao serviço). Total do projeto: 1148 (1146 passam e 2 pulados com `.env`; 1141 e 7 pulados sem `.env`). Mutação: 117 mutantes (briefing/alvo, política de fontes, site, links, Instagram, anúncios, achado, portas/falhas, orçamentos); 27 sobreviveram na primeira rodada — 20 lacunas reais corrigidas e agora detectadas; 7 equivalentes/defensivos: limite da busca (o alvo já é ≤ 150), revalidação V2 e relatório de descartados (a construção só gera achados válidos), orçamentos de páginas (o máximo possível já é 2 por candidato × 150 = 300), motivo herdado do protótipo (cai no mesmo `NAO_CONSULTADO`) e limite de tamanho de link (a URL já é limitada por `checkUrl`).
