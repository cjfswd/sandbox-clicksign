/**
 * HealthMais Assinaturas — app desktop nativo (Perry + perry/ui).
 * Monta lotes de PDFs, envia para a batch API e entrega os links de assinatura.
 *
 * Reatividade: linhas do lote são redesenhadas só quando itens entram/saem
 * (ForEach sobre rowCount); atualizações de status durante o envio usam os
 * handles imperativos (textSetString/widgetSetHidden) para não perder foco.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  App,
  Button,
  Divider,
  ForEach,
  HStack,
  Picker,
  Spacer,
  State,
  Text,
  TextField,
  VStack,
  alert,
  clipboardWrite,
  openFileDialog,
  pickerAddItem,
  textSetColor,
  textSetFontSize,
  textSetFontWeight,
  textSetString,
  textfieldSetString,
  widgetSetHidden,
} from 'perry/ui';
import { preferencesGet, preferencesSet } from 'perry/system';
import { validateBatchItems } from '../../src/domain/validation.ts';
import {
  createBatch,
  getBatch,
  testConnection,
  type ApiConfig,
  type Delivery,
} from './api-client.ts';

// ---------------------------------------------------------------------------
// Configuração (Registry do Windows via preferences)

function loadConfig(): ApiConfig {
  return {
    baseUrl: String(preferencesGet('api_base_url') ?? 'http://localhost:3000'),
    apiKey: String(preferencesGet('api_key') ?? ''),
  };
}

const config = loadConfig();
const connectionStatus = State('');

// ---------------------------------------------------------------------------
// Rascunho do lote (array simples — sem State — para não redesenhar a cada tecla)

interface DraftRow {
  path: string;
  filename: string;
  name: string;
  email: string;
  phone: string;
  delivery: Delivery;
  itemId: string | null;
  signUrl: string | null;
  statusText: number | null; // handle do Text de status da linha
  linkButton: number | null; // handle do botão "Copiar link"
}

const drafts: DraftRow[] = [];
const rowCount = State(0);
const batchStatus = State('');
let sending = false;

const DELIVERY_OPTIONS: Delivery[] = ['link', 'email', 'whatsapp'];
const DELIVERY_LABELS = ['Somente link (envio manual)', 'E-mail (Clicksign notifica)', 'WhatsApp (Clicksign notifica)'];

// ---------------------------------------------------------------------------
// Ações

function addPdf(): void {
  openFileDialog((path: string) => {
    if (path.length === 0) return;
    if (!path.toLowerCase().endsWith('.pdf')) {
      alert('Arquivo inválido', 'Selecione um arquivo PDF.');
      return;
    }
    drafts.push({
      path,
      filename: basename(path),
      name: '',
      email: '',
      phone: '',
      delivery: 'link',
      itemId: null,
      signUrl: null,
      statusText: null,
      linkButton: null,
    });
    rowCount.set(drafts.length);
  });
}

function removeRow(index: number): void {
  drafts.splice(index, 1);
  rowCount.set(drafts.length);
}

function buildPayload() {
  return drafts.map((d) => ({
    filename: d.filename,
    contentBase64: readFileSync(d.path).toString('base64'),
    signer: {
      name: d.name.trim(),
      email: d.email.trim() === '' ? undefined : d.email.trim(),
      phoneNumber: d.phone.trim() === '' ? undefined : d.phone.trim(),
    },
    delivery: d.delivery,
  }));
}

function setRowStatus(index: number, text: string): void {
  const handle = drafts[index]?.statusText;
  if (handle !== null && handle !== undefined) {
    // textSetString atualiza o Text da linha sem redesenhar a árvore
    textSetString(handle, text);
  }
}

async function sendBatch(): Promise<void> {
  if (sending) return;
  if (drafts.length === 0) {
    alert('Lote vazio', 'Adicione ao menos um PDF antes de enviar.');
    return;
  }

  let payload;
  try {
    payload = buildPayload();
  } catch (error) {
    alert('Erro ao ler arquivo', String(error));
    return;
  }

  const validation = validateBatchItems(payload);
  if (!validation.ok) {
    const lines = validation.errors
      .map((e) => `Item ${e.index + 1} (${drafts[e.index]?.filename}): ${e.message}`)
      .join('\n');
    alert('Corrija antes de enviar', lines);
    return;
  }

  sending = true;
  batchStatus.set('Enviando lote...');
  try {
    const { batchId } = await createBatch(config, payload);
    batchStatus.set(`Lote ${batchId.slice(0, 8)} em processamento...`);
    await pollUntilSettled(batchId);
  } catch (error) {
    batchStatus.set(`Erro no envio: ${String(error)}`);
  } finally {
    sending = false;
  }
}

async function pollUntilSettled(batchId: string): Promise<void> {
  for (;;) {
    const status = await getBatch(config, batchId);
    status.items.forEach((item, index) => {
      const draft = drafts[index];
      if (!draft) return;
      draft.itemId = item.id;
      if (item.status === 'done' && item.signUrl) {
        draft.signUrl = item.signUrl;
        setRowStatus(index, 'Concluído');
        if (draft.linkButton !== null) widgetSetHidden(draft.linkButton, 0);
      } else if (item.status === 'failed') {
        setRowStatus(index, `Falhou: ${item.errorMessage ?? 'erro'}`);
      } else {
        setRowStatus(index, item.status === 'processing' ? 'Processando...' : 'Na fila');
      }
    });

    const { pending, processing, done, failed, total } = status.progress;
    batchStatus.set(`Progresso: ${done + failed}/${total} (${done} ok, ${failed} falhas)`);
    if (pending + processing === 0) {
      batchStatus.set(
        failed === 0
          ? `Lote concluído: ${done}/${total} links prontos.`
          : `Lote finalizado com ${failed} falha(s) — ${done} link(s) prontos.`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

function copyAllLinks(): void {
  const lines = drafts
    .filter((d) => d.signUrl !== null)
    .map((d) => `${d.name || d.filename}: ${d.signUrl}`);
  if (lines.length === 0) {
    alert('Nada para copiar', 'Nenhum link pronto ainda.');
    return;
  }
  clipboardWrite(lines.join('\n'));
  batchStatus.set(`${lines.length} link(s) copiados para a área de transferência.`);
}

async function saveAndTestConnection(): Promise<void> {
  preferencesSet('api_base_url', config.baseUrl);
  preferencesSet('api_key', config.apiKey);
  connectionStatus.set('Testando...');
  try {
    const result = await testConnection(config);
    connectionStatus.set(result === 'ok' ? 'Conectado ✓' : 'API key inválida ✗');
  } catch {
    connectionStatus.set('API inacessível — confira o endereço ✗');
  }
}

// ---------------------------------------------------------------------------
// UI

function settingsSection(): number {
  const title = Text('Configuração da API');
  textSetFontSize(title, 15);
  textSetFontWeight(title, 700);

  const urlField = TextField('URL da API (ex.: http://localhost:3000)', (v: string) => {
    config.baseUrl = v.trim();
  });
  textfieldSetString(urlField, config.baseUrl);

  const keyField = TextField('API key', (v: string) => {
    config.apiKey = v.trim();
  });
  textfieldSetString(keyField, config.apiKey);

  const statusLabel = Text(`${connectionStatus.value}`);
  textSetColor(statusLabel, 0.3, 0.3, 0.3, 1);

  return VStack(8, [
    title,
    HStack(8, [urlField, keyField, Button('Salvar e testar', () => void saveAndTestConnection())]),
    statusLabel,
  ]);
}

function rowWidget(index: number): number {
  const draft = drafts[index];
  if (!draft) return Spacer();

  const fileLabel = Text(draft.filename);
  textSetFontWeight(fileLabel, 600);

  const nameField = TextField('Nome e sobrenome', (v: string) => {
    draft.name = v;
  });
  textfieldSetString(nameField, draft.name);

  const emailField = TextField('E-mail', (v: string) => {
    draft.email = v;
  });
  textfieldSetString(emailField, draft.email);

  const phoneField = TextField('Telefone (WhatsApp)', (v: string) => {
    draft.phone = v;
  });
  textfieldSetString(phoneField, draft.phone);

  const deliveryPicker = Picker((selected: number) => {
    draft.delivery = DELIVERY_OPTIONS[selected] ?? 'link';
  });
  DELIVERY_LABELS.forEach((label) => pickerAddItem(deliveryPicker, label));

  const statusLabel = Text('');
  textSetColor(statusLabel, 0.25, 0.45, 0.25, 1);
  draft.statusText = statusLabel;

  const linkButton = Button('Copiar link', () => {
    if (draft.signUrl) {
      clipboardWrite(draft.signUrl);
      setRowStatus(index, 'Link copiado ✓');
    }
  });
  widgetSetHidden(linkButton, 1);
  draft.linkButton = linkButton;

  const removeButton = Button('Remover', () => removeRow(index));

  return VStack(6, [
    HStack(8, [fileLabel, Spacer(), statusLabel, linkButton, removeButton]),
    HStack(8, [nameField, emailField, phoneField, deliveryPicker]),
    Divider(),
  ]);
}

const header = Text('HealthMais Assinaturas — Envio em Lote');
textSetFontSize(header, 20);
textSetFontWeight(header, 800);

const statusBar = Text(`${batchStatus.value}`);
textSetFontSize(statusBar, 13);

App({
  title: 'HealthMais Assinaturas',
  width: 1080,
  height: 760,
  body: VStack(14, [
    header,
    settingsSection(),
    Divider(),
    HStack(10, [
      Button('Adicionar PDF', addPdf),
      Button('Enviar lote', () => void sendBatch()),
      Button('Copiar todos os links', copyAllLinks),
      Spacer(),
    ]),
    Text(`Documentos no lote: ${rowCount.value}`),
    VStack(8, [ForEach(rowCount, (i: number) => rowWidget(i))]),
    Spacer(),
    statusBar,
  ]),
});
