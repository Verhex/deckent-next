import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_SETUP_STAGES, SETUP_PLAN_SCHEMA_VERSION, SetupStageRegistry, planSetup, setupObservationSchema, type SetupFamilyPackage, type SetupObservation } from '#engine/index.js';
import { MESSAGE_KEYS } from '#platform/index.js';

const base: SetupObservation = { schemaVersion: 2,
  environment: { platform: 'linux', node: 'supported' }, language: { configured: null, requested: null, system: 'tr' },
  folder: { installation: 'none', homeRoot: false, configuredScope: null, suggestedScope: 'my-erp' },
  profile: { available: [{ id: 'core:solo', version: 1 }, { id: 'core:team', version: 1 }] }, policy: { state: 'absent' },
  sandbox: { realm: 'bubblewrap', selfTest: 'ok', usernsRestricted: false }, model: { connections: 0 }, check: { state: 'not-run' }, families: {} };
const observe = (change: Partial<SetupObservation> = {}): SetupObservation => ({ ...base, ...change });
const answers = (values: Record<string, unknown>) => ({ schemaVersion: 2 as const, values });
const byId = (plan: ReturnType<typeof planSetup>) => new Map(plan.stages.map(stage => [stage.id, stage]));
/** Test-only family: an execution-environment registration anchored after the sandbox stage. */
function family(namespace: string, after: 'core:sandbox' | 'core:model' = 'core:sandbox', evaluate: SetupFamilyPackage['stages'][number]['evaluate'] = context => ({
  state: (context.facts as { ready: boolean }).ready ? 'done' : 'needs-answer', reason: { code: `${namespace}.reason.runtime`, params: {} } })): SetupFamilyPackage {
  return { namespace, source: 'test', facts: z.object({ ready: z.boolean() }).strict().default({ ready: false }),
    stages: [{ id: `${namespace}:runtime`, after, title: `${namespace}.stage.runtime`, evaluate }] };
}
async function code(work: () => unknown) { try { work(); } catch (error) { return (error as { code?: string }).code; } return 'no-error'; }

describe('I-S1 setup planner', () => {
  it('fresh Linux folder: Core stages in order with typed states, exact commands and no derived scope', () => {
    const plan = planSetup(observe()), stages = byId(plan);
    expect(plan.stages.map(stage => stage.id)).toEqual(['core:language', 'core:environment', ...CORE_SETUP_STAGES.slice(2, 6), 'core:final-check', 'core:model']);
    expect(plan.stages.map(stage => [stage.id, stage.state])).toEqual([['core:language', 'needs-answer'], ['core:environment', 'done'], ['core:folder', 'needs-answer'],
      ['core:profile', 'needs-answer'], ['core:policy', 'blocked'], ['core:sandbox', 'done'], ['core:final-check', 'ready'], ['core:model', 'blocked']]);
    expect(stages.get('core:language')).toMatchObject({ default: 'tr', question: { key: 'setup.question.language', params: { language: 'tr' } } });
    expect(stages.get('core:folder')).toMatchObject({ default: 'my-erp', autoEligible: false, operation: null });
    expect(stages.get('core:policy')!.reason).toEqual({ code: 'setup.reason.waitsFor', params: { stage: 'core:folder' } });
    expect(stages.get('core:final-check')).toMatchObject({ operation: { id: 'doctor.inspect', input: { heal: false } }, cli: ['deckent', 'doctor', '--json'] });
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('with an explicit scope and profile the fresh policy is ready; the language is answered until it can be saved', () => {
    const plan = byId(planSetup(observe(), answers({ 'core:folder': 'my-erp', 'core:language': 'tr', 'core:profile': { id: 'core:solo', version: 1 } })));
    expect(plan.get('core:policy')).toMatchObject({ state: 'needs-answer', default: true, autoEligible: true,
      operation: { id: 'installation.policy-template', version: 1, input: { scopeId: 'my-erp' } }, cli: ['deckent', 'init', 'policy', '--scope', 'my-erp', '--apply'] });
    expect(plan.get('core:language')).toMatchObject({ state: 'ready', reason: { code: 'setup.reason.languageSavedAfterPolicy', params: { language: 'tr' } }, operation: null });
    const installed = byId(planSetup(observe({ policy: { state: 'current' }, folder: { ...base.folder, configuredScope: 'my-erp' } }), answers({ 'core:language': 'tr' })));
    expect(installed.get('core:language')).toMatchObject({ state: 'ready', operation: { id: 'config.set', input: { keyPath: 'language', value: 'tr' } }, cli: ['deckent', 'config', 'set', 'language', 'tr'] });
    expect(installed.get('core:model')).toMatchObject({ state: 'needs-answer', autoEligible: false });
  });

  it('D5: only the fresh policy, the language and the final check are eligible for --yes; upgrade and resume never are', async () => {
    const eligible = (change: Partial<SetupObservation>) => planSetup(observe(change), answers({ 'core:language': 'en', 'core:folder': 's', 'core:profile': { id: 'core:solo', version: 1 } })).stages.filter(stage => stage.autoEligible).map(stage => stage.id);
    expect(eligible({})).toEqual(['core:language', 'core:policy', 'core:final-check']);
    expect(eligible({ policy: { state: 'upgradable' } })).toEqual(['core:language', 'core:final-check']);
    expect(eligible({ policy: { state: 'pending' } })).toEqual(['core:language', 'core:final-check']);
    const upgrade = byId(planSetup(observe({ policy: { state: 'upgradable' } }), answers({ 'core:language': 'en', 'core:folder': 's', 'core:profile': { id: 'core:solo', version: 1 } }))).get('core:policy')!;
    expect(upgrade).toMatchObject({ state: 'needs-answer', default: false, cli: ['deckent', 'init', 'policy', '--scope', 's', '--upgrade', '--preview'] });
    // A family stage can never mark itself eligible: the decision schema refuses the field.
    const sneaky = new SetupStageRegistry([family('execution', 'core:sandbox', () => ({ state: 'ready', reason: { code: 'execution.reason.x', params: {} }, autoEligible: true }) as never)]);
    expect(await code(() => planSetup(observe(), answers({}), sneaky))).toBe('SETUP_STAGE_INVALID');
    const honest = planSetup(observe(), answers({}), new SetupStageRegistry([family('execution')]));
    expect(honest.stages.find(stage => stage.id === 'execution:runtime')!.autoEligible).toBe(false);
  });

  it('SOLO-PROFILE (owner 2026-10-20): every profile is answered before policy and saved through the same operation after installation', () => {
    for (const id of ['core:solo', 'core:team']) {
      expect(byId(planSetup(observe(), answers({ 'core:language': 'en', 'core:folder': 's', 'core:profile': { id, version: 1 } }))).get('core:profile')!.state, id).toBe('ready');
      const chosen = byId(planSetup(observe({ policy: { state: 'current' } }), answers({ 'core:language': 'en', 'core:folder': 's', 'core:profile': { id, version: 1 } }))).get('core:profile')!;
      expect(chosen, id).toMatchObject({ state: 'ready', autoEligible: false, operation: { id: 'identity-profile.preview', input: { scopeId: 's', profile: { id, version: 1 } } } });
    }
  });

  it('SOLO-PROFILE: a saved profile (any id, also one outside the listed packages) reads done on a re-run and is never asked or written again', () => {
    for (const id of ['core:solo', 'core:team', 'acme.erp:approvers']) {
      const saved = observe({ profile: { ...base.profile, selected: { id, version: 2 } }, policy: { state: 'current' }, folder: { ...base.folder, configuredScope: 's' } });
      for (const given of [answers({}), answers({ 'core:profile': { id: 'core:team', version: 1 } })]) {
        const stage = byId(planSetup(saved, given)).get('core:profile')!;
        expect(stage, id).toMatchObject({ state: 'done', reason: { code: 'setup.reason.profileConfigured', params: { profile: id } }, operation: null, question: null, cli: null });
      }
    }
    expect(byId(planSetup(observe())).get('core:profile')!.state).toBe('needs-answer');
  });

  it('a hand-built or conflicting policy is never rewritten; a declined stage is skipped', () => {
    const scoped = answers({ 'core:language': 'en', 'core:folder': 's', 'core:profile': { id: 'core:solo', version: 1 } });
    expect(byId(planSetup(observe({ policy: { state: 'hand-built' } }), scoped)).get('core:policy')).toMatchObject({ state: 'skipped', operation: null });
    expect(byId(planSetup(observe({ policy: { state: 'conflict' } }), scoped)).get('core:policy')).toMatchObject({ state: 'blocked', operation: null });
    expect(byId(planSetup(observe(), answers({ 'core:language': 'en', 'core:folder': 's', 'core:policy': false, 'core:profile': { id: 'core:solo', version: 1 } }))).get('core:policy')!.state).toBe('skipped');
  });

  it('a finished installation re-plans as done everywhere (resumable by re-observation)', () => {
    const plan = planSetup(observe({ language: { configured: 'tr', requested: null, system: null }, folder: { ...base.folder, installation: 'present', configuredScope: 's' },
      policy: { state: 'current' }, model: { connections: 1 }, check: { state: 'ok' }, profile: { ...base.profile, selected: { id: 'core:solo', version: 1 } } }));
    expect(plan.stages.every(stage => stage.state === 'done')).toBe(true);
  });

  it('native Windows and macOS are unsupported: nothing to apply, no command', () => {
    for (const platform of ['windows', 'macos'] as const) {
      const plan = planSetup(observe({ environment: { platform, node: 'supported' } }), answers({ 'core:folder': 's' }), new SetupStageRegistry([family('execution')]));
      expect(byId(plan).get('core:environment')).toMatchObject({ id: 'core:environment', state: 'unsupported' });
      expect(plan.stages.filter(stage => stage.id !== 'core:environment').every(stage => stage.state === 'unsupported' && stage.operation === null && stage.cli === null && !stage.autoEligible)).toBe(true);
    }
  });

  it('sandbox realms: a missing or restricted realm blocks only that stage', () => {
    const plan = byId(planSetup(observe({ sandbox: { realm: 'none', selfTest: 'not-run', usernsRestricted: true } })));
    expect(plan.get('core:sandbox')).toMatchObject({ state: 'blocked', reason: { code: 'setup.reason.usernsRestricted' }, operation: null });
    expect(plan.get('core:final-check')!.state).toBe('ready');
  });

  it('model answers carry names only; a key in an answer is refused', async () => {
    const installed = observe({ policy: { state: 'current' }, folder: { ...base.folder, configuredScope: 's' } });
    const ready = byId(planSetup(installed, answers({ 'core:model': { connection: 'anthropic-api', model: 'm-1' } }))).get('core:model')!;
    expect(ready).toMatchObject({ state: 'ready', operation: { id: 'model.connect', input: { scopeId: 's', connection: 'anthropic-api', model: 'm-1' } } });
    expect(await code(() => planSetup(installed, answers({ 'core:model': { connection: 'anthropic-api', model: 'm-1', key: 'sk-secret' } })))).toBe('SETUP_ANSWER_INVALID');
  });

  it('digest is deterministic, content-bound and independent of family registration order', () => {
    const a = new SetupStageRegistry([family('execution'), family('source', 'core:model')]), b = new SetupStageRegistry([family('source', 'core:model'), family('execution')]);
    const p1 = planSetup(observe(), answers({ 'core:folder': 's' }), a), p2 = planSetup(observe(), answers({ 'core:folder': 's' }), b);
    expect(a.digest).toBe(b.digest); expect(p1).toEqual(p2); expect(p1.planDigest).toBe(p2.planDigest);
    expect(p1.stages.map(stage => stage.id)).toEqual(['core:language', 'core:environment', 'core:folder', 'core:profile', 'core:policy', 'core:sandbox', 'core:final-check',
      'core:model', 'source:runtime', 'execution:runtime']);
    expect(planSetup(observe(), answers({ 'core:folder': 't' }), a).planDigest).not.toBe(p1.planDigest);
    expect(new SetupStageRegistry().digest).not.toBe(a.digest);
  });

  it('family facts drive family stages, and the final check is done only when every install stage is settled', () => {
    const registry = new SetupStageRegistry([family('execution')]);
    const done = observe({ language: { configured: 'en', requested: null, system: null }, folder: { ...base.folder, configuredScope: 's' }, policy: { state: 'current' },
      model: { connections: 1 }, check: { state: 'ok' }, profile: { ...base.profile, selected: { id: 'core:solo', version: 1 } } });
    const none = answers({});
    expect(byId(planSetup(done, none, registry)).get('core:final-check')!.state).toBe('done');
    // A solo answer that is not saved yet is not settled: the profile is ready to apply, so the final check stays open.
    expect(byId(planSetup({ ...done, profile: base.profile, families: { execution: { ready: true } } }, answers({ 'core:profile': { id: 'core:solo', version: 1 } }), registry))
      .get('core:final-check')!.state).toBe('ready');
    const ready = planSetup({ ...done, families: { execution: { ready: true } } }, none, registry);
    expect(byId(ready).get('execution:runtime')!.state).toBe('done'); expect(byId(ready).get('core:final-check')!.state).toBe('done');
  });

  it('refuses invalid registrations: Core shadowing, duplicate family, foreign stage id, final-check anchor, too many families', async () => {
    expect(await code(() => new SetupStageRegistry([family('core')]))).toBe('SETUP_STAGE_SHADOW');
    expect(await code(() => new SetupStageRegistry([family('execution'), family('execution')]))).toBe('SETUP_STAGE_SHADOW');
    expect(await code(() => new SetupStageRegistry([{ ...family('execution'), stages: [{ ...family('execution').stages[0]!, id: 'other:runtime' }] }]))).toBe('SETUP_STAGE_INVALID');
    expect(await code(() => new SetupStageRegistry([{ ...family('execution'), stages: [{ ...family('execution').stages[0]!, after: 'core:final-check' }] }]))).toBe('SETUP_STAGE_INVALID');
    expect(await code(() => new SetupStageRegistry(Array.from({ length: 65 }, (_, index) => family(`f${index}`))))).toBe('SETUP_STAGE_INVALID');
  });

  it('refuses invalid observations and answers before planning', async () => {
    const registry = new SetupStageRegistry([family('execution')]);
    expect(await code(() => planSetup({ ...observe(), families: { erp: {} } }, answers({}), registry))).toBe('SETUP_FAMILY_UNKNOWN');
    expect(await code(() => planSetup({ ...observe(), families: { execution: { ready: 'yes' } } }, answers({}), registry))).toBe('SETUP_OBSERVATION_INVALID');
    expect(await code(() => planSetup({ ...observe(), runtime: { installed: true } } as SetupObservation))).toBe('SETUP_OBSERVATION_INVALID');
    expect(await code(() => planSetup(observe(), answers({ 'core:unknown': true })))).toBe('SETUP_ANSWER_INVALID');
    expect(await code(() => planSetup(observe(), answers({ 'core:profile': { id: 'acme:x', version: 1 } })))).toBe('SETUP_ANSWER_INVALID');
    expect(await code(() => planSetup(observe(), answers({ 'core:language': 'de' })))).toBe('SETUP_ANSWER_INVALID');
    const foreign = new SetupStageRegistry([family('execution', 'core:sandbox', () => ({ state: 'done', reason: { code: 'setup.reason.policyCurrent', params: {} } }))]);
    expect(await code(() => planSetup(observe(), answers({}), foreign))).toBe('SETUP_STAGE_INVALID');
    const throwing = new SetupStageRegistry([family('execution', 'core:sandbox', () => { throw new Error('probe'); })]);
    expect(await code(() => planSetup(observe(), answers({}), throwing))).toBe('SETUP_STAGE_INVALID');
  });

  it('every Core title, question and reason the planner can return exists in the catalogs', () => {
    const keys = new Set<string>(MESSAGE_KEYS);
    const plans = [planSetup(observe()), planSetup(observe({ environment: { platform: 'windows', node: 'below-floor' } })),
      planSetup(observe({ policy: { state: 'upgradable' }, sandbox: { realm: 'landlock', selfTest: 'not-run', usernsRestricted: false } }), answers({ 'core:folder': 's', 'core:language': 'en' })),
      planSetup(observe({ policy: { state: 'pending' }, folder: { ...base.folder, homeRoot: true } }))];
    for (const stage of plans.flatMap(plan => plan.stages)) {
      expect(keys.has(stage.title), stage.title).toBe(true); expect(keys.has(stage.reason.code), stage.reason.code).toBe(true);
      if (stage.question) expect(keys.has(stage.question.key), stage.question.key).toBe(true);
    }
  });

  it('S1 acceptance: no container-runtime, source-control or coding identifier in the Core stage list, observation type or unit source', () => {
    const forbidden = /docker|git|coding/i;
    expect(CORE_SETUP_STAGES.filter(stage => forbidden.test(stage))).toEqual([]);
    const shapeKeys = (schema: z.ZodTypeAny): string[] => {
      const inner = schema instanceof z.ZodDefault || schema instanceof z.ZodOptional || schema instanceof z.ZodNullable ? schema._def.innerType : schema;
      if (inner instanceof z.ZodObject) return Object.entries(inner.shape as Record<string, z.ZodTypeAny>).flatMap(([key, value]) => [key, ...shapeKeys(value)]);
      if (inner instanceof z.ZodEnum) return [...inner.options as string[]];
      if (inner instanceof z.ZodArray) return shapeKeys(inner.element);
      return [];
    };
    expect(shapeKeys(setupObservationSchema).filter(key => forbidden.test(key))).toEqual([]);
    const unit = join(process.cwd(), 'src/engine/core/setup');
    const files = readdirSync(unit, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(3);
    expect(files.filter(file => forbidden.test(readFileSync(join(unit, file), 'utf8')))).toEqual([]);
  });
});

it('U3-1a: phase filters keep all prerequisite states, settle install warnings, reject cross-phase answers and bind registry data', async () => {
  const registry = new SetupStageRegistry([family('execution'), family('instructions', 'core:model'), family('work', 'core:model')]);
  const fresh = planSetup(observe(), undefined, registry, { phase: 'install' });
  expect(fresh.schemaVersion).toBe(2);
  expect(fresh.stages[0]!.id).toBe('core:language');
  expect(fresh.stages.every(stage => stage.phase === 'install')).toBe(true);
  expect(fresh.stages.map(stage => stage.id)).not.toContain('execution:runtime');
  expect(fresh.stages.map(stage => stage.id)).not.toContain('core:model');
  const done = observe({ language: { configured: 'en', requested: null, system: null }, folder: { ...base.folder, installation: 'present', configuredScope: 's' },
    policy: { state: 'current' }, profile: { ...base.profile, selected: { id: 'core:solo', version: 1 } }, check: { state: 'warnings' } });
  expect(byId(planSetup(done, undefined, registry, { phase: 'install' })).get('core:final-check')).toMatchObject({ state: 'done', reason: { code: 'setup.reason.checkWarnings' } });
  const onboarding = planSetup(done, undefined, registry, { phase: 'onboarding' });
  expect(onboarding.stages.every(stage => stage.phase === 'onboarding')).toBe(true);
  expect(byId(onboarding).get('core:model')!.state).toBe('needs-answer');
  expect(await code(() => planSetup(done, { schemaVersion: SETUP_PLAN_SCHEMA_VERSION, values: { 'core:model': { connection: 'api', model: 'm' } } }, registry, { phase: 'install' })))
    .toBe('SETUP_STAGE_NOT_IN_PHASE');
  const enterprise = new SetupStageRegistry([], { unattendedProfile: 'acme:erp' });
  expect(enterprise.unattendedProfile).toBe('acme:erp');
  expect(enterprise.digest).not.toBe(new SetupStageRegistry().digest);
  const permission = family('permissions', 'core:sandbox', () => ({ state: 'ready', reason: { code: 'setup.permissions.ready', params: {} },
    operation: { id: 'permission-mode.set', version: 1, input: {} } }));
  const table = new SetupStageRegistry([{ ...permission, stages: [{ ...permission.stages[0]!, id: 'permissions:start-mode', phase: 'onboarding' }] },
    { ...family('acme'), stages: [{ ...family('acme').stages[0]!, phase: 'onboarding' }] }, family('other')]);
  const mode = (attestedPerson?: boolean) => byId(planSetup(done, undefined, table, { phase: 'install', ...(attestedPerson === undefined ? {} : { attestedPerson }) }));
  // A listed row wins over the descriptor; unlisted descriptors fall back to their phase, then to their anchor.
  expect(mode().get('permissions:start-mode')).toMatchObject({ phase: 'install', autoEligible: false });
  expect(mode(false).get('permissions:start-mode')!.autoEligible).toBe(false);
  expect(mode(true).get('permissions:start-mode')!.autoEligible).toBe(true);
  expect(mode(true).get('other:runtime')).toMatchObject({ phase: 'install', autoEligible: false });
  expect(mode().has('acme:runtime')).toBe(false);
  expect(byId(planSetup(done, undefined, table, { phase: 'onboarding' })).get('acme:runtime')!.phase).toBe('onboarding');
});

it('U3-1b: declared onboarding order passes only answered earlier stages to later families', () => {
  const seen: unknown[] = [];
  const work: SetupFamilyPackage = { namespace: 'work', source: 'test', facts: z.unknown(), stages: [
    { id: 'work:kind', title: 'setup.work.kindTitle', after: 'core:model', evaluate: context => ({ state: typeof context.answer === 'string' ? 'done' : 'needs-answer', reason: { code: 'setup.work.kindDone' } }) }] };
  const execution: SetupFamilyPackage = { namespace: 'execution', source: 'test', facts: z.unknown(), stages: [
    { id: 'execution:worker', title: 'setup.execution.workerTitle', after: 'core:sandbox', evaluate: context => { seen.push(context.prior?.get('work:kind')); return { state: 'skipped', reason: { code: 'setup.execution.noWorkKind' } }; } }] };
  const registry = new SetupStageRegistry([execution, work]);
  const plan = planSetup(observe(), answers({ 'work:kind': 'chosen-cli' }), registry);
  expect(plan.stages.findIndex(row => row.id === 'work:kind')).toBeLessThan(plan.stages.findIndex(row => row.id === 'execution:worker'));
  expect(seen).toEqual(['chosen-cli']);
  planSetup(observe(), answers({ 'work:kind': { unvalidated: true } }), registry);
  expect(seen).toEqual(['chosen-cli', undefined]);
});
