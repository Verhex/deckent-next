import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeHostShellResult, HOST_SHELL_CHUNK_MAX_BYTES, hostShellCleanupNote, runHostShell, type HostShellResult } from '#adapters/index.js';

// setsid is an explicit fixture capability; macOS has no system setsid executable. No command may pass vacuously when it is absent.
const hasSetsid = process.platform !== 'win32' && spawnSync('setsid', ['--version'], { timeout: 2_000, stdio: 'ignore' }).status === 0;
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function workspace() { const root = await mkdtemp(join(tmpdir(), 'dn-host-shell-')); roots.push(root); return root; }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(process.platform === 'win32')('host shell execution (T-L4 slice 3b)', () => {
  it('runs in the workspace root with a scrubbed, non-interactive environment and reports the exit code and output in order', async () => {
    const cwd = await workspace();
    const result = await runHostShell({ command: 'pwd; echo "secret=${DEMO_SECRET:-none} allowed=${DEMO_ALLOWED:-none} term=$TERM pager=$GIT_PAGER"; echo oops >&2; exit 3',
      cwd, environment: { PATH: process.env.PATH, HOME: '/home/x', DEMO_SECRET: 's3cr3t', DEMO_ALLOWED: 'yes' }, extraEnv: ['DEMO_ALLOWED'] });
    expect(result).toMatchObject({ status: 'exited', exitCode: 3, omittedBytes: 0, cleanup: 'clean' });
    expect(result.output).toContain(`${cwd}\nsecret=none allowed=yes term=dumb pager=cat\n`);
    expect(result.output).toContain('oops');
    expect(result.output).not.toContain('s3cr3t');
  });

  it('kills the whole process group on cancel, background children included', async () => {
    const cwd = await workspace(), controller = new AbortController();
    const running = runHostShell({ command: 'sleep 30 & echo $! > child.pid; echo started; wait', cwd, signal: controller.signal,
      onOutput: (_stream, text) => { if (text.includes('started')) controller.abort(); } });
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(result.durationMs).toBeLessThan(5_000);
    const pid = Number((await readFile(join(cwd, 'child.pid'), 'utf8')).trim());
    await settle(200);
    expect(alive(pid)).toBe(false);
  });

  it('escalates to SIGKILL when the group ignores SIGTERM, and stops a command at its timeout', async () => {
    const cwd = await workspace(), controller = new AbortController();
    const stubborn = await runHostShell({ command: "trap '' TERM; echo started; sleep 30", cwd, signal: controller.signal,
      onOutput: (_stream, text) => { if (text.includes('started')) controller.abort(); } });
    expect(stubborn.status).toBe('cancelled');
    expect(stubborn.durationMs).toBeGreaterThanOrEqual(1_500); expect(stubborn.durationMs).toBeLessThan(6_000);
    const slow = await runHostShell({ command: 'sleep 30', cwd, timeoutMs: 300 });
    expect(slow.status).toBe('timed-out'); expect(slow.durationMs).toBeLessThan(3_000);
  });

  it('streams bounded chunks and keeps a bounded head and tail of a large output, counting what it left out', async () => {
    const cwd = await workspace(), chunks: string[] = [];
    const result = await runHostShell({ command: "head -c 1000000 /dev/zero | tr '\\0' a; echo; echo END", cwd, onOutput: (_stream, text) => chunks.push(text) });
    expect(result).toMatchObject({ status: 'exited', exitCode: 0, totalBytes: 1_000_005 });
    expect(result.omittedBytes).toBeGreaterThan(800_000);
    expect(result.output).toMatch(/\[… \d+ bytes of output omitted …\]/u); expect(result.output.endsWith('END\n')).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThan(17_000);
    expect(chunks.every(chunk => Buffer.byteLength(chunk) <= HOST_SHELL_CHUNK_MAX_BYTES)).toBe(true);
    expect(chunks.join('').length).toBe(1_000_005);
  });

  it('never splits a multi-byte character in streamed chunks or in the kept output', async () => {
    const cwd = await workspace(), chunks: string[] = [];
    const result = await runHostShell({ command: "for i in $(seq 1 400); do printf 'ş%.0s' $(seq 1 100); done", cwd, resultMaxBytes: 4_097,
      onOutput: (_stream, text) => chunks.push(text) });
    expect(chunks.join('')).toBe('ş'.repeat(40_000));
    expect(chunks.some(chunk => chunk.includes('�'))).toBe(false);
    expect(result.output.includes('�')).toBe(false);
  });

  // Astra 2112 R1 (inverted repro): a background child that redirected its output lets the shell exit normally; the call still
  // ends the whole group before it settles, and the result says that survivors were killed.
  it('terminates a redirected background child the shell left behind at its normal exit, and says so', async () => {
    const cwd = await workspace(); let pid = 0;
    try {
      const result = await runHostShell({ cwd, command: 'sleep 20 > /dev/null 2>&1 & echo $!', timeoutMs: 5_000 });
      pid = Number(result.output.trim());
      expect(pid).toBeGreaterThan(0);
      expect(result).toMatchObject({ status: 'exited', exitCode: 0, cleanup: 'group-ended' });
      expect(result.durationMs).toBeLessThan(3_000);
      expect(alive(pid)).toBe(false);
      await settle(100);
      expect(alive(pid)).toBe(false);
    } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } }
  });

  // Astra 2112 R2 (inverted repro): a multi-byte character whose bytes arrive in two pipe chunks is kept whole in the result, and
  // nothing is reported as omitted.
  it('keeps a multi-byte character split across pipe chunks whole in the result', async () => {
    const cwd = await workspace(), chunks: string[] = [];
    const result = await runHostShell({ cwd, command: "head -c 4095 /dev/zero | tr '\\0' a; printf '\\305'; sleep 0.05; printf '\\237'", onOutput: (_stream, text) => chunks.push(text) });
    expect(chunks.join('')).toBe(`${'a'.repeat(4095)}ş`);
    expect(result).toMatchObject({ status: 'exited', exitCode: 0, totalBytes: 4_097, omittedBytes: 0, cleanup: 'clean' });
    expect(result.output).toBe(`${'a'.repeat(4095)}ş`);
    expect(result.output.includes('\ufffd')).toBe(false);
  });

  // Once a character did not fit the head and went to the tail, later output must follow it there, whatever room the head has left.
  it('keeps the kept output in arrival order once the head spilled into the tail', async () => {
    const cwd = await workspace();
    const result = await runHostShell({ cwd, command: "head -c 4095 /dev/zero | tr '\\0' a; printf 'ş'; sleep 0.05; echo b" });
    expect(result).toMatchObject({ status: 'exited', exitCode: 0, totalBytes: 4_099, omittedBytes: 0 });
    expect(result.output).toBe(`${'a'.repeat(4095)}şb\n`);
  });

  // I40: the duration is elapsed time on the platform clock's monotonic reading; a host wall clock stepping backwards during the
  // run (measured ~2 s on this host) never clamps it to 0.
  it('measures the run on the monotonic clock, so a backward wall step during the run does not shorten it', async () => {
    const cwd = await workspace();
    const samples = [{ wallMs: 1_000, monotonicMs: 500 }, { wallMs: 1_000 - 2_100, monotonicMs: 650 }];
    const clock = { sample() { return samples.length > 1 ? samples.shift()! : samples[0]!; } };
    const result = await runHostShell({ cwd, command: 'true' }, clock);
    expect(result).toMatchObject({ status: 'exited', exitCode: 0, durationMs: 150 });
  });

  // Astra 2119 (inverted repro): a descendant that left the process group (setsid) and kept the inherited pipes open cannot be seen
  // or ended through the group; the pipes are released a short grace after the group is known empty (or at the timeout), the call
  // ends bounded, and the result says the cleanup is unverified. Documented scope: such a descendant can outlive the call.
  it.skipIf(!hasSetsid)('bounds the pipe drain after the shell exit even when a child left the process group, and reports the cleanup as unverified (requires setsid fixture)', async () => {
    const cwd = await workspace(), before = performance.now();
    const result = await runHostShell({ cwd, command: 'setsid sh -c "echo ready; sleep 5" & sleep 0.2; exit 0', timeoutMs: 500 });
    // The timeout (500 ms) releases the pipes, well before the drain grace would (~1.2 s) and long before the child ends (5 s).
    expect(performance.now() - before).toBeLessThan(1_000);
    expect(result).toMatchObject({ status: 'exited', exitCode: 0, cleanup: 'unverified' });
    expect(result.output).toContain('ready');
  });

  it.skipIf(!hasSetsid)('ends at once when a child that left the process group redirected its output, and does not claim to have observed it (requires setsid fixture)', async () => {
    const cwd = await workspace(), before = performance.now();
    const result = await runHostShell({ cwd, command: 'setsid sh -c "sleep 5" > /dev/null 2>&1 & sleep 0.2; exit 0' });
    expect(performance.now() - before).toBeLessThan(1_000);
    expect(result).toMatchObject({ status: 'exited', exitCode: 0, cleanup: 'clean' });
  });

  it.skipIf(!hasSetsid)('is released by a cancellation while a child outside the group still holds the pipes (requires setsid fixture)', async () => {
    const cwd = await workspace(), controller = new AbortController(), before = performance.now();
    const result = await runHostShell({ cwd, command: 'setsid sh -c "echo ready; sleep 5" & sleep 1; exit 0', signal: controller.signal,
      onOutput: (_stream, text) => { if (text.includes('ready')) setTimeout(() => controller.abort(), 50); } });
    expect(performance.now() - before).toBeLessThan(3_000);
    expect(result).toMatchObject({ status: 'cancelled', cleanup: 'unverified' });
  });

  // The shell exits at ~200 ms; the abort lands at ~300 ms, inside the drain (its grace would end at ~1.2 s): the pipes are released
  // at once and the exited status is kept.
  it.skipIf(!hasSetsid)('is released by a cancellation that arrives during the drain after the shell exited (requires setsid fixture)', async () => {
    const cwd = await workspace(), controller = new AbortController(), before = performance.now();
    const result = await runHostShell({ cwd, command: 'setsid sh -c "echo ready; sleep 5" & sleep 0.2; exit 0', signal: controller.signal, timeoutMs: 20_000,
      onOutput: (_stream, text) => { if (text.includes('ready')) setTimeout(() => controller.abort(), 300); } });
    expect(performance.now() - before).toBeLessThan(900);
    expect(result).toMatchObject({ status: 'exited', exitCode: 0, cleanup: 'unverified' });
  });

  it('drains ordinary output completely after the shell exit', async () => {
    const cwd = await workspace();
    const result = await runHostShell({ cwd, command: "head -c 60000 /dev/zero | tr '\\0' a; echo; echo END; exit 7" });
    expect(result).toMatchObject({ status: 'exited', exitCode: 7, totalBytes: 60_005, cleanup: 'clean' });
    expect(result.output.endsWith('END\n')).toBe(true);
  });

  it('runs nothing when the call is already cancelled', async () => {
    const cwd = await workspace(), controller = new AbortController(); controller.abort();
    expect(await runHostShell({ command: 'touch ran', cwd, signal: controller.signal })).toMatchObject({ status: 'cancelled', totalBytes: 0 });
    expect(existsSync(join(cwd, 'ran'))).toBe(false);
  });
});

// COMPOSITION-BUDGET-2: the agent-facing text of a run is the host shell's (moved from the runtime agent turn's shell).
it('describes a run: how it ended and after how long, the command cut at 120, the output, then the realm notice and the cleanup note', () => {
  const ran = (over: Partial<HostShellResult>): HostShellResult => ({ status: 'exited', exitCode: 0, signal: null, output: 'hi\n', totalBytes: 3, omittedBytes: 0,
    durationMs: 1_234, cleanup: 'clean', ...over });
  expect(describeHostShellResult('echo hi', ran({}), null)).toBe('[deckent] run_shell: exit 0 after 1.2s (echo hi)\nhi\n');
  expect(describeHostShellResult('x', ran({ exitCode: null, signal: 'SIGTERM', output: '' }), null)).toBe('[deckent] run_shell: exit signal SIGTERM after 1.2s (x)\n');
  const long = 'y'.repeat(130);
  expect(describeHostShellResult(long, ran({ status: 'timed-out', exitCode: null, output: 'part' }), null)).toBe(`[deckent] run_shell: timed-out after 1.2s (${'y'.repeat(119)}…)\npart`);
  expect(describeHostShellResult('ls', ran({ cleanup: 'group-ended' }), null)).toBe(`[deckent] run_shell: exit 0 after 1.2s (ls)\nhi\n${hostShellCleanupNote('group-ended')}`);
  expect(describeHostShellResult('ls', ran({ output: 'no newline', cleanup: 'unverified' }), { marker: 'sandbox: none', notice: 'N' })).toBe(
    `[deckent] run_shell: sandbox: none; exit 0 after 1.2s (ls)\nno newline\nN\n${hostShellCleanupNote('unverified')}`);
  expect(hostShellCleanupNote('clean')).toBeNull();
  expect(hostShellCleanupNote('unverified')).toMatch(/^\[deckent\] cleanup unverified: .*this is not a sandbox\.$/u);
});
