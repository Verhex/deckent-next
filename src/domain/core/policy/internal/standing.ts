import { IDENTITY_MAX_LENGTH } from '#domain/core/primitives/index.js';
import { policyResources } from './vocabulary.js';

/**
 * Standing approvals (PERSISTENT-APPROVALS G6, owner 2026-09-28): a person's "this session" / "in this project always" answer to an
 * owner approval card, as data. Pure: which calls may stand, the narrow pattern a standing approval covers, and the `policy.administer`
 * change that persists it as the person's OWN grant. The grant is an ordinary policy v2 grant on the resource kind `agent-tool-call`
 * (id = the pattern key, exact string — no policy version changes); it is consulted only by the call decision's lowering step, never by
 * the strict policy sides, so it can lower an approval but never create authority the company denied.
 */
export const STANDING_GRANT_KIND = policyResources.agentToolCall.kind;
export const STANDING_GRANT_ACTION = 'invoke';
/** Persisted standing grants of one person (bounded so the person's own rule set and the bound's cell count stay small). */
export const STANDING_GRANTS_MAX = 64;
/** Longest command or directory a pattern names; longer text is not persistable (the card must show all of what it would allow). */
export const STANDING_PATTERN_MAX_CHARS = 200;

/**
 * The cells a standing approval may lower, decided one by one: an ordinary edit (outside the write floor) and the two shell tiers that are
 * bounded by the classifier (read-only with wide reach, the narrow mutating set). Everything else is never standing: the write floor
 * (`edit-floor`, owner: hard floor), destructive / always-ask / other-modify shell commands, and every fetch (no mode lowers a fetch).
 */
export type StandingCell = 'edit' | 'shell-read-low' | 'shell-narrow-mutating';
const STANDING_CELLS: ReadonlySet<string> = new Set<StandingCell>(['edit', 'shell-read-low', 'shell-narrow-mutating']);
export const standingCell = (cell: string): cell is StandingCell => STANDING_CELLS.has(cell);

export type StandingRefusal = 'cell-not-standing' | 'no-target' | 'unsafe-target' | 'pattern-too-long';
export interface StandingPattern { readonly key: string; readonly kind: 'command' | 'directory'; readonly text: string; readonly tool: string; readonly cell: StandingCell }
export type StandingPatternResult = { readonly ok: true; readonly pattern: StandingPattern } | { readonly ok: false; readonly reason: StandingRefusal };

const hasControl = (text: string) => [...text].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const GLOB = /[*?[\]{}\\]/u;
const refuse = (reason: StandingRefusal): StandingPatternResult => Object.freeze({ ok: false, reason });

/**
 * The narrow pattern of one call (generalization rule, versioned by the `v1` key prefix so a later, wider pattern kind is a different key
 * and never widens an existing grant):
 * - shell: the command's **whole text** (one line, no control characters, ≤ 200 characters). No head-plus-wildcard and no argument
 *   generalization: a shell string (`&&`, `;`, `$()`, redirection) cannot be generalized safely by an argument shape.
 * - edit: the target's **directory plus `/*`** — one level, never `**`; a workspace-relative path without `.`/`..` segments, without a leading
 *   slash and without glob characters. The write floor is a path-level code rule that never consults this: a floored path is the
 *   `edit-floor` cell, which is never standing.
 */
export function standingPattern(call: { readonly tool: string; readonly cell: string; readonly path: string | null; readonly command: string | null }): StandingPatternResult {
  if (!standingCell(call.cell)) return refuse('cell-not-standing');
  const seal = (kind: StandingPattern['kind'], text: string): StandingPatternResult => {
    const key = `v1:${call.tool}:${kind}:${text}`;
    return key.length > IDENTITY_MAX_LENGTH ? refuse('pattern-too-long') : Object.freeze({ ok: true, pattern: Object.freeze({ key, kind, text, tool: call.tool, cell: call.cell as StandingCell }) });
  };
  if (call.cell === 'edit') {
    const path = call.path;
    if (path === null || path === '') return refuse('no-target');
    if (path.startsWith('/') || hasControl(path) || GLOB.test(path) || path.trim() !== path) return refuse('unsafe-target');
    const segments = path.split('/');
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return refuse('unsafe-target');
    const directory = segments.length === 1 ? '.' : segments.slice(0, -1).join('/');
    return directory.length + 2 > STANDING_PATTERN_MAX_CHARS ? refuse('pattern-too-long') : seal('directory', `${directory}/*`);
  }
  const command = call.command;
  if (command === null || command === '') return refuse('no-target');
  if (hasControl(command) || command.trim() !== command) return refuse('unsafe-target');
  return command.length > STANDING_PATTERN_MAX_CHARS ? refuse('pattern-too-long') : seal('command', command);
}

/** Whether a standing key covers a call's own key: literal equality (the pattern is already the whole rule; no glob is ever evaluated). */
export const standingCovers = (grantKey: string, callKey: string) => grantKey === callKey;

/** The grant id a key persists under: the caller supplies a stable digest (the domain does no hashing). */
export const standingGrantId = (digest: string) => `standing-${digest}`;
export const isStandingGrantId = (id: string) => id.startsWith('standing-');

/** The `policy.administer` change that persists one pattern as the person's own grant, or removes it. */
export function standingGrantChange(input: { readonly id: string; readonly principal: { readonly issuer: string; readonly subject: string }; readonly scopeId: string; readonly key: string }) {
  return Object.freeze({ schemaVersion: 1 as const, changes: Object.freeze([Object.freeze({ kind: 'grant.add' as const, grant: Object.freeze({ id: input.id, effect: 'allow' as const,
    actions: Object.freeze([STANDING_GRANT_ACTION]), scopes: Object.freeze([input.scopeId]), principals: Object.freeze([Object.freeze({ issuer: input.principal.issuer, subject: input.principal.subject })]),
    resource: Object.freeze({ kind: STANDING_GRANT_KIND, ids: Object.freeze([input.key]) }) }) })]) });
}
export const standingRevokeChange = (id: string) => Object.freeze({ schemaVersion: 1 as const, changes: Object.freeze([Object.freeze({ kind: 'grant.remove' as const, id })]) });
