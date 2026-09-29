// deps-watch (DEPS-GOV): networked dependency watch — NOT part of verify. Weekly and before every batch push (docs-delta).
// Usage: node scripts/deps-watch.mjs <outDir> [--date YYYY-MM-DD] [--sbom <package>/sbom.cdx.json]
// Inputs: package-lock.json (installed tree), dependencies.json (registry + policy), embedded components (check-embedded-deps) and, with
// --sbom, the CycloneDX SBOM of a bundled package (scripts/build-dist.mjs): every shipped component, nested embedded ones included, is queried
// too — a component only the SBOM names (packaging drift) is itself reported.
// Sources: OSV querybatch + /v1/vulns/{id} (installed tree AND embedded components), npm registry (latest, deprecated, provenance =
// dist.attestations, publish dates for direct dependencies and registry alternatives), `npm audit signatures --json`, lockfile licenses.
// Writes <outDir>/deps-watch-<date>.json and .md; exit 1 when a finding's severity is in policy.failSeverities (default HIGH/CRITICAL).
// dependencies.json `acceptedRisks` turn a vulnerability into MITIGATED (reported, not failing) only while the entry is unexpired and the
// component's observed advisory set, version, carrier and severities match it exactly; any change fails again. An entry with `shipped: false`
// covers only the installed tree: with --sbom, an embedded component the SBOM omits is marked [not shipped], one it names is not accepted.
// A source that cannot be read is itself a HIGH finding (an incomplete watch never passes).
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHosts, scanEmbedded } from './check-embedded-deps.mjs';
import { loadRegistry } from './dependencies.mjs';

const OSV = 'https://api.osv.dev/v1', NPM = 'https://registry.npmjs.org', ABBREVIATED = 'application/vnd.npm.install-v1+json';
const RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0, MITIGATED: -1 };

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

/** Marks vulnerabilities MITIGATED per accepted risk (exact package, version, carrier and advisory set; unexpired; severity not above the
 * accepted one; a `shipped: false` risk only while `shippedKeys` — `name@version|carrier` of a package SBOM — does not name it) and adds one
 * finding per vulnerability. A risk no longer observed anywhere is reported (LOW) so it gets removed. */
export function applyAcceptedRisks(vulnerable, risks, today, add, shippedKeys = null) {
  const groups = Map.groupBy(vulnerable, item => `${item.name}@${item.version}|${item.carrier}`);
  const used = new Set();
  for (const items of groups.values()) {
    const { name, version, carrier } = items[0];
    const risk = risks.find(entry => entry.package === name && entry.version === version && entry.carriers.includes(carrier));
    let reason = null;
    if (risk) {
      used.add(risk.id);
      const observed = new Set(items.map(item => item.id)), accepted = new Set(risk.advisories);
      const added = [...observed].filter(id => !accepted.has(id)), gone = [...accepted].filter(id => !observed.has(id));
      if (risk.expires < today) reason = `accepted risk ${risk.id} expired ${risk.expires}`;
      else if (risk.shipped === false && shippedKeys?.has(`${name}@${version}|${carrier}`)) reason = `accepted risk ${risk.id} covers the installed tree only, but the package SBOM ships it`;
      else if (added.length || gone.length) reason = `accepted risk ${risk.id} no longer matches (new: ${added.join(', ') || '—'}; gone: ${gone.join(', ') || '—'})`;
      else if (items.some(item => RANK[item.severity] > RANK[risk.severity])) reason = `accepted risk ${risk.id} covers up to ${risk.severity}`;
    }
    for (const item of items) {
      const detail = `${item.id}${item.rated ? '' : ' (unrated; counted HIGH)'} ${item.summary}`.trim();
      if (risk && !reason) { item.mitigated = risk.id; add('MITIGATED', 'vulnerability', item.subject, `${detail} [was ${item.severity}; accepted risk ${risk.id} until ${risk.expires}: ${risk.mitigation}]`); }
      else add(item.severity, 'vulnerability', item.subject, reason ? `${detail} [${reason}]` : detail);
    }
  }
  for (const risk of risks) if (!used.has(risk.id)) add('LOW', 'accepted-risk-unused', risk.id, `${risk.package}@${risk.version} in ${risk.carriers.join(', ')} is no longer observed; remove the entry`);
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

/** npm components of a CycloneDX SBOM (top-level and nested), as OSV targets. A nested component's carrier is its
 * `deckent:embedded:carrier` property (the same carrier string acceptedRisks use); a top-level shipped component is the installed `tree`. */
export function sbomComponents(bom) {
  const out = [], visit = (components, parent) => { for (const component of components ?? []) {
    const purl = /^pkg:npm\/(.+)@([^@?#]+)(?:[?#].*)?$/u.exec(component.purl ?? '');
    const carrier = component.properties?.find(item => item.name === 'deckent:embedded:carrier')?.value ?? (parent ? `${parent.name}@${parent.version}` : null);
    const item = purl ? { name: decodeURIComponent(purl[1]), version: purl[2], via: carrier } : null;
    if (item) out.push(item);
    visit(component.components, item ?? parent);
  } };
  if (bom?.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components)) throw new Error('not a CycloneDX JSON SBOM');
  visit(bom.components, null);
  return out;
}

/** Runs the watch; `fetchJson` and `signatures` are injectable so the pipeline is testable offline. Returns { report, exitCode, files }. */
export async function runWatch({ root, outDir, today = new Date().toISOString().slice(0, 10), fetchJson = defaultFetchJson, signatures = defaultSignatures, sbom = null }) {
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
  // Shipped components of a bundled package: the same name@version already scanned (tree or embedded carrier) is not queried twice.
  const shipped = sbom ? sbomComponents(sbom) : [], shippedKeys = sbom ? new Set(shipped.map(component => `${component.name}@${component.version}|${component.via ?? 'tree'}`)) : null;
  const known = new Set([...[...tree.values()].map(entry => `${entry.name}@${entry.version}|tree`),
    ...embedded.map(component => `${component.name}@${component.version}|${component.via}`)]);
  const sbomOnly = shipped.filter(component => !known.has(`${component.name}@${component.version}|${component.via ?? 'tree'}`));
  for (const component of sbomOnly) add('MEDIUM', 'sbom-drift', `${component.name}@${component.version}${component.via ? ` (embedded in ${component.via})` : ''}`,
    'named by the bundled package SBOM but not by the installed tree or embedded scan; rebuild the package or the lockfile');

  // OSV: one querybatch for the tree and the versioned embedded components; paginated per query; details for severity.
  const targets = [...[...tree.values()].map(entry => ({ name: entry.name, version: entry.version, via: null, runtime: entry.runtime })),
    ...embedded.filter(component => component.version).map(component => ({ ...component, runtime: true,
      notShipped: shippedKeys !== null && !shippedKeys.has(`${component.name}@${component.version}|${component.via}`) })),
    ...sbomOnly.map(component => ({ ...component, runtime: true }))];
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
        const subject = `${target.name}@${target.version}${target.via ? ` (embedded in ${target.via})` : ''}${target.runtime ? '' : ' [dev]'}${target.notShipped ? ' [not shipped]' : ''}`;
        vulnerable.push({ id, subject, severity, rated, name: target.name, version: target.version, carrier: target.via ?? 'tree',
          summary: record?.summary ?? '', aliases: record?.aliases ?? [] });
      }
    });
    applyAcceptedRisks(vulnerable, registry.acceptedRisks, today, add, shippedKeys);
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
    sbom: sbom ? { components: shipped.length, nested: shipped.filter(component => component.via).length, sbomOnly: sbomOnly.length } : null,
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
    ...(report.sbom ? [`Bundled package SBOM: ${report.sbom.components} components (${report.sbom.nested} nested embedded), ${report.sbom.sbomOnly} named only by the SBOM.`] : []),
    `Findings: ${Object.entries(report.counts).map(([level, count]) => `${level} ${count}`).join(', ')}. Signatures: invalid ${report.signatures.invalid ?? '?'}, missing ${report.signatures.missing ?? '?'}.`, '',
    '## Findings', '', report.findings.length ? table(['Severity', 'Kind', 'Subject', 'Detail'], report.findings.map(item => [item.severity, item.kind, item.subject, item.detail])) : 'None.', '',
    `MITIGATED findings come from dependencies.json acceptedRisks; they fail again on expiry or on any advisory/version/carrier change.`, '',
    '## Direct dependencies', '', table(['Package', 'Kind', 'Criticality', 'Installed', 'Latest', 'Latest date', 'Next review'],
      report.direct.map(row => [row.name, row.kind, row.criticality, row.installed, row.latest, row.latestDate, row.nextReview])), '',
    '## Alternatives (registry record vs npm now)', '', table(['Alternative', 'Package', 'Recorded', 'Recorded date', 'Latest', 'Latest date'],
      report.alternatives.map(row => [row.name, row.package, row.recorded, row.recordedDate, row.latest, row.latestDate])), '',
    `## Runtime packages without provenance (${report.unprovenancedRuntime.length})`, '', report.unprovenancedRuntime.join(', ') || 'None.', ''].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dateAt = args.indexOf('--date');
  const date = dateAt > -1 ? args.splice(dateAt, 2)[1] : undefined;
  const sbomAt = args.indexOf('--sbom'), sbomFile = sbomAt > -1 ? args.splice(sbomAt, 2)[1] : undefined;
  if (args.length !== 1 || (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(date))) { process.stderr.write('usage: node scripts/deps-watch.mjs <outDir> [--date YYYY-MM-DD]\n'); process.exit(2); }
  const { report, exitCode, files } = await runWatch({ root: dirname(dirname(fileURLToPath(import.meta.url))), outDir: resolve(args[0]), ...(date ? { today: date } : {}),
    ...(sbomFile ? { sbom: JSON.parse(readFileSync(resolve(sbomFile), 'utf8')) } : {}) });
  process.stdout.write(`deps-watch ${report.date}: ${Object.entries(report.counts).map(([level, count]) => `${level} ${count}`).join(', ')}; exit ${exitCode}\n${files.join('\n')}\n`);
  process.exitCode = exitCode;
}
