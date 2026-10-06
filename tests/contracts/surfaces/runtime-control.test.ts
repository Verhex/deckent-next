import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { createMcpServer } from '../../../src/surfaces/core/mcp/index.js';

const descriptor = { schemaVersion: 1 as const, instanceId: 'instance-a', shutdownAvailable: true as const,
  identity: { scopeId: 'service-scope', serviceId: 'runtime' } };
const command = { schemaVersion: 1 as const, commandId: 'command-a', serviceId: 'runtime', instanceId: 'instance-a', reason: 'maintenance' };
const admission = { replayed: false, admission: { schemaVersion: 1 as const, scopeId: 'service-scope', command,
  actor: { principal: { id: 'local', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['service-scope'] },
    evidence: { method: 'os-peer' as const, pid: 10, uid: 1000, gid: 1000 } },
  authorization: { revision: 'policy-a', ruleId: 'shutdown-rule' }, admittedAtMs: 10 } };

function sink() { const values: string[] = []; return { values, output: { write(value: string) { values.push(value); } } }; }

describe('runtime control surfaces', () => {
  it('CLI describes and admits an exact caller-known instance without reporting it stopped', async () => {
    const described = sink(); let shutdownInput: unknown;
    const base = { env: { HOME: '/tmp/deckent-runtime-control' }, stdout: described.output, stderr: described.output, initialize() {} };
    expect(await main(['runtime', 'describe', '--json'], { ...base, async describeRuntimeService() { return descriptor; } })).toBe(0);
    expect(JSON.parse(described.values.join(''))).toEqual(descriptor);

    const accepted = sink();
    expect(await main(['runtime', 'shutdown', '--service', 'runtime', '--instance', 'instance-a', '--command-id', 'command-a',
      '--reason', 'maintenance'], { ...base, stdout: accepted.output, stderr: accepted.output,
      async shutdownRuntimeService(_root, input) { shutdownInput = input; return admission; } })).toBe(0);
    expect(shutdownInput).toEqual(command);
    expect(accepted.values.join('')).toContain('shutdown accepted');
    expect(accepted.values.join('')).not.toContain('stopped');
  });

  it('CLI restart goes through the managed restart handler only, and refuses shutdown fields or an unwired host', async () => {
    let restarts = 0; const output = sink();
    const base = { env: { HOME: '/tmp/deckent-runtime-control' }, stdout: output.output, stderr: output.output, initialize() {} };
    const readiness = { mode: 'started' as const, instanceId: 'instance-b', pid: 4242, logPath: null, shutdownAvailable: true, build: null };
    expect(await main(['runtime', 'restart'], { ...base, async restartRuntimeService() { restarts++; return readiness; } })).toBe(0);
    expect(restarts).toBe(1); expect(output.values.join('')).toContain('restarted'); expect(output.values.join('')).toContain('instance-b');
    // Negative: no handler wired, or hand-written shutdown fields: nothing is restarted and the command fails typed.
    expect(await main(['runtime', 'restart'], base)).not.toBe(0);
    expect(await main(['runtime', 'restart', '--service', 'runtime'], { ...base, async restartRuntimeService() { restarts++; return readiness; } })).not.toBe(0);
    expect(restarts).toBe(1);
  });

  it('CLI rejects incomplete or wire-forged shutdown input before invoking the handler', async () => {
    let invoked = 0; const output = sink();
    const context = { env: { HOME: '/tmp/deckent-runtime-control' }, stdout: output.output, stderr: output.output,
      initialize() {}, async shutdownRuntimeService() { invoked++; return admission; } };
    expect(await main(['runtime', 'shutdown', '--service', 'runtime', '--instance', 'instance-a', '--reason', 'missing-command'], context)).toBe(2);
    expect(await main(['runtime', 'shutdown', '--service', 'runtime', '--instance', 'instance-a', '--command-id', 'command-a',
      '--reason', 'maintenance', '--principal', 'admin'], context)).toBe(2);
    expect(invoked).toBe(0);
  });

  it('MCP advertises optional descriptor and exact destructive shutdown tools', async () => {
    let shutdownInput: unknown;
    const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
      async describeService() { return descriptor; }, async shutdownService(input) { shutdownInput = input; return admission; } },
    { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
    const client = new Client({ name: 'runtime-control-test', version: '1' }); await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.find(tool => tool.name === 'runtime_service_descriptor')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tools.find(tool => tool.name === 'shutdown_runtime_service')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect((await client.callTool({ name: 'runtime_service_descriptor', arguments: {} })).structuredContent).toEqual(descriptor);
      expect((await client.callTool({ name: 'shutdown_runtime_service', arguments: command })).structuredContent).toEqual(admission);
      expect(shutdownInput).toEqual(command);
      expect(JSON.stringify(await client.callTool({ name: 'shutdown_runtime_service', arguments: { ...command, principal: 'admin' } }))).toContain('MCP_INPUT_INVALID');
    } finally { await client.close(); await server.close(); }
  });
});
