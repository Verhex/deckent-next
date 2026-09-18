import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { ProcessSupervisor } from '#adapters/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const readCommand = `let input='';for await(const chunk of process.stdin) input+=chunk;const c=JSON.parse(input);`;
async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-process-supervisor-')); roots.push(root);
  const child = join(root, 'control.mjs'); await writeFile(child, readCommand + body);
  const request = { protocolVersion: 1 as const, identity: { runId: 'r', taskId: 't', attemptId: randomUUID(), scopeId: 's', layoutRevision: 'l', generation: 1 }, workspace: join(root, 'workspace'), argv: ['node', '-e', 'process.stdout.write("done")'] };
  await mkdir(request.workspace);
  const options = { executable: process.execPath, args: [child], cwd: root, timeoutMs: 5000, maxInputBytes: 4096, maxOutputBytes: 4096 };
  return { root, child, request, options, supervisor: new ProcessSupervisor(options) };
}
const reply = `const reply={protocolVersion:1,requestId:c.requestId,identity:c.request.identity,operation:c.operation,value:{handle:'worker',result:{kind:'unknown',reasonCode:'PENDING'}}};`;
it('correlates a real subprocess observation and preserves an unknown outcome', async () => {
  const f = await fixture(reply + 'process.stdout.write(JSON.stringify(reply));');
  expect(await f.supervisor.observe(f.request)).toEqual({ handle: 'worker', result: { kind: 'unknown', reasonCode: 'PENDING' } });
});
it.each([
  "reply.requestId='different';process.stdout.write(JSON.stringify(reply));",
  "reply.identity.scopeId='other';process.stdout.write(JSON.stringify(reply));",
  "reply.identity.generation++;process.stdout.write(JSON.stringify(reply));",
  "reply.operation='cancel';process.stdout.write(JSON.stringify(reply));",
  "reply.protocolVersion=2;process.stdout.write(JSON.stringify(reply));",
  "process.stdout.write(JSON.stringify(reply)+'\\n'+JSON.stringify(reply));",
  "process.stdout.write('private invalid response');",
  "process.stdout.write(Buffer.from([0xc3,0x28]));",
  "process.stderr.write('secret'.repeat(1000));",
  "process.exitCode=3;process.stdout.write(JSON.stringify(reply));",
])('rejects mismatched or invalid control-process evidence %s', async body => {
  const f = await fixture(reply + body);
  await expect(f.supervisor.observe(f.request)).rejects.toMatchObject({ code: 'SUPERVISOR_CONTROL_FAILED', message: 'SUPERVISOR_CONTROL_FAILED' });
});
it('bounds input, times out control work and refuses an already aborted launch', async () => {
  const f = await fixture('setInterval(()=>{},1000);');
  await expect(new ProcessSupervisor({ ...f.options, maxInputBytes: 1 }).execute(f.request)).rejects.toMatchObject({ code: 'SUPERVISOR_REQUEST_INVALID' });
  await expect(new ProcessSupervisor({ ...f.options, timeoutMs: 100 }).execute(f.request)).rejects.toMatchObject({ code: 'SUPERVISOR_CONTROL_FAILED' });
  await expect(f.supervisor.execute(f.request, AbortSignal.abort())).rejects.toMatchObject({ code: 'SUPERVISOR_CANCELLED' });
});
it.skipIf(!process.env.DECKENT_TEST_DOCKER_IMAGE)('executes, observes and releases a real Docker worker across the process protocol', async () => {
  const f = await fixture('');
  const options = { executable: '/usr/bin/docker', workspaceRoot: f.root, imageId: process.env.DECKENT_TEST_DOCKER_IMAGE!, uid: process.getuid!(), gid: process.getgid!(), logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 };
  await writeFile(f.child, `import {DockerSupervisor} from ${JSON.stringify(pathToFileURL(resolve('dist/adapters/index.js')).href)};` + readCommand +
    `const supervisor=new DockerSupervisor(${JSON.stringify(options)});const method=c.operation==='recover-output'?'recoverOutput':c.operation;const value=await supervisor[method](c.request);process.stdout.write(JSON.stringify({protocolVersion:1,requestId:c.requestId,operation:c.operation,identity:c.request.identity,value:value??null}));`);
  const supervisor = new ProcessSupervisor({ ...f.options, timeoutMs: 15000, maxOutputBytes: 131072 });
  try {
    const result = await supervisor.execute(f.request); expect(result.result).toEqual({ kind: 'exited', exitCode: 0 }); expect(result.stdout).toBe('done');
    expect((await supervisor.observe(f.request)).result).toEqual(result.result);
    expect(await supervisor.recoverOutput(f.request)).toEqual({ stdout: 'done', stderr: '', completeness: 'partial' });
    expect((await supervisor.cancel(f.request)).result).toEqual(result.result);
  } finally { await supervisor.release(f.request); }
  expect((await supervisor.observe(f.request)).result.kind).toBe('unknown');
}, 25000);

it('redacts missing executable failures and rejects NUL process configuration before launch', async () => {
  const f = await fixture('');
  await expect(new ProcessSupervisor({ ...f.options, executable: join(f.root, 'private-missing') }).observe(f.request))
    .rejects.toMatchObject({ code: 'SUPERVISOR_CONTROL_FAILED', message: 'SUPERVISOR_CONTROL_FAILED' });
  for (const override of [{ executable: '/private\0' }, { cwd: '/private\0' }, { args: ['private\0'] }]) {
    expect(() => new ProcessSupervisor({ ...f.options, ...override })).toThrow('SUPERVISOR_OPTIONS_INVALID');
  }
});
it('interrupts a confirmed live control process without reporting worker termination', async () => {
  const f = await fixture("await import('node:fs/promises').then(fs=>fs.writeFile('ready',String(process.pid)));setInterval(()=>{},1000);");
  const controller = new AbortController();
  const pending = f.supervisor.execute(f.request, controller.signal);
  const rejection = expect(pending).rejects.toMatchObject({ code: 'SUPERVISOR_CONTROL_FAILED' });
  try {
    let pid = 0;
    for (let i = 0; i < 200; i++) {
      try { pid = Number(await readFile(join(f.root, 'ready'), 'utf8')); break; } catch { await sleep(10); }
    }
    expect(pid).toBeGreaterThan(0); expect(() => process.kill(pid, 0)).not.toThrow();
    controller.abort(); await rejection;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { controller.abort(); await rejection.catch(() => {}); }
});

it('does not wait for inherited pipe writers after confirmed control cancellation', async () => {
  const f = await fixture("const {spawn}=await import('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});await import('node:fs/promises').then(fs=>fs.writeFile('descendant',String(child.pid)));setInterval(()=>{},1000);");
  let descendant = 0;
  const controller = new AbortController();
  const pending = new ProcessSupervisor({ ...f.options, timeoutMs: 15000 }).execute(f.request, controller.signal);
  const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
  try {
    for (let i = 0; i < 1000; i++) {
      try { descendant = Number(await readFile(join(f.root, 'descendant'), 'utf8')); break; } catch { await sleep(10); }
    }
    expect(descendant).toBeGreaterThan(0); controller.abort();
    expect((await outcome).error).toMatchObject({ code: 'SUPERVISOR_CONTROL_FAILED' });
    // The command returned before the descendant closed its inherited stdout/stderr.
    // This is intentionally not evidence that a worker or arbitrary descendant stopped.
    expect(() => process.kill(descendant, 0)).not.toThrow();
  } finally { controller.abort(); if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* The bounded child may already have exited. */ } } await outcome; }
}, 20000);
