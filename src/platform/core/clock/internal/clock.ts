/** Sample once per validation boundary; sample again after asynchronous authentication. */
export interface ClockSample { readonly wallMs: number; readonly monotonicMs: number }
export interface TrustedClock { sample(): ClockSample }
/** Process-wide floor for wall time. Hosts step the wall clock backwards (measured: 2.1-2.2 s about every 30 s on WSL2),
 * so a later sample in this process never reports an earlier wall time than one already handed out (Jev 6086297e). */
let wallFloor = 0;
export class SystemTrustedClock implements TrustedClock {
  sample(): ClockSample {
    wallFloor = Math.max(wallFloor, Date.now());
    return Object.freeze({ wallMs: wallFloor, monotonicMs: performance.now() });
  }
}
