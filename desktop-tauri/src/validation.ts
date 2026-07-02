/**
 * Validação local do lote, espelhando src/domain/validation.ts do backend
 * (fail-fast, mesmos critérios) — reimplementada aqui porque o navegador
 * não decodifica base64 com Buffer.
 */
import type { Delivery } from './native/batch.ts';

export interface BatchItemPayload {
  filename: string;
  contentBase64: string;
  signer: { name: string; email?: string; phoneNumber?: string };
  delivery: Delivery;
}

export interface ItemValidationError {
  index: number;
  field: string;
  message: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PDF_BYTES = 10 * 1024 * 1024;

export function validateBatchItems(items: BatchItemPayload[]): ItemValidationError[] {
  return items.flatMap((item, index) => validateItem(item, index));
}

function validateItem(item: BatchItemPayload, index: number): ItemValidationError[] {
  const errors: ItemValidationError[] = [];
  const name = item.signer.name.trim();

  if (name.split(/\s+/).filter(Boolean).length < 2) {
    errors.push({ index, field: 'signer.name', message: 'Informe nome e sobrenome do signatário' });
  }
  if (/\d/.test(name)) {
    errors.push({ index, field: 'signer.name', message: 'O nome não pode conter números' });
  }
  if (item.delivery === 'email' && !isValidEmail(item.signer.email)) {
    errors.push({ index, field: 'signer.email', message: "Envio por e-mail exige um e-mail válido" });
  }
  if (item.delivery === 'whatsapp' && (item.signer.phoneNumber ?? '').replace(/\D/g, '').length < 10) {
    errors.push({ index, field: 'signer.phoneNumber', message: 'Envio por WhatsApp exige telefone com DDD' });
  }
  if (item.signer.email !== undefined && item.signer.email !== '' && !isValidEmail(item.signer.email)) {
    errors.push({ index, field: 'signer.email', message: 'E-mail inválido' });
  }
  // A Clicksign exige document_signed em 'email' ou 'whatsapp' (nunca 'none'):
  // todo signatário precisa de ao menos um contato, mesmo em delivery 'link'.
  const hasEmail = item.signer.email !== undefined && item.signer.email !== '';
  const hasPhone = (item.signer.phoneNumber ?? '').replace(/\D/g, '').length > 0;
  if (!hasEmail && !hasPhone) {
    errors.push({
      index,
      field: 'signer.email',
      message: 'Informe e-mail ou telefone do signatário (a Clicksign exige ao menos um contato)',
    });
  }
  errors.push(...validatePdf(item.contentBase64, index));
  return errors;
}

function isValidEmail(email: string | undefined): boolean {
  return email !== undefined && EMAIL_PATTERN.test(email);
}

function validatePdf(contentBase64: string, index: number): ItemValidationError[] {
  const field = 'contentBase64';
  let bytes: Uint8Array;
  try {
    const binary = atob(contentBase64);
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return [{ index, field, message: 'Conteúdo não é base64 válido' }];
  }
  const header = String.fromCharCode(...bytes.subarray(0, 5));
  if (!header.startsWith('%PDF')) {
    return [{ index, field, message: 'O arquivo não é um PDF válido' }];
  }
  if (bytes.length > MAX_PDF_BYTES) {
    return [{ index, field, message: 'PDF excede o limite de 10 MB da Clicksign' }];
  }
  return [];
}
