import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentToolSpec, EffectTargetRef } from '#domain/index.js';
import { EffectTargetError, type EffectApplyRequest, type EffectTarget } from '#engine/index.js';
import { createGlobMatcher, type WorkspaceScope } from '#adapters/core/workspace-read/index.js';
import { ABSENT_FILE_VERSION, WORKSPACE_WRITE_MAX_FILE_BYTES, WorkspaceWriteError, fileContentVersion, readWritableFile, resolveWritable,
  writeWorkspaceFile } from './files.js';
import { unifiedDiff } from './diff.js';

export const WORKSPACE_FILE_TARGET_KIND = 'workspace-file';
/** Core operation of an agent edit (catalog data in code for the built-in Core target; Enterprise catalogs may add their own). */
export const WORKSPACE_FILE_WRITE_OPERATION = Object.freeze({ schemaVersion: 1 as const, operation: Object.freeze({ id: 'workspace.file.write', version: 1 }),
  targetKind: WORKSPACE_FILE_TARGET_KIND, effectClass: 'write' as const, approval: 'policy' as const, precondition: 'record-version' as const,
  compensation: null, inputMaxBytes: 1_048_576 });

/**
 * Writes that always need the owner's approval, whatever policy or mode allows (T-L4 contract §5): repository internals, hooks,
 * CI, package manifests, Deckent and agent configuration. Reads of secret paths are already denied by the workspace scope.
 */
export const WORKSPACE_WRITE_APPROVAL_FLOOR: readonly string[] = Object.freeze(['.github/**', '.gitlab-ci.yml', '.circleci/**', '.husky/**', '**/.husky/**',
  'package.json', '**/package.json', 'package-lock.json', '.deckent/**', '.claude/**', '.cursor/**', '.agents/**', 'AGENTS.md', 'CLAUDE.md', 'Makefile', 'Dockerfile']);
const floorMatchers = WORKSPACE_WRITE_APPROVAL_FLOOR.map(createGlobMatcher);
/** True when a resolved workspace-relative path is on the approval floor. */
export const isWriteApprovalFloored = (rel: string) => floorMatchers.some(match => match(rel));
const inputSchema = z.object({ content: z.string() }).strict();
const journalSchema = z.object({ schemaVersion: z.literal(1), rel: z.string(), expected: z.string(), next: z.string() }).strict();

/**
 * The project's files as a C11 effect target (T-L4 slice 2). A record is a workspace-relative path resolved only through the
 * workspace scope (never absolute, never outside, never a denied path); its version is the sha256 of the file's bytes, or `absent`.
 * A write is conditional on that version and atomic. Before writing, the target journals (wire key → expected and next version)
 * in its private directory, so `lookup` after a crash reads evidence from the file itself: at `next` → applied, at `expected` →
 * absent (the idempotent write may be sent again), anything else → unknown (never a blind retry).
 */
export class WorkspaceFileTarget implements EffectTarget {
  readonly kind = WORKSPACE_FILE_TARGET_KIND;
  constructor(private readonly scope: WorkspaceScope, private readonly journalDirectory: string) {}
  identity() { return `workspace-file:${this.scope.root}`; }
  private async writable(ref: EffectTargetRef) {
    const target = await resolveWritable(this.scope, ref.id);
    if (!target.ok || target.rel !== ref.id) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    return target;
  }
  private async version(ref: EffectTargetRef) {
    const current = await readWritableFile(this.scope, await this.writable(ref));
    if (!current.ok) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    return current.version;
  }
  private journal = (key: string) => join(this.journalDirectory, `${z.string().regex(/^[0-9a-f]{64}$/).parse(key)}.json`);
  async observe(ref: EffectTargetRef) { return { version: await this.version(ref) }; }
  async apply(request: EffectApplyRequest) {
    const parsed = inputSchema.safeParse(request.input);
    if (!parsed.success || request.expectedVersion === null) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    const bytes = Buffer.from(parsed.data.content, 'utf8');
    if (bytes.length > WORKSPACE_WRITE_MAX_FILE_BYTES) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    const target = await this.writable(request.target);
    // A stale precondition is refused before anything is journaled, so it leaves no trace a later lookup could misread.
    if (await this.version(request.target) !== request.expectedVersion) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
    await mkdir(this.journalDirectory, { recursive: true, mode: 0o700 });
    const handle = await open(this.journal(request.idempotencyKey), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, rel: target.rel, expected: request.expectedVersion, next: fileContentVersion(bytes) }));
      await handle.sync();
    } finally { await handle.close(); }
    try { return { version: await writeWorkspaceFile(this.scope, target, request.expectedVersion, bytes) }; }
    catch (error) {
      if (error instanceof WorkspaceWriteError) {
        throw new EffectTargetError(error.code === 'precondition' ? 'EFFECT_TARGET_PRECONDITION' : error.code === 'rejected' ? 'EFFECT_TARGET_REJECTED' : 'EFFECT_TARGET_UNKNOWN', { cause: error });
      }
      throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause: error });
    }
  }
  async lookup(ref: EffectTargetRef, idempotencyKey: string) {
    let journal;
    try { journal = journalSchema.parse(JSON.parse(await readFile(this.journal(idempotencyKey), 'utf8'))); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'absent' as const } : null; }
    if (journal.rel !== ref.id) return null;
    const current = await this.version(ref).catch(() => null);
    if (current === journal.next) return { status: 'applied' as const, version: current };
    if (current === journal.expected) return { status: 'absent' as const };
    return null;
  }
}

/** The edit tools (T-L4). Arguments are exact strings: `old_string` must match exactly once unless `replace_all`. */
export const WORKSPACE_EDIT_TOOL_SPECS: readonly AgentToolSpec[] = Object.freeze([
  { name: 'edit_file', version: 1, toolClass: 'edit' as const, description: 'Replace an exact text in an existing UTF-8 file of the project. '
    + 'old_string must match exactly once (include enough surrounding lines), unless replace_all is true. Read the file first. '
    + 'The change is shown to the owner as a diff before it is written; the write fails if the file changed since it was read.',
  inputSchema: { type: 'object', required: ['path', 'old_string', 'new_string'], properties: { path: { type: 'string', description: 'Workspace-relative path' },
    old_string: { type: 'string', description: 'Exact text to replace' }, new_string: { type: 'string', description: 'Replacement text' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence' } } } },
  { name: 'write_file', version: 1, toolClass: 'edit' as const, description: 'Create a new UTF-8 file or replace a whole file of the project with content. '
    + 'Prefer edit_file for changes to existing files. Shown to the owner as a diff before it is written.',
  inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string', description: 'Workspace-relative path' },
    content: { type: 'string', description: 'The complete new file content' } } } },
]);

export type WorkspaceEditPlan = { readonly ok: true; readonly rel: string; readonly beforeVersion: string; readonly after: string; readonly preview: string;
  readonly added: number; readonly removed: number } | { readonly ok: false; readonly error: string };

/**
 * The file change an edit call proposes, computed from the file as it is now: its version (the write's precondition), the new
 * content and a bounded diff for the approval card. Nothing is written here. `replace` never interprets `$` patterns.
 */
export async function planWorkspaceEdit(scope: WorkspaceScope, tool: string, args: Record<string, unknown>): Promise<WorkspaceEditPlan> {
  const target = await resolveWritable(scope, args['path']);
  if (!target.ok) return { ok: false, error: target.error };
  const current = await readWritableFile(scope, target);
  if (!current.ok) return { ok: false, error: current.error };
  let before: string | null = null;
  if (current.bytes) {
    try { before = new TextDecoder('utf-8', { fatal: true }).decode(current.bytes); } catch { return { ok: false, error: 'not-utf8-text' }; }
  }
  let after: string;
  if (tool === 'write_file') {
    if (typeof args['content'] !== 'string') return { ok: false, error: 'invalid-arguments' };
    after = args['content'];
  } else if (tool === 'edit_file') {
    const old = args['old_string'], replacement = args['new_string'];
    if (before === null) return { ok: false, error: 'not-found (use write_file to create a file)' };
    if (typeof old !== 'string' || typeof replacement !== 'string' || old === '') return { ok: false, error: 'invalid-arguments' };
    const parts = before.split(old);
    if (parts.length === 1) return { ok: false, error: 'old_string not found' };
    if (parts.length > 2 && args['replace_all'] !== true) return { ok: false, error: `old_string matches ${parts.length - 1} places; add surrounding lines or set replace_all` };
    after = args['replace_all'] === true ? parts.join(replacement) : before.slice(0, before.indexOf(old)) + replacement + before.slice(before.indexOf(old) + old.length);
  } else return { ok: false, error: 'unknown-tool' };
  if (after === before) return { ok: false, error: 'no change' };
  if (Buffer.byteLength(after, 'utf8') > WORKSPACE_WRITE_MAX_FILE_BYTES) return { ok: false, error: 'too-large' };
  const preview = unifiedDiff(target.rel, before, after), lines = preview.split('\n');
  return { ok: true, rel: target.rel, beforeVersion: current.version === ABSENT_FILE_VERSION ? ABSENT_FILE_VERSION : current.version, after, preview,
    added: lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length, removed: lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length };
}
