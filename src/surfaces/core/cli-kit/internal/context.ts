import type { Readable } from 'node:stream';
import type { Locale, OutputSink, MessageKey, Params, ProjectRootResolution } from '#platform/index.js';

/** An existing installation wins; otherwise propose the repository top, or the launch folder outside Git. */
export const offerTarget = (found: boolean, gitTop: string | null, cwd: string): string => found ? cwd : gitTop ?? cwd;

/** What every CLI command gets from its host: project root, environment, output sinks, stdin, cancellation and the chosen locale. */
export interface CliBaseContext {
  /** Read-only help data, loaded only for a recognized command help request. */
  helpParams?: (key: MessageKey) => Promise<Params>;
  root?: string; env?: NodeJS.ProcessEnv; stdout?: OutputSink; stderr?: OutputSink;
  /** U7: how `root` was found from the launch folder (its folder relative to `root`, whether an installation was found, the Git top otherwise). */
  rootResolution?: ProjectRootResolution;
  stdin?: Readable & { isTTY?: boolean };
  signal?: AbortSignal;
  onLocale?: (locale: Locale) => void;
  /** L-KIT: the locale the host resolved once for this call (`resolveCliLocale`, config `language` included); read it through `commandLocale`. */
  locale?: Locale;
  /** L-KIT: exact environment variable names that mark an AI agent caller (config registry once INIT-D7 lands); absent: the kit's registry list. */
  agentEnvironment?: readonly string[];
}
