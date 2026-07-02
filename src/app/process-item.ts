/**
 * Pipeline de processamento de UM item do lote (critérios 2 e 10 da spec):
 * envelope → documento → signatário → requisitos → ativação → link → notificação.
 */
import type { ClicksignResult, Delivery, ProcessingItem } from '../domain/batch.ts';
import type { ThrottledClicksign } from '../infra/throttled-clicksign.ts';

export interface ProcessItemDeps {
  clicksign: ThrottledClicksign;
  /** Lê o PDF do item (base64) do armazenamento local. */
  readPdfBase64: (itemId: string) => string;
  /** Monta o link caso o evento add_signer não traga a URL (decisão 5 do plan). */
  signUrlFallback: (signerId: string) => string;
}

interface CommunicateEvents {
  signature_request: string;
  signature_reminder: string;
  document_signed: string;
}

function communicateEventsFor(
  delivery: Delivery,
  hasEmail: boolean,
  hasPhone: boolean,
): CommunicateEvents {
  // A Clicksign exige document_signed em 'email' ou 'whatsapp' — nunca 'none'.
  // Preferir e-mail quando disponível; cair para whatsapp só se não houver e-mail.
  const confirmationChannel = hasEmail ? 'email' : 'whatsapp';

  switch (delivery) {
    case 'email':
      return { signature_request: 'email', signature_reminder: 'email', document_signed: 'email' };
    case 'whatsapp':
      return {
        signature_request: 'whatsapp',
        signature_reminder: 'none',
        document_signed: 'whatsapp',
      };
    case 'link':
      // Envio manual: a Clicksign não notifica a solicitação de assinatura.
      if (!hasEmail && !hasPhone) {
        throw new Error(
          'Signatário sem e-mail e sem telefone: a Clicksign exige ao menos um contato ' +
            'para a notificação de "documento assinado" (document_signed).',
        );
      }
      return {
        signature_request: 'none',
        signature_reminder: 'none',
        document_signed: confirmationChannel,
      };
  }
}

export async function processItem(
  item: ProcessingItem,
  deps: ProcessItemDeps,
): Promise<ClicksignResult> {
  const { clicksign } = deps;

  const envelope = await clicksign.run((c) => c.createEnvelope(item.filename));

  const pdfBase64 = deps.readPdfBase64(item.id);
  const document = await clicksign.run((c) => c.addDocument(envelope.id, item.filename, pdfBase64));

  const signer = await clicksign.run((c) =>
    c.addSigner(envelope.id, {
      name: item.signer.name,
      email: item.signer.email,
      phoneNumber: item.signer.phoneNumber,
      communicateEvents: communicateEventsFor(
        item.delivery,
        item.signer.email !== undefined,
        item.signer.phoneNumber !== undefined,
      ),
    }),
  );

  await clicksign.run((c) => c.addQualificationRequirement(envelope.id, document.id, signer.id));

  const auth = item.delivery === 'whatsapp' ? 'whatsapp' : 'email';
  await clicksign.run((c) =>
    c.addAuthenticationRequirement(envelope.id, document.id, signer.id, auth),
  );

  await clicksign.run((c) => c.activateEnvelope(envelope.id));

  const signUrl = await resolveSignUrl(envelope.id, signer.id, deps);

  if (item.delivery !== 'link') {
    await clicksign.run((c) => c.notifySigner(envelope.id, signer.id));
  }

  return { envelopeId: envelope.id, signerId: signer.id, signUrl };
}

async function resolveSignUrl(
  envelopeId: string,
  signerId: string,
  deps: ProcessItemDeps,
): Promise<string> {
  const events = await deps.clicksign.run((c) => c.getEnvelopeEvents(envelopeId));
  const addSignerEvent = events.find((e) => e.attributes.name === 'add_signer');
  const url = addSignerEvent?.attributes.data.signers?.find((s) => s.key === signerId)?.url;
  if (url) return url;

  console.warn(
    `Evento add_signer sem url para signer ${signerId}; usando formato conhecido como fallback`,
  );
  return deps.signUrlFallback(signerId);
}
