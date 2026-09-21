/** Sample once per validation boundary; sample again after asynchronous authentication. */
export interface ClockSample { readonly wallMs: number; readonly monotonicMs: number }
export interface TrustedClock { sample(): ClockSample }
export class SystemTrustedClock implements TrustedClock {
  sample(): ClockSample { return Object.freeze({ wallMs: Date.now(), monotonicMs: performance.now() }); }
}
