/**
 * Validação semântica dos itens do lote (critério 4 da spec).
 * Fail fast: o lote inteiro é rejeitado antes de qualquer chamada à Clicksign,
 * reportando TODOS os erros com o índice do item.
 */
import type { Delivery, Signer } from './batch.ts';

export interface BatchItemInput {
  filename: string;
  contentBase64: string;
  signer: Signer;
  delivery: Delivery;
}

export interface ItemValidationError {
  index: number;
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ItemValidationError[] };

const MAX_PDF_BYTES = 10 * 1024 * 1024; // limite da Clicksign por arquivo
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateBatchItems(items: BatchItemInput[]): ValidationResult {
  const errors: ItemValidationError[] = [];
  items.forEach((item, index) => {
    errors.push(...validateItem(item, index));
  });
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateItem(item: BatchItemInput, index: number): ItemValidationError[] {
  const errors: ItemValidationError[] = [];

  // A Clicksign exige nome e sobrenome — rejeitar aqui evita falha garantida no worker.
  if (item.signer.name.trim().split(/\s+/).length < 2) {
    errors.push({
      index,
      field: 'signer.name',
      message: 'Informe nome e sobrenome do signatário',
    });
  }

  // A Clicksign rejeita nomes com números ("name não está em um formato válido").
  if (/\d/.test(item.signer.name)) {
    errors.push({
      index,
      field: 'signer.name',
      message: 'O nome do signatário não pode conter números',
    });
  }

  if (item.delivery === 'email' && !isValidEmail(item.signer.email)) {
    errors.push({
      index,
      field: 'signer.email',
      message: "delivery 'email' exige um e-mail válido",
    });
  }

  if (item.delivery === 'whatsapp' && !item.signer.phoneNumber?.trim()) {
    errors.push({
      index,
      field: 'signer.phoneNumber',
      message: "delivery 'whatsapp' exige phoneNumber",
    });
  }

  if (item.signer.email !== undefined && !isValidEmail(item.signer.email)) {
    const alreadyReported = errors.some((e) => e.index === index && e.field === 'signer.email');
    if (!alreadyReported) {
      errors.push({ index, field: 'signer.email', message: 'E-mail inválido' });
    }
  }

  // A Clicksign exige o campo document_signed em 'email' ou 'whatsapp' (nunca 'none'),
  // então todo signatário precisa de ao menos um contato, mesmo em delivery 'link'.
  if (item.signer.email === undefined && !item.signer.phoneNumber?.trim()) {
    errors.push({
      index,
      field: 'signer.email',
      message: 'Informe e-mail ou telefone do signatário (a Clicksign exige ao menos um contato)',
    });
  }

  errors.push(...validatePdfContent(item.contentBase64, index));
  return errors;
}

function isValidEmail(email: string | undefined): boolean {
  return email !== undefined && EMAIL_PATTERN.test(email);
}

function validatePdfContent(contentBase64: string, index: number): ItemValidationError[] {
  const field = 'contentBase64';
  let decoded: Buffer;
  try {
    decoded = Buffer.from(contentBase64, 'base64');
    // Node ignora caracteres inválidos silenciosamente; comparar o round-trip detecta lixo.
    const normalized = contentBase64.replace(/\s/g, '');
    if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
      return [{ index, field, message: 'Conteúdo não é base64 válido' }];
    }
  } catch {
    return [{ index, field, message: 'Conteúdo não é base64 válido' }];
  }

  if (!decoded.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    return [{ index, field, message: 'Conteúdo não é um PDF (magic bytes %PDF ausentes)' }];
  }

  if (decoded.length > MAX_PDF_BYTES) {
    return [{ index, field, message: 'PDF excede o limite de 10 MB da Clicksign' }];
  }

  return [];
}
