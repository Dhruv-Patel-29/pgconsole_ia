#!/usr/bin/env node
import { build } from 'esbuild';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
const gitCommit = process.env.GIT_COMMIT?.slice(0, 8) || 'devlocal';

/**
 * Bundles the Electron main process together with the server it embeds, into
 * electron/dist/main.mjs.
 *
 * The externals must match scripts/build-server.mjs: these packages ship native binaries
 * or .wasm that cannot be inlined, so they stay as runtime requires and must exist as real
 * files in the packaged app — which is what the asarUnpack list in electron-builder.yml
 * guarantees.
 */
await build({
  entryPoints: [join(rootDir, 'electron/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(rootDir, 'electron/dist/main.mjs'),
  external: [
    'electron',
    'pg',
    'postgres',
    'express',
    '@libpg-query/parser',
    '@electric-sql/pglite',
    '@electric-sql/pglite-socket',
    // Node builtin; esbuild treats node: specifiers as external already, listed for clarity.
    'node:sqlite',
  ],
  banner: {
    js: `import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);`,
  },
  define: {
    '__APP_VERSION__': JSON.stringify(pkg.version),
    '__DEV__': 'false',
    '__GIT_COMMIT__': JSON.stringify(gitCommit),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  sourcemap: true,
  logLevel: 'info',
});

console.log('Electron main build complete!');
