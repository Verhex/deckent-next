import manifest from './package-metadata.json' with { type: 'json' };

/** Package identity as shipped; the single source for name/version at runtime. */
export const PACKAGE_NAME: string = manifest.name;
export const PACKAGE_VERSION: string = manifest.version;

export const NODE_ENGINE_RANGE: string = manifest.nodeEngine;
/** The per-major floors of the range for people (`24.22.1 / 26.12.1`); the range itself stays the machine contract. */
export const NODE_ENGINE_FLOOR_TEXT: string = (NODE_ENGINE_RANGE.match(/(?<=>=\s*)\d+\.\d+\.\d+/g) ?? [NODE_ENGINE_RANGE]).join(' / ');
export const DECKENT_VERSION = PACKAGE_VERSION;
