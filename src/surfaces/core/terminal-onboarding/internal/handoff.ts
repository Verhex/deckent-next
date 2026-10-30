import { useEffect, useRef } from 'react';
import { useApp } from 'ink';
import type { FirstTaskIntent, OnboardingFocus } from './contract.js';
export type OnboardingHandoff = Readonly<{ initial: FirstTaskIntent | null; open(signal: AbortSignal, focus?: OnboardingFocus): Promise<FirstTaskIntent | null>;
  /** Said when a message waits as a draft for a model (catalog text; the raw TERMINAL_CHAT_NOT_CONFIGURED is not shown to the person). */
  modelDraft: string }>;
/** Selected intent is submitted once to the ordinary Workline input queue, preserving its /do command identity. */
export function useOnboardingHandoff(input: Readonly<{ port?: OnboardingHandoff | undefined; submit(id: string, line: string): boolean;
  release?(): void; reclaim?(): void }>) {
  const { suspendTerminal } = useApp(), latest = useRef(input), started = useRef(false), queued = useRef(new Map<string, FirstTaskIntent>());
  latest.current = input;
  const enqueue = (intent: FirstTaskIntent | null) => {
    if (!intent || queued.current.has(intent.commandId)) return;
    queued.current.set(intent.commandId, intent);
    if (!latest.current.submit(intent.commandId, `/do ${intent.intent}`)) queued.current.delete(intent.commandId);
  };
  useEffect(() => { if (!started.current) { started.current = true; enqueue(latest.current.port?.initial ?? null); } }, []);
  return {
    intent: (inputId: string) => queued.current.get(inputId),
    settled: (inputId: string) => queued.current.delete(inputId),
    async open(signal: AbortSignal, focus?: OnboardingFocus) {
      if (!latest.current.port) return;
      let intent: FirstTaskIntent | null = null;
      await suspendTerminal(async () => { latest.current.release?.();
        try { intent = await latest.current.port!.open(signal, focus); } finally { latest.current.reclaim?.(); } });
      enqueue(intent);
    },
  };
}
