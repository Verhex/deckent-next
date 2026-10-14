import type { AttemptIdentity } from '#domain/index.js';
import type { EffectConfirmationView, RunView } from '#engine/index.js';

/**
 * TESLIM-PENCERESI (owner 2026-10-14): the terminal delivery window's port. The surface never writes Git, refs or the ledger itself:
 * `preview` is read-only (inventory, patch preview, integration check, configured adoption targets) and `deliver` / `adopt` go through the
 * existing integration applications and the TESLIM-GUVENLIK confirmation port that the trusted CLI composition binds to this verified TTY.
 */
export type DeliveryTarget = Readonly<{ key: string; scopeId: string; runId: string; taskId: string; title: string }>;
export type DeliveryFileStat = Readonly<{ path: string; added: number; removed: number }>;
/** What the window shows before the person's `y`; `base`/`source`/`proposal` come from the integration check of the current source. */
/** `verification`: the installation's adoption bar (`execution.adoption.verification`): the verifying task kind and whether adoption requires it. */
export type DeliveryPreview = Readonly<{ target: DeliveryTarget; identity: AttemptIdentity; files: readonly DeliveryFileStat[]; added: number; removed: number;
  source: string; base: string; proposal: string; outOfScope: readonly string[]; adoptionTargets: readonly string[];
  verification: Readonly<{ kind: string; required: boolean }> | null }>;
export type DeliveryOutcome = Readonly<{ ref: string; commit: string; commandId: string }>;
/** `commandId`: the adoption's own command (what `deckent task integration-rollback --adoption-command-id` names); `verifiedBy`: the verification Run, if any. */
export type AdoptionOutcome = Readonly<{ targetRef: string; fromCommit: string; toCommit: string; commandId: string; verifiedBy: string | null }>;
/** An accepted Run of the configured verification kind with one task (the bar's shape). Whether it ran on this delivered commit and meets the
 * criteria is decided by the adoption application, never by this list. */
export type VerificationCandidate = Readonly<{ runId: string; taskId: string }>;
/** The answer the confirmation port asks for; only the window that showed the card supplies it (never a command field, model or SDK). */
export type DeliveryAnswer = (view: EffectConfirmationView) => Promise<boolean>;
export interface TerminalDeliveryPort {
  preview(target: DeliveryTarget): Promise<DeliveryPreview>;
  /** One flow after the person's `y`: verified-terminal check, candidate preparation, then delivery to a dedicated ref. */
  deliver(preview: DeliveryPreview, ids: Readonly<{ candidate: string; delivery: string }>, answer: DeliveryAnswer): Promise<DeliveryOutcome>;
  /** Moves one configured adoption target to the delivered commit, after its own explicit `y`. A verification Run is named like the CLI's
   * `--verification-run`; its kind is read from the configuration at that moment, never from the window. */
  adopt(preview: DeliveryPreview, delivery: DeliveryOutcome, targetRef: string, commandId: string, answer: DeliveryAnswer, verificationRunId?: string): Promise<AdoptionOutcome>;
  /** Y1: the scope's accepted Runs of the configured verification kind (read-only); empty when none exists yet. */
  verificationRuns(preview: DeliveryPreview): Promise<readonly VerificationCandidate[]>;
}

/**
 * The window's `y` is recorded as a one-shot consent of exactly what it showed. The confirmation port's answer consumes it and says yes only
 * when the port's card is the same operation, scope, Run, Task and command, and — for delivery — the same changed file set and base commit,
 * for adoption the same target branch and delivered commit. Anything else is shown to the person as the port's exact card and needs a fresh `y`.
 */
export type DeliveryConsent = Readonly<{ operation: 'deliver-integration' | 'adopt-integration'; scopeId: string; runId: string; taskId: string; commandId: string;
  files?: readonly string[]; from?: string; resource?: string; to?: string }>;
export function consentMatches(consent: DeliveryConsent, view: EffectConfirmationView): boolean {
  if (view.operation !== consent.operation || view.scopeId !== consent.scopeId || view.runId !== consent.runId || view.taskId !== consent.taskId
    || view.commandId !== consent.commandId) return false;
  if (consent.files) {
    const shown = [...new Set(consent.files)].sort(), asked = [...new Set(view.files)].sort();
    if (shown.length !== asked.length || shown.some((path, index) => path !== asked[index])) return false;
  }
  return (consent.from === undefined || consent.from === view.from) && (consent.resource === undefined || consent.resource === view.resource)
    && (consent.to === undefined || consent.to === view.to);
}

/**
 * Tasks whose prepared patch awaits delivery: an accepted task that carries work input, whose Run is finished and whose result brief says
 * "awaiting delivery" (the monitor's derivation; no new rule). A Run's tasks without work input deliver nothing.
 */
export function awaitingDeliveryTargets(runs: readonly RunView[], fallbackTitle: string): readonly DeliveryTarget[] {
  const targets = new Map<string, DeliveryTarget>();
  for (const run of runs) {
    if (run.state.kind !== 'terminal') continue;
    for (const task of run.tasks) {
      const instruction = task.taskBrief?.task;
      if (task.phase !== 'accepted' || task.resultBrief?.deliveryOutlook !== 'awaiting-delivery' || !instruction) continue;
      const key = `${run.scopeId}:${run.runId}:${task.id}`;
      if (!targets.has(key)) targets.set(key, Object.freeze({ key, scopeId: run.scopeId, runId: run.runId, taskId: task.id,
        title: instruction.split(/\r?\n/u).find(line => line.trim())?.trim() ?? fallbackTitle }));
    }
  }
  return Object.freeze([...targets.values()]);
}
