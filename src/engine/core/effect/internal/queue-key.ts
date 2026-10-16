import { createHash } from 'node:crypto';
import { encodeCommandProjection, targetBindingSchema, type TargetBinding } from '#domain/index.js';
export function targetQueueKey(input: TargetBinding): string {
  const binding = targetBindingSchema.parse(input);
  // An adapter upgrade cannot create a second physical writer queue for the same resource.
  return createHash('sha256').update(encodeCommandProjection('target-queue:1', { installationId: binding.installationId,
    adapterId: binding.adapter.id, resourceBinding: binding.resourceBinding, target: binding.target })).digest('hex');
}
