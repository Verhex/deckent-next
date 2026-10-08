import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configDefinitions } from '#engine/core/config/index.js';
import { configValueModel } from '#surfaces/core/config/index.js';
import { configChoiceDeclaration, configEntryAllowed, configStepper, stepConfigNumber, configNumberText } from '#platform/index.js';
import { composeCore } from '#composition/core/root/index.js';
import type { ConfigFieldView } from '#engine/index.js';
const field = (key: string, schema: unknown, value: unknown = null): ConfigFieldView => ({ key, schema, value, defaultValue: null, source: 'default', description: key,
  descriptionKey: key, binding: { state: 'bound', consumers: [] }, apply: 'live', redacted: false });
describe('CS-1 registry coverage and selection contract', () => {
  it('every registered settable leaf, including representative dynamic records, declares a choice source', () => {
    composeCore(); const missing: string[] = [];
    function visit(schema: z.ZodTypeAny, path: string) {
      if (schema instanceof z.ZodDefault) return visit(schema._def.innerType, path);
      if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional || schema instanceof z.ZodReadonly) return visit(schema.unwrap(), path);
      if (schema instanceof z.ZodEffects) return visit(schema.innerType(), path);
      if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) { for (const option of schema.options) visit(option, path); return; }
      if (schema instanceof z.ZodObject) { for (const [key, child] of Object.entries(schema.shape)) visit(child as z.ZodTypeAny, `${path}.${key}`); return; }
      if (!configChoiceDeclaration(path) && !configEntryAllowed(path)) missing.push(path);
      if (schema instanceof z.ZodArray) visit(schema.element, `${path}.0`);
      if (schema instanceof z.ZodRecord) visit(schema.valueSchema, `${path}.sample`);
    }
    for (const [key, definition] of configDefinitions()) visit(definition.schema, key);
    expect([...new Set(missing)]).toEqual([]);
  });
  it('nullable fields select null; max_workers selects auto; literals and structured descendants are hidden', async () => {
    const nullable = await configValueModel(field('service.idleShutdown.afterMs', { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] }), '/project', 'en');
    expect(nullable.choices).toContainEqual({ id: '0', label: 'Never', value: null }); expect(nullable.free).toBe(false);
    const workers = await configValueModel(field('max_workers', { anyOf: [{ type: 'integer', exclusiveMinimum: 0 }, { const: 'auto' }] }, 'auto'), '/project', 'en');
    expect(workers.choices.some(choice => choice.value === 'auto')).toBe(true); expect(workers.stepper?.min).toBe(1); expect(workers.free).toBe(false);
    expect((await configValueModel(field('schema_version', { const: 4 }, 4), '/project', 'en')).hidden).toBe(true);
    expect((await configValueModel(field('provider_catalog.providers.0.secret', { type: 'string' }), '/project', 'en')).hidden).toBe(true);
    const container = await configValueModel(field('execution.adoption.verification', { anyOf: [{ type: 'object' }, { type: 'null' }] }), '/project', 'en');
    expect(container.choices[0]?.value).toBeNull(); expect(container.readOnly).toBeNull();
  });
  it('steps stay inside integer/float/exclusive bounds and display human units', () => {
    const declaration = configChoiceDeclaration('execution.docker.cpus');
    const float = configStepper({ type: 'number', exclusiveMinimum: 0, maximum: 1 }, declaration, 0.25)!;
    expect(float.min).toBe(0.25); expect(stepConfigNumber(float, 0.25, -1)).toBe(0.25); expect(stepConfigNumber(float, 1, 1)).toBe(1);
    const integer = configStepper({ type: 'integer', minimum: 0, exclusiveMinimum: true, maximum: 4, exclusiveMaximum: true }, configChoiceDeclaration('max_workers'), 0)!;
    expect(integer).toMatchObject({ min: 1, max: 3, current: 1 });
    expect(stepConfigNumber({ ...integer, max: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER - 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(stepConfigNumber({ ...float, step: 0.05 }, 0.9, 1)).toBe(0.95);
    expect(configNumberText(60000, 'ms')).toBe('1 min'); expect(configNumberText(16777216, 'bytes')).toBe('16 MB');
  });
  it('uses fake read-only sources for every reference and writes one whole model reference value', async () => {
    const seen: string[] = [], reference = { providerId: 'local', providerVersion: 1, modelId: 'model', modelVersion: 2 };
    const sources = { list: async (source: string, key: string) => { seen.push(`${source}:${key}`); return [{ id: 'model', label: 'Local model', value: key === 'terminal.chat.reference' ? reference : 'known', detail: 'muted-id' }]; } };
    for (const key of ['terminal.scopeId', 'admission.poolId', 'company.id', 'execution.adoption.verification.kind', 'approvals.keyFile', 'execution.workTargets.targets.0.baseRef',
      'execution.docker.executable', 'execution.git.gitExecutable', 'execution.docker.imageId', 'identity.profile', 'inference_serving.activeProfileId', 'terminal.shell.environment', 'terminal.chat.reference']) {
      const model = await configValueModel(field(key, { type: 'string' }), '/project', 'en', sources);
      expect(model.free).toBe(false); expect(model.choices.length).toBeGreaterThan(0);
      if (key === 'terminal.chat.reference') expect(model.choices[0]?.value).toEqual(reference);
    }
    expect(seen).toHaveLength(13);
    const failed = await configValueModel(field('admission.poolId', { type: 'string' }), '/project', 'en', { list: async () => { throw new Error('failure'); } });
    expect(failed.readOnly).toBe('Choice source unavailable'); expect(failed.free).toBe(false);
  });
  it('derives names, regenerates IDs and only allows the explicit entry exceptions', async () => {
    const project = await configValueModel(field('projectName', { type: 'string' }), '/work/my_project', 'en');
    expect(project.choices.map(choice => choice.value)).toEqual(['my_project', 'my project']);
    for (const key of ['service.identity.serviceId', 'provider_catalog.revision']) {
      const a = await configValueModel(field(key, { type: 'string' }), '/project', 'en'), b = await configValueModel(field(key, { type: 'string' }), '/project', 'en');
      expect(a.generated).toBe(true); expect(a.choices[0]?.value).not.toBe(b.choices[0]?.value);
    }
    for (const key of ['max_workers', 'projectName', 'terminal.chat.reference', 'provider_catalog.providers', 'layout.root', 'terminal.scopeId']) expect(configEntryAllowed(key, true)).toBe(false);
    expect(configEntryAllowed('terminal.fetch.allowedHosts')).toBe(true); expect(configEntryAllowed('toolchains.currency.registryEndpoint')).toBe(true);
    expect(configEntryAllowed('secrets.token', true)).toBe(true); expect(configEntryAllowed('secrets.token')).toBe(false);
  });
});
