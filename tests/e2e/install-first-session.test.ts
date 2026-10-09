import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_LEDGER_VERSION } from '#adapters/index.js';

const binary = fileURLToPath(new URL('../../dist/composition/core/cli/internal/entry.js', import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== 'linux')('README first session, actual binary, no Docker or provider call', () => {
  it.each(['short', 'long'] as const)('initializes and serves a fresh %s path; stdin secrets use the selected default scope', async kind => {
    const root = await mkdtemp('/tmp/dk-first-'); roots.push(root);
    const project = join(root, kind === 'long' ? 'a project with spaces '.repeat(9) : 'project');
    const home = join(root, 'home'), global = join(root, 'global');
    await mkdir(project); await mkdir(home, { mode: 0o700 }); await mkdir(global, { mode: 0o700 });
    const env = { PATH: process.env['PATH'], HOME: home, DECKENT_GLOBAL_HOME: global, NO_COLOR: '1', DECKENT_LANGUAGE: 'en', DOCKER_HOST: 'unix:///nonexistent/docker.sock' };
    const run = async (args: string[]) => ({ stdout: execFileSync(process.execPath, [binary, ...args],
      { cwd: project, env, timeout: 20_000, maxBuffer: 1024 * 1024, encoding: 'utf8' }), stderr: '' });
    const version = await run(['--version']); expect(version.stdout + version.stderr, JSON.stringify({ binary, node: process.execPath, version })).toContain('deckent v');
    await run(['init', 'policy', '--scope', 'my-project', '--preview']);
    await expect(lstat(join(project, '.deckent'))).rejects.toMatchObject({ code: 'ENOENT' });
    await run(['init', 'policy', '--scope', 'my-project', '--apply']);
    const config = JSON.parse(await readFile(join(project, '.deckent/config.json'), 'utf8'));
    expect(config).toMatchObject({ schema_version: 4, terminal: { scopeId: 'my-project', chat: { schemaVersion: 1 } }, cancellationRuntime: { scopeIds: ['my-project'] } });
    expect(config.cancellation.maxConcurrentDeliveries).toBeGreaterThan(0);
    const db = new DatabaseSync(join(project, '.deckent/state/ledger.db'), { readOnly: true });
    try { expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION); expect(db.prepare('SELECT count(*) AS n FROM runs').get()?.n).toBe(0); } finally { db.close(); }
    const applied = await readFile(join(project, '.deckent/config.json'), 'utf8');
    await run(['init', 'policy', '--scope', 'my-project', '--apply']);
    expect(await readFile(join(project, '.deckent/config.json'), 'utf8')).toBe(applied);
    let log = '';
    const service = spawn(process.execPath, [binary, 'runtime', 'serve'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    service.stdout.on('data', chunk => { log += String(chunk); }); service.stderr.on('data', chunk => { log += String(chunk); });
    const exited = new Promise<void>((resolve, reject) => { service.once('exit', () => resolve()); service.once('error', reject); });
    try {
      let health: { status: string; startability: { status: string; endpoint: string; checks: unknown[] }; serviceConfig: string } | undefined;
      for (let retry = 0; retry < 100; retry++) {
        if (service.exitCode !== null) throw new Error(`runtime exited ${service.exitCode}: ${log}`);
        health = JSON.parse((await run(['doctor', '--json'])).stdout);
        if (health?.serviceConfig === 'current') break;
        await wait(50);
      }
      expect(health, log).toMatchObject({ status: 'ready', startability: { status: 'ready', checks: [] }, serviceConfig: 'current' });
      const endpoint = health!.startability.endpoint; roots.push(dirname(endpoint));
      expect(Buffer.byteLength(endpoint)).toBeLessThan(108); expect(endpoint).not.toContain(project);
      expect((await lstat(dirname(endpoint))).mode & 0o777).toBe(0o700);
      expect((await lstat(endpoint)).mode & 0o777).toBe(0o600);
      const set = spawn(process.execPath, [binary, 'secret', 'set', 'INSTALL_FLOW_TEST'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let secretLog = ''; set.stdout.on('data', chunk => { secretLog += String(chunk); }); set.stderr.on('data', chunk => { secretLog += String(chunk); });
      const saved = new Promise<number | null>(resolve => set.once('exit', resolve)); set.stdin.end('offline-fixture-key\n');
      expect(await saved, secretLog).toBe(0); expect(secretLog).not.toContain('offline-fixture-key');
      const listed = await run(['secret', 'list']); expect(listed.stdout + listed.stderr).toContain('INSTALL_FLOW_TEST');
      const doctor = await run(['doctor']); expect(doctor.stdout + doctor.stderr).toContain('Runtime startability: ready');
    } finally {
      service.kill('SIGTERM');
      const timer = setTimeout(() => service.kill('SIGKILL'), 10_000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  }, 60_000);
});
