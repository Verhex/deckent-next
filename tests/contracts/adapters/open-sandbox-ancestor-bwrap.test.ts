import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGlobMatcher, createWorkspaceScope, DEFAULT_WORKSPACE_READ_DENY, REPOSITORY_INTERNALS_DENY, type ShellSandboxLayout } from '#adapters/index.js';
import { bubblewrapArguments, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

/**
 * Astra 2189 R7 at the real boundary: the open (full-access) view built by the adapter, run by the selected bubblewrap. A protective mount
 * (sealed/hidden state root, a credential mask) must not travel away with a renamed ancestor, leaving its original path for a command to
 * recreate: every ancestor is a mount point (EBUSY) — HOME, the global root's parents, the project's parents, a directory above a masked
 * file inside the project, inside HOME and inside an owner-Y writable `.deckent/docs`. And the pins must not undo the floor (ordering): a
 * direct write to a sealed root still fails, a masked credential stays unreadable, while HOME, the project and `.deckent/docs` stay writable.
 */
const measured = await measureTestShellHost();
const launcher = measured.bubblewrap.status === 'available' ? measured.bubblewrap.launcher?.path ?? null : null;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const credentials = DEFAULT_WORKSPACE_READ_DENY.filter(pattern => !REPOSITORY_INTERNALS_DENY.includes(pattern)).map(createGlobMatcher);
const homeDenied = (path: string) => credentials.some(match => match(path));
const ORIGINAL = 'ORIGINAL-SYNTHETIC';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-r7-')); roots.push(root, `${root}-moved`);
  const work = join(root, 'work'), project = join(work, 'project'), home = join(root, 'home'), authority = join(root, 'authority'), global = join(authority, 'state');
  const userRoot = join(home, '.local/state/deckent');
  await Promise.all([mkdir(join(project, '.deckent/docs/sub'), { recursive: true }), mkdir(join(project, 'a/b'), { recursive: true }), mkdir(join(project, 'src'), { recursive: true }),
    mkdir(join(home, '.config/tool'), { recursive: true }), mkdir(userRoot, { recursive: true }), mkdir(global, { recursive: true })]);
  await Promise.all([writeFile(join(project, '.deckent/mcp.json'), ORIGINAL), writeFile(join(project, 'a/b/.env'), ORIGINAL), writeFile(join(project, '.deckent/docs/sub/.env'), ORIGINAL),
    writeFile(join(project, '.deckent/docs/a.md'), 'doc'), writeFile(join(home, '.config/tool/id.pem'), ORIGINAL), writeFile(join(userRoot, 'mcp.json'), ORIGINAL),
    writeFile(join(global, 'mcp.json'), ORIGINAL), writeFile(join(home, 'notes.txt'), 'notes')]);
  const deny = DEFAULT_WORKSPACE_READ_DENY.filter(pattern => !REPOSITORY_INTERNALS_DENY.includes(pattern));
  const product = (rel: string) => rel === '.deckent/mcp.json';
  const layout: ShellSandboxLayout = { project: await createWorkspaceScope(project, deny), scratchDir: null, writeFloor: () => false, repositoryWritable: true,
    hardFloor: { roots: [join(project, '.deckent'), userRoot, global], homeDenied, product } };
  const env = { HOME: home, PATH: '/usr/bin:/bin' };
  const run = async (command: string) => {
    const view = await resolveBubblewrapView(layout, env, {}, { floorReadOnly: true, open: true });
    if (!view.ok) throw new Error(view.reason);
    const out = spawnSync(launcher!, [...bubblewrapArguments(view.view), '--', '/bin/bash', '--noprofile', '--norc', '-c', command], { encoding: 'utf8', env, timeout: 20_000 });
    return { status: out.status, output: `${out.stdout}${out.stderr}` };
  };
  const bytes = (path: string) => readFile(path, 'utf8').catch(() => null);
  return { root, work, project, home, authority, global, userRoot, run, bytes };
}

describe.skipIf(process.platform !== 'linux')('R7: the open view pins every ancestor of a protective mount', () => {
  it.skipIf(!launcher)('a renamed ancestor cannot carry a protected path away: each rename fails with EBUSY, the original bytes stay', async () => {
    // Each shape on its own fixture, so one rename that lands cannot hide another.
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const shapes: ((f: Fixture) => { moved: string; protectedFile: string })[] = [
      // The global root's parent, and a grandparent (more than one ancestor).
      f => ({ moved: f.authority, protectedFile: join(f.global, 'mcp.json') }),
      f => ({ moved: f.root, protectedFile: join(f.global, 'mcp.json') }),
      // HOME, and the user state root's ancestors inside it.
      f => ({ moved: f.home, protectedFile: join(f.userRoot, 'mcp.json') }),
      f => ({ moved: join(f.home, '.local'), protectedFile: join(f.userRoot, 'mcp.json') }),
      // The project's parent (the project's `.deckent` is sealed; the project itself is already a mount point).
      f => ({ moved: f.work, protectedFile: join(f.project, '.deckent/mcp.json') }),
      // A directory above a masked file: inside the project, inside HOME, inside the owner-Y writable `.deckent/docs`.
      f => ({ moved: join(f.project, 'a'), protectedFile: join(f.project, 'a/b/.env') }),
      f => ({ moved: join(f.home, '.config'), protectedFile: join(f.home, '.config/tool/id.pem') }),
      f => ({ moved: join(f.project, '.deckent/docs/sub'), protectedFile: join(f.project, '.deckent/docs/sub/.env') })];
    const results = [];
    for (const shape of shapes) {
      const f = await fixture(), { moved, protectedFile } = shape(f);
      const outcome = await f.run(`mv '${moved}' '${moved}-moved' && mkdir -p "$(dirname '${protectedFile}')" && printf REPLACED-SYNTHETIC > '${protectedFile}'`);
      results.push({ moved: moved.slice(f.root.length) || '<root>', status: outcome.status, busy: /Device or resource busy/u.test(outcome.output), current: await f.bytes(protectedFile) });
    }
    console.log('R7_ANCESTOR_SHAPES', JSON.stringify(results));
    for (const result of results) expect(result).toEqual({ moved: result.moved, status: 1, busy: true, current: ORIGINAL });
  }, 60_000);

  it.skipIf(!launcher)('the pins do not undo the floor (ordering): sealed and hidden roots refuse direct writes, masks stay unreadable; HOME, project and docs stay writable', async () => {
    const f = await fixture();
    for (const command of [`printf X > '${join(f.project, '.deckent/mcp.json')}'`, `mkdir '${join(f.project, '.deckent/new')}'`, `printf X > '${join(f.global, 'mcp.json')}'`,
      `printf X > '${join(f.userRoot, 'mcp.json')}'`, `cat '${join(f.home, '.config/tool/id.pem')}'`, `cat '${join(f.project, 'a/b/.env')}'`, `cat '${join(f.project, '.deckent/docs/sub/.env')}'`,
      `printf X > '${join(f.project, 'a/b/.env')}'`]) {
      const outcome = await f.run(command);
      expect({ command, status: outcome.status, denied: /Read-only file system|Permission denied/u.test(outcome.output), leaked: outcome.output.includes(ORIGINAL) })
        .toEqual({ command, status: 1, denied: true, leaked: false });
    }
    for (const path of [join(f.project, '.deckent/mcp.json'), join(f.global, 'mcp.json'), join(f.userRoot, 'mcp.json'), join(f.project, 'a/b/.env')]) expect(await f.bytes(path)).toBe(ORIGINAL);
    // Hidden roots show nothing.
    const listed = await f.run(`ls -A '${f.global}' '${f.userRoot}'`);
    expect(listed.output).not.toContain('mcp.json');
    // Positives: HOME read/write, a project write, owner-Y docs write, and a rename of a directory holding no protected path.
    const positive = await f.run(`cat "$HOME/notes.txt" && echo h > "$HOME/new.txt" && echo s > '${join(f.project, 'src/b.ts')}' && echo d > '${join(f.project, '.deckent/docs/new.md')}'`
      + ` && mv '${join(f.project, 'src')}' '${join(f.project, 'src2')}' && echo POSITIVE_OK`);
    expect({ status: positive.status, ok: positive.output.includes('POSITIVE_OK') }).toEqual({ status: 0, ok: true });
    expect(await f.bytes(join(f.home, 'new.txt'))).toBe('h\n');
    expect(await f.bytes(join(f.project, '.deckent/docs/new.md'))).toBe('d\n');
    expect(await f.bytes(join(f.project, 'src2/b.ts'))).toBe('s\n');
  }, 60_000);
});
