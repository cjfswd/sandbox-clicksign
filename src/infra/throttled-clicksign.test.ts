import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClicksignError, type ClicksignClient } from './clicksign.ts';
import { ThrottledClicksign } from './throttled-clicksign.ts';
import type { TokenBucket } from './rate-limiter.ts';

function instantBucket(): { bucket: TokenBucket; acquires: () => number } {
  let count = 0;
  const bucket = {
    acquire: async () => {
      count++;
    },
  } as unknown as TokenBucket;
  return { bucket, acquires: () => count };
}

function buildFakeClient(rateLimitInfo: ReturnType<ClicksignClient['getLastRateLimitInfo']> = null) {
  return { getLastRateLimitInfo: () => rateLimitInfo } as unknown as ClicksignClient;
}

const fakeClient = buildFakeClient();

describe('ThrottledClicksign', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('consome um token do bucket por chamada', async () => {
    const { bucket, acquires } = instantBucket();
    const throttled = new ThrottledClicksign(fakeClient, bucket, { jitter: () => 0 });

    await throttled.run(async () => 'ok');
    await throttled.run(async () => 'ok');
    expect(acquires()).toBe(2);
  });

  it('retorna o resultado da operação em caso de sucesso', async () => {
    const { bucket } = instantBucket();
    const throttled = new ThrottledClicksign(fakeClient, bucket, { jitter: () => 0 });
    const result = await throttled.run(async () => ({ id: 'env-1' }));
    expect(result).toEqual({ id: 'env-1' });
  });

  it('em 429 aguarda com backoff exponencial e re-tenta até suceder (critério 8)', async () => {
    const { bucket, acquires } = instantBucket();
    const throttled = new ThrottledClicksign(fakeClient, bucket, {
      baseDelayMs: 1_000,
      jitter: () => 0,
    });

    let attempts = 0;
    const promise = throttled.run(async () => {
      attempts++;
      if (attempts <= 2) throw new ClicksignError(429, '', 'rate limited');
      return 'sucesso';
    });

    // 1ª tentativa imediata; retry 1 após 1s; retry 2 após 2s
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(promise).resolves.toBe('sucesso');
    expect(attempts).toBe(3);
    expect(acquires()).toBe(3); // cada tentativa consome token
  });

  it('desiste após maxRetries em 429 persistente', async () => {
    const { bucket } = instantBucket();
    const throttled = new ThrottledClicksign(fakeClient, bucket, {
      baseDelayMs: 10,
      maxRetries: 2,
      jitter: () => 0,
    });

    const promise = throttled
      .run(async () => {
        throw new ClicksignError(429, '', 'rate limited');
      })
      .catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(60_000);
    const error = await promise;
    expect(error).toBeInstanceOf(ClicksignError);
    expect((error as ClicksignError).status).toBe(429);
  });

  it('em 429 com X-Rate-Limit-Reset espera exatamente até o reset, não o backoff exponencial', async () => {
    const { bucket } = instantBucket();
    const throttled = new ThrottledClicksign(fakeClient, bucket, {
      baseDelayMs: 60_000, // se caísse no fallback exponencial, esperaria bem mais que isso
      jitter: () => 0,
    });

    const resetAtMs = Date.now() + 3_000;
    let attempts = 0;
    const promise = throttled.run(async () => {
      attempts++;
      if (attempts === 1) throw new ClicksignError(429, '', 'rate limited', resetAtMs);
      return 'sucesso';
    });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(attempts).toBe(1); // ainda não chegou o reset

    await vi.advanceTimersByTimeAsync(500); // reset + folga de jitter
    await expect(promise).resolves.toBe('sucesso');
    expect(attempts).toBe(2);
  });

  it('espera proativamente quando a última resposta reportou remaining baixo', async () => {
    const { bucket, acquires } = instantBucket();
    const resetAtMs = Date.now() + 2_000;
    const client = buildFakeClient({ limit: 20, remaining: 0, resetAtMs });
    const throttled = new ThrottledClicksign(client, bucket, { jitter: () => 0 });

    let called = false;
    const promise = throttled.run(async () => {
      called = true;
      return 'ok';
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(called).toBe(false); // esperando proativamente, nem tentou ainda

    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBe('ok');
    expect(called).toBe(true);
    expect(acquires()).toBe(1); // bucket local ainda é respeitado independente do proativo
  });

  it('não espera proativamente quando remaining está confortável', async () => {
    const { bucket } = instantBucket();
    const client = buildFakeClient({ limit: 20, remaining: 15, resetAtMs: Date.now() + 5_000 });
    const throttled = new ThrottledClicksign(client, bucket, { jitter: () => 0 });

    const result = await throttled.run(async () => 'imediato');
    expect(result).toBe('imediato');
  });

  it('erro 4xx definitivo propaga imediatamente sem retry', async () => {
    const { bucket, acquires } = instantBucket();
    const throttled = new ThrottledClicksign(fakeClient, bucket, { jitter: () => 0 });

    let attempts = 0;
    await expect(
      throttled.run(async () => {
        attempts++;
        throw new ClicksignError(422, '{"errors":[]}', 'validação');
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(attempts).toBe(1);
    expect(acquires()).toBe(1);
  });
});
