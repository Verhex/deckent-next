/** Cursor, gap, scope and backpressure for an in-process approval/run/worker push.
 * The runtime stays the event-source owner. Missing cursors are never invented. */

export const SURFACE_PUSH_KINDS = ['approval', 'run', 'worker'] as const;
export type SurfacePushKind = typeof SURFACE_PUSH_KINDS[number];
export const SURFACE_WATCH_OWNER = 'terminal-watch';
export const SURFACE_PUSH_QUEUE = 32;

export type SurfaceWaitAction = 'poll-scope' | 'read-next' | 'hold-event' | 'report-gap' | 'refuse-scope';
export type SurfaceWait = {
  readonly timeoutMs: number;
  readonly owner: typeof SURFACE_WATCH_OWNER;
  readonly action: SurfaceWaitAction;
};
export type SurfaceDeliveryMode = 'push' | 'poll';
export type SurfacePushEvent = {
  readonly kind: SurfacePushKind;
  readonly scopeId: string;
  /** Monotonic position for this kind. The next applied event is the previous position plus one. */
  readonly sequence: number;
  readonly id: string;
  readonly text: string;
};
export type SurfacePushState = {
  readonly cursors: Readonly<Record<SurfacePushKind, number | null>>;
  readonly queued: number;
};
export type SurfacePushStep =
  | { readonly status: 'applied'; readonly state: SurfacePushState; readonly wait: SurfaceWait; readonly event: SurfacePushEvent }
  | { readonly status: 'gap'; readonly state: SurfacePushState; readonly wait: SurfaceWait; readonly expected: number; readonly sequence: number }
  | { readonly status: 'backpressure'; readonly state: SurfacePushState; readonly wait: SurfaceWait }
  | { readonly status: 'foreign-scope'; readonly state: SurfacePushState; readonly wait: SurfaceWait }
  | { readonly status: 'invalid'; readonly state: SurfacePushState; readonly wait: SurfaceWait };

export function surfaceWait(action: SurfaceWaitAction, pace: number): SurfaceWait {
  if (!Number.isSafeInteger(pace) || pace < 1) throw new RangeError('SURFACE_WAIT_PACE');
  return { timeoutMs: pace, owner: SURFACE_WATCH_OWNER, action };
}
export function pollWait(pace: number): SurfaceWait {
  return surfaceWait('poll-scope', pace);
}
export function surfaceDeliveryValues(mode: SurfaceDeliveryMode, pace: number) {
  const wait = surfaceWait(mode === 'poll' ? 'poll-scope' : 'read-next', pace);
  return { mode, timeoutMs: wait.timeoutMs, owner: wait.owner, action: wait.action };
}
export function openSurfacePush(): SurfacePushState {
  return { cursors: { approval: null, run: null, worker: null }, queued: 0 };
}

function positiveCursor(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Applies one producer event. A gap or a full queue leaves the position where it was. `pace` is the wait timeout. */
export function acceptSurfaceEvent(state: SurfacePushState, event: SurfacePushEvent, scopeId: string, pace: number): SurfacePushStep {
  if (scopeId.length === 0) return { status: 'invalid', state, wait: surfaceWait('refuse-scope', pace) };
  if (event.scopeId !== scopeId) return { status: 'foreign-scope', state, wait: surfaceWait('refuse-scope', pace) };
  const textOk = typeof event.text === 'string' && event.text.length > 0 && event.text.length <= 2000;
  const idOk = typeof event.id === 'string' && event.id.length > 0 && event.id.length <= 200;
  if (!SURFACE_PUSH_KINDS.includes(event.kind) || !positiveCursor(event.sequence) || !textOk || !idOk) {
    return { status: 'invalid', state, wait: surfaceWait('read-next', pace) };
  }
  const last = state.cursors[event.kind];
  const expected = last === null ? 1 : last + 1;
  if (event.sequence > expected) return { status: 'gap', state, wait: surfaceWait('report-gap', pace), expected, sequence: event.sequence };
  if (event.sequence !== expected) return { status: 'invalid', state, wait: surfaceWait('read-next', pace) };
  if (state.queued >= SURFACE_PUSH_QUEUE) return { status: 'backpressure', state, wait: surfaceWait('hold-event', pace) };
  return {
    status: 'applied', wait: surfaceWait('read-next', pace), event,
    state: { cursors: { ...state.cursors, [event.kind]: event.sequence }, queued: state.queued + 1 },
  };
}

export function releaseSurfacePush(state: SurfacePushState): SurfacePushState {
  return { ...state, queued: state.queued > 0 ? state.queued - 1 : 0 };
}

/** Paints an applied event only for a watched kind. Approval is always visible. Exceptions use the catalog template. */
export function surfaceFollowLine(step: SurfacePushStep, watch: { readonly workers: boolean; readonly runs: boolean }, template: string | undefined): string | null {
  if (step.status === 'applied') {
    const visible = step.event.kind === 'approval' || (step.event.kind === 'worker' && watch.workers) || (step.event.kind === 'run' && watch.runs);
    return visible ? step.event.text : null;
  }
  if (!template || step.status === 'invalid') return null;
  const values: Record<string, string | number> = { status: step.status, timeoutMs: step.wait.timeoutMs, owner: step.wait.owner, action: step.wait.action };
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/** Sequential reader. Releases the slot after an applied event so one painted event does not fill the queue. */
export async function consumeSurfaceFollow(events: AsyncIterable<SurfacePushEvent>, scopeId: string, pace: number, signal: AbortSignal,
  onStep: (step: SurfacePushStep) => void): Promise<void> {
  let state = openSurfacePush();
  for await (const event of events) {
    if (signal.aborted) return;
    const step = acceptSurfaceEvent(state, event, scopeId, pace);
    state = step.status === 'applied' ? releaseSurfacePush(step.state) : step.state;
    onStep(step);
  }
}
