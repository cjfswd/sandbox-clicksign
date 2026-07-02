/**
 * Teste de integração de ponta a ponta contra o SANDBOX REAL da Clicksign.
 * Pulado automaticamente se CLICKSIGN_ACCESS_TOKEN não estiver no ambiente.
 *
 * Prova o critério 2 da spec: lote de 3 itens delivery=link → todos done
 * com links de assinatura que resolvem para a página real (não /404).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClicksignClient } from './infra/clicksign.ts';
import { BatchRepository } from './infra/repository.ts';
import { PdfStore } from './infra/pdf-store.ts';
import { TokenBucket } from './infra/rate-limiter.ts';
import { ThrottledClicksign } from './infra/throttled-clicksign.ts';
import { QueueWorker } from './app/worker.ts';
import { processItem } from './app/process-item.ts';
import { createApp } from './http/server.ts';
import { generateSamplePdfBase64 } from './infra/sample-pdf.ts';

const token = process.env.CLICKSIGN_ACCESS_TOKEN;
const baseUrl = process.env.CLICKSIGN_BASE_URL ?? 'https://sandbox.clicksign.com';
const API_KEY = 'integration-test-key';

describe.skipIf(!token)('integração sandbox: lote completo', () => {
  let repo: BatchRepository;
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let worker: QueueWorker;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'batch-integration-'));
    repo = new BatchRepository(':memory:');
    const pdfStore = new PdfStore(join(dir, 'pdfs'));
    const client = new ClicksignClient({ baseUrl, accessToken: token! });
    const throttled = new ThrottledClicksign(
      client,
      new TokenBucket({ capacity: 16, windowMs: 10_000 }),
    );

    worker = new QueueWorker({
      repo,
      process: (item) =>
        processItem(item, {
          clicksign: throttled,
          readPdfBase64: (id) => pdfStore.readBase64(id),
          signUrlFallback: (signerId) => client.signUrl(signerId),
        }),
      removePdf: (id) => pdfStore.remove(id),
    });

    app = createApp({
      repo,
      pdfStore,
      apiKey: API_KEY,
      wakeWorker: () => worker.wake(),
      secrets: [token!],
    });
    worker.start();
  });

  afterAll(() => {
    worker.stop();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('cria lote de 3 itens delivery=link, processa e todos os links resolvem', async () => {
    const pdf = await generateSamplePdfBase64('Teste de Integracao');
    const payload = {
      items: [1, 2, 3].map((n) => ({
        filename: `integracao-${n}.pdf`,
        contentBase64: pdf,
        signer: { name: `Signatario Integracao ${n}`, email: 'ti@healthmaiscuidados.com' },
        delivery: 'link' as const,
      })),
    };

    const created = await app.request('/batches', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(created.status).toBe(201);
    const { batchId } = (await created.json()) as { batchId: string };

    // aguarda o worker esvaziar a fila
    await worker.drain();

    const res = await app.request(`/batches/${batchId}`, {
      headers: { 'x-api-key': API_KEY },
    });
    const body = (await res.json()) as {
      progress: { done: number; failed: number };
      items: Array<{ status: string; signUrl: string | null; errorMessage: string | null }>;
    };

    expect(body.progress.failed).toBe(0);
    expect(body.progress.done).toBe(3);

    // cada link deve resolver para a página de assinatura, não para /404
    for (const item of body.items) {
      expect(item.signUrl).toBeTruthy();
      const page = await fetch(item.signUrl!, { redirect: 'follow' });
      expect(page.url).not.toContain('/404');
      expect(page.status).toBe(200);
    }
  }, 300_000);
});
