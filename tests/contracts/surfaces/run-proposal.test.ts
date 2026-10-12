import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { brainProposalLines } from '#surfaces/core/run-planning/index.js';
import { runProposalDigest, type RunProposalResult } from '#engine/index.js';
import { runCommand } from '../../fixtures/cli-input.js';
import { proposalFixture } from '../support/run-proposal.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const proposal = proposalFixture(), digest = runProposalDigest(proposal);
const receipt: RunProposalResult = { schemaVersion: 1, run: null, runtimeTotalSpendEnforced: false, budgetSemantics: 'admission-check-only',
  proposal: { schemaVersion: 1, proposal, digest, revision: 1, recordedAt: 100, status: 'pending', reason: 'RUN_APPROVAL_REQUIRED', authority: null,
    approval: { approvalId: 'a', expiresAt: 1000, decisionRecordId: 'decision' }, binding: { schemaVersion: 1, proposalId: proposal.proposalId, digest,
      requiredPermissions: [], budgetCeiling: proposal.budgetCeiling, admission: { registryRevision: 'registry', registryDigest: 'a'.repeat(64), standingAdmission: false,
        budget: { budgetId: 'scope-budget', budgetRevision: 1, checkpointDigest: 'b'.repeat(64), checkedAt: 100, remainingMinorUnits: 1000 } } } } };
it('CLI file/pipe and inspect pass the same typed application input and expose truthful EN/TR states', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-proposal-cli-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.deckent')); await writeFile(join(root, '.deckent/config.json'), '{}');
  const file = join(root, 'proposal.json'); await writeFile(file, JSON.stringify(proposal));
  const calls: unknown[] = [], output: string[] = [];
  const context = { root, env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') }, stdout: { write(text: string) { output.push(text); } },
    async proposeRun(_root: string, input: unknown) { calls.push(input); return receipt; },
    async inspectRunProposal(_root: string, input: unknown) { calls.push(input); return receipt; } };
  await runCommand(['run', 'propose', '--proposal', file, '--json'], context);
  expect(JSON.parse(output.pop()!)).toEqual(receipt); expect(calls.pop()).toEqual(proposal);
  await runCommand(['run', 'propose', '--proposal', '-', '--lang', 'tr'], { ...context, stdin: Readable.from([JSON.stringify(proposal)]) });
  const tr = output.pop()!; expect(tr).toContain('Onay bekliyor'); expect(tr).toContain('toplam Run harcaması henüz sınırlanmıyor'); expect(tr).toContain('MCP onay kararı veremez');
  await runCommand(['run', 'inspect-proposal', '--scope', 's', '--id', 'r', '--command-id', 'propose', '--lang', 'en'], context);
  expect(calls.pop()).toEqual({ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'propose' });
  expect(output.pop()).toContain('no total Run spending limit is enforced');
  for (const status of ['recorded', 'accepted', 'rejected', 'parked'] as const) {
    await runCommand(['run', 'inspect-proposal', '--scope', 's', '--id', 'r', '--command-id', 'propose', '--json'],
      { ...context, inspectRunProposal: async () => ({ ...receipt, proposal: { ...receipt.proposal, status } }) });
    expect(JSON.parse(output.pop()!).proposal.status).toBe(status);
  }
  const before = calls.length;
  await expect(runCommand(['run', 'propose', '--proposal', file, '--approve'], context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  await expect(runCommand(['run', 'propose', '--proposal', file, '--proposal', file], context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  await writeFile(file, JSON.stringify({ ...proposal, standingAdmission: true }));
  await expect(runCommand(['run', 'propose', '--proposal', file], context)).rejects.toMatchObject({ code: 'RUN_PROPOSAL_INVALID' });
  expect(calls).toHaveLength(before);
});
it('MCP wire submits and inspects the same contract, rejects forged fields and exposes no approval mutator', async () => {
  const calls: unknown[] = [];
  let response = receipt;
  const server = createMcpServer({ inspectRun: async () => ({}), inspectInventory: async () => ({}),
    proposeRun: async input => { calls.push(input); return response; }, inspectRunProposal: async query => { calls.push(query); return response; } },
    { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'tr');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'proposal-test', version: '1' }); await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  expect(tools.find(t => t.name === 'propose_run')!.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  expect(tools.find(t => t.name === 'inspect_run_proposal')!.annotations).toMatchObject({ readOnlyHint: true });
  expect(tools.find(t => t.name === 'propose_run')!.description).toContain('yürütmede toplam Run harcaması sınırlanmaz');
  expect((await client.callTool({ name: 'propose_run', arguments: proposal })).structuredContent).toEqual(receipt); expect(calls.pop()).toEqual(proposal);
  const query = { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'propose' };
  expect((await client.callTool({ name: 'inspect_run_proposal', arguments: query })).structuredContent).toEqual(receipt); expect(calls.pop()).toEqual(query);
  expect(JSON.stringify(await client.callTool({ name: 'propose_run', arguments: { ...proposal, approved: true } }))).toContain('MCP_INPUT_INVALID');
  for (const name of ['decide_approval', 'approve_run_proposal']) {
    expect(tools.map(t => t.name)).not.toContain(name);
    expect(JSON.stringify(await client.callTool({ name, arguments: { ...query, decision: 'allow' } }))).toContain('MCP_TOOL_UNKNOWN');
  }
  expect(calls).toEqual([]);
  response = { ...receipt, budgetSemantics: 'not-metered', proposal: { ...receipt.proposal, binding: { ...receipt.proposal.binding,
    admission: { ...receipt.proposal.binding.admission!, budgetSemantics: 'not-metered', budget: null } } } };
  expect((await client.callTool({ name: 'propose_run', arguments: proposal })).structuredContent).toEqual(response);
  expect((await client.callTool({ name: 'inspect_run_proposal', arguments: query })).structuredContent).toEqual(response);
});

it.each(['en', 'tr'] as const)('non-metered proposal and /do preview explicitly waive only money checks (%s)', async locale => {
  const value: RunProposalResult = { ...receipt, budgetSemantics: 'not-metered', proposal: { ...receipt.proposal, binding: { ...receipt.proposal.binding,
    admission: { ...receipt.proposal.binding.admission!, budgetSemantics: 'not-metered', budget: null } } } };
  const expected = locale === 'tr' ? 'Abonelik/ücretsiz model — bütçe kontrolü uygulanmaz' : 'Subscription/free model — budget check does not apply';
  const output: string[] = [];
  await runCommand(['run', 'inspect-proposal', '--scope', 's', '--id', 'r', '--command-id', 'propose', '--lang', locale], {
    inspectRunProposal: async () => value, stdout: { write(text: string) { output.push(text); } } });
  expect(output.join('')).toContain(expected); expect(brainProposalLines(value, locale).join('\n')).toContain(expected);
  expect(output.join('')).not.toContain(locale === 'tr' ? 'kabul anında kontrol' : 'checked at admission');
});
