import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { createConfiguredRuntimeClient } from '../../../src/index.js';
import { clearConfigCache } from '#platform/index.js';
import { cliChildEnv } from '../support/child-env.js';
import { startTestRuntimeService } from '../support/runtime-service.js';

const exec = promisify(execFile); const roots: string[] = [];
const binary = resolve('dist/composition/core/cli/internal/entry.js'); const sdk = pathToFileURL(resolve('dist/index.js')).href;
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { issuer: hostname(), subject: String(userInfo().uid) };
const inspectAll = { id: 'inspect-all', effect: 'allow', actions: ['inspect'], scopes: 'all', principals: [actor], resource: { kind: 'scope', ids: 'all' } };
const spendAll = { id: 'spend-all', effect: 'allow', actions: ['inspect'], scopes: 'all', principals: [actor], resource: { kind: 'provider-spend-account', ids: 'all' } };

/** A solo project whose trusted policy grants only `scopes: 'all'`; the ledger exists (as after installation) and the local
 * runtime service is started once (CLI inventory reaches the service over the socket). */
async function fixture(config: Record<string, unknown> = {}, grants: readonly unknown[] = [inspectAll, spendAll], prepare?: (ledger: string) => void) {
  const project = await mkdtemp(join(tmpdir(), 'deckent-scope-registry-')); roots.push(project);
  const data = join(project, 'data'); await mkdir(join(project, '.deckent'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = cliChildEnv({ HOME: join(project, 'home'), DECKENT_LANGUAGE: 'en', NO_COLOR: '1' }); delete env.DECKENT_HOME;
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, inspection: { maxPageSize: 4, policyMaxBytes: 65536 }, ...config }));
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants }), { mode: 0o600 });
  prepare?.(opened.path);
  await startTestRuntimeService(project, env);
  return { project, data, env, ledger: opened.path };
}
async function cliFailure(f: { project: string; env: NodeJS.ProcessEnv }, args: readonly string[]) {
  try { await exec(process.execPath, [binary, ...args, '--json'], { cwd: f.project, env: f.env }); }
  catch (error) { const failure = error as { code: number; stdout: string; stderr: string }; return { exit: failure.code, stdout: failure.stdout, code: JSON.parse(failure.stderr).code }; }
  throw new Error('expected failure');
}

describe.skipIf(process.platform === 'win32')('fail-closed scope registry on real surfaces', () => {
  it('refuses a fabricated scope reached only through a `scopes: all` grant on CLI --scope and the SDK', async () => {
    const f = await fixture();
    expect(await cliFailure(f, ['inventory', '--scope', 'fabricated'])).toEqual({ exit: 1, stdout: '', code: 'SCOPE_UNKNOWN' });
    expect(await cliFailure(f, ['run', 'inspect', '--scope', 'fabricated', '--id', 'r'])).toEqual({ exit: 1, stdout: '', code: 'SCOPE_UNKNOWN' });
    const library = await exec(process.execPath, ['--input-type=module', '-e', `import {inspectInventory} from ${JSON.stringify(sdk)};
      try { await inspectInventory(process.cwd(), {schemaVersion:1,scopeId:'fabricated'}); console.log('admitted'); } catch (error) { console.log(error.code); }`],
    { cwd: f.project, env: f.env });
    expect(library.stdout.trim()).toBe('SCOPE_UNKNOWN');
  });

  it('refuses a fabricated scope on the runtime socket peer path', async () => {
    const f = await fixture();
    const client = createConfiguredRuntimeClient(f.project, { env: f.env });
    await expect(client.inspectProviderSpendAccount({ schemaVersion: 1, scopeId: 'fabricated', budgetId: 'b', budgetRevision: 1 }))
      .rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
  });

  it('registers the default company and the installation\'s own scopes at first start, so `all` reaches them and nothing else', async () => {
    const f = await fixture({ service: { identity: { scopeId: 'own', serviceId: 'svc' } } });
    const db = new DatabaseSync(f.ledger, { readOnly: true });
    try {
      expect(db.prepare('SELECT company_id FROM companies').all()).toEqual([{ company_id: 'default' }]);
      expect(db.prepare('SELECT scope_id,company_id,origin FROM scope_registry ORDER BY scope_id').all()).toEqual([
        { scope_id: 'own', company_id: 'default', origin: 'start' }, { scope_id: 'runtime-test', company_id: 'default', origin: 'start' }]);
    } finally { db.close(); }
    const inventory = await exec(process.execPath, [binary, 'inventory', '--scope', 'own', '--json'], { cwd: f.project, env: f.env });
    expect(JSON.parse(inventory.stdout).page).toEqual({ entries: [], nextAfter: null });
    const client = createConfiguredRuntimeClient(f.project, { env: f.env });
    expect(await client.inspectProviderSpendAccount({ schemaVersion: 1, scopeId: 'own', budgetId: 'b', budgetRevision: 1 }))
      .toMatchObject({ scopeId: 'own', checkpoint: null });
    expect(await cliFailure(f, ['inventory', '--scope', 'fabricated'])).toEqual({ exit: 1, stdout: '', code: 'SCOPE_UNKNOWN' });
  });

  it('keeps the solo default: a scope named by the trusted policy needs no extra step and gives `all` no reach beyond it', async () => {
    const named = { ...inspectAll, id: 'named', scopes: ['s'], resource: { kind: 'scope', ids: ['s'] } };
    const f = await fixture({}, [named, inspectAll]);
    const inventory = await exec(process.execPath, [binary, 'inventory', '--scope', 's', '--json'], { cwd: f.project, env: f.env });
    expect(JSON.parse(inventory.stdout).page).toEqual({ entries: [], nextAfter: null });
    expect(await cliFailure(f, ['inventory', '--scope', 'other'])).toEqual({ exit: 1, stdout: '', code: 'SCOPE_UNKNOWN' });
  });

  it('refuses a scope pinned to another company even when the trusted policy names it, and grants on it have no effect', async () => {
    const named = { ...inspectAll, id: 'named', scopes: ['s'], resource: { kind: 'scope', ids: ['s'] } };
    // Pinned before the first start (as by an earlier start configured for company `other`); the start never re-homes it.
    const f = await fixture({}, [named], ledger => {
      const db = new DatabaseSync(ledger);
      try { db.exec("INSERT INTO companies(company_id) VALUES('other'); INSERT INTO scope_registry(scope_id,company_id,origin) VALUES('s','other','start');"); }
      finally { db.close(); }
    });
    const pins = new DatabaseSync(f.ledger, { readOnly: true });
    try { expect(pins.prepare("SELECT company_id FROM scope_registry WHERE scope_id='s'").all()).toEqual([{ company_id: 'other' }]); } finally { pins.close(); }
    expect(await cliFailure(f, ['inventory', '--scope', 's'])).toEqual({ exit: 1, stdout: '', code: 'SCOPE_UNKNOWN' });
    // The same pin is the configured company's own scope once the installation is configured for that company.
    const path = join(f.project, '.deckent/config.json');
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), company: { id: 'other' } })); clearConfigCache();
    const inventory = await exec(process.execPath, [binary, 'inventory', '--scope', 's', '--json'], { cwd: f.project, env: f.env });
    expect(JSON.parse(inventory.stdout).page).toEqual({ entries: [], nextAfter: null });
  });

  it('still answers POLICY_DENIED before touching the ledger when no grant covers the scope', async () => {
    const f = await fixture({}, []);
    expect(await cliFailure(f, ['inventory', '--scope', 'fabricated'])).toEqual({ exit: 1, stdout: '', code: 'POLICY_DENIED' });
  });
});
