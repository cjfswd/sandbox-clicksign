import { describe, expect, it } from 'vitest';
import { mapEnvelopeStatus } from './clicksign-status.ts';

describe('mapEnvelopeStatus', () => {
  it('mapeia closed (todos assinaram) para signed', () => {
    expect(mapEnvelopeStatus('closed')).toBe('signed');
  });

  it('mapeia canceled para canceled', () => {
    expect(mapEnvelopeStatus('canceled')).toBe('canceled');
  });

  it('mapeia running (ainda faltam assinaturas) para pending', () => {
    expect(mapEnvelopeStatus('running')).toBe('pending');
  });

  it('mapeia draft para pending (não deveria acontecer, mas não é erro)', () => {
    expect(mapEnvelopeStatus('draft')).toBe('pending');
  });

  it('mapeia null (GET voltou 404 — envelope não existe mais) para canceled', () => {
    expect(mapEnvelopeStatus(null)).toBe('canceled');
  });
});
