import { open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { agentToolArgumentsDigest, agentTurnResultDigest } from '#engine/core/agent-turn/index.js';
import { AI_PROPOSAL_TOOL_SPECS } from '#engine/index.js';

// Sandbox recording double only. No planner, approval, admission, installation or business effect.
export function preparationFixture(turnId, approvalTtlMs, custodyFile) {
  const tools = AI_PROPOSAL_TOOL_SPECS.filter(tool => tool.name === 'propose_work');
  if (tools.length !== 1) throw new Error('PREPARATION_TOOL_MISSING');
  const session = { schemaVersion: 1, turnId, generation: 1, tools, approvalTtlMs };
  const events = [], calls = new Map();
  let token, P, released = false;
  const record = async row => {
    const file = await open(custodyFile, 'a', 0o600);
    try { await file.writeFile(JSON.stringify(row) + '\n'); await file.sync(); } finally { await file.close(); }
    events.push(row);
  };
  const closure = kind => ({ kind, turnId, generation: 1, pendingCallIds: [], termination: 'confirmed', effects: 'settled' });
  return { events, session, get token() { return token; }, get P() { return P; }, get calls() { return calls.size; },
    port: { session, async propose(call, correlation, signal) {
      signal.throwIfAborted();
      if (call.name !== tools[0].name) throw new Error('UNEXPECTED_PREPARATION_TOOL');
      if (JSON.stringify(JSON.parse(call.argumentsJson)) !== '{"request":"prepare a purchase with durable business readback"}') throw new Error('UNEXPECTED_PREPARATION_ARGUMENTS');
      const argsDigest = agentToolArgumentsDigest(call.name, JSON.parse(call.argumentsJson));
      const prior = calls.get(call.id);
      if (prior) { if (prior.argsDigest !== argsDigest) throw new Error('PREPARATION_REPLAY_CONFLICT'); return prior.result; }
      if (released) throw new Error('SECOND_PREPARATION_FORBIDDEN');
      // A recording pin is synthetic custody, never a real product invocation/source receipt.
      token = randomBytes(32).toString('hex');
      P = 'No work was admitted or executed. Return this line at byte zero, LF, then exactly one BrainDraft JSON object:\nDECKENT-PLAN-CHALLENGE/1 ' + token;
      const result = Object.freeze({ schemaVersion: 1, turnId, generation: 1, deckentCallId: call.id, outcome: { status: 'ok', text: P } });
      // P already includes the token; fsync completes before resolving the tool promise.
      await record({ kind: 'fixture-settlement', turnId, generation: 1, callId: call.id, correlation, argsDigest,
        P, bytes: Buffer.byteLength(P), resultDigest: agentTurnResultDigest(P), result });
      calls.set(call.id, { argsDigest, result }); released = true;
      await record({ kind: 'fixture-release', callId: call.id });
      return result;
    }, cancel: async () => closure('cancelled'), revoke: async () => closure('revoked') },
  };
}

export const recordingSystem = 'You are recording a harmless planning protocol in an isolated sandbox. Use only the provided propose_work preparation fixture. It admits and executes nothing. No other tools, files, secrets, commands or network requests. Output a short early BrainDraft JSON object BEFORE calling preparation. Then call propose_work exactly once with request "prepare a purchase with durable business readback". Wait for its result. In a separate final assistant message output the exact challenge line from that result at byte zero, one LF, then exactly one complete BrainDraft JSON object. No Markdown or trailing prose. Do not repeat the challenge anywhere else. Finish normally. This recording does not grant work authority.';
export const recordingStdin = 'First emit an early draft. Then make the one preparation call. Finally emit the challenge-framed final draft. The BrainDraft shape is {"graph":{"schemaVersion":4,"revision":1,"tasks":[{"id":"task","kind":"purchase","workClass":"business","dependencies":[],"acceptanceCriteria":["readback"]}],"criterionDefinitions":[{"id":"readback","version":1,"description":"Durable business readback","evaluator":{"id":"process-exit","version":1},"parameters":{"acceptedExitCodes":[0]}}]},"budgetCeiling":{"currency":"USD","limitMinorUnits":200},"requiredPermissions":[]}. This is fixture data only; a process-exit criterion is not ERP acceptance.\n';
