/** Sample once per validation boundary; sample again after asynchronous authentication. */
export interface ClockSample { readonly wallMs: number; readonly monotonicMs: number }
export interface TrustedClock { sample(): ClockSample }
/** Largest wall-time lead of another local process that a durable record may carry (I40). The floor below orders one
 * process only; processes step independently. Measured host steps are 2.0-2.2 s spaced ~30 s apart, so one process
 * leads another by at most about one step; 5 s bounds that with margin. A versioned security invariant, not
 * configuration: it only tolerates ordering skew and never extends an expiry. */
export const MAX_WALL_SKEW_MS = 5_000;
function wallFloor(source: () => number): () => number {
  let floor = 0;
  return () => (floor = Math.max(floor, source()));
}
/** Process-wide floor for wall time. Hosts step the wall clock backwards (measured: 2.1-2.2 s about every 30 s on WSL2),
 * so a later sample in this process never reports an earlier wall time than one already handed out (Jev 6086297e). */
const processWall = wallFloor(() => Date.now());
export class SystemTrustedClock implements TrustedClock {
  private readonly wall: () => number;
  /** Every instance shares the process floor over Date.now. An explicit raw source (tests, deterministic replay)
   * gets the same floor mechanism over that source only. */
  constructor(source?: () => number) { this.wall = source ? wallFloor(source) : processWall; }
  sample(): ClockSample {
    return Object.freeze({ wallMs: this.wall(), monotonicMs: performance.now() });
  }
}
