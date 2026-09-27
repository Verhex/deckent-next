import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { configuredApproval, createConfiguredRuntimeClient, inspectConfiguredOperation, inspectConfiguredWorkers, inspectModelActivation,
  inspectRun, requestRunCancellation } from '../../../src/index.js';
import { clearConfigCache } from '#platform/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';
import { cliChildEnv } from '../support/child-env.js';
import { startTestRuntimeService, stopTestRuntimeService } from '../support/runtime-service.js';

// H34 S3: company-aware authorization at every port. The one company rule (engine scope membership, H34 S1) decides every principal a
// port sees, for the requesting installation's company; a scope pinned to another company is refused as SCOPE_UNKNOWN on CLI, SDK and
// the runtime peer path, without naming the other company. The same company is unchanged.
const exec = promisify(execFile); const roots: string[] = [];
const binary = resolve('dist/composition/core/cli/internal/entry.js');
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { issuer: hostname(), subject: String(userInfo().uid) };
const kinds = ['scope', 'run', 'approval', 'model-activation', 'operation', 'provider-spend-account', 'attempt'] as const;
/** Every grant names `s` explicitly (a declared scope): only the company pin decides. */
const grants = (scope: string) => kinds.map(kind => ({ id: `${kind}-${scope}`, effect: 'allow', actions: 'all', scopes: [scope], principals: [actor],
  resource: { kind, ids: 'all' } }));
type Fixture = { project: string; data: string; env: NodeJS.ProcessEnv; ledger: string; configPath: string };

async function project(config: Record<string, unknown>, policy: unknown, pins: Record<string, string> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'deckent-company-authz-')); roots.push(root);
  const data = join(root, 'data'); await mkdir(join(root, '.deckent'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = cliChildEnv({ HOME: join(root, 'home'), DECKENT_LANGUAGE: 'en', NO_COLOR: '1' }); delete env.DECKENT_HOME;
  const configPath = join(root, '.deckent/config.json');
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, inspection: { maxPageSize: 4, policyMaxBytes: 65536 }, ...config }));
  const opened = await openConfiguredAttemptStore(root, { env }); opened.store.close();
  await writeFile(join(data, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
  const db = new DatabaseSync(opened.path);
  try {
    for (const [scope, company] of Object.entries(pins)) {
      db.prepare('INSERT OR IGNORE INTO companies(company_id) VALUES(?)').run(company);
      db.prepare("INSERT INTO scope_registry(scope_id,company_id,origin) VALUES(?,?,'start')").run(scope, company);
    }
  } finally { db.close(); }
  clearConfigCache();
  return { project: root, data, env, ledger: opened.path, configPath };
}
const v1 = (scope: string) => ({ schemaVersion: 1, revision: 'p', restrictions: [], grants: grants(scope) });
async function setCompany(f: Fixture, id: string) {
  await writeFile(f.configPath, JSON.stringify({ ...JSON.parse(await readFile(f.configPath, 'utf8')), company: { id } })); clearConfigCache();
}
async function cli(f: Fixture, args: readonly string[]) {
  try { return { exit: 0, stderr: '', value: JSON.parse((await exec(process.execPath, [binary, ...args, '--json'], { cwd: f.project, env: f.env })).stdout) }; }
  catch (error) { const failure = error as { code: number; stdout: string; stderr: string }; return { exit: failure.code, stderr: failure.stderr, code: JSON.parse(failure.stderr).code }; }
}
const codeOf = (work: Promise<unknown>) => work.then(() => 'admitted', (error: { code?: string }) => error.code ?? 'thrown');
const pinsOf = (ledger: string) => { const db = new DatabaseSync(ledger, { readOnly: true });
  try { return db.prepare('SELECT scope_id,company_id FROM scope_registry ORDER BY scope_id').all(); } finally { db.close(); } };
const reference = { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 };

describe.skipIf(process.platform === 'win32')('company-aware authorization at every port (H34 S3)', () => {
  it('refuses a worker source whose installation holds the scope for another company (CLI and SDK); the same company is unchanged', async () => {
    const target = await project({ company: { id: 'other' } }, v1('s'), { s: 'other' });
    // One admitted attempt of the other company's scope: the record a foreign request must never observe.
    const store = await openSqliteAttemptStore(target.ledger, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles);
    const identity = { runId: 'r', taskId: 'secret-task', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'layout' };
    try {
      await admitRunAttempts(store, [identity]);
      await store.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: '/private', argv: ['x'] } }));
    } finally { store.close(); }
    const requester = await project({ inspection: { maxPageSize: 4, policyMaxBytes: 65536,
      workers: { sources: [{ id: 'external', kind: 'next-project', path: target.project, scopeId: 's' }] } } }, v1('s'), { s: 'default' });
    const viaCli = await cli(requester, ['workers', 'list', '--scope', 's']);
    expect(viaCli.exit).toBe(0);
    expect(JSON.stringify(viaCli.value)).not.toContain('other'); expect(JSON.stringify(viaCli.value)).not.toContain('secret-task');
    expect(viaCli.value.sources.map((source: { id: string; status: string }) => [source.id, source.status])).toEqual([['current', 'available'], ['external', 'denied']]);
    const viaSdk = await inspectConfiguredWorkers(requester.project, { schemaVersion: 1, scopeId: 's' }, { env: requester.env });
    expect(viaSdk.sources.map(source => [source.id, source.status, source.workers.length])).toEqual([['current', 'available', 0], ['external', 'denied', 0]]);
    // Same company on both installations: the source is observed exactly as before.
    await setCompany(target, 'default');
    const db = new DatabaseSync(target.ledger);
    try { db.exec("INSERT OR IGNORE INTO companies(company_id) VALUES('default'); UPDATE scope_registry SET company_id='default' WHERE scope_id='s';"); } finally { db.close(); }
    const same = await inspectConfiguredWorkers(requester.project, { schemaVersion: 1, scopeId: 's' }, { env: requester.env });
    expect(same.sources.map(source => [source.id, source.status, source.workers.map(worker => worker.taskId)]))
      .toEqual([['current', 'available', []], ['external', 'available', ['secret-task']]]);
  });

  it('refuses a scope pinned to another company at the run, approval, model-activation, operation and worker ports (CLI and SDK)', async () => {
    // `s` is not one of the installation's own scopes at start: the trusted policy declares nothing yet, so the clean start below
    // is unaffected by decision 6 (H34 S3 Q1, owner 2026-09-27 evening: a foreign-pinned OWN scope now refuses the start itself,
    // see the dedicated start-refusal test). `s` is declared and pinned to another company only afterward — the ordinary "grew a
    // scope while running" path every port below already covers per request; the policy file is read fresh on every request.
    const f = await project({}, { schemaVersion: 1, revision: 'p0', restrictions: [], grants: [] });
    await startTestRuntimeService(f.project, f.env);
    await writeFile(join(f.data, 'policy.json'), JSON.stringify(v1('s')), { mode: 0o600 });
    const db = new DatabaseSync(f.ledger);
    try {
      db.exec("INSERT OR IGNORE INTO companies(company_id) VALUES('other')");
      db.prepare("INSERT INTO scope_registry(scope_id,company_id,origin) VALUES(?,?,'admission')").run('s', 'other');
    } finally { db.close(); }
    const env = { env: f.env };
    const calls = () => Promise.all([
      codeOf(inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'absent' }, env)),
      codeOf(requestRunCancellation(f.project, { schemaVersion: 1, scopeId: 's', runId: 'absent', commandId: 'c', action: 'cancel', expectedRevision: 0 }, env)),
      codeOf(configuredApproval(f.project, 'list', { schemaVersion: 1, scopeId: 's', afterId: null, limit: 1 }, env)),
      codeOf(inspectModelActivation(f.project, { schemaVersion: 1, scopeId: 's', reference }, env)),
      codeOf(inspectConfiguredOperation(f.project, { scopeId: 's', commandId: 'absent' }, env)),
      codeOf(inspectConfiguredWorkers(f.project, { schemaVersion: 1, scopeId: 's' }, env)),
    ]);
    expect(await calls()).toEqual(Array(6).fill('SCOPE_UNKNOWN'));
    for (const args of [['run', 'cancel', '--scope', 's', '--id', 'absent', '--command-id', 'c', '--expected-revision', '0'],
      ['workers', 'list', '--scope', 's'], ['inventory', '--scope', 's']]) {
      const refused = await cli(f, args);
      expect([refused.exit, refused.code]).toEqual([1, 'SCOPE_UNKNOWN']); expect(refused.stderr).not.toContain('other');
    }
    expect(pinsOf(f.ledger)).toContainEqual({ scope_id: 's', company_id: 'other' });
    // The installation configured for the pinning company reaches the same ports past membership.
    await setCompany(f, 'other');
    expect((await calls()).filter(code => code === 'SCOPE_UNKNOWN' || code === 'POLICY_DENIED')).toEqual([]);
  });

  it('never lets a role binding reach a scope pinned to another company', async () => {
    const policy = { schemaVersion: 2, revision: 'p2', grants: [], restrictions: [], separationOfDuties: [],
      roles: [{ id: 'viewer', permissions: [{ id: 'inspect-scope', effect: 'allow', actions: ['inspect'], resource: { kind: 'scope', ids: 'all' } }] }] };
    const bindings = (principals: typeof actor[]) => JSON.stringify({ schemaVersion: 1, revision: 'b1',
      bindings: [{ id: 'viewers', principals, roles: ['viewer'], scopes: ['s'] }] });
    const f = await project({}, policy, { s: 'other' });
    await writeFile(join(f.data, 'bindings.json'), bindings([actor]), { mode: 0o600 });
    const service = await startTestRuntimeService(f.project, f.env);
    try {
      expect(await cli(f, ['inventory', '--scope', 's'])).toMatchObject({ exit: 1, code: 'SCOPE_UNKNOWN' });
    } finally { await stopTestRuntimeService(service); }
    // The pinning company's installation: its OWN fresh installation, configured for `other` from its own first start — not the
    // same installation with `company.id` changed after a start (decision 6 refuses exactly that: this installation's own loop
    // scope would already be pinned to the old company). The same binding, on `other`'s own policy/bindings, reaches the scope.
    const g = await project({ company: { id: 'other' } }, policy, { s: 'other' });
    await writeFile(join(g.data, 'bindings.json'), bindings([actor]), { mode: 0o600 });
    const otherService = await startTestRuntimeService(g.project, g.env);
    try {
      expect(await cli(g, ['inventory', '--scope', 's'])).toMatchObject({ exit: 0, value: { page: { entries: [], nextAfter: null } } });
    } finally { await stopTestRuntimeService(otherService); }
  });

  it('refuses to start when the service identity scope is pinned to another company (H34 S3 Q1, owner 2026-09-27 evening decision 6); the pin never moves and the same company starts normally', async () => {
    const shutdown = { id: 'shutdown', effect: 'allow', actions: ['shutdown'], scopes: ['svc-scope'], principals: [actor], resource: { kind: 'service', ids: ['svc'] } };
    const f = await project({ service: { identity: { scopeId: 'svc-scope', serviceId: 'svc' } } },
      { schemaVersion: 1, revision: 'p', restrictions: [], grants: [...grants('svc-scope'), shutdown] }, { 'svc-scope': 'rival-company-7' });
    const seeded = pinsOf(f.ledger);
    // In-process: the read-only precheck refuses before any write, so the ledger stays byte-identical to what the fixture seeded.
    await expect(startTestRuntimeService(f.project, f.env)).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_SCOPE_FOREIGN' });
    expect(pinsOf(f.ledger)).toEqual(seeded);
    // Real process surface: `runtime serve` exits non-zero immediately (no `ready` event ever printed), the reason names this
    // installation's own scope, and the other company's identity never appears (Astra 2122/2123 non-disclosure extends to start).
    const refused = await cli(f, ['runtime', 'serve']);
    expect(refused.exit).toBe(78); // category 'config' (§1.1: config/ledger mismatch, operator fixes company.id or the ledger)
    expect(refused.code).toBe('RUNTIME_SERVICE_SCOPE_FOREIGN');
    expect(refused.stderr).not.toContain('rival-company-7');
    expect(pinsOf(f.ledger)).toEqual(seeded);
    // What H34-S3 proved here — governed shutdown and the runtime peer path stay `SCOPE_UNKNOWN` while the service "keeps running"
    // — is now unreachable: the start itself refuses first, so that scenario can no longer be produced. `shutdown.ts`'s own
    // membership check is unchanged code and remains defense-in-depth; its dedicated mutation evidence (M3) stays historical,
    // recorded before this decision, under `proof/H34-S3-2026-09-27/` (not reproduced here — see review.md §1.2).
    await setCompany(f, 'rival-company-7');
    const service = await startTestRuntimeService(f.project, f.env);
    try {
      const client = createConfiguredRuntimeClient(f.project, { env: f.env });
      await expect(client.describeService()).resolves.toMatchObject({ shutdownAvailable: true });
    } finally { await stopTestRuntimeService(service); }
    // Start never re-homes the pinned service scope even once a same-company installation exists.
    expect(pinsOf(f.ledger)).toContainEqual({ scope_id: 'svc-scope', company_id: 'rival-company-7' });
  });
});
