import { guardModelUseNative } from '#engine/index.js';
import type { ModelInspectionSnapshot } from '#composition/core/model-inspection/index.js';
import { resolveConfiguredModelUse } from './read.js';
export const modelUseNative = (root: Parameters<typeof resolveConfiguredModelUse>[0], profile: Parameters<typeof resolveConfiguredModelUse>[1],
  actor: Parameters<typeof resolveConfiguredModelUse>[2], options: Parameters<typeof resolveConfiguredModelUse>[3],
  port: Parameters<typeof guardModelUseNative>[0], snapshot?: ModelInspectionSnapshot) =>
  guardModelUseNative(port, () => resolveConfiguredModelUse(root, profile, actor, options, snapshot));
