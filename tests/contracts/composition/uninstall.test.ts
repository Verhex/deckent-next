import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, lstat, symlink, link, chmod, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileInstallationIdentityStore, readLocalOsIdentity, openLocalIntegrityAuthority, acquireLedgerLock } from '#adapters/index.js';
import { clearConfigCache, resolveProductLayout, uninstallHoldPath, loadConfig, getConfigFieldDefault, productResourcePath } from '#platform/index.js';
import { uninstallPlanLines, uninstallSummaryLines } from '#surfaces/core/cli-installation/index.js';
import { previewConfiguredUninstall, applyConfiguredUninstall } from '#composition/core/installation/index.js';
// The scratch owner's session area shape (`<32 hex>/<32 hex>`); anything else under state/scratch is not its member.
const AREA = `state/scratch/${'a'.repeat(32)}/${'b'.repeat(32)}`;
const KEEP = { schemaVersion: 2, tier: 'keep-data', force: false, disableUnit: false } as const, ALL = { ...KEEP, tier: 'all' } as const;
// R7: the AI/CI floor reads the real process too; these fixtures stand for a person, so the test runner's own markers are cleared (CI, agent shells).
const MARKERS = [...getConfigFieldDefault('cli').agentEnvironment, 'CI'];
beforeEach(() => { for (const name of MARKERS) vi.stubEnv(name, ''); }); afterEach(() => { vi.unstubAllEnvs(); });

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
    const plan = await previewConfiguredUninstall(project, KEEP, options);
    expect(plan.items.find(item => item.resourceId === 'scratch')).toMatchObject({ action: 'remove', owner: plan.installation.id });
    expect(plan.installation).not.toHaveProperty('name'); expect(plan.installation).not.toHaveProperty('generation');
    expect(await previewConfiguredUninstall(project, KEEP, options)).toEqual(plan);
    expect(await readdir(root, { recursive: true })).toEqual(before); expect(await readFile(join(project, '.deckent/config.json'))).toEqual(configBefore);
    expect(await readFile(join(project, '.deckent/user-file'), 'utf8')).toBe('KEEP PROJECT');
    const otherGlobal = join(root, 'shared-global');
    const foreign = await previewConfiguredUninstall(project, KEEP, { env: { ...options.env, DECKENT_GLOBAL_HOME: otherGlobal }, heal: false });
    expect(foreign.items.every(item => item.action !== 'remove')).toBe(true);
    expect(foreign.items.find(item => item.resourceId === 'global-home')).toMatchObject({ action: 'keep', ownership: 'shared' });
    // An ancestor link can never acquire ownership by its configured spelling.
    await rm(join(data, 'state/scratch'), { recursive: true });
    await symlink(join(project, '.deckent'), join(data, 'state/scratch'));
    const unsafe = await previewConfiguredUninstall(project, KEEP, options);
    expect(unsafe.items.find(item => item.resourceId === 'scratch')).toMatchObject({ action: 'keep', ownership: 'unknown' });
    expect(await readFile(join(project, '.deckent/user-file'), 'utf8')).toBe('KEEP PROJECT');
    await mkdir(join(data, 'customer-data'), { mode: 0o700 });
    await writeFile(join(data, 'customer-data/record'), 'CUSTOMER', { mode: 0o600 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data, resources: { scratch: 'customer-data' } }, terminal: { scopeId: 's' } }), { mode: 0o600 });
    const relocated = await previewConfiguredUninstall(project, KEEP, options);
    expect(relocated.items.find(item => item.resourceId === 'scratch')).toMatchObject({ action: 'keep', protected: true, ownership: 'unknown' });
    expect(await readFile(join(data, 'customer-data/record'), 'utf8')).toBe('CUSTOMER');
    // Cache hits also honor the durable lifecycle fence; a malformed hold is never healed or interpreted as absent.
    await loadConfig(project, options);
    await writeFile(uninstallHoldPath(data), 'incomplete', { mode: 0o600 });
    await expect(loadConfig(project, options)).rejects.toMatchObject({ code: 'UNINSTALL_LIFECYCLE_HOLD' });
    expect((await lstat(uninstallHoldPath(data))).size).toBe(10);
  } finally { tail.at = null; clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

// A trusted-witness fixture only; actual controlling-terminal acceptance remains a separate lead check.
vi.mock('#adapters/core/local-principal/internal/interactive.js', () => ({ attestLocalInteractiveTerminal: async () => true }));
// A process death inside the final tail: unlinks after `left` more calls fail; null passes every call through.
const tail = vi.hoisted(() => ({ left: null as number | null, at: null as string | null }));
vi.mock('node:fs/promises', async original => { const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
    // `at`: the process dies at the first unlink whose path names this text (one member of the final tail), once.
    if (tail.left !== null && tail.left-- <= 0 || tail.at && String(path).includes(tail.at) && !(tail.at = null)) throw Object.assign(new Error('crash'), { code: 'EIO' });
    return actual.unlink(path); } }; });
/** A member still there for a resumed tail: under its name, or moved aside by a removal the crash interrupted (resumed, never left as a stray). */
const unremoved = async (path: string) => !!await lstat(path).catch(() => null) || (await readdir(dirname(path)).catch(() => [] as string[])).some(name => name.startsWith(`.${basename(path)}.`) && name.endsWith('.removing'));

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
    // P5a: the CLI compile cache under this global root: Node's per-version directory is its member; a stray beside it is kept.
    const compiled = join(data, `state/compile-cache/v26.13.0-x64-0123abcd-${process.getuid!()}`);
    await mkdir(compiled, { recursive: true, mode: 0o700 }); await writeFile(join(compiled, '89abcdef'), 'CODE', { mode: 0o600 });
    await writeFile(join(data, 'state/compile-cache/stray'), 'KEEP', { mode: 0o600 });
    // Astra 2862 R2: a writer record (here of an ended process) is a member too: checked before the removal, then removed with the cache.
    const ended = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }), writers = join(data, 'state/compile-cache/writers');
    await mkdir(writers, { mode: 0o700 }); await writeFile(join(writers, `${ended}-1-a`), JSON.stringify({ schemaVersion: 1, pid: Number(ended), startedAtMs: Date.now() }), { mode: 0o600 });
    const actor = readLocalOsIdentity();
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: ['installation', 'operation', 'approval'].map(kind => ({
      id: `owner-${kind}`, effect: 'allow', actions: 'all', scopes: 'all', principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind, ids: 'all' },
    })) }), { mode: 0o600 });
    const layout = resolveProductLayout({ projectRoot: project, root: data });
    await new FileInstallationIdentityStore(layout).loadOrCreate();
    const keyFile = getConfigFieldDefault('approvals').keyFile;
    await openLocalIntegrityAuthority(layout, keyFile, true);
    const ledger = productResourcePath(layout, 'ledger');
    const db = openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite);
    // G7: more finished dispatches than one inspection page is history, never active work.
    const insert = db.prepare('INSERT INTO dispatches(scope_id,attempt_id,record) VALUES (?,?,?)');
    for (let index = 0; index <= getConfigFieldDefault('inspection').maxPageSize; index++) insert.run('s', `attempt-${index}`, JSON.stringify({ request: { identity: { runId: 'done' } }, terminal: { exitCode: 0 } }));
    db.close(); await chmod(ledger, 0o600);
    const options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: data }, heal: false };
    const plan = await previewConfiguredUninstall(project, KEEP, options), command = { schemaVersion: 2, commandId: 'confirmed-card', planDigest: plan.planDigest };
    const busy = acquireLedgerLock(`${ledger}-lock`);
    try {
      // G20 (owner 2026-10-27): the ledger custody a running service holds is "the service is running", never "work active".
      await expect(applyConfiguredUninstall(project, command, { confirm: async () => true }, options)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
      expect(await readFile(join(data, AREA, 'cache'), 'utf8')).toBe('DISPOSABLE');
      await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { busy.release(); }
    expect(plan).toMatchObject({ blockers: [], work: { running: [], complete: true } });
    // Preview reads the ledger without creating sidecars.
    for (const suffix of ['-wal', '-shm']) await expect(lstat(ledger + suffix)).rejects.toMatchObject({ code: 'ENOENT' });
    let cards = 0;
    const result = await applyConfiguredUninstall(project, command, { confirm: async shown => { cards++; expect(shown).toEqual(plan); return true; } }, options);
    expect(plan.items.find(item => item.resourceId === 'scratch')).toMatchObject({ action: 'remove', members: [join(data, AREA)] });
    expect(plan.items.find(item => item.locator === join(data, 'state/scratch/customer-record'))).toMatchObject({ action: 'keep', ownership: 'unknown' });
    expect(plan.items.find(item => item.resourceId === 'compileCache')).toMatchObject({ action: 'remove', members: [compiled, writers] });
    expect(result.status).toBe('completed'); expect(cards).toBe(1);
    await expect(lstat(join(data, 'state/scratch', 'a'.repeat(32)))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(compiled)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(lstat(writers)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(data, 'state/compile-cache/stray'), 'utf8')).toBe('KEEP');
    expect(await readFile(join(data, 'state/scratch/customer-record'), 'utf8')).toBe('KEEP');
    expect(await readFile(join(project, '.deckent/keep'), 'utf8')).toBe('PROJECT');
    expect(await lstat(ledger)).toBeTruthy(); expect(await lstat(join(data, 'approvals', keyFile))).toBeTruthy();
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await applyConfiguredUninstall(project, { ...command, commandId: 'replay' }, { confirm: async () => true }, options)).status).toBe('noop');
    const effects = JSON.parse(await readFile(join(result.recoveryLocation!, 'effects.json'), 'utf8'));
    expect(effects.body.records).toHaveLength(2);   // one settled removal per cache resource (scratch, compileCache)
    for (const record of effects.body.records) expect(record).toMatchObject({ state: 'settled', intent: { approval: { approvalId: expect.any(String) } } });
  } finally { tail.at = null; clearConfigCache(); await rm(root, { recursive: true, force: true }); }
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
    const plan = await previewConfiguredUninstall(project, ALL, options);
    expect(plan.blockers).toEqual([]);
    expect(plan.items.filter(item => item.action === 'remove')).toEqual([expect.objectContaining({ resourceId: 'global-data', members })]);
    for (const locator of [join(data, 'runs'), join(data, 'audit'), ...strays.slice(2)]) expect(plan.items.find(item => item.locator === locator)).toMatchObject({ action: 'keep' });
    expect(plan.items.find(item => item.resourceId === 'shared.secrets.json')).toMatchObject({ action: 'keep', ownership: 'shared' });
    const cancelled = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'cancel-purge', planDigest: plan.planDigest }, {
      backupPassphrase: async () => phrase, confirm: async () => false,
    }, options);
    // K7: the one card precedes the backup; a cancelled card leaves no backup and no hold. The backup lives outside every deleted folder.
    expect(cancelled.status).toBe('cancelled'); expect(await lstat(ledger)).toBeTruthy();
    await expect(lstat(cancelled.backup.destination!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(plan.backup.destination!.startsWith(join(root, 'home', '.local', 'state'))).toBe(true);
    let cards = 0;
    const result = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'purge', planDigest: plan.planDigest }, {
      backupPassphrase: async () => phrase, confirm: async shown => { cards++; expect(shown).toEqual(plan); return true; },
    }, options);
    expect(result.status).toBe('completed'); expect(cards).toBe(1); expect(result.backup.destination).not.toBe(cancelled.backup.destination);
    for (const path of members) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const path of strays) expect(await readFile(path, 'utf8')).toBe('FOREIGN KEEP');
    expect(await readFile(join(project, '.deckent/customer'), 'utf8')).toBe('KEEP PROJECT');
    expect(await readFile(join(data, 'secrets.json'), 'utf8')).toBe('SHARED KEEP');
    const finalSet = result.backup.destination!, verified = await verifyBackupSet(finalSet, phrase, getConfigFieldDefault('installation').packageMeasurement);
    expect(verified.state.installationId).toBe(plan.installation.id); verified.close();
    const replay = await previewConfiguredUninstall(project, ALL, options);
    expect(replay.items.every(item => item.action === 'keep')).toBe(true);
    expect((await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'replay', planDigest: replay.planDigest }, { confirm: async () => { throw Error('unexpected prompt'); } }, options)).status).toBe('noop');
    // M3: a crash after the final tail but before the tombstone/hold transition. Policy, identity and key are gone; the durable intent
    // plus a fresh observation reconciles the outcome (read-only on preview), never by a second deletion.
    const directory = uninstallRecoveryDirectory({ productLayout: { root: data }, installation: { uninstallRecoveryRoot: null } }, options.env), hold = JSON.stringify({ body: { schemaVersion: 1, installationId: plan.installation.id, planDigest: plan.planDigest }, keyId: 'purged', mac: 'unverifiable' });
    const crash = async () => { for (const name of [`${plan.planDigest}.tombstone.json`, 'tombstone.json']) await rm(join(directory, name), { force: true }); await writeFile(uninstallHoldPath(data), hold, { mode: 0o600 }); };
    await crash();
    const pending = await previewConfiguredUninstall(project, ALL, options);
    expect(pending).toEqual(replay); expect(await lstat(uninstallHoldPath(data))).toBeTruthy();
    expect((await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'after-crash', planDigest: pending.planDigest }, { confirm: async () => { throw Error('unexpected prompt'); } }, options)).status).toBe('noop');
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' }); expect(await lstat(join(directory, 'tombstone.json'))).toBeTruthy();
    // M3/D2: a member recreated with the same bytes is not the purged file (new inode): held as unknown, nothing deleted, no success.
    await crash(); await writeFile(join(data, 'policy.json'), policyBytes, { mode: 0o600 });
    await expect(previewConfiguredUninstall(project, ALL, options)).rejects.toMatchObject({ code: 'UNINSTALL_FINAL_TAIL_UNKNOWN' });
    await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'partial', planDigest: pending.planDigest }, { confirm: async () => true }, options)).rejects.toMatchObject({ code: 'UNINSTALL_FINAL_TAIL_UNKNOWN' });
    expect(await readFile(join(data, 'policy.json'))).toEqual(policyBytes); expect(await lstat(uninstallHoldPath(data))).toBeTruthy();
    // C2/D2: the managed restore of exactly the intent's final set works from the held state (no hand-removed hold), preserves the
    // recreated file, retires the intent and releases the hold; the installation then previews normally.
    await executeConfiguredBackup(project, { schemaVersion: 1, action: 'restore', scopeId: 's', set: finalSet, target: project, confirmTarget: project }, phrase, options);
    expect(await readFile(join(data, 'policy.json'))).toEqual(policyBytes);
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(data)).some(name => name.startsWith('policy.json.damaged-'))).toBe(true);
    await expect(lstat(join(directory, 'final-tail.json'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(await lstat(join(directory, `${plan.planDigest}.restored.json`))).toBeTruthy();
    const reopened = await previewConfiguredUninstall(project, KEEP, options); expect(reopened.blockers).toEqual([]);
    expect((await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'after-restore', planDigest: reopened.planDigest }, { confirm: async () => true }, options)).status).toMatch(/^(completed|noop)$/);
    for (const path of members) expect(await lstat(path)).toBeTruthy();
    for (const path of [strays[0]!, strays[3]!]) expect(await readFile(path, 'utf8')).toBe('FOREIGN KEEP');
    expect(await readFile(join(data, 'secrets.json'), 'utf8')).toBe('SHARED KEEP');
  } finally { tail.at = null; clearConfigCache(); await rm(root, { recursive: true, force: true }); }
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
    const plan = await previewConfiguredUninstall(project, ALL, options);
    expect(plan.scopeSummary).toContain('retained-company');
    await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'held', planDigest: plan.planDigest }, { backupPassphrase: async () => 'unused', confirm: async () => true }, options))
      .rejects.toMatchObject({ code: 'UNINSTALL_PURGE_DENIED', params: { owner: 'legal-hold-retained-company' } });
    await expect(lstat(uninstallRecoveryDirectory({ productLayout: { root: data }, installation: { uninstallRecoveryRoot: null } }, options.env))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' }); expect(await lstat(ledger)).toBeTruthy();
    // Unreadable recorded company scopes: no retention rule can be checked for all data, so nothing is admitted or removed.
    const db = new DatabaseSync(ledger); try { db.exec('DROP TABLE scope_registry'); } finally { db.close(); }
    const shallow = await previewConfiguredUninstall(project, KEEP, options);
    await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'unverified', planDigest: shallow.planDigest }, { confirm: async () => true }, options))
      .rejects.toMatchObject({ code: 'UNINSTALL_SCOPE_UNVERIFIED' });
    expect(await readFile(join(data, AREA, 'cache'), 'utf8')).toBe('DISPOSABLE');
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { tail.at = null; clearConfigCache(); await rm(root, { recursive: true, force: true }); }
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
    const unsafe = await previewConfiguredUninstall(project, ALL, options);
    expect(unsafe.blockers).toContain(`authority-unsafe:${join(data, 'bindings.json')}`);
    expect(unsafe.items.some(item => item.resourceId === 'global-data')).toBe(false);
    await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'unsafe', planDigest: unsafe.planDigest }, { backupPassphrase: async () => 'unused', confirm: async () => true }, options))
      .rejects.toMatchObject({ code: 'UNINSTALL_AUTHORITY_UNVERIFIED', params: { path: join(data, 'bindings.json') } });
    expect(await readFile(join(data, AREA, 'cache'), 'utf8')).toBe('DISPOSABLE');
    await expect(lstat(uninstallRecoveryDirectory({ productLayout: { root: data }, installation: { uninstallRecoveryRoot: null } }, options.env))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    // Lane J P1: an unsafe policy or (v2) bindings file leaves no tier authorizable: a typed refusal naming it, nothing removed, the file left as it is.
    const policyPath = join(data, 'policy.json'), v1 = await readFile(policyPath, 'utf8');
    const refused = async (path: string) => { await expect(previewConfiguredUninstall(project, KEEP, options)).rejects.toMatchObject({ code: 'UNINSTALL_POLICY_UNREADABLE',
      params: { path, reason: 'POLICY_FILE_UNSAFE' } }); expect(await readFile(join(data, AREA, 'cache'), 'utf8')).toBe('DISPOSABLE'); };
    await chmod(policyPath, 0o666); await refused(policyPath); expect((await lstat(policyPath)).mode & 0o777).toBe(0o666); await chmod(policyPath, 0o600);
    await writeFile(policyPath, JSON.stringify({ ...JSON.parse(v1), schemaVersion: 2, roles: [], separationOfDuties: [] })); await refused(join(data, 'bindings.json'));
    await writeFile(policyPath, v1);
    // A relocated authority file is never followed to its configured spelling; the data-keeping uninstall stays available.
    await chmod(join(data, 'bindings.json'), 0o600); await config({ bindings: 'moved/bindings.json' }); clearConfigCache();
    const moved = await previewConfiguredUninstall(project, ALL, options);
    expect(moved.blockers).toContain(`authority-relocated:${join(data, 'moved/bindings.json')}`);
    expect((await previewConfiguredUninstall(project, KEEP, options)).blockers).toEqual([]);
    expect(await lstat(join(data, 'bindings.json'))).toBeTruthy(); expect(await lstat(ledger)).toBeTruthy();
  } finally { tail.at = null; clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('deletes an in-project installation (K1) after archiving every owned file, but keeps Git-tracked and unknown files (and so the folder), with the archive outside the project', async () => {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/git')) { console.info('verify-not-run: K1 in-project purge needs Linux custody and /usr/bin/git'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const { verifyBackupSet } = await import('#adapters/core/backup-store/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-purge-in-project-'));
  try {
    const { project, local, options, phrase, install } = await projectInstallation(root), elsewhere = join(root, 'elsewhere'); await mkdir(elsewhere, { mode: 0o700 });
    const layout = await install(), ledger = productResourcePath(layout, 'ledger');
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    await writeFile(join(local, 'notes.txt'), 'UNKNOWN KEEP', { mode: 0o600 }); await writeFile(join(local, 'state/terminal-history.jsonl'), 'HISTORY\n', { mode: 0o600 });
    // B3: a file under a Deckent resource folder whose name no owner writes is the person's (location is no ownership): kept and listed.
    const record = join(local, 'workspaces/customer-record.txt'); await mkdir(dirname(record), { mode: 0o700 }); await writeFile(record, 'CUSTOMER', { mode: 0o600 });
    // R9: the files a real worker-image build and toolchain update write in this project's workspaces/toolchains (their owners' own name
    // builders) are members; a person's file beside them is not.
    const { prepareWorkerImageBuildContext } = await import('#adapters/core/worker-image/index.js'), { refreshAuditName } = await import('#engine/index.js');
    const toolchains = join(local, 'workspaces/toolchains'), built = await prepareWorkerImageBuildContext({ packageRoot: process.cwd(), parent: join(toolchains, 'builds'),
      imageVersion: 'r1-20261027', dockerfile: 'FROM scratch\n', recipe: { schemaVersion: 1 }, plan: { buildTimeoutMs: 1000 } });
    const produced = [...built.files.map(name => join(built.context, name)), join(toolchains, 'receipts/r1-20261027.json'), join(toolchains, 'plans/r2-20261028-2026-10-28T10-00-00-000Z.json'),
      join(toolchains, 'proposals/r2-20261028.json'), join(toolchains, 'refreshes', refreshAuditName('2026-10-28T10:00:00.000Z', 'startup')), join(toolchains, 'acquisitions/11111111-2222-4333-8444-555555555555.json')];
    for (const path of produced.slice(built.files.length)) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, '{}\n', { mode: 0o600 }); }
    const beside = join(toolchains, 'receipts/customer-notes.txt'); await writeFile(beside, 'CUSTOMER', { mode: 0o600 });
    // B4: a regular file at the layout's runtime.sock name (no Deckent code writes one there) is the person's: kept, even by the final cleanup.
    const sock = join(local, 'state/runtime.sock'); await writeFile(sock, 'MINE', { mode: 0o600 });
    // Dogfood: the team commits a Deckent file; Git tracking makes it the team's, never a member.
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', project, ...args], { env: { GIT_CONFIG_NOSYSTEM: '1', HOME: join(root, 'home') } });
    git('init', '-q'); git('add', '-f', '.deckent/bindings.json');
    // R2: a custody-named file the team committed (bytes in it, 0600, single link): holding the lock never makes it removable.
    const lockFile = join(local, 'state/ledger.db-lock'); await writeFile(lockFile, 'TEAM LOCK', { mode: 0o600 }); git('add', '-f', '.deckent/state/ledger.db-lock');
    const plan = await previewConfiguredUninstall(project, ALL, options), members = plan.items.find(item => item.resourceId === 'global-data')!.members!;
    expect(plan.items.find(item => item.locator === lockFile)).toMatchObject({ action: 'keep', reason: 'vcs-tracked' });
    expect(plan.blockers).toEqual([]); expect(plan).toMatchObject({ purge: true, backup: { required: true } });
    expect(members).toEqual(expect.arrayContaining([ledger, join(local, 'policy.json'), join(local, 'installation-identity/identity.json'), join(local, 'state/terminal-history.jsonl'), join(local, 'config.json')]));
    expect(members).not.toContain(join(local, 'bindings.json')); expect(members).not.toContain(join(local, 'notes.txt')); expect(members).not.toContain(record);
    expect(members).toEqual(expect.arrayContaining(produced)); expect(members).not.toContain(beside); expect(plan.items.find(item => item.locator === beside)).toMatchObject({ action: 'keep' });
    expect(plan.items.find(item => item.locator === record)).toMatchObject({ action: 'keep', ownership: 'unknown' });
    expect(plan.items.find(item => item.resourceId.startsWith('tracked.') && item.locator === join(local, 'bindings.json'))).toMatchObject({ action: 'keep', reason: 'vcs-tracked' });
    expect(plan.items.find(item => item.locator === join(local, 'notes.txt'))).toMatchObject({ action: 'keep', ownership: 'unknown' });
    expect(plan.backup.destination!.startsWith(join(root, 'home', '.local', 'state'))).toBe(true);
    // M13: an SDK call from an AI agent or CI (marker set, even with a real terminal attested) is no person's witness: refused, nothing deleted.
    for (const marker of [{ CLAUDECODE: '1' }, { CI: 'true' }]) await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'marked', planDigest: plan.planDigest },
      { backupPassphrase: async () => phrase, confirm: async () => true }, { ...options, env: { ...options.env, ...marker } })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    // R7: the real process is marked (CI) while the SDK supplies a HOME-only env: the supplied env never lowers the floor.
    vi.stubEnv('CI', 'true');
    await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'marked', planDigest: plan.planDigest },
      { backupPassphrase: async () => phrase, confirm: async () => true }, options)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    vi.stubEnv('CI', '');
    expect(await readFile(join(local, 'state/terminal-history.jsonl'), 'utf8')).toBe('HISTORY\n');
    // M5: a member that cannot be archived stops the removal before its first effect: the cache stays too (archive built before any removal).
    const report = join(local, 'crashes/crash-1-1-33333333-3333-4333-8333-333333333333.json'), cached = join(local, AREA, 'entry');
    for (const path of [cached, report]) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, 'CACHE', { mode: 0o600 }); }
    const withCache = await previewConfiguredUninstall(project, ALL, options); await chmod(report, 0o000);
    await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'archive-fails', planDigest: withCache.planDigest }, { backupPassphrase: async () => phrase, confirm: async () => true }, options)).rejects.toThrow();
    await chmod(report, 0o600); expect(await readFile(cached, 'utf8')).toBe('CACHE'); expect(await readFile(report, 'utf8')).toBe('CACHE');
    const result = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'in-project', planDigest: (await previewConfiguredUninstall(project, ALL, options)).planDigest },
      { backupPassphrase: async () => phrase, confirm: async () => true }, options);
    expect(result.status).toBe('completed');
    for (const path of members) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(local, 'bindings.json'), 'utf8')).toContain('b1'); expect(await readFile(join(local, 'notes.txt'), 'utf8')).toBe('UNKNOWN KEEP');
    expect(await readFile(record, 'utf8')).toBe('CUSTOMER'); expect(await readFile(sock, 'utf8')).toBe('MINE'); expect(await readFile(lockFile, 'utf8')).toBe('TEAM LOCK');
    for (const path of produced) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(beside, 'utf8')).toBe('CUSTOMER');
    expect(plan.items.find(item => item.locator === sock)).toMatchObject({ action: 'keep', ownership: 'unknown' });
    (await verifyBackupSet(result.backup.destination!, phrase, getConfigFieldDefault('installation').packageMeasurement)).close();
    expect(await lstat(`${result.backup.destination!}.archive`)).toBeTruthy(); expect(result.backup.destination!.startsWith(project)).toBe(false);
    // Negative: a data root moved outside the global home and the project is a genuine relocation; the data tier stays closed with its path.
    await install(elsewhere);
    expect((await previewConfiguredUninstall(project, ALL, options)).blockers).toContain(`authority-relocated:${elsewhere}`);
  } finally { tail.at = null; clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('keep-work archives conversation data and retires the folder; ALL force preserves unproven workspaces and backup restore brings owned files back', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: native purge custody is Linux-only'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const { executeConfiguredBackup } = await import('#composition/core/backup/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-archive-'));
  try {
    const { project, local, options, phrase, install } = await projectInstallation(root), layout = await install(), ledger = productResourcePath(layout, 'ledger');
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    await writeFile(join(local, 'state/terminal-history.jsonl'), 'HISTORY\n', { mode: 0o600 });
    // Files their Deckent owners name (a worker workspace's lease and hook, an automatic ledger backup); the work records stay with keep-work.
    const lease = join(local, `workspaces/${'c'.repeat(64)}/lease.json`), hook = join(local, `workspaces/${'c'.repeat(64)}/hooks/pre-commit`), earlier = join(local, 'state/backups/ledger-v1-2026-10-27T10-00-00-000Z.db');
    for (const path of [hook, earlier]) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(lease, 'LEASE', { mode: 0o644 }); await writeFile(hook, '#!/bin/sh\n', { mode: 0o755 }); await writeFile(earlier, 'EARLIER LEDGER', { mode: 0o600 });
    // R10, F7 (JOURNEY §5.2): a config backup goes with keep-work (archived first). A workspace goes only when its owner proves it idle from the
    // ledger (engine attempt-custody-release F7); here an owner-shaped lease of a Run the ledger does not have stays as possibly pending, as does
    // the workspace above whose lease cannot be read: both are kept, listed and counted by the menu.
    const identity = { runId: 'finished-run', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 } /* the owner's key order: the folder name matches */, source = { schemaVersion: 1, sourceRoot: project, repositoryRoot: project };
    const { createHash } = await import('node:crypto'), hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
    const unproven = join(local, `workspaces/${hash(identity)}`), configBackup = join(local, 'config.json.bak.2026-10-27T10-00-00.000Z.11111111-2222-4333-8444-555555555555');
    await mkdir(join(unproven, 'tree'), { recursive: true, mode: 0o700 }); await writeFile(join(unproven, 'tree/file.txt'), 'WORK', { mode: 0o600 });
    await writeFile(join(unproven, 'lease.json'), JSON.stringify({ schemaVersion: 2, fingerprint: 'e'.repeat(64), request: { schemaVersion: 1, identity, baseCommit: 'a'.repeat(40) }, status: 'ready',
      sourceBase: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: hash(source), source, baseCommit: 'a'.repeat(40) } }), { mode: 0o600 });
    await writeFile(configBackup, '{}', { mode: 0o600 });
    const work = await previewConfiguredUninstall(project, { ...KEEP, tier: 'keep-work' }, options);
    expect([...work.items.find(item => item.resourceId === 'conversation-data')!.members!].sort()).toEqual([configBackup, join(local, 'state/terminal-history.jsonl')].sort());
    expect(work.items.filter(item => item.keep === 'workspace-pending' && item.action === 'keep').map(item => item.locator).sort()).toEqual([join(local, `workspaces/${'c'.repeat(64)}`), unproven].sort());
    expect(work.items.some(item => item.resourceId === 'global-data')).toBe(false); expect(work.backup.required).toBe(true);
    const kept = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'keep-work', planDigest: work.planDigest }, { backupPassphrase: async () => phrase, confirm: async () => true }, options);
    expect(kept.status).toBe('completed'); await expect(lstat(join(local, 'state/terminal-history.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await lstat(ledger)).toBeTruthy(); expect(await readFile(lease, 'utf8')).toBe('LEASE');
    expect(await readFile(earlier, 'utf8')).toBe('EARLIER LEDGER'); // M10 (JOURNEY §5.2): keep-work keeps earlier backups where they are
    await expect(lstat(configBackup)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(join(unproven, 'tree/file.txt'), 'utf8')).toBe('WORK');
    // ...archived (verified) in keep-work's own set first: the archive manifest names it.
    const archivedIds = (JSON.parse(await readFile(`${kept.backup.destination!}.archive.json`, 'utf8')) as { resources: { resourceId: string }[] }).resources.map(row => row.resourceId);
    expect(archivedIds).toContain(hash(configBackup)); expect(archivedIds).not.toContain(hash(join(unproven, 'tree/file.txt')));
    expect(await lstat(join(local, 'installation/retired.json'))).toBeTruthy(); // §5.4: the service stays down until the person reopens the folder
    // F7 (K3, JOURNEY §5.1): the two possibly pending workspaces are pending work for delete-everything: without --force it is refused before
    // any card, naming them and keep-work; nothing changes.
    const unforced = await previewConfiguredUninstall(project, ALL, options);
    expect(unforced.work.workspaces).toBe(2); expect(unforced.blockers).toEqual(['work-pending']); let cards = 0;
    const refusal = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'all-unforced', planDigest: unforced.planDigest },
      { backupPassphrase: async () => phrase, confirm: async () => { cards += 1; return true; } }, options).catch((error: { code?: string; message?: string }) => error);
    expect(refusal).toMatchObject({ code: 'UNINSTALL_WORK_ACTIVE' }); expect((refusal as Error).message).toContain('--keep-work'); expect(cards).toBe(0);
    expect(await readFile(join(unproven, 'tree/file.txt'), 'utf8')).toBe('WORK');
    // Force never grants ownership: these unreadable/unverifiable leases and their trees stay out of every removal group.
    const all = await previewConfiguredUninstall(project, { ...ALL, force: true }, options);
    expect(all.blockers).toEqual([]); expect(all.work.workspaces).toBe(2);
    const result = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'all', planDigest: all.planDigest }, { backupPassphrase: async () => phrase, confirm: async () => true }, options);
    expect(result.status).toBe('completed'); expect(await lstat(local)).toBeTruthy();
    expect(await readFile(lease, 'utf8')).toBe('LEASE'); expect(await readFile(join(unproven, 'tree/file.txt'), 'utf8')).toBe('WORK');
    expect(all.items.filter(item => item.keep === 'workspace-pending')).toHaveLength(2);
    const removed = (JSON.parse(await readFile(`${result.backup.destination!}.archive.json`, 'utf8')) as { resources: { resourceId: string }[] }).resources.map(row => row.resourceId);
    expect(removed).not.toContain(hash(join(unproven, 'tree/file.txt'))); // No removal authority and no archive membership
    // `deckent backup restore <set>`: the semantic set and the uninstall archive beside it bring the installation and its files back.
    await executeConfiguredBackup(project, { schemaVersion: 1, action: 'restore', scopeId: 's', set: result.backup.destination!, target: project, confirmTarget: project }, phrase, options);
    expect(await lstat(ledger)).toBeTruthy(); expect(await readFile(lease, 'utf8')).toBe('LEASE'); expect(await readFile(earlier, 'utf8')).toBe('EARLIER LEDGER');
    expect((await lstat(hook)).mode & 0o777).toBe(0o755); expect(await readFile(join(unproven, 'tree/file.txt'), 'utf8')).toBe('WORK');
  } finally { tail.at = null; clearConfigCache(); await rm(root, { recursive: true, force: true }); }
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
    const plan = await previewConfiguredUninstall(project, ALL, options);
    tail.left = 4; // the process "dies" inside the final tail after policy.json is gone: authority must come from the verified set
    let interrupted;
    try { interrupted = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'crash', planDigest: plan.planDigest }, { backupPassphrase: async () => phrase, confirm: async () => true }, options); }
    finally { tail.left = null; }
    expect(interrupted.status).toBe('unknown'); expect(await lstat(uninstallHoldPath(data))).toBeTruthy();
    const remaining: string[] = []; for (const path of members) if (await unremoved(path)) remaining.push(path);
    expect(remaining.length).toBeGreaterThan(0); expect(remaining).not.toContain(join(data, 'policy.json'));
    const second = await previewConfiguredUninstall(project, ALL, options);
    expect(second.items.filter(item => item.action === 'remove')).toEqual([expect.objectContaining({ resourceId: 'global-data', members: remaining, reason: 'resume' })]);
    const command = { schemaVersion: 2, commandId: 'resume', planDigest: second.planDigest };
    // Cancelling the second card deletes nothing; a wrong passphrase cannot verify the set, so nothing is deleted either.
    expect((await applyConfiguredUninstall(project, command, { backupPassphrase: async () => { throw Error('unexpected prompt'); }, confirm: async () => false }, options)).status).toBe('cancelled');
    await expect(applyConfiguredUninstall(project, command, { backupPassphrase: async () => 'wrong-passphrase', confirm: async () => true }, options)).rejects.toMatchObject({ code: 'BACKUP_PASSPHRASE_INVALID' });
    for (const path of remaining) expect(await unremoved(path)).toBe(true);
    expect(await lstat(uninstallHoldPath(data))).toBeTruthy();
    let cards = 0;
    const resumed = await applyConfiguredUninstall(project, command, { backupPassphrase: async () => phrase, confirm: async shown => { cards++; expect(shown).toEqual(second); return true; } }, options);
    expect(resumed).toMatchObject({ status: 'completed', planDigest: second.planDigest }); expect(cards).toBe(1);
    for (const path of members) expect(await unremoved(path)).toBe(false);
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    const replay = await previewConfiguredUninstall(project, ALL, options);
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
    const plan = await previewConfiguredUninstall(project, ALL, options);
    expect(plan.blockers).toEqual([]);
    expect(plan.items.find(item => item.resourceId === 'global-data')!.members).toContain(record);
    for (const locator of [...keep.slice(0, 2), join(data, 'audit/authority-revisions'), join(data, 'artifacts')]) expect(plan.items.find(item => item.locator === locator)).toMatchObject({ action: 'keep' });
    const result = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'tree', planDigest: plan.planDigest }, { backupPassphrase: async () => phrase, confirm: async () => true }, options);
    expect(result.status).toBe('completed');
    await expect(lstat(record)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const path of keep) expect((await readFile(path)).length).toBeGreaterThan(0);
    // The standard restore brings the record back; it verifies again with the restored installation key.
    await executeConfiguredBackup(project, { schemaVersion: 1, action: 'restore', scopeId: 's', set: result.backup.destination!, target: project, confirmTarget: project }, phrase, options);
    const restored = await openLocalIntegrityAuthority(layout, keyFile);
    expect(verifyAuditRecord(JSON.parse(await readFile(record, 'utf8')), restored).event.eventId).toBe(eventId);
  } finally { tail.at = null; clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

/** A project-folder installation (İ-6): its data root is the project's own .deckent. */
async function projectInstallation(root: string) {
  const project = join(root, 'project'), data = join(root, 'global'), local = join(project, '.deckent');
  for (const path of [join(local, 'state'), data]) await mkdir(path, { recursive: true, mode: 0o700 });
  const actor = readLocalOsIdentity(), options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: data }, heal: false }, phrase = 'temporary-only-test-passphrase';
  const install = async (layoutRoot?: string) => {
    await writeFile(join(local, 'config.json'), JSON.stringify({ ...(layoutRoot ? { layout: { root: layoutRoot } } : {}), terminal: { scopeId: 's' } }), { mode: 0o600 });
    for (const name of ['policy.json', 'bindings.json']) await writeFile(join(layoutRoot ?? local, name), JSON.stringify(name === 'bindings.json' ? { schemaVersion: 1, revision: 'b1', bindings: [] }
      : { schemaVersion: 1, revision: 'p1', restrictions: [], grants: ['installation', 'operation', 'approval', 'backup'].map(kind => ({
        id: `owner-${kind}`, effect: 'allow', actions: 'all', scopes: 'all', principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind, ids: 'all' } })) }), { mode: 0o600 });
    const layout = resolveProductLayout({ projectRoot: project, ...(layoutRoot ? { root: layoutRoot } : {}) });
    await new FileInstallationIdentityStore(layout).loadOrCreate(); await openLocalIntegrityAuthority(layout, getConfigFieldDefault('approvals').keyFile, true); clearConfigCache();
    return layout;
  };
  return { project, local, options, phrase, install };
}

it('fails closed when a kept policy file changed before an interrupted keep-work tail resumes: nothing more is deleted, the tail stays unknown', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: native purge custody is Linux-only'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-tail-authority-'));
  try {
    const { project, local, options, phrase, install } = await projectInstallation(root), layout = await install(), ledger = productResourcePath(layout, 'ledger');
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    await mkdir(join(local, 'state/terminal-sessions'), { mode: 0o700 });
    for (const name of ['state/terminal-history.jsonl', 'state/terminal-sessions/11111111-1111-4111-8111-111111111111.json', 'state/terminal-sessions/22222222-2222-4222-8222-222222222222.json']) await writeFile(join(local, name), name, { mode: 0o600 });
    const plan = await previewConfiguredUninstall(project, { ...KEEP, tier: 'keep-work' }, options);
    tail.left = 2; // one custody unlink, then the process "dies" after the first conversation file is gone
    let interrupted;
    try { interrupted = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'crash', planDigest: plan.planDigest }, { backupPassphrase: async () => phrase, confirm: async () => true }, options); }
    finally { tail.left = null; }
    expect(interrupted.status).toBe('unknown');
    const remaining: string[] = []; for (const name of ['state/terminal-history.jsonl', 'state/terminal-sessions/11111111-1111-4111-8111-111111111111.json', 'state/terminal-sessions/22222222-2222-4222-8222-222222222222.json'])
      if (await unremoved(join(local, name))) remaining.push(join(local, name));
    expect(remaining.length).toBe(2);
    // The kept policy is not the file the intent recorded: the resumed tail cannot decide from it and deletes nothing.
    const policy = await readFile(join(local, 'policy.json'));
    await writeFile(join(local, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'tampered', restrictions: [], grants: [] }), { mode: 0o600 });
    const resume = async () => { const second = await previewConfiguredUninstall(project, KEEP, options).catch((error: unknown) => error);
      return 'planDigest' in (second as object) ? applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'resume', planDigest: (second as { planDigest: string }).planDigest },
        { backupPassphrase: async () => phrase, confirm: async () => true }, options) : Promise.reject(second); };
    await expect(resume()).rejects.toMatchObject({ code: 'UNINSTALL_FINAL_TAIL_UNKNOWN' });
    for (const path of remaining) expect(await unremoved(path)).toBe(true);
    // R11: with the recorded policy back the resumed tail completes like the normal step: the retired marker is there and the service refuses to start.
    await writeFile(join(local, 'policy.json'), policy, { mode: 0o600 });
    expect(await resume()).toMatchObject({ status: 'completed' });
    for (const path of remaining) expect(await unremoved(path)).toBe(false);
    const { assertNotRetired } = await import('#platform/index.js');
    await expect(assertNotRetired(local)).rejects.toMatchObject({ code: 'UNINSTALL_RETIRED' });
  } finally { tail.left = null; clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('R13: an unknown result recorded in a scope the configuration no longer names stays under an all-scopes company restriction: force cannot delete data', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: native purge custody is Linux-only'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'deckent-managed-history-'));
  try {
    const { project, local, options, install } = await projectInstallation(root), layout = await install(), ledger = productResourcePath(layout, 'ledger');
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    await writeFile(join(local, 'state/terminal-history.jsonl'), 'HISTORY\n', { mode: 0o600 });
    // Company control over every scope (an ERP posting restriction, not an uninstall rule) and an ERP effect of an earlier scope, result unknown.
    const policy = JSON.parse(await readFile(join(local, 'policy.json'), 'utf8')) as { restrictions: unknown[] };
    policy.restrictions = [{ id: 'company-erp', actions: ['execute'], scopes: 'all', principals: 'all', resource: { kind: 'operation', ids: ['erp.post-invoice'] } }];
    await writeFile(join(local, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
    const db = new DatabaseSync(ledger);
    try { db.prepare('INSERT INTO effect_intents(scope_id,command_id,target_kind,target_id,sequence,idempotency_key_hash,state,record) VALUES(?,?,?,?,?,?,?,?)')
      .run('historical', 'erp-1', 'erp', 'invoice-1', 1, 'h'.repeat(64), 'unknown', '{}'); } finally { db.close(); }
    for (const tier of ['keep-work', 'all'] as const) {
      const plan = await previewConfiguredUninstall(project, { ...KEEP, tier, force: true }, options);
      expect(plan.work.uncertain).toEqual([expect.objectContaining({ scopeId: 'historical', id: 'erp-1' })]); expect(plan.blockers).toContain('uncertain-managed');
    }
    expect((await previewConfiguredUninstall(project, { ...KEEP, force: true }, options)).blockers).not.toContain('uncertain-managed');
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('F6: queued-withdraw preflight writes nothing, denies without the owner grant, and cancellation uses the queue owner after approval', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: native purge custody is Linux-only'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const { DatabaseSync } = await import('node:sqlite');
  const { fixtureDockerRegistry } = await import('../support/execution-registry.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-preflight-inspect-'));
  try {
    const { project, local, options, install } = await projectInstallation(root), layout = await install(), ledger = productResourcePath(layout, 'ledger'), target = join(root, 'target');
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', target, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', ...args]);
    await mkdir(target); git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'base');
    const { argv: _argv, ...docker } = fixtureDockerRegistry([]).profiles[0]!.parameters; void _argv;
    await writeFile(join(local, 'config.json'), JSON.stringify({ terminal: { scopeId: 's' }, execution: { docker: { executable: '/usr/bin/docker', ...docker },
      git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 }, adoption: { targets: ['refs/heads/main'] },
      workTargets: { schemaVersion: 1, targets: [{ id: 'n1', kind: 'git', path: target, baseRef: 'refs/heads/main' }] } } }), { mode: 0o600 }); clearConfigCache();
    // The queue's scope is named by policy (its membership); every other grant is the installation's own.
    const policy = JSON.parse(await readFile(join(local, 'policy.json'), 'utf8')) as { grants: unknown[] }, actor = readLocalOsIdentity();
    policy.grants.push({ id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind: 'scope', ids: ['s'] } });
    await writeFile(join(local, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    const { FileProjectIdentityStore, registerLedgerScopes } = await import('#adapters/index.js');
    await new FileProjectIdentityStore(project, getConfigFieldDefault('configFile').writeLockTimeoutMs).loadOrCreate();
    registerLedgerScopes(ledger, getConfigFieldDefault('storage').sqlite, getConfigFieldDefault('company').id, ['s'], 'admission');
    const db = new DatabaseSync(ledger);
    try {
      const { SqliteTargetQueue } = await import('#adapters/core/target-queue-store/index.js'), { targetQueueRequestSchema } = await import('#domain/index.js');
      new SqliteTargetQueue(db).enqueue(targetQueueRequestSchema.parse({ schemaVersion: 1, commandId: 'ticket-1', identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' },
        actor: { id: 'owner', issuer: actor.issuer, subject: actor.subject }, target: { schemaVersion: 1, installationId: 'i', adapter: { id: 'git', version: 1 }, resourceBinding: 'a'.repeat(64), target: { kind: 'git-ref', id: 'refs/heads/main' } },
        payloadDigest: 'b'.repeat(64), policyRevision: 'p1', outputDigest: 'c'.repeat(64), acceptedRevision: 1, submittedAt: 1, deadline: 5000 }), getConfigFieldDefault('targetQueue'), () => {});
    } finally { db.close(); }
    const plan = await previewConfiguredUninstall(project, { ...ALL, force: true }, options);
    expect(plan.steps.withdrawDeliveries).toEqual([{ scopeId: 's', id: 'ticket-1', revision: 0, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' }, state: 'queued', company: 'current' }]); expect(plan.blockers).toEqual([]);
    let cards = 0;
    await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'inspect', planDigest: plan.planDigest }, { confirm: async () => { cards += 1; return true; } }, options))
      .rejects.toMatchObject({ code: 'UNINSTALL_DELIVERY_QUEUED' });
    expect(cards).toBe(0);
    for (const resource of ['workspaces', 'artifacts'] as const) await expect(lstat(productResourcePath(layout, resource))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const resource of ['workspaces', 'artifacts'] as const) await mkdir(productResourcePath(layout, resource), { mode: 0o700 });
    const { withQueueContext } = await import('#composition/core/runtime-service/index.js');
    const snapshot = async () => { const { readdir } = await import('node:fs/promises'); const names = await readdir(dirname(ledger));
      return Promise.all(names.sort().map(async name => [name, (await readFile(join(dirname(ledger), name))).toString('hex')])); };
    const live = new DatabaseSync(ledger);
    try {
      live.exec('PRAGMA journal_mode=WAL'); live.prepare('UPDATE target_queue SET record=record WHERE command_id=?').run('ticket-1');
      const fresh = await previewConfiguredUninstall(project, { ...ALL, force: true }, options), before = await snapshot(); let entered = false;
      await expect(withQueueContext(project, 's', options, undefined, 'inspect', async () => { entered = true; }))
        .rejects.toMatchObject({ code: 'UNINSTALL_UNSUPPORTED' });
      await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'inspect-existing', planDigest: fresh.planDigest }, { confirm: async () => { cards += 1; return true; } }, options))
        .rejects.toMatchObject({ code: 'UNINSTALL_DELIVERY_QUEUED' });
      expect(entered).toBe(false); expect(await snapshot()).toEqual(before); expect(cards).toBe(0);
      for (const kind of ['attempt', 'work-target']) policy.grants.push({ id: `queue-${kind}`, effect: 'allow', actions: 'all', scopes: 'all',
        principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind, ids: 'all' } });
      await writeFile(join(local, 'policy.json'), JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
      // F2772-1: a retained ticket survives removal of its configured target; refuse before the destructive card, without opening the queue.
      const configPath = join(local, 'config.json'), configured = await readFile(configPath, 'utf8'), noTarget = JSON.parse(configured);
      delete noTarget.execution.workTargets;
      await writeFile(configPath, JSON.stringify(noTarget)); clearConfigCache();
      const missingTarget = await previewConfiguredUninstall(project, { ...ALL, force: true }, options);
      expect(missingTarget.steps.withdrawDeliveries).toEqual(plan.steps.withdrawDeliveries);
      const allFiles = async () => Promise.all((await readdir(root, { recursive: true })).sort().map(async name => {
        const path = join(root, name), stat = await lstat(path); return [name, stat.isFile() ? (await readFile(path)).toString('hex') : stat.mode];
      }));
      const engine = await import('#engine/index.js'), unchanged = await allFiles(), cancel = vi.spyOn(engine.TargetQueueApplication.prototype, 'cancel'), effect = vi.spyOn(engine.EffectApplication.prototype, 'execute');
      try {
        const refused = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'queue-no-target', planDigest: missingTarget.planDigest },
          { confirm: async () => { cards++; return true; } }, options).catch(error => error);
        expect(refused).toMatchObject({ code: 'UNINSTALL_DELIVERY_TARGET_REQUIRED', params: { delivery: 'ticket-1', owner: 's' } });
        for (const locale of ['en', 'tr'] as const) {
          const message = refused.localize(locale).message;
          for (const text of ['ticket-1', 's', 'delivery-queue', 'execution.workTargets', '/config', 'deckent uninstall --all --force']) expect(message).toContain(text);
        }
        expect(cards).toBe(0); expect(cancel).not.toHaveBeenCalled(); expect(effect).not.toHaveBeenCalled(); expect(await allFiles()).toEqual(unchanged);
        expect(live.prepare('SELECT state,revision FROM target_queue WHERE command_id=?').get('ticket-1')).toMatchObject({ state: 'queued', revision: 0 });
      } finally { cancel.mockRestore(); effect.mockRestore(); }
      await writeFile(configPath, configured); clearConfigCache();
      const permitted = await previewConfiguredUninstall(project, { ...ALL, force: true }, options), noWrite = await snapshot();
      const declined = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'queue-decline', planDigest: permitted.planDigest },
        { confirm: async () => { cards++; return false; } }, options);
      expect(declined.status).toBe('cancelled'); expect(cards).toBe(1); expect(await snapshot()).toEqual(noWrite);
      // Security proof approves the real destructive card; the queue owner cancels and audits before the later backup guard refuses.
      await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'queue-allow', planDigest: permitted.planDigest },
        { confirm: async () => { cards++; return true; } }, options)).rejects.toMatchObject({ code: 'BACKUP_PASSPHRASE_REQUIRED' });
      expect(cards).toBe(2);
      const ticket = live.prepare('SELECT state,record FROM target_queue WHERE command_id=?').get('ticket-1');
      expect(ticket?.state).toBe('cancelled'); expect(JSON.parse(String(ticket?.record)).revision).toBe(1);
      expect(live.prepare("SELECT COUNT(*) n FROM audit_events WHERE record LIKE '%target-queue%' AND record LIKE '%cancelled%'").get()?.n).toBe(1);

    } finally { live.close(); }

  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('F8: an admitted keep-data whose only cache vanished after the card still completes through the common owner: the folder is retired', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: native purge custody is Linux-only'); return; }
  const root = await mkdtemp(join(tmpdir(), 'deckent-admitted-noop-'));
  try {
    const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
    const { project, local, options, install } = await projectInstallation(root), ledger = productResourcePath(await install(), 'ledger');
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    const entry = join(local, AREA, 'entry'); await mkdir(dirname(entry), { recursive: true, mode: 0o700 }); await writeFile(entry, 'CACHE', { mode: 0o600 });
    const plan = await previewConfiguredUninstall(project, KEEP, options);
    expect(plan.items.find(item => item.resourceId === 'scratch')).toMatchObject({ action: 'remove' });
    // Another cleanup takes the cache while the person reads the card: D1/D2 see it absent, nothing is left to remove.
    const result = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'vanished', planDigest: plan.planDigest },
      { confirm: async () => { await unlink(entry); await rm(join(local, 'state/scratch', 'a'.repeat(32)), { recursive: true }); return true; } }, options);
    expect(result.status).toBe('noop');
    const { assertNotRetired } = await import('#platform/index.js');
    await expect(assertNotRetired(local)).rejects.toMatchObject({ code: 'UNINSTALL_RETIRED' }); await expect(lstat(uninstallHoldPath(local))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('delete everything removes the bridges init wrote (a file init created whole, else only its line) and this folder\'s own vault slice; a changed DECKENT.md or bridge line and a repository-shared slice stay and are listed', async () => {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/git')) { console.info('verify-not-run: bridge purge needs Linux custody and /usr/bin/git'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const { projectVaultDirectory, admitProjectVault, directoryLocation, previewProjectInstructions, createWorkspaceScope, WorkspaceFileTarget, WORKSPACE_FILE_WRITE_OPERATION } = await import('#adapters/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-bridges-'));
  try {
    const { project, local, options, phrase, install } = await projectInstallation(root), layout = await install(), ledger = productResourcePath(layout, 'ledger');
    openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close(); await chmod(ledger, 0o600);
    // The person's own bytes after the line: CRLF, invalid UTF-8 and no final newline all stay exactly as they are (M4).
    const team = Buffer.concat([Buffer.from('# Team rules\r\nrule: '), Buffer.from([0xff, 0xfe]), Buffer.from('\r\nlast line')]), deck = join(project, 'DECKENT.md'), claude = join(project, 'CLAUDE.md'), agents = join(project, 'AGENTS.md');
    // Init's own preview and file target (the approval broker before it needs a person's terminal): its committed journal names the bytes it wrote.
    const preview = await previewProjectInstructions(project, ['claude-code', 'agents-md'], name => `# ${name}\n`);
    const writer = new WorkspaceFileTarget(await createWorkspaceScope(project), productResourcePath(layout, 'fileEffects'));
    for (const [index, change] of preview.changes.entries()) await writer.apply({ target: { kind: writer.kind, id: change.path }, operation: WORKSPACE_FILE_WRITE_OPERATION.operation,
      idempotencyKey: String(index).repeat(64), expectedVersion: change.beforeDigest, input: { content: change.after } });
    expect(await readFile(claude, 'utf8')).toBe('@DECKENT.md\n'); expect(await readFile(agents, 'utf8')).toBe('Read DECKENT.md\n');
    // Vaults: this folder's own slice (no repository) and one a repository's worktrees share for the same folder.
    const identity = await new FileInstallationIdentityStore(layout).read(), installationId = identity.status === 'available' ? identity.value.installationId : '';
    const anchor = { installationId, projectId: '00000000-0000-4000-8000-000000000001', binding: (await directoryLocation(local))!, repository: null, projectRoot: project };
    const shared = { ...anchor, projectId: '00000000-0000-4000-8000-000000000002', repository: (await directoryLocation(root))! };
    const [own, other] = await Promise.all([anchor, shared].map(async value => { const directory = (await projectVaultDirectory(join(root, 'global'), value as never, true))!;
      await admitProjectVault(directory, value as never, true, 1, 5000); await writeFile(join(directory, 'secrets.json'), '{}', { mode: 0o600 }); return directory; }));
    // B3: a file in this folder's vault whose name the vault does not write stays and is listed (and so does the vault folder).
    await writeFile(join(own, 'notes.txt'), 'MINE', { mode: 0o600 });
    const removed = (plan: Awaited<ReturnType<typeof previewConfiguredUninstall>>) => plan.items.find(item => item.resourceId === 'global-data')!.members!;
    const listed = (plan: Awaited<ReturnType<typeof previewConfiguredUninstall>>, path: string) => plan.items.find(item => item.locator === path && item.action === 'keep');
    // Negative: DECKENT.md the person changed stays, and so do the bridge lines that point to it; both are listed.
    const original = await readFile(deck); await writeFile(deck, `${original.toString('utf8')}my own note\n`);
    const changed = await previewConfiguredUninstall(project, ALL, options);
    expect(removed(changed)).not.toContain(deck); expect(removed(changed)).not.toContain(claude);
    expect(listed(changed, deck)).toBeTruthy(); expect(listed(changed, claude)).toBeTruthy();
    // Negative: a bridge line the person copied (or changed) stays and is listed; which copy is Deckent's is not proven.
    await writeFile(deck, original); await writeFile(agents, 'Read DECKENT.md\nRead DECKENT.md\n');
    const edited = await previewConfiguredUninstall(project, ALL, options);
    expect(removed(edited)).not.toContain(agents); expect(listed(edited, agents)).toBeTruthy();
    // AGENTS.md as init created it goes whole; CLAUDE.md init created but the person added to loses only its bridge line.
    // M12: this folder's record in the global instruction-trust store (written by its owner) goes with delete-everything; another folder's stays.
    const { openHostProjectInstructionReader, instructionTrustDirectory } = await import('#adapters/index.js'), elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere); await writeFile(join(elsewhere, 'DECKENT.md'), '# elsewhere\n');
    const trusted = async (folder: string) => { const reader = await openHostProjectInstructionReader(folder, options.env as NodeJS.ProcessEnv), view = await reader.inspect();
      if (view.status !== 'trust-required') throw new Error(view.status); await reader.trust(view.source.digest); };
    await trusted(project); await trusted(elsewhere);
    const trustStore = instructionTrustDirectory(options.env), records = (await readdir(trustStore)).filter(name => /^[a-f0-9]{64}$/u.test(name));
    expect(records).toHaveLength(2);
    // R6: both folders' records were there before the legacy snapshot (a store from an earlier release): a committed ref read honours them.
    const { openProjectInstructionReader } = await import('#adapters/index.js'), legacy = join(trustStore, 'legacy-folder-trust.v1');
    await rm(legacy); await openProjectInstructionReader(project, trustStore);
    const committed = async () => (await (await openProjectInstructionReader(project, trustStore, undefined, undefined, { ref: 'main',
      read: async name => name === 'DECKENT.md' ? { commit: 'c'.repeat(40), blobOid: 'b'.repeat(40), bytes: original } : null })).inspect()).status;
    expect(await committed()).toBe('ready');
    const claudeBefore = Buffer.concat([Buffer.from('@DECKENT.md\n'), team]);
    await writeFile(agents, 'Read DECKENT.md\n'); await writeFile(claude, claudeBefore);
    // B2: a root bridge the team's Git tracks is theirs: kept and listed, never cut.
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', project, ...args], { env: { GIT_CONFIG_NOSYSTEM: '1', HOME: join(root, 'home') } });
    git('init', '-q'); git('add', 'CLAUDE.md');
    const tracked = await previewConfiguredUninstall(project, ALL, options);
    expect(removed(tracked)).not.toContain(claude); expect(tracked.items.find(item => item.locator === claude)).toMatchObject({ action: 'keep', reason: 'vcs-tracked' });
    git('rm', '-q', '--cached', 'CLAUDE.md');
    const plan = await previewConfiguredUninstall(project, ALL, options);
    expect(removed(plan)).toEqual(expect.arrayContaining([deck, claude, agents, join(own, 'secrets.json'), join(own, 'project.json')]));
    const ownRecord = removed(plan).filter(path => path.startsWith(trustStore)); expect(ownRecord).toHaveLength(1); expect(removed(plan)).not.toContain(join(own, 'notes.txt'));
    expect(listed(plan, join(own, 'notes.txt'))).toBeTruthy();
    expect(listed(plan, other)).toBeTruthy(); expect(removed(plan).some(path => path.startsWith(other))).toBe(false);
    // B1: the process dies while removing DECKENT.md, before the bridges; the resumed tail keeps every byte of CLAUDE.md but its bound line.
    const confirm = { backupPassphrase: async () => phrase, confirm: async () => true };
    tail.at = '.DECKENT.md.';
    let interrupted; try { interrupted = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'bridges', planDigest: plan.planDigest }, confirm, options); } finally { tail.at = null; }
    expect(interrupted.status).toBe('unknown'); expect((await readFile(claude)).equals(claudeBefore)).toBe(true);
    const second = await previewConfiguredUninstall(project, ALL, options);
    // M2: the archive beside the final set is lost after the interruption: the resumed tail deletes nothing more and stays unknown.
    const companion = `${interrupted.backup.destination!}.archive.json`; await rename(companion, `${companion}.away`);
    await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'resume', planDigest: second.planDigest }, confirm, options)).rejects.toMatchObject({ code: 'UNINSTALL_FINAL_TAIL_UNKNOWN' });
    expect(await unremoved(deck)).toBe(true); expect((await readFile(claude)).equals(claudeBefore)).toBe(true); await rename(`${companion}.away`, companion);
    // M13: the resumed tail holds the same floor: a marked SDK call is refused and deletes nothing more.
    await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'resume', planDigest: second.planDigest }, confirm, { ...options, env: { ...options.env, CLAUDECODE: '1' } }))
      .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    vi.stubEnv('CLAUDECODE', '1'); // R7: a marked real process with a clean supplied env
    await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'resume', planDigest: second.planDigest }, confirm, options)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    vi.stubEnv('CLAUDECODE', '');
    expect((await readFile(claude)).equals(claudeBefore)).toBe(true); expect(await readFile(agents, 'utf8')).toBe('Read DECKENT.md\n');
    // B2: a remaining member Git started tracking after the interruption stops the resumed tail before anything more is deleted.
    git('add', 'AGENTS.md');
    await expect(applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'resume', planDigest: second.planDigest }, confirm, options)).rejects.toMatchObject({ code: 'UNINSTALL_FINAL_TAIL_UNKNOWN' });
    expect(await readFile(agents, 'utf8')).toBe('Read DECKENT.md\n'); expect((await readFile(claude)).equals(claudeBefore)).toBe(true);
    git('rm', '-q', '--cached', 'AGENTS.md');
    const result = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'resume', planDigest: second.planDigest }, confirm, options);
    expect(result.status).toBe('completed');
    expect(await unremoved(deck)).toBe(false); expect((await readFile(claude)).equals(team)).toBe(true);
    await expect(lstat(agents)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(own, 'secrets.json'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(join(own, 'notes.txt'), 'utf8')).toBe('MINE');
    expect(await readFile(join(other, 'secrets.json'), 'utf8')).toBe('{}');
    await expect(lstat(ownRecord[0]!)).rejects.toMatchObject({ code: 'ENOENT' }); expect((await readdir(trustStore)).filter(name => records.includes(name))).toHaveLength(1);
    // R6: this folder's legacy entry went through its owner; the other folder's stays. R11, R2: the resumed tail completes like the normal step:
    // the empty, untracked custody file and then the emptied .deckent go.
    const snapshot = await readFile(legacy, 'utf8'); expect(snapshot).not.toContain(basename(ownRecord[0]!)); expect(records.some(name => snapshot.includes(name))).toBe(true);
    expect(await readdir(local, { recursive: true }).catch(() => 'gone')).toBe('gone');
    // M11: `deckent backup restore` brings back DECKENT.md, the init-created AGENTS.md, the vault slice and CLAUDE.md's bridge line, byte for byte.
    const { executeConfiguredBackup } = await import('#composition/core/backup/index.js');
    await executeConfiguredBackup(project, { schemaVersion: 1, action: 'restore', scopeId: 's', set: result.backup.destination!, target: project, confirmTarget: project }, phrase, options);
    expect((await readFile(claude)).equals(claudeBefore)).toBe(true); expect((await readFile(deck)).equals(original)).toBe(true);
    expect(await readFile(agents, 'utf8')).toBe('Read DECKENT.md\n'); expect(await readFile(join(own, 'secrets.json'), 'utf8')).toBe('{}'); expect(await lstat(ownRecord[0]!)).toBeTruthy();
    // R6: the restored folder record alone never reopens the committed ref read (its legacy entry stays forgotten: that trust is asked again).
    expect(await committed()).toBe('trust-required');
  } finally { tail.at = null; clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('F7: ALL + force preserves and reports a rejected real lease and clone while backing up and removing verified pending work', async () => {
  if (process.platform !== 'linux') return;
  const { GitWorkspaceBroker, FileArtifactStore, openSqliteAttemptStore } = await import('#adapters/index.js');
  const { DispatchApplication, TaskEvaluationApplication } = await import('#engine/index.js');
  const { admitRunAttempts } = await import('../support/admission.js'), { custodyProfile, custodyOrDockerProfiles } = await import('../support/custody.js');
  const { fixtureDockerRegistry } = await import('../support/execution-registry.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-kw-owner-'));
  try {
    const { project, local, options, phrase, install } = await projectInstallation(root), layout = await install();
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', project, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'base'); const baseCommit = git('rev-parse', 'HEAD');
    const { argv: _argv, ...docker } = fixtureDockerRegistry([]).profiles[0]!.parameters; void _argv;
    const gitOptions = { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 };
    await writeFile(join(local, 'config.json'), JSON.stringify({ terminal: { scopeId: 's' }, execution: { docker: { executable: '/usr/bin/docker', ...docker }, git: gitOptions } }), { mode: 0o600 }); clearConfigCache();
    const workspaceRoot = productResourcePath(layout, 'workspaces'), artifactRoot = productResourcePath(layout, 'artifacts');
    await mkdir(workspaceRoot, { mode: 0o700 }); await mkdir(artifactRoot, { mode: 0o700 });
    const broker = new GitWorkspaceBroker({ ...gitOptions, sourceRoot: project, workspaceRoot });
    const identity = { scopeId: 's', runId: 'settled', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
    const lease = await broker.allocate({ schemaVersion: 1, identity, baseCommit }); await writeFile(join(lease.workspace, 'work.txt'), 'KEEP OUTPUT', { mode: 0o600 });
    const store = await openSqliteAttemptStore(productResourcePath(layout, 'ledger'), getConfigFieldDefault('storage').sqlite, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyOrDockerProfiles);
    try {
      await admitRunAttempts(store, [identity], { noWorkspaceDelivery: true });
      const principal = { id: 'user', issuer: 'test', subject: 'user', assurance: 'os-user' as const, scopeIds: ['s'] }, verifier = { async verify() { return principal; } }, allow = { async authorize() {}, async authorizeIdentity() {} };
      const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: 1048576 });
      const supervisor = { async release() { throw new Error('unused'); }, async captureProfile() { return custodyProfile; }, async cancel() { throw new Error('unused'); }, async recoverOutput() { throw new Error('unused'); }, async observe() { throw new Error('unused'); },
        async execute() { return { handle: 'h1', result: { kind: 'exited' as const, exitCode: 0 }, stdout: 'ok', stderr: '', interrupted: false, outputCompleteness: 'complete' as const }; } };
      await new DispatchApplication(store, supervisor, verifier, allow, 'owner', artifacts).execute({ protocolVersion: 1, identity, workspace: lease.workspace, argv: ['node'] });
      await new TaskEvaluationApplication(store, verifier, allow, { async evaluate() { return 'pass' as const; } }, artifacts, { maxEvidenceItems: 1, maxTotalBytes: 1048576 }, { now: Date.now, timeoutMs: 86400000 })
        .execute({ schemaVersion: 1, commandId: 'settle', identity, expectedRevision: (await store.loadRun('s', identity.runId))!.revision });
      expect((await store.loadRun('s', identity.runId))!.state.kind).toBe('terminal');
    } finally { store.close(); }
    await chmod(productResourcePath(layout, 'ledger'), 0o600);
    // The verified idle clone still qualifies for keep-work; an owned clone with no settled Run remains pending.
    const idle = await previewConfiguredUninstall(project, { ...KEEP, tier: 'keep-work' }, options);
    expect(idle.items.find(item => item.resourceId === 'conversation-data')!.members).toContain(join(lease.workspace, 'work.txt'));
    const pending = await broker.allocate({ schemaVersion: 1, identity: { ...identity, runId: 'pending' }, baseCommit });
    await writeFile(join(pending.workspace, 'pending.txt'), 'OWNED PENDING', { mode: 0o600 });
    const leaseFile = join(dirname(lease.workspace), 'lease.json'), record = JSON.parse(await readFile(leaseFile, 'utf8'));
    expect(await broker.openRecorded(identity)).toBeTruthy();
    const original = await readFile(leaseFile, 'utf8'), observed = async () => {
      for (const tier of ['keep-data', 'keep-work', 'all'] as const) {
        const plan = await previewConfiguredUninstall(project, { ...KEEP, tier, force: true }, options);
        expect(plan.items.find(item => item.locator === dirname(lease.workspace))).toMatchObject({ action: 'keep', reason: 'ownership', ownership: 'unknown' });
        for (const item of plan.items.filter(item => item.action === 'remove'))
          expect((item.members ?? [item.locator]).some(path => path.startsWith(dirname(lease.workspace) + '/'))).toBe(false);
      }
    };
    // The same production observer protects options/private-source mismatches and shared/linked lease records.
    const configFile = join(local, 'config.json'), config = await readFile(configFile, 'utf8');
    const changed = JSON.parse(config); changed.execution.git.timeoutMs = 9999;
    await writeFile(configFile, JSON.stringify(changed)); clearConfigCache(); await observed();
    await writeFile(configFile, config); clearConfigCache();
    const { gitWorkspaceFingerprint } = await import('#engine/index.js');
    record.fingerprint = gitWorkspaceFingerprint(record.request, record.sourceBase, { ...gitOptions, sourceRoot: project, workspaceRoot }, { repositoryRoot: project, baseCommit });
    await writeFile(leaseFile, JSON.stringify(record)); await observed(); await writeFile(leaseFile, original);
    await link(leaseFile, leaseFile + '.copy'); await observed(); await unlink(leaseFile + '.copy');
    await rename(leaseFile, leaseFile + '.copy'); await symlink(leaseFile + '.copy', leaseFile); await observed();
    await unlink(leaseFile); await rename(leaseFile + '.copy', leaseFile);
    record.fingerprint = 'e'.repeat(64); await writeFile(leaseFile, JSON.stringify(record));
    await expect(broker.openRecorded(identity)).rejects.toMatchObject({ code: 'WORKSPACE_IDENTITY_CONFLICT' });
    await writeFile(join(local, 'state/terminal-history.jsonl'), 'HISTORY\n', { mode: 0o600 });
    await observed();
    const preserved = new Map<string, Buffer>();
    for (const entry of await readdir(dirname(lease.workspace), { recursive: true })) {
      const path = join(dirname(lease.workspace), entry); if ((await lstat(path)).isFile()) preserved.set(path, await readFile(path));
    }
    const plan = await previewConfiguredUninstall(project, { ...ALL, force: true }, options);
    expect(plan.items).toContainEqual(expect.objectContaining({ locator: dirname(lease.workspace), action: 'keep', keep: 'workspace-pending' }));
    expect(plan.items.filter(item => item.action === 'remove').flatMap(item => item.members ?? [item.locator])).not.toContain(join(lease.workspace, 'work.txt'));
    expect(plan.blockers).toEqual([]); expect(plan.work.workspaces).toBe(2);
    expect(plan.items.find(item => item.resourceId === 'global-data')!.members).toContain(join(pending.workspace, 'pending.txt'));
    for (const locale of ['en', 'tr'] as const) {
      const kept = locale === 'en' ? 'Worker workspaces kept because ownership could not be verified: 1' : 'Sahipliği doğrulanamadığı için korunan işçi çalışma alanı: 1';
      const removed = locale === 'en' ? 'Worker workspaces this removes after the encrypted backup holds them: 1' : 'Şifreli yedeğe alındıktan sonra kaldırılacak işçi çalışma alanı: 1';
      expect(uninstallSummaryLines(plan, locale)).toContain(kept); expect(uninstallSummaryLines(plan, locale)).toContain(removed);
      const lines = uninstallPlanLines(plan, locale); expect(lines).toContain(kept); expect(lines).toContain(removed);
      expect(lines.join('\n')).toContain(locale === 'en' ? 'not proven to belong only to this installation' : 'yalnız bu kuruluma ait olduğu kanıtlanmadı');
    }
    let cards = 0;
    const result = await applyConfiguredUninstall(project, { schemaVersion: 2, commandId: 'all-corrupt', planDigest: plan.planDigest }, { confirm: async shown => { cards++; expect(shown).toEqual(plan); return true; }, backupPassphrase: async () => phrase }, options);
    expect(cards).toBe(1); expect(result.status).toBe('completed'); expect(await readFile(join(lease.workspace, 'work.txt'), 'utf8')).toBe('KEEP OUTPUT');
    expect(await readFile(leaseFile, 'utf8')).toBe(JSON.stringify(record));
    for (const [path, bytes] of preserved) expect(await readFile(path)).toEqual(bytes);
    for (const path of plan.items.find(item => item.resourceId === 'global-data')!.members!.filter(path => path.startsWith(dirname(pending.workspace) + '/')))
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const removed = (JSON.parse(await readFile(`${result.backup.destination!}.archive.json`, 'utf8')) as { resources: { resourceId: string }[] }).resources.map(row => row.resourceId);
    const { sha256 } = await import('#platform/index.js');
    expect(removed).toContain(sha256(join(pending.workspace, 'pending.txt'))); expect(removed).not.toContain(sha256(join(lease.workspace, 'work.txt')));
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});
