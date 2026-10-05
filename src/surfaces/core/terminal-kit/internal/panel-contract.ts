import type { AgentToolApprovalSettlement } from '#domain/index.js';
import type { ConversationSessionPort } from './session-references.js';

/** Custody labels are not authentication. Only a trusted composition may inject these ports. */
export type TerminalLocalContext = Readonly<{
  kind: 'terminal-local'; installationId: string; projectId: string; scopeId: string;
  sessionId: string; sessionRevision?: never;
}>;
export type ExactContext = Readonly<{
  kind: 'service-session'; installationId: string; projectId: string; scopeId: string;
  sessionId: string; sessionRevision: number;
}>;
export type PanelContext = TerminalLocalContext | ExactContext;
export type PanelLocalHistory =
  | Readonly<{ kind: 'enabled'; port: ConversationSessionPort }>
  | Readonly<{ kind: 'disabled' | 'unavailable'; port: null }>;
/** No service history schema/producer is introduced by the controller-only slice. */
export type PanelServiceHistory = Readonly<{ kind: 'unavailable'; read: null }>;
export type PanelSubmission<C extends PanelContext> = Readonly<{
  context: C; inputId: string; text: string; mentions: readonly string[];
}>;
export type PanelApprovalIntent = Readonly<{ cardHandle: string; decision: 'allow' | 'deny'; reason: string }>;
export type PanelInput<C extends PanelContext> =
  | Readonly<{ kind: 'submit'; context: C; inputId: string; text: string; mentions?: readonly string[] }>
  | Readonly<{ kind: 'edit-queued'; context: C; inputId: string; text: string; mentions?: readonly string[] }>
  | Readonly<{ kind: 'cancel'; context: C; turnId: string }>
  | Readonly<{ kind: 'cancel-input'; context: C; inputId: string }>
  | Readonly<{ kind: 'close-view'; context: C }>
  | (Readonly<{ kind: 'decide-approval'; context: C }> & PanelApprovalIntent)
  | Readonly<{ kind: 'choose-item'; context: C; pickerHandle: string; itemHandle: string | null }>;
/** The composition's command identity, not proof of admission, recording or durable closure. */
export type PanelTurnBinding = Readonly<{
  scopeId: string; sessionId: string | null; turnId: string; phase: 'command-generated';
}>;
/** Complete transported display fields and capabilities stay in the private adapter, indexed by these addresses.
 * The adapter renders through the existing canonical decision projection; this type contains no safe-text claim. */
export type PanelApprovalView<C extends PanelContext> = Readonly<{
  context: C; turnId: string; approvalId: string; revision: number; expiresAt: number;
  cardHandle: string; presentationHandle: string;
}>;
export type PanelApprovalSettlement<C extends PanelContext> = PanelApprovalView<C> & Readonly<{ outcome: AgentToolApprovalSettlement }>;
export type PanelPickerView = Readonly<{ pickerHandle: string;
  items: readonly Readonly<{ itemHandle: string; presentationHandle: string }>[] }>;
export type PanelExecution<C extends PanelContext> = Readonly<{
  input: PanelSubmission<C>; signal: AbortSignal;
  pick(view: PanelPickerView): Promise<string | null>;
  /** Only the active, unbound local session command may replace its session after canonical load/clear.
   * Queued input follows that serialized transition, as in the terminal's existing FIFO. */
  selectSession(next: C): boolean;
  onTurnBound(binding: PanelTurnBinding): boolean;
  onApproval(view: PanelApprovalView<C>): boolean;
  onApprovalSettled(settlement: PanelApprovalSettlement<C>): boolean;
}>;
/** Effect/admission/assurance owners remain behind injected application adapters.
 * execute returning means only that this adapter invocation returned. Errors/abort are locally unknown.
 * decideApproval resolves only after the existing application decision succeeds, rejects on refusal/uncertainty.
 * retireApproval releases private active-card custody; it never cancels or settles a service approval. */
export interface PanelPort<C extends PanelContext> {
  readonly kind: C['kind']; readonly context: C;
  readonly history: C extends TerminalLocalContext ? PanelLocalHistory : PanelServiceHistory;
  readonly now: () => number;
  execute(execution: PanelExecution<C>): Promise<void>;
  decideApproval(view: PanelApprovalView<C>, intent: PanelApprovalIntent): Promise<void>;
  retireApproval(view: PanelApprovalView<C>): void;
}
export type TerminalLocalPanelPort = PanelPort<TerminalLocalContext>;
export type ServicePanelPort = PanelPort<ExactContext>;
/** No submitted text, messages, exceptions, decision reasons or raw renderer DTOs are exported. */
export interface PanelSnapshot<C extends PanelContext> {
  readonly context: C;
  readonly phase: 'idle' | 'running' | 'cancelling' | 'closed';
  readonly queued: readonly Readonly<{ inputId: string }>[];
  readonly active: Readonly<{ inputId: string; binding: PanelTurnBinding | null }> | null;
  readonly picker: PanelPickerView | null;
  readonly approval: (PanelApprovalView<C> & Readonly<{ phase: 'pending' | 'deciding' | 'unknown' }>) | null;
  /** Local adapter outcome only; it never asserts a Run/turn's durable finish. */
  readonly last: Readonly<{ inputId: string; outcome: 'returned' | 'unknown' }> | null;
}
export interface PanelController<C extends PanelContext> {
  send(input: PanelInput<C>): boolean;
  snapshot(): PanelSnapshot<C>;
  subscribe(listener: (snapshot: PanelSnapshot<C>) => void): () => void;
  /** Supplied by the trusted session adapter after canonical load/clear; creates no identity or history. */
  selectSession(previous: C, next: C): boolean;
}
