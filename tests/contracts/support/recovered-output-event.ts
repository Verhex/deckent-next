import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { attemptIdentitySchema, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';

const eventSchema = z.object({ event: z.literal('reconciliation'), result: z.object({ outcomes: z.array(z.object({
  identity: attemptIdentitySchema, status: z.string(), completeness: z.string().optional(),
})) }) });

/** Subscribe at service spawn, before awaiting readiness: recovery can finish before ready is consumed.
 * Terminal cancellation is not output recovery. The CLI emits this page only after recoverOutput returns.
 * The caller owns the existing process timeout and kills the child on failure (closing this stream).
 */
export function waitForRecoveredOutput(stdout: Readable, identity: AttemptIdentity): Promise<void> {
  const lines = createInterface({ input: stdout });
  const completed = new Promise<void>((resolve, reject) => {
    lines.once('close', () => {
      // readline.close pauses input; the installed harness must keep draining later ready/stopped diagnostics.
      stdout.resume(); reject(new Error(`RECOVERY_OUTPUT_EVENT_MISSING: ${identity.attemptId}`));
    });
    lines.once('error', reject);
    lines.on('line', line => {
      let value: unknown;
      try { value = JSON.parse(line); } catch { return; }
      const event = eventSchema.safeParse(value);
      if (event.success && event.data.result.outcomes.some(outcome => sameAttemptIdentity(outcome.identity, identity)
        && outcome.status === 'output-recovered' && outcome.completeness === 'partial')) {
        resolve(); lines.close();
      }
    });
  });
  // Other assertions can fail before the caller awaits recovery; retain the rejection for that await.
  void completed.catch(() => undefined);
  return completed;
}
