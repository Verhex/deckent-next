import type { RunLifecycleTiming } from './lifecycle.js';
import { cancelRunAttempt, type CancelledAttemptDispatch } from './settle.js';

/** Application proof that launch permission was denied before execution (no claim, or the launch decision itself). This is not a
 * supervisor observation or a fabricated exit. Existing uncertain effects must remain open; a granted launch is never prevented. */
export const preventRunAttempt = (input: unknown, expectedRevision: number, attemptInput: unknown, dispatch: CancelledAttemptDispatch, timing: RunLifecycleTiming) =>
  cancelRunAttempt(input, expectedRevision, attemptInput, dispatch, 'prevent', timing);
