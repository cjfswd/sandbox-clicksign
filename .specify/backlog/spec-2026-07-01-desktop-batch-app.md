# spec-2026-07-01-desktop-batch-app

**Status:** draft
**Criada em:** 2026-07-01
**Autor:** Antonio Castillo (via sessão Claude)

---

## Contexto

Os operadores da Health+ precisam de um aplicativo desktop Windows, simples de instalar
(um instalador `.exe`/`.msi`, sem pré-requisitos manuais), para montar e enviar lotes de
documentos para assinatura via a **batch API** (spec-2026-07-01-clicksign-batch-api) e
distribuir os links de assinatura.

O app **nunca** fala diretamente com a Clicksign: consome exclusivamente a batch API,
autenticado por API key. O token da Clicksign permanece só no servidor.

> **Decisão de framework (pendente de verificação):** o usuário indicou o framework
> **Perry** (https://github.com/PerryTS/perry) no lugar de Tauri. O repositório ainda
> não pôde ser verificado (indisponibilidade de rede na sessão). O plan desta spec DEVE
> começar validando: existência/maturidade do Perry, capacidade de gerar instalador
> Windows autossuficiente e modelo de UI. Fallback registrado: Tauri 2. A spec abaixo é
> agnóstica de framework — nenhum critério depende dessa escolha.

## Usuário afetado

Operadores de TI/administrativo da Health+ (usuários não técnicos; interface em pt-BR).

## Fluxo principal

1. **Primeira execução:** o operador informa URL da batch API e a API key; o app valida
   com uma chamada de teste e persiste a configuração localmente.
2. **Montar lote:** o operador adiciona um ou mais PDFs (seletor de arquivos e/ou
   drag & drop). Para cada arquivo, preenche o destinatário (nome completo,
   e-mail e/ou telefone) e escolhe o tipo de envio (`email` | `whatsapp` | `link`),
   com um tipo padrão aplicável a todos.
3. **Enviar:** o app valida os campos localmente (espelhando as regras da API),
   converte os PDFs para base64 e faz `POST /batches`.
4. **Acompanhar:** o app consulta `GET /batches/{id}` periodicamente e mostra o
   progresso por item (pendente/processando/concluído/falhou).
5. **Distribuir:** para cada item concluído, o app exibe o link de assinatura com botão
   "copiar" (e "copiar todos"). Para itens `delivery=email/whatsapp`, indica que a
   Clicksign já notificou o destinatário.
6. **Histórico:** lotes enviados anteriormente ficam listados e reabríveis (status
   atualizado sob demanda via API).

## Fluxos alternativos

- **A1 — Validação local falha:** campos inválidos são destacados por item, antes de
  qualquer chamada à API; o envio fica bloqueado até corrigir.
- **A2 — API rejeita o lote (400):** os erros retornados (por índice de item) são
  mapeados de volta aos itens na tela.
- **A3 — Item failed:** o app mostra a mensagem de erro e oferece botão "tentar
  novamente" (`POST .../retry`).
- **A4 — API inacessível/API key inválida:** mensagem clara distinguindo erro de rede
  (endereço/conexão) de 401 (chave); acesso rápido à tela de configuração.
- **A5 — App fechado durante um lote:** o processamento continua no servidor; ao
  reabrir, o histórico recupera o lote e seu estado atual.

## Critérios de aceite (EARS)

1. O sistema SHALL permitir compor um lote com N arquivos PDF, cada um com seu
   destinatário e tipo de envio individual, WHEN o operador monta um lote.
2. O sistema SHALL validar localmente (nome e sobrenome; e-mail obrigatório para
   `email`; telefone obrigatório para `whatsapp`; arquivo é PDF ≤ 10 MB) e bloquear o
   envio com indicação por item WHEN houver campo inválido.
3. O sistema SHALL enviar o lote via `POST /batches` e exibir o progresso por item
   atualizado no máximo a cada 5 segundos WHEN houver lote em andamento.
4. O sistema SHALL exibir o link de assinatura com ação de copiar (individual e "copiar
   todos") WHEN um item estiver `done`.
5. O sistema SHALL exibir a mensagem de erro e oferecer retry via API WHEN um item
   estiver `failed`.
6. O sistema SHALL persistir URL da API e API key localmente e validá-las com uma
   chamada de teste WHEN o operador salvar a configuração.
7. O sistema SHALL recuperar lotes anteriores com seu estado atual WHEN o app for
   reaberto.
8. O sistema SHALL NOT conter, armazenar ou transmitir o access token da Clicksign
   IF qualquer funcionalidade for exercida (o app só conhece a API key da batch API).
9. O sistema SHALL ser distribuído como instalador Windows único que funciona sem
   instalação manual de runtimes WHEN instalado em Windows 10/11 64-bit.

## Fora do escopo

- Fluxo de assinatura dentro do app (o link abre no navegador do destinatário).
- Edição/visualização avançada de PDF (no máximo, preview simples).
- Múltiplos usuários/perfis ou permissões.
- Acompanhamento pós-assinatura (documento assinado, download) — spec futura.
- macOS/Linux.

## Dependências

- **spec-2026-07-01-clicksign-batch-api** (bloqueante): o app consome o contrato
  [contracts/batch-contract.ts](../../contracts/batch-contract.ts) — reutilizar os
  tipos/schemas Zod se o framework de UI for TypeScript.
- Decisão de framework: Perry (a verificar) vs. Tauri 2 (fallback) — resolver no plan.
