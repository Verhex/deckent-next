import { ErrorRegistry, sha256 } from '#platform/index.js';
import { identitySchema } from '#domain/index.js';
import { SETUP_PLAN_SCHEMA_VERSION, setupAnswersSchema, setupDecisionSchema, setupObservationSchema, type SetupAnswers, type SetupObservation, type SetupPhase,
  type SetupPlan, type SetupStage, type SetupStageState } from './contract.js';
import { CORE_STAGE_EVALUATORS, CORE_STAGE_TITLES } from './core-stages.js';
import { SetupStageRegistry } from './registry.js';
import { canonicalSetupJson } from './canonical.js';

const freezeStage = (stage: SetupStage): SetupStage => Object.freeze(stage);
/** Pure, deterministic setup plan: the same observation, answers and registry give the same stages and `planDigest`.
 * It applies nothing; every `operation` names an existing owner that a surface calls after its own preview and confirmation.
 * `phase` (U3-1a): every stage is evaluated (an onboarding stage may wait for an install stage), only that phase's stages are returned, and an
 * answer to a stage of the other phase is refused (SETUP_STAGE_NOT_IN_PHASE), never ignored. */
export function planSetup(observation: SetupObservation, answers: SetupAnswers = { schemaVersion: SETUP_PLAN_SCHEMA_VERSION, values: {} },
  registry: SetupStageRegistry = new SetupStageRegistry(), options: Readonly<{ phase?: SetupPhase; attestedPerson?: boolean }> = {}): SetupPlan {
  const observed = setupObservationSchema.safeParse(observation);
  if (!observed.success) throw ErrorRegistry.createError('SETUP_OBSERVATION_INVALID');
  const given = setupAnswersSchema.safeParse(answers);
  if (!given.success) throw ErrorRegistry.createError('SETUP_ANSWER_INVALID');
  const facts = observed.data, values = given.data.values, order = registry.order();
  const known = new Set(order.map(entry => typeof entry === 'string' ? entry : entry.id));
  if (Object.keys(values).some(stage => !known.has(stage))) throw ErrorRegistry.createError('SETUP_ANSWER_INVALID');
  if (Object.keys(facts.families).some(namespace => !registry.family(namespace))) throw ErrorRegistry.createError('SETUP_FAMILY_UNKNOWN');
  const familyFacts = new Map(registry.list().map(family => {
    try { return [family.namespace, family.parseFacts(facts.families[family.namespace])] as const; }
    catch { throw ErrorRegistry.createError('SETUP_OBSERVATION_INVALID', { params: { family: family.namespace } }); }
  }));
  const folderAnswer = identitySchema.safeParse(values['core:folder']);
  const scopeId = facts.folder.configuredScope ?? (folderAnswer.success ? folderAnswer.data : null);
  const phaseOf = (entry: typeof order[number]) => typeof entry === 'string' ? registry.corePhase(entry) : entry.phase;
  const phases = new Map(order.map(entry => [typeof entry === 'string' ? entry : entry.id, phaseOf(entry)] as const));
  const foreign = options.phase === undefined ? undefined : Object.keys(values).find(stage => phases.get(stage) !== options.phase);
  if (foreign) throw ErrorRegistry.createError('SETUP_STAGE_NOT_IN_PHASE', { params: { stage: foreign } });
  const states = new Map<string, SetupStageState>(), prior = new Map<string, unknown>(), stages: SetupStage[] = [];
  const unsupported = facts.environment.platform !== 'linux' && facts.environment.platform !== 'wsl';
  for (const entry of order) {
    const core = typeof entry === 'string', id = core ? entry : entry.id, namespace = core ? 'core' : entry.namespace;
    const title = core ? CORE_STAGE_TITLES[entry] : entry.title, phase = phaseOf(entry);
    if (unsupported && id !== 'core:environment') {
      // An unsupported platform writes nothing: every later stage reports the platform, with no operation or command.
      states.set(id, 'unsupported');
      stages.push(freezeStage({ id, namespace, title, phase, state: 'unsupported', reason: { code: 'setup.reason.platformBlocked', params: {} },
        operation: null, question: null, default: null, cli: null, autoEligible: false }));
      continue;
    }
    let decision: unknown, autoEligible = false;
    if (core) ({ decision, autoEligible } = CORE_STAGE_EVALUATORS[entry]({ facts, answers: values, scopeId, states, phases,
      unattendedProfile: registry.unattendedProfile }));
    else {
      try { decision = entry.evaluate(Object.freeze({ facts: familyFacts.get(namespace), answer: values[id], scopeId, states: new Map(states), prior: new Map(prior) })); }
      catch { throw ErrorRegistry.createError('SETUP_STAGE_INVALID', { params: { stage: id } }); }
    }
    const parsed = setupDecisionSchema.safeParse(decision);
    if (!parsed.success) throw ErrorRegistry.createError('SETUP_STAGE_INVALID', { params: { stage: id } });
    const value = parsed.data;
    // A family's message keys stay inside its own namespace. Only table-allowlisted families may be auto-eligible for an attested person;
    // this planning hint grants no authority and never replaces the operation owner's witness and policy checks.
    const owned = (key: string) => core || key.startsWith(`${namespace}.`) || key.startsWith(`setup.${namespace}.`);
    if (!owned(value.reason.code) || value.question && !owned(value.question.key)) throw ErrorRegistry.createError('SETUP_STAGE_INVALID', { params: { stage: id } });
    if (values[id] !== undefined && (value.state === 'done' || value.state === 'ready')) prior.set(id, values[id]);
    states.set(id, value.state);
    stages.push(freezeStage({ id, namespace, title, phase, state: value.state, reason: Object.freeze({ code: value.reason.code, params: Object.freeze(value.reason.params) }),
      operation: value.operation, question: value.question ? Object.freeze({ key: value.question.key, params: Object.freeze(value.question.params) }) : null,
      default: value.default, cli: value.cli ? Object.freeze([...value.cli]) : null,
      autoEligible: core ? autoEligible : options.attestedPerson === true && registry.unattendedFamilyStage(id) }));
  }
  const shown = options.phase === undefined ? stages : stages.filter(stage => stage.phase === options.phase);
  const body = { schemaVersion: SETUP_PLAN_SCHEMA_VERSION, registryDigest: registry.digest, stages: Object.freeze(shown) };
  return Object.freeze({ ...body, planDigest: sha256(canonicalSetupJson(body)) });
}
