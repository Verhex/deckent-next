import { cpSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { BUNDLED_DIR, bundleProblems, stageBundle } from './build-bwrap.mjs';

/**
 * BWRAP-SELECT (lead 2026-09-29): the bundled bubblewrap is part of the normal build, so src-mode tests and dist run the same locked build
 * the package ships. `src/…/bundled/` (gitignored) must be exactly the locked build; when it is absent or stale it is staged from a
 * build-bwrap output that verifies against the lock — `DECKENT_BWRAP_BUILD=<dir>`, else the newest matching `.pack/bwrap/<dir>/`. A wrong
 * staged tree fails the build; no verifiable output triggers the locked CI source recipe (Docker), whose failure stops the build. build-dist still gates releases on its own `--bwrap` input.
 */
export function stageBubblewrap({ root: ROOT, run, platform = process.platform, buildOutput = process.env.DECKENT_BWRAP_BUILD }) {
  const SRC = join(ROOT, 'src'), DIST = join(ROOT, 'dist');
  const lock = JSON.parse(readFileSync(join(ROOT, 'packaging', 'bwrap', 'bwrap.lock.json'), 'utf8'));
  const target = join(SRC, BUNDLED_DIR);
  const verifies = dir => lock.shipArches.every(arch => { const file = join(dir, 'out', arch, 'bwrap'); return existsSync(file) && createHash('sha256').update(readFileSync(file)).digest('hex') === lock.outputs[arch].sha256; });
  let state = 'present';
  if (bundleProblems(target, lock).length) {
    const packs = join(ROOT, '.pack', 'bwrap');
    const candidates = buildOutput ? [resolve(buildOutput)]
      : existsSync(packs) ? readdirSync(packs).map(name => join(packs, name)).filter(dir => existsSync(join(dir, 'out'))).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) : [];
    const source = candidates.find(verifies);
    if (source) { stageBundle(source, target, lock); state = `staged from ${relative(ROOT, source) || source}`; }
    else if (existsSync(target)) throw new Error(`${relative(ROOT, target)} is not the locked bubblewrap build (${bundleProblems(target, lock).join('; ')}) and no build-bwrap output verifies against the lock: `
      + 'run `node scripts/build-bwrap.mjs` (Docker) or set DECKENT_BWRAP_BUILD=<build-bwrap output>');
    else if (platform !== 'linux') return 'absent (not Linux)';
    else {
      // The same locked download/digest/Docker recipe CI uses; failures must stop the source build.
      const out = join(ROOT, '.pack', 'bwrap', 'source-build');
      if (existsSync(out)) throw new Error(`Incomplete locked bubblewrap output at ${out}. Remove that disposable output or set DECKENT_BWRAP_BUILD to a verified build.`);
      try { run(process.execPath, [join(ROOT, 'scripts/build-bwrap.mjs'), '--out', out]); }
      catch (error) { throw new Error(`BUBBLEWRAP_BUILD_REQUIRED: locked bubblewrap ${lock.version} staging failed. Start Docker and rerun npm run build, or set DECKENT_BWRAP_BUILD to a verified build-bwrap output.`, { cause: error }); }
      stageBundle(out, target, lock); state = 'staged from locked source build';
    }
  }
  cpSync(target, join(DIST, BUNDLED_DIR), { recursive: true });
  return state;
}

