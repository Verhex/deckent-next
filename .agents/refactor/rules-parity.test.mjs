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
  for (const name of claude) assert.ok(read(`.claude/rules/${name}`).equals(read(`.codex/rules/${name}`)), `${name} differs; copy .claude/rules/${name} to .codex/rules/${name}`);
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
