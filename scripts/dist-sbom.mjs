// dist-sbom (DEPS-DIST, owner 2026-09-29): what the bundled package ships, derived from the bundler's own record, not from package.json.
// Input: the esbuild metafile of scripts/build-dist.mjs (every input file and the bytes it put into each output), the installed tree
// (package.json, license files) and package-lock.json (registry integrity). A package counts as shipped when at least one of its files put
// bytes into an output; packages the bundler read but tree-shook away are reported separately, never listed as shipped.
// Second level: components that a shipped package itself carries inside its own files (check-embedded-deps sourcemap evidence, e.g. ajv and
// fast-uri inside the MCP SDK) are shipped only when the carrier file that embeds them put bytes into the bundle.
// Output: a CycloneDX 1.6 JSON SBOM (shipped packages as top-level components, embedded ones nested under their carrier, since OSV-Scanner's
// CycloneDX extractor walks top-level components recursively) and a THIRD-PARTY-NOTICES.md with each shipped package's own license text.
// PACK-SMOKE (2026-09-30): a component whose installed copy carries no license text may take it from packaging/licenses/licenses.lock.json —
// a byte copy of a named upstream artifact for that exact name@version, sha256-checked here; everything else stays a gap.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { scanEmbedded } from './check-embedded-deps.mjs';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/iu;
export const LICENSE_LOCK = 'packaging/licenses/licenses.lock.json';

/** The locked upstream license texts: `texts` maps name@version → { text, file, sha256, source }; `problems` lists entries that cannot be
 * used (unsupported lock, file missing or outside the lock directory, sha256 mismatch) — each one a publish blocker, never a silent skip. */
export function lockedLicenseTexts(root, lockPath = join(root, LICENSE_LOCK)) {
  const texts = new Map(), problems = [];
  if (!existsSync(lockPath)) return { texts, problems };
  const lock = readJson(lockPath);
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.texts)) return { texts, problems: [`${LICENSE_LOCK}: unsupported lock (schemaVersion 1 with texts[] expected)`] };
  for (const entry of lock.texts) {
    const key = `${entry.name}@${entry.version}`, file = typeof entry.file === 'string' ? normalize(entry.file) : '';
    if (!file || isAbsolute(file) || file.startsWith('..') || !existsSync(join(dirname(lockPath), file))) { problems.push(`${key}: locked license text ${entry.file} missing or outside ${dirname(LICENSE_LOCK)}`); continue; }
    const bytes = readFileSync(join(dirname(lockPath), file)), digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256) { problems.push(`${key}: locked license text sha256 ${digest} does not match the lock (${entry.sha256})`); continue; }
    if (texts.has(key)) { problems.push(`${key}: locked twice`); continue; }
    texts.set(key, { text: bytes.toString('utf8'), file, sha256: digest, license: entry.license ?? null, source: entry.source ?? null });
  }
  return { texts, problems };
}
const provenance = (entry, why = 'The installed package ships no license text') => `(${why}; this is the upstream text from ${entry.source?.url ?? 'an unrecorded source'}` +
  `${entry.source?.commit ? ` at commit ${entry.source.commit}` : ''}${entry.source?.integrity ? ` (${entry.source.integrity})` : ''}, sha256 ${entry.sha256}.)`;

/** `node_modules/a/node_modules/@s/b/lib/x.js` → `node_modules/a/node_modules/@s/b` (the innermost installed package directory). */
export function packageDirOf(input) {
  input = input.replaceAll('\\', '/');
  const at = input.lastIndexOf('node_modules/');
  if (at < 0) return null;
  const parts = input.slice(at + 'node_modules/'.length).split('/');
  const depth = parts[0]?.startsWith('@') ? 2 : 1;
  return parts.length > depth ? input.slice(0, at) + 'node_modules/' + parts.slice(0, depth).join('/') : null;
}
/** purl-spec npm type: the scope is the namespace and its `@` is percent-encoded. */
export const npmPurl = (name, version) => `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;
const licenseChoice = expression => !expression ? [] : /[\s()]/u.test(expression) ? [{ expression }] : [{ license: { id: expression } }];
const sriHex = integrity => { const match = /^sha512-(.+)$/u.exec(integrity ?? ''); return match ? Buffer.from(match[1], 'base64').toString('hex') : null; };
const licenseOf = manifest => typeof manifest.license === 'string' ? manifest.license : typeof manifest.license?.type === 'string' ? manifest.license.type : null;

/** Shipped and tree-shaken third-party packages of one bundle. `root` is the bundler's working directory (metafile paths are relative to it). */
export function bundledPackages(root, metafile) {
  const bytes = new Map();
  for (const output of Object.values(metafile.outputs)) for (const [input, entry] of Object.entries(output.inputs ?? {})) {
    const path = input.replaceAll('\\', '/'); bytes.set(path, (bytes.get(path) ?? 0) + entry.bytesInOutput);
  }
  const lock = existsSync(join(root, 'package-lock.json')) ? readJson(join(root, 'package-lock.json')).packages ?? {} : {};
  const byDir = new Map();
  for (const rawInput of Object.keys(metafile.inputs)) {
    const input = rawInput.replaceAll('\\', '/');
    const dir = packageDirOf(input);
    if (!dir) continue;
    const row = byDir.get(dir) ?? { dir, bytesInOutput: 0, files: 0, shippedFiles: [] };
    const shipped = bytes.get(input) ?? 0;
    row.bytesInOutput += shipped; row.files += 1; if (shipped > 0) row.shippedFiles.push(input.slice(dir.length + 1));
    byDir.set(dir, row);
  }
  const shipped = [], treeShaken = [];
  for (const row of [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir))) {
    const manifest = readJson(join(root, row.dir, 'package.json'));
    const files = readdirSync(join(root, row.dir)).filter(name => LICENSE_FILE.test(name)).sort();
    const item = { name: manifest.name, version: manifest.version, license: licenseOf(manifest), dir: row.dir, bytesInOutput: row.bytesInOutput,
      integrity: lock[row.dir]?.integrity ?? null, licenseFiles: files, shippedFiles: row.shippedFiles.sort() };
    (row.bytesInOutput > 0 ? shipped : treeShaken).push(item);
  }
  return { shipped, treeShaken };
}

/** Embedded (vendored) components of every shipped package, scanned at its own installed directory and marked shipped only when an
 * embedding carrier file is in the bundle. Scan failures remain as { carrier, problem } rows, never as shipped components.
 * `licenses` maps `name@version` to an SPDX id (dependencies.json `embedded[].license`); unknown stays null and is reported. */
export function embeddedInBundle(root, shipped, licenses = new Map()) {
  const scanned = scanEmbedded(root, shipped.map(item => ({ name: item.name, dir: item.dir })));
  return scanned.flatMap((host, index) => {
    const carrier = shipped[index];
    const embedded = host.embedded.map(component => {
      const files = component.maps.map(map => map.replaceAll('\\', '/').replace(/\.map$/u, '')).filter(file => carrier.shippedFiles.includes(file));
      return { name: component.name, version: component.version, license: licenses.get(`${component.name}@${component.version}`) ?? null,
        carrier: `${carrier.name}@${carrier.version}`, shipped: files.length > 0, carrierFiles: files };
    });
    return host.problem ? [...embedded, { carrier: `${carrier.name}@${carrier.version}`, problem: host.problem }] : embedded;
  });
}

/** Deterministic urn:uuid (v5-shaped) from the SBOM content, so the same bundle always yields the same document. */
const contentUuid = text => { const hex = createHash('sha256').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };

/** Native executables the package ships itself (BWRAP-SELECT: bubblewrap, from its build lock): one application component per shipped
 * architecture's binary (generic purl with the corresponding source's download URL and checksum), the statically linked Alpine packages
 * nested under it. `path` is where the binary sits in the package. */
export function bundledNativeComponents(lock, path = arch => `dist/adapters/core/shell-sandbox-bwrap/bundled/linux-${arch}/bwrap`) {
  const distro = `alpine-${lock.buildImage.alpineRelease}`;
  return lock.shipArches.map(arch => {
    const nodeArch = lock.outputs[arch].nodeArch;
    const purl = `pkg:generic/${lock.component}@${lock.version}?download_url=${encodeURIComponent(lock.source.url)}&checksum=sha256:${lock.source.sha256}`;
    return { type: 'application', 'bom-ref': `${purl}#linux-${nodeArch}`, name: lock.component, version: lock.version, purl, licenses: licenseChoice(lock.license),
      hashes: [{ alg: 'SHA-256', content: lock.outputs[arch].sha256 }],
      externalReferences: [{ type: 'source-distribution', url: lock.source.url, hashes: [{ alg: 'SHA-256', content: lock.source.sha256 }] },
        { type: 'vcs', url: `https://github.com/containers/${lock.component}` }],
      properties: [{ name: 'deckent:bundle:path', value: path(nodeArch) }, { name: 'deckent:bundle:arch', value: `linux-${nodeArch}` },
        { name: 'deckent:bundle:minimumKernel', value: lock.minimumKernel }, { name: 'deckent:bundle:correspondingSource', value: `source/${lock.component}-${lock.version}.tar.xz` }],
      components: lock.linked.filter(part => part.apk).map(part => {
        const ref = `pkg:apk/alpine/${part.apk}@${part.version}?arch=${arch}&distro=${distro}`;
        return { type: 'library', 'bom-ref': `${ref}#${lock.component}-linux-${nodeArch}`, name: part.apk, version: part.version, purl: ref, licenses: licenseChoice(part.spdx),
          properties: [{ name: 'deckent:bundle:linkedInto', value: `${lock.component}@${lock.version}` }] };
      }) };
  });
}

/** CycloneDX 1.6 JSON. `pkg` is the staged package.json; `identity` the build identity; `tools` [{name, version}]. */
export function cyclonedx({ pkg, identity, tools, shipped, embedded, timestamp, native = [] }) {
  const rootRef = npmPurl(pkg.name, pkg.version);
  const component = (item, extra = []) => {
    const [group, name] = item.name.startsWith('@') ? item.name.split('/') : [undefined, item.name];
    const hash = sriHex(item.integrity);
    return { type: 'library', 'bom-ref': npmPurl(item.name, item.version), ...(group ? { group } : {}), name, version: item.version,
      purl: npmPurl(item.name, item.version), licenses: licenseChoice(item.license), ...(hash ? { hashes: [{ alg: 'SHA-512', content: hash }] } : {}),
      properties: [{ name: 'cdx:npm:package:bundled', value: 'true' }, ...extra] };
  };
  const components = shipped.map(item => {
    const inside = embedded.filter(entry => entry.shipped && entry.carrier === `${item.name}@${item.version}`);
    const row = component(item, [{ name: 'deckent:bundle:bytesInOutput', value: String(item.bytesInOutput) },
      ...(item.dir !== `node_modules/${item.name}` ? [{ name: 'deckent:bundle:installPath', value: item.dir }] : [])]);
    // One bom-ref per document: the same embedded name@version in two carriers gets a carrier-qualified ref.
    if (inside.length) row.components = inside.map(entry => ({ ...component({ ...entry, integrity: null }, [
      { name: 'deckent:embedded:carrier', value: entry.carrier }, { name: 'deckent:embedded:evidence', value: `sourcemap: ${entry.carrierFiles.join(', ')}` }]),
    'bom-ref': `${npmPurl(entry.name, entry.version)}?carrier=${encodeURIComponent(entry.carrier)}` }));
    return row;
  });
  const body = { metadata: { timestamp, tools: { components: tools.map(tool => ({ type: 'application', name: tool.name, version: tool.version })) },
    component: { type: 'application', 'bom-ref': rootRef, name: pkg.name, version: pkg.version, purl: rootRef, licenses: licenseChoice(pkg.license),
      properties: [{ name: 'deckent:build:sourceTreeSha256', value: identity.sourceTreeSha256 }, ...(identity.sourceCommit ? [{ name: 'deckent:build:sourceCommit', value: identity.sourceCommit }] : [])] } },
  components: [...components, ...native], dependencies: [{ ref: rootRef, dependsOn: [...components, ...native].map(item => item['bom-ref']) }] };
  const serialNumber = `urn:uuid:${contentUuid(JSON.stringify({ ...body, metadata: { ...body.metadata, timestamp: null } }))}`;
  return { bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber, version: 1, ...body };
}

/** THIRD-PARTY-NOTICES.md: every shipped package with its own license file text; embedded components with the license their carrier did not
 * ship as text. Returns { text, gaps, lockedUsed } — a gap is a shipped component whose license text is not available offline; `locked`
 * (lockedLicenseTexts().texts) supplies the upstream text for a component that has none, and lockedUsed names the entries that did. */
export function thirdPartyNotices(root, { pkg, shipped, embedded, declarations = [], native = [], locked = new Map() }) {
  const used = new Set();
  /** A component without its own text: the locked upstream text for exactly this name@version, else a gap. */
  const lockedOrGap = (item, gap) => {
    const entry = locked.get(`${item.name}@${item.version}`), mismatch = entry && entry.license !== item.license;
    if (!entry || mismatch) { gaps.push(mismatch ? `${gap}; the locked text is ${entry.license}, the package declares ${item.license ?? 'no license'}` : gap); sections.push('(No license file ships with this package.)', ''); return; }
    used.add(`${item.name}@${item.version}`); sections.push(provenance(entry), '', '```text', entry.text.trimEnd(), '```', '');
  };
  const gaps = [], sections = [`# Third-party notices for ${pkg.name} ${pkg.version}`, '',
    `This package bundles the third-party code listed below into its own files (no install-time dependencies). The machine-readable list is sbom.cdx.json.`, ''];
  for (const item of shipped) {
    sections.push(`## ${item.name}@${item.version}`, '', `License: ${item.license ?? 'not declared'}`, '');
    if (!item.licenseFiles.length) lockedOrGap(item, `${item.name}@${item.version}: no license file in the installed package`);
    for (const file of item.licenseFiles) sections.push('```text', readFileSync(join(root, item.dir, file), 'utf8').trimEnd(), '```', '');
  }
  const inside = embedded.filter(entry => entry.shipped);
  if (inside.length) {
    sections.push('## Components embedded inside bundled packages', '', 'These were bundled by their carrier package before Deckent bundled it; the carrier ships no license text for them.', '');
    for (const entry of inside) {
      sections.push(`- ${entry.name}@${entry.version} (in ${entry.carrier}): ${entry.license ?? 'license not recorded'}`);
      if (!entry.license || locked.get(`${entry.name}@${entry.version}`)?.license !== entry.license)
        gaps.push(`${entry.name}@${entry.version} (in ${entry.carrier}): license text not shipped by the carrier${entry.license ? '' : '; SPDX id not recorded in dependencies.json'}`);
    }
    sections.push('');
    // Locked upstream texts for embedded components, once per name@version whatever the number of carriers.
    for (const key of [...new Set(inside.filter(entry => entry.license && locked.get(`${entry.name}@${entry.version}`)?.license === entry.license).map(entry => `${entry.name}@${entry.version}`))]) {
      used.add(key); sections.push(`### ${key}`, '', provenance(locked.get(key), 'Its carriers ship no license text'), '', '```text', locked.get(key).text.trimEnd(), '```', '');
    }
  }
  // DEPS-TYPES: third-party type declarations copied into dist/vendor/types. A package whose code is also bundled has its license text above;
  // a declarations-only package gets its own section.
  if (declarations.length) {
    sections.push('## Type declarations vendored into dist/vendor/types', '',
      'The published type declarations include these packages\' declaration files (specifiers rewritten to relative paths, content unchanged otherwise).', '');
    for (const item of declarations) {
      const code = shipped.some(entry => entry.name === item.name && entry.version === item.version);
      sections.push(`- ${item.name}@${item.version}: ${item.license ?? 'not declared'}, ${item.files.length} declaration file(s)${code ? ' (license text above)' : ''}`);
    }
    sections.push('');
    for (const item of declarations.filter(entry => !shipped.some(code => code.name === entry.name && code.version === entry.version))) {
      sections.push(`## ${item.name}@${item.version} (type declarations only)`, '', `License: ${item.license ?? 'not declared'}`, '');
      if (!item.licenseFiles.length) lockedOrGap(item, `${item.name}@${item.version} (declarations): no license file in the installed package`);
      for (const file of item.licenseFiles) sections.push('```text', readFileSync(join(root, item.dir, file), 'utf8').trimEnd(), '```', '');
    }
  }
  // Separate programs shipped next to the code (BWRAP-SELECT): their notice (license, where the corresponding source is in the package,
  // linked components) as the build wrote it; the license texts ship beside them.
  for (const item of native) sections.push(`## ${item.name} ${item.version} (separate executable)`, '', '```text', item.notice.trimEnd(), '```', '',
    `Files: ${item.dir}/ (licenses/, source/).`, '');
  return { text: sections.join('\n'), gaps, lockedUsed: [...used].sort() };
}
