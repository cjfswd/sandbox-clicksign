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

const fakeClient = {} as ClicksignClient;

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
