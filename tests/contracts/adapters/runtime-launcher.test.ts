import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { launchDetachedRuntimeService } from '#adapters/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('WAIT_TIMEOUT');
}

it('starts `<entry> runtime serve` detached in its own session with no stdin and a private append-only log (requires Linux /proc session identity)', async context => {
  if (process.platform !== 'linux') context.skip('LINUX_PROCESS_SESSION_UNAVAILABLE: detached session identity proof needs /proc/self/stat');
  const root = await mkdtemp(join(tmpdir(), 'dn-launch-')); roots.push(root);
  const entry = join(root, 'entry.mjs'), logPath = join(root, 'service.log');
  // The fake entry reports what it was started with, then exits; a real service would keep running.
  await writeFile(entry, `import { readFileSync } from 'node:fs';
const stat = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), marker: process.env.MARKER, pid: process.pid, sid: Number(stat[3]) }) + '\\n');`);
  await writeFile(logPath, 'previous line\n', { mode: 0o600 });
  const { pid } = await launchDetachedRuntimeService({ executable: process.execPath, entry, cwd: root, logPath, env: { MARKER: 'm', PATH: process.env['PATH'] ?? '' } });
  await waitFor(async () => (await readFile(logPath, 'utf8')).includes('"argv"'));
  const [previous, line] = (await readFile(logPath, 'utf8')).trim().split('\n');
  expect(previous).toBe('previous line');
  expect(JSON.parse(line!)).toEqual({ argv: ['runtime', 'serve'], cwd: root, marker: 'm', pid, sid: pid });
  expect((await stat(logPath)).mode & 0o777).toBe(0o600);
});

it('refuses relative paths and a symlinked log before starting anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-launch-')); roots.push(root);
  const entry = join(root, 'entry.mjs'), target = join(root, 'elsewhere.log'), link = join(root, 'service.log');
  await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'ran'))}, '1');`);
  await expect(launchDetachedRuntimeService({ executable: 'node', entry, cwd: root, logPath: link, env: {} }))
    .rejects.toMatchObject({ code: 'RUNTIME_LAUNCH_INVALID' });
  if (process.platform === 'win32') {
    await expect(launchDetachedRuntimeService({ executable: process.execPath, entry, cwd: root, logPath: link, env: {} }))
      .rejects.toMatchObject({ code: 'RUNTIME_LAUNCH_UNSUPPORTED' });
    await expect(stat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, 'ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    return;
  }
  await writeFile(target, ''); await symlink(target, link);
  await expect(launchDetachedRuntimeService({ executable: process.execPath, entry, cwd: root, logPath: link, env: {} }))
    .rejects.toMatchObject({ code: 'RUNTIME_LAUNCH_FAILED' });
  await expect(stat(join(root, 'ran'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('Windows detached launch refuses before log creation or process launch (native on Windows; simulated guard elsewhere)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-launch-refusal-')); roots.push(root);
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
    await expect(launchDetachedRuntimeService({ executable: process.execPath, entry: join(root, 'missing.mjs'), cwd: root, logPath: join(root, 'log'), env: {} }))
      .rejects.toMatchObject({ code: 'RUNTIME_LAUNCH_UNSUPPORTED' });
    await expect(stat(join(root, 'log'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { Object.defineProperty(process, 'platform', original); }
});
