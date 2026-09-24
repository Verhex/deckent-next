import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { AgentToolOutcome, AgentToolSpec } from '#domain/index.js';
import { boundLine, readBoundedTextFile, sliceUtf8, splitLines } from './bounded.js';
import { renderReadFileView, resolveReadFileBudget, resolveReadFileViewRequest } from './views.js';
import { createWorkspaceScope, DEFAULT_WORKSPACE_READ_DENY, globToRegExp, walkWorkspaceFiles, type WorkspaceScope } from './scope.js';

/** Read/search tools of the terminal tool loop (T-L1), ported from the legacy native tools minus their defects: every result is
 * byte-bounded here (not by a later broker), grep never answers "no matches" when content was skipped, and long lines are elided
 * with an exact continuation. Byte caps only; fitting results into the model context is the loop's job in one token unit. */
export interface WorkspaceReadLimits {
  /** Hard ceiling of one tool result (bytes). */
  readonly maxResultBytes: number;
  /** Largest file read or scanned whole (bytes). */
  readonly maxFileBytes: number;
}
export const DEFAULT_WORKSPACE_READ_LIMITS: WorkspaceReadLimits = Object.freeze({ maxResultBytes: 16_384, maxFileBytes: 16 * 1024 * 1024 });
const MAX_LIST_ENTRIES = 500, MAX_GLOB_MATCHES = 500, MAX_GREP_HITS = 200, GREP_BYTES_PER_LINE = 2048, MAX_SKIP_NOTES = 32;

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', minimum: 0, description });
export const WORKSPACE_READ_TOOL_SPECS: readonly AgentToolSpec[] = Object.freeze([
  { name: 'read_file', version: 1, toolClass: 'read', description: 'Read a workspace file (prefer this over shell tools for reading). Every result starts with a "[deckent] read_file:" line that says what was returned and how to continue. mode "outline": headings with line numbers and size/longest-line statistics (take this first on big files); startLine/endLine: numbered lines, long lines elided with an exact re-read marker; pattern: grep-style matches with optional context.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: str('Workspace-relative path.'), mode: { type: 'string', enum: ['content', 'outline', 'search'] },
      startLine: int('1-based first line.'), endLine: int('1-based last line (inclusive).'), lineByteOffset: int('Byte offset inside long lines.'),
      maxBytesPerLine: int('Per-line byte window.'), outlineOffset: int('1-based first heading.'), pattern: str('Regular expression (search mode).'),
      literal: { type: 'boolean' }, ignoreCase: { type: 'boolean' }, context: int('Context lines around matches (max 10).'), maxMatches: int('Max matches (max 500).') } } },
  { name: 'list_dir', version: 1, toolClass: 'read', description: 'List a workspace directory; directories end with "/".',
    inputSchema: { type: 'object', properties: { path: str('Workspace-relative directory; default the workspace root.') } } },
  { name: 'grep', version: 1, toolClass: 'read', description: 'Search workspace files with a regular expression; returns path:line:text hits. Long lines are elided, never missed; skipped files are reported.',
    inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: str('Regular expression.'), path: str('Directory or file to search; default the workspace root.'),
      glob: str('Only files whose workspace-relative path matches this glob.'), ignoreCase: { type: 'boolean' } } } },
  { name: 'glob', version: 1, toolClass: 'read', description: 'Find workspace files by glob ("**" any directories, "*" within a name).',
    inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: str('Glob relative to path.'), path: str('Directory; default the workspace root.') } } },
] as const satisfies readonly AgentToolSpec[]);

const fail = (tool: string, detail: string): AgentToolOutcome => ({ status: 'error', text: `[deckent] ${tool}: error=${detail}` });
const toPosix = (path: string) => path.split(sep).join('/');
/** Joins rows until the byte budget; a cut is always stated with how to narrow. */
function bounded(rows: readonly string[], trailer: readonly string[], maxBytes: number, narrow: string): string {
  const tail = trailer.join('\n'), reserve = Buffer.byteLength(tail, 'utf8') + 160, out: string[] = [];
  let used = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(row, 'utf8') + 1;
    if (used + bytes > maxBytes - reserve) { out.push(`[deckent] truncated at ${out.length} of ${rows.length} rows (result byte cap); ${narrow}`); break; }
    out.push(row); used += bytes;
  }
  return sliceUtf8(Buffer.from([...out, ...(tail ? [tail] : [])].join('\n'), 'utf8'), maxBytes);
}

export interface WorkspaceReadTools {
  readonly specs: readonly AgentToolSpec[];
  readonly scope: WorkspaceScope;
  execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome>;
}

export async function createWorkspaceReadTools(root: string, options: { deny?: readonly string[]; limits?: Partial<WorkspaceReadLimits> } = {}): Promise<WorkspaceReadTools> {
  const scope = await createWorkspaceScope(root, options.deny ?? DEFAULT_WORKSPACE_READ_DENY);
  const limits = { ...DEFAULT_WORKSPACE_READ_LIMITS, ...options.limits };
  const readFileTool = async (args: Record<string, unknown>): Promise<AgentToolOutcome> => {
    const target = await scope.resolve(args['path']);
    if (!target.ok) return fail('read_file', `${target.error} path=${JSON.stringify(String(args['path'] ?? ''))}`);
    const read = await readBoundedTextFile(target.abs, limits.maxFileBytes);
    if (!read.ok) return fail('read_file', `${read.kind} (${read.detail}) path=${JSON.stringify(target.rel)}`);
    return { status: 'ok', text: renderReadFileView(read.text, resolveReadFileViewRequest(args), resolveReadFileBudget(limits.maxResultBytes)) };
  };
  const listDir = async (args: Record<string, unknown>): Promise<AgentToolOutcome> => {
    const target = await scope.resolve(args['path'], true);
    if (!target.ok) return fail('list_dir', `${target.error} path=${JSON.stringify(String(args['path'] ?? '.'))}`);
    let entries;
    try { entries = await readdir(target.abs, { withFileTypes: true }); } catch { return fail('list_dir', `not-a-directory path=${JSON.stringify(target.rel || '.')}`); }
    const visible = entries.filter(entry => !scope.ignoredDirs.has(entry.name) && !scope.denied(toPosix(relative(scope.root, join(target.abs, entry.name)))))
      .sort((a, b) => a.name.localeCompare(b.name));
    const rows = visible.slice(0, MAX_LIST_ENTRIES).map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name);
    const hidden = entries.length - visible.length;
    const trailer = [...(visible.length > MAX_LIST_ENTRIES ? [`[deckent] list_dir: ${visible.length} entries, showing ${MAX_LIST_ENTRIES}`] : []),
      ...(hidden > 0 ? [`[deckent] list_dir: ${hidden} ignored or protected entr${hidden === 1 ? 'y' : 'ies'} not shown`] : [])];
    return { status: 'ok', text: rows.length === 0 && trailer.length === 0 ? '[deckent] list_dir: empty directory' : bounded(rows, trailer, limits.maxResultBytes, 'list a subdirectory') };
  };
  const grep = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome> => {
    const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : '';
    if (!pattern) return fail('grep', 'empty-pattern');
    let re: RegExp;
    try { re = new RegExp(pattern, args['ignoreCase'] === true ? 'iu' : 'u'); } catch { return fail('grep', `invalid-pattern pattern=${JSON.stringify(pattern)}`); }
    const target = await scope.resolve(args['path'], true);
    if (!target.ok) return fail('grep', `${target.error} path=${JSON.stringify(String(args['path'] ?? '.'))}`);
    const only = typeof args['glob'] === 'string' && args['glob'] ? globToRegExp(args['glob']) : null;
    const hits: string[] = [], skipped: string[] = [];
    let scanned = 0, capped = false;
    const scan = async (abs: string, rel: string) => {
      if (signal?.aborted) return false;
      if (only && !only.test(rel)) return true;
      const read = await readBoundedTextFile(abs, limits.maxFileBytes);
      if (!read.ok) { skipped.push(`${rel} (${read.kind}: ${read.detail})`); return true; }
      scanned++;
      const lines = splitLines(read.text);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]!)) continue;
        if (hits.length >= MAX_GREP_HITS) { capped = true; return false; }
        hits.push(`${rel}:${i + 1}:${boundLine(lines[i]!, i + 1, 0, GREP_BYTES_PER_LINE).text}`);
      }
      return true;
    };
    const info = await stat(target.abs);
    if (info.isFile()) await scan(target.abs, target.rel); else await walkWorkspaceFiles(scope, target.abs, scan);
    if (signal?.aborted) return fail('grep', 'cancelled');
    const notes = [...(capped ? [`truncated (${MAX_GREP_HITS} hits cap); narrow with path or glob`] : []),
      ...skipped.slice(0, MAX_SKIP_NOTES).map(entry => `skipped ${entry}`), ...(skipped.length > MAX_SKIP_NOTES ? [`${skipped.length - MAX_SKIP_NOTES} more skipped file(s)`] : [])];
    const trailer = hits.length === 0
      ? [skipped.length > 0 ? `[deckent] grep: no matches in ${scanned} scanned file(s); ${skipped.length} file(s) not fully scanned` : `[deckent] grep: no matches in ${scanned} scanned file(s)`, ...(notes.length ? [`[deckent] grep: ${notes.join('; ')}`] : [])]
      : notes.length ? [`[deckent] grep: ${notes.join('; ')}`] : [];
    return { status: 'ok', text: bounded(hits, trailer, limits.maxResultBytes, 'narrow with path or glob') };
  };
  const glob = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome> => {
    const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : '';
    if (!pattern) return fail('glob', 'empty-pattern');
    const target = await scope.resolve(args['path'], true);
    if (!target.ok) return fail('glob', `${target.error} path=${JSON.stringify(String(args['path'] ?? '.'))}`);
    const re = globToRegExp(pattern), matched: string[] = [];
    let capped = false;
    await walkWorkspaceFiles(scope, target.abs, (abs) => {
      if (signal?.aborted) return false;
      const rel = toPosix(relative(target.abs, abs));
      if (!re.test(rel)) return true;
      if (matched.length >= MAX_GLOB_MATCHES) { capped = true; return false; }
      matched.push(rel); return true;
    });
    if (signal?.aborted) return fail('glob', 'cancelled');
    if (matched.length === 0) return { status: 'ok', text: '[deckent] glob: no matches' };
    return { status: 'ok', text: bounded(matched, capped ? [`[deckent] glob: truncated (${MAX_GLOB_MATCHES} matches cap); narrow the pattern`] : [], limits.maxResultBytes, 'narrow the pattern') };
  };
  const run: Record<string, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolOutcome>> = { read_file: readFileTool, list_dir: listDir, grep, glob };
  return Object.freeze({
    specs: WORKSPACE_READ_TOOL_SPECS, scope,
    async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const tool = Object.hasOwn(run, name) ? run[name] : undefined;
      if (!tool) return fail(name.slice(0, 64), 'unknown-tool');
      if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(name, 'arguments-not-an-object');
      try { return await tool(args, signal); } catch { return fail(name, 'failed'); }
    },
  });
}
