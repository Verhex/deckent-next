import { z } from 'zod';
import { attemptIdentitySchema, sameAttemptIdentity, identitySchema } from '#domain/index.js';
import { sandboxRequestSchema, sandboxResultSchema, sandboxObservationSchema, sandboxOutputSchema, SupervisorError } from './port.js';
const operation = z.enum(['execute', 'observe', 'cancel', 'recover-output', 'release']);
export const supervisorCommandSchema = z.object({ protocolVersion: z.literal(1), requestId: identitySchema,
  operation, request: sandboxRequestSchema }).strict().readonly();
const header = { protocolVersion: z.literal(1), requestId: identitySchema, identity: attemptIdentitySchema };
export const supervisorReplySchema = z.discriminatedUnion('operation', [
  z.object({ ...header, operation: z.literal('execute'), value: sandboxResultSchema }).strict(),
  z.object({ ...header, operation: z.literal('observe'), value: sandboxObservationSchema }).strict(),
  z.object({ ...header, operation: z.literal('cancel'), value: sandboxObservationSchema }).strict(),
  z.object({ ...header, operation: z.literal('recover-output'), value: sandboxOutputSchema }).strict(),
  z.object({ ...header, operation: z.literal('release'), value: z.null() }).strict(),
]).readonly();
export type SupervisorCommand = z.infer<typeof supervisorCommandSchema>;
export type SupervisorReply = z.infer<typeof supervisorReplySchema>;
/** Correlation validates the attempt generation and scope, not only a process-local request ID. */
export function validateSupervisorReply(command: SupervisorCommand, input: unknown): SupervisorReply {
  const parsed = supervisorReplySchema.safeParse(input);
  if (!parsed.success || parsed.data.requestId !== command.requestId || parsed.data.operation !== command.operation
    || !sameAttemptIdentity(parsed.data.identity, command.request.identity)) throw new SupervisorError('SUPERVISOR_CONTROL_FAILED');
  return parsed.data;
}
