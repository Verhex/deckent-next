import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// FIX8a R27: the dist that `scripts/build.mjs` writes (dev runner, live, N1) loads React from node_modules at run time, where NODE_ENV picks
// the development or production build. A person's shell has no NODE_ENV; the CLI entry must still bring the terminal up on production React.
const execute = promisify(execFile), url = (path: string) => pathToFileURL(resolve(path)).href;
const ENTRY = url('dist/composition/core/cli/internal/entry.js');
const TERMINAL = [url('dist/surfaces/core/cli-terminal/index.js'), url('dist/surfaces/core/terminal/index.js')];
const SUPERVISOR = url('dist/adapters/core/process-supervisor/index.js');
const withoutNodeEnv = () => { const env = { ...process.env }; delete env.NODE_ENV; delete env.VITEST; return env; };

/** Loads the terminal modules in a shell without NODE_ENV (after the CLI entry, or without it) and lists the development builds Node evaluated. */
async function developmentModules(throughEntry: boolean): Promise<string[]> {
  const script = `${throughEntry ? `await import(${JSON.stringify(ENTRY)});` : ''}
for (const module of ${JSON.stringify(TERMINAL)}) await import(module);
const { createRequire } = await import('node:module');
// Node's CJS export scan caches both builds; only an evaluated (loaded) one runs.
console.log(JSON.stringify(Object.entries(createRequire(import.meta.url).cache).filter(([path, module]) => module?.loaded && /\\.development\\.js$/.test(path)).map(([path]) => path)));`;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { env: withoutNodeEnv(), timeout: 60_000 });
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as string[];
}

describe('production React in the built dist', () => {
  it('the CLI entry starts the terminal on production React builds; without the entry the same shell gets the development builds', async () => {
    expect(await developmentModules(true)).toEqual([]);
    expect((await developmentModules(false)).some(path => /react-reconciler/.test(path))).toBe(true);
  });

  it('a process the production entry starts (a process-supervisor control child) gets the caller\'s NODE_ENV back: unset stays unset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-caller-env-')), seen = join(root, 'node-env');
    const control = `require('node:fs').writeFileSync(${JSON.stringify(seen)}, process.env.NODE_ENV ?? '<unset>')`;
    const request = { protocolVersion: 1, identity: { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 }, workspace: root, argv: ['node'] };
    const script = `await import(${JSON.stringify(ENTRY)}); const { ProcessSupervisor } = await import(${JSON.stringify(SUPERVISOR)});
await new ProcessSupervisor({ executable: process.execPath, args: ['-e', ${JSON.stringify(control)}], cwd: ${JSON.stringify(root)}, timeoutMs: 10000,
  maxInputBytes: 65536, maxOutputBytes: 65536 }).observe(${JSON.stringify(request)}).catch(() => undefined);
console.log(process.env.NODE_ENV + ' ' + (await import('node:fs')).readFileSync(${JSON.stringify(seen)}, 'utf8'));`;
    try {
      for (const [caller, expected] of [[undefined, 'production <unset>'], ['staging', 'staging staging']] as const) {
        const env = { ...withoutNodeEnv(), ...(caller ? { NODE_ENV: caller } : {}) };
        const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { env, timeout: 60_000 });
        expect(stdout.trim().split('\n').at(-1)).toBe(expected);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
