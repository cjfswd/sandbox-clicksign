# Constitution do Projeto

A constitution define os princípios não-negociáveis que governam todo o desenvolvimento.
É lida em toda sessão e vincula todos os agentes, specs e tasks.

---

## Princípios de Engenharia (non-negotiable)

- Todo código novo começa com teste falhando (TDD — Red → Green → Refactor)
- Nenhuma feature é implementada sem spec aprovada
- Nenhuma spec é implementada sem tasks atômicas definidas
- Commits são atômicos, semânticos e rastreáveis à task que os gerou
- Specs são a fonte de verdade — quando código diverge da spec, o código está errado

## Processo de Desenvolvimento

- Fluxo: Constitution → Spec → Plan → Tasks → Worktree isolado → PR → Merge
- Cada task é independente o suficiente para rodar em worktree próprio
- Tasks paralelas não tocam os mesmos arquivos
- Toda task concluída passa pelos hooks de qualidade antes de PR

## Qualidade (garantida pelos hooks ativos)

- KISS: solução mais simples que resolve o problema atual
- YAGNI: não implementar o que não está na spec
- DRY: uma fonte de verdade para cada conhecimento
- SoC: cada camada tem uma responsabilidade
- Fail Fast: erros explícitos, cedo, com contexto

## Rastreabilidade

- Todo commit referencia a task: `feat(auth): adicionar OAuth — task-003`
- Toda spec tem ID único: `spec-YYYY-MM-DD-nome`
- Toda task tem ID único dentro da spec: `task-NNN`

## Skills ativas por contexto

- `spec-driven`: ao criar/refinar specs, plans ou tasks
- `agile`: ao planejar trabalho, priorizar backlog, revisar entregáveis
- `scrum`: ao trabalhar com sprints, backlog, velocity, cerimônias
- `kanban`: ao gerenciar fluxo, WIP limits, cycle time
- `xp`: ao implementar, parear, refatorar, integrar continuamente
