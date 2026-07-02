import { describe, expect, it } from 'vitest';
import {
  complete,
  fail,
  resetForRetry,
  startProcessing,
  type BatchItem,
  type PendingItem,
} from './batch.ts';

function pendingItem(overrides: Partial<PendingItem> = {}): PendingItem {
  return {
    status: 'pending',
    id: 'item-1',
    batchId: 'batch-1',
    filename: 'contrato.pdf',
    signer: { name: 'Fulano da Silva', email: 'fulano@exemplo.com' },
    delivery: 'link',
    retryCount: 0,
    ...overrides,
  };
}

const clicksignResult = {
  envelopeId: 'env-1',
  signerId: 'sig-1',
  signUrl: 'https://sandbox.clicksign.com/notarial/widget/signatures/sig-1/redirect',
};

describe('startProcessing', () => {
  it('transiciona pending para processing', () => {
    const processing = startProcessing(pendingItem());
    expect(processing.status).toBe('processing');
    expect(processing.retryCount).toBe(0);
  });

  it('rejeita item que não está pending', () => {
    const processing = startProcessing(pendingItem());
    expect(() => startProcessing(processing as unknown as BatchItem)).toThrow(/pending/);
  });
});

describe('complete', () => {
  it('transiciona processing para done com os dados da Clicksign', () => {
    const done = complete(startProcessing(pendingItem()), clicksignResult);
    expect(done.status).toBe('done');
    expect(done.signUrl).toBe(clicksignResult.signUrl);
    expect(done.envelopeId).toBe('env-1');
    expect(done.signerId).toBe('sig-1');
  });

  it('rejeita completar item que não está processing', () => {
    expect(() => complete(pendingItem() as unknown as BatchItem, clicksignResult)).toThrow(
      /processing/,
    );
  });

  it('rejeita completar item já done', () => {
    const done = complete(startProcessing(pendingItem()), clicksignResult);
    expect(() => complete(done as unknown as BatchItem, clicksignResult)).toThrow(/processing/);
  });
});

describe('fail', () => {
  it('transiciona processing para failed com a mensagem de erro', () => {
    const failed = fail(startProcessing(pendingItem()), 'HTTP 422: signer inválido');
    expect(failed.status).toBe('failed');
    expect(failed.errorMessage).toBe('HTTP 422: signer inválido');
  });

  it('rejeita falhar item que não está processing', () => {
    expect(() => fail(pendingItem() as unknown as BatchItem, 'erro')).toThrow(/processing/);
  });
});

describe('resetForRetry', () => {
  it('volta failed para pending incrementando retryCount', () => {
    const failed = fail(startProcessing(pendingItem()), 'erro transitório');
    const retried = resetForRetry(failed);
    expect(retried.status).toBe('pending');
    expect(retried.retryCount).toBe(1);
  });

  it('acumula retryCount em falhas sucessivas', () => {
    const failedTwice = fail(
      startProcessing(resetForRetry(fail(startProcessing(pendingItem()), 'erro 1'))),
      'erro 2',
    );
    expect(resetForRetry(failedTwice).retryCount).toBe(2);
  });

  it('rejeita retry de item que não está failed', () => {
    expect(() => resetForRetry(pendingItem() as unknown as BatchItem)).toThrow(/failed/);
  });
});
