import { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScratchActivity, createShellPathContext, createShellWriteContext, createWorkspaceScope, ensureScratchDirectories, openScratchSession,
  scratchSessionKey, scratchUsage, sweepScratch } from '#adapters/index.js';
import { classifyReadOnlyShellCommand, classifyShellMutation, classifyShellRisk, EffectTargetError, shellPermissionTier } from '#engine/index.js';

// SCR-A at the adapter boundary: the scratch area's directories, quota and retention, and the shell's second root, on real files.
const bases: string[] = [];
afterEach(async () => Promise.all(bases.splice(0).map(base => rm(base, { recursive: true, force: true }))));
const DAY_MS = 86_400_000;
const limits = { writeMaxBytes: 1_024, sessionMaxBytes: 2_048, installationMaxBytes: 8_192, retentionDays: 7, sweepIntervalMs: 60_000 };
async function area(sessionId = 's1') {
  const base = await mkdtemp(join(tmpdir(), 'dn-scratch-')); bases.push(base);
  const root = join(base, 'scratch'), outside = join(base, 'outside'), project = join(base, 'project');
  await Promise.all([mkdir(root, { mode: 0o700 }), mkdir(outside), mkdir(join(project, 'src'), { recursive: true })]);
  await writeFile(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  const key = scratchSessionKey({ scopeId: 'scope', principal: { issuer: 'host', subject: '1000' }, sessionId });
  const session = await openScratchSession(root, key, limits, createScratchActivity());
  return { base, root, outside, project, key, session, journal: join(base, 'journal') };
}
const write = (key: string, path: string, content: string, commandId = 'c'.repeat(64)) => ({ target: { kind: 'scratch-file', id: `${key}/${path}` },
  operation: { id: 'workspace.scratch.write', version: 1 }, idempotencyKey: commandId, expectedVersion: 'absent', input: { content } });
const age = async (path: string, atMs: number) => {
  const when = new Date(atMs);
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) await utimes(join(entry.parentPath, entry.name), when, when);
  await utimes(path, when, when);
};

describe.skipIf(process.platform !== 'linux')('scratch store (SCR-A)', () => {
  it('opens the area 0700 under owner and session digests, and keys never carry identity text', async () => {
    const f = await area();
    expect(f.key).toMatch(/^[0-9a-f]{32}\/[0-9a-f]{32}$/u);
    for (const dir of [join(f.root, f.key.split('/')[0]!), f.session.dir]) expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(scratchSessionKey({ scopeId: 'scope', principal: { issuer: 'host', subject: '1001' }, sessionId: 's1' }).split('/')[0]).not.toBe(f.key.split('/')[0]);
    expect(scratchSessionKey({ scopeId: 'scope', principal: { issuer: 'host', subject: '1000' }, turnId: 't1' }).split('/')[1]).not.toBe(f.key.split('/')[1]);
  });

  it('never creates a directory through a link: a link placed after planning is refused at the effect and nothing is written outside', async () => {
    const f = await area();
    const planned = await f.session.writes.plan('scratch_write', { path: 'sub/x.txt', content: 'x\n' });
    expect(planned).toMatchObject({ ok: true, rel: 'sub/x.txt', beforeVersion: 'absent' });
    await symlink(f.outside, join(f.session.dir, 'sub'));
    const target = f.session.writes.target(f.journal);
    await expect(target.apply(write(f.key, 'sub/x.txt', 'x\n'))).rejects.toBeInstanceOf(EffectTargetError);
    expect(await readdir(f.outside)).toEqual([]);
    await expect(ensureScratchDirectories(f.session.dir, ['sub', 'deeper'])).rejects.toMatchObject({ code: 'SCRATCH_UNSAFE' });
    await expect(target.apply({ ...write(f.key, 'x.txt', 'x\n'), target: { kind: 'scratch-file', id: `${'0'.repeat(32)}/${'1'.repeat(32)}/x.txt` } }))
      .rejects.toBeInstanceOf(EffectTargetError);
  });

  it('checks the quota again at the effect: a write that fitted when planned is refused once the area filled meanwhile', async () => {
    const f = await area();
    expect(await f.session.writes.plan('scratch_write', { path: 'late.txt', content: 'y'.repeat(900) })).toMatchObject({ ok: true });
    await writeFile(join(f.session.dir, 'filler.bin'), Buffer.alloc(1_500, 1));
    const refused = await f.session.writes.target(f.journal).apply(write(f.key, 'late.txt', 'y'.repeat(900))).catch(error => error as EffectTargetError);
    expect(refused).toBeInstanceOf(EffectTargetError);
    expect((refused as EffectTargetError).cause).toMatchObject({ code: 'SCRATCH_QUOTA_EXCEEDED', message: expect.stringContaining('session: 1500 + 900 > 2048') });
    await expect(lstat(join(f.session.dir, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    // A write within the quota goes through and is created 0600.
    await f.session.writes.target(f.journal).apply(write(f.key, 'ok.txt', 'z\n', 'd'.repeat(64)));
    expect((await stat(join(f.session.dir, 'ok.txt'))).mode & 0o777).toBe(0o600);
  });

  it('measures usage without following links', async () => {
    const f = await area();
    await writeFile(join(f.outside, 'big.bin'), Buffer.alloc(5_000, 1)); await symlink(f.outside, join(f.session.dir, 'link'));
    await writeFile(join(f.session.dir, 'own.txt'), 'abc');
    expect(await scratchUsage(f.session.dir)).toBe(3); expect(await scratchUsage(join(f.base, 'missing'))).toBe(0);
  });

  it('sweeps areas unused past retention, never one a running turn holds, and removes it once released', async () => {
    const f = await area();
    await writeFile(join(f.session.dir, 'old.txt'), 'old'); await age(f.session.dir, Date.now() - 8 * DAY_MS);
    const activity = createScratchActivity(), release = await activity.hold(f.key), again = await activity.hold(f.key);
    expect(await sweepScratch(f.root, limits, Date.now(), activity)).toEqual({ removedSessions: 0, removedBytes: 0, kept: 1, unreadable: 0 });
    expect(await readdir(f.session.dir)).toEqual(['old.txt']);
    release(); release();
    expect(await sweepScratch(f.root, limits, Date.now(), activity)).toMatchObject({ removedSessions: 0, kept: 1 });
    again();
    expect(await sweepScratch(f.root, limits, Date.now(), activity)).toEqual({ removedSessions: 1, removedBytes: 3, kept: 0, unreadable: 0 });
    await expect(lstat(f.session.dir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(f.root, f.key.split('/')[0]!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('takes the area as a second shell root: an absolute scratch path reads without asking and a copy into it is narrow; nothing else changes', async () => {
    const f = await area();
    await writeFile(join(f.session.dir, 'n.txt'), 'n\n');
    const project = await createWorkspaceScope(f.project);
    const classify = async (command: string, roots: readonly (typeof project)[]) => {
      const paths = createShellPathContext(project, undefined, roots);
      const readOnly = await classifyReadOnlyShellCommand(command, paths);
      const mutation = readOnly.readOnly ? { tier: 'unrecognized' as const, reasonCode: 'NOT_NARROW' as const }
        : await classifyShellMutation(command, paths, createShellWriteContext(project, roots));
      return shellPermissionTier(classifyShellRisk(command, readOnly), readOnly, mutation);
    };
    const roots = [f.session.scope];
    expect(await classify(`cat ${f.session.dir}/n.txt`, roots)).toBe('read-none');
    expect(await classify(`cat ${f.session.dir}/n.txt`, [])).not.toBe('read-none');
    expect(await classify(`cp src/a.ts ${f.session.dir}/copy.ts`, roots)).toBe('narrow-mutating');
    expect(await classify(`cp src/a.ts ${f.session.dir}/copy.ts`, [])).not.toBe('narrow-mutating');
    // Leaving the area lexically or through a link is outside, as for the project.
    await symlink(f.outside, join(f.session.dir, 'out'));
    for (const command of [`cat ${f.session.dir}/../x`, `cat ${f.session.dir}/out/secret`, `cp src/a.ts ${f.session.dir}/out/x`]) {
      expect(await classify(command, roots)).not.toMatch(/^(read-none|narrow-mutating)$/u);
    }
    // Project paths classify exactly as before.
    expect(await classify('cat src/a.ts', roots)).toBe(await classify('cat src/a.ts', []));
  });
});
