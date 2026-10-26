import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectConfiguredMemoryEvaluators, listConfiguredMemory, prepareConfiguredMemoryEvaluation } from '#composition/core/memory/index.js';
import { invokeConfiguredModelAs } from '#composition/core/model-invocation/index.js';
import { prepareTerminalChatCommand } from '#composition/core/terminal-chat/index.js';
import { memoryEvaluatorPrincipal } from '#domain/index.js';
import { memoryEvaluationSpendOf, modelInvocationTargetId } from '#engine/index.js';
import { openSqliteModelInvocationReader, readLocalOsIdentity } from '#adapters/index.js';
import { memoryCommand } from '#surfaces/core/cli-memory/index.js';
import { applyModelCatalog } from '../../../src/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';

// S4B-3 through the real composition (config, policy file, ledger, S2 role registry, catalog, model invocation and spend ledger); only the provider's
// HTTP effect is the brain-provider fixture's bounded in-memory fake — no paid API is called. The evaluator works under its own composition-root
// identity: without its V1–V5 grants it is refused, never run as the person. Makers, models and prices are synthetic catalog data.
beforeEach(context => { if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: configured policy/integrity flows require a verified POSIX UID'); });
const fixtures: Awaited<ReturnType<typeof brainProviderFixture>>[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.close())); });
/** The brain-provider fixture's declared channel and exact model (its catalog and invocation profile). */
const CHANNEL = 'test-operator', modelId = 'vendor/model';
const roles = { schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'fixture-evaluator-roles', roles: [],
  models: [{ channelId: CHANNEL, modelId, version: 1, tier: 'frontier', roles: ['brain', 'memory-evaluator'] }], exceptions: [] }] };
async function setup(options: { evaluatorGrants: boolean; invoke: boolean; roles?: unknown }) {
  const f = await brainProviderFixture({ response: JSON.stringify({ verdict: 'pass' }), modelRoles: options.roles ?? roles }); fixtures.push(f);
  const reference = f.reference;
  const local = readLocalOsIdentity(), person = { issuer: local.issuer, subject: local.subject }, evaluator = { issuer: `${person.issuer}/memory-evaluator`, subject: person.subject };
  const policy = JSON.parse(await readFile(join(f.data, 'policy.json'), 'utf8')) as { grants: object[] };
  const grant = (id: string, principals: object[], kind: string, actions: string[], ids: 'all' | string[] = 'all', scopes: 'all' | string[] = ['s']) =>
    ({ id, effect: 'allow', actions, scopes, principals, resource: { kind, ids } });
  policy.grants.push(grant('person-catalog', [person], 'model-activation', ['activate', 'deactivate', 'inspect'], 'all', 'all'), grant('person-memory', [person], 'memory', ['inspect']),
    ...(options.evaluatorGrants ? [grant('evaluator-memory', [evaluator], 'memory', ['inspect', 'verify', 'contest']), grant('evaluator-runs', [evaluator], 'run', ['inspect'])] : []),
    ...(options.invoke ? [grant('evaluator-model', [evaluator], 'model-invocation', ['invoke'], [modelInvocationTargetId(reference)])] : []));
  await writeFile(join(f.data, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
  // The catalog row of the fixture channel: its maker and per-token price are catalog data (the evaluator reads them; no literal in code).
  const seed = JSON.parse(await readFile(new URL('../../../assets/model-catalog/anthropic-api.json', import.meta.url), 'utf8')) as { providers: { id: string; models: Record<string, unknown>[] }[] };
  const model = { ...seed.providers[0]!.models[0]!, id: modelId, nativeId: modelId, channelModelId: modelId, canonicalModelId: modelId, vendorId: 'maker-b',
    pricing: { ...(seed.providers[0]!.models[0]!['pricing'] as object), inputPerMTok: '3', outputPerMTok: '15' } };
  const catalog = { ...seed, revision: 'fixture-evaluator-catalog', recommendedActivations: [], providers: [{ ...seed.providers[0]!, id: reference.providerId, models: [model] }] };
  await applyModelCatalog(f.project, { schemaVersion: 1, commandId: 'register-evaluator', scopeId: 's', action: 'register', catalog }, f.options);
  for (const id of [null, modelId]) await applyModelCatalog(f.project, { schemaVersion: 1, commandId: `activate-evaluator-${id ?? 'channel'}`, scopeId: 's', action: 'activate',
    channelId: CHANNEL, modelId: id, expectedRevision: 0 }, f.options);
  return { f, reference, evaluator: memoryEvaluatorPrincipal(person, ['s']) };
}

it('off loads nothing; shadow runs under the evaluator identity (refused without its grants), at most once per pass interval, and calls no model without a candidate', async () => {
  expect(prepareConfiguredMemoryEvaluation('/nowhere', {}, 'off')).toBeNull();
  const refused = await setup({ evaluatorGrants: false, invoke: false });
  await expect(prepareConfiguredMemoryEvaluation(refused.f.project, refused.f.options, 'shadow')!.run('s')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  const granted = await setup({ evaluatorGrants: true, invoke: true }), pass = prepareConfiguredMemoryEvaluation(granted.f.project, granted.f.options, 'shadow')!;
  expect(await pass.run('s')).toMatchObject({ schemaVersion: 1, mode: 'shadow', calls: 0, records: [], alerts: [] });
  expect(await pass.run('s')).toBeNull();
  expect(granted.f.posts).toBe(0);
});

it('the read-only view names the evaluator row, its catalog maker and its price with the exact daily answer ceiling; the list shows it', async () => {
  const { f, reference } = await setup({ evaluatorGrants: true, invoke: true });
  await prepareConfiguredMemoryEvaluation(f.project, f.options, 'shadow')!.run('s'); // creates the integrity key the list reads with
  const view = await inspectConfiguredMemoryEvaluators(f.project, 's', f.options);
  expect(view).toMatchObject({ available: true, callsPerDay: 30, maxCompletionTokens: 2048, rows: [{ channelId: reference.providerId, modelId: 'vendor/model', maker: 'maker-b',
    billing: 'metered', invocable: true, price: { kind: 'per-token', inputPerMTok: '3', outputPerMTok: '15', answersPerDayCeiling: '0.9216' } }] });
  let text = '';
  await memoryCommand(['memory', '--scope', 's', '--lang', 'en'], { root: f.project, env: f.options.env, listMemory: listConfiguredMemory, inspectMemoryEvaluators: inspectConfiguredMemoryEvaluators,
    stdout: { write(chunk: string) { text += chunk; } } });
  expect(text).toContain(`Evaluator for this scope: ${reference.providerId}/vendor/model by maker-b`); expect(text).toContain('at most $0.9216 a day');
  let turkish = '';
  await memoryCommand(['memory', '--scope', 's', '--lang', 'tr'], { root: f.project, env: f.options.env, listMemory: listConfiguredMemory, inspectMemoryEvaluators: inspectConfiguredMemoryEvaluators,
    stdout: { write(chunk: string) { turkish += chunk; } } });
  expect(turkish).toContain('0,9216 USD');
  await applyModelCatalog(f.project, { schemaVersion: 1, commandId: 'deactivate-evaluator-channel', scopeId: 's', action: 'deactivate', channelId: CHANNEL, modelId: null, expectedRevision: 1 }, f.options);
  expect(await inspectConfiguredMemoryEvaluators(f.project, 's', f.options)).toMatchObject({ available: false, rows: [] });
  await applyModelCatalog(f.project, { schemaVersion: 1, commandId: 'reactivate-evaluator-channel', scopeId: 's', action: 'activate', channelId: CHANNEL, modelId: null, expectedRevision: 2 }, f.options);
  await applyModelCatalog(f.project, { schemaVersion: 1, commandId: 'deactivate-evaluator-model', scopeId: 's', action: 'deactivate', channelId: CHANNEL, modelId, expectedRevision: 1 }, f.options);
  expect(await inspectConfiguredMemoryEvaluators(f.project, 's', f.options)).toMatchObject({ available: false, rows: [] });
  expect(f.posts).toBe(0);
  // N3: a model holding only the Brain role is never an evaluator row.
  const brainOnly = await setup({ evaluatorGrants: true, invoke: true, roles: { schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'fixture-brain-only', roles: [],
    models: [{ channelId: CHANNEL, modelId, version: 1, tier: 'frontier', roles: ['brain'] }], exceptions: [] }] } });
  expect(await inspectConfiguredMemoryEvaluators(brainOnly.f.project, 's', brainOnly.f.options)).toMatchObject({ available: false, rows: [] });
});

it('V5: the evaluator invokes its model under its own principal only with its grant; the call is sealed and its spend read exactly from the spend ledger', async () => {
  for (const invoke of [false, true]) {
    const { f, reference, evaluator } = await setup({ evaluatorGrants: true, invoke });
    const { command } = await prepareTerminalChatCommand({ projectRoot: f.project, scopeId: 's', messages: [{ role: 'user', content: '{"candidate":"data"}' }], options: f.options },
      false, reference, { maxCompletionTokens: 8 });
    const call = invokeConfiguredModelAs(f.project, { ...command, commandId: 'e'.repeat(64) }, evaluator, f.options);
    if (!invoke) { await expect(call).rejects.toMatchObject({ code: 'POLICY_DENIED' }); expect(f.posts).toBe(0); continue; }
    await call; expect(f.posts).toBe(1);
    const reader = await openSqliteModelInvocationReader(f.path, { busyTimeoutMs: 1000 });
    try {
      const record = (await reader.loadReceipt!('s', 'e'.repeat(64)))!, held = (await reader.loadInspection('s', record.receipt.claim.invocationId))!;
      expect(JSON.stringify(record.receipt)).toContain(evaluator.issuer);
      expect(memoryEvaluationSpendOf({ receipt: record.receipt, spending: held.spending }, 'metered')).toMatchObject({ state: 'settled', currency: 'USD' });
      expect(memoryEvaluationSpendOf({ receipt: record.receipt, spending: null }, 'metered')).toEqual({ state: 'unknown' });
    } finally { reader.close(); }
  }
});
