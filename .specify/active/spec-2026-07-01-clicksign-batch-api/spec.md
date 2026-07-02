# spec-2026-07-01-clicksign-batch-api

**Status:** approved
**Criada em:** 2026-07-01
**Autor:** Antonio Castillo (via sessão Claude)

---

## Contexto

A Health+ Cuidados precisa enviar documentos para assinatura eletrônica via Clicksign
(API v3 — Envelopes) em lote: cada documento PDF vai para exatamente **um** destinatário
(envelope singular → documento singular → signatário singular). O fluxo unitário já foi
validado no sandbox em `src/clicksign.ts` deste repositório.

O access token da Clicksign dá controle total da conta e **não pode ser distribuído** no
app desktop que será instalado nas máquinas dos operadores. Esta API centraliza o token
e expõe uma interface própria, protegida por API key, para o app desktop (Tauri, spec
futura) consumir.

A Clicksign impõe rate limit (produção: 50 req/10s; sandbox: 20 req/10s) e cada item do
lote consome ~6 requisições (envelope, documento, signatário, requisito de qualificação,
requisito de autenticação, ativação). Lotes maiores que ~8 itens não podem ser disparados
de uma vez — é necessária uma fila com controle de vazão.

## Usuário afetado

- **App desktop (Tauri)** — consumidor primário da API (spec futura).
- **Operadores de TI/administrativo da Health+** — usuários finais indiretos que montam
  os lotes e distribuem os links de assinatura.

## Fluxo principal

1. O cliente envia `POST /batches` com API key e um JSON contendo N itens:
   `{ filename, content_base64, signer: { name, email?, phone_number? }, delivery: "email" | "whatsapp" | "link" }`.
2. A API valida o payload, persiste o job e os itens no SQLite com status `pending`
   e responde imediatamente `201` com `{ batch_id }`.
3. Um worker interno processa a fila item a item, respeitando o rate limit do ambiente
   configurado (sandbox ou produção), executando por item: criar envelope → adicionar
   documento → adicionar signatário → requisitos → ativar.
4. Conforme cada item conclui, seu status vira `done` e o link de assinatura
   (`{base_url}/notarial/widget/signatures/{signer_id}/redirect`) é gravado.
   - `delivery: "email"` → signatário criado com `communicate_events.signature_request = "email"` e notificação disparada via API.
   - `delivery: "whatsapp"` → idem com `"whatsapp"` (telefone obrigatório) e notificação disparada.
   - `delivery: "link"` → `communicate_events.signature_request = "none"`; nenhuma notificação; o link é o único canal.
5. O cliente consulta `GET /batches/{id}` e recebe o progresso agregado e o estado de
   cada item, incluindo os links já disponíveis.

## Fluxos alternativos

- **A1 — Payload inválido:** item sem nome do signatário, sem canal compatível
  (ex.: `delivery: "whatsapp"` sem `phone_number`), base64 inválido ou PDF acima de
  10 MB → a API rejeita o lote inteiro com `400` e a lista de erros por item,
  **antes** de qualquer chamada à Clicksign (fail fast).
- **A2 — Erro da Clicksign em um item:** o item é marcado `failed` com o erro registrado;
  os demais itens continuam. Itens `failed` podem ser reprocessados via
  `POST /batches/{id}/items/{itemId}/retry`.
- **A3 — HTTP 429 (rate limit):** o worker aguarda com backoff exponencial e reprocessa;
  o item não é marcado como `failed` por 429.
- **A4 — Restart da API no meio de um lote:** ao subir, o worker retoma itens `pending`
  e reprocessa itens presos em `processing` de forma idempotente (envelopes órfãos de
  tentativa anterior interrompida são recriados; o link final é sempre o da última
  tentativa bem-sucedida).
- **A5 — API key ausente/incorreta:** `401` sem detalhes internos.

## Critérios de aceite (EARS)

1. O sistema SHALL responder `201` com `batch_id` em menos de 2s WHEN receber
   `POST /batches` válido com até 100 itens, sem aguardar o processamento.
2. O sistema SHALL processar todos os itens do lote e disponibilizar em
   `GET /batches/{id}` o link de assinatura de cada item WHEN o lote for válido e a
   Clicksign estiver operacional.
3. O sistema SHALL manter a taxa de requisições à Clicksign abaixo do limite do
   ambiente (20 req/10s sandbox, 50 req/10s produção) WHEN processar qualquer lote.
4. O sistema SHALL rejeitar o lote inteiro com `400` e erros por item WHEN qualquer
   item tiver validação inválida (signer sem nome; `delivery: "whatsapp"` sem
   `phone_number`; `delivery: "email"` sem `email`; base64 não decodificável; PDF > 10 MB).
5. O sistema SHALL NOT expor o access token da Clicksign em nenhuma resposta, log ou
   mensagem de erro IF qualquer requisição falhar.
6. O sistema SHALL responder `401` WHEN a requisição não contiver o header `x-api-key`
   com o valor configurado.
7. O sistema SHALL marcar item como `failed` com a mensagem de erro da Clicksign e
   continuar os demais itens WHEN a Clicksign retornar erro definitivo (4xx exceto 429)
   para um item.
8. O sistema SHALL reprocessar automaticamente com backoff WHEN a Clicksign retornar
   429, sem marcar o item como `failed`.
9. O sistema SHALL retomar o processamento de itens `pending`/`processing` WHEN a API
   reiniciar durante um lote.
10. O sistema SHALL disparar a notificação da Clicksign pelo canal escolhido WHEN
    `delivery` for `email` ou `whatsapp`, e SHALL NOT disparar notificação IF
    `delivery` for `link`.

## Fora do escopo

- App desktop Tauri (spec separada, dependente desta).
- Múltiplos documentos por envelope ou múltiplos signatários por documento.
- Webhooks da Clicksign / atualização de status de assinatura pós-envio (consultável
  manualmente; automação fica para spec futura).
- Autenticações avançadas (biometria, Pix, ICP-Brasil) — somente token por
  e-mail/SMS/WhatsApp.
- Widget Embedded (produto pago; o link usa a página hospedada da Clicksign).
- Gestão de usuários/permissões — uma única API key estática.
- Download do documento assinado.

## Dependências

- Clicksign API v3 (sandbox validado em 2026-07-01; código base em `src/clicksign.ts`).
- Formato do link de assinatura não documentado oficialmente — confirmado via evento
  `add_signer` (ver memória do projeto `clicksign-v3-sign-link`). **Risco:** pode mudar
  sem aviso; mitigação: ler o `url` do evento `add_signer` em vez de montar a string.
- Nenhuma dependência de outras specs. A spec do app desktop dependerá desta.

## Configuração (env)

- `CLICKSIGN_BASE_URL` (sandbox/produção — decide também o rate limit aplicado)
- `CLICKSIGN_ACCESS_TOKEN`
- `API_KEY` (chave estática exigida no header `x-api-key`)
- `DATABASE_PATH` (arquivo SQLite)
- `PORT`
