# Referência de código — desktop-tauri

Este documento percorre **todo arquivo-fonte do app desktop** (`desktop-tauri/`)
explicando o papel de cada função, variável, constante, tipo e classe. Para a
visão geral de arquitetura (por que existe, como os pedaços se encaixam,
histórico da migração do sidecar), veja [README.md](README.md) e
[MIGRATION-PLAN.md](MIGRATION-PLAN.md) — este arquivo é o nível abaixo: o que
cada linha de código faz.

Não cobre `src/` (API standalone da raiz) nem `desktop/` (app Perry) — só o
app Tauri em uso, per escopo pedido.

## Índice

- [Camada de UI](#camada-de-ui)
  - [src/main.ts](#srcmaints)
  - [src/App.vue](#srcappvue)
  - [src/validation.ts](#srcvalidationts)
- [Camada nativa — `src/native/`](#camada-nativa--srcnative)
  - [native/batch.ts](#nativebatchts)
  - [native/clicksign.ts](#nativeclicksignts)
  - [native/rate-limiter.ts](#nativerate-limiterts)
  - [native/throttled-clicksign.ts](#nativethrottled-clicksignts)
  - [native/process-item.ts](#nativeprocess-itemts)
  - [native/worker.ts](#nativeworkerts)
  - [native/repository.ts](#nativerepositoryts)
  - [native/pdf-store.ts](#nativepdf-storets)
  - [native/session.ts](#nativesessionts)
- [Camada Rust — `src-tauri/src/`](#camada-rust--src-taurisrc)
  - [main.rs](#mainrs)
  - [lib.rs](#librs)

---

## Camada de UI

### `src/main.ts`

Ponto de entrada do frontend. Três linhas: importa o componente raiz `App`,
importa o CSS global (`style.css`, Tailwind) e monta a aplicação Vue no
elemento `#app` do `index.html`. Não há nada de lógica aqui — é só o
bootstrap padrão de qualquer app Vue 3 com Vite.

### `src/App.vue`

Único componente da aplicação — toda a UI (conexão, lista de documentos,
lote) vive aqui. Usa `<script setup lang="ts">` (Composition API).

#### Tipos e constantes do módulo

| Nome | O que é |
|---|---|
| `Draft` (interface) | Um documento na tela, do momento em que o PDF é adicionado até o lote terminar de processar. Existe **antes** de haver um item real no banco — por isso a maioria dos campos é opcional/nula até o envio. Ver comentários de campo no próprio arquivo (`path`, `bytes`, `phone`, `status`, `itemId`). |
| `DELIVERY_LABELS` | `Record<Delivery, string>` — rótulo exibido no `<select>` de cada linha, uma entrada por valor de `Delivery` (`link`, `email`, `whatsapp`, `handwritten`). Como é um `Record` completo, o TypeScript obriga a cobrir todo valor novo de `Delivery` aqui — se um dia adicionar um 5º delivery e esquecer este mapa, o build quebra. |

#### Estado do módulo (fora do `setup`, não reativo por padrão)

| Nome | Tipo | Papel |
|---|---|---|
| `store` | `Store` (plugin-store) | Persistência de `config.json` em `app_data_dir()` — guarda `clicksignToken` e `clicksignEnv` entre execuções. Atribuída em `onMounted`. |
| `session` | `BatchSession \| null` | A sessão nativa ativa (repo + pdfStore + cliente Clicksign + worker) do ambiente conectado. `null` até o primeiro `saveAndConnect()` bem-sucedido. Não é `ref` — trocá-la não precisa re-renderizar nada sozinha. |
| `activeBatchId` | `string \| null` | Id do lote em processamento atual. |
| `pollTimer` | `ReturnType<typeof setInterval> \| null` | Handle do intervalo de polling; `null` quando não há polling rodando. |

#### Estado reativo (`ref`/`computed`)

| Nome | Papel |
|---|---|
| `clicksignToken` | Valor do campo de token na UI (v-model). |
| `clicksignEnv` | Ambiente selecionado no dropdown (`'sandbox' \| 'producao'`) — pode divergir de `activeEnv` enquanto a troca não foi confirmada/concluída. |
| `activeEnv` | Ambiente que a sessão **de fato** está rodando agora; controla o selo colorido no cabeçalho (amarelo "Sandbox", vermelho "Produção"). |
| `connStatus` | Resultado do último `testConnection()`: `'idle' \| 'testing' \| 'ok' \| 'chave-invalida' \| 'inacessivel'`. |
| `drafts` | Array reativo de `Draft` — a lista de documentos mostrada na tela. |
| `sending` | `true` enquanto o lote atual tem item pendente/processando; desabilita o botão "Enviar lote". |
| `batchStatus` | Texto do rodapé da tela. |
| `batchTone` | Cor do rodapé: `'ok' \| 'erro' \| 'neutro'`. |
| `connLabel` (computed) | Texto do selo de conexão, derivado de `connStatus`. |
| `connTone` (computed) | Cor do selo de conexão. |
| `justCopied` | Path do draft cujo link foi copiado por último (feedback "Copiado ✓" por 2s). |
| `justCopiedAll` | `true` por 2s depois de "Copiar todos os links". |

#### Funções

| Função | Assinatura | O que faz |
|---|---|---|
| `toBase64` | `(bytes: Uint8Array) => string` | Converte os bytes crus do PDF (lidos via `plugin-fs`) para base64 — formato que a API da Clicksign espera no `content_base64`. |
| `formatPhone` | `(digits: string) => string` | Aplica a máscara `(11) 99999-9999` progressivamente conforme o usuário digita; corta em 11 dígitos. |
| `onPhoneInput` | `(draft, event) => void` | Handler do campo de telefone. Usa `:value` em vez de `v-model` porque o valor **exibido** é a versão mascarada, não o que o usuário digitou cru. |
| `onMounted` (hook) | — | Carrega `clicksignToken`/`clicksignEnv` do store; se já havia um token salvo, reconecta sozinho (`skipProductionConfirm: true` — não repete o aviso de produção numa reabertura do app). |
| `saveAndConnect` | `(options?) => Promise<void>` | Fluxo principal de conexão: (1) se está indo para produção e não é reconexão automática, pede confirmação via `ask()` (diálogo nativo) — texto avisa que documentos terão valor legal; (2) salva token/ambiente no store; (3) encerra a sessão anterior se houver (`session.stop()`); (4) abre `startSession()` nova; (5) roda `testConnection()` e grava o resultado em `connStatus`. Qualquer exceção vira `connStatus = 'inacessivel'` e uma mensagem no rodapé. |
| `addPdfs` | `() => Promise<void>` | Abre o diálogo nativo de arquivos (`plugin-dialog`, multi-seleção, filtro `*.pdf`), lê cada arquivo escolhido (`plugin-fs`) e empurra um novo `Draft` em `drafts` por arquivo, todos com `delivery: 'link'` por padrão. |
| `removeDraft` | `(index: number) => void` | Remove um draft da lista (antes do envio) via `splice`. |
| `buildPayload` | `() => BatchItemPayload[]` | Converte os `Draft` da tela para o formato que `validateBatchItems`/`session.createBatch` esperam — nome/email/telefone "trimados", telefone sem máscara. |
| `sendBatch` | `() => Promise<void>` | Fluxo de envio: valida (`validateBatchItems`), se houver erro marca cada `draft.errorMessage` pelo índice e para; senão chama `session.createBatch(items, pdfsBase64)`, guarda `activeBatchId`, marca todos os drafts como `pending` e liga `startPolling()`. |
| `startPolling` | `() => void` | `setInterval` de 1s: busca `session.getBatch(activeBatchId)`, atualiza `status`/`signUrl`/`errorMessage` de cada draft pelo índice, e quando todos os itens estiverem `done` ou `failed` (`settled === total`) para o timer e escreve a mensagem final no rodapé. |
| `retryDraft` | `(draft: Draft) => Promise<void>` | Chama `session.retryItem(activeBatchId, draft.itemId)`, volta o draft para `pending` e religa o polling se ele já tinha parado (lote antes 100% concluído, agora com um item novo). |
| `copyLink` | `(draft: Draft) => Promise<void>` | Copia `draft.signUrl` para a área de transferência (`plugin-clipboard-manager`); mostra "Copiado ✓" por 2s. Falha (ex.: outro app segurando o clipboard) vira `draft.actionError` em vez de passar em silêncio. |
| `openLink` | `(draft: Draft) => Promise<void>` | Abre `draft.signUrl` no navegador padrão do SO (`plugin-opener`). |
| `copyAllLinks` | `() => Promise<void>` | Monta uma lista `"nome: link"` (um por linha) de todos os drafts já concluídos e copia tudo de uma vez; se nenhum link estiver pronto ainda, avisa no rodapé em vez de copiar vazio. |
| `statusLabel` | `(draft: Draft) => string` | Texto de status de uma linha: erro tem prioridade sobre o status bruto (`errorMessage` non-null vence qualquer `status`). |
| `statusClass` | `(draft: Draft) => string` | Cor do texto de status (vermelho erro/falha, verde concluído, cinza resto). |

#### Template

Estrutura: cabeçalho com título e selo de ambiente → seção de conexão
(token + select de ambiente + botão "Salvar e conectar" + selo de status) →
barra de ações ("+ Adicionar PDF", "Enviar lote", "Copiar todos os links",
contador) → lista de cartões (um por `draft`, com nome/e-mail/telefone/select
de delivery, link clicável quando pronto, botões de ação) → rodapé com
`batchStatus`.

### `src/validation.ts`

Validação client-side do lote — roda **antes** de qualquer chamada à
Clicksign, espelhando as mesmas regras do backend standalone
(`src/domain/validation.ts`), reimplementada aqui porque o motor do webview
não tem `Buffer` do Node para decodificar base64.

| Nome | Tipo | O que é/faz |
|---|---|---|
| `BatchItemPayload` (interface) | tipo | Formato de um item pronto para envio: nome do arquivo, conteúdo em base64, dados do signatário, delivery. |
| `ItemValidationError` (interface) | tipo | Um erro de validação: índice do item na lista, campo, mensagem em português para exibir na UI. |
| `EMAIL_PATTERN` | `RegExp` | Checagem de formato simples (não é RFC 5322 completo) — suficiente para pegar erro de digitação óbvio. |
| `MAX_PDF_BYTES` | `number` | `10 * 1024 * 1024` — limite de tamanho de documento da própria Clicksign. |
| `validateBatchItems` | `(items) => ItemValidationError[]` | Roda `validateItem` em cada item do lote e concatena os erros (`flatMap`); lista vazia = tudo certo. |
| `validateItem` | `(item, index) => ItemValidationError[]` | Regras por item: (1) nome precisa ter nome **e** sobrenome (≥ 2 palavras); (2) nome não pode conter dígitos; (3) `delivery === 'email'` exige e-mail válido; (4) `delivery === 'whatsapp'` exige telefone com ≥ 10 dígitos (DDD); (5) se um e-mail foi informado (qualquer delivery), precisa ser válido; (6) **todo** item precisa de e-mail OU telefone, mesmo em `'link'`/`'handwritten'` — a Clicksign exige contato para a notificação `document_signed`, que nunca pode ser `'none'`; (7) valida o PDF via `validatePdf`. |
| `isValidEmail` | `(email) => boolean` | `undefined` ou não bate com `EMAIL_PATTERN` → `false`. |
| `validatePdf` | `(contentBase64, index) => ItemValidationError[]` | Decodifica o base64 (erro de decodificação vira erro de validação), confere que os primeiros bytes são a assinatura `%PDF`, e que o tamanho não passa de `MAX_PDF_BYTES`. |

---

## Camada nativa — `src/native/`

Módulos portados de `src/` (a API standalone Node) trocando as bordas de I/O
por plugins do Tauri — a lógica de domínio/negócio é idêntica.

### `native/batch.ts`

Domínio puro do lote: tipos e as transições de estado válidas. Zero
dependência de Tauri/Node — só TypeScript.

| Nome | Tipo | O que é |
|---|---|---|
| `Delivery` | `'email' \| 'whatsapp' \| 'link' \| 'handwritten'` | Como o signatário é notificado e autenticado. Ver `authMethodFor`/`communicateEventsFor` em `process-item.ts` para o que cada valor implica na prática. |
| `Signer` (interface) | tipo | `name`, `email?`, `phoneNumber?` — pelo menos um contato é exigido pela validação. |
| `BaseItem` (interface, privada) | tipo | Campos comuns a todo item: `id` (UUID gerado pelo repositório), `batchId`, `filename`, `signer`, `delivery`, `retryCount` (começa em 0). |
| `PendingItem` / `ProcessingItem` / `DoneItem` / `FailedItem` (interfaces) | tipo | `BaseItem` + um `status` literal específico; `DoneItem` acrescenta `envelopeId`/`signerId`/`signUrl`, `FailedItem` acrescenta `errorMessage`. |
| `BatchItem` | união discriminada | `PendingItem \| ProcessingItem \| DoneItem \| FailedItem` — o TypeScript só deixa acessar `envelopeId`/`errorMessage`/etc. depois de checar `status` no branch certo. |
| `Batch` (interface) | tipo | `id`, `createdAt`, `items: BatchItem[]` — retorno de `BatchRepository.getBatch`. |
| `ClicksignResult` (interface) | tipo | `envelopeId`, `signerId`, `signUrl` — o que `processItem` devolve ao ter sucesso; vira os campos extras de `DoneItem` via `complete()`. |
| `invalidTransition` | `(action, expected, item) => never` | Lança o erro padrão "Transição inválida" usado por todas as funções de transição abaixo. |
| `startProcessing` | `(item) => ProcessingItem` | `pending → processing`. Chamada pelo claim atômico do repositório (na prática, a transição já acontece dentro do `UPDATE ... RETURNING` do SQL — esta função é o espelho em memória/para testes). |
| `complete` | `(item, result) => DoneItem` | `processing → done`, grava `envelopeId`/`signerId`/`signUrl` do resultado. |
| `fail` | `(item, errorMessage) => FailedItem` | `processing → failed`. |
| `resetForRetry` | `(item) => PendingItem` | `failed → pending`: descarta `errorMessage` e incrementa `retryCount`. |

Todas as funções de transição lançam se o item não estiver no status
esperado — isso é o que torna ilegal, por exemplo, tentar `complete()` um
item que já está `done`.

### `native/clicksign.ts`

Cliente HTTP mínimo para a API v3 da Clicksign (JSON:API). Único ponto do
app que fala com a rede — via `fetch` do `@tauri-apps/plugin-http` (roda no
processo Rust, não no motor do webview, então não sofre CORS).

#### Tipos

| Nome | O que é |
|---|---|
| `ClicksignConfig` | `{ baseUrl, accessToken }` — configuração passada ao construtor. |
| `JsonApiResource<A>` | Forma padrão de um recurso JSON:API: `id`, `type`, `attributes: A`, `links?`, `relationships?`. |
| `JsonApiDocument<T>` (privado) | Envelope de resposta: `{ data: T, errors?: [...] }`. |
| `EnvelopeAttributes` | Atributos de um envelope: `name`, `status` (`'draft' \| 'running' \| 'canceled' \| 'closed'`), `locale`, `auto_close`, `deadline_at`. |
| `SignerAttributes` | Atributos de um signatário: `name`, `email`, `status?`, `communicate_events?`. |
| `EventAttributes` | Atributos de um evento do envelope: `name`, `data` (contém `signers?: [{key, url?}]` para o evento `add_signer`), `created`. |
| `RateLimitInfo` | `{ limit, remaining, resetAtMs }` — estado do rate limit reportado pelos headers `X-Rate-Limit*`. `resetAtMs` já é convertido de Unix-seconds para milissegundos. |

#### Funções e classes

| Nome | O que faz |
|---|---|
| `parseRateLimitHeaders` | `(headers) => RateLimitInfo` — lê `x-rate-limit`, `x-rate-limit-remaining`, `x-rate-limit-reset`; qualquer um ausente ou não-numérico vira `null` no campo correspondente. |
| `ClicksignError` (classe, extends `Error`) | Erro tipado com `status` (HTTP), `body` (texto cru da resposta) e `rateLimitResetAtMs` (só preenchido quando `status === 429`, usado pelo `ThrottledClicksign` para saber exatamente quando reagendar a tentativa). |
| `ClicksignClient` (classe) | Ver métodos abaixo. Guarda `config` (imutável) e `lastRateLimitInfo` (atualizado a cada resposta, sucesso ou erro). |
| `ClicksignClient.getLastRateLimitInfo` | Devolve o último `RateLimitInfo` visto em qualquer resposta — usado por `ThrottledClicksign` para decidir se deve esperar proativamente antes da próxima chamada. |
| `ClicksignClient.request` (privado) | Faz **uma** requisição HTTP: monta headers (`Authorization`, `Accept`/`Content-Type: application/vnd.api+json`), serializa o body se houver, atualiza `lastRateLimitInfo`, e lança `ClicksignError` se `!response.ok` (incluindo o `resetAtMs` quando é 429). Todo método público do cliente é uma chamada a este. |
| `ClicksignClient.createEnvelope` | `POST /envelopes` — cria o envelope (contêiner do lote) em status `draft`. |
| `ClicksignClient.addDocument` | `POST /envelopes/:id/documents` — anexa o PDF como data URI base64 (`data:application/pdf;base64,...`). |
| `ClicksignClient.addSigner` | `POST /envelopes/:id/signers` — registra o signatário; `communicateEvents` default é tudo `'none'`/`'email'` caso não seja passado (mas `process-item.ts` sempre passa um valor explícito). |
| `ClicksignClient.addQualificationRequirement` | `POST /envelopes/:id/requirements` com `{action: 'agree', role: 'sign'}` — define o papel do signatário no documento. |
| `ClicksignClient.addAuthenticationRequirement` | Idem, com `{action: 'provide_evidence', auth}`, onde `auth` é `'email' \| 'sms' \| 'whatsapp' \| 'handwritten'` (padrão `'email'`). `'handwritten'` dispensa token: a assinatura desenhada na tela é a própria prova de identidade. |
| `ClicksignClient.addRequirement` (privado) | POST genérico de requirement — usado pelos dois métodos acima, que só variam os `attributes`. |
| `ClicksignClient.activateEnvelope` | `PATCH /envelopes/:id` com `{status: 'running'}` — sem isso o envelope fica em rascunho e ninguém consegue assinar. |
| `ClicksignClient.getEnvelope` | `GET /envelopes/:id` — usado por `session.testConnection()` só para validar token/rede (um 404 aqui ainda conta como "token válido", já que autenticou). |
| `ClicksignClient.listSigners` | `GET /envelopes/:id/signers` — não usado no fluxo principal, utilitário de depuração. |
| `ClicksignClient.getEnvelopeEvents` | `GET /envelopes/:id/events` — o evento `add_signer` traz a URL real de assinatura de cada signatário; é como `process-item.ts` resolve `signUrl`. |
| `ClicksignClient.notifySigner` | `POST /envelopes/:id/signers/:id/notifications` — dispara a notificação de solicitação de assinatura pelo canal já configurado no signatário (`communicate_events`). |
| `ClicksignClient.signUrl` | `(signerId) => string` — monta o link de assinatura pelo formato conhecido (`/notarial/widget/signatures/:id/redirect`), usado como **fallback** caso o evento `add_signer` não traga a URL. |

### `native/rate-limiter.ts`

Limitador de vazão por **janela deslizante**: garante que nunca há mais que
`capacity` aquisições em qualquer janela de `windowMs` milissegundos — a
garantia exata que o rate limit da Clicksign exige. (Um token bucket
clássico com balde cheio permitiria estourar o limite real na primeira
rajada; por isso não é essa a implementação aqui.)

| Nome | O que é/faz |
|---|---|
| `TokenBucketConfig` (interface) | `{ capacity, windowMs }`. |
| `TokenBucket` (classe) | Ver campos e métodos abaixo. |
| `capacity` / `windowMs` (campos privados) | Limites configurados no construtor; validados (`>= 1`) — lança se algum vier zero ou negativo. |
| `timestamps` (campo privado) | Array dos instantes (ms) das aquisições ainda "dentro" da janela atual. |
| `waiters` (campo privado) | Fila de `resolve` de promises esperando uma vaga abrir. |
| `timer` (campo privado) | Handle do `setTimeout` agendado para liberar o próximo waiter; `null` quando não há nada agendado. |
| `acquire` | `() => Promise<void>` — resolve na hora se `tryAcquire()` conseguir vaga; senão entra na fila (`waiters`) e agenda uma nova tentativa (`scheduleRelease`). |
| `tryAcquire` (privado) | Poda timestamps velhos (`prune`); se ainda há espaço (`< capacity`), registra `Date.now()` e devolve `true`; senão `false`. |
| `prune` (privado) | Remove do início do array todo timestamp mais velho que `windowMs`. |
| `scheduleRelease` (privado) | Agenda um `setTimeout` para o momento em que a vaga mais antiga expira (ou 1ms se a fila já estiver vazia); ao disparar, libera quantos waiters couberem e reagenda se ainda sobrar alguém. `timer.unref()` evita que esse timer sozinho segure o processo vivo. |

### `native/throttled-clicksign.ts`

Envolve o `ClicksignClient` com controle de vazão (via `TokenBucket`) e
retry automático em `429`.

| Nome | O que é/faz |
|---|---|
| `ThrottleOptions` (interface) | `baseDelayMs` (padrão 2000 — base do backoff exponencial quando não há header), `maxRetries` (padrão 5), `jitter` (padrão `Math.random`, injetável para testes determinísticos), `proactiveThreshold` (padrão 1 — `remaining` igual ou abaixo disso dispara espera proativa). |
| `ThrottledClicksign` (classe) | Ver método `run` e privados abaixo. |
| `run` | `<T>(fn: (client) => Promise<T>) => Promise<T>` — loop de tentativas: adquire vaga no bucket (`bucket.acquire()`), espera proativamente se o servidor já avisou `remaining` baixo, executa `fn`; em erro que **não** seja 429 (ou depois de esgotar `maxRetries`), relança; em 429, espera (`delayFor`) e tenta de novo. Contrato: `fn` deve fazer **exatamente uma** requisição HTTP, senão a contagem do bucket fica errada. |
| `waitIfServerReportedLowRemaining` (privado) | Consulta `client.getLastRateLimitInfo()`; se `remaining` está acima do limiar, não faz nada; senão espera até `resetAtMs` (+ jitter) antes de deixar a próxima chamada prosseguir — evita gastar uma tentativa que sabidamente vai voltar 429. |
| `delayFor` (privado) | Se o erro trouxe `rateLimitResetAtMs` (header real), espera exatamente até esse instante (+ jitter); senão cai no backoff exponencial "no escuro" (`baseDelayMs * 2^attempt`, com jitter multiplicativo). |
| `jitterMs` (privado) | 250-500ms de folga aleatória somada sobre o instante de reset exato — evita todas as chamadas presas retomarem no exato mesmo milissegundo. |
| `isRateLimit` | `(error) => error is ClicksignError` — `true` só para `status === 429`; qualquer outro erro (4xx/5xx/rede) sobe direto, sem retry. |
| `sleep` | `(ms) => Promise<void>` — `setTimeout` promisificado. |

### `native/process-item.ts`

O pipeline de processamento de **um** item do lote, do envelope vazio até o
link de assinatura pronto.

| Nome | O que é/faz |
|---|---|
| `ProcessItemDeps` (interface) | Dependências injetadas: `clicksign` (`ThrottledClicksign`), `readPdfBase64` (lê o PDF do item do armazenamento local), `signUrlFallback` (monta o link caso o evento `add_signer` não traga a URL). |
| `CommunicateEvents` (interface, privada) | Forma dos três campos de notificação exigidos pela Clicksign: `signature_request`, `signature_reminder`, `document_signed`. |
| `contactChannelFor` | `(delivery, hasEmail, hasPhone) => 'email' \| 'whatsapp'` — canal usado tanto para `communicate_events` quanto (via `authMethodFor`) para o requisito de autenticação; ambos exigem `'email'`/`'whatsapp'` explícito, nunca `'none'`. Para `delivery` `'whatsapp'`/`'email'` usa a própria escolha do usuário (já validada); para `'link'`/`'handwritten'` (sem canal explícito) escolhe pelo contato disponível, preferindo e-mail. Lança se não houver nem e-mail nem telefone (não deveria acontecer — a validação já barra isso antes). |
| `communicateEventsFor` | `(delivery, contactChannel) => CommunicateEvents` — `'email'`: tudo por e-mail. `'whatsapp'`: solicitação por WhatsApp, sem lembrete, confirmação por WhatsApp. `'link'`/`'handwritten'`: sem solicitação nem lembrete automáticos (envio é manual/já sem token), mas a confirmação de assinatura (`document_signed`) ainda vai por `contactChannel` — a Clicksign exige isso sempre. |
| `authMethodFor` | `(delivery, contactChannel) => 'email' \| 'whatsapp' \| 'handwritten'` — `'handwritten'` dispensa token (a assinatura desenhada é a prova); qualquer outro delivery usa o canal de contato normal. |
| `processItem` | `(item, deps) => Promise<ClicksignResult>` — a sequência completa: `createEnvelope` → `addDocument` (lê o PDF via `deps.readPdfBase64`) → resolve `contactChannel` → `addSigner` (com `communicateEventsFor`) → `addQualificationRequirement` → `addAuthenticationRequirement` (com `authMethodFor`) → `activateEnvelope` → `resolveSignUrl` → se `delivery !== 'link'`, dispara `notifySigner` (envio manual não notifica pela Clicksign). Cada chamada passa por `clicksign.run(...)`, então já está sob rate limit e retry. |
| `resolveSignUrl` (privado) | Busca os eventos do envelope (`getEnvelopeEvents`), procura o evento `add_signer` e extrai a `url` do signatário; se não encontrar (nunca visto acontecer, mas tratado), cai no `signUrlFallback` com um aviso no console. |

### `native/worker.ts`

Fila sequencial: reivindica um item por vez, processa, grava o resultado.
Um item com erro vira `failed` e o loop **continua** para os próximos — uma
falha isolada não trava o lote inteiro.

| Nome | O que é/faz |
|---|---|
| `WorkerDeps` (interface) | `repo` (`BatchRepository`), `process` (a função que efetivamente fala com a Clicksign — normalmente `processItem` com as deps fechadas em `session.ts`), `removePdf` (apaga o PDF do disco ao concluir). |
| `QueueWorker` (classe) | Ver campos e métodos. |
| `running` (campo privado) | `false` antes de `start()` ou depois de `stop()` — `wake()` vira no-op nesse estado. |
| `draining` (campo privado) | `Promise<void> \| null` — o ciclo de drenagem em andamento; `null` quando a fila está ociosa. Existe para tornar `drain()` **reentrante**: chamadas concorrentes (ex.: `wake()` disparado duas vezes seguidas) esperam o mesmo ciclo em vez de rodar dois loops em paralelo. |
| `start` | `() => Promise<void>` — no boot, chama `repo.reclaimStale()` (itens presos em `processing` de uma queda anterior voltam para `pending`), loga quantos foram retomados, liga `running` e chama `wake()`. |
| `stop` | `() => void` — desliga `running`; um drain já em andamento termina o item atual mas não reivindica mais nenhum depois. |
| `wake` | `() => void` — sinaliza que há trabalho novo (chamado depois de criar um lote ou de um retry); só age se `running`. |
| `drain` | `() => Promise<void>` — se já há um ciclo rodando, devolve a mesma promise; senão inicia `processUntilEmpty()` e limpa `draining` ao final (sucesso ou erro). |
| `processUntilEmpty` (privado) | Loop real: `repo.claimNextPending()` até vir `null` (fila vazia). Para cada item: tenta `deps.process(item)`; sucesso → `complete()` + `saveItemResult` + `removePdf`; erro → `fail()` + `saveItemResult` + log no console (**sem** relançar — o loop segue para o próximo item). |

### `native/repository.ts`

Persistência do lote via `@tauri-apps/plugin-sql` (SQLite/sqlx rodando no
processo Rust, sem processo separado).

| Nome | O que é/faz |
|---|---|
| `BatchItemInput` (interface) | O que é preciso para **criar** um item — sem `id`/`status`/`retryCount`, que o repositório preenche. |
| `ItemRow` (interface, privada) | Forma exata de uma linha da tabela `items` (nomes de coluna em `snake_case`, exatamente como o SQLite devolve). |
| `BatchRepository` (classe) | Ver construtor e métodos. |
| `constructor` (privado) | Recebe a conexão `Database` (sqlx) já aberta — uma instância de `BatchRepository` = uma conexão = um ambiente (sandbox ou produção nunca compartilham repositório). |
| `load` (estático) | `(sqlitePath) => Promise<BatchRepository>` — `sqlitePath` é `'sandbox/batches.db'` ou `'producao/batches.db'`, tem que bater com um dos caminhos registrados em `add_migrations` no `lib.rs`. Abre a conexão via `Database.load('sqlite:' + sqlitePath)`. |
| `close` | `() => Promise<void>` — fecha a conexão (na troca de ambiente ou ao encerrar a sessão). |
| `createBatch` | `(items) => Promise<Batch>` — gera um UUID de lote, insere a linha em `batches` e uma linha por item em `items`, tudo dentro de uma transação (`BEGIN`/`COMMIT`, `ROLLBACK` em qualquer erro) — ou tudo entra, ou nada entra. Devolve o lote recém-criado via `getBatch`. |
| `getBatch` | `(batchId) => Promise<Batch \| null>` — busca a linha do lote e todos os itens (ordenados por `seq`, a ordem de criação); `null` se o id não existir. |
| `claimNextPending` | `() => Promise<ProcessingItem \| null>` — o coração da fila: um único `UPDATE ... WHERE id = (SELECT ... status='pending' ORDER BY rowid LIMIT 1) RETURNING *`. É atômico — mesmo com múltiplas chamadas concorrentes (não deveria haver, mas a garantia é do SQL, não de lock em memória), cada linha só pode ser reivindicada uma vez. Lança se a linha retornada não estiver de fato em `processing` (bug de invariante). |
| `saveItemResult` | `(item: DoneItem \| FailedItem) => Promise<void>` — grava o resultado final: `done` grava `envelope_id`/`signer_id`/`sign_url` e limpa `error_message`; `failed` grava só `error_message`. |
| `reclaimStale` | `() => Promise<number>` — no boot, `UPDATE items SET status='pending' WHERE status='processing'` (itens presos por uma queda do app a meio de processamento); devolve quantas linhas foram afetadas. |
| `resetItemForRetry` | `(batchId, itemId) => Promise<PendingItem>` — busca o item, valida a transição via `resetForRetry` (só aceita item `failed`), grava `status='pending'` com `retry_count` incrementado e `error_message` limpo. |
| `rowToItem` (função de módulo, privada) | Converte uma `ItemRow` crua (snake_case, campos opcionais) para o `BatchItem` tipado do domínio — o `switch` sobre `row.status` garante que cada branch monta exatamente os campos daquele status (ex.: `done` lança se faltar `envelope_id`/`signer_id`/`sign_url`, o que indicaria corrupção de dado). |

### `native/pdf-store.ts`

Guarda os PDFs do lote em disco (não no SQLite) — decodificados de base64,
um arquivo por item, removidos quando o item conclui para não acumular
espaço.

| Nome | O que é/faz |
|---|---|
| `base64ToBytes` / `bytesToBase64` | Conversões puras entre base64 e `Uint8Array`, usando `atob`/`btoa` do runtime do webview (sem `Buffer` do Node). |
| `PdfStore` (classe) | Ver construtor e métodos. |
| `constructor` (privado) | Recebe `dir`, o caminho absoluto de `<app_data_dir>/<env>/pdfs`, resolvido uma vez em `load()`. |
| `load` (estático) | `(env: 'sandbox' \| 'producao') => Promise<PdfStore>` — resolve o diretório via `appDataDir()` + `join()`; **não cria** o diretório ainda (isso é `save()` que faz, sob demanda). |
| `save` | `(itemId, contentBase64) => Promise<void>` — cria o diretório na primeira vez (`mkdir` recursivo) e grava o arquivo `<itemId>.pdf`. |
| `readBase64` | `(itemId) => Promise<string>` — lê o arquivo de volta e devolve como base64, pronto para `addDocument`. |
| `remove` | `(itemId) => Promise<void>` — apaga o arquivo se existir (chamado pelo worker ao concluir um item). |
| `pathFor` (privado) | `(itemId) => Promise<string>` — monta `<dir>/<itemId>.pdf`. |

### `native/session.ts`

O módulo de integração: monta tudo que uma "sessão" de ambiente precisa e
devolve uma API só com o que o `App.vue` usa. É o substituto direto do
antigo `start_sidecar` (Rust) — mesma responsabilidade, sem processo
separado.

| Nome | O que é/faz |
|---|---|
| `Environment` | `'sandbox' \| 'producao'`. |
| `ConnectionStatus` | `'ok' \| 'chave-invalida' \| 'inacessivel'`. |
| `BatchSession` (interface) | O contrato exposto ao `App.vue`: `createBatch`, `getBatch`, `retryItem`, `testConnection`, `stop` (ver docs de cada campo no próprio arquivo). |
| `CLICKSIGN_BASE_URLS` | `Record<Environment, string>` — host da API por ambiente (`sandbox.clicksign.com` / `app.clicksign.com`). Nunca mesclar: contas e dados completamente separados na Clicksign. |
| `startSession` | `(env, clicksignToken) => Promise<BatchSession>` — monta, nesta ordem: `BatchRepository.load` (banco do ambiente), `PdfStore.load`, `ClicksignClient` (com a base URL do ambiente), `TokenBucket` (capacidade 16/10s sandbox, 40/10s produção — 20% de margem sobre o limite oficial da Clicksign), `ThrottledClicksign`, e o `QueueWorker` (cujo `process` já fecha as deps de `processItem`: cliente throttled, leitor de PDF, fallback de link). Chama `worker.start()` (que já retoma itens presos) antes de devolver o objeto `BatchSession`. |
| `createBatch` (método do objeto devolvido) | Cria o lote no repositório, **depois** salva os PDFs de cada item (em paralelo via `Promise.all`) e só então acorda o worker — nessa ordem para o worker nunca tentar ler um PDF que ainda não foi escrito. |
| `getBatch` (método) | Repassa direto para `repo.getBatch`. |
| `retryItem` (método) | `repo.resetItemForRetry` seguido de `worker.wake()`. |
| `testConnection` (método) | Chama `throttled.run(c => c.getEnvelope(<uuid zerado>))` — **importante**: passa por `throttled`, não pelo `client` direto, para compartilhar o bucket com o worker e reaproveitar o retry em 429 (sem isso, um 429 durante um lote grande em andamento vira "inacessível" por engano). Um 404 aqui conta como `'ok'` (autenticou; só o envelope de teste não existe); 401 vira `'chave-invalida'`; qualquer outro erro vira `'inacessivel'`. |
| `stop` (método) | Para o worker e fecha a conexão do repositório. |

---

## Camada Rust — `src-tauri/src/`

### `main.rs`

Ponto de entrada do binário. `#![cfg_attr(not(debug_assertions),
windows_subsystem = "windows")]` some com a janela de console no Windows em
build de release (comentário `DO NOT REMOVE!!` no próprio arquivo — sem
essa linha, o app abriria um terminal preto atrás da janela). A função
`main()` só chama `app_lib::run()` — a lógica real mora em `lib.rs`,
separada assim para permitir também alvos mobile via
`tauri::mobile_entry_point`.

### `lib.rs`

Monta o app Tauri: plugins, migrations do banco, diretórios de dados. Não
há **nenhum** `#[tauri::command]`/IPC customizado — toda a lógica de negócio
roda do lado TypeScript (`native/`), falando com os plugins nativos
diretamente pelos pacotes `@tauri-apps/plugin-*`.

| Nome | O que é/faz |
|---|---|
| `SCHEMA_SQL` (constante) | O DDL completo do banco: `PRAGMA journal_mode = WAL` (essencial — sem ele, escritas concorrentes no mesmo arquivo têm bem mais chance de `SQLITE_BUSY`; é a paridade com o `node:sqlite` original, que já ligava WAL por padrão), tabela `batches` (`id`, `created_at`), tabela `items` (todas as colunas de `ItemRow` em `repository.ts` — `signer_email`/`signer_phone`/`envelope_id`/`signer_id`/`sign_url`/`error_message` nuláveis, `status` com default `'pending'`, `retry_count` com default `0`) e dois índices (`idx_items_status`, `idx_items_batch`) para as queries mais frequentes (`claimNextPending` filtra por status; `getBatch` filtra por `batch_id`). |
| `batch_migrations` | `() -> Vec<Migration>` — uma única migration (`version: 1`), registrada **duas vezes** no builder abaixo: uma para `sqlite:sandbox/batches.db`, outra para `sqlite:producao/batches.db`. Mesmo schema, bancos física e completamente separados. |
| `run` | `pub fn run()` — o entry point real. Registra, na ordem: `tauri-plugin-dialog` (diálogo nativo de arquivos/confirmação), `tauri-plugin-fs` (leitura/escrita de PDF), `tauri-plugin-clipboard-manager` (copiar link), `tauri-plugin-store` (persistência de `config.json`), `tauri-plugin-opener` (abrir link no navegador), `tauri-plugin-sql` (SQLite, com as duas migrations de `batch_migrations()`), `tauri-plugin-http` (chamadas à Clicksign sem CORS). No `.setup()`: em debug, liga `tauri-plugin-log` (nível `Info`) para poder depurar via console; sempre, garante que `sandbox/` e `producao/` existem dentro de `app_data_dir()` **antes** de qualquer `Database.load()` — o SQLite não cria diretório pai sozinho, e sem isso o primeiro boot falharia com `CANTOPEN` (achado real da migração, ver `MIGRATION-PLAN.md`). |

---

## Onde cada critério de robustez vive

Para quem for mexer no código, um mapa rápido de "onde procurar" por
preocupação transversal:

| Preocupação | Arquivo(s) |
|---|---|
| Rate limit da Clicksign (janela deslizante + retry em 429) | `rate-limiter.ts`, `throttled-clicksign.ts` |
| Retomada automática após crash a meio de um lote | `worker.ts` (`start`/`reclaimStale`), `repository.ts` (`reclaimStale`) |
| Isolamento sandbox/produção (dados nunca se misturam) | `session.ts` (`CLICKSIGN_BASE_URLS`), `lib.rs` (`add_migrations` duplo), `App.vue` (confirmação antes de conectar em produção) |
| Assinatura sem token (handwritten) | `batch.ts` (`Delivery`), `process-item.ts` (`authMethodFor`), `clicksign.ts` (`addAuthenticationRequirement`) |
| Validação antes de qualquer chamada de rede | `validation.ts` |
| Claim atômico de item da fila (sem duas execuções pegarem o mesmo item) | `repository.ts` (`claimNextPending`, via `UPDATE ... RETURNING`) |
