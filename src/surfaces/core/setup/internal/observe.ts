import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { FIRST_RUN_POLICY_TEMPLATE_VERSION } from '#domain/index.js';
import { LOCALES, NODE_ENGINE_RANGE, assessNodeSupport, envValue, isWslHost, loadConfig, loadConfigLanguage, productResourcePath, type Locale } from '#platform/index.js';
import { SETUP_PLAN_SCHEMA_VERSION, SetupStageRegistry, type SetupFamilyPackage, type SetupObservation } from '#engine/index.js';
import { PROJECT_INSTRUCTION_SETUP_FAMILY, projectInstructionFacts, projectSkeleton } from '#surfaces/core/project-instructions/index.js';
import type { SetupCommandContext } from './contract.js';

const locale = (value: string | undefined): Locale | null => {
  const code = value?.trim().slice(0, 2).toLowerCase();
  return code && (LOCALES as readonly string[]).includes(code) ? code as Locale : null;
};
const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;
/** A scope suggestion from the folder name (lowercase letters, digits, dashes); only ever a default for a person's answer, never applied. */
export function suggestScope(root: string): string | null {
  const value = basename(resolve(root)).toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 63);
  return /^[a-z0-9]/u.test(value) ? value : null;
}
const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * Observation for the Core stages from the handlers this CLI already has. With `context.observeSetup` (I-S3 composition) the composition
 * owns the whole observation: it calls this bridge for the Core facts and the `instructions` family, then adds the detection families and
 * the final check. No project or apply write: configuration is read with `heal: false`; the project-instruction reader may create the
 * HOME instruction-trust directory (existing reader behaviour). What it cannot read is reported in the state that offers no operation
 * (`check: not-run`, no sandbox self-test, no model). A pending installation journal is `pending`; any other configuration error is thrown
 * as its own typed error, never guessed around. `person` (a person answers in the window) is passed on to the composition.
 */
export async function observeSetup(context: SetupCommandContext, root: string, flagLanguage: string | undefined, person = false): Promise<Observed> {
  if (context.observeSetup) return context.observeSetup(root, { env: context.env ?? process.env, person, ...(flagLanguage === undefined ? {} : { language: flagLanguage }) });
  return observeCoreSetup(context, root, flagLanguage);
}
type Observed = Readonly<{ observation: SetupObservation; registry: SetupStageRegistry }>;
/** The Core facts and the instructions family, plus the families a composition detected (`extra`: their packages and facts). */
export async function observeCoreSetup(context: SetupCommandContext, root: string, flagLanguage: string | undefined,
  extra: Readonly<{ packages: readonly SetupFamilyPackage[]; facts: Readonly<Record<string, unknown>> }> = { packages: [], facts: {} }): Promise<Observed> {
  const env = context.env ?? process.env, options = { env };
  const platform = process.platform === 'linux' ? isWslHost('linux', env) ? 'wsl' : 'linux' : process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'macos' : 'other';
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null, pending = false;
  try { config = await loadConfig(root, { env, heal: false }); }
  catch (error) { if (errorCode(error) !== 'BOOTSTRAP_INSTALLATION_INCOMPLETE') throw error; pending = true; }
  const terminal = (config as Record<string, unknown> | null)?.['terminal'] as { scopeId?: unknown } | undefined;
  const scopeId = typeof terminal?.scopeId === 'string' && terminal.scopeId ? terminal.scopeId : null;
  const policyFile = config ? await exists(productResourcePath(config.productLayout, 'policy')) : false;
  const template = config && context.inspectPolicyTemplate ? await context.inspectPolicyTemplate(root, options) : null;
  const policy = pending ? 'pending' : template ? template.version < FIRST_RUN_POLICY_TEMPLATE_VERSION ? 'upgradable' : 'current' : policyFile ? 'hand-built' : 'absent';
  const realm = context.inspectShellRealm && !pending ? await context.inspectShellRealm(root, options).catch(() => null) : null;
  const instructions = context.openProjectInstructions && !pending ? await context.openProjectInstructions(root, options)
    .then(port => port.preview([], projectSkeleton('en'))).catch(() => null) : null;
  const observation: SetupObservation = { schemaVersion: SETUP_PLAN_SCHEMA_VERSION,
    environment: { platform, node: assessNodeSupport(process.version, NODE_ENGINE_RANGE).status === 'unsupported' ? 'below-floor' : 'supported' },
    language: { configured: locale(await loadConfigLanguage(root, options).catch(() => undefined)),
      requested: locale(flagLanguage) ?? locale(envValue(env, 'DECKENT_LANGUAGE')) ?? locale(envValue(env, 'DECKENT_LANG')),
      system: [envValue(env, 'LC_ALL'), envValue(env, 'LC_MESSAGES'), envValue(env, 'LANG')].map(locale).find(value => value !== null) ?? null },
    folder: { installation: pending ? 'pending' : policyFile ? 'present' : 'none', homeRoot: resolve(root) === resolve(homedir()),
      configuredScope: scopeId, suggestedScope: suggestScope(root) },
    profile: { available: (context.listIdentityProfiles?.([]).profiles ?? []).map(entry => ({ id: entry.definition.id, version: entry.definition.version })) },
    policy: { state: policy },
    sandbox: { realm: realm?.selected === 'bubblewrap' || realm?.selected === 'landlock' ? realm.selected : 'none', selfTest: realm?.selfTest?.status ?? 'not-run',
      usernsRestricted: realm?.rejected.some(row => row.restricted) ?? false },
    // Connected models = switched-on models of this scope's catalog (what `models connect` leaves behind); unreadable → none.
    model: { connections: scopeId && context.inspectModelCatalog ? await context.inspectModelCatalog(root, { schemaVersion: 1, scopeId }, options).then(catalog => catalog.channels
      .flatMap(channel => channel.access === 'denied' ? [] : channel.models.filter(entry => entry.activation?.state === 'active')).length, () => 0) : 0 },
    check: { state: 'not-run' },
    families: { ...extra.facts, ...(instructions ? { instructions: projectInstructionFacts(instructions) } : {}) } };
  return { observation, registry: new SetupStageRegistry([PROJECT_INSTRUCTION_SETUP_FAMILY, ...extra.packages]) };
}
