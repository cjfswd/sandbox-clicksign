/**
 * Armazena os PDFs do lote em disco (não no SQLite), decodificados.
 * Arquivos são removidos quando o item conclui, para não acumular disco.
 *
 * Porta de src/infra/pdf-store.ts: node:fs → @tauri-apps/plugin-fs
 * (IPC, assíncrono). Guarda em `<app_data_dir>/<env>/pdfs/`, ao lado do
 * SQLite do mesmo ambiente.
 */
import { exists, mkdir, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class PdfStore {
  /** `dir` é o caminho absoluto de `<app_data_dir>/<env>/pdfs`, resolvido uma vez em load(). */
  private constructor(private readonly dir: string) {}

  /** Resolve o diretório de PDFs do ambiente (não cria ainda — save() cria sob demanda). */
  static async load(env: 'sandbox' | 'producao'): Promise<PdfStore> {
    const dir = await join(await appDataDir(), env, 'pdfs');
    return new PdfStore(dir);
  }

  /** Grava o PDF do item em disco, criando o diretório na primeira vez. */
  async save(itemId: string, contentBase64: string): Promise<void> {
    if (!(await exists(this.dir))) await mkdir(this.dir, { recursive: true });
    await writeFile(await this.pathFor(itemId), base64ToBytes(contentBase64));
  }

  /** Lê o PDF do item de volta como base64, para anexar ao envelope da Clicksign. */
  async readBase64(itemId: string): Promise<string> {
    const bytes = await readFile(await this.pathFor(itemId));
    return bytesToBase64(bytes);
  }

  /** Apaga o PDF do item (chamado pelo worker ao concluir, para não acumular disco). */
  async remove(itemId: string): Promise<void> {
    const path = await this.pathFor(itemId);
    if (await exists(path)) await remove(path);
  }

  /** Caminho do arquivo de um item: `<dir>/<itemId>.pdf`. */
  private pathFor(itemId: string): Promise<string> {
    return join(this.dir, `${itemId}.pdf`);
  }
}
