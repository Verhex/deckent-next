import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// FIX8a R27: the dist that `scripts/build.mjs` writes (dev runner, live, N1) loads React from node_modules at run time, where NODE_ENV picks
// the development or production build. A person's shell has no NODE_ENV; the CLI entry must still bring the terminal up on production React.
const execute = promisify(execFile), url = (path: string) => pathToFileURL(resolve(path)).href;
const ENTRY = url('dist/composition/core/cli/internal/entry.js');
const TERMINAL = [url('dist/surfaces/core/cli-terminal/index.js'), url('dist/surfaces/core/terminal/index.js')];

/** Loads the terminal modules in a shell without NODE_ENV (after the CLI entry, or without it) and lists the development builds Node evaluated. */
async function developmentModules(throughEntry: boolean): Promise<string[]> {
  const script = `${throughEntry ? `await import(${JSON.stringify(ENTRY)});` : ''}
for (const module of ${JSON.stringify(TERMINAL)}) await import(module);
const { createRequire } = await import('node:module');
// Node's CJS export scan caches both builds; only an evaluated (loaded) one runs.
console.log(JSON.stringify(Object.entries(createRequire(import.meta.url).cache).filter(([path, module]) => module?.loaded && /\\.development\\.js$/.test(path)).map(([path]) => path)));`;
  const env = { ...process.env }; delete env.NODE_ENV; delete env.VITEST;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { env, timeout: 60_000 });
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as string[];
}

describe('production React in the built dist', () => {
  it('the CLI entry starts the terminal on production React builds; without the entry the same shell gets the development builds', async () => {
    expect(await developmentModules(true)).toEqual([]);
    expect((await developmentModules(false)).some(path => /react-reconciler/.test(path))).toBe(true);
  });
});
