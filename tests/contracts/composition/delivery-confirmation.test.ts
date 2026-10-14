import { verifiedDeliveryConfirmation } from '#composition/core/workspace-patch/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitIntegrationTarget, fingerprintGitSource } from '#adapters/index.js';
import { integrationManifestSchema, integrationDeliveryCommandSchema, integrationAdoptionCommandSchema, patchDigest, patchExclusions, patchFile, workspacePatchSchema } from '#engine/index.js';
import { terminalProgram } from '../support/approval-terminal.js';
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-delivery-confirm-')); roots.push(root);
  const sourceRoot = join(root, 'source'), workspaceRoot = join(root, 'workspaces');
  await mkdir(sourceRoot, { mode: 0o700 }); await mkdir(workspaceRoot, { mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', sourceRoot, ...args])).stdout.trim();
  await git('init', '-q'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(sourceRoot, 'note.txt'), 'before\n'); await git('add', '.'); await git('commit', '-qm', 'base');
  const base = await git('rev-parse', 'HEAD'), target = 'refs/heads/adopted'; await git('branch', 'adopted', base);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 };
  const options = { sourceRoot, workspaceRoot, gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 };
  const limits = { maxBytes: 65536, maxEntries: 100, maxDepth: 10, maxPathBytes: 256 };
  const patch = workspacePatchSchema.parse({ schemaVersion: 1, kind: 'workspace-patch', identity,
    source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: fingerprintGitSource({ schemaVersion: 1, sourceRoot, repositoryRoot: sourceRoot }) },
    baseCommit: base, snapshotDigest: patchDigest('fixture'), exclusions: patchExclusions,
    changes: [{ path: 'note.txt', before: patchFile(Buffer.from('before\n'), '100644'), after: patchFile(Buffer.from('after\n'), '100644') }] });
  const receipt = { schemaVersion: 1 as const, scopeId: 's', digest: patchDigest(JSON.stringify(patch)), byteLength: Buffer.byteLength(JSON.stringify(patch)) };
  const candidate = new GitIntegrationTarget(options, limits);
  const manifest = integrationManifestSchema.parse(await candidate.prepare({ schemaVersion: 1,
    command: { schemaVersion: 1, commandId: 'candidate', identity, proposal: '0'.repeat(20) }, patch: receipt,
    observation: (await candidate.observe(patch)).digest, actor: { id: 'owner', issuer: 'test', subject: 'owner' } }, patch));
  const time = Date.parse('2026-10-14T10:20:30Z');
  await writeFile(join(root, 'input.json'), JSON.stringify({ options, limits, patch, receipt, manifest, target, time,
    command: { schemaVersion: 1, commandId: 'delivery', identity, integrationCommandId: 'candidate' },
    run: { revision: 7, graph: { tasks: [{ id: 't', acceptanceCriteria: ['exit'], workInput: { title: 'Ship useful change' } }] },
      progress: [{ taskId: 't', phase: 'accepted' }], bindings: [{ identity: patch.identity }] } }));
  // The child runs the compiled engine (same path on Node 24 and 26); source-type flags differ between majors.
  await access(resolve('dist/composition/core/workspace-patch/index.js')).catch(() => { throw new Error('BUILD_REQUIRED: run npm run build before this process proof'); });
  const refs = async () => JSON.stringify({ refs: await git('for-each-ref', '--format=%(refname) %(objectname)'), objects: await git('count-objects', '-v') });
  const execute = async (mode = 'deliver', answer = 'y', tty = 'tty') => {
    const result = await terminalProgram([process.execPath, resolve('tests/fixtures/delivery-confirmation-application.mjs'), root, mode], {}, root, tty, answer);
    const line = result.output.split(/\r?\n/u).find(line => line.startsWith('{"response":'));
    if (!line) throw new Error(result.output);
    return { ...JSON.parse(line).response, output: result.output };
  };
  return { root, git, base, target, execute, refs, time, sourceRoot };
}
describe.skipIf(process.platform !== 'linux')('delivery/adoption verified human confirmation — real controlling PTY, Git and engine', () => {
  it.each(['piped-input', 'redirected-output'])('refuses %s without a delivery intent or reference', async tty => {
    const f = await fixture(), before = await f.refs();
    expect(await f.execute('deliver', 'y', tty)).toMatchObject({ ok: false, error: { code: 'DELIVERY_INTERACTIVE_REQUIRED' } });
    expect(await f.refs()).toBe(before); await expect(readFile(join(f.root, 'delivery.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('declines silence at the configured bounded wait without writing a reference', async () => {
    const f = await fixture(), before = await f.refs();
    expect(await f.execute('timeout', '')).toMatchObject({ ok: false, error: { code: 'DELIVERY_CONFIRMATION_DECLINED' } });
    expect(await f.refs()).toBe(before);
  });
  it.each(['n', 'EOF', 'yes', ' '])('refuses %s after showing the exact card and keeps refs untouched', async answer => {
    const f = await fixture(), before = await f.refs(), result = await f.execute('deliver', answer);
    expect(result).toMatchObject({ ok: false, error: { code: 'DELIVERY_CONFIRMATION_DECLINED' } });
    expect(result.output).toContain('Ship useful change'); expect(result.output).toContain('note.txt'); expect(result.output).toContain(f.base);
    expect(await f.refs()).toBe(before); await expect(readFile(join(f.root, 'delivery.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('cannot carry a forged confirmation through either typed command input', async () => {
    const f = await fixture(), data = JSON.parse(await readFile(join(f.root, 'input.json'), 'utf8'));
    expect(integrationDeliveryCommandSchema.safeParse({ ...data.command, confirmed: true }).success).toBe(false);
    expect(integrationAdoptionCommandSchema.safeParse({ schemaVersion: 2, commandId: 'adopt', identity: data.patch.identity, deliveryCommandId: 'delivery', targetRef: f.target, confirmed: true }).success).toBe(false);
  });
  it.each(['deliver-sdk', 'deliver-mcp'])('prevents %s even inside a verified terminal', async mode => {
    const f = await fixture(), before = await f.refs();
    expect(await f.execute(mode)).toMatchObject({ ok: false, error: { code: 'DELIVERY_INTERACTIVE_REQUIRED' } });
    expect(await f.refs()).toBe(before);
  });
  it('approves the displayed card then delivers once with meaningful title/ids/acceptance and trusted time; SDK replay does not ask', async () => {
    const f = await fixture(), before = await f.git('status', '--porcelain');
    const result = await f.execute(); expect(result.ok, result.output).toBe(true);
    const { commit, ref } = result.result.plan;
    expect(await f.git('rev-parse', ref)).toBe(commit); expect(await f.git('rev-parse', 'HEAD')).toBe(f.base);
    expect(await f.git('status', '--porcelain')).toBe(before);
    expect(await f.git('show', '-s', '--format=%B', commit)).toBe('Ship useful change\n\nRun: r\nTask: t\nAcceptance: Task accepted; criteria 1; run revision 7');
    expect(await f.git('show', '-s', '--format=%an <%ae>|%at|%ct', commit)).toBe(`Deckent <delivery@deckent.invalid>|${f.time / 1000}|${f.time / 1000}`);
    const replay = await f.execute('deliver-sdk', '', 'piped-input'); expect(replay.ok).toBe(true); expect(replay.result).toEqual(result.result);
    expect(replay.output).not.toContain('y/N: ');
  });
  it('redacts the full admitted title before bounding; omits worker free text and retains configured author identity', async () => {
    const f = await fixture(), path = join(f.root, 'input.json'), data = JSON.parse(await readFile(path, 'utf8'));
    data.run.graph.tasks[0].workInput.title = 'Useful change fixture-private-title-secret' + 'x'.repeat(300);
    data.options.deliveryIdentity = { authorName: 'Configured author', authorEmail: 'delivery@example.invalid' };
    await writeFile(path, JSON.stringify(data));
    const result = await f.execute(); expect(result.ok, result.output).toBe(true);
    const message = await f.git('show', '-s', '--format=%B', result.result.plan.commit);
    expect(message).not.toContain('fixture-private-title-secret'); expect(result.output).not.toContain('fixture-private-title-secret');
    expect(message.split('\n')[0]!.length).toBeLessThanOrEqual(256);
    expect(await f.git('show', '-s', '--format=%an <%ae>', result.result.plan.commit)).toBe('Configured author <delivery@example.invalid>');
  });
  it.each(['deliver-revoke', 'adopt-revoke'])('rechecks policy after approving %s and writes no new intent', async mode => {
    const f = await fixture(); if (mode.startsWith('adopt')) expect((await f.execute()).ok).toBe(true);
    const before = await f.refs();
    expect(await f.execute(mode)).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
    expect(await f.refs()).toBe(before);
    await expect(readFile(join(f.root, mode.startsWith('adopt') ? 'adoption.json' : 'delivery.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires fresh consent for an unpublished intent but settles an already-published crash without another answer', async () => {
    const f = await fixture(), delivered = await f.execute(); const record = JSON.parse(await readFile(join(f.root, 'delivery.json'), 'utf8'));
    record.delivered = false; await writeFile(join(f.root, 'delivery.json'), JSON.stringify(record));
    expect((await f.execute('deliver-sdk', '', 'piped-input')).ok).toBe(true);
    record.delivered = false; await writeFile(join(f.root, 'delivery.json'), JSON.stringify(record)); await f.git('update-ref', '-d', delivered.result.plan.ref);
    expect(await f.execute('deliver-sdk')).toMatchObject({ ok: false, error: { code: 'DELIVERY_INTERACTIVE_REQUIRED' } });
    const retry = await f.execute(); expect(retry.ok).toBe(true); expect(retry.result.plan).toEqual(delivered.result.plan);
  });
  it.each(['n', 'EOF', 'y'])('adoption %s writes only after explicit human consent; replay retains its result', async answer => {
    const f = await fixture(), delivered = await f.execute(); expect(delivered.ok).toBe(true);
    const before = await f.refs(), result = await f.execute('adopt', answer);
    if (answer !== 'y') { expect(result.error.code).toBe('DELIVERY_CONFIRMATION_DECLINED'); expect(await f.refs()).toBe(before); }
    else { expect(result.ok, result.output).toBe(true); expect(await f.git('rev-parse', f.target)).toBe(delivered.result.plan.commit);
      const replay = await f.execute('adopt-sdk', '', 'piped-input'); expect(replay.result).toEqual(result.result); expect(replay.output).not.toContain('y/N: '); }
  });
  it.each(['adopt-sdk', 'adopt-mcp'])('prevents %s from moving a configured target', async mode => {
    const f = await fixture(); expect((await f.execute()).ok).toBe(true); const before = await f.refs();
    expect(await f.execute(mode)).toMatchObject({ ok: false, error: { code: 'DELIVERY_INTERACTIVE_REQUIRED' } }); expect(await f.refs()).toBe(before);
  });
  // TESLIM-GUVENLIK (owner): every action that moves a branch asks the person y/N — a rollback moves the adopted branch back.
  async function adopted() {
    const f = await fixture(), delivered = await f.execute(); expect(delivered.ok, delivered.output).toBe(true);
    const adoption = await f.execute('adopt', 'y'); expect(adoption.ok, adoption.output).toBe(true);
    expect(await f.git('rev-parse', f.target)).toBe(delivered.result.plan.commit);
    return { f, commit: delivered.result.plan.commit as string };
  }
  it.each(['n', 'EOF'])('rollback %s after the shown card keeps the branch, its fence and the journal unchanged', async answer => {
    const { f, commit } = await adopted(), before = await f.refs(), result = await f.execute('rollback', answer);
    expect(result).toMatchObject({ ok: false, error: { code: 'DELIVERY_CONFIRMATION_DECLINED' } });
    expect(result.output).toContain('Roll back an adoption: Ship useful change'); expect(result.output).toContain(`${commit} → ${f.base}`);
    expect(await f.git('rev-parse', f.target)).toBe(commit); expect(await f.refs()).toBe(before);
    await expect(readFile(join(f.root, 'rollback.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([['rollback', 'piped-input'], ['rollback-sdk', 'tty'], ['rollback-mcp', 'tty']])('%s (%s) is refused before any journal claim; the branch stays adopted', async (mode, tty) => {
    const { f, commit } = await adopted(), before = await f.refs(), result = await f.execute(mode, 'y', tty);
    expect(result).toMatchObject({ ok: false, error: { code: 'DELIVERY_INTERACTIVE_REQUIRED' } }); expect(result.output).not.toContain('y/N: ');
    expect(await f.git('rev-parse', f.target)).toBe(commit); expect(await f.refs()).toBe(before);
    await expect(readFile(join(f.root, 'rollback.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rollback y moves the branch back once after the shown card; replay returns the same result without asking', async () => {
    const { f, commit } = await adopted(), result = await f.execute('rollback', 'y');
    expect(result.ok, result.output).toBe(true); expect(result.output).toContain('Roll back an adoption: Ship useful change');
    expect(result.result).toMatchObject({ status: 'rolled-back', targetRef: f.target, fromCommit: commit, toCommit: f.base, sequence: 2 });
    expect(await f.git('rev-parse', f.target)).toBe(f.base);
    const replay = await f.execute('rollback-sdk', '', 'piped-input'); expect(replay.result).toEqual(result.result); expect(replay.output).not.toContain('y/N: ');
  });
  it('a claimed but unmoved rollback needs a fresh answer; a moved but unsettled one settles without asking', async () => {
    const { f, commit } = await adopted(), adoption = JSON.parse(await readFile(join(f.root, 'adoption.json'), 'utf8'));
    const intent = { schemaVersion: 1, kind: 'rollback', command: { schemaVersion: 1, commandId: 'rollback', identity: adoption.intent.command.identity, adoptionCommandId: 'adopt' },
      targetRef: f.target, fromCommit: commit, toCommit: f.base, actor: adoption.intent.actor };
    await writeFile(join(f.root, 'rollback.json'), JSON.stringify({ intent, sequence: 2, settled: false }));
    const before = await f.refs();
    expect(await f.execute('rollback-sdk', '', 'piped-input')).toMatchObject({ ok: false, error: { code: 'DELIVERY_INTERACTIVE_REQUIRED' } });
    expect(await f.refs()).toBe(before); expect(await f.git('rev-parse', f.target)).toBe(commit);
    const resumed = await f.execute('rollback', 'y'); expect(resumed.ok, resumed.output).toBe(true); expect(resumed.output).toContain('Roll back an adoption');
    expect(await f.git('rev-parse', f.target)).toBe(f.base);
    await writeFile(join(f.root, 'rollback.json'), JSON.stringify({ intent, sequence: 2, settled: false }));
    const settled = await f.execute('rollback-sdk', '', 'piped-input'); expect(settled.ok, settled.output).toBe(true); expect(settled.result).toEqual(resumed.result);
  });
});

it.skipIf(process.platform === 'linux')('refuses the unavailable verified-terminal capability before effects on other platforms', async () => {
  const port = verifiedDeliveryConfirmation(async () => true);
  await expect(port.assertAvailable()).rejects.toMatchObject({ code: 'DELIVERY_INTERACTIVE_REQUIRED' });
});
