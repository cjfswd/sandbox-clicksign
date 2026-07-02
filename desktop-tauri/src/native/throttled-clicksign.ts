/**
 * Executa operações do ClicksignClient sob controle de vazão (token bucket)
 * e re-tenta quando a Clicksign responde 429.
 *
 * A espera em 429 usa o X-Rate-Limit-Reset real da resposta quando
 * disponível (docs: https://developers.clicksign.com/docs/limite-de-requisicoes)
 * — espera exata até o limite resetar, em vez de um backoff "chutado".
 * O backoff exponencial continua como fallback para quando o header não
 * vier (ex.: erro de rede antes de qualquer resposta chegar).
 *
 * Além disso, se a última resposta reportou `remaining` muito baixo, a
 * próxima chamada espera proativamente até o reset — evita gastar uma
 * tentativa que sabemos que vai voltar 429.
 *
 * Contrato de uso: cada `fn` passada a `run` deve executar exatamente UMA
 * requisição HTTP — é isso que mantém a contagem do bucket correta.
 */
import { ClicksignError, type ClicksignClient } from './clicksign.ts';
import type { TokenBucket } from './rate-limiter.ts';

export interface ThrottleOptions {
  /** Delay base do backoff exponencial (fallback sem header). Padrão: 2000ms. */
  baseDelayMs?: number;
  /** Máximo de re-tentativas em 429. Padrão: 5. */
  maxRetries?: number;
  /** Fator de jitter [0,1) — injetável para testes determinísticos. Padrão: Math.random. */
  jitter?: () => number;
  /** `remaining` igual ou abaixo disso dispara espera proativa. Padrão: 1. */
  proactiveThreshold?: number;
}

export class ThrottledClicksign {
  private readonly client: ClicksignClient;
  private readonly bucket: TokenBucket;
  private readonly baseDelayMs: number;
  private readonly maxRetries: number;
  private readonly jitter: () => number;
  private readonly proactiveThreshold: number;

  constructor(client: ClicksignClient, bucket: TokenBucket, options: ThrottleOptions = {}) {
    this.client = client;
    this.bucket = bucket;
    this.baseDelayMs = options.baseDelayMs ?? 2_000;
    this.maxRetries = options.maxRetries ?? 5;
    this.jitter = options.jitter ?? Math.random;
    this.proactiveThreshold = options.proactiveThreshold ?? 1;
  }

  async run<T>(fn: (client: ClicksignClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.bucket.acquire();
      await this.waitIfServerReportedLowRemaining();
      try {
        return await fn(this.client);
      } catch (error) {
        if (!isRateLimit(error) || attempt >= this.maxRetries) throw error;
        await sleep(this.delayFor(error, attempt));
      }
    }
  }

  /** Se a última resposta real da Clicksign avisou remaining baixo, espera o reset antes de tentar. */
  private async waitIfServerReportedLowRemaining(): Promise<void> {
    const info = this.client.getLastRateLimitInfo();
    if (!info || info.remaining === null || info.resetAtMs === null) return;
    if (info.remaining > this.proactiveThreshold) return;

    const wait = info.resetAtMs - Date.now();
    if (wait > 0) await sleep(wait + this.jitterMs());
  }

  private delayFor(error: ClicksignError, attempt: number): number {
    if (error.rateLimitResetAtMs !== null) {
      const untilReset = error.rateLimitResetAtMs - Date.now();
      if (untilReset > 0) return untilReset + this.jitterMs();
    }
    // Fallback: header ausente — backoff exponencial "no escuro".
    return this.baseDelayMs * 2 ** attempt * (1 + this.jitter());
  }

  private jitterMs(): number {
    return 250 + this.jitter() * 250; // 250-500ms de folga sobre o reset exato
  }
}

/** true só para 429 da Clicksign — outros erros (4xx/5xx/rede) sobem direto, sem retry. */
function isRateLimit(error: unknown): error is ClicksignError {
  return error instanceof ClicksignError && error.status === 429;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
