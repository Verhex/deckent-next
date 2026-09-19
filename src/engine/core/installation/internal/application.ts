import { createHash } from 'node:crypto';
import { z } from 'zod';
import { evaluatePolicy, executionRegistrySchema, identitySchema, immutableJsonObjectSchema,
  type EvaluatorDefinition, type ExecutionProfileDefinition, type JsonObject, type Policy } from '#domain/index.js';
import type { ExecutionPool } from '#engine/core/runs/index.js';
import { hashInstallationProfilePayload, installationProfileSchema, profilePayload, type InstallationProfile } from './profile.js';

export type InstallationProfileErrorCode = 'INSTALLATION_PROFILE_INVALID' | 'INSTALLATION_PROFILE_DIGEST'
  | 'INSTALLATION_PROFILE_CONFIG' | 'INSTALLATION_PROFILE_REGISTRY' | 'INSTALLATION_PROFILE_ADAPTER'
  | 'INSTALLATION_PROFILE_EVALUATOR' | 'INSTALLATION_PROFILE_POOL' | 'INSTALLATION_PROFILE_POLICY'
  | 'INSTALLATION_PROFILE_SHUTDOWN' | 'INSTALLATION_PROFILE_PATHS';
export class InstallationProfileError extends Error {
  constructor(readonly code: InstallationProfileErrorCode) { super(code); this.name = 'InstallationProfileError'; }
}

const choicesSchema = z.object({
  principal: z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly(),
  allowShutdown: z.boolean(),
}).strict().readonly();
const neededConfigSchema = z.object({
  execution: z.object({}).passthrough(),
  admission: z.object({ registry: z.unknown(), poolId: identitySchema,
    executionSlots: z.number().int().positive().safe(), inFlightSlots: z.number().int().positive().safe(),
  }).passthrough().nullable(),
  service: z.object({ identity: z.object({ scopeId: identitySchema, serviceId: identitySchema }).strict().nullable() }).passthrough(),
}).passthrough();
const resolvedPathsSchema = z.object({
  config: immutableJsonObjectSchema,
  layout: z.object({ schemaVersion: z.number().int().positive().safe(), revision: identitySchema,
    root: z.string().min(1), bootstrapConfigPath: z.string().min(1) }).strict().readonly(),
  paths: z.record(z.string().min(1)).readonly(),
}).strict().readonly();

export interface InstallationPreviewPorts {
  resolvePaths(projectRoot: string, authoredConfig: JsonObject): Promise<{ readonly config: JsonObject;
    readonly layout: { readonly schemaVersion: number; readonly revision: string; readonly root: string; readonly bootstrapConfigPath: string };
    readonly paths: Readonly<Record<string, string>> }>;
  validateProfile(profile: ExecutionProfileDefinition): { readonly imageId: string };
  validateEvaluator(evaluator: EvaluatorDefinition): undefined;
}
export interface InstallationPreviewChoices { readonly principal: { readonly issuer: string; readonly subject: string }; readonly allowShutdown: boolean }
export interface InstallationPreview {
  readonly schemaVersion: 1;
  readonly status: 'preview';
  readonly scopeId: string;
  readonly principal: { readonly issuer: string; readonly subject: string };
  readonly planDigest: string;
  readonly profile: { readonly id: string; readonly version: number; readonly digest: string; readonly integrity: 'verified' };
  readonly layout: { readonly schemaVersion: number; readonly revision: string; readonly root: string; readonly bootstrapConfigPath: string };
  readonly paths: Readonly<Record<string, string>>;
  readonly policy: Policy;
  readonly pool: ExecutionPool;
  readonly registry: { readonly revision: string; readonly kinds: readonly { readonly kind: string; readonly profile: { readonly id: string; readonly version: number } }[]; readonly profiles: readonly { readonly id: string; readonly version: number;
    readonly adapter: { readonly id: string; readonly version: number } }[]; readonly evaluators: readonly { readonly id: string;
    readonly version: number; readonly implementation: { readonly id: string; readonly version: number } }[] };
  readonly images: readonly { readonly profileId: string; readonly version: number; readonly imageId: string }[];
  readonly shutdown: { readonly enabled: boolean; readonly serviceIdentity: { readonly scopeId: string; readonly serviceId: string } | null;
    readonly grantRuleId: string | null };
  readonly blockers: readonly ['INSTALL_PACKAGE_TRUST_UNVERIFIED', 'INSTALL_IMAGE_PROVENANCE_UNVERIFIED', 'INSTALL_IMAGE_AVAILABILITY_UNCHECKED'];
}

/** Private recovery material. Never render this configuration snapshot through a surface. */
export interface InstallationMaterial {
  readonly schemaVersion: 1;
  readonly authoredProfile: InstallationProfile;
  readonly configuration: JsonObject;
  readonly layout: InstallationPreview['layout'];
  readonly paths: InstallationPreview['paths'];
  readonly principal: InstallationPreview['principal'];
  readonly allowShutdown: boolean;
  readonly planDigest: string;
}
export interface PreparedInstallation {
  readonly preview: InstallationPreview;
  readonly material: InstallationMaterial;
}

function canonical(input: unknown): string {
  const parsed = immutableJsonObjectSchema.safeParse(input);
  if (!parsed.success) throw new InstallationProfileError('INSTALLATION_PROFILE_INVALID');
  return JSON.stringify(parsed.data);
}
function digest(input: unknown): string { return createHash('sha256').update(`deckent.installation-plan.v1\n${canonical(input)}`, 'utf8').digest('hex'); }
function includes(values: 'all' | readonly string[], value: string) { return values === 'all' || values.includes(value); }

export class InstallationPreviewApplication {
  constructor(private readonly ports: InstallationPreviewPorts) {
    if (!ports || typeof ports.resolvePaths !== 'function' || typeof ports.validateProfile !== 'function'
      || typeof ports.validateEvaluator !== 'function') throw new InstallationProfileError('INSTALLATION_PROFILE_INVALID');
  }

  async preview(projectRoot: string, supplied: unknown, inputChoices: InstallationPreviewChoices): Promise<InstallationPreview> {
    return (await this.prepare(projectRoot, supplied, inputChoices)).preview;
  }

  async prepare(projectRoot: string, supplied: unknown, inputChoices: InstallationPreviewChoices): Promise<PreparedInstallation> {
    const safeProfile = immutableJsonObjectSchema.safeParse(supplied), safeChoices = immutableJsonObjectSchema.safeParse(inputChoices);
    if (!safeProfile.success || !safeChoices.success) throw new InstallationProfileError('INSTALLATION_PROFILE_INVALID');
    const parsed = installationProfileSchema.safeParse(safeProfile.data), choices = choicesSchema.safeParse(safeChoices.data);
    if (!parsed.success || !choices.success || typeof projectRoot !== 'string' || !projectRoot) throw new InstallationProfileError('INSTALLATION_PROFILE_INVALID');
    const profile = parsed.data, payload = profilePayload(profile);
    if (profile.profile.digest !== hashInstallationProfilePayload(payload)) throw new InstallationProfileError('INSTALLATION_PROFILE_DIGEST');
    if (profile.shutdown.enabled !== choices.data.allowShutdown) throw new InstallationProfileError('INSTALLATION_PROFILE_SHUTDOWN');

    let rawResolved;
    try { rawResolved = await this.ports.resolvePaths(projectRoot, profile.configuration); }
    catch { throw new InstallationProfileError('INSTALLATION_PROFILE_CONFIG'); }
    const parsedResolved = resolvedPathsSchema.safeParse(rawResolved);
    if (!parsedResolved.success) throw new InstallationProfileError('INSTALLATION_PROFILE_PATHS');
    const resolved = parsedResolved.data;
    const config = neededConfigSchema.safeParse(resolved.config);
    if (!config.success || !config.data.admission) throw new InstallationProfileError('INSTALLATION_PROFILE_CONFIG');
    const registry = executionRegistrySchema.safeParse(config.data.admission.registry);
    if (!registry.success) throw new InstallationProfileError('INSTALLATION_PROFILE_REGISTRY');
    if (config.data.admission.poolId !== profile.pool.poolId
      || config.data.admission.executionSlots > profile.pool.capacity.executionSlots
      || config.data.admission.inFlightSlots > profile.pool.capacity.inFlightSlots) {
      throw new InstallationProfileError('INSTALLATION_PROFILE_POOL');
    }
    const images: { profileId: string; version: number; imageId: string }[] = [];
    try { for (const definition of registry.data.profiles) images.push(Object.freeze({ profileId: definition.id,
      version: definition.version, imageId: identitySchema.parse(this.ports.validateProfile(definition).imageId) })); }
    catch { throw new InstallationProfileError('INSTALLATION_PROFILE_ADAPTER'); }
    try { for (const evaluator of registry.data.evaluators) if (this.ports.validateEvaluator(evaluator) !== undefined) throw new Error('invalid'); }
    catch { throw new InstallationProfileError('INSTALLATION_PROFILE_EVALUATOR'); }

    const actor = { id: 'installation-preview', ...choices.data.principal, assurance: 'os-user' as const, scopeIds: [profile.scopeId] };
    const poolGrant = profile.policy.grants.find(rule => rule.effect === 'allow' && rule.actions !== 'all' && rule.actions.includes('use')
      && rule.scopes !== 'all' && rule.scopes.includes(profile.scopeId) && rule.principals !== 'all'
      && rule.principals.some(value => value.issuer === actor.issuer && value.subject === actor.subject)
      && rule.resource.kind === 'pool' && rule.resource.ids !== 'all' && rule.resource.ids.includes(profile.pool.poolId));
    let poolDecision;
    try { poolDecision = evaluatePolicy(profile.policy, { principal: actor, scopeId: profile.scopeId,
      action: 'use', resource: { kind: 'pool', id: profile.pool.poolId } }); }
    catch { throw new InstallationProfileError('INSTALLATION_PROFILE_POLICY'); }
    if (!poolGrant || poolDecision.decision !== 'allow') throw new InstallationProfileError('INSTALLATION_PROFILE_POLICY');

    const service = config.data.service.identity;
    const matchingShutdown = profile.policy.grants.filter(rule => rule.effect === 'allow'
      && includes(rule.actions, 'shutdown') && includes(rule.scopes, profile.scopeId)
      && (rule.principals === 'all' || rule.principals.some(value => value.issuer === actor.issuer && value.subject === actor.subject))
      && rule.resource.kind === 'service');
    let shutdownRuleId: string | null = null;
    if (!choices.data.allowShutdown) {
      if (matchingShutdown.length > 0) throw new InstallationProfileError('INSTALLATION_PROFILE_SHUTDOWN');
    } else {
      const narrow = service && service.scopeId === profile.scopeId && matchingShutdown.filter(rule => rule.actions !== 'all'
        && rule.actions.length === 1 && rule.actions[0] === 'shutdown' && rule.scopes !== 'all' && rule.scopes.length === 1
        && rule.scopes[0] === service.scopeId && rule.principals !== 'all' && rule.principals.length === 1
        && rule.principals[0]?.issuer === actor.issuer && rule.principals[0]?.subject === actor.subject
        && rule.resource.ids !== 'all' && rule.resource.ids.length === 1 && rule.resource.ids[0] === service.serviceId);
      if (!service || !narrow || narrow.length !== 1 || matchingShutdown.length !== 1) throw new InstallationProfileError('INSTALLATION_PROFILE_SHUTDOWN');
      const shutdownGrant = narrow[0];
      if (!shutdownGrant) throw new InstallationProfileError('INSTALLATION_PROFILE_SHUTDOWN');
      let decision;
      try { decision = evaluatePolicy(profile.policy, { principal: actor, scopeId: service.scopeId,
        action: 'shutdown', resource: { kind: 'service', id: service.serviceId } }); }
      catch { throw new InstallationProfileError('INSTALLATION_PROFILE_SHUTDOWN'); }
      if (decision.decision !== 'allow' || decision.ruleId !== shutdownGrant.id) throw new InstallationProfileError('INSTALLATION_PROFILE_SHUTDOWN');
      shutdownRuleId = shutdownGrant.id;
    }
    const registryReferences = Object.freeze({ revision: registry.data.revision,
      kinds: Object.freeze(registry.data.kinds.map(value => Object.freeze({ kind: value.kind, profile: Object.freeze({ ...value.profile }) }))),
      profiles: Object.freeze(registry.data.profiles.map(value => Object.freeze({ id: value.id, version: value.version, adapter: value.adapter }))),
      evaluators: Object.freeze(registry.data.evaluators.map(value => Object.freeze({ id: value.id, version: value.version, implementation: value.implementation }))) });
    const planDigest = digest({ schemaVersion: 1, profileDigest: profile.profile.digest, principal: choices.data.principal,
      allowShutdown: choices.data.allowShutdown, config: resolved.config, layout: resolved.layout, paths: resolved.paths });
    const preview = Object.freeze({ schemaVersion: 1 as const, status: 'preview' as const, scopeId: profile.scopeId, principal: choices.data.principal, planDigest,
      profile: Object.freeze({ ...profile.profile, integrity: 'verified' as const }), layout: resolved.layout, paths: resolved.paths,
      policy: profile.policy, pool: Object.freeze({ ...profile.pool, capacity: Object.freeze({ ...profile.pool.capacity }) }), registry: registryReferences, images: Object.freeze(images),
      shutdown: Object.freeze({ enabled: choices.data.allowShutdown, serviceIdentity: service ? Object.freeze({ ...service }) : null, grantRuleId: shutdownRuleId }),
      blockers: Object.freeze(['INSTALL_PACKAGE_TRUST_UNVERIFIED', 'INSTALL_IMAGE_PROVENANCE_UNVERIFIED', 'INSTALL_IMAGE_AVAILABILITY_UNCHECKED'] as const) });
    return Object.freeze({ preview, material: Object.freeze({ schemaVersion: 1 as const, authoredProfile: profile,
      configuration: resolved.config, layout: resolved.layout, paths: resolved.paths, principal: choices.data.principal,
      allowShutdown: choices.data.allowShutdown, planDigest }) });
  }
}
