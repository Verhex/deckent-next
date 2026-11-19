import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { brainProposalCardLines } from '#surfaces/core/run-planning/index.js';
import { ErrorRegistry, t } from '#platform/index.js';
import { main } from '../../fixtures/cli-input.js';
import { pendingBrainFixture } from '../support/brain-proposal.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const command = { schemaVersion: 1, scopeId: 's', commandId: 'brain', intent: 'Plan purchase readback' };
it('explains a refused private read in both terminal languages', () => {
  expect(t('brain.sameTurn.readRefused', {}, 'en')).toBe('The system could not verify access to the saved reply for this chat. No plan was sent for approval and no Run started. Use /do to request a separate plan.');
  expect(t('brain.sameTurn.readRefused', {}, 'tr')).toBe('Sistem bu sohbetin kayıtlı yanıtına erişimi doğrulayamadı. Plan onaya sunulmadı ve iş başlamadı. Ayrı bir plan istemek için /do kullanın.');
});
it('CLI do passes one intent contract and returns pending JSON or human TR/EN preview without an approve flag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-brain-cli-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.deckent')); await writeFile(join(root, '.deckent/config.json'), '{}');
  const calls: unknown[] = [], output: string[] = [], result = pendingBrainFixture();
  const context = { root, env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') },
    stdout: { write(text: string) { output.push(text); } }, stderr: { write(text: string) { output.push(text); } }, async planRun(_root: string, input: unknown) { calls.push(input); return result; } };
  const args = ['do', '--request', command.intent, '--scope', 's', '--command-id', 'brain'];
  expect(await main([...args, '--json'], context)).toBe(0); expect(JSON.parse(output.pop()!)).toEqual(result); expect(calls.pop()).toEqual(command);
  expect(await main([...args, '--lang', 'tr'], context)).toBe(0); const tr = output.pop()!;
  expect(tr).toContain('Komut kimliği: brain'); expect(tr).toContain('Durable business evidence'); expect(tr).toContain('Onay'); expect(tr).toContain('toplam iş harcaması henüz sınırlanmıyor');
  expect(await main([...args, '--lang', 'en'], context)).toBe(0); expect(output.pop()).toContain('no total Run spending limit is enforced');
  const before = calls.length;
  for (const flag of ['--approve', '--yes']) { expect(await main([...args, flag, '--json'], context)).not.toBe(0); expect(output.pop()).toContain('CLI_USAGE'); }
  expect(calls).toHaveLength(before);
  expect(await main(['do', '--request', command.intent, '--lang', 'tr'], context)).toBe(2);
  expect(output.pop()).toContain('CLI_SCOPE_REQUIRED'); expect(calls).toHaveLength(before);
  expect(await main(['do', '--request', '--lang', 'tr'], context)).toBe(2);
  const missingValue = output.pop()!; expect(missingValue).toContain('geçersiz'); expect(missingValue).not.toContain('Usage:');
});
it('MCP plan_run shares the contract, rejects decision fields and has no approval mutator', async () => {
  const calls: unknown[] = [], result = pendingBrainFixture();
  const server = createMcpServer({ inspectRun: async () => ({}), inspectInventory: async () => ({}), planRun: async input => { calls.push(input); return result; } },
    { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'tr');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'brain-test', version: '1' }); await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  expect(tools.find(tool => tool.name === 'plan_run')!.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  expect((await client.callTool({ name: 'plan_run', arguments: command })).structuredContent).toEqual(result); expect(calls.pop()).toEqual(command);
  expect(JSON.stringify(await client.callTool({ name: 'plan_run', arguments: { ...command, decision: 'allow' } }))).toContain('MCP_INPUT_INVALID');
  expect(JSON.stringify(await client.callTool({ name: 'decide_approval', arguments: { scopeId: 's', decision: 'allow' } }))).toContain('MCP_TOOL_UNKNOWN');
  expect(tools.map(tool => tool.name)).not.toContain('decide_approval'); expect(calls).toEqual([]);
});

it('D1 CLI do warns before planning, also in JSON, and never offers permission repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-do-permission-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.deckent')); await writeFile(join(root, '.deckent/config.json'), '{}');
  for (const command of ["chmod go-w -- '/project/.git'", '']) for (const locale of ['en', 'tr']) {
    const order: string[] = [], output: string[] = [], errors: string[] = [], result = pendingBrainFixture();
    const context = { root, env: { HOME: join(root, 'home') }, stdout: { write: (text: string) => output.push(text) }, stderr: { write: (text: string) => { order.push('warning'); errors.push(text); } },
      gitDeliveryPermission: async (_root: string, _options: unknown, confirm?: unknown) => { expect(confirm).toBeUndefined(); return { path: '/project/.git', command, before: '0775', after: '0755' }; },
      planRun: async () => { order.push('plan'); return result; } };
    expect(await main(['do', '--scope', 's', '--request', 'Write the file', '--json', '--lang', locale], context)).toBe(0);
    expect(order).toEqual(['warning', 'plan']); expect(errors.join('')).toContain(command || (locale === 'en' ? 'no command is offered' : 'komut sunulmuyor'));
    if (!command) expect(errors.join('')).not.toContain('chmod');
    expect(JSON.parse(output.join(''))).toEqual(result);
  }
});

it('attributes a same-turn draft to its chat sign-in and keeps a separate Brain card distinct in both languages', () => {
  const pending = pendingBrainFixture(), digest = 'a'.repeat(64);
  const source = { kind: 'model' as const, receipt: { commandId: 'chat', invocationId: 'one', responseDigest: digest,
    reference: { providerId: 'team-subscription', providerVersion: 1, modelId: 'chat-model', modelVersion: 1 } },
    contribution: { schemaVersion: 2 as const, billingAxis: 'subscription' as const, activationRevision: 1, requestDigest: digest,
      bindingDigest: digest, template: { id: 'planning', version: 1, digest }, inputDigest: digest, contextDigest: digest, outputDigest: digest,
      inputSummary: 'Purchase', outputSummary: 'Readback', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } } };
  const view = { ...pending, proposal: { ...pending.proposal, proposal: { ...pending.proposal.proposal, source } } };
  for (const locale of ['en', 'tr'] as const) {
    const card = brainProposalCardLines(view, locale, undefined, { invocationId: 'one', chosenBrain: 'chosen-model' }).join('\n');
    for (const word of ['chat-model', 'team-subscription', 'chosen-model', '/do', '15', 'Durable business evidence']) expect(card).toContain(word);
    expect(card).toContain(locale === 'tr'
      ? 'team-subscription sağlayıcısındaki chat-model, bu planı bu sohbetin abonelik girişiyle hazırladı.'
      : 'chat-model from team-subscription drafted this plan using the subscription sign-in for this chat.');
    expect(card).toContain(locale === 'tr' ? 'Planın amacınıza ulaşacağını doğrulamadı' : 'did not verify that the plan will achieve your goal');
    expect(card).toContain(locale === 'tr' ? 'aynı girişi paylaştığı için kullanılmadı' : 'was not used because it shares this sign-in');
    expect(brainProposalCardLines(view, locale, undefined, { invocationId: 'one', chosenBrain: null }).join('\n')).not.toContain('/do');
    expect(brainProposalCardLines(view, locale).join('\n')).not.toContain(locale === 'tr' ? 'tek abonelik çağrısında' : 'one subscription call');
    expect(brainProposalCardLines(view, locale, undefined, { invocationId: 'different-turn', chosenBrain: 'chosen-model' }))
      .toEqual(brainProposalCardLines(view, locale));
    const unknownUsage = { ...source, contribution: { ...source.contribution, usage: null } };
    const unknown = { ...pending, proposal: { ...pending.proposal, proposal: { ...pending.proposal.proposal, source: unknownUsage } } };
    expect(brainProposalCardLines(unknown, locale, undefined, { invocationId: 'one', chosenBrain: null }).join('\n'))
      .toContain(locale === 'tr' ? 'Toplam token sayısı bildirilmedi' : 'token total is unavailable');
    expect(ErrorRegistry.createError('BRAIN_SAME_TURN_REFUSED', { locale }).message).toContain('/do');
    expect(ErrorRegistry.createError('RUN_PROPOSAL_OUTCOME_UNKNOWN', { locale }).message)
      .toContain(locale === 'tr' ? 'Aynı komutu' : 'same command');
  }
});
