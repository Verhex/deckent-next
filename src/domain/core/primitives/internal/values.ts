import { persistedString, persistedCounter, persistedIssueCode } from './persisted-schema.js';
import { z } from 'zod';
/** Version-1 wire identifier budget, not a limit on task descriptions or customer content. */
export const IDENTITY_MAX_LENGTH = 256;
export const identitySchema = persistedString(z.string().min(1).max(IDENTITY_MAX_LENGTH)).refine(value => value.trim() === value &&
  ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
export const counterSchema = persistedCounter();
export type ValidationIssue = Readonly<{ path: readonly (string | number)[]; code: string }>;
export function sanitizeIssues(issues: readonly z.ZodIssue[]): readonly ValidationIssue[] {
  return Object.freeze(issues.map(issue => Object.freeze({ path: Object.freeze(issue.path.map(part => typeof part === 'symbol' ? String(part) : part)), code: persistedIssueCode(issue) })));
}
