import type { Readable } from 'node:stream';
import type { Locale, OutputSink } from '#platform/index.js';

/** What every CLI command gets from its host: project root, environment, output sinks, stdin, cancellation and the chosen locale. */
export interface CliBaseContext {
  root?: string; env?: NodeJS.ProcessEnv; stdout?: OutputSink; stderr?: OutputSink;
  stdin?: Readable & { isTTY?: boolean };
  signal?: AbortSignal;
  onLocale?: (locale: Locale) => void;
  /** L-KIT: the locale the host resolved once for this call (`resolveCliLocale`, config `language` included); read it through `commandLocale`. */
  locale?: Locale;
  /** L-KIT: exact environment variable names that mark an AI agent caller (config registry once INIT-D7 lands); absent: the kit's registry list. */
  agentEnvironment?: readonly string[];
}
