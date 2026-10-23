import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileBrainQuotaWaitStore, BRAIN_QUOTA_WAIT_STORE_LIMITS } from '#adapters/index.js';
import type { BrainQuotaWaitRecord } from '#domain/index.js';

// f4 item 1: the Brain quota wait presence store (state/brain-waits): one 0600 file per plan command, removed when the wait ends, hidden past its
// planned end plus the registry stale bound or once its writer process is gone; the writer prunes, the reader creates and deletes nothing.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const NOW = 1_800_000_000_000;
const wait = (commandId: string, untilMs = NOW + 10_000, scopeId = 's'): BrainQuotaWaitRecord => ({ schemaVersion: 1, scopeId, commandId, attempt: 2, maxAttempts: 2,
  sinceMs: NOW, resetsAtMs: untilMs, untilMs, after: { commandId: 'a'.repeat(64), invocationId: 'inv-1' } });
async function store(now = () => NOW, limits = BRAIN_QUOTA_WAIT_STORE_LIMITS) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-brain-waits-')); roots.push(root);
  return { root, store: new FileBrainQuotaWaitStore(async () => root, now, limits) };
}
const files = async (root: string) => (await readdir(root)).sort();

describe('f4 FileBrainQuotaWaitStore', () => {
  it('begin writes one 0600 record per plan command (a second begin replaces it); end removes it; list shows only live ones', async () => {
    const { root, store: s } = await store();
    await s.begin(wait('plan-a')); await s.begin({ ...wait('plan-a'), attempt: 2, untilMs: NOW + 20_000 }); await s.begin(wait('plan-b'));
    expect((await files(root)).filter(name => name.endsWith('.json'))).toHaveLength(2);
    for (const name of await files(root)) expect((await stat(join(root, name))).mode & 0o777).toBe(0o600);
    expect((await s.list()).records.map(record => [record.commandId, record.untilMs])).toEqual([['plan-a', NOW + 20_000], ['plan-b', NOW + 10_000]]);
    await s.end('s', 'plan-a'); await s.end('s', 'plan-a');
    expect((await s.list()).records.map(record => record.commandId)).toEqual(['plan-b']);
  });
  it('negative: a record past its planned end plus the stale bound is hidden, and the next begin prunes it', async () => {
    let now = NOW;
    const { root, store: s } = await store(() => now);
    await s.begin(wait('old', NOW + 1_000));
    now = NOW + 1_000 + BRAIN_QUOTA_WAIT_STORE_LIMITS.staleAfterMs - 1; expect((await s.list()).records).toHaveLength(1);
    now += 1; expect((await s.list()).records).toEqual([]);
    expect(await files(root)).toHaveLength(1);
    await s.begin(wait('new', now + 5_000));
    expect((await s.list()).records.map(record => record.commandId)).toEqual(['new']); expect(await files(root)).toHaveLength(1);
  });
  it('negative: a record whose writer process is gone (a crash) is hidden at once and pruned; a damaged or foreign file is never a wait', async () => {
    const { root, store: s } = await store();
    await s.begin(wait('live'));
    const [name] = await files(root);
    const text = JSON.stringify({ schemaVersion: 1, record: wait('crashed'), expiresAtMs: NOW + 60_000, writer: { pid: 2 ** 22 + 7, host: (await import('node:os')).hostname() } });
    await writeFile(join(root, 'b'.repeat(64) + '.json'), text, { mode: 0o600 });
    await writeFile(join(root, 'c'.repeat(64) + '.json'), '{"schemaVersion":1,"record":', { mode: 0o600 });
    await writeFile(join(root, 'd'.repeat(64) + '.json'), JSON.stringify({ schemaVersion: 1, record: { ...wait('bad'), extra: 1 }, expiresAtMs: NOW + 60_000, writer: { pid: process.pid, host: 'h' } }));
    expect((await s.list()).records.map(record => record.commandId)).toEqual(['live']);
    await s.begin(wait('second'));
    expect((await files(root)).filter(entry => entry !== name)).toHaveLength(1);
  });
  it('a temporary file a crashed writer left is removed only once older than the stale bound', async () => {
    const { root, store: s } = await store(() => Date.now());
    const young = `.${'e'.repeat(64)}.json.00000000-0000-0000-0000-000000000001.tmp`, old = `.${'f'.repeat(64)}.json.00000000-0000-0000-0000-000000000002.tmp`;
    await writeFile(join(root, young), 'x'); await writeFile(join(root, old), 'x');
    const past = (Date.now() - BRAIN_QUOTA_WAIT_STORE_LIMITS.staleAfterMs - 5_000) / 1000; await utimes(join(root, old), past, past);
    await s.begin(wait('plan', Date.now() + 5_000));
    expect(await files(root)).toContain(young); expect(await files(root)).not.toContain(old);
  });
  it('negative: past maxEntries live waits a begin is refused (bounded); the reader reads at most maxEntries files and says it was cut', async () => {
    const limits = { ...BRAIN_QUOTA_WAIT_STORE_LIMITS, maxEntries: 2 }, { store: s } = await store(() => NOW, limits);
    await s.begin(wait('one')); await s.begin(wait('two'));
    await expect(s.begin(wait('three'))).rejects.toThrow('BRAIN_QUOTA_WAIT_STORE_FULL');
    await s.begin({ ...wait('two'), untilMs: NOW + 30_000 });
    expect(await s.list()).toMatchObject({ truncated: false });
  });
  it('negative: no store yet (null directory) is no wait; the reader creates nothing and end is a no-op; begin refuses', async () => {
    const empty = new FileBrainQuotaWaitStore(async () => null, () => NOW);
    expect(await empty.list()).toEqual({ records: [], truncated: false });
    await empty.end('s', 'x');
    await expect(empty.begin(wait('x'))).rejects.toThrow('BRAIN_QUOTA_WAIT_STORE_UNAVAILABLE');
  });
});
