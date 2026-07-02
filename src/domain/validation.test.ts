import { describe, expect, it } from 'vitest';
import { validateBatchItems, type BatchItemInput } from './validation.ts';

const validPdfBase64 = Buffer.from('%PDF-1.4 conteudo minimo').toString('base64');

function validItem(overrides: Partial<BatchItemInput> = {}): BatchItemInput {
  return {
    filename: 'contrato.pdf',
    contentBase64: validPdfBase64,
    signer: { name: 'Fulano da Silva', email: 'fulano@exemplo.com' },
    delivery: 'link',
    ...overrides,
  };
}

describe('validateBatchItems', () => {
  it('aceita lote com itens válidos', () => {
    const result = validateBatchItems([validItem(), validItem({ delivery: 'email' })]);
    expect(result.ok).toBe(true);
  });

  it('rejeita signer sem nome completo (nome e sobrenome)', () => {
    const result = validateBatchItems([validItem({ signer: { name: 'Fulano' } })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ index: 0, field: 'signer.name' });
    }
  });

  it('rejeita nome com números (regra da Clicksign)', () => {
    const result = validateBatchItems([validItem({ signer: { name: 'Fulano da Silva 2' } })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ index: 0, field: 'signer.name' });
      expect(result.errors[0]!.message).toMatch(/números/);
    }
  });

  it('rejeita delivery=email sem email', () => {
    const result = validateBatchItems([
      validItem({ delivery: 'email', signer: { name: 'Fulano da Silva' } }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ index: 0, field: 'signer.email' });
    }
  });

  it('rejeita delivery=whatsapp sem phone_number', () => {
    const result = validateBatchItems([
      validItem({
        delivery: 'whatsapp',
        signer: { name: 'Fulano da Silva', email: 'f@exemplo.com' },
      }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ index: 0, field: 'signer.phoneNumber' });
    }
  });

  it('aceita delivery=link sem email nem telefone', () => {
    const result = validateBatchItems([validItem({ signer: { name: 'Fulano da Silva' } })]);
    expect(result.ok).toBe(true);
  });

  it('rejeita base64 não decodificável', () => {
    const result = validateBatchItems([validItem({ contentBase64: '###nao-e-base64###' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ index: 0, field: 'contentBase64' });
    }
  });

  it('rejeita conteúdo que não é PDF (sem magic bytes %PDF)', () => {
    const notPdf = Buffer.from('apenas texto simples').toString('base64');
    const result = validateBatchItems([validItem({ contentBase64: notPdf })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.message).toMatch(/PDF/);
    }
  });

  it('rejeita PDF acima de 10 MB', () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20);
    big.write('%PDF-1.4');
    const result = validateBatchItems([validItem({ contentBase64: big.toString('base64') })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.message).toMatch(/10 MB/);
    }
  });

  it('reporta todos os erros do lote com o índice de cada item', () => {
    const result = validateBatchItems([
      validItem(), // ok
      validItem({ signer: { name: 'SóNome' } }), // erro no índice 1
      validItem({ delivery: 'whatsapp', signer: { name: 'Beltrano de Souza' } }), // erro no índice 2
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.index)).toEqual([1, 2]);
    }
  });
});
