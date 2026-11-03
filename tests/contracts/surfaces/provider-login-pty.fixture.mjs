import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFakeCli, FAMILY } from '../../fixtures/native-headless/stream.ts';
import { runHeadlessLogin } from '#adapters/core/native-cli-headless/index.js';
import { shellSandboxCapabilities } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { createElement } from 'react';
import { render } from 'ink';
import { SettingsPanel } from '#surfaces/core/terminal-provider/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { providerPanelPort } from '#surfaces/core/terminal-provider/index.js';
import { PROVIDER_CONNECT_KINDS, providerConnectFamily } from '#adapters/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { loadSiwcWindow } from '#surfaces/core/siwc/index.js';
// Synthetic-person fixture: compiled production windows/port, fixture login and provider I/O; no network or real credentials.
const mode = process.argv[2], locale = mode.endsWith('-tr') ? 'tr' : 'en';
const kinds = PROVIDER_CONNECT_KINDS.map(kind => ({ id: kind.id, labelKey: kind.labelKey, available: kind.available,
  endpointDefault: kind.endpoint.default, endpointEditable: kind.endpoint.editable, endpointChoices: [], keyRequired: kind.key?.required ?? false,
  secretName: kind.key?.secretName ?? null, probePath: kind.probe?.path ?? null, billing: kind.billing, presentation: kind.presentation,
  catalogProviderId: kind.connect?.seed, pull: kind.connect?.pull, connectFamily: providerConnectFamily(kind), seeded: false,
  headlessLogin: Boolean(kind.connect?.personOnly && (kind.connect.adapter === 'native-cli-headless' || kind.connect.headless)) }));
const ref = { providerId: 'fixture', providerVersion: 1, modelId: 'fixture', modelVersion: 1 };
const host = { providerConnect: { kinds, endpoint: text => ({ ok: true, base: text }), probe: async () => ({ outcome: 'ok', httpStatus: 200, key: 'verified' }),
  loginDir: async () => { const owned = join(process.env.HOME, 'fixture-login'); await mkdir(owned, { mode: 0o700, recursive: true }); return { owned }; },
  login: async command => {
    const configDir = command.configDir ?? join(process.env.HOME, 'fixture-login'), bin = join(process.env.HOME, 'fixture-bin');
    await mkdir(bin, { mode: 0o700, recursive: true });
    const generated = await writeFakeCli(bin, { authFromLogin: true, logPath: join(configDir, '.claude.json') }), executable = `${generated}.cjs`;
    // HOME is under the repo's type:module boundary; the existing scripted CLI is CommonJS.
    await rename(generated, executable);
    const result = await runHeadlessLogin({ family: FAMILY, configDir, owned: true, executable, sso: false,
      stateDir: join(process.env.HOME, 'fixture-state'), env: process.env, now: Date.now,
      isolation: async () => (await shellSandboxCapabilities(join(process.env.HOME, 'fixture-sandbox'))).bubblewrap });
    if (result.signedIn) process.stdout.write('\nFIXTURE-CLI-LOGIN: completed (synthetic, no account)\n');
    return result;
  } },
  inspectDelegationPermission: async () => ({ layers: ['global'], decisions: [{ layer: 'global', decision: 'allow', ruleId: 'fixture' }] }),
  connectModel: async () => ({ schemaVersion: 1, status: 'connected', connection: 'fixture', scopeId: 'scope', reference: ref,
    models: [{ reference: ref, nativeId: 'fixture', state: 'connected' }], carriedModels: [], credentialRef: null, keyStored: null, cli: { configDir: process.env.HOME + '/fixture-login', owned: true, delegate: [] }, notCarried: [], steps: {}, tariff: 'unmetered' }),
  inspectInvocableModels: async () => ({ models: [{ reference: ref, nativeId: 'Fixture', availability: { invocable: true, reason: null } }] }),
  siwc: { connection: 'chatgpt-login', execute: async (_root, request) => {
    if (request.operation === 'prepare') return { apiTargets: [] };
    process.stdout.write('\nFIXTURE-OAUTH-CONNECT-REACHED\n'); throw ErrorRegistry.createError('SIWC_STORE_NOT_PERSONAL', { params: { reason: 'unknown-locality' } });
  } } };
const port = providerPanelPort(process.env.HOME, 'scope', host, {}, locale, error => error.message);
const view = createElement(SettingsPanel, { kind: 'provider', ports: { provider: port }, labels: terminalPanelLabels(locale), push: () => {},
  onError: error => process.stdout.write('\nERROR ' + error.code + '\n'), onClose: () => instance.unmount() });
// SIWC is hidden in the public list. Exercise its retained custody refusal explicitly as a beta fixture.
const SiwcWindow = mode.startsWith('chatgpt-') ? (await loadSiwcWindow()).default : null;
if (SiwcWindow) process.stdout.write('K13-HIDDEN-SIWC-BETA: fixture-only\n');
const beta = SiwcWindow ? createElement(SiwcWindow, { port: port.siwc, onClose: () => instance.rerender(view), onApi: () => instance.rerender(view),
  onError: error => process.stdout.write('\nERROR ' + error.code + '\n') }) : view;
const instance = render(beta, { exitOnCtrlC: true, patchConsole: false, interactive: true });
await instance.waitUntilExit();
