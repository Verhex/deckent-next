import type { Readable } from 'node:stream';
import type { Locale, OutputSink } from '#platform/index.js';

/** What every CLI command gets from its host: project root, environment, output sinks, stdin, cancellation and the chosen locale. */
export interface CliBaseContext {
  root?: string; env?: NodeJS.ProcessEnv; stdout?: OutputSink; stderr?: OutputSink;
  stdin?: Readable & { isTTY?: boolean };
  signal?: AbortSignal;
  onLocale?: (locale: Locale) => void;
}
