import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PdfStore } from './pdf-store.ts';

describe('PdfStore', () => {
  let dir: string;
  let store: PdfStore;
  const pdfBase64 = Buffer.from('%PDF-1.4 teste').toString('base64');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdf-store-'));
    store = new PdfStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('grava o base64 decodificado e lê de volta', () => {
    store.save('item-1', pdfBase64);
    const read = store.readBase64('item-1');
    expect(Buffer.from(read, 'base64').toString('latin1')).toContain('%PDF-1.4 teste');
  });

  it('remove o arquivo ao concluir o item', () => {
    store.save('item-1', pdfBase64);
    store.remove('item-1');
    expect(() => store.readBase64('item-1')).toThrow();
  });

  it('remove é idempotente (não lança se o arquivo não existe)', () => {
    expect(() => store.remove('nunca-existiu')).not.toThrow();
  });

  it('cria o diretório de destino se não existir', () => {
    const nested = new PdfStore(join(dir, 'a', 'b'));
    nested.save('item-2', pdfBase64);
    expect(nested.readBase64('item-2')).toBeTruthy();
  });
});
