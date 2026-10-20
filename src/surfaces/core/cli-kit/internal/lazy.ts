type AsyncFunction = (...args: never[]) => Promise<unknown>;

/**
 * COLDSTART: an async function of a module loaded on its first call, with the module's own signature. A static import evaluates the whole
 * graph behind it before the first line runs (the engine and adapters barrels are ~1000 modules); a command that never calls the function
 * never pays for it, so `--version`, help and an unknown command stay off that graph. A loader that fails rejects the call that needed it.
 */
export function lazyFunction<M extends Record<K, AsyncFunction>, K extends keyof M>(load: () => Promise<M>, name: K): M[K] {
  return (async (...args: never[]) => (await load())[name](...args)) as M[K];
}
