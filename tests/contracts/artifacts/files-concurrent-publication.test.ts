import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileArtifactStore } from '#adapters/index.js';

// Forces the interleaving a loaded runner produced (ubuntu node 24, run 37308549749): a publisher that missed the existence check
// publishes while another put sits between its lstat and open. Only scheduling is controlled; every file operation is real.
const gate = vi.hoisted(() => ({ held: null as null | { arrived: () => void; release: Promise<void> }, onLstat: null as null | { file: string; run: () => Promise<void> } }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const publish = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A) => {
    const held = gate.held; gate.held = null;
    if (held) { held.arrived(); await held.release; }
    return fn(...args);
  };
  return { ...real,
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      const result = await real.lstat(...args); const hook = gate.onLstat;
      if (hook && String(args[0]) === hook.file) { gate.onLstat = null; await hook.run(); }
      return result;
    },
    link: publish(real.link), rename: publish(real.rename) };
});

const roots: string[] = [];
afterEach(async () => { gate.held = null; gate.onLstat = null; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform === 'win32')('concurrent identical artifact publication', () => {
  it('a late identical publisher never replaces the published file under a reader between lstat and open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-artifact-race-')); roots.push(root);
    const path = join(root, 'artifacts'); await mkdir(path, { mode: 0o700 });
    const store = new FileArtifactStore({ root: path, maxBytes: 1024 }); const bytes = Buffer.from('same-content');
    let arrived!: () => void, release!: () => void;
    const atPublish = new Promise<void>(resolve => { arrived = resolve; });
    gate.held = { arrived, release: new Promise<void>(resolve => { release = resolve; }) };
    const late = store.put('s', bytes); await atPublish; // missed the existence check, staged, waits to publish
    const first = await store.put('s', bytes);
    const file = join(path, createHash('sha256').update('s').digest('hex'), first.digest); const published = (await stat(file)).ino;
    gate.onLstat = { file, run: async () => { release(); await late; } }; // the late publisher completes inside the reader's lstat→open window
    await expect(store.put('s', bytes)).resolves.toEqual(first);
    await expect(late).resolves.toEqual(first);
    expect((await stat(file)).ino).toBe(published);
    expect(await readdir(join(path, createHash('sha256').update('s').digest('hex')))).toEqual([first.digest]);
    expect(Buffer.from(await store.read('s', first)).toString()).toBe('same-content');
  });
});
