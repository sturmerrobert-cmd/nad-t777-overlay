/**
 * Embed the built web UI (apps/web/dist) into a generated TS module so the
 * standalone exe serves it from memory (no external files).
 * Usage: node tools/gen-embedded.mjs <distDir> <outFile>
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const distDir = process.argv[2];
const outFile = process.argv[3];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const map = {};
for (const file of walk(distDir)) {
  const rel = relative(distDir, file).split('\\').join('/');
  const ext = rel.slice(rel.lastIndexOf('.'));
  map[rel] = { type: TYPES[ext] ?? 'application/octet-stream', b64: readFileSync(file).toString('base64') };
}

const body =
  '// AUTO-GENERATED — do not edit. Built from apps/web/dist.\n' +
  'export const WEB: Record<string, { type: string; b64: string }> = ' +
  JSON.stringify(map) +
  ';\n';
writeFileSync(outFile, body);
console.log(`embedded ${Object.keys(map).length} web files -> ${outFile}`);
