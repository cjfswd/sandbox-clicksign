/**
 * Fluxo completo da Clicksign API v3:
 * envelope -> documento -> signatario -> requisitos -> ativacao -> link de assinatura.
 *
 * Uso: npm run create -- "Nome do Signatario" email@exemplo.com
 * (sem argumentos usa o signatario de teste padrao)
 */
import { clientFromEnv } from './infra/clicksign.ts';
import { generateSamplePdfBase64 } from './infra/sample-pdf.ts';

const signerName = process.argv[2] ?? 'Signatario de Teste';
const signerEmail = process.argv[3] ?? 'ti@healthmaiscuidados.com';

const client = clientFromEnv();

console.log('1/6 Criando envelope...');
const envelope = await client.createEnvelope(
  `Contrato de Teste - ${new Date().toISOString().slice(0, 16)}`,
);
console.log(`    Envelope criado: ${envelope.id} (status: ${envelope.attributes.status})`);

console.log('2/6 Gerando e enviando documento PDF...');
const pdfBase64 = await generateSamplePdfBase64(signerName);
const document = await client.addDocument(envelope.id, 'contrato-teste.pdf', pdfBase64);
console.log(`    Documento adicionado: ${document.id}`);

console.log('3/6 Adicionando signatario...');
const signer = await client.addSigner(envelope.id, { name: signerName, email: signerEmail });
console.log(`    Signatario adicionado: ${signer.id} (${signerEmail})`);

console.log('4/6 Criando requisito de qualificacao (assinar como parte)...');
await client.addQualificationRequirement(envelope.id, document.id, signer.id);

console.log('5/6 Criando requisito de autenticacao (token por e-mail)...');
await client.addAuthenticationRequirement(envelope.id, document.id, signer.id);

console.log('6/6 Ativando envelope (draft -> running)...');
const activated = await client.activateEnvelope(envelope.id);
console.log(`    Envelope ativado: status = ${activated.attributes.status}`);

const link = client.signUrl(signer.id);
console.log('\n========================================================');
console.log('Envelope pronto para assinatura!');
console.log(`Envelope ID:   ${envelope.id}`);
console.log(`Documento ID:  ${document.id}`);
console.log(`Signatario ID: ${signer.id}`);
console.log('\nLink de assinatura (envie manualmente ao signatario):');
console.log(`  ${link}`);
console.log('========================================================');
