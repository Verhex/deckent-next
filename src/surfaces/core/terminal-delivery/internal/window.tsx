import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import type { EffectConfirmationView, RunView } from '#engine/index.js';
import { shortId, type KnownSecretSnapshot } from '#platform/index.js';
import { fillTemplate, humanRecordText, span, type SpanStyle } from '#surfaces/core/terminal-render/index.js';
import { Window, WindowOpeningContext, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { awaitingDeliveryTargets, consentMatches, type AdoptionOutcome, type DeliveryConsent, type DeliveryOutcome, type DeliveryPreview,
  type DeliveryTarget, type TerminalDeliveryPort } from './contract.js';
import WINDOW from './window.json' with { type: 'json' };

/** Catalog words of the delivery window (terminal.delivery.*); `next` maps a typed error code to its next-step sentence. */
export interface DeliveryWindowLabels {
  readonly title: string; readonly ids: string; readonly loading: string; readonly check: string; readonly outOfScope: string; readonly summary: string;
  readonly file: string; readonly moreFiles: string; readonly where: string; readonly adoptionLater: string; readonly hints: string;
  readonly working: string; readonly confirmBody: string; readonly confirmRef: string; readonly confirmHints: string;
  readonly delivered: string; readonly adoptPrompt: string; readonly adoptTarget: string; readonly adoptHints: string; readonly adopting: string;
  readonly adopted: string; readonly doneHints: string; readonly failedHints: string;
  readonly summaryDelivered: string; readonly summaryAdopted: string; readonly summaryLeft: string; readonly summaryFailed: string; readonly summaryAdoptFailed: string; readonly summaryNotAdopted: string;
  readonly next: Readonly<Record<string, string>>; readonly nextDefault: string; readonly pickerTitle: string; readonly none: string; readonly fallbackTitle: string;
}
export type DeliveryOpening = 'foreground' | 'background';
type Waiting = Readonly<{ view: EffectConfirmationView; resolve: (yes: boolean) => void }>;
type Stage = Readonly<{ kind: 'loading' | 'ready' | 'working' | 'adopting' }> | Readonly<{ kind: 'confirm'; waiting: Waiting }>
  | Readonly<{ kind: 'delivered' }> | Readonly<{ kind: 'done' }> | Readonly<{ kind: 'failed'; error: string; code: string | null }>;
interface Entry {
  readonly target: DeliveryTarget; readonly sinceMs: number;
  opening: DeliveryOpening; generation: number; stage: Stage; preview: DeliveryPreview | null; consent: DeliveryConsent | null;
  ids: { candidate: string; delivery: string; adopt: string }; delivered: DeliveryOutcome | null; adopted: AdoptionOutcome | null;
  selected: number; closed: boolean; settled: boolean;
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
  const load = useCallback((entry: Entry) => {
    const current = latest.current.port; if (!current) return;
    entry.stage = { kind: 'loading' }; entry.preview = null; entry.consent = null; entry.ids = ids(); entry.selected = 0;
    current.preview(entry.target).then(preview => { if (entry.stage.kind === 'loading') { entry.preview = preview; entry.stage = { kind: 'ready' }; changed(); } },
      error => { entry.stage = { kind: 'failed', error: latest.current.errorText(error), code: codeOf(error) }; changed(); });
  }, [changed]);
  const open = useCallback((target: DeliveryTarget, opening: DeliveryOpening) => {
    if (!latest.current.port || !latest.current.labels) return;
    seen.current.add(target.key);
    let entry = entries.current.get(target.key);
    if (!entry) {
      entry = { target, sinceMs: Date.now(), opening, generation: 0, stage: { kind: 'loading' }, preview: null, consent: null, ids: ids(), delivered: null, adopted: null,
        selected: 0, closed: false, settled: false };
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
  useEffect(() => () => { for (const entry of entries.current.values()) if (entry.stage.kind === 'confirm') entry.stage.waiting.resolve(false); }, []);

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
  const deliver = useCallback((entry: Entry) => {
    const current = latest.current.port, preview = entry.preview, words = latest.current.labels!;
    if (!current || !preview || entry.stage.kind !== 'ready') return;
    entry.consent = { operation: 'deliver-integration', scopeId: preview.identity.scopeId, runId: preview.identity.runId, taskId: preview.identity.taskId,
      commandId: entry.ids.delivery, files: preview.files.map(file => file.path), from: preview.base };
    entry.stage = { kind: 'working' }; changed();
    current.deliver(preview, entry.ids, answer(entry)).then(outcome => {
      entry.delivered = outcome; entry.consent = null;
      entry.stage = { kind: preview.adoptionTargets.length ? 'delivered' : 'done' };
      if (!preview.adoptionTargets.length) entry.settled = true;
      latest.current.summary(fillTemplate(words.summaryDelivered, { title: humanRecordText(entry.target.title, latest.current.known), commit: outcome.commit.slice(0, 12), ref: outcome.ref }));
      changed();
    }, error => { entry.consent = null; fail(entry, error); });
  }, [answer, changed, fail]);
  const adopt = useCallback((entry: Entry) => {
    const current = latest.current.port, preview = entry.preview, delivered = entry.delivered, words = latest.current.labels!;
    const targetRef = preview?.adoptionTargets[entry.selected];
    if (!current || !preview || !delivered || !targetRef || entry.stage.kind !== 'delivered') return;
    entry.consent = { operation: 'adopt-integration', scopeId: preview.identity.scopeId, runId: preview.identity.runId, taskId: preview.identity.taskId,
      commandId: entry.ids.adopt, resource: targetRef, to: delivered.commit };
    entry.stage = { kind: 'adopting' }; changed();
    current.adopt(preview, delivered, targetRef, entry.ids.adopt, answer(entry)).then(outcome => {
      entry.adopted = outcome; entry.consent = null; entry.stage = { kind: 'done' }; entry.settled = true;
      latest.current.summary(fillTemplate(words.summaryAdopted, { target: outcome.targetRef, from: outcome.fromCommit.slice(0, 12), to: outcome.toCommit.slice(0, 12) }));
      changed();
    }, error => { entry.consent = null; entry.settled = true; fail(entry, error); });
  }, [answer, changed, fail]);
  const close = useCallback((entry: Entry) => {
    const words = latest.current.labels!;
    if (entry.stage.kind === 'working' || entry.stage.kind === 'adopting') return;
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
      body={deliveryLines(visible, labels, input.known)} hints={hintsOf(visible, labels)} position={input.position}
      onInput={(text, key) => {
        const stage = visible.stage, lower = text.toLowerCase();
        if (stage.kind === 'confirm') {
          if (lower === 'y') stage.waiting.resolve(true); else if (lower === 'n' || key.escape) stage.waiting.resolve(false);
          return lower === 'y' || lower === 'n' || key.escape;
        }
        if (stage.kind === 'delivered' && (key.upArrow || key.downArrow) && visible.preview) {
          const count = visible.preview.adoptionTargets.length;
          visible.selected = (visible.selected + (key.upArrow ? count - 1 : 1)) % count; changed(); return true;
        }
        if (lower === 'y') { if (stage.kind === 'ready') deliver(visible); else if (stage.kind === 'delivered') adopt(visible); return true; }
        if (lower === 'n' || key.escape || (key.return && (stage.kind === 'done' || stage.kind === 'failed'))) { close(visible); return true; }
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

function hintsOf(entry: Entry, labels: DeliveryWindowLabels): string {
  switch (entry.stage.kind) {
    case 'ready': return labels.hints;
    case 'confirm': return labels.confirmHints;
    case 'delivered': return labels.adoptHints;
    case 'done': return labels.doneHints;
    case 'failed': return labels.failedHints;
    default: return '';
  }
}

/** Body rows: ids, the check of the current source, the changed files with their stat, where it writes, and the stage's own lines. */
export function deliveryLines(entry: Pick<Entry, 'target' | 'stage' | 'preview' | 'delivered' | 'adopted' | 'selected'>, labels: DeliveryWindowLabels, known?: KnownSecretSnapshot): WindowLine[] {
  const text = (value: string) => humanRecordText(value, known), line = (value: string, extra: SpanStyle = {}): WindowLine => ({ spans: [span(text(value), extra)] });
  const exact = (value: string, extra: SpanStyle = {}): WindowLine => ({ spans: [span(text(value), extra)], exact: true });
  const { target, stage, preview, delivered, adopted } = entry;
  const rows: WindowLine[] = [line(fillTemplate(labels.ids, { run: shortId(target.runId), task: target.taskId }), { role: 'muted' })];
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
    rows.push(line(fillTemplate(labels.check, { base: preview.base.slice(0, 12), source: preview.source }), { role: 'success' }));
    if (preview.outOfScope.length) rows.push(line(fillTemplate(labels.outOfScope, { count: preview.outOfScope.length, paths: preview.outOfScope.join(', ') }), { role: 'warning' }));
    rows.push(line(fillTemplate(labels.summary, { count: preview.files.length, added: preview.added, removed: preview.removed })),
      ...preview.files.slice(0, WINDOW.maxFiles).map(file => exact(fillTemplate(labels.file, { path: file.path, added: file.added, removed: file.removed }))));
    if (preview.files.length > WINDOW.maxFiles) rows.push(line(fillTemplate(labels.moreFiles, { count: preview.files.length - WINDOW.maxFiles }), { role: 'muted' }));
    if (!delivered) {
      rows.push(line(labels.where, { role: 'muted' }));
      if (preview.adoptionTargets.length) rows.push(line(fillTemplate(labels.adoptionLater, { targets: preview.adoptionTargets.join(', ') }), { role: 'muted' }));
    }
  }
  if (stage.kind === 'working' || stage.kind === 'adopting') rows.push(line(stage.kind === 'working' ? labels.working : labels.adopting, { role: 'accent' }));
  if (delivered) rows.push(exact(fillTemplate(labels.delivered, { commit: delivered.commit, ref: delivered.ref }), { role: 'success' }));
  if (stage.kind === 'delivered' && preview && delivered) {
    rows.push(line(fillTemplate(labels.adoptPrompt, { commit: delivered.commit.slice(0, 12) }), { bold: true }));
    preview.adoptionTargets.forEach((targetRef, index) => rows.push(exact(fillTemplate(labels.adoptTarget, { mark: index === entry.selected ? '›' : ' ', target: targetRef, commit: delivered.commit.slice(0, 12) }),
      index === entry.selected ? { role: 'accent', bold: true } : {})));
  }
  if (adopted) rows.push(exact(fillTemplate(labels.adopted, { target: adopted.targetRef, from: adopted.fromCommit, to: adopted.toCommit }), { role: 'success' }));
  if (stage.kind === 'failed') {
    rows.push(...stage.error.split('\n').map(value => line(value, { role: 'error' })));
    rows.push(line((stage.code ? labels.next[stage.code] : undefined) ?? labels.nextDefault, { role: 'accent' }));
  }
  return rows;
}
export type DeliveryWindows = ReturnType<typeof useDeliveryWindows>;
