/**
 * Executa operações do ClicksignClient sob controle de vazão (token bucket)
 * e re-tenta com backoff exponencial + jitter quando a Clicksign responde 429.
 *
 * Contrato de uso: cada `fn` passada a `run` deve executar exatamente UMA
 * requisição HTTP — é isso que mantém a contagem do bucket correta.
 */
import { ClicksignError, type ClicksignClient } from './clicksign.ts';
import type { TokenBucket } from './rate-limiter.ts';

export interface ThrottleOptions {
  /** Delay base do backoff (dobra a cada tentativa). Padrão: 2000ms. */
  baseDelayMs?: number;
  /** Máximo de re-tentativas em 429. Padrão: 5. */
  maxRetries?: number;
  /** Fator de jitter [0,1) — injetável para testes determinísticos. Padrão: Math.random. */
  jitter?: () => number;
}

export class ThrottledClicksign {
  private readonly client: ClicksignClient;
  private readonly bucket: TokenBucket;
  private readonly baseDelayMs: number;
  private readonly maxRetries: number;
  private readonly jitter: () => number;

  constructor(client: ClicksignClient, bucket: TokenBucket, options: ThrottleOptions = {}) {
    this.client = client;
    this.bucket = bucket;
    this.baseDelayMs = options.baseDelayMs ?? 2_000;
    this.maxRetries = options.maxRetries ?? 5;
    this.jitter = options.jitter ?? Math.random;
  }

  async run<T>(fn: (client: ClicksignClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.bucket.acquire();
      try {
        return await fn(this.client);
      } catch (error) {
        if (!isRateLimit(error) || attempt >= this.maxRetries) throw error;
        const delay = this.baseDelayMs * 2 ** attempt * (1 + this.jitter());
        await sleep(delay);
      }
    }
  }
}

function isRateLimit(error: unknown): boolean {
  return error instanceof ClicksignError && error.status === 429;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
