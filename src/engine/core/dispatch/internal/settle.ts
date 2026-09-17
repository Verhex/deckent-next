import { AttemptError, applyAttemptObservation, sameAttemptIdentity, type AttemptSnapshot } from '#domain/index.js';
import { DispatchError, type DispatchClaim, type DispatchTerminal } from './port.js';

/** Application-owned evidence projection, evaluated inside the store's atomic settlement transaction.
 * A process exit is not Task acceptance. Cancellation intent remains independent of observed exit.
 */
export function projectDispatchTerminal(current: AttemptSnapshot, claim: DispatchClaim, terminal: DispatchTerminal): AttemptSnapshot {
  if (!sameAttemptIdentity(current.identity, claim.request.identity)) throw new DispatchError('DISPATCH_CONFLICT');
  try { return applyAttemptObservation(current, { protocolVersion: 1, identity: current.identity,
    sequence: (current.lastObservation?.sequence ?? 0) + 1, eventId: 'dispatch-terminal',
    result: { kind: 'exited', exitCode: terminal.exitCode, ...(terminal.signal === undefined ? {} : { signal: terminal.signal }) } }, current.revision); } catch (error) {
    if (error instanceof AttemptError) throw new DispatchError('DISPATCH_CONFLICT');
    throw error;
  }
}
