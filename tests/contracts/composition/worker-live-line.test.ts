import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectConfiguredWorkers } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { createNormalizerState, flushUnmapped, normalizeClaudeLine, openSqliteAttemptStore } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { workerEventSchema, type WorkerEvent } from '#domain/index.js';
import { formatWorkerLine, workerReportToLedgerEntries, type WorkLedgerWorkerEntry } from '#surfaces/core/terminal/index.js';
import { workSurfaceLabels } from '#surfaces/core/cli/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a-1', generation: 1, layoutRevision: 'l' };

async function claudeEvents(): Promise<WorkerEvent[]> {
  const lines = (await readFile(new URL('../../fixtures/worker-events/claude-stream.jsonl', import.meta.url), 'utf8')).split('\n').filter(Boolean);
  const state = createNormalizerState([], 0);
  return [...lines.flatMap((line, index) => normalizeClaudeLine(line, state, index * 250)), ...flushUnmapped(state, 99_000)]
    .map(event => workerEventSchema.parse(event)) as WorkerEvent[];
}

/** A bound (never launched) dispatch whose attempt directory holds host-written `worker.events`; no Docker is needed. */
async function fixture(maxFileBytes = 65_536) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dn-live-line-'))); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const attempt = join(root, 'attempt'); await mkdir(attempt, { mode: 0o700 });
  const configPath = join(project, '.deckent/config.json');
  await writeFile(configPath, JSON.stringify({ layout: { root: join(root, 'data') }, inspection: { workers: { maxFileBytes } } }));
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles);
  try {
    await admitRunAttempts(store, [identity]);
    await store.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: join(attempt, 'workspace'), argv: ['worker'] } }));
  } finally { store.close(); }
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'live', restrictions: [], grants: [
    { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'output', effect: 'allow', actions: ['read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } }] }), { mode: 0o600 });
  /** Host format: one `{receivedAt, event}` object per line (0600); extra raw lines model torn or corrupt writes. */
  const events = (lines: readonly string[]) => writeFile(join(attempt, 'worker.events'), lines.join('\n') + '\n', { mode: 0o600 });
  const inspect = async () => workerReportToLedgerEntries(await inspectConfiguredWorkers(project, { schemaVersion: 1, scopeId: 's' }, options), 'live')
    .filter((entry): entry is WorkLedgerWorkerEntry => entry.kind === 'worker');
  return { events, inspect };
}

describe.skipIf(process.platform !== 'linux')('worker live line from a real worker.events stream', () => {
  it('surfaces what a Claude worker is doing, its host-clock age, tokens, cache and dropped events through inspectConfiguredWorkers', async () => {
    const f = await fixture(); const all = await claudeEvents();
    const upToWrite = all.slice(0, all.findIndex(event => event.kind === 'tool.call' && event.toolClass === 'write') + 1);
    const sent = Date.now() - 12_000;
    const lines = upToWrite.map((event, index) => JSON.stringify({ receivedAt: sent + index, event }));
    const dropped = { schemaVersion: 1, sequence: upToWrite.length + 1, atMs: 99_999, kind: 'dropped', reason: 'invalid', count: 2 };
    await f.events(['{"receivedAt": 1, "event": {"kind": "tool.ca', ...lines, 'not json', JSON.stringify({ receivedAt: sent + upToWrite.length, event: dropped })]);
    const [worker] = await f.inspect();
    expect(worker).toMatchObject({ ordinal: 1, attempt: identity, live: { phase: 'editing', target: 'hello.txt', dropped: 2, eventsTruncated: false } });
    const tr = formatWorkerLine(worker!, workSurfaceLabels('tr').workerLine).text;
    expect(tr).toMatch(/^worker 1 · claude claude-haiku-4-5-20251001 · düzenliyor hello\.txt · 1[1-4] sn önce · [\d,]+k? token \(önbellek %\d+\) · 2 olay düşürüldü$/);
    expect(formatWorkerLine(worker!, workSurfaceLabels('en').workerLine).text).toMatch(/editing hello\.txt · 1[1-4] s ago · .* tokens \(cache \d+%\) · 2 events dropped$/);
  });

  it('labels the finished outcome as worker reported and marks a tail-truncated event log; partial first lines never parse', async () => {
    const f = await fixture(2_048); const all = await claudeEvents();
    await f.events(all.map((event, index) => JSON.stringify({ receivedAt: Date.now() - 5_000 + index, event })));
    const [worker] = await f.inspect();
    expect(worker?.live).toMatchObject({ phase: 'finished', outcome: 'success', eventsTruncated: true });
    const text = formatWorkerLine(worker!, workSurfaceLabels('tr').workerLine).text;
    expect(text).toContain('bitti (worker bildirdi)');
    expect(text).toContain('olaylar kırpıldı');
  });

  it('keeps the plain process line when the worker wrote no events', async () => {
    const f = await fixture();
    const [worker] = await f.inspect();
    expect(worker?.live).toBeUndefined();
    expect(formatWorkerLine(worker!, workSurfaceLabels('en').workerLine)).toEqual({ text: 'worker 1 · unknown · unknown', tone: 'muted' });
  });
});
