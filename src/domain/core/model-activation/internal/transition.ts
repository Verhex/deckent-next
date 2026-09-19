import type { ModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { ModelActivationError, modelActivationRecordSchema, parseModelActivationCommand, parseModelActivationRecord,
  type ModelActivationCommand, type ModelActivationRecord } from './contract.js';

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function command(input: unknown): ModelActivationCommand {
  try { return parseModelActivationCommand(input); }
  catch (error) { if (error instanceof ModelActivationError) throw error; throw new ModelActivationError('MODEL_ACTIVATION_INVALID'); }
}
function existing(input: unknown): ModelActivationRecord | null {
  if (input === null) return null;
  try { return parseModelActivationRecord(input); }
  catch (error) { if (error instanceof ModelActivationError) throw error; throw new ModelActivationError('MODEL_ACTIVATION_INVALID'); }
}

/** Pure state transition. Binding cryptographic verification is an engine boundary responsibility. */
export function transitionModelActivation(existingInput: unknown, commandInput: unknown,
  resolvedDefinition?: ModelBindingDefinition): ModelActivationRecord {
  const current = existing(existingInput), requested = command(commandInput);
  if (current && (current.scopeId !== requested.scopeId || !same(current.reference, requested.reference))) {
    throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  }
  if (requested.action === 'deactivate' && !current) throw new ModelActivationError('MODEL_ACTIVATION_NOT_FOUND');
  if (requested.action === 'deactivate' && current?.state !== 'active') throw new ModelActivationError('MODEL_ACTIVATION_NOT_ACTIVE');
  if ((current?.revision ?? 0) !== requested.expectedRevision) throw new ModelActivationError('MODEL_ACTIVATION_REVISION_CONFLICT');
  if (requested.action === 'deactivate') {
    if (!current) throw new ModelActivationError('MODEL_ACTIVATION_NOT_FOUND');
    if (!same(current.binding, requested.expectedBinding)) throw new ModelActivationError('MODEL_ACTIVATION_BINDING_CONFLICT');
    const result = modelActivationRecordSchema.safeParse({ ...current, revision: current.revision + 1, state: 'inactive' });
    if (!result.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
    return parseModelActivationRecord(result.data);
  }
  if (!resolvedDefinition) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  const proposed = modelActivationRecordSchema.safeParse({ schemaVersion: 1, scopeId: requested.scopeId,
    reference: requested.reference, revision: requested.expectedRevision + 1, state: 'active', catalogRevision: requested.catalogRevision,
    definition: resolvedDefinition, binding: requested.expectedBinding });
  if (!proposed.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  return parseModelActivationRecord(proposed.data);
}
