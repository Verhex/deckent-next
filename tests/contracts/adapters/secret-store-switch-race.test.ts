import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SecretStoreAdministration, SecretStoreSwitch, type SecretStore, type SecretStoreSwitchPorts } from '#engine/index.js';
import { createInstallationSecretCustody, createInstallationSecretStoreSelection, isRegisteredSecretStore, openRegisteredSecretStore, registerProviderConfig } from '#adapters/index.js';

// Astra 2456 P1-1: a secret change that runs while the store switch moves secrets must never be lost; a change that cannot be applied is
// refused typed. Real file and encrypted stores, the real cross-process custody lock; deterministic barriers park the switch inside its
// section between each step (copy, read back, publish, old-copy removal). Synthetic values only.
const FILE = 'core.secret-store.file@1', SEALED = 'core.secret-store.encrypted-file@1';
type Point = 'copy' | 'readback' | 'publish' | 'delete';
const POINTS: readonly Point[] = ['copy', 'readback', 'publish', 'delete'];
const roots: string[] = [];
// The `secrets` section is registered as the product does at startup (the selection publish validates the installation config).
beforeAll(() => { registerProviderConfig(); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const code = (work: Promise<unknown>) => work.then(() => 'resolved', (error: { code?: string }) => error.code ?? String(error));
const me = { issuer: 'os', subject: '1000' };
const allow = async () => ({ policyRevision: 'p1', effect: 'allow' as const, ruleId: 'r' });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-race-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 }); await mkdir(join(home, 'global'), { mode: 0o700 });
  const env = { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: join(home, 'global') };
  const open = (id: string) => openRegisteredSecretStore(id, env, 'linux'), selection = createInstallationSecretStoreSelection(env, 'linux');
  await selection.publish(FILE, (await selection.read()).digest);
  await open(FILE).set('A_KEY', 'old-a'); await open(FILE).set('B_KEY', 'old-b');
  /** A change prepared on `store` (the store its request opened), from its own process view of the custody section. */
  const admin = (store: string, waitMs: number) => new SecretStoreAdministration(open(store), allow, () => undefined, () => 1,
    createInstallationSecretCustody(env, 'linux', waitMs));
  const change = (store: string, waitMs: number) => ({
    set: (name: string, value: string) => admin(store, waitMs).set({ principal: me, scopeId: 'installation', name }, value),
    delete: (name: string) => admin(store, waitMs).delete({ principal: me, scopeId: 'installation', name }),
  });
  async function contents(id: string) {
    const store = open(id), names = await store.listNames();
    return Object.fromEntries(await Promise.all(names.map(async name => [name, await store.get(name)] as const)));
  }
  /** The switch to `to`, parked once at `point` inside its custody section until `release()`. */
  function parkedSwitch(to: string, point: Point) {
    let release!: () => void, reached!: () => void;
    const released = new Promise<void>(done => { release = done; }), arrived = new Promise<void>(done => { reached = done; });
    let fired = false;
    const pause = async (where: Point) => { if (where === point && !fired) { fired = true; reached(); await released; } };
    const wrap = (store: SecretStore, role: 'source' | 'target'): SecretStore => Object.freeze({ descriptor: store.descriptor,
      get: async (name: string) => { if (role === 'target') await pause('readback'); return store.get(name); },
      set: async (name: string, value: string) => { if (role === 'target') await pause('copy'); return store.set(name, value); },
      delete: async (name: string) => { if (role === 'source') await pause('delete'); return store.delete(name); },
      listNames: () => store.listNames(), inspect: () => store.inspect() });
    const ports: SecretStoreSwitchPorts = { environmentReferences: async () => [], has: isRegisteredSecretStore,
      open: id => id === to ? wrap(open(id), 'target') : wrap(open(id), 'source'),
      selection: { read: () => selection.read(), publish: async (store, digest) => { await pause('publish'); return selection.publish(store, digest); } },
      authorize: allow, audit: () => undefined, now: () => 1, custody: createInstallationSecretCustody(env, 'linux') };
    const result = new SecretStoreSwitch(ports).switch({ principal: me, scopeId: 'installation', to, confirmDowngrade: false });
    return { result, arrived, release };
  }
  return { env, open, selection, change, contents, parkedSwitch };
}

describe.skipIf(process.platform !== 'linux')('secret changes against a running store switch (Astra 2456 P1-1)', () => {
  for (const point of POINTS) {
    it(`a change that cannot wait while the switch is parked at ${point} is refused SECRET_STORE_BUSY and changes nothing`, async () => {
      const f = await fixture(), run = f.parkedSwitch(SEALED, point);
      await run.arrived;
      const before = { file: await f.contents(FILE), sealed: await f.contents(SEALED) };
      // Overwrite, new name and delete on the store the change opened (the old one), and a change on the new one: all refused, typed.
      expect(await code(f.change(FILE, 150).set('A_KEY', 'new-a'))).toBe('SECRET_STORE_BUSY');
      expect(await code(f.change(FILE, 150).set('C_KEY', 'new-c'))).toBe('SECRET_STORE_BUSY');
      expect(await code(f.change(FILE, 150).delete('B_KEY'))).toBe('SECRET_STORE_BUSY');
      expect(await code(f.change(SEALED, 150).set('D_KEY', 'new-d'))).toBe('SECRET_STORE_BUSY');
      expect({ file: await f.contents(FILE), sealed: await f.contents(SEALED) }).toEqual(before);
      run.release();
      expect(await run.result).toMatchObject({ status: 'switched', from: FILE, to: SEALED, entries: 2, cleaned: true });
      expect(await f.contents(SEALED)).toEqual({ A_KEY: 'old-a', B_KEY: 'old-b' });
      expect(await f.contents(FILE)).toEqual({});
    }, 30_000);

    it(`a change that waits out the switch parked at ${point} lands on the selected store or is refused SECRET_STORE_CHANGED; no acknowledged change is lost`, async () => {
      const f = await fixture();
      // A change acknowledged before the switch starts is moved with the rest.
      await f.change(FILE, 1_000).set('A_KEY', 'acknowledged-a');
      const run = f.parkedSwitch(SEALED, point);
      await run.arrived;
      const overwrite = code(f.change(FILE, 10_000).set('A_KEY', 'late-a')), added = code(f.change(FILE, 10_000).set('C_KEY', 'late-c'));
      const removed = code(f.change(FILE, 10_000).delete('B_KEY')), onTarget = code(f.change(SEALED, 10_000).set('D_KEY', 'late-d'));
      let settled = false; void Promise.race([overwrite, added, removed, onTarget]).then(() => { settled = true; });
      await sleep(200);
      // Parked inside the section: every change waits; nothing touched either store.
      expect(settled).toBe(false);
      run.release();
      expect(await run.result).toMatchObject({ status: 'switched', entries: 2, cleaned: true });
      // The changes prepared on the old store were not applied anywhere (typed refusal); the one prepared on the new store landed.
      expect(await overwrite).toBe('SECRET_STORE_CHANGED'); expect(await added).toBe('SECRET_STORE_CHANGED'); expect(await removed).toBe('SECRET_STORE_CHANGED');
      expect(await onTarget).toBe('resolved');
      expect(await f.contents(SEALED)).toEqual({ A_KEY: 'acknowledged-a', B_KEY: 'old-b', D_KEY: 'late-d' });
      expect(await f.contents(FILE)).toEqual({});
      // After the switch a change prepared on the selected store applies as usual.
      await f.change(SEALED, 1_000).set('A_KEY', 'after-a'); await f.change(SEALED, 1_000).delete('B_KEY');
      expect(await f.contents(SEALED)).toEqual({ A_KEY: 'after-a', D_KEY: 'late-d' });
    }, 30_000);
  }

  it('a half-finished cleanup (selection published, old copies left) runs in the section: a change and a switch back that arrive meanwhile lose nothing', async () => {
    const f = await fixture();
    // An interrupted switch: both copies identical, the encrypted store already selected.
    await f.open(SEALED).set('A_KEY', 'old-a'); await f.open(SEALED).set('B_KEY', 'old-b');
    await f.selection.publish(SEALED, (await f.selection.read()).digest);
    const run = f.parkedSwitch(SEALED, 'delete');
    await run.arrived;
    // Parked between "identical" and the removal of the old copies: a change of the selected store and a confirmed switch back to the file store.
    const onSelected = code(f.change(SEALED, 10_000).set('A_KEY', 'new-a'));
    const back = new SecretStoreSwitch({ environmentReferences: async () => [], has: isRegisteredSecretStore, open: f.open, selection: f.selection, authorize: allow, audit: () => undefined,
      now: () => 1, custody: createInstallationSecretCustody(f.env, 'linux', 10_000) })
      .switch({ principal: me, scopeId: 'installation', to: FILE, confirmDowngrade: true });
    run.release();
    expect(await run.result).toMatchObject({ status: 'current', entries: 2, cleaned: true });
    expect(await back).toMatchObject({ status: 'switched', from: SEALED, to: FILE, entries: 2 });
    // Whichever waiter ran first, the acknowledged value survives: applied before the switch back it moved with it, otherwise it was refused typed.
    const applied = await onSelected;
    expect(['resolved', 'SECRET_STORE_CHANGED']).toContain(applied);
    expect(await f.contents(FILE)).toEqual({ A_KEY: applied === 'resolved' ? 'new-a' : 'old-a', B_KEY: 'old-b' });
    expect(await f.contents(SEALED)).toEqual({});
  }, 30_000);

  it('another process holding the installation section (a second service) makes changes and switches wait bounded and refuse typed; a dead holder is reclaimed', async () => {
    const f = await fixture();
    const adapters = resolve('dist/adapters/index.js');
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `
      const { createInstallationSecretCustody } = await import(${JSON.stringify(adapters)});
      setInterval(() => undefined, 1000);
      await createInstallationSecretCustody(${JSON.stringify(f.env)}, 'linux').exclusive(() => new Promise(() => { process.stdout.write('held\\n'); }));`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    holder.stdout!.on('data', chunk => { stdout += String(chunk); }); holder.stderr!.on('data', chunk => { stderr += String(chunk); });
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`HOLDER_TIMEOUT:${stderr}`)), 10_000);
        holder.stdout!.on('data', () => { if (stdout.includes('held\n')) { clearTimeout(timer); done(); } });
        holder.once('exit', () => { clearTimeout(timer); reject(new Error(`HOLDER_EXIT:${stderr}`)); });
      });
      expect(await code(f.change(FILE, 300).set('A_KEY', 'new-a'))).toBe('SECRET_STORE_BUSY');
      const blocked = new SecretStoreSwitch({ environmentReferences: async () => [], has: isRegisteredSecretStore, open: f.open, selection: f.selection, authorize: allow, audit: () => undefined,
        now: () => 1, custody: createInstallationSecretCustody(f.env, 'linux', 300) });
      expect(await code(blocked.switch({ principal: me, scopeId: 'installation', to: SEALED, confirmDowngrade: false }))).toBe('SECRET_STORE_BUSY');
      expect(await f.contents(FILE)).toEqual({ A_KEY: 'old-a', B_KEY: 'old-b' }); expect((await f.selection.read()).store).toBe(FILE);
      // A holder that dies inside the section does not wedge the installation: its lock is reclaimed and the change applies.
      holder.kill('SIGKILL'); await once(holder, 'exit');
      await f.change(FILE, 5_000).set('A_KEY', 'new-a');
      expect(await f.contents(FILE)).toEqual({ A_KEY: 'new-a', B_KEY: 'old-b' });
    } finally { if (holder.exitCode === null && holder.signalCode === null) { holder.kill('SIGKILL'); await once(holder, 'exit'); } }
  }, 30_000);
});

describe.skipIf(process.platform !== 'linux')('store switch target privacy (S1 O1)', () => {
  it('a switch into a global home others can read is refused with the path before anything is recorded or selected; the directory is not chmod\'ed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-secret-switch-private-')); roots.push(root);
    const home = join(root, 'home'), global = join(home, 'global'); await mkdir(home, { mode: 0o700 }); await mkdir(global, { mode: 0o700 });
    const { chmod, lstat } = await import('node:fs/promises'); await chmod(global, 0o755);
    const env = { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: global }, selection = createInstallationSecretStoreSelection(env, 'linux');
    const audits: unknown[] = [];
    const run = () => new SecretStoreSwitch({ environmentReferences: async () => [], has: isRegisteredSecretStore, open: id => openRegisteredSecretStore(id, env, 'linux'), selection, authorize: allow,
      audit: event => { audits.push(event); }, now: () => 1, custody: createInstallationSecretCustody(env, 'linux') })
      .switch({ principal: me, scopeId: 'installation', to: SEALED, confirmDowngrade: false });
    await expect(run()).rejects.toMatchObject({ code: 'SECRET_STORE_UNSAFE', params: { path: global } });
    expect(audits).toEqual([]); expect((await selection.read()).store).toBeNull(); expect((await lstat(global)).mode & 0o777).toBe(0o755);
    // A fresh global home is created owner-only and the same switch is admitted; the store then accepts a secret.
    const fresh = join(root, 'fresh'), freshEnv = { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: fresh };
    await new SecretStoreSwitch({ environmentReferences: async () => [], has: isRegisteredSecretStore, open: id => openRegisteredSecretStore(id, freshEnv, 'linux'), selection: createInstallationSecretStoreSelection(freshEnv, 'linux'),
      authorize: allow, audit: () => undefined, now: () => 1, custody: createInstallationSecretCustody(freshEnv, 'linux') })
      .switch({ principal: me, scopeId: 'installation', to: SEALED, confirmDowngrade: false });
    expect((await lstat(fresh)).mode & 0o777).toBe(0o700);
    await openRegisteredSecretStore(SEALED, freshEnv, 'linux').set('A_KEY', 'synthetic-a');
    expect(await openRegisteredSecretStore(SEALED, freshEnv, 'linux').get('A_KEY')).toBe('synthetic-a');
  });
});
