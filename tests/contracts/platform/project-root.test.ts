import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { resolveProjectRoot, type ProjectRootEntry, type ProjectRootPorts } from '#platform/index.js';

// U7-1 (İ-6, audit C): one table over a virtual tree — the walk-up adopts only a guarded installation above the launch folder.
type Node = Readonly<{ kind: 'dir' | 'file' | 'link'; uid?: number; mode?: number; nlink?: number; dev?: number }>;
const UID = 1000, dir = (extra: Partial<Node> = {}): Node => ({ kind: 'dir', mode: 0o700, ...extra }), file = (extra: Partial<Node> = {}): Node => ({ kind: 'file', mode: 0o600, ...extra });
const installed = (root: string, policy: Partial<Node> = {}, identity = true): Record<string, Node> => ({ [root]: dir(), [`${root}/.deckent`]: dir(),
  [`${root}/.deckent/policy.json`]: file(policy), ...(identity ? { [`${root}/.deckent/installation-identity/identity.json`]: file() } : {}) });
function ports(start: string, tree: Record<string, Node>, extra: Partial<ProjectRootPorts> = {}): Partial<ProjectRootPorts> {
  const all: Record<string, Node> = { '/': dir(), '/home': dir(), '/home/u': dir(), [start]: dir(), ...tree };
  for (const path of Object.keys(all)) for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) all[parent] ??= dir();
  return { uid: UID, platform: 'linux', realpath: async path => path, tracked: async () => false, ...extra,
    lstat: async path => { const node = all[path]; return node ? { isFile: () => node.kind === 'file', isDirectory: () => node.kind === 'dir', isSymbolicLink: () => node.kind === 'link',
      uid: node.uid ?? UID, mode: node.mode ?? 0o700, nlink: node.nlink ?? 1, dev: node.dev ?? 1 } satisfies ProjectRootEntry : null; } };
}
const env = { HOME: '/home/u', DECKENT_GLOBAL_HOME: '/g/.deckent' };
const resolve = (start: string, tree: Record<string, Node>, extra: Partial<ProjectRootPorts> = {}, options: { exact?: boolean; env?: Record<string, string> } = {}) =>
  resolveProjectRoot(start, options.env ?? env, { ...(options.exact ? { exact: true } : {}), ports: ports(start, tree, extra) });

it('walks up only to a guarded installation, refuses an unsafe one and keeps the exact folder as today', async () => {
  const p = '/home/u/p';
  expect(await resolve(`${p}/a/b`, installed(p))).toEqual({ root: p, folder: 'a/b', found: true, gitTop: null });
  expect(await resolve(`${p}/n/x`, { ...installed(p), ...installed(`${p}/n`) })).toMatchObject({ root: `${p}/n`, folder: 'x' });
  // Tracked docs or a tracked config without a policy file are no installation; the Git top is proposed instead.
  expect(await resolve(`${p}/a`, { [`${p}/.deckent/docs/x.md`]: file(), [`${p}/.deckent/config.json`]: file(), [`${p}/.git`]: dir(), [`${p}/.git/HEAD`]: file() }))
    .toEqual({ root: `${p}/a`, folder: '', found: false, gitTop: p });
  // BeUser AYSE-02: an empty `.git` folder above is no repository (the person's own folder stays the proposal); a `.git` file (worktree) is one.
  expect(await resolve(`${p}/a`, { [`${p}/.git`]: dir() })).toMatchObject({ root: `${p}/a`, found: false, gitTop: null });
  expect(await resolve(`${p}/a`, { [`${p}/.git`]: file() })).toMatchObject({ found: false, gitTop: p });
  // The global state root is never a project: by default under $HOME, and when relocated.
  expect(await resolve(`${p}/a`, installed('/home/u'), {}, { env: { HOME: '/home/u' } })).toMatchObject({ found: false });
  expect(await resolve('/g/x', installed('/g'))).toMatchObject({ found: false });
  // The walk stops at $HOME (Git's discovery ceiling): a safe same-UID installation above it is never adopted; outside HOME the walk is unchanged.
  expect(await resolve('/home/u/work/x', installed('/home'))).toEqual({ root: '/home/u/work/x', folder: '', found: false, gitTop: null });
  expect(await resolve('/srv/p/a', installed('/srv/p'))).toMatchObject({ root: '/srv/p', folder: 'a', found: true });
  // An identity not created yet: not an installation, and nothing further up is adopted in its place.
  expect(await resolve(`${p}/n/x`, { ...installed(p), ...installed(`${p}/n`, {}, false) })).toMatchObject({ root: `${p}/n/x`, found: false });
  const tracked = { ...installed(p), [`${p}/.git`]: dir() };
  await expect(resolve(`${p}/a`, tracked, { tracked: async () => true })).rejects.toMatchObject({ code: 'INSTALLATION_ROOT_TRACKED', params: { reason: 'tracked' } });
  await expect(resolve(`${p}/a`, tracked, { tracked: async () => null })).rejects.toMatchObject({ code: 'INSTALLATION_ROOT_TRACKED', params: { reason: 'unknown' } });
  expect(await resolve(`${p}/a`, installed(p), { tracked: async () => true })).toMatchObject({ found: true }); // no work tree: Git is not asked
  await expect(resolve(`${p}/a`, installed(p, { mode: 0o644 }))).rejects.toMatchObject({ code: 'INSTALLATION_ROOT_UNSAFE', params: { reason: 'mode' } });
  await expect(resolve(`${p}/a`, installed(p, { mode: 0o400 }))).rejects.toMatchObject({ code: 'INSTALLATION_ROOT_UNSAFE', params: { reason: 'mode' } });
  await expect(resolve(`${p}/a`, { ...installed(p), [`${p}/.deckent`]: dir({ mode: 0o755 }) })).rejects.toMatchObject({ code: 'INSTALLATION_ROOT_UNSAFE', params: { reason: 'mode' } });
  await expect(resolve(`${p}/a`, { ...installed(p), [`${p}/.deckent`]: { kind: 'link' } })).rejects.toMatchObject({ code: 'INSTALLATION_ROOT_UNSAFE', params: { reason: 'symlink' } });
  await expect(resolve(`${p}/a`, installed(p, { uid: 0 }))).rejects.toMatchObject({ code: 'INSTALLATION_ROOT_FOREIGN' });
  await expect(resolve(`${p}/a`, { ...installed(p), [`${p}/.deckent`]: dir({ mode: 0o777 }) })).rejects.toMatchObject({ code: 'INSTALLATION_ROOT_FOREIGN' });
  await expect(resolve(`${p}/.deckent/workspaces/w`, installed(p))).rejects.toMatchObject({ code: 'INSTALLATION_ROOT_INSIDE_DATA_ROOT' });
  await expect(resolve(`${p}/a`, installed(p), { platform: 'win32' }, { env: { ...env, USERPROFILE: '/home/u' } })).rejects.toMatchObject({ code: 'INSTALLATION_ROOT_WALK_UNSUPPORTED' });
  // A mount boundary ends the walk; the exact folder (start, `--project`, `init --here`) keeps today's behavior without the walk-up checks.
  expect(await resolve(`${p}/m/a`, { ...installed(p), [`${p}/m`]: dir({ dev: 2 }), [`${p}/m/a`]: dir({ dev: 2 }) })).toMatchObject({ found: false });
  expect(await resolve(p, installed(p, { mode: 0o644 }))).toEqual({ root: p, folder: '', found: true, gitTop: null });
  expect(await resolve(`${p}/a`, installed(p), {}, { exact: true })).toEqual({ root: `${p}/a`, folder: '', found: false, gitTop: null });
  expect(await resolve('/alias', { '/physical': dir() }, { realpath: async path => path === '/alias' ? '/physical' : path }))
    .toEqual({ root: '/physical', folder: '', found: false, gitTop: null });
});
