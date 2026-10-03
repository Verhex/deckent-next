import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateHandoff, verifyAcceptedHandoffSource } from '#engine/core/task-inputs/index.js';
import { recordAttemptHandoffStart, readAttemptHandoffEvents } from '#engine/core/task-inputs/index.js';
import { createAttempt } from '#domain/index.js';
const source = { scopeId: 's', runId: 'r', taskId: 'a', attemptId: 'a1', generation: 1, layoutRevision: 'l' };
const target = { ...source, taskId: 'b', attemptId: 'b1' };
const digest = 'a'.repeat(64);
const note = { summary: 'ready', artifacts: [{ name: 'code', digest }], openQuestions: [] };
const envelope = (handoff = note) => ({ schemaVersion: 1, identity: source, completeness: 'complete', stdout: JSON.stringify({
  schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: { schemaVersion: 1, summary: 'done', changedFiles: [], checks: [], openIssues: [], handoff, sharedNotes: ['run-scoped'] } }), stderr: '', files: [{ name: 'code', status: 'collected', receipt: { schemaVersion: 1, scopeId: 's', digest, byteLength: 4 } }] });
describe('handoff custody', () => {
  it('validates note against recorded artifact digest and retains a digest of exact note bytes', () => {
    expect(evaluateHandoff(envelope())).toEqual({ status: 'valid', digest: createHash('sha256').update(JSON.stringify(note)).digest('hex') });
  });
  it('refuses mismatching artifact even though artifact exists', () => {
    expect(evaluateHandoff(envelope({ ...note, artifacts: [{ name: 'code', digest: 'b'.repeat(64) }] }))).toMatchObject({ status: 'invalid', code: 'HANDOFF_ARTIFACT_MISMATCH' });
  });
  it('refuses nonexistent artifact', () => {
    expect(evaluateHandoff(envelope({ ...note, artifacts: [{ name: 'absent', digest }] }))).toMatchObject({ status: 'invalid', code: 'HANDOFF_ARTIFACT_MISMATCH' });
  });
  it('refuses duplicate artifacts', () => {
    expect(evaluateHandoff(envelope({ ...note, artifacts: [note.artifacts[0]!, note.artifacts[0]!] }))).toMatchObject({ status: 'invalid' });
  });
  it.each(['failed', 'skipped', 'awaiting-decision', 'waiting'])('refuses %s source irrespective of output existence', phase => {
    expect(() => verifyAcceptedHandoffSource(source, source, phase)).toThrowError('HANDOFF_SOURCE_NOT_ACCEPTED');
  });
  it('refuses the wrong full source attempt identity', () => {
    expect(() => verifyAcceptedHandoffSource(source, { ...source, generation: 2 }, 'accepted')).toThrowError('HANDOFF_SOURCE_NOT_ACCEPTED');
  });
  it('missing structured output produces no handoff (Codex/Cursor fallback)', () => {
    expect(evaluateHandoff({ ...envelope(), stdout: 'plain worker output' })).toBeUndefined();
  });
  it('records exact event idempotently without changing supervisor sequence/revision', async () => {
    const snapshot = createAttempt(target); let receipt: { commandId: string; command: string; snapshot: typeof snapshot } | null = null; let writes = 0;
    const store = { async load() { return snapshot; }, async receipt() { return receipt; }, async commit(value: { commandId: string; command: string; snapshot: typeof snapshot }) { writes++; return receipt = value; } };
    const events = [{ kind: 'handoff-received' as const, source, digest }];
    await recordAttemptHandoffStart(store, target, events);
    await recordAttemptHandoffStart(store, target, events);
    expect(writes).toBe(1); expect(receipt!.snapshot).toEqual(snapshot);
    expect(await readAttemptHandoffEvents(store, target)).toMatchObject({ identity: target, events });
    await expect(readAttemptHandoffEvents(store, { ...target, taskId: 'wrong' })).rejects.toThrow();
  });
});
