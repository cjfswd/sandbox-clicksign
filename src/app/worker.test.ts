import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueWorker } from './worker.ts';
import { BatchRepository } from '../infra/repository.ts';
import type { BatchItemInput } from '../domain/validation.ts';
import type { ClicksignResult, ProcessingItem } from '../domain/batch.ts';

function input(filename: string): BatchItemInput {
  return {
    filename,
    contentBase64: 'ignorado',
    signer: { name: 'Fulano da Silva', email: 'f@exemplo.com' },
    delivery: 'link',
  };
}

function resultFor(item: ProcessingItem): ClicksignResult {
  return {
    envelopeId: `env-${item.filename}`,
    signerId: `sig-${item.filename}`,
    signUrl: `https://x/sign/${item.filename}`,
  };
}

describe('QueueWorker', () => {
  let repo: BatchRepository;
  let removed: string[];

  beforeEach(() => {
    repo = new BatchRepository(':memory:');
    removed = [];
  });

  afterEach(() => {
    repo.close();
  });

  function worker(processImpl: (item: ProcessingItem) => Promise<ClicksignResult>) {
    return new QueueWorker({
      repo,
      process: processImpl,
      removePdf: (itemId) => removed.push(itemId),
    });
  }

  it('processa todos os itens pending e grava done com link', async () => {
    const batch = repo.createBatch([input('a.pdf'), input('b.pdf')]);
    const w = worker(async (item) => resultFor(item));

    await w.drain();

    const found = repo.getBatch(batch.id)!;
    expect(found.items.every((i) => i.status === 'done')).toBe(true);
    expect(found.items.map((i) => (i.status === 'done' ? i.signUrl : null))).toEqual([
      'https://x/sign/a.pdf',
      'https://x/sign/b.pdf',
    ]);
  });

  it('remove o PDF do disco quando o item conclui', async () => {
    const batch = repo.createBatch([input('a.pdf')]);
    await worker(async (item) => resultFor(item)).drain();
    expect(removed).toEqual([repo.getBatch(batch.id)!.items[0]!.id]);
  });

  it('item que falha vira failed com mensagem e não impede os demais (critério 7)', async () => {
    const batch = repo.createBatch([input('a.pdf'), input('b.pdf'), input('c.pdf')]);
    const w = worker(async (item) => {
      if (item.filename === 'b.pdf') throw new Error('HTTP 422: signatário inválido');
      return resultFor(item);
    });

    await w.drain();

    const found = repo.getBatch(batch.id)!;
    const statuses = found.items.map((i) => i.status);
    expect(statuses).toEqual(['done', 'failed', 'done']);
    const failedItem = found.items[1]!;
    expect(failedItem.status === 'failed' && failedItem.errorMessage).toContain('HTTP 422');
    expect(removed).toHaveLength(2); // PDF do item failed permanece para retry
  });

  it('no start(), itens presos em processing são retomados (critério 9)', async () => {
    const batch = repo.createBatch([input('a.pdf')]);
    repo.claimNextPending(); // simula crash: item ficou processing

    const w = worker(async (item) => resultFor(item));
    w.start();
    await w.drain();
    w.stop();

    const found = repo.getBatch(batch.id)!;
    expect(found.items[0]!.status).toBe('done');
  });

  it('wake() dispara processamento de trabalho que chegou depois', async () => {
    const w = worker(async (item) => resultFor(item));
    w.start();
    await w.drain(); // fila vazia

    const batch = repo.createBatch([input('nova.pdf')]);
    w.wake();
    await w.drain();
    w.stop();

    expect(repo.getBatch(batch.id)!.items[0]!.status).toBe('done');
  });

  it('captura erro não-Error sem quebrar o loop', async () => {
    const batch = repo.createBatch([input('a.pdf')]);
    const w = worker(async () => {
      throw 'string jogada'; // eslint-disable-line no-throw-literal
    });
    await w.drain();
    expect(repo.getBatch(batch.id)!.items[0]!.status).toBe('failed');
  });
});
