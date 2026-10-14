export { default as LOCAL_AUTHENTICATOR_INVENTORY } from './internal/authenticators.json' with { type: 'json' };
export { LocalOsPrincipalVerifier, readLocalOsIdentity } from './internal/local.js';
export { LocalOsSessionAuthority } from './internal/session.js';
export { localPrincipalChannel, localPrincipalPeer, withMcpPrincipal, withLocalPrincipalChannel } from './internal/channel.js';
export { attestLocalInteractiveTerminal } from './internal/interactive.js';
