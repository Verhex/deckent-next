import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { a0Record, a0Records, a0Wire, redactA0Paths, writeA0FakeCli } from '../../fixtures/native-agent-a0/fixture.js';

const roots: string[] = [];
async function disposable() {
  const dir = await mkdtemp(join(tmpdir(), 'deckent-a0-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const argv = (cli: string) => cli === 'claude' ? ['--print', '--output-format', 'stream-json'] : ['exec', '--json'];
const environment = (dir: string) => ({ HOME: dir, DECKENT_GLOBAL_HOME: join(dir, 'state') });

describe('A63-K10 retained A0 fake CLIs', () => {
  it('pins every source byte and excludes email/credential patterns; optionally rechecks retained A0', async () => {
    expect(new Set(a0Records.map(row => row.source)).size).toBe(a0Records.length);
    for (const record of a0Records) {
      const wire = await a0Wire(record);
      expect(wire.length, record.id).toBe(record.bytes);
      expect(createHash('sha256').update(wire).digest('hex'), record.id).toBe(record.sha256);
      expect(wire.toString().trimEnd().split('\n'), record.id).toHaveLength(record.lines);
      expect(wire.toString()).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
      expect(wire.toString()).not.toMatch(/sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]+\.eyJ/u);
      // CI needs only pinned fixtures; the lane's two required runs supply the external retained root.
      if (process.env['DECKENT_A0_SOURCE_ROOT']) {
        const source = await readFile(join(process.env['DECKENT_A0_SOURCE_ROOT'], record.source));
        expect(createHash('sha256').update(source).digest('hex'), record.id).toBe(record.sourceSha256);
        expect(wire, record.id).toEqual(redactA0Paths(source));
      }
    }
  });

  it('replays every retained stream byte-for-byte and preserves the measured exit code', async () => {
    const dir = await disposable();
    for (const record of a0Records) {
      const cli = await writeA0FakeCli(dir, record.id);
      const result = spawnSync(process.execPath, [cli, ...argv(record.cli)], { env: environment(dir), timeout: 5000 });
      expect(result.error, record.id).toBeUndefined();
      expect(result.signal, record.id).toBeNull();
      expect(result.status, record.id).toBe(record.exitCode);
      expect(result.stderr.toString(), record.id).toBe('');
      expect(result.stdout, record.id).toEqual(await a0Wire(record));
    }
  });

  it('keeps wire fidelity across small writes and fails closed if copied wire is corrupted', async () => {
    const dir = await disposable(), record = a0Record('claude-tools');
    const cli = await writeA0FakeCli(dir, record.id, { chunkBytes: 7 });
    const invoke = () => spawnSync(process.execPath, [cli, ...argv(record.cli)], { env: environment(dir), timeout: 5000 });
    expect(invoke().stdout).toEqual(await a0Wire(record));
    await writeFile(join(dirname(cli), 'stdout.jsonl'), '{}\n');
    const corrupted = invoke();
    expect(corrupted.status).not.toBe(0);
    expect(corrupted.stdout.length).toBe(0);
    expect(corrupted.stderr.toString()).toContain('A0_FAKE_WIRE_DIGEST_MISMATCH');
  });

  it('never fabricates successful login/help and rejects unknown recordings and unbounded player options', async () => {
    const dir = await disposable(), cli = await writeA0FakeCli(dir, 'codex-tools');
    for (const args of [['login'], ['--help']]) {
      const result = spawnSync(process.execPath, [cli, ...args], { env: environment(dir), timeout: 5000 });
      expect(result.status).toBe(2);
      expect(result.stdout.length).toBe(0);
      expect(result.stderr.toString()).toContain('A0_FAKE_UNRECORDED_INVOCATION');
    }
    await expect(writeA0FakeCli(dir, 'not-recorded')).rejects.toThrow('A0_RECORD_NOT_FOUND');
    await expect(writeA0FakeCli(dir, 'codex-tools', { chunkBytes: 0 })).rejects.toThrow('A0_FAKE_INVALID_BOUND');
    await expect(writeA0FakeCli(dir, 'codex-tools', { waitTimeoutMs: Infinity })).rejects.toThrow('A0_FAKE_INVALID_BOUND');
    await expect(writeA0FakeCli(dir, 'codex-tools', { mode: 'interrupt' })).rejects.toThrow('A0_FAKE_NOT_A_CANCEL_RECORD');
  });

  it('waits at the retained pending call until interruption and retains cancellation bytes/exit truth', async () => {
    const dir = await disposable();
    for (const id of ['claude-cancel', 'codex-cancel']) {
      const record = a0Record(id), cli = await writeA0FakeCli(dir, id, { mode: 'interrupt' });
      const child = spawn(process.execPath, [cli, ...argv(record.cli)], { env: environment(dir), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stdout = Buffer.alloc(0), stderr = '', interrupted = false;
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.on('error', reject);
          child.stdout!.on('data', chunk => {
            stdout = Buffer.concat([stdout, chunk]);
            if (!interrupted && stdout.toString().includes(record.cli === 'claude' ? '"tool_use"' : '"mcp_tool_call"')) {
              interrupted = true;
              // POSIX uses the same signal as the measured A0 runner; Windows uses explicit test-only IPC.
              if (process.platform === 'win32') child.send('A0_FAKE_INTERRUPT');
              else child.kill('SIGINT');
            }
          });
          child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
          child.on('close', (code, signal) => resolve({ code, signal }));
        });
        expect(interrupted).toBe(true);
        expect(result).toEqual({ code: record.exitCode, signal: null });
        expect(stderr).toBe('');
        expect(stdout).toEqual(await a0Wire(record));
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  });
});
