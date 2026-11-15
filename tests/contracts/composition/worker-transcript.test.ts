import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { memoryDistillerPrincipal, summarizeWorkerEvents, workerActivityPhase, workerEventSchema } from '#domain/index.js';
import { inspectConfiguredWorkerTranscript } from '../../../src/index.js';
import { DispatchPolicyAuthorization, WorkerTranscriptApplication } from '#engine/index.js';
import { main as cliMain } from '#surfaces/index.js';
import { openConfiguredAttemptStore } from '../support/configured-open.js';
import { FileArtifactStore, createNormalizerState, flushUnmapped, normalizeClaudeLine } from '#adapters/index.js';
import { clearConfigCache, productResourcePath, prepareProductDirectory } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a-1', generation: 1, layoutRevision: 'layout' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-transcript-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') } }));
  const opened = await openConfiguredAttemptStore(project, options);
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const policy = (actions: string[]) => writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'attempt', effect: 'allow', actions, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } }] }), { mode: 0o600 });
  await policy(['read-output']);
  // Seal a real normalized stream exactly as execution does: artifact + ledger record.
  const lines = (await readFile(new URL('../../fixtures/worker-events/claude-stream.jsonl', import.meta.url), 'utf8')).split('\n').filter(Boolean);
  const state = createNormalizerState([], 0);
  const original = [...lines.flatMap((line, index) => normalizeClaudeLine(line, state, index * 250)), ...flushUnmapped(state, 99_000)];
  const observation = workerEventSchema.parse({ schemaVersion: 1, sequence: original.length + 1, atMs: 100000, kind: 'cli.observation',
    observation: { schemaVersion: 1, cliVersion: 'fixture-cli-version', builtinPlugins: { names: ['fixture-private-plugin'], omitted: 2 },
      paidExtraUsage: { kind: 'overage', status: 'rejected', window: 'five_hour', resetsAtMs: null } } });
  // beta.2.1 retained body and a host-paid suffix after the loss marker; never a beta.2 producer.
  const events = [{ ...observation, atMs: 0 }, ...original, workerEventSchema.parse({ schemaVersion: 1, sequence: original.length + 2, atMs: 100000, kind: 'dropped', reason: 'byte-cap', count: 1 }),
    { ...observation, sequence: original.length + 3 }].map((event, index) => workerEventSchema.parse({ ...event, sequence: index + 1 }));
  expect(summarizeWorkerEvents(events)).toEqual({ ...summarizeWorkerEvents(original), events: events.length, dropped: 1 });
  expect(workerActivityPhase(events)).toEqual(workerActivityPhase(original));
  const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 1_048_576 });
  const receipt = await artifacts.put('s', Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n'));
  await opened.store.saveWorkerEventLog({ schemaVersion: 1, identity, events: receipt, eventCount: events.length, sealedAt: 1 });
  opened.store.close();
  return { project, options, policy, artifacts, count: events.length };
}

it.skipIf(process.platform === 'win32')('requires POSIX managed storage; MANAGED_FILE_UNSUPPORTED — reads a sealed worker transcript through SDK and CLI with a deterministic summary and a human-readable timeline', async () => {
  const f = await fixture();
  const sdk = await inspectConfiguredWorkerTranscript(f.project, identity, f.options);
  expect(JSON.stringify(sdk.events)).not.toContain('fixture-private-plugin');
  expect(sdk.events.filter(event => event.kind === 'cli.observation')).toHaveLength(2);
  expect(sdk.events.find(event => event.kind === 'cli.observation')).toMatchObject({ observation: { builtinPlugins: { names: [], omitted: 3 } } });
  expect(sdk).toMatchObject({ sealed: { eventCount: f.count }, summary: { provider: 'claude', outcome: 'success', turns: 4, filesTouched: ['hello.txt'],
    tokens: { input: 26, output: 859, cacheRead: 65832, cacheWrite: 12854 } }, activity: { phase: 'finished' } });
  const out: string[] = [];
  const code = await cliMain(['task', 'transcript', '--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a-1', '--generation', '1', '--layout-revision', 'layout', '--lang', 'tr'],
    { root: f.project, env: f.options.env, stdout: { write: (value: string) => { out.push(value); } }, inspectWorkerTranscript: inspectConfiguredWorkerTranscript });
  expect(code).toBe(0);
  const text = out.join('');
  expect(text).toContain('İşçi claude · claude-haiku-4-5-20251001 · 4 tur');
  expect(text).toContain('önbellek okuma 65832');
  expect(text).toMatch(/düzenliyor\s+hello\.txt/); expect(text).toMatch(/okuyor\s+hello\.txt/); expect(text).toContain('çalıştırıyor');
  expect(text).toContain('Sonuç ve kabul için otorite süreç çıkışı');
  expect(text).toContain('3 ad; okumak için içerik izni gerekir');
  expect(text).toContain('Sağlayıcı hesabınızın ücretli ek kullanımı devrede');
  expect(text).not.toContain('fixture-private-plugin'); expect(text).not.toContain('fixture-cli-version');
  out.length = 0;
  expect(await cliMain(['task', 'transcript', '--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a-1', '--generation', '1', '--layout-revision', 'layout', '--json'],
    { root: f.project, env: f.options.env, stdout: { write: value => { out.push(String(value)); } }, inspectWorkerTranscript: inspectConfiguredWorkerTranscript })).toBe(0);
  expect(out.join('')).not.toContain('fixture-private-plugin');
  expect(JSON.parse(out.join('')).events.find((event: { kind: string }) => event.kind === 'cli.observation').observation.builtinPlugins).toEqual({ names: [], omitted: 3 });
  const reopened = await openConfiguredAttemptStore(f.project, f.options);
  const distiller = memoryDistillerPrincipal({ issuer: hostname(), subject: String(userInfo().uid) }, ['s']);
  const authorization = new DispatchPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: 'distiller', restrictions: [], grants: [{
    id: 'distill', effect: 'allow', actions: ['read-output'], scopes: ['s'], principals: [{ issuer: distiller.issuer, subject: distiller.subject }], resource: { kind: 'attempt', ids: 'all' } }] }; } });
  try {
    const app = new WorkerTranscriptApplication(reopened.store, f.artifacts, authorization);
    out.length = 0;
    expect(await cliMain(['task', 'transcript', '--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a-1', '--generation', '1', '--layout-revision', 'layout', '--json'],
      { root: f.project, env: f.options.env, stdout: { write: value => { out.push(String(value)); } }, inspectWorkerTranscript: async (_root, input) => app.inspect(input, distiller) })).toBe(0);
    expect(out.join('')).not.toContain('fixture-private-plugin');
    expect(JSON.parse(out.join('')).events.find((event: { kind: string }) => event.kind === 'cli.observation').observation.builtinPlugins).toEqual({ names: [], omitted: 3 });
  } finally { reopened.store.close(); }
  expect(await inspectConfiguredWorkerTranscript(f.project, { ...identity, attemptId: 'other' }, f.options)).toMatchObject({ sealed: null, summary: null });
  await f.policy(['execute']);
  await expect(inspectConfiguredWorkerTranscript(f.project, identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});
