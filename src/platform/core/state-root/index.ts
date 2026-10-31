/** P5a: the global state root and the compile-cache bootstrap (node: built-ins and the layout registry only); its own unit so the i18n renderer
 * and other node-free units never reach node: modules through `common`. */
export { enableDeckentCompileCache, resolveGlobalStateRoot, type GlobalStateRoot } from './internal/state-root.js';
