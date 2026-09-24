import { Worker } from 'node:worker_threads';

// A model or user regular expression can backtrack for minutes (`^(a+)+$`); run on the service thread it would stall every
// other request and ignore cancellation (Astra 2072 R2). Matching therefore runs in one worker thread per tool call, which is
// terminated on cancel. Compilation stays on the caller (it cannot backtrack) so an invalid pattern is reported at once.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, source, flags, lines }) => {
  const re = new RegExp(source, flags), hits = [];
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i);
  parentPort.postMessage({ id, hits });
});`;

export class RegexCancelled extends Error { constructor() { super('cancelled'); this.name = 'RegexCancelled'; } }

export interface RegexRunner {
  /** Indexes of the lines the expression matches; rejects with RegexCancelled when the signal fires. */
  match(source: string, flags: string, lines: readonly string[]): Promise<number[]>;
  close(): Promise<void>;
}

export function createRegexRunner(signal?: AbortSignal): RegexRunner {
  let worker: Worker | null = null, next = 0;
  const pending = new Map<number, { resolve: (hits: number[]) => void; reject: (error: Error) => void }>();
  const failAll = (error: Error) => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  const stop = () => { const current = worker; worker = null; failAll(new RegexCancelled()); void current?.terminate(); };
  signal?.addEventListener('abort', stop, { once: true });
  const start = () => {
    const created = new Worker(WORKER_SOURCE, { eval: true });
    created.on('message', (message: { id: number; hits: number[] }) => { const entry = pending.get(message.id); pending.delete(message.id); entry?.resolve(message.hits); });
    created.on('error', (error: unknown) => { if (worker === created) { worker = null; failAll(error instanceof Error ? error : new Error('REGEX_WORKER_FAILED')); } });
    created.unref();
    return created;
  };
  return {
    match(source, flags, lines) {
      if (signal?.aborted) return Promise.reject(new RegexCancelled());
      worker ??= start();
      const id = ++next;
      return new Promise<number[]>((resolve, reject) => { pending.set(id, { resolve, reject }); worker!.postMessage({ id, source, flags, lines }); });
    },
    async close() { signal?.removeEventListener('abort', stop); const current = worker; worker = null; failAll(new RegexCancelled()); await current?.terminate(); },
  };
}
