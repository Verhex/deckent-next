import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FileArtifactStore, GitWorkspaceBroker, LocalOsPrincipalVerifier, createFileSecretStore, readLocalOsIdentity, openTerminalHistoryFile, openTerminalSessionStore, withInstallationJournal } from '#adapters/index.js';
import { publishInstallationFile } from '#adapters/core/installation-files/index.js';
import { observeBootstrapState, resolveGlobalScopePaths } from '#platform/index.js';

// These are guard simulations on Linux, not native Windows filesystem or process proof.
const { noUid } = vi.hoisted(() => ({ noUid: { active: false } }));
vi.mock('node:os', async importActual => {
  const actual = await importActual<typeof import('node:os')>();
  return { ...actual, userInfo: () => noUid.active ? { ...actual.userInfo(), uid: -1, gid: -1, shell: null } : actual.userInfo() };
});
const roots: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
afterEach(async () => {
  noUid.active = false;
  Object.defineProperty(process, 'platform', platform);
  if (getuid) Object.defineProperty(process, 'getuid', getuid); else Reflect.deleteProperty(process, 'getuid');
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function root() { const path = await mkdtemp(join(tmpdir(), 'ci-win-unsupported-')); roots.push(path); return path; }

it('a Windows fixture must supply USERPROFILE; HOME alone is a typed missing-home refusal', () => {
  expect(() => resolveGlobalScopePaths('win32', { HOME: 'C:\\Users\\fixture' })).toThrow(expect.objectContaining({ code: 'HOME_NOT_RESOLVED' }));
  expect(resolveGlobalScopePaths('win32', { HOME: 'C:\\Users\\fixture', USERPROFILE: 'C:\\Users\\fixture' }))
    .toMatchObject({ home: 'C:\\Users\\fixture', stateDir: 'C:\\Users\\fixture\\.deckent' });
});

it('Windows UID -1 is refused as AUTHENTICATION_REQUIRED; it grants no principal or scope', async () => {
  noUid.active = true;
  expect(() => readLocalOsIdentity()).toThrow(expect.objectContaining({ code: 'AUTHENTICATION_REQUIRED' }));
  await expect(new LocalOsPrincipalVerifier(['scope']).verify(undefined)).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
});

it('Windows private publication, journal and artifacts fail closed without creating product state', async () => {
  const directory = await root();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  await expect(publishInstallationFile({ root: directory, path: join(directory, 'config.json'), maxBytes: 4096, transactionId: 'ci' }, '{}'))
    .rejects.toMatchObject({ code: 'INSTALLATION_FILE_UNSUPPORTED' });
  await expect(withInstallationJournal(directory, { timeoutMs: 100 }, async () => { throw new Error('callback must not run'); }))
    .rejects.toMatchObject({ code: 'INSTALLATION_JOURNAL_UNSUPPORTED' });
  expect(() => new FileArtifactStore({ root: directory, maxBytes: 4096 })).toThrow(expect.objectContaining({ code: 'ARTIFACT_UNSUPPORTED' }));
  expect(await readdir(directory)).toEqual([]);
});

it('an existing bootstrap journal without POSIX ownership reports BOOTSTRAP_STATE_UNSUPPORTED and preserves bytes', async () => {
  const directory = await root(), installation = join(directory, '.deckent', 'installation');
  await mkdir(installation, { recursive: true }); const journal = join(installation, 'journal.json');
  await writeFile(journal, 'unread journal');
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
  await expect(observeBootstrapState(directory)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_UNSUPPORTED' });
  expect(await readFile(journal, 'utf8')).toBe('unread journal');
});

it('the Windows file secret store reports SECRET_STORE_UNAVAILABLE and writes nothing', async () => {
  const directory = await root(), store = createFileSecretStore({ root: directory, platform: 'win32' });
  await expect(store.set('FIXTURE', 'synthetic')).rejects.toMatchObject({ code: 'SECRET_STORE_UNAVAILABLE' });
  expect(await store.inspect()).toEqual({ status: 'unavailable', code: 'SECRET_STORE_UNAVAILABLE' });
  expect(await readdir(directory)).toEqual([]);
});

it('Windows refuses private terminal history and sessions before any state is created', async () => {
  const directory = await root();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  expect(() => openTerminalHistoryFile(join(directory, 'history.jsonl'))).toThrow(expect.objectContaining({ code: 'MANAGED_FILE_UNSUPPORTED' }));
  expect(() => openTerminalSessionStore(directory)).toThrow(expect.objectContaining({ code: 'MANAGED_FILE_UNSUPPORTED' }));
  expect(await readdir(directory)).toEqual([]);
});

it('Git custody refuses non-private directories with WORKSPACE_UNSAFE before running Git', async () => {
  const directory = await root(); await chmod(directory, 0o777);
  const broker = new GitWorkspaceBroker({ sourceRoot: directory, workspaceRoot: directory, gitExecutable: process.execPath, timeoutMs: 1000, outputBytes: 4096 });
  await expect(broker.captureSourceBase()).rejects.toMatchObject({ code: 'WORKSPACE_UNSAFE' });
  expect(await readdir(directory)).toEqual([]);
});
