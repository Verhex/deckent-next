import type { WorkerLineLabels } from '#surfaces/core/terminal/index.js';

const phases = { starting: 'starting', thinking: 'thinking', reading: 'reading', editing: 'editing', running: 'running', searching: 'searching',
  fetching: 'fetching', delegating: 'delegating', finished: 'finished', failed: 'failed' } as const;

/** Plain English worker-line labels for surface tests (production labels come from the i18n catalog in the CLI adapter). */
export const WORKER_LINE_EN: WorkerLineLabels = { numberLocale: 'en', ordinal: 'worker {n}', phases, durationSeconds: '{n} s', durationMinutes: '{n} min',
  durationHours: '{n} h', ago: '{duration} ago', tokens: '{tokens} tokens', tokensCache: '{tokens} tokens (cache {ratio}%)', reported: '{phase} (worker reported)',
  eventsTruncated: 'events truncated', dropped: '{count} events dropped', unmapped: '{count} provider events not itemized yet' };
