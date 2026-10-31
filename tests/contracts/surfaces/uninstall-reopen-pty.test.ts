import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_DRIVER as driver } from '../support/delivery-queue-fixture.js';
import type { Step } from '../support/pty-steps.js';

/**
 * §5.4 (owner 2026-10-27) on the built CLI: a keep-data uninstall on the person's own pseudo-terminal retires the folder; the service does not
 * start while it is retired; the next `deckent` there asks once — "Not now" leaves everything as it is, "Continue with it" clears the marker and
 * the terminal starts the service again. Requires `npm run build`.
 */
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const python = (process.env['PATH'] ?? '').split(':').map(dir => join(dir, 'python3')).find(path => existsSync(path)) ?? 'python3';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== 'linux' || !existsSync(cli))('uninstall keep-data retires the folder; the reopen card decides (built CLI, PTY)', () => {
  it('keep-data writes the marker, the service refuses to start, "Not now" keeps it and "Continue with it" clears it and starts the service', async () => {
    const base = await mkdtemp(join(tmpdir(), 'deckent-uninstall-reopen-pty-')); roots.push(base);
    const project = join(base, 'walk'), home = join(base, 'home');
    for (const dir of [project, home]) await mkdir(dir, { recursive: true });
    // A clean environment (the runner may itself run inside an AI agent or CI): no agent marker, English, no Deckent variables.
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home, LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
    const run = (args: readonly string[], extra: Record<string, string> = {}) => execute(process.execPath, [cli, ...args], { cwd: project, env: { ...env, TERM: 'dumb', ...extra },
      timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const pty = async (args: readonly string[], steps: readonly Step[], untilExit: boolean) => {
      const { stdout } = await execute(python, ['-c', driver, JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps), 'tty', ...(untilExit ? ['until-exit'] : [])],
        { cwd: project, env, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
      const result = JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string };
      if (result.timeout) throw new Error(`waited for ${JSON.stringify(result.timeout)}\n${stripVTControlCharacters(result.output).slice(-4000)}`);
      return { ...result, output: stripVTControlCharacters(result.output) };
    };
    await run(['init', '--yes', '--scope', 'walk']);
    // One owned cache entry, so keep-data has something to remove (otherwise it asks nothing and changes nothing).
    const area = join(project, '.deckent/state/scratch', 'a'.repeat(32), 'b'.repeat(32)), marker = join(project, '.deckent/installation/retired.json');
    await mkdir(area, { recursive: true, mode: 0o700 }); await writeFile(join(area, 'entry'), 'cache', { mode: 0o600 });
    const removed = await pty(['uninstall', '--lang', 'en'], [['Remove, keep my data', '\r'], ['Will be removed', '\r', 'fresh']], true);
    expect(removed.status, removed.output).toBe(0); expect(removed.output).toContain('Removal completed.');
    expect(await lstat(marker)).toBeTruthy(); await expect(lstat(area)).rejects.toMatchObject({ code: 'ENOENT' });
    // The service does not start in a retired folder.
    const serve = await run(['runtime', 'serve'], { NODE_ENV: 'test' }).then(() => null, (error: { stderr?: string; code?: number }) => error);
    expect(serve?.stderr ?? '').toContain('UNINSTALL_RETIRED');
    const service = () => run(['runtime', 'describe', '--json']).then(() => 'running', (error: { stderr?: string }) => error.stderr ?? '');
    try {
      // The card listens once its key hint is drawn; the moved choice is confirmed only once it is shown.
      const notNow = await pty(['--lang', 'en'], [['↑↓ choose', '\x1b[B'], ['› 2. Not now', '\r', 'fresh']], true);
      expect(notNow.status, notNow.output).toBe(0); expect(await lstat(marker)).toBeTruthy(); expect(await service()).toContain('LOCAL_RUNTIME_UNAVAILABLE');
      expect(notNow.output).not.toContain('Preparing…'); // alpha.60 C: a retired folder keeps the old path (no launch shell)
      // Continue: the marker is cleared and the terminal starts the service before onboarding opens (the view is stopped there; the service keeps running).
      const reopened = await pty(['--lang', 'en'], [['↑↓ choose', '\r'], ['Permission settings', '', 'fresh']], false);
      await expect(lstat(marker), reopened.output).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await service()).toBe('running');
    } finally {
      // Teardown waits for the started service to end, not only for its accepted shutdown: a process still exiting writes its own state
      // (the compile cache flush at exit, alpha.60 A), which raced the folder removal under load.
      const pid = await run(['runtime', 'describe', '--json']).then(result => (JSON.parse(result.stdout) as { processId?: number }).processId, () => undefined);
      await run(['runtime', 'shutdown', '--reason', 'test teardown', '--json']).catch(() => undefined);
      for (const until = Date.now() + 20_000; pid && Date.now() < until;) { try { process.kill(pid, 0); } catch { break; } await new Promise(done => setTimeout(done, 100)); }
    }
  }, 300_000);
});
