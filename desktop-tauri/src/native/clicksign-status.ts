/**
 * Mapeamento do status do envelope na Clicksign para o ClicksignStatus que
 * o app guarda e mostra no histórico (ver batch.ts). Um GET de envelope que
 * volta 404 significa que o envelope foi cancelado/deletado na Clicksign —
 * chame esta função com `null` nesse caso.
 */
import type { ClicksignStatus } from './batch.ts';
import type { EnvelopeAttributes } from './clicksign.ts';

export function mapEnvelopeStatus(envelopeStatus: EnvelopeAttributes['status'] | null): ClicksignStatus {
  if (envelopeStatus === null) return 'canceled';
  switch (envelopeStatus) {
    case 'closed':
      return 'signed';
    case 'canceled':
      return 'canceled';
    case 'running':
    case 'draft':
      return 'pending';
  }
}
