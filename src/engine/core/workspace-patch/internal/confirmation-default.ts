import { ErrorRegistry } from '#platform/index.js';
import type { EffectConfirmation } from '#engine/core/effect/index.js';
export const unconfirmedEffect: EffectConfirmation = {
  async assertAvailable() { throw ErrorRegistry.createError('DELIVERY_INTERACTIVE_REQUIRED'); },
  async confirm() { throw ErrorRegistry.createError('DELIVERY_INTERACTIVE_REQUIRED'); },
};
