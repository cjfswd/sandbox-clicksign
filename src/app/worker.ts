/**
 * Worker sequencial da fila: claim → processa → grava resultado.
 * Um item com erro vira 'failed' e o loop continua (critério 7).
 * No boot, itens presos em 'processing' voltam para a fila (critério 9).
 */
import type { ClicksignResult, ProcessingItem } from '../domain/batch.ts';
import { complete, fail } from '../domain/batch.ts';
import type { BatchRepository } from '../infra/repository.ts';

export interface WorkerDeps {
  repo: BatchRepository;
  process: (item: ProcessingItem) => Promise<ClicksignResult>;
  removePdf: (itemId: string) => void;
}

export class QueueWorker {
  private readonly deps: WorkerDeps;
  private running = false;
  private draining: Promise<void> | null = null;

  constructor(deps: WorkerDeps) {
    this.deps = deps;
  }

  /** Boot: retoma itens órfãos de execução anterior e liga o worker. */
  start(): void {
    const reclaimed = this.deps.repo.reclaimStale();
    if (reclaimed > 0) {
      console.warn(`Retomando ${reclaimed} item(ns) preso(s) em processing de execução anterior`);
    }
    this.running = true;
    this.wake();
  }

  stop(): void {
    this.running = false;
  }

  /** Sinaliza que entrou trabalho novo (chamado pelos handlers HTTP). */
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

  private async processUntilEmpty(): Promise<void> {
    for (;;) {
      const item = this.deps.repo.claimNextPending();
      if (!item) return;

      try {
        const result = await this.deps.process(item);
        this.deps.repo.saveItemResult(complete(item, result));
        this.deps.removePdf(item.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.repo.saveItemResult(fail(item, message));
        console.error(`Item ${item.id} (${item.filename}) falhou: ${message}`);
      }
    }
  }
}
