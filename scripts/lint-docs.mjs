#!/usr/bin/env node
// Fast, offline documentation size, release-drift, link and EN/TR pair gate (owner 2026-10-08; links 2026-10-18).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIMITS = { planBytes: 60 * 1024, planLineChars: 800, architectureLines: 1200 };
const read = (name) => readFileSync(join(ROOT, name), 'utf8');
const failures = [];
const fail = (where, message) => failures.push(`${where.replaceAll('\\', '/')}: ${message}`);
const anchorCache = new Map();
// Shrink-only baseline: English-only docs at the gate's introduction (2026-10-18). The Turkish overview links the English
// page with an "(EN)" label. An entry is removed when its pair lands; adding one needs an owner decision.
const UNPAIRED_BASELINE = new Set(['docs/secret-helpers.md']);
// SemVer precedence: numeric prerelease identifiers compare numerically; build metadata is ignored.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
function version(value) {
  const match = versionPattern.exec(value);
  if (!match || match[4]?.split('.').some(id => /^0\d+$/u.test(id))) throw new Error(`invalid SemVer: ${value}`);
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? [] };
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/u.test(x), yn = /^\d+$/u.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
// PR-based landing began with PR #1 (opened 2026-10-04T19:21Z). alpha.1–4 (2026-09-16..2026-10-03) landed as direct main
// commits whose GitHub associated-PR lists are empty, so no PR number exists to cite. Only for versions below this fixed
// cutoff is the PR-number receipt waived; their SHA ref and the PR-pending rejection still apply. Never move the cutoff.
const FIRST_PR_RELEASE = version('1.0.0-alpha.5');
function architectureFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? architectureFiles(path) : entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}
let planBytes = 0, architectureLines = 0;
try {
  const plan = read('PLAN.md');
  planBytes = Buffer.byteLength(plan);
  if (planBytes > LIMITS.planBytes) fail('PLAN.md', `${planBytes} bytes > ${LIMITS.planBytes}`);
  plan.split('\n').forEach((line, index) => { if (line.length > LIMITS.planLineChars) fail(`PLAN.md:${index + 1}`, `${line.length} chars > ${LIMITS.planLineChars}`); });
  const architecture = read('ARCHITECTURE.md');
  architectureLines = architecture.trimEnd().split('\n').length;
  if (architectureLines > LIMITS.architectureLines) fail('ARCHITECTURE.md', `${architectureLines} lines > ${LIMITS.architectureLines}`);
  const packageVersion = JSON.parse(read('package.json')).version, current = version(packageVersion);
  const releases = read('CHANGELOG.md').split('\n').flatMap((line, index) => {
    const match = /^\s*-\s+\*\*([^*]+)\*\*/u.exec(line);
    return match ? [{ line, number: index + 1, value: match[1] }] : [];
  });
  if (releases[0]?.value !== packageVersion) fail('CHANGELOG.md', `first release ${releases[0]?.value ?? '(missing)'} must equal package.json ${packageVersion}`);
  for (const [index, release] of releases.entries()) {
    const where = `CHANGELOG.md:${release.number}`;
    if (compare(version(release.value), current) > 0) continue;
    // Explicit Unreleased is the only exemption; a prerelease version alone is not an unlanded release.
    if (index === 0 && release.value === packageVersion && /^\s*-\s+\*\*[^*]+\*\*\s*—\s*Unreleased\b/iu.test(release.line)) continue;
    if (/\bPR\s+pending\b/iu.test(release.line)) fail(where, 'landed release contains PR pending');
    if (compare(version(release.value), FIRST_PR_RELEASE) >= 0 && !/\bPRs?\s+#[1-9]\d*\b/iu.test(release.line)) fail(where, 'landed release must name a PR number (PR #N)');
    // The first ref after the date must be a SHA, not a branch followed by a SHA elsewhere in the prose.
    if (!/\*\*\s*—\s*\d{4}-\d{2}-\d{2}\s*·\s*`[0-9a-f]{7,40}`(?:\s|$)/iu.test(release.line)) fail(where, 'landed ref after the date must be a commit SHA, not a branch');
  }
  // An alpha is `alpha.N` or a hotfix `alpha.N.M` (alpha.55.1, 2026-10-24); compared as (N, M) with M = 0 when absent.
  const alphaOf = (text) => { const match = /-alpha\.(\d+)(?:\.(\d+))?(?:\+.*)?$/u.exec(text); return match ? [BigInt(match[1]), BigInt(match[2] ?? 0)] : null; };
  const alphaName = ([major, minor]) => minor ? `${major}.${minor}` : `${major}`;
  const packageAlpha = /^\d+\.\d+\.\d+-alpha\.\d+(?:\.\d+)?(?:\+.*)?$/u.test(packageVersion) ? alphaOf(packageVersion) : null;
  // Public docs describe what is live: the package version once released, or the last released version while the top CHANGELOG line is Unreleased.
  const unreleasedTop = /^\s*-\s+\*\*[^*]+\*\*\s*—\s*Unreleased\b/iu.test(releases[0]?.line ?? '');
  const lastReleasedAlpha = alphaOf((unreleasedTop ? releases[1] : releases[0])?.value ?? '');
  if (packageAlpha) for (const name of ['README.md', 'README.tr.md', 'SECURITY.md']) {
    const alphas = [...read(name).matchAll(/\balpha\.(\d+)(?:\.(\d+))?\b/gu)].map(match => [BigInt(match[1]), BigInt(match[2] ?? 0)]);
    const highest = alphas.reduce((max, value) => value[0] > max[0] || value[0] === max[0] && value[1] > max[1] ? value : max, [-1n, 0n]);
    const allowed = new Set([alphaName(packageAlpha), ...(unreleasedTop && lastReleasedAlpha ? [alphaName(lastReleasedAlpha)] : [])]);
    if (!allowed.has(alphaName(highest))) fail(name, `highest alpha.${alphaName(highest)} must equal package.json ${packageVersion}${unreleasedTop && lastReleasedAlpha ? ` or the last released alpha.${alphaName(lastReleasedAlpha)}` : ''}`);
  }
  for (const name of ['ARCHITECTURE.md', ...architectureFiles('.deckent/docs/architecture')]) {
    read(name).split('\n').forEach((line, index) => {
      const phrase = /\b(?:unpushed|not landed|review open|PR pending)\b/iu.exec(line)?.[0];
      if (phrase && !/^\s*(?:[-*>]\s*)?historical:/iu.test(line)) fail(`${name}:${index + 1}`, `forbidden phrase "${phrase}"; update the claim or prefix a historical record with historical:`);
    });
  }
  // Stage 1 link gate (Jev g3-lint-docs, 2026-10-18): relative Markdown links resolve to an existing file and anchor, and
  // every docs/X.md has docs/X.tr.md linking the same targets (anchors are language-specific and ignored for the pair).
  const publicDocs = readdirSync(join(ROOT, 'docs'), { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => `docs/${entry.name}`);
  // Every root Markdown file except COMPLETED-PLAN.md (its history links name host folders outside the repository), docs/ recursively.
  const rootDocs = readdirSync(ROOT, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'COMPLETED-PLAN.md').map(entry => entry.name);
  const linkScope = [...new Set([...rootDocs, ...architectureFiles('.deckent/docs/architecture'), ...architectureFiles('docs')])];
  for (const name of linkScope.map(path => path.replaceAll('\\', '/'))) {
    for (const link of markdownLinks(read(name))) {
      const where = `${name}:${link.line}`, target = linkTarget(name, link.target);
      if (!target) continue;
      if (!existsSync(join(ROOT, target.path))) { fail(where, `link target ${link.target} does not exist`); continue; }
      if (target.anchor !== undefined && target.path.endsWith('.md') && !anchors(target.path).has(target.anchor)) fail(where, `link anchor #${target.anchor} not found in ${target.path}`);
    }
  }
  for (const name of UNPAIRED_BASELINE) if (!publicDocs.includes(name)) fail(name, 'unpaired baseline entry no longer exists; remove it');
  for (const name of publicDocs.filter(path => !path.endsWith('.tr.md'))) {
    const turkish = name.replace(/\.md$/u, '.tr.md');
    const paired = existsSync(join(ROOT, turkish));
    if (UNPAIRED_BASELINE.has(name)) { if (paired) fail(name, `${turkish} exists; remove ${name} from the unpaired baseline`); continue; }
    if (!paired) fail(name, `missing Turkish pair ${turkish}`);
  }
  // Every Turkish page (README, docs/, architecture documents) is compared with its English page.
  const turkishPages = ['README.tr.md', ...publicDocs, ...architectureFiles('.deckent/docs/architecture')].map(path => path.replaceAll('\\', '/')).filter(path => path.endsWith('.tr.md'));
  for (const turkish of turkishPages) {
    const name = turkish.replace(/\.tr\.md$/u, '.md');
    if (existsSync(join(ROOT, name))) checkPair(name, turkish); else fail(turkish, `missing English pair ${name}`);
  }
} catch (error) { fail('input', error.message); }
// Fenced code blocks are not prose: yields [line number, text] for lines outside them.
function proseLines(text) {
  let fence;
  return text.split('\n').flatMap((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length)))) { fence = fence ? undefined : marker; return []; }
    return fence ? [] : [[index + 1, line]];
  });
}
// Inline [text](target "title") links and [label]: target definitions outside code spans.
function markdownLinks(text) {
  return proseLines(text).flatMap(([line, raw]) => {
    const prose = raw.replace(/(`+)[^`]*?\1/gu, '');
    const inline = [...prose.matchAll(/\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/gu)].map(match => match[1]);
    const definition = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/u.exec(prose)?.[1];
    return [...inline, ...(definition ? [definition] : [])].map(target => ({ line, target }));
  });
}
// Repository path and decoded anchor of a relative link; undefined for a URL with a scheme or a protocol-relative URL.
function linkTarget(from, target) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) return undefined;
  const hash = target.indexOf('#'), path = (hash < 0 ? target : target.slice(0, hash)).split('?')[0];
  const anchor = hash < 0 ? undefined : decodeURIComponent(target.slice(hash + 1));
  const decoded = decodeURIComponent(path);
  const resolved = decoded === '' ? from : decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(from), decoded);
  return { path: posix.normalize(resolved).replace(/\/$/u, '') || '.', anchor };
}
// Pair comparison: a local target counts once per language (X.tr.md and X.md are the same document), URLs as written.
function linkTargets(name) {
  return new Set(markdownLinks(read(name)).map(({ target }) => {
    const local = linkTarget(name, target);
    return local ? local.path.replace(/\.tr\.md$/u, '.md') : target.split('#')[0];
  }));
}
// An EN/TR pair links the same targets and keeps the same ATX heading levels in the same order (heading text is translated).
function checkPair(name, turkish) {
  const english = linkTargets(name), translated = linkTargets(turkish);
  for (const target of english) if (!translated.has(target)) fail(turkish, `missing link target ${target} present in ${name}`);
  for (const target of translated) if (!english.has(target)) fail(name, `missing link target ${target} present in ${turkish}`);
  const levels = headingLevels(name), turkishLevels = headingLevels(turkish);
  const at = levels.findIndex((level, index) => level !== turkishLevels[index]);
  const index = at >= 0 ? at : levels.length < turkishLevels.length ? levels.length : -1;
  if (index >= 0) fail(turkish, `heading ${index + 1} is h${turkishLevels[index] ?? '-'} but h${levels[index] ?? '-'} in ${name}; heading levels must match in order`);
}
function headingLevels(name) {
  return proseLines(read(name)).flatMap(([, line]) => { const marks = /^\s{0,3}(#{1,6})\s+\S/u.exec(line)?.[1]; return marks ? [marks.length] : []; });
}
// GitHub heading ids (github-slugger): lowercase, drop every character that is not alphabetic, a mark, a decimal/letter
// number, connector punctuation, hyphen or space, turn spaces into hyphens, suffix repeats -1, -2...; explicit
// id/name attributes count too.
function anchors(name) {
  if (anchorCache.has(name)) return anchorCache.get(name);
  const ids = new Set(), slugs = new Map();
  for (const [, line] of proseLines(read(name))) {
    for (const match of line.matchAll(/<[a-z][^>]*\s(?:id|name)="([^"]+)"/giu)) ids.add(match[1]);
    const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/u.exec(line)?.[1];
    if (heading === undefined) continue;
    const text = heading.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/<[^>]+>/gu, '');
    const base = text.toLowerCase().replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Nl}\p{Pc} -]/gu, '').replaceAll(' ', '-');
    let slug = base;
    while (slugs.has(slug)) { const count = slugs.get(base) + 1; slugs.set(base, count); slug = `${base}-${count}`; }
    slugs.set(slug, 0); ids.add(slug);
  }
  anchorCache.set(name, ids);
  return ids;
}
for (const failure of failures) console.error('lint-docs: ' + failure);
console.log(`lint-docs: PLAN.md ${planBytes} bytes, ARCHITECTURE.md ${architectureLines} lines, ${failures.length} violation(s)`);
process.exitCode = failures.length === 0 ? 0 : 1;
