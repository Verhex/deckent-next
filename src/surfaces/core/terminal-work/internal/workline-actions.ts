import { type WorkLedgerEntry, notice, fillTemplate, type WorkerLineLabels, type WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import type { JobWindowLabels } from './job-windows.js';
import type { RunAnswerLabels, RunControlLabels } from './run-control.js';
import type { ActiveWorkLabels } from './active-work.js';
import type { LiveWindowKind, LiveWindowLabels, WorkerPanelLabels } from './live-windows.js';
import type { ApprovalWindowLabels } from './approval-window.js';
import { movedSlashCommand, slashHelpText, WORKLINE_SLASH_COMMANDS, type SurfaceDeliveryMode } from '#surfaces/core/terminal-kit/index.js';

export interface WorklineActionLabels {
  readonly ledgerUnavailable: string;
  readonly runNotFound: string;
  readonly workersEmpty: string;
  readonly runsEmpty: string;
  readonly serviceRestartUnavailable: string;
  readonly queued: string;
  readonly runUsage: string;
  readonly watchStarted: string;
  readonly watchRunsStarted: string;
  readonly watchStopped: string;
  /** `{mode}` is `push` or `poll`. Present in production; tests omit it unless they assert the mark. */
  readonly watchDelivery?: string;
  /** `{status}` is `gap`, `backpressure` or `foreign-scope`. */
  readonly watchStep?: string;
  readonly watchPushFailed?: string;
  readonly watchNotInitialized?: string; readonly watchAccessDenied?: string;
  readonly watchAccessStopped?: string;
  readonly statusLine: string;
  readonly unknownCommand: string;
  /** K2: `{old}` moved to `{new}` (a rename; the old name never runs). Absent: the unknown-command notice. */
  readonly movedCommand?: string;
  /** The same registry-derived labels as the palette; optional for callers without a composer. */
  readonly composer?: { readonly slash: Readonly<Record<string, string>> };
  /** Worker live line, transcript, approvals and run control; absent means those commands are not offered. */
  readonly work?: WorkSurfaceLabels;
}

/** Catalog strings for the work surface (P4). Templates use `{name}` placeholders. */
export interface WorkSurfaceLabels {
  readonly jobs?: JobWindowLabels;
  /** Y1: the Runs window's hold/resume/close keys and cards; absent: `/runs` stays the read-only list. */
  readonly runControl?: RunControlLabels;
  /** K7: the needs-input answer card (`a` on a Runs window row); absent with `runControl`: no answer key. */
  readonly runAnswer?: RunAnswerLabels;
  /** TERMINAL-SABIT slice 2: the active work strip above the composer; absent means no strip. */
  readonly activeWork?: ActiveWorkLabels;
  /** Live windows (`/monitor`, the Runs window); absent means those commands are not offered as windows. */
  readonly live?: LiveWindowLabels;
  readonly workerLine: WorkerLineLabels;
  readonly panel: WorkerPanelLabels;
  readonly unavailable: string;
  readonly transcriptUsage: string;
  readonly transcriptNotFound: string;
  readonly transcriptNoAttempt: string;
  readonly transcriptHeader: string;
  /** `{task}` and `{attempt}` in full: the headline carries their short forms. */
  readonly transcriptDetail?: string;
  readonly sessionStandingClear?: { readonly cleared: string; readonly unconfirmed: string };
  readonly approvalsNone: string;
  readonly approvalItem: string;
  readonly approvalsTruncated: string;
  readonly approvalNotFound: string;
  readonly approvalTitle: string;
  readonly approvalSubject: string;
  /** `{count}` more preview lines of a tool-call approval are not shown on the card. */
  readonly approvalPreviewMore: string;
  readonly approvalExpires: string;
  readonly approvalPrompt: string;
  readonly approvalPending: string;
  readonly approvalAllowed: string;
  readonly approvalDenied: string;
  /** `{id}`: the service could not confirm closing a tool-call approval request; the call did not run. */
  readonly approvalUnsettled: string;
  /** `{id}`: the full approval identity on a detail line under a decision notice (whose first line carries the short form). Absent: no line. */
  readonly approvalIdentity?: string;
  readonly approvalMore: string;
  readonly approvalNotify: string;
  readonly approvalPollFailed: string;
  /** Single card lines (B1): `risk` with `{risk}`/`{undo}`; nothing runs on expiry; assurance turn-bound here / elsewhere / peer-session / other `{level}`. */
  readonly approvalCard: { readonly risk: string; readonly notDeclared: string; readonly onExpiry: string; readonly assuranceTurnHere: string; readonly assuranceTurnElsewhere: string; readonly assurancePeer: string; readonly assuranceOther: string };
  /** Standing scopes on an approval card (PERSISTENT-APPROVALS G6); absent = the plain y/N card only. */
  readonly approvalStanding?: {
    /** `{pattern}`: exactly what a standing answer covers (the command, or the directory pattern). */
    readonly covers: string;
    readonly promptBoth: string;
    readonly promptSession: string;
    readonly promptAlways: string;
    /** `{id}`: the approval was allowed and the standing answer saved; `notSaved…` adds `{reason}` (the call was allowed once either way). */
    readonly savedSession: string;
    readonly savedAlways: string;
    readonly unconfirmedSession: string;
    readonly notSavedSession: string;
    readonly notSavedAlways: string;
  };
  /** Bounded windows (TS-WINDOW): `position` has `{from}`, `{to}`, `{total}`; `pick` is a list window's key hints; titles of the list
   * windows; the `/service-restart` confirmation (title, what happens, keys, kept). */
  readonly window: Readonly<{ position: string; pick: string; approvalsTitle: string; resumeTitle: string;
    restartTitle: string; restartDetail: string; restartPrompt: string; restartKept: string }>;
  /** The approval window's labelled fields (T-APPROVAL-WINDOW). */
  readonly approvalWindow: ApprovalWindowLabels;
  readonly cancelUsage: string;
  readonly cancelTitle: string;
  readonly cancelDetail: string;
  readonly cancelAlreadyRequested: string;
  readonly cancelPrompt: string;
  readonly cancelPending: string;
  readonly cancelKept: string;
  /** `{run}`: the full run identity on its own detail line (the title carries the short form). Absent: no identity line. */
  readonly cancelIdentity?: string;
}

/** Commands owned by the work surface; they need its labels and their port. */
export const WORK_SURFACE_COMMANDS = Object.freeze(['approvals'] as const);
export type WorkSurfaceCommand = typeof WORK_SURFACE_COMMANDS[number];
export function isWorkSurfaceCommand(command: string): command is WorkSurfaceCommand {
  return (WORK_SURFACE_COMMANDS as readonly string[]).includes(command);
}

export type WatchState = Readonly<{ workers: boolean; runs: boolean }>;

export interface WorklineActionContext {
  readonly followDelivery?: SurfaceDeliveryMode;
  readonly ledger: WorklineLedgerPorts | undefined;
  readonly labels: WorklineActionLabels;
  readonly watch: WatchState;
  readonly canRestartService?: boolean;
  /** Poll interval used when the watch has no push port. The delivery line reports this timeout. */
  readonly pollMs?: number;
}

/** Result of one slash command; the view applies it. Entries carry no identity: the ledger buffer assigns sequence ids. */
/** `window`: the live window the command opens (`null` closes the open one). */
export type WorklineActionResult = Readonly<{ entries: readonly WorkLedgerEntry[]; watch?: WatchState; window?: Exclude<LiveWindowKind, 'monitor'> | null; exit?: true }>;

/** Pure dispatch for immediate commands; a command that needs its window or port returns null and runs in the view. */
export function immediateSlashAction(command: string, context: WorklineActionContext): WorklineActionResult | null {
  const { labels, watch, ledger } = context;
  if (command === 'exit') return { entries: [], exit: true };
  if (command === 'help') return { entries: [notice('info', slashHelpText(labels.composer?.slash ?? {}, WORKLINE_SLASH_COMMANDS))] };
  if (command === 'status') return { entries: [notice('info', labels.statusLine)] };
  // K1: `/runs` is the one Runs window over both feeds (runs only where the ledger can list them); a feed already on is not announced again.
  if (command === 'runs') {
    if (!ledger || !labels.work?.live) return { entries: [notice('error', labels.work?.live ? labels.ledgerUnavailable : (labels.work?.unavailable ?? labels.ledgerUnavailable))] };
    const next: WatchState = { workers: true, runs: watch.runs || Boolean(ledger.listRunIds) };
    if (next.workers === watch.workers && next.runs === watch.runs) return { entries: [], window: 'runs' };
    return { entries: [], watch: next, window: 'runs' };
  }
  const moved = movedSlashCommand(command);
  if (moved) return { entries: [notice('error', labels.movedCommand ? fillTemplate(labels.movedCommand, { old: `/${command}`, new: `/${moved}` }) : `${labels.unknownCommand}: /${command}`)] };
  if (command === 'service-restart') return context.canRestartService ? null : { entries: [notice('error', labels.serviceRestartUnavailable)] };
  if (isWorkSurfaceCommand(command)) {
    const wired = ledger?.listApprovalPage && ledger.decideApproval;
    return labels.work && wired ? null : { entries: [notice('error', labels.work?.unavailable ?? labels.ledgerUnavailable)] };
  }
  return { entries: [notice('error', `${labels.unknownCommand}: /${command}`)] };
}
