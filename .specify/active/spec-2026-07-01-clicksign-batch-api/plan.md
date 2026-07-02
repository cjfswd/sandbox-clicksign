# Plan — spec-2026-07-01-clicksign-batch-api

**Spec:** [spec.md](./spec.md)
**Status:** ready-for-tasks
**Criado em:** 2026-07-01

---

## Estado atual da codebase

| Existe | Descrição |
|--------|-----------|
| `src/clicksign.ts` | Cliente da Clicksign API v3 validado no sandbox (envelope, documento, signatário, requisitos, ativação, notificação implícita via curl). Sem retry/rate limit. |
| `src/sample-pdf.ts` | Gerador de PDF de teste (pdf-lib) — útil nos testes de integração. |
| `src/create-envelope.ts`, `src/envelope-status.ts` | Scripts CLI de validação manual; permanecem como estão. |
| `tsconfig.json` | strict + `erasableSyntaxOnly` (TS roda nativo no Node 24, sem build). |

Não existem ainda: servidor HTTP, contrato ts-rest, persistência, fila, testes. O projeto
não é repositório git — inicializar no início da implementação (worktrees dependem disso).

## Decisões técnicas

1. **Hono + @ts-rest/core como servidor HTTP** em vez de Express/Fastify — é o stack
   padrão do projeto (hooks e skills já configurados para ts-rest); o contrato Zod é
   compartilhável com o app Tauri depois (mesma linguagem no cliente).

2. **`node:sqlite` (built-in do Node 24) em vez de `better-sqlite3`** — zero dependência
   nativa (sem node-gyp/prebuilds no deploy Docker), API síncrona `DatabaseSync`
   suficiente para o volume (fila de centenas de itens). Se aparecer limitação, a
   interface `BatchRepository` isola a troca.

3. **Worker in-process (setImmediate loop) em vez de job queue externa (BullMQ/Redis)** —
   YAGNI: um único processo, um único worker sequencial já satisfaz o rate limit; Redis
   adicionaria infraestrutura sem ganho. A retomada pós-restart (critério 9) vem do
   SQLite, não da queue.

4. **Rate limit por token bucket no nível de requisição HTTP, dentro de um wrapper do
   `ClicksignClient`** em vez de limitar por item — o custo por item varia (7 requisições
   com notificação, 6 sem; +1 para ler o evento `add_signer`). Contar requisições reais
   é correto; contar itens é aproximação frágil. Bucket configurado por env:
   sandbox 20 req/10s, produção 50 req/10s, com margem de segurança de 20%
   (16 e 40 respectivamente) para coexistir com outros consumidores do token.

5. **Link de assinatura lido do evento `add_signer`** (`GET /envelopes/:id/events`)
   em vez de montar a string `/notarial/widget/signatures/{id}/redirect` — o formato
   não é documentado; o evento é a fonte oficial (decisão registrada na spec e na
   memória do projeto). Fallback: se o evento não trouxer `url`, montar a string
   conhecida e logar warning.

6. **Estados do item como discriminated union TS + coluna TEXT no SQLite:**
   `pending → processing → done | failed`, com `retry_count`, `error_message`,
   `envelope_id`, `signer_id`, `sign_url`. Transições só no worker (single writer);
   handlers HTTP apenas leem e inserem.

7. **PDFs em base64 armazenados em disco (`DATA_DIR/pdfs/{item_id}.pdf`), não no
   SQLite** — evita inflar o banco e permite reprocessar item sem reenviar o arquivo;
   apagados quando o item conclui (`done`) para não acumular disco.

8. **Validação fail-fast com Zod no contrato**: lote inteiro rejeitado com erros por
   item (critério 4) — inclui refinements: `delivery=whatsapp ⇒ phone_number`,
   `delivery=email ⇒ email`, base64 decodável e ≤ 10 MB, magic bytes `%PDF`.

9. **Vitest** para testes. Unidade: validação, rate limiter (fake timers), máquina de
   estados, repositório (SQLite em `:memory:`). Integração: fluxo completo contra o
   **sandbox real** (token via env, pulado se ausente) — o sandbox é gratuito e é o
   teste que realmente prova o critério 2.

## Arquitetura

```
contracts/
  batch-contract.ts        # ts-rest + Zod (compartilhável com o Tauri)
src/
  domain/
    batch.ts               # tipos, estados, transições (puro, sem IO)
    validation.ts          # regras de negócio de validação por item
  infra/
    clicksign.ts           # (existente, movido) cliente HTTP v3
    rate-limiter.ts        # token bucket
    throttled-clicksign.ts # wrapper: client + bucket + retry/backoff em 429
    repository.ts          # BatchRepository sobre node:sqlite + schema/migração
    pdf-store.ts           # gravação/leitura/limpeza dos PDFs em disco
  app/
    worker.ts              # loop da fila: claim item, executa passos, transiciona
    process-item.ts        # pipeline de 1 item (envelope→doc→signer→reqs→ativar→link→notificar)
  http/
    server.ts              # Hono + auth x-api-key + montagem do contrato
    handlers.ts            # POST /batches, GET /batches/:id, POST .../retry
  index.ts                 # bootstrap: env, db, worker, server
```

## Mapeamento critérios → componentes

| Critério | Componente responsável |
|----------|------------------------|
| 1 (201 < 2s) | `handlers.ts` insere e responde; worker é assíncrono |
| 2 (links via GET) | `process-item.ts` + `repository.ts` |
| 3 (rate limit) | `rate-limiter.ts` + `throttled-clicksign.ts` |
| 4 (400 com erros por item) | `validation.ts` + schemas Zod do contrato |
| 5 (token nunca exposto) | `ClicksignError` já trunca corpo; handler de erro global sanitiza; teste dedicado |
| 6 (401 sem api key) | middleware em `server.ts` |
| 7 (failed isolado) | `worker.ts` (catch por item) |
| 8 (backoff em 429) | `throttled-clicksign.ts` |
| 9 (retomada pós-restart) | `worker.ts` (reclaim de `processing` no boot) + SQLite |
| 10 (notificação por canal) | `process-item.ts` (passo condicional por `delivery`) |

## Riscos

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Formato do link não documentado | Links quebrados se a Clicksign mudar | Decisão 5 (ler do evento) + teste de integração diário seria ideal (fora de escopo; documentar no runbook) |
| Rate limit de **notificação**: doc menciona "1 notificação/min por endpoint" | Lotes `delivery=email/whatsapp` podem ser drasticamente mais lentos que lotes `link` | Tratar 429 da notificação com backoff (decisão 4 cobre); **validar empiricamente no sandbox na task de integração** — se confirmar 1/min global, expor no GET do batch um `estimated_completion` |
| `node:sqlite` é relativamente novo | Bug/limitação inesperada | Interface `BatchRepository` isola; trocar por better-sqlite3 é mudança local |
| Envelope órfão em retomada pós-crash (item `processing` sem saber em que passo parou) | Envelopes duplicados em draft na conta | Recriar do zero e registrar `envelope_id` antigo em log; envelopes draft órfãos não notificam ninguém e podem ser limpos depois (documentar no runbook) |
| WhatsApp no sandbox pode não entregar de fato | Falso negativo em teste manual | Testar canal whatsapp apenas quanto à aceitação da API (201), não à entrega |

**Complexidade estimada:** média. Nenhum spike necessário — a única incerteza real
(rate limit de notificação) é barata de validar durante a task de integração.

## Fora deste plan

- Deploy (Docker/Coolify) — usar `/pipeline` após a implementação.
- App desktop Tauri — spec própria, consumirá `contracts/batch-contract.ts`.
