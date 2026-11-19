import { toolErrorClass, withToolErrorClass, type ToolErrorClass } from '#capabilities/index.js';

/** Carry the producer's private disposition across projection without adding a wire field. */
export function agentToolResult<T extends object>(result: T, basis: ToolErrorClass | object): T {
  return withToolErrorClass(result, typeof basis === 'string' ? basis : toolErrorClass(basis));
}

/** The existing session entry keeps the receipt alive. Only durable.ts publishes after the insert. */
export const storedToolCalls = new WeakMap<object, Readonly<{ scopeId: string; turnId: string; round: number; index: number; argsDigest: string | null; resultDigest: string }>>();
