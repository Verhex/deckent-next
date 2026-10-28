import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { applyPolicyTemplateInstallation, upgradePolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { evaluatorEvidence } from '#capabilities/index.js';
import { deliveryEvidenceKindSchema } from '#engine/index.js';
import { expect, it } from 'vitest';
import { BeuserContractError, BeuserTransferError } from '#engine/index.js';
import { BeuserSurfaceError } from '#adapters/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

it('keeps BeUser target, surface and sealed-backup refusals typed and localized without exposing internal detail', () => {
  const errors = [new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'), new BeuserSurfaceError('BEUSER_SURFACE_INVALID'), new BeuserTransferError()];
  const codes = ['BEUSER_TARGET_NOT_SANDBOX', 'BEUSER_SURFACE_INVALID', 'BACKUP_REALM_SEALED'];
  errors.forEach((error, index) => {
    error.message += ' /private/target/raw-screen credential=hidden';
    const mapped = queryFailure(error);
    expect(mapped.code).toBe(codes[index]);
    expect(mapped.localize?.('tr').message).not.toBe(mapped.localize?.('en').message);
    expect(mapped.suggestion).toBeTruthy();
    expect(JSON.stringify(mapped)).not.toContain('/private'); expect(JSON.stringify(mapped)).not.toContain('hidden');
  });
});

it('carries the installed harness-readback evidence label through delivery consumers', () => {
  expect(evaluatorEvidence({ id: 'beuser' })).toEqual({ kind: 'harness-readback', independent: true });
  expect(deliveryEvidenceKindSchema.parse('harness-readback')).toBe('harness-readback');
});
it('publishes rows inside the original digest, refuses changed bytes on replay and preserves revocation on same-data upgrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-c6-r3-'));
  try {
    expect(await applyPolicyTemplateInstallation(root, 'scope')).toMatchObject({ status: 'installed', systemRows: { status: 'applied' } });
    const config = await loadComposedConfig(root, { heal: false, force: true });
    const store = createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes);
    await expect(applyPolicyTemplateInstallation(root, 'scope')).resolves.toMatchObject({ status: 'replayed', systemRows: { status: 'replayed' } });
    const before = await store.updateAuthority(snapshot => ({ write: null, result: snapshot }));
    const policy = before.policy as { roles: { id: string; permissions: unknown[] }[] };
    const systemRole = policy.roles.find(role => role.id.startsWith('sr-'))!;
    expect(systemRole.permissions.length).toBeGreaterThan(1);
    await store.updateAuthority(snapshot => ({ write: { policy: { ...(snapshot.policy as object), revision: 'deleted-permission',
      roles: policy.roles.map(role => role.id === systemRole.id ? { ...role, permissions: role.permissions.slice(1) } : role) }, bindings: null, order: 'policy-first' }, result: null }), 'test-delete-permission');
    const path = join(root, '.deckent', 'policy.json'), deleted = await readFile(path, 'utf8');
    await expect(applyPolicyTemplateInstallation(root, 'scope')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
    const preview = await upgradePolicyTemplateInstallation(root, 'scope', false);
    expect(await upgradePolicyTemplateInstallation(root, 'scope', true, preview.expect ?? undefined, {}, userInfo().uid, undefined, { attest: async () => true })).toMatchObject({ status: 'current' });
    expect(await readFile(path, 'utf8')).toBe(deleted);
    // A manual edit with the same revision has no archived edge and must never be adopted on replay.
    const foreign = JSON.parse(deleted); foreign.grants[0].resource.ids = ['foreign-target'];
    await writeFile(path, JSON.stringify(foreign));
    await expect(applyPolicyTemplateInstallation(root, 'scope')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
    await writeFile(path, deleted + '\n');
    await expect(applyPolicyTemplateInstallation(root, 'scope')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
