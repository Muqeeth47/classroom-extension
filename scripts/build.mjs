// Bundles the TypeScript sources and copies static files into dist/, which is the folder you
// load in the browser ("Load unpacked") and the one that gets zipped for releases.
//
//   npm run build          one-off build
//   npm run build -- --watch   rebuild on change

import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: path.join(root, 'src/background.ts'),
    content: path.join(root, 'src/content.ts'),
    popup: path.join(root, 'src/popup/popup.ts'),
  },
  outdir: dist,
  bundle: true,
  format: 'iife', // content scripts must be classic scripts; the rest don't need modules either
  target: 'es2022',
  platform: 'browser',
  // Not minified: the output stays readable for store reviewers and for debugging.
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
};

async function copyStatic() {
  await cp(path.join(root, 'public'), dist, { recursive: true });
  await cp(path.join(root, 'src/popup/popup.html'), path.join(dist, 'popup.html'));
  await cp(path.join(root, 'src/popup/popup.css'), path.join(dist, 'popup.css'));
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await copyStatic();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching for changes… (static files are copied once; re-run to refresh them)');
} else {
  await build(options);
  console.log(`Built to ${path.relative(root, dist)}/`);
}
