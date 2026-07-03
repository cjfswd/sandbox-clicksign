/**
 * Ciclo de vida de uma "sessão" de ambiente (sandbox ou produção): repo +
 * pdfStore + cliente Clicksign + worker, tudo isolado por ambiente. É o
 * substituto direto do antigo `start_sidecar` — mesma responsabilidade
 * (subir tudo o que precisa pra processar lotes), só que em processo em
 * vez de spawnar um sidecar Node separado.
 */
import { BatchRepository, type BatchItemInput } from './repository.ts';
import type { Batch, ClicksignStatus } from './batch.ts';
import type { HistoryFilter } from './history-query.ts';
import { mapEnvelopeStatus } from './clicksign-status.ts';
import { PdfStore } from './pdf-store.ts';
import { ClicksignClient, ClicksignError } from './clicksign.ts';
import { ThrottledClicksign } from './throttled-clicksign.ts';
import { TokenBucket } from './rate-limiter.ts';
import { QueueWorker } from './worker.ts';
import { processItem } from './process-item.ts';

export type Environment = 'sandbox' | 'producao';
export type ConnectionStatus = 'ok' | 'chave-invalida' | 'inacessivel';

export interface BatchSession {
  /** Cria o lote e só então salva os PDFs e acorda o worker (evita o worker
   *  tentar ler um PDF que ainda não foi escrito). `pdfBase64ByIndex` deve
   *  ter o mesmo tamanho/ordem de `items`. */
  createBatch(items: BatchItemInput[], pdfBase64ByIndex: string[]): Promise<Batch>;
  getBatch(batchId: string): Promise<Batch | null>;
  retryItem(batchId: string, itemId: string): Promise<void>;
  /** Histórico de lotes já enviados, filtrado e paginado (ver history-query.ts). */
  listHistory(filter: HistoryFilter, limit: number, offset: number): Promise<Batch[]>;
  /** Consulta a Clicksign pro status real de assinatura de um item já `done` e persiste o resultado. */
  refreshItemStatus(batchId: string, itemId: string): Promise<ClicksignStatus>;
  testConnection(): Promise<ConnectionStatus>;
  /** Encerra o worker e fecha a conexão com o banco deste ambiente. */
  stop(): Promise<void>;
}

/** Host da API por ambiente — nunca mesclar: sandbox e produção são contas/dados totalmente separados na Clicksign. */
const CLICKSIGN_BASE_URLS: Record<Environment, string> = {
  sandbox: 'https://sandbox.clicksign.com',
  producao: 'https://app.clicksign.com',
};

/** Monta repo + pdfStore + cliente + worker do ambiente escolhido e já liga o worker (retomando itens presos). */
export async function startSession(env: Environment, clicksignToken: string): Promise<BatchSession> {
  const baseUrl = CLICKSIGN_BASE_URLS[env];
  const repo = await BatchRepository.load(`${env}/batches.db`);
  const pdfStore = await PdfStore.load(env);
  const client = new ClicksignClient({ baseUrl, accessToken: clicksignToken });

  // Mesma margem de 20% sobre o limite oficial da Clicksign usada no backend Node.
  const bucket = new TokenBucket({ capacity: env === 'sandbox' ? 16 : 40, windowMs: 10_000 });
  const throttled = new ThrottledClicksign(client, bucket);

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

  await worker.start();

  return {
    async createBatch(items, pdfBase64ByIndex) {
      const batch = await repo.createBatch(items);
      await Promise.all(
        batch.items.map((item, index) => pdfStore.save(item.id, pdfBase64ByIndex[index]!)),
      );
      worker.wake();
      return batch;
    },

    getBatch(batchId) {
      return repo.getBatch(batchId);
    },

    async retryItem(batchId, itemId) {
      await repo.resetItemForRetry(batchId, itemId);
      worker.wake();
    },

    listHistory(filter, limit, offset) {
      return repo.listBatches(filter, limit, offset);
    },

    async refreshItemStatus(batchId, itemId) {
      const batch = await repo.getBatch(batchId);
      const item = batch?.items.find((i) => i.id === itemId);
      if (!item) throw new Error(`Item ${itemId} não encontrado no lote ${batchId}`);
      if (item.status !== 'done') {
        throw new Error('Item sem envelope criado — nada para checar na Clicksign ainda.');
      }

      let envelopeStatus: Awaited<ReturnType<typeof client.getEnvelope>>['attributes']['status'] | null;
      try {
        const envelope = await throttled.run((c) => c.getEnvelope(item.envelopeId));
        envelopeStatus = envelope.attributes.status;
      } catch (error) {
        if (error instanceof ClicksignError && error.status === 404) {
          envelopeStatus = null;
        } else {
          throw error;
        }
      }

      const clicksignStatus = mapEnvelopeStatus(envelopeStatus);
      await repo.updateClicksignStatus(itemId, clicksignStatus);
      return clicksignStatus;
    },

    async testConnection() {
      try {
        // Passa por throttled (não client direto) — compartilha o bucket
        // com o worker e re-tenta sozinho em 429 (achado real: sem isso,
        // um 429 durante um lote grande em andamento vira "inacessível" por
        // engano, mesmo com o token e a rede perfeitamente ok).
        await throttled.run((c) => c.getEnvelope('00000000-0000-0000-0000-000000000000'));
        return 'ok';
      } catch (error) {
        if (error instanceof ClicksignError) {
          if (error.status === 404) return 'ok'; // autenticou; só o envelope não existe
          if (error.status === 401) return 'chave-invalida';
        }
        return 'inacessivel';
      }
    },

    async stop() {
      worker.stop();
      await repo.close();
    },
  };
}
