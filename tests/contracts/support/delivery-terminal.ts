import { expect } from 'vitest';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { EffectConfirmation, IntegrationDeliveryCommand, IntegrationAdoptionCommand, IntegrationRollbackCommand } from '#engine/index.js';
import { deliverWorkspaceIntegrationWithConfirmation, adoptWorkspaceIntegrationWithConfirmation, rollbackWorkspaceIntegrationWithConfirmation } from '#composition/core/workspace-patch/index.js';
/** Explicit test broker: approve the actual card then assert the effect. Never claims a TTY witness.
 * Kept in-process so crash/race spies still exercise the original production adapters. */
const approvedCard: EffectConfirmation = { async assertAvailable() {}, async confirm(card) {
  expect(card.resource).toMatch(/^refs\//); expect(card.to).toMatch(/^[a-f0-9]{40,64}$/);
  expect(card.actor.id).toBeTruthy(); return async () => {};
} };
export const confirmedDelivery = (root: string, input: IntegrationDeliveryCommand, options: ConfigLoadOptions = {}) =>
  deliverWorkspaceIntegrationWithConfirmation(root, input, options, approvedCard);
export const confirmedAdoption = (root: string, input: IntegrationAdoptionCommand, options: ConfigLoadOptions = {}) =>
  adoptWorkspaceIntegrationWithConfirmation(root, input, options, approvedCard);
/** TESLIM-GUVENLIK: a rollback moves the branch back, so it carries the same approved card (the bare SDK call is refused). */
export const confirmedRollback = (root: string, input: IntegrationRollbackCommand, options: ConfigLoadOptions = {}) =>
  rollbackWorkspaceIntegrationWithConfirmation(root, input, options, approvedCard);
