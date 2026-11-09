import type { Locale } from '#platform/index.js';
import type { WorkerLineLabels } from '#surfaces/core/terminal-ledger/index.js';
import type { ApprovalWindowLabels } from './approval-window.js';

export interface ApprovalSurfaceLabels {
  readonly jobs?: { readonly locale: Locale };
  readonly workerLine: WorkerLineLabels;
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

export type PanelWindowPresentation = Readonly<{ kind: 'window'; title: string; body: readonly string[]; hints: string; confirm: boolean }>;
