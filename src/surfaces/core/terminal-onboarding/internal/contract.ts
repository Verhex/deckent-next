import type { BrainPlanCommand } from '#domain/index.js';
import type { SetupPlan, SetupStage, SetupObservation, RunIntentRecord, RunPlanningResult } from '#engine/index.js';
import type { Locale } from '#platform/index.js';
export type FolderFacts = Readonly<{ kind: 'coding' | 'documents' | 'empty' | 'unknown'; readme: boolean; tests: boolean }>;
export type FirstTaskIntent = Readonly<{ commandId: string; scopeId: string; folder: string; intent: string; pending?: RunIntentRecord }>;
export type OnboardingConfigBasis = Readonly<{ projectDigest: string | null; globalDigest: string }>;
export type OnboardingSnapshot = Readonly<{ configBasis: OnboardingConfigBasis; plan: SetupPlan; observation: SetupObservation; answers: Readonly<Record<string, unknown>>;
  deferred: readonly string[]; modelUsable: boolean; folder: string; folderFacts: FolderFacts; scopeId: string;
  hosts: readonly Readonly<{ id: string; cli: string; login: string }>[];
  budget: Readonly<{ needed: boolean; presetUsd: number; presetsUsd: readonly number[]; currentUsd: number | null; reason?: string }>;
  permissions: Readonly<{ state: 'applied' | 'needed' | 'unavailable'; reason: string }>;
  ready?: Readonly<{ provider: string | null; imageId: string | null; fallbackBefore: string | null; fallbackAfter: string | null }>;
  pending: readonly RunIntentRecord[] }>;
export interface OnboardingPort {
  observe(answers: Readonly<Record<string, unknown>>): Promise<OnboardingSnapshot>;
  assertPerson(): Promise<void>;
  defer(stageId: string, planDigest: string): Promise<void>;
  apply(stage: SetupStage, basis: OnboardingConfigBasis): Promise<Readonly<{ status: string; code?: string }>>;
  previewConsent(provider: string): Promise<Readonly<{ digest: string; providers: readonly string[]; sources: readonly string[]; proxy: string | null;
    baseRef: string; recipeDigest: string; sizeGigabytes: number; buildTimeoutMs: number }>>;
  consent(provider: string, digest: string): Promise<void>;
  budget(usd: number): Promise<void>;
  /** U5 alone owns this operation; an absent carrier is unavailable, never an implicit grant. */
  permissions?(): Promise<void>;
  reconcile(intent: RunIntentRecord): Promise<RunIntentRecord>;
  start(intent: RunIntentRecord, signal?: AbortSignal): Promise<RunPlanningResult>;
  cancel(intent: RunIntentRecord): Promise<void>;
}
export type OnboardingStep = Readonly<{ id: string; stages: readonly SetupStage[]; kind: 'stage' | 'work' | 'ready' | 'budget' | 'permissions' | 'first-task' | 'parked'; pending?: RunIntentRecord }>;
export type OnboardingPresentation = Readonly<{ schemaVersion: 1; steps: readonly OnboardingStep[]; completed: number; total: number; snapshot: OnboardingSnapshot }>;
export type OnboardingUi = Readonly<{ locale: Locale; provider(): Promise<void>; instructions(): Promise<void>;
  foreground(stage: SetupStage): Promise<Readonly<{ status: string; code?: string }>> }>;
export const intentCommand = (intent: FirstTaskIntent): BrainPlanCommand => ({ schemaVersion: 1, commandId: intent.commandId, scopeId: intent.scopeId, intent: intent.intent });
