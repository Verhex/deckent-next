import type { BrainPlanCommand } from '#domain/index.js';
import type { SetupPlan, SetupStage, SetupObservation, RunIntentRecord, RunPlanningResult, SetupPermissionPreview } from '#engine/index.js';
import type { Locale } from '#platform/index.js';
/** The folder's kind and its visible top-level names (bounded by the observer); first-task facts are derived from them by registry data. */
export type FolderFacts = Readonly<{ kind: 'coding' | 'documents' | 'empty' | 'unknown'; entries: readonly string[] }>;
export type FirstTaskIntent = Readonly<{ commandId: string; scopeId: string; folder: string; intent: string; pending?: RunIntentRecord }>;
export type OnboardingConfigBasis = Readonly<{ projectDigest: string | null; globalDigest: string }>;
export type OnboardingCommitPreview = Readonly<{ state: 'has-commits' }> | Readonly<{ state: 'staged' }> | Readonly<{ state: 'offered'; identity: boolean; sign: boolean; hooks: 'not-run';
  total: number; selected: number; flagged: number; rows: readonly Readonly<{ path: string; bytes: number; flag: string | null }>[]; more: number; digest: string }>;
export type OnboardingSnapshot = Readonly<{ configBasis: OnboardingConfigBasis; plan: SetupPlan; observation: SetupObservation; answers: Readonly<Record<string, unknown>>;
  deferred: readonly string[]; modelUsable: boolean; folder: string; folderFacts: FolderFacts; scopeId: string;
  hosts: readonly Readonly<{ id: string; cli: string; login: string }>[];
  admittedProviders?: readonly string[];
  budget: Readonly<{ needed: boolean; presetUsd: number; presetsUsd: readonly number[]; currentUsd: number | null; reason?: string }>;
  permissions: Readonly<{ state: SetupPermissionPreview['state'] | 'unavailable'; reason: string; digest?: string; mode?: string; profile?: string; principal?: string;
    selectedProfile?: SetupPermissionPreview['selectedProfile']; profiles?: SetupPermissionPreview['profiles'] }>;
  ready?: Readonly<{ provider: string | null; imageId: string | null; fallbackBefore: string | null; fallbackAfter: string | null }>;
  pending: readonly RunIntentRecord[];
  rights?: Readonly<{ state: 'needed' | 'current' | 'unavailable'; digest?: string; rules: number }> }>; // BeUser ZEY-02/D-04: the founder card, previewed
export interface OnboardingPort {
  observe(answers: Readonly<Record<string, unknown>>): Promise<OnboardingSnapshot>;
  assertPerson(): Promise<void>;
  defer(stageId: string, planDigest: string): Promise<void>;
  /** R18: forgets this person's deferrals of steps that are no longer open (settled elsewhere); absent → only the notice skips them. */
  settle?(stageIds: readonly string[]): Promise<void>;
  apply(stage: SetupStage, basis: OnboardingConfigBasis): Promise<Readonly<{ status: string; code?: string }>>;
  previewConsent(provider: string): Promise<Readonly<{ digest: string; providers: readonly string[]; sources: readonly string[]; proxy: string | null;
    baseRef: string; recipeDigest: string; sizeGigabytes: number | null; referenceMs?: number | null; buildTimeoutMs: number; previousMs?: number | null; images?: readonly Readonly<{ imageId: string; tag: string; ready: boolean }>[] }>>;
  consent(provider: string, digest: string, imageId?: string): Promise<void>;
  budget(usd: number): Promise<void>;
  /** The existing person-only founder card (owner baseline, MCP-delegable family) applied at the previewed digest; absent → the step is not offered. */
  rights?(digest: string): Promise<Readonly<{ status: string }>>;
  /** U5 alone owns this operation; an absent carrier is unavailable, never an implicit grant. */
  previewPermissions?(profile?: Readonly<{ id: string; version: number }>): Promise<SetupPermissionPreview>;
  permissions?(digest: string, profile?: Readonly<{ id: string; version: number }>): Promise<void>;
  previewProfile?(stage: SetupStage): Promise<Readonly<{ digest: string; expect: string | null; profile: string; provider: string; image: string; kind: string }>>;
  previewFirstCommit?(message: string, include?: readonly string[]): Promise<OnboardingCommitPreview>;
  firstCommit?(input: Readonly<{ message: string; digest: string; include?: readonly string[] }>, signal?: AbortSignal): Promise<Readonly<{ status: string }>>;
  firstCommitRecovery?(): Promise<Readonly<{ state: 'none' | 'settled' | 'prepared' }> | Readonly<{ state: 'pending'; paths: readonly string[]; pathsFile: string;
    locked: boolean; overlap: readonly string[]; command: string | null }>>;
  reconcile(intent: RunIntentRecord): Promise<RunIntentRecord>;
  start(intent: RunIntentRecord, signal?: AbortSignal): Promise<RunPlanningResult>;
  cancel(intent: RunIntentRecord): Promise<void>;
}
export type OnboardingStep = Readonly<{ id: string; stages: readonly SetupStage[]; kind: 'stage' | 'work' | 'ready' | 'budget' | 'permissions' | 'rights' | 'first-task' | 'parked'; pending?: RunIntentRecord }>;
export type OnboardingPresentation = Readonly<{ schemaVersion: 1; steps: readonly OnboardingStep[]; completed: number; total: number; snapshot: OnboardingSnapshot }>;
export type OnboardingUi = Readonly<{ locale: Locale; provider(): Promise<void>; instructions(): Promise<void>;
  foreground(stage: SetupStage): Promise<Readonly<{ status: string; code?: string }>> }>;
export const intentCommand = (intent: FirstTaskIntent): BrainPlanCommand => ({ schemaVersion: 1, commandId: intent.commandId, scopeId: intent.scopeId, intent: intent.intent });
