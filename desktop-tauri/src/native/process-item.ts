/**
 * Pipeline de processamento de UM item do lote (critérios 2 e 10 da spec):
 * envelope → documento → signatário → requisitos → ativação → link → notificação.
 *
 * Porta de src/app/process-item.ts — lógica pura, idêntica; só os imports
 * mudam de ../domain/../infra para o mesmo diretório native/.
 */
import type { ClicksignResult, Delivery, ProcessingItem } from './batch.ts';
import type { ThrottledClicksign } from './throttled-clicksign.ts';

export interface ProcessItemDeps {
  clicksign: ThrottledClicksign;
  /** Lê o PDF do item (base64) do armazenamento local. */
  readPdfBase64: (itemId: string) => string | Promise<string>;
  /** Monta o link caso o evento add_signer não traga a URL (decisão 5 do plan). */
  signUrlFallback: (signerId: string) => string;
}

interface CommunicateEvents {
  signature_request: string;
  signature_reminder: string;
  document_signed: string;
}

/**
 * Canal usado tanto para communicate_events quanto para o requisito de
 * autenticação — ambos exigem 'email' ou 'whatsapp', nunca 'none', e o
 * requisito de autenticação falha com 422 se o canal escolhido não tiver
 * o dado correspondente no signatário.
 *
 * Para delivery='email'/'whatsapp' o canal é a própria escolha do usuário
 * (a validação já garante o contato correspondente). Só em delivery='link'
 * — onde não há canal explícito — escolhemos pelo contato disponível,
 * preferindo e-mail.
 */
function contactChannelFor(
  delivery: Delivery,
  hasEmail: boolean,
  hasPhone: boolean,
): 'email' | 'whatsapp' {
  if (delivery === 'whatsapp') return 'whatsapp';
  if (delivery === 'email') return 'email';
  if (hasEmail) return 'email';
  if (hasPhone) return 'whatsapp';
  throw new Error(
    'Signatário sem e-mail e sem telefone: a Clicksign exige ao menos um contato ' +
      'para autenticação e para a notificação de "documento assinado".',
  );
}

function communicateEventsFor(delivery: Delivery, contactChannel: 'email' | 'whatsapp'): CommunicateEvents {
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
    case 'handwritten':
      // Envio manual: a Clicksign não notifica a solicitação de assinatura.
      return {
        signature_request: 'none',
        signature_reminder: 'none',
        document_signed: contactChannel,
      };
  }
}

/** Auth do requisito de autenticação: 'handwritten' dispensa token — a
 *  própria assinatura desenhada na tela é a prova. Os demais usam o canal
 *  de contato (token por e-mail ou WhatsApp). */
function authMethodFor(delivery: Delivery, contactChannel: 'email' | 'whatsapp'): 'email' | 'whatsapp' | 'handwritten' {
  return delivery === 'handwritten' ? 'handwritten' : contactChannel;
}

export async function processItem(
  item: ProcessingItem,
  deps: ProcessItemDeps,
): Promise<ClicksignResult> {
  const { clicksign } = deps;

  const envelope = await clicksign.run((c) => c.createEnvelope(item.filename));

  const pdfBase64 = await deps.readPdfBase64(item.id);
  const document = await clicksign.run((c) => c.addDocument(envelope.id, item.filename, pdfBase64));

  const contactChannel = contactChannelFor(
    item.delivery,
    item.signer.email !== undefined,
    item.signer.phoneNumber !== undefined,
  );

  const signer = await clicksign.run((c) =>
    c.addSigner(envelope.id, {
      name: item.signer.name,
      email: item.signer.email,
      phoneNumber: item.signer.phoneNumber,
      communicateEvents: communicateEventsFor(item.delivery, contactChannel),
    }),
  );

  await clicksign.run((c) => c.addQualificationRequirement(envelope.id, document.id, signer.id));

  await clicksign.run((c) =>
    c.addAuthenticationRequirement(
      envelope.id,
      document.id,
      signer.id,
      authMethodFor(item.delivery, contactChannel),
    ),
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
