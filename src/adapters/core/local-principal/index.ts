import authenticators from './internal/authenticators.json' with { type: 'json' };
/** Published declarations stay self-contained: the inventory type is inlined, never a reference to the JSON file. */
export const LOCAL_AUTHENTICATOR_INVENTORY = authenticators;
export { LocalOsPrincipalVerifier, readLocalOsIdentity } from './internal/local.js';
export { LocalOsSessionAuthority } from './internal/session.js';
export { localPrincipalChannel, localPrincipalPeer, withMcpPrincipal, withLocalPrincipalChannel } from './internal/channel.js';
export { attestLocalInteractiveTerminal, captureLocalInteractiveTerminal } from './internal/interactive.js';
