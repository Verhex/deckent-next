/** Paths and schema identities; execution policy belongs to the owning package. */
export const DECKENT_DIR = '.deckent';
export const BRAIN_DIR = '.brain';
export const CONFIG_FILE = 'config.json';
export const PROJECT_CONFIG_PATH = `${DECKENT_DIR}/${CONFIG_FILE}`;
export const CONFIG_SCHEMA_VERSION = 2;
export const OUTPUT_MODES = ['standard', 'explanatory', 'verbose', 'json'] as const;
export type OutputMode = typeof OUTPUT_MODES[number];

/** Historical introduction version; unlike PACKAGE_VERSION this never advances on release. */
export const CONFIG_CONTRACT_SINCE = '1.0.0-alpha.1';
