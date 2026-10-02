import { describe, expect, it } from 'vitest';
import { ConfigApplication, ConfigApplicationError, planConfigChange, authorizeConfigWrite } from '../src/engine/core/config/index.js';
import { createDefaultConfig, validateConfig } from '../src/platform/core/config/index.js';
import { digestText } from '../src/platform/core/utils/index.js';

const principal = { id: 'test', issuer: 'local-os', subject: 'test', assurance: 'os-user', scopeIds: ['test'] } as const;
const command = { keyPath: 'max_workers', value: 2, principal, scopeId: 'test', commandId: 'config-test' };
function fixture() {
  const document = {}, effective = createDefaultConfig();
  const snapshot = { document, global: {}, project: {}, effective, digest: null, layer: 'project' as const, env: {} };
  const events: unknown[] = [];
  let published: unknown;
  const app = new ConfigApplication({
    async snapshot() { return snapshot; },
    async publish(input, planner) { const plan = await planner(snapshot); published = plan.document; return { keyPath: input.keyPath, layer: 'project', beforeDigest: null, afterDigest: digestText(JSON.stringify(plan.document)), backupPath: null, overridden: false }; },
  }, { async authorize() { return 'test-policy'; }, async audit(event) { events.push(event); } });
  return { app, events, published: () => published };
}
describe('registry config application', () => {
  it('rejects invalid fields before publish', async () => {
    const f = fixture(); await expect(f.app.set({ ...command, value: -1 })).rejects.toThrow(); expect(f.published()).toBeUndefined(); expect(f.events).toHaveLength(0);
  });
  it('refuses secrets section writes and prototype paths', () => {
    expect(() => planConfigChange({}, 'secrets.backend', 'unsafe', false)).toThrow(ConfigApplicationError);
    expect(() => planConfigChange({}, '__proto__.polluted', true, false)).toThrow(ConfigApplicationError);
  });
  it('set produces one validated document and one value-free audit event', async () => {
    const f = fixture(); await f.app.set(command); expect(f.published()).toMatchObject({ max_workers: 2 }); expect(f.events).toHaveLength(1);
    expect(JSON.stringify(f.events)).not.toContain('"value"'); validateConfig({ ...createDefaultConfig(), ...f.published() as object });
  });
  it('denies unauthorized writes before audit and publication', async () => {
    const f = fixture(); const app = new ConfigApplication({ snapshot: async () => { throw Error('should not read'); }, publish: async () => { throw Error('should not publish'); } }, { authorize: async () => { throw new ConfigApplicationError('POLICY_DENIED'); }, audit: async () => { throw Error('should not audit'); } });
    await expect(app.set(command)).rejects.toMatchObject({ code: 'POLICY_DENIED' }); expect(f.published()).toBeUndefined();
  });
  it('shows environment provenance and redacts secret-like fields', async () => {
    const f = fixture(); const view = await f.app.inspect(); expect(view.fields.find(field => field.key === 'max_workers')?.value).toBe('auto');
  });
});

it('never exposes a secret-like registered nested value', async () => {
  const effective = createDefaultConfig(); effective.layout.resources = { api_token: 'never-print-secret' };
  const app = new ConfigApplication({ snapshot: async () => ({ document: {}, global: {}, project: {}, effective, digest: null, layer: 'project', env: {} }), publish: async () => { throw Error('read only'); } }, { authorize: async () => { throw Error('read only'); }, audit: async () => { throw Error('read only'); } });
  const view = await app.explain({ keyPath: 'layout.resources.api_token' }); expect(view.value).toBe('[REDACTED]'); expect(JSON.stringify(await app.inspect())).not.toContain('never-print-secret');
});


it('preserves resolved secret provenance for leaf and parent inspection', async () => {
  const effective = createDefaultConfig(); effective.layout.resources = { credential: 'RESOLVED_SECRET_CANARY' }; effective['secretPaths'] = ['/layout/resources/credential'];
  const app = new ConfigApplication({ snapshot: async () => ({ document: {}, global: {}, project: {}, effective, digest: null, layer: 'project', env: {} }), publish: async () => { throw Error('read only'); } }, { authorize: async () => { throw Error('read only'); }, audit: async () => { throw Error('read only'); } });
  expect((await app.explain({ keyPath: 'layout.resources.credential' })).value).toBe('[REDACTED]');
  expect(JSON.stringify(await app.explain({ keyPath: 'layout.resources' }))).not.toContain('RESOLVED_SECRET_CANARY');
  expect(JSON.stringify(await app.inspect())).not.toContain('RESOLVED_SECRET_CANARY');
});

it('updates registered array items without holes and refuses noncanonical/out-of-range indexes', () => {
  const a = { id: 'a', kind: 'next-project', path: '/tmp/a', scopeId: 'test' }, b = { ...a, id: 'b' };
  const document = { inspection: { workers: { sources: [a] } } };
  const appended = planConfigChange(document, 'inspection.workers.sources.1', b, false);
  expect(appended).toMatchObject({ inspection: { workers: { sources: [a, b] } } });
  const c = { ...a, id: 'c' };
  expect(planConfigChange(appended, 'inspection.workers.sources.0', c, false)).toMatchObject({ inspection: { workers: { sources: [c, b] } } });
  expect(planConfigChange(appended, 'inspection.workers.sources.0', undefined, true)).toMatchObject({ inspection: { workers: { sources: [b] } } });
  for (const index of ['2', '-1', '01', '9007199254740992']) expect(() => planConfigChange(document, `inspection.workers.sources.${index}`, b, false)).toThrow();
});


it('audit failure applies no configuration effect', async () => {
  const effective = createDefaultConfig(); let published = false;
  const app = new ConfigApplication({ snapshot: async () => { throw Error('unused'); }, publish: async (input, plan) => {
    await plan({ document: {}, global: {}, project: {}, effective, digest: null, layer: 'project', env: {} }); published = true; throw Error('unexpected effect');
  } }, { authorize: async () => 'p1', audit: async () => { throw new ConfigApplicationError('AUDIT_UNAVAILABLE'); } });
  await expect(app.set(command)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' }); expect(published).toBe(false);
});

it('global config writes require installation authority and require-approval remains a typed refusal', () => {
  const policy = { schemaVersion: 1, revision: 'p1', grants: [{ id: 'g1', effect: 'allow', actions: ['write'], scopes: ['test'], principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'config', ids: 'all' } }], restrictions: [] };
  expect(authorizeConfigWrite(policy, principal, command)).toBe('p1');
  expect(() => authorizeConfigWrite(policy, principal, { ...command, layer: 'global' })).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
  expect(() => authorizeConfigWrite({ ...policy, grants: [{ ...policy.grants[0], effect: 'require-approval' }] }, principal, command)).toThrow(expect.objectContaining({ code: 'POLICY_APPROVAL_UNSUPPORTED' }));
});

it('compatibility lookup walks only canonical existing array indexes', async () => {
  const { getConfigValue } = await import('../src/platform/core/config/index.js');
  const document = { entries: [{ id: 'Qwen3.8-27B-INT4-W4A16' }] };
  expect(getConfigValue(document, 'entries.0.id')).toBe('Qwen3.8-27B-INT4-W4A16');
  for (const path of ['entries.01.id', 'entries.-1.id', 'entries.1.id', 'entries.length', 'entries.0.__proto__']) expect(() => getConfigValue(document, path)).toThrow();
});

it('numeric token capacity stays visible while credential token keys stay masked', async () => {
  const { configDisplayView, isSensitiveConfigKey } = await import('../src/platform/core/config/index.js');
  expect(isSensitiveConfigKey('maxOutputTokens')).toBe(false); expect(isSensitiveConfigKey('contextWindowTokens')).toBe(false);
  for (const key of ['token', 'accessToken', 'auth_token', 'foo_token', 'sessionToken', 'refreshToken', 'apiKey', 'privateKey']) expect(isSensitiveConfigKey(key)).toBe(true);
  const effective = createDefaultConfig();
  const view = configDisplayView({ ...effective, projectRoot: '/tmp/project', productLayout: {}, secretPaths: ['/credentials/arbitrary'],
    capacity: { maxOutputTokens: 32, contextWindowTokens: 64 }, credentials: { arbitrary: 'RESOLVED', accessToken: 'SECRET' } } as never);
  expect(view).toMatchObject({ capacity: { maxOutputTokens: 32, contextWindowTokens: 64 }, credentials: { arbitrary: '[REDACTED]', accessToken: '[REDACTED]' } });
});

it('refuses values that cannot preserve the JSON document contract', () => {
  for (const value of [undefined, NaN, Infinity, BigInt(1)]) expect(() => planConfigChange({}, 'max_workers', value, false)).toThrow();
});

it('refuses cyclic and accessor values as typed JSON failures before evaluating them', () => {
  const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
  expect(() => planConfigChange({}, 'layout.resources', cyclic, false)).toThrow(expect.objectContaining({ issues: [{ path: 'layout.resources', reason: 'JSON_REQUIRED' }] }));
  let reads = 0; const getter = Object.defineProperty({}, 'credential', { enumerable: true, get() { reads++; return 'PRIVATE'; } });
  expect(() => planConfigChange({}, 'layout.resources', getter, false)).toThrow(); expect(reads).toBe(0);
});
