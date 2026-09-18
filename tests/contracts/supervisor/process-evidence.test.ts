import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { validateProcessEvidence, type ProcessEvidence } from '#adapters/index.js';
const command = { schemaVersion: 1 as const, requestId: randomUUID(), executable: process.execPath, args: [], cwd: process.cwd(), env: {}, timeoutMs: 1000, outputBytes: 2 };
const good: ProcessEvidence = { schemaVersion: 1, requestId: command.requestId, started: true, reason: 'exit', exitCode: 0, signal: null,
  stdoutBase64: Buffer.from([0xc3, 0x28]).toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 };
it('accepts correlated raw byte evidence, explicit no-start and bounded truncated signal evidence', () => {
  expect(validateProcessEvidence(command, good)).toEqual(good);
  expect(validateProcessEvidence(command, { ...good, started: false, reason: 'start-failed', exitCode: null, stdoutBase64: '' }).started).toBe(false);
  expect(validateProcessEvidence(command, { ...good, reason: 'output-limit', exitCode: null, signal: 'SIGKILL', stdoutTruncated: true }).stdoutTruncated).toBe(true);
});
it.each([
  { requestId: randomUUID() }, { schemaVersion: 2 }, { extra: true }, { durationMs: Infinity }, { durationMs: -1 },
  { signal: 'SIGTERM' }, { exitCode: null }, { started: false }, { reason: 'start-failed' }, { reason: 'signal' },
  { reason: 'output-limit' }, { stdoutTruncated: true }, { stdoutBase64: 'AB==' }, { stdoutBase64: 'YWJj' },
  { stdoutBase64: 'a===' }, { stdoutBase64: 'YQ' }, { stdoutBase64: 'YQ==\n' },
  { reason: 'output-limit', stdoutTruncated: true, stdoutBase64: 'YQ==', exitCode: null, signal: 'SIGKILL' },
])('rejects mismatched, malformed or unbounded command evidence %j', changes => {
  expect(() => validateProcessEvidence(command, { ...good, ...changes })).toThrow('PROCESS_RUNNER_RESPONSE_INVALID');
});
