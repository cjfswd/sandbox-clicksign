<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { load, type Store } from '@tauri-apps/plugin-store';
import { openUrl } from '@tauri-apps/plugin-opener';
import { startSession, type BatchSession, type Environment } from './native/session';
import type { Batch, BatchItem, ClicksignStatus, Delivery } from './native/batch';
import type { HistoryFilter } from './native/history-query';
import { validateBatchItems, type BatchItemPayload } from './validation';

// Um documento na tela, do "adicionado" até "concluído" — existe antes do item existir no backend.
interface Draft {
  // Caminho no disco do usuário; usado como :key da linha (é estável e único por PDF escolhido).
  path: string;
  filename: string;
  // Conteúdo bruto do PDF, lido uma vez ao adicionar (convertido para base64 só no envio).
  bytes: Uint8Array;
  name: string;
  email: string;
  // Já formatado (11) 99999-9999 — ver formatPhone; dígitos puros são extraídos no envio.
  phone: string;
  delivery: Delivery;
  // 'idle' até o lote ser enviado; depois espelha o status real do item (pending/processing/done/failed).
  status: BatchItem['status'] | 'idle';
  signUrl: string | null;
  errorMessage: string | null;
  // Erro de copiar/abrir o link — separado de errorMessage (esse é do processamento na Clicksign).
  actionError: string | null;
  // Preenchido só depois que o lote é criado — liga este draft ao item real no banco (para retry).
  itemId: string | null;
}

// Rótulos exibidos no select de cada linha — uma entrada por Delivery.
const DELIVERY_LABELS: Record<Delivery, string> = {
  link: 'Somente link (envio manual)',
  email: 'E-mail (Clicksign envia)',
  whatsapp: 'WhatsApp (Clicksign envia)',
  handwritten: 'Assinatura manuscrita (sem token)',
};

// Store persistente (plugin-store) com token e ambiente salvos entre execuções — config.json em app_data_dir.
let store: Store;
// Sessão nativa (repo + pdfStore + cliente Clicksign + worker) do ambiente
// ativo — substitui o sidecar. Só o token da Clicksign é configurável.
let session: BatchSession | null = null;
// Campo de token digitado na UI (não confundir com o token realmente em uso pela sessão ativa).
const clicksignToken = ref('');
// Ambiente selecionado no dropdown — pode divergir de activeEnv enquanto a troca não é confirmada.
const clicksignEnv = ref<Environment>('sandbox');
// Ambiente que a sessão está de fato rodando agora (para o selo no header).
const activeEnv = ref<Environment | null>(null);
// Resultado do último testConnection(); 'idle' antes de qualquer tentativa.
const connStatus = ref<'idle' | 'testing' | 'ok' | 'chave-invalida' | 'inacessivel'>('idle');

// Um item por linha da UI, na mesma ordem enviada ao backend (index usado para casar com o resultado do polling).
const drafts = ref<Draft[]>([]);
// true enquanto o lote atual ainda tem item pending/processing (desabilita o botão "Enviar lote").
const sending = ref(false);
// Mensagem exibida no rodapé da tela.
const batchStatus = ref('Adicione PDFs para montar o lote.');
// Cor do rodapé — controlada junto com batchStatus.
const batchTone = ref<'ok' | 'erro' | 'neutro'>('neutro');
// Id do lote em processamento; null antes do primeiro envio.
let activeBatchId: string | null = null;
// Handle do setInterval do polling — null quando não há polling ativo.
let pollTimer: ReturnType<typeof setInterval> | null = null;

const HISTORY_PAGE_SIZE = 20;

// Rótulos exibidos no select de status do filtro de histórico.
const HISTORY_STATUS_LABELS: Record<NonNullable<HistoryFilter['status']>, string> = {
  pending: 'Pendente',
  signed: 'Assinado',
  canceled: 'Cancelado ou deletado',
  failed: 'Falhou',
};

// Filtro atual da busca de histórico.
const historySearch = ref('');
const historyStatus = ref<'' | NonNullable<HistoryFilter['status']>>('');
const historyDateFrom = ref('');
const historyDateTo = ref('');

// Lotes carregados na tela (acumula a cada "Carregar mais").
const historyBatches = ref<Batch[]>([]);
const historyOffset = ref(0);
const historyHasMore = ref(true);
const historyLoading = ref(false);
const historyStatusMessage = ref('');

function currentHistoryFilter(): HistoryFilter {
  return {
    search: historySearch.value.trim() || undefined,
    status: historyStatus.value || undefined,
    dateFrom: historyDateFrom.value || undefined,
    // "até" é um <input type="date"> (ex.: "2026-07-03"), mas created_at no banco
    // é um timestamp ISO completo (ex.: "2026-07-03T14:22:31.502Z"). Comparando
    // strings, "2026-07-03" < "2026-07-03T14:22:31.502Z", então o dia inteiro do
    // filtro final seria excluído. Estendemos até o fim do dia (23:59:59.999Z).
    dateTo: historyDateTo.value ? `${historyDateTo.value}T23:59:59.999Z` : undefined,
  };
}

// Bytes crus do PDF (lidos via plugin-fs) → base64, formato que a Clicksign espera.
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

// Máscara (11) 99999-9999 aplicada aos dígitos conforme o usuário digita.
function formatPhone(digits: string): string {
  const d = digits.replace(/\D/g, '').slice(0, 11);
  if (d.length > 6) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length > 2) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length > 0) return `(${d}`;
  return '';
}

// Handler do campo de telefone: usa :value (não v-model) porque o valor exibido é a versão mascarada.
function onPhoneInput(draft: Draft, event: Event): void {
  const raw = (event.target as HTMLInputElement).value;
  draft.phone = formatPhone(raw);
}

// Carrega token/ambiente salvos e reconecta sozinho se já havia um token configurado.
onMounted(async () => {
  store = await load('config.json', { autoSave: true, defaults: {} });
  clicksignToken.value = (await store.get<string>('clicksignToken')) ?? '';
  clicksignEnv.value = (await store.get<Environment>('clicksignEnv')) ?? 'sandbox';

  if (clicksignToken.value) {
    // token já configurado em execução anterior — reconecta sozinho, sem
    // repetir a confirmação de produção (usuário já optou por isso antes)
    await saveAndConnect({ skipProductionConfirm: true });
  }
});

// Salva token/ambiente no store, encerra a sessão anterior (se houver) e abre uma nova sessão nativa.
async function saveAndConnect(options: { skipProductionConfirm?: boolean } = {}): Promise<void> {
  const token = clicksignToken.value.trim();
  if (!token) {
    connStatus.value = 'idle';
    return;
  }

  // Produção emite documentos com valor legal — confirmar antes de trocar
  // para lá manualmente (não na reconexão automática ao abrir o app).
  if (clicksignEnv.value === 'producao' && !options.skipProductionConfirm) {
    const confirmed = await ask(
      'Você está prestes a conectar em PRODUÇÃO. Documentos enviados a partir de agora terão valor legal e serão cobrados. Continuar?',
      { title: 'Confirmar ambiente de produção', kind: 'warning' },
    );
    if (!confirmed) {
      clicksignEnv.value = activeEnv.value ?? 'sandbox';
      return;
    }
  }

  await store.set('clicksignToken', token);
  await store.set('clicksignEnv', clicksignEnv.value);

  connStatus.value = 'testing';
  try {
    if (session) await session.stop(); // troca de ambiente: fecha a sessão anterior antes de abrir a nova
    session = await startSession(clicksignEnv.value, token);
    activeEnv.value = clicksignEnv.value;
    connStatus.value = await session.testConnection();
    if (connStatus.value === 'ok') await loadHistory();
  } catch (error) {
    batchStatus.value = `Falha ao conectar com a Clicksign: ${String(error)}`;
    batchTone.value = 'erro';
    connStatus.value = 'inacessivel';
  }
}

// Texto do selo de status ao lado do botão "Salvar e conectar".
const connLabel = computed(() => {
  switch (connStatus.value) {
    case 'ok':
      return 'Conectado ✓';
    case 'chave-invalida':
      return 'Token da Clicksign inválido ✗';
    case 'inacessivel':
      return 'Não foi possível conectar com a Clicksign ✗';
    case 'testing':
      return 'Conectando…';
    default:
      return '';
  }
});
const connTone = computed(() =>
  connStatus.value === 'ok' ? 'text-emerald-600' : connStatus.value === 'testing' ? 'text-slate-400' : 'text-red-600',
);

// Abre o seletor nativo de arquivos e adiciona cada PDF escolhido como um novo draft (item ainda não enviado).
async function addPdfs(): Promise<void> {
  const selected = await open({
    multiple: true,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  for (const path of paths) {
    const bytes = await readFile(path);
    const filename = path.split(/[\\/]/).pop() ?? path;
    drafts.value.push({
      path,
      filename,
      bytes,
      name: '',
      email: '',
      phone: '',
      delivery: 'link',
      status: 'idle',
      signUrl: null,
      errorMessage: null,
      actionError: null,
      itemId: null,
    });
  }
  batchStatus.value = `${drafts.value.length} documento(s) no lote.`;
  batchTone.value = 'neutro';
}

// Remove um draft do lote (antes do envio) e atualiza o contador exibido.
function removeDraft(index: number): void {
  drafts.value.splice(index, 1);
  batchStatus.value = `${drafts.value.length} documento(s) no lote.`;
}

// Converte os drafts da UI para o formato aceito por validateBatchItems/createBatch.
function buildPayload(): BatchItemPayload[] {
  return drafts.value.map((d) => ({
    filename: d.filename,
    contentBase64: toBase64(d.bytes),
    signer: {
      name: d.name.trim(),
      email: d.email.trim() || undefined,
      phoneNumber: d.phone.replace(/\D/g, '') || undefined,
    },
    delivery: d.delivery,
  }));
}

// Valida os drafts, cria o lote na sessão nativa e liga o polling de progresso.
async function sendBatch(): Promise<void> {
  if (sending.value) return;
  if (!session) {
    batchStatus.value = 'Configure e conecte com a Clicksign antes de enviar.';
    batchTone.value = 'erro';
    return;
  }
  if (drafts.value.length === 0) {
    batchStatus.value = 'Adicione ao menos um PDF antes de enviar.';
    batchTone.value = 'erro';
    return;
  }

  const payload = buildPayload();
  const errors = validateBatchItems(payload);
  if (errors.length > 0) {
    for (const draft of drafts.value) draft.errorMessage = null;
    for (const e of errors) {
      const draft = drafts.value[e.index];
      if (draft) draft.errorMessage = e.message;
    }
    batchStatus.value = `${errors.length} problema(s) de validação — veja as mensagens em vermelho nas linhas.`;
    batchTone.value = 'erro';
    return;
  }

  sending.value = true;
  batchStatus.value = 'Enviando lote...';
  batchTone.value = 'neutro';
  try {
    const items = payload.map(({ filename, signer, delivery }) => ({ filename, signer, delivery }));
    const pdfBase64ByIndex = payload.map((p) => p.contentBase64);
    const batch = await session.createBatch(items, pdfBase64ByIndex);
    activeBatchId = batch.id;
    drafts.value.forEach((d) => {
      d.status = 'pending';
      d.errorMessage = null;
    });
    batchStatus.value = `Lote ${batch.id.slice(0, 8)} em processamento...`;
    startPolling();
  } catch (error) {
    batchStatus.value = `Erro no envio: ${String(error)}`;
    batchTone.value = 'erro';
    sending.value = false;
  }
}

// Consulta o lote a cada 1s até todo item terminar (done ou failed) e atualiza a UI.
function startPolling(): void {
  pollTimer = setInterval(async () => {
    if (!activeBatchId || !session) return;
    try {
      const status = await session.getBatch(activeBatchId);
      if (!status) return;
      status.items.forEach((item, index) => {
        const draft = drafts.value[index];
        if (!draft) return;
        draft.itemId = item.id;
        draft.status = item.status;
        draft.signUrl = item.status === 'done' ? item.signUrl : null;
        draft.errorMessage = item.status === 'failed' ? item.errorMessage : null;
      });

      const total = status.items.length;
      const done = status.items.filter((i) => i.status === 'done').length;
      const failed = status.items.filter((i) => i.status === 'failed').length;
      const settled = done + failed;

      if (settled === total) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        sending.value = false;
        batchStatus.value =
          failed === 0
            ? `Lote concluído: ${done}/${total} link(s) prontos.`
            : `Lote finalizado: ${done} ok, ${failed} falha(s).`;
        batchTone.value = failed === 0 ? 'ok' : 'erro';
      } else {
        batchStatus.value = `Progresso: ${settled}/${total} concluídos...`;
      }
    } catch (error) {
      batchStatus.value = `Erro ao consultar lote: ${String(error)}`;
      batchTone.value = 'erro';
    }
  }, 1000);
}

// Reenfileira um item que falhou e religa o polling se ele já tinha parado.
async function retryDraft(draft: Draft): Promise<void> {
  if (!activeBatchId || !draft.itemId || !session) return;
  try {
    await session.retryItem(activeBatchId, draft.itemId);
    draft.status = 'pending';
    draft.errorMessage = null;
    if (!pollTimer) {
      sending.value = true;
      startPolling();
    }
  } catch (error) {
    draft.errorMessage = `Retry falhou: ${String(error)}`;
  }
}

const justCopied = ref<string | null>(null); // path do draft copiado por último, para feedback "Copiado ✓"
const justCopiedAll = ref(false);

async function copyLink(draft: Draft): Promise<void> {
  if (!draft.signUrl) return;
  draft.actionError = null;
  try {
    await writeText(draft.signUrl);
    justCopied.value = draft.path;
    setTimeout(() => {
      if (justCopied.value === draft.path) justCopied.value = null;
    }, 2000);
  } catch (error) {
    // sem isso, uma falha na área de transferência (ex.: permissão do SO,
    // outro app segurando o clipboard) passava em silêncio total
    draft.actionError = `Falha ao copiar o link: ${String(error)}`;
  }
}

// Abre o link do draft atual, mostrando erro no próprio card (actionError).
async function openLink(draft: Draft): Promise<void> {
  if (!draft.signUrl) return;
  draft.actionError = null;
  try {
    await openSignUrl(draft.signUrl);
  } catch (error) {
    draft.actionError = `Falha ao abrir o link no navegador: ${String(error)}`;
  }
}

// Copia todos os links já concluídos, um por linha, como "nome: link".
async function copyAllLinks(): Promise<void> {
  const lines = drafts.value
    .filter((d) => d.signUrl)
    .map((d) => `${d.name || d.filename}: ${d.signUrl}`);
  if (lines.length === 0) {
    batchStatus.value = 'Nenhum link pronto ainda.';
    batchTone.value = 'erro';
    return;
  }
  try {
    await writeText(lines.join('\n'));
    batchStatus.value = `${lines.length} link(s) copiados para a área de transferência.`;
    batchTone.value = 'ok';
    justCopiedAll.value = true;
    setTimeout(() => (justCopiedAll.value = false), 2000);
  } catch (error) {
    batchStatus.value = `Falha ao copiar os links: ${String(error)}`;
    batchTone.value = 'erro';
  }
}

// Texto de status de uma linha do lote (erro tem prioridade sobre o status bruto).
function statusLabel(draft: Draft): string {
  if (draft.errorMessage) return draft.errorMessage;
  switch (draft.status) {
    case 'done':
      return 'Concluído ✓';
    case 'failed':
      return 'Falhou';
    case 'processing':
      return 'Processando…';
    case 'pending':
      return 'Na fila';
    default:
      return '';
  }
}

// Cor do texto de status: vermelho para erro/falha, verde para concluído, cinza no resto.
function statusClass(draft: Draft): string {
  if (draft.errorMessage || draft.status === 'failed') return 'text-red-600';
  if (draft.status === 'done') return 'text-emerald-600';
  return 'text-slate-500';
}

// Recarrega o histórico do zero com o filtro atual — chamado ao clicar "Buscar" ou ao abrir a seção pela primeira vez.
async function loadHistory(): Promise<void> {
  if (!session) return;
  historyLoading.value = true;
  historyOffset.value = 0;
  try {
    const batches = await session.listHistory(currentHistoryFilter(), HISTORY_PAGE_SIZE, 0);
    historyBatches.value = batches;
    historyOffset.value = batches.length;
    historyHasMore.value = batches.length === HISTORY_PAGE_SIZE;
    historyStatusMessage.value = batches.length === 0 ? 'Nenhum lote encontrado.' : '';
  } catch (error) {
    historyStatusMessage.value = `Erro ao carregar histórico: ${String(error)}`;
  } finally {
    historyLoading.value = false;
  }
}

// Busca a próxima página de lotes com o filtro atual, sem limpar o que já está na tela.
async function loadMoreHistory(): Promise<void> {
  if (!session || historyLoading.value) return;
  historyLoading.value = true;
  try {
    const batches = await session.listHistory(currentHistoryFilter(), HISTORY_PAGE_SIZE, historyOffset.value);
    historyBatches.value.push(...batches);
    historyOffset.value += batches.length;
    historyHasMore.value = batches.length === HISTORY_PAGE_SIZE;
  } catch (error) {
    historyStatusMessage.value = `Erro ao carregar mais itens: ${String(error)}`;
  } finally {
    historyLoading.value = false;
  }
}

// Atualiza o status de um único item do histórico, in-place no array reativo.
async function refreshHistoryItem(batch: Batch, item: BatchItem): Promise<void> {
  if (!session) return;
  try {
    const status = await session.refreshItemStatus(batch.id, item.id);
    applyHistoryItemStatus(batch.id, item.id, status);
  } catch (error) {
    historyStatusMessage.value = `Falha ao atualizar "${item.filename}": ${String(error)}`;
  }
}

// Roda refreshHistoryItem para todo item 'done' carregado na tela agora (não o histórico inteiro).
async function refreshAllLoadedHistory(): Promise<void> {
  if (!session) return;
  const targets = historyBatches.value.flatMap((batch) =>
    batch.items.filter((item) => item.status === 'done').map((item) => ({ batch, item })),
  );
  historyStatusMessage.value = `Atualizando ${targets.length} documento(s)...`;
  const results = await Promise.allSettled(targets.map(({ batch, item }) => refreshHistoryItem(batch, item)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  historyStatusMessage.value =
    failed === 0 ? `${targets.length} documento(s) atualizados.` : `${failed} de ${targets.length} falharam.`;
}

// Reenfileira um item que falhou num lote antigo — o worker processa em segundo plano; recarregue o histórico depois para ver o resultado.
async function retryHistoryItem(batch: Batch, item: BatchItem): Promise<void> {
  if (!session) return;
  try {
    await session.retryItem(batch.id, item.id);
    historyStatusMessage.value = `"${item.filename}" reenviado — clique em "Buscar" novamente em alguns segundos para ver o resultado.`;
  } catch (error) {
    historyStatusMessage.value = `Falha ao reenviar "${item.filename}": ${String(error)}`;
  }
}

function applyHistoryItemStatus(batchId: string, itemId: string, status: ClicksignStatus): void {
  const batch = historyBatches.value.find((b) => b.id === batchId);
  const item = batch?.items.find((i) => i.id === itemId);
  if (item) {
    item.clicksignStatus = status;
    item.clicksignStatusCheckedAt = new Date().toISOString();
  }
}

function clicksignStatusLabel(item: BatchItem): string {
  if (item.status !== 'done') return '';
  switch (item.clicksignStatus) {
    case 'signed':
      return 'Assinado ✓';
    case 'canceled':
      return 'Cancelado/deletado na Clicksign';
    case 'pending':
      return 'Pendente de assinatura';
    default:
      return 'Status não verificado';
  }
}

// Abre uma URL de assinatura no navegador padrão do sistema (sem tratamento de erro — cada chamador decide onde mostrar a falha).
async function openSignUrl(url: string): Promise<void> {
  await openUrl(url);
}

// Abre o link de um item do histórico, mostrando erro na mensagem de status da seção.
async function openHistoryLink(url: string): Promise<void> {
  try {
    await openSignUrl(url);
  } catch (error) {
    historyStatusMessage.value = `Falha ao abrir o link: ${String(error)}`;
  }
}
</script>

<template>
  <div class="min-h-screen bg-slate-50 p-6 text-slate-900">
    <header class="mb-4 flex items-center gap-3">
      <div>
        <h1 class="text-xl font-extrabold text-blue-700">HealthMais Assinaturas</h1>
        <p class="text-xs text-slate-500">Envio em lote de documentos para assinatura via Clicksign</p>
      </div>
      <span
        v-if="activeEnv"
        class="rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide"
        :class="activeEnv === 'producao' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'"
      >
        {{ activeEnv === 'producao' ? '⚠ Produção — valor legal' : 'Sandbox — testes' }}
      </span>
    </header>

    <section class="mb-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 class="mb-2 text-sm font-bold">Conexão com a Clicksign</h2>
      <div class="flex flex-wrap items-center gap-2">
        <input
          v-model="clicksignToken"
          type="password"
          placeholder="Token de acesso da Clicksign"
          class="w-72 rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <select v-model="clicksignEnv" class="rounded border border-slate-300 px-2 py-1 text-sm">
          <option value="sandbox">Sandbox (testes)</option>
          <option value="producao">Produção</option>
        </select>
        <button
          class="rounded bg-slate-100 px-3 py-1 text-sm font-medium hover:bg-slate-200"
          @click="() => saveAndConnect()"
        >
          Salvar e conectar
        </button>
        <span class="text-xs" :class="connTone">{{ connLabel }}</span>
      </div>
    </section>

    <div class="mb-4 flex items-center gap-2">
      <button class="rounded bg-slate-100 px-3 py-1.5 text-sm font-medium hover:bg-slate-200" @click="addPdfs">
        + Adicionar PDF
      </button>
      <button
        class="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        :disabled="sending"
        @click="sendBatch"
      >
        Enviar lote
      </button>
      <button class="rounded bg-slate-100 px-3 py-1.5 text-sm font-medium hover:bg-slate-200" @click="copyAllLinks">
        {{ justCopiedAll ? 'Copiado ✓' : 'Copiar todos os links' }}
      </button>
      <span class="ml-auto text-xs text-slate-500">Documentos no lote: {{ drafts.length }}</span>
    </div>

    <div class="space-y-3">
      <div
        v-for="(draft, index) in drafts"
        :key="draft.path"
        class="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
      >
        <div class="mb-2 flex items-center gap-2">
          <span class="font-semibold">📄 {{ draft.filename }}</span>
          <span class="text-xs" :class="statusClass(draft)">{{ statusLabel(draft) }}</span>
          <button
            v-if="draft.signUrl"
            class="ml-auto rounded bg-slate-100 px-2 py-0.5 text-xs hover:bg-slate-200"
            @click="copyLink(draft)"
          >
            {{ justCopied === draft.path ? 'Copiado ✓' : 'Copiar link' }}
          </button>
          <button
            v-if="draft.signUrl"
            class="rounded bg-slate-100 px-2 py-0.5 text-xs hover:bg-slate-200"
            @click="openLink(draft)"
          >
            Abrir no navegador
          </button>
          <button
            v-if="draft.status === 'failed'"
            class="rounded bg-slate-100 px-2 py-0.5 text-xs hover:bg-slate-200"
            @click="retryDraft(draft)"
          >
            Tentar de novo
          </button>
          <button class="text-red-500 hover:text-red-700" @click="removeDraft(index)">✕</button>
        </div>
        <p v-if="draft.signUrl" class="mb-2 break-all">
          <a
            href="#"
            class="text-xs text-blue-600 underline hover:text-blue-800"
            @click.prevent="openLink(draft)"
          >{{ draft.signUrl }}</a>
        </p>
        <p v-if="draft.actionError" class="mb-2 text-xs text-red-600">{{ draft.actionError }}</p>
        <div class="flex flex-wrap gap-2">
          <input
            v-model="draft.name"
            type="text"
            placeholder="Nome e sobrenome *"
            class="w-56 rounded border border-slate-300 px-2 py-1 text-sm"
          />
          <input
            v-model="draft.email"
            type="email"
            placeholder="E-mail"
            class="w-56 rounded border border-slate-300 px-2 py-1 text-sm"
          />
          <input
            :value="draft.phone"
            type="text"
            placeholder="(11) 99999-8888"
            class="w-40 rounded border border-slate-300 px-2 py-1 text-sm"
            @input="onPhoneInput(draft, $event)"
          />
          <select v-model="draft.delivery" class="rounded border border-slate-300 px-2 py-1 text-sm">
            <option v-for="(label, value) in DELIVERY_LABELS" :key="value" :value="value">{{ label }}</option>
          </select>
        </div>
      </div>
    </div>

    <footer class="mt-6 border-t border-slate-200 pt-2 text-xs" :class="{
      'text-emerald-600': batchTone === 'ok',
      'text-red-600': batchTone === 'erro',
      'text-slate-500': batchTone === 'neutro',
    }">
      {{ batchStatus }}
    </footer>

    <section class="mt-8 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-bold">Histórico</h2>
        <button
          class="rounded bg-slate-100 px-3 py-1 text-xs font-medium hover:bg-slate-200"
          :disabled="historyLoading"
          @click="refreshAllLoadedHistory"
        >
          Atualizar tudo
        </button>
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <input
          v-model="historySearch"
          type="text"
          placeholder="Buscar por signatário ou arquivo"
          class="w-56 rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <select v-model="historyStatus" class="rounded border border-slate-300 px-2 py-1 text-sm">
          <option value="">Todos os status</option>
          <option v-for="(label, value) in HISTORY_STATUS_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
        <input v-model="historyDateFrom" type="date" class="rounded border border-slate-300 px-2 py-1 text-sm" />
        <input v-model="historyDateTo" type="date" class="rounded border border-slate-300 px-2 py-1 text-sm" />
        <button
          class="rounded bg-slate-100 px-3 py-1 text-sm font-medium hover:bg-slate-200"
          @click="loadHistory"
        >
          Buscar
        </button>
      </div>

      <p v-if="historyStatusMessage" class="mb-2 text-xs text-slate-500">{{ historyStatusMessage }}</p>

      <div v-for="batch in historyBatches" :key="batch.id" class="mb-4">
        <p class="mb-1 text-xs font-semibold text-slate-600">
          Lote de {{ new Date(batch.createdAt).toLocaleString('pt-BR') }} — {{ batch.items.length }} documento(s)
        </p>
        <div class="space-y-2">
          <div
            v-for="item in batch.items"
            :key="item.id"
            class="rounded border border-slate-200 p-2 text-sm"
          >
            <div class="flex items-center gap-2">
              <span class="font-medium">📄 {{ item.filename }}</span>
              <span class="text-xs text-slate-500">{{ item.signer.name }}</span>
              <span class="text-xs">{{ clicksignStatusLabel(item) }}</span>
              <button
                v-if="item.status === 'done'"
                class="ml-auto rounded bg-slate-100 px-2 py-0.5 text-xs hover:bg-slate-200"
                @click="refreshHistoryItem(batch, item)"
              >
                Atualizar status
              </button>
              <button
                v-if="item.status === 'failed'"
                class="ml-auto rounded bg-slate-100 px-2 py-0.5 text-xs hover:bg-slate-200"
                @click="retryHistoryItem(batch, item)"
              >
                Tentar de novo
              </button>
            </div>
            <p v-if="item.status === 'done'" class="mt-1 break-all text-xs text-blue-600 underline">
              <a href="#" @click.prevent="openHistoryLink(item.signUrl!)">{{ item.signUrl }}</a>
            </p>
            <p v-if="item.status === 'failed'" class="mt-1 text-xs text-red-600">{{ item.errorMessage }}</p>
          </div>
        </div>
      </div>

      <button
        v-if="historyHasMore && historyBatches.length > 0"
        class="mt-2 w-full rounded bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
        :disabled="historyLoading"
        @click="loadMoreHistory"
      >
        Carregar mais
      </button>
    </section>
  </div>
</template>
