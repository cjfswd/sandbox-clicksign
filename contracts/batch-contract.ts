/**
 * Contrato ts-rest da batch API — fonte de verdade compartilhada
 * entre o servidor (Hono) e os clientes (app desktop Tauri).
 */
import { initContract } from '@ts-rest/core';
import { z } from 'zod';

export const deliverySchema = z.enum(['email', 'whatsapp', 'link']);

export const signerInputSchema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  phoneNumber: z.string().optional(),
});

export const batchItemInputSchema = z.object({
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
  signer: signerInputSchema,
  delivery: deliverySchema,
});

export const createBatchRequestSchema = z.object({
  items: z.array(batchItemInputSchema).min(1).max(100),
});

export const itemStatusSchema = z.enum(['pending', 'processing', 'done', 'failed']);

export const batchItemResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  signer: signerInputSchema,
  delivery: deliverySchema,
  status: itemStatusSchema,
  retryCount: z.number(),
  signUrl: z.string().nullable(),
  envelopeId: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

export const batchResponseSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  progress: z.object({
    total: z.number(),
    pending: z.number(),
    processing: z.number(),
    done: z.number(),
    failed: z.number(),
  }),
  items: z.array(batchItemResponseSchema),
});

export const validationErrorSchema = z.object({
  message: z.string(),
  errors: z.array(
    z.object({
      index: z.number(),
      field: z.string(),
      message: z.string(),
    }),
  ),
});

const c = initContract();

export const batchContract = c.router({
  createBatch: {
    method: 'POST',
    path: '/batches',
    body: createBatchRequestSchema,
    responses: {
      201: z.object({ batchId: z.string() }),
      400: validationErrorSchema,
      401: z.object({ message: z.string() }),
    },
    summary: 'Cria um lote de envios (1 documento → 1 destinatário por item)',
  },
  getBatch: {
    method: 'GET',
    path: '/batches/:id',
    responses: {
      200: batchResponseSchema,
      401: z.object({ message: z.string() }),
      404: z.object({ message: z.string() }),
    },
    summary: 'Consulta progresso e links de assinatura do lote',
  },
  retryItem: {
    method: 'POST',
    path: '/batches/:id/items/:itemId/retry',
    body: z.object({}).optional(),
    responses: {
      202: z.object({ itemId: z.string(), status: itemStatusSchema }),
      401: z.object({ message: z.string() }),
      404: z.object({ message: z.string() }),
      409: z.object({ message: z.string() }),
    },
    summary: 'Reenfileira um item failed',
  },
});

export type BatchContract = typeof batchContract;
export type CreateBatchRequest = z.infer<typeof createBatchRequestSchema>;
export type BatchResponse = z.infer<typeof batchResponseSchema>;
export type BatchItemResponse = z.infer<typeof batchItemResponseSchema>;
