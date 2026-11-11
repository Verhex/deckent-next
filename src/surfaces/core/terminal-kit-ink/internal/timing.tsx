import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { runWithTiming, timingFrame, type TimingTrace } from '#platform/index.js';

export const TimingFrameContext = createContext<TimingTrace | undefined>(undefined);
export function useTimingFrame(populated: boolean) {
  const trace = useContext(TimingFrameContext);
  useEffect(() => { void timingFrame(trace, populated).catch(() => undefined); }, [trace, populated]);
  return useMemo(() => ({ fail: () => trace?.fail(), run: async <T,>(read: () => T): Promise<Awaited<T>> => {
    if (trace) await timingFrame(trace, false);
    return await runWithTiming(trace, read);
  } }), [trace]);
}
export function TimingPopulatedFrame({ children }: { readonly children: ReactNode }) {
  useTimingFrame(true); return children;
}

/** Runs only when a command's window has committed. Data windows own their later populated milestone. */
export function TimingWindowFrame({ trace }: { readonly trace: TimingTrace | undefined }) {
  useEffect(() => {
    if (!trace) return;
    void timingFrame(trace, false).then(() => { if (!['model', 'provider', 'status', 'doctor', 'chat-backend'].includes(trace.command)) trace.finish(); }).catch(() => undefined);
  }, [trace]);
  return null;
}
