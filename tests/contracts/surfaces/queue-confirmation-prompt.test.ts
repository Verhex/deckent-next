import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { askQueueConfirmation } from '#surfaces/core/effect-confirmation/index.js';
import type { QueueConsent } from '#engine/index.js';

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

  it('every answer but an explicit y declines, and no controlling terminal is refused before any question', async () => {
    for (const answer of ['\r', 'n\r', 'yes please\r']) expect((await ask('adopt', 'en', answer)).decision).toBe(false);
    await expect(ask('adopt', 'en', 'y\r', false)).rejects.toMatchObject({ code: 'DELIVERY_INTERACTIVE_REQUIRED' });
  });
});
