import { describe, expect, it } from 'vitest';
import { TargetBatchConfirmation, targetBatchDigest, type BatchPeer, type TargetBatch } from '#engine/index.js';
const peer: BatchPeer = { scopeId: 's', sessionId: 'session', principal: { issuer: 'test', subject: 'owner' }, peerPid: 100, channel: 'terminal' };
const batch: TargetBatch = { schemaVersion: 1, operation: 'publish', target: { schemaVersion: 1, installationId: 'i', adapter: { id: 'adapter', version: 1 },
  resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'key' } }, ownerInstance: 'service', epoch: 1, policyRevision: 'p1', expiresAt: 1000,
  items: [{ scopeId: 's', commandId: 'c', ordinal: 1, revision: 3, candidateDigest: 'b'.repeat(64), custodyReceipt: 'c'.repeat(64), verificationReceipt: 'd'.repeat(64),
    from: 'V7', to: 'V8', effectCommandIds: ['publish-command', 'adopt-command'] }] };
function fixture() {
  let now = 10, active = true, start = 'start-1', tty: string | null = 'tty-1', audit = true;
  const decisions: string[] = [];
  const app = new TargetBatchConfirmation({ async capture() { return tty ? { processStart: start, terminal: tty } : null; },
    async sessionActive() { return active; }, async record(_peer, digest, operation, answer) { if (!audit) throw new Error('audit-failed'); decisions.push(`${operation}:${answer}:${digest}`); } }, 4, () => now);
  return { app, decisions, time: (value: number) => { now = value; }, active: (value: boolean) => { active = value; },
    start: (value: string) => { start = value; }, tty: (value: string | null) => { tty = value; }, audit: (value: boolean) => { audit = value; } };
}
describe('service batch confirmation', () => {
  it('records one decision for the exact displayed operation and cannot replay the capability', async () => {
    const f = fixture(), capability = await f.app.challenge(peer, batch);
    const guard = await f.app.answer(peer, batch, capability, 'allow'); await guard();
    expect(f.decisions).toEqual([`publish:allow:${targetBatchDigest(batch)}`]);
    await expect(f.app.answer(peer, batch, capability, 'allow')).rejects.toThrow('QUEUE_CONFIRMATION_REQUIRED');
    await expect(f.app.answer(peer, { ...batch, operation: 'adopt' }, capability, 'allow')).rejects.toThrow('QUEUE_CONFIRMATION_REQUIRED');
    f.time(1000); await expect(guard()).rejects.toThrow('QUEUE_EXPIRED');
  });
  it.each(['mcp', 'sdk', 'ai'] as const)('refuses %s at challenge and answer ingress even with the real capability', async channel => {
    const f = fixture(), capability = await f.app.challenge(peer, batch), forged = { ...peer, channel };
    await expect(f.app.challenge(forged, batch)).rejects.toThrow('QUEUE_AUTHORITY_REQUIRED');
    await expect(f.app.answer(forged, batch, capability, 'allow')).rejects.toThrow('QUEUE_AUTHORITY_REQUIRED');
    expect(f.decisions).toEqual([]);
  });
  it.each(['digest', 'peer', 'session', 'start', 'tty', 'expired', 'restart'] as const)('refuses changed %s after a legitimate challenge', async mutation => {
    const f = fixture(), capability = await f.app.challenge(peer, batch);
    if (mutation === 'start') f.start('reused-pid'); if (mutation === 'tty') f.tty(null); if (mutation === 'expired') f.time(1000);
    if (mutation === 'session') f.active(false);
    const app = mutation === 'restart' ? fixture().app : f.app;
    await expect(app.answer(mutation === 'peer' ? { ...peer, peerPid: 101 } : peer,
      mutation === 'digest' ? { ...batch, policyRevision: 'p2' } : batch, capability, 'allow')).rejects.toThrow();
    expect(f.decisions).toEqual([]);
  });
  it('decline, non-TTY and audit failure never issue an effect guard', async () => {
    const f = fixture(); f.tty(null); await expect(f.app.challenge(peer, batch)).rejects.toThrow('QUEUE_AUTHORITY_REQUIRED');
    f.tty('tty-1'); const declined = await f.app.challenge(peer, batch);
    await expect(f.app.answer(peer, batch, declined, 'decline')).rejects.toThrow('QUEUE_CONFIRMATION_REQUIRED');
    const capability = await f.app.challenge(peer, batch); f.audit(false);
    await expect(f.app.answer(peer, batch, capability, 'allow')).rejects.toThrow('audit-failed');
    f.audit(true); await expect(f.app.answer(peer, batch, capability, 'allow')).rejects.toThrow('QUEUE_CONFIRMATION_REQUIRED');
  });
  it('rechecks process incarnation and active session immediately before effect', async () => {
    const f = fixture(), token = await f.app.challenge(peer, batch), guard = await f.app.answer(peer, batch, token, 'allow');
    f.start('new-start'); await expect(guard()).rejects.toThrow('QUEUE_CONFIRMATION_REQUIRED'); f.start('start-1');
    f.active(false); await expect(guard()).rejects.toThrow('QUEUE_AUTHORITY_REQUIRED');
  });
});
