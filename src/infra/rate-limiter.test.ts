import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenBucket } from './rate-limiter.ts';

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('permite até a capacidade imediatamente', async () => {
    const bucket = new TokenBucket({ capacity: 3, windowMs: 10_000 });
    const acquired: number[] = [];

    for (let i = 0; i < 3; i++) {
      await bucket.acquire();
      acquired.push(i);
    }
    expect(acquired).toHaveLength(3);
  });

  it('bloqueia a requisição além da capacidade até a janela deslizar', async () => {
    const bucket = new TokenBucket({ capacity: 2, windowMs: 10_000 });
    await bucket.acquire();
    await bucket.acquire();

    let third = false;
    const promise = bucket.acquire().then(() => {
      third = true;
    });

    // a vaga só abre quando a 1ª aquisição sai da janela (t=10s)
    await vi.advanceTimersByTimeAsync(9_000);
    expect(third).toBe(false);

    await vi.advanceTimersByTimeAsync(1_100);
    await promise;
    expect(third).toBe(true);
  });

  it('nunca excede a taxa capacity/window em rajada contínua', async () => {
    const capacity = 4;
    const windowMs = 10_000;
    const bucket = new TokenBucket({ capacity, windowMs });
    const timestamps: number[] = [];

    const total = 12;
    const run = (async () => {
      for (let i = 0; i < total; i++) {
        await bucket.acquire();
        timestamps.push(Date.now());
      }
    })();

    await vi.advanceTimersByTimeAsync(windowMs * 4);
    await run;

    expect(timestamps).toHaveLength(total);
    for (let start = 0; start < timestamps.length; start++) {
      const windowEnd = timestamps[start]! + windowMs;
      const inWindow = timestamps.filter((t) => t >= timestamps[start]! && t < windowEnd);
      expect(inWindow.length).toBeLessThanOrEqual(capacity);
    }
  });

  it('libera waiters gradualmente conforme aquisições antigas saem da janela', async () => {
    const bucket = new TokenBucket({ capacity: 2, windowMs: 10_000 });
    await bucket.acquire(); // t=0
    await vi.advanceTimersByTimeAsync(3_000);
    await bucket.acquire(); // t=3s

    let resolved = 0;
    const p1 = bucket.acquire().then(() => resolved++);
    const p2 = bucket.acquire().then(() => resolved++);

    // vaga 1 abre em t=10s (aquisição de t=0 sai da janela)
    await vi.advanceTimersByTimeAsync(7_100);
    await p1;
    expect(resolved).toBe(1);

    // vaga 2 abre em t=13s (aquisição de t=3s sai da janela)
    await vi.advanceTimersByTimeAsync(3_100);
    await p2;
    expect(resolved).toBe(2);
  });
});
