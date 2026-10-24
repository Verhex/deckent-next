import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { processCommandSchema, runNodeProcess } from '#adapters/core/process-runner/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function v2(code: string, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-runner-v2-')); roots.push(root);
  return { schemaVersion: 2 as const, requestId: randomUUID(), executable: process.execPath, args: ['-e', code], cwd: root, env: {}, timeoutMs: 5000, outputBytes: 4096,
    maxLineBytes: 256, ...extra };
}
const text = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');
describe.skipIf(process.platform !== 'linux')('process runner v2 (S3-2): stdin, lines, graceful stop', () => {
  it('keeps v1 strict: stdin, grace and line bounds exist only in v2', () => {
    const base = { schemaVersion: 1, requestId: randomUUID(), executable: '/bin/true', args: [], cwd: '/', env: {}, timeoutMs: 1, outputBytes: 1 };
    for (const extra of [{ stdinBase64: '' }, { interruptGraceMs: 1 }, { maxLineBytes: 1 }, { stderrBytes: 1 }]) expect(processCommandSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    expect(processCommandSchema.safeParse({ ...base, schemaVersion: 2, stdinBase64: 'not base64!' }).success).toBe(false);
    expect(processCommandSchema.safeParse({ ...base, schemaVersion: 2, stdinBase64: '', interruptGraceMs: 1, maxLineBytes: 1, stderrBytes: 1 }).success).toBe(true);
  });
  it('delivers bounded stdin bytes and complete lines in order, the last unterminated line at close', async () => {
    const lines: string[] = [];
    const input = await v2('let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write("a\\n"+s.toUpperCase()+"\\nlast"))',
      { stdinBase64: Buffer.from('hello stdin').toString('base64') });
    const result = await runNodeProcess(input, undefined, line => { lines.push(line); });
    expect(result).toMatchObject({ reason: 'exit', exitCode: 0 });
    expect(lines).toEqual(['a', 'HELLO STDIN', 'last']);
    expect(text(result.stdoutBase64)).toBe('a\nHELLO STDIN\nlast');
  });
  it('lets the line consumer stop the process group at once and ignores later lines', async () => {
    const lines: string[] = [];
    const input = await v2('process.stdout.write("one\\ntwo\\nthree\\n");setInterval(()=>{},1000)', { interruptGraceMs: 60000 });
    const started = Date.now();
    const result = await runNodeProcess(input, undefined, line => { lines.push(line); return line === 'two' ? 'stop' : undefined; });
    expect(result).toMatchObject({ started: true, reason: 'stopped', signal: 'SIGKILL' });
    expect(lines).toEqual(['one', 'two']);
    expect(Date.now() - started).toBeLessThan(30000);
  });
  it('refuses a line over the line bound and a stderr flood over its own bound', async () => {
    expect(await runNodeProcess(await v2('process.stdout.write("x".repeat(1000));setInterval(()=>{},1000)'), undefined, () => undefined))
      .toMatchObject({ reason: 'line-limit', signal: 'SIGKILL' });
    const flood = await runNodeProcess(await v2('process.stderr.write("e".repeat(5000));setInterval(()=>{},1000)', { stderrBytes: 64 }));
    expect(flood).toMatchObject({ reason: 'output-limit', stderrTruncated: true });
    expect(Buffer.from(flood.stderrBase64, 'base64')).toHaveLength(64);
    await expect(runNodeProcess({ ...(await v2('')), maxLineBytes: undefined }, undefined, () => undefined)).rejects.toMatchObject({ code: 'PROCESS_RUNNER_INVALID' });
  });
  it('interrupts first on timeout and cancel: a child that ends its turn on SIGINT exits by itself', async () => {
    const code = 'process.on("SIGINT",()=>{process.stdout.write("interrupted\\n");process.exit(130)});process.stdout.write("ready\\n");setInterval(()=>{},1000)';
    const timed = await runNodeProcess(await v2(code, { timeoutMs: 300, interruptGraceMs: 10000 }), undefined, () => undefined);
    expect(timed).toMatchObject({ reason: 'timeout', exitCode: 130, signal: null });
    expect(text(timed.stdoutBase64)).toContain('interrupted');
    const controller = new AbortController(), pending = runNodeProcess(await v2(code, { interruptGraceMs: 10000 }), controller.signal,
      line => { if (line === 'ready') controller.abort(); });
    expect(await pending).toMatchObject({ reason: 'cancelled', exitCode: 130, signal: null });
  });
  it('kills the group after the grace bound when SIGINT is ignored', async () => {
    const started = Date.now();
    const result = await runNodeProcess(await v2('process.on("SIGINT",()=>{});setInterval(()=>{},1000)', { timeoutMs: 200, interruptGraceMs: 300 }));
    expect(result).toMatchObject({ reason: 'timeout', signal: 'SIGKILL' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });
});
