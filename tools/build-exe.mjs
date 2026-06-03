/**
 * Build the single-file standalone:
 *   1. build the web UI (vite)
 *   2. embed dist into a generated TS module
 *   3. bundle the standalone backend into one CJS file (esbuild)
 *   4. package into a Windows .exe (@yao-pkg/pkg)
 *
 * Usage:
 *   node tools/build-exe.mjs            # full pipeline incl. exe
 *   node tools/build-exe.mjs --no-exe   # stop after the bundle (for testing)
 */
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const noExe = process.argv.includes('--no-exe');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  if (r.status !== 0) { console.error(`\nstep failed: ${cmd} ${args.join(' ')}`); process.exit(1); }
};

mkdirSync(root + 'build-exe', { recursive: true });

// Distribution legal docs must ship NEXT TO the .exe (the .exe is a single file).
// THIRD-PARTY-NOTICES is required by the bundled OSS licenses (MIT/ISC/BSD); the
// EULA + disclaimer are part of the product. Copy them into build-exe/.
console.log('\n[0/4] copying legal docs next to the build…');
for (const f of ['THIRD-PARTY-NOTICES.txt', 'EULA.txt', 'DISCLAIMER.txt']) {
  if (existsSync(root + f)) {
    copyFileSync(root + f, root + 'build-exe/' + f);
    console.log('  ' + f);
  } else {
    console.warn(`  WARNING: ${f} missing — distribution will lack required notices`);
  }
}

console.log('\n[1/4] building web UI…');
run('pnpm', ['--filter', '@receiver-hq/web', 'build']);

console.log('\n[2/4] embedding web into generated module…');
run('node', ['tools/gen-embedded.mjs', 'apps/web/dist', 'apps/api/src/embedded-web.generated.ts']);

console.log('\n[3/4] bundling backend (esbuild)…');
await esbuild.build({
  entryPoints: [root + 'apps/api/src/standalone.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: root + 'build-exe/app.cjs',
  // Preserve bundled OSS license/copyright headers (MIT/ISC/BSD require attribution
  // in redistributions). 'eof' appends them at the end of the bundle; the human-
  // readable summary also ships as THIRD-PARTY-NOTICES.txt next to the .exe.
  legalComments: 'eof',
  logLevel: 'info',
  // pino's optional pretty transport is never used (logger:false) — don't fail on it.
  external: ['pino-pretty'],
});
console.log('  bundle -> build-exe/app.cjs');

if (noExe) { console.log('\n--no-exe: stopping before packaging.'); process.exit(0); }

console.log('\n[4/4] packaging Windows exe (@yao-pkg/pkg)…');
run('pnpm', ['exec', 'pkg', 'build-exe/app.cjs', '-t', 'node22-win-x64', '-o', 'build-exe/receiver-hq.exe', '--public']);
console.log('\nDone: build-exe/receiver-hq.exe');
