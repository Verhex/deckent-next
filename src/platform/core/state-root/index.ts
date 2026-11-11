/** P5a: the global state root and the compile-cache bootstrap (node: built-ins and the layout registry only); its own unit so the i18n renderer
 * and other node-free units never reach node: modules through `common`. */
export { enableDeckentCompileCache, resolveGlobalStateRoot } from './internal/state-root.js';
export { processExists } from './internal/process-exists.js';
export { TIMING_TRACE_LIMITS, timingEnabled, startTiming, currentTiming, runWithTiming, beginTimingRead, timedAsync, timedSync, timingCommand, catalogParseObserver,
  installTimingFlush, timingFrame, startProcessTiming, flushTiming, type TimingTrace, type TimingPhase } from './internal/timing-trace.js';
export const readTimingSummary = async (env?: NodeJS.ProcessEnv) => (await import('./internal/timing-summary.js')).readTimingSummary(env);
