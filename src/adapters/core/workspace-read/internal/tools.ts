import { readdir } from 'node:fs/promises';
import type { AgentToolOutcome, AgentToolSpec } from '#domain/index.js';
import { boundLine, readBoundedTextFile, sliceUtf8, splitLines } from './bounded.js';
import { compileSearchPattern, metaPattern, renderReadFileView, resolveReadFileBudget, resolveReadFileViewRequest } from './views.js';
import { createGlobMatcher, createWorkspaceScope, DEFAULT_WORKSPACE_READ_DENY, describeIncomplete, openWalkedFile, walkWorkspaceFiles,
  type WorkspaceScope } from './scope.js';
import { createRegexRunner, RegexCancelled } from './regex-runner.js';

/** Read/search tools of the terminal tool loop (T-L1), ported from the legacy native tools minus their defects. Every result, on
 * every branch, is cut to the byte cap with a stated marker; grep never answers "no matches" when content was skipped; long lines
 * are elided with an exact continuation; regular expressions run off the service thread and stop on cancel. Byte caps only:
 * fitting results into the model context is the loop's job in one token unit. The adapter is not an authorized execution
 * surface by itself: the engine authorizes every call (T-L3). */
export interface WorkspaceReadLimits {
  /** Hard ceiling of one tool result (bytes), 1 KiB – 1 MiB. */
  readonly maxResultBytes: number;
  /** Largest file read or scanned whole (bytes), up to 256 MiB. */
  readonly maxFileBytes: number;
}
export const DEFAULT_WORKSPACE_READ_LIMITS: WorkspaceReadLimits = Object.freeze({ maxResultBytes: 16_384, maxFileBytes: 16 * 1024 * 1024 });
const MAX_LIST_ENTRIES = 500, MAX_GLOB_MATCHES = 500, MAX_GREP_HITS = 200, GREP_BYTES_PER_LINE = 2048, MAX_SKIP_NOTES = 32;
const MAX_PATH_ARG_BYTES = 4096, MAX_PATTERN_ARG_BYTES = 2048, MAX_GLOB_ARG_BYTES = 512;

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
  { name: 'grep', version: 1, toolClass: 'read', description: 'Search workspace files with a regular expression; returns path:line:text hits. Long lines are elided, never missed; skipped files and unscanned directories are reported.',
    inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: str('Regular expression.'), path: str('Directory or file to search; default the workspace root.'),
      glob: str('Only files whose workspace-relative path matches this glob.'), ignoreCase: { type: 'boolean' } } } },
  { name: 'glob', version: 1, toolClass: 'read', description: 'Find workspace files by glob ("**" any directories, "*" within a name).',
    inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: str('Glob relative to path.'), path: str('Directory; default the workspace root.') } } },
] as const satisfies readonly AgentToolSpec[]);

const quote = (value: unknown) => metaPattern(String(value ?? ''));
const fail = (tool: string, detail: string): AgentToolOutcome => ({ status: 'error', text: `[deckent] ${tool}: error=${detail}` });
/** The last line of defence for every branch: a result never exceeds the cap, and a cut always says so (Astra 2072 R3). */
function capped(outcome: AgentToolOutcome, maxBytes: number): AgentToolOutcome {
  const bytes = Buffer.byteLength(outcome.text, 'utf8');
  if (bytes <= maxBytes) return outcome;
  const marker = `\n[deckent] result cut at the ${maxBytes}-byte cap (${bytes} bytes); narrow the request`;
  return { status: outcome.status, text: sliceUtf8(Buffer.from(outcome.text, 'utf8'), maxBytes - Buffer.byteLength(marker, 'utf8')) + marker };
}
/** Joins rows until the byte budget; a cut is always stated with how to narrow. */
function rowsWithin(rows: readonly string[], trailer: readonly string[], maxBytes: number, narrow: string): string {
  const tail = trailer.join('\n'), reserve = Buffer.byteLength(tail, 'utf8') + 160, out: string[] = [];
  let used = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(row, 'utf8') + 1;
    if (used + bytes > maxBytes - reserve) { out.push(`[deckent] truncated at ${out.length} of ${rows.length} rows (result byte cap); ${narrow}`); break; }
    out.push(row); used += bytes;
  }
  return [...out, ...(tail ? [tail] : [])].join('\n');
}
function argumentProblem(args: Record<string, unknown>): string | null {
  for (const key of ['path'] as const) if (typeof args[key] === 'string' && Buffer.byteLength(args[key], 'utf8') > MAX_PATH_ARG_BYTES) return `argument-too-long name=${key} limit=${MAX_PATH_ARG_BYTES}`;
  for (const key of ['pattern', 'glob'] as const) if (typeof args[key] === 'string' && Buffer.byteLength(args[key], 'utf8') > MAX_PATTERN_ARG_BYTES) return `argument-too-long name=${key} limit=${MAX_PATTERN_ARG_BYTES}`;
  // A glob is matched per path by a bounded dynamic program; its length bounds that cost.
  const glob = typeof args['glob'] === 'string' ? args['glob'] : undefined;
  if (glob !== undefined && Buffer.byteLength(glob, 'utf8') > MAX_GLOB_ARG_BYTES) return `argument-too-long name=glob limit=${MAX_GLOB_ARG_BYTES}`;
  return null;
}
function validLimits(limits: WorkspaceReadLimits): WorkspaceReadLimits {
  const ok = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!ok(limits.maxResultBytes, 1024, 1024 * 1024) || !ok(limits.maxFileBytes, 1, 256 * 1024 * 1024)) throw new RangeError('WORKSPACE_READ_LIMITS_INVALID');
  return limits;
}

export interface WorkspaceReadTools {
  readonly specs: readonly AgentToolSpec[];
  readonly scope: WorkspaceScope;
  execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome>;
}

export async function createWorkspaceReadTools(root: string, options: { deny?: readonly string[]; limits?: Partial<WorkspaceReadLimits> } = {}): Promise<WorkspaceReadTools> {
  const limits = validLimits({ ...DEFAULT_WORKSPACE_READ_LIMITS, ...options.limits });
  const scope = await createWorkspaceScope(root, options.deny ?? DEFAULT_WORKSPACE_READ_DENY);
  const cancelled = (tool: string) => fail(tool, 'cancelled');

  const readFileTool = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome> => {
    const target = await scope.resolve(args['path']);
    if (!target.ok) return fail('read_file', `${target.error} path=${quote(args['path'])}`);
    const opened = await scope.open(target.rel, 'file');
    if (!opened.ok) return fail('read_file', `${opened.error} path=${quote(target.rel)}`);
    const read = await readBoundedTextFile(opened.handle, limits.maxFileBytes, signal);
    if (!read.ok) return read.kind === 'cancelled' ? cancelled('read_file') : fail('read_file', `${read.kind} (${read.detail}) path=${quote(target.rel)}`);
    const request = resolveReadFileViewRequest(args);
    let matching: ReadonlySet<number> | null = null;
    if (request.mode === 'search' && request.pattern !== null && compileSearchPattern(request.pattern, request.literal, request.ignoreCase)) {
      const re = compileSearchPattern(request.pattern, request.literal, request.ignoreCase)!;
      const runner = createRegexRunner(signal);
      try { matching = new Set(await runner.match(re.source, re.flags, splitLines(read.text))); }
      catch (error) { if (error instanceof RegexCancelled) return cancelled('read_file'); throw error; }
      finally { await runner.close(); }
    }
    return { status: 'ok', text: renderReadFileView(read.text, request, resolveReadFileBudget(limits.maxResultBytes), matching) };
  };

  const listDir = async (args: Record<string, unknown>): Promise<AgentToolOutcome> => {
    const target = await scope.resolve(args['path'], true);
    if (!target.ok) return fail('list_dir', `${target.error} path=${quote(args['path'] ?? '.')}`);
    const opened = await scope.open(target.rel, 'dir');
    if (!opened.ok) return fail('list_dir', `${opened.error} path=${quote(target.rel || '.')}`);
    let entries;
    try { entries = await readdir(`/proc/self/fd/${opened.handle.fd}`, { withFileTypes: true }); }
    catch { return fail('list_dir', `unreadable path=${quote(target.rel || '.')}`); }
    finally { await opened.handle.close().catch(() => undefined); }
    const relOf = (name: string) => target.rel === '' ? name : `${target.rel}/${name}`;
    const visible = entries.filter(entry => !scope.ignoredDirs.has(entry.name) && !scope.denied(relOf(entry.name))).sort((a, b) => a.name.localeCompare(b.name));
    const rows = visible.slice(0, MAX_LIST_ENTRIES).map(entry => entry.isDirectory() ? `${entry.name}/` : entry.isSymbolicLink() ? `${entry.name}@` : entry.name);
    const hidden = entries.length - visible.length;
    const trailer = [...(visible.length > MAX_LIST_ENTRIES ? [`[deckent] list_dir: ${visible.length} entries, showing ${MAX_LIST_ENTRIES}`] : []),
      ...(hidden > 0 ? [`[deckent] list_dir: ${hidden} ignored or protected entr${hidden === 1 ? 'y' : 'ies'} not shown`] : [])];
    return { status: 'ok', text: rows.length === 0 && trailer.length === 0 ? '[deckent] list_dir: empty directory' : rowsWithin(rows, trailer, limits.maxResultBytes, 'list a subdirectory') };
  };

  const grep = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome> => {
    const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : '';
    if (!pattern) return fail('grep', 'empty-pattern');
    const re = compileSearchPattern(pattern, false, args['ignoreCase'] === true);
    if (!re) return fail('grep', `invalid-pattern pattern=${quote(pattern)}`);
    const target = await scope.resolve(args['path'], true);
    if (!target.ok) return fail('grep', `${target.error} path=${quote(args['path'] ?? '.')}`);
    const only = typeof args['glob'] === 'string' && args['glob'] ? createGlobMatcher(args['glob']) : null;
    const hits: string[] = [], skipped: string[] = [];
    let scanned = 0, hitCapped = false;
    const runner = createRegexRunner(signal);
    const scanText = async (rel: string, text: string) => {
      const lines = splitLines(text);
      const matches = await runner.match(re.source, re.flags, lines);
      scanned++;
      for (const index of matches) {
        if (hits.length >= MAX_GREP_HITS) { hitCapped = true; return false; }
        hits.push(`${rel}:${index + 1}:${boundLine(lines[index]!, index + 1, 0, GREP_BYTES_PER_LINE).text}`);
      }
      return true;
    };
    try {
      const asFile = await scope.open(target.rel, 'file');
      let incomplete: string | null = null;
      if (asFile.ok) {
        const read = await readBoundedTextFile(asFile.handle, limits.maxFileBytes, signal);
        if (read.ok) await scanText(target.rel, read.text); else if (read.kind !== 'cancelled') skipped.push(`${target.rel} (${read.kind}: ${read.detail})`);
      } else if (asFile.error === 'hardlink-refused') skipped.push(`${target.rel} (hard link refused)`);
      else {
        incomplete = describeIncomplete(await walkWorkspaceFiles(scope, target.rel, async (rel, parent, name) => {
          if (only && !only(rel)) return true;
          const opened = await openWalkedFile(scope, parent, name, rel);
          if (!opened.ok) { skipped.push(`${rel} (${opened.reason})`); return true; }
          const read = await readBoundedTextFile(opened.handle, limits.maxFileBytes, signal);
          if (!read.ok) { if (read.kind !== 'cancelled') skipped.push(`${rel} (${read.kind}: ${read.detail})`); return read.kind !== 'cancelled'; }
          return await scanText(rel, read.text);
        }, signal));
      }
      if (signal?.aborted) return cancelled('grep');
      const notes = [...(hitCapped ? [`truncated (${MAX_GREP_HITS} hits cap); narrow with path or glob`] : []), ...(incomplete ? [incomplete] : []),
        ...skipped.slice(0, MAX_SKIP_NOTES).map(entry => `skipped ${entry}`), ...(skipped.length > MAX_SKIP_NOTES ? [`${skipped.length - MAX_SKIP_NOTES} more skipped file(s)`] : [])];
      const partial = skipped.length > 0 || incomplete !== null;
      const trailer = hits.length === 0
        ? [partial ? `[deckent] grep: no matches in ${scanned} scanned file(s); the search was not complete` : `[deckent] grep: no matches in ${scanned} scanned file(s)`, ...(notes.length ? [`[deckent] grep: ${notes.join('; ')}`] : [])]
        : notes.length ? [`[deckent] grep: ${notes.join('; ')}`] : [];
      return { status: 'ok', text: rowsWithin(hits, trailer, limits.maxResultBytes, 'narrow with path or glob') };
    } catch (error) {
      if (error instanceof RegexCancelled) return cancelled('grep');
      throw error;
    } finally { await runner.close(); }
  };

  const glob = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome> => {
    const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : '';
    if (!pattern) return fail('glob', 'empty-pattern');
    if (Buffer.byteLength(pattern, 'utf8') > MAX_GLOB_ARG_BYTES) return fail('glob', `argument-too-long name=pattern limit=${MAX_GLOB_ARG_BYTES}`);
    const target = await scope.resolve(args['path'], true);
    if (!target.ok) return fail('glob', `${target.error} path=${quote(args['path'] ?? '.')}`);
    const matches = createGlobMatcher(pattern), matched: string[] = [];
    const prefix = target.rel === '' ? '' : `${target.rel}/`;
    let hitCapped = false;
    const incomplete = describeIncomplete(await walkWorkspaceFiles(scope, target.rel, rel => {
      const local = rel.slice(prefix.length);
      if (!matches(local)) return true;
      if (matched.length >= MAX_GLOB_MATCHES) { hitCapped = true; return false; }
      matched.push(local); return true;
    }, signal));
    if (signal?.aborted) return cancelled('glob');
    const trailer = [...(hitCapped ? [`[deckent] glob: truncated (${MAX_GLOB_MATCHES} matches cap); narrow the pattern`] : []), ...(incomplete ? [`[deckent] glob: ${incomplete}`] : [])];
    if (matched.length === 0) return { status: 'ok', text: [incomplete ? '[deckent] glob: no matches in the scanned part' : '[deckent] glob: no matches', ...trailer].join('\n') };
    return { status: 'ok', text: rowsWithin(matched, trailer, limits.maxResultBytes, 'narrow the pattern') };
  };

  const run: Record<string, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolOutcome>> = { read_file: readFileTool, list_dir: listDir, grep, glob };
  return Object.freeze({
    specs: WORKSPACE_READ_TOOL_SPECS, scope,
    async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const label = sliceUtf8(Buffer.from(String(name), 'utf8'), 64);
      const tool = Object.hasOwn(run, name) ? run[name] : undefined;
      if (!tool) return fail(label, 'unknown-tool');
      if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(label, 'arguments-not-an-object');
      if (signal?.aborted) return cancelled(label);
      const problem = argumentProblem(args);
      if (problem) return fail(label, problem);
      let outcome: AgentToolOutcome;
      try { outcome = await tool(args, signal); } catch { outcome = fail(label, 'failed'); }
      return capped(signal?.aborted && outcome.status === 'ok' ? cancelled(label) : outcome, limits.maxResultBytes);
    },
  });
}
