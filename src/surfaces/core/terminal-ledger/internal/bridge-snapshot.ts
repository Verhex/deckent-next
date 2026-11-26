import { redactForRecord, terminalSafeText, type KnownSecretSnapshot } from '#platform/index.js';
import type { InferenceServingProfile } from '#domain/index.js';
import type { InferenceServingPlan } from '#engine/index.js';
import type { WorkLedgerEntry } from './work-ledger.js';

export const WORKLINE_BRIDGE_SCHEMA_VERSION = 1;

export interface WorklineBridgeSnapshot {
  readonly schemaVersion: typeof WORKLINE_BRIDGE_SCHEMA_VERSION;
  readonly profileId: string;
  readonly openaiBaseUrl: string;
  readonly publishedModelIds: readonly string[];
  readonly tty: { readonly columns: number | null; readonly rows: number | null };
  readonly ledgerTail: readonly WorkLedgerEntry[];
  readonly observedAtMs: number;
}

export interface WorklineBridgeSink {
  readonly onUpdate: (snapshot: WorklineBridgeSnapshot) => void;
  readonly maxTail?: number;
  readonly publishedModelIds?: readonly string[];
}

export interface BuildWorklineBridgeSnapshotInput {
  readonly knownSecrets?: KnownSecretSnapshot;
  readonly profile: InferenceServingProfile;
  readonly plan: InferenceServingPlan;
  readonly tty: { readonly columns: number | null; readonly rows: number | null };
  readonly ledgerTail: readonly WorkLedgerEntry[];
  readonly publishedModelIds?: readonly string[];
  readonly maxTail?: number;
  readonly observedAtMs?: number;
}

export function buildWorklineBridgeSnapshot(input: BuildWorklineBridgeSnapshotInput): WorklineBridgeSnapshot {
  const maxTail = input.maxTail ?? 200;
  const safe = (text: string) => redactForRecord(terminalSafeText(redactForRecord(text, input.knownSecrets)), input.knownSecrets);
  const nullable = (text: string | null) => text === null ? null : safe(text);
  // Chat text is model invocation content governed by invocation retention/purge; the bridge carries work items only.
  const work = input.ledgerTail.filter(entry => entry.kind !== 'chat');
  const tail = (work.length > maxTail ? work.slice(-maxTail) : work).map(entry => {
    if (entry.kind === 'notice') return Object.freeze({ ...entry, text: safe(entry.text),
      ...(entry.identity ? { identity: { model: safe(entry.identity.model), provider: safe(entry.identity.provider) } } : {}) });
    if (entry.kind === 'worker') {
      const { sourceId, ...worker } = entry;
      void sourceId; // The terminal's selection provenance stays local.
      return Object.freeze({ ...worker, process: safe(worker.process), provider: safe(worker.provider), authority: safe(worker.authority),
        ...(worker.live ? { live: { ...worker.live, target: nullable(worker.live.target), detail: nullable(worker.live.detail),
          provider: nullable(worker.live.provider), model: nullable(worker.live.model) } } : {}) });
    }
    return entry;
  });
  const published = input.publishedModelIds?.length
    ? input.publishedModelIds
    : Object.freeze([input.profile.model.modelId]);
  return Object.freeze({
    schemaVersion: WORKLINE_BRIDGE_SCHEMA_VERSION,
    profileId: safe(input.profile.id),
    openaiBaseUrl: safe(input.plan.openaiBaseUrl ?? ''),
    publishedModelIds: Object.freeze(published.map(safe)),
    tty: input.tty,
    ledgerTail: Object.freeze([...tail]),
    observedAtMs: input.observedAtMs ?? Date.now(),
  });
}
