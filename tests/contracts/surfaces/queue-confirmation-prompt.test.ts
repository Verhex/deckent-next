import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { askQueueConfirmation, renderQueueConsent, renderQueueStatus } from '#surfaces/core/effect-confirmation/index.js';
import type { QueueConsent, TargetQueueView } from '#engine/index.js';

// QUEUE-SMALL 5: both queue cards asked "Write this reference? y/N". The adoption card moves a branch, so it asks exactly that.
const TARGET = 'refs/heads/dogfood/adopted';
const card = (operation: 'publish' | 'adopt'): Omit<QueueConsent, 'capability'> => ({ schemaVersion: 1, digest: 'd'.repeat(64), operation, expiresAt: Date.now() + 60_000,
  target: { kind: 'git-ref', id: TARGET }, display: { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' },
  items: [{ commandId: 'q1', from: 'a'.repeat(40), to: 'b'.repeat(40), candidateDigest: 'c'.repeat(64), verificationReceipt: 'e'.repeat(64), changes: ['note.txt'] }] });
/** One answer on a stand-in controlling terminal; returns the decision and everything written to it. */
async function ask(operation: 'publish' | 'adopt', locale: 'en' | 'tr', answer: string, tty = true) {
  const input = Object.assign(new PassThrough(), { isTTY: tty }), output = new PassThrough();
  let written = ''; output.on('data', chunk => { written += String(chunk); });
  const decision = askQueueConfirmation(card(operation), locale, input, output, { timeoutMs: 5_000 });
  setTimeout(() => input.write(answer), 20);
  return { decision: await decision, written };
}

describe('queue confirmation questions', () => {
  it('the adoption card asks whether the branch moves to the verified commit, in English and Turkish; publication keeps its question', async () => {
    const adopt = await ask('adopt', 'en', 'y\r');
    expect(adopt).toMatchObject({ decision: true }); expect(adopt.written).toContain(`Move ${TARGET} to the verified commit? y/N: `);
    expect(adopt.written).not.toContain('Write this reference?');
    const turkish = await ask('adopt', 'tr', 'y\r');
    expect(turkish).toMatchObject({ decision: true }); expect(turkish.written).toContain(`${TARGET} doğrulanmış commit'e taşınsın mı? y/N: `);
    const publish = await ask('publish', 'en', 'y\r');
    expect(publish).toMatchObject({ decision: true }); expect(publish.written).toContain('Write this reference? y/N: ');
    expect(publish.written).not.toContain('to the verified commit');
  });

  it('alpha.53 A3: summary lines stand above the exact card, which stays byte-identical; without them nothing is added', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true }), output = new PassThrough(); let written = '';
    output.on('data', chunk => { written += String(chunk); });
    const publish = card('publish'), decision = askQueueConfirmation(publish, 'en', input, output, { timeoutMs: 5_000, summary: ['Summary (your yes approves the exact card below, nothing else):', 'Work: \u001b[31mfix'] });
    setTimeout(() => input.write('n\r'), 20);
    expect(await decision).toBe(false);
    expect(written.startsWith('Summary (your yes approves the exact card below, nothing else):\nWork:  [31mfix\n' + renderQueueConsent(publish, 'en') + '\n')).toBe(true);
    expect((await ask('publish', 'en', 'n\r')).written.startsWith(renderQueueConsent(publish, 'en').split('\nExpires')[0]!)).toBe(true);
  });

  it('every answer but an explicit y declines, and no controlling terminal is refused before any question', async () => {
    for (const answer of ['\r', 'n\r', 'yes please\r']) expect((await ask('adopt', 'en', answer)).decision).toBe(false);
    await expect(ask('adopt', 'en', 'y\r', false)).rejects.toMatchObject({ code: 'DELIVERY_INTERACTIVE_REQUIRED' });
  });
});

// DOGFOOD-50 friction 14: a refused ticket showed only "stale-refused"; its typed cause is shown next to the outcome, in both locales.
describe('queue status window', () => {
  const view = (outcome: TargetQueueView['outcome'], reason: string | null): TargetQueueView => ({ schemaVersion: 1, commandId: 'q1',
    identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' }, operation: 'delivery', target: { kind: 'git-ref', id: TARGET },
    display: card('publish').display, state: 'settled', outcome, revision: 3, observedAt: 1, freshness: 'last-known', position: null, nextAction: 'prepare-current',
    responsibility: 'service', basis: null, verification: null, evidenceRefs: [], reason });
  it('a settled refusal shows its outcome and its typed reason; a ticket without a reason keeps the outcome alone', () => {
    const en = renderQueueStatus(view('stale-refused', 'QUEUE_PREPARATION_REFUSED'), 'en'), tr = renderQueueStatus(view('stale-refused', 'QUEUE_PREPARATION_REFUSED'), 'tr');
    expect(en).toContain('The candidate could not be prepared on the current target'); expect(tr).toContain('Aday güncel hedef üzerinde hazırlanamadı');
    expect(en).not.toContain('error.'); expect(tr).not.toContain('error.');
    const plain = renderQueueStatus(view('stale-refused', null), 'en');
    expect(plain).not.toContain('could not be prepared'); expect(en.startsWith(plain.slice(0, plain.indexOf('\nResponsible')))).toBe(true);
  });
});
