import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClicksignClient, ClicksignError } from './clicksign.ts';

function mockFetchOnce(status: number, headers: Record<string, string>, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers })),
  );
}

describe('ClicksignClient — rate limit headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new ClicksignClient({ baseUrl: 'https://sandbox.clicksign.com', accessToken: 'token' });

  it('expõe X-Rate-Limit-* de uma resposta de sucesso via getLastRateLimitInfo', async () => {
    mockFetchOnce(
      200,
      { 'x-rate-limit': '20', 'x-rate-limit-remaining': '17', 'x-rate-limit-reset': '1709210040' },
      { data: [] },
    );

    await client.getEnvelope('env-1');

    expect(client.getLastRateLimitInfo()).toEqual({
      limit: 20,
      remaining: 17,
      resetAtMs: 1_709_210_040_000,
    });
  });

  it('anexa o reset (convertido para ms) ao ClicksignError quando status é 429', async () => {
    mockFetchOnce(
      429,
      { 'x-rate-limit': '20', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': '1709226020' },
      { errors: [{ title: 'rate limited' }] },
    );

    await expect(client.getEnvelope('env-1')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ClicksignError);
      expect((error as ClicksignError).rateLimitResetAtMs).toBe(1_709_226_020_000);
      return true;
    });
  });

  it('não popula rateLimitResetAtMs em erros que não são 429', async () => {
    mockFetchOnce(422, {}, { errors: [{ title: 'validação' }] });

    await expect(client.getEnvelope('env-1')).rejects.toSatisfy((error: unknown) => {
      expect((error as ClicksignError).rateLimitResetAtMs).toBeNull();
      return true;
    });
  });

  it('getLastRateLimitInfo retorna null antes de qualquer requisição', () => {
    const fresh = new ClicksignClient({ baseUrl: 'https://sandbox.clicksign.com', accessToken: 'token' });
    expect(fresh.getLastRateLimitInfo()).toBeNull();
  });

  it('tolera resposta sem os headers de rate limit (campos ficam null)', async () => {
    mockFetchOnce(200, {}, { data: [] });
    await client.getEnvelope('env-1');
    expect(client.getLastRateLimitInfo()).toEqual({ limit: null, remaining: null, resetAtMs: null });
  });
});
