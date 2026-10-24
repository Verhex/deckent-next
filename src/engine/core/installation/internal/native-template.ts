import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { executionRegistrySchema, evaluatorDefinitionSchema, identitySchema, nativeCliIdSchema, type ExecutionRegistry, type JsonValue, type ExecutionProfileDefinition, type VerifiedPrincipal } from '#domain/index.js';
import { affectedToolchainProfiles, registryLayerHold } from '#engine/core/toolchain-currency/index.js';
import { assertConfigPersonWitness, type ConfigSnapshot, type ConfigWriteResult, type ConfigApplication } from '#engine/core/config/index.js';
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
  /** alpha.55.1: the person's terminal witness (`ConfigAuthorityPort.witness`): `admission` is a protected root, so an apply asks it right after
   * input validation, before any snapshot, discovery, principal or write; absent, an apply is refused (fail closed). */
  witness?: (operation: string) => Promise<void>;
}

const discoveryModeSchema = z.enum(['disabled', 'repository']);
/** `discovery` omitted: `coding template` keeps the mode of the admitted profiles it derives from, `init registry` takes the adapter default
 * (`disabled`, owner 2026-10-23 Q2). Explicit `--discovery` selects a new template content id; bound kinds are never edited in place. */
const requestSchema = z.object({ provider: nativeCliIdSchema, kind: identitySchema,
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), discovery: discoveryModeSchema.optional(), apply: z.boolean() }).strict();
export type CodingTemplateRequest = z.infer<typeof requestSchema>;
/** `current` is returned by the first-registry bootstrap only (an equal registry already exists); the template returns the other three. */
export type CodingTemplateResult = Readonly<{ schemaVersion: 1; status: 'preview' | 'applied' | 'unchanged' | 'current';
  profile: ExecutionRegistry['profiles'][number]; kind: ExecutionRegistry['kinds'][number]; registry: ExecutionRegistry;
  expect: string | null; write: ConfigWriteResult | null }>;
function refuse(code: string): never { throw ErrorRegistry.createError(code); }
/** The adapter's typed refusal for a discovery mode the selected CLI cannot honour, named instead of a generic template failure. */
function discoveryRefusal(error: unknown, provider: string, fallback: string): never {
  if ((error as { code?: unknown } | null)?.code === 'NATIVE_CODING_DISCOVERY_UNSUPPORTED') throw ErrorRegistry.createError('CODING_DISCOVERY_UNSUPPORTED', { params: { provider } });
  refuse(fallback);
}

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
    const discovery = request.discovery ? { schemaVersion: 1, mode: request.discovery }
      : invocation?.discovery ?? (preflight?.discovery ? { schemaVersion: 1, mode: preflight.discovery } : null);
    if (!discovery) refuse('CODING_TEMPLATE_TOOLCHAIN_REQUIRED');
    try { return template({ ...resourceLimits, imageId }, { provider: request.provider, cliVersion: pin.cliVersion, discovery, permissionMode: 'unattended' }); }
    catch (error) { discoveryRefusal(error, request.provider, 'EXECUTION_PROFILE_INVALID'); }
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
export async function configureNativeTemplate(input: unknown, ports: NativeTemplatePorts): Promise<CodingTemplateResult & Readonly<{ status: 'preview' | 'applied' | 'unchanged' }>> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) refuse('CODING_TEMPLATE_INPUT_INVALID');
  const request = parsed.data;
  // alpha.55.1 (Astra 2752): an apply is the person's act — the witness first, before any read, discovery, principal or write; preview stays open.
  if (request.apply) await assertConfigPersonWitness('set', 'admission.registry', ports.witness);
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
  discovery: discoveryModeSchema.optional() }).strict();
export type InitialRegistryRequest = z.infer<typeof initializeSchema>;
const authoredRegistry = (document: Record<string, unknown>) => {
  // Authored presence, including malformed/empty/null values, must never be mistaken for an absent registry.
  const admission = document['admission'];
  return !!admission && typeof admission === 'object' && Object.hasOwn(admission, 'registry');
};
function initialSource(snapshot: ConfigSnapshot, request: InitialRegistryRequest, existing = false) {
  if (!existing && [snapshot.global, snapshot.project].some(authoredRegistry)) refuse('INITIAL_REGISTRY_EXISTS');
  const admission = snapshot.effective.admission;
  if (!existing && admission && (admission.poolId !== request.poolId || admission.executionSlots !== request.executionSlots || admission.inFlightSlots !== request.inFlightSlots)) refuse('INITIAL_REGISTRY_CONFIG_CONFLICT');
  const scope = snapshot.effective.service.identity?.scopeId ?? (snapshot.effective['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  if (scope !== request.scopeId) refuse('INITIAL_REGISTRY_CONFIG_CONFLICT');
  const settings = snapshot.effective.execution?.docker;
  if (!settings) refuse(existing ? 'INITIAL_REGISTRY_EXISTS' : 'CODING_TEMPLATE_IMAGE_REQUIRED');
  return settings;
}
type DockerSettings = NonNullable<DeckentConfig['execution']>['docker'];
/** The first registry for one detected CLI version: one profile, one kind, the default evaluators; deterministic revision. */
function initialRegistry(request: InitialRegistryRequest, settings: DockerSettings, cliVersion: string, template: NativeTemplatePorts['template']) {
  const { executable, ...resources } = settings; void executable;
  let profile: ExecutionProfileDefinition;
  try { profile = template(resources, { provider: request.provider, cliVersion,
    ...(request.discovery ? { discovery: { schemaVersion: 1, mode: request.discovery } } : {}), permissionMode: 'unattended' }); }
  catch (error) { discoveryRefusal(error, request.provider, 'INITIAL_REGISTRY_CLI_UNAVAILABLE'); }
  const kind = { kind: request.kind, profile: { id: profile.id, version: profile.version } };
  const content = { schemaVersion: 1, profiles: [profile], kinds: [kind], evaluators: initialRegistryDefaults.evaluators };
  return { profile, kind, registry: executionRegistrySchema.parse({ ...content, revision: `initial-registry-${sha256(JSON.stringify(content))}` }) };
}
/** I-S6: a project registry equal to what this request would write (rebuilt from its own recorded CLI version, so no new probe) is
 * `current`; any other authored registry, or one in the global layer, keeps the `INITIAL_REGISTRY_EXISTS` refusal before any write. */
function currentRegistry(snapshot: ConfigSnapshot, request: InitialRegistryRequest, template: NativeTemplatePorts['template']) {
  if (authoredRegistry(snapshot.global)) refuse('INITIAL_REGISTRY_EXISTS');
  if (!authoredRegistry(snapshot.project)) return null;
  const settings = initialSource(snapshot, request, true);
  const existing = executionRegistrySchema.safeParse((snapshot.project['admission'] as { registry?: unknown }).registry);
  const invocation = existing.success && existing.data.profiles.length === 1 ? existing.data.profiles[0]!.parameters['invocation'] as { cliVersion?: unknown } | undefined : undefined;
  if (typeof invocation?.cliVersion !== 'string') refuse('INITIAL_REGISTRY_EXISTS');
  let candidate: ReturnType<typeof initialRegistry>;
  try { candidate = initialRegistry(request, settings, invocation.cliVersion, template); } catch { refuse('INITIAL_REGISTRY_EXISTS'); }
  const admission = snapshot.effective.admission;
  const equal = JSON.stringify(existing.data) === JSON.stringify(candidate.registry) && admission?.poolId === request.poolId
    && admission.executionSlots === request.executionSlots && admission.inFlightSlots === request.inFlightSlots && admission.ordering === initialRegistryDefaults.ordering;
  if (!equal) refuse('INITIAL_REGISTRY_EXISTS');
  return candidate;
}
/** Bootstrap only: discovery is a port observation, and the existing config application remains the sole durable writer. */
export async function initializeNativeRegistry(input: unknown, ports: NativeTemplatePorts) {
  const parsed = initializeSchema.safeParse(input);
  if (!parsed.success) refuse('CODING_TEMPLATE_INPUT_INVALID');
  const request = parsed.data;
  // alpha.55.1 (Astra 2752): the witness before the snapshot and the discovery probe (a container), so a refused apply starts nothing.
  if (request.apply) await assertConfigPersonWitness('set', 'admission', ports.witness);
  const read = await ports.snapshot();
  const current = currentRegistry(read, request, ports.template);
  if (current) return { schemaVersion: 1 as const, ...current, expect: read.digest, status: 'current' as const, write: null };
  const settings = initialSource(read, request);
  const cliVersion = await ports.detect(request.provider, settings);
  const { profile, kind, registry } = initialRegistry(request, settings, cliVersion, ports.template);
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
