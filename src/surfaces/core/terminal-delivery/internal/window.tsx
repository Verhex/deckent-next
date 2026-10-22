import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import type { DeliverySummary, EffectConfirmationView, RunView, TargetQueueView, QueueConsent } from '#engine/index.js';
import { shortId, type KnownSecretSnapshot } from '#platform/index.js';
import { fillTemplate, humanRecordText, span, type SpanStyle } from '#surfaces/core/terminal-render/index.js';
import { decisionKey } from '#surfaces/core/terminal-kit/index.js';
import { Window, WindowOpeningContext, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { awaitingDeliveryTargets, consentMatches, type AdoptionOutcome, type DeliveryConsent, type DeliveryOutcome, type DeliveryPreview,
  type DeliveryTarget, type TerminalDeliveryPort, type VerificationCandidate } from './contract.js';
import WINDOW from './window.json' with { type: 'json' };

/** Catalog words of the delivery window (terminal.delivery.*); `next` maps a typed error code to its next-step sentence. */
export interface DeliveryWindowLabels {
  readonly queue?: { readonly reprepare: string; readonly hints: string; readonly waiting: string;
    status(view: TargetQueueView): string; card(view: Omit<QueueConsent, 'capability'>): string };
  /** TESLIM-KARTI-OZET (shared renderer): a ticket's or Attempt's summary lines (`brief` leaves out what the window shows itself: title, operation,
   * files) and the block placed ABOVE an exact consent card. No shadow line exists here. */
  readonly cardSummary?: { lines(summary: DeliverySummary | null, brief: boolean): readonly string[]; consent(summaries: readonly (DeliverySummary | null)[]): readonly string[] };
  readonly title: string; readonly ids: string; readonly loading: string; readonly check: string; readonly outOfScope: string; readonly summary: string;
  readonly file: string; readonly moreFiles: string; readonly where: string; readonly adoptionLater: string; readonly reattempt: string; readonly hints: string;
  readonly working: string; readonly confirmBody: string; readonly confirmRef: string; readonly confirmHints: string;
  readonly delivered: string; readonly adoptPrompt: string; readonly adoptTarget: string; readonly adoptHints: string; readonly adopting: string;
  readonly adopted: string; readonly doneHints: string; readonly failedHints: string;
  readonly summaryDelivered: string; readonly summaryAdopted: string; readonly summaryLeft: string; readonly summaryFailed: string; readonly summaryAdoptFailed: string; readonly summaryNotAdopted: string;
  readonly next: Readonly<Record<string, string>>; readonly nextDefault: string; readonly pickerTitle: string; readonly none: string; readonly fallbackTitle: string;
  /** Y1: choosing the verification Run of an adoption (`execution.adoption.verification`), and how an adoption names its verification. */
  readonly verifyTitle: string; readonly verifyRow: string; readonly verifyWithout: string; readonly verifyLoading: string; readonly verifyNone: string;
  readonly verifyHow: string; readonly verifyCheck: string; readonly verifyHints: string; readonly verifyNoneHints: string;
  readonly verifiedBy: string; readonly notVerified: string;
  /** Read-only per-file diff view inside the window: key hints, header, why a body is absent, cut lines and the scroll position. */
  readonly diffListHints: string; readonly diffHints: string; readonly diffHeader: string; readonly diffUnavailable: string;
  readonly diffEmpty: string; readonly diffHidden: string; readonly diffPosition: string;
}
export type DeliveryOpening = 'foreground' | 'background';
type Waiting = Readonly<{ view: EffectConfirmationView; resolve: (yes: boolean) => void }>;
type Stage = Readonly<{ kind: 'loading' | 'ready' | 'working' | 'adopting' }> | Readonly<{ kind: 'confirm'; waiting: Waiting }>
  | Readonly<{ kind: 'queue' | 'queue-working' }> | Readonly<{ kind: 'queue-confirm'; view: Omit<QueueConsent, 'capability'>; summaries?: readonly (DeliverySummary | null)[]; resolve: (yes: boolean) => void }>
  | Readonly<{ kind: 'delivered' }> | Readonly<{ kind: 'verify' }> | Readonly<{ kind: 'done' }> | Readonly<{ kind: 'failed'; error: string; code: string | null }>;
/** The verification choice of the selected branch: the candidates (null while read), the selected row and the last refusal or read failure. */
type Verify = { runs: readonly VerificationCandidate[] | null; selected: number; status: string };
/** The choices a verification step offers: each accepted candidate, and adopting without verification only when the installation allows it. */
const verifyOptions = (preview: DeliveryPreview, verify: Verify): readonly (string | null)[] =>
  [...(verify.runs ?? []).map(run => run.runId), ...(verify.runs && !preview.verification?.required ? [null] : [])];
/** Typed refusals of a moved base that the queue can re-prepare on the current base (`r`); every other failure only closes. */
const QUEUE_REPREPARE = new Set(['PATCH_BASE_ADVANCED', 'ADOPTION_BASE_CHANGED', 'PATCH_CONFLICT']);
/** Typed refusals that mean "choose another verification" rather than "the adoption is over" (the window returns to the choice). */
const VERIFY_RETRY = new Set(['ADOPTION_NOT_VERIFIED', 'ADOPTION_VERIFICATION_MISMATCH', 'ADOPTION_VERIFICATION_CRITERIA_WEAKER', 'ADOPTION_VERIFICATION_FAILED',
  'ADOPTION_VERIFICATION_PENDING', 'ADOPTION_VERIFICATION_UNSETTLED', 'ADOPTION_VERIFICATION_CANCELLED']);
interface Entry {
  readonly target: DeliveryTarget; readonly sinceMs: number;
  opening: DeliveryOpening; generation: number; stage: Stage; preview: DeliveryPreview | null; consent: DeliveryConsent | null;
  ids: { candidate: string; delivery: string; adopt: string }; delivered: DeliveryOutcome | null; adopted: AdoptionOutcome | null;
  /** Whether the window showed the re-attempt line: from the preview, or read from the queue port when a refused preview offers `r`. */
  reattempt?: boolean; queue?: TargetQueueView; queueSummary?: DeliverySummary | null; selected: number; fileSel?: number; diffScroll?: number | null; closed: boolean; settled: boolean; verify: Verify | null;
}
const ids = () => ({ candidate: `terminal-candidate-${randomUUID()}`, delivery: `terminal-delivery-${randomUUID()}`, adopt: `terminal-adopt-${randomUUID()}` });
const codeOf = (error: unknown) => { const code = (error as { code?: unknown } | null)?.code; return typeof code === 'string' ? code : null; };

export interface DeliveryWindowsInput {
  readonly port: TerminalDeliveryPort | undefined; readonly labels: DeliveryWindowLabels | undefined;
  /** This session's admitted Runs as last observed; only these open a window by themselves. */
  readonly runs: readonly RunView[];
  readonly summary: (text: string, level?: 'info' | 'warning' | 'error') => void; readonly errorText: (error: unknown) => string;
  readonly position: string; readonly known?: KnownSecretSnapshot | undefined;
  /** Bounded wait for a fresh `y` on the port's exact card (the session approval time); silence declines. */
  readonly confirmTimeoutMs: number;
}

/**
 * The delivery windows of this terminal session. A Task of a Run this session admitted that reaches "accepted · patch ready, awaiting
 * delivery" opens a window by itself in the background (the composer keeps focus; Ctrl+O or the active work strip moves input to it);
 * `/deliver` and the strip open one in the foreground. One window is shown at a time; the others wait in the strip. No delivery is ever
 * started without the window's own `y`, and nothing here decides autonomously.
 */
export function useDeliveryWindows(input: DeliveryWindowsInput) {
  const { port, labels } = input;
  const entries = useRef(new Map<string, Entry>()), order = useRef<string[]>([]), seen = useRef(new Set<string>()), deliveredKeys = useRef(new Set<string>());
  const [, rerender] = useState(0);
  const changed = useCallback(() => rerender(value => value + 1), []);
  const latest = useRef(input); latest.current = input;
  // TESLIM-KARTI-OZET: the ticket's summary follows its last view (read-only; a failed read leaves the status card alone).
  const summarize = useCallback((entry: Entry) => {
    const view = entry.queue, read = latest.current.port?.queue?.summary;
    if (view && read) read(view).then(summary => { if (entry.queue === view) { entry.queueSummary = summary; changed(); } }, () => undefined);
  }, [changed]);
  const load = useCallback((entry: Entry) => {
    const current = latest.current.port; if (!current) return;
    if (entry.queue && current.queue) { current.queue.inspect(entry.target.scopeId, entry.queue.commandId).then(view => { if (view) entry.queue = view; entry.stage = { kind: 'queue' }; summarize(entry); changed(); }, error => { entry.stage = { kind: 'failed', error: latest.current.errorText(error), code: codeOf(error) }; changed(); }); return; }
    entry.stage = { kind: 'loading' }; entry.preview = null; entry.consent = null; entry.ids = ids(); entry.selected = 0; entry.fileSel = 0; entry.diffScroll = null; entry.reattempt = false;
    current.preview(entry.target).then(preview => { if (entry.stage.kind === 'loading') { entry.preview = preview; entry.reattempt = preview.reattempt === true; entry.stage = { kind: 'ready' }; changed(); } },
      error => {
        const show = () => { entry.stage = { kind: 'failed', error: latest.current.errorText(error), code: codeOf(error) }; changed(); };
        // A refused preview that offers `r` (queue preparation on the current base) shows the re-attempt line first when that enqueue carries the intent.
        if (current.queue && QUEUE_REPREPARE.has(codeOf(error) ?? '')) current.queue.reattempt().then(yes => { entry.reattempt = yes; show(); }, show); else show();
      });
  }, [changed, summarize]);
  const open = useCallback((target: DeliveryTarget, opening: DeliveryOpening) => {
    if (!latest.current.port || !latest.current.labels) return;
    seen.current.add(target.key);
    let entry = entries.current.get(target.key);
    if (!entry) {
      entry = { target, sinceMs: Date.now(), opening, generation: 0, stage: { kind: 'loading' }, preview: null, consent: null, ids: ids(), delivered: null, adopted: null,
        selected: 0, closed: false, settled: false, verify: null };
      entries.current.set(target.key, entry); load(entry);
    } else if (entry.closed && !entry.delivered) load(entry);
    entry.closed = false; entry.opening = opening; entry.generation++;
    order.current = opening === 'foreground' ? [target.key, ...order.current.filter(key => key !== target.key)]
      : order.current.includes(target.key) ? order.current : [...order.current, target.key];
    changed();
  }, [changed, load]);
  // A Run this session admitted reaching "awaiting delivery" opens its window once, in the background; a refreshed snapshot never reopens it.
  const targets = useMemo(() => labels ? awaitingDeliveryTargets(input.runs, labels.fallbackTitle) : [], [input.runs, labels]);
  useEffect(() => { for (const target of targets) if (!seen.current.has(target.key)) open(target, 'background'); }, [targets, open]);
  // An unmounted terminal answers every waiting card with no.
  useEffect(() => () => { for (const entry of entries.current.values()) if (entry.stage.kind === 'confirm') entry.stage.waiting.resolve(false); else if (entry.stage.kind === 'queue-confirm') entry.stage.resolve(false); }, []);

  const answer = useCallback((entry: Entry) => async (view: EffectConfirmationView): Promise<boolean> => {
    const consent = entry.consent; entry.consent = null;
    if (consent && consentMatches(consent, view)) return true;
    // The port's card differs from what the window showed: show that exact card and wait for a fresh explicit y (bounded; silence is no).
    return new Promise<boolean>(resolve => {
      const back = view.operation === 'adopt-integration' ? 'adopting' : 'working';
      const timer = setTimeout(() => finish(false), latest.current.confirmTimeoutMs);
      const finish = (yes: boolean) => { clearTimeout(timer); if (entry.stage.kind === 'confirm') { entry.stage = { kind: back }; changed(); } resolve(yes); };
      entry.stage = { kind: 'confirm', waiting: { view, resolve: finish } }; changed();
    });
  }, [changed]);
  const fail = useCallback((entry: Entry, error: unknown) => {
    entry.stage = { kind: 'failed', error: latest.current.errorText(error), code: codeOf(error) }; changed();
  }, [changed]);
  const refreshQueue = useCallback((entry: Entry) => {
    const queue = latest.current.port?.queue;
    if (!queue || !entry.queue) return;
    queue.inspect(entry.target.scopeId, entry.queue.commandId).then(view => {
      if (view) { entry.queue = view; entry.stage = { kind: 'queue' }; entry.settled = view.state === 'settled'; summarize(entry); changed(); }
    }, error => fail(entry, error));
  }, [changed, fail, summarize]);
  const prepareCurrent = useCallback((entry: Entry) => {
    const queue = latest.current.port?.queue; if (!queue) return;
    entry.stage = { kind: 'queue-working' }; changed();
    queue.prepareCurrent(entry.target, `terminal-queue-${randomUUID()}`).then(view => { entry.queue = view; entry.stage = { kind: 'queue' }; summarize(entry); changed(); }, error => fail(entry, error));
  }, [changed, fail, summarize]);
  const confirmQueue = useCallback((entry: Entry) => {
    const queue = latest.current.port?.queue;
    if (!queue || entry.queue?.state !== 'awaiting-confirmation') return;
    entry.stage = { kind: 'queue-working' }; changed();
    const ask = (view: Omit<QueueConsent, 'capability'>, summaries: readonly (DeliverySummary | null)[]) => new Promise<boolean>(resolve => {
      const timer = setTimeout(() => finish(false), latest.current.confirmTimeoutMs);
      const finish = (yes: boolean) => { clearTimeout(timer); entry.stage = { kind: 'queue-working' }; changed(); resolve(yes); };
      entry.stage = { kind: 'queue-confirm', view, summaries, resolve: finish }; changed();
    });
    queue.confirm(entry.target.scopeId, entry.queue.commandId, ask).then(() => refreshQueue(entry), error => fail(entry, error));
  }, [changed, fail, refreshQueue]);
  const deliver = useCallback((entry: Entry) => {
    const current = latest.current.port, preview = entry.preview, words = latest.current.labels!;
    if (!current || !preview || entry.stage.kind !== 'ready') return;
    if (preview.queueTarget && current.queue) { prepareCurrent(entry); return; }
    entry.consent = { operation: 'deliver-integration', scopeId: preview.identity.scopeId, runId: preview.identity.runId, taskId: preview.identity.taskId,
      commandId: entry.ids.delivery, files: preview.files.map(file => file.path), from: preview.base };
    entry.stage = { kind: 'working' }; changed();
    current.deliver(preview, entry.ids, answer(entry)).then(outcome => {
      entry.delivered = outcome; entry.consent = null;
      entry.stage = { kind: preview.adoptionTargets.length ? 'delivered' : 'done' };
      if (!preview.adoptionTargets.length) entry.settled = true;
      latest.current.summary(fillTemplate(words.summaryDelivered, { title: humanRecordText(entry.target.title, latest.current.known), commit: outcome.commit.slice(0, 12), ref: outcome.ref,
        command: outcome.commandId }));
      changed();
    }, error => { entry.consent = null; fail(entry, error); });
  }, [answer, changed, fail, prepareCurrent]);
  // Y1: the candidates of the configured verification kind, read again on `r`; a failed read is the step's status (nothing is chosen for the person).
  const readVerification = useCallback((entry: Entry) => {
    const current = latest.current.port, preview = entry.preview; if (!current || !preview) return;
    const verify: Verify = { runs: null, selected: 0, status: entry.verify?.status ?? '' }; entry.verify = verify; changed();
    current.verificationRuns(preview).then(runs => { if (entry.verify === verify) { verify.runs = runs; changed(); } },
      error => { if (entry.verify === verify) { verify.runs = []; verify.status = latest.current.errorText(error); changed(); } });
  }, [changed]);
  const adopt = useCallback((entry: Entry, verificationRunId?: string) => {
    const current = latest.current.port, preview = entry.preview, delivered = entry.delivered, words = latest.current.labels!;
    const targetRef = preview?.adoptionTargets[entry.selected];
    if (!current || !preview || !delivered || !targetRef || (entry.stage.kind !== 'delivered' && entry.stage.kind !== 'verify')) return;
    entry.consent = { operation: 'adopt-integration', scopeId: preview.identity.scopeId, runId: preview.identity.runId, taskId: preview.identity.taskId,
      commandId: entry.ids.adopt, resource: targetRef, to: delivered.commit };
    entry.stage = { kind: 'adopting' }; changed();
    current.adopt(preview, delivered, targetRef, entry.ids.adopt, answer(entry), verificationRunId).then(outcome => {
      entry.adopted = outcome; entry.consent = null; entry.stage = { kind: 'done' }; entry.settled = true;
      // The adoption and delivery command ids are what `deckent task integration-rollback` and `integration-adopt` name (BETA-BELGE rollback gap).
      latest.current.summary(fillTemplate(words.summaryAdopted, { target: outcome.targetRef, from: outcome.fromCommit.slice(0, 12), to: outcome.toCommit.slice(0, 12),
        verification: outcome.verifiedBy ? fillTemplate(words.verifiedBy, { run: outcome.verifiedBy }) : words.notVerified, command: outcome.commandId, delivery: delivered.commandId }));
      changed();
    }, error => {
      entry.consent = null;
      // A verification refusal moved nothing: back to the choice with the reason; a retry is a new adoption command.
      if (preview.verification && VERIFY_RETRY.has(codeOf(error) ?? '')) {
        entry.ids = { ...entry.ids, adopt: ids().adopt }; entry.stage = { kind: 'verify' };
        entry.verify = { runs: entry.verify?.runs ?? null, selected: entry.verify?.selected ?? 0, status: latest.current.errorText(error) };
        if (entry.verify.runs === null) readVerification(entry); else changed();
        return;
      }
      entry.settled = true; fail(entry, error);
    });
  }, [answer, changed, fail, readVerification]);
  const close = useCallback((entry: Entry) => {
    const words = latest.current.labels!;
    if (entry.stage.kind === 'working' || entry.stage.kind === 'adopting' || entry.stage.kind === 'queue-working') return;
    if (entry.stage.kind === 'queue-confirm') { entry.stage.resolve(false); return; }
    if (entry.stage.kind === 'confirm') { entry.stage.waiting.resolve(false); return; }
    // The one transcript line of a window that ends without a new result: left waiting, or why it was not done (a success already wrote its line).
    const title = humanRecordText(entry.target.title, latest.current.known), stage = entry.stage;
    if (stage.kind === 'failed') latest.current.summary(entry.delivered ? fillTemplate(words.summaryAdoptFailed, { ref: entry.delivered.ref, reason: stage.error.split('\n')[0] ?? '' })
      : fillTemplate(words.summaryFailed, { title, reason: stage.error.split('\n')[0] ?? '' }), 'error');
    else if (stage.kind === 'delivered' && entry.delivered) latest.current.summary(fillTemplate(words.summaryNotAdopted, { ref: entry.delivered.ref }));
    else if (!entry.delivered) latest.current.summary(fillTemplate(words.summaryLeft, { title }));
    if (stage.kind === 'delivered') entry.settled = true;
    entry.closed = true;
    if (entry.settled) { entries.current.delete(entry.target.key); deliveredKeys.current.add(entry.target.key); }
    order.current = order.current.filter(key => key !== entry.target.key);
    changed();
  }, [changed]);

  const visible = order.current.map(key => entries.current.get(key)).find((entry): entry is Entry => Boolean(entry && !entry.closed)) ?? null;
  const element = visible && labels ? <WindowOpeningContext.Provider value={visible.opening}>
    <Window key={`delivery:${visible.target.key}:${visible.generation}`} title={[span(fillTemplate(labels.title, { title: humanRecordText(visible.target.title, input.known) }))]}
      body={deliveryLines(visible, labels, input.known)} hints={hintsOf(visible, labels, Boolean(port?.queue))} position={input.position} decision
      onInput={(text, key) => {
        // One key rule with the decision cards: only a single typed y says yes; Ctrl/Alt+y, pasted or coalesced keys leave it waiting.
        const stage = visible.stage, decision = decisionKey(text, key);
        if (stage.kind === 'queue-confirm') { if (decision !== null) stage.resolve(decision === 'yes'); return decision !== null; }
        if (text === 'r' && !key.ctrl && !key.meta && ['queue', 'failed'].includes(stage.kind) && latest.current.port?.queue) {
          if (visible.queue) refreshQueue(visible); else if (stage.kind === 'failed' && QUEUE_REPREPARE.has(stage.code ?? '')) prepareCurrent(visible);
          return true;
        }
        if (stage.kind === 'queue') { if (decision === 'yes') { confirmQueue(visible); return true; } if (decision === 'no') { close(visible); return true; } return false; }
        if (stage.kind === 'confirm') {
          if (decision !== null) stage.waiting.resolve(decision === 'yes');
          return decision !== null;
        }
        // Read-only diff of the changed files (ready step only): ↑↓/j/k choose a file, Enter opens its hunks, ↑↓/j/k scroll them, the page keys scroll the
        // window, Esc goes back. No key here delivers, adopts or declines.
        const diffs = stage.kind === 'ready' ? visible.preview?.diffs : undefined;
        if (diffs?.length && visible.preview && !key.ctrl && !key.meta) {
          const up = key.upArrow || text === 'k', down = key.downArrow || text === 'j', file = visible.fileSel ?? 0;
          if (visible.diffScroll !== null && visible.diffScroll !== undefined) {
            // The page keys stay the Window's own scroll, so a short terminal still reaches the page's last rows; every other key stays here and never decides.
            if (key.pageUp || key.pageDown || key.home || key.end) return false;
            const room = Math.max(0, (diffs[file]?.lines.length ?? 0) - WINDOW.diffViewLines);
            if (key.escape) visible.diffScroll = null;
            else if (up) visible.diffScroll = Math.max(0, visible.diffScroll - 1);
            else if (down) visible.diffScroll = Math.min(room, visible.diffScroll + 1);
            changed(); return true;
          }
          const count = Math.min(visible.preview.files.length, WINDOW.maxFiles);
          if ((up || down) && count) { visible.fileSel = (file + (up ? count - 1 : 1)) % count; changed(); return true; }
          if (key.return) { visible.diffScroll = 0; changed(); return true; }
        }
        if (stage.kind === 'delivered' && (key.upArrow || key.downArrow) && visible.preview) {
          const count = visible.preview.adoptionTargets.length;
          visible.selected = (visible.selected + (key.upArrow ? count - 1 : 1)) % count; changed(); return true;
        }
        if (stage.kind === 'verify' && visible.preview && visible.verify) {
          // The verification step: ↑↓ choose, a single typed y adopts with the chosen row, r reads the candidates again, n/Esc/Ctrl+C go back.
          const options = verifyOptions(visible.preview, visible.verify), verify = visible.verify;
          if ((key.upArrow || key.downArrow) && options.length) { verify.selected = (verify.selected + (key.upArrow ? options.length - 1 : 1)) % options.length; changed(); return true; }
          if (key.return) return false;
          if (decision === 'yes') { const chosen = options[verify.selected]; if (chosen !== undefined) adopt(visible, chosen ?? undefined); return true; }
          if (decision === 'no') { visible.stage = { kind: 'delivered' }; visible.verify = null; changed(); return true; }
          if (text === 'r' && !key.ctrl && !key.meta) { readVerification(visible); return true; }
          return false;
        }
        // Enter only closes a finished window; on a pending step it neither confirms nor declines.
        if (key.return) { if (stage.kind === 'done' || stage.kind === 'failed') { close(visible); return true; } return false; }
        if (decision === 'yes') {
          if (stage.kind === 'ready') deliver(visible);
          // With a configured verification bar the branch's y opens the verification choice first (the CLI's --verification-run).
          else if (stage.kind === 'delivered' && visible.preview?.verification) { visible.stage = { kind: 'verify' }; visible.verify = null; readVerification(visible); }
          else if (stage.kind === 'delivered') adopt(visible);
          return true;
        }
        if (decision === 'no') { close(visible); return true; }
        return false;
      }} />
  </WindowOpeningContext.Provider> : null;
  const pending = [...entries.current.values()].filter(entry => !entry.settled).map(entry => Object.freeze({ key: entry.target.key, title: entry.target.title, sinceMs: entry.sinceMs }));
  return { available: Boolean(port && labels), open, element, visible: visible !== null, pending, candidates: (runs: readonly RunView[]) => {
    // The first view of a Run wins (callers pass the fresh read model first); a task delivered in this session is never offered again.
    const fresh = new Map<string, RunView>(); for (const run of runs) if (!fresh.has(`${run.scopeId}:${run.runId}`)) fresh.set(`${run.scopeId}:${run.runId}`, run);
    return labels ? awaitingDeliveryTargets([...fresh.values()], labels.fallbackTitle).filter(target => !deliveredKeys.current.has(target.key) && !entries.current.get(target.key)?.delivered) : [];
  },
    target: (key: string) => entries.current.get(key)?.target ?? null };
}

function hintsOf(entry: Entry, labels: DeliveryWindowLabels, queueAvailable: boolean): string {
  switch (entry.stage.kind) {
    case 'queue': return labels.queue?.hints ?? '';
    case 'queue-confirm': return labels.confirmHints;
    case 'ready': return entry.preview?.diffs?.length ? entry.diffScroll !== null && entry.diffScroll !== undefined ? labels.diffHints : `${labels.hints} · ${labels.diffListHints}` : labels.hints;
    case 'confirm': return labels.confirmHints;
    case 'delivered': return labels.adoptHints;
    case 'verify': return entry.preview && entry.verify?.runs && verifyOptions(entry.preview, entry.verify).length ? labels.verifyHints : labels.verifyNoneHints;
    case 'done': return labels.doneHints;
    // The re-prepare key is offered only where `r` acts (the same rule as the key handler); closing stays visible on every failure.
    case 'failed': return labels.queue && queueAvailable && !entry.queue && QUEUE_REPREPARE.has(entry.stage.code ?? '')
      ? `${labels.queue.reprepare} · ${labels.failedHints}` : labels.failedHints;
    default: return '';
  }
}

/** Body rows: ids, the check of the current source, the changed files with their stat, where it writes, and the stage's own lines. */
export function deliveryLines(entry: Pick<Entry, 'target' | 'stage' | 'preview' | 'delivered' | 'adopted' | 'selected'> & Partial<Pick<Entry, 'verify' | 'queue' | 'queueSummary' | 'fileSel' | 'diffScroll' | 'reattempt'>>, labels: DeliveryWindowLabels, known?: KnownSecretSnapshot): WindowLine[] {
  const text = (value: string) => humanRecordText(value, known), line = (value: string, extra: SpanStyle = {}): WindowLine => ({ spans: [span(text(value), extra)] });
  const exact = (value: string, extra: SpanStyle = {}): WindowLine => ({ spans: [span(text(value), extra)], exact: true });
  const { target, stage, preview, delivered, adopted } = entry;
  const rows: WindowLine[] = [line(fillTemplate(labels.ids, { run: shortId(target.runId), task: target.taskId }), { role: 'muted' })];
  // The summary stands ABOVE the exact card or status, never inside it (the consent stays bound to the card's digest).
  if (stage.kind === 'queue-confirm' && labels.queue) return [...rows, ...(labels.cardSummary?.consent(stage.summaries ?? []) ?? []).map(value => line(value)),
    ...labels.queue.card(stage.view).split('\n').map(value => exact(value))];
  if (entry.queue && labels.queue && stage.kind === 'queue') return [...rows, ...(entry.queueSummary !== undefined && labels.cardSummary ? labels.cardSummary.lines(entry.queueSummary, false) : []).map(value => line(value)),
    ...labels.queue.status(entry.queue).split('\n').map(value => exact(value))];
  if (stage.kind === 'queue-working' && labels.queue) return [...rows, line(labels.queue.waiting)];
  if (stage.kind === 'confirm') {
    const view = stage.waiting.view;
    rows.push(line(labels.confirmBody, { role: 'warning' }), line(view.title, { bold: true }), exact(fillTemplate(labels.confirmRef, { ref: view.resource, from: view.from, to: view.to })),
      line(fillTemplate(labels.summary, { count: view.files.length, added: view.added, removed: view.removed })),
      ...view.files.slice(0, WINDOW.maxFiles).map(path => exact(path)));
    if (view.files.length > WINDOW.maxFiles) rows.push(line(fillTemplate(labels.moreFiles, { count: view.files.length - WINDOW.maxFiles }), { role: 'muted' }));
    return rows;
  }
  if (stage.kind === 'loading') return [...rows, line(labels.loading, { role: 'muted' })];
  if (preview) {
    if (stage.kind === 'ready' && entry.diffScroll !== null && entry.diffScroll !== undefined && preview.diffs?.length)
      return [...rows, ...diffLines(preview, entry.fileSel ?? 0, entry.diffScroll, labels, text)];
    rows.push(line(fillTemplate(labels.check, { base: preview.base.slice(0, 12), source: preview.source }), { role: 'success' }));
    if (preview.outOfScope.length) rows.push(line(fillTemplate(labels.outOfScope, { count: preview.outOfScope.length, paths: preview.outOfScope.join(', ') }), { role: 'warning' }));
    rows.push(line(fillTemplate(labels.summary, { count: preview.files.length, added: preview.added, removed: preview.removed })),
      ...preview.files.slice(0, WINDOW.maxFiles).map((file, index) => exact(`${preview.diffs?.length ? `${index === (entry.fileSel ?? 0) ? '›' : ' '} ` : ''}${fillTemplate(labels.file, { path: file.path, added: file.added, removed: file.removed })}`,
        preview.diffs?.length && index === (entry.fileSel ?? 0) ? { role: 'accent', bold: true } : {})));
    if (preview.files.length > WINDOW.maxFiles) rows.push(line(fillTemplate(labels.moreFiles, { count: preview.files.length - WINDOW.maxFiles }), { role: 'muted' }));
    if (!delivered) {
      if (preview.summary !== undefined && labels.cardSummary) rows.push(...labels.cardSummary.lines(preview.summary, true).map(value => line(value)));
      rows.push(line(labels.where, { role: 'muted' }));
      if (preview.adoptionTargets.length) rows.push(line(fillTemplate(labels.adoptionLater, { targets: preview.adoptionTargets.join(', ') }), { role: 'muted' }));
      if (preview.queueTarget && preview.reattempt) rows.push(line(labels.reattempt, { role: 'muted' }));
    }
  }
  if (stage.kind === 'working' || stage.kind === 'adopting') rows.push(line(stage.kind === 'working' ? labels.working : labels.adopting, { role: 'accent' }));
  if (delivered) rows.push(exact(fillTemplate(labels.delivered, { commit: delivered.commit, ref: delivered.ref, command: delivered.commandId }), { role: 'success' }));
  if (stage.kind === 'delivered' && preview && delivered) {
    rows.push(line(fillTemplate(labels.adoptPrompt, { commit: delivered.commit.slice(0, 12) }), { bold: true }));
    preview.adoptionTargets.forEach((targetRef, index) => rows.push(exact(fillTemplate(labels.adoptTarget, { mark: index === entry.selected ? '›' : ' ', target: targetRef, commit: delivered.commit.slice(0, 12) }),
      index === entry.selected ? { role: 'accent', bold: true } : {})));
  }
  if (stage.kind === 'verify' && preview?.verification && delivered) rows.push(...verifyLines(entry.verify ?? null, preview, delivered, preview.adoptionTargets[entry.selected] ?? '', labels, text));
  if (adopted) rows.push(exact(fillTemplate(labels.adopted, { target: adopted.targetRef, from: adopted.fromCommit, to: adopted.toCommit, command: adopted.commandId,
    verification: adopted.verifiedBy ? fillTemplate(labels.verifiedBy, { run: adopted.verifiedBy }) : labels.notVerified }), { role: 'success' }));
  if (stage.kind === 'failed') {
    rows.push(...stage.error.split('\n').map(value => line(value, { role: 'error' })));
    if (!preview && !entry.queue && entry.reattempt && QUEUE_REPREPARE.has(stage.code ?? '')) rows.push(line(labels.reattempt, { role: 'muted' }));
    // A next step may name the exact command for this attempt, delivery and selected branch (ADOPTION_NOT_VERIFIED: the CLI with --verification-run).
    const next = (stage.code ? labels.next[stage.code] : undefined) ?? labels.nextDefault, id = preview?.identity;
    // Identities admit spaces, quotes, $() and ; — every value placed into the suggested command is one POSIX shell word (Astra 2543 P1).
    const arg = shellWord, target = preview?.adoptionTargets[entry.selected];
    rows.push(line(preview && id ? fillTemplate(next, { scope: arg(id.scopeId), run: arg(id.runId), task: arg(id.taskId), attempt: arg(id.attemptId),
      generation: arg(String(id.generation)), layout: arg(id.layoutRevision), delivery: delivered ? arg(delivered.commandId) : '<delivery>',
      target: target === undefined ? '<branch>' : arg(target) }) : next, { role: 'accent' }));
  }
  return rows;
}
/** The opened file's hunks: the Attempt/base/proposal the preview was built from, then one bounded page of the diff body (every row sanitized and redacted by `text`). */
function diffLines(preview: DeliveryPreview, index: number, scroll: number, labels: DeliveryWindowLabels, text: (value: string) => string): WindowLine[] {
  const diff = preview.diffs![index], id = preview.identity;
  const row = (value: string, extra: SpanStyle = {}): WindowLine => ({ spans: [span(text(value), extra)], exact: true });
  const rows: WindowLine[] = [row(fillTemplate(labels.diffHeader, { path: diff?.path ?? '', index: index + 1, count: preview.files.length, attempt: `${id.attemptId}#${id.generation}`,
    base: preview.base.slice(0, 12), proposal: preview.proposal.slice(0, 12) }), { bold: true })];
  if (!diff || diff.unavailable) return [...rows, row(labels.diffUnavailable, { role: 'warning' })];
  if (!diff.lines.length) return [...rows, row(labels.diffEmpty, { role: 'muted' })];
  const page = diff.lines.slice(scroll, scroll + WINDOW.diffViewLines);
  rows.push(...page.map(value => row(value, value.startsWith('@@') ? { role: 'accent' } : value.startsWith('+') ? { role: 'success' } : value.startsWith('-') ? { role: 'error' } : {})));
  rows.push(row(fillTemplate(labels.diffPosition, { from: scroll + 1, to: scroll + page.length, total: diff.lines.length }), { role: 'muted' }));
  if (diff.hidden) rows.push(row(fillTemplate(labels.diffHidden, { count: diff.hidden }), { role: 'muted' }));
  return rows;
}
/** The verification step's rows: what is chosen for which branch, the candidates (or why there is none and how to make one), and what the adoption checks. */
function verifyLines(verify: Verify | null, preview: DeliveryPreview, delivered: DeliveryOutcome, target: string, labels: DeliveryWindowLabels, text: (value: string) => string): WindowLine[] {
  const kind = preview.verification!.kind, line = (value: string, extra: SpanStyle = {}): WindowLine => ({ spans: [span(text(value), extra)] });
  const rows: WindowLine[] = [line(fillTemplate(labels.verifyTitle, { target, kind }), { bold: true })];
  if (!verify?.runs) return [...rows, line(labels.verifyLoading, { role: 'muted' })];
  const options = verifyOptions(preview, verify);
  options.forEach((runId, index) => {
    const mark = index === verify.selected ? '›' : ' ', style: SpanStyle = index === verify.selected ? { role: 'accent', bold: true } : {};
    const candidate = verify.runs!.find(run => run.runId === runId);
    rows.push({ spans: [span(text(runId === null ? fillTemplate(labels.verifyWithout, { mark }) : fillTemplate(labels.verifyRow, { mark, run: runId, task: candidate?.taskId ?? '' })), style)], exact: true });
  });
  if (!verify.runs.length) {
    rows.push(line(fillTemplate(labels.verifyNone, { kind }), { role: 'warning' }));
    rows.push({ spans: [span(text(fillTemplate(labels.verifyHow, { scope: shellWord(preview.identity.scopeId), kind, delivery: shellWord(delivered.commandId) })), { role: 'accent' })], exact: true });
  }
  if (verify.status) rows.push(...verify.status.split('\n').map(value => line(value, { role: 'error' })));
  rows.push(line(labels.verifyCheck, { role: 'muted' }));
  return rows;
}
/** One POSIX shell word: safe characters stay as they are; anything else is single-quoted with embedded quotes closed and escaped. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9._/:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
export type DeliveryWindows = ReturnType<typeof useDeliveryWindows>;
