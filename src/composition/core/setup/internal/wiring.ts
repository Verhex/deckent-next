import { randomUUID } from 'node:crypto';
import { codingSetupFamily, detectCodingFacts, detectExecutionFacts, dockerInstallOffer, executionSetupFamily, nativeProviderSpec } from '#adapters/index.js';
import type { SetupStage } from '#engine/index.js';
import { loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { doctorVerdict, loadSetupSurface, type KernelCommandContext } from '#surfaces/index.js';
import { applyPolicyTemplateInstallationWithSecretDefault, previewPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { inspectConfiguredShellRealm } from '#composition/core/agent-turn/index.js';
import { installExecutionEnvironment } from './install.js';

type Options = ConfigLoadOptions & Readonly<{ person?: boolean; language?: string; scopeId?: string }>;
type Status = 'applied' | 'refused' | 'not-wired';
const failure = (error: unknown) => { const code = (error as { code?: unknown } | null)?.code; return typeof code === 'string' ? code : 'SETUP_STAGE_FAILED'; };

/**
 * I-S3: bare `deckent init`'s observation and apply port over the CLI host (the same handlers every command gets). Observation: the Core
 * facts and the instructions family from the surface reader, I-S2's execution and coding detection (I-D2's install offer only when a person
 * answers in the window), and the final check from doctor's own measurement (heal:false; its grouped rows: error → errors, warning → warnings)
 * once permissions exist. Apply: each stage's existing owner; owners that take the terminal (Docker, bridges, model connect, upgrade, the
 * human doctor) run in the surface after the window closed, so here they are refused (TERMINAL_TTY_REQUIRED) and never half-run; the
 * surface reaches I-D2's foreground install through `installExecutionEnvironment`.
 */
export function configuredSetup(host: object) {
  // The doctor verdict (its grouped rows, read-only); in an observation a measurement that cannot run is "not run", never a guess.
  const verdict = (env: NodeJS.ProcessEnv, root: string) => doctorVerdict(root, { ...host, env } as KernelCommandContext, { env });
  const observeSetup = async (root: string, options: Options) => {
    const env = options.env ?? process.env, config = await loadConfig(root, { env, heal: false }).catch(() => null);
    const credential = (id: string) => { try { return nativeProviderSpec(id as Parameters<typeof nativeProviderSpec>[0]); } catch { return null; } };
    const [execution, coding] = await Promise.all([detectExecutionFacts({ env }),
      detectCodingFacts({ root, env, workTargets: config?.execution?.workTargets?.targets.map(target => target.path) ?? [], ports: { credential } })]);
    const observed = await (await loadSetupSurface()).observeCoreSetup({ ...host, env }, root, options.language, {
      packages: [executionSetupFamily({ install: dockerInstallOffer(options.person === true) }), codingSetupFamily()], facts: { execution, coding } });
    const installed = ['current', 'upgradable', 'hand-built'].includes(observed.observation.policy.state);
    return { ...observed, observation: { ...observed.observation, check: { state: installed ? await verdict(env, root).catch(() => 'not-run' as const) : 'not-run' as const } } };
  };
  const applySetupStage = async (root: string, stage: SetupStage, options: Options) => {
    const op = stage.operation?.id ?? '-', input = stage.operation?.input ?? {}, scopeId = String(input['scopeId'] ?? options.scopeId ?? '');
    const result = (status: Status, code?: string) => ({ stage: stage.id, operation: op, status, ...(code ? { code } : {}) });
    const config = async (keyPath: string, value: unknown) => createConfiguredConfigApplication(root, options).set({ keyPath, value, layer: 'project',
      principal: await resolveConfiguredConfigPrincipal(root, scopeId, options), scopeId, commandId: randomUUID() });
    try {
      if (op === 'installation.policy-template') {
        // The owner's own preview first (the same deterministic plan the apply journals), then the journaled first-run install.
        await previewPolicyTemplateInstallation(root, scopeId, options);
        const { status } = await applyPolicyTemplateInstallationWithSecretDefault(root, scopeId, options);
        return status === 'installed' || status === 'replayed' ? result('applied') : result('refused', status);
      }
      if (op === 'config.set') { await config(String(input['keyPath']), input['value']); return result('applied'); }
      // The team or enterprise selection (template data, never authority); distribution stays `deckent identity distribute` with its card.
      if (op === 'identity-profile.preview') { await config('identity.profile', input['profile']); return result('applied'); }
      if (op === 'shell-realm.inspect') { await inspectConfiguredShellRealm(root, options); return result('applied'); }
      if (op === 'doctor.inspect') { await verdict(options.env ?? process.env, root); return result('applied'); }
      return result('refused', 'TERMINAL_TTY_REQUIRED');
    } catch (error) { return result('refused', failure(error)); }
  };
  return { observeSetup, applySetupStage, installExecutionEnvironment };
}
