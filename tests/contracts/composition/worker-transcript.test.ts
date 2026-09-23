import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectConfiguredWorkerTranscript } from '../../../src/index.js';
import { main as cliMain } from '#surfaces/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { FileArtifactStore, createNormalizerState, flushUnmapped, normalizeClaudeLine } from '#adapters/index.js';
import { clearConfigCache, productResourcePath, prepareProductDirectory } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a-1', generation: 1, layoutRevision: 'layout' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-transcript-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: join(root, 'home') } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') } }));
  const opened = await openConfiguredAttemptStore(project, options);
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const policy = (actions: string[]) => writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'attempt', effect: 'allow', actions, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } }] }), { mode: 0o600 });
  await policy(['read-output']);
  // Seal a real normalized stream exactly as execution does: artifact + ledger record.
  const lines = (await readFile(new URL('../../fixtures/worker-events/claude-stream.jsonl', import.meta.url), 'utf8')).split('\n').filter(Boolean);
  const state = createNormalizerState([], 0);
  const events = [...lines.flatMap((line, index) => normalizeClaudeLine(line, state, index * 250)), ...flushUnmapped(state, 99_000)];
  const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 1_048_576 });
  const receipt = await artifacts.put('s', Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n'));
  await opened.store.saveWorkerEventLog({ schemaVersion: 1, identity, events: receipt, eventCount: events.length, sealedAt: 1 });
  opened.store.close();
  return { project, options, policy, count: events.length };
}

it('reads a sealed worker transcript through SDK and CLI with a deterministic summary and a human-readable timeline', async () => {
  const f = await fixture();
  const sdk = await inspectConfiguredWorkerTranscript(f.project, identity, f.options);
  expect(sdk).toMatchObject({ sealed: { eventCount: f.count }, summary: { provider: 'claude', outcome: 'success', turns: 4, filesTouched: ['hello.txt'],
    tokens: { input: 26, output: 859, cacheRead: 65832, cacheWrite: 12854 } }, activity: { phase: 'finished' } });
  const out: string[] = [];
  const code = await cliMain(['task', 'transcript', '--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a-1', '--generation', '1', '--layout-revision', 'layout', '--lang', 'tr'],
    { root: f.project, env: f.options.env, stdout: { write: (value: string) => { out.push(value); } }, inspectWorkerTranscript: inspectConfiguredWorkerTranscript });
  expect(code).toBe(0);
  const text = out.join('');
  expect(text).toContain('Worker claude · claude-haiku-4-5-20251001 · 4 tur');
  expect(text).toContain('önbellek okuma 65832');
  expect(text).toMatch(/düzenliyor\s+hello\.txt/); expect(text).toMatch(/okuyor\s+hello\.txt/); expect(text).toContain('çalıştırıyor');
  expect(text).toContain('Sonuç ve kabul için otorite süreç çıkışı');
  expect(await inspectConfiguredWorkerTranscript(f.project, { ...identity, attemptId: 'other' }, f.options)).toMatchObject({ sealed: null, summary: null });
  await f.policy(['execute']);
  await expect(inspectConfiguredWorkerTranscript(f.project, identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});
