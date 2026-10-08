import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyPolicyTemplateInstallationWithSecretDefault } from '#composition/core/installation/index.js';
import { resolveGlobalConfigPaths } from '#platform/index.js';

// SECRET-DEFAULT (owner 2026-10-08, Jev 60bdc5e6) on the governed store switch (Jev a0284b73, 0950f08e): a fresh installation on Linux/WSL/macOS
// selects the encrypted secret store through `deckent init policy --apply`; an existing installation, a replay or a config that already names a store is
// left as it is, and native Windows keeps the environment store until the OS keyring backend.
const roots: string[] = [], cli = resolve('dist/composition/core/cli/internal/entry.js');
const SEALED = 'core.secret-store.encrypted-file@1';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-default-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'); await mkdir(project); await mkdir(home, { mode: 0o700 });
  const env = { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: join(home, 'global'), DECKENT_LANGUAGE: 'en', NO_COLOR: '1', PATH: process.env.PATH ?? '' };
  const globalPath = resolveGlobalConfigPaths(env, 'linux').platformPath;
  async function run(args: string[]) {
    const capture = await mkdtemp(join(root, 'capture-')), output = join(capture, 'stdout'), error = join(capture, 'stderr'), stdin = join(capture, 'stdin');
    await writeFile(stdin, '');
    const handles = await Promise.all([open(stdin, 'r'), open(output, 'w'), open(error, 'w')]);
    try {
      const child = spawn(process.execPath, [cli, ...args], { cwd: project, env, stdio: handles.map(handle => handle.fd) });
      const code = await new Promise<number | null>((accept, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('SECRET_DEFAULT_PROCESS_TIMEOUT')); }, 20_000);
        child.once('error', failure => { clearTimeout(timer); reject(failure); });
        child.once('close', status => { clearTimeout(timer); accept(status); });
      });
      return { code, stdout: await readFile(output, 'utf8'), stderr: await readFile(error, 'utf8') };
    } finally { await Promise.all(handles.map(handle => handle.close())); }
  }
  const globalConfig = async () => JSON.parse(await readFile(globalPath, 'utf8').catch(() => '{}')) as { secrets?: { store?: string } };
  return { project, globalPath, run, globalConfig };
}

it.skipIf(process.platform !== 'linux')('a fresh `init policy --apply` selects the encrypted store in the installation config; a replay changes nothing; doctor names it', async () => {
  const f = await fixture();
  const applied = await f.run(['init', 'policy', '--scope', 'installation', '--apply', '--json']);
  expect(applied.code, applied.stderr).toBe(0);
  // The switch's own record is the command result (no ledger yet at this point): decided by the policy this run installed, nothing moved.
  expect(JSON.parse(applied.stdout)).toMatchObject({ status: 'installed', secretStore: { status: 'set', backend: SEALED, record: {
    policyRevision: expect.stringContaining('first-run-template-v6'), subject: { kind: 'secret-store-switch', from: 'core.secret-store.env@1', to: SEALED,
      entries: 0, downgrade: false, decision: { effect: 'allow', ruleId: 'first-run-secret-switch' } } } } });
  expect((await f.globalConfig()).secrets).toEqual({ store: SEALED });
  const before = await readFile(f.globalPath, 'utf8');
  // The same command again is not a fresh installation: no default step, the installation config byte-identical.
  const again = await f.run(['init', 'policy', '--scope', 'installation', '--apply', '--json']);
  expect(again.code, again.stderr).toBe(0);
  expect(JSON.parse(again.stdout)).not.toHaveProperty('secretStore');
  expect(await readFile(f.globalPath, 'utf8')).toBe(before);
  const doctor = await f.run(['doctor']);
  expect(doctor.stdout).toContain(`Secret store: ${SEALED}`);
  expect(doctor.stdout).toContain('other programs running as your user can');
}, 60_000);

it.skipIf(process.platform !== 'linux')('a store the installation config already names is kept; an existing installation is never switched', async () => {
  const f = await fixture();
  await mkdir(dirname(f.globalPath), { recursive: true, mode: 0o700 });
  await writeFile(f.globalPath, JSON.stringify({ secrets: { store: 'core.secret-store.file@1' } }), { mode: 0o600 });
  const kept = await f.run(['init', 'policy', '--scope', 'installation', '--apply', '--json']);
  expect(kept.code, kept.stderr).toBe(0);
  expect(JSON.parse(kept.stdout)).toMatchObject({ secretStore: { status: 'kept', backend: 'core.secret-store.file@1' } });
  expect((await f.globalConfig()).secrets).toEqual({ store: 'core.secret-store.file@1' });
  // An installation that already has its policy (here: the one just installed) and no store selection stays on the environment store.
  await writeFile(f.globalPath, JSON.stringify({}), { mode: 0o600 });
  const existing = await f.run(['init', 'policy', '--scope', 'installation', '--apply', '--json']);
  expect(existing.code, existing.stderr).toBe(0);
  expect(JSON.parse(existing.stdout)).not.toHaveProperty('secretStore');
  expect((await f.globalConfig()).secrets).toBeUndefined();
}, 60_000);

it('native Windows keeps the environment store until the OS keyring backend: the default is not offered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-default-win-')); roots.push(root);
  const result = await applyPolicyTemplateInstallationWithSecretDefault(root, 'installation', { platform: 'win32', env: { USERPROFILE: root } });
  expect(result).toMatchObject({ status: 'installed', secretStore: { status: 'platform', backend: null } });
});
