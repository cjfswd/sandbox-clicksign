/**
 * Worker sequencial da fila: claim → processa → grava resultado.
 * Um item com erro vira 'failed' e o loop continua (critério 7).
 * No boot, itens presos em 'processing' voltam para a fila (critério 9).
 *
 * Porta de src/app/worker.ts — mesma lógica. Diferença real: `start()`
 * agora é assíncrono porque `reclaimStale()` do novo repositório (plugin-sql)
 * é IPC, não síncrono como node:sqlite.
 */
import type { ClicksignResult, ProcessingItem } from './batch.ts';
import { complete, fail } from './batch.ts';
import type { BatchRepository } from './repository.ts';

export interface WorkerDeps {
  repo: BatchRepository;
  process: (item: ProcessingItem) => Promise<ClicksignResult>;
  removePdf: (itemId: string) => void | Promise<void>;
}

export class QueueWorker {
  private readonly deps: WorkerDeps;
  /** false antes de start() ou depois de stop() — wake() vira no-op nesse estado. */
  private running = false;
  /** Promise do ciclo de drenagem em andamento; null quando a fila está ociosa. */
  private draining: Promise<void> | null = null;

  constructor(deps: WorkerDeps) {
    this.deps = deps;
  }

  /** Boot: retoma itens órfãos de execução anterior e liga o worker. */
  async start(): Promise<void> {
    const reclaimed = await this.deps.repo.reclaimStale();
    if (reclaimed > 0) {
      console.warn(`Retomando ${reclaimed} item(ns) preso(s) em processing de execução anterior`);
    }
    this.running = true;
    this.wake();
  }

  /** Desliga o worker; um drain em andamento termina o item atual mas não reclama mais nenhum. */
  stop(): void {
    this.running = false;
  }

  /** Sinaliza que entrou trabalho novo (chamado depois de criar um lote / retry). */
  wake(): void {
    if (!this.running) return;
    void this.drain();
  }

  /** Processa até esvaziar a fila. Reentrante: chamadas concorrentes aguardam o mesmo ciclo. */
  drain(): Promise<void> {
    this.draining ??= this.processUntilEmpty().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** Loop real: reivindica um item por vez até a fila esvaziar; erro de um item não para os seguintes. */
  private async processUntilEmpty(): Promise<void> {
    for (;;) {
      const item = await this.deps.repo.claimNextPending();
      if (!item) return;

      try {
        const result = await this.deps.process(item);
        await this.deps.repo.saveItemResult(complete(item, result));
        await this.deps.removePdf(item.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.deps.repo.saveItemResult(fail(item, message));
        console.error(`Item ${item.id} (${item.filename}) falhou: ${message}`);
      }
    }
  }
}
