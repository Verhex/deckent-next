import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation, configuredProjectAttachment } from '#composition/core/installation/index.js';
import { configuredAttachmentStore, inspectConfiguredInstallationSource, loadConfiguredScopeContext, loadConfiguredInstallationIdentity } from '#composition/core/scoped-request/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { FileProjectAttachmentStore, localProjectAttachmentPorts, readAttachmentBootstrapConfig, withInstallationJournal, attachmentLifecycle } from '#adapters/index.js';
import { ProjectAttachmentApplication } from '#engine/index.js';
import { clearConfigCache } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-attachment-')); roots.push(root);
  const a = join(root, 'A'), b = join(root, 'B'), env = { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') }, options = { env };
  await mkdir(a, { mode: 0o700 }); await mkdir(b, { mode: 0o700 });
  await applyPolicyTemplateInstallation(a, 'source', options);
  const make = async (target: string, failInstall = false) => {
    const config = await readAttachmentBootstrapConfig(target, options), store = configuredAttachmentStore(config, options);
    // Application-level fixture only: the public composition's real terminal witness is tested separately below.
    return { store, app: new ProjectAttachmentApplication({ store, ...localProjectAttachmentPorts(config, options, store), authorize: async () => {},
      source: (root, scope, actor) => inspectConfiguredInstallationSource(root, scope, actor, options),
      install: async (attachment, identity) => {
        if (failInstall) throw new Error('injected before installer');
        return applyPolicyTemplateInstallation(target, attachment.scopeId, options, { attachment, identity });
      } }) };
  };
  const selected = await make(a), preview = await selected.app.registrationPreview(a, 'source');
  await selected.app.register(a, 'source', preview.planDigest);
  return { root, a, b, options, make, selected };
}
describe.skipIf(process.platform !== 'linux')('shared installation / isolated project context', () => {
  it('registers explicitly, journals one attachment, replays, revokes and never creates a missing source identity', async () => {
    const f = await fixture(), original = await loadConfiguredInstallationIdentity(f.a, f.options), target = await f.make(f.b);
    const preview = await target.app.preview('target'), commandId = randomUUID();
    expect(await target.store.attachment()).toBeNull();
    const attached = await target.app.apply('target', preview.planDigest, commandId);
    expect(attached.status).toBe('attached');
    expect(await loadConfiguredInstallationIdentity(f.b, f.options)).toEqual(original);
    const context = await loadConfiguredScopeContext(f.b, 'target', f.options, 'write');
    expect(context.projectId).not.toBe((await loadConfiguredScopeContext(f.a, 'source', f.options, 'read')).projectId);
    expect(context.layout.root).toBe(join(f.b, '.deckent'));
    expect(await target.app.apply('target', preview.planDigest, commandId)).toMatchObject({ status: 'attached', attachment: attached.attachment });
    // Retained crash prefix: earlier resources published, the last attachment publication and journal commit unfinished.
    await withInstallationJournal(f.b, { timeoutMs: 2000 }, async journal => {
      const observed = await journal.observe(), { checksum: ignored, ...record } = observed.record!; void ignored;
      await journal.write(observed, { ...record, phase: 'pending', blockers: ['POLICY_TEMPLATE_NOT_APPLIED'],
        resources: record.resources.map(resource => ({ ...resource, state: resource.resource === 'projectAttachment' ? 'pending' : 'published' })) });
    });
    await rm(join(f.b, '.deckent/project-attachment.json'));
    const active = await target.store.registration();
    await target.store.hold(() => target.store.write(active, { ...active!, entries: active!.entries.map(entry => ({ ...entry, state: 'pending' })) }));
    await expect(loadConfiguredInstallationIdentity(f.b, f.options)).rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
    await (await f.make(f.b)).app.apply('target', preview.planDigest, commandId);
    expect(await loadConfiguredInstallationIdentity(f.b, f.options)).toEqual(original);
    for (const root of [f.a, f.b]) {
      await expect(attachmentLifecycle(await loadComposedConfig(root, f.options), f.options).assert()).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_LIFECYCLE_BLOCKED' });
    }
    const copy = join(f.root, 'clone'); await cp(f.b, copy, { recursive: true });
    await expect(loadConfiguredInstallationIdentity(copy, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
    const sourceIdentity = join(f.a, '.deckent/installation-identity/identity.json'), bytes = await readFile(sourceIdentity);
    await rename(sourceIdentity, `${sourceIdentity}.held`);
    await expect(loadConfiguredInstallationIdentity(f.b, f.options)).rejects.toBeDefined();
    await expect(readFile(sourceIdentity)).rejects.toMatchObject({ code: 'ENOENT' });
    await rename(`${sourceIdentity}.held`, sourceIdentity);
    expect(await readFile(sourceIdentity)).toEqual(bytes);
    await f.selected.app.revoke(attached.attachment.projectId);
    await expect(loadConfiguredInstallationIdentity(f.b, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_REVOKED' });
  });
  it('recovers a pending reservation with the same command and rejects scope, principal, drift, symlink and concurrent attachment', async () => {
    const f = await fixture(), target = await f.make(f.b, true), preview = await target.app.preview('target'), commandId = randomUUID();
    await expect(target.app.apply('target', preview.planDigest, commandId)).rejects.toThrow('injected before installer');
    expect((await target.store.registration())?.entries[0]?.state).toBe('pending');
    const recovery = await f.make(f.b);
    await expect(recovery.app.apply('other-scope', preview.planDigest, commandId)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
    const attached = await recovery.app.apply('target', preview.planDigest, commandId);
    await expect(loadConfiguredScopeContext(f.b, 'other-scope', f.options, 'write')).rejects.toBeDefined();
    const registry = await recovery.store.registration();
    const altered = { ...registry!, source: { ...registry!.source, owner: { issuer: 'other', subject: 'other' } } };
    await recovery.store.hold(() => recovery.store.write(registry, altered));
    await expect(recovery.app.preview('target')).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    await recovery.store.hold(() => recovery.store.write(altered, registry!));
    const third = join(f.root, 'C'); await mkdir(third, { mode: 0o700 });
    const next = await f.make(third), plan = await next.app.preview('third');
    const results = await Promise.allSettled([next.app.apply('third', plan.planDigest, randomUUID()), next.app.apply('third', plan.planDigest, randomUUID())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const link = join(f.root, 'link'); await symlink(f.b, link);
    await expect(f.make(link)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_UNSAFE' });
    expect((await recovery.store.registration())?.entries.find(entry => entry.attachment.projectId === attached.attachment.projectId)?.state).toBe('active');
    const publicApp = await configuredProjectAttachment(f.b, f.options);
    await expect(publicApp.revoke(attached.attachment.projectId)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    const broken = new FileProjectAttachmentStore((await loadComposedConfig(f.b, f.options)).productLayout, f.options, 1, 100);
    await expect(broken.registration()).rejects.toBeDefined();
    await writeFile(join(f.b, '.deckent/project-attachment.json'), '{}', { mode: 0o600 });
    await expect(loadConfiguredInstallationIdentity(f.b, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_INVALID' });
  });
});
