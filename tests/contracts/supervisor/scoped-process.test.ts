import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runNodeProcess, DockerSupervisor, createScopedNodeDockerRunner } from '#adapters/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(code: string) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-scoped-runner-')); roots.push(root);
  return { schemaVersion: 1 as const, requestId: randomUUID(), executable: process.execPath, args: ['-e', code], cwd: root, env: {}, timeoutMs: 5000, outputBytes: 4096 };
}
describe.skipIf(process.platform !== 'linux')('explicit Linux process profile', () => {
  it('uses only explicit environment/cwd and closes stdin; preserves raw invalid UTF8 bytes', async () => {
    const input = await fixture('process.stdin.on("end",()=>{process.stdout.write(Buffer.from([0xc3,0x28]));process.stderr.write(JSON.stringify({leaked:process.env.DECKENT_TEST_PARENT_SECRET??null,explicit:process.env.EXPLICIT,cwd:process.cwd()}))});process.stdin.resume();');
    const before = process.env.DECKENT_TEST_PARENT_SECRET; process.env.DECKENT_TEST_PARENT_SECRET = 'must-not-inherit';
    try {
      const result = await runNodeProcess({ ...input, env: { EXPLICIT: 'allowed' } });
      expect(result).toMatchObject({ started: true, reason: 'exit', exitCode: 0, signal: null, stdoutTruncated: false });
      expect(Buffer.from(result.stdoutBase64, 'base64')).toEqual(Buffer.from([0xc3, 0x28]));
      expect(JSON.parse(Buffer.from(result.stderrBase64, 'base64').toString())).toEqual({ leaked: null, explicit: 'allowed', cwd: input.cwd });
    } finally { if (before === undefined) delete process.env.DECKENT_TEST_PARENT_SECRET; else process.env.DECKENT_TEST_PARENT_SECRET = before; }
  });
  it('distinguishes start failure, nonzero exit, signal, timeout and pre-start cancellation', async () => {
    const input = await fixture('process.exitCode=7');
    expect(await runNodeProcess(input)).toMatchObject({ started: true, reason: 'exit', exitCode: 7, signal: null });
    expect(await runNodeProcess({ ...input, executable: join(input.cwd, 'absent') })).toMatchObject({ started: false, reason: 'start-failed', exitCode: null, signal: null });
    expect(await runNodeProcess({ ...input, args: ['-e', 'process.kill(process.pid,"SIGTERM")'] })).toMatchObject({ started: true, reason: 'signal', exitCode: null, signal: 'SIGTERM' });
    expect(await runNodeProcess({ ...input, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 })).toMatchObject({ started: true, reason: 'timeout', signal: 'SIGKILL' });
    expect(await runNodeProcess(input, AbortSignal.abort())).toMatchObject({ started: false, reason: 'cancelled', exitCode: null });
  });
  it('enforces separate stdout/stderr byte limits and rejects lossy argv/environment values', async () => {
    const input = await fixture('process.stdout.write("x".repeat(10000))');
    const result = await runNodeProcess({ ...input, outputBytes: 32 });
    expect(result).toMatchObject({ reason: 'output-limit', stdoutTruncated: true });
    expect(Buffer.from(result.stdoutBase64, 'base64')).toHaveLength(32);
    const errResult = await runNodeProcess({ ...input, args: ['-e', 'process.stderr.write("x".repeat(10000))'], outputBytes: 32 });
    expect(errResult).toMatchObject({ reason: 'output-limit', stderrTruncated: true });
    expect(Buffer.from(errResult.stderrBase64, 'base64')).toHaveLength(32);
    for (const changes of [{ args: ['\ud800'] }, { args: ['a\0'] }, { env: { BAD: '\udfff' } }, { env: { 'BAD=KEY': 'x' } }]) {
      await expect(runNodeProcess({ ...input, ...changes })).rejects.toMatchObject({ code: 'PROCESS_RUNNER_INVALID' });
    }
  });
  it('kills the owned process group when aborting a confirmed live child and descendant', async () => {
    const input = await fixture('const fs=require("node:fs");const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});fs.writeFileSync("pids",JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)');
    const controller = new AbortController(); const pending = runNodeProcess(input, controller.signal); let pids: number[] = [];
    try {
      for (let i = 0; i < 200; i++) { try { pids = JSON.parse(await readFile(join(input.cwd, 'pids'), 'utf8')); break; } catch { await sleep(10); } }
      expect(pids).toHaveLength(2); for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
      controller.abort(); expect(await pending).toMatchObject({ started: true, reason: 'cancelled', signal: 'SIGKILL' });
      for (const pid of pids) {
        let state = 'absent'; try { state = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1]!.split(' ')[0]!; } catch { /* Reaped by the OS. */ }
        expect(['absent', 'Z', 'X']).toContain(state);
      }
    } finally { controller.abort(); await pending; for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } } }
  });
  it.skipIf(!process.env.DECKENT_TEST_DOCKER_IMAGE)('executes a real isolated Docker worker with the explicit profile', async () => {
    const input = await fixture(''); const workspace = join(input.cwd, 'workspace'); await mkdir(workspace);
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: input.cwd, imageId: process.env.DECKENT_TEST_DOCKER_IMAGE!, uid: process.getuid!(), gid: process.getgid!(), logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 }, createScopedNodeDockerRunner({ cwd: input.cwd, env: {} }));
    const request = { protocolVersion: 1 as const, identity: { runId: 'r', taskId: 't', attemptId: randomUUID(), scopeId: 's', layoutRevision: 'l', generation: 1 }, workspace, argv: ['node', '-e', 'console.log("scoped")'] };
    try { expect(await supervisor.execute(request)).toMatchObject({ result: { kind: 'exited', exitCode: 0 }, stdout: 'scoped\n', interrupted: false }); }
    finally { await supervisor.release(request); }
  }, 20000);
});
