import { describe, expect, it, vi } from 'vitest';
import { processItem } from './process-item.ts';
import { ThrottledClicksign } from '../infra/throttled-clicksign.ts';
import type { ClicksignClient } from '../infra/clicksign.ts';
import type { TokenBucket } from '../infra/rate-limiter.ts';
import type { ProcessingItem } from '../domain/batch.ts';

const SIGN_URL = 'https://sandbox.clicksign.com/notarial/widget/signatures/sig-1/redirect';

function buildMockClient(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const client = {
    createEnvelope: vi.fn(async () => {
      calls.push('createEnvelope');
      return { id: 'env-1', type: 'envelopes', attributes: {} };
    }),
    addDocument: vi.fn(async () => {
      calls.push('addDocument');
      return { id: 'doc-1', type: 'documents', attributes: {} };
    }),
    addSigner: vi.fn(async (_envelopeId: string, _signer: Record<string, unknown>) => {
      calls.push('addSigner');
      return { id: 'sig-1', type: 'signers', attributes: {} };
    }),
    addQualificationRequirement: vi.fn(async () => {
      calls.push('addQualificationRequirement');
      return { id: 'req-1', type: 'requirements', attributes: {} };
    }),
    addAuthenticationRequirement: vi.fn(async () => {
      calls.push('addAuthenticationRequirement');
      return { id: 'req-2', type: 'requirements', attributes: {} };
    }),
    activateEnvelope: vi.fn(async () => {
      calls.push('activateEnvelope');
      return { id: 'env-1', type: 'envelopes', attributes: { status: 'running' } };
    }),
    getEnvelopeEvents: vi.fn(async () => {
      calls.push('getEnvelopeEvents');
      return [
        {
          id: 'evt-1',
          type: 'events',
          attributes: {
            name: 'add_signer',
            data: { signers: [{ key: 'sig-1', url: SIGN_URL }] },
            created: '2026-07-01T00:00:00Z',
          },
        },
      ];
    }),
    notifySigner: vi.fn(async () => {
      calls.push('notifySigner');
      return { id: 'not-1', type: 'notifications', attributes: {} };
    }),
    ...overrides,
  };
  return { client: client as unknown as ClicksignClient, calls, mocks: client };
}

function throttledFor(client: ClicksignClient): ThrottledClicksign {
  const bucket = { acquire: async () => {} } as unknown as TokenBucket;
  return new ThrottledClicksign(client, bucket, { jitter: () => 0 });
}

function item(overrides: Partial<ProcessingItem> = {}): ProcessingItem {
  return {
    status: 'processing',
    id: 'item-1',
    batchId: 'batch-1',
    filename: 'contrato.pdf',
    signer: { name: 'Fulano da Silva', email: 'fulano@exemplo.com' },
    delivery: 'link',
    retryCount: 0,
    ...overrides,
  };
}

function deps(client: ClicksignClient) {
  return {
    clicksign: throttledFor(client),
    readPdfBase64: () => 'JVBERi0xLjQ=',
    signUrlFallback: (signerId: string) => `https://fallback/${signerId}`,
  };
}

describe('processItem', () => {
  it('executa os passos na ordem correta e retorna o link (delivery=link)', async () => {
    const { client, calls, mocks } = buildMockClient();
    const result = await processItem(item(), deps(client));

    expect(calls).toEqual([
      'createEnvelope',
      'addDocument',
      'addSigner',
      'addQualificationRequirement',
      'addAuthenticationRequirement',
      'activateEnvelope',
      'getEnvelopeEvents',
    ]);
    expect(result).toEqual({ envelopeId: 'env-1', signerId: 'sig-1', signUrl: SIGN_URL });
    expect(mocks.notifySigner).not.toHaveBeenCalled();

    // link: Clicksign não notifica ninguém, mas document_signed exige email/whatsapp
    const signerArgs = mocks.addSigner.mock.calls[0]!;
    expect(signerArgs[1]).toMatchObject({
      communicateEvents: expect.objectContaining({
        signature_request: 'none',
        document_signed: 'email',
      }),
    });
  });

  it('delivery=link com apenas telefone usa whatsapp para document_signed', async () => {
    const { client, mocks } = buildMockClient();
    await processItem(
      item({ delivery: 'link', signer: { name: 'Fulano da Silva', phoneNumber: '11999998888' } }),
      deps(client),
    );

    expect(mocks.addSigner.mock.calls[0]![1]).toMatchObject({
      communicateEvents: expect.objectContaining({ document_signed: 'whatsapp' }),
    });
  });

  it('delivery=link sem email nem telefone lança erro (Clicksign exige contato para document_signed)', async () => {
    const { client } = buildMockClient();
    await expect(
      processItem(
        item({ delivery: 'link', signer: { name: 'Fulano da Silva' } }),
        deps(client),
      ),
    ).rejects.toThrow(/e-mail e sem telefone/);
  });

  it('delivery=email configura canal e dispara notificação', async () => {
    const { client, mocks } = buildMockClient();
    await processItem(item({ delivery: 'email' }), deps(client));

    expect(mocks.addSigner.mock.calls[0]![1]).toMatchObject({
      email: 'fulano@exemplo.com',
      communicateEvents: expect.objectContaining({ signature_request: 'email' }),
    });
    expect(mocks.addAuthenticationRequirement).toHaveBeenCalledWith(
      'env-1',
      'doc-1',
      'sig-1',
      'email',
    );
    expect(mocks.notifySigner).toHaveBeenCalledWith('env-1', 'sig-1');
  });

  it('delivery=whatsapp usa telefone, auth whatsapp e notifica', async () => {
    const { client, mocks } = buildMockClient();
    await processItem(
      item({
        delivery: 'whatsapp',
        signer: { name: 'Fulano da Silva', phoneNumber: '11999998888' },
      }),
      deps(client),
    );

    expect(mocks.addSigner.mock.calls[0]![1]).toMatchObject({
      phoneNumber: '11999998888',
      communicateEvents: expect.objectContaining({ signature_request: 'whatsapp' }),
    });
    expect(mocks.addAuthenticationRequirement).toHaveBeenCalledWith(
      'env-1',
      'doc-1',
      'sig-1',
      'whatsapp',
    );
    expect(mocks.notifySigner).toHaveBeenCalled();
  });

  it('usa o fallback quando o evento add_signer não traz url', async () => {
    const { client } = buildMockClient({
      getEnvelopeEvents: vi.fn(async () => [
        {
          id: 'evt-1',
          type: 'events',
          attributes: { name: 'add_signer', data: { signers: [{ key: 'sig-1' }] }, created: '' },
        },
      ]),
    });
    const result = await processItem(item(), deps(client));
    expect(result.signUrl).toBe('https://fallback/sig-1');
  });

  it('propaga erro de qualquer passo sem engolir', async () => {
    const { client } = buildMockClient({
      addDocument: vi.fn(async () => {
        throw new Error('upload falhou');
      }),
    });
    await expect(processItem(item(), deps(client))).rejects.toThrow('upload falhou');
  });
});
