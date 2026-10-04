import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelCatalog, createRun, inspectRun } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { runCommand } from '#surfaces/core/cli/index.js';
import { assertNativeWorkerBinding } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { seedCatalog } from '../support/model-catalog.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const channelId = 'codex-effort-fixture', modelId = 'exact-effort-fixture';
const model = { channelId, modelId, auxiliaryModelIds: [] };
const command = (runId: string, kind: string, effort?: string) => ({ schemaVersion: 1 as const, commandId: `create-${runId}`, scopeId: 's', runId,
  graph: { schemaVersion: 4, revision: 1, tasks: [{ id: 't', kind, dependencies: [], acceptanceCriteria: ['exit'], workInput: {
    schemaVersion: 1, task: 'Review note.txt', scope: { paths: ['note.txt'] }, acceptance: 'Report findings', model, ...(effort ? { effort } : {}),
  } }], criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] } });

/** Real catalog/policy/ledger admission; inspect the persisted profile without starting a worker or service. */
async function fixture(efforts = ['ultra'], ultraTarget = false) {
  const project = await mkdtemp(join(tmpdir(), 'dn-effort-r-')); roots.push(project);
  const data = join(project, 'd'), configPath = join(project, '.deckent/config.json'), options = { env: { HOME: join(project, 'h') } };
  await mkdir(join(project, '.deckent'), { recursive: true });
  const registry = { schemaVersion: 1, revision: 'effort-r', profiles: [{ id: 'native', version: 1, adapter: { id: 'native-coding-template', version: 1 }, parameters: {
    schemaVersion: 1, docker: { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64,
      logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 },
    invocation: { provider: 'codex', cliVersion: 'codex-cli 0.159.2', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended' },
  } }], kinds: ['small', 'design'].map(kind => ({ kind, profile: { id: 'native', version: 1 } })),
  evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }], ...(ultraTarget ? {
    workClasses: { schemaVersion: 1, revision: 'deliberate-ultra', classes: [{ id: 'opt-in', defaultEffort: 'ultra' }], bindings: [{ kind: 'design', classId: 'opt-in' }] },
  } : {}) };
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1,
    ordering: 'input-order', registry } }));
  const { store, path } = await openConfiguredAttemptStore(project, options);
  try { await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); } finally { store.close(); }
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'catalog', effect: 'allow', actions: ['activate'], scopes: 'all', principals, resource: { kind: 'model-activation', ids: 'all' } },
  ] }), { mode: 0o600 });
  const seed = await seedCatalog(), provider = seed.providers[0];
  const catalog = { schemaVersion: 3, revision: 'effort-r-fixture', providers: [{ ...provider, id: channelId, channel: { ...provider.channel, cli: 'codex', client: 'codex',
    protocolFamily: 'fixture', aliases: [], aliasesRefused: [] }, models: [{ ...provider.models[0], id: modelId, nativeId: modelId, channelModelId: modelId,
    canonicalModelId: modelId, aliases: [], efforts, reasoning: { supportedEfforts: efforts, defaultEffort: efforts[0] }, minCliVersion: null, minClientVersion: null,
    lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null },
    protocols: [{ family: 'fixture', version: 'v1', capabilities: [] }] }] }] };
  await applyModelCatalog(project, { schemaVersion: 1, commandId: 'catalog-register', scopeId: 's', action: 'register', catalog }, options);
  for (const id of [null, modelId]) await applyModelCatalog(project, { schemaVersion: 1, commandId: `activate-${id}`, scopeId: 's',
    action: 'activate', channelId, modelId: id, expectedRevision: 0 }, options);
  const profile = (runId: string) => { const db = new DatabaseSync(path, { readOnly: true });
    try { const row = db.prepare('SELECT snapshot FROM runs WHERE run_id = ?').get(runId) as { snapshot: string };
      return JSON.parse(row.snapshot).execution.tasks[0].profile; } finally { db.close(); } };
  return { project, options, path, configPath, profile };
}

describe.skipIf(process.platform === 'win32')('WORKER-EFFORT-R real admission → frozen argv', () => {
  it.each(['small', 'design'])('only-Ultra %s default stays cli-default with a visible reason and no effort flag', async kind => {
    const f = await fixture(), request = command(`default-${kind}`, kind);
    const created = await createRun(f.project, request, f.options), frozen = f.profile(request.runId);
    expect(frozen.parameters.argv).not.toContain('model_reasoning_effort=ultra');
    expect(frozen.parameters.argv.some((arg: string) => arg.startsWith('model_reasoning_effort='))).toBe(false);
    const selected = { schemaVersion: 1, level: null, source: 'cli-default', status: 'ultra-opt-in-required', workClass: kind,
      policyRevision: 'worker-effort-2026-10-03', target: kind === 'small' ? 'high' : 'max' };
    expect(frozen.parameters.nativeSubscription.reasoningEffort).toEqual(selected);
    expect(created.admission.run.tasks[0]!.reasoningEffort).toEqual(selected);
    expect(() => assertNativeWorkerBinding(frozen)).not.toThrow();
    for (const lang of ['en', 'tr']) {
      let output = '';
      await runCommand(['run', 'inspect', '--scope', 's', '--id', request.runId, '--lang', lang],
        { inspectRun, root: f.project, env: f.options.env, stdout: { write(chunk: string) { output += chunk; return true; } } } as never);
      expect(output).toContain(lang === 'en' ? 'Ultra requires explicit effort or an Ultra registry target' : 'Ultra için açık efor isteği veya Ultra registry hedefi gerekir');
      expect(output).toContain(lang === 'en' ? 'CLI default' : 'CLI varsayılanı');
    }
    // Replayed requests preserve the frozen boundary even after an installation opts in to Ultra.
    const config = JSON.parse(await readFile(f.configPath, 'utf8'));
    config.admission.registry.workClasses = { schemaVersion: 1, revision: 'new-ultra', classes: [{ id: 'opt-in', defaultEffort: 'ultra' }], bindings: [{ kind, classId: 'opt-in' }] };
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    expect(await createRun(f.project, request, f.options)).toEqual(created);
    expect(f.profile(request.runId)).toEqual(frozen);
  });

  it('explicit Ultra passes unchanged; an unsupported explicit effort refuses before ledger writes', async () => {
    const f = await fixture();
    const created = await createRun(f.project, command('explicit', 'design', 'ultra'), f.options);
    expect(created.admission.run.tasks[0]!.reasoningEffort).toMatchObject({ level: 'ultra', source: 'explicit', status: 'selected' });
    expect(f.profile('explicit').parameters.argv).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort=ultra']));
    expect(() => assertNativeWorkerBinding(f.profile('explicit'))).not.toThrow();
    const before = await readFile(f.path);
    await expect(createRun(f.project, command('unsupported', 'design', 'max'), f.options)).rejects.toMatchObject({ code: 'WORKER_EFFORT_UNSUPPORTED' });
    expect(await readFile(f.path)).toEqual(before);
  });

  it('a deliberate Ultra registry target remains a policy-default opt-in', async () => {
    const f = await fixture(['ultra'], true);
    const created = await createRun(f.project, command('registry-ultra', 'design'), f.options);
    expect(created.admission.run.tasks[0]!.reasoningEffort).toMatchObject({ level: 'ultra', source: 'policy-default', target: 'ultra', policyRevision: 'deliberate-ultra' });
    expect(f.profile('registry-ultra').parameters.argv).toContain('model_reasoning_effort=ultra');
  });

  it('max-only/high upper fallback still reaches the frozen command', async () => {
    const f = await fixture(['max']);
    const created = await createRun(f.project, command('max-fallback', 'small'), f.options);
    expect(created.admission.run.tasks[0]!.reasoningEffort).toMatchObject({ level: 'max', source: 'policy-default', target: 'high' });
    expect(f.profile('max-fallback').parameters.argv).toContain('model_reasoning_effort=max');
  });
});
