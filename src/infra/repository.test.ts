import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BatchRepository } from './repository.ts';
import type { BatchItemInput } from '../domain/validation.ts';
import { complete, fail } from '../domain/batch.ts';

function input(overrides: Partial<BatchItemInput> = {}): BatchItemInput {
  return {
    filename: 'contrato.pdf',
    contentBase64: 'ignorado-pelo-repositorio',
    signer: { name: 'Fulano da Silva', email: 'fulano@exemplo.com' },
    delivery: 'link',
    ...overrides,
  };
}

describe('BatchRepository', () => {
  let repo: BatchRepository;

  beforeEach(() => {
    repo = new BatchRepository(':memory:');
  });

  afterEach(() => {
    repo.close();
  });

  it('cria lote com itens pending e o recupera com progresso agregado', () => {
    const batch = repo.createBatch([input(), input({ delivery: 'email' })]);
    const found = repo.getBatch(batch.id);

    expect(found).not.toBeNull();
    expect(found!.items).toHaveLength(2);
    expect(found!.items.every((i) => i.status === 'pending')).toBe(true);
  });

  it('retorna null para lote inexistente', () => {
    expect(repo.getBatch('nao-existe')).toBeNull();
  });

  it('claimNextPending transiciona para processing e respeita a ordem de criação', () => {
    const batch = repo.createBatch([input({ filename: 'a.pdf' }), input({ filename: 'b.pdf' })]);

    const first = repo.claimNextPending();
    expect(first!.filename).toBe('a.pdf');
    expect(first!.status).toBe('processing');

    const second = repo.claimNextPending();
    expect(second!.filename).toBe('b.pdf');

    expect(repo.claimNextPending()).toBeNull();
    const found = repo.getBatch(batch.id);
    expect(found!.items.every((i) => i.status === 'processing')).toBe(true);
  });

  it('persiste resultado done com link e resultado failed com mensagem', () => {
    const batch = repo.createBatch([input(), input()]);
    const a = repo.claimNextPending()!;
    const b = repo.claimNextPending()!;

    repo.saveItemResult(
      complete(a, { envelopeId: 'env-1', signerId: 'sig-1', signUrl: 'https://x/sign' }),
    );
    repo.saveItemResult(fail(b, 'HTTP 422: erro'));

    const found = repo.getBatch(batch.id)!;
    const doneItem = found.items.find((i) => i.status === 'done');
    const failedItem = found.items.find((i) => i.status === 'failed');
    expect(doneItem).toMatchObject({ signUrl: 'https://x/sign', envelopeId: 'env-1' });
    expect(failedItem).toMatchObject({ errorMessage: 'HTTP 422: erro' });
  });

  it('reclaimStale devolve itens processing para pending', () => {
    repo.createBatch([input(), input()]);
    repo.claimNextPending();
    repo.claimNextPending();

    const reclaimed = repo.reclaimStale();
    expect(reclaimed).toBe(2);
    expect(repo.claimNextPending()).not.toBeNull();
  });

  it('resetItemForRetry reenfileira somente item failed, incrementando retryCount', () => {
    const batch = repo.createBatch([input()]);
    const claimed = repo.claimNextPending()!;
    repo.saveItemResult(fail(claimed, 'erro'));

    const retried = repo.resetItemForRetry(batch.id, claimed.id);
    expect(retried.status).toBe('pending');
    expect(retried.retryCount).toBe(1);

    // item agora pending — segundo retry deve falhar
    expect(() => repo.resetItemForRetry(batch.id, claimed.id)).toThrow(/failed/);
  });

  it('resetItemForRetry lança erro para item inexistente', () => {
    expect(() => repo.resetItemForRetry('b', 'nao-existe')).toThrow(/não encontrado/);
  });
});
