/**
 * Domínio do lote — cópia de src/domain/batch.ts (lógica pura, sem Node).
 * Mantido em sincronia manual até a migração ser concluída (ver
 * MIGRATION-PLAN.md); se divergir, o arquivo original é a fonte de verdade.
 */

/** Como o signatário é notificado/autenticado — ver authMethodFor/communicateEventsFor em process-item.ts. */
export type Delivery = 'email' | 'whatsapp' | 'link' | 'handwritten';

/** Status da assinatura confirmado na Clicksign — independente do status do pipeline de envio (pending/processing/done/failed). null até a primeira checagem manual (botão "Atualizar"). */
export type ClicksignStatus = 'pending' | 'signed' | 'canceled';

/** Dados de contato de quem vai assinar; pelo menos um de email/phoneNumber é exigido na validação. */
export interface Signer {
  name: string;
  email?: string;
  phoneNumber?: string;
}

/** Campos comuns a todo item, independente do status atual. */
interface BaseItem {
  /** UUID gerado no repositório ao criar o lote. */
  id: string;
  batchId: string;
  filename: string;
  signer: Signer;
  delivery: Delivery;
  /** Quantas vezes já foi reenviado via resetForRetry; começa em 0. */
  retryCount: number;
  /** null até alguém clicar em "Atualizar" no histórico. */
  clicksignStatus: ClicksignStatus | null;
  /** Timestamp ISO da última checagem; null se nunca checado. */
  clicksignStatusCheckedAt: string | null;
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

/** União discriminada por `status` — o TS só deixa acessar envelopeId/errorMessage no branch certo. */
export type BatchItem = PendingItem | ProcessingItem | DoneItem | FailedItem;

/** Um lote e todos os seus itens, na forma devolvida por BatchRepository.getBatch. */
export interface Batch {
  id: string;
  createdAt: string;
  items: BatchItem[];
}

/** O que processItem devolve ao completar um item com sucesso — vira os campos de DoneItem. */
export interface ClicksignResult {
  envelopeId: string;
  signerId: string;
  signUrl: string;
}

/** Erro lançado quando uma função de transição é chamada com o item no status errado. */
function invalidTransition(action: string, expected: string, item: BatchItem): never {
  throw new Error(
    `Transição inválida: ${action} exige item ${expected}, mas o item ${item.id} está '${item.status}'`,
  );
}

/** pending → processing: chamada pelo claim atômico do repositório. */
export function startProcessing(item: BatchItem): ProcessingItem {
  if (item.status !== 'pending') invalidTransition('startProcessing', "'pending'", item);
  return { ...item, status: 'processing' };
}

/** processing → done: grava o resultado da Clicksign no item. */
export function complete(item: BatchItem, result: ClicksignResult): DoneItem {
  if (item.status !== 'processing') invalidTransition('complete', "'processing'", item);
  const { envelopeId, signerId, signUrl } = result;
  return { ...item, status: 'done', envelopeId, signerId, signUrl };
}

/** processing → failed: grava a mensagem de erro. */
export function fail(item: BatchItem, errorMessage: string): FailedItem {
  if (item.status !== 'processing') invalidTransition('fail', "'processing'", item);
  return { ...item, status: 'failed', errorMessage };
}

/** failed → pending: descarta o erro anterior e incrementa retryCount para nova tentativa. */
export function resetForRetry(item: BatchItem): PendingItem {
  if (item.status !== 'failed') invalidTransition('resetForRetry', "'failed'", item);
  const { errorMessage: _discarded, ...base } = item;
  return { ...base, status: 'pending', retryCount: item.retryCount + 1 };
}

/** Grava o resultado de uma checagem manual de status na Clicksign — não é uma transição de pipeline, funciona em qualquer status do item. */
export function applyClicksignStatus(
  item: BatchItem,
  status: ClicksignStatus,
  checkedAtIso: string,
): BatchItem {
  return { ...item, clicksignStatus: status, clicksignStatusCheckedAt: checkedAtIso };
}
