import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileInstallationIdentityStore, readLocalOsIdentity, openLocalIntegrityAuthority, acquireLedgerLock } from '#adapters/index.js';
import { clearConfigCache, resolveProductLayout, uninstallHoldPath, loadConfig, getConfigFieldDefault, productResourcePath } from '#platform/index.js';
import { previewConfiguredUninstall, applyConfiguredUninstall } from '#composition/core/installation/index.js';
// The scratch owner's session area shape (`<32 hex>/<32 hex>`); anything else under state/scratch is not its member.
const AREA = `state/scratch/${'a'.repeat(32)}/${'b'.repeat(32)}`;

it('previews real recorded global caches without writing or exposing an installation name, and always preserves project/unknown global data', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: installation identity positive requires POSIX binding'); return; }
  const root = await mkdtemp(join(tmpdir(), 'deckent-uninstall-preview-'));
  try {
    const project = join(root, 'project'), data = join(root, 'global');
    await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(data, { mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal: { scopeId: 's' } }), { mode: 0o600 });
    const actor = readLocalOsIdentity();
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [{ id: 'owner', effect: 'allow',
      actions: 'all', scopes: 'all', principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind: 'installation', ids: 'all' } }] }), { mode: 0o600 });
    const layout = resolveProductLayout({ projectRoot: project, root: data });
    await new FileInstallationIdentityStore(layout).loadOrCreate();
    await mkdir(join(data, AREA), { recursive: true, mode: 0o700 }); await writeFile(join(data, AREA, 'disposable'), 'cache', { mode: 0o600 });
    await writeFile(join(project, '.deckent/user-file'), 'KEEP PROJECT', { mode: 0o600 });
    const options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: data }, heal: false };
    const before = await readdir(root, { recursive: true }), configBefore = await readFile(join(project, '.deckent/config.json'));
    const plan = await previewConfiguredUninstall(project, false, options);
    expect(plan.items.find(item => item.resourceId === 'scratch')).toMatchObject({ action: 'remove', owner: plan.installation.id });
    expect(plan.installation).not.toHaveProperty('name'); expect(plan.installation).not.toHaveProperty('generation');
    expect(await previewConfiguredUninstall(project, false, options)).toEqual(plan);
    expect(await readdir(root, { recursive: true })).toEqual(before); expect(await readFile(join(project, '.deckent/config.json'))).toEqual(configBefore);
    expect(await readFile(join(project, '.deckent/user-file'), 'utf8')).toBe('KEEP PROJECT');
    const otherGlobal = join(root, 'shared-global');
    const foreign = await previewConfiguredUninstall(project, false, { env: { ...options.env, DECKENT_GLOBAL_HOME: otherGlobal }, heal: false });
    expect(foreign.items.every(item => item.action !== 'remove')).toBe(true);
    expect(foreign.items.find(item => item.resourceId === 'global-data')).toMatchObject({ action: 'keep', ownership: 'shared' });
    // An ancestor link can never acquire ownership by its configured spelling.
    await rm(join(data, 'state/scratch'), { recursive: true });
    await symlink(join(project, '.deckent'), join(data, 'state/scratch'));
    const unsafe = await previewConfiguredUninstall(project, false, options);
    expect(unsafe.items.find(item => item.resourceId === 'scratch')).toMatchObject({ action: 'keep', ownership: 'unknown' });
    expect(await readFile(join(project, '.deckent/user-file'), 'utf8')).toBe('KEEP PROJECT');
    await mkdir(join(data, 'customer-data'), { mode: 0o700 });
    await writeFile(join(data, 'customer-data/record'), 'CUSTOMER', { mode: 0o600 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data, resources: { scratch: 'customer-data' } }, terminal: { scopeId: 's' } }), { mode: 0o600 });
    const relocated = await previewConfiguredUninstall(project, false, options);
    expect(relocated.items.find(item => item.resourceId === 'scratch')).toMatchObject({ action: 'keep', protected: true, ownership: 'unknown' });
    expect(await readFile(join(data, 'customer-data/record'), 'utf8')).toBe('CUSTOMER');
    // Cache hits also honor the durable lifecycle fence; a malformed hold is never healed or interpreted as absent.
    await loadConfig(project, options);
    await writeFile(uninstallHoldPath(data), 'incomplete', { mode: 0o600 });
    await expect(loadConfig(project, options)).rejects.toMatchObject({ code: 'UNINSTALL_LIFECYCLE_HOLD' });
    expect((await lstat(uninstallHoldPath(data))).size).toBe(10);
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

// A trusted-witness fixture only; actual controlling-terminal acceptance remains a separate lead check.
vi.mock('#adapters/core/local-principal/internal/interactive.js', () => ({ attestLocalInteractiveTerminal: async () => true }));
// A process death inside the final tail: unlinks after `left` more calls fail; null passes every call through.
const tail = vi.hoisted(() => ({ left: null as number | null }));
vi.mock('node:fs/promises', async original => { const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, unlink: async (path: Parameters<typeof actual.unlink>[0]) => { if (tail.left !== null && tail.left-- <= 0) throw Object.assign(new Error('crash'), { code: 'EIO' }); return actual.unlink(path); } }; });

it('applies the confirmed real temp cache through the production broker and generic store, then replays without another removal', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: production admission uses Linux custody'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-uninstall-admission-'));
  try {
    const project = join(root, 'project'), data = join(root, 'global');
    for (const path of [join(project, '.deckent'), join(data, AREA)]) await mkdir(path, { mode: 0o700, recursive: true });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal: { scopeId: 's' } }), { mode: 0o600 });
    await writeFile(join(project, '.deckent/keep'), 'PROJECT', { mode: 0o600 });
    await writeFile(join(data, AREA, 'cache'), 'DISPOSABLE', { mode: 0o600 });
    // M1: a private same-user file in the canonical cache tree has no owner record; it is kept and listed.
    await writeFile(join(data, 'state/scratch/customer-record'), 'KEEP', { mode: 0o600 });
    const actor = readLocalOsIdentity();
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: ['installation', 'operation', 'approval'].map(kind => ({
      id: `owner-${kind}`, effect: 'allow', actions: 'all', scopes: 'all', principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind, ids: 'all' },
    })) }), { mode: 0o600 });
    const layout = resolveProductLayout({ projectRoot: project, root: data });
    await new FileInstallationIdentityStore(layout).loadOrCreate();
    const keyFile = getConfigFieldDefault('approvals').keyFile;
    await openLocalIntegrityAuthority(layout, keyFile, true);
    const ledger = productResourcePath(layout, 'ledger');
    const db = openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite); db.close(); await chmod(ledger, 0o600);
    const options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: data }, heal: false };
    const plan = await previewConfiguredUninstall(project, false, options), command = { schemaVersion: 1, commandId: 'confirmed-card', planDigest: plan.planDigest };
    const busy = acquireLedgerLock(`${ledger}-lock`);
    try {
      await expect(applyConfiguredUninstall(project, command, { confirm: async () => true }, options)).rejects.toMatchObject({ code: 'UNINSTALL_WORK_ACTIVE' });
      expect(await readFile(join(data, AREA, 'cache'), 'utf8')).toBe('DISPOSABLE');
      await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { busy.release(); }
    let cards = 0;
    const result = await applyConfiguredUninstall(project, command, { confirm: async shown => { cards++; expect(shown).toEqual(plan); return true; } }, options);
    expect(plan.items.find(item => item.resourceId === 'scratch')).toMatchObject({ action: 'remove', members: [join(data, AREA)] });
    expect(plan.items.find(item => item.locator === join(data, 'state/scratch/customer-record'))).toMatchObject({ action: 'keep', ownership: 'unknown' });
    expect(result.status).toBe('completed'); expect(cards).toBe(1);
    await expect(lstat(join(data, 'state/scratch', 'a'.repeat(32)))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(data, 'state/scratch/customer-record'), 'utf8')).toBe('KEEP');
    expect(await readFile(join(project, '.deckent/keep'), 'utf8')).toBe('PROJECT');
    expect(await lstat(ledger)).toBeTruthy(); expect(await lstat(join(data, 'approvals', keyFile))).toBeTruthy();
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await applyConfiguredUninstall(project, { ...command, commandId: 'replay' }, { confirm: async () => true }, options)).status).toBe('noop');
    const effects = JSON.parse(await readFile(join(result.recoveryLocation!, 'effects.json'), 'utf8'));
    expect(effects.body.records).toHaveLength(1); expect(effects.body.records[0]).toMatchObject({ state: 'settled', intent: { approval: { approvalId: expect.any(String) } } });
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('purges only the exact backed-up authority files, keeps every unrecorded or shared file, reconciles an interrupted final tail without deleting again and restores through deckent backup restore', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: native purge custody is Linux-only'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const { verifyBackupSet } = await import('#adapters/core/backup-store/index.js');
  const { uninstallRecoveryDirectory } = await import('#adapters/core/installation-removal/index.js');
  const { executeConfiguredBackup } = await import('#composition/core/backup/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-purge-'));
  try {
    const project = join(root, 'project'), data = join(root, 'global');
    for (const path of [join(project, '.deckent'), join(data, 'runs'), join(data, 'audit')]) await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal: { scopeId: 's' } }), { mode: 0o600 });
    await writeFile(join(project, '.deckent/customer'), 'KEEP PROJECT', { mode: 0o600 });
    await writeFile(join(data, 'secrets.json'), 'SHARED KEEP', { mode: 0o600 });
    const actor = readLocalOsIdentity();
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: ['installation', 'operation', 'approval', 'backup'].map(kind => ({
      id: `owner-${kind}`, effect: 'allow', actions: 'all', scopes: 'all', principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind, ids: 'all' },
    })) }), { mode: 0o600 });
    await writeFile(join(data, 'bindings.json'), JSON.stringify({ schemaVersion: 1, revision: 'b1', bindings: [] }), { mode: 0o600 });
    const layout = resolveProductLayout({ projectRoot: project, root: data });
    await new FileInstallationIdentityStore(layout).loadOrCreate();
    const keyFile = getConfigFieldDefault('approvals').keyFile;
    await openLocalIntegrityAuthority(layout, keyFile, true);
    const ledger = productResourcePath(layout, 'ledger'); await mkdir(join(data, 'state'), { mode: 0o700 });
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    // M1: private same-user files in canonical trees and member directories are no recorded member of this installation.
    const strays = [join(data, 'runs/customer-record'), join(data, 'audit/company-record'), join(data, 'installation-identity/foreign-note'), join(data, 'approvals/other-company.key')];
    for (const path of strays) await writeFile(path, 'FOREIGN KEEP', { mode: 0o600 });
    const members = [ledger, join(data, 'bindings.json'), join(data, 'policy.json'), join(data, 'installation-identity/identity.json'), join(data, 'approvals', keyFile)];
    const policyBytes = await readFile(join(data, 'policy.json'));
    const options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: data }, heal: false }, phrase = 'temporary-only-test-passphrase';
    const plan = await previewConfiguredUninstall(project, true, options);
    expect(plan.blockers).toEqual([]);
    expect(plan.items.filter(item => item.action === 'remove')).toEqual([expect.objectContaining({ resourceId: 'global-data', members })]);
    for (const locator of [join(data, 'runs'), join(data, 'audit'), ...strays.slice(2)]) expect(plan.items.find(item => item.locator === locator)).toMatchObject({ action: 'keep' });
    expect(plan.items.find(item => item.resourceId === 'shared.secrets.json')).toMatchObject({ action: 'keep', ownership: 'shared' });
    const cancelled = await applyConfiguredUninstall(project, { schemaVersion: 1, commandId: 'cancel-purge', planDigest: plan.planDigest }, {
      backupPassphrase: async () => phrase, confirm: async () => false,
    }, options);
    expect(cancelled.status).toBe('cancelled'); expect(await lstat(ledger)).toBeTruthy();
    (await verifyBackupSet(cancelled.backup.destination!, phrase, getConfigFieldDefault('installation').packageMeasurement)).close();
    let cards = 0;
    const result = await applyConfiguredUninstall(project, { schemaVersion: 1, commandId: 'purge', planDigest: plan.planDigest }, {
      backupPassphrase: async () => phrase, confirm: async shown => { cards++; expect(shown).toEqual(plan); return true; },
    }, options);
    expect(result.status).toBe('completed'); expect(cards).toBe(1); expect(result.backup.destination).not.toBe(cancelled.backup.destination);
    for (const path of members) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const path of strays) expect(await readFile(path, 'utf8')).toBe('FOREIGN KEEP');
    expect(await readFile(join(project, '.deckent/customer'), 'utf8')).toBe('KEEP PROJECT');
    expect(await readFile(join(data, 'secrets.json'), 'utf8')).toBe('SHARED KEEP');
    const finalSet = result.backup.destination!, verified = await verifyBackupSet(finalSet, phrase, getConfigFieldDefault('installation').packageMeasurement);
    expect(verified.state.installationId).toBe(plan.installation.id); verified.close();
    const replay = await previewConfiguredUninstall(project, true, options);
    expect(replay.items.every(item => item.action === 'keep')).toBe(true);
    expect((await applyConfiguredUninstall(project, { schemaVersion: 1, commandId: 'replay', planDigest: replay.planDigest }, { confirm: async () => { throw Error('unexpected prompt'); } }, options)).status).toBe('noop');
    // M3: a crash after the final tail but before the tombstone/hold transition. Policy, identity and key are gone; the durable intent
    // plus a fresh observation reconciles the outcome (read-only on preview), never by a second deletion.
    const directory = uninstallRecoveryDirectory(data), hold = JSON.stringify({ body: { schemaVersion: 1, installationId: plan.installation.id, planDigest: plan.planDigest }, keyId: 'purged', mac: 'unverifiable' });
    const crash = async () => { for (const name of [`${plan.planDigest}.tombstone.json`, 'tombstone.json']) await rm(join(directory, name), { force: true }); await writeFile(uninstallHoldPath(data), hold, { mode: 0o600 }); };
    await crash();
    const pending = await previewConfiguredUninstall(project, true, options);
    expect(pending).toEqual(replay); expect(await lstat(uninstallHoldPath(data))).toBeTruthy();
    expect((await applyConfiguredUninstall(project, { schemaVersion: 1, commandId: 'after-crash', planDigest: pending.planDigest }, { confirm: async () => { throw Error('unexpected prompt'); } }, options)).status).toBe('noop');
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' }); expect(await lstat(join(directory, 'tombstone.json'))).toBeTruthy();
    // M3/D2: a member recreated with the same bytes is not the purged file (new inode): held as unknown, nothing deleted, no success.
    await crash(); await writeFile(join(data, 'policy.json'), policyBytes, { mode: 0o600 });
    await expect(previewConfiguredUninstall(project, true, options)).rejects.toMatchObject({ code: 'UNINSTALL_FINAL_TAIL_UNKNOWN' });
    await expect(applyConfiguredUninstall(project, { schemaVersion: 1, commandId: 'partial', planDigest: pending.planDigest }, { confirm: async () => true }, options)).rejects.toMatchObject({ code: 'UNINSTALL_FINAL_TAIL_UNKNOWN' });
    expect(await readFile(join(data, 'policy.json'))).toEqual(policyBytes); expect(await lstat(uninstallHoldPath(data))).toBeTruthy();
    // C2/D2: the managed restore of exactly the intent's final set works from the held state (no hand-removed hold), preserves the
    // recreated file, retires the intent and releases the hold; the installation then previews normally.
    await executeConfiguredBackup(project, { schemaVersion: 1, action: 'restore', scopeId: 's', set: finalSet, target: project, confirmTarget: project }, phrase, options);
    expect(await readFile(join(data, 'policy.json'))).toEqual(policyBytes);
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(data)).some(name => name.startsWith('policy.json.damaged-'))).toBe(true);
    await expect(lstat(join(directory, 'final-tail.json'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(await lstat(join(directory, `${plan.planDigest}.restored.json`))).toBeTruthy();
    const reopened = await previewConfiguredUninstall(project, false, options); expect(reopened.blockers).toEqual([]);
    expect((await applyConfiguredUninstall(project, { schemaVersion: 1, commandId: 'after-restore', planDigest: reopened.planDigest }, { confirm: async () => true }, options)).status).toMatch(/^(completed|noop)$/);
    for (const path of members) expect(await lstat(path)).toBeTruthy();
    for (const path of [strays[0]!, strays[3]!]) expect(await readFile(path, 'utf8')).toBe('FOREIGN KEEP');
    expect(await readFile(join(data, 'secrets.json'), 'utf8')).toBe('SHARED KEEP');
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('keeps purge closed before any backup or hold when a legal hold names a company scope no allow lists, and when recorded scopes cannot be read', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: native purge custody is Linux-only'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const { DatabaseSync } = await import('node:sqlite');
  const { uninstallRecoveryDirectory } = await import('#adapters/core/installation-removal/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-purge-hold-'));
  try {
    const project = join(root, 'project'), data = join(root, 'global');
    for (const path of [join(project, '.deckent'), join(data, AREA)]) await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal: { scopeId: 's' } }), { mode: 0o600 });
    await writeFile(join(data, AREA, 'cache'), 'DISPOSABLE', { mode: 0o600 });
    const actor = readLocalOsIdentity();
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', grants: ['installation', 'operation', 'approval', 'backup'].map(kind => ({
      id: `owner-${kind}`, effect: 'allow', actions: 'all', scopes: 'all', principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind, ids: 'all' },
    })), restrictions: [{ id: 'legal-hold-retained-company', actions: ['purge'], scopes: ['retained-company'], principals: 'all', resource: { kind: 'installation', ids: 'all' } }] }), { mode: 0o600 });
    const layout = resolveProductLayout({ projectRoot: project, root: data });
    await new FileInstallationIdentityStore(layout).loadOrCreate();
    await openLocalIntegrityAuthority(layout, getConfigFieldDefault('approvals').keyFile, true);
    const ledger = productResourcePath(layout, 'ledger'); await mkdir(join(data, 'state'), { recursive: true, mode: 0o700 });
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    const options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: data }, heal: false };
    const plan = await previewConfiguredUninstall(project, true, options);
    expect(plan.scopeSummary).toContain('retained-company');
    await expect(applyConfiguredUninstall(project, { schemaVersion: 1, commandId: 'held', planDigest: plan.planDigest }, { backupPassphrase: async () => 'unused', confirm: async () => true }, options))
      .rejects.toMatchObject({ code: 'UNINSTALL_PURGE_DENIED', params: { owner: 'legal-hold-retained-company' } });
    await expect(lstat(uninstallRecoveryDirectory(data))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' }); expect(await lstat(ledger)).toBeTruthy();
    // Unreadable recorded company scopes: no retention rule can be checked for all data, so nothing is admitted or removed.
    const db = new DatabaseSync(ledger); try { db.exec('DROP TABLE scope_registry'); } finally { db.close(); }
    const shallow = await previewConfiguredUninstall(project, false, options);
    await expect(applyConfiguredUninstall(project, { schemaVersion: 1, commandId: 'unverified', planDigest: shallow.planDigest }, { confirm: async () => true }, options))
      .rejects.toMatchObject({ code: 'UNINSTALL_SCOPE_UNVERIFIED' });
    expect(await readFile(join(data, AREA, 'cache'), 'utf8')).toBe('DISPOSABLE');
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('blocks the whole purge before any backup, hold or cache removal when an authority file is unsafe or relocated, naming its exact path', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: native purge custody is Linux-only'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const { uninstallRecoveryDirectory } = await import('#adapters/core/installation-removal/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-purge-unsafe-'));
  try {
    const project = join(root, 'project'), data = join(root, 'global');
    for (const path of [join(project, '.deckent'), join(data, AREA), join(data, 'state')]) await mkdir(path, { recursive: true, mode: 0o700 });
    const config = (resources: Record<string, string> = {}) => writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data, resources }, terminal: { scopeId: 's' } }), { mode: 0o600 });
    await config(); await writeFile(join(data, AREA, 'cache'), 'DISPOSABLE', { mode: 0o600 });
    const actor = readLocalOsIdentity();
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: ['installation', 'operation', 'approval', 'backup'].map(kind => ({
      id: `owner-${kind}`, effect: 'allow', actions: 'all', scopes: 'all', principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind, ids: 'all' } })) }), { mode: 0o600 });
    // A same-user bindings file readable by others is not a private member: the purge stops instead of silently keeping the authority set.
    await writeFile(join(data, 'bindings.json'), JSON.stringify({ schemaVersion: 1, revision: 'b1', bindings: [] }), { mode: 0o644 });
    const layout = resolveProductLayout({ projectRoot: project, root: data });
    await new FileInstallationIdentityStore(layout).loadOrCreate();
    await openLocalIntegrityAuthority(layout, getConfigFieldDefault('approvals').keyFile, true);
    const ledger = productResourcePath(layout, 'ledger');
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    const options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: data }, heal: false };
    const unsafe = await previewConfiguredUninstall(project, true, options);
    expect(unsafe.blockers).toContain(`authority-unsafe:${join(data, 'bindings.json')}`);
    expect(unsafe.items.some(item => item.resourceId === 'global-data')).toBe(false);
    await expect(applyConfiguredUninstall(project, { schemaVersion: 1, commandId: 'unsafe', planDigest: unsafe.planDigest }, { backupPassphrase: async () => 'unused', confirm: async () => true }, options))
      .rejects.toMatchObject({ code: 'UNINSTALL_AUTHORITY_UNVERIFIED', params: { path: join(data, 'bindings.json') } });
    expect(await readFile(join(data, AREA, 'cache'), 'utf8')).toBe('DISPOSABLE');
    await expect(lstat(uninstallRecoveryDirectory(data))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    // A relocated authority file is never followed to its configured spelling; the data-keeping uninstall stays available.
    await chmod(join(data, 'bindings.json'), 0o600); await config({ bindings: 'moved/bindings.json' }); clearConfigCache();
    const moved = await previewConfiguredUninstall(project, true, options);
    expect(moved.blockers).toContain(`authority-relocated:${join(data, 'moved/bindings.json')}`);
    expect((await previewConfiguredUninstall(project, false, options)).blockers).toEqual([]);
    expect(await lstat(join(data, 'bindings.json'))).toBeTruthy(); expect(await lstat(ledger)).toBeTruthy();
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('resumes an interrupted final tail only through a second card that lists the remaining members, verifies the final set with the passphrase and decides the delete permission again', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: native purge custody is Linux-only'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-purge-resume-'));
  try {
    const project = join(root, 'project'), data = join(root, 'global');
    for (const path of [join(project, '.deckent'), join(data, 'state')]) await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal: { scopeId: 's' } }), { mode: 0o600 });
    const actor = readLocalOsIdentity();
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: ['installation', 'operation', 'approval', 'backup'].map(kind => ({
      id: `owner-${kind}`, effect: 'allow', actions: 'all', scopes: 'all', principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind, ids: 'all' } })) }), { mode: 0o600 });
    await writeFile(join(data, 'bindings.json'), JSON.stringify({ schemaVersion: 1, revision: 'b1', bindings: [] }), { mode: 0o600 });
    const layout = resolveProductLayout({ projectRoot: project, root: data });
    await new FileInstallationIdentityStore(layout).loadOrCreate();
    const keyFile = getConfigFieldDefault('approvals').keyFile;
    await openLocalIntegrityAuthority(layout, keyFile, true);
    const ledger = productResourcePath(layout, 'ledger');
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    const members = [ledger, join(data, 'bindings.json'), join(data, 'policy.json'), join(data, 'installation-identity/identity.json'), join(data, 'approvals', keyFile)];
    const options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: data }, heal: false }, phrase = 'temporary-only-test-passphrase';
    const plan = await previewConfiguredUninstall(project, true, options);
    tail.left = 4; // the process "dies" inside the final tail after policy.json is gone: authority must come from the verified set
    let interrupted;
    try { interrupted = await applyConfiguredUninstall(project, { schemaVersion: 1, commandId: 'crash', planDigest: plan.planDigest }, { backupPassphrase: async () => phrase, confirm: async () => true }, options); }
    finally { tail.left = null; }
    expect(interrupted.status).toBe('unknown'); expect(await lstat(uninstallHoldPath(data))).toBeTruthy();
    const remaining: string[] = []; for (const path of members) if (await lstat(path).catch(() => null)) remaining.push(path);
    expect(remaining.length).toBeGreaterThan(0); expect(remaining).not.toContain(join(data, 'policy.json'));
    const second = await previewConfiguredUninstall(project, true, options);
    expect(second.items.filter(item => item.action === 'remove')).toEqual([expect.objectContaining({ resourceId: 'global-data', members: remaining, reason: 'resume' })]);
    const command = { schemaVersion: 1, commandId: 'resume', planDigest: second.planDigest };
    // Cancelling the second card deletes nothing; a wrong passphrase cannot verify the set, so nothing is deleted either.
    expect((await applyConfiguredUninstall(project, command, { backupPassphrase: async () => { throw Error('unexpected prompt'); }, confirm: async () => false }, options)).status).toBe('cancelled');
    await expect(applyConfiguredUninstall(project, command, { backupPassphrase: async () => 'wrong-passphrase', confirm: async () => true }, options)).rejects.toMatchObject({ code: 'BACKUP_PASSPHRASE_INVALID' });
    for (const path of remaining) expect(await lstat(path)).toBeTruthy();
    expect(await lstat(uninstallHoldPath(data))).toBeTruthy();
    let cards = 0;
    const resumed = await applyConfiguredUninstall(project, command, { backupPassphrase: async () => phrase, confirm: async shown => { cards++; expect(shown).toEqual(second); return true; } }, options);
    expect(resumed).toMatchObject({ status: 'completed', planDigest: second.planDigest }); expect(cards).toBe(1);
    for (const path of members) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    const replay = await previewConfiguredUninstall(project, true, options);
    expect(replay.items.every(item => item.action === 'keep')).toBe(true);
  } finally { tail.left = null; clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('purges a tree only through its owner\'s signed records that the final set restores; unsigned, renamed and unready trees stay and are listed', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: native purge custody is Linux-only'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const { executeConfiguredBackup } = await import('#composition/core/backup/index.js');
  const { verifyAuditRecord } = await import('#engine/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-purge-tree-'));
  try {
    const project = join(root, 'project'), data = join(root, 'global');
    for (const path of [join(project, '.deckent'), join(data, 'state'), join(data, 'audit/authority-revisions'), join(data, 'artifacts', 'a'.repeat(64))]) await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal: { scopeId: 's' } }), { mode: 0o600 });
    const actor = readLocalOsIdentity();
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: ['installation', 'operation', 'approval', 'backup'].map(kind => ({
      id: `owner-${kind}`, effect: 'allow', actions: 'all', scopes: 'all', principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind, ids: 'all' } })) }), { mode: 0o600 });
    await writeFile(join(data, 'bindings.json'), JSON.stringify({ schemaVersion: 1, revision: 'b1', bindings: [] }), { mode: 0o600 });
    const layout = resolveProductLayout({ projectRoot: project, root: data });
    await new FileInstallationIdentityStore(layout).loadOrCreate();
    const keyFile = getConfigFieldDefault('approvals').keyFile;
    await openLocalIntegrityAuthority(layout, keyFile, true);
    const ledger = productResourcePath(layout, 'ledger');
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    const options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: data }, heal: false }, phrase = 'temporary-only-test-passphrase';
    // The real producer: a person's backup writes its sealed operation record into audit/backup-operations.
    await executeConfiguredBackup(project, { schemaVersion: 1, action: 'create', scopeId: 's', set: join(root, 'manual-set') }, phrase, options);
    const operations = join(data, 'audit/backup-operations'), [eventId] = await readdir(operations), record = join(operations, eventId!);
    const keep = [join(operations, 'unsigned-note'), join(operations, `renamed-${eventId}`), join(data, 'audit/authority-revisions/r-1.json'), join(data, 'artifacts', 'a'.repeat(64), 'b'.repeat(64))];
    await writeFile(keep[0]!, 'FOREIGN KEEP', { mode: 0o600 }); await writeFile(keep[1]!, await readFile(record), { mode: 0o600 });
    for (const path of keep.slice(2)) await writeFile(path, 'UNREADY KEEP', { mode: 0o600 });
    const plan = await previewConfiguredUninstall(project, true, options);
    expect(plan.blockers).toEqual([]);
    expect(plan.items.find(item => item.resourceId === 'global-data')!.members).toContain(record);
    for (const locator of [...keep.slice(0, 2), join(data, 'audit/authority-revisions'), join(data, 'artifacts')]) expect(plan.items.find(item => item.locator === locator)).toMatchObject({ action: 'keep' });
    const result = await applyConfiguredUninstall(project, { schemaVersion: 1, commandId: 'tree', planDigest: plan.planDigest }, { backupPassphrase: async () => phrase, confirm: async () => true }, options);
    expect(result.status).toBe('completed');
    await expect(lstat(record)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const path of keep) expect((await readFile(path)).length).toBeGreaterThan(0);
    // The standard restore brings the record back; it verifies again with the restored installation key.
    await executeConfiguredBackup(project, { schemaVersion: 1, action: 'restore', scopeId: 's', set: result.backup.destination!, target: project, confirmTarget: project }, phrase, options);
    const restored = await openLocalIntegrityAuthority(layout, keyFile);
    expect(verifyAuditRecord(JSON.parse(await readFile(record, 'utf8')), restored).event.eventId).toBe(eventId);
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});
