import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const exec = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const sdk = resolve('dist/index.js');
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { startTestRuntimeService } from '../support/runtime-service.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-query-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data, resources: { policy: 'access.json', ledger: 'state/custom.db' } } }));
  const options = { env: { HOME: join(root, 'home') } };
  async function policy(ids: string[]) {
    await mkdir(data, { recursive: true, mode: 0o700 });
    await writeFile(join(data, 'access.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: ids.length ? [
      { id: 'read', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'run', ids } },
    ] : [] }), { mode: 0o600 });
  }
  await startTestRuntimeService(project, options.env);
  return { project, data, options, policy };
}
describe.skipIf(process.platform === 'win32')('compiled Run CLI and SDK', () => {
  it('returns the same RunView and honestly labels stored state in Turkish pipe output', async () => {
    const f = await fixture(); const { store } = await openConfiguredAttemptStore(f.project, f.options);
    try { await admitRunAttempts(store, [{ runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }]); } finally { store.close(); }
    await f.policy(['r', 'missing']);
    const options = { cwd: f.project, env: { ...process.env, ...f.options.env, NO_COLOR: '1' } };
    const args = ['run', 'inspect', '--scope', 's', '--id', 'r'];
    const cliResult = await exec(process.execPath, [cli, ...args, '--json'], options);
    const sdkResult = await exec(process.execPath, ['--input-type=module', '-e',
      "const {inspectRun}=await import(process.argv[1]); console.log(JSON.stringify(await inspectRun(process.cwd(),{schemaVersion:1,scopeId:'s',runId:'r'})))", sdk], options);
    expect(JSON.parse(cliResult.stdout)).toEqual(JSON.parse(sdkResult.stdout));
    expect(JSON.parse(cliResult.stdout).run.tasks[0].phase).toBe('active');
    const human = await exec(process.execPath, [cli, ...args, '--lang', 'tr'], options);
    expect(human.stdout).toContain('canlı durum değil'); expect(human.stdout).toContain('Etkin'); expect(human.stdout).not.toContain('\u001b[');
    const english = await exec(process.execPath, [cli, ...args, '--lang', 'en'], options);
    expect(english.stdout).toContain('recorded revision'); expect(english.stdout).toContain('Cancellation: no request recorded.');
    const missingHuman = await exec(process.execPath, [cli, 'run', 'inspect', '--scope', 's', '--id', 'missing', '--lang', 'en'], options);
    expect(missingHuman.stdout).toContain('No recorded Run found: missing');
    const absent = await exec(process.execPath, [cli, 'run', 'inspect', '--scope', 's', '--id', 'missing', '--json'], options);
    expect(JSON.parse(absent.stdout).run).toBeNull();
    await f.policy([]); await expect(exec(process.execPath, [cli, ...args, '--json'], options)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('POLICY_DENIED') });
    await expect(exec(process.execPath, [cli, ...args, '--id', 'duplicate'], options)).rejects.toMatchObject({ code: 2 });
    await expect(exec(process.execPath, [cli, 'run', 'cancel'], options)).rejects.toMatchObject({ code: 2 });
  });
});
