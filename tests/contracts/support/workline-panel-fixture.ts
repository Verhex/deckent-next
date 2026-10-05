import type { WorklineProps } from '#surfaces/core/terminal/index.js';
/** Existing renderer-only fixtures explicitly simulate a trusted producer. Tests passing a context
 * exercise their own binding producer untouched; production never uses these synthetic identities. */
export function panelFixture(props: Partial<WorklineProps>) {
  const context = props.context ?? { installationId: 'fixture-installation', projectId: 'fixture-project', scopeId: props.ledger?.scopeId ?? 'scope-a' };
  const stream = props.streamTurn;
  return { context, ...(stream && !props.context ? { streamTurn: ((messages, signal, turn) => {
    turn?.onTurnBound?.({ scopeId: context.scopeId, sessionId: turn.sessionId ?? null, turnId: 'fixture-turn', phase: 'command-generated' });
    return stream(messages, signal, turn);
  }) as NonNullable<WorklineProps['streamTurn']> } : {}) };
}
