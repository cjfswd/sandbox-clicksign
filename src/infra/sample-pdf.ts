import { PDFDocument, StandardFonts } from 'pdf-lib';

/** Gera um PDF simples de contrato de teste e retorna em base64. */
export async function generateSamplePdfBase64(signerName: string): Promise<string> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  page.drawText('CONTRATO DE TESTE - SANDBOX CLICKSIGN', {
    x: 50,
    y: 780,
    size: 16,
    font: bold,
  });

  const lines = [
    'Este documento foi gerado automaticamente para testar a',
    'integracao com a API v3 da Clicksign (ambiente sandbox).',
    '',
    `Signatario: ${signerName}`,
    `Gerado em: ${new Date().toISOString()}`,
    '',
    'Documentos criados no sandbox nao possuem valor legal.',
  ];

  lines.forEach((line, index) => {
    page.drawText(line, { x: 50, y: 730 - index * 22, size: 12, font });
  });

  return pdf.saveAsBase64();
}
