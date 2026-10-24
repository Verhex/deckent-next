import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { RECOVERY_POLICY_SEED, freezeRecoveryPolicy, loadRecoveryPolicy, type AttemptIdentity } from '#domain/index.js';
import { modelInvocationTargetId } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAttemptStore, readLocalOsIdentity, type SqliteAttemptStore } from '#adapters/index.js';
import { clearConfigCache, loadConfig } from '#platform/index.js';
import { prepareConfiguredRecovery } from '#composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { applyModelCatalog } from '../../../src/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles } from '../support/custody.js';
import { LEDGER_OPTIONS, LOST_TIMING, loseAttempt, sealDetection } from '../support/lost-task.js';

// S6R-5 through the real composition (config, policy file, ledger, S2 role registry, catalog, model invocation and spend ledger, audit chain): the
// recovery pass decides a sealed lost-worker case under the composition-root recovery principal. Only the provider's HTTP effect is the brain-provider
// fixture's bounded in-memory fake — no model is called. Models, makers and prices are synthetic catalog data.
beforeEach(context => { if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: configured policy/integrity flows require a verified POSIX UID'); });
const fixtures: Awaited<ReturnType<typeof brainProviderFixture>>[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(fixtures.splice(0).map(f => f.close())); });
const CHANNEL = 'test-operator', modelId = 'vendor/model';
const roles = { schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'fixture-recovery-roles', roles: [],
  models: [{ channelId: CHANNEL, modelId, version: 1, tier: 'frontier', roles: ['brain', 'recovery-decision'] }], exceptions: [] }] };
type Choice = Record<string, unknown>;

async function setup(input: { mode: 'shadow' | 'live'; invokeGrant?: boolean; choice?: Choice; roles?: unknown; frozen?: 'shadow' | 'live' }) {
  const f = await brainProviderFixture({ response: '', modelRoles: input.roles ?? roles, maxOutputTokens: 1024 }); fixtures.push(f);
  const local = readLocalOsIdentity(), person = { issuer: local.issuer, subject: local.subject }, recoveryRef = { issuer: `${person.issuer}/recovery`, subject: person.subject };
  const config = JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ ...config, runRuntime: { recovery: { mode: input.mode } } })); clearConfigCache();
  const policy = JSON.parse(await readFile(join(f.data, 'policy.json'), 'utf8')) as { grants: object[] };
  const grant = (id: string, principals: object[], kind: string, actions: string[], ids: 'all' | string[] = 'all') => ({ id, effect: 'allow', actions, scopes: ['s'], principals, resource: { kind, ids } });
  policy.grants.push({ ...grant('person-catalog', [person], 'model-activation', ['activate', 'inspect']), scopes: 'all' }, grant('person-hold', [person], 'run', ['cancel']), grant('recovery-standing', [person], 'recovery-action', ['apply'], ['continue-new-attempt']),
    ...(input.invokeGrant === false ? [] : [grant('recovery-model', [recoveryRef], 'model-invocation', ['invoke'], [modelInvocationTargetId(f.reference)])]));
  await writeFile(join(f.data, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
  // The catalog row of the fixture channel: its billing axis is catalog data (per-token here: metered, no consent needed).
  const seed = JSON.parse(await readFile(new URL('../../../assets/model-catalog/anthropic-api.json', import.meta.url), 'utf8')) as { providers: { id: string; models: Record<string, unknown>[] }[] };
  const model = { ...seed.providers[0]!.models[0]!, id: modelId, nativeId: modelId, channelModelId: modelId, canonicalModelId: modelId, vendorId: 'maker-b' };
  await applyModelCatalog(f.project, { schemaVersion: 1, commandId: 'register-recovery', scopeId: 's', action: 'register',
    catalog: { ...seed, revision: 'fixture-recovery-catalog', recommendedActivations: [], providers: [{ ...seed.providers[0]!, id: f.reference.providerId, models: [model] }] } }, f.options);
  // One Run admitted with frozen recovery bounds whose only Attempt was lost and released with an exit proof; the Nervous detection sealed with the installation key.
  const store = await openSqliteAttemptStore(f.path, LEDGER_OPTIONS, LOST_TIMING, 'forbid', custodyProfiles); stores.push(store);
  const { layout } = await openConfiguredAttemptStore(f.project, f.options).then(opened => { opened.store.close(); return opened; });
  const identity: AttemptIdentity = { scopeId: 's', runId: 'lost-run', taskId: 'task', attemptId: 'attempt-1', layoutRevision: layout.revision, generation: 1 };
  await admitRunAttempts(store, [identity], { recovery: freezeRecoveryPolicy(loadRecoveryPolicy(RECOVERY_POLICY_SEED), input.frozen ?? input.mode, ['task']) });
  await loseAttempt(store, f.data, identity);
  const integrity = await openLocalIntegrityAuthority(layout, (await loadConfig(f.project, f.options)).approvals.keyFile, true);
  const caseId = await sealDetection(f.path, identity, 'launcher-dead-orphan', integrity);
  f.setOutput(body => { const messages = (JSON.parse(body) as { messages: { content: string }[] }).messages, user = JSON.parse(messages.at(-1)!.content) as { caseId: string; evidenceDigest: string };
    return JSON.stringify({ schemaVersion: 1, caseId: user.caseId, evidenceDigest: user.evidenceDigest, action: 'continue-new-attempt', causeClass: 'infra-transient',
      rationale: 'The launcher died; nothing is open.', nextAttemptNote: 'previous-attempt-launcher-died', ...input.choice }); });
  const rows = (sql: string) => { const db = new DatabaseSync(f.path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const sealed = () => rows("SELECT record FROM audit_events WHERE kind='recovery-decision' ORDER BY sequence").map(row => JSON.parse(String(row['record'])).event);
  return { f, store, identity, caseId, sealed, rows, recoveryRef };
}

it('off loads nothing; live decides the released case once under the recovery principal, seals it, continues the task; a restarted pass replays without a call', async () => {
  expect(prepareConfiguredRecovery('/nowhere', {}, 'off')).toBeNull();
  const h = await setup({ mode: 'live' });
  expect(await prepareConfiguredRecovery(h.f.project, h.f.options, 'live')!.run('s')).toEqual([expect.objectContaining({ kind: 'continued', replay: false })]);
  expect(h.f.posts).toBe(1);
  const [event] = h.sealed();
  expect(event).toMatchObject({ principal: h.recoveryRef, subject: { kind: 'recovery-decision', caseId: h.caseId, mode: 'live', action: 'continue-new-attempt',
    note: 'previous-attempt-launcher-died', model: { channelId: CHANNEL, modelId, template: { id: 'recovery-decision', version: 1 } } } });
  expect(event.subject.model.invocationId).toEqual(expect.any(String));
  const run = (await h.store.loadRun('s', 'lost-run'))!;
  expect(run.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: false });
  expect(run.previousBindings).toEqual([expect.objectContaining({ observedKind: 'lost', recoveryContext: { note: 'previous-attempt-launcher-died', facts: [] } })]);
  // The provider saw only the typed evidence projection: no policy, principal or path.
  expect(h.f.bodies[0]).not.toMatch(/policy|recovery-standing|\/home|\/tmp/u);
  // A restart: a fresh pass re-reads the detections from the start; the sealed, applied case replays, nothing is sent again.
  expect(await prepareConfiguredRecovery(h.f.project, h.f.options, 'live')!.run('s')).toEqual([expect.objectContaining({ kind: 'continued', replay: true })]);
  expect(h.f.posts).toBe(1); expect(h.sealed()).toHaveLength(1);
});

it('without the recovery principal\'s model grant the call is refused before any provider effect: sealed escalation with the typed reason, the Run held for a person', async () => {
  const h = await setup({ mode: 'live', invokeGrant: false });
  expect(await prepareConfiguredRecovery(h.f.project, h.f.options, 'live')!.run('s')).toEqual([expect.objectContaining({ kind: 'escalated', case: expect.objectContaining({
    decision: { action: 'escalate-human', code: 'model-failed' } }) })]);
  expect(h.f.posts).toBe(0);
  expect(h.sealed().map(event => [event.subject.code, event.subject.failure])).toEqual([['model-failed', 'POLICY_DENIED']]);
  expect((await h.store.loadRun('s', 'lost-run'))!.state).toMatchObject({ kind: 'parked', holdSource: 'nervous' });
});

it('no active recovery-decision role row: escalated without a model call (the Brain role alone never decides recovery)', async () => {
  const h = await setup({ mode: 'live', roles: { schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'fixture-brain-only', roles: [],
    models: [{ channelId: CHANNEL, modelId, version: 1, tier: 'frontier', roles: ['brain'] }], exceptions: [] }] } });
  expect(await prepareConfiguredRecovery(h.f.project, h.f.options, 'live')!.run('s')).toEqual([expect.objectContaining({ kind: 'escalated' })]);
  expect(h.f.posts).toBe(0); expect(h.sealed().map(event => event.subject.code)).toEqual(['no-eligible-model']);
});

it('shadow: the model is asked once on the real case, the decision sealed, and the Run, its case table and its custody stay exactly as they were', async () => {
  const h = await setup({ mode: 'shadow', frozen: 'live' }), before = await h.store.loadRun('s', 'lost-run');
  expect(await prepareConfiguredRecovery(h.f.project, h.f.options, 'shadow')!.run('s')).toEqual([{ kind: 'shadow', action: 'continue-new-attempt', code: null, replay: false }]);
  expect(h.f.posts).toBe(1); expect(h.sealed().map(event => event.subject.mode)).toEqual(['shadow']);
  expect(await h.store.loadRun('s', 'lost-run')).toEqual(before); expect(h.rows('SELECT count(*) AS n FROM recovery_cases')).toEqual([{ n: 0 }]);
  expect(await prepareConfiguredRecovery(h.f.project, h.f.options, 'shadow')!.run('s')).toEqual([{ kind: 'shadow', action: 'continue-new-attempt', code: null, replay: true }]);
  expect(h.f.posts).toBe(1);
});
