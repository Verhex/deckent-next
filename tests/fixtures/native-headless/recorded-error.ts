// Synthetic host, real K1 coordinator, approval seal and SQLite insert. No provider or installed state.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { openSqliteAgentTurnStore, openSqliteApprovalStore } from '#adapters/index.js';
import { agentToolResult, runDurableAgentTurn, requestAgentToolApproval, settleAgentToolApproval, approvalRequestDigest, sealApproval } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import type { ToolSessionPort } from '#capabilities/index.js';

export type RecordedErrorCase = 'nonzero' | 'person-no' | 'session' | 'uncertain';
export const errorCallArgs = { command: 'exit 1' };
export async function withRecordedToolError(directory: string, variant: RecordedErrorCase, inspect: (port: ToolSessionPort) => Promise<void>) {
  const turnId = 'fixture-turn', options = { journalMode: 'wal' as const, durability: 'full' as const, busyTimeoutMs: 2000 };
  const path = join(directory, 'fixture.sqlite'), store = await openSqliteAgentTurnStore(path, options);
  const journal = openSqliteApprovalStore(path, options), integrity = createHmacIntegrity('fixture', randomBytes(32));
  const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 1000 }) };
  const tool = { name: 'run_shell', version: 1, toolClass: 'shell' as const, description: 'Synthetic command',
    inputSchema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } };
  const session = { schemaVersion: 1 as const, turnId, generation: 1, tools: [tool], approvalTtlMs: 60000 };
  let executions = 0, inspected = false, failure: unknown;
  if (variant === 'uncertain') store.recordToolCall = async () => { throw new Error('fixture insert failure'); };
  try {
    await runDurableAgentTurn({ claim: { scopeId: 'scope', turnId, principalKey: 'synthetic', requestDigest: 'a'.repeat(64), claimedAtMs: 1000 },
      messages: [], tools: session.tools, nativeSession: session, emit() {}, signal: new AbortController().signal }, store, {
      now: () => 1000, invokeRound: async () => { throw new Error('unexpected pull round'); },
      async invokeAgent({ session: host }) {
        // A malformed correlation gets K1's real session refusal with the proposed call id, through the same envelope constructor.
        const port: ToolSessionPort = variant === 'session' ? { ...host, propose: (call, corr, signal) =>
          host.propose(call, { ...corr, kind: 'codex-mcp', callId: '', itemId: 'fixture' }, signal) } : host;
        try { await inspect(port); inspected = true; } catch (error) { failure = error; }
        return { status: 'responded', content: 'finished', reasoning: '', toolCalls: [], finish: 'stop', usage: null };
      },
      describe: () => 'fixture', authorize: async () => variant === 'person-no' ? 'require-approval' : 'allow',
      async requestApproval(input, signal) {
        const record = requestAgentToolApproval(journal.store, integrity, { scopeId: 'scope', requester: { id: 'ai', issuer: 'fixture/mcp', subject: 'ai' },
          subject: { kind: 'agent-tool-call', turnId, round: input.round, index: input.index, tool: tool.name, toolVersion: 1, resource: 'fixture', argsDigest: input.argsDigest },
          summary: 'Synthetic decision', policyRevision: 'fixture', createdAt: 1000, expiresAt: 61000 });
        journal.store.transition(record, sealApproval({ ...record, revision: 1, status: 'decided', decision: { schemaVersion: 4, decision: 'deny',
          deciderClass: 'human-tty', assurance: 'peer-session', commandId: 'no', actor: { id: 'person', issuer: 'fixture', subject: 'person' },
          channel: 'local-terminal-card', sessionId: 'person', reason: 'No', decidedAt: 1000, requestDigest: approvalRequestDigest(record.request),
          commandDigest: 'b'.repeat(64), idempotencyKeyHash: 'c'.repeat(64) } }, integrity));
        return settleAgentToolApproval(journal.store, integrity, record, clock, signal, clock.sample(), input.personDenied ? { personDenied: input.personDenied } : {});
      },
      async execute() {
        executions++;
        const exit = spawnSync(errorCallArgs.command, { shell: true, cwd: directory, stdio: 'ignore' });
        if (exit.error || exit.signal || exit.status !== 1) throw new Error('synthetic shell did not exit with 1');
        return agentToolResult({ status: 'error', text: 'synthetic exit ' + exit.status, cleanup: 'clean' }, 'ordinary');
      },
    });
    if (failure) throw failure;
    if (!inspected) throw new Error('driver was never reached');
    if (executions !== (variant === 'nonzero' || variant === 'uncertain' ? 1 : 0)) throw new Error('unexpected execution count');
  } finally { journal.close(); store.close(); }
}
