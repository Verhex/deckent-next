import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGlobMatcher, createWorkspaceScope, DEFAULT_WORKSPACE_READ_DENY, hostShellRealm, openShellRealm, REPOSITORY_INTERNALS_DENY, sandboxWriteView, shellWritePosture,
  type ShellRealmResolution, type ShellSandboxLayout } from '#adapters/index.js';
import { bubblewrapArguments, bubblewrapPosture, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';

// OPEN-SANDBOX: the fourth write posture (full access: open view) and the bubblewrap arguments that build it, without running bubblewrap.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const credentials = DEFAULT_WORKSPACE_READ_DENY.filter(pattern => !REPOSITORY_INTERNALS_DENY.includes(pattern)).map(createGlobMatcher);
const homeDenied = (path: string) => credentials.some(match => match(path));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-open-view-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'), global = join(root, 'global'), scratch = join(project, '.deckent/data/state/scratch/a/b');
  await Promise.all([mkdir(join(project, '.deckent/data/state/scratch/a/b'), { recursive: true }), mkdir(join(home, 'a/b/c'), { recursive: true }),
    mkdir(join(home, 'node_modules/pkg'), { recursive: true }), mkdir(join(home, '.ssh'), { recursive: true })]);
  await Promise.all([writeFile(join(project, '.deckent/data/policy.json'), '{}'), writeFile(join(project, '.deckent/config.json'), '{}'), writeFile(join(home, '.npmrc'), 't'), writeFile(join(home, '.ssh/id_ed25519'), 'k'),
    writeFile(join(home, 'a/b/key.pem'), 'k'), writeFile(join(home, 'a/b/c/deep.pem'), 'k'), writeFile(join(home, 'node_modules/pkg/x.pem'), 'k'), writeFile(join(home, 'notes.txt'), 'n')]);
  await symlink(join(home, 'notes.txt'), join(home, 'link.pem'));
  const deny = [...DEFAULT_WORKSPACE_READ_DENY.filter(pattern => !REPOSITORY_INTERNALS_DENY.includes(pattern)), '.deckent/data/policy.json*', '.deckent/data/state/scratch*', '.deckent/data/state/scratch/**'];
  const layout: ShellSandboxLayout = { project: await createWorkspaceScope(project, deny), scratchDir: scratch, writeFloor: rel => rel.startsWith('.deckent/config.json'), repositoryWritable: true,
    hardFloor: { roots: [join(project, '.deckent'), join(project, '.deckent/data'), global], homeDenied } };
  return { root, project, home, global, scratch, layout };
}

describe('OPEN-SANDBOX posture', () => {
  it('full access (and an owner-approved call of a full-access turn) is open; an unattended call and every other turn stay closed', () => {
    expect(shellWritePosture('full-access', 'unrecognized', true)).toEqual({ writeFloorReadOnly: true, projectReadOnly: false, writeSet: false, open: true });
    expect(shellWritePosture('owner-approved', 'unrecognized', true).open).toBe(true);
    expect(shellWritePosture('owner-approved', 'unrecognized', false).open).toBe(false);
    expect(shellWritePosture('unattended', 'narrow-mutating', true)).toEqual({ writeFloorReadOnly: true, projectReadOnly: true, writeSet: false, open: false });
    expect(shellWritePosture('full-auto', 'unrecognized', false, true).open).toBe(false);
    // The view never carries `open` with a read-only project or a write set.
    expect(sandboxWriteView({ repositoryWritable: true }, { writeFloorReadOnly: true, projectReadOnly: true, open: true }).open).toBeUndefined();
    expect(sandboxWriteView({ repositoryWritable: true }, { writeFloorReadOnly: true, projectReadOnly: false, writeSet: true, open: true }).open).toBeUndefined();
    const view = sandboxWriteView({ repositoryWritable: true }, shellWritePosture('full-access', 'unrecognized', true));
    expect(bubblewrapPosture(view)).toContain('network on, HOME visible, Deckent state and credentials hidden/read-only');
    expect(bubblewrapPosture(view)).toContain('.git writable');
    expect(bubblewrapPosture(sandboxWriteView({}, shellWritePosture('owner-approved', 'unrecognized', false)))).toContain('there is no network');
  });

  it('a realm that cannot open: prefer-sandbox moves the call to the host, require-sandbox keeps it closed; both say so', () => {
    const landlock: Extract<ShellRealmResolution, { ok: true }> = { ok: true, realm: { kind: 'landlock', run: hostShellRealm.run }, marker: 'sandbox: landlock', notice: null,
      posture: () => 'Runs in a Landlock sandbox', containment: 'sandbox', rejected: [{ kind: 'bubblewrap', reason: 'bubblewrap restricted' }] };
    const host = openShellRealm(landlock, 'prefer-sandbox');
    expect({ kind: host.realm.kind, marker: host.marker, containment: host.containment }).toEqual({ kind: 'host', marker: 'sandbox: none', containment: 'host' });
    expect(host.notice).toContain('full access: no open sandbox (bubblewrap: bubblewrap restricted; landlock cannot open the network and HOME); running on host');
    const kept = openShellRealm(landlock, 'require-sandbox');
    expect({ kind: kept.realm.kind, marker: kept.marker }).toEqual({ kind: 'landlock', marker: 'sandbox: landlock' });
    expect(kept.notice).toContain('require-sandbox keeps this call in the closed landlock view');
    expect(kept.posture({ projectReadOnly: false, writeFloorReadOnly: true, repositoryWritable: true, open: true })).toContain('full access: no open sandbox');
    // A realm that opens, the host mode and a host fallback are unchanged.
    expect(openShellRealm({ ...landlock, opens: true }, 'prefer-sandbox')).toMatchObject({ marker: 'sandbox: landlock', notice: null });
    const hostMode: Extract<ShellRealmResolution, { ok: true }> = { ok: true, realm: hostShellRealm, marker: null, notice: null, posture: () => 'host', containment: 'host' };
    expect(openShellRealm(hostMode, 'host')).toBe(hostMode);
  });
});

describe.skipIf(process.platform !== 'linux')('OPEN-SANDBOX bubblewrap view', () => {
  it('seals the state roots, masks credential files in HOME (bounded), and orders the arguments so the floor covers the host bind', async () => {
    const f = await fixture();
    const resolved = await resolveBubblewrapView(f.layout, { HOME: f.home, PATH: '/usr/bin:/bin' }, {}, { floorReadOnly: true, open: true });
    if (!resolved.ok) throw new Error(resolved.reason);
    const view = resolved.view;
    // A missing root (the global one) is created empty and private, then hidden; the project's product root is sealed (nested data root folded in).
    expect((await stat(f.global)).mode & 0o777).toBe(0o700);
    expect(view.open).toEqual({ sealed: [join(f.project, '.deckent')], hidden: [f.global] });
    expect(view.maskedFiles).toEqual(expect.arrayContaining([join(f.home, '.npmrc'), join(f.home, '.ssh/id_ed25519'), join(f.home, 'a/b/key.pem'), join(f.project, '.deckent/data/policy.json')]));
    // Bounded walk: depth 3, vendored trees and symbolic links not entered/masked.
    for (const path of ['a/b/c/deep.pem', 'node_modules/pkg/x.pem', 'link.pem', 'notes.txt']) expect(view.maskedFiles).not.toContain(join(f.home, path));
    const args = bubblewrapArguments(view), at = (...token: string[]) => args.findIndex((_, index) => token.every((part, offset) => args[index + offset] === part));
    expect(at('--unshare-all')).toBeLessThan(at('--share-net'));
    expect(at('--bind', '/', '/')).toBeLessThan(at('--proc', '/proc'));
    expect(at('--tmpfs', '/tmp')).toBe(-1);
    expect(at('--tmpfs', f.home)).toBe(-1);
    expect(at('--bind', f.project, f.project)).toBeLessThan(at('--ro-bind', join(f.project, '.deckent'), join(f.project, '.deckent')));
    expect(at('--ro-bind', join(f.project, '.deckent'), join(f.project, '.deckent'))).toBeLessThan(at('--ro-bind', '/dev/null', join(f.project, '.deckent/data/policy.json')));
    expect(at('--perms', '0700', '--tmpfs', f.global)).toBeLessThan(at('--bind', f.scratch, f.scratch));
    expect(at('--bind', f.scratch, f.scratch)).toBeLessThan(at('--remount-ro', f.global));
    // The configuration file (the turn's write floor) stays read-only under full access; an owner-approved call of that turn (its card
    // approved the floor) gets the existing file writable inside the sealed root — content only, never a new name.
    const config = join(f.project, '.deckent/config.json');
    expect({ readOnly: view.readOnlyPaths.includes(config), writable: view.writablePaths?.includes(config) ?? false }).toEqual({ readOnly: true, writable: false });
    const approved = await resolveBubblewrapView(f.layout, { HOME: f.home, PATH: '/usr/bin:/bin' }, {}, { floorReadOnly: false, open: true });
    if (!approved.ok) throw new Error(approved.reason);
    expect({ readOnly: approved.view.readOnlyPaths.includes(config), writable: approved.view.writablePaths?.includes(config) ?? false }).toEqual({ readOnly: false, writable: true });
    const approvedArgs = bubblewrapArguments(approved.view);
    expect(approvedArgs.join('\0').indexOf(['--ro-bind', join(f.project, '.deckent'), join(f.project, '.deckent')].join('\0')))
      .toBeLessThan(approvedArgs.join('\0').indexOf(['--bind', config, config].join('\0')));
    // The closed view of the same layout is unchanged: no network, HOME a tmpfs.
    const closed = await resolveBubblewrapView(f.layout, { HOME: f.home, PATH: '/usr/bin:/bin' }, {}, { floorReadOnly: true });
    if (!closed.ok) throw new Error(closed.reason);
    const closedArgs = bubblewrapArguments(closed.view);
    expect({ shareNet: closedArgs.includes('--share-net'), rootBind: closedArgs.join(' ').includes('--bind / /'), homeTmpfs: closedArgs.join(' ').includes(`--tmpfs ${f.home}`) })
      .toEqual({ shareNet: false, rootBind: false, homeTmpfs: true });
  });

  it('the HOME walk skips only what is inside the project and the state roots, never their ancestors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-open-nested-')); roots.push(root);
    const home = join(root, 'home'), project = join(home, 'work/proj'), hidden = join(home, '.local/state/x');
    await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(hidden, { recursive: true }), mkdir(join(home, '.local/share'), { recursive: true }),
      mkdir(join(home, 'work/other'), { recursive: true })]);
    await Promise.all([writeFile(join(home, '.local/share/key.pem'), 'k'), writeFile(join(home, 'work/other/.env'), 'k'), writeFile(join(hidden, 'secrets.json'), 'k'),
      writeFile(join(project, 'id.pem'), 'k')]);
    const layout: ShellSandboxLayout = { project: await createWorkspaceScope(project), scratchDir: null, writeFloor: () => false, repositoryWritable: true,
      hardFloor: { roots: [join(project, '.deckent'), hidden], homeDenied } };
    const resolved = await resolveBubblewrapView(layout, { HOME: home, PATH: '/usr/bin:/bin' }, {}, { floorReadOnly: true, open: true });
    if (!resolved.ok) throw new Error(resolved.reason);
    const masked = resolved.view.maskedFiles;
    expect(masked).toEqual(expect.arrayContaining([join(home, '.local/share/key.pem'), join(home, 'work/other/.env')]));
    // Inside the hidden root nothing is masked one by one (the root is hidden whole); the project's own file is its walk's (the project deny).
    expect(masked).not.toContain(join(hidden, 'secrets.json'));
    expect(masked.filter(path => path === join(project, 'id.pem'))).toHaveLength(1);
  });

  it('owner Y: existing non-product subdirectories of a sealed root are writable; product ones, denied ones and the root itself are not', async () => {
    const f = await fixture();
    await Promise.all(['docs', 'recently-works', 'crashes', 'host'].map(name => mkdir(join(f.project, '.deckent', name), { recursive: true })));
    const productPaths = ['.deckent/data', '.deckent/crashes', '.deckent/mcp.json', '.deckent/host'];
    const product = (rel: string) => productPaths.some(path => path === rel || path.startsWith(`${rel}/`) || rel.startsWith(`${path}/`));
    const layout: ShellSandboxLayout = { ...f.layout, hardFloor: { ...f.layout.hardFloor!, product } };
    const resolved = await resolveBubblewrapView(layout, { HOME: f.home, PATH: '/usr/bin:/bin' }, {}, { floorReadOnly: true, open: true });
    if (!resolved.ok) throw new Error(resolved.reason);
    const writable = (resolved.view.writablePaths ?? []).filter(path => path.startsWith(join(f.project, '.deckent')));
    expect(writable.sort()).toEqual([join(f.project, '.deckent/docs'), join(f.project, '.deckent/recently-works')]);
    const args = bubblewrapArguments(resolved.view).join('\0');
    expect(args.indexOf(['--ro-bind', join(f.project, '.deckent'), join(f.project, '.deckent')].join('\0')))
      .toBeLessThan(args.indexOf(['--bind', join(f.project, '.deckent/docs'), join(f.project, '.deckent/docs')].join('\0')));
    // Without the product predicate nothing under the sealed root is rebound (fail safe).
    const bare = await resolveBubblewrapView(f.layout, { HOME: f.home, PATH: '/usr/bin:/bin' }, {}, { floorReadOnly: true, open: true });
    expect(bare.ok && (bare.view.writablePaths ?? []).some(path => path.startsWith(join(f.project, '.deckent')))).toBe(false);
  });

  it('fails closed: no hard floor, a root holding the project or HOME, a read-only project', async () => {
    const f = await fixture();
    const env = { HOME: f.home, PATH: '/usr/bin:/bin' };
    const withoutFloor: ShellSandboxLayout = { project: f.layout.project, scratchDir: f.layout.scratchDir, writeFloor: f.layout.writeFloor, repositoryWritable: true };
    expect(await resolveBubblewrapView(withoutFloor, env, {}, { floorReadOnly: true, open: true })).toEqual({ ok: false, reason: 'the hard floor is not known to this open view' });
    for (const holder of [f.root, f.project, f.home]) {
      const refused = await resolveBubblewrapView({ ...f.layout, hardFloor: { roots: [holder], homeDenied } }, env, {}, { floorReadOnly: true, open: true });
      expect(refused.ok ? null : refused.reason).toMatch(/holds the project or HOME/u);
    }
    expect(await resolveBubblewrapView(f.layout, env, {}, { floorReadOnly: true, projectReadOnly: true, open: true })).toEqual({ ok: false, reason: 'the open view is only for a writable project' });
  });
});
