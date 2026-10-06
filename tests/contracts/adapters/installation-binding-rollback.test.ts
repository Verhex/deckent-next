import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { installationBindingNotRunReason } from '../support/binding-capability.js';

/** Only the platform machine identity is simulated (present or absent); records, locks, paths and inodes are the real filesystem. */
const probe = vi.hoisted(() => ({ machine: undefined as string | Error | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: (...args: Parameters<typeof original.readFile>) => {
    if (args[0] === '/etc/machine-id' && probe.machine !== undefined) {
      return probe.machine instanceof Error ? Promise.reject(probe.machine) : Promise.resolve(probe.machine);
    }
    return original.readFile(...args);
  } };
});

/* Verbatim alpha.6 (main 9e01322c, src/domain/core/primitives/internal/installation-identity.ts) record contract: the only shapes a
 * rolled-back release can read. Kept here on purpose; it must not follow the current schema. */
const installationIdSchema = z.string().uuid().brand<'InstallationId'>();
const installationIdentitySchema = z.object({ schemaVersion: z.literal(1), installationId: installationIdSchema }).strict().readonly();
const installationBindingSchema = z.object({
  schemaVersion: z.literal(1), machineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalRoot: z.string().min(1), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^[1-9]\d*$/),
}).strict().readonly();
const installationIdentityChoiceSchema = z.enum(['keep', 'new']);
const installationIdentityResolutionSchema = z.object({
  schemaVersion: z.literal(1), choice: installationIdentityChoiceSchema, previousInstallationId: installationIdSchema, installationId: installationIdSchema,
  at: z.string().datetime(), principal: z.object({ issuer: z.string().min(1), subject: z.string().min(1) }).strict().readonly(),
}).strict().readonly();
const boundInstallationIdentitySchema = z.object({ schemaVersion: z.literal(2), installationId: installationIdSchema,
  binding: installationBindingSchema, lastResolution: installationIdentityResolutionSchema.nullable(),
}).strict().readonly();
const alpha6RecordSchema = z.union([boundInstallationIdentitySchema, installationIdentitySchema]);

// The package-private publication mechanism alpha.6 used (read/load path unchanged since 9e01322c), loaded like other internal fixtures.
const { IdentityFile } = await import('#adapters/core/installation-files/internal/identity-file.js');
const bindingNotRun = await installationBindingNotRunReason();
const MACHINE = '0123456789abcdef0123456789abcdef', principal = { issuer: 'host', subject: '1000' };
const roots: string[] = [];
afterEach(async () => { probe.machine = undefined; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(name = 'installation') {
  const parent = await mkdtemp(join(tmpdir(), 'deckent-binding-rollback-')); roots.push(parent);
  const root = join(parent, name); await mkdir(root);
  return { parent, root, layout: resolveProductLayout({ projectRoot: root }), path: join(root, '.deckent/installation-identity/identity.json') };
}
const alpha6 = async (path: string) => alpha6RecordSchema.safeParse(JSON.parse(await readFile(path, 'utf8'))).success;
/**
 * The alpha.6 store read path: the same IdentityFile (unchanged between alpha.6 and this branch on the read/load path) with the alpha.6
 * record parser and alpha.6 error mapping. Used to show what a rolled-back release does with a record it cannot express.
 */
const alpha6Reader = (layout: ReturnType<typeof resolveProductLayout>) => new IdentityFile(layout, 'installationIdentity', {
  parse: value => alpha6RecordSchema.parse(value),
  create: () => { throw new Error('ALPHA6_FIXTURE_NEVER_CREATES'); },
  error: reason => Object.assign(new Error(`INSTALLATION_IDENTITY_${reason}`), { code: `INSTALLATION_IDENTITY_${reason}` }),
});

describe.skipIf(process.platform !== 'linux')('binding v2 rollback compatibility with alpha.6 (expand/contract)', () => {
  it('a new platform machine binding is written in the alpha.6 v1 shape and parses with the alpha.6 schema', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await fixture(); probe.machine = MACHINE;
    const store = new FileInstallationIdentityStore(f.layout), identity = await store.loadOrCreate();
    expect(JSON.parse(await readFile(f.path, 'utf8')).binding).toMatchObject({ schemaVersion: 1 });
    expect(JSON.parse(await readFile(f.path, 'utf8')).binding).not.toHaveProperty('strength');
    expect(await alpha6(f.path)).toBe(true);
    expect(await alpha6Reader(f.layout).load()).toMatchObject({ installationId: identity.installationId });
    expect(await store.read()).toMatchObject({ status: 'available', binding: { strength: 'machine', source: 'platform' } });
  });

  it.skipIf(bindingNotRun !== null).each(['keep', 'new'] as const)('--%s on a platform machine host writes an alpha.6-readable binding', async choice => {
    const f = await fixture(); probe.machine = MACHINE;
    await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    const copy = join(f.parent, 'copy'); await cp(f.root, copy, { recursive: true });
    const store = new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: copy })), path = join(copy, '.deckent/installation-identity/identity.json');
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    await store.resolveRelocation(choice, principal);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ binding: { schemaVersion: 1 }, lastResolution: { choice } });
    expect(await alpha6(path)).toBe(true);
  });

  it('weak to platform machine strengthening writes an alpha.6-readable binding; the weak record before it is a typed INVALID for alpha.6 without heal', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await fixture(); probe.machine = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const store = new FileInstallationIdentityStore(f.layout), identity = await store.loadOrCreate(), weak = await readFile(f.path, 'utf8');
    expect(JSON.parse(weak).binding).toMatchObject({ schemaVersion: 2, strength: 'weak' });
    // Known limit (rollback note): alpha.6 cannot express a weak binding. It refuses typed and never repairs; the bytes stay.
    expect(await alpha6(f.path)).toBe(false);
    await expect(alpha6Reader(f.layout).load()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    await expect(alpha6Reader(f.layout).loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    expect(await readFile(f.path, 'utf8')).toBe(weak);
    probe.machine = MACHINE;
    expect(await store.read()).toMatchObject({ pendingWrite: true, binding: { strength: 'machine', source: 'platform' } });
    expect(await store.loadOrCreate()).toEqual(identity);
    expect(JSON.parse(await readFile(f.path, 'utf8')).binding).toMatchObject({ schemaVersion: 1 });
    expect(await alpha6(f.path)).toBe(true);
  });

  it('a configured-source binding is v2 only: alpha.6 reads it as a typed INVALID and does not heal it', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await fixture(), source = join(f.parent, 'machine-identity'); await writeFile(source, 'site-rollback.node-identity-0001\n');
    await new FileInstallationIdentityStore(f.layout, undefined, undefined, { machineIdentity: { source } }).loadOrCreate();
    const bytes = await readFile(f.path, 'utf8');
    expect(JSON.parse(bytes).binding).toMatchObject({ schemaVersion: 2, strength: 'machine', source: 'configured' });
    expect(await alpha6(f.path)).toBe(false);
    await expect(alpha6Reader(f.layout).load()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    // alpha.6 `init identity --keep` replaces the record through the same update path, which parses the current record first: also INVALID.
    await expect(alpha6Reader(f.layout).update(async current => current)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
    // The operator path that alpha.6 does accept: the same installationId as an unbound v1 record (no machine value involved).
    const { installationId } = JSON.parse(bytes); await writeFile(f.path, JSON.stringify({ schemaVersion: 1, installationId }));
    expect(await alpha6Reader(f.layout).load()).toEqual({ schemaVersion: 1, installationId });
  });
});
