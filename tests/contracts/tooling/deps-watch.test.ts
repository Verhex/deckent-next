import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// Tooling runs against source; the network is injected so the whole producer-to-report pipeline is exercised offline.
// @ts-expect-error JavaScript build tooling has no declaration file.
import { licenseAllowed, osvSeverity, runWatch } from '../../../scripts/deps-watch.mjs';

type Finding = { severity: string; kind: string; subject: string; detail: string };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const review = { lastReview: '2026-09-29', nextReview: '2026-10-29' };
const entry = (kind: string, owners: string[], extra: Record<string, unknown> = {}) => ({ kind, owners, purpose: 'p', features: ['f'], criticality: 'P0',
  reviewedVersion: '1.0.0', alternatives: [], ownSolution: 'none', ...review, ...extra });

async function project(licenses: Record<string, string>, acceptedRisks: unknown[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'deps-watch-')); roots.push(root);
  const files: Record<string, string> = {
    'arch.json': JSON.stringify({ dependencies: { registry: 'dependencies.json' } }),
    'package.json': JSON.stringify({ dependencies: { host: '1.0.0' }, devDependencies: { tool: '2.0.0' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {},
      'node_modules/host': { version: '1.0.0', license: licenses.host }, 'node_modules/tool': { version: '2.0.0', dev: true, license: licenses.tool } } }),
    'dependencies.json': JSON.stringify({ schemaVersion: 2, policy: { reviewIntervalDays: { P0: 30, P1: 60, P2: 90 },
      licenses: { runtime: ['MIT'], dev: ['MIT', 'MPL-2.0'] }, failSeverities: ['HIGH', 'CRITICAL'] },
    dependencies: { host: entry('runtime', ['src/adapters/core/x'], { embedded: [{ name: 'fast-uri', version: '3.1.0' }],
      alternatives: [{ name: 'alt', package: 'alt', version: '0.1.0', date: '2026-01-01', note: 'n' }] }), tool: entry('dev', ['package.json'], { reviewedVersion: '1.9.0' }) },
    platform: {}, acceptedRisks }),
    'node_modules/host/package.json': JSON.stringify({ name: 'host', version: '1.0.0' }),
    'node_modules/host/dist/index.js.map': JSON.stringify({ sources: ['../../../node_modules/.pnpm/fast-uri@3.1.0/node_modules/fast-uri/index.js'] }),
  };
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}

function network(vulnerable: boolean, fastUriIds = ['GHSA-aaaa', 'GHSA-unrated'], toolMalicious = true) {
  const calls: string[] = [];
  const packument = (name: string, version: string, extra: Record<string, unknown> = {}) => ({ 'dist-tags': { latest: version === '2.0.0' ? '2.1.0' : version },
    time: { [version]: '2026-09-01T00:00:00Z', '2.1.0': '2026-09-20T00:00:00Z' }, versions: { [version]: { dist: {}, ...extra } } });
  const fetchJson = async (url: string, init: { body?: string } = {}) => {
    calls.push(url);
    if (url.endsWith('/querybatch')) {
      const { queries } = JSON.parse(init.body!) as { queries: { package: { name: string } }[] };
      return { results: queries.map(query => vulnerable && query.package.name === 'fast-uri' ? { vulns: fastUriIds.map(id => ({ id })) }
        : vulnerable && toolMalicious && query.package.name === 'tool' ? { vulns: [{ id: 'MAL-2026-1' }] } : {}) };
    }
    if (url.endsWith('/vulns/GHSA-aaaa')) return { id: 'GHSA-aaaa', summary: 'uri confusion', database_specific: { severity: 'MODERATE' } };
    if (url.endsWith('/vulns/GHSA-unrated')) return { id: 'GHSA-unrated', summary: 'no rating' };
    if (url.endsWith('/vulns/GHSA-bbbb')) return { id: 'GHSA-bbbb', summary: 'new one', database_specific: { severity: 'HIGH' } };
    if (url.endsWith('/vulns/MAL-2026-1')) return { id: 'MAL-2026-1', summary: 'malicious' };
    if (url.endsWith('/host')) return packument('host', '1.0.0');
    if (url.endsWith('/tool')) return packument('tool', '2.0.0', { deprecated: 'use tool2' });
    if (url.endsWith('/alt')) return packument('alt', '0.2.0');
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchJson };
}

describe('deps-watch', () => {
  it('rates OSV records fail-closed and evaluates SPDX expressions', () => {
    expect(osvSeverity({ id: 'MAL-1' }).severity).toBe('CRITICAL');
    expect(osvSeverity({ id: 'GHSA-x', database_specific: { severity: 'MODERATE' } })).toEqual({ severity: 'MEDIUM', rated: true });
    expect(osvSeverity({ id: 'GHSA-x', affected: [{ ecosystem_specific: { severity: 'critical' } }] }).severity).toBe('CRITICAL');
    expect(osvSeverity({ id: 'GHSA-y' })).toEqual({ severity: 'HIGH', rated: false });
    expect(licenseAllowed('(MIT OR CC0-1.0)', ['CC0-1.0'])).toBe(true);
    expect(licenseAllowed('MIT AND GPL-3.0-only', ['MIT'])).toBe(false);
    expect(licenseAllowed(null, ['MIT'])).toBe(false);
  });

  it('scans the tree and embedded components, writes dated JSON + Markdown and fails on HIGH/CRITICAL', async () => {
    const root = await project({ host: 'GPL-3.0-only', tool: 'MPL-2.0' });
    const { calls, fetchJson } = network(true);
    const out = join(root, 'report');
    const { exitCode, files, report } = await runWatch({ root, outDir: out, today: '2026-11-15', fetchJson, signatures: async () => ({ invalid: [{ name: 'host', version: '1.0.0' }], missing: [] }) });
    expect(exitCode).toBe(1);
    expect(files).toEqual([join(out, 'deps-watch-2026-11-15.json'), join(out, 'deps-watch-2026-11-15.md')]);
    const findings = report.findings as Finding[];
    const has = (severity: string, kind: string, subject: string) => expect(findings).toContainEqual(expect.objectContaining({ severity, kind, subject }));
    has('MEDIUM', 'vulnerability', 'fast-uri@3.1.0 (embedded in host@1.0.0)');
    has('HIGH', 'vulnerability', 'fast-uri@3.1.0 (embedded in host@1.0.0)');
    has('CRITICAL', 'vulnerability', 'tool@2.0.0 [dev]');
    has('CRITICAL', 'signature-invalid', 'host@1.0.0');
    has('HIGH', 'license', 'host@1.0.0');
    has('LOW', 'deprecated', 'tool@2.0.0 [dev]');
    has('LOW', 'reviewed-version-drift', 'tool');
    has('INFO', 'outdated', 'tool');
    has('MEDIUM', 'review-overdue', 'host');
    expect(findings.some(finding => finding.kind === 'license' && finding.subject.startsWith('tool'))).toBe(false);
    expect(report.unprovenancedRuntime).toEqual(['host@1.0.0']);
    expect(report.alternatives).toEqual([{ name: 'alt', package: 'alt', recorded: '0.1.0', recordedDate: '2026-01-01', latest: '0.2.0', latestDate: '2026-09-01' }]);
    expect(calls.filter(url => url.endsWith('/querybatch'))).toHaveLength(1);
    expect(JSON.parse(await readFile(files[0], 'utf8')).exitCode).toBe(1);
    const markdown = await readFile(files[1], 'utf8');
    expect(markdown).toContain('# deps-watch 2026-11-15');
    expect(markdown).toContain('| CRITICAL | vulnerability | tool@2.0.0 [dev] | MAL-2026-1 malicious |');
    expect(markdown).toContain('GHSA-unrated (unrated; counted HIGH)');
  });

  it('passes a clean tree and fails closed when a source cannot be read', async () => {
    const root = await project({ host: 'MIT', tool: 'MIT' });
    const clean = await runWatch({ root, outDir: join(root, 'clean'), today: '2026-10-01', fetchJson: network(false).fetchJson, signatures: async () => ({ invalid: [], missing: [] }) });
    expect(clean.exitCode).toBe(0);
    expect((clean.report.findings as Finding[]).map(finding => finding.severity).filter(level => level === 'HIGH' || level === 'CRITICAL')).toEqual([]);
    const offline = await runWatch({ root, outDir: join(root, 'offline'), today: '2026-10-01', fetchJson: async () => { throw new Error('ENOTFOUND'); },
      signatures: async () => ({ error: 'npm unavailable' }) });
    expect(offline.exitCode).toBe(1);
    expect((offline.report.findings as Finding[]).filter(finding => finding.kind === 'watch-incomplete').map(finding => finding.subject)).toEqual(['npm audit signatures', 'npm registry', 'OSV']);
  });

  describe('accepted risks', () => {
    const accepted = (extra: Record<string, unknown> = {}) => ({ id: 'fast-uri-accepted', package: 'fast-uri', version: '3.1.0', carriers: ['host@1.0.0'],
      advisories: ['GHSA-aaaa', 'GHSA-unrated'], severity: 'HIGH', mitigation: 'schemas never reach it', evidence: ['proof/X/review.md'],
      decidedBy: 'lead', decided: '2026-09-29', expires: '2026-10-29', ...extra });
    const watch = async (risks: unknown[], today: string, ids?: string[]) => {
      const root = await project({ host: 'MIT', tool: 'MIT' }, risks);
      return runWatch({ root, outDir: join(root, 'out'), today, fetchJson: network(true, ids, false).fetchJson, signatures: async () => ({ invalid: [], missing: [] }) });
    };
    const vulnerabilities = (report: { findings: Finding[] }) => report.findings.filter(finding => finding.kind === 'vulnerability');

    it('reports a matching, unexpired risk as MITIGATED and does not fail on it', async () => {
      const { exitCode, report, files } = await watch([accepted()], '2026-10-01');
      expect(exitCode).toBe(0);
      expect(vulnerabilities(report).map(finding => finding.severity)).toEqual(['MITIGATED', 'MITIGATED']);
      expect(vulnerabilities(report)[0]!.detail).toContain('accepted risk fast-uri-accepted until 2026-10-29');
      expect(report.counts.MITIGATED).toBe(2);
      expect(await readFile(files[1], 'utf8')).toContain('| MITIGATED | vulnerability | fast-uri@3.1.0 (embedded in host@1.0.0) |');
    });

    it('fails again after expiry', async () => {
      const { exitCode, report } = await watch([accepted()], '2026-10-30');
      expect(exitCode).toBe(1);
      expect(vulnerabilities(report).map(finding => finding.severity).sort()).toEqual(['HIGH', 'MEDIUM']);
      expect(vulnerabilities(report)[0]!.detail).toContain('accepted risk fast-uri-accepted expired 2026-10-29');
    });

    it('fails again when a new advisory id appears for the same package', async () => {
      const { exitCode, report } = await watch([accepted()], '2026-10-01', ['GHSA-aaaa', 'GHSA-unrated', 'GHSA-bbbb']);
      expect(exitCode).toBe(1);
      expect(vulnerabilities(report).some(finding => finding.severity === 'MITIGATED')).toBe(false);
      expect(vulnerabilities(report)[0]!.detail).toContain('no longer matches (new: GHSA-bbbb; gone: —)');
    });

    it('fails again when the embedded version moves and reports the stale entry', async () => {
      const { exitCode, report } = await watch([accepted({ version: '3.0.0' })], '2026-10-01');
      expect(exitCode).toBe(1);
      expect(vulnerabilities(report).some(finding => finding.severity === 'MITIGATED')).toBe(false);
      expect(report.findings).toContainEqual(expect.objectContaining({ severity: 'LOW', kind: 'accepted-risk-unused', subject: 'fast-uri-accepted' }));
    });
  });
});
