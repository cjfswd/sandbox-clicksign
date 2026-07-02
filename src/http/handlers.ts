/**
 * Handlers do contrato batch-contract:
 * POST /batches (201 imediato — critério 1), GET /batches/:id (critério 2),
 * POST /batches/:id/items/:itemId/retry.
 */
import type { Hono } from 'hono';
import { createBatchRequestSchema, type BatchResponse } from '../../contracts/batch-contract.ts';
import { validateBatchItems, type ItemValidationError } from '../domain/validation.ts';
import type { Batch, BatchItem } from '../domain/batch.ts';
import type { AppDeps } from './server.ts';

export function registerBatchRoutes(app: Hono, deps: AppDeps): void {
  app.post('/batches', async (c) => {
    const parsed = createBatchRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { message: 'Payload inválido', errors: zodIssuesToItemErrors(parsed.error.issues) },
        400,
      );
    }

    const validation = validateBatchItems(parsed.data.items);
    if (!validation.ok) {
      return c.json({ message: 'Lote rejeitado pela validação', errors: validation.errors }, 400);
    }

    const batch = deps.repo.createBatch(parsed.data.items);
    batch.items.forEach((item, index) => {
      deps.pdfStore.save(item.id, parsed.data.items[index]!.contentBase64);
    });
    deps.wakeWorker();
    return c.json({ batchId: batch.id }, 201);
  });

  app.get('/batches/:id', (c) => {
    const batch = deps.repo.getBatch(c.req.param('id'));
    if (!batch) return c.json({ message: 'Lote não encontrado' }, 404);
    return c.json(toBatchResponse(batch), 200);
  });

  app.post('/batches/:id/items/:itemId/retry', (c) => {
    const { id, itemId } = c.req.param();
    try {
      const item = deps.repo.resetItemForRetry(id, itemId);
      deps.wakeWorker();
      return c.json({ itemId: item.id, status: item.status }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro';
      if (message.includes('não encontrado')) return c.json({ message }, 404);
      return c.json({ message }, 409);
    }
  });
}

function zodIssuesToItemErrors(
  issues: Array<{ path: Array<string | number>; message: string }>,
): ItemValidationError[] {
  return issues.map((issue) => {
    const [, index, ...rest] = issue.path;
    return {
      index: typeof index === 'number' ? index : -1,
      field: rest.join('.') || String(issue.path.join('.')),
      message: issue.message,
    };
  });
}

function toBatchResponse(batch: Batch): BatchResponse {
  const count = (status: BatchItem['status']) =>
    batch.items.filter((i) => i.status === status).length;

  return {
    id: batch.id,
    createdAt: batch.createdAt,
    progress: {
      total: batch.items.length,
      pending: count('pending'),
      processing: count('processing'),
      done: count('done'),
      failed: count('failed'),
    },
    items: batch.items.map((item) => ({
      id: item.id,
      filename: item.filename,
      signer: item.signer,
      delivery: item.delivery,
      status: item.status,
      retryCount: item.retryCount,
      signUrl: item.status === 'done' ? item.signUrl : null,
      envelopeId: item.status === 'done' ? item.envelopeId : null,
      errorMessage: item.status === 'failed' ? item.errorMessage : null,
    })),
  };
}
