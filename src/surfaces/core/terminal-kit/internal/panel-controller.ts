import type { ExactContext, PanelApprovalView, PanelContext, PanelController, PanelInput, PanelPort,
  PanelSnapshot, PanelPickerView, PanelSubmission, PanelTurnBinding, TerminalLocalContext } from './panel-contract.js';

type Active<C extends PanelContext> = { input: PanelSubmission<C>; readonly abort: AbortController; binding: PanelTurnBinding | null; readonly handles: Set<string>; readonly revisions: Map<string, number> };
type Card<C extends PanelContext> = { readonly view: PanelApprovalView<C>; phase: 'pending' | 'deciding' | 'unknown' };
function validContext(context: PanelContext): boolean {
  return !!context && [context.installationId, context.projectId, context.scopeId, context.sessionId].every(id => typeof id === 'string' && id.trim().length > 0)
    && (context.kind === 'terminal-local' ? !('sessionRevision' in context)
      : context.kind === 'service-session' && Number.isSafeInteger(context.sessionRevision) && context.sessionRevision >= 0);
}
function sameContext(a: PanelContext, b: PanelContext): boolean {
  return validContext(b) && a.kind === b.kind && a.installationId === b.installationId && a.projectId === b.projectId
    && a.scopeId === b.scopeId && a.sessionId === b.sessionId && a.sessionRevision === b.sessionRevision;
}
/** Explicit projection avoids spreading cap-bearing/raw transport objects into public state. */
function captureContext<C extends PanelContext>(context: C): C {
  return Object.freeze({ kind: context.kind, installationId: context.installationId, projectId: context.projectId,
    scopeId: context.scopeId, sessionId: context.sessionId,
    ...(context.kind === 'service-session' ? { sessionRevision: context.sessionRevision } : {}) }) as C;
}
function sameCard<C extends PanelContext>(a: PanelApprovalView<C>, b: PanelApprovalView<C>): boolean {
  return sameContext(a.context, b.context) && a.turnId === b.turnId && a.approvalId === b.approvalId
    && a.revision === b.revision && a.cardHandle === b.cardHandle && a.presentationHandle === b.presentationHandle;
}

function validHistory<C extends PanelContext>(ports: PanelPort<C>): boolean {
  const history = ports.history;
  return ports.kind === 'terminal-local'
    ? 'port' in history && (history.kind === 'enabled' ? !!history.port
      && ['save', 'list', 'load'].every(key => typeof history.port[key as keyof typeof history.port] === 'function')
      : (history.kind === 'disabled' || history.kind === 'unavailable') && history.port === null)
    : history.kind === 'unavailable' && 'read' in history && history.read === null;
}
function capturePicker(view: PanelPickerView): PanelPickerView | null {
  if (!view.pickerHandle || !view.items.length || view.items.some(item => !item.itemHandle || !item.presentationHandle)
    || new Set(view.items.map(item => item.itemHandle)).size !== view.items.length) return null;
  return Object.freeze({ pickerHandle: view.pickerHandle, items: Object.freeze(view.items.map(item =>
    Object.freeze({ itemHandle: item.itemHandle, presentationHandle: item.presentationHandle }))) });
}

/** One control owner, independent of React/Ink, storage, OS identity and runtime authority.
 * Terminal adoption injects the trusted installation/project identity and private application adapters. */
export function createPanelController(ports: PanelPort<TerminalLocalContext>): PanelController<TerminalLocalContext>;
export function createPanelController(ports: PanelPort<ExactContext>): PanelController<ExactContext>;
export function createPanelController<C extends PanelContext>(ports: PanelPort<C>): PanelController<C> {
  if (!validContext(ports.context) || ports.kind !== ports.context.kind || !validHistory(ports)) throw new TypeError();
  let context = captureContext(ports.context), active: Active<C> | null = null, approval: Card<C> | null = null;
  let picker: { view: PanelPickerView; resolve: (choice: string | null) => void } | null = null;
  let closed = false, last: PanelSnapshot<C>['last'] = null;
  const queue: PanelSubmission<C>[] = [], listeners = new Set<(snapshot: PanelSnapshot<C>) => void>();
  const snapshot = (): PanelSnapshot<C> => Object.freeze({ context,
    phase: closed ? 'closed' : active?.abort.signal.aborted ? 'cancelling' : active ? 'running' : 'idle',
    queued: Object.freeze(queue.map(item => Object.freeze({ inputId: item.inputId }))),
    active: active ? Object.freeze({ inputId: active.input.inputId, binding: active.binding }) : null,
    picker: picker?.view ?? null,
    approval: approval ? Object.freeze({ ...approval.view, phase: approval.phase }) : null, last });
  // Deliver ordered snapshots during observer reentrancy; observer failures cannot interrupt the FIFO owner.
  const notifications: PanelSnapshot<C>[] = [];
  let notifying = false;
  const publish = () => {
    notifications.push(snapshot());
    if (notifying) return;
    notifying = true;
    try {
      while (notifications.length) {
        const view = notifications.shift()!;
        for (const listener of [...listeners]) {
          if (listeners.has(listener)) { try { listener(view); } catch { /* View observers do not own control. */ } }
        }
      }
    } finally { notifying = false; }
  };
  const retire = () => {
    const old = approval; approval = null;
    if (old) { try { ports.retireApproval(old.view); } catch { /* Private cleanup failure cannot block cancel/close. */ } }
  };
  const finishPicker = (choice: string | null) => {
    const old = picker; picker = null; old?.resolve(choice);
  };
  const pick = (operation: Active<C>, view: PanelPickerView): Promise<string | null> => {
    if (!current(operation) || picker) return Promise.resolve(null);
    const captured = capturePicker(view); if (!captured) return Promise.resolve(null);
    return new Promise(resolve => { picker = { view: captured, resolve }; publish(); });
  };
  const current = (operation: Active<C>) => !closed && active === operation && !operation.abort.signal.aborted && sameContext(context, operation.input.context);
  const bind = (operation: Active<C>, binding: PanelTurnBinding): boolean => {
    if (!current(operation) || operation.binding || binding.phase !== 'command-generated' || !binding.turnId
      || binding.scopeId !== operation.input.context.scopeId || binding.sessionId !== operation.input.context.sessionId) return false;
    operation.binding = Object.freeze({ scopeId: binding.scopeId, sessionId: binding.sessionId, turnId: binding.turnId, phase: binding.phase });
    publish(); return true;
  };
  const present = (operation: Active<C>, view: PanelApprovalView<C>): boolean => {
    if (!current(operation) || !operation.binding || !sameContext(operation.input.context, view.context) || view.turnId !== operation.binding.turnId
      || !view.approvalId || !view.cardHandle || !view.presentationHandle || !Number.isSafeInteger(view.revision) || view.revision < 0
      || !Number.isFinite(view.expiresAt) || view.expiresAt <= ports.now()) return false;
    if (operation.handles.has(view.cardHandle) || (operation.revisions.get(view.approvalId) ?? -1) >= view.revision) return false;
    operation.handles.add(view.cardHandle); operation.revisions.set(view.approvalId, view.revision);
    retire();
    approval = { phase: 'pending', view: Object.freeze({ context: operation.input.context, turnId: view.turnId, approvalId: view.approvalId,
      revision: view.revision, expiresAt: view.expiresAt, cardHandle: view.cardHandle, presentationHandle: view.presentationHandle }) };
    publish(); return true;
  };
  const drain = () => {
    if (closed || active || !queue.length) return;
    const input = queue.shift()!;
    const operation: Active<C> = { input, abort: new AbortController(), binding: null, handles: new Set(), revisions: new Map() };
    active = operation; publish();
    // A reentrant observer may close/cancel before the adapter gets the input.
    if (!current(operation)) { finish(operation, 'unknown'); return; }
    void (async () => {
      let outcome: 'returned' | 'unknown' = 'returned';
      try {
        await ports.execute(Object.freeze({ input, signal: operation.abort.signal, pick: (view: PanelPickerView) => pick(operation, view),
          selectSession: next => {
            if (!current(operation) || operation.binding || picker || approval || context.kind !== 'terminal-local'
              || !validContext(next) || next.kind !== context.kind || next.installationId !== context.installationId
              || next.projectId !== context.projectId || next.scopeId !== context.scopeId) return false;
            context = captureContext(next);
            operation.input = Object.freeze({ ...operation.input, context });
            for (let index = 0; index < queue.length; index++) queue[index] = Object.freeze({ ...queue[index]!, context });
            publish(); return true;
          },
          onTurnBound: (binding: PanelTurnBinding) => bind(operation, binding),
          onApproval: (view: PanelApprovalView<C>) => present(operation, view),
          onApprovalSettled: settlement => {
            if (!current(operation) || !approval || !sameCard(approval.view, settlement)) return false;
            if (settlement.outcome === 'unsettled') approval.phase = 'unknown'; else retire();
            publish(); return true;
          } }));
      } catch { outcome = 'unknown'; }
      finish(operation, operation.abort.signal.aborted ? 'unknown' : outcome);
    })();
  };
  const finish = (operation: Active<C>, outcome: 'returned' | 'unknown') => {
    if (active !== operation) return;
    retire(); finishPicker(null); operation.handles.clear(); operation.revisions.clear(); active = null; last = Object.freeze({ inputId: operation.input.inputId, outcome });
    if (!closed) { publish(); drain(); }
  };
  const decide = (input: Extract<PanelInput<C>, { kind: 'decide-approval' }>): boolean => {
    const captured = approval;
    if (!active || active.abort.signal.aborted || !captured || captured.phase !== 'pending' || captured.view.cardHandle !== input.cardHandle
      || captured.view.expiresAt <= ports.now() || (input.decision !== 'allow' && input.decision !== 'deny')) return false;
    captured.phase = 'deciding'; publish();
    if (closed || approval !== captured || active?.abort.signal.aborted) return false;
    void (async () => {
      let refused = false;
      try { await ports.decideApproval(captured.view, Object.freeze({ cardHandle: input.cardHandle, decision: input.decision, reason: input.reason })); }
      catch { refused = true; }
      if (closed || approval !== captured) return;
      if (refused) { if (captured.phase !== 'unknown') captured.phase = 'pending'; } else retire();
      publish();
    })();
    return true;
  };
  const send = (input: PanelInput<C>): boolean => {
    if (closed || !sameContext(context, input.context)) return false;
    if (input.kind === 'close-view') {
      closed = true; queue.length = 0;
      const operation = active; active = null; retire(); finishPicker(null);
      operation?.handles.clear(); operation?.revisions.clear(); operation?.abort.abort();
      publish(); listeners.clear(); return true;
    }
    if (input.kind === 'cancel' || input.kind === 'cancel-input') {
      if (!active || active.abort.signal.aborted || (input.kind === 'cancel'
        ? active.binding?.turnId !== input.turnId : active.input.inputId !== input.inputId || active.binding !== null)) return false;
      retire(); finishPicker(null); active.abort.abort(); publish(); return true;
    }
    if (input.kind === 'choose-item') {
      if (!picker || approval || picker.view.pickerHandle !== input.pickerHandle
        || (input.itemHandle !== null && !picker.view.items.some(item => item.itemHandle === input.itemHandle))) return false;
      finishPicker(input.itemHandle); publish(); return true;
    }
    if (input.kind === 'decide-approval') return decide(input);
    const text = input.text.trim();
    if ((input.kind !== 'submit' && input.kind !== 'edit-queued') || !text || !input.inputId) return false;
    if (input.kind === 'edit-queued') {
      const index = queue.findIndex(item => item.inputId === input.inputId);
      if (index < 0) return false;
      queue[index] = Object.freeze({ context, inputId: input.inputId, text, mentions: Object.freeze([...(input.mentions ?? queue[index]!.mentions)]) });
    } else {
      if (active?.input.inputId === input.inputId || queue.some(item => item.inputId === input.inputId)) return false;
      queue.push(Object.freeze({ context, inputId: input.inputId, text, mentions: Object.freeze([...(input.mentions ?? [])]) }));
    }
    publish(); drain(); return true;
  };
  return Object.freeze({ send, snapshot,
    subscribe(listener: (view: PanelSnapshot<C>) => void) {
      if (!closed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    selectSession(previous: C, next: C) {
      if (closed || active || queue.length || !sameContext(context, previous) || !validContext(next) || next.kind !== context.kind
        || next.installationId !== context.installationId || next.projectId !== context.projectId || next.scopeId !== context.scopeId) return false;
      retire(); context = captureContext(next); last = null; publish(); return true;
    } });
}
