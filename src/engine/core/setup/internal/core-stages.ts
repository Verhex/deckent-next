import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { LOCALES, ErrorRegistry, type MessageKey } from '#platform/index.js';
import { setupProfileRefSchema, type CoreSetupStageId, type SetupDecision, type SetupObservationFacts, type SetupStageState } from './contract.js';

/** Inputs every Core evaluator reads; `states` holds the states decided so far (stage order). */
export type CoreStageInput = Readonly<{ facts: SetupObservationFacts; answers: Readonly<Record<string, unknown>>; scopeId: string | null;
  states: ReadonlyMap<string, SetupStageState> }>;
export type CoreStageResult = Readonly<{ decision: SetupDecision; autoEligible: boolean }>;
type Reason = Extract<MessageKey, `setup.reason.${string}`>;
type Question = Extract<MessageKey, `setup.question.${string}`>;
export const CORE_STAGE_TITLES: Readonly<Record<CoreSetupStageId, Extract<MessageKey, `setup.stage.${string}`>>> = Object.freeze({
  'core:environment': 'setup.stage.environment', 'core:language': 'setup.stage.language', 'core:folder': 'setup.stage.folder',
  'core:profile': 'setup.stage.profile', 'core:policy': 'setup.stage.policy', 'core:sandbox': 'setup.stage.sandbox',
  'core:model': 'setup.stage.model', 'core:final-check': 'setup.stage.finalCheck' });

const SOLO = 'core:solo';
const reason = (code: Reason, params: Record<string, string | number> = {}) => ({ code, params });
const question = (key: Question, params: Record<string, string | number> = {}) => ({ key, params });
const result = (decision: SetupDecision, autoEligible = false): CoreStageResult => ({ decision, autoEligible });
const settled = (state: SetupStageState | undefined) => state === 'done' || state === 'skipped';
/** The installation exists once a policy is in place (current, older template or hand-built); later stages read this fact,
 * not the policy stage's state, because the language and profile stages come before it in the plan. */
const installed = (facts: SetupObservationFacts) => ['current', 'upgradable', 'hand-built'].includes(facts.policy.state);
const waits = (stage: CoreSetupStageId) => result({ state: 'blocked', reason: reason('setup.reason.waitsFor', { stage }) });
function answer<T>(input: CoreStageInput, stage: CoreSetupStageId, schema: z.ZodType<T>): T | undefined {
  const value = input.answers[stage];
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw ErrorRegistry.createError('SETUP_ANSWER_INVALID', { params: { stage } });
  return parsed.data;
}

function environment({ facts }: CoreStageInput): CoreStageResult {
  const { platform, node } = facts.environment;
  if (platform !== 'linux' && platform !== 'wsl') return result({ state: 'unsupported', reason: reason('setup.reason.platformUnsupported', { platform }) });
  return result({ state: 'done', reason: reason(node === 'supported' ? 'setup.reason.environmentReady' : 'setup.reason.nodeBelowFloor', { platform }) });
}
function language(input: CoreStageInput): CoreStageResult {
  const { configured, requested, system } = input.facts.language;
  if (configured) return result({ state: 'done', reason: reason('setup.reason.languageConfigured', { language: configured }) });
  const detected = requested ?? system ?? 'en', chosen = answer(input, 'core:language', z.enum(LOCALES));
  if (chosen === undefined) return result({ state: 'needs-answer', reason: reason('setup.reason.languageDetected', { language: detected }),
    question: question('setup.question.language', { language: detected }), default: detected }, true);
  // The language is persisted through the config application once the installation exists (after the policy stage).
  if (!installed(input.facts)) return result({ ...waits('core:policy').decision, default: chosen }, true);
  return result({ state: 'ready', reason: reason('setup.reason.languageChosen', { language: chosen }), default: chosen,
    operation: { id: 'config.set', version: 1, input: { keyPath: 'language', value: chosen, layer: 'project' } },
    cli: ['deckent', 'config', 'set', 'language', chosen] }, true);
}
function folder(input: CoreStageInput): CoreStageResult {
  const { configuredScope, suggestedScope, homeRoot } = input.facts.folder;
  if (configuredScope) return result({ state: 'done', reason: reason('setup.reason.scopeConfigured', { scope: configuredScope }) });
  const chosen = answer(input, 'core:folder', identitySchema);
  if (chosen !== undefined) return result({ state: 'done', reason: reason('setup.reason.scopeChosen', { scope: chosen }), default: chosen });
  // The scope is never derived silently: a suggestion is only a default for a human answer (D5: `--yes` needs `--scope`).
  return result({ state: 'needs-answer', reason: reason(homeRoot ? 'setup.reason.homeRoot' : 'setup.reason.scopeRequired'),
    question: question('setup.question.folder', { scope: suggestedScope ?? '' }), default: suggestedScope });
}
function profile(input: CoreStageInput): CoreStageResult {
  const { available, selected } = input.facts.profile, solo = available.find(entry => entry.id === SOLO) ?? null;
  // A saved selection is observed, never asked or written again (SOLO-PROFILE, owner 2026-10-20).
  if (selected) return result({ state: 'done', reason: reason('setup.reason.profileConfigured', { profile: selected.id }) });
  const chosen = answer(input, 'core:profile', setupProfileRefSchema);
  if (chosen === undefined) return result({ state: 'needs-answer', reason: reason('setup.reason.profileChoice'), question: question('setup.question.profile'), default: solo });
  if (!available.some(entry => entry.id === chosen.id && entry.version === chosen.version)) throw ErrorRegistry.createError('SETUP_ANSWER_INVALID', { params: { stage: 'core:profile' } });
  if (!input.scopeId || !installed(input.facts)) return result({ ...waits(input.scopeId ? 'core:policy' : 'core:folder').decision, default: chosen });
  return result({ state: 'ready', reason: reason('setup.reason.profileChosen', { profile: chosen.id }), default: chosen,
    operation: { id: 'identity-profile.preview', version: 1, input: { scopeId: input.scopeId, profile: chosen } },
    cli: ['deckent', 'identity', 'preview', '--profile', chosen.id, '--profile-version', String(chosen.version), '--scope', input.scopeId] });
}
function policy(input: CoreStageInput): CoreStageResult {
  const state = input.facts.policy.state, scopeId = input.scopeId;
  if (state === 'current') return result({ state: 'done', reason: reason('setup.reason.policyCurrent') });
  if (state === 'hand-built') return result({ state: 'skipped', reason: reason('setup.reason.policyHandBuilt') });
  if (state === 'conflict') return result({ state: 'blocked', reason: reason('setup.reason.policyConflict') });
  if (!scopeId) return waits('core:folder');
  const chosen = answer(input, 'core:policy', z.boolean());
  if (chosen === false) return result({ state: 'skipped', reason: reason('setup.reason.declined') });
  if (state === 'upgradable') {
    const operation = { id: 'installation.policy-upgrade', version: 1, input: { scopeId } };
    const cli = ['deckent', 'init', 'policy', '--scope', scopeId, '--upgrade', '--preview'];
    // An upgrade is never applied unattended; it needs a human answer after its preview.
    return result(chosen ? { state: 'ready', reason: reason('setup.reason.policyUpgrade'), operation, cli }
      : { state: 'needs-answer', reason: reason('setup.reason.policyUpgrade'), question: question('setup.question.policyUpgrade'), default: false, operation, cli });
  }
  const fresh = state === 'absent', code = fresh ? 'setup.reason.policyFresh' : 'setup.reason.policyPending';
  const operation = { id: 'installation.policy-template', version: 1, input: { scopeId } }, cli = ['deckent', 'init', 'policy', '--scope', scopeId, '--apply'];
  // D5: only a fresh first-run policy is eligible for `--yes`; a pending journal is resumed by a human answer.
  return result(chosen ? { state: 'ready', reason: reason(code), operation, cli }
    : { state: 'needs-answer', reason: reason(code), question: question('setup.question.policy'), default: true, operation, cli }, fresh);
}
function sandbox({ facts }: CoreStageInput): CoreStageResult {
  const { realm, selfTest, usernsRestricted } = facts.sandbox;
  if (realm !== 'none' && selfTest === 'ok') return result({ state: 'done', reason: reason('setup.reason.sandboxReady', { realm }) });
  if (realm !== 'none' && selfTest === 'not-run') return result({ state: 'ready', reason: reason('setup.reason.sandboxUnchecked', { realm }),
    operation: { id: 'shell-realm.inspect', version: 1, input: {} }, cli: ['deckent', 'doctor'] });
  // Chat and read-only tools stay available; only approved edits and shell commands need the sandbox.
  return result({ state: 'blocked', reason: reason(usernsRestricted ? 'setup.reason.usernsRestricted' : 'setup.reason.sandboxUnavailable'), cli: ['deckent', 'doctor'] });
}
const connection = z.object({ connection: identitySchema, model: identitySchema }).strict();
function model(input: CoreStageInput): CoreStageResult {
  const connections = input.facts.model.connections;
  if (connections > 0) return result({ state: 'done', reason: reason('setup.reason.modelConnected', { count: connections }) });
  if (!input.scopeId || !installed(input.facts)) return waits(input.scopeId ? 'core:policy' : 'core:folder');
  const chosen = answer(input, 'core:model', connection), scopeId = input.scopeId;
  const cli = ['deckent', 'models', 'connect', '--scope', scopeId, '--connection', chosen?.connection ?? '<connection>', '--model', chosen?.model ?? '<model>', '--command-id', '<command-id>'];
  // The key itself never enters the plan: the connection names a secret that is set through the hidden prompt or stdin.
  if (!chosen) return result({ state: 'needs-answer', reason: reason('setup.reason.modelMissing'), question: question('setup.question.model'), cli });
  return result({ state: 'ready', reason: reason('setup.reason.modelChosen', { model: chosen.model }), default: chosen, cli,
    operation: { id: 'model.connect', version: 1, input: { scopeId, connection: chosen.connection, model: chosen.model } } });
}
function finalCheck(input: CoreStageInput): CoreStageResult {
  const check = input.facts.check.state, others = [...input.states.values()];
  if (check === 'ok' && others.every(settled)) return result({ state: 'done', reason: reason('setup.reason.checkPassed') }, true);
  const code = check === 'warnings' ? 'setup.reason.checkWarnings' : check === 'errors' ? 'setup.reason.checkErrors' : 'setup.reason.checkReady';
  // Read-only: the final check never heals configuration.
  return result({ state: 'ready', reason: reason(code), operation: { id: 'doctor.inspect', version: 1, input: { heal: false } },
    cli: ['deckent', 'doctor', '--json'] }, true);
}
export const CORE_STAGE_EVALUATORS: Readonly<Record<CoreSetupStageId, (input: CoreStageInput) => CoreStageResult>> = Object.freeze({
  'core:environment': environment, 'core:language': language, 'core:folder': folder, 'core:profile': profile,
  'core:policy': policy, 'core:sandbox': sandbox, 'core:model': model, 'core:final-check': finalCheck });
