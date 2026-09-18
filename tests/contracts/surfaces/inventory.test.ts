import { admitRunAttempts } from '../support/admission.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { clearConfigCache, resolveGlobalConfigPaths } from '#platform/index.js';
import { custodyProfiles, custodyPrincipal, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
import { startTestRuntimeService } from '../support/runtime-service.js';
const exec = promisify(execFile); const roots: string[] = [];
const binary = resolve('dist/composition/core/cli/internal/entry.js'); const sdk = pathToFileURL(resolve('dist/index.js')).href;
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'deckent-inventory-surface-')); roots.push(project);
  const data = join(project, 'data'); await mkdir(join(project, '.deckent'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(project, 'home'), DECKENT_LANGUAGE: 'en', NO_COLOR: '1' }; delete env.DECKENT_HOME;
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, inspection: { maxPageSize: 1, policyMaxBytes: 65536 } }));
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles);
  try {
    const identities = ['a', 'b'].map(attemptId => ({ runId: 'r', taskId: attemptId, attemptId, scopeId: 's', generation: 1, layoutRevision: opened.layout.revision }));
    await admitRunAttempts(store, identities);
    for (const identity of identities) {
      await store.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: '/secret-path', argv: ['private-token'] } }));
    }
  } finally { store.close(); }
  const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [{ id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'],
    principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'scope', ids: ['s'] } }] };
  await writeFile(join(data, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
  const configPath = join(project, '.deckent/config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')); config.provider_limits = { schemaVersion: 1, policies: [] };
  await writeFile(configPath, JSON.stringify(config));
  const globalPath = resolveGlobalConfigPaths(env).platformPath; await mkdir(dirname(globalPath), { recursive: true, mode: 0o700 });
  await writeFile(globalPath, JSON.stringify({ provider_limits: config.provider_limits }));
  await startTestRuntimeService(project, env);
  return { project, data, env, ledgerPath: opened.path, layoutRevision: opened.layout.revision };
}
describe.skipIf(process.platform === 'win32')('shipped inventory CLI and SDK', () => {
  it('returns identical versioned JSON through CLI and SDK, defaults to configured page budget and follows cursors', async () => {
    const f = await fixture(); const options = { cwd: f.project, env: f.env };
    const cli = await exec(process.execPath, [binary, 'inventory', '--scope', 's', '--json'], options);
    const library = await exec(process.execPath, ['--input-type=module', '-e', `import {inspectInventory} from ${JSON.stringify(sdk)}; console.log(JSON.stringify(await inspectInventory(process.cwd(), {schemaVersion:1,scopeId:'s'})));`], options);
    expect(JSON.parse(cli.stdout)).toEqual(JSON.parse(library.stdout));
    const result = JSON.parse(cli.stdout); expect(result.schemaVersion).toBe(1); expect(result.page.entries).toHaveLength(1); expect(result.page.nextAfter).toBe('a');
    expect(result.page.entries[0]).toMatchObject({ launch: 'pending', terminal: null });
    expect(cli.stdout).not.toContain('private-token'); expect(cli.stdout).not.toContain('secret-path'); expect(cli.stdout).not.toContain('\x1b');
    const next = await exec(process.execPath, [binary, 'inventory', '--scope', 's', '--after', result.page.nextAfter, '--json'], options);
    expect(JSON.parse(next.stdout).page.entries[0].identity.attemptId).toBe('b');
    const empty = await exec(process.execPath, [binary, 'inventory', '--scope', 's', '--after', 'b', '--json'], options);
    expect(JSON.parse(empty.stdout).page).toEqual({ entries: [], nextAfter: null });
    const human = await exec(process.execPath, [binary, 'inventory', '--scope', 's', '--lang', 'tr'], options);
    expect(human.stdout).toContain('Başlatma izni bekliyor'); expect(human.stdout).toContain('canlı durum'); expect(human.stdout).not.toContain('\x1b');
  });
  it('renders a durably prevented launch through CLI inventory without exposing private custody data', async () => {
    const f = await fixture(); const identity = { runId: 'r', taskId: 'a', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: f.layoutRevision };
    const request = { protocolVersion: 1 as const, identity, workspace: '/secret-path', argv: ['private-token'] };
    const claim = { owner: 'worker', request };
    const store = await openSqliteAttemptStore(f.ledgerPath, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles);
    try {
      await store.requestDispatchCancellation(request, custodyPrincipal);
      expect(await grantTestLaunch(store, claim)).toMatchObject({ kind: 'prevented', record: { launch: 'prevented-before-launch' } });
    } finally { store.close(); }
    const options = { cwd: f.project, env: f.env };
    const json = await exec(process.execPath, [binary, 'inventory', '--scope', 's', '--json'], options);
    expect(JSON.parse(json.stdout).page.entries[0]).toMatchObject({ identity, launch: 'prevented-before-launch', terminal: null, cancellationRequested: true });
    expect(json.stdout).not.toContain('private-token'); expect(json.stdout).not.toContain('secret-path'); expect(json.stdout).not.toContain('strict-custody-profile');
    const human = await exec(process.execPath, [binary, 'inventory', '--scope', 's'], options);
    expect(human.stdout).toContain('Launch prevented before permission was granted'); expect(human.stdout).not.toContain('terminal result not recorded');
  });
  it('returns typed denial and usage errors on stderr without crash artifacts', async () => {
    const f = await fixture(); const options = { cwd: f.project, env: f.env };
    for (const [args, expectedCode, exit] of [
      [['--scope', 'other'], 'POLICY_DENIED', 1], [['--scope', 's', '--limit', '2'], 'DISPATCH_INVENTORY_LIMIT', 2],
      [['--scope', 's', '--limit', '-1'], 'CLI_USAGE', 2], [['--scope', 's', '--scope', 'other'], 'CLI_USAGE', 2],
    ] as const) {
      try { await exec(process.execPath, [binary, 'inventory', ...args, '--json'], options); throw new Error('expected failure'); }
      catch (error) {
        const failure = error as { code: number; stdout: string; stderr: string }; expect(failure.code).toBe(exit); expect(failure.stdout).toBe('');
        expect(JSON.parse(failure.stderr).code).toBe(expectedCode);
      }
    }
    await expect(stat(join(f.data, 'crashes'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(f.project, '.deckent/crashes'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
