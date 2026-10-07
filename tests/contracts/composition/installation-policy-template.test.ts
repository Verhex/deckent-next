import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, afterEach, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation, inspectPolicyTemplate, previewPolicyTemplateInstallation, upgradePolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { FileInstallationIdentityStore, readLocalOsIdentity } from '#adapters/index.js';

import { clearConfigCache, resolveProductLayout } from '#platform/index.js';
import { installationBindingNotRunReason } from '../support/binding-capability.js';
const bindingNotRun = await installationBindingNotRunReason();

// SCR-B (owner 2026-09-28, checkpoint option B, proof/SCR-B-2026-09-28/review.md): a real journal + real adapters
// end to end. No Docker, no pool, no config.json is ever created or required for this path.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() { const root = await mkdtemp(join(tmpdir(), 'deckent-policy-template-')); roots.push(root); return root; }

describe.skipIf(process.platform === 'win32')('requires POSIX local principal and private installation journal', () => {
it('previews without touching disk, then a real apply journals and writes policy.json + bindings.json privately; a repeated apply is a byte-identical replay', async () => {
  const root = await project();
  const preview = await previewPolicyTemplateInstallation(root, 'installation');
  expect(preview).toMatchObject({ status: 'preview', scopeId: 'installation', template: { id: 'first-run-template', version: 5 } });
  await expect(stat(join(root, '.deckent'))).rejects.toMatchObject({ code: 'ENOENT' });
  const identity = readLocalOsIdentity();
  expect(preview.principal).toEqual({ issuer: identity.issuer, subject: identity.subject });
  expect(await inspectPolicyTemplate(root)).toBeNull(); // no policy file yet

  const result = await applyPolicyTemplateInstallation(root, 'installation');
  expect(result).toMatchObject({ status: 'installed', template: { id: 'first-run-template', version: 5 }, scopeId: 'installation' });
  const policyPath = join(root, '.deckent/policy.json'), bindingsPath = join(root, '.deckent/bindings.json');
  const policyBytes = await readFile(policyPath, 'utf8'), bindingsBytes = await readFile(bindingsPath, 'utf8');
  const identityPaths = ['installation-identity', 'project-identity'].map(name => join(root, '.deckent', name, 'identity.json'));
  const identities = await Promise.all(identityPaths.map(path => readFile(path, 'utf8')));
  expect(JSON.parse(identities[0]!)).toHaveProperty('installationId'); expect(JSON.parse(identities[1]!)).toHaveProperty('projectId');
  expect(JSON.parse(policyBytes)).toMatchObject({ schemaVersion: 2, revision: 'first-run-template-v5' });
  expect(JSON.parse(bindingsBytes)).toEqual({ schemaVersion: 1, revision: 'first-run-template-v5-bindings', bindings: [] });
  expect((await stat(policyPath)).mode & 0o777).toBe(0o600); expect((await stat(bindingsPath)).mode & 0o777).toBe(0o600);

  expect(await inspectPolicyTemplate(root)).toEqual({ id: 'first-run-template', version: 5 });

  const replay = await applyPolicyTemplateInstallation(root, 'installation');
  expect(replay).toMatchObject({ status: 'replayed' });
  expect(await readFile(policyPath, 'utf8')).toBe(policyBytes);
  expect(await readFile(bindingsPath, 'utf8')).toBe(bindingsBytes);
  expect(await Promise.all(identityPaths.map(path => readFile(path, 'utf8')))).toEqual(identities);
});

it('migrates exactly an untouched first-run v4 policy to v5 (owner 2026-10-07): preview reads only, apply writes once through the authority writer, bindings stay', async () => {
  const root = await project();
  await applyPolicyTemplateInstallation(root, 'installation');
  const policyPath = join(root, '.deckent/policy.json'), bindingsPath = join(root, '.deckent/bindings.json');
  const v5 = JSON.parse(await readFile(policyPath, 'utf8')) as { revision: string; grants: { id: string; resource: { ids: unknown } }[] };
  // The bytes alpha.10 `init policy` wrote: v5 without the MCP rules, read tools without the proposal tool, the v4 revision.
  const v4 = { ...v5, revision: 'first-run-template-v4', grants: v5.grants.filter(grant => !['first-run-mcp-servers', 'first-run-mcp-call-operation'].includes(grant.id))
    .map(grant => grant.id === 'first-run-read-tools' ? { ...grant, resource: { ...grant.resource, ids: (grant.resource.ids as string[]).filter(name => name !== 'propose_mcp_server') } } : grant) };
  await writeFile(policyPath, `${JSON.stringify(v4)}\n`, { mode: 0o600 });
  const bindingsBefore = await readFile(bindingsPath, 'utf8'), v4Bytes = await readFile(policyPath, 'utf8');
  expect(await inspectPolicyTemplate(root)).toEqual({ id: 'first-run-template', version: 4 });

  const preview = await upgradePolicyTemplateInstallation(root, 'installation', false);
  expect(preview).toMatchObject({ status: 'preview', template: { from: 4, to: 5 } });
  expect(preview.rules.map(rule => (rule as { id: string }).id)).toEqual(['first-run-read-tools', 'first-run-mcp-servers', 'first-run-mcp-call-operation']);
  expect(await readFile(policyPath, 'utf8')).toBe(v4Bytes);

  expect(await upgradePolicyTemplateInstallation(root, 'installation', true)).toMatchObject({ status: 'upgraded', template: { from: 4, to: 5 } });
  expect(JSON.parse(await readFile(policyPath, 'utf8'))).toEqual(v5);
  expect(await readFile(bindingsPath, 'utf8')).toBe(bindingsBefore);
  expect((await stat(policyPath)).mode & 0o777).toBe(0o600);
  expect(await inspectPolicyTemplate(root)).toEqual({ id: 'first-run-template', version: 5 });
  expect(await upgradePolicyTemplateInstallation(root, 'installation', true)).toMatchObject({ status: 'current' });
});

it('never rewrites a changed v4 policy: the upgrade is unavailable, the bytes stay, and the result lists the v5 rules as the explicit step', async () => {
  const root = await project();
  await applyPolicyTemplateInstallation(root, 'installation');
  const policyPath = join(root, '.deckent/policy.json');
  const v5 = JSON.parse(await readFile(policyPath, 'utf8')) as { grants: { id: string }[] };
  const edited = { ...v5, revision: 'a-0000000000000000000000000000000000000000', grants: v5.grants.filter(grant => grant.id !== 'first-run-mcp-servers') };
  await writeFile(policyPath, `${JSON.stringify(edited)}\n`, { mode: 0o600 });
  const before = await readFile(policyPath, 'utf8');
  const result = await upgradePolicyTemplateInstallation(root, 'installation', true);
  expect(result).toMatchObject({ status: 'unavailable', reason: 'not-v4-template' });
  expect(result.rules).toHaveLength(3);
  expect(await readFile(policyPath, 'utf8')).toBe(before);
});

it('never overwrites an existing, different policy.json: apply refuses before any journal entry, the file stays byte-identical, and doctor does not recognize it', async () => {
  const root = await project();
  await mkdir(join(root, '.deckent'), { mode: 0o700, recursive: true });
  const before = `${JSON.stringify({ schemaVersion: 1, revision: 'hand-authored', grants: [], restrictions: [] })}\n`;
  await writeFile(join(root, '.deckent/policy.json'), before, { mode: 0o600 });
  expect(await inspectPolicyTemplate(root)).toBeNull();

  await expect(applyPolicyTemplateInstallation(root, 'installation')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });

  expect(await readFile(join(root, '.deckent/policy.json'), 'utf8')).toBe(before);
  await expect(stat(join(root, '.deckent/bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(root, '.deckent/installation/journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await inspectPolicyTemplate(root)).toBeNull();
});

it('two different scopes cannot both occupy the same project\'s one installation journal', async () => {
  const root = await project();
  await applyPolicyTemplateInstallation(root, 'installation');
  await expect(applyPolicyTemplateInstallation(root, 'other-scope')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
});

});

it.skipIf(process.platform !== 'linux' || bindingNotRun !== null)('[requires installation binding] refuses copied identity before direct policy setup publishes policy, bindings or journal', async () => {
  const original = await project(), copied = await project();
  await new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: original })).loadOrCreate();
  await mkdir(join(copied, '.deckent'), { mode: 0o700 });
  await cp(join(original, '.deckent/installation-identity'), join(copied, '.deckent/installation-identity'), { recursive: true });
  const bytes = await readFile(join(copied, '.deckent/installation-identity/identity.json'));
  await expect(applyPolicyTemplateInstallation(copied, 'installation')).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
  expect(await readFile(join(copied, '.deckent/installation-identity/identity.json'))).toEqual(bytes);
  for (const name of ['policy.json', 'bindings.json', 'installation', 'project-identity']) {
    await expect(stat(join(copied, '.deckent', name))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it.skipIf(process.platform !== 'linux' || bindingNotRun !== null)('[requires installation binding] direct policy setup binds through the configured machine identity source, not the platform one', async () => {
  const root = await project(), source = join(root, 'machine-identity'); await writeFile(source, 'site-policy-template.node-0001\n');
  await mkdir(join(root, '.deckent'), { mode: 0o700 });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ installation: { machineIdentity: { source } } }), { mode: 0o600 }); clearConfigCache();
  const settings = { machineIdentity: { source } };
  const identity = await new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: root }), undefined, undefined, settings).loadOrCreate();
  const path = join(root, '.deckent/installation-identity/identity.json'), bytes = await readFile(path, 'utf8');
  expect(JSON.parse(bytes).binding).toMatchObject({ strength: 'machine', source: 'configured' });
  // Without the configured settings the policy write path would compare against the platform identity (or a weak binding) and stop as RELOCATED.
  await expect(applyPolicyTemplateInstallation(root, 'installation')).resolves.toMatchObject({ status: 'installed' });
  expect(await readFile(path, 'utf8')).toBe(bytes);
  expect(JSON.parse(bytes).installationId).toBe(identity.installationId);
  clearConfigCache();
});
