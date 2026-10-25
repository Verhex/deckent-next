import registry from './internal/registry.json' with { type: 'json' };
/** Static available connection kinds for installation-free CLI help. No credentials or runtime imports. */
export const providerConnectHelpKinds = () => registry.kinds.filter(kind => kind.available && Boolean(kind.connect)).map(kind => kind.id).join(', ');
