import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { clearConfigCache } from '#platform/index.js';

/** WORKER-CURRENCY-2: requested → init → usage → verdict on `workers list|watch`, `run inspect` and `task transcript` (human en/tr + JSON). */
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const requested = { channelId: 'claude-cli-subscription', modelId: 'claude-sonnet-5-5', auxiliaryModelIds: ['claude-haiku-4-5-20251001'] };
const substituted = { provider: 'claude', requested, init: 'claude-sonnet-5-5', usage: ['claude-sonnet-5-5', 'claude-opus-5-5'], verdict: 'substituted',
  unexpected: ['claude-opus-5-5'], evidence: 'sealed' } as const;
const codex = { provider: 'codex', requested: { channelId: 'codex-cli', modelId: 'gpt-exact-1', auxiliaryModelIds: [] }, init: null, usage: null,
  verdict: 'unverified', unexpected: [], evidence: 'sealed' } as const;
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'dn-worker-model-cli-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') } }));
  return root;
}
async function run(argv: string[], handlers: Record<string, unknown>, root: string) {
  const out: string[] = [];
  const code = await main(argv, { root, env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h') }, initialize() {}, stdout: { write(value: string) { out.push(value); } }, stderr: { write() {} }, ...handlers } as never);
  return { code, text: out.join('') };
}

it('workers list prints one model row per pinned worker in en and tr, and JSON carries the typed row', async () => {
  const root = await project();
  const report = { schemaVersion: 1, observedAt: 0, scopeId: 's', control: 'observe-only', sources: [{ id: 'current', path: root, kind: 'next-project', status: 'available',
    nextAfter: null, truncated: false, workers: [
      { taskId: 't', identity, authority: 'next-ledger', provider: 'claude', workspace: null, process: 'exited', handle: null, terminal: null, outputRecorded: true,
        patchRecorded: false, files: null, diagnostics: [], model: substituted },
      { taskId: 'u', identity: { ...identity, taskId: 'u' }, authority: 'next-ledger', provider: 'codex', workspace: null, process: 'exited', handle: null, terminal: null,
        outputRecorded: true, patchRecorded: false, files: null, diagnostics: [], model: codex },
      { taskId: 'plain', identity: null, authority: 'legacy-activity', provider: 'docker', workspace: null, process: 'exited', handle: null, terminal: null,
        outputRecorded: false, patchRecorded: false, files: null, diagnostics: [] }] }] };
  const handlers = { async inspectWorkers() { return report; } };
  const english = await run(['workers', 'list', '--scope', 's', '--lang', 'en'], handlers, root);
  expect(english.code).toBe(0);
  expect(english.text).toContain('  Task t: Model on claude-cli-subscription: requested claude-sonnet-5-5 (declared auxiliary: claude-haiku-4-5-20251001) → init claude-sonnet-5-5'
    + ' → usage claude-sonnet-5-5, claude-opus-5-5 → SUBSTITUTED (undeclared model; attempt not accepted) [sealed log] · undeclared models used: claude-opus-5-5');
  expect(english.text).toContain('  Task u: Model on codex-cli: requested gpt-exact-1 (declared auxiliary: none) → init none → usage none → unverified [sealed log]');
  expect(english.text).not.toContain('Task plain:');
  const turkish = await run(['workers', 'watch', '--scope', 's', '--samples', '1', '--lang', 'tr'], handlers, root);
  expect(turkish.text).toContain('  Görev t: claude-cli-subscription kanalında model: istenen claude-sonnet-5-5');
  expect(turkish.text).toContain('İKAME EDİLDİ (beyan edilmemiş model; deneme kabul edilmez) [mühürlü günlük] · beyan edilmemiş kullanılan modeller: claude-opus-5-5');
  expect(turkish.text).toContain('→ doğrulanmadı [mühürlü günlük]');
  const json = await run(['workers', 'list', '--scope', 's', '--json'], handlers, root);
  expect(JSON.parse(json.text).sources[0].workers.map((worker: { model?: unknown }) => worker.model ?? null)).toEqual([substituted, codex, null]);
});

it('run inspect and the transcript report view show the same row; the transcript states the evidence limit', async () => {
  const root = await project();
  const view = { schemaVersion: 3, state: { kind: 'running' }, runId: 'r', scopeId: 's', layoutRevision: 'l', registryRevision: 'reg', criteria: [], revision: 3, cancellationRequested: false,
    tasks: [{ id: 't', kind: 'claude', dependencies: [], acceptanceCriteria: ['exit'], profile: { id: 'claude', version: 1 }, phase: 'failed', unresolvedEffects: false }] };
  const inspectRun = async () => ({ schemaVersion: 1, layout: {}, run: view, models: [{ ...substituted, taskId: 't', attemptId: 'a' }] });
  const english = await run(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', 'en'], { inspectRun }, root);
  expect(english.text).toContain('  Recorded state: Failed');
  expect(english.text).toContain('  Attempt a: Model on claude-cli-subscription: requested claude-sonnet-5-5');
  const turkish = await run(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', 'tr'], { inspectRun }, root);
  expect(turkish.text).toContain('  Deneme a: claude-cli-subscription kanalında model');
  expect(JSON.parse((await run(['run', 'inspect', '--scope', 's', '--id', 'r', '--json'], { inspectRun }, root)).text).models[0]).toMatchObject({ verdict: 'substituted', taskId: 't' });
  const transcript = { schemaVersion: 2, identity, finalReport: undefined, sealed: null, summary: null, activity: null, events: [], model: { ...substituted, verdict: 'pending', evidence: 'live', unexpected: [] } };
  const args = ['task', 'transcript', '--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a', '--layout-revision', 'l', '--generation', '1'];
  const report = await run([...args, '--lang', 'en'], { async inspectWorkerTranscript() { return transcript; } }, root);
  expect(report.text).toContain('→ pending [live, not sealed yet]');
  expect(report.text).toContain('it is not provider attestation');
  const raporTr = await run([...args, '--lang', 'tr'], { async inspectWorkerTranscript() { return transcript; } }, root);
  expect(raporTr.text).toContain('sağlayıcı onayı (attestation) değildir');
});
