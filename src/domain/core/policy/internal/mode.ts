import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { bindingsFileSchema, includes, PERMISSION_MODES, principalGrants, principalPermissionMode, PolicyError, type PermissionMode, type Policy } from './schema.js';

/**
 * Runtime protocol v15 (T-L4 slice 4c): a person reads and sets **their own** terminal permission mode for one scope. The principal is
 * never an input field (the transport's verified peer is the principal); setting is conditional on the effective policy revision the
 * caller last read (`policy+bindings`), so a concurrent change answers a typed conflict instead of overwriting it.
 */
export const permissionModeQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema }).strict().readonly();
export const permissionModeCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, mode: z.enum(PERMISSION_MODES),
  expectedRevision: identitySchema }).strict().readonly();
const viewShape = { schemaVersion: z.literal(1), scopeId: identitySchema,
  /** false for a v1 policy: bindings are not read, so there are no modes (everyone `ask`) and nothing can be set. */
  supported: z.boolean(), mode: z.enum(PERMISSION_MODES), revision: identitySchema,
  /** Whether the company marked any `require-approval` rule that can apply to this person in this scope `modeEligible`; without one a
   * mode changes nothing here. */
  eligible: z.boolean() };
export const permissionModeViewSchema = z.object(viewShape).strict().readonly();
export const permissionModeChangeSchema = z.object({ ...viewShape, previous: z.enum(PERMISSION_MODES), changed: z.boolean() }).strict().readonly();
export type PermissionModeQuery = z.infer<typeof permissionModeQuerySchema>;
export type PermissionModeCommand = z.infer<typeof permissionModeCommandSchema>;
export type PermissionModeView = z.infer<typeof permissionModeViewSchema>;
export type PermissionModeChange = z.infer<typeof permissionModeChangeSchema>;
export function parsePermissionModeQuery(input: unknown): PermissionModeQuery { return permissionModeQuerySchema.parse(input); }
export function parsePermissionModeCommand(input: unknown): PermissionModeCommand { return permissionModeCommandSchema.parse(input); }

type Actor = { readonly issuer: string; readonly subject: string };
const same = (left: Actor, right: Actor) => left.issuer === right.issuer && left.subject === right.subject;

/** The person's effective mode in one scope over a resolved snapshot (ambiguity is `ask`, as in the decision function). */
export function permissionModeView(input: Policy, actor: Actor, scopeId: string): PermissionModeView {
  const eligible = input.schemaVersion === 2 && principalGrants(input, actor).some(rule => rule.effect === 'require-approval' && rule.modeEligible === true
    && includes(rule.scopes, scopeId) && (rule.principals === 'all' || rule.principals.some(principal => same(principal, actor))));
  return Object.freeze({ schemaVersion: 1 as const, scopeId, supported: input.schemaVersion === 2,
    mode: principalPermissionMode(input, actor, scopeId)?.mode ?? 'ask', revision: input.revision, eligible });
}

type BindingsFile = z.infer<typeof bindingsFileSchema>;
type ModeEntry = Extract<BindingsFile, { schemaVersion: 2 }>['modes'][number];
/**
 * The `modes` of a bindings document after the actor sets `mode` for `scopeId`, or null when it already is exactly that (nothing to
 * write). Only entries of this exact issuer + subject change: the scope leaves each of them (an emptied entry is removed), then — unless
 * `ask`, which is the absence of an entry — it joins the actor's entry of that mode or a new entry `entryId` (suffixed on a clash).
 * Every other person's entry, and the role `bindings`, are returned as they were. Pure: the caller derives ids and the revision.
 */
export function withPrincipalPermissionMode(input: BindingsFile, actor: Actor, scopeId: string, mode: PermissionMode, entryId: string): readonly ModeEntry[] | null {
  const bindings = bindingsFileSchema.safeParse(input);
  if (!bindings.success) throw new PolicyError();
  const modes = bindings.data.schemaVersion === 2 ? bindings.data.modes : [];
  const named = modes.filter(entry => same(entry.principal, actor) && entry.scopes.includes(scopeId));
  if (mode === 'ask' ? named.length === 0 : named.length === 1 && named[0]!.mode === mode) return null;
  const next: ModeEntry[] = [];
  for (const entry of modes) {
    if (!same(entry.principal, actor) || !entry.scopes.includes(scopeId)) { next.push(entry); continue; }
    const scopes = entry.scopes.filter(value => value !== scopeId);
    if (scopes.length) next.push(Object.freeze({ ...entry, scopes: Object.freeze(scopes) }));
  }
  if (mode !== 'ask') {
    const index = next.findIndex(entry => same(entry.principal, actor) && entry.mode === mode);
    if (index >= 0) next[index] = Object.freeze({ ...next[index]!, scopes: Object.freeze([...next[index]!.scopes, scopeId]) });
    else {
      const taken = new Set(next.map(entry => entry.id));
      let id = entryId;
      for (let suffix = 2; taken.has(id); suffix++) id = `${entryId}-${suffix}`;
      next.push(Object.freeze({ id, principal: Object.freeze({ issuer: actor.issuer, subject: actor.subject }), scopes: Object.freeze([scopeId]), mode }));
    }
  }
  return Object.freeze(next);
}
