import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_SHELL_CHUNK_MAX_BYTES, runHostShell } from '#adapters/index.js';

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
    expect(result).toMatchObject({ status: 'exited', exitCode: 3, omittedBytes: 0 });
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
    expect(Buffer.byteLength(result.output)).toBeLessThan(140_000);
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

  it('runs nothing when the call is already cancelled', async () => {
    const cwd = await workspace(), controller = new AbortController(); controller.abort();
    expect(await runHostShell({ command: 'touch ran', cwd, signal: controller.signal })).toMatchObject({ status: 'cancelled', totalBytes: 0 });
    expect(existsSync(join(cwd, 'ran'))).toBe(false);
  });
});
