import { type ToolErrorClass } from '#capabilities/index.js';
import { ApprovalError, EffectError } from '#domain/index.js';
import { SessionAuthenticationError } from '#engine/index.js';

export function effectToolError(error: unknown): ToolErrorClass {
  if (error instanceof SessionAuthenticationError) return 'session';
  if (error instanceof ApprovalError) return error.code === 'APPROVAL_UNSETTLED' || error.code === 'APPROVAL_MISSING' ? 'uncertain' : 'session';
  if (error instanceof EffectError) {
    switch (error.code) {
      case 'EFFECT_PRECONDITION_CHANGED': case 'EFFECT_APPROVAL_REQUIRED': case 'EFFECT_OUTCOME_UNKNOWN': return 'ordinary';
      case 'EFFECT_CONFLICT': case 'EFFECT_INVALID': case 'OPERATION_SURFACE_RESTRICTED': return 'session';
    }
  }
  return 'uncertain';
}
