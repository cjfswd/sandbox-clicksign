/**
 * Consulta o status de um envelope e lista os links de assinatura dos signatarios.
 *
 * Uso: npm run status -- <envelope_id>
 */
import { clientFromEnv } from './infra/clicksign.ts';

const envelopeId = process.argv[2];
if (!envelopeId) {
  console.error('Uso: npm run status -- <envelope_id>');
  process.exit(1);
}

const client = clientFromEnv();

const envelope = await client.getEnvelope(envelopeId);
console.log(`Envelope: ${envelope.attributes.name}`);
console.log(`Status:   ${envelope.attributes.status}`);

const signers = await client.listSigners(envelopeId);
console.log(`\nSignatarios (${signers.length}):`);
for (const signer of signers) {
  console.log(`  - ${signer.attributes.name} <${signer.attributes.email}>`);
  console.log(`    Link: ${client.signUrl(signer.id)}`);
}
