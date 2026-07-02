/**
 * Armazena os PDFs do lote em disco (não no SQLite), decodificados.
 * Arquivos são removidos quando o item conclui, para não acumular disco.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class PdfStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  save(itemId: string, contentBase64: string): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathFor(itemId), Buffer.from(contentBase64, 'base64'));
  }

  readBase64(itemId: string): string {
    return readFileSync(this.pathFor(itemId)).toString('base64');
  }

  remove(itemId: string): void {
    rmSync(this.pathFor(itemId), { force: true });
  }

  private pathFor(itemId: string): string {
    return join(this.dir, `${itemId}.pdf`);
  }
}
