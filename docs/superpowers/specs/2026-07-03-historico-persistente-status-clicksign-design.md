# Histórico persistente de lotes + atualização de status na Clicksign

**Data:** 2026-07-03
**Escopo:** `desktop-tauri/` — app desktop Tauri + Vue de envio em lote via Clicksign.

## Problema

Hoje o app já persiste todo lote/documento/link enviado no SQLite
(`repository.ts`), mas o `App.vue` só mantém a lista de documentos da sessão
atual (`drafts`, em memória). Ao fechar e reabrir o app, os lotes e links já
enviados continuam no banco mas somem da tela — não há como consultá-los de
volta pela UI.

Além disso, o app nunca volta a checar a Clicksign depois que um documento é
enviado: se o signatário assina depois, ou se o envelope é cancelado/deletado
na Clicksign, o app não sabe — o único status que existe é o do pipeline
interno de envio (`pending`/`processing`/`done`/`failed`), não o status real
da assinatura.

## Objetivo

1. Expor, na própria UI, todos os lotes já enviados (não só o da sessão
   atual), agrupados por lote com a data de criação de cada um.
2. Permitir buscar/filtrar esse histórico por nome de signatário/arquivo,
   status e intervalo de datas — a busca precisa alcançar **todo** o
   histórico gravado no banco, não só o que já foi carregado na tela.
3. Permitir checar, sob demanda (nunca automaticamente), se um documento já
   foi assinado ou se o envelope foi cancelado/deletado na Clicksign —
   por item individual ou em lote para tudo que estiver carregado na tela.

## Fora de escopo

- Checagem automática/periódica de status (só manual, via botão).
- Status por signatário individual dentro de um envelope com múltiplos
  signatários — usa-se o status do envelope inteiro (`draft`/`running`/
  `canceled`/`closed`), que é o dado confiável disponível hoje. Detalhamento
  por signatário fica para uma iteração futura, se necessário.
- Mudar o comportamento do lote atual (fluxo de envio) — só adiciona a seção
  de histórico.
- Espelhar essa feature na API standalone (`src/` da raiz) — escopo é só o
  app desktop.

## Modelo de dados

Nova migration (`version: 2`, em `lib.rs`) adiciona duas colunas à tabela
`items`:

| Coluna | Tipo | Significado |
|---|---|---|
| `clicksign_status` | `TEXT`, nulo | `null` até a primeira checagem manual; depois `'pending'`, `'signed'` ou `'canceled'`. |
| `clicksign_status_checked_at` | `TEXT`, nulo | Timestamp ISO da última checagem; `null` se nunca checado. |

Mapeamento do status do envelope na Clicksign (`EnvelopeAttributes.status`)
para `clicksign_status`:

| Status da Clicksign | `clicksign_status` |
|---|---|
| `running` | `'pending'` |
| `closed` | `'signed'` |
| `canceled` | `'canceled'` |
| GET retorna 404 (envelope não existe mais) | `'canceled'` |
| `draft` (não deveria acontecer — o app sempre ativa o envelope) | `'pending'` |

Este campo é **independente** do `status` interno já existente
(`pending`/`processing`/`done`/`failed`, o pipeline de envio). Um item pode
estar `done` (link gerado com sucesso) e `clicksign_status` continuar `null`
até alguém clicar em "Atualizar".

## Camada de repositório (`native/repository.ts`)

### `listBatches(filter, limit, offset): Promise<Batch[]>`

`filter` é `{ search?: string; status?: ItemStatus | ClicksignStatus; dateFrom?: string; dateTo?: string }`.

Implementação em duas consultas:

1. Acha os `batch_id` distintos cujos itens batem com o filtro — `search`
   via `LIKE` em `signer_name`/`filename`; `status` compara com `items.status`
   (quando o filtro é `'failed'`) ou `items.clicksign_status` (quando o
   filtro é `'signed'`/`'canceled'`, ou `'pending'` — nesse último caso o
   filtro casa tanto `clicksign_status = 'pending'` quanto
   `clicksign_status IS NULL`, já que um item `done` nunca checado ainda não
   tem confirmação de assinatura, o mesmo caso prático de "pendente");
   intervalo de datas compara com `batches.created_at`. Sem filtro nenhum,
   `listBatches` devolve todos os lotes, sem restringir por status. Ordenado
   por `created_at DESC`, com `LIMIT`/`OFFSET` — isso pagina **lotes**, não
   itens soltos.
2. Busca todos os itens de cada `batch_id` encontrado (lote completo, mesmo
   que só um item dele tenha batido no filtro) — mesma forma de `getBatch`.

### `updateClicksignStatus(itemId, status): Promise<void>`

Grava `clicksign_status` e `clicksign_status_checked_at = now()` para um item.

## Camada de sessão (`native/session.ts`)

Duas novas funções expostas em `BatchSession`:

- `listHistory(filter, limit, offset): Promise<Batch[]>` — repassa direto
  para `repo.listBatches`.
- `refreshItemStatus(itemId): Promise<ClicksignStatus>` — busca o item (via
  uma nova leitura pontual no repositório, para obter `envelopeId`); se não
  houver `envelopeId` (item nunca chegou a criar envelope — ficou
  `pending`/`failed` antes disso), lança erro descritivo em vez de tentar a
  chamada. Caso tenha `envelopeId`, chama `throttled.run(c =>
  c.getEnvelope(envelopeId))` — passa pelo rate limiter e retry em 429, como
  todo o resto. Um 404 (`ClicksignError` com `status === 404`) mapeia para
  `'canceled'`; sucesso mapeia pelo `status` do envelope conforme a tabela
  acima. Persiste via `updateClicksignStatus` e devolve o resultado.

## UI (`App.vue`)

Nova seção "Histórico", abaixo do lote atual:

- **Barra de filtro**: campo de busca por texto (nome do signatário ou do
  arquivo), select de status (`Pendente`/`Assinado`/`Cancelado ou
  deletado`/`Falhou`), dois campos de data (`de`/`até`).
- **Lista de lotes**: cada lote é um cabeçalho com a data de criação e a
  contagem de documentos, seguido das linhas de item daquele lote — mesmo
  visual das linhas do lote atual (nome, e-mail/telefone somente leitura,
  status, link quando houver, botões de ação).
- **Por item**: botão "Atualizar status" (chama `refreshItemStatus`); se
  `status === 'failed'`, também aparece "Tentar de novo" (reaproveita
  `retryItem`, que já existe).
- **"Atualizar tudo"** no topo da seção: roda `refreshItemStatus` para todo
  item **carregado na tela no momento** (não o histórico inteiro) — evita
  gastar rate limit em itens que o usuário nem está vendo.
- **"Carregar mais"** no fim da lista: busca a próxima página de lotes
  (`offset` acumulado) com o filtro atual aplicado.
- Mudar o filtro reinicia a paginação (`offset = 0`, lista recarregada do
  zero).

## Tratamento de erro

- `refreshItemStatus` sem `envelopeId`: erro tratado localmente, vira uma
  mensagem "Sem envelope pra checar" na linha do item — não interrompe os
  outros itens de uma chamada "Atualizar tudo".
- Erro de rede/rate limit durante o refresh: mensagem de erro por item,
  outros itens da mesma leva de "Atualizar tudo" continuam normalmente
  (mesmo padrão de isolamento de erro já usado no `worker.ts`).
- Filtro sem nenhum resultado: mensagem "Nenhum lote encontrado" em vez de
  lista vazia sem explicação.

## Testes

- `listBatches` com filtros combinados (busca + status + intervalo de data)
  precisa de teste de integração real contra SQLite — parametrização de SQL
  não é segura de validar só por inspeção (mesmo padrão já usado para
  `claimNextPending`/`reclaimStale` na Fase 1 da migração, testado dentro do
  `tauri dev` real).
- `refreshItemStatus`: teste unitário do mapeamento de status
  (`running`/`closed`/`canceled`/404 → `pending`/`signed`/`canceled`) com o
  `ClicksignClient` mockado, e teste manual real contra o sandbox (criar um
  item, assinar manualmente no widget, clicar "Atualizar", confirmar que
  vira "Assinado").
- Migration `version: 2`: confirmar que um banco já existente (`version: 1`)
  ganha as duas colunas novas sem perder dados — testar abrindo o app com um
  `batches.db` real já populado de sessões anteriores desta migração.
