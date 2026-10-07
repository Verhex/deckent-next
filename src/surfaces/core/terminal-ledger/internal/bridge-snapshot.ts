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
  // Chat text is model invocation content governed by invocation retention/purge; the bridge carries work items only.
  const work = input.ledgerTail.filter(entry => entry.kind !== 'chat');
  const tail = work.length > maxTail ? work.slice(-maxTail) : work;
  const published = input.publishedModelIds?.length
    ? input.publishedModelIds
    : Object.freeze([input.profile.model.modelId]);
  return Object.freeze({
    schemaVersion: WORKLINE_BRIDGE_SCHEMA_VERSION,
    profileId: input.profile.id,
    openaiBaseUrl: input.plan.openaiBaseUrl ?? '',
    publishedModelIds: published,
    tty: input.tty,
    ledgerTail: Object.freeze([...tail]),
    observedAtMs: input.observedAtMs ?? Date.now(),
  });
}
