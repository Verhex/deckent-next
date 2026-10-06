import { it, expect, vi } from 'vitest';
import { constants } from 'node:fs';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalIntegrityAuthority } from '../../../src/adapters/core/local-keyring/index.js';
import { resolveProductLayout, productResourcePath } from '../../../src/platform/core/host/index.js';

const gate = vi.hoisted(() => ({ path: '', opened: () => {}, waiter: () => {}, hold: Promise.resolve() }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) === gate.path && typeof args[1] === 'number' && (args[1] & constants.O_CREAT)) {
        gate.opened(); await gate.hold;
      }
      return handle;
    },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      try { return await fs.mkdir(...args); }
      catch (error) {
        if (String(args[0]) === gate.path + '.write-lock' && (error as NodeJS.ErrnoException).code === 'EEXIST') gate.waiter();
        throw error;
      }
    },
  };
});

it.skipIf(process.platform === 'win32')('POSIX first key creation: another writer cannot read the incomplete key; both receive the same signing custody', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-publication-'));
  const layout = resolveProductLayout({ projectRoot: root });
  gate.path = join(productResourcePath(layout, 'approvals'), 'first.key');
  let release!: () => void, opened!: () => void, waiter!: () => void;
  gate.hold = new Promise<void>(resolve => { release = resolve; });
  const created = new Promise<void>(resolve => { opened = resolve; });
  const waiting = new Promise<void>(resolve => { waiter = resolve; });
  gate.opened = opened; gate.waiter = waiter;
  const first = openLocalIntegrityAuthority(layout, 'first.key', true);
  let second: Promise<{ value: Awaited<ReturnType<typeof openLocalIntegrityAuthority>> | null; error: unknown }> | undefined;
  let outcome = 'pending';
  try {
    await created;
    expect((await lstat(gate.path)).size).toBe(0); // Real exclusive create, paused before the real write; no sleep or scheduler guess.
    second = openLocalIntegrityAuthority(layout, 'first.key', true).then(value => {
      outcome = 'fulfilled'; waiter(); return { value, error: null };
    }, error => { outcome = 'rejected'; waiter(); return { value: null, error }; });
    await waiting; // Either the existing write lock was observed, or the old implementation incorrectly finished.
    expect(outcome).toBe('pending');
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b.error).toBeNull();
    expect(b.value?.keyId).toBe(a.keyId);
    expect(b.value?.verify('publication-proof', a.sign('publication-proof'), a.keyId)).toBe(true);
    expect((await lstat(gate.path)).size).toBe(32);
  } finally {
    release(); await Promise.allSettled([first, ...(second ? [second] : [])]);
    gate.path = ''; gate.opened = () => {}; gate.waiter = () => {}; gate.hold = Promise.resolve();
    await rm(root, { recursive: true, force: true });
  }
});
