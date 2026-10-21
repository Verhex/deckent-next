/**
 * PRE-8 `/provider` first-use card on a real pseudo-terminal (lead 2026-10-21). The built `/provider` window (SettingsPanel), the built panel port
 * (`providerPanelPort`) with the shipped card port and the composition's REAL offer, REAL governed grant and REAL credential resolver; only the
 * provider's model listing is a stand-in that reads the key through the real resolver (no network, no model call). Run after `npm run build`.
 * env PRE8_E2E_ROOT; argv[2] locale.
 */
import { join } from 'node:path';
import { createElement } from 'react';
import { render } from 'ink';
import { SettingsPanel } from '#surfaces/core/terminal-panels/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { providerPanelPort, secretGrantCardPort } from '#surfaces/core/cli-terminal/index.js';
import { terminalSecretGrantOffer } from '#composition/core/terminal-chat/index.js';
import { assertConfiguredProjectCredential, changeProjectSecretGrant, projectCredentialResolver } from '#composition/core/secrets/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { registerProviderConfig } from '#adapters/index.js';

registerProviderConfig();
const root = process.env['PRE8_E2E_ROOT'], locale = process.argv[2] ?? 'en', scope = 'scope-a';
const projectRoot = join(root, 'project'), home = join(root, 'home');
const options = { env: { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') } };
const KEY = 'DECKENT_FIXTURE_KEY';
const kind = { id: 'fixture-remote', labelKey: 'tui.provider.kind.openrouter', available: true, endpointDefault: 'https://provider.invalid', endpointEditable: false, keyRequired: true,
  secretName: KEY, probePath: null, endpointChoices: [], catalogProviderId: null, connectFamily: 'openai-chat-completions', seeded: false, priceRequired: false };
const host = {
  // The "connect a model" action is offered where the host binds models; this proof stops at the model list (nothing is bound).
  connectModel: async () => { throw new Error('NOT_REACHED'); },
  // The key is already in the main vault (the parent seeded it); storing again only answers like the runtime service would (name and backend).
  setSecret: async (_where, input) => ({ schemaVersion: 1, scopeId: input.scopeId, name: input.name, action: 'set', backend: 'core.secret-store.encrypted-file@1', removed: null }),
  listSecretNames: async () => ({ schemaVersion: 1, backend: 'core.secret-store.encrypted-file@1', names: [KEY] }),
  providerConnect: { kinds: [kind], endpoint: text => ({ ok: true, base: text }), probe: async () => ({ outcome: 'ok', httpStatus: 200, key: 'verified' }), legacyKeys: [],
    // The provider's free model list, reached only with the key: the key is read through the REAL project credential resolver.
    discoverModels: async (where, scopeId, _kind, _endpoint, loaded) => {
      const value = await projectCredentialResolver(await loadConfiguredScopeContext(where, scopeId, loaded, 'read'), scopeId, loaded).resolve(KEY);
      return [{ nativeId: 'fixture-model', displayName: `FIXTURE-MODEL-AFTER-GRANT len=${value?.length ?? 0}`, priced: true }];
    } },
};
const card = secretGrantCardPort(projectRoot, scope, options, locale, { offer: (where, loaded) => terminalSecretGrantOffer(where, loaded),
  grant: (where, scopeId, name, loaded) => changeProjectSecretGrant(where, scopeId, name, 'grant', 'card', loaded).then(() => {}),
  check: (where, scopeId, name, loaded) => assertConfiguredProjectCredential(where, scopeId, name, loaded) }, home);
const port = providerPanelPort(projectRoot, scope, host, options, locale, error => `ERR:${error?.code ?? 'error'} ${error?.suggestion ?? ''}`, card);
const notices = [];
const view = createElement(SettingsPanel, { kind: 'provider', ports: { provider: port }, labels: terminalPanelLabels(locale),
  push: items => { notices.push(...items); }, onError: error => { process.stdout.write(`\nNOTICE ERR:${error?.code ?? 'error'} ${error?.suggestion ?? ''}\n`); },
  errorText: error => String(error?.code ?? error), openApproval: () => {}, onClose: () => { process.stdout.write('\nCLOSED\n'); instance.unmount(); } });
// Ink 7 defers every frame under CI (is-in-ci) even on a TTY; the product terminal passes `interactive: true` on a TTY (workline.tsx), so does this PTY fixture.
const instance = render(view, { exitOnCtrlC: true, patchConsole: false, interactive: true });
await instance.waitUntilExit();
