import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ensureConfiguredRuntimeService } from '../../../src/composition/core/cli/index.js';
import { clearConfigCache } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(terminal: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-autostart-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal }), { mode: 0o600 });
  return { project, data, options: { env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), DECKENT_GLOBAL_HOME: join(home, 'global') } } };
}

it('treats a fresh project without a state directory as no service, launches once and fails typed with the private log path when none becomes ready in time', async () => {
  const f = await fixture({ serviceStartTimeoutMs: 1_000 });
  const launches: Array<{ entry: string; cwd: string; logPath: string }> = [];
  const started = Date.now();
  const error = await ensureConfiguredRuntimeService(f.project, f.options, async input => { launches.push(input); return { pid: 1 }; },
    fileURLToPath(import.meta.url)).catch(value => value);
  expect(error).toMatchObject({ code: 'RUNTIME_AUTOSTART_FAILED', params: { log: join(f.data, 'state/runtime-service.log') } });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(launches).toHaveLength(1);
  expect(launches[0]).toMatchObject({ cwd: f.project, logPath: join(f.data, 'state/runtime-service.log') });
  expect((await stat(launches[0]!.logPath)).mode & 0o777).toBe(0o600);
});

it('never starts a service over an endpoint that fails ownership checks', async () => {
  const f = await fixture();
  await mkdir(join(f.data, 'state'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.data, 'state/runtime.sock'), 'not a socket', { mode: 0o600 });
  let launched = 0;
  await expect(ensureConfiguredRuntimeService(f.project, f.options, async () => { launched++; return { pid: 1 }; })).rejects.toMatchObject({ code: expect.stringMatching(/UNSAFE/) });
  expect(launched).toBe(0);
});
