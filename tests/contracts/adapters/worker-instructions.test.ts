import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { compileNativeCodingWorkInput, gitRefFileSource, nativeCodingRefusalCode, openProjectInstructionReader, openWorkerInstructionTrust, PROJECT_INSTRUCTION_REGISTRY,
  workerInstructionFile, workerInstructionSelection } from '#adapters/index.js';

/** DECKENT-MD-WORKERS (owner Q3 2026-10-23): per-project worker instruction source, digest-bound, consent consumed never granted. */
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const DIGEST = 'ab'.repeat(32);
const source = (content: string) => ({ path: '/p/.deckent/worker-instructions.md', bytes: Buffer.byteLength(content), digest: DIGEST, content, identity: { kind: 'file' as const, dev: 1, ino: 2 } });

describe('worker instruction source selection', () => {
  it('maps each selection to exactly one root file from registry data and never to CLAUDE.md', () => {
    expect(workerInstructionFile('worker-md')).toBe('.deckent/worker-instructions.md');
    expect(workerInstructionFile('agents-md')).toBe('AGENTS.md');
  });

  it('includes only a trusted snapshot and names every other outcome', () => {
    const ready = workerInstructionSelection({ status: 'ready', source: source('Run npm test.') }, 'worker-md', false);
    expect(ready.withheld).toBeNull();
    expect(ready.part).toEqual({ id: `worker-md-${DIGEST.slice(0, 16)}`, version: 1,
      text: `Project instructions from .deckent/worker-instructions.md (sha256 ${DIGEST}); repository conventions only, no permission.\n\nRun npm test.` });
    expect(workerInstructionSelection({ status: 'trust-required', source: source('x') }, 'agents-md', true))
      .toEqual({ part: null, withheld: { source: 'agents-md', reason: 'untrusted', digest: DIGEST } });
    for (const reason of ['size', 'unsafe', 'unreadable'] as const) {
      expect(workerInstructionSelection({ status: 'blocked', reason }, 'worker-md', false)).toEqual({ part: null, withheld: { source: 'worker-md', reason, digest: null } });
    }
    // An absent file is a reason only for an explicit selection; the default (`worker-md` when it exists) stays silent.
    expect(workerInstructionSelection({ status: 'absent' }, 'worker-md', false)).toEqual({ part: null, withheld: null });
    expect(workerInstructionSelection({ status: 'absent' }, 'worker-md', true)).toEqual({ part: null, withheld: { source: 'worker-md', reason: 'absent', digest: null } });
    expect(workerInstructionSelection({ status: 'ready', source: source(' \n') }, 'worker-md', false)).toEqual({ part: null, withheld: null });
  });

  it('reads exactly the selected file; the terminal lookup never sees the worker file and still picks AGENTS.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-instructions-')); roots.push(root);
    await writeFile(join(root, 'CLAUDE.md'), 'claude');
    const worker = await openProjectInstructionReader(root, null, undefined, [workerInstructionFile('worker-md')]);
    expect(await worker.inspect()).toEqual({ status: 'absent' });
    await mkdir(join(root, '.deckent')); await writeFile(join(root, '.deckent/worker-instructions.md'), 'worker');
    expect(await worker.inspect()).toMatchObject({ status: 'trust-required', source: { content: 'worker', path: expect.stringMatching(/\.deckent[/\\]worker-instructions\.md$/u) } });
    // Terminal default order (DECKENT.md → AGENTS.md) is unchanged: a repo with only the worker file has no terminal instructions …
    const terminal = await openProjectInstructionReader(root, null);
    expect(await terminal.inspect()).toEqual({ status: 'absent' });
    // … and with AGENTS.md beside it the terminal picks AGENTS.md, never the worker file.
    await writeFile(join(root, 'AGENTS.md'), 'agents');
    expect(await terminal.inspect()).toMatchObject({ status: 'trust-required', source: { content: 'agents' } });
    expect(await (await openProjectInstructionReader(root, null, undefined, [workerInstructionFile('agents-md')])).inspect()).toMatchObject({ source: { content: 'agents' } });
    await writeFile(join(root, 'DECKENT.md'), 'deckent');
    expect(await terminal.inspect()).toMatchObject({ source: { content: 'deckent' } });
    expect(await worker.inspect()).toMatchObject({ source: { content: 'worker' } }); // the worker selection never falls back
  });

  it('alpha.53 F1: a CLI trust persists or is refused (no session-only fallback); revoke removes exactly that folder+digest record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-instructions-')), home = await mkdtemp(join(tmpdir(), 'worker-home-')); roots.push(root, home);
    await chmod(home, 0o700); await mkdir(join(root, '.deckent')); await writeFile(join(root, '.deckent/worker-instructions.md'), 'conventions');
    const env = { HOME: home }, file = workerInstructionFile('worker-md');
    const first = await openWorkerInstructionTrust(root, env, undefined, file), view = await first.inspect();
    if (view.status !== 'trust-required') throw new Error(view.status);
    expect((await first.trust(view.source.digest)).status).toBe('ready');
    const second = await openWorkerInstructionTrust(root, env, undefined, file); // a fresh process sees the persisted record
    expect((await second.inspect()).status).toBe('ready');
    expect(await second.revoke(view.source.digest)).toBe(true);
    expect((await (await openWorkerInstructionTrust(root, env, undefined, file)).inspect()).status).toBe('trust-required');
    expect(await second.revoke(view.source.digest)).toBe(false); // already untrusted
    await expect(second.revoke('not-a-digest')).rejects.toThrow('unsafe');
    // A trust folder inside the workspace (here: HOME is the project) is never used for a CLI trust: refused, not session-only.
    await expect(openWorkerInstructionTrust(root, { HOME: root }, undefined, file)).rejects.toThrow();
  });

  it('REVISE 2734 R1: given the file the card showed, trust and revoke act only while the read just before the write is that file (path, identity, digest)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-instructions-')), home = await mkdtemp(join(tmpdir(), 'worker-home-')); roots.push(root, home);
    await chmod(home, 0o700); await mkdir(join(root, '.deckent')); const path = join(root, '.deckent/worker-instructions.md'); await writeFile(path, 'conventions');
    const env = { HOME: home }, file = workerInstructionFile('worker-md'), fresh = async () => (await (await openWorkerInstructionTrust(root, env, undefined, file)).inspect()).status;
    const reader = await openWorkerInstructionTrust(root, env, undefined, file), view = await reader.inspect();
    if (view.status !== 'trust-required') throw new Error(view.status);
    const identity = async () => { const info = await stat(path); return { path: view.source.path, dev: info.dev, ino: info.ino }; }, shown = await identity();
    await writeFile(join(root, '.deckent/replacement.md'), 'conventions'); await rename(join(root, '.deckent/replacement.md'), path); // identical bytes, new inode
    await expect(reader.trust(view.source.digest, shown)).rejects.toThrow('changed');
    expect(await fresh()).toBe('trust-required'); // nothing written
    const current = await identity();
    expect((await reader.trust(view.source.digest, current)).status).toBe('ready');
    await expect(reader.revoke(view.source.digest, shown)).rejects.toThrow('changed');
    await expect(reader.revoke('cd'.repeat(32), current)).rejects.toThrow('changed'); // not the content read now
    expect(await fresh()).toBe('ready'); // the record stays
    expect(await reader.revoke(view.source.digest, current)).toBe(true);
    expect(await fresh()).toBe('trust-required');
  });

  it('refuses a worker file reached through a symlinked directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-instructions-')), outside = await mkdtemp(join(tmpdir(), 'worker-outside-')); roots.push(root, outside);
    await writeFile(join(outside, 'worker-instructions.md'), 'planted'); await symlink(outside, join(root, '.deckent'));
    expect(await (await openProjectInstructionReader(root, null, undefined, [workerInstructionFile('worker-md')])).inspect()).toEqual({ status: 'blocked', reason: 'unsafe' });
  });
});

/** alpha.54 R1 (owner Q5 2026-10-23): with a work target, workers read the file committed on its base ref, never the working tree. */
describe.skipIf(process.platform === 'win32')('worker instruction file read from the work target ref', () => {
  const exec = promisify(execFile), GIT = { gitExecutable: '/usr/bin/git', timeoutMs: 10_000, outputBytes: 65_536 }, REF = 'refs/heads/main', FILE = '.deckent/worker-instructions.md';
  const git = async (root: string, ...args: string[]) => (await exec('/usr/bin/git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args])).stdout.trim();
  async function repository(files: Record<string, string> = { [FILE]: 'committed' }) {
    const root = await mkdtemp(join(tmpdir(), 'worker-ref-')); roots.push(root);
    await git(root, 'init', '-q', '-b', 'main');
    for (const [name, text] of Object.entries(files)) { await mkdir(join(root, name, '..'), { recursive: true }); await writeFile(join(root, name), text); }
    await git(root, 'add', '-A'); await git(root, 'commit', '-q', '--allow-empty', '-m', 'base');
    return root;
  }
  const commit = async (root: string, message = 'next') => { await git(root, 'add', '-A'); await git(root, 'commit', '-q', '--allow-empty', '-m', message); return git(root, 'rev-parse', REF); };
  const committed = (root: string, ref = REF) => gitRefFileSource(GIT, root, ref, () => git(root, 'rev-parse', '--verify', `${ref}^{commit}`));
  const reader = (root: string, trust: string | null = null, file = FILE, ref = REF) => openProjectInstructionReader(root, trust, undefined, [file], committed(root, ref));

  it('reads the ref content: a modified, uncommitted or detached working tree is never what workers get', async () => {
    const root = await repository(), head = await git(root, 'rev-parse', REF);
    await writeFile(join(root, FILE), 'dirty, not committed');
    const view = await (await reader(root)).inspect();
    expect(view).toMatchObject({ status: 'trust-required', source: { content: 'committed', bytes: 9, path: `${REF}:${FILE}`,
      identity: { kind: 'ref', ref: REF, commit: head, blobOid: await git(root, 'rev-parse', `${REF}:${FILE}`) } } });
    // A detached HEAD with other committed bytes: the configured ref still wins.
    await git(root, 'checkout', '-q', '--detach'); await writeFile(join(root, FILE), 'detached'); await commit(root);
    expect(await git(root, 'rev-parse', REF)).toBe(head);
    expect(await (await reader(root)).inspect()).toMatchObject({ source: { content: 'committed', identity: { commit: head } } });
    // Present in the working tree but not committed on the ref: absent.
    const fresh = await repository({ 'note.txt': 'x' }); await mkdir(join(fresh, '.deckent')); await writeFile(join(fresh, FILE), 'untracked');
    expect(await (await reader(fresh)).inspect()).toEqual({ status: 'absent' });
    // A ref that names no commit is unreadable, never absent.
    expect(await (await reader(root, null, FILE, 'refs/heads/missing')).inspect()).toEqual({ status: 'blocked', reason: 'unreadable' });
  });

  it('refuses a symlink, submodule or file .deckent and a non-regular entry at the ref; the size comes from the tree before any read', async () => {
    const outside = await repository({ 'worker-instructions.md': 'planted' });
    const linked = await repository({ 'note.txt': 'x' }); await symlink(outside, join(linked, '.deckent')); await commit(linked);
    const plain = await repository({ '.deckent': 'a file' });
    const sub = await repository({ 'note.txt': 'x' });
    await git(sub, 'update-index', '--add', '--cacheinfo', `160000,${await git(outside, 'rev-parse', 'HEAD')},.deckent`); await git(sub, 'commit', '-q', '-m', 'gitlink');
    const fileLink = await repository({ '.deckent/target.md': 'x' }); await symlink('target.md', join(fileLink, FILE)); await commit(fileLink);
    const tree = await repository({ 'AGENTS.md/inner.md': 'x' });
    for (const [root, file] of [[linked, FILE], [plain, FILE], [sub, FILE], [fileLink, FILE], [tree, 'AGENTS.md']] as const) {
      expect(await (await reader(root, null, file)).inspect(), `${root} ${file}`).toEqual({ status: 'blocked', reason: 'unsafe' });
    }
    const large = await repository({ [FILE]: 'x'.repeat(PROJECT_INSTRUCTION_REGISTRY.maxBytes + 1) });
    expect(await (await reader(large)).inspect()).toEqual({ status: 'blocked', reason: 'size' });
    expect(await (await reader(await repository({ 'AGENTS.md': 'agents' }), null, 'AGENTS.md')).inspect()).toMatchObject({ source: { content: 'agents', path: `${REF}:AGENTS.md` } });
  });

  it('REVISE 2738 R1 (owner Q5): a new trust binds ref + content; another ref or the folder with the same bytes needs its own trust; revokes stay per ref', async () => {
    const root = await repository(), home = await mkdtemp(join(tmpdir(), 'worker-home-')); roots.push(home); await chmod(home, 0o700);
    const env = { HOME: home }, OTHER = 'refs/heads/other'; await git(root, 'branch', 'other');
    const open = (ref: string | null) => openWorkerInstructionTrust(root, env, undefined, FILE, ref === null ? undefined : committed(root, ref));
    const fresh = async (ref: string | null) => (await (await open(ref)).inspect()).status; // a new process: only the persisted records count
    const atA = await open(REF), shown = await atA.inspect();
    if (shown.status !== 'trust-required') throw new Error(shown.status);
    const digest = shown.source.digest;
    expect((await atA.trust(digest)).status).toBe('ready');
    expect([await fresh(REF), await fresh(OTHER), await fresh(null)]).toEqual(['ready', 'trust-required', 'trust-required']);
    const atB = await open(OTHER);
    expect((await atB.trust(digest)).status).toBe('ready');
    expect(await atA.revoke(digest)).toBe(true); // A's record only
    expect([await fresh(REF), await fresh(OTHER)]).toEqual(['trust-required', 'ready']);
    expect((await atA.trust(digest)).status).toBe('ready');
    expect(await atB.revoke(digest)).toBe(true); // and the other way round
    expect([await fresh(REF), await fresh(OTHER)]).toEqual(['ready', 'trust-required']);
    // The same ref advancing with the same bytes stays trusted; other bytes on it need a new trust.
    await writeFile(join(root, 'other.txt'), 'unrelated'); const advanced = await commit(root);
    expect(await (await open(REF)).inspect()).toMatchObject({ status: 'ready', source: { digest, identity: { kind: 'ref', ref: REF, commit: advanced } } });
    await writeFile(join(root, FILE), 'changed on the branch'); await commit(root);
    expect(await (await open(REF)).inspect()).toMatchObject({ status: 'trust-required', source: { content: 'changed on the branch' } });
  });

  it('legacy rule: the alpha.53 folder + content record (exact bytes) is still honoured at a ref of that folder; a ref trust never writes it; a ref revoke removes it', async () => {
    const root = await repository(), trust = await mkdtemp(join(tmpdir(), 'worker-trust-')); roots.push(trust); await chmod(trust, 0o700);
    const open = (ref: string | null) => openProjectInstructionReader(root, trust, undefined, [FILE], ref === null ? undefined : committed(root, ref));
    const digest = createHash('sha256').update('committed').digest('hex'), real = await realpath(root), info = await stat(real);
    const folder = createHash('sha256').update(`${real}\0${info.dev}\0${info.ino}`).digest('hex');
    const legacyName = createHash('sha256').update(`${folder}\0${digest}`).digest('hex');
    // A ref trust in an empty store writes its own record, never the alpha.53 form.
    expect((await (await open(REF)).trust(digest)).status).toBe('ready');
    expect(await readdir(trust)).not.toContain(legacyName);
    expect(await (await open(REF)).revoke(digest)).toBe(true);
    expect(await readdir(trust)).toEqual([]);
    // The record alpha.53 wrote (N1): sha256(sha256(real root \0 dev \0 ino) \0 digest), content = the digest, mode 0600.
    await writeFile(join(trust, legacyName), digest, { mode: 0o600 });
    expect(await (await open(REF)).inspect()).toMatchObject({ status: 'ready', source: { digest, identity: { kind: 'ref' } } });
    expect(await (await open(null)).inspect()).toMatchObject({ status: 'ready' }); // the working tree (no target) reads it as before
    await writeFile(join(root, 'other.txt'), 'unrelated'); await commit(root);
    expect((await (await open(REF)).inspect()).status).toBe('ready');
    // A revoke at the ref takes that consent back too: a sealed revoke never leaves the card trusted.
    expect(await (await open(REF)).revoke(digest)).toBe(true);
    expect([(await (await open(REF)).inspect()).status, (await (await open(null)).inspect()).status, await readdir(trust)]).toEqual(['trust-required', 'trust-required', []]);
  });
});

describe('native prompt composition with an admitted instruction part', () => {
  const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
    deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
  const template = (context: object[] = []) => ({ id: 'coding', version: 1, adapter: { id: 'native-coding-template', version: 1 }, parameters: { schemaVersion: 1, docker,
    invocation: { provider: 'claude', cliVersion: '2.1.293 (Claude Code)', discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended',
      composition: { context } } } });
  const input = { schemaVersion: 1, task: 'Append done.', scope: { paths: ['note.txt'] }, acceptance: 'note.txt ends with done.',
    model: { channelId: 'claude', modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] } };
  const part = (text: string, id = 'worker-md-0123456789abcdef') => ({ id, version: 1, text });
  const delivery = (profile: { parameters: Record<string, unknown> }) => (profile.parameters['nativeSubscription'] as { promptDelivery: { task: string; segments: { kind: string; id: string }[] } }).promptDelivery;
  const refusal = (fn: () => unknown) => { try { fn(); } catch (error) { return nativeCodingRefusalCode(error); } return null; };

  it('appends the part after the template context and pins it in the compiled prompt', () => {
    const compiled = compileNativeCodingWorkInput(template([part('Use npm scripts.', 'repo-tooling')]) as never, input, undefined, undefined, [part('Conventions.')]);
    const prompt = delivery(compiled);
    expect(prompt.segments.filter(s => s.kind === 'context').map(s => s.id)).toEqual(['repo-tooling', 'worker-md-0123456789abcdef']);
    expect(prompt.task).toContain('### context:worker-md-0123456789abcdef@1\nConventions.');
    // No part: byte-identical to the compilation before this slice.
    expect(JSON.stringify(compileNativeCodingWorkInput(template() as never, input, undefined, undefined, []))).toBe(JSON.stringify(compileNativeCodingWorkInput(template() as never, input)));
  });

  it('refuses a snapshot that does not fit the prompt budget with a typed code, never a generic invalid profile', () => {
    expect(refusal(() => compileNativeCodingWorkInput(template() as never, input, undefined, undefined, [part('x'.repeat(16_385))]))).toBe('WORKER_INSTRUCTIONS_TOO_LARGE');
    const full = Array.from({ length: 8 }, (_, i) => part('ctx', `ctx-${i}`));
    expect(refusal(() => compileNativeCodingWorkInput(template(full) as never, input, undefined, undefined, [part('fits')]))).toBe('WORKER_INSTRUCTIONS_TOO_LARGE');
    const large = [part('y'.repeat(16_384), 'big-1')];
    expect(refusal(() => compileNativeCodingWorkInput(template(large) as never, input, undefined, undefined, [part('z'.repeat(16_384))]))).toBe('WORKER_INSTRUCTIONS_TOO_LARGE');
    // A template that is itself invalid stays the existing generic refusal.
    expect(refusal(() => compileNativeCodingWorkInput(template([part('x'.repeat(16_385), 'bad')]) as never, input, undefined, undefined, [part('fits')]))).toBe('EXECUTION_PROFILE_INVALID');
    expect(refusal(() => compileNativeCodingWorkInput(template() as never, input, undefined, undefined, [part('fits')]))).toBeNull();
  });
});
