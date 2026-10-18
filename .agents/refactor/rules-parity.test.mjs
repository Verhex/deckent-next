// Host rule-surface parity (Jev g3-kural-eslik, 2026-10-18): copies of the same rule must not drift silently.
// Reads tracked files only (git ls-files), because test:host runs on CI checkouts where untracked or ignored
// local files do not exist. Host-only material outside Git (external proof, LAW-GATE notes) is out of scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DOGFOOD_SOURCE } from './board.mjs';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const TRACKED = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0').filter(Boolean));
const TRACKED_DIRS = new Set([...TRACKED].flatMap(file => file.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))));
const read = file => fs.readFileSync(path.join(ROOT, file));
const RULE_FILE = /^(?:CLAUDE\.md|AGENTS\.md|\.codex\/AGENTS\.md|\.(?:claude|codex)\/rules\/[^/]+\.md|\.cursor\/rules\/[^/]+\.mdc|\.deckent\/docs\/core-memory\/[^/]+\.md)$/u;
const CORE_MEMORY = '.deckent/docs/core-memory/';
// Shrink-only: core-memory changes need owner approval (law_documents_and_memory), so a broken reference found there
// is listed here until an approved memory edit fixes it; a listed entry that resolves again must be removed.
// Format: '<file>:<line> → <target>'. Every other rule file tolerates no broken reference.
const CORE_MEMORY_BROKEN = Object.freeze([]);
// Cursor-only rules with no Claude/Codex counterpart.
const CURSOR_ONLY = Object.freeze(['deckent.mdc']);

/**
 * Splits a Cursor `.mdc` rule on raw bytes the way Cursor loads it: a `---` frontmatter block of `key: value` lines,
 * then the body that reaches the model. Strict on purpose (security review 2026-10-18, parser differential): a BOM,
 * CR line ending, missing or unterminated block, malformed or duplicate key, or anything but exactly `alwaysApply: true`
 * is refused, so a copy Cursor would not load unconditionally, or would load with a different body, cannot pass.
 * The body stays a Buffer and is compared byte for byte; decoding first would fold invalid UTF-8 into U+FFFD.
 */
/**
 * The YAML subset these rules use (Cursor rules format, prod.cursor.com/docs/reference/plugins#rules-format, read 2026-10-18:
 * description string, alwaysApply boolean, globs string or array). Astra 2648 F2: a line regex let `description: [` or an
 * unbalanced quote through, which is not valid YAML. Accepted here: exactly `description` as a YAML plain scalar that
 * resolves to a string, and `alwaysApply: true`. Flow collections, quotes, block scalars, anchors, tags, comments,
 * `key: value` inside a value, YAML booleans/null/numbers as a description, and `globs` (unused) are refused.
 */
const PLAIN_SCALAR_START = /^[^\s\-?:,[\]{}#&*!|>'"%@`]/u;
const NON_STRING_SCALAR = /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\.?\d[\d_]*(?:\.\d*)?(?:e[-+]?\d+)?|\.inf|\.nan))$/iu;
const FRONTMATTER = Object.freeze({
  description: value => /[\p{Cc}\uFEFF]/u.test(value) ? 'contains a control character'
    : !PLAIN_SCALAR_START.test(value) ? 'must be a plain YAML scalar (no flow collection, quote, block or indicator start)'
    : /: |\s#|[\t\r]|\s$|:$/u.test(value) ? 'plain scalar contains ": ", " #", a tab or trailing space/colon'
      : NON_STRING_SCALAR.test(value) ? 'would resolve to a non-string YAML scalar' : null,
  alwaysApply: value => value === 'true' ? null : 'must be exactly true (always loaded on every surface)',
});

export function parseCursorRule(buffer) {
  const OPEN = Buffer.from('---\n'), CLOSE = Buffer.from('\n---\n');
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('starts with a UTF-8 BOM');
  if (buffer.includes(0x0d)) throw new Error('contains a CR byte; rules use LF line endings');
  if (!buffer.subarray(0, OPEN.length).equals(OPEN)) throw new Error('does not start with a --- frontmatter line');
  const end = buffer.indexOf(CLOSE, OPEN.length - 1);
  if (end < 0) throw new Error('frontmatter block is not closed by a --- line');
  const fields = new Map();
  // Astra 2650 F2: decode the header losslessly (invalid UTF-8 is refused, never folded to U+FFFD) and allow only printable
  // characters: YAML 1.2.2 §5.1 forbids C0 controls except TAB/LF/CR; DEL, C1 controls and a BOM are refused here too.
  let header;
  try { header = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(OPEN.length, end)); } catch { throw new Error('frontmatter is not valid UTF-8'); }
  const control = /[^\P{Cc}\n]|\uFEFF/u.exec(header);
  if (control) throw new Error(`frontmatter contains control character U+${control[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  for (const line of header.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9]*): (.*)$/u.exec(line);
    if (!match) throw new Error(`malformed frontmatter line: ${JSON.stringify(line)}`);
    const [, key, value] = match;
    if (!Object.hasOwn(FRONTMATTER, key)) throw new Error(`unsupported frontmatter key ${key}`);
    if (fields.has(key)) throw new Error(`duplicate frontmatter key ${key}`);
    const problem = FRONTMATTER[key](value);
    if (problem) throw new Error(`${key}: ${problem}`);
    fields.set(key, value);
  }
  for (const key of Object.keys(FRONTMATTER)) if (!fields.has(key)) throw new Error(`frontmatter needs ${key}`);
  return { fields, body: buffer.subarray(end + CLOSE.length) };
}

/** Claude and Codex load `.claude/rules` / `.codex/rules` Markdown as-is; frontmatter (Claude `paths:` scoping) would load differently per tool. */
function assertPlainRule(file, buffer) {
  assert.ok(!buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${file} starts with a UTF-8 BOM`);
  assert.ok(!buffer.includes(0x0d), `${file} contains a CR byte; rules use LF line endings`);
  assert.ok(!buffer.subarray(0, 4).equals(Buffer.from('---\n')), `${file} has frontmatter; Claude would scope it while Codex and Cursor would not`);
}

/** True when a tracked file or directory exists at the target, following tracked symlinks (.codex/skills → .agents/skills). */
function trackedTarget(absolute) {
  if (!fs.existsSync(absolute)) return false;
  const real = path.relative(ROOT, fs.realpathSync(absolute)).split(path.sep).join('/');
  return TRACKED.has(real) || TRACKED_DIRS.has(real);
}
const firstSegmentTracked = (base, word) => {
  const head = path.posix.join(base, word.split('/')[0]);
  return TRACKED.has(head) || TRACKED_DIRS.has(head);
};

/**
 * Relative references a reader would follow: Markdown link targets (resolved against the file's directory) and
 * repository paths in backticks (whole span or one word of a command). A backtick word counts only when its first
 * segment is a tracked entry next to the file or at the repository root, so prose names, URLs, absolute host paths,
 * the Git-ignored host area (.deckent/host/) and the external proof folder (proof/…) are not repository references.
 */
export function references(file, text) {
  const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
      const target = decodeURI(match[1].split('#')[0]);
      if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
      found.push({ line: index + 1, target: path.posix.join(dir, target) });
    }
    for (const span of line.matchAll(/`([^`]+)`/gu)) for (const raw of span[1].split(/\s+/u)) {
      const word = raw.replace(/[),.;:]+$/u, '');
      if (!word.includes('/') || /:\/\/|[*{}=<>$~]|^[-/#@]/u.test(word) || word.startsWith('.deckent/host/')) continue;
      const base = firstSegmentTracked(dir, word) ? dir : firstSegmentTracked('', word) ? '' : null;
      if (base !== null) found.push({ line: index + 1, target: path.posix.join(base, word) });
    }
  });
  return found;
}

test('CLAUDE.md and AGENTS.md are byte-identical', () => {
  assert.ok(TRACKED.has('CLAUDE.md') && TRACKED.has('AGENTS.md'), 'both root instruction files are tracked');
  assert.ok(read('CLAUDE.md').equals(read('AGENTS.md')), 'CLAUDE.md and AGENTS.md differ; keep them byte-identical');
});

test('.claude/rules and .codex/rules carry the same tracked Markdown rules byte for byte', () => {
  const names = dir => [...TRACKED].filter(file => file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes('/') && file.endsWith('.md'))
    .map(file => file.slice(dir.length + 1)).sort();
  const claude = names('.claude/rules'), codex = names('.codex/rules');
  assert.ok(claude.length > 0, 'no tracked .claude/rules/*.md');
  assert.deepEqual(codex, claude, 'rule sets differ between .claude/rules and .codex/rules');
  for (const name of claude) {
    assertPlainRule(`.claude/rules/${name}`, read(`.claude/rules/${name}`));
    assert.ok(read(`.claude/rules/${name}`).equals(read(`.codex/rules/${name}`)), `${name} differs; copy .claude/rules/${name} to .codex/rules/${name}`);
  }
});

test('.cursor/rules carries the same rules as .claude/rules, with the same body under its frontmatter', () => {
  const claude = [...TRACKED].filter(file => /^\.claude\/rules\/[^/]+\.md$/u.test(file)).map(file => path.posix.basename(file, '.md')).sort();
  const cursor = [...TRACKED].filter(file => /^\.cursor\/rules\/[^/]+\.mdc$/u.test(file)).map(file => path.posix.basename(file))
    .filter(name => !CURSOR_ONLY.includes(name)).map(name => name.slice(0, -'.mdc'.length)).sort();
  assert.deepEqual(cursor, claude, 'rule sets differ between .claude/rules and .cursor/rules');
  for (const name of claude) {
    let rule;
    try { rule = parseCursorRule(read(`.cursor/rules/${name}.mdc`)); } catch (error) { assert.fail(`.cursor/rules/${name}.mdc: ${error.message}`); }
    assert.ok(rule.body.equals(read(`.claude/rules/${name}.md`)), `.cursor/rules/${name}.mdc body differs byte for byte from .claude/rules/${name}.md`);
  }
  for (const name of CURSOR_ONLY) assert.doesNotThrow(() => parseCursorRule(read(`.cursor/rules/${name}`)), `.cursor/rules/${name} must be a valid alwaysApply rule`);
});

test('the deckent-route router rule is present and alwaysApply on all three surfaces (source check, not a runtime load) and stays at or below 12 lines', () => {
  // Owner 2026-10-18 skill-surface decision 6: one cheap moment → skill router, byte-identical for Claude, Codex and Cursor.
  for (const file of ['.claude/rules/deckent-route.md', '.codex/rules/deckent-route.md', '.cursor/rules/deckent-route.mdc']) assert.ok(TRACKED.has(file), `${file} is not tracked`);
  assert.ok(read('.claude/rules/deckent-route.md').toString('utf8').trimEnd().split('\n').length <= 12, 'deckent-route.md exceeds 12 lines');
  assert.doesNotThrow(() => parseCursorRule(read('.cursor/rules/deckent-route.mdc')), 'the Cursor router rule must be a valid alwaysApply rule');
});

test('the Cursor rule parser refuses copies that Cursor would load differently or not at all', () => {
  const body = Buffer.from('# rule\n\nSame body.\n');
  const rule = text => Buffer.concat([Buffer.from(text), body]);
  assert.ok(parseCursorRule(rule('---\ndescription: d\nalwaysApply: true\n---\n')).body.equals(body));
  const refused = {
    bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), rule('---\ndescription: d\nalwaysApply: true\n---\n')]),
    crlf: rule('---\r\ndescription: d\r\nalwaysApply: true\r\n---\r\n'),
    'not always applied': rule('---\ndescription: d\nalwaysApply: false\n---\n'),
    'alwaysApply only in the body': Buffer.from('---\ndescription: d\n---\nalwaysApply: true\n---\n'),
    'duplicate key': rule('---\ndescription: d\nalwaysApply: false\nalwaysApply: true\n---\n'),
    'unterminated frontmatter': Buffer.from('---\ndescription: d\nalwaysApply: true\n'),
    'no description': rule('---\nalwaysApply: true\n---\n'),
    // Astra 2648 F2: invalid YAML headers that the earlier line regex accepted.
    'unclosed flow sequence': rule('---\ndescription: [\nalwaysApply: true\n---\n'),
    'unbalanced double quote': rule('---\ndescription: "\nalwaysApply: true\n---\n'),
    'unbalanced single quote': rule("---\ndescription: 'x\nalwaysApply: true\n---\n"),
    'flow mapping': rule('---\ndescription: {a: b}\nalwaysApply: true\n---\n'),
    'nested mapping in a value': rule('---\ndescription: a: b\nalwaysApply: true\n---\n'),
    'block scalar': rule('---\ndescription: |\nalwaysApply: true\n---\n'),
    'non-string description': rule('---\ndescription: true\nalwaysApply: true\n---\n'),
    'empty description': rule('---\ndescription: \nalwaysApply: true\n---\n'),
    'quoted boolean': rule('---\ndescription: d\nalwaysApply: "true"\n---\n'),
    'unsupported key': rule('---\ndescription: d\nalwaysApply: true\nglobs: *.ts\n---\n'),
    // Astra 2650 F2: raw control bytes and invalid UTF-8 in the header.
    'raw NUL in description': rule('---\ndescription: d\u0000\nalwaysApply: true\n---\n'),
    'raw ESC in description': rule('---\ndescription: d\u001b[31m\nalwaysApply: true\n---\n'),
    'raw DEL in description': rule('---\ndescription: d\u007f\nalwaysApply: true\n---\n'),
    'C1 control in description': rule('---\ndescription: d\u0085x\nalwaysApply: true\n---\n'),
    'raw TAB after alwaysApply': rule('---\ndescription: d\nalwaysApply: true\t\n---\n'),
    'invalid UTF-8 in header': Buffer.concat([Buffer.from('---\ndescription: d'), Buffer.from([0xff]), Buffer.from('\nalwaysApply: true\n---\n'), body]),
  };
  for (const [name, buffer] of Object.entries(refused)) assert.throws(() => parseCursorRule(buffer), Error, name);
  // A divergent body parses but must not equal the Claude copy, including invalid UTF-8 that decodes to the same U+FFFD.
  const parsed = parseCursorRule(Buffer.concat([Buffer.from('---\ndescription: d\nalwaysApply: true\n---\n'), Buffer.from([0x61, 0xff])]));
  assert.equal(parsed.body.toString('utf8'), Buffer.from([0x61, 0xfe]).toString('utf8'), 'both invalid bytes decode alike');
  assert.ok(!parsed.body.equals(Buffer.from([0x61, 0xfe])), 'byte comparison still tells them apart');
});

test('board.mjs DOGFOOD_SOURCE names a tracked file that still contains the cited heading', () => {
  const [file, heading, ...rest] = DOGFOOD_SOURCE.split(' · ');
  assert.equal(rest.length, 0); assert.ok(file && heading, `DOGFOOD_SOURCE must be "<file> · <heading>": ${DOGFOOD_SOURCE}`);
  assert.ok(TRACKED.has(file), `DOGFOOD_SOURCE file is not tracked: ${file}`);
  const headings = read(file).toString('utf8').split('\n').map(line => /^#{1,6}\s+(.+?)\s*$/u.exec(line)?.[1]).filter(Boolean);
  assert.ok(headings.includes(heading), `${file} has no heading "${heading}"`);
});

test('relative references in tracked rule files resolve; core-memory breaks only shrink', () => {
  const ruleFiles = [...TRACKED].filter(file => RULE_FILE.test(file)).sort();
  assert.ok(ruleFiles.includes('CLAUDE.md') && ruleFiles.some(file => file.startsWith(CORE_MEMORY)), 'rule file set unexpectedly empty');
  const broken = [];
  let checked = 0;
  for (const file of ruleFiles) for (const ref of references(file, read(file).toString('utf8'))) {
    checked++;
    if (!trackedTarget(path.join(ROOT, ref.target))) broken.push(`${file}:${ref.line} → ${ref.target}`);
  }
  assert.ok(checked > 0, 'no references found; the extractor is broken');
  const listed = new Set(CORE_MEMORY_BROKEN);
  const unexpected = broken.filter(entry => !entry.startsWith(CORE_MEMORY) || !listed.has(entry));
  assert.deepEqual(unexpected, [], 'broken rule references (fix the target or the reference)');
  const stale = CORE_MEMORY_BROKEN.filter(entry => !broken.includes(entry));
  assert.deepEqual(stale, [], 'CORE_MEMORY_BROKEN entries resolve again; remove them (shrink-only)');
});

test('the reference extractor follows links and repository paths, not prose, URLs or host areas', () => {
  const text = [
    'See [contract](../skills/x.md#part), [web](https://example.com) and [top](#anchor).',
    'Run `node .agents/refactor/board.mjs show` and `scripts/lint-docs.mjs`; read `deckent-next-refactor`.',
    'Host `.deckent/host/process-board.json`, proof `proof/X/review.md`, `/abs/path`, `<root>/a.md`, `owner/repo`.',
  ].join('\n');
  assert.deepEqual(references('.codex/rules/x.md', text), [
    { line: 1, target: '.codex/skills/x.md' },
    { line: 2, target: '.agents/refactor/board.mjs' },
    { line: 2, target: 'scripts/lint-docs.mjs' },
  ]);
});
