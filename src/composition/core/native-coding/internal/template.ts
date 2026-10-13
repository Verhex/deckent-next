import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { executionRegistrySchema, identitySchema, type ExecutionRegistry, type JsonValue } from '#domain/index.js';
import { nativeCliIdSchema, createNativeCodingTemplate } from '#adapters/index.js';
import { affectedToolchainProfiles, registryLayerHold, type ConfigSnapshot, type ConfigWriteResult } from '#engine/index.js';
import { ConfigValidationError, ErrorRegistry, sha256, type ConfigLoadOptions } from '#platform/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal, snapshotConfiguredConfig } from '#composition/core/config/index.js';

const requestSchema = z.object({ provider: nativeCliIdSchema, kind: identitySchema,
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), apply: z.boolean() }).strict();
export type CodingTemplateRequest = z.infer<typeof requestSchema>;
export type CodingTemplateResult = Readonly<{ schemaVersion: 1; status: 'preview' | 'applied' | 'unchanged';
  profile: ExecutionRegistry['profiles'][number]; kind: ExecutionRegistry['kinds'][number]; registry: ExecutionRegistry;
  expect: string | null; write: ConfigWriteResult | null }>;
function refuse(code: string): never { throw ErrorRegistry.createError(code); }

/** Pure proposal from the authored project registry and the effective, validated resource limits. */
function proposal(snapshot: ConfigSnapshot, request: CodingTemplateRequest) {
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
    try { return createNativeCodingTemplate({ ...resourceLimits, imageId }, { provider: request.provider, cliVersion: pin.cliVersion, discovery, permissionMode: 'unattended' }); }
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
export async function configureNativeCodingTemplate(projectRoot: string, input: unknown, options: ConfigLoadOptions = {},
  dependencies: { readonly beforeWrite?: () => void | Promise<void> } = {}): Promise<CodingTemplateResult> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) refuse('CODING_TEMPLATE_INPUT_INVALID');
  const request = parsed.data;
  const read = await snapshotConfiguredConfig(projectRoot, { ...options, heal: false }).catch((error: unknown) => {
    if (error instanceof ConfigValidationError) {
      if (error.issues.some(issue => ['admission.poolId', 'admission.executionSlots', 'admission.inFlightSlots'].includes(issue.path))) refuse('CODING_TEMPLATE_ADMISSION_REQUIRED');
      if (error.issues.some(issue => issue.path === 'execution.docker.imageId')) refuse('CODING_TEMPLATE_IMAGE_REQUIRED');
    }
    throw error;
  });
  const plan = proposal(read, request);
  const result = { schemaVersion: 1 as const, profile: plan.profile, kind: plan.kind, registry: plan.registry, expect: read.digest };
  if (!request.apply || !plan.changed) return { ...result, status: plan.changed ? 'preview' : 'unchanged', write: null };
  const config = read.effective;
  const scopeId = config.service.identity?.scopeId ?? (config['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  if (!scopeId) refuse('TERMINAL_SCOPE_REQUIRED');
  const principal = await resolveConfiguredConfigPrincipal(projectRoot, scopeId, options);
  // Refuse a changed global registry or effective resource source under the writer's lock as well as the project CAS.
  const guard = (current: ConfigSnapshot) => {
    const fresh = proposal(current, request);
    if (JSON.stringify(fresh.profile) !== JSON.stringify(plan.profile)) refuse('CONFIG_CONCURRENT_REVISION_HOLD');
  };
  await dependencies.beforeWrite?.();
  const write = await createConfiguredConfigApplication(projectRoot, options, guard).set({ keyPath: 'admission.registry', value: plan.registry,
    layer: 'project', principal, scopeId, commandId: randomUUID(), expect: read.digest });
  return { ...result, status: 'applied', write };
}
