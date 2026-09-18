import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requestRunCancellation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { clearConfigCache } from '#platform/index.js';
const exec = promisify(execFile); const binary = resolve('dist/composition/core/cli/internal/entry.js'); const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-cli-cancel-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
  const env = { ...process.env, HOME: join(root, 'home'), NO_COLOR: '1', TERM: 'dumb' }; const options = { env };
  const { store } = await openConfiguredAttemptStore(project, options); try { await admitRunAttempts(store, [identity]); } finally { store.close(); }
  async function policy(allowed: boolean) {
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: allowed ? [
      { id: 'cancel', effect: 'allow', actions: ['cancel', 'inspect'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'run', ids: ['r'] } },
    ] : [] }), { mode: 0o600 });
  }
  await policy(true);
  const args = ['run', 'cancel', '--scope', 's', '--id', 'r', '--command-id', 'cancel', '--expected-revision', '1'];
  return { project, options, policy, args, run: (extra: string[]) => exec(process.execPath, [binary, ...args, ...extra], { cwd: project, env }) };
}
describe.skipIf(process.platform === 'win32')('real CLI cancellation-intent surface', () => {
  it('matches SDK JSON and records bound Attempt intent without claiming worker termination', async () => {
    const f = await fixture(); const cli = await f.run(['--json']); expect(cli.stderr).toBe(''); expect(cli.stdout).not.toContain('\u001b');
    const sdk = await requestRunCancellation(f.project, { schemaVersion: 1, commandId: 'cancel', action: 'cancel', scopeId: 's', runId: 'r', expectedRevision: 1 }, f.options);
    expect(JSON.parse(cli.stdout)).toEqual(sdk); expect(sdk.cancellation.run.cancellationRequested).toBe(true);
    expect(sdk.cancellation.run.tasks[0]!.phase).toBe('active');
    const { store } = await openConfiguredAttemptStore(f.project, f.options);
    try { expect((await store.load('s', 'a'))!.cancelRequested).toBe(true); } finally { store.close(); }
  });
  it('prints truthful EN/TR text on dumb redirected terminals and denies replay after authority removal', async () => {
    const f = await fixture(); const en = await f.run(['--lang', 'en']); const tr = await f.run(['--lang', 'tr']);
    expect(en.stdout).toContain('cancellation request recorded'); expect(en.stdout).toContain('does not confirm worker termination'); expect(en.stdout).toContain('does not deliver cancellation');
    expect(tr.stdout).toContain('iptal isteği'); expect(tr.stdout).toContain('durduğunu doğrulamaz'); expect(tr.stdout).toContain('worker’lara iletmez'); expect(tr.stdout).not.toContain('\u001b');
    await f.policy(false); await expect(f.run(['--json'])).rejects.toMatchObject({ code: 1 });
  });
  it('rejects duplicate and ambiguous revision flags before issuing intent', async () => {
    const f = await fixture(); await expect(f.run(['--expected-revision', '2'])).rejects.toMatchObject({ code: 2 });
    const command = [...f.args]; command[command.length - 1] = '1e0';
    await expect(exec(process.execPath, [binary, ...command], { cwd: f.project, env: f.options.env })).rejects.toMatchObject({ code: 2 });
    const { store } = await openConfiguredAttemptStore(f.project, f.options);
    try { expect((await store.loadRun('s', 'r'))!.cancelRequested).toBe(false); } finally { store.close(); }
  });
});
