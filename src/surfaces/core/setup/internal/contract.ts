import type { ConfigLoadOptions } from '#platform/index.js';
import type { ModelCatalogQuery } from '#domain/index.js';
import type { IdentityProfileListing, ModelCatalogInspection, ProjectInstructionPort, SetupObservation, SetupStage, SetupStageRegistry } from '#engine/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { CliCardIo } from '#surfaces/core/cli-human/index.js';

/** What applying one stage did. `not-wired`: this build has no apply owner for the stage yet (I-S3 wires each operation to its existing
 * owner); nothing was written. A surface never reports a stage as done from an apply result, only from the next observation. */
export type SetupApplyResult = Readonly<{ stage: string; operation: string; status: 'not-wired' | 'applied' | 'refused'; code?: string }>;
/** `scopeId`: the folder stage's answer, else the configured scope. `foreground`: the person's terminal is free (no window holds it), so an
 * owner that takes the terminal itself (a card, a picker, sudo's own prompt) may run; without it such a stage is refused, never half-run. */
export type SetupApplyOptions = ConfigLoadOptions & Readonly<{ scopeId?: string; foreground?: boolean }>;
/** One stage's operation through its existing owner, after that owner's own preview (I-S3). */
export type SetupApplyHandler = (root: string, stage: SetupStage, options: SetupApplyOptions) => Promise<SetupApplyResult>;
/** `person`: a person on a real terminal answers this plan (the window); only then may a family offer a host install (I-D2). */
export type SetupObserveOptions = ConfigLoadOptions & Readonly<{ person?: boolean; language?: string }>;
/** Read-only observation and the stage registry for one root (I-S2/I-S3 detection). */
export type SetupObserveHandler = (root: string, options: SetupObserveOptions) => Promise<Readonly<{ observation: SetupObservation; registry: SetupStageRegistry }>>;

/** The shell realm doctor reports (structural: only the fields setup reads). */
export type SetupShellRealmView = Readonly<{ selected: string | null; rejected: readonly Readonly<{ restricted: boolean }>[];
  selfTest?: Readonly<{ status: 'ok' | 'failed' | 'not-run' }> }>;

/**
 * `deckent init` (bare) gets the CLI context. `observeSetup` and `applySetupStage` are the I-S3 seam: until they are wired, observation
 * reads only the existing read-only handlers below, and every apply answers `not-wired`.
 */
export interface SetupCommandContext extends CliBaseContext {
  observeSetup?: SetupObserveHandler;
  applySetupStage?: SetupApplyHandler;
  inspectPolicyTemplate?: (root: string, options: ConfigLoadOptions) => Promise<{ readonly id: string; readonly version: number } | null>;
  inspectShellRealm?: (root: string, options: ConfigLoadOptions) => Promise<SetupShellRealmView>;
  listIdentityProfiles?: (packages: readonly unknown[]) => IdentityProfileListing;
  openProjectInstructions?: (root: string, options: ConfigLoadOptions) => Promise<ProjectInstructionPort>;
  /** I-D2 (composition/core/setup): the person's foreground Docker install; `present|printed|declined|succeeded|failed|uncertain`. */
  installExecutionEnvironment?: (root: string, scopeId: string, io: CliCardIo) => Promise<string>;
  /** The first-run policy upgrade (`init policy --upgrade`): preview (`apply: false`) gives `expect`; the apply needs the terminal witness. */
  upgradePolicyTemplateInstallation?: (root: string, scopeId: string, apply: boolean, expect?: string) => Promise<Readonly<{ status: string; expect?: string | null;
    rules?: readonly unknown[] }>>;
  inspectModelCatalog?: (root: string, query: ModelCatalogQuery, options: ConfigLoadOptions) => Promise<ModelCatalogInspection>;
  configChoiceSources?: (root: string, options: ConfigLoadOptions) => { list(source: 'scopes', keyPath: string): Promise<readonly { readonly value: unknown }[]> };
}

/** The default apply port until I-S3: it records nothing anywhere and answers `not-wired` for every stage. */
export const notWiredApply: SetupApplyHandler = async (_root, stage) => Object.freeze({ stage: stage.id, operation: stage.operation?.id ?? '-', status: 'not-wired' });
