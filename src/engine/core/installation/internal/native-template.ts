import { NATIVE_CODING_TEMPLATE_ADAPTER_ID, persistedInteger, executionRegistrySchema, evaluatorDefinitionSchema, identitySchema, nativeCliIdSchema, type ExecutionRegistry, type JsonValue, type ExecutionProfileDefinition, type VerifiedPrincipal } from '#domain/index.js';
import { ConfigValidationError, ErrorRegistry, sha256, type DeckentConfig } from '#platform/index.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { affectedToolchainProfiles, registryLayerHold } from '#engine/core/toolchain-currency/index.js';
import { assertConfigPersonWitness, type ConfigSnapshot, type ConfigWriteResult, type ConfigApplication } from '#engine/core/config/index.js';
import type { NativeCliWorkerBinding } from '#capabilities/index.js';
import defaults from './initial-registry.json' with { type: 'json' };
const initialRegistryDefaults = z.strictObject({ schemaVersion: z.literal(1), ordering: z.literal('input-order'),
  evaluators: z.array(evaluatorDefinitionSchema).min(1) }).parse(defaults);
export interface NativeTemplatePorts {
  snapshot(): Promise<ConfigSnapshot>;
  principal(scopeId: string): Promise<VerifiedPrincipal>;
  writer(guard: (snapshot: ConfigSnapshot) => void): Pick<ConfigApplication, 'set'>;
  template(resources: unknown, invocation: unknown, worker?: NativeCliWorkerBinding): ExecutionProfileDefinition;
  connection?(snapshot: ConfigSnapshot, id: string, provider: string): Promise<NativeCliWorkerBinding>; observed?(worker: NativeCliWorkerBinding): Promise<string | null>; // R8: last proved CLI
  detect(provider: string, settings: NonNullable<NonNullable<DeckentConfig['execution']>['docker']>): Promise<string>;
  beforeWrite?: () => void | Promise<void>;
  /** alpha.55.1: the person's terminal witness (`ConfigAuthorityPort.witness`): `admission` is a protected root, so an apply asks it right after
   * input validation, before any snapshot, discovery, principal or write; absent, an apply is refused (fail closed). */
  witness?: (operation: string) => Promise<void>;
}

const discoveryModeSchema = z.enum(['disabled', 'repository']);
/** `discovery` omitted: `coding template` keeps the mode of the admitted profiles it derives from, `init registry` takes the adapter default
 * (`disabled`, owner 2026-10-23 Q2); a connected worker requires disabled. Explicit `--discovery` selects a new template content id; bound kinds are never edited in place. */
const requestSchema = z.strictObject({ provider: nativeCliIdSchema, kind: identitySchema,
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), connection: identitySchema.optional(), detach: z.boolean().optional(), discovery: discoveryModeSchema.optional(), apply: z.boolean() });
export type CodingTemplateRequest = z.infer<typeof requestSchema>;
export type CodingTemplateResult = Readonly<{ schemaVersion: 1; status: 'preview' | 'applied' | 'unchanged' | 'current';
  profile: ExecutionRegistry['profiles'][number]; kind: ExecutionRegistry['kinds'][number]; registry: ExecutionRegistry;
  expect: string | null; connection?: string | null; write: ConfigWriteResult | null }>;
function refuse(code: string): never { throw ErrorRegistry.createError(code); }
/** R8b (owner D1): a connected CLI worker runs in the host sandbox: without Docker settings its template takes the adapter's default limits, no image. */
function limits(snapshot: ConfigSnapshot, worker: NativeCliWorkerBinding | undefined, image: string | undefined, missing: string) {
  const docker = snapshot.effective.execution?.docker; if (!docker) return worker ? undefined : refuse(missing);
  const { executable, ...rest } = docker; void executable; return { ...rest, imageId: image ?? rest.imageId };
}
/** The adapter's typed refusals named instead of a generic template failure: a discovery mode the CLI cannot honour, a CLI without a Docker subscription path (owner 2026-11-08). */
function discoveryRefusal(error: unknown, provider: string, fallback: string): never {
  const typed = ({ NATIVE_CODING_DISCOVERY_UNSUPPORTED: 'CODING_DISCOVERY_UNSUPPORTED', NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE: 'NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE' } as Record<string, string>)[String((error as { code?: unknown } | null)?.code)]; if (typed) throw ErrorRegistry.createError(typed, { params: { provider } });
  refuse(fallback);
}

function proposal(snapshot: ConfigSnapshot, request: CodingTemplateRequest, template: NativeTemplatePorts['template'], discovered?: ExecutionProfileDefinition, worker?: NativeCliWorkerBinding) {
  const admission = snapshot.effective.admission;
  if (!admission?.poolId || !admission.executionSlots || !admission.inFlightSlots) refuse('CODING_TEMPLATE_ADMISSION_REQUIRED');
  const hold = registryLayerHold(snapshot);
  if (hold) refuse(hold === 'TOOLCHAIN_REGISTRY_NOT_IN_PROJECT' ? 'CODING_TEMPLATE_ADMISSION_REQUIRED' : hold);
  const registry = executionRegistrySchema.safeParse((snapshot.document['admission'] as { registry?: unknown }).registry);
  if (!registry.success) refuse('CODING_TEMPLATE_REGISTRY_INVALID');
  const resourceLimits = limits(snapshot, worker, request.image, 'CODING_TEMPLATE_IMAGE_REQUIRED'), imageId = resourceLimits?.imageId;
  const bound = registry.data.kinds.find(entry => entry.kind === request.kind);
  const discoveryMode = request.discovery ?? (worker ? 'disabled' : undefined);
  if (worker && discoveryMode !== 'disabled') refuse('CODING_TEMPLATE_CONNECTION_DISCOVERY_UNSUPPORTED');
  const pins = affectedToolchainProfiles({ admission: { registry: registry.data } }).filter(pin => pin.provider === request.provider && pin.imageId === imageId
    && (!(request.connection || request.detach) || !bound || pin.profile.id === bound.profile.id && pin.profile.version === bound.profile.version));
  const candidates = discovered ? [discovered] : pins.map(pin => {
    const source = registry.data.profiles.find(profile => profile.id === pin.profile.id && profile.version === pin.profile.version)!;
    const invocation = source.parameters['invocation'] as { discovery?: JsonValue } | undefined;
    const preflight = (source.parameters['nativeSubscription'] as { preflight?: { discovery?: string } } | undefined)?.preflight;
    const discovery = discoveryMode ? { schemaVersion: 1, mode: discoveryMode }
      : invocation?.discovery ?? (preflight?.discovery ? { schemaVersion: 1, mode: preflight.discovery } : null);
    if (!discovery) refuse('CODING_TEMPLATE_TOOLCHAIN_REQUIRED');
    try { return template(resourceLimits, { provider: request.provider, cliVersion: pin.cliVersion, discovery, permissionMode: 'unattended' }, worker); }
    catch (error) { discoveryRefusal(error, request.provider, 'EXECUTION_PROFILE_INVALID'); }
  });
  if (new Set(candidates.map(candidate => JSON.stringify(candidate))).size !== 1) refuse('CODING_TEMPLATE_TOOLCHAIN_REQUIRED');
  const candidate = candidates[0]!;
  const same = (profile: typeof candidate) => JSON.stringify(profile) === JSON.stringify(candidate);
  const existing = registry.data.profiles.find(profile => profile.id === candidate.id && profile.version === candidate.version);
  if (existing && !same(existing)) refuse('CODING_TEMPLATE_KIND_CONFLICT');
  const kind = { kind: request.kind, profile: { id: candidate.id, version: candidate.version } };
  const replacing = bound && (bound.profile.id !== kind.profile.id || bound.profile.version !== kind.profile.version);
  if (bound && replacing && (!(request.connection || request.detach) || !registry.data.profiles.some(profile => profile.id === bound.profile.id
    && profile.version === bound.profile.version && profile.adapter.id === NATIVE_CODING_TEMPLATE_ADAPTER_ID))) refuse('CODING_TEMPLATE_KIND_CONFLICT');
  if (bound && !replacing) return { profile: candidate, kind: bound, registry: registry.data, changed: false };
  const next = { ...registry.data, profiles: existing ? registry.data.profiles : [...registry.data.profiles, candidate], kinds: bound ? registry.data.kinds.map(row => row.kind === request.kind ? kind : row) : [...registry.data.kinds, kind] };
  return { profile: candidate, kind, registry: executionRegistrySchema.parse({ ...next, revision: `coding-template-${sha256(JSON.stringify(next))}` }), changed: true };
}

export async function addNativeProfile(input: unknown, ports: NativeTemplatePorts) {
  const parsed = requestSchema.omit({ connection: true, detach: true }).extend({ image: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    expect: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(), digest: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict().safeParse(input);
  if (!parsed.success) refuse('CODING_TEMPLATE_INPUT_INVALID');
  const request = parsed.data;
  if (request.apply) await assertConfigPersonWitness('set', 'admission.registry', ports.witness);
  const read = await ports.snapshot();
  if (request.expect !== undefined && request.expect !== read.digest) refuse('CONFIG_CONCURRENT_REVISION_HOLD');
  const settings = read.effective.execution?.docker;
  if (!settings) refuse('CODING_TEMPLATE_IMAGE_REQUIRED');
  // Validate registry/layer/kind prerequisites before a detection process is allowed to start.
  const hold = registryLayerHold(read);
  if (hold) refuse(hold);
  const existing = executionRegistrySchema.safeParse(read.effective.admission?.registry);
  if (!existing.success) refuse('CODING_TEMPLATE_REGISTRY_INVALID');
  const pins = affectedToolchainProfiles(read.effective).filter(pin => pin.provider === request.provider && pin.imageId === request.image);
  const cliVersion = pins[0]?.cliVersion ?? await ports.detect(request.provider, { ...settings, imageId: request.image });
  const { executable, ...resources } = settings; void executable;
  const candidate = ((): ExecutionProfileDefinition => { try { return ports.template({ ...resources, imageId: request.image }, { provider: request.provider, cliVersion, permissionMode: 'unattended',
    ...(request.discovery ? { discovery: { schemaVersion: 1, mode: request.discovery } } : {}) }); } catch (error) { discoveryRefusal(error, request.provider, 'EXECUTION_PROFILE_INVALID'); } })();
  const plan = proposal(read, request, ports.template, candidate);
  const digest = sha256(JSON.stringify({ project: read.digest, global: read.global, profile: plan.profile, registry: plan.registry }));
  const result = { schemaVersion: 1 as const, profile: plan.profile, kind: plan.kind, registry: plan.registry, expect: read.digest, digest };
  if (!request.apply) return { ...result, status: plan.changed ? 'preview' as const : 'unchanged' as const, write: null };
  if (request.digest !== digest) refuse('CONFIG_CONCURRENT_REVISION_HOLD');
  if (!plan.changed) return { ...result, status: 'unchanged' as const, write: null };
  const scopeId = read.effective.service.identity?.scopeId ?? (read.effective['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  if (!scopeId) refuse('TERMINAL_SCOPE_REQUIRED');
  const principal = await ports.principal(scopeId);
  const guard = (current: ConfigSnapshot) => {
    if (JSON.stringify(current.global) !== JSON.stringify(read.global) || JSON.stringify(current.effective.execution) !== JSON.stringify(read.effective.execution)
      || JSON.stringify(current.effective.admission) !== JSON.stringify(read.effective.admission)) refuse('CONFIG_CONCURRENT_REVISION_HOLD');
  };
  await ports.beforeWrite?.();
  const write = await ports.writer(guard).set({ keyPath: 'admission.registry', value: plan.registry, layer: 'project', principal, scopeId,
    commandId: randomUUID(), expect: read.digest });
  return { ...result, status: 'applied' as const, write };
}

export async function configureNativeTemplate(input: unknown, ports: NativeTemplatePorts): Promise<CodingTemplateResult & Readonly<{ status: 'preview' | 'applied' | 'unchanged' }>> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || parsed.data.connection && parsed.data.detach) refuse('CODING_TEMPLATE_INPUT_INVALID');
  const request = parsed.data;
  if (request.apply) await assertConfigPersonWitness('set', 'admission.registry', ports.witness);
  const read = await ports.snapshot().catch((error: unknown) => {
    if (error instanceof ConfigValidationError) {
      if (error.issues.some(issue => ['admission.poolId', 'admission.executionSlots', 'admission.inFlightSlots'].includes(issue.path))) refuse('CODING_TEMPLATE_ADMISSION_REQUIRED');
      if (error.issues.some(issue => issue.path === 'execution.docker.imageId')) refuse('CODING_TEMPLATE_IMAGE_REQUIRED');
    }
    throw error;
  });
  const worker = request.connection ? await ports.connection?.(read, request.connection, request.provider) : undefined; if (request.connection && !worker) refuse('NATIVE_AGENT_RECONNECT_REQUIRED');
  const cliVersion = worker ? await ports.observed?.(worker) ?? worker.definition.minCliVersion : undefined; // Owner R8: the CLI its connection last proved, read once
  const own = (snapshot: ConfigSnapshot) => {
    try { return ports.template(limits(snapshot, worker, request.image, 'CODING_TEMPLATE_IMAGE_REQUIRED'), { provider: request.provider, cliVersion: cliVersion!,
      discovery: { schemaVersion: 1, mode: request.discovery ?? 'disabled' }, permissionMode: 'unattended' }, worker); } catch (error) { discoveryRefusal(error, request.provider, 'EXECUTION_PROFILE_INVALID'); } };
  const planFor = (snapshot: ConfigSnapshot) => { try { return proposal(snapshot, request, ports.template, undefined, worker); } catch (error) {
    if (!worker || (error as { code?: unknown }).code !== 'CODING_TEMPLATE_TOOLCHAIN_REQUIRED') throw error; return proposal(snapshot, request, ports.template, own(snapshot), worker); } };
  const plan = planFor(read), result = { schemaVersion: 1 as const, profile: plan.profile, kind: plan.kind, registry: plan.registry, expect: read.digest, connection: request.connection ?? null };
  if (!request.apply || !plan.changed) return { ...result, status: plan.changed ? 'preview' : 'unchanged', write: null };
  const config = read.effective;
  const scopeId = config.service.identity?.scopeId ?? (config['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  if (!scopeId) refuse('TERMINAL_SCOPE_REQUIRED');
  const principal = await ports.principal(scopeId);
  // Refuse a changed global registry or effective resource source under the writer's lock as well as the project CAS.
  const guard = (current: ConfigSnapshot) => {
    if (worker && (JSON.stringify(current.effective['provider_invocation_profiles']) !== JSON.stringify(read.effective['provider_invocation_profiles'])
      || JSON.stringify(current.effective['provider_catalog']) !== JSON.stringify(read.effective['provider_catalog']))) refuse('CONFIG_CONCURRENT_REVISION_HOLD');
    const fresh = planFor(current);
    if (JSON.stringify(fresh.profile) !== JSON.stringify(plan.profile)) refuse('CONFIG_CONCURRENT_REVISION_HOLD');
  };
  await ports.beforeWrite?.();
  const write = await ports.writer(guard).set({ keyPath: 'admission.registry', value: plan.registry,
    layer: 'project', principal, scopeId, commandId: randomUUID(), expect: read.digest });
  return { ...result, status: 'applied', write };
}

const initializeSchema = requestSchema.omit({ detach: true }).extend({ schemaVersion: z.literal(1), scopeId: identitySchema,
  expect: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
  poolId: identitySchema, executionSlots: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), inFlightSlots: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  discovery: discoveryModeSchema.optional() }).strict();
export type InitialRegistryRequest = z.infer<typeof initializeSchema>;
const authoredRegistry = (document: Record<string, unknown>) => {
  // Authored presence, including malformed/empty/null values, must never be mistaken for an absent registry.
  const admission = document['admission'];
  return !!admission && typeof admission === 'object' && Object.hasOwn(admission, 'registry');
};
function initialSource(snapshot: ConfigSnapshot, request: InitialRegistryRequest, existing: boolean, worker: NativeCliWorkerBinding | undefined) {
  if (!existing && [snapshot.global, snapshot.project].some(authoredRegistry)) refuse('INITIAL_REGISTRY_EXISTS');
  const admission = snapshot.effective.admission;
  if (!existing && admission && (admission.poolId !== request.poolId || admission.executionSlots !== request.executionSlots || admission.inFlightSlots !== request.inFlightSlots)) refuse('INITIAL_REGISTRY_CONFIG_CONFLICT');
  const scope = snapshot.effective.service.identity?.scopeId ?? (snapshot.effective['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  if (scope !== request.scopeId) refuse('INITIAL_REGISTRY_CONFIG_CONFLICT');
  return limits(snapshot, worker, request.image, existing ? 'INITIAL_REGISTRY_EXISTS' : 'CODING_TEMPLATE_IMAGE_REQUIRED');
}
/** The first registry for one detected CLI version: one profile, one kind, the default evaluators; deterministic revision. */
function initialRegistry(request: InitialRegistryRequest, settings: ReturnType<typeof limits>, cliVersion: string, template: NativeTemplatePorts['template'], worker?: NativeCliWorkerBinding) {
  const discovery = request.discovery ?? (worker ? 'disabled' : undefined); if (worker && discovery !== 'disabled') refuse('CODING_TEMPLATE_CONNECTION_DISCOVERY_UNSUPPORTED');
  let profile: ExecutionProfileDefinition;
  try { profile = template(settings, { provider: request.provider, cliVersion,
    ...(discovery ? { discovery: { schemaVersion: 1, mode: discovery } } : {}), permissionMode: 'unattended' }, worker); }
  catch (error) { discoveryRefusal(error, request.provider, 'INITIAL_REGISTRY_CLI_UNAVAILABLE'); }
  const kind = { kind: request.kind, profile: { id: profile.id, version: profile.version } };
  const content = { schemaVersion: 1, profiles: [profile], kinds: [kind], evaluators: initialRegistryDefaults.evaluators };
  return { profile, kind, registry: executionRegistrySchema.parse({ ...content, revision: `initial-registry-${sha256(JSON.stringify(content))}` }) };
}
/** An identical first registry is current; any other authored registry remains refused. */
function currentRegistry(snapshot: ConfigSnapshot, request: InitialRegistryRequest, template: NativeTemplatePorts['template'], worker?: NativeCliWorkerBinding) {
  if (authoredRegistry(snapshot.global)) refuse('INITIAL_REGISTRY_EXISTS');
  if (!authoredRegistry(snapshot.project)) return null;
  const settings = initialSource(snapshot, request, true, worker);
  const existing = executionRegistrySchema.safeParse((snapshot.project['admission'] as { registry?: unknown }).registry);
  const invocation = existing.success && existing.data.profiles.length === 1 ? existing.data.profiles[0]!.parameters['invocation'] as { cliVersion?: unknown } | undefined : undefined;
  if (typeof invocation?.cliVersion !== 'string') refuse('INITIAL_REGISTRY_EXISTS');
  let candidate: ReturnType<typeof initialRegistry>;
  try { candidate = initialRegistry(request, settings, invocation.cliVersion, template, worker); } catch { refuse('INITIAL_REGISTRY_EXISTS'); }
  const admission = snapshot.effective.admission;
  const equal = JSON.stringify(existing.data) === JSON.stringify(candidate.registry) && admission?.poolId === request.poolId
    && admission.executionSlots === request.executionSlots && admission.inFlightSlots === request.inFlightSlots && admission.ordering === initialRegistryDefaults.ordering;
  if (!equal) refuse('INITIAL_REGISTRY_EXISTS');
  return candidate;
}
export async function initializeNativeRegistry(input: unknown, ports: NativeTemplatePorts) {
  const parsed = initializeSchema.safeParse(input);
  if (!parsed.success) refuse('CODING_TEMPLATE_INPUT_INVALID');
  const request = parsed.data;
  if (request.apply) await assertConfigPersonWitness('set', 'admission', ports.witness);
  const read = await ports.snapshot();
  if (request.expect !== undefined && request.expect !== read.digest) refuse('CONFIG_CONCURRENT_REVISION_HOLD');
  const worker = request.connection ? await ports.connection?.(read, request.connection, request.provider) : undefined; if (request.connection && !worker) refuse('NATIVE_AGENT_RECONNECT_REQUIRED');
  const current = currentRegistry(read, request, ports.template, worker);
  if (current) return { schemaVersion: 1 as const, ...current, expect: read.digest, status: 'current' as const, write: null };
  const settings = initialSource(read, request, false, worker); // R8a: a connected worker records its connection's current CLI version; no detection container
  const cliVersion = worker ? await ports.observed?.(worker) ?? worker.definition.minCliVersion : await ports.detect(request.provider, { executable: read.effective.execution!.docker!.executable, ...settings! });
  const { profile, kind, registry } = initialRegistry(request, settings, cliVersion, ports.template, worker);
  const admission = { ...read.effective.admission, registry, poolId: request.poolId, executionSlots: request.executionSlots,
    inFlightSlots: request.inFlightSlots, ordering: initialRegistryDefaults.ordering };
  const result = { schemaVersion: 1 as const, profile, kind, registry, expect: read.digest };
  if (!request.apply) return { ...result, status: 'preview' as const, write: null };
  const principal = await ports.principal(request.scopeId);
  const guard = (current: ConfigSnapshot) => {
    if (JSON.stringify(initialSource(current, request, false, worker)) !== JSON.stringify(settings) || JSON.stringify(current.effective.admission) !== JSON.stringify(read.effective.admission)
      || worker && JSON.stringify(current.effective['provider_invocation_profiles']) !== JSON.stringify(read.effective['provider_invocation_profiles'])) refuse('CONFIG_CONCURRENT_REVISION_HOLD');
  };
  await ports.beforeWrite?.();
  const write = await ports.writer(guard).set({ keyPath: 'admission', value: admission, layer: 'project', principal,
    scopeId: request.scopeId, commandId: randomUUID(), expect: read.digest });
  return { ...result, status: 'applied' as const, write };
}
