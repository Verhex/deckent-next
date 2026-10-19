import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { FIRST_RUN_POLICY_TEMPLATE_VERSION } from '#domain/index.js';
import { LOCALES, NODE_ENGINE_RANGE, assessNodeSupport, envValue, isWslHost, loadConfig, loadConfigLanguage, productResourcePath, type Locale } from '#platform/index.js';
import { SETUP_PLAN_SCHEMA_VERSION, SetupStageRegistry, type SetupObservation } from '#engine/index.js';
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
 * Read-only observation for the Core stages from the handlers this CLI already has (I-S4 bridge until I-S2/I-S3 provide `observeSetup`).
 * It writes nothing: configuration is read with `heal: false`; what it cannot read is reported in the state that offers no operation
 * (`check: not-run`, no sandbox self-test, no model). A pending installation journal is `pending`; any other configuration error is thrown
 * as its own typed error, never guessed around.
 */
export async function observeSetup(context: SetupCommandContext, root: string, flagLanguage: string | undefined): Promise<Readonly<{ observation: SetupObservation; registry: SetupStageRegistry }>> {
  const env = context.env ?? process.env, options = { env };
  if (context.observeSetup) return context.observeSetup(root, options);
  const platform = process.platform === 'linux' ? isWslHost('linux', env) ? 'wsl' : 'linux' : process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'macos' : 'other';
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null, pending = false;
  try { config = await loadConfig(root, { env, heal: false }); }
  catch (error) { if (errorCode(error) !== 'BOOTSTRAP_INSTALLATION_INCOMPLETE') throw error; pending = true; }
  const terminal = (config as Record<string, unknown> | null)?.['terminal'] as { scopeId?: unknown } | undefined;
  const policyFile = config ? await exists(productResourcePath(config.productLayout, 'policy')) : false;
  const template = config && context.inspectPolicyTemplate ? await context.inspectPolicyTemplate(root, options) : null;
  const policy = pending ? 'pending' : template ? template.version < FIRST_RUN_POLICY_TEMPLATE_VERSION ? 'upgradable' : 'current' : policyFile ? 'hand-built' : 'absent';
  const realm = context.inspectShellRealm && !pending ? await context.inspectShellRealm(root, options).catch(() => null) : null;
  const catalog = (config as Record<string, unknown> | null)?.['provider_catalog'] as { providers?: unknown } | null | undefined;
  const instructions = context.openProjectInstructions && !pending ? await context.openProjectInstructions(root, options)
    .then(port => port.preview([], projectSkeleton('en'))).catch(() => null) : null;
  const observation: SetupObservation = { schemaVersion: SETUP_PLAN_SCHEMA_VERSION,
    environment: { platform, node: assessNodeSupport(process.version, NODE_ENGINE_RANGE).status === 'unsupported' ? 'below-floor' : 'supported' },
    language: { configured: locale(await loadConfigLanguage(root, options).catch(() => undefined)),
      requested: locale(flagLanguage) ?? locale(envValue(env, 'DECKENT_LANGUAGE')) ?? locale(envValue(env, 'DECKENT_LANG')),
      system: [envValue(env, 'LC_ALL'), envValue(env, 'LC_MESSAGES'), envValue(env, 'LANG')].map(locale).find(value => value !== null) ?? null },
    folder: { installation: pending ? 'pending' : policyFile ? 'present' : 'none', homeRoot: resolve(root) === resolve(homedir()),
      configuredScope: typeof terminal?.scopeId === 'string' && terminal.scopeId ? terminal.scopeId : null, suggestedScope: suggestScope(root) },
    profile: { available: (context.listIdentityProfiles?.([]).profiles ?? []).map(entry => ({ id: entry.definition.id, version: entry.definition.version })) },
    policy: { state: policy },
    sandbox: { realm: realm?.selected === 'bubblewrap' || realm?.selected === 'landlock' ? realm.selected : 'none', selfTest: realm?.selfTest?.status ?? 'not-run',
      usernsRestricted: realm?.rejected.some(row => row.restricted) ?? false },
    model: { connections: Array.isArray(catalog?.providers) ? catalog.providers.length : 0 },
    check: { state: 'not-run' },
    families: instructions ? { instructions: projectInstructionFacts(instructions) } : {} };
  return { observation, registry: new SetupStageRegistry([PROJECT_INSTRUCTION_SETUP_FAMILY]) };
}
