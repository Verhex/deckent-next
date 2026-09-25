import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAgentTurnStore } from '#adapters/index.js';
import { AGENT_TURN_INTERRUPTED_NOTE, agentTurnResultDigest, runDurableAgentTurn, type AgentRoundOutcome, type AgentTurnPorts } from '#engine/index.js';
import type { AgentToolSpec, AgentTurnEvent } from '#domain/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { journalMode: 'wal' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
async function file() { const root = await mkdtemp(join(tmpdir(), 'dn-agent-turn-')); roots.push(root); return join(root, 'ledger.db'); }
const claim = (turnId = 't1', requestDigest = 'a'.repeat(64), principalKey = 'host:1000') => ({ scopeId: 'scope', turnId, principalKey, requestDigest, claimedAtMs: 10 });
const outcome = { finish: 'stop' as const, note: null, rounds: 1, toolCalls: 0, appended: [{ role: 'assistant' as const, content: 'hi', toolCalls: [] }] };
const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: { code?: string }) => error.code);

it('binds a turn id to one principal and request: running is in progress, finished replays, anything else conflicts', async () => {
  const store = await openSqliteAgentTurnStore(await file(), options);
  try {
    expect(await store.claim(claim())).toEqual({ status: 'new' });
    expect(await code(store.claim(claim()))).toBe('AGENT_TURN_IN_PROGRESS');
    expect(await code(store.claim(claim('t1', 'b'.repeat(64))))).toBe('AGENT_TURN_CONFLICT');
    expect(await code(store.claim(claim('t1', 'a'.repeat(64), 'host:1001')))).toBe('AGENT_TURN_CONFLICT');
    await store.finish('scope', 't1', outcome, 20);
    expect(await store.claim(claim())).toEqual({ status: 'finished', outcome });
    expect(await code(store.claim(claim('t1', 'b'.repeat(64))))).toBe('AGENT_TURN_CONFLICT');
    // A finished turn is final: no second finish, no late tool call.
    expect(await code(store.finish('scope', 't1', { ...outcome, finish: 'error' }, 30))).toBe('AGENT_TURN_CONFLICT');
    expect(await code(store.recordToolCall({ scopeId: 'scope', turnId: 't1', round: 1, index: 0, callId: 'c', tool: 'read_file', toolVersion: 1,
      argsDigest: null, target: null, status: 'ok', bytes: 1, resultDigest: agentTurnResultDigest('x'), atMs: 30 }))).toBe('AGENT_TURN_CONFLICT');
    expect(await code(store.recordToolCall({ scopeId: 'scope', turnId: 'unknown', round: 1, index: 0, callId: 'c', tool: 'read_file', toolVersion: 1,
      argsDigest: null, target: null, status: 'ok', bytes: 1, resultDigest: agentTurnResultDigest('x'), atMs: 30 }))).toBe('AGENT_TURN_CONFLICT');
  } finally { store.close(); }
});

it('closes turns left running by a stopped service as interrupted at the next start, never resuming them', async () => {
  const path = await file();
  const first = await openSqliteAgentTurnStore(path, options);
  await first.claim(claim('left')); await first.claim(claim('done')); await first.finish('scope', 'done', outcome, 20);
  await first.recordToolCall({ scopeId: 'scope', turnId: 'left', round: 1, index: 0, callId: 'c1', tool: 'read_file', toolVersion: 1,
    argsDigest: 'd'.repeat(64), target: 'src/a.ts', status: 'ok', bytes: 5, resultDigest: agentTurnResultDigest('hello'), atMs: 15 });
  // One record per (round, index): a second record of the same call is a conflict, not an unavailable store.
  expect(await code(first.recordToolCall({ scopeId: 'scope', turnId: 'left', round: 1, index: 0, callId: 'c1', tool: 'read_file', toolVersion: 1,
    argsDigest: null, target: null, status: 'error', bytes: 0, resultDigest: agentTurnResultDigest(''), atMs: 16 }))).toBe('AGENT_TURN_CONFLICT');
  first.close();
  const second = await openSqliteAgentTurnStore(path, options);
  try {
    expect(await second.interruptRunning(100)).toEqual({ interrupted: 1, corrupt: [] });
    expect(await second.interruptRunning(101)).toEqual({ interrupted: 0, corrupt: [] });
    expect(await second.claim(claim('left'))).toEqual({ status: 'finished', outcome: { finish: 'error', note: AGENT_TURN_INTERRUPTED_NOTE, rounds: 0, toolCalls: 1, appended: [] } });
    expect(await second.claim(claim('done'))).toEqual({ status: 'finished', outcome });
  } finally { second.close(); }
});

it('refuses a damaged turn row instead of trusting it, and still closes the intact running turns around it', async () => {
  const path = await file(), store = await openSqliteAgentTurnStore(path, options);
  await store.claim(claim()); await store.finish('scope', 't1', outcome, 20); await store.claim(claim('t2')); store.close();
  const db = new DatabaseSync(path);
  // The row says running while its record is finished: the two disagree.
  db.exec("UPDATE agent_turns SET state='running' WHERE turn_id='t1'"); db.close();
  const reopened = await openSqliteAgentTurnStore(path, options);
  try {
    expect(await code(reopened.claim(claim()))).toBe('AGENT_TURN_CORRUPT');
    expect(await reopened.interruptRunning(30)).toEqual({ interrupted: 1, corrupt: [{ scopeId: 'scope', turnId: 't1' }] });
    expect(await reopened.claim(claim('t2'))).toMatchObject({ status: 'finished', outcome: { finish: 'error', note: AGENT_TURN_INTERRUPTED_NOTE } });
    expect(await code(reopened.claim(claim()))).toBe('AGENT_TURN_CORRUPT');
  } finally { reopened.close(); }
});

const readFile: AgentToolSpec = { name: 'read_file', version: 1, toolClass: 'read', description: 'Read a file.',
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } };
function ports(rounds: AgentRoundOutcome[]) {
  const invoked: number[] = [];
  const value: AgentTurnPorts = {
    async invokeRound(input, onDelta) {
      invoked.push(input.round); const next = rounds[input.round - 1]!;
      if (next.status === 'responded' && next.content) onDelta({ kind: 'text', text: next.content });
      return next;
    },
    async authorize() { return 'allow'; },
    describe(_tool, args) { return typeof args['path'] === 'string' ? args['path'] : null; },
    async execute(_tool, args) { return { status: 'ok', text: `contents of ${String(args['path'])}` }; },
    now: () => 50,
  };
  return { value, invoked };
}
const rounds: AgentRoundOutcome[] = [
  { status: 'responded', content: '', reasoning: '', toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"path":"src/a.ts"}' }], finish: 'tool_calls', usage: null },
  { status: 'responded', content: 'It exports a.', reasoning: '', toolCalls: [], finish: 'stop', usage: null }];

it('records every settled tool call of a durable turn and replays a finished turn without a model round', async () => {
  const path = await file(), store = await openSqliteAgentTurnStore(path, options);
  try {
    const first = ports(rounds), events: AgentTurnEvent[] = [];
    const run = await runDurableAgentTurn({ claim: claim(), messages: [{ role: 'user', content: 'what?' }], tools: [readFile],
      signal: new AbortController().signal, emit: event => events.push(event) }, store, first.value);
    expect(run).toMatchObject({ finish: 'stop', rounds: 2, toolCalls: 1, replayed: false }); expect(first.invoked).toEqual([1, 2]);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare('SELECT round,call_index,record FROM agent_turn_tool_calls').all() as { round: number; call_index: number; record: string }[];
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.record)).toMatchObject({ round: 1, index: 0, callId: 'c1', tool: 'read_file', target: 'src/a.ts', status: 'ok',
        bytes: Buffer.byteLength('contents of src/a.ts'), resultDigest: agentTurnResultDigest('contents of src/a.ts') });
      expect(rows[0]!.record).not.toContain('contents of');
    } finally { db.close(); }
    const again = ports(rounds), replayEvents: AgentTurnEvent[] = [];
    const replay = await runDurableAgentTurn({ claim: claim(), messages: [{ role: 'user', content: 'what?' }], tools: [readFile],
      signal: new AbortController().signal, emit: event => replayEvents.push(event) }, store, again.value);
    expect(again.invoked).toEqual([]);
    expect(replay).toMatchObject({ finish: 'stop', rounds: 2, toolCalls: 1, replayed: true });
    expect(replayEvents).toEqual([{ kind: 'text', text: 'It exports a.' }, { kind: 'done', finish: 'stop', note: null }]);
  } finally { store.close(); }
});

it('still finishes the turn when the loop fails unexpectedly, so the id is never left running', async () => {
  const store = await openSqliteAgentTurnStore(await file(), options);
  try {
    const failing = ports(rounds);
    await expect(runDurableAgentTurn({ claim: claim(), messages: [{ role: 'user', content: 'what?' }], tools: [readFile], signal: new AbortController().signal,
      emit: event => { if (event.kind === 'done') throw new Error('surface closed'); } }, store, failing.value)).rejects.toThrow('surface closed');
    expect(await store.claim(claim())).toMatchObject({ status: 'finished', outcome: { finish: 'error', note: expect.stringMatching(/failed before it could finish/) } });
  } finally { store.close(); }
});

it('returns an answered turn whose outcome could not be stored as unrecorded, and never masks a loop failure with a store failure', async () => {
  const store = await openSqliteAgentTurnStore(await file(), options);
  try {
    const failingFinish = { claim: store.claim.bind(store), recordToolCall: store.recordToolCall.bind(store), interruptRunning: store.interruptRunning.bind(store),
      async finish() { throw Object.assign(new Error('AGENT_TURN_UNAVAILABLE'), { code: 'AGENT_TURN_UNAVAILABLE' }); } };
    const answered = await runDurableAgentTurn({ claim: claim(), messages: [{ role: 'user', content: 'what?' }], tools: [readFile],
      signal: new AbortController().signal, emit: () => undefined }, failingFinish, ports(rounds).value);
    expect(answered).toMatchObject({ finish: 'stop', rounds: 2, recorded: false });
    // Not stored as finished: the id stays running until the next start closes it as interrupted.
    expect(await code(store.claim(claim()))).toBe('AGENT_TURN_IN_PROGRESS');
    await expect(runDurableAgentTurn({ claim: claim('t2'), messages: [{ role: 'user', content: 'what?' }], tools: [readFile], signal: new AbortController().signal,
      emit: event => { if (event.kind === 'done') throw new Error('surface closed'); } }, failingFinish, ports(rounds).value)).rejects.toThrow('surface closed');
  } finally { store.close(); }
});
