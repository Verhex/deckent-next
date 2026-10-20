import { appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { planRun, proposeRun, configuredApproval } from '../../../src/index.js';
import { approvalRecordSchema, type RunProposal } from '#domain/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { workSurfaceLabels } from '#surfaces/core/cli/index.js';
import { createWorklineLedgerPorts } from '../support/cli-ledger-ports.js';
import { readMonitorLedger } from '#adapters/index.js';
import { createProviderSpendAccount, createProviderSpendCheckpoint } from '#engine/index.js';
import { clearConfigCache } from '#platform/index.js';
import { main } from '../../fixtures/cli-input.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { proposalFixture } from '../support/run-proposal.js';
import { emptySnapshot } from '../../fixtures/monitor/snapshots.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const command = { schemaVersion: 1 as const, scopeId: 's', commandId: 'card-plan', intent: 'Prepare a purchase and durable readback' };
const frames = (title: string, text: string) => { if (process.env.DECKENT_L1_FRAME_PROOF) appendFileSync(process.env.DECKENT_L1_FRAME_PROOF, `\n## ${title}\n${text}\n`); };
// Plan approvals open a live OS session (LocalOsSessionAuthority reads /proc/<pid>); other platforms refuse with SESSION_REQUIRED by design.
it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] a configured Turkish plan remains sealed in its original language after configuration changes', async () => {
  const f = await brainProviderFixture(); cleanup.push(f.close);
  await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ ...f.config, language: 'tr' })); clearConfigCache();
  const pending = await planRun(f.project, command, f.options);
  const query = { schemaVersion: 1, scopeId: 's', approvalId: pending.proposal.approval!.approvalId };
  const record = approvalRecordSchema.parse(await configuredApproval(f.project, 'inspect', query, f.options));
  expect(record.request.summary).toContain('Plan · görevler: 1'); expect(record.request.summary).toContain('yalnız kabul anında');
  expect(record.request.summary).toContain('Beyan edilen bütçe tavanı');
  await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ ...f.config, language: 'en' })); clearConfigCache();
  expect(await planRun(f.project, command, f.options)).toEqual(pending);
  expect(await configuredApproval(f.project, 'inspect', query, f.options)).toEqual(record); expect(f.posts).toBe(1);
});
for (const route of ['cli-do-json', 'mcp-plan', 'mcp-propose'] as const) it.skipIf(process.platform !== 'linux')(`[requires Linux live OS session /proc identity] ${route}: a fresh terminal reads the durable plan; SDK, CLI and MCP inspect/list and monitor retain it`, async () => {
  const f = await brainProviderFixture(); cleanup.push(f.close);
  const output: string[] = [];
  const query = { schemaVersion: 1 as const, scopeId: 's', afterId: null, limit: 10 };
  const listApprovals = (input: unknown) => configuredApproval(f.project, 'list', input, f.options);
  const inspectApproval = (input: unknown) => configuredApproval(f.project, 'inspect', input, f.options);
  const server = createMcpServer({ inspectRun: async () => ({}), inspectInventory: async () => ({}), listApprovals, inspectApproval,
    planRun: input => planRun(f.project, input, f.options), proposeRun: input => proposeRun(f.project, input, f.options) },
  { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'approval-plan-test', version: '1' }); await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const cli = { root: f.project, env: f.options.env, stdout: { write(text: string) { output.push(text); } },
    stderr: { write(text: string) { output.push(text); } }, listApprovals, inspectApproval,
    planRun: (root: string, input: Parameters<typeof planRun>[1]) => planRun(root, input, f.options) };
  if (route === 'cli-do-json') {
    expect(await main(['do', '--request', command.intent, '--scope', 's', '--command-id', command.commandId, '--json'], cli)).toBe(0);
    expect(JSON.parse(output.pop()!).proposal.status).toBe('pending');
  } else if (route === 'mcp-plan') {
    const reply = await client.callTool({ name: 'plan_run', arguments: command });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true); expect(reply.structuredContent).toMatchObject({ proposal: { status: 'pending' } });
  } else {
    // A direct proposal needs an existing scope budget; no invocation is made to initialize it.
    const account = createProviderSpendAccount(f.config.provider_spending!.budgets[0]!);
    const checkpoint = createProviderSpendCheckpoint(account, 1, 0), db = new DatabaseSync(f.path);
    try { db.prepare('INSERT INTO provider_spend_accounts(scope_id,revision,reservation_count,digest,record) VALUES(?,?,?,?,?)')
      .run('s', 1, 0, checkpoint.digest, JSON.stringify(account)); } finally { db.close(); }
    const { id, issuer, subject } = (await import('#adapters/index.js')).readLocalOsIdentity();
    const actor = { id, issuer, subject };
    const proposal: RunProposal = { ...proposalFixture('business', actor), commandId: command.commandId };
    const reply = await client.callTool({ name: 'propose_run', arguments: proposal });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true); expect(reply.structuredContent, JSON.stringify(reply)).toMatchObject({ proposal: { status: 'pending' } });
  }
  const records = (await listApprovals(query) as unknown[]).map(record => approvalRecordSchema.parse(record));
  expect(records).toHaveLength(1); const record = records[0]!, summary = record.request.summary;
  expect(summary).toContain('Plan · tasks: 1'); expect(summary).toContain('purchase'); expect(summary).toContain('business');
  expect(summary).toContain('$2.00'); expect(summary).toContain('only at admission'); expect(summary).toContain('work-class registry');
  expect(await inspectApproval({ schemaVersion: 1, scopeId: 's', approvalId: record.request.approvalId })).toEqual(record);
  for (const action of ['list', 'inspect']) {
    const input = action === 'list' ? query : { schemaVersion: 1, scopeId: 's', approvalId: record.request.approvalId };
    expect(await main(['approval', action, '--input', '-', '--json'], { ...cli, stdin: Readable.from([JSON.stringify(input)]) })).toBe(0);
    const displayed = JSON.parse(output.pop()!); expect(action === 'list' ? displayed : [displayed]).toEqual(records);
    const reply = await client.callTool({ name: action === 'list' ? 'list_approvals' : 'inspect_approval', arguments: input });
    expect(JSON.stringify(reply)).toContain('only at admission'); expect(JSON.stringify(reply)).toContain('$2.00');
  }
  const ledger = await readMonitorLedger(f.path, { busyTimeoutMs: 100, maxRuns: 10 });
  expect(ledger.approvals[0]!.summary).toBe(summary);
  const monitor = await loadMonitorSurface();
  const viewModel = monitor.buildMonitorView({ ...emptySnapshot, installs: [{ ...emptySnapshot.installs[0]!,
    approvals: ledger.approvals.map(row => ({ ...row, requiredAssurance: null })) }] }, 'en', true);
  const monitorRows = viewModel.tabs.approvals.flatMap(block => block.kind === 'table' ? block.rows : []);
  expect(monitorRows[0]!.cells[0]!.text).toContain('purchase');
  const detailText = monitorRows[0]!.detail().map(line => line.map(part => part.text).join('')).join('\n');
  expect(detailText).toContain(summary.replace(/\s+/gu, ' ')); frames(route + ' monitor detail', detailText);
  const ports = createWorklineLedgerPorts({ root: f.project, scopeId: 's', options: f.options, listApprovals,
    inspectWorkers: async () => ({ workers: [] }) as never, inspectRun: async () => ({ run: null }) as never,
    decideApproval: async () => { throw new Error('OBSERVATION_ONLY_TEST'); }, renderRunCancellation: () => '' });
  const words = workSurfaceLabels('en');
  // This terminal has no /do preview, planning result or prior in-memory card.
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: words }, ledger: ports, pollMs: 60_000, approvalPollMs: 60_000 }, 160);
  cleanup.push(() => view.instance.unmount());
  await settle(40); view.stdin.write('/approvals\r');
  await until(() => view.stdout.frame.includes('Plan · tasks: 1'), 'fresh terminal approvals list'); frames(route + ' list', view.stdout.frame);
  expect(view.stdout.frame).toContain('purchase'); expect(view.stdout.frame).toContain('business');
  await settle(40); view.stdin.write('\r');
  await until(() => view.stdout.frame.includes('ceiling checked only at admission'), 'stored plan in approval window'); frames(route + ' card', view.stdout.frame);
  expect(view.stdout.frame).toContain('only at admission'); expect(view.stdout.frame).toContain('work-class registry');
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('decide_approval');
  expect(JSON.stringify(await client.callTool({ name: 'decide_approval', arguments: { decision: 'allow' } }))).toContain('MCP_TOOL_UNKNOWN');
  expect((await listApprovals(query) as unknown[]).map(r => approvalRecordSchema.parse(r))).toEqual(records);
  expect(f.posts).toBe(route === 'mcp-propose' ? 0 : 1);
});
