import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileInstallationIdentityStore, readLocalOsIdentity, openLocalIntegrityAuthority, acquireLedgerLock } from '#adapters/index.js';
import { clearConfigCache, resolveProductLayout, uninstallHoldPath, loadConfig, getConfigFieldDefault, productResourcePath } from '#platform/index.js';
import { previewConfiguredUninstall, applyConfiguredUninstall } from '#composition/core/installation/index.js';

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
    await mkdir(join(data, 'state/scratch'), { recursive: true, mode: 0o700 }); await writeFile(join(data, 'state/scratch/disposable'), 'cache', { mode: 0o600 });
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

it('applies the confirmed real temp cache through the production broker and generic store, then replays without another removal', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: production admission uses Linux custody'); return; }
  const { openSqliteLedger } = await import('#adapters/core/sqlite-ledger/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-uninstall-admission-'));
  try {
    const project = join(root, 'project'), data = join(root, 'global');
    for (const path of [join(project, '.deckent'), join(data, 'state/scratch')]) await mkdir(path, { mode: 0o700, recursive: true });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal: { scopeId: 's' } }), { mode: 0o600 });
    await writeFile(join(project, '.deckent/keep'), 'PROJECT', { mode: 0o600 });
    await writeFile(join(data, 'state/scratch/cache'), 'DISPOSABLE', { mode: 0o600 });
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
      expect(await readFile(join(data, 'state/scratch/cache'), 'utf8')).toBe('DISPOSABLE');
      await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { busy.release(); }
    let cards = 0;
    const result = await applyConfiguredUninstall(project, command, { confirm: async shown => { cards++; expect(shown).toEqual(plan); return true; } }, options);
    expect(result.status).toBe('completed'); expect(cards).toBe(1);
    await expect(lstat(join(data, 'state/scratch'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(project, '.deckent/keep'), 'utf8')).toBe('PROJECT');
    expect(await lstat(ledger)).toBeTruthy(); expect(await lstat(join(data, 'approvals', keyFile))).toBeTruthy();
    await expect(lstat(uninstallHoldPath(data))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await applyConfiguredUninstall(project, { ...command, commandId: 'replay' }, { confirm: async () => true }, options)).status).toBe('noop');
    const effects = JSON.parse(await readFile(join(result.recoveryLocation!, 'effects.json'), 'utf8'));
    expect(effects.body.records).toHaveLength(1); expect(effects.body.records[0]).toMatchObject({ state: 'settled', intent: { approval: { approvalId: expect.any(String) } } });
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});
