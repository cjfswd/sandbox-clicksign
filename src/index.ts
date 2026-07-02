/**
 * Bootstrap da batch API: env → SQLite → worker → servidor HTTP.
 */
import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { clientFromEnv } from './infra/clicksign.ts';
import { BatchRepository } from './infra/repository.ts';
import { PdfStore } from './infra/pdf-store.ts';
import { TokenBucket } from './infra/rate-limiter.ts';
import { ThrottledClicksign } from './infra/throttled-clicksign.ts';
import { QueueWorker } from './app/worker.ts';
import { processItem } from './app/process-item.ts';
import { createApp } from './http/server.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

const apiKey = requireEnv('API_KEY');
const baseUrl = requireEnv('CLICKSIGN_BASE_URL');
const accessToken = requireEnv('CLICKSIGN_ACCESS_TOKEN');
const dataDir = process.env.DATA_DIR ?? './data';
const port = Number(process.env.PORT ?? 3000);

mkdirSync(dataDir, { recursive: true });

// Rate limit da Clicksign com margem de 20% (plan, decisão 4).
const isSandbox = baseUrl.includes('sandbox');
const bucket = new TokenBucket({ capacity: isSandbox ? 16 : 40, windowMs: 10_000 });

const client = clientFromEnv();
const throttled = new ThrottledClicksign(client, bucket);
const repo = new BatchRepository(process.env.DATABASE_PATH ?? join(dataDir, 'batches.db'));
const pdfStore = new PdfStore(join(dataDir, 'pdfs'));

const worker = new QueueWorker({
  repo,
  process: (item) =>
    processItem(item, {
      clicksign: throttled,
      readPdfBase64: (itemId) => pdfStore.readBase64(itemId),
      signUrlFallback: (signerId) => client.signUrl(signerId),
    }),
  removePdf: (itemId) => pdfStore.remove(itemId),
});

const app = createApp({
  repo,
  pdfStore,
  apiKey,
  wakeWorker: () => worker.wake(),
  secrets: [accessToken],
});

worker.start();

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Batch API ouvindo em http://localhost:${info.port} (${isSandbox ? 'SANDBOX' : 'PRODUÇÃO'})`);
});

function shutdown(): void {
  console.log('Encerrando: parando worker e fechando servidor...');
  worker.stop();
  server.close();
  repo.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
