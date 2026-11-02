import { invocationEffectAuthority as authority, ModelInvocationPolicyAuthorization } from '#engine/index.js';
import type { loadInvocationContext } from './context.js';
export const invocationEffectAuthority = (context: Awaited<ReturnType<typeof loadInvocationContext>>, profile: Parameters<typeof authority>[1]) => authority(context, profile, new ModelInvocationPolicyAuthorization(context.policy));
