import { chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { withInstallationJournal, type InstallationJournalSession } from '../../../src/adapters/core/installation-journal/index.js';
import type { BootstrapJournalPayload, BootstrapObservation } from '../../../src/platform/core/bootstrap-state/index.js';

const roots: string[] = [], options = { timeoutMs: 2_000 }, hex = (char: string) => char.repeat(64);
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() { const root = await mkdtemp(join(tmpdir(), 'deckent-journal-')); roots.push(root); return root; }
function payload(root: string, updatedAtMs = 1): BootstrapJournalPayload {
  return { schemaVersion: 2, transactionId: 'transaction-1', planDigest: hex('a'), profileDigest: hex('b'), phase: 'pending',
    createdAtMs: 1, updatedAtMs, resources: [{ resource: 'config', path: join(root, '.deckent/config.json'),
      preimageDigest: null, targetDigest: hex('c'), state: 'pending' }], blockers: ['INSTALLATION_NOT_APPLIED'],
    recovery: { authoredProfile: { schemaVersion: 1 }, normalizedConfig: { schema_version: 2 }, approval: { status: 'recorded' } } };
}

it('atomically creates a complete initial pending journal that survives callback failure', async () => {
  const root = await project(), failure = new Error('simulated-crash'); let observedFailure: unknown;
  try { await withInstallationJournal(root, options, async session => {
    const absent = await session.observe(); expect(absent).toEqual({ generation: 'absent', record: null });
    const written = await session.write(absent, payload(root)); expect(written.record).toMatchObject({ schemaVersion: 2, phase: 'pending', recovery: { approval: { status: 'recorded' } } });
    throw failure;
  }); } catch (error) { observedFailure = error; }
  expect(observedFailure).toBe(failure);
  await withInstallationJournal(root, options, async session => {
    const observed = await session.observe(); expect(observed.record).toMatchObject({ transactionId: 'transaction-1', phase: 'pending' });
    expect((await session.observe()).generation).toBe(observed.generation);
  });
  expect((await readdir(join(root, '.deckent/installation'))).filter(name => name.includes('.tmp'))).toEqual([]);
});

it('compares the expected generation again at write time', async () => {
  const root = await project(); let absent: BootstrapObservation | undefined;
  const current = await withInstallationJournal(root, options, async session => {
    absent = await session.observe(); return session.write(absent, payload(root));
  });
  await expect(withInstallationJournal(root, options, async session => session.write(absent!, payload(root, 2))))
    .rejects.toMatchObject({ code: 'INSTALLATION_JOURNAL_CONFLICT' });
  await withInstallationJournal(root, options, async session => {
    const next = await session.write(current, payload(root, 2)); expect(next.record?.updatedAtMs).toBe(2);
  });
});

it('serializes actual concurrent callbacks through the fixed config writer lock', async () => {
  const root = await project(); let release!: () => void; let secondEntered = false;
  const held = new Promise<void>(resolve => { release = resolve; }); let entered!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  const first = withInstallationJournal(root, options, async () => { entered(); await held; }); await firstEntered;
  const second = withInstallationJournal(root, options, async () => { secondEntered = true; });
  await new Promise(resolve => setTimeout(resolve, 75)); expect(secondEntered).toBe(false);
  release(); await Promise.all([first, second]); expect(secondEntered).toBe(true);
});

it('returns a typed bounded busy hold without entering the losing callback, then admits a fresh call after release', async () => {
  const root = await project(); let release!: () => void, loserEntered = false, retryEntered = false;
  const held = new Promise<void>(resolve => { release = resolve; }); let entered!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  const first = withInstallationJournal(root, options, async () => { entered(); await held; }); await firstEntered;
  try {
    await expect(withInstallationJournal(root, { timeoutMs: 25 }, async () => { loserEntered = true; }))
      .rejects.toMatchObject({ code: 'INSTALLATION_JOURNAL_BUSY' });
    expect(loserEntered).toBe(false);
  } finally { release(); await first; }
  await withInstallationJournal(root, { timeoutMs: 25 }, async () => { retryEntered = true; });
  expect(retryEntered).toBe(true);
});

it('serializes overlapping writes in one session so the same expected generation cannot win twice', async () => {
  const root = await project();
  await expect(withInstallationJournal(root, options, async session => {
    const absent = await session.observe(); const first = session.write(absent, payload(root));
    const second = session.write(absent, payload(root, 2)); await first; await second;
  })).rejects.toMatchObject({ code: 'INSTALLATION_JOURNAL_CONFLICT' });
  await withInstallationJournal(root, options, async session => { expect((await session.observe()).record?.updatedAtMs).toBe(1); });
});

it('expires an escaped session after its callback returns', async () => {
  const root = await project(); let escaped: InstallationJournalSession | undefined;
  await withInstallationJournal(root, options, async session => { escaped = session; });
  await expect(escaped!.observe()).rejects.toMatchObject({ code: 'INSTALLATION_JOURNAL_EXPIRED' });
  await expect(escaped!.write({ generation: 'absent', record: null }, payload(root))).rejects.toMatchObject({ code: 'INSTALLATION_JOURNAL_EXPIRED' });
});

it('drains an unawaited write before releasing the config lock and expiring the session', async () => {
  const root = await project();
  await withInstallationJournal(root, options, async session => {
    const absent = await session.observe(); void session.write(absent, payload(root));
  });
  await withInstallationJournal(root, options, async session => {
    expect((await session.observe()).record).toMatchObject({ transactionId: 'transaction-1', phase: 'pending' });
  });
});

it('snapshots the expected generation and encoded payload when write is admitted', async () => {
  const root = await project();
  await withInstallationJournal(root, options, async session => {
    const expected = { ...(await session.observe()) };
    const supplied = payload(root);
    const writing = session.write(expected, supplied);
    (expected as { generation: string }).generation = 'mutated-after-admission';
    (supplied as { updatedAtMs: number }).updatedAtMs = 99;
    const written = await writing;
    expect(written.record?.updatedAtMs).toBe(1);
  });
});

it('propagates an unawaited write failure instead of reporting callback success', async () => {
  const root = await project();
  await expect(withInstallationJournal(root, options, async session => {
    const absent = await session.observe();
    void session.write(absent, { ...payload(root), recovery: { invalid: undefined } } as unknown as BootstrapJournalPayload);
  })).rejects.toMatchObject({ code: 'INSTALLATION_JOURNAL_INVALID' });
  await withInstallationJournal(root, options, async session => { expect(await session.observe()).toEqual({ generation: 'absent', record: null }); });
});

it('immediately observes an unawaited observe rejection and still poisons the transaction', async () => {
  const root = await project();
  await withInstallationJournal(root, options, async session => {
    const absent = await session.observe(); await session.write(absent, payload(root));
  });
  await chmod(join(root, '.deckent/installation/journal.json'), 0o644);
  await expect(withInstallationJournal(root, options, async session => {
    void session.observe();
    await new Promise(resolve => setTimeout(resolve, 25));
  })).rejects.toMatchObject({ code: 'INSTALLATION_JOURNAL_UNSAFE' });
});

it('rejects unsafe existing bootstrap directories without repairing their mode', async () => {
  const root = await project(); await chmod(root, 0o777);
  await expect(withInstallationJournal(root, options, async () => undefined)).rejects.toMatchObject({ code: 'INSTALLATION_JOURNAL_UNSAFE' });
  expect((await stat(root)).mode & 0o777).toBe(0o777);
});

it('preflights invalid recovery data without replacing the current journal', async () => {
  const root = await project(); const current = await withInstallationJournal(root, options, async session => {
    const absent = await session.observe(); return session.write(absent, payload(root));
  });
  await expect(withInstallationJournal(root, options, async session => {
    const invalid = { ...payload(root, 2), recovery: { bad: undefined } } as unknown as BootstrapJournalPayload;
    return session.write(current, invalid);
  })).rejects.toMatchObject({ code: 'INSTALLATION_JOURNAL_INVALID' });
  await withInstallationJournal(root, options, async session => { expect((await session.observe()).generation).toBe(current.generation); });
});

it('writes and reopens group-custodied journal ancestry while keeping journal bytes private', async () => {
  const root = await project(); await chmod(root, 0o775);
  const initial = await withInstallationJournal(root, options, async session => session.write(await session.observe(), payload(root)));
  const bootstrap = join(root, '.deckent'), directory = join(bootstrap, 'installation'), path = join(directory, 'journal.json');
  await chmod(bootstrap, 0o775); await chmod(directory, 0o775);
  const updated = await withInstallationJournal(root, options, async session => session.write(initial, payload(root, 2)));
  await withInstallationJournal(root, options, async session => expect((await session.observe()).generation).toBe(updated.generation));
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  for (const parent of [root, bootstrap, directory]) expect((await stat(parent)).mode & 0o777).toBe(0o775);
  const bytes = await readFile(path);
  await chmod(directory, 0o777);
  await expect(withInstallationJournal(root, options, async session => session.observe())).rejects.toMatchObject({ code: 'INSTALLATION_JOURNAL_UNSAFE' });
  expect(await readFile(path)).toEqual(bytes);
});
