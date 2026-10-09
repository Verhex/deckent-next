import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const release = (n: number, ref = 'abcdef12', receipt = 'PR #12') => `- **1.0.0-alpha.${n}** — 2026-10-08 · \`${ref}\` (${receipt}) · features`;
async function fixture(changes: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-docs-gate-')); roots.push(root);
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, '.deckent/docs/architecture/nested'), { recursive: true });
  await cp(new URL('../../../scripts/lint-docs.mjs', import.meta.url), join(root, 'scripts/lint-docs.mjs'));
  const files = { 'package.json': '{"version":"1.0.0-alpha.17"}', 'CHANGELOG.md': '# Changelog\n\n' + release(17) + '\n' + release(9),
    'PLAN.md': '# Plan\n', 'ARCHITECTURE.md': '# Architecture\n', 'README.md': 'Current alpha.17. Historical screenshot alpha.10.',
    'README.tr.md': 'Güncel alpha.17. Eski görüntü alpha.10.', 'SECURITY.md': 'Supports alpha.17.', ...changes };
  for (const [name, value] of Object.entries(files)) await writeFile(join(root, name), value);
  return root;
}
// A regular-file receipt avoids pipe-capture EPERM in restricted hosts; exit status remains the child's own.
function lint(root: string) {
  const receipt = join(root, 'lint-output.log'), fd = openSync(receipt, 'w');
  try {
    const result = spawnSync(process.execPath, [join(root, 'scripts/lint-docs.mjs')], { stdio: ['ignore', fd, fd], timeout: 10_000 });
    if (result.error) throw result.error;
    return { status: result.status, output: readFileSync(receipt, 'utf8') };
  } finally { closeSync(fd); }
}
describe('documentation release drift gate', () => {
  it('accepts landed alpha.17 with older numeric alpha.9, and CRLF checkouts', async () => {
    const root = await fixture({ 'CHANGELOG.md': [release(17), release(9)].join('\r\n') });
    expect(lint(root)).toMatchObject({ status: 0, output: expect.stringContaining('0 violation(s)') });
  });
  it('requires the first CHANGELOG version to equal the package version, including a missing release', async () => {
    for (const changelog of [release(16), '# Changelog']) {
      const result = lint(await fixture({ 'CHANGELOG.md': changelog }));
      expect(result.status).toBe(1); expect(result.output).toContain('first release');
    }
  });
  it.each([
    [release(17, 'abcdef12', 'features only'), 'must name a PR number'],
    [release(17, 'abcdef12', 'PR #12, PR pending'), 'contains PR pending'],
    [release(17, 'wave/release', 'PR #12; commit `abcdef12`'), 'must be a commit SHA'],
    [release(17, 'lane/release', 'PR #12'), 'must be a commit SHA'],
    [release(17) + '\n' + release(9, 'abcdef12', 'PR pending'), 'contains PR pending'],
  ])('rejects incomplete landed receipts: %s', async (changelog, error) => {
    const result = lint(await fixture({ 'CHANGELOG.md': changelog }));
    expect(result.status).toBe(1); expect(result.output).toContain(error);
  });
  it('exempts only the explicitly Unreleased top line; prerelease alone and lower Unreleased lines still need receipts', async () => {
    const top = '- **1.0.0-alpha.17** — Unreleased · `lane/release` (PR pending)';
    expect(lint(await fixture({ 'CHANGELOG.md': top + '\n' + release(16) })).status).toBe(0);
    const result = lint(await fixture({ 'CHANGELOG.md': top + '\n- **1.0.0-alpha.16** — Unreleased (PR pending)' }));
    expect(result.status).toBe(1); expect(result.output).toContain('contains PR pending');
    expect(lint(await fixture({ 'CHANGELOG.md': release(17, 'abcdef12', 'PR pending') + ' · Unreleased feature' })).status).toBe(1);
  });
  it('waives only the PR number for releases before PR-based landing (below alpha.5); SHA and PR-pending rules stay', async () => {
    const changelog = (...lines: string[]) => ({ 'CHANGELOG.md': [release(17), ...lines].join('\n') });
    expect(lint(await fixture(changelog(release(4, 'de7d2469', 'batch 28'), release(1, '037cab0d', 'K0')))).status).toBe(0);
    for (const [line, error] of [[release(5, 'abcdef12', 'batch 36'), 'must name a PR number'],
      [release(4, 'lane/release', 'batch 28'), 'must be a commit SHA'], [release(4, 'abcdef12', 'PR pending'), 'contains PR pending']]) {
      const result = lint(await fixture(changelog(line)));
      expect(result.status).toBe(1); expect(result.output).toContain(error);
    }
  });
  it('ignores receipt requirements only for versions above the package version (SemVer numeric order)', async () => {
    const result = lint(await fixture({ 'CHANGELOG.md': release(17) + '\n' + release(100, 'branch', 'PR pending') }));
    expect(result.status).toBe(0);
  });
  it.each(['README.md', 'README.tr.md', 'SECURITY.md'])('rejects stale, missing or future alpha claims in %s', async name => {
    for (const claim of ['alpha.16', 'no version', 'alpha.17 and alpha.18']) {
      const result = lint(await fixture({ [name]: claim }));
      expect(result.status).toBe(1); expect(result.output).toContain(`${name}: highest alpha.`);
    }
  });
  it('while the top line is Unreleased, public docs may claim the last released alpha (live) but nothing older or newer', async () => {
    const changelog = '- **1.0.0-alpha.18** — Unreleased · (BATCH) · features\n' + release(17) + '\n' + release(9);
    const base = { 'package.json': '{"version":"1.0.0-alpha.18"}', 'CHANGELOG.md': changelog };
    expect(lint(await fixture(base)).status).toBe(0);
    expect(lint(await fixture({ ...base, 'README.md': 'Live alpha.18.' })).status).toBe(0);
    for (const claim of ['alpha.16', 'alpha.19']) {
      const result = lint(await fixture({ ...base, 'SECURITY.md': `Supports ${claim}.` }));
      expect(result.status).toBe(1); expect(result.output).toContain('SECURITY.md: highest alpha.');
    }
    const landed = lint(await fixture({ 'package.json': '{"version":"1.0.0-alpha.18"}', 'CHANGELOG.md': release(18) + '\n' + release(17) }));
    expect(landed.status).toBe(1); expect(landed.output).toContain('README.md: highest alpha.17 must equal package.json 1.0.0-alpha.18');
  });
  it.each(['unpushed', 'not landed', 'review open', 'PR pending'])('rejects %s in root and recursively nested architecture docs', async phrase => {
    for (const name of ['ARCHITECTURE.md', '.deckent/docs/architecture/nested/contract.md']) {
      const result = lint(await fixture({ [name]: `# Contract\nCandidate ${phrase}` }));
      expect(result.status).toBe(1); expect(result.output).toContain(`${name}:2: forbidden phrase`);
      expect(lint(await fixture({ [name]: `# Contract\n- historical: previously ${phrase}` })).status).toBe(0);
      expect(lint(await fixture({ [name]: `Candidate ${phrase}; see historical: elsewhere` })).status).toBe(1);
    }
  });
  it('retains size gates and fails closed on malformed versions', async () => {
    expect(lint(await fixture({ 'PLAN.md': 'x'.repeat(801) })).output).toContain('801 chars');
    expect(lint(await fixture({ 'PLAN.md': 'x\n'.repeat(31_000) })).output).toContain('bytes >');
    expect(lint(await fixture({ 'ARCHITECTURE.md': 'x\n'.repeat(1201) })).output).toContain('1201 lines');
    expect(lint(await fixture({ 'package.json': '{"version":"bad"}' })).status).toBe(1);
  });
});
