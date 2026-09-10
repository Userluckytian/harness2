import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(__dirname, '..');

function legacyExit(reason) {
  console.log(reason);
  process.exit(0);
}

if (process.argv.includes('--no-tui')) {
  legacyExit('LEGACY_FORCED_BY_ARG');
}
if (process.env.HARNESS2_NO_TUI === '1') {
  legacyExit('LEGACY_FORCED_BY_ENV');
}
if (process.env.HARNESS2_SPIKE_FORCE_TUI === '1') {
  /* skip notty gate for real-TTY spike testing */
} else if (!process.stdin.isTTY) {
  legacyExit('LEGACY_FORCED_BY_NOTTY');
}

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('ESBUILD_MISSING need esbuild dev dep');
  process.exit(2);
}

const outfile = join(CLI_ROOT, 'scripts', `.tui-spike.bundle-${process.pid}.mjs`);
await esbuild.build({
  entryPoints: [join(CLI_ROOT, 'scripts', 'tui-spike.tsx')],
  bundle: false,
  format: 'esm',
  jsx: 'automatic',
  outfile,
  sourcemap: false,
  logLevel: 'info',
});

try {
  await import(pathToFileURL(outfile).href);
} finally {
  const { rmSync } = await import('node:fs');
  if (existsSync(outfile)) rmSync(outfile, { force: true });
}
