/**
 * HealthMais Assinaturas — app desktop nativo Windows (Perry + perry/ui).
 *
 * Restrições do perry/ui 0.5.1182 no Win32 (validadas por sondas):
 * - onChange de TextField NÃO dispara → os valores são LIDOS via
 *   textfieldGetString/pickerGetSelected no momento do envio (e "colhidos"
 *   antes de qualquer re-render, para não perder o que foi digitado);
 * - IO assíncrono não é bombeado pelo run loop → HTTP síncrono via curl
 *   (api-client.ts) e polling com setInterval (timers funcionam);
 * - máscara em tempo real é inviável sem onChange → telefone e e-mail são
 *   normalizados/validados na leitura.
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
  buttonSetTextColor,
  clipboardWrite,
  openFileDialog,
  pickerAddItem,
  pickerGetSelected,
  pickerSetSelected,
  setCornerRadius,
  textfieldGetString,
  textfieldSetString,
  textSetColor,
  textSetFontSize,
  textSetFontWeight,
  textSetString,
  widgetSetBackgroundColor,
  widgetSetBorderColor,
  widgetSetBorderWidth,
  widgetSetEdgeInsets,
  widgetSetHidden,
  widgetSetWidth,
} from 'perry/ui';
import { preferencesGet, preferencesSet } from 'perry/system';
import {
  createBatchSync,
  getBatchSync,
  retryItemSync,
  testConnectionSync,
  type ApiConfig,
  type BatchItemPayload,
  type Delivery,
} from './api-client.ts';

// ---------------------------------------------------------------------------
// Paleta

const INK = { r: 0.13, g: 0.15, b: 0.19 };
const MUTED = { r: 0.45, g: 0.48, b: 0.53 };
const GREEN = { r: 0.09, g: 0.53, b: 0.33 };
const RED = { r: 0.78, g: 0.18, b: 0.18 };
const BLUE = { r: 0.12, g: 0.38, b: 0.75 };

function card(widget: number): number {
  widgetSetBackgroundColor(widget, 1, 1, 1, 1);
  widgetSetBorderColor(widget, 0.86, 0.88, 0.9, 1);
  widgetSetBorderWidth(widget, 1);
  setCornerRadius(widget, 10);
  widgetSetEdgeInsets(widget, 12, 14, 12, 14);
  return widget;
}

function primaryButton(button: number): number {
  widgetSetBackgroundColor(button, GREEN.r, GREEN.g, GREEN.b, 1);
  buttonSetTextColor(button, 1, 1, 1, 1);
  setCornerRadius(button, 6);
  return button;
}

function subtleButton(button: number): number {
  widgetSetBackgroundColor(button, 0.93, 0.94, 0.96, 1);
  buttonSetTextColor(button, INK.r, INK.g, INK.b, 1);
  setCornerRadius(button, 6);
  return button;
}

// ---------------------------------------------------------------------------
// Configuração (Registry via preferences)

const config: ApiConfig = {
  baseUrl: String(preferencesGet('api_base_url') ?? 'http://localhost:3000'),
  apiKey: String(preferencesGet('api_key') ?? ''),
};

// ---------------------------------------------------------------------------
// Estado do lote

interface DraftRow {
  path: string;
  filename: string;
  // valores colhidos (fonte de verdade entre re-renders)
  name: string;
  email: string;
  phone: string;
  deliveryIndex: number;
  // handles vivos da linha renderizada (para colher/atualizar)
  nameField: number | null;
  emailField: number | null;
  phoneField: number | null;
  deliveryPicker: number | null;
  statusText: number | null;
  linkButton: number | null;
  retryButton: number | null;
  // resultado
  itemId: string | null;
  signUrl: string | null;
}

const DELIVERY_OPTIONS: Delivery[] = ['link', 'email', 'whatsapp'];
const DELIVERY_LABELS = ['Somente link', 'E-mail (Clicksign envia)', 'WhatsApp (Clicksign envia)'];

const drafts: DraftRow[] = [];
const rowCount = State(0);
const batchStatus = State('Adicione PDFs para montar o lote.');
let statusBarHandle: number | null = null;
let activeBatchId: string | null = null;
let pollHandle: ReturnType<typeof setInterval> | null = null;
let polling = false;

function setStatusBar(message: string, tone: 'ok' | 'erro' | 'neutro'): void {
  batchStatus.set(message);
  if (statusBarHandle !== null) {
    textSetString(statusBarHandle, message);
    const c = tone === 'ok' ? GREEN : tone === 'erro' ? RED : MUTED;
    textSetColor(statusBarHandle, c.r, c.g, c.b, 1);
  }
}

/** Lê os valores atuais dos widgets para os drafts (antes de re-render ou envio). */
function harvest(): void {
  for (const draft of drafts) {
    if (draft.nameField !== null) draft.name = textfieldGetString(draft.nameField);
    if (draft.emailField !== null) draft.email = textfieldGetString(draft.emailField);
    if (draft.phoneField !== null) draft.phone = textfieldGetString(draft.phoneField);
    if (draft.deliveryPicker !== null) draft.deliveryIndex = pickerGetSelected(draft.deliveryPicker);
  }
}

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

interface ValidationError {
  index: number;
  message: string;
}

/**
 * Validação local dos itens (espelha src/domain/validation.ts do backend).
 * Reimplementada aqui em estilo imperativo simples: o codegen do Perry
 * 0.5.1182 corrompe o retorno union `{ok, errors}` do módulo compartilhado
 * (errors chegava como null — classe de bug NaN-boxing conhecida do projeto).
 */
function validateDrafts(payload: BatchItemPayload[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const maxPdfBytes = 10 * 1024 * 1024;

  for (let i = 0; i < payload.length; i++) {
    const item = payload[i]!;
    const name = item.signer.name.trim();

    if (name.split(/\s+/).length < 2) {
      errors.push({ index: i, message: 'Informe nome e sobrenome do signatário' });
    }
    if (/\d/.test(name)) {
      errors.push({ index: i, message: 'O nome do signatário não pode conter números' });
    }
    if (item.delivery === 'email') {
      const email = item.signer.email ?? '';
      if (!emailPattern.test(email)) {
        errors.push({ index: i, message: "Envio por e-mail exige um e-mail válido" });
      }
    }
    if (item.delivery === 'whatsapp') {
      const phone = item.signer.phoneNumber ?? '';
      if (phone.length < 10) {
        errors.push({ index: i, message: 'Envio por WhatsApp exige telefone com DDD' });
      }
    }
    if (item.signer.email !== undefined && !emailPattern.test(item.signer.email)) {
      errors.push({ index: i, message: 'E-mail inválido' });
    }
    // A Clicksign exige document_signed em 'email' ou 'whatsapp' (nunca 'none'):
    // todo signatário precisa de ao menos um contato, mesmo em delivery 'link'.
    const hasEmail = item.signer.email !== undefined && item.signer.email !== '';
    const hasPhone = (item.signer.phoneNumber ?? '').length > 0;
    if (!hasEmail && !hasPhone) {
      errors.push({
        index: i,
        message: 'Informe e-mail ou telefone do signatário (a Clicksign exige ao menos um contato)',
      });
    }
    const bytes = Buffer.from(item.contentBase64, 'base64');
    if (bytes.length === 0 || bytes.subarray(0, 5).toString('latin1').indexOf('%PDF') !== 0) {
      errors.push({ index: i, message: 'O arquivo não é um PDF válido' });
    } else if (bytes.length > maxPdfBytes) {
      errors.push({ index: i, message: 'PDF excede o limite de 10 MB da Clicksign' });
    }
  }
  return errors;
}

function formatPhone(digits: string): string {
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return digits;
}

// ---------------------------------------------------------------------------
// Ações

function addPdf(): void {
  openFileDialog((path: string) => {
    if (path.length === 0) return;
    if (!path.toLowerCase().endsWith('.pdf')) {
      alert('Arquivo inválido', 'Selecione um arquivo PDF.');
      return;
    }
    harvest();
    drafts.push({
      path,
      filename: basename(path),
      name: '',
      email: '',
      phone: '',
      deliveryIndex: 0,
      nameField: null,
      emailField: null,
      phoneField: null,
      deliveryPicker: null,
      statusText: null,
      linkButton: null,
      retryButton: null,
      itemId: null,
      signUrl: null,
    });
    rowCount.set(drafts.length);
    setStatusBar(`${drafts.length} documento(s) no lote.`, 'neutro');
  });
}

function removeRow(index: number): void {
  harvest();
  drafts.splice(index, 1);
  rowCount.set(drafts.length);
  setStatusBar(`${drafts.length} documento(s) no lote.`, 'neutro');
}

function buildPayload(): BatchItemPayload[] {
  return drafts.map((d) => {
    const phone = normalizePhone(d.phone);
    return {
      filename: d.filename,
      contentBase64: readFileSync(d.path).toString('base64'),
      signer: {
        name: d.name.trim(),
        email: d.email.trim() === '' ? undefined : d.email.trim(),
        phoneNumber: phone === '' ? undefined : phone,
      },
      delivery: DELIVERY_OPTIONS[d.deliveryIndex] ?? 'link',
    };
  });
}

function setRowStatus(draft: DraftRow, message: string, tone: 'ok' | 'erro' | 'neutro'): void {
  if (draft.statusText === null) return;
  textSetString(draft.statusText, message);
  const c = tone === 'ok' ? GREEN : tone === 'erro' ? RED : MUTED;
  textSetColor(draft.statusText, c.r, c.g, c.b, 1);
}

function sendBatch(): void {
  if (polling) {
    alert('Aguarde', 'Já existe um lote em processamento.');
    return;
  }
  if (drafts.length === 0) {
    alert('Lote vazio', 'Adicione ao menos um PDF antes de enviar.');
    return;
  }
  harvest();

  let payload: BatchItemPayload[];
  try {
    payload = buildPayload();
  } catch (error) {
    alert('Erro ao ler arquivo', String(error));
    return;
  }

  const errors = validateDrafts(payload);
  if (errors.length > 0) {
    // diagnóstico legível no stdout (visível rodando pelo terminal)
    for (const d of drafts) {
      console.log(`[debug] lido: ${d.filename} | nome="${d.name}" email="${d.email}" fone="${d.phone}" envio=${DELIVERY_OPTIONS[d.deliveryIndex]}`);
    }
    for (const e of errors) {
      console.log(`[debug] erro item ${e.index}: ${e.message}`);
    }
    // o alert do Win32 descarta o corpo da mensagem — os erros aparecem
    // na linha de cada documento e na barra de status
    for (const e of errors) {
      const draft = drafts[e.index];
      if (draft) setRowStatus(draft, e.message, 'erro');
    }
    const first = errors[0]!;
    const firstFile = drafts[first.index]?.filename ?? `item ${first.index + 1}`;
    setStatusBar(
      `${errors.length} problema(s) — veja as mensagens em vermelho nas linhas. Primeiro: ${firstFile}: ${first.message}`,
      'erro',
    );
    alert(`Corrija antes de enviar: ${errors.length} problema(s)`, '');
    return;
  }

  setStatusBar('Enviando lote...', 'neutro');
  try {
    const { batchId } = createBatchSync(config, payload);
    activeBatchId = batchId;
    drafts.forEach((d) => setRowStatus(d, 'Na fila', 'neutro'));
    setStatusBar(`Lote ${batchId.slice(0, 8)} em processamento...`, 'neutro');
    startPolling();
  } catch (error) {
    setStatusBar(`Erro no envio: ${String(error)}`, 'erro');
  }
}

function startPolling(): void {
  polling = true;
  pollHandle = setInterval(() => {
    if (!activeBatchId) return;
    try {
      const status = getBatchSync(config, activeBatchId);
      status.items.forEach((item, index) => {
        const draft = drafts[index];
        if (!draft) return;
        draft.itemId = item.id;
        if (item.status === 'done' && item.signUrl) {
          draft.signUrl = item.signUrl;
          setRowStatus(draft, 'Concluído ✓', 'ok');
          if (draft.linkButton !== null) widgetSetHidden(draft.linkButton, 0);
          if (draft.retryButton !== null) widgetSetHidden(draft.retryButton, 1);
        } else if (item.status === 'failed') {
          setRowStatus(draft, `Falhou: ${item.errorMessage ?? 'erro'}`, 'erro');
          if (draft.retryButton !== null) widgetSetHidden(draft.retryButton, 0);
        } else {
          setRowStatus(draft, item.status === 'processing' ? 'Processando…' : 'Na fila', 'neutro');
        }
      });

      const { pending, processing, done, failed, total } = status.progress;
      if (pending + processing === 0) {
        stopPolling();
        setStatusBar(
          failed === 0
            ? `Lote concluído: ${done}/${total} link(s) prontos. Use "Copiar todos".`
            : `Lote finalizado: ${done} ok, ${failed} falha(s). Reenvie os itens com erro.`,
          failed === 0 ? 'ok' : 'erro',
        );
      } else {
        setStatusBar(`Progresso: ${done + failed}/${total} concluídos…`, 'neutro');
      }
    } catch (error) {
      setStatusBar(`Erro ao consultar lote: ${String(error)}`, 'erro');
    }
  }, 2500);
}

function stopPolling(): void {
  if (pollHandle !== null) clearInterval(pollHandle);
  pollHandle = null;
  polling = false;
}

function retryDraft(draft: DraftRow): void {
  if (!activeBatchId || !draft.itemId) return;
  try {
    retryItemSync(config, activeBatchId, draft.itemId);
    setRowStatus(draft, 'Reenfileirado…', 'neutro');
    if (draft.retryButton !== null) widgetSetHidden(draft.retryButton, 1);
    if (!polling) startPolling();
  } catch (error) {
    setRowStatus(draft, `Retry falhou: ${String(error)}`, 'erro');
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
  setStatusBar(`${lines.length} link(s) copiados para a área de transferência.`, 'ok');
}

// ---------------------------------------------------------------------------
// UI — configuração

let urlField: number;
let keyField: number;
let connStatusHandle: number;

function saveAndTest(): void {
  config.baseUrl = textfieldGetString(urlField).trim().replace(/\/+$/, '');
  config.apiKey = textfieldGetString(keyField).trim();
  preferencesSet('api_base_url', config.baseUrl);
  preferencesSet('api_key', config.apiKey);

  textSetString(connStatusHandle, 'Testando…');
  textSetColor(connStatusHandle, MUTED.r, MUTED.g, MUTED.b, 1);

  const result = testConnectionSync(config);
  if (result === 'ok') {
    textSetString(connStatusHandle, 'Conectado ✓');
    textSetColor(connStatusHandle, GREEN.r, GREEN.g, GREEN.b, 1);
  } else if (result === 'chave-invalida') {
    textSetString(connStatusHandle, 'API key inválida ✗');
    textSetColor(connStatusHandle, RED.r, RED.g, RED.b, 1);
  } else {
    textSetString(connStatusHandle, 'API inacessível — confira o endereço ✗');
    textSetColor(connStatusHandle, RED.r, RED.g, RED.b, 1);
  }
}

function settingsSection(): number {
  const title = Text('Configuração da API');
  textSetFontSize(title, 14);
  textSetFontWeight(title, 700);
  textSetColor(title, INK.r, INK.g, INK.b, 1);

  urlField = TextField('URL da API (ex.: http://localhost:3000)', () => {});
  textfieldSetString(urlField, config.baseUrl);
  widgetSetWidth(urlField, 320);

  keyField = TextField('API key', () => {});
  textfieldSetString(keyField, config.apiKey);
  widgetSetWidth(keyField, 260);

  const testButton = subtleButton(Button('Salvar e testar', saveAndTest));

  connStatusHandle = Text(config.apiKey === '' ? 'Informe a API key e teste a conexão.' : '');
  textSetColor(connStatusHandle, MUTED.r, MUTED.g, MUTED.b, 1);
  textSetFontSize(connStatusHandle, 12);

  return card(VStack(8, [title, HStack(8, [urlField, keyField, testButton, Spacer()]), connStatusHandle]));
}

// ---------------------------------------------------------------------------
// UI — linha do lote

function rowWidget(index: number): number {
  const draft = drafts[index];
  if (!draft) return Spacer();

  const fileLabel = Text(`📄 ${draft.filename}`);
  textSetFontWeight(fileLabel, 600);
  textSetColor(fileLabel, INK.r, INK.g, INK.b, 1);

  draft.statusText = Text('');
  textSetFontSize(draft.statusText, 12);

  draft.linkButton = subtleButton(
    Button('Copiar link', () => {
      if (draft.signUrl) {
        clipboardWrite(draft.signUrl);
        setRowStatus(draft, 'Link copiado ✓', 'ok');
      }
    }),
  );
  widgetSetHidden(draft.linkButton, draft.signUrl ? 0 : 1);

  draft.retryButton = subtleButton(Button('Tentar de novo', () => retryDraft(draft)));
  widgetSetHidden(draft.retryButton, 1);

  const removeButton = Button('✕', () => removeRow(index));
  buttonSetTextColor(removeButton, RED.r, RED.g, RED.b, 1);

  draft.nameField = TextField('Nome e sobrenome *', () => {});
  textfieldSetString(draft.nameField, draft.name);
  widgetSetWidth(draft.nameField, 220);

  draft.emailField = TextField('E-mail', () => {});
  textfieldSetString(draft.emailField, draft.email);
  widgetSetWidth(draft.emailField, 220);

  draft.phoneField = TextField('Telefone: (11) 99999-8888', () => {});
  textfieldSetString(draft.phoneField, formatPhone(normalizePhone(draft.phone)));
  widgetSetWidth(draft.phoneField, 170);

  draft.deliveryPicker = Picker(() => {});
  DELIVERY_LABELS.forEach((label) => pickerAddItem(draft.deliveryPicker!, label));
  pickerSetSelected(draft.deliveryPicker, draft.deliveryIndex);

  return card(
    VStack(8, [
      HStack(8, [fileLabel, Spacer(), draft.statusText, draft.linkButton, draft.retryButton, removeButton]),
      HStack(8, [draft.nameField, draft.emailField, draft.phoneField, draft.deliveryPicker, Spacer()]),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Montagem

const header = Text('HealthMais Assinaturas');
textSetFontSize(header, 20);
textSetFontWeight(header, 800);
textSetColor(header, BLUE.r, BLUE.g, BLUE.b, 1);

const subtitle = Text('Envio em lote de documentos para assinatura via Clicksign');
textSetFontSize(subtitle, 12);
textSetColor(subtitle, MUTED.r, MUTED.g, MUTED.b, 1);

const addButton = subtleButton(Button('+ Adicionar PDF', addPdf));
const sendButton = primaryButton(Button('Enviar lote', sendBatch));
const copyButton = subtleButton(Button('Copiar todos os links', copyAllLinks));

statusBarHandle = Text(`${batchStatus.value}`);
textSetFontSize(statusBarHandle, 12);
textSetColor(statusBarHandle, MUTED.r, MUTED.g, MUTED.b, 1);

const emptyHint = Text(`Documentos no lote: ${rowCount.value}`);
textSetFontSize(emptyHint, 12);
textSetColor(emptyHint, MUTED.r, MUTED.g, MUTED.b, 1);

const root = VStack(12, [
  VStack(2, [header, subtitle]),
  settingsSection(),
  HStack(10, [addButton, sendButton, copyButton, Spacer(), emptyHint]),
  VStack(10, [ForEach(rowCount, (i: number) => rowWidget(i))]),
  Spacer(),
  Divider(),
  statusBarHandle,
]);
widgetSetBackgroundColor(root, 0.96, 0.965, 0.975, 1);
widgetSetEdgeInsets(root, 16, 18, 12, 18);

App({
  title: 'HealthMais Assinaturas',
  width: 1100,
  height: 780,
  body: root,
});
