// deps-watch (DEPS-GOV): networked dependency watch — NOT part of verify. Weekly and before every batch push (docs-delta).
// Usage: node scripts/deps-watch.mjs <outDir> [--date YYYY-MM-DD]
// Inputs: package-lock.json (installed tree), dependencies.json (registry + policy), embedded components (check-embedded-deps).
// Sources: OSV querybatch + /v1/vulns/{id} (installed tree AND embedded components), npm registry (latest, deprecated, provenance =
// dist.attestations, publish dates for direct dependencies and registry alternatives), `npm audit signatures --json`, lockfile licenses.
// Writes <outDir>/deps-watch-<date>.json and .md; exit 1 when a finding's severity is in policy.failSeverities (default HIGH/CRITICAL).
// A source that cannot be read is itself a HIGH finding (an incomplete watch never passes).
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHosts, scanEmbedded } from './check-embedded-deps.mjs';
import { loadRegistry } from './dependencies.mjs';

const OSV = 'https://api.osv.dev/v1', NPM = 'https://registry.npmjs.org', ABBREVIATED = 'application/vnd.npm.install-v1+json';
const RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };

/** OSV record → severity. MAL- (malicious package) is CRITICAL; an unrated record counts as HIGH (fail-closed). */
export function osvSeverity(record) {
  if (record.id.startsWith('MAL-')) return { severity: 'CRITICAL', rated: true };
  const raw = [record.database_specific?.severity, ...(record.affected ?? []).map(affected => affected.ecosystem_specific?.severity)]
    .find(value => typeof value === 'string');
  const severity = raw?.toUpperCase() === 'MODERATE' ? 'MEDIUM' : raw?.toUpperCase();
  return RANK[severity] > 0 ? { severity, rated: true } : { severity: 'HIGH', rated: false };
}

/** Simple SPDX evaluation: parentheses dropped; any AND needs every id allowed, otherwise one OR branch suffices. */
export function licenseAllowed(expression, allowed) {
  if (typeof expression !== 'string' || !expression.trim()) return false;
  const ids = expression.replace(/[()]/gu, ' ').split(/\s+(?:OR|AND)\s+/u).map(id => id.trim()).filter(Boolean);
  return /\sAND\s/u.test(expression) ? ids.every(id => allowed.includes(id)) : ids.some(id => allowed.includes(id));
}

const pool = async (items, size, work) => {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const index = next++; out[index] = await work(items[index]); } }));
  return out;
};
const defaultFetchJson = async (url, init = {}) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) { if (attempt >= 2) throw new Error(`${url}: ${error.message}`, { cause: error }); }
  }
};
const defaultSignatures = root => new Promise(done => execFile('npm', ['audit', 'signatures', '--json'], { cwd: root, timeout: 300_000, maxBuffer: 64 << 20 },
  (error, stdout) => { try { done(JSON.parse(stdout)); } catch { done({ error: error?.message ?? 'unparsable npm audit signatures output' }); } }));
const registryUrl = name => `${NPM}/${name.replace('/', '%2f')}`;

/** Runs the watch; `fetchJson` and `signatures` are injectable so the pipeline is testable offline. Returns { report, exitCode, files }. */
export async function runWatch({ root, outDir, today = new Date().toISOString().slice(0, 10), fetchJson = defaultFetchJson, signatures = defaultSignatures }) {
  const arch = JSON.parse(readFileSync(join(root, 'arch.json'), 'utf8'));
  const { registry, errors } = loadRegistry(root, arch.dependencies?.registry);
  if (!registry) throw new Error(`dependency registry invalid: ${errors.join('; ')}`);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const findings = [], add = (severity, kind, subject, detail) => findings.push({ severity, kind, subject, detail });

  const tree = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || entry.link || !entry.version) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length), key = `${name}@${entry.version}`;
    const known = tree.get(key);
    tree.set(key, { name, version: entry.version, license: entry.license ?? null, runtime: (known?.runtime ?? false) || entry.dev !== true });
  }
  const embedded = scanEmbedded(root, defaultHosts(root)).flatMap(host => host.embedded.map(component => ({ name: component.name, version: component.version, via: `${host.package}@${host.installed}` })));
  for (const component of embedded) if (!component.version) add('MEDIUM', 'embedded-unversioned', `${component.name} (in ${component.via})`, 'sourcemap carries no version; OSV cannot be queried');
  const installed = name => lock.packages?.[`node_modules/${name}`]?.version ?? null;

  // OSV: one querybatch for the tree and the versioned embedded components; paginated per query; details for severity.
  const targets = [...[...tree.values()].map(entry => ({ name: entry.name, version: entry.version, via: null, runtime: entry.runtime })),
    ...embedded.filter(component => component.version).map(component => ({ ...component, runtime: true }))];
  const vulnerable = [];
  try {
    const ids = targets.map(() => []);
    let pending = targets.map((target, index) => ({ index, query: { package: { name: target.name, ecosystem: 'npm' }, version: target.version } }));
    while (pending.length) {
      const batch = pending.splice(0, 1000);
      const { results = [] } = await fetchJson(`${OSV}/querybatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: batch.map(item => item.query) }) });
      batch.forEach((item, position) => {
        const result = results[position] ?? {};
        ids[item.index].push(...(result.vulns ?? []).map(vuln => vuln.id));
        if (result.next_page_token) pending.push({ index: item.index, query: { ...item.query, page_token: result.next_page_token } });
      });
    }
    const unique = [...new Set(ids.flat())];
    const records = new Map((await pool(unique, 8, async id => [id, await fetchJson(`${OSV}/vulns/${encodeURIComponent(id)}`)])));
    targets.forEach((target, index) => {
      for (const id of ids[index]) {
        const record = records.get(id);
        if (record?.withdrawn) continue;
        const { severity, rated } = osvSeverity(record ?? { id });
        const subject = `${target.name}@${target.version}${target.via ? ` (embedded in ${target.via})` : ''}${target.runtime ? '' : ' [dev]'}`;
        vulnerable.push({ id, subject, severity, summary: record?.summary ?? '', aliases: record?.aliases ?? [] });
        add(severity, 'vulnerability', subject, `${id}${rated ? '' : ' (unrated; counted HIGH)'} ${record?.summary ?? ''}`.trim());
      }
    });
  } catch (error) { add('HIGH', 'watch-incomplete', 'OSV', error.message); }

  // npm registry: abbreviated packuments for the installed tree; full packuments (publish times) for direct deps and alternatives.
  const direct = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
  const alternatives = [...new Map(Object.values({ ...registry.dependencies, ...registry.platform })
    .flatMap(entry => entry.alternatives.filter(item => item.package)).map(item => [`${item.name}|${item.package}`, item])).values()];
  const abbreviated = new Map(), full = new Map();
  try {
    const names = [...new Set([...tree.values()].map(entry => entry.name))].sort();
    for (const [name, doc] of await pool(names, 8, async name => [name, await fetchJson(registryUrl(name), { headers: { accept: ABBREVIATED } })])) abbreviated.set(name, doc);
    const timed = [...new Set([...direct, ...alternatives.map(item => item.package)])].sort();
    for (const [name, doc] of await pool(timed, 4, async name => [name, await fetchJson(registryUrl(name))])) full.set(name, doc);
  } catch (error) { add('HIGH', 'watch-incomplete', 'npm registry', error.message); }
  const unprovenanced = [];
  for (const entry of tree.values()) {
    const version = abbreviated.get(entry.name)?.versions?.[entry.version];
    if (!version) continue;
    if (version.deprecated) add(entry.runtime ? 'MEDIUM' : 'LOW', 'deprecated', `${entry.name}@${entry.version}${entry.runtime ? '' : ' [dev]'}`, version.deprecated);
    if (entry.runtime && !version.dist?.attestations) unprovenanced.push(`${entry.name}@${entry.version}`);
  }
  const directRows = direct.map(name => {
    const doc = full.get(name), latest = doc?.['dist-tags']?.latest ?? null, entry = registry.dependencies[name], current = installed(name);
    if (latest && current && latest !== current) add('INFO', 'outdated', name, `installed ${current}, latest ${latest} (${doc.time?.[latest]?.slice(0, 10) ?? '?'})`);
    if (entry && current && entry.reviewedVersion !== current) add('LOW', 'reviewed-version-drift', name, `installed ${current}, registry reviewed ${entry.reviewedVersion}; re-review and update dependencies.json`);
    return { name, kind: entry?.kind ?? null, installed: current, latest, latestDate: doc?.time?.[latest]?.slice(0, 10) ?? null, criticality: entry?.criticality ?? null, nextReview: entry?.nextReview ?? null };
  });
  const alternativeRows = alternatives.map(item => {
    const doc = full.get(item.package), latest = doc?.['dist-tags']?.latest ?? null;
    return { name: item.name, package: item.package, recorded: item.version ?? null, recordedDate: item.date ?? null, latest, latestDate: doc?.time?.[latest]?.slice(0, 10) ?? null };
  });

  // Registry signatures and provenance attestations of the installed tree.
  const signed = await signatures(root);
  if (signed.error) add('HIGH', 'watch-incomplete', 'npm audit signatures', signed.error);
  for (const item of signed.invalid ?? []) add('CRITICAL', 'signature-invalid', `${item.name}@${item.version}`, 'registry signature or attestation does not verify');
  for (const item of signed.missing ?? []) add('MEDIUM', 'signature-missing', `${item.name}@${item.version}`, 'no registry signature');

  for (const entry of tree.values()) {
    const allowed = registry.policy.licenses[entry.runtime ? 'runtime' : 'dev'];
    if (!licenseAllowed(entry.license, allowed)) add(entry.runtime ? 'HIGH' : 'MEDIUM', 'license', `${entry.name}@${entry.version}${entry.runtime ? '' : ' [dev]'}`, `${entry.license ?? 'no license'} is outside the ${entry.runtime ? 'runtime' : 'dev'} allowlist`);
  }
  for (const [label, entry] of [...Object.entries(registry.dependencies), ...Object.entries(registry.platform).map(([id, entry]) => [`platform ${id}`, entry])]) {
    if (entry.nextReview < today) add('MEDIUM', 'review-overdue', label, `nextReview ${entry.nextReview}`);
  }

  findings.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject));
  const counts = Object.fromEntries(Object.keys(RANK).map(level => [level, findings.filter(item => item.severity === level).length]));
  const exitCode = findings.some(item => registry.policy.failSeverities.includes(item.severity)) ? 1 : 0;
  const report = { schemaVersion: 1, date: today, generatedAt: new Date().toISOString(), node: process.version, failSeverities: registry.policy.failSeverities, exitCode, counts,
    tree: { packages: tree.size, runtime: [...tree.values()].filter(entry => entry.runtime).length, embedded: embedded.length },
    signatures: { invalid: signed.invalid?.length ?? null, missing: signed.missing?.length ?? null }, unprovenancedRuntime: unprovenanced.sort(),
    direct: directRows, alternatives: alternativeRows, vulnerabilities: vulnerable, findings };
  mkdirSync(outDir, { recursive: true });
  const files = [join(outDir, `deps-watch-${today}.json`), join(outDir, `deps-watch-${today}.md`)];
  writeFileSync(files[0], `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(files[1], renderMarkdown(report));
  return { report, exitCode, files };
}

const cell = value => String(value ?? '—').replaceAll('|', '\\|');
export function renderMarkdown(report) {
  const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n');
  return [`# deps-watch ${report.date}`, '',
    `Exit ${report.exitCode} (fails on ${report.failSeverities.join('/')}). Node ${report.node}. Tree: ${report.tree.packages} packages (${report.tree.runtime} runtime), ${report.tree.embedded} embedded components.`,
    `Findings: ${Object.entries(report.counts).map(([level, count]) => `${level} ${count}`).join(', ')}. Signatures: invalid ${report.signatures.invalid ?? '?'}, missing ${report.signatures.missing ?? '?'}.`, '',
    '## Findings', '', report.findings.length ? table(['Severity', 'Kind', 'Subject', 'Detail'], report.findings.map(item => [item.severity, item.kind, item.subject, item.detail])) : 'None.', '',
    '## Direct dependencies', '', table(['Package', 'Kind', 'Criticality', 'Installed', 'Latest', 'Latest date', 'Next review'],
      report.direct.map(row => [row.name, row.kind, row.criticality, row.installed, row.latest, row.latestDate, row.nextReview])), '',
    '## Alternatives (registry record vs npm now)', '', table(['Alternative', 'Package', 'Recorded', 'Recorded date', 'Latest', 'Latest date'],
      report.alternatives.map(row => [row.name, row.package, row.recorded, row.recordedDate, row.latest, row.latestDate])), '',
    `## Runtime packages without provenance (${report.unprovenancedRuntime.length})`, '', report.unprovenancedRuntime.join(', ') || 'None.', ''].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dateAt = args.indexOf('--date');
  const date = dateAt > -1 ? args.splice(dateAt, 2)[1] : undefined;
  if (args.length !== 1 || (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(date))) { process.stderr.write('usage: node scripts/deps-watch.mjs <outDir> [--date YYYY-MM-DD]\n'); process.exit(2); }
  const { report, exitCode, files } = await runWatch({ root: dirname(dirname(fileURLToPath(import.meta.url))), outDir: resolve(args[0]), ...(date ? { today: date } : {}) });
  process.stdout.write(`deps-watch ${report.date}: ${Object.entries(report.counts).map(([level, count]) => `${level} ${count}`).join(', ')}; exit ${exitCode}\n${files.join('\n')}\n`);
  process.exitCode = exitCode;
}
