import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The bundled bwrap copy under concurrent placement (one installation's processes measuring the host at once: test workers, a service and a
 * CLI, MCP starts). Before the fix, each writer `rename`d its temporary over the target, and a writer whose own copy was replaced between
 * its `rename` and its check read `nlink` 0 and refused the build ("did not verify after writing": measured 29 of 120 processes), falling
 * back to another realm. Now the copy is published with `link` (never replaces): every process selects the bundled build, all of them the
 * same inode (unless a publisher is descheduled past the settle bound), and no temporary name is left behind. Real processes released together by a barrier; the compiled module (dist) is what they run.
 */
const dist = resolve('dist/adapters/core/shell-sandbox-bwrap/index.js');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const PROCESSES = 8, ROUNDS = 6;

const child = `
import { existsSync } from 'node:fs';
const [module, stateDir, bundledPath, bundledSha256, go] = process.argv.slice(1);
const { selectBubblewrapLauncher } = await import(module);
process.stdout.write('ready\\n');
while (!existsSync(go)) { /* barrier: released together */ }
const observed = await selectBubblewrapLauncher({ stateDir, systemPaths: [], bundledPath, bundledSha256, bundledVersion: '0.13.0' });
process.stdout.write(JSON.stringify({ status: observed.status, path: observed.launcher?.path ?? null, identity: observed.launcher?.identity ?? null, detail: observed.detail }) + '\\n');
`;

type ChildResult = { status: string; path: string | null; identity: string | null; detail: string | null };
async function round(root: string, index: number, bundled: string, sha: string) {
  const state = join(root, `state-${index}`), go = join(root, `go-${index}`);
  const outputs: Promise<string>[] = [], ready: Promise<void>[] = [];
  for (let n = 0; n < PROCESSES; n++) {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', child, pathToFileURL(dist).href, state, bundled, sha, go], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ready.push(new Promise(done => proc.stdout.on('data', chunk => { out += String(chunk); if (out.startsWith('ready\n')) done(); })));
    proc.stderr.on('data', chunk => { out += String(chunk); });
    outputs.push(new Promise(done => proc.on('close', () => done(out))));
  }
  await Promise.all(ready);
  await writeFile(go, '');
  const parse = (out: string) => { const line = out.split('\n').find(text => text.startsWith('{')); if (!line) throw new Error(`child output: ${out.slice(0, 400)}`); return JSON.parse(line) as ChildResult; };
  return { state, results: (await Promise.all(outputs)).map(parse) };
}

describe.skipIf(process.platform !== 'linux' || !existsSync(dist))('bundled bwrap copy: concurrent placement', () => {
  it('processes placing the copy at once all select it; one name, one link, nothing left behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-bwrap-race-')); roots.push(root);
    // A launcher that passes the smoke run (exit 0), padded so each write takes long enough to overlap.
    const script = `#!/bin/sh\nexit 0\n${'#'.repeat(80)}\n`.repeat(2_048);
    const bundled = join(root, 'bwrap'); await writeFile(bundled, script); await chmod(bundled, 0o755);
    const sha = createHash('sha256').update(script).digest('hex');
    const summary: { round: number; selected: number; statuses: Record<string, number>; inodes: number; copyRefusals: string[]; names: string[]; links: number }[] = [];
    for (let index = 0; index < ROUNDS; index++) {
      const { state, results } = await round(root, index, bundled, sha);
      const target = join(state, 'bin', `bwrap-${sha}`), statuses: Record<string, number> = {};
      for (const result of results) statuses[result.status] = (statuses[result.status] ?? 0) + 1;
      summary.push({ round: index, selected: results.filter(result => result.path === target).length, statuses, inodes: new Set(results.map(result => result.identity?.split(':')[1])).size,
        copyRefusals: results.flatMap(result => result.detail && /bundled bwrap (copy|could not)/u.test(result.detail) ? [result.detail] : []),
        names: await readdir(join(state, 'bin')), links: Number((await lstat(target)).nlink) });
    }
    console.log('BWRAP_COPY_RACE', JSON.stringify(summary));
    // The race's outcome is the selection: every process selects the bundled copy (its smoke run's status is the host's, reported only), no
    // copy refusal, one name with one link left. The copy is normally one inode for all (`inodes` 1); a publisher descheduled past the
    // settle bound makes a later one replace its copy (still verified): reported, not asserted.
    for (const entry of summary) {
      expect({ round: entry.round, selected: entry.selected, copyRefusals: entry.copyRefusals, names: entry.names, links: entry.links })
        .toEqual({ round: entry.round, selected: PROCESSES, copyRefusals: [], names: [`bwrap-${sha}`], links: 1 });
    }
  }, 120_000);
});
