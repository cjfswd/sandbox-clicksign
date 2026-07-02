<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { load, type Store } from '@tauri-apps/plugin-store';
import { openUrl } from '@tauri-apps/plugin-opener';
import { startSession, type BatchSession, type Environment } from './native/session';
import type { BatchItem, Delivery } from './native/batch';
import { validateBatchItems, type BatchItemPayload } from './validation';

interface Draft {
  path: string;
  filename: string;
  bytes: Uint8Array;
  name: string;
  email: string;
  phone: string;
  delivery: Delivery;
  status: BatchItem['status'] | 'idle';
  signUrl: string | null;
  errorMessage: string | null;
  /** Erro de copiar/abrir o link — separado de errorMessage (esse é do processamento na Clicksign). */
  actionError: string | null;
  itemId: string | null;
}

const DELIVERY_LABELS: Record<Delivery, string> = {
  link: 'Somente link (envio manual)',
  email: 'E-mail (Clicksign envia)',
  whatsapp: 'WhatsApp (Clicksign envia)',
};

let store: Store;
// Sessão nativa (repo + pdfStore + cliente Clicksign + worker) do ambiente
// ativo — substitui o sidecar. Só o token da Clicksign é configurável.
let session: BatchSession | null = null;
const clicksignToken = ref('');
const clicksignEnv = ref<Environment>('sandbox');
/** Ambiente que a sessão está de fato rodando agora (para o selo no header). */
const activeEnv = ref<Environment | null>(null);
const connStatus = ref<'idle' | 'testing' | 'ok' | 'chave-invalida' | 'inacessivel'>('idle');

const drafts = ref<Draft[]>([]);
const sending = ref(false);
const batchStatus = ref('Adicione PDFs para montar o lote.');
const batchTone = ref<'ok' | 'erro' | 'neutro'>('neutro');
let activeBatchId: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

function formatPhone(digits: string): string {
  const d = digits.replace(/\D/g, '').slice(0, 11);
  if (d.length > 6) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length > 2) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length > 0) return `(${d}`;
  return '';
}

function onPhoneInput(draft: Draft, event: Event): void {
  const raw = (event.target as HTMLInputElement).value;
  draft.phone = formatPhone(raw);
}

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
  } catch (error) {
    batchStatus.value = `Falha ao conectar com a Clicksign: ${String(error)}`;
    batchTone.value = 'erro';
    connStatus.value = 'inacessivel';
  }
}

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

function removeDraft(index: number): void {
  drafts.value.splice(index, 1);
  batchStatus.value = `${drafts.value.length} documento(s) no lote.`;
}

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

async function openLink(draft: Draft): Promise<void> {
  if (!draft.signUrl) return;
  draft.actionError = null;
  try {
    await openUrl(draft.signUrl);
  } catch (error) {
    draft.actionError = `Falha ao abrir o link no navegador: ${String(error)}`;
  }
}

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

function statusClass(draft: Draft): string {
  if (draft.errorMessage || draft.status === 'failed') return 'text-red-600';
  if (draft.status === 'done') return 'text-emerald-600';
  return 'text-slate-500';
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
  </div>
</template>
