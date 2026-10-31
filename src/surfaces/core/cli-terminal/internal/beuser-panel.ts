import { join } from 'node:path';
import limits from '../../../../../assets/beuser/limits.json' with { type: 'json' };
import controller from '../../../../../assets/beuser/controller.json' with { type: 'json' };
import { ErrorRegistry, globalStateRoot, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { configPanelPort, terminalConfigWrite } from '#surfaces/core/config/index.js';
import { beuserPanelPort, type BeuserLimitKey } from '#surfaces/core/terminal-beuser/index.js';
import type { TerminalLaunchContext } from './context.js';

/** Human /beuser only: inspect the private controller; writes retain its principal, scope, policy and approval path. */
export function configuredBeuserPanelPort(context: TerminalLaunchContext, options: ConfigLoadOptions, locale: Locale) {
  const root = () => { const state = globalStateRoot(options.env ?? process.env); if (!state) throw ErrorRegistry.createError('CLI_USAGE'); return join(state, controller.folder); };
  const ceiling = limits.profiles.at(-1)!;
  const keys: readonly BeuserLimitKey[] = ['maxWallMs', 'maxReruns', 'maxSteps', 'maxCost'];
  return beuserPanelPort({ inspect: () => context.inspectBeuserMonitor!(options),
    ...(context.configApplication && context.resolveConfigPrincipal ? {
      async limitConfig() {
        const app = context.configApplication!(root(), { ...options, heal: false });
        if (!(await app.explain({ keyPath: 'terminal.scopeId' })).value) return null;
        const snapshot = await app.inspectValue({ keyPath: 'beuser.limits', layer: 'project' });
        const fields = (await configPanelPort(root(), context, options, locale).inspect()).fields;
        const overrides = snapshot.effective as Partial<Record<BeuserLimitKey, number>>;
        const values = Object.fromEntries(keys.map(key => [key, overrides[key] ?? ceiling[key]])) as Record<BeuserLimitKey, number>;
        return { root: root(), expect: snapshot.digest, values, currency: ceiling.currency, revision: ceiling.revision,
          source: keys.some(key => values[key] < ceiling[key]) ? 'config' as const : 'code' as const,
          presets: keys.flatMap(key => { const field = fields.find(row => row.key === `beuser.limits.${key}`);
            return (field?.choices ?? []).flatMap(choice => typeof choice.value === 'number' && choice.value < values[key] ? [{ key, value: choice.value }] : []); }) };
      },
      writeLimit: (key: BeuserLimitKey, value: number, expect: string | null) => terminalConfigWrite(root(),
        { action: 'set', keyPath: `beuser.limits.${key}`, value, layer: 'project', expect }, context, options, locale),
    } : {}),
  }, locale);
}
