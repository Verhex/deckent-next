// Synthetic-person: compiled product windows/ports and the shipped registry, fixture I/O only. No account, token or network.
import { createElement } from 'react';
import { render } from 'ink';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerPanelPort, SettingsPanel } from '#surfaces/core/terminal-provider/index.js';
import { loadOnboardingProvider } from '#surfaces/core/terminal-onboarding/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { PROVIDER_CONNECT_KINDS, providerConnectFamily } from '#adapters/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
const mode = process.argv[2], locale = mode.endsWith('-tr') ? 'tr' : 'en';
const kinds = PROVIDER_CONNECT_KINDS.map(kind => ({ id: kind.id, labelKey: kind.labelKey, available: kind.available,
  endpointDefault: kind.endpoint.default, endpointEditable: kind.endpoint.editable, endpointChoices: [], keyRequired: kind.key?.required ?? false,
  secretName: kind.key?.secretName ?? null, probePath: kind.probe?.path ?? null, billing: kind.billing, presentation: kind.presentation,
  catalogProviderId: kind.connect?.seed, pull: kind.connect?.pull, connectFamily: providerConnectFamily(kind), seeded: false,
  terminalTextChat: Boolean(kind.connect?.headless || kind.connect?.terminalTextChat),
  headlessLogin: Boolean(kind.connect?.personOnly && (kind.connect.adapter === 'native-cli-headless' || kind.connect.headless)) }));
const host = {
  providerConnect: { kinds, endpoint: () => ({ ok: false, reason: 'unused' }), probe: async () => { throw new Error('NO_NETWORK'); },
    loginMethods: connection => nativeCliAgent(kinds.find(kind => kind.id === connection)?.connectFamily)?.agent.loginMethods.map(row => row.method) ?? [],
    loginDir: async () => ({ owned: join(process.env.DECKENT_GLOBAL_HOME, 'synthetic-login') }),
    login: async command => {
      await appendFile(process.env.K13_REQUESTS, JSON.stringify(command) + '\n');
      process.stdout.write('\nK13-SYNTHETIC-LOGIN: ' + command.loginMethod + '\n');
      return { configDir: join(process.env.DECKENT_GLOBAL_HOME, 'synthetic-login'), owned: true, exit: 'completed', signedIn: true, authMethod: null, subscriptionType: null };
    } },
  inspectDelegationPermission: async () => ({ layers: ['global'], decisions: [{ layer: 'global', decision: 'allow', ruleId: 'fixture' }] }),
  connectModel: async (_root, command) => {
    const reference = { providerId: command.connection, providerVersion: 1, modelId: 'fixture-model', modelVersion: 1 };
    return { schemaVersion: 1, operation: 'models.connect', status: 'connected', connection: command.connection, scopeId: 'scope', reference,
      models: [{ reference, nativeId: 'fixture-model', state: 'connected' }], carriedModels: [], notCarried: [], credentialRef: null, keyStored: null,
      cli: { configDir: join(process.env.DECKENT_GLOBAL_HOME, 'synthetic-login'), owned: true, delegate: [] },
      steps: { catalog: 'present', declaration: 'skipped', profile: 'written', activation: 'present', carried: 0 }, tariff: 'unmetered', approval: null, service: 'current' };
  },
};
const port = providerPanelPort(process.cwd(), 'scope', host, { env: process.env }, locale, error => error.message);
const labels = terminalPanelLabels(locale);
if (mode.startsWith('onboarding')) {
  const { runOnboardingProvider } = await loadOnboardingProvider();
  await runOnboardingProvider(port, labels, kinds.filter(kind => kind.headlessLogin).map(kind => kind.id), { locale, root: process.cwd(), env: process.env,
    stdout: process.stdout, stdin: process.stdin });
} else {
  const view = createElement(SettingsPanel, { kind: 'provider', ports: { provider: port }, labels, push: () => {},
    onError: error => process.stdout.write('\nERROR ' + error.code + '\n'), onClose: () => instance.unmount() });
  const instance = render(view, { exitOnCtrlC: true, patchConsole: false, interactive: true });
  await instance.waitUntilExit();
}
