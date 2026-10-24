// S3-3 N19 (owner Q-H3): who may spend a subscription profile. One rule in the invocation application for every caller; fake CLI only, no model call.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { delegationOwner, delegationPrincipalClass, encodeModelBindingDefinition, mcpPrincipalRef, memoryEvaluatorPrincipal, recoveryPrincipal,
  type VerifiedPrincipal } from '#domain/index.js';
import { ModelInvocationApplication } from '#engine/core/model-invocation/index.js';
import { memoryCatalogKey, memoryEvaluatorRows } from '#engine/core/memory/index.js';
import { openSqliteModelActivationStore } from '#adapters/core/sqlite-model-activation/index.js';
import { openSqliteModelInvocationStore } from '#adapters/core/sqlite-model-invocation/index.js';
import { binding as definition, cleanupConnections, connection, request } from '../../fixtures/native-headless/connection.js';
import { assistantLine, initLine, rateLimitLine, resultLine, uiLine } from '../../fixtures/native-headless/stream.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';
// S3-5: every headless CLI spawn runs in the bubblewrap realm; a host without one is covered by the real-sandbox guard, not silently here.
const sandbox = (await measureTestShellHost()).bubblewrap.status === 'available';

afterEach(cleanupConnections);
const sqlite = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2000 };
const reference = { providerId: 'cli-subscription', providerVersion: 1, modelId: 'pinned', modelVersion: 1 };
const expectedBinding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const owner = { issuer: 'local-os:host', subject: '1000' };
const person: VerifiedPrincipal = { id: 'person', ...owner, assurance: 'os-user', scopeIds: ['scope'] };
const mcp: VerifiedPrincipal = { id: 'mcp', ...mcpPrincipalRef(owner), assurance: 'os-user', scopeIds: ['scope'] };
const recovery = recoveryPrincipal(owner, ['scope']), evaluator = memoryEvaluatorPrincipal(owner, ['scope']);
const stranger = mcpPrincipalRef({ issuer: 'local-os:host', subject: '1001' });
const consent = (classes: readonly ('ai' | 'system')[], by = owner) => ({ consentedBy: by, atMs: 5, classes });
const authorization = { revision: 'policy', ruleId: 'invoke' };
const steps = [uiLine(), initLine(), assistantLine('{"ok":true}'), rateLimitLine(), resultLine('{"ok":true}')].map(line => ({ line }));

async function invokeAs(principal: VerifiedPrincipal, delegatedUse: unknown) {
  const c = await connection({ steps }, { delegatedUse }, expectedBinding.digest), path = join(c.root, 'ledger.db');
  const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance };
  const activations = await openSqliteModelActivationStore(path, sqlite);
  const admitted = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: 'catalog', expectedBinding }, actor, authorization, admittedAtMs: 1, definition }); activations.close();
  (await openSqliteModelInvocationStore(path, sqlite, 'forbid')).close();
  const app = new ModelInvocationApplication({ async verify() { return principal; } }, { async authorize() { return authorization; } },
    { async inspect() { return { schemaVersion: 1, reference, status: 'declared', catalogRevision: 'catalog', definition, binding: expectedBinding, availability: 'not-observed' }; } },
    async () => ({ async loadRecord() { return admitted.receipt.record; }, close() {} }), { async resolve() { return c.profile; } },
    { resolve() { return c.port; }, async admit(profile, signal) { await c.port.preflight(profile, signal); } },
    async () => openSqliteModelInvocationStore(path, sqlite, 'forbid'), { invocationId: () => 'invocation', ownerId: () => 'owner', now: () => 10 });
  const command = { schemaVersion: 1, commandId: 'plan-1', scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding, nativeRequest: request() };
  const outcome = await app.invoke(command).then(result => ({ state: result.receipt.outcome?.state }), (error: { code?: string }) => ({ code: error.code }));
  return { outcome, spawns: (await c.log()).length };
}

describe('S3-3 principal classes and the person a workload acts for', () => {
  it('classifies person, MCP and composition-root workloads and keeps the owner they act for', () => {
    expect([person, mcp, recovery, evaluator].map(delegationPrincipalClass)).toEqual(['person', 'ai', 'system', 'system']);
    expect(delegationPrincipalClass({ issuer: 'remote', assurance: 'token-verified' })).toBe('ai');
    for (const actor of [person, mcp, recovery, evaluator]) expect(delegationOwner(actor)).toEqual(owner);
  });
});
describe.skipIf(process.platform !== 'linux' || !sandbox)('S3-3 N19 delegated use of a subscription profile, enforced by the invocation application', () => {
  it.each([
    ['the person without any consent', person, null, 'responded'],
    ['an MCP actor without consent', mcp, null, 'HEADLESS_DELEGATION_REFUSED'],
    ['a recovery workload without consent', recovery, null, 'HEADLESS_DELEGATION_REFUSED'],
    ['a memory evaluator with only the AI class', evaluator, consent(['ai']), 'HEADLESS_DELEGATION_REFUSED'],
    ['an MCP actor with only the system class', mcp, consent(['system']), 'HEADLESS_DELEGATION_REFUSED'],
    ['an MCP actor with the AI class', mcp, consent(['ai']), 'responded'],
    ['a recovery workload with the system class', recovery, consent(['ai', 'system']), 'responded'],
    ['another person acting through MCP, even with consent', { ...mcp, ...stranger }, consent(['ai', 'system']), 'HEADLESS_DELEGATION_REFUSED'],
    ['an MCP actor under consent written by another person', mcp, consent(['ai'], { issuer: 'local-os:host', subject: '1001' }), 'HEADLESS_DELEGATION_REFUSED'],
  ] as const)('%s', async (_label, principal, delegatedUse, expected) => {
    const { outcome, spawns } = await invokeAs(principal as VerifiedPrincipal, delegatedUse);
    if (expected === 'responded') expect(outcome).toEqual({ state: 'responded' });
    else { expect(outcome).toEqual({ code: expected }); expect(spawns).toBe(0); } // refused before the preflight, so no process ever starts
  });
});

describe('S3-3 the memory evaluator path (S4B-3) applies the same consent rule when it lists its rows', () => {
  const CHANNEL = 'test-sub', MODEL = 'vendor/model';
  const sources = { modelRoles: { schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'fixture-roles', roles: [],
    models: [{ channelId: CHANNEL, modelId: MODEL, version: 1, tier: 'frontier', roles: ['memory-evaluator'] }], exceptions: [] }] },
  providerCatalog: { schemaVersion: 1, revision: 'catalog', providers: [{ id: CHANNEL, version: 1, models: [{ id: 'm', version: 1, nativeId: MODEL, protocols: [{ family: 'claude-code-stream-json', version: 'v1', capabilities: [] }] }] }] },
  activation: async () => ({ state: 'active' }) as never };
  const profiles = (delegatedUse: unknown, billingAxis = 'subscription') => ({ schemaVersion: 1, profiles: [{ schemaVersion: 2, billingAxis, id: 'p', version: 1, scopeId: 'scope',
    reference: { providerId: CHANNEL, providerVersion: 1, modelId: 'm', modelVersion: 1 }, bindingDigest: 'a'.repeat(64), protocol: { family: 'claude-code-stream-json', version: 'v1' },
    adapter: { id: 'native-cli-headless', version: 1, definition: { delegatedUse } }, allocation: { id: 'a', maxCalls: null, maxInFlight: 1 },
    limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } }] });
  const facts = new Map([[memoryCatalogKey(CHANNEL, MODEL), { maker: 'maker-a', billing: 'subscription' as const, pricing: null }]]);
  it.each([
    ['no consent', null, false], ['the AI class only', consent(['ai']), false], ['another person\'s consent', consent(['system'], { issuer: 'x', subject: 'y' }), false],
    ['the system class', consent(['system']), true],
  ])('a subscription row with %s is invocable: %s', async (_label, delegatedUse, invocable) => {
    const [row] = await memoryEvaluatorRows(sources, profiles(delegatedUse), 'scope', facts, Date.UTC(2026, 9, 23), owner);
    expect(row).toMatchObject({ channelId: CHANNEL, modelId: MODEL, billing: 'subscription', invocable });
  });
});
