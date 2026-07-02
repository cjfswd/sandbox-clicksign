/**
 * Domínio do lote de envio: tipos e transições de estado.
 * Puro — sem IO. O worker é o único que executa transições.
 *
 * pending → processing → done
 *                      → failed → (retry) → pending
 */

export type Delivery = 'email' | 'whatsapp' | 'link';

export interface Signer {
  name: string;
  email?: string;
  phoneNumber?: string;
}

interface BaseItem {
  id: string;
  batchId: string;
  filename: string;
  signer: Signer;
  delivery: Delivery;
  retryCount: number;
}

export interface PendingItem extends BaseItem {
  status: 'pending';
}

export interface ProcessingItem extends BaseItem {
  status: 'processing';
}

export interface DoneItem extends BaseItem {
  status: 'done';
  envelopeId: string;
  signerId: string;
  signUrl: string;
}

export interface FailedItem extends BaseItem {
  status: 'failed';
  errorMessage: string;
}

export type BatchItem = PendingItem | ProcessingItem | DoneItem | FailedItem;

export interface Batch {
  id: string;
  createdAt: string;
  items: BatchItem[];
}

export interface ClicksignResult {
  envelopeId: string;
  signerId: string;
  signUrl: string;
}

function invalidTransition(action: string, expected: string, item: BatchItem): never {
  throw new Error(
    `Transição inválida: ${action} exige item ${expected}, mas o item ${item.id} está '${item.status}'`,
  );
}

export function startProcessing(item: BatchItem): ProcessingItem {
  if (item.status !== 'pending') invalidTransition('startProcessing', "'pending'", item);
  return { ...item, status: 'processing' };
}

export function complete(item: BatchItem, result: ClicksignResult): DoneItem {
  if (item.status !== 'processing') invalidTransition('complete', "'processing'", item);
  const { envelopeId, signerId, signUrl } = result;
  return { ...item, status: 'done', envelopeId, signerId, signUrl };
}

export function fail(item: BatchItem, errorMessage: string): FailedItem {
  if (item.status !== 'processing') invalidTransition('fail', "'processing'", item);
  return { ...item, status: 'failed', errorMessage };
}

export function resetForRetry(item: BatchItem): PendingItem {
  if (item.status !== 'failed') invalidTransition('resetForRetry', "'failed'", item);
  const { errorMessage: _discarded, ...base } = item;
  return { ...base, status: 'pending', retryCount: item.retryCount + 1 };
}
