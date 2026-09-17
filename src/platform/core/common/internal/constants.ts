import layoutResources from './layout-resources.json' with { type: 'json' };
export const PRODUCT_LAYOUT_REGISTRY = Object.freeze({ ...layoutResources, resources: Object.freeze(layoutResources.resources) });
/** Paths and schema identities; execution policy belongs to the owning package. */
export const DECKENT_DIR = PRODUCT_LAYOUT_REGISTRY.rootName;
export const CONFIG_FILE = PRODUCT_LAYOUT_REGISTRY.resources.config;
export const PROJECT_CONFIG_PATH = `${DECKENT_DIR}/${CONFIG_FILE}`;
export const CONFIG_SCHEMA_VERSION = 2;
export const OUTPUT_MODES = ['standard', 'explanatory', 'verbose', 'json'] as const;
export type OutputMode = typeof OUTPUT_MODES[number];

/** Historical introduction version; unlike PACKAGE_VERSION this never advances on release. */
export const CONFIG_CONTRACT_SINCE = '1.0.0-alpha.1';
export const LAYOUT_CONTRACT_SINCE = '1.0.0-alpha.2';
