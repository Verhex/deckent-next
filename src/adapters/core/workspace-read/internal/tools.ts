import { readdir } from 'node:fs/promises';
import type { AgentToolOutcome, AgentToolSpec } from '#domain/index.js';
import { boundLine, readBoundedTextFile, sliceUtf8, splitLines } from './bounded.js';
import { compileSearchPattern, metaPattern, renderReadFileView, resolveReadFileBudget, resolveReadFileViewRequest } from './views.js';
import { createGlobMatcher, createWorkspaceScope, DEFAULT_WORKSPACE_READ_DENY, describeIncomplete, MAX_WALK_DEPTH, openWalkedFile, walkWorkspaceFiles,
  type WorkspacePathDiagnostic, type WorkspacePathError, type WorkspaceScope } from './scope.js';
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
// 64 KiB (owner, TL-B D3, TERM-LOOP-UX analysis §5/§8): 16 KiB forced every 15-20 KB source file into a second round.
export const DEFAULT_WORKSPACE_READ_LIMITS: WorkspaceReadLimits = Object.freeze({ maxResultBytes: 65_536, maxFileBytes: 16 * 1024 * 1024 });
const MAX_LIST_ENTRIES = 500, MAX_GLOB_MATCHES = 500, MAX_GREP_HITS = 200, GREP_BYTES_PER_LINE = 2048, MAX_SKIP_NOTES = 32, GREP_MAX_CONTEXT = 5;
const MAX_PATH_ARG_BYTES = 4096, MAX_PATTERN_ARG_BYTES = 2048, MAX_GLOB_ARG_BYTES = 512;

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', minimum: 0, description });
/** Clamps a model-supplied integer argument into range; anything absent or unparsable falls back rather than erroring
 * (read_file's `context`/`maxMatches` set the precedent: the cap is informational in the schema, enforced here). */
function boundedIntArg(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
export const WORKSPACE_READ_TOOL_SPECS: readonly AgentToolSpec[] = Object.freeze([
  { name: 'read_file', version: 1, toolClass: 'read', description: 'Read a workspace file (prefer this over shell tools for reading). Every result starts with a "[deckent] read_file:" line that says what was returned and how to continue. mode "outline": headings with line numbers and size/longest-line statistics (take this first on big files); startLine/endLine: numbered lines, long lines elided with an exact re-read marker; pattern: grep-style matches with optional context.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: str('Workspace-relative path.'), mode: { type: 'string', enum: ['content', 'outline', 'search'] },
      startLine: int('1-based first line.'), endLine: int('1-based last line (inclusive).'), lineByteOffset: int('Byte offset inside long lines.'),
      maxBytesPerLine: int('Per-line byte window.'), outlineOffset: int('1-based first heading.'), pattern: str('Regular expression (search mode).'),
      literal: { type: 'boolean' }, ignoreCase: { type: 'boolean' }, context: int('Context lines around matches (max 10).'), maxMatches: int('Max matches (max 500).') } } },
  { name: 'list_dir', version: 1, toolClass: 'read', description: 'List a workspace directory; directories end with "/".',
    inputSchema: { type: 'object', properties: { path: str('Workspace-relative directory; default the workspace root.') } } },
  { name: 'grep', version: 1, toolClass: 'read', description: 'Search workspace files with a regular expression; returns path:line:text hits, or path:line-text context lines around them when requested. Long lines are elided, never missed; skipped files and unscanned directories are reported. A result with hits ends with "[deckent] grep: matches=N" (N hit lines returned; "N+" when more exist).',
    inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: str('Regular expression.'), path: str('Directory or file to search; default the workspace root.'),
      glob: str('Only files whose workspace-relative path matches this glob.'), ignoreCase: { type: 'boolean' },
      context: int('Context lines around each hit (max 5).'), maxHits: int('Cap on hits that open a context window (max 200); hits inside an opened window are also shown.') } } },
  { name: 'glob', version: 1, toolClass: 'read', description: 'Find workspace files by glob ("**" any directories, "*" within a name).',
    inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: str('Glob relative to path.'), path: str('Directory; default the workspace root.') } } },
] as const satisfies readonly AgentToolSpec[]);

const quote = (value: unknown) => metaPattern(String(value ?? ''));
const fail = (tool: string, detail: string): AgentToolOutcome => ({ status: 'error', text: `[deckent] ${tool}: error=${detail}` });
/**
 * A refused workspace path (B4 diagnosis, owner terminal test 2026-10-07): `not-found` and `path-changed` also say at which step they fell
 * (`realpath`, `open:<segment>`, `verify:<segment>`, `stat`) and the errno, in the text (`error=not-found step=open:2 errno=ENOENT path=…`)
 * and as the outcome's `diagnostic` (the turn's tool-call record keeps it). No path or content beyond the requested one is added.
 */
function pathFail(tool: string, refused: { readonly error: WorkspacePathError; readonly diagnostic?: WorkspacePathDiagnostic }, path: string): AgentToolOutcome {
  const diagnostic = refused.error === 'not-found' || refused.error === 'path-changed' ? refused.diagnostic : undefined;
  const detail = diagnostic ? ` step=${diagnostic.step}${diagnostic.errno ? ` errno=${diagnostic.errno}` : ''}` : '';
  return { status: 'error', text: `[deckent] ${tool}: error=${refused.error}${detail} path=${path}`, ...(diagnostic ? { diagnostic } : {}) };
}
/** The last line of defence for every branch: a result never exceeds the cap, and a cut always says so (Astra 2072 R3). */
function capped(outcome: AgentToolOutcome, maxBytes: number): AgentToolOutcome {
  const bytes = Buffer.byteLength(outcome.text, 'utf8');
  if (bytes <= maxBytes) return outcome;
  const marker = `\n[deckent] result cut at the ${maxBytes}-byte cap (${bytes} bytes); narrow the request`;
  return { status: outcome.status, text: sliceUtf8(Buffer.from(outcome.text, 'utf8'), maxBytes - Buffer.byteLength(marker, 'utf8')) + marker };
}
/** Rows that fit the byte budget before the trailer; a cut is always stated with how to narrow. `kept` counts the rows returned. */
function fitRows(rows: readonly string[], trailer: readonly string[], maxBytes: number, narrow: string, extraReserve = 0) {
  const reserve = Buffer.byteLength(trailer.join('\n'), 'utf8') + 160 + extraReserve, out: string[] = [];
  let used = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(row, 'utf8') + 1;
    if (used + bytes > maxBytes - reserve) return { lines: [...out, `[deckent] truncated at ${out.length} of ${rows.length} rows (result byte cap); ${narrow}`], kept: out.length };
    out.push(row); used += bytes;
  }
  return { lines: out, kept: out.length };
}
/** Joins rows until the byte budget; a cut is always stated with how to narrow. */
function rowsWithin(rows: readonly string[], trailer: readonly string[], maxBytes: number, narrow: string): string {
  const tail = trailer.join('\n');
  return [...fitRows(rows, trailer, maxBytes, narrow).lines, ...(tail ? [tail] : [])].join('\n');
}
/** grep's exact count, always its last line when it returned hits (Astra 2145 R2): the hit rows cannot be parsed back reliably (a
 * workspace path may contain ':'), so the terminal reads only this line. Bounded: at most 200 windows × 11 lines. */
const GREP_COUNT_RESERVE = 48;
const grepCountLine = (shown: number, more: boolean) => `[deckent] grep: matches=${shown}${more ? '+' : ''}`;
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

/**
 * B4 diagnosis (owner terminal test 2026-10-07: `glob src/deneme.md` said "no matches" for a file on disk). For a pattern without wildcards
 * that matched nothing, one line says which filter of the walk drops that path: `deny` (decided by name only: a protected path's existence is
 * never probed), `symlink` (the walk does not follow links), `ignored` (a `.gitignore` or baseline name on its path), `depth`, or `none` (it
 * exists, nothing filters it, and how it opens), else that it is not there with the failing step and errno. No content, no absolute path.
 */
async function literalGlobNote(scope: WorkspaceScope, prefix: string, pattern: string): Promise<string | null> {
  if (/[*?[\]{}]/u.test(pattern)) return null;
  const rel = `${prefix}${pattern}`.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '');
  if (rel === '' || rel.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return null;
  const segments = rel.split('/'), named = `[deckent] glob: path=${quote(rel)}`;
  if (segments.some((_, i) => scope.denied(segments.slice(0, i + 1).join('/')))) return `${named} filter=deny (a protected path is never listed)`;
  const resolved = await scope.resolve(rel);
  if (!resolved.ok) {
    const d = resolved.diagnostic;
    return `${named} not there (error=${resolved.error}${d ? ` step=${d.step}${d.errno ? ` errno=${d.errno}` : ''}` : ''})`;
  }
  if (resolved.rel !== rel) return `${named} filter=symlink (the walk does not follow links)`;
  const ignored = segments.find(segment => scope.ignoredDirs.has(segment));
  if (ignored !== undefined) return `${named} filter=ignored name=${quote(ignored)} (.gitignore or baseline name)`;
  if (segments.length - 1 > MAX_WALK_DEPTH) return `${named} filter=depth (beyond ${MAX_WALK_DEPTH} directories)`;
  const opened = await scope.open(rel, 'file');
  if (opened.ok) { await opened.handle.close().catch(() => undefined); return `${named} filter=none open=ok (it exists and no filter drops it)`; }
  const d = opened.diagnostic;
  return `${named} filter=none open=${opened.error}${d ? ` step=${d.step}${d.errno ? ` errno=${d.errno}` : ''}` : ''}`;
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
    if (!target.ok) return pathFail('read_file', target, quote(args['path']));
    const opened = await scope.open(target.rel, 'file');
    if (!opened.ok) return pathFail('read_file', opened, quote(target.rel));
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
    if (!target.ok) return pathFail('list_dir', target, quote(args['path'] ?? '.'));
    const opened = await scope.open(target.rel, 'dir');
    if (!opened.ok) return pathFail('list_dir', opened, quote(target.rel || '.'));
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
    if (!target.ok) return pathFail('grep', target, quote(args['path'] ?? '.'));
    const only = typeof args['glob'] === 'string' && args['glob'] ? createGlobMatcher(args['glob']) : null;
    // D3 (owner): grep gains read_file's `context`/cap naming; context=0 (the default) keeps the exact old one-line-per-hit
    // shape (no separators), so every existing caller and result is unaffected.
    const context = boundedIntArg(args['context'], 0, 0, GREP_MAX_CONTEXT);
    const maxHits = boundedIntArg(args['maxHits'], MAX_GREP_HITS, 1, MAX_GREP_HITS);
    // One row per seed hit (its whole context window when context > 0) and, per row, the ':'-marked hit lines it holds. `maxHits`
    // caps seed hits (windows opened); hits inside an opened window are shown and counted too (Astra 2145 R2).
    const hits: string[] = [], hitLines: number[] = [], skipped: string[] = [];
    let scanned = 0, hitCapped = false;
    const runner = createRegexRunner(signal);
    const scanText = async (rel: string, text: string) => {
      const lines = splitLines(text);
      const matches = await runner.match(re.source, re.flags, lines);
      scanned++;
      // Every real match line keeps its ':' marker regardless of which match's context window prints it (Astra 2143
      // R2): two matches close enough that their windows touch or overlap must not let the earlier window's block
      // print the later match's own line as plain context ('-') just because it wasn't *that* window's `index`.
      const matchSet = context > 0 ? new Set(matches) : null;
      let lastEmitted = 0, firstBlockOfFile = true;
      for (const index of matches) {
        if (hits.length >= maxHits) { hitCapped = true; return false; }
        if (context === 0) { hits.push(`${rel}:${index + 1}:${boundLine(lines[index]!, index + 1, 0, GREP_BYTES_PER_LINE).text}`); hitLines.push(1); continue; }
        const from = Math.max(index - context, lastEmitted), to = Math.min(lines.length - 1, index + context);
        // This match's whole window already printed inside an earlier, still-open block (its own line included,
        // correctly marked ':' there via matchSet) — nothing new to emit, and pushing would add an empty row.
        if (from > to) continue;
        const block: string[] = [];
        let marked = 0;
        if (!firstBlockOfFile && from > lastEmitted) block.push('--');
        for (let j = from; j <= to; j++) {
          const hit = matchSet!.has(j); if (hit) marked++;
          block.push(`${rel}:${j + 1}${hit ? ':' : '-'}${boundLine(lines[j]!, j + 1, 0, GREP_BYTES_PER_LINE).text}`);
        }
        hits.push(block.join('\n')); hitLines.push(marked); lastEmitted = to + 1; firstBlockOfFile = false;
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
      const notes = [...(hitCapped ? [`truncated (${maxHits} hits cap); narrow with path or glob`] : []), ...(incomplete ? [incomplete] : []),
        ...skipped.slice(0, MAX_SKIP_NOTES).map(entry => `skipped ${entry}`), ...(skipped.length > MAX_SKIP_NOTES ? [`${skipped.length - MAX_SKIP_NOTES} more skipped file(s)`] : [])];
      const partial = skipped.length > 0 || incomplete !== null;
      if (hits.length === 0) {
        const trailer = [partial ? `[deckent] grep: no matches in ${scanned} scanned file(s); the search was not complete` : `[deckent] grep: no matches in ${scanned} scanned file(s)`, ...(notes.length ? [`[deckent] grep: ${notes.join('; ')}`] : [])];
        return { status: 'ok', text: rowsWithin(hits, trailer, limits.maxResultBytes, 'narrow with path or glob') };
      }
      // Counted after the byte cap: N is the hit lines this result returns, and a cut row makes it `N+`.
      const notesLine = notes.length ? [`[deckent] grep: ${notes.join('; ')}`] : [];
      const fitted = fitRows(hits, notesLine, limits.maxResultBytes, 'narrow with path or glob', GREP_COUNT_RESERVE);
      const shown = hitLines.slice(0, fitted.kept).reduce((sum, count) => sum + count, 0);
      const more = hitCapped || partial || fitted.kept < hits.length;
      return { status: 'ok', text: [...fitted.lines, ...notesLine, grepCountLine(shown, more)].join('\n') };
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
    if (!target.ok) return pathFail('glob', target, quote(args['path'] ?? '.'));
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
    if (matched.length === 0) {
      const note = await literalGlobNote(scope, prefix, pattern);
      return { status: 'ok', text: [incomplete ? '[deckent] glob: no matches in the scanned part' : '[deckent] glob: no matches', ...trailer, ...(note ? [note] : [])].join('\n') };
    }
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
