import { ErrorRegistry, sha256 } from '#platform/index.js';
import { CORE_SETUP_STAGES, SETUP_PLAN_SCHEMA_VERSION, setupFamilyPackageSchema, type CoreSetupStageId, type SetupFamilyPackage, type SetupStageContext,
  type SetupDecision } from './contract.js';
import { canonicalSetupJson } from './canonical.js';
import limits from './limits.json' with { type: 'json' };

export type SetupFamilyStage = Readonly<{ id: string; namespace: string; after: CoreSetupStageId; title: string;
  evaluate: (context: SetupStageContext) => SetupDecision }>;
export type SetupFamilyEntry = Readonly<{ namespace: string; source: string; parseFacts: (value: unknown) => unknown; stages: readonly SetupFamilyStage[] }>;

/** Immutable stage registry. Core holds the generic stages; adapter families (execution environment, source control, Enterprise,
 * business systems) add stages and facts under their own namespace and never replace Core or another family (as identity profiles). */
export class SetupStageRegistry {
  readonly digest: string;
  private readonly families: readonly SetupFamilyEntry[];
  constructor(packages: readonly SetupFamilyPackage[] = []) {
    if (packages.length > limits.maxFamilies) throw ErrorRegistry.createError('SETUP_STAGE_INVALID');
    const families: SetupFamilyEntry[] = [];
    for (const input of packages) {
      const parsed = setupFamilyPackageSchema.safeParse(input);
      if (!parsed.success) throw ErrorRegistry.createError('SETUP_STAGE_INVALID');
      const value = parsed.data;
      if (value.namespace === 'core' || families.some(family => family.namespace === value.namespace)) throw ErrorRegistry.createError('SETUP_STAGE_SHADOW');
      const ids = new Set<string>();
      for (const stage of value.stages) {
        if (stage.id.split(':')[0] !== value.namespace) throw ErrorRegistry.createError('SETUP_STAGE_INVALID');
        if (ids.has(stage.id)) throw ErrorRegistry.createError('SETUP_STAGE_SHADOW');
        ids.add(stage.id);
      }
      const facts = value.facts;
      families.push(Object.freeze({ namespace: value.namespace, source: value.source, parseFacts: (input: unknown) => facts.parse(input),
        stages: Object.freeze(value.stages.map(stage => Object.freeze({ id: stage.id, namespace: value.namespace, after: stage.after, title: stage.title, evaluate: stage.evaluate }))) }));
    }
    // Registration order never changes the plan: families sort by namespace, stages by (anchor, id).
    this.families = Object.freeze(families.sort((a, b) => a.namespace < b.namespace ? -1 : 1));
    this.digest = sha256(canonicalSetupJson({ schemaVersion: SETUP_PLAN_SCHEMA_VERSION, core: CORE_SETUP_STAGES,
      families: this.families.map(family => ({ namespace: family.namespace, source: family.source,
        stages: family.stages.map(stage => ({ id: stage.id, after: stage.after, title: stage.title })) })) }));
    Object.freeze(this);
  }
  list(): readonly SetupFamilyEntry[] { return this.families; }
  family(namespace: string): SetupFamilyEntry | undefined { return this.families.find(family => family.namespace === namespace); }
  /** Core stages in order, each followed by the family stages anchored after it; the final check always closes the plan. */
  order(): readonly (CoreSetupStageId | SetupFamilyStage)[] {
    const anchored = this.families.flatMap(family => family.stages).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return CORE_SETUP_STAGES.flatMap((core): (CoreSetupStageId | SetupFamilyStage)[] => [core, ...anchored.filter(stage => stage.after === core)]);
  }
}
