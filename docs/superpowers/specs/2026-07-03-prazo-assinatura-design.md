# Prazo de assinatura (deadline_at)

**Data:** 2026-07-03
**Escopo:** `desktop-tauri/` — app desktop Tauri + Vue de envio em lote via Clicksign.

## Problema

O app não expõe nenhuma forma de configurar o prazo de assinatura de um
envelope. A API da Clicksign já suporta isso (`deadline_at` em
`EnvelopeAttributes`), mas `createEnvelope` hoje só envia `{ name }` — o
campo nunca é setado. Confirmado empiricamente contra o sandbox real: se
`deadline_at` não é informado na criação, a Clicksign aplica um padrão de
**30 dias a partir da criação** (testado criando um envelope real:
criado em `2026-07-03T18:43:44-03:00`, `deadline_at` retornado
`2026-08-02T18:43:44.529-03:00`).

## Objetivo

1. Permitir definir um prazo de assinatura por lote inteiro (aplicado a
   todos os documentos daquele envio de uma vez) e, a partir daí, ajustar
   individualmente por documento se necessário.
2. Quando o prazo de um documento está em branco, mostrar a data final e a
   quantidade de dias que a Clicksign vai aplicar por padrão (30 dias a
   partir de hoje), calculado localmente, sem chamada de rede.
3. Persistir o prazo escolhido junto com o item (igual `signer`/`delivery`
   já são hoje) — um retry mais tarde recria o envelope com o **mesmo**
   prazo original, não recalcula um novo a partir da data do retry.

## Fora de escopo

- Editar o prazo de um envelope já criado (a Clicksign talvez suporte via
  `PATCH`, mas não foi pedido e não faz parte desta spec).
- Notificação/alerta quando um prazo está prestes a vencer.
- Mudar o comportamento de nenhum outro delivery/fluxo existente.

## Modelo de dados

Nova migration (`version: 3`, aditiva, mesma técnica da v2) adiciona uma
coluna a `items`:

| Coluna | Tipo | Significado |
|---|---|---|
| `deadline_at` | `TEXT`, nulo | `null` = sem prazo definido pelo usuário (a Clicksign aplica os 30 dias dela); caso contrário, string ISO 8601 completa, enviada verbatim para `createEnvelope`. |

## Camada de domínio (`native/batch.ts`)

`BaseItem` ganha `deadlineAt: string | null` — persistido desde a criação
do item, ao lado de `signer`/`delivery`/`filename`. Não é uma transição de
pipeline; é um dado de entrada como qualquer outro campo do item.

## Camada de rede (`native/clicksign.ts`)

`createEnvelope(name: string, deadlineAt?: string)` — quando `deadlineAt`
é fornecido, inclui `deadline_at: deadlineAt` nos `attributes` do POST;
quando omitido, o body fica exatamente como está hoje (`{ name }`), preservando
o comportamento atual (padrão de 30 dias da própria Clicksign).

**A implementação precisa confirmar empiricamente contra o sandbox real
qual formato de string a API aceita** — o valor observado na resposta da
Clicksign foi `"2026-08-02T18:43:44.529-03:00"` (ISO 8601 com offset de
fuso horário), mas não foi testado se a API aceita também o formato UTC
`Z` (ex.: `"2026-08-02T23:59:59.999Z"`, mesmo padrão já usado em
`created_at`/`clicksign_status_checked_at` neste projeto). Se a API
aceitar `Z`, usar esse formato por consistência com o resto do código; se
rejeitar, formatar com o offset de fuso horário local do sistema.

## Camada de repositório (`native/repository.ts`)

`BatchItemInput` ganha `deadlineAt?: string`. `createBatch` grava a nova
coluna; `ItemRow`/`rowToItem` leem de volta (mesmo padrão de
`clicksign_status` na v2 — propagado via `...base` em todo branch do
`switch`).

## Camada de pipeline (`native/process-item.ts`)

`processItem` passa `item.deadlineAt` (pode ser `null`/`undefined`) para
`createEnvelope`.

## UI (`App.vue`)

- **Campo "Prazo do lote"**, um `<input type="date">` no topo da tela
  (perto de "+ Adicionar PDF"/"Enviar lote"). Ao mudar, escreve esse valor
  em `draft.deadlineAt` de **todos** os drafts atuais na tela — os que já
  tinham um valor individual diferente são sobrescritos (é o comportamento
  pedido: mudar o campo do lote muda todos os documentos). PDFs adicionados
  **depois** de definir o prazo do lote (via "+ Adicionar PDF") já nascem
  com esse valor de prazo herdado, em vez de vazios — evita ter que
  reaplicar o prazo do lote toda vez que um novo PDF é adicionado no meio
  do preenchimento.
- **Campo de prazo por linha**: cada draft ganha seu próprio
  `<input type="date">`, editável depois de aplicado pelo campo do lote —
  permite ajustar um documento específico sem afetar os outros.
- **Prazo padrão exibido quando vazio**: se `draft.deadlineAt` está vazio,
  mostra ao lado do campo a data final e quantos dias faltam, calculados
  localmente (`hoje + 30 dias`, sem chamada de rede) — ex.: "02/08/2026 ·
  30 dias, padrão da Clicksign".
- **No envio**: converte a data escolhida (`YYYY-MM-DD`, formato nativo do
  `<input type="date">`) para o formato ISO 8601 completo que
  `createEnvelope` espera (ver nota da camada de rede acima sobre
  confirmar o formato exato aceito), usando fim do dia local como horário
  — um prazo "até 02/08/2026" deve valer o dia inteiro. Se vazio, não
  envia `deadlineAt` (fica `undefined`/`null` de ponta a ponta).

## Tratamento de erro

Nenhum novo caminho de erro introduzido — `createEnvelope` já lança
`ClicksignError` em qualquer resposta não-OK, e isso já é tratado pelo
pipeline existente (`processItem` → `worker.ts` → item vira `failed`). Se
a Clicksign rejeitar um formato de `deadline_at` malformado, o erro já
aparece na UI da forma que qualquer outro erro de criação de envelope
aparece hoje (mensagem em `draft.errorMessage`).

## Testes

- `batch.ts`: nenhuma função de transição nova — só um campo a mais em
  `BaseItem`, não precisa de teste dedicado além do que já cobre
  `applyClicksignStatus`/transições existentes continuarem passando.
- `clicksign.ts`: não é unit-testável (chamada HTTP real via
  `@tauri-apps/plugin-http`) — verificação manual real contra o sandbox,
  igual todo o resto deste cliente. Testar especificamente: (1) enviar
  `deadlineAt` e confirmar via `getEnvelope` que o valor retornado bate
  com o enviado; (2) confirmar que omitir `deadlineAt` continua aplicando
  os 30 dias padrão (comportamento já confirmado nesta spec, não deveria
  regressar).
- Migration v3: mesma verificação da v2 — banco novo E banco existente
  (v1/v2) recebendo a coluna sem perda de dados.
- `App.vue`: sem teste automatizado (convenção já estabelecida no
  projeto) — verificação manual real com screenshot: campo do lote
  propaga pra todos os itens, campo individual sobrescreve só aquele
  item, prazo padrão exibido bate com a conta de 30 dias, e um envio real
  ao sandbox com prazo customizado confirma (via `getEnvelope` ou a
  própria resposta de criação) que o valor foi realmente aplicado.
