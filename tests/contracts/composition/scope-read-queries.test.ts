import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import {
  checkConfiguredWorkspaceIntegration, configuredApproval, createConfiguredRuntimeClient, inspectConfiguredOperation, inspectConfiguredWorkerTranscript,
  inspectConfiguredWorkers, inspectConfiguredWorkspaceIntegration, inspectInventory, inspectModelActivation, inspectModelInvocation,
  inspectProviderSpendAccount, inspectRun, previewConfiguredWorkspacePatch, requestRunCancellation,
} from '../../../src/index.js';
import { clearConfigCache } from '#platform/index.js';
import { cliChildEnv } from '../support/child-env.js';
import { startTestRuntimeService } from '../support/runtime-service.js';

// Astra 2126 R1 (inverted read-pin repro): a read-only query never writes a scope pin; only a write admission pins.
const exec = promisify(execFile); const roots: string[] = [];
const binary = resolve('dist/composition/core/cli/internal/entry.js');
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = [{ issuer: hostname(), subject: String(userInfo().uid) }];
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const attempt = (scopeId: string) => ({ runId: 'r', taskId: 't', attemptId: 'a', scopeId, generation: 1, layoutRevision: 'layout' });

/** Every read-only entry point, each on its own explicitly declared scope, so a pin names the query that wrote it. */
const reads: Readonly<Record<string, (f: Fixture) => Promise<unknown>>> = {
  'sdk-run-inspect': f => inspectRun(f.project, { schemaVersion: 1, scopeId: 'sdk-run-inspect', runId: 'missing' }, f.options),
  'sdk-inventory': f => inspectInventory(f.project, { schemaVersion: 1, scopeId: 'sdk-inventory' }, f.options),
  'sdk-operation-inspect': f => inspectConfiguredOperation(f.project, { scopeId: 'sdk-operation-inspect', commandId: 'missing' }, f.options),
  'sdk-approval-list': f => configuredApproval(f.project, 'list', { schemaVersion: 1, scopeId: 'sdk-approval-list', afterId: null, limit: 10 }, f.options),
  'sdk-approval-inspect': f => configuredApproval(f.project, 'inspect', { schemaVersion: 1, scopeId: 'sdk-approval-inspect', approvalId: 'missing' }, f.options),
  'sdk-model-activation': f => inspectModelActivation(f.project, { schemaVersion: 1, scopeId: 'sdk-model-activation', reference }, f.options),
  'sdk-model-invocation': f => inspectModelInvocation(f.project, { schemaVersion: 2, scopeId: 'sdk-model-invocation', invocationId: 'missing', reference }, f.options),
  'sdk-provider-spend': f => inspectProviderSpendAccount(f.project, { schemaVersion: 1, scopeId: 'sdk-provider-spend', budgetId: 'b', budgetRevision: 1 }, f.options),
  'sdk-patch-preview': f => previewConfiguredWorkspacePatch(f.project, attempt('sdk-patch-preview'), f.options),
  'sdk-integration-check': f => checkConfiguredWorkspaceIntegration(f.project, attempt('sdk-integration-check'), f.options),
  'sdk-integration-inspect': f => inspectConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, identity: attempt('sdk-integration-inspect'), commandId: 'missing' }, f.options),
  'sdk-workers': f => inspectConfiguredWorkers(f.project, { schemaVersion: 1, scopeId: 'sdk-workers' }, f.options),
  'sdk-worker-transcript': f => inspectConfiguredWorkerTranscript(f.project, attempt('sdk-worker-transcript'), f.options),
  'cli-operation-inspect': f => cli(f, ['operation', 'inspect', '--scope', 'cli-operation-inspect', '--command-id', 'missing']),
  'cli-run-inspect': f => cli(f, ['run', 'inspect', '--scope', 'cli-run-inspect', '--id', 'missing']),
  'cli-inventory': f => cli(f, ['inventory', '--scope', 'cli-inventory']),
  'peer-approval-list': f => f.client.listApprovals({ schemaVersion: 1, scopeId: 'peer-approval-list', afterId: null, limit: 10 }),
  'peer-approval-inspect': f => f.client.inspectApproval({ schemaVersion: 1, scopeId: 'peer-approval-inspect', approvalId: 'missing' }),
  'peer-model-invocation': f => f.client.inspectModelInvocation({ schemaVersion: 2, scopeId: 'peer-model-invocation', invocationId: 'missing', reference }),
  'peer-provider-spend': f => f.client.inspectProviderSpendAccount({ schemaVersion: 1, scopeId: 'peer-provider-spend', budgetId: 'b', budgetRevision: 1 }),
};
const scopes = [...Object.keys(reads), 'writer'];
const grants = [
  ['scope', 'inspect'], ['run', 'inspect'], ['operation', 'inspect'], ['approval', 'inspect'], ['model-activation', 'inspect'],
  ['model-invocation', 'inspect'], ['provider-spend-account', 'inspect'], ['attempt', 'read-output'], ['run', 'cancel'],
].map(([kind, action], index) => ({ id: `g${index}`, effect: 'allow', actions: [action], scopes, principals: actor, resource: { kind, ids: 'all' } }));

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'deckent-scope-reads-')); roots.push(project);
  const data = join(project, 'data'); await mkdir(join(project, '.deckent'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = cliChildEnv({ HOME: join(project, 'home'), DECKENT_LANGUAGE: 'en', NO_COLOR: '1' }); delete env.DECKENT_HOME;
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, company: { id: 'alpha' } }));
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  // The service starts before the policy names these scopes, so the first-start registration cannot pin them.
  await startTestRuntimeService(project, env);
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants }), { mode: 0o600 });
  return { project, env, options: { env }, ledger: opened.path, client: createConfiguredRuntimeClient(project, { env }) };
}
async function cli(f: Fixture, args: readonly string[]) { return exec(process.execPath, [binary, ...args, '--json'], { cwd: f.project, env: f.env }); }
const pins = (f: Fixture) => { const db = new DatabaseSync(f.ledger, { readOnly: true });
  try { return db.prepare('SELECT scope_id,company_id,origin FROM scope_registry ORDER BY scope_id').all(); } finally { db.close(); } };
const outcome = async (work: Promise<unknown>) => { try { await work; return 'ok'; } catch (error) { return (error as { code?: unknown }).code ?? 'error'; } };

describe.skipIf(process.platform === 'win32')('read-only queries never pin a scope', () => {
  it('leaves scope_registry unchanged for every SDK, CLI and runtime-peer query; the first write admission still pins', async () => {
    const f = await fixture();
    const before = pins(f);
    expect(before).toEqual([{ scope_id: 'runtime-test', company_id: 'alpha', origin: 'start' }]);
    const outcomes: Record<string, unknown> = {};
    for (const [name, read] of Object.entries(reads)) outcomes[name] = await outcome(read(f));
    console.log(`read outcomes: ${JSON.stringify(outcomes)}`);
    // No query was refused by membership: each one passed the scope decision (policy + registry) before its own outcome.
    for (const code of Object.values(outcomes)) expect(['POLICY_DENIED', 'SCOPE_UNKNOWN']).not.toContain(code);
    expect({ outcomes, pins: pins(f) }).toEqual({ outcomes, pins: before });
    await outcome(requestRunCancellation(f.project, { schemaVersion: 1, scopeId: 'writer', runId: 'missing', commandId: 'c', action: 'cancel', expectedRevision: 0 }, f.options));
    expect(pins(f)).toEqual([...before, { scope_id: 'writer', company_id: 'alpha', origin: 'admission' }]);
    // A company switch refuses the pinned writer scope and reads still pin nothing.
    const path = join(f.project, '.deckent/config.json');
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), company: { id: 'beta' } })); clearConfigCache();
    await expect(inspectConfiguredOperation(f.project, { scopeId: 'writer', commandId: 'missing' }, f.options)).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
    for (const read of Object.values(reads)) await outcome(read(f));
    expect(pins(f)).toEqual([...before, { scope_id: 'writer', company_id: 'alpha', origin: 'admission' }]);
  });
});
