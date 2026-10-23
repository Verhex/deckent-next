// S3-3 N19/N23: the subscription profile (login, uid floor, delegated-use consent) and the preview switch are a person's to write, on every surface.
import { describe, expect, it } from 'vitest';
import { ConfigApplication } from '../../../src/engine/core/config/index.js';
import { aiAuthorityFloor, mcpPrincipalRef } from '#domain/index.js';
import { createDefaultConfig } from '../../../src/platform/core/config/index.js';
import { digestText } from '../../../src/platform/core/utils/index.js';
import { registerProviderConfig } from '#adapters/index.js';

registerProviderConfig();

const owner = { issuer: 'local-os', subject: 'test' };
const person = { id: 'person', ...owner, assurance: 'os-user', scopeIds: ['test'] } as const;
const mcp = { id: 'mcp', ...mcpPrincipalRef(owner), assurance: 'os-user', scopeIds: ['test'] } as const;
const profile = (over: Record<string, unknown> = {}) => ({ schemaVersion: 2, billingAxis: 'subscription', id: 'claude-cli-subscription.x.y.1', version: 1, scopeId: 'test',
  reference: { providerId: 'x', providerVersion: 1, modelId: 'y', modelVersion: 1 }, bindingDigest: 'a'.repeat(64), protocol: { family: 'claude-code-stream-json', version: 'v1' },
  adapter: { id: 'native-cli-headless', version: 1, definition: { schemaVersion: 1, executable: '/opt/cli', configDir: '/home/p/.claude', stateDir: '/var/state/headless/x',
    ownerUid: 1000, minCliVersion: '2.1.0', delegatedUse: null } }, allocation: { id: 'a', maxCalls: null, maxInFlight: 1 },
  limits: { requestMaxBytes: 65_536, responseMaxBytes: 65_536, timeoutMs: 5000 }, ...over });
const metered = profile({ schemaVersion: 2, billingAxis: 'metered', id: 'api.x.z.1', reference: { providerId: 'x', providerVersion: 1, modelId: 'z', modelVersion: 1 },
  adapter: { id: 'openai-chat-http', version: 5, definition: { endpoint: 'https://example.invalid/v1/chat/completions' } } });
function fixture(document: Record<string, unknown>) {
  const snapshot = { document, global: {}, project: {}, effective: createDefaultConfig(), digest: null, layer: 'project' as const, env: {} };
  let published: unknown;
  const app = new ConfigApplication({ async snapshot() { return snapshot; },
    async publish(input, planner) { const plan = await planner(snapshot); published = plan.document; return { keyPath: input.keyPath, layer: 'project', beforeDigest: null, afterDigest: digestText(JSON.stringify(plan.document)), backupPath: null, overridden: false }; },
  }, { async authorize() { return 'test-policy'; }, async audit() {} });
  return { app, published: () => published };
}
const write = (principal: typeof person | typeof mcp, value: unknown) => ({ keyPath: 'provider_invocation_profiles', value, principal, scopeId: 'test', commandId: 'c-1' });
const consented = profile({ adapter: { ...profile().adapter, definition: { ...profile().adapter.definition, delegatedUse: { consentedBy: owner, atMs: 1, classes: ['ai'] } } } });

describe('S3-3 a subscription profile is written by a person only', () => {
  it.each([
    ['grant itself consent', { schemaVersion: 1, profiles: [consented] }],
    ['remove the profile', { schemaVersion: 1, profiles: [] }],
    ['add a new one', { schemaVersion: 1, profiles: [profile(), profile({ id: 'second', reference: { providerId: 'x', providerVersion: 1, modelId: 'w', modelVersion: 1 } })] }],
  ])('refuses an AI/MCP actor that would %s, at preview and at write', async (_label, value) => {
    const f = fixture({ provider_invocation_profiles: { schemaVersion: 1, profiles: [profile()] } });
    await expect(f.app.preview('set', write(mcp, value))).rejects.toMatchObject({ code: 'HEADLESS_PERSON_REQUIRED' });
    await expect(f.app.set(write(mcp, value))).rejects.toMatchObject({ code: 'HEADLESS_PERSON_REQUIRED' });
    expect(f.published()).toBeUndefined();
  });
  it('lets the person write the consent and an AI actor change other profiles while the subscription one stays as it was', async () => {
    const f = fixture({ provider_invocation_profiles: { schemaVersion: 1, profiles: [profile()] } });
    await f.app.set(write(person, { schemaVersion: 1, profiles: [consented] }));
    expect(f.published()).toMatchObject({ provider_invocation_profiles: { profiles: [{ adapter: { definition: { delegatedUse: { classes: ['ai'] } } } }] } });
    const g = fixture({ provider_invocation_profiles: { schemaVersion: 1, profiles: [profile()] } });
    await g.app.set(write(mcp, { schemaVersion: 1, profiles: [profile(), metered] }));
    expect((g.published() as { provider_invocation_profiles: { profiles: unknown[] } }).provider_invocation_profiles.profiles).toHaveLength(2);
  });
  it('N23: the preview switch is under the AI floor; the existing models display field stays writable', () => {
    for (const key of ['models.headless.preview', 'models.headless', 'models']) expect(aiAuthorityFloor(mcp, { kind: 'config', id: `project:${key}` }, 'write')).toBe(true);
    expect(aiAuthorityFloor(mcp, { kind: 'config', id: 'project:models.retirementWarningDays' }, 'write')).toBe(false);
    expect(aiAuthorityFloor(person, { kind: 'config', id: 'global:models.headless.preview' }, 'write')).toBe(false);
  });
});
