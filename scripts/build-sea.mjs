/**
 * Empacota a batch API (src/index.ts) como um executável Windows autossuficiente
 * usando Single Executable Applications do Node 24 (node: builtins, incluindo
 * node:sqlite, continuam funcionando — fazem parte do próprio binário do Node).
 *
 * Saída: dist/batch-api.exe
 * Uso: node scripts/build-sea.mjs
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(ROOT, 'dist');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log('[1/4] Bundle (esbuild) src/index.ts -> dist/batch-api.cjs');
await build({
  entryPoints: [join(ROOT, 'src/index.ts')],
  outfile: join(DIST, 'batch-api.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  // node:sqlite e demais node: builtins ficam de fora do bundle automaticamente
  // (esbuild trata prefixo node: como externo no modo platform:'node').
});

console.log('[2/4] Gerando SEA blob');
const seaConfigPath = join(DIST, 'sea-config.json');
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: join(DIST, 'batch-api.cjs'),
      output: join(DIST, 'batch-api.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });

console.log('[3/4] Copiando node.exe base');
const exePath = join(DIST, 'batch-api.exe');
copyFileSync(process.execPath, exePath);

console.log('[4/4] Injetando o blob no executável (postject)');
execFileSync(
  process.execPath,
  [
    join(ROOT, 'node_modules/postject/dist/cli.js'),
    exePath,
    'NODE_SEA_BLOB',
    join(DIST, 'batch-api.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '--overwrite',
  ],
  { stdio: 'inherit' },
);

console.log(`\nOK: ${exePath}`);
