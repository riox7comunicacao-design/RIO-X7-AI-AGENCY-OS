# data/

Estado local persistente gerado pelo projeto — não é código, teste nem documentação.

**Nenhum arquivo `data/*.json` faz parte do Git** (ver `.gitignore`): eles guardam configuração de acesso e dados pessoais/operacionais. Cada computador tem os seus, e **eles não são sincronizados entre computadores** — quem chega a um computador novo recria o que precisa (ver [docs/operations/MULTICOMPUTER-HANDOFF.md](../docs/operations/MULTICOMPUTER-HANDOFF.md)). Compartilhar dados operacionais entre máquinas é uma necessidade futura de persistência centralizada, **ainda não decidida nem implementada**.

| Arquivo | O que é | Se não existir |
|---|---|---|
| `users.json` | Usuários operacionais do Dashboard (`userId`, `authUserId`, nome, e-mail, role, status). Formato em `.env.example`. **Contém identidade real; nunca versionar.** | O servidor **recusa subir**, dizendo o que falta. Nenhum usuário é criado automaticamente. |
| `approval-queue.json` | Fila de aprovação humana do módulo Research + Prospector ([decisão 0007](../docs/decisions/0007-human-approval-queue.md)): dados públicos/comerciais de prospects aguardando decisão humana. | A fila é tratada como vazia — nada a criar. |
| `crm.json` | CRM operacional local ([decisão 0013](../docs/decisions/0013-crm-domain.md)) — adapter de arquivo de **desenvolvimento**, não a persistência de produção. Caminho configurável por `RIO_X7_CRM_PATH`. | O CRM é tratado como vazio; o arquivo é criado no primeiro registro. |
| `approval-queue.dev.json`, `approval-queue.manual-validation.json` | Dados **fictícios** para desenvolvimento (`scripts/seed-dev-queue.js`). | Podem ser recriados. |

**Por que nada disso vai para o Git:** a fila e o CRM contêm dados pessoais reais de pessoas/empresas pesquisadas publicamente, e `users.json` contém a identidade de quem acessa o painel. Mantê-los fora do histórico é consistente com a Regra 8 do [RULES.md](../RULES.md) (privacidade) e com o cuidado de nunca versionar segredos. Registros de teste (por exemplo, "TESTE CRM Rio X7") não precisam ser transportados para outro computador.
