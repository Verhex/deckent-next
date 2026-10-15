import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { executionRegistrySchema, evaluatorDefinitionSchema, identitySchema, nativeCliIdSchema, type ExecutionRegistry, type JsonValue, type ExecutionProfileDefinition, type VerifiedPrincipal } from '#domain/index.js';
import { affectedToolchainProfiles, registryLayerHold } from '#engine/core/toolchain-currency/index.js';
import type { ConfigSnapshot, ConfigWriteResult, ConfigApplication } from '#engine/core/config/index.js';
import { ConfigValidationError, ErrorRegistry, sha256, type DeckentConfig } from '#platform/index.js';
import defaults from './initial-registry.json' with { type: 'json' };
const initialRegistryDefaults = z.object({ schemaVersion: z.literal(1), ordering: z.literal('input-order'),
  evaluators: z.array(evaluatorDefinitionSchema).min(1) }).strict().parse(defaults);
export interface NativeTemplatePorts {
  snapshot(): Promise<ConfigSnapshot>;
  principal(scopeId: string): Promise<VerifiedPrincipal>;
  writer(guard: (snapshot: ConfigSnapshot) => void): Pick<ConfigApplication, 'set'>;
  template(resources: unknown, invocation: unknown): ExecutionProfileDefinition;
  detect(provider: string, settings: NonNullable<DeckentConfig['execution']>['docker']): Promise<string>;
  beforeWrite?: () => void | Promise<void>;
}

const requestSchema = z.object({ provider: nativeCliIdSchema, kind: identitySchema,
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), apply: z.boolean() }).strict();
export type CodingTemplateRequest = z.infer<typeof requestSchema>;
export type CodingTemplateResult = Readonly<{ schemaVersion: 1; status: 'preview' | 'applied' | 'unchanged';
  profile: ExecutionRegistry['profiles'][number]; kind: ExecutionRegistry['kinds'][number]; registry: ExecutionRegistry;
  expect: string | null; write: ConfigWriteResult | null }>;
function refuse(code: string): never { throw ErrorRegistry.createError(code); }

/** Pure proposal from the authored project registry and the effective, validated resource limits. */
function proposal(snapshot: ConfigSnapshot, request: CodingTemplateRequest, template: NativeTemplatePorts['template']) {
  const admission = snapshot.effective.admission;
  if (!admission?.poolId || !admission.executionSlots || !admission.inFlightSlots) refuse('CODING_TEMPLATE_ADMISSION_REQUIRED');
  const hold = registryLayerHold(snapshot);
  if (hold) refuse(hold === 'TOOLCHAIN_REGISTRY_NOT_IN_PROJECT' ? 'CODING_TEMPLATE_ADMISSION_REQUIRED' : hold);
  const registry = executionRegistrySchema.safeParse((snapshot.document['admission'] as { registry?: unknown }).registry);
  if (!registry.success) refuse('CODING_TEMPLATE_REGISTRY_INVALID');
  const settings = snapshot.effective.execution?.docker;
  if (!settings) refuse('CODING_TEMPLATE_IMAGE_REQUIRED');
  const imageId = request.image ?? settings.imageId;
  const { executable, ...resourceLimits } = settings; void executable;
  const pins = affectedToolchainProfiles({ admission: { registry: registry.data } }).filter(pin => pin.provider === request.provider && pin.imageId === imageId);
  const candidates = pins.map(pin => {
    const source = registry.data.profiles.find(profile => profile.id === pin.profile.id && profile.version === pin.profile.version)!;
    const invocation = source.parameters['invocation'] as { discovery?: JsonValue } | undefined;
    const preflight = (source.parameters['nativeSubscription'] as { preflight?: { discovery?: string } } | undefined)?.preflight;
    const discovery = invocation?.discovery ?? (preflight?.discovery ? { schemaVersion: 1, mode: preflight.discovery } : null);
    if (!discovery) refuse('CODING_TEMPLATE_TOOLCHAIN_REQUIRED');
    try { return template({ ...resourceLimits, imageId }, { provider: request.provider, cliVersion: pin.cliVersion, discovery, permissionMode: 'unattended' }); }
    catch { refuse('EXECUTION_PROFILE_INVALID'); }
  });
  if (new Set(candidates.map(candidate => JSON.stringify(candidate))).size !== 1) refuse('CODING_TEMPLATE_TOOLCHAIN_REQUIRED');
  const candidate = candidates[0]!;
  const same = (profile: typeof candidate) => JSON.stringify(profile) === JSON.stringify(candidate);
  const existing = registry.data.profiles.find(profile => profile.id === candidate.id && profile.version === candidate.version);
  if (existing && !same(existing)) refuse('CODING_TEMPLATE_KIND_CONFLICT');
  const kind = { kind: request.kind, profile: { id: candidate.id, version: candidate.version } };
  const bound = registry.data.kinds.find(entry => entry.kind === request.kind);
  if (bound && (bound.profile.id !== kind.profile.id || bound.profile.version !== kind.profile.version)) refuse('CODING_TEMPLATE_KIND_CONFLICT');
  if (bound) return { profile: candidate, kind: bound, registry: registry.data, changed: false };
  const next = { ...registry.data, profiles: existing ? registry.data.profiles : [...registry.data.profiles, candidate], kinds: [...registry.data.kinds, kind] };
  return { profile: candidate, kind, registry: executionRegistrySchema.parse({ ...next, revision: `coding-template-${sha256(JSON.stringify(next))}` }), changed: true };
}

/** No launch/build/network. Apply is one allow-only ConfigApplication CAS write; no retry or policy bypass. */
export async function configureNativeTemplate(input: unknown, ports: NativeTemplatePorts): Promise<CodingTemplateResult> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) refuse('CODING_TEMPLATE_INPUT_INVALID');
  const request = parsed.data;
  const read = await ports.snapshot().catch((error: unknown) => {
    if (error instanceof ConfigValidationError) {
      if (error.issues.some(issue => ['admission.poolId', 'admission.executionSlots', 'admission.inFlightSlots'].includes(issue.path))) refuse('CODING_TEMPLATE_ADMISSION_REQUIRED');
      if (error.issues.some(issue => issue.path === 'execution.docker.imageId')) refuse('CODING_TEMPLATE_IMAGE_REQUIRED');
    }
    throw error;
  });
  const plan = proposal(read, request, ports.template);
  const result = { schemaVersion: 1 as const, profile: plan.profile, kind: plan.kind, registry: plan.registry, expect: read.digest };
  if (!request.apply || !plan.changed) return { ...result, status: plan.changed ? 'preview' : 'unchanged', write: null };
  const config = read.effective;
  const scopeId = config.service.identity?.scopeId ?? (config['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  if (!scopeId) refuse('TERMINAL_SCOPE_REQUIRED');
  const principal = await ports.principal(scopeId);
  // Refuse a changed global registry or effective resource source under the writer's lock as well as the project CAS.
  const guard = (current: ConfigSnapshot) => {
    const fresh = proposal(current, request, ports.template);
    if (JSON.stringify(fresh.profile) !== JSON.stringify(plan.profile)) refuse('CONFIG_CONCURRENT_REVISION_HOLD');
  };
  await ports.beforeWrite?.();
  const write = await ports.writer(guard).set({ keyPath: 'admission.registry', value: plan.registry,
    layer: 'project', principal, scopeId, commandId: randomUUID(), expect: read.digest });
  return { ...result, status: 'applied', write };
}

const initializeSchema = requestSchema.omit({ image: true }).extend({ schemaVersion: z.literal(1), scopeId: identitySchema,
  poolId: identitySchema, executionSlots: z.number().int().positive().safe(), inFlightSlots: z.number().int().positive().safe(),
  discovery: z.enum(['disabled', 'repository']) }).strict();
export type InitialRegistryRequest = z.infer<typeof initializeSchema>;
function initialSource(snapshot: ConfigSnapshot, request: InitialRegistryRequest) {
  // Authored presence, including malformed/empty/null values, must never be mistaken for an absent registry.
  for (const document of [snapshot.global, snapshot.project]) {
    const admission = document['admission'];
    if (admission && typeof admission === 'object' && Object.hasOwn(admission, 'registry')) refuse('INITIAL_REGISTRY_EXISTS');
  }
  const admission = snapshot.effective.admission;
  if (admission && (admission.poolId !== request.poolId || admission.executionSlots !== request.executionSlots || admission.inFlightSlots !== request.inFlightSlots)) refuse('INITIAL_REGISTRY_CONFIG_CONFLICT');
  const scope = snapshot.effective.service.identity?.scopeId ?? (snapshot.effective['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  if (scope !== request.scopeId) refuse('INITIAL_REGISTRY_CONFIG_CONFLICT');
  const settings = snapshot.effective.execution?.docker;
  if (!settings) refuse('CODING_TEMPLATE_IMAGE_REQUIRED');
  return settings;
}
/** Bootstrap only: discovery is a port observation, and the existing config application remains the sole durable writer. */
export async function initializeNativeRegistry(input: unknown, ports: NativeTemplatePorts) {
  const parsed = initializeSchema.safeParse(input);
  if (!parsed.success) refuse('CODING_TEMPLATE_INPUT_INVALID');
  const request = parsed.data, read = await ports.snapshot(), settings = initialSource(read, request);
  const cliVersion = await ports.detect(request.provider, settings);
  const { executable, ...resources } = settings; void executable;
  let profile: ExecutionProfileDefinition;
  try { profile = ports.template(resources, { provider: request.provider, cliVersion,
    discovery: { schemaVersion: 1, mode: request.discovery }, permissionMode: 'unattended' }); }
  catch { refuse('INITIAL_REGISTRY_CLI_UNAVAILABLE'); }
  const kind = { kind: request.kind, profile: { id: profile.id, version: profile.version } };
  const content = { schemaVersion: 1, profiles: [profile], kinds: [kind], evaluators: initialRegistryDefaults.evaluators };
  const registry = executionRegistrySchema.parse({ ...content, revision: `initial-registry-${sha256(JSON.stringify(content))}` });
  const admission = { ...read.effective.admission, registry, poolId: request.poolId, executionSlots: request.executionSlots,
    inFlightSlots: request.inFlightSlots, ordering: initialRegistryDefaults.ordering };
  const result = { schemaVersion: 1 as const, profile, kind, registry, expect: read.digest };
  if (!request.apply) return { ...result, status: 'preview' as const, write: null };
  const principal = await ports.principal(request.scopeId);
  const guard = (current: ConfigSnapshot) => {
    if (JSON.stringify(initialSource(current, request)) !== JSON.stringify(settings)
      || JSON.stringify(current.effective.admission) !== JSON.stringify(read.effective.admission)) refuse('CONFIG_CONCURRENT_REVISION_HOLD');
  };
  await ports.beforeWrite?.();
  const write = await ports.writer(guard).set({ keyPath: 'admission', value: admission, layer: 'project', principal,
    scopeId: request.scopeId, commandId: randomUUID(), expect: read.digest });
  return { ...result, status: 'applied' as const, write };
}
