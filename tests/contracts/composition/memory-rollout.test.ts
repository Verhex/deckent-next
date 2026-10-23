import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelCatalog, createRun } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '../../../src/composition/core/config/index.js';
import { proposeConfiguredMemory, verifyConfiguredMemory } from '#composition/core/memory/index.js';
import { inspectConfiguredMemoryRollout } from '#composition/core/memory-rollout/index.js';
import { clearConfigCache, loadConfig } from '#platform/index.js';
import type { MemoryRolloutStatus } from '#engine/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';

// S4B-7 through the real composition (config file, policy file, integrity key, SQLite ledger with the memory journal and the audit chain):
// `deckent memory rollout` measures the phase 3 criteria from the sealed `memory-context` seals of real shadow admissions, and every configured
// config write refuses the protected live switch (`memoryAutomation.context.mode on`, `…verification.mode on`) until its criteria hold —
// nothing is written; a step back is never measured. No model is called.
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const invocation = (context: readonly { id: string; version: number; text: string }[]) => ({ provider: 'claude', cliVersion: '2.1.293 (Claude Code)',
  discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended', maxTurns: 40, composition: { persona: { id: 'implementer', version: 1, text: 'You implement exactly one card.' }, context } });
const registry = (context: readonly { id: string; version: number; text: string }[]) => ({ schemaVersion: 1 as const, revision: 's4b7',
  profiles: [{ id: 'coding', version: 1, adapter: { id: 'native-coding-template', version: 1 }, parameters: { schemaVersion: 1, docker, invocation: invocation(context) } }],
  kinds: [{ kind: 'coding', profile: { id: 'coding', version: 1 } }], evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] });
const workInput = { schemaVersion: 1, task: 'Fix the invoice approval queue for invoices without a delivery note.', scope: { paths: ['src/invoice/**'] },
  acceptance: 'Invoices without a delivery note reach the approval queue.', model: { channelId: SEED_CHANNEL, modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] } };
const run = (runId: string) => ({ schemaVersion: 1 as const, commandId: `create-${runId}`, scopeId: 's', runId, graph: { schemaVersion: 3, revision: 1,
  tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'], workInput }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] } });

async function seeded(context: readonly { id: string; version: number; text: string }[] = [{ id: 'repo-tooling', version: 2, text: 'Use npm scripts.' }]) {
  const project = await mkdtemp(join(tmpdir(), 'dn-memory-rollout-')); roots.push(project); const data = join(project, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true }); const options = { env: { HOME: join(project, 'h'), PATH: process.env.PATH ?? '/usr/bin:/bin' } };
  const config = { layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: registry(context) },
    memoryAutomation: { extraction: { mode: 'on' }, verification: { mode: 'shadow' }, context: { mode: 'shadow' } } };
  const path = join(project, '.deckent/config.json');
  await writeFile(path, JSON.stringify(config));
  const opened = await openConfiguredAttemptStore(project, options);
  try { await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); } finally { opened.store.close(); }
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'catalog', effect: 'allow', actions: ['activate', 'deactivate'], scopes: 'all', principals, resource: { kind: 'model-activation', ids: 'all' } },
    { id: 'memory', effect: 'allow', actions: ['inspect', 'propose', 'verify'], scopes: ['s'], principals, resource: { kind: 'memory', ids: 'all' } },
    { id: 'config', effect: 'allow', actions: ['write'], scopes: ['s'], principals, resource: { kind: 'config', ids: 'all' } },
  ] }), { mode: 0o600 });
  let sequence = 0;
  const catalog = (command: Record<string, unknown>) => applyModelCatalog(project, { schemaVersion: 1, commandId: `catalog-${++sequence}`, scopeId: 's', ...command }, options);
  await catalog({ action: 'register', catalog: await seedCatalog() });
  await catalog({ action: 'activate', channelId: SEED_CHANNEL, modelId: null, expectedRevision: 0 });
  await catalog({ action: 'activate', channelId: SEED_CHANNEL, modelId: 'claude-sonnet-5-5', expectedRevision: 0 });
  await proposeConfiguredMemory(project, { schemaVersion: 1, commandId: 'm1', scopeId: 's', content: { kind: 'fact', title: 'Invoice approval',
    body: 'Invoices without a delivery note go to the approval queue.', tags: [], lesson: null }, origin: { kind: 'human', ref: null } }, options);
  await verifyConfiguredMemory(project, { schemaVersion: 1, commandId: 'v-m1', scopeId: 's', entryId: 'm1', expectedRevision: 1, basis: { kind: 'human-review', note: 'checked' } }, options,
    { attest: async () => true });
  const events = () => { const db = new DatabaseSync(opened.path, { readOnly: true });
    try { return db.prepare("SELECT record FROM audit_events WHERE kind = 'memory-context' ORDER BY sequence").all().map(row => JSON.parse((row as { record: string }).record).event.subject); } finally { db.close(); } };
  const status = async () => { const result = await inspectConfiguredMemoryRollout(project, 's', options); if (result.status !== 'ok') throw new Error(result.code); return result; };
  const write = async (keyPath: string, value: unknown, commandId: string) => {
    clearConfigCache();
    const principal = await resolveConfiguredConfigPrincipal(project, 's', options);
    return createConfiguredConfigApplication(project, options).set({ keyPath, value, layer: 'project', principal, scopeId: 's', commandId });
  };
  return { project, options, path, events, status, write };
}
const criterion = (status: MemoryRolloutStatus, id: string) => status.view.phases.flatMap(phase => phase.criteria).find(row => row.criterion.id === id)!;

describe.skipIf(process.platform === 'win32')('S4B-7 memory rollout: measured status and protected live switches', () => {
  it('phase 3 is refused (nothing written) until 20 sealed shadow admissions fit; a step back is never measured; then the person switch is written', async () => {
    const f = await seeded();
    await createRun(f.project, run('r0'), f.options);
    expect(f.events()).toEqual([expect.objectContaining({ kind: 'memory-context', mode: 'shadow', delivered: false, fit: true })]);
    const first = await f.status();
    expect(first).toMatchObject({ scopeId: 's', modes: { extraction: 'on', verification: 'shadow', context: 'shadow' }, view: { phase: 2, next: { phase: 3, met: false } } });
    expect(criterion(first, 'context-admissions')).toMatchObject({ met: false, measure: { count: 1 } });
    expect(criterion(first, 'context-integrity')).toMatchObject({ met: true, measure: { count: 0, sample: 1 } });
    const before = await readFile(f.path, 'utf8');
    await expect(f.write('memoryAutomation.context.mode', 'on', 'c-on-1')).rejects.toMatchObject({ code: 'MEMORY_ROLLOUT_CRITERIA_UNMET',
      params: { phase: 3, scope: 's', criteria: 'context-admissions' } });
    await expect(f.write('memoryAutomation', { extraction: { mode: 'on' }, verification: { mode: 'shadow' }, context: { mode: 'on' } }, 'c-on-2'))
      .rejects.toMatchObject({ code: 'MEMORY_ROLLOUT_CRITERIA_UNMET' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    // A step back and a write of another key are never measured.
    await f.write('memoryAutomation.context.mode', 'off', 'c-off');
    await f.write('memoryAutomation.context.mode', 'shadow', 'c-shadow');
    for (let index = 1; index < 20; index++) await createRun(f.project, run(`r${index}`), f.options);
    const ready = await f.status();
    expect(ready.view).toMatchObject({ next: { phase: 3, met: true } });
    expect(criterion(ready, 'context-admissions')).toMatchObject({ met: true, measure: { count: 20 } });
    await f.write('memoryAutomation.context.mode', 'on', 'c-on-3');
    clearConfigCache();
    expect((await loadConfig(f.project, f.options)).memoryAutomation.context.mode).toBe('on');
    expect((await f.status()).view).toMatchObject({ phase: 3, liveUnmet: [], next: { phase: 4, met: false } });
    // Phase 4 has no sealed evaluator evidence here: refused, naming every unmet criterion.
    const refusal = await f.write('memoryAutomation.verification.mode', 'on', 'c-v-on').then(() => null, (error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'MEMORY_ROLLOUT_CRITERIA_UNMET', params: { phase: 4 } });
    expect(String((refusal as { params: { criteria: string } }).params.criteria).split(', ')).toEqual(expect.arrayContaining(['evaluator-agreement', 'evaluator-false-pass', 'injection-corpus']));
  });
  it('a shadow part that would not fit the prompt is sealed with fit false and fails the overflow criterion', async () => {
    const f = await seeded(Array.from({ length: 8 }, (_, index) => ({ id: `part-${index}`, version: 1, text: 'Use npm scripts.' })));
    await createRun(f.project, run('full'), f.options);
    expect(f.events()).toEqual([expect.objectContaining({ mode: 'shadow', delivered: false, fit: false })]);
    expect(criterion(await f.status(), 'context-overflow')).toMatchObject({ met: false, measure: { count: 1, sample: 1 } });
  });
});
