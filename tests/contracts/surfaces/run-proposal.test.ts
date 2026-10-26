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
import { pendingBrainFixture } from '../support/brain-proposal.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const proposal = proposalFixture(), digest = runProposalDigest(proposal);
const receipt: RunProposalResult = { schemaVersion: 1, run: null, runtimeTotalSpendEnforced: false, budgetSemantics: 'admission-check-only',
  proposal: { schemaVersion: 1, proposal, digest, revision: 1, recordedAt: 100, status: 'pending', reason: 'RUN_APPROVAL_REQUIRED', authority: null,
    approval: { approvalId: 'a', expiresAt: 1000, decisionRecordId: 'decision' }, binding: { schemaVersion: 1, proposalId: proposal.proposalId, digest,
      requiredPermissions: [], budgetCeiling: proposal.budgetCeiling, admission: { registryRevision: 'registry', registryDigest: 'a'.repeat(64), standingAdmission: false,
        budget: { budgetId: 'scope-budget', budgetRevision: 1, checkpointDigest: 'b'.repeat(64), checkedAt: 100, remainingMinorUnits: 1000 } } } } };
it.skipIf(process.platform === 'win32')('[unsupported on Windows: CLI JSON file input (no O_NOFOLLOW)] CLI file/pipe and inspect pass the same typed application input and expose truthful EN/TR states', async () => {
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
  const tr = output.pop()!; expect(tr).toContain('Onay bekliyor'); expect(tr).toContain('toplam iş harcaması henüz sınırlanmıyor'); expect(tr).toContain('MCP onay kararı veremez'); expect(tr).not.toContain('{approvalId}');
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
  expect(tools.find(t => t.name === 'propose_run')!.description).toContain('yürütmede toplam iş harcaması sınırlanmaz');
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
  const expected = locale === 'tr' ? 'İşçiler: abonelik veya ek ücret gerektirmeyen model — API bütçesi uygulanmaz' : 'Workers: subscription or local model — no extra cost; budget check does not apply';
  const output: string[] = [];
  await runCommand(['run', 'inspect-proposal', '--scope', 's', '--id', 'r', '--command-id', 'propose', '--lang', locale], {
    inspectRunProposal: async () => value, stdout: { write(text: string) { output.push(text); } } });
  expect(output.join('')).toContain(expected); expect(brainProposalLines(value, locale).join('\n')).toContain(expected);
  expect(output.join('')).not.toContain(locale === 'tr' ? 'kabul anında kontrol' : 'checked at admission');
});

it.each(['en', 'tr'] as const)('paid Brain cost stays distinct from non-metered workers in both proposal renderers (%s)', async locale => {
  const model = { ...receipt.proposal.proposal, budgetCeiling: { currency: 'USD', limitMinorUnits: 5000 }, source: { kind: 'model' as const,
    receipt: { commandId: 'plan', invocationId: 'inv', reference: { providerId: 'fixture-api', providerVersion: 1, modelId: 'fixture-model', modelVersion: 1 }, responseDigest: 'a'.repeat(64) } } };
  const value: RunProposalResult = { ...receipt, budgetSemantics: 'not-metered', proposal: { ...receipt.proposal, proposal: model },
    planningSpending: { class: 'metered', currency: 'USD', amountMinorUnits: 2, evidence: 'measured-tariff' } };
  const expected = locale === 'tr' ? '0,02 $' : '$0.02';
  const lines = brainProposalLines(value, locale).join('\n');
  expect(lines).toContain('fixture-api/fixture-model'); expect(lines).toContain(expected);
  expect(lines).toContain(locale === 'tr' ? 'ücretli API' : 'paid API'); expect(lines).toContain(locale === 'tr' ? 'İşçiler:' : 'Workers:');
  const out: string[] = [];
  await runCommand(['run', 'inspect-proposal', '--scope', 's', '--id', 'r', '--command-id', 'propose', '--lang', locale], {
    root: '/unused', inspectRunProposal: async () => value, stdout: { write(text: string) { out.push(text); } } });
  expect(out.join('')).toContain(expected); expect(out.join('')).toContain('fixture-api/fixture-model');
  const unknown = brainProposalLines({ ...value, planningSpending: { class: 'metered', currency: 'USD', amountMinorUnits: null, evidence: 'held' } }, locale).join('\n');
  expect(unknown).toContain(locale === 'tr' ? 'bilinmiyor (kesinleşmedi)' : 'unknown (unsettled)'); expect(unknown).not.toContain(expected);
  const upper = brainProposalLines({ ...value, planningSpending: { ...value.planningSpending!, evidence: 'measured-tariff-upper-bound' } }, locale).join('\n');
  expect(upper).toContain(locale === 'tr' ? 'üst sınır' : 'upper bound');
  const metered = brainProposalLines({ ...value, budgetSemantics: 'admission-check-only' }, locale).join('\n');
  expect(metered).toContain(locale === 'tr' ? '50,00 $' : '$50.00'); expect(metered).not.toContain('5000');
});

it.each(['en', 'tr'] as const)('returned durable Run identity leads the summary even with a long paid planning projection (%s)', locale => {
  const pending = pendingBrainFixture(), run: NonNullable<RunProposalResult['run']> = {
    schemaVersion: 3, runId: 'r', scopeId: 's', revision: 1, cancellationRequested: false, state: { kind: 'running' }, tasks: [],
  };
  const accepted: RunProposalResult = { ...pending, run, proposal: { ...pending.proposal, status: 'accepted', reason: null, approval: null,
    proposal: { ...pending.proposal.proposal, source: { kind: 'model', receipt: { commandId: 'plan', invocationId: 'inv',
      reference: { providerId: 'fixture-api', providerVersion: 1, modelId: 'fixture-model', modelVersion: 1 }, responseDigest: 'a'.repeat(64) } } } },
    planningSpending: { class: 'metered', currency: 'USD', amountMinorUnits: 2, evidence: 'measured-tariff' } };
  const lines = brainProposalLines(accepted, locale);
  expect(lines[0]).toBe(locale === 'en' ? 'Run r admitted. Follow /tasks or /monitor.' : 'İş r başlatıldı. /tasks veya /monitor ile izleyin.');
  expect(lines.join('\n')).toContain('fixture-api/fixture-model');
  expect(brainProposalLines(pending, locale)[0]).not.toBe(lines[0]);
});

it.each(['en', 'tr'] as const)('shows subscription planning as plan usage without a monetary zero or API label (%s)', locale => {
  const value = pendingBrainFixture();
  const proposal = { ...value.proposal.proposal, source: { kind: 'model' as const, receipt: { commandId: 'plan', invocationId: 'inv',
    reference: { providerId: 'fixture', providerVersion: 1, modelId: 'plan-model', modelVersion: 1 }, responseDigest: 'a'.repeat(64) } } };
  const lines = brainProposalLines({ ...value, budgetSemantics: 'not-metered', proposal: { ...value.proposal, proposal },
    planningSpending: { class: 'not-metered', billingAxis: 'subscription', currency: null, amountMinorUnits: null, evidence: 'plan-usage' } }, locale).join('\n');
  expect(lines).toContain(locale === 'tr' ? 'abonelik planı' : 'subscription plan');
  expect(lines).toContain(locale === 'tr' ? 'plan kullanımı; parasal ücret yok' : 'plan usage; no monetary charge');
  expect(lines).not.toContain('$0'); expect(lines).not.toContain(locale === 'tr' ? 'ücretli API' : 'paid API');
});
