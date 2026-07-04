import { describe, expect, it } from 'vitest';
import { applyClicksignStatus, complete, startProcessing } from './batch.ts';
import type { PendingItem } from './batch.ts';

function pendingItem(): PendingItem {
  return {
    id: 'item-1',
    batchId: 'batch-1',
    filename: 'contrato.pdf',
    signer: { name: 'Ana Silva', email: 'ana@example.com' },
    delivery: 'link',
    retryCount: 0,
    status: 'pending',
    clicksignStatus: null,
    clicksignStatusCheckedAt: null,
    deadlineAt: null,
  };
}

it('preserva deadlineAt através de startProcessing/complete', () => {
  const pending: PendingItem = {
    id: 'item-1',
    batchId: 'batch-1',
    filename: 'contrato.pdf',
    signer: { name: 'Ana Silva', email: 'ana@example.com' },
    delivery: 'link',
    retryCount: 0,
    clicksignStatus: null,
    clicksignStatusCheckedAt: null,
    deadlineAt: '2026-08-15T23:59:59.999Z',
    status: 'pending',
  };
  const processing = startProcessing(pending);
  const done = complete(processing, {
    envelopeId: 'env-1',
    signerId: 'signer-1',
    signUrl: 'https://sandbox.clicksign.com/notarial/widget/signatures/signer-1/redirect',
  });
  expect(done.deadlineAt).toBe('2026-08-15T23:59:59.999Z');
});

describe('applyClicksignStatus', () => {
  it('grava status e timestamp de checagem, preservando os outros campos do item', () => {
    const processing = startProcessing(pendingItem());
    const done = complete(processing, {
      envelopeId: 'env-1',
      signerId: 'signer-1',
      signUrl: 'https://sandbox.clicksign.com/notarial/widget/signatures/signer-1/redirect',
    });

    const updated = applyClicksignStatus(done, 'signed', '2026-07-03T12:00:00.000Z');

    expect(updated.clicksignStatus).toBe('signed');
    expect(updated.clicksignStatusCheckedAt).toBe('2026-07-03T12:00:00.000Z');
    expect(updated.id).toBe('item-1');
    expect(updated.status).toBe('done');
  });

  it('funciona em qualquer status do item (não é uma transição de pipeline)', () => {
    const updated = applyClicksignStatus(pendingItem(), 'pending', '2026-07-03T12:00:00.000Z');
    expect(updated.status).toBe('pending');
    expect(updated.clicksignStatus).toBe('pending');
  });
});
