import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyModelCatalog, createRun, proposeRun } from '../../../src/index.js';
import { defineConfiguredAgent, defineConfiguredSkill, inspectConfiguredAgent } from '#composition/core/agent-catalog/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { readLocalOsIdentity } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';

// S8-1b on the product path: a person defines an agent on their terminal card, then the real admission (configured registry, ledger catalog,
// policy, integrity key) selects it for a work-input task of its WorkClass, puts its persona and pinned skill into the worker prompt and freezes the
// seal in the Run; the proposal records the same selection and the candidate takes the Run to the card. Model assignment is untouched (ASS1).
beforeEach(context => { if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: configured policy/integrity flows require a verified POSIX UID'); });
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const claude = { provider: 'claude', cliVersion: '2.1.293 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended' };
const registry = { schemaVersion: 1, revision: 's8-1b', profiles: [{ id: 'coding', version: 1, adapter: { id: 'native-coding-template', version: 1 },
  parameters: { schemaVersion: 1, docker, invocation: claude } }], kinds: [{ kind: 'coding', profile: { id: 'coding', version: 1 } }],
  evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] };
const graph = { schemaVersion: 4, revision: 1, tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'], workClass: 'small',
  workInput: { schemaVersion: 2, task: 'Append the line "done" to note.txt.', scope: { paths: ['note.txt'] }, acceptance: 'note.txt ends with "done".' } }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
const witness = { attest: async () => true };
async function seeded() {
  const project = await mkdtemp(join(tmpdir(), 'dn-agent-admission-')); roots.push(project); const data = join(project, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true }); const options = { env: { HOME: join(project, 'h') } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1,
    ordering: 'input-order', registry }, cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 } }));
  const { store, path } = await openConfiguredAttemptStore(project, options);
  try { await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); } finally { store.close(); }
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'catalog', effect: 'allow', actions: ['activate', 'deactivate'], scopes: 'all', principals, resource: { kind: 'model-activation', ids: 'all' } },
    { id: 'agents', effect: 'allow', actions: ['inspect', 'define'], scopes: ['s'], principals, resource: { kind: 'agent-catalog', ids: 'all' } },
  ] }), { mode: 0o600 });
  let sequence = 0;
  const catalog = (command: Record<string, unknown>) => applyModelCatalog(project, { schemaVersion: 1, commandId: `catalog-${++sequence}`, scopeId: 's', ...command }, options);
  await catalog({ action: 'register', catalog: await seedCatalog() });
  await catalog({ action: 'activate', channelId: SEED_CHANNEL, modelId: null, expectedRevision: 0 }); await catalog({ action: 'activate', channelId: SEED_CHANNEL, modelId: 'claude-sonnet-5-5', expectedRevision: 0 });
  const task = (runId: string) => { const db = new DatabaseSync(path, { readOnly: true });
    try { return (JSON.parse(String(db.prepare('SELECT snapshot FROM runs WHERE run_id = ?').get(runId)!['snapshot'])) as { execution: { tasks: Record<string, unknown>[] } }).execution.tasks[0]!; } finally { db.close(); } };
  return { project, options, task };
}

it('the configured admission selects the person\'s candidate agent, fills its persona and pinned skill, and freezes the seal; model assignment is unchanged', async () => {
  const f = await seeded();
  const skill = (await defineConfiguredSkill(f.project, { schemaVersion: 1, commandId: 'k1', scopeId: 's', skillId: 'tdd', expectedRevision: null,
    content: { name: 'TDD', text: 'Önce başarısız testi yaz.' } }, f.options, witness)).item;
  await defineConfiguredAgent(f.project, { schemaVersion: 1, commandId: 'a1', scopeId: 's', agentId: 'small-fixer', expectedRevision: null, content: { name: 'Küçük işçi',
    persona: 'Küçük ve geri alınabilir değişiklik yaparsın.', workClasses: ['small'], skills: [{ skillId: 'tdd', revision: 1, digest: skill.contentDigest }], parentAgentId: null } }, f.options, witness);
  expect(await inspectConfiguredAgent(f.project, { schemaVersion: 1, scopeId: 's', agentId: 'small-fixer' }, f.options)).toMatchObject({ standings: [{ workClass: 'small', standing: 'candidate' }] });
  await createRun(f.project, { schemaVersion: 1, commandId: 'create-r', scopeId: 's', runId: 'r', graph }, f.options);
  const task = f.task('r') as { agent: Record<string, unknown>; assignment: { modelId: string }; profile: { parameters: { nativeSubscription: { promptDelivery: { segments: { kind: string; id: string }[] } } } } };
  expect(task.agent).toMatchObject({ agentId: 'small-fixer', revision: 1, workClass: 'small', standing: 'candidate', skills: [{ skillId: 'tdd', revision: 1, digest: skill.contentDigest }] });
  expect(task.profile.parameters.nativeSubscription.promptDelivery.segments.filter(row => row.kind === 'persona' || row.kind === 'skill').map(row => `${row.kind}:${row.id}`))
    .toEqual(['persona:small-fixer', 'skill:tdd']);
  expect(task.assignment.modelId).toBe('claude-sonnet-5-5');
  // The proposal path records the same selection; a candidate never runs card-less.
  const proposal = { schemaVersion: 1 as const, commandId: 'p', proposalId: 'p', scopeId: 's', runId: 'proposed', proposer: (({ id, issuer, subject }) => ({ id, issuer, subject }))(readLocalOsIdentity()),
    source: { kind: 'human' as const }, budgetCeiling: { currency: 'USD', limitMinorUnits: 0 }, requiredPermissions: [], graph };
  const result = await proposeRun(f.project, proposal, f.options);
  expect(result.proposal).toMatchObject({ status: 'pending', binding: { admission: { standingAdmission: false, agents: [{ taskId: 't', agentId: 'small-fixer', revision: 1, standing: 'candidate' }] } } });
});
it('N25: with no agent defined the configured admission seals nothing and the prompt has no persona/skill part', async () => {
  const f = await seeded();
  await createRun(f.project, { schemaVersion: 1, commandId: 'create-r', scopeId: 's', runId: 'r', graph }, f.options);
  expect(f.task('r')).not.toHaveProperty('agent');
});
