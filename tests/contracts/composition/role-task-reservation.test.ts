import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

// H34 S2 follow-up (owner 2026-09-27): roles may carry a `task` rule. Before this slice `src/domain/core/policy`
// refused any role permission targeting `task` (typed POLICY_ROLE_TASK) and `runs/internal/reserve.ts` only looked
// at the document's top-level grants/restrictions to decide whether to wire the task-admission filter at all, so a
// task rule reachable only through a bound role could not be authored and — had it existed — would have been
// silently ignored by real Run reservation (the task would reserve without ever asking for approval).
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const graph = { schemaVersion: 2 as const, revision: 1, tasks: ['held', 'free'].map(id => ({ id, kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] })),
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };

describe.skipIf(process.platform === 'win32')('a role-derived task rule is applied by real Run reservation (H34 S2 follow-up)', () => {
  it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] a require-approval task permission granted only through a bound role excludes the task until decided, and allows it after', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-role-task-')); roots.push(root);
    const project = join(root, 'project'), data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 2,
      inFlightSlots: 2, ordering: 'input-order', registry: fixtureDockerRegistry(['selected']) } }));
    const options = { env: { HOME: join(root, 'home') } };
    const opened = await openConfiguredAttemptStore(project, options);
    try { await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } }); } finally { opened.store.close(); }
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    // The task rule ("wait") lives only inside the `gatekeeper` role's permissions, never as a top-level grant/restriction.
    const policy = { schemaVersion: 2 as const, revision: 'p1', restrictions: [], separationOfDuties: [],
      grants: [
        { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
        { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
        { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['s'], principals, resource: { kind: 'approval', ids: 'all' } },
      ],
      roles: [{ id: 'gatekeeper', permissions: [{ id: 'wait', effect: 'require-approval', actions: ['execute'], resource: { kind: 'task', ids: ['held'] } }] }] };
    const bindings = { schemaVersion: 1, revision: 'b1', bindings: [{ id: 'ops', principals, roles: ['gatekeeper'], scopes: ['s'] }] };
    await writeFile(join(data, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
    await writeFile(join(data, 'bindings.json'), JSON.stringify(bindings), { mode: 0o600 });
    await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
    // Only the un-gated task reserves; the role-gated one is excluded, exactly like an explicit top-level task grant.
    const first = await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve-1', expectedRevision: 0 }, options);
    expect(first.reservation.identities.map(value => value.taskId)).toEqual(['free']);
    const pending = await configuredApproval(project, 'list', { schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 }, options) as
      { request: { approvalId: string; taskId: string } }[];
    expect(pending).toHaveLength(1); expect(pending[0]!.request.taskId).toBe('held');
    await configuredApproval(project, 'decide', { schemaVersion: 1, scopeId: 's', approvalId: pending[0]!.request.approvalId,
      commandId: 'allow-held', expectedRevision: 0, decision: 'allow', reason: 'Reviewed' }, options);
    const next = await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve-2', expectedRevision: 1 }, options);
    expect(next.reservation.identities.map(value => value.taskId)).toEqual(['held']);
  });
});
