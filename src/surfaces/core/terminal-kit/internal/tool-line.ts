import type { ToolResultSummary } from './turn-stream.js';

/**
 * Tool-line presentation derived entirely client-side from data the engine already puts on the wire (TL-B D2,
 * TERM-LOOP-UX analysis §2/§4/§8): the model's own recorded call arguments (an assistant `message` event, before
 * `tool.started`) and the call's own recorded result text (a `message` event of role 'tool', right before
 * `tool.finished`). Neither function changes a protocol event or the C12 approval subject/resource — those still come
 * from the engine's `describeAgentCall` (`composition/core/agent-turn/internal/call-approvals.ts`), untouched here.
 */

/** grep/glob show their pattern first (`call-approvals.ts`'s `displayTarget` shows `path` before `pattern`, the exact
 * "grep src" defect the analysis found: `call-approvals.ts:8`). Every other tool's engine target is shown as is —
 * `null` here means "use the engine's target unchanged", never "no target". */
export function describeAgentToolCallTarget(name: string, argumentsJson: string | undefined): string | null {
  if ((name !== 'grep' && name !== 'glob') || !argumentsJson) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsJson); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const args = parsed as Record<string, unknown>;
  const field = (key: string) => typeof args[key] === 'string' && args[key] ? args[key] as string : null;
  const pattern = field('pattern');
  if (pattern === null) return null;
  const path = field('path'), glob = name === 'grep' ? field('glob') : null;
  return [`"${pattern}"`, ...(path ? [path] : []), ...(glob ? [`(${glob})`] : [])].join(' ');
}

const META_PREFIX = '[deckent] ';
/** Lines a read-class tool's own text marks as content (never the leading meta line, a skip note or a truncation
 * marker — all of those start with the tool's own `[deckent] ` prefix by construction, `workspace-read/internal/tools.ts`). */
const countContentLines = (content: string) => content.split('\n').filter(line => line.length > 0 && !line.startsWith(META_PREFIX)).length;
const hasMetaNote = (content: string) => content.split('\n').some(line => line.startsWith(META_PREFIX));

// grep's own line shapes (`workspace-read/internal/tools.ts`): a real hit is `path:line:text`; a context row around
// it, only ever present when the model asked for `context` (Astra 2143 R2), is `path:line-text`; a gap between two
// non-adjacent context blocks is a lone `--` row. Only the first shape is a match — the summary must not let context
// rows or the block separator inflate the count the user sees. The check anchors on the FIRST colon (`[^:]*`, no
// colons allowed before it): that is always the path/line-number boundary, so it cannot keep scanning into a
// context line's own content and mistake something shaped like `12:34:56` (a timestamp is the everyday case) for
// the marker. Known limit: this is still shape-derived (no new wire field, TL-B D2), so a workspace-relative path
// that itself contained a literal ':' would be undercounted here; this product's paths never do.
const GREP_HIT_LINE = /^[^:]*:\d+:/;
const countGrepHitLines = (content: string) => content.split('\n').filter(line => line.length > 0 && !line.startsWith(META_PREFIX) && GREP_HIT_LINE.test(line)).length;

function readFileSummary(content: string): ToolResultSummary | null {
  const meta = content.split('\n', 1)[0] ?? '';
  const range = /^\[deckent\] read_file: mode=range totalLines=(\d+) range=\S+ returned=(\d+) hasMore=(true|false)/.exec(meta);
  if (range) return { kind: 'lines', shown: Number(range[2]), total: Number(range[1]), more: range[3] === 'true' };
  const outline = /^\[deckent\] read_file: mode=outline .*headings=(\d+) shown=(?:none|(\d+)-(\d+)) hasMore=(true|false)/.exec(meta);
  if (outline) {
    const shown = outline[2] !== undefined ? Number(outline[3]) - Number(outline[2]) + 1 : 0;
    return { kind: 'headings', shown, total: Number(outline[1]), more: outline[4] === 'true' };
  }
  const search = /^\[deckent\] read_file: mode=search .*totalLines=\d+ matches=(\d+)(\+)? shown=\d+ context=\d+ hasMore=(true|false)/.exec(meta);
  if (search) return { kind: 'matches', count: Number(search[1]), more: search[2] !== undefined || search[3] === 'true' };
  return null;
}

/** Read-class result text is always either a leading meta line (read_file) or a plain list of content lines (grep,
 * glob, list_dir) with `[deckent] `-prefixed notes only for skips/caps/errors — so a match count and a coarse "may be
 * incomplete" flag come from the shape of the text itself, without tools.ts adding a single new meta line for D2. */
export function summarizeAgentToolResult(name: string, content: string): ToolResultSummary | null {
  // S5: only the trusted leading metadata carries posture; command stdout cannot supply this prefix.
  if (name === 'run_shell') return content.startsWith('[deckent] run_shell: sandbox: none; ') ? { kind: 'sandbox-none' } : null;
  if (name === 'read_file') return readFileSummary(content);
  if (name === 'grep') {
    const count = countGrepHitLines(content);
    return { kind: 'matches', count, more: count > 0 && hasMetaNote(content) };
  }
  if (name === 'glob') {
    const count = countContentLines(content);
    return { kind: 'matches', count, more: count > 0 && hasMetaNote(content) };
  }
  if (name === 'list_dir') return { kind: 'entries', count: countContentLines(content) };
  return null;
}
