import type { OutputSink, ConfigLoadOptions, Locale } from '#platform/index.js';
import type { InspectSlashPorts } from '#surfaces/core/terminal-kit/index.js';
import type { TerminalAdminContext } from './context.js';
import { doctorLines } from './doctor.js';
import { modelLines } from './model.js';
import { scopeLines } from './scope.js';
import { statusLines } from './status.js';
import { usageLines } from './usage.js';

export interface TerminalAdminInput {
  readonly root: string;
  readonly scopeId: string;
  readonly installationId: string;
  readonly projectId: string;
  readonly options: ConfigLoadOptions;
  readonly locale: Locale;
  readonly context: TerminalAdminContext;
  /** The host's own status report, produced fresh on every call (the same renderer `deckent terminal status` uses). */
  readonly status: () => Promise<string>;
  /** The host's own `doctor` command, writing to the given sink. */
  readonly doctor: (sink: OutputSink) => Promise<void>;
  /** The person's display name for `/scope` (the host user the principal is derived from); absent means the line is left out. */
  readonly principalName?: string | null;
}

/** The read-only management ports of the interactive terminal (S09); each call asks its typed producers again. */
export function terminalAdminPorts(input: TerminalAdminInput): Readonly<{ inspect: InspectSlashPorts }> {
  const call = { root: input.root, scopeId: input.scopeId, options: input.options, locale: input.locale, context: input.context };
  return { inspect: {
    status: () => statusLines(call, input.status),
    model: args => modelLines(call, args),
    usage: (args, view) => usageLines(call, args, view.usage),
    doctor: () => doctorLines(input.doctor),
    scope: args => scopeLines(call, { installationId: input.installationId, projectId: input.projectId }, args, input.principalName ?? null),
  } };
}
