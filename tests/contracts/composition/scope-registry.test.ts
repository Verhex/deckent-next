import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { createConfiguredRuntimeClient, inspectRun, requestRunCancellation } from '../../../src/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles } from '../support/custody.js';
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
async function fixture(config: Record<string, unknown> = {}, grants: readonly unknown[] = [inspectAll, spendAll], prepare?: (ledger: string) => void, start = true) {
  const project = await mkdtemp(join(tmpdir(), 'deckent-scope-registry-')); roots.push(project);
  const data = join(project, 'data'); await mkdir(join(project, '.deckent'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = cliChildEnv({ HOME: join(project, 'home'), DECKENT_LANGUAGE: 'en', NO_COLOR: '1' }); delete env.DECKENT_HOME;
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, inspection: { maxPageSize: 4, policyMaxBytes: 65536 }, ...config }));
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants }), { mode: 0o600 });
  prepare?.(opened.path);
  if (start) await startTestRuntimeService(project, env);
  return { project, data, env, ledger: opened.path };
}
async function cliFailure(f: { project: string; env: NodeJS.ProcessEnv }, args: readonly string[]) {
  try { await exec(process.execPath, [binary, ...args, '--json'], { cwd: f.project, env: f.env }); }
  catch (error) { const failure = error as { code: number; stdout: string; stderr: string }; return { exit: failure.code, stdout: failure.stdout, code: JSON.parse(failure.stderr).code }; }
  throw new Error('expected failure');
}

describe.skipIf(process.platform === 'win32')('fail-closed scope registry on real surfaces', () => {
  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] refuses a fabricated scope reached only through a `scopes: all` grant on CLI --scope and the SDK', async () => {
    const f = await fixture();
    expect(await cliFailure(f, ['inventory', '--scope', 'fabricated'])).toEqual({ exit: 1, stdout: '', code: 'SCOPE_UNKNOWN' });
    expect(await cliFailure(f, ['run', 'inspect', '--scope', 'fabricated', '--id', 'r'])).toEqual({ exit: 1, stdout: '', code: 'SCOPE_UNKNOWN' });
    const library = await exec(process.execPath, ['--input-type=module', '-e', `import {inspectInventory} from ${JSON.stringify(sdk)};
      try { await inspectInventory(process.cwd(), {schemaVersion:1,scopeId:'fabricated'}); console.log('admitted'); } catch (error) { console.log(error.code); }`],
    { cwd: f.project, env: f.env });
    expect(library.stdout.trim()).toBe('SCOPE_UNKNOWN');
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] refuses a fabricated scope on the runtime socket peer path', async () => {
    const f = await fixture();
    const client = createConfiguredRuntimeClient(f.project, { env: f.env });
    await expect(client.inspectProviderSpendAccount({ schemaVersion: 1, scopeId: 'fabricated', budgetId: 'b', budgetRevision: 1 }))
      .rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] registers the default company and the installation\'s own scopes at first start, so `all` reaches them and nothing else', async () => {
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

  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] keeps the solo default: a scope named by the trusted policy needs no extra step and gives `all` no reach beyond it', async () => {
    const named = { ...inspectAll, id: 'named', scopes: ['s'], resource: { kind: 'scope', ids: ['s'] } };
    const f = await fixture({}, [named, inspectAll]);
    const inventory = await exec(process.execPath, [binary, 'inventory', '--scope', 's', '--json'], { cwd: f.project, env: f.env });
    expect(JSON.parse(inventory.stdout).page).toEqual({ entries: [], nextAfter: null });
    expect(await cliFailure(f, ['inventory', '--scope', 'other'])).toEqual({ exit: 1, stdout: '', code: 'SCOPE_UNKNOWN' });
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] refuses to start when the trusted policy names a scope already pinned to another company; grants on it have no effect, and a fresh installation for that company reaches it normally', async () => {
    const named = { ...inspectAll, id: 'named', scopes: ['s'], resource: { kind: 'scope', ids: ['s'] } };
    // Pinned before the first start (as by an earlier start configured for company `other`). `s` is one of THIS installation's own
    // declared scopes (the trusted policy names it), so decision 6 (H34 S3 Q1, owner 2026-09-27 evening) now refuses the start
    // itself — a stronger guarantee than the old "starts, then fails closed per request" (grants on it still have no effect either
    // way; the start never re-homes the pin).
    const pinOther = (ledger: string) => { const db = new DatabaseSync(ledger);
      try { db.exec("INSERT INTO companies(company_id) VALUES('other'); INSERT INTO scope_registry(scope_id,company_id,origin) VALUES('s','other','start');"); }
      finally { db.close(); } };
    const f = await fixture({}, [named], pinOther, false);
    const pins = new DatabaseSync(f.ledger, { readOnly: true });
    try { expect(pins.prepare("SELECT company_id FROM scope_registry WHERE scope_id='s'").all()).toEqual([{ company_id: 'other' }]); } finally { pins.close(); }
    await expect(startTestRuntimeService(f.project, f.env)).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_SCOPE_FOREIGN' });
    // The same pin is a fresh installation's own scope when it is configured for that company from its own first start (not the
    // same installation with `company.id` changed afterward — decision 6 refuses exactly that above).
    const g = await fixture({ company: { id: 'other' } }, [named], pinOther);
    const inventory = await exec(process.execPath, [binary, 'inventory', '--scope', 's', '--json'], { cwd: g.project, env: g.env });
    expect(JSON.parse(inventory.stdout).page).toEqual({ entries: [], nextAfter: null });
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] still answers POLICY_DENIED before touching the ledger when no grant covers the scope', async () => {
    const f = await fixture({}, []);
    expect(await cliFailure(f, ['inventory', '--scope', 'fabricated'])).toEqual({ exit: 1, stdout: '', code: 'POLICY_DENIED' });
  });

  // Astra 2122: a declared scope is pinned durably at its first admission, before any scoped record, and never re-homed.
  const named = (scope: string) => ({ ...inspectAll, id: `named-${scope}`, scopes: [scope], resource: { kind: 'scope', ids: 'all' } });
  const runNamed = (scope: string) => ({ id: `run-${scope}`, effect: 'allow', actions: ['inspect'], scopes: [scope], principals: [actor], resource: { kind: 'run', ids: 'all' } });
  // A write admission (cancellation request of a Run that does not exist): membership pins before the application refuses it.
  const cancel = (f: { project: string; env: NodeJS.ProcessEnv }, scopeId: string) => requestRunCancellation(f.project,
    { schemaVersion: 1, scopeId, runId: 'absent', commandId: 'cancel', action: 'cancel', expectedRevision: 0 }, { env: f.env }).catch(() => undefined);
  const pins = (ledger: string) => { const db = new DatabaseSync(ledger, { readOnly: true });
    try { return db.prepare('SELECT scope_id,company_id,origin FROM scope_registry ORDER BY scope_id').all(); } finally { db.close(); } };

  it('pins a declared scope durably at its first direct SDK write admission, before any service start; reads never write', async () => {
    const f = await fixture({}, [named('s'), runNamed('s')], undefined, false);
    expect(pins(f.ledger)).toEqual([]);
    expect(await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'absent' }, { env: f.env })).toMatchObject({ run: null });
    expect(pins(f.ledger)).toEqual([]);
    await cancel(f, 's');
    expect(pins(f.ledger)).toEqual([{ scope_id: 's', company_id: 'default', origin: 'admission' }]);
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] pins a scope added to the policy after the service started at its first CLI use', async () => {
    const f = await fixture({}, [named('s')]);
    await writeFile(join(f.data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p2', restrictions: [], grants: [named('s'), named('late')] }), { mode: 0o600 });
    expect(pins(f.ledger)).toEqual([{ scope_id: 'runtime-test', company_id: 'default', origin: 'start' }, { scope_id: 's', company_id: 'default', origin: 'start' }]);
    const inventory = await exec(process.execPath, [binary, 'inventory', '--scope', 'late', '--json'], { cwd: f.project, env: f.env });
    expect(JSON.parse(inventory.stdout).page).toEqual({ entries: [], nextAfter: null });
    expect(pins(f.ledger).map(row => row.scope_id)).toEqual(['runtime-test', 's']);
    await exec(process.execPath, [binary, 'run', 'cancel', '--scope', 'late', '--id', 'absent', '--command-id', 'c', '--expected-revision', '0', '--json'],
      { cwd: f.project, env: f.env }).catch(() => undefined);
    expect(pins(f.ledger)).toContainEqual({ scope_id: 'late', company_id: 'default', origin: 'admission' });
  });

  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] refuses to start, never re-homes, when company.id changes to a company foreign to an already-pinned own scope; records written before stay under the original company', async () => {
    const f = await fixture({}, [named('s'), runNamed('s')], undefined, false);
    await cancel(f, 's');
    const store = await openSqliteAttemptStore(f.ledger, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    try { await admitRunAttempts(store, [{ runId: 'r', taskId: 'a', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'layout' }]); }
    finally { store.close(); }
    const path = join(f.project, '.deckent/config.json');
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), company: { id: 'acme' } })); clearConfigCache();
    // `s` is one of this installation's own declared scopes and is already pinned to `default`: decision 6 (H34 S3 Q1, owner
    // 2026-09-27 evening) now refuses the start itself instead of starting and failing closed on every later request.
    await expect(startTestRuntimeService(f.project, f.env)).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_SCOPE_FOREIGN' });
    await expect(inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, { env: f.env })).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
    const db = new DatabaseSync(f.ledger, { readOnly: true });
    try {
      expect(db.prepare("SELECT company_id,origin FROM scope_registry WHERE scope_id='s'").all()).toEqual([{ company_id: 'default', origin: 'admission' }]);
      expect(db.prepare("SELECT DISTINCT r.company_id FROM runs JOIN scope_registry r USING(scope_id) WHERE runs.scope_id='s'").all()).toEqual([{ company_id: 'default' }]);
    } finally { db.close(); }
  });
});
