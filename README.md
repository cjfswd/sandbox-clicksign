# sandbox-clicksign — Batch API

API Node.js + TypeScript para **envio em lote** de documentos para assinatura via
**Clicksign (API v3 — Envelopes)**: cada item do lote é 1 documento PDF para
1 destinatário, com escolha do tipo de envio e retorno de **todos os links de assinatura**.

Spec: [.specify/active/spec-2026-07-01-clicksign-batch-api/spec.md](.specify/active/spec-2026-07-01-clicksign-batch-api/spec.md)

## Requisitos

- Node.js >= 24 (roda TypeScript nativamente; usa `node:sqlite` built-in)
- Access Token da Clicksign (Configurações > API)

## Configuração

```bash
npm install
```

`.env` (ignorado pelo git):

```env
CLICKSIGN_BASE_URL=https://sandbox.clicksign.com   # ou https://app.clicksign.com em produção
CLICKSIGN_ACCESS_TOKEN=<token-clicksign>
API_KEY=<chave-que-o-app-desktop-usara>
PORT=3000
DATA_DIR=./data
```

## Subir a API

```bash
npm start
```

## Endpoints

Todas as chamadas exigem o header `x-api-key: <API_KEY>`.
Contrato completo (ts-rest + Zod, compartilhável com o cliente): [contracts/batch-contract.ts](contracts/batch-contract.ts)

### `POST /batches` — criar lote

Responde `201 { "batchId": "..." }` **imediatamente**; o processamento é assíncrono.

```json
{
  "items": [
    {
      "filename": "contrato-fulano.pdf",
      "contentBase64": "<PDF em base64>",
      "signer": { "name": "Fulano da Silva", "email": "fulano@exemplo.com" },
      "delivery": "link"
    },
    {
      "filename": "contrato-beltrana.pdf",
      "contentBase64": "<PDF em base64>",
      "signer": { "name": "Beltrana de Souza", "phoneNumber": "11999998888" },
      "delivery": "whatsapp"
    }
  ]
}
```

**Tipos de envio (`delivery`):**

| Valor | Comportamento |
|-------|--------------|
| `link` | Clicksign não notifica ninguém; você envia o link manualmente. Autenticação: token por e-mail. |
| `email` | Clicksign envia a solicitação por e-mail (`email` obrigatório). Token por e-mail. |
| `whatsapp` | Clicksign envia por WhatsApp (`phoneNumber` obrigatório). Token por WhatsApp (custo por envio em produção). |

Validação (fail fast — o lote inteiro é rejeitado com `400` e a lista de erros por
índice de item): nome e sobrenome; e-mail/telefone conforme o `delivery`; base64
válido; magic bytes `%PDF`; máx. 10 MB por arquivo.

### `GET /batches/{id}` — progresso e links

```json
{
  "id": "...",
  "progress": { "total": 2, "pending": 0, "processing": 1, "done": 1, "failed": 0 },
  "items": [
    {
      "id": "...",
      "filename": "contrato-fulano.pdf",
      "status": "done",
      "signUrl": "https://sandbox.clicksign.com/notarial/widget/signatures/<signer_id>/redirect",
      "envelopeId": "...",
      "errorMessage": null
    }
  ]
}
```

### `POST /batches/{id}/items/{itemId}/retry` — reprocessar item `failed`

Responde `202`. Itens que não estão `failed` retornam `409`.

## Como funciona por dentro

```
POST /batches ──> validação ──> SQLite (fila) ──> 201 imediato
                                    │
                              QueueWorker (sequencial)
                                    │  token bucket: 16 req/10s sandbox, 40 req/10s produção
                                    ▼
              envelope → documento → signatário → requisitos → ativação
                                    │
                    link lido do evento add_signer (fonte oficial)
                                    │
                    delivery ≠ link? → notificação Clicksign
```

- **Rate limit:** toda requisição à Clicksign passa por um token bucket com margem de
  20% sob o limite oficial (sandbox 20 req/10s, produção 50 req/10s). HTTP 429 gera
  retry com backoff exponencial, sem falhar o item.
- **Resiliência:** a fila vive no SQLite (`DATA_DIR/batches.db`). Se a API reiniciar
  no meio de um lote, itens em processamento voltam para a fila no boot.
- **Isolamento de falha:** item com erro definitivo vira `failed` (com a mensagem da
  Clicksign) e os demais continuam; use o endpoint de retry.
- **Segurança:** o token da Clicksign vive só no servidor; respostas e logs de erro
  são sanitizados para nunca vazá-lo. O cliente usa apenas a `API_KEY`.
- **PDFs:** gravados em `DATA_DIR/pdfs/` e removidos quando o item conclui.

## Scripts utilitários (validação manual)

```bash
npm run create -- "Nome do Signatario" email@exemplo.com  # fluxo unitário no sandbox
npm run status -- <envelope_id>                            # status + links de um envelope
```

## Testes

```bash
npm test           # unidade + integração (integração pulada sem CLICKSIGN_ACCESS_TOKEN)
npm run typecheck
```

O teste de integração (`src/integration.test.ts`) roda contra o sandbox real: cria um
lote de 3 itens `delivery=link`, aguarda a fila e verifica que os 3 links abrem a
página de assinatura (não `/404`).

## Runbook

- **Envelopes órfãos em draft:** um crash entre a criação do envelope e a conclusão do
  item pode deixar envelopes `draft` órfãos na conta ao reprocessar. Eles não notificam
  ninguém; limpe periodicamente pela UI ou via `DELETE /api/v3/envelopes/:id`.
- **Troca sandbox ⇄ produção:** apenas `CLICKSIGN_BASE_URL` + `CLICKSIGN_ACCESS_TOKEN`.
  O rate limit se ajusta sozinho (detecta `sandbox` na URL).
- **Formato do link:** não documentado oficialmente; a API lê do evento `add_signer`
  e só usa o formato conhecido como fallback (warning no log quando isso ocorrer).
- **Rate limit de notificação:** a doc da Clicksign menciona "1 notificação/min por
  endpoint" para solicitações de assinatura. Lotes `delivery=email/whatsapp` grandes
  podem ser mais lentos que lotes `link`; o backoff em 429 cobre isso automaticamente.

## Observações do sandbox

- Rate limit: 20 req/conta/10s (produção: 50).
- Limites: 10 MB por arquivo, 100 MB por envelope.
- Documentos do sandbox não têm valor legal.
- Docs oficiais: https://developers.clicksign.com/docs/primeiros-passos
