import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGlobalConfigPaths } from '../../src/kernel/index.js';

const exec = promisify(execFile);
const binary = fileURLToPath(new URL('../../dist/surfaces/core/cli/internal/entry.js', import.meta.url));
const roots: string[] = [];
async function fixture(kind: 'empty' | 'global-only' | 'project-override') {
  const root = await mkdtemp(join(tmpdir(), `deckent-${kind}-`)); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'), xdg = join(home, '.config');
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, APPDATA: xdg, LOCALAPPDATA: xdg, NO_COLOR: '1' };
  const globalPath = resolveGlobalConfigPaths(env).platformPath;
  await mkdir(project); await mkdir(dirname(globalPath), { recursive: true });
  if (kind !== 'empty') await writeFile(globalPath, '{"mode":"balanced","language":"tr"}');
  if (kind === 'project-override') {
    await mkdir(join(project, '.deckent'));
    await writeFile(join(project, '.deckent/config.json'), '{"mode":"economic","language":"en"}');
  }
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => exec(process.execPath, [binary, ...args], { cwd: project, env: { ...env, ...extra }, timeout: 15_000, maxBuffer: 1024 * 1024 });
  return { project, run, env, root };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('K1 real binary journeys', () => {
  it('reads effective config in three fixture projects, in human and JSON formats', async () => {
    for (const [kind, expected] of [['empty', 'performance'], ['global-only', 'balanced'], ['project-override', 'economic']] as const) {
      const f = await fixture(kind);
      expect((await f.run(['config', 'get', 'mode'])).stdout.trim()).toBe(expected);
      expect(JSON.parse((await f.run(['config', 'get', 'mode', '--json'])).stdout)).toBe(expected);
      expect(JSON.parse((await f.run(['config', 'get', '--json'])).stdout)).toMatchObject({ schema_version: 2, mode: expected });
      expect(JSON.parse((await f.run(['config', 'get', 'mode', '--json'], { DECKENT_MODE: 'balanced' })).stdout)).toBe('balanced');
    }
  });
  it('rejects legacy migration and aliases without altering config bytes', async () => {
    const f = await fixture('project-override'), path = join(f.project, '.deckent/config.json');
    const before = await readFile(path, 'utf8');
    await expect(f.run(['config', 'migrate', '--json'])).rejects.toMatchObject({ code: 2, stdout: '' });
    expect(await readFile(path, 'utf8')).toBe(before);
    await writeFile(path, '{"outputMode":"json"}');
    await expect(f.run(['config', 'get', '--json'])).rejects.toMatchObject({ code: 78, stdout: '' });
    expect(await readFile(path, 'utf8')).toBe('{"outputMode":"json"}');
  });
  it('wires platform, actual OS identity, tenant config, host sizing and Turkish output through doctor', async () => {
    const f = await fixture('project-override');
    const result = JSON.parse((await f.run(['doctor', '--json'])).stdout);
    expect(result).toMatchObject({ schemaVersion: 1, principal: { assurance: 'os-user', provenance: 'cli' }, tenant: { tenantId: 'local' }, status: 'ready' });
    expect(result.tenant).not.toHaveProperty('createdAt');
    expect(result.host.cpuCores).toBeGreaterThan(0); expect(result.host.recommendedMaxWorkers).toBeGreaterThan(0);
    expect((await f.run(['doctor'], { DECKENT_LANG: 'tr' })).stdout).toContain('Önerilen worker');
    expect((await f.run(['doctor', '--lang', 'tr'])).stdout).toContain('Bellek:');
  });
  it('returns usage=2/config=78 and keeps structured diagnostics on stderr', async () => {
    const f = await fixture('project-override');
    await expect(f.run(['config', 'get', 'missing', '--json'])).rejects.toMatchObject({ code: 2, stdout: '' });
    await writeFile(join(f.project, '.deckent/config.json'), '{"schema_version":99}');
    try { await f.run(['config', 'get', '--json']); expect.fail('must reject'); }
    catch (error) { expect(error).toMatchObject({ code: 78, stdout: '' }); expect(JSON.parse((error as { stderr: string }).stderr).code).toBe('CONFIG_VERSION_UNSUPPORTED'); }
  });
  it('reports tenant traversal as usage error instead of reading another tenant directory', async () => {
    const f = await fixture('empty');
    await expect(f.run(['doctor', '--json'], { DECKENT_TENANT_ID: '../outside' })).rejects.toMatchObject({ code: 2, stdout: '' });
  });
  it('enforces strict tenant claims in the real ingress only when the flag is enabled', async () => {
    const f = await fixture('project-override');
    await writeFile(join(f.project, '.deckent/config.json'), '{"strict_tenant_isolation":true}');
    await expect(f.run(['doctor', '--json'])).rejects.toMatchObject({ code: 2, stdout: '' });
    const admitted = JSON.parse((await f.run(['doctor', '--json'], { DECKENT_TENANT_ID: 'explicit-tenant' })).stdout);
    expect(admitted.principal.tenantId).toBe('explicit-tenant');
  });
  it('registers the provider limit section before loading CLI config and rejects project-only authority', async () => {
    const f = await fixture('project-override');
    await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ provider_limits: { schemaVersion: 1, policies: [{ selector: { tenantId: 'local' }, values: { warnAtRatio: 0.5, blockAtRatio: 0.8 } }] } }));
    await expect(f.run(['config', 'get', '--json'])).rejects.toMatchObject({ code: 78, stdout: '' });
  });
  it('renders errors using the effective config locale and lets explicit language override it', async () => {
    const f = await fixture('global-only');
    await expect(f.run(['config', 'get', 'absent'])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('Bilinmeyen config anahtarı') });
    await expect(f.run(['config', 'get', 'absent', '--lang', 'en'])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('Unknown configuration key') });
    await expect(f.run(['config', 'get', 'absent', '--lang', 'tr', '--json'])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('Bilinmeyen config anahtarı') });
  });
});


describe('K1 blocking review reproductions', () => {
  it('never exposes a resolved secret value in full, subtree or projected human/JSON config output', async () => {
    const f = await fixture('project-override'), secret = 'supersecret-value-42';
    Object.assign(f.env, { API_TOKEN: secret });
    await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ providers: { brain: '$DECK:API_TOKEN', overrides: { sample: '$DECK:API_TOKEN' } } }));
    for (const key of [undefined, 'providers', 'providers.brain', 'providers.overrides.sample']) {
      for (const format of [[], ['--json']]) {
        const result = await f.run(['config', 'get', ...(key ? [key] : []), ...format]);
        expect(result.stdout + result.stderr).not.toContain(secret);
        expect(result.stdout).toContain('[REDACTED]');
        if (format.length) expect(() => JSON.parse(result.stdout)).not.toThrow();
      }
    }
  });
  it('recovers after a real writer process crashes and emits the typed warning on stderr', async () => {
    const f = await fixture('project-override'), path = join(f.project, '.deckent/config.json');
    const module = new URL('../../dist/kernel/index.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `const {withConfigWriteLock}=await import(${JSON.stringify(module)}); await withConfigWriteLock(process.argv[1],async()=>{process.stdout.write('ready');await new Promise(()=>setInterval(()=>{},1000));});`, path],
    { cwd: f.project, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    try {
      await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error('writer exited before taking lock'); })]);
      child.kill('SIGKILL'); await closed;
      await writeFile(path, '{broken');
      const result = await f.run(['config', 'get', '--json']);
      expect(JSON.parse(result.stdout)).toMatchObject({ schema_version: 2 });
      expect(result.stderr.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ code: 'CONFIG_LOCK_STALE_RECLAIMED' }));
      expect(JSON.parse(await readFile(path, 'utf8')).schema_version).toBe(2);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
  });
  it('returns actionable structured diagnostics for an old live lock without stealing it', async () => {
    const f = await fixture('project-override'), lock = join(f.project, '.deckent/config.json.write-lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 3600_000).toISOString() }));
    await writeFile(join(f.project, '.deckent/config.json'), '{broken');
    try { await f.run(['config', 'get', '--json']); expect.fail('live writer must block'); }
    catch (error) {
      expect(error).toMatchObject({ code: 78, stdout: '' });
      expect(JSON.parse((error as { stderr: string }).stderr)).toMatchObject({ code: 'CONFIG_WRITE_LOCKED', params: { path: lock, pid: process.pid, ageSeconds: expect.any(Number) } });
    }
    expect(JSON.parse(await readFile(lock, 'utf8')).pid).toBe(process.pid);
  });
  it('keeps separate writer processes mutually exclusive during stale recovery', async () => {
    const f = await fixture('project-override'), path = join(f.project, '.deckent/config.json');
    const dead = await exec(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    await writeFile(`${path}.write-lock`, JSON.stringify({ pid: Number(dead.stdout) }));
    const module = new URL('../../dist/kernel/index.js', import.meta.url).href;
    const witness = join(f.project, 'active-writer');
    const script = `const {withConfigWriteLock}=await import(${JSON.stringify(module)});
      const {open,unlink}=await import('node:fs/promises');
      await withConfigWriteLock(process.argv[1],async()=>{
        const f=await open(process.argv[2],'wx');
        await new Promise(r=>setTimeout(r,25)); await f.close(); await unlink(process.argv[2]);
      });`;
    await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath, ['--input-type=module', '-e', script, path, witness], { cwd: f.project, env: f.env, timeout: 10_000 })));
    expect((await readdir(join(f.project, '.deckent'))).filter(name => name.includes('.stale-'))).toHaveLength(1);
  });

});
