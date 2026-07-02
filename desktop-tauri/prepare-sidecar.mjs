/**
 * Reconstrói a batch API como executável (SEA) e copia para
 * src-tauri/binaries/ com o sufixo de target-triple que o Tauri exige
 * para sidecars. Rodar sempre que o código da batch API mudar, antes de
 * `npx tauri build` / `npx tauri dev`.
 *
 * Uso: node prepare-sidecar.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TAURI_DIR = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

console.log('Rodando npm run build:sea na raiz do repositório...');
// shell:true é necessário no Windows para resolver npm.cmd; comando é uma
// string fixa sem input externo, então não há risco de injeção aqui.
execFileSync('npm run build:sea', { cwd: ROOT, stdio: 'inherit', shell: true });

const hostTriple = execFileSync('rustc', ['-Vv'], { encoding: 'utf8' })
  .split('\n')
  .find((line) => line.startsWith('host:'))
  ?.split(':')[1]
  ?.trim();
if (!hostTriple) throw new Error('Não foi possível determinar o target triple via `rustc -Vv`');

const binariesDir = join(TAURI_DIR, 'src-tauri/binaries');
mkdirSync(binariesDir, { recursive: true });
const dest = join(binariesDir, `batch-api-${hostTriple}.exe`);
copyFileSync(join(ROOT, 'dist/batch-api.exe'), dest);

console.log(`OK: ${dest}`);
