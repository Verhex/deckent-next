import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitWorkspaceLease, GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { GIT_LOCAL_ENV, listBase, localGitArgs, SnapshotBudget } from '#adapters/core/git-patch/index.js';

const exec = promisify(execFile); const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const limits = { maxBytes: 64 * 1024 * 1024, maxEntries: 10000, maxDepth: 32, maxPathBytes: 1024 };

describe('local Git invocation construction (lane GIT-NET 2026-09-29)', () => {
  it('denies every Git protocol transport and carries no ambient environment', () => {
    const args = localGitArgs('/repo', ['rev-parse', 'HEAD']);
    expect(args).toEqual(['--no-replace-objects', '-C', '/repo', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', 'rev-parse', 'HEAD']);
    expect(GIT_LOCAL_ENV).toEqual({
      PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
    });
  });
});

/** A partial clone with a promisor remote reachable only over `file://`: the realistic shape of the risk the
 * audit named (DEPENDENCY-AUDIT-2026-09-29/B-platform.md §3.1) — a source repository whose own local config
 * can make a normally read-only Git command reach a remote to satisfy a missing object. `file://` is used
 * instead of a real network remote so the test needs no network access while still exercising the same
 * protocol-allow-list code path a real network transport would use (git-config(1) `protocol.<name>.allow`
 * documents `file` as governing "any local file-based path (including file:// URLs, or local paths)"). */
async function promisorSource(options: { hostileLocalConfig?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deckent-git-network-'))); roots.push(root);
  const origin = join(root, 'origin'); const source = join(root, 'source');
  const git = async (cwd: string, ...args: string[]) => (await exec('/usr/bin/git', ['-C', cwd, ...args])).stdout.trim();
  await mkdir(origin); await git(origin, 'init', '-q');
  await git(origin, 'config', 'user.email', 't@example.invalid'); await git(origin, 'config', 'user.name', 'T');
  await writeFile(join(origin, 'big.txt'), 'X'.repeat(5000) + '\n');
  await git(origin, 'add', 'big.txt'); await git(origin, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  await git(origin, 'config', 'uploadpack.allowFilter', 'true');
  const head = await git(origin, 'rev-parse', 'HEAD');
  // --no-checkout: the working-tree checkout a plain `clone --filter` performs would itself fetch the blob
  // (under the clone's own unrestricted environment) before this test ever runs its own restricted call.
  await exec('/usr/bin/git', ['clone', '--filter=blob:none', '--no-checkout', `file://${origin}`, source, '-q']);
  // The residual case (Astra/lead follow-up 2026-09-29): a hostile or merely misconfigured source repository
  // sets this in its own LOCAL .git/config — not system/global, so GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL do
  // not suppress it — to re-permit the more specific `protocol.file.allow` ahead of a bare `protocol.allow=never`.
  if (options.hostileLocalConfig) await git(source, 'config', 'protocol.file.allow', 'always');
  const blob = await git(source, 'rev-parse', `${head}:big.txt`);
  return { root, origin, source, head, blob, git };
}

describe.skipIf(process.platform !== 'linux')('local-only Git invocation cannot reach a remote (lane GIT-NET 2026-09-29)', () => {
  it('reports a locally missing blob size as unavailable and does not recreate the object', async () => {
    const f = await promisorSource();
    // A regular source with a missing loose blob reaches ls-tree's successful BAD-size
    // output even on Git 2.43, independently of the version's promisor-fetch behavior.
    await rm(join(f.origin, '.git', 'objects', f.blob.slice(0, 2), f.blob.slice(2)));
    const raw = await exec('/usr/bin/git', localGitArgs(f.origin, ['ls-tree', '-r', '-z', '-l', '--full-tree', f.head]), { env: GIT_LOCAL_ENV });
    expect(raw.stdout).toBe(`100644 blob ${f.blob}     BAD\tbig.txt\0`);
    const lease = { baseCommit: f.head, sourceBase: { source: { repositoryRoot: f.origin } } } as unknown as GitWorkspaceLease;
    const options = { gitExecutable: '/usr/bin/git', outputBytes: 65536 } as GitWorkspaceOptions;
    await expect(listBase(lease, options, new SnapshotBudget(limits, Date.now() + 10_000))).rejects.toMatchObject({ code: 'PATCH_UNAVAILABLE' });
    expect(await f.git(f.origin, 'rev-list', '--objects', '--all', '--missing=print', f.head)).toContain(`?${f.blob}`);
  });

  it('refuses a promisor lazy fetch over file:// and leaves the object unfetched', async () => {
    const f = await promisorSource();
    expect(await f.git(f.source, 'rev-list', '--objects', '--all', '--missing=print', f.head)).toContain(`?${f.blob}`);
    const lease = { baseCommit: f.head, sourceBase: { source: { repositoryRoot: f.source } } } as unknown as GitWorkspaceLease;
    const options = { gitExecutable: '/usr/bin/git', timeoutMs: 10_000, outputBytes: 65536, sourceRoot: f.source, workspaceRoot: f.source } as unknown as GitWorkspaceOptions;
    const budget = new SnapshotBudget(limits, Date.now() + 10_000);
    // ls-tree -l needs the blob's size; on a promisor-missing object this is exactly the Git operation the
    // audit flagged as able to trigger a network fetch during snapshot/observe.
    await expect(listBase(lease, options, budget)).rejects.toMatchObject({ code: 'PATCH_UNAVAILABLE' });
    // The object was never fetched: `rev-list --missing=print` still reports it missing after the attempt.
    expect(await f.git(f.source, 'rev-list', '--objects', '--all', '--missing=print', f.head)).toContain(`?${f.blob}`);
  });

  it('stays refused when the source repository\'s own local config re-permits the file protocol', async () => {
    const f = await promisorSource({ hostileLocalConfig: true });
    expect(await f.git(f.source, 'config', 'protocol.file.allow')).toBe('always');
    const lease = { baseCommit: f.head, sourceBase: { source: { repositoryRoot: f.source } } } as unknown as GitWorkspaceLease;
    const options = { gitExecutable: '/usr/bin/git', timeoutMs: 10_000, outputBytes: 65536, sourceRoot: f.source, workspaceRoot: f.source } as unknown as GitWorkspaceOptions;
    const budget = new SnapshotBudget(limits, Date.now() + 10_000);
    // Measured 2026-09-29 (proof/GIT-NET-2026-09-29/protocol-matrix.log): `-c protocol.allow=never` alone is
    // overridden by this exact repository-local setting (protocol.<name>.allow takes precedence over the
    // generic protocol.allow regardless of source). GIT_ALLOW_PROTOCOL='' is an environment variable the
    // repository cannot override, and is documented to override any existing configuration instead — this is
    // the layer that must hold here.
    await expect(listBase(lease, options, budget)).rejects.toMatchObject({ code: 'PATCH_UNAVAILABLE' });
    expect(await f.git(f.source, 'rev-list', '--objects', '--all', '--missing=print', f.head)).toContain(`?${f.blob}`);
  });
});
