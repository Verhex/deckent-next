import { expect, it } from 'vitest';
import {
  applyAttemptObservation, createAttempt, createRun, requestAttemptCancellation, requestRunCancellation,
  reserveRunTasks,
} from '#domain/index.js';
import { selectReservedTaskProfile } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const identity = Object.freeze({ runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 });
const graph = Object.freeze({ schemaVersion: 2 as const, revision: 1,
  tasks: Object.freeze([{ id: 't', kind: 'fixture', dependencies: Object.freeze([]), acceptanceCriteria: Object.freeze(['verified']) }]),
  criterionDefinitions: Object.freeze([{ id: 'verified', version: 1, description: 'Verify fixture', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }]) });

function fixture() {
  const run = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
  const reserved = reserveRunTasks(run, 0, [identity], 0);
  return { run: reserved, attempt: createAttempt(identity) };
}

it('returns the exact immutable profile selected and stored at admission', () => {
  const f = fixture();
  expect(selectReservedTaskProfile(f.run, f.attempt, identity)).toEqual(f.run.execution.tasks[0]!.profile);
});

it.each([
  ['foreign identity', () => ({ ...identity, generation: 2 })],
  ['cancelled Run', () => identity],
  ['cancelled Attempt', () => identity],
  ['observed Attempt', () => identity],
] as const)('rejects %s before selecting a profile', (_name, identityInput) => {
  const f = fixture(); let run = f.run; let attempt = f.attempt; const candidate = identityInput();
  if (_name === 'cancelled Run') run = requestRunCancellation(run, run.revision);
  if (_name === 'cancelled Attempt') attempt = requestAttemptCancellation(attempt, 0);
  if (_name === 'observed Attempt') attempt = applyAttemptObservation(attempt, { protocolVersion: 1, identity, sequence: 1, eventId: 'started', result: { kind: 'started' } }, 0);
  expect(() => selectReservedTaskProfile(run, attempt, candidate)).toThrow('RUN_STORE_CONFLICT');
});

it('rejects a tampered stored criterion fingerprint before profile selection', () => {
  const f = fixture(); const tampered = { ...f.run, execution: { ...f.run.execution,
    criteria: f.run.execution.criteria.map(entry => ({ ...entry, fingerprint: 'f'.repeat(64) })) } };
  expect(() => selectReservedTaskProfile(tampered, f.attempt, identity)).toThrow('RUN_EXECUTION_INTEGRITY');
});
