# data/

Estado local persistente gerado pelo projeto — não é código, teste nem documentação.

## `approval-queue.json`

Fila de aprovação humana do módulo Research + Prospector ([docs/decisions/0007-human-approval-queue.md](../docs/decisions/0007-human-approval-queue.md)). Contém dados públicos/comerciais de prospects pesquisados (nome, telefone, e-mail, site, redes) aguardando decisão humana antes de qualquer eventual criação no CRM.

**Este arquivo não é versionado no Git** (ver `.gitignore`) porque contém dados pessoais reais de pessoas/empresas pesquisadas publicamente — mantê-lo fora do histórico do repositório é consistente com a Regra 8 do [RULES.md](../RULES.md) (privacidade) e com o princípio já registrado em [0002-execution-architecture.md](../docs/decisions/0002-execution-architecture.md) de não duplicar permanentemente dado de lead fora do Notion.

Se o arquivo não existir, o módulo trata a fila como vazia — nada precisa ser criado manualmente.
