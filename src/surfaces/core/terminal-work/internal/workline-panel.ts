import { randomUUID } from 'node:crypto';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPanelController, type PanelExecution, type PanelApprovalView, type PanelSnapshot, type TerminalLocalContext,
  type ConversationSessionPort, type TurnDelta, type StandingScope } from '#surfaces/core/terminal-kit/index.js';
import type { RunView } from '#engine/index.js';
import type { WorklineApproval } from '#surfaces/core/terminal-ledger/index.js';
import type { Span } from '#surfaces/core/terminal-render/index.js';
import type { TurnApprovalRequest } from './work-surface.js';

export type LocalExecution = PanelExecution<TerminalLocalContext>;
export interface ResumePickerItem { readonly sessionId: string; readonly label: string; readonly spans?: readonly Span[]; readonly hiddenNotice?: string }
type Approval = Readonly<{ kind: 'approval'; approval: WorklineApproval; remaining: number; preview?: string; standing?: TurnApprovalRequest['standing'] }>;
/** A generic bounded window (TS-WINDOW): a titled body; `confirm` asks y/N (picker items `allow`/`deny`), otherwise it closes (`close`). */
export type PanelWindowPresentation = Readonly<{ kind: 'window'; title: string; body: readonly string[]; hints: string; confirm: boolean }>;
export type PanelPresentation = Approval | Readonly<{ kind: 'cancel'; run: RunView }> | PanelWindowPresentation
  | Readonly<{ kind: 'approvals'; rows: readonly WorklineApproval[] }> | Readonly<{ kind: 'resume'; rows: readonly ResumePickerItem[] }>;
type PrivateCard = { view: PanelApprovalView<TerminalLocalContext>; presentation: Approval; standing?: StandingScope; unknown: () => void };
export type WorklinePanel = ReturnType<typeof createWorklinePanel>;

/** Private renderer/application adapter. Only opaque presentation addresses enter the shared controller.
 * No capability/display-field getter is exported through the terminal barrel or a bridge. */
function createWorklinePanel(context: TerminalLocalContext, sessions: ConversationSessionPort | undefined,
  execute: (execution: LocalExecution) => Promise<void>, decide: (approval: WorklineApproval, remaining: number, yes: boolean, standing?: StandingScope, reason?: string) => Promise<void>) {
  let sequence = 0;
  const cards = new Map<string, PrivateCard>();
  let presentation: { inputId: string; handle: string; value: PanelPresentation } | null = null;
  const make = (context: TerminalLocalContext) => createPanelController({ kind: 'terminal-local', context,
    history: sessions ? { kind: 'enabled', port: sessions } : { kind: 'unavailable', port: null }, now: Date.now,
    async execute(execution) { try { await execute(execution); } finally { if (presentation?.inputId === execution.input.inputId) presentation = null; } },
    async decideApproval(view, intent) {
      const card = cards.get(view.cardHandle);
      if (!card || card.view.turnId !== view.turnId || card.view.revision !== view.revision || card.view.approvalId !== view.approvalId
        || card.view.context.sessionId !== view.context.sessionId) throw new TypeError();
      try { await decide(card.presentation.approval, 0, intent.decision === 'allow', card.standing, intent.reason || undefined); }
      catch (error) {
        if (!['APPROVAL_ASSURANCE_INSUFFICIENT', 'APPROVAL_SURFACE_RESTRICTED'].includes(String((error as { code?: unknown }).code))) card.unknown();
        throw error;
      }
    },
    retireApproval(view) { cards.delete(view.cardHandle); },
  });
  let controller = make(context);
  return {
    get controller() { return controller; },
    /** React StrictMode effect replay reattaches an idle view; it never revives an old operation. */
    attach() { if (controller.snapshot().phase === 'closed') controller = make(controller.snapshot().context); },
    close() { controller.send({ kind: 'close-view', context: controller.snapshot().context }); cards.clear(); presentation = null; },
    async pick(execution: LocalExecution, value: PanelPresentation, choices: readonly string[]) {
      if (execution.signal.aborted) return null;
      const handle = `picker-${++sequence}`;
      presentation = { inputId: execution.input.inputId, handle, value };
      return execution.pick({ pickerHandle: handle, items: choices.map(itemHandle => ({ itemHandle, presentationHandle: handle })) });
    },
    choose(pickerHandle: string | undefined, itemHandle: string | null) {
      const state = controller.snapshot();
      return pickerHandle ? controller.send({ kind: 'choose-item', context: state.context, pickerHandle, itemHandle }) : false;
    },
    presentation(state: PanelSnapshot<TerminalLocalContext>) {
      if (state.approval) return state.approval.phase === 'unknown' ? null : cards.get(state.approval.cardHandle)?.presentation ?? null;
      return presentation && presentation.inputId === state.active?.inputId ? presentation.value : null;
    },
    decide(cardHandle: string, yes: boolean, standing?: StandingScope, reason = '') {
      const state = controller.snapshot(), card = state.approval && cards.get(state.approval.cardHandle);
      if (!card || card.view.cardHandle !== cardHandle || state.approval?.phase !== 'pending' || (standing && (!yes || !card.presentation.standing?.scopes.includes(standing)))) return false;
      if (standing) card.standing = standing; else delete card.standing;
      return controller.send({ kind: 'decide-approval', context: state.context, cardHandle: card.view.cardHandle, decision: yes ? 'allow' : 'deny', reason });
    },
    stream(execution: LocalExecution) {
      let turnId: string | null = null;
      const calls = new Map<string, PanelApprovalView<TerminalLocalContext>>();
      return {
        onTurnBound(binding: Parameters<LocalExecution['onTurnBound']>[0]) {
          if (!execution.onTurnBound(binding)) throw new TypeError();
          turnId = binding.turnId;
        },
        approval(delta: Extract<TurnDelta, { kind: 'approval' }>) {
          if (delta.phase === 'settled') {
            const view = calls.get(delta.callId);
            return !!view && view.approvalId === delta.approvalId && execution.onApprovalSettled({ ...view, outcome: delta.outcome });
          }
          if (!turnId) return false;
          const handle = `approval-${++sequence}`;
          const view = { context: execution.input.context, turnId, approvalId: delta.approvalId, revision: delta.revision,
            expiresAt: delta.expiresAt, cardHandle: handle, presentationHandle: handle };
          const approval: WorklineApproval = { approvalId: delta.approvalId, revision: delta.revision, expiresAt: delta.expiresAt, summary: delta.summary,
            runId: '-', taskId: '-', requester: '-', status: 'pending', decision: null,
            ...(delta.decisionCapability ? { decisionCapability: delta.decisionCapability } : {}), ...(delta.risk !== undefined ? { risk: delta.risk } : {}),
            ...(delta.requiredAssurance ? { requiredAssurance: delta.requiredAssurance } : {}), ...(delta.undo ? { undo: delta.undo } : {}), ...(delta.posture ? { posture: delta.posture } : {}),
            ...(delta.call ? { call: delta.call } : {}), ...(delta.previewCut ? { previewCut: delta.previewCut } : {}),
            ...(delta.tool ? { tool: delta.tool, target: delta.target ?? null } : {}), createdAt: Date.now() };
          cards.set(handle, { view, unknown: () => { execution.onApprovalSettled({ ...view, outcome: 'unsettled' }); }, presentation: { kind: 'approval', approval, remaining: 0, preview: delta.preview, ...(delta.standing ? { standing: delta.standing } : {}) } });
          if (!execution.onApproval(view)) { cards.delete(handle); return false; }
          calls.set(delta.callId, view); return true;
        },
      };
    },
  };
}

export function useWorklinePanel(identity: Omit<TerminalLocalContext, 'kind' | 'sessionId'>, sessions: ConversationSessionPort | undefined) {
  const execute = useRef<(execution: LocalExecution) => Promise<void>>(async () => { throw new TypeError(); });
  const decide = useRef<(approval: WorklineApproval, remaining: number, yes: boolean, standing?: StandingScope, reason?: string) => Promise<void>>(async () => { throw new TypeError(); });
  const [panel] = useState(() => createWorklinePanel({ kind: 'terminal-local', ...identity, sessionId: randomUUID() }, sessions,
    execution => execute.current(execution), (...args) => decide.current(...args)));
  const captured = panel.controller.snapshot().context;
  if (captured.installationId !== identity.installationId || captured.projectId !== identity.projectId || captured.scopeId !== identity.scopeId) throw new TypeError();
  const [state, setState] = useState(() => panel.controller.snapshot());
  useLayoutEffect(() => {
    panel.attach(); setState(panel.controller.snapshot());
    const unsubscribe = panel.controller.subscribe(setState);
    return () => { unsubscribe(); panel.close(); };
  }, [panel]);
  return { panel, state, execute, decide };
}
