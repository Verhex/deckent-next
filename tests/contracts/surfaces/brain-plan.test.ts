import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { main } from '../../fixtures/cli-input.js';
import { pendingBrainFixture } from '../support/brain-proposal.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const command = { schemaVersion: 1, scopeId: 's', commandId: 'brain', intent: 'Plan purchase readback' };
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
