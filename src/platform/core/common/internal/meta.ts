import manifest from './package-metadata.json' with { type: 'json' };

/** Package identity as shipped; the single source for name/version at runtime. */
export const PACKAGE_NAME: string = manifest.name;
export const PACKAGE_VERSION: string = manifest.version;

export const NODE_ENGINE_RANGE: string = manifest.nodeEngine;
export const DECKENT_VERSION = PACKAGE_VERSION;
