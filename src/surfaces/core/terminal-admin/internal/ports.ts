import type { OutputSink, ConfigLoadOptions, Locale } from '#platform/index.js';
import type { InspectSlashPorts } from '#surfaces/core/terminal-kit/index.js';
import type { TerminalAdminContext } from './context.js';
import type { InfoSurfaceLabels, InfoViewPorts } from '#surfaces/core/terminal-window/index.js';
import { doctorLines, doctorView } from './doctor.js';
import { terminalInfoLabels } from './info-labels.js';
import { modelLines } from './model.js';
import { scopeLines, scopeView } from './scope.js';
import { statusLines, statusView } from './status.js';
import { usageLines, usageView } from './usage.js';

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
  /** The same doctor command with its structured report (`deckent doctor --json`): the `/doctor` window groups it by area (SW-1). Absent: the text. */
  readonly doctorReport?: (sink: OutputSink) => Promise<void>;
  /** The person's display name for `/scope` (the host user the principal is derived from); absent means the line is left out. */
  readonly principalName?: string | null;
}

/**
 * The read-only management ports of the interactive terminal (S09); each call asks its typed producers again. `info` (SW-1) answers the same
 * commands as typed window models (`/status`, `/usage`, `/doctor`, `/scope`) with the catalog words of the information windows.
 */
export function terminalAdminPorts(input: TerminalAdminInput): Readonly<{ inspect: InspectSlashPorts; info: Readonly<{ ports: InfoViewPorts; labels: InfoSurfaceLabels }> }> {
  const call = { root: input.root, scopeId: input.scopeId, options: input.options, locale: input.locale, context: input.context };
  const identity = { installationId: input.installationId, projectId: input.projectId };
  return { inspect: {
    status: () => statusLines(call, input.status),
    model: args => modelLines(call, args),
    usage: (args, view) => usageLines(call, args, view.usage),
    doctor: () => doctorLines(input.doctor),
    scope: (args, view) => scopeLines(call, identity, args, input.principalName ?? null, view.sessionFullAccess === true),
  }, info: { labels: terminalInfoLabels(input.locale), ports: {
    status: () => statusView(call, input.status, identity),
    usage: view => usageView(call, view.usage),
    doctor: () => doctorView(input.locale, input.doctorReport ?? null, input.doctor),
    scope: view => scopeView(call, identity, input.principalName ?? null, view.sessionFullAccess === true),
  } } };
}
