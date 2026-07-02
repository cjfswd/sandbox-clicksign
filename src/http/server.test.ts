import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.ts';
import { BatchRepository } from '../infra/repository.ts';
import { PdfStore } from '../infra/pdf-store.ts';
import { fail } from '../domain/batch.ts';

const API_KEY = 'chave-de-teste-123';
const SECRET_TOKEN = 'token-clicksign-super-secreto';
const validPdfBase64 = Buffer.from('%PDF-1.4 conteudo').toString('base64');

function validPayload(itemCount = 1) {
  return {
    items: Array.from({ length: itemCount }, (_, i) => ({
      filename: `contrato-${i}.pdf`,
      contentBase64: validPdfBase64,
      signer: { name: 'Fulano da Silva', email: 'fulano@exemplo.com' },
      delivery: 'link',
    })),
  };
}

describe('batch API HTTP', () => {
  let repo: BatchRepository;
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let wakeWorker: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    repo = new BatchRepository(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'batch-http-'));
    wakeWorker = vi.fn();
    app = createApp({
      repo,
      pdfStore: new PdfStore(dir),
      apiKey: API_KEY,
      wakeWorker,
    });
  });

  afterEach(() => {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function request(path: string, init: RequestInit = {}, key: string | null = API_KEY) {
    const headers = new Headers(init.headers);
    if (key !== null) headers.set('x-api-key', key);
    if (init.body) headers.set('content-type', 'application/json');
    return app.request(path, { ...init, headers });
  }

  describe('CORS (app desktop)', () => {
    it('responde preflight OPTIONS permitindo x-api-key', async () => {
      const res = await app.request('/batches', {
        method: 'OPTIONS',
        headers: {
          origin: 'tauri://localhost',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-api-key,content-type',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
        'x-api-key',
      );
    });
  });

  describe('autenticação (critério 6)', () => {
    it('401 sem x-api-key', async () => {
      const res = await request('/batches', { method: 'POST' }, null);
      expect(res.status).toBe(401);
    });

    it('401 com x-api-key incorreta', async () => {
      const res = await request('/batches', { method: 'POST' }, 'chave-errada');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /batches', () => {
    it('201 imediato com batchId, itens persistidos e worker acordado (critério 1)', async () => {
      const res = await request('/batches', {
        method: 'POST',
        body: JSON.stringify(validPayload(3)),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { batchId: string };
      expect(body.batchId).toBeTruthy();

      const batch = repo.getBatch(body.batchId)!;
      expect(batch.items).toHaveLength(3);
      expect(batch.items.every((i) => i.status === 'pending')).toBe(true);
      expect(wakeWorker).toHaveBeenCalled();
    });

    it('400 com erros por item quando a validação falha (critério 4)', async () => {
      const payload = {
        items: [
          validPayload().items[0],
          {
            filename: 'x.pdf',
            contentBase64: validPdfBase64,
            signer: { name: 'SóNome' },
            delivery: 'whatsapp',
          },
        ],
      };
      const res = await request('/batches', { method: 'POST', body: JSON.stringify(payload) });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors: Array<{ index: number; field: string }> };
      expect(body.errors.length).toBeGreaterThanOrEqual(2);
      expect(body.errors.every((e) => e.index === 1)).toBe(true);
    });

    it('400 para payload estruturalmente inválido', async () => {
      const res = await request('/batches', { method: 'POST', body: JSON.stringify({ items: [] }) });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /batches/:id', () => {
    it('404 para lote inexistente', async () => {
      const res = await request('/batches/nao-existe');
      expect(res.status).toBe(404);
    });

    it('retorna progresso agregado e itens com links (critério 2)', async () => {
      const created = await request('/batches', {
        method: 'POST',
        body: JSON.stringify(validPayload(2)),
      });
      const { batchId } = (await created.json()) as { batchId: string };

      const claimed = repo.claimNextPending()!;
      repo.saveItemResult({
        ...claimed,
        status: 'done',
        envelopeId: 'env-1',
        signerId: 'sig-1',
        signUrl: 'https://x/sign',
      });

      const res = await request(`/batches/${batchId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        progress: Record<string, number>;
        items: Array<{ status: string; signUrl: string | null }>;
      };
      expect(body.progress).toMatchObject({ total: 2, done: 1, pending: 1 });
      expect(body.items.find((i) => i.status === 'done')!.signUrl).toBe('https://x/sign');
    });
  });

  describe('POST /batches/:id/items/:itemId/retry', () => {
    it('202 reenfileira item failed', async () => {
      const created = await request('/batches', {
        method: 'POST',
        body: JSON.stringify(validPayload(1)),
      });
      const { batchId } = (await created.json()) as { batchId: string };
      const claimed = repo.claimNextPending()!;
      repo.saveItemResult(fail(claimed, 'erro qualquer'));

      const res = await request(`/batches/${batchId}/items/${claimed.id}/retry`, {
        method: 'POST',
      });
      expect(res.status).toBe(202);
      expect(wakeWorker).toHaveBeenCalledTimes(2); // create + retry
    });

    it('409 para item que não está failed', async () => {
      const created = await request('/batches', {
        method: 'POST',
        body: JSON.stringify(validPayload(1)),
      });
      const { batchId } = (await created.json()) as { batchId: string };
      const itemId = repo.getBatch(batchId)!.items[0]!.id;

      const res = await request(`/batches/${batchId}/items/${itemId}/retry`, { method: 'POST' });
      expect(res.status).toBe(409);
    });

    it('404 para item inexistente', async () => {
      const res = await request('/batches/b/items/nao-existe/retry', { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });

  describe('sanitização de erros (critério 5)', () => {
    it('erro interno contendo o token da Clicksign não vaza na resposta', async () => {
      const throwingRepo = {
        getBatch: () => {
          throw new Error(`falha com Authorization: ${SECRET_TOKEN} no corpo`);
        },
      } as unknown as BatchRepository;
      const brokenApp = createApp({
        repo: throwingRepo,
        pdfStore: new PdfStore(dir),
        apiKey: API_KEY,
        wakeWorker: () => {},
        secrets: [SECRET_TOKEN],
      });

      const res = await brokenApp.request('/batches/qualquer', {
        headers: { 'x-api-key': API_KEY },
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain(SECRET_TOKEN);
    });
  });
});
