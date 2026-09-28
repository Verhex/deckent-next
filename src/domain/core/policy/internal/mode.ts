import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { evaluatePolicy } from './evaluate.js';
import { includes, PERMISSION_MODES, principalGrants, principalPermissionMode, upgradeBindingsDocument, type PermissionMode, type PermissionModeEntry, type Policy } from './schema.js';
import { policyResources } from './vocabulary.js';
import type { VerifiedPrincipal } from '#domain/core/principal/index.js';

/**
 * Runtime protocol v15 (T-L4 slice 4c; v17 MODES-3): a person reads and sets **their own** terminal permission mode for one scope. The
 * principal is never an input field (the transport's verified peer is the principal); setting is conditional on the effective policy
 * revision the caller last read (`policy+bindings`), so a concurrent change answers a typed conflict instead of overwriting it. v17: the
 * modes are `standart | full-auto | full-access` (`full-access` is stored only as the person's start mode), and `askEdits` (absent = keep)
 * sets the person's "ask for edits too" preference.
 */
export const permissionModeQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema }).strict().readonly();
export const permissionModeCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, mode: z.enum(PERMISSION_MODES),
  askEdits: z.boolean().optional(), expectedRevision: identitySchema }).strict().readonly();
const viewShape = { schemaVersion: z.literal(1), scopeId: identitySchema,
  /** false for a v1 policy: bindings are not read, so there are no modes (everyone `standart`) and nothing can be set. */
  supported: z.boolean(), mode: z.enum(PERMISSION_MODES), askEdits: z.boolean(), revision: identitySchema,
  /** Whether the company marked any `require-approval` rule that can apply to this person in this scope `modeEligible`; without one
   * standart and full-auto change nothing here. */
  eligible: z.boolean(),
  /** Whether a company `permission-mode`/`set` grant allows full access for this person here now (a launch without it is refused). */
  fullAccess: z.boolean() };
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

/**
 * Whether a company grant allows this person full access in this scope now (MODES-3): an `allow` on `permission-mode`/`set` for the id
 * `full-access`. The decision function asks the same on every call; the turn's admission records it.
 */
export function fullAccessGrant(input: unknown, principal: VerifiedPrincipal, scopeId: string) {
  return evaluatePolicy(input, { principal, scopeId, action: policyResources.permissionMode.actions[0], resource: { kind: policyResources.permissionMode.kind, id: 'full-access' } });
}
/** The person's effective mode in one scope over a resolved snapshot (ambiguity reads as standart with every edit asked, as in the decision). */
export function permissionModeView(input: Policy, principal: VerifiedPrincipal, scopeId: string): PermissionModeView {
  const actor = { issuer: principal.issuer, subject: principal.subject };
  const eligible = input.schemaVersion === 2 && principalGrants(input, actor).some(rule => rule.effect === 'require-approval' && rule.modeEligible === true
    && includes(rule.scopes, scopeId) && (rule.principals === 'all' || rule.principals.some(principal => same(principal, actor))));
  const person = principalPermissionMode(input, actor, scopeId);
  const fullAccess = input.schemaVersion === 2 && fullAccessGrant(input, principal, scopeId).decision === 'allow';
  return Object.freeze({ schemaVersion: 1 as const, scopeId, supported: input.schemaVersion === 2, mode: person.mode, askEdits: person.askEdits, revision: input.revision,
    eligible, fullAccess });
}

/**
 * The v3 `modes` of a bindings document after the actor sets `mode` (and `askEdits`) for `scopeId`, or null when it already is exactly that
 * (nothing to write). Only entries of this exact issuer + subject change: the scope leaves each of them (an emptied entry is removed), then —
 * unless it is the default (`standart` without `askEdits`, the absence of an entry) — it joins the actor's entry of that mode and preference
 * or a new entry `entryId` (suffixed on a clash). Every other person's entry, and the role `bindings`, are returned as they were (a v2 document's
 * entries in their v3 form). Pure: the caller derives ids and the revision.
 */
export function withPrincipalPermissionMode(input: unknown, actor: Actor, scopeId: string, mode: PermissionMode, askEdits: boolean,
  entryId: string): readonly PermissionModeEntry[] | null {
  const modes = upgradeBindingsDocument(input).modes;
  const named = modes.filter(entry => same(entry.principal, actor) && entry.scopes.includes(scopeId));
  const matches = (entry: PermissionModeEntry) => entry.mode === mode && (entry.askEdits === true) === askEdits;
  const isDefault = mode === 'standart' && !askEdits;
  if (isDefault ? named.length === 0 : named.length === 1 && matches(named[0]!)) return null;
  const next: PermissionModeEntry[] = [];
  for (const entry of modes) {
    if (!same(entry.principal, actor) || !entry.scopes.includes(scopeId)) { next.push(entry); continue; }
    const scopes = entry.scopes.filter(value => value !== scopeId);
    if (scopes.length) next.push(Object.freeze({ ...entry, scopes: Object.freeze(scopes) }));
  }
  if (!isDefault) {
    const index = next.findIndex(entry => same(entry.principal, actor) && matches(entry));
    if (index >= 0) next[index] = Object.freeze({ ...next[index]!, scopes: Object.freeze([...next[index]!.scopes, scopeId]) });
    else {
      const taken = new Set(next.map(entry => entry.id));
      let id = entryId;
      for (let suffix = 2; taken.has(id); suffix++) id = `${entryId}-${suffix}`;
      next.push(Object.freeze({ id, principal: Object.freeze({ issuer: actor.issuer, subject: actor.subject }), scopes: Object.freeze([scopeId]), mode,
        ...(askEdits ? { askEdits: true as const } : {}) }));
    }
  }
  return Object.freeze(next);
}
