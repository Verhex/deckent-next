import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { ErrorRegistry, sha256 } from '#platform/index.js';
import { CORE_SETUP_STAGES, SETUP_PHASES, SETUP_PLAN_SCHEMA_VERSION, setupFamilyPackageSchema, type CoreSetupStageId, type SetupFamilyPackage, type SetupPhase,
  type SetupStageContext, type SetupDecision } from './contract.js';
import { canonicalSetupJson } from './canonical.js';
import limits from './limits.json' with { type: 'json' };
import stageTable from './stages.json' with { type: 'json' };

/** The stage table (U3-1a registry data): every Core stage has its phase; a family stage's row wins over its descriptor and its anchor. */
const STAGE_TABLE = z.object({ $comment: z.string().optional(), schemaVersion: z.literal(1), unattendedProfile: identitySchema,
  unattendedFamilyStages: z.array(z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/)).refine(ids => new Set(ids).size === ids.length),
  order: z.array(z.string()).refine(ids => new Set(ids).size === ids.length && CORE_SETUP_STAGES.every(id => ids.includes(id))),
  phases: z.record(z.string(), z.enum(SETUP_PHASES)).refine(phases => CORE_SETUP_STAGES.every(stage => phases[stage] !== undefined)) }).strict().parse(stageTable);

export type SetupFamilyStage = Readonly<{ id: string; namespace: string; after: CoreSetupStageId; title: string; phase: SetupPhase;
  evaluate: (context: SetupStageContext) => SetupDecision }>;
export type SetupFamilyEntry = Readonly<{ namespace: string; source: string; parseFacts: (value: unknown) => unknown; stages: readonly SetupFamilyStage[] }>;

/** Immutable stage registry. Core holds the generic stages; adapter families (execution environment, source control, Enterprise,
 * business systems) add stages and facts under their own namespace and never replace Core or another family (as identity profiles). */
export class SetupStageRegistry {
  readonly digest: string;
  /** The identity profile a call without a person answers with, and the first one offered to a person (stage table data, never a literal). */
  readonly unattendedProfile: string;
  private readonly families: readonly SetupFamilyEntry[];
  constructor(packages: readonly SetupFamilyPackage[] = [], options: Readonly<{ unattendedProfile?: string }> = {}) {
    this.unattendedProfile = identitySchema.parse(options.unattendedProfile ?? STAGE_TABLE.unattendedProfile);
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
        stages: Object.freeze(value.stages.map(stage => Object.freeze({ id: stage.id, namespace: value.namespace, after: stage.after, title: stage.title,
          // The stage table's row (Core's contract for the stages it knows), else the descriptor's own phase, else the anchor's phase.
          phase: STAGE_TABLE.phases[stage.id] ?? stage.phase ?? STAGE_TABLE.phases[stage.after]!, evaluate: stage.evaluate }))) }));
    }
    // Registration order never changes the plan: families sort by namespace, stages by (anchor, id).
    this.families = Object.freeze(families.sort((a, b) => a.namespace < b.namespace ? -1 : 1));
    this.digest = sha256(canonicalSetupJson({ schemaVersion: SETUP_PLAN_SCHEMA_VERSION, core: CORE_SETUP_STAGES.map(id => ({ id, phase: STAGE_TABLE.phases[id] })),
      table: STAGE_TABLE, unattendedProfile: this.unattendedProfile, families: this.families.map(family => ({ namespace: family.namespace, source: family.source,
        stages: family.stages.map(stage => ({ id: stage.id, after: stage.after, title: stage.title, phase: stage.phase })) })) }));
    Object.freeze(this);
  }
  list(): readonly SetupFamilyEntry[] { return this.families; }
  family(namespace: string): SetupFamilyEntry | undefined { return this.families.find(family => family.namespace === namespace); }
  /** A Core stage's phase from the stage table. */
  corePhase(stage: CoreSetupStageId): SetupPhase { return STAGE_TABLE.phases[stage]!; }
  /** Eligibility only: each registered owner still enforces its witness, policy and profile guards. */
  unattendedFamilyStage(stage: string): boolean { return STAGE_TABLE.unattendedFamilyStages.includes(stage); }
  /** Installation table order, then onboarding anchor order; final-check sees every install stage before it settles. */
  order(): readonly (CoreSetupStageId | SetupFamilyStage)[] {
    const entries: (CoreSetupStageId | SetupFamilyStage)[] = [...CORE_SETUP_STAGES, ...this.families.flatMap(family => family.stages)];
    const id = (entry: typeof entries[number]) => typeof entry === 'string' ? entry : entry.id;
    const phase = (entry: typeof entries[number]) => typeof entry === 'string' ? this.corePhase(entry) : entry.phase;
    const rank = (entry: typeof entries[number]): number => {
      const listed = STAGE_TABLE.order.indexOf(id(entry));
      if (listed >= 0) return listed;
      if (typeof entry === 'string') return STAGE_TABLE.order.length;
      // Unlisted family stages follow the listed stages of their anchor in the same phase.
      const anchored = entries.filter(other => typeof other !== 'string' && other.after === entry.after && phase(other) === phase(entry));
      return Math.max(STAGE_TABLE.order.indexOf(entry.after), ...anchored.map(other => STAGE_TABLE.order.indexOf(id(other))));
    };
    return entries.sort((a, b) => Number(phase(a) === 'onboarding') - Number(phase(b) === 'onboarding') || Number(a === 'core:final-check') - Number(b === 'core:final-check') || rank(a) - rank(b) || Number(!STAGE_TABLE.order.includes(id(a))) - Number(!STAGE_TABLE.order.includes(id(b))) || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));
  }
}
