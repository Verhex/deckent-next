import { guardModelUseNative } from '#engine/index.js';
import { resolveConfiguredModelUse } from './read.js';
export const modelUseNative = (...args: [...Parameters<typeof resolveConfiguredModelUse>, Parameters<typeof guardModelUseNative>[0]]) =>
  guardModelUseNative(args[4], () => resolveConfiguredModelUse(args[0], args[1], args[2], args[3]));
