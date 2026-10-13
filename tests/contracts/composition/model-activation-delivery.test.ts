import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, afterEach, expect, it } from 'vitest';
import { admitConfiguredModelActivation } from '#composition/core/model-activation/index.js';
import { assessConfiguredModelInvocationDelivery } from '#composition/core/model-invocation/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteModelActivationStore, readLocalOsIdentity } from '#adapters/index.js';
import { modelActivationTargetId } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';

// SESSION-RESULT-LIMIT-2026-09-28: `models activate` refuses a reference whose already-declared invocation profile
// could never deliver a worst-case result on any surface — before this fix it silently activated (proven below on
// the pre-fix code by stashing src/composition/core/model-activation/internal/admit.ts).
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const reference = { providerId: 'local-llama', providerVersion: 1, modelId: 'qwen38', modelVersion: 1 };
const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'local-llama', version: 1, models: [{ id: 'qwen38',
  version: 1, nativeId: 'native-model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] }] };
const definition = { encodingVersion: 1 as const, provider: { id: 'local-llama', version: 1 }, model: catalog.providers[0]!.models[0]! };
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };

/** A profile that reuses the exact live default numbers: its own limits.responseMaxBytes equals the surface's
 * responseMaxBytes, which SESSION-RESULT-LIMIT-2026-09-28 proved can never fit (required ~2x available). */
function profile(responseMaxBytes: number) {
  return { schemaVersion: 1 as const, id: 'local-qwen', version: 1, scopeId: 'scope-a', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'openai-chat-http', version: 4, definition: { endpoint: 'http://127.0.0.1:65535/', maxOutputTokens: 8192,
      authentication: { type: 'none' as const }, tariff: { kind: 'operator-static' as const, version: 1 as const, currency: 'USD',
        inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } } },
    allocation: { id: 'allocation', maxCalls: null, maxInFlight: 2 },
    limits: { requestMaxBytes: responseMaxBytes, responseMaxBytes, timeoutMs: 60000 } };
}
async function fixture(responseMaxBytes: number | null, serviceResponseMaxBytes = 1_048_576) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-activation-delivery-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  const identity = readLocalOsIdentity();
  const target = modelActivationTargetId(reference);
  const grant = { id: 'owner', effect: 'allow' as const, actions: ['activate', 'deactivate', 'inspect'] as const, scopes: ['scope-a'],
    principals: [{ issuer: identity.issuer, subject: identity.subject }], resource: { kind: 'model-activation' as const, ids: [target] } };
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'policy-1', restrictions: [], grants: [grant] }), { mode: 0o600 });
  const config = { layout: { root: data }, storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog,
    ...(responseMaxBytes === null ? {} : { provider_invocation_profiles: { schemaVersion: 1, profiles: [profile(responseMaxBytes)] } }),
    service: { responseMaxBytes: serviceResponseMaxBytes, responseTimeoutMs: 180000, identity: { scopeId: 'scope-a', serviceId: 'local' } } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify(config), { mode: 0o600 });
  clearConfigCache();
  await loadComposedConfig(project, { env: { HOME: home, USERPROFILE: home } });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  (await openSqliteModelActivationStore(ledger, sqlite)).close(); // seed/migrate schema once; admit() itself opens 'forbid'
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const activate = { schemaVersion: 1 as const, action: 'activate' as const, commandId: 'activate-a', scopeId: 'scope-a', reference,
    expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: binding };
  return { project, env, activate, ledger };
}

describe.skipIf(process.platform === 'win32')('requires POSIX local principal; AUTHENTICATION_REQUIRED on Windows UID -1', () => {
it.each(['en', 'tr'] as const)('shows delivery findings in doctor and activation refusal in %s (live default numbers)', async locale => {
  // service.responseMaxBytes = profile.limits.responseMaxBytes = 1048576 (the exact live default combination).
  const f = await fixture(1_048_576);
  const findings = await assessConfiguredModelInvocationDelivery(f.project, { env: f.env });
  expect(findings.map(finding => finding.surface)).toEqual(['runtime-service', 'mcp']);
  const error = await admitConfiguredModelActivation(f.project, f.activate, { env: f.env }).catch(error => error);
  expect(error).toMatchObject({ code: 'MODEL_ACTIVATION_DELIVERY_UNFIT', params: { profile: 'local-qwen', surface: 'runtime-service',
    required: findings[0]!.requiredBytes, available: findings[0]!.availableBytes } });
  const message = error.localize(locale).message;
  for (const value of ['local-qwen', 'runtime-service', String(findings[0]!.requiredBytes), String(findings[0]!.availableBytes),
    'service.responseMaxBytes', 'limits.responseMaxBytes']) expect(message).toContain(value);
  const lines: string[] = [], stdout = { write(text: string) { lines.push(text); return true; } };
  const context = { root: f.project, env: f.env, stdout, assessModelInvocationDelivery: assessConfiguredModelInvocationDelivery };
  await runKernelCommand(['doctor', '--lang', locale], context);
  const rendered = lines.join('').split('\n').filter(line => line.includes('local-qwen'));
  expect(rendered).toHaveLength(findings.length);
  findings.forEach((finding, index) => {
    for (const value of ['local-llama@1/qwen38@1', 'scope-a', finding.surface, String(finding.requiredBytes), String(finding.availableBytes),
      finding.surface === 'mcp' ? 'mcp.responseMaxBytes' : 'service.responseMaxBytes', 'limits.responseMaxBytes',
      locale === 'tr' ? 'gerekli' : 'required']) expect(rendered[index]).toContain(value);
    expect(rendered[index]).not.toContain('127.0.0.1');
  });
  lines.length = 0;
  await runKernelCommand(['doctor', '--json', '--lang', locale], context);
  expect(JSON.parse(lines.join('')).modelInvocationDelivery).toEqual(findings);
  const store = await openSqliteModelActivationStore(f.ledger, sqlite, 'forbid');
  try { expect(await store.loadRecord('scope-a', reference)).toBeNull(); expect(await store.loadReceipt('scope-a', 'activate-a')).toBeNull(); }
  finally { store.close(); }
  const mcpOnly = await fixture(1_048_576, 8_388_608);
  const mcpFinding = await assessConfiguredModelInvocationDelivery(mcpOnly.project, { env: mcpOnly.env });
  expect(mcpFinding.map(finding => finding.surface)).toEqual(['mcp']);
  const mcpError = await admitConfiguredModelActivation(mcpOnly.project, mcpOnly.activate, { env: mcpOnly.env }).catch(error => error);
  expect(mcpError).toMatchObject({ code: 'MODEL_ACTIVATION_DELIVERY_UNFIT', params: { profile: 'local-qwen', surface: 'mcp',
    required: mcpFinding[0]!.requiredBytes, available: mcpFinding[0]!.availableBytes } });
  expect(mcpError.localize(locale).message).toContain('mcp.responseMaxBytes');
  expect(mcpError.localize(locale).message).not.toContain('service.responseMaxBytes');
});
it('admits activation when the already-declared profile fits every surface', async () => {
  // A profile whose own response cap is comfortably under half the service capacity fits (measured, not assumed).
  const f = await fixture(64 * 1024);
  const result = await admitConfiguredModelActivation(f.project, f.activate, { env: f.env });
  expect(result).toMatchObject({ replayed: false, receipt: { record: { state: 'active', revision: 1 } } });
  for (const locale of ['en', 'tr']) {
    const lines: string[] = [];
    await runKernelCommand(['doctor', '--lang', locale], { root: f.project, env: f.env,
      stdout: { write(text: string) { lines.push(text); return true; } }, assessModelInvocationDelivery: assessConfiguredModelInvocationDelivery });
    expect(lines.join('')).not.toContain('limits.responseMaxBytes');
  }
});
it('admits activation when no profile is declared yet for this reference (the common case: nothing to protect)', async () => {
  const f = await fixture(null);
  const result = await admitConfiguredModelActivation(f.project, f.activate, { env: f.env });
  expect(result).toMatchObject({ replayed: false, receipt: { record: { state: 'active', revision: 1 } } });
});

});
