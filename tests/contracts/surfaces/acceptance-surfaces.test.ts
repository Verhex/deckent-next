import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { applyTaskEvaluation, bindTaskAcceptance, deriveAcceptanceView } from '#domain/index.js';
import { describeTaskEvaluationReceipt, projectRunView, projectMonitorRun } from '#engine/index.js';
import { main } from '#surfaces/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { renderAcceptanceLine } from '#surfaces/core/monitor/index.js';
import { resolveProductPaths } from '#platform/index.js';
import { evaluating, evidence, identity } from '../domain/acceptance-fixture.js';

function fixture() {
  const { run } = evaluating(), evaluation = bindTaskAcceptance(run, evidence());
  const accepted = applyTaskEvaluation(run, run.revision, evaluation, { now: 100, timeoutMs: 1000 });
  const receipt = { commandId: evaluation.evaluationId, command: JSON.stringify({ evaluation }), snapshot: accepted.snapshot };
  return { ...accepted, evaluation, view: describeTaskEvaluationReceipt(receipt).run };
}
it('the evaluation response, shared Run view and monitor use the same acceptance fields; absent evidence remains unknown', () => {
  const f = fixture(); const exact = deriveAcceptanceView(f.snapshot, identity.taskId, f.evaluation);
  expect(f.view.tasks[0]!.acceptance).toEqual(exact); expect(exact.score).toBe(1);
  expect(projectRunView(f.snapshot).tasks[0]!.acceptance).toMatchObject({ outcome: 'accepted', workClass: 'business', evaluationId: null, score: null });
  const monitor = projectMonitorRun({ run: { snapshot: f.snapshot, poolId: null, admitted: true, createdAtMs: null, attempts: [] },
    pool: null, approvals: [], workers: new Map(), observedAt: 100 });
  expect(monitor.tasks[0]!.acceptance).toEqual(projectRunView(f.snapshot).tasks[0]!.acceptance);
  const recorded = projectMonitorRun({ run: { snapshot: f.snapshot, evaluations: [f.evaluation], poolId: null, admitted: true, createdAtMs: null, attempts: [] }, pool: null, approvals: [], workers: new Map(), observedAt: 100 });
  expect(recorded.tasks[0]!.acceptance).toEqual(exact);
  expect(() => deriveAcceptanceView(f.snapshot, identity.taskId, { ...f.evaluation, identity: { ...identity, generation: 2 } })).toThrow('TASK_EVALUATION_PROFILE_MISMATCH');
});
it('CLI JSON and the real MCP in-memory transport preserve the canonical evaluation response acceptance bytes', async () => {
  const f = fixture(), query = { schemaVersion: 1 as const, scopeId: identity.scopeId, runId: identity.runId };
  const layout = resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } });
  const result = { schemaVersion: 1 as const, layout, run: f.view, models: [] };
  const out: string[] = [];
  expect(await main(['run', 'inspect', '--scope', query.scopeId, '--id', query.runId, '--json'], {
    env: { NO_COLOR: '1' }, stdout: { write(text: string) { out.push(text); } }, stderr: { write() {} }, async inspectRun() { return result; },
  } as never)).toBe(0);
  const cli = JSON.parse(out.join(''));
  const server = createMcpServer({ async inspectRun() { return result; }, async inspectInventory() { return {}; } }, { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: 'acceptance-source-proof', version: '1' }); await client.connect(ct);
  try {
    const mcp = await client.callTool({ name: 'inspect_run', arguments: query });
    const text = (mcp.content as { type: string; text?: string }[]).find(row => row.type === 'text')!.text!;
    const parsed = JSON.parse(text);
    const bytes = JSON.stringify(result.run.tasks[0]!.acceptance);
    expect(JSON.stringify(cli.run.tasks[0].acceptance)).toBe(bytes);
    expect(JSON.stringify(parsed.run.tasks[0].acceptance)).toBe(bytes);
    console.info('CANONICAL_ACCEPTANCE_BYTES', JSON.stringify({ sdk: bytes, cli: JSON.stringify(cli.run.tasks[0].acceptance), mcp: JSON.stringify(parsed.run.tasks[0].acceptance) }));
  } finally { await client.close(); await server.close(); }
});
it.each(['en', 'tr'] as const)('run and task inspection render acceptance from the catalog in %s', async locale => {
  const f = fixture(), out: string[] = [];
  const context = { env: { NO_COLOR: '1' }, stdout: { write(text: string) { out.push(text); } }, stderr: { write() {} },
    async inspectRun() { return { schemaVersion: 1, layout: resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } }), run: f.view }; } };
  for (const argv of [['run', 'inspect', '--scope', identity.scopeId, '--id', identity.runId], ['task', 'inspect', '--scope', identity.scopeId, '--run', identity.runId, '--task', identity.taskId]]) {
    out.length = 0; expect(await main([...argv, '--lang', locale], context as never)).toBe(0);
    expect(out.join('')).toContain(renderAcceptanceLine(f.view.tasks[0]!.acceptance!, locale));
    expect(out.join('')).toContain(locale === 'en' ? 'accepted' : 'kabul edildi');
  }
});

it('source SDK, CLI JSON and MCP transport show identical frozen fields from a real reopened ledger, with the unbound receipt visible as unknown', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir, hostname, userInfo } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { inspectRun } = await import('../../../src/index.js');
  const { openConfiguredAttemptStore } = await import('../../../src/composition/core/storage/index.js');
  const { clearConfigCache } = await import('#platform/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-acceptance-surface-')), project = join(root, 'project'), data = join(root, 'data');
  const f = fixture(), query = { schemaVersion: 1 as const, scopeId: identity.scopeId, runId: identity.runId }, options = { env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') } };
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
  let client: Client | undefined, server: ReturnType<typeof createMcpServer> | undefined;
  try {
    const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
    const db = new DatabaseSync(opened.path);
    try {
      db.prepare('INSERT INTO execution_pools VALUES(?,?)').run('pool', JSON.stringify({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 } }));
      db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(identity.scopeId, identity.runId, f.snapshot.revision, JSON.stringify(f.snapshot), JSON.stringify({ schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['task'] }));
      db.prepare('INSERT INTO run_receipts VALUES(?,?,?,?)').run(identity.scopeId, 'evaluation', JSON.stringify({ action: 'apply-task-evaluation', evaluation: f.evaluation }), JSON.stringify(f.snapshot));
    } finally { db.close(); }
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'fixture-read', restrictions: [], grants: [
      { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: [identity.scopeId], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'run', ids: [identity.runId] } },
    ] }), { mode: 0o600 });
    clearConfigCache();
    const sdk = await inspectRun(project, query, options), bytes = JSON.stringify(sdk.run!.tasks[0]!.acceptance);
    // This negative evidence exposes the remaining reader wiring; it is not relabeled complete acceptance.
    expect(sdk.run!.tasks[0]!.acceptance).toMatchObject({ workClass: 'business', outcome: 'accepted', score: null, evaluationId: null });
    const out: string[] = [];
    expect(await main(['run', 'inspect', '--scope', identity.scopeId, '--id', identity.runId, '--json'], {
      root: project, env: options.env, stdout: { write(text: string) { out.push(text); } }, stderr: { write() {} }, async inspectRun() { return inspectRun(project, query, options); },
    } as never)).toBe(0);
    server = createMcpServer({ async inspectRun() { return inspectRun(project, query, options); }, async inspectInventory() { return {}; } }, { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); client = new Client({ name: 'source-sdk-acceptance', version: '1' }); await client.connect(ct);
    const result = await client.callTool({ name: 'inspect_run', arguments: query });
    const returned = JSON.parse((result.content as { type: string; text?: string }[]).find(row => row.type === 'text')!.text!);
    expect(JSON.stringify(JSON.parse(out.join('')).run.tasks[0].acceptance)).toBe(bytes);
    expect(JSON.stringify(returned.run.tasks[0].acceptance)).toBe(bytes);
    console.info('REOPENED_LEDGER_ACCEPTANCE_BYTES', JSON.stringify({ sdk: bytes, cli: JSON.stringify(JSON.parse(out.join('')).run.tasks[0].acceptance), mcp: JSON.stringify(returned.run.tasks[0].acceptance) }));
  } finally {
    if (client) await client.close(); if (server) await server.close(); clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
});
