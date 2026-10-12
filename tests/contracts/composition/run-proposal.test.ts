import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { proposeRun, inspectRunProposal, inspectRun, configuredApproval } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { readLocalOsIdentity } from '#adapters/index.js';
import { createProviderSpendAccount, createProviderSpendCheckpoint } from '#engine/index.js';
import { clearConfigCache } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { proposalFixture } from '../support/run-proposal.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(standing: boolean, withBudget = true) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-proposal-sdk-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const workClasses = { schemaVersion: 2, revision: 'business-v1', classes: [{ id: 'business', parentClassId: 'small', defaultEffort: 'high',
    proposalAdmission: { risk: 'low', standingAdmission: standing }, acceptanceProfile: { schemaVersion: 1, version: 1, criterionTypes: ['completion'],
      evidenceTypes: ['verification-result'], rubric: [{ criterionType: 'completion', evidenceTypes: ['verification-result'], weight: 1 }],
      ceilingRules: [], decisionThresholds: { rejectBelow: 0.2, acceptAt: 1 } } }], bindings: [{ kind: 'purchase', classId: 'business' }] };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 2,
    ordering: 'input-order', registry: { ...fixtureDockerRegistry(['purchase']), workClasses } } }));
  const options = { env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') } };
  const { store, path } = await openConfiguredAttemptStore(project, options);
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } }); store.close();
  const { id, issuer, subject } = readLocalOsIdentity(), proposer = { id, issuer, subject }, principals = [{ issuer, subject }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'budget', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'provider-spend-account', ids: ['scope-budget'] } },
    { id: 'approval', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['s'], principals, resource: { kind: 'approval', ids: 'all' } },
  ] }), { mode: 0o600 });
  if (withBudget) {
    const account = createProviderSpendAccount({ schemaVersion: 1, scopeId: 's', budgetId: 'scope-budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 });
    const checkpoint = createProviderSpendCheckpoint(account, 1, 0), db = new DatabaseSync(path);
    try { db.prepare('INSERT INTO provider_spend_accounts(scope_id,revision,reservation_count,digest,record) VALUES(?,?,?,?,?)').run('s', 1, 0, checkpoint.digest, JSON.stringify(account)); }
    finally { db.close(); }
  }
  return { project, data, path, options, proposal: proposalFixture('business', proposer) };
}
it.skipIf(process.platform === 'win32')('public SDK produces durable proposal → sealed decision → one existing Run admission and inspect surfaces', async () => {
  const f = await fixture(true), first = await proposeRun(f.project, f.proposal, f.options);
  expect(first.proposal.status).toBe('accepted'); expect(first.runtimeTotalSpendEnforced).toBe(false);
  expect((await inspectRunProposal(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'propose' }, f.options))!.proposal).toEqual(first.proposal);
  expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run!.proposal).toEqual(first.proposal.binding);
  expect(await proposeRun(f.project, f.proposal, f.options)).toEqual(first);
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    for (const table of ['runs', 'run_receipts', 'run_execution_intents']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE kind='authority-decision'").get()!.n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM run_proposal_receipts').get()!.n).toBe(2);
  } finally { db.close(); }
});
it.skipIf(process.platform !== 'linux')('unmarked configured SDK proposal remains pending; headless decisions keep the TTY gate intact', async () => {
  const f = await fixture(false), pending = await proposeRun(f.project, f.proposal, f.options);
  expect(pending.proposal.status).toBe('pending');
  for (const decision of ['allow', 'deny']) await expect(configuredApproval(f.project, 'decide', { schemaVersion: 1, commandId: 'headless-' + decision,
    scopeId: 's', approvalId: pending.proposal.approval!.approvalId, expectedRevision: 0, decision, reason: 'Headless SDK attempt' }, f.options))
    .rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
  expect((await proposeRun(f.project, f.proposal, f.options)).proposal).toEqual(pending.proposal);
  expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run).toBeNull();
});
it.skipIf(process.platform === 'win32')('no configured budget is a durable typed refusal with no Run', async () => {
  const f = await fixture(true, false), rejected = await proposeRun(f.project, f.proposal, f.options);
  expect(rejected.proposal).toMatchObject({ status: 'rejected', reason: 'RUN_PROPOSAL_BUDGET_MISSING' });
  expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run).toBeNull();
});
