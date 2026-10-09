#!/usr/bin/env node
// Fast, offline documentation size and release-drift gate (owner 2026-10-08).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIMITS = { planBytes: 60 * 1024, planLineChars: 800, architectureLines: 1200 };
const read = (name) => readFileSync(join(ROOT, name), 'utf8');
const failures = [];
const fail = (where, message) => failures.push(`${where.replaceAll('\\', '/')}: ${message}`);
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
  const packageAlpha = /^\d+\.\d+\.\d+-alpha\.(\d+)(?:\+.*)?$/u.exec(packageVersion);
  // Public docs describe what is live: the package version once released, or the last released version while the top CHANGELOG line is Unreleased.
  const unreleasedTop = /^\s*-\s+\*\*[^*]+\*\*\s*—\s*Unreleased\b/iu.test(releases[0]?.line ?? '');
  const lastReleasedAlpha = /-alpha\.(\d+)\b/u.exec((unreleasedTop ? releases[1] : releases[0])?.value ?? '')?.[1];
  if (packageAlpha) for (const name of ['README.md', 'README.tr.md', 'SECURITY.md']) {
    const alphas = [...read(name).matchAll(/\balpha\.(\d+)\b/gu)].map(match => BigInt(match[1]));
    const highest = alphas.reduce((max, value) => value > max ? value : max, -1n);
    const allowed = new Set([BigInt(packageAlpha[1]), ...(unreleasedTop && lastReleasedAlpha ? [BigInt(lastReleasedAlpha)] : [])]);
    if (!allowed.has(highest)) fail(name, `highest alpha.${highest} must equal package.json ${packageVersion}${unreleasedTop && lastReleasedAlpha ? ` or the last released alpha.${lastReleasedAlpha}` : ''}`);
  }
  for (const name of ['ARCHITECTURE.md', ...architectureFiles('.deckent/docs/architecture')]) {
    read(name).split('\n').forEach((line, index) => {
      const phrase = /\b(?:unpushed|not landed|review open|PR pending)\b/iu.exec(line)?.[0];
      if (phrase && !/^\s*(?:[-*>]\s*)?historical:/iu.test(line)) fail(`${name}:${index + 1}`, `forbidden phrase "${phrase}"; update the claim or prefix a historical record with historical:`);
    });
  }
} catch (error) { fail('input', error.message); }
for (const failure of failures) console.error('lint-docs: ' + failure);
console.log(`lint-docs: PLAN.md ${planBytes} bytes, ARCHITECTURE.md ${architectureLines} lines, ${failures.length} violation(s)`);
process.exitCode = failures.length === 0 ? 0 : 1;
