// dependencies: the external-dependency registry (dependencies.json, DEPS-GOV 2026-09-29) and its offline lint-arch gate.
// dependencies.json is the single source of truth for which arch unit (or whole package, `src/<pkg>`) may import which npm package;
// arch.json only points at it. Checks: the versioned schema; registry keys = package.json dependencies ∪ devDependencies with the
// matching kind; owners exist (units/packages for runtime and platform entries, repository paths for dev tooling); review intervals;
// every bare import in src (static, export-from, import(), typeof import(), createRequire()()) is a runtime dependency owned by the
// importing unit; no stale owner; embedded (bundled) components match the installed sourcemaps. A past nextReview only warns.
import ts from 'typescript';
import { z } from 'zod';
import { builtinModules } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanEmbedded } from './check-embedded-deps.mjs';

const DAY = 86_400_000;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'invalid calendar date');
const text = z.string().trim().min(1);
const alternative = z.object({ name: text, package: text.optional(), version: text.optional(), date: date.optional(), note: text }).strict()
  .refine(value => !value.version === !value.date, 'alternative version and date go together');
const reviewed = { purpose: text, owners: z.array(text).min(1), criticality: z.enum(['P0', 'P1', 'P2']), alternatives: z.array(alternative),
  ownSolution: text, watch: z.array(text).optional(), lastReview: date, nextReview: date };
const dependencySchema = z.object({ kind: z.enum(['runtime', 'dev']), reviewedVersion: text, features: z.array(text).min(1),
  embedded: z.array(z.object({ name: text, version: text.nullable(), license: text.optional() }).strict()).optional(), ...reviewed }).strict();
/** A native component the package ships itself (BWRAP-SELECT: bubblewrap), identified by its build lock; advisories come from the upstream
 * repository's GitHub security advisories (OSV has no ecosystem for it). */
const bundledSchema = z.object({ version: text, lock: text, license: text, minimumSystemVersion: text.optional(), shipArches: z.array(text).min(1),
  advisories: z.object({ source: z.literal('github-security-advisories'), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/u) }).strict() }).strict();
const platformSchema = z.object({ requirement: text, bundled: bundledSchema.optional(), ...reviewed }).strict();
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
/** A known, mitigated advisory set on one package@version in named carriers (`tree` or `<registry dependency>@<version>` that embeds it).
 * `shipped: false` narrows it to the installed (dev/test) tree: deps-watch --sbom stops accepting it once the package SBOM ships the component. */
const riskSchema = z.object({ id: text, package: text, version: text, carriers: z.array(text).min(1), shipped: z.literal(false).optional(), advisories: z.array(text).min(1),
  severity: z.enum(SEVERITIES), mitigation: text, evidence: z.array(text).min(1, 'an accepted risk needs at least one evidence reference'),
  decidedBy: text, decided: date, expires: date }).strict();
/** Longest acceptance window by the accepted severity (owner/lead 2026-09-29: HIGH/CRITICAL at most 30 days). */
export const RISK_WINDOW_DAYS = { LOW: 90, MEDIUM: 90, HIGH: 30, CRITICAL: 30 };
const registrySchema = z.object({ $comment: z.string().optional(), schemaVersion: z.literal(2),
  policy: z.object({ reviewIntervalDays: z.object({ P0: z.number().int().positive(), P1: z.number().int().positive(), P2: z.number().int().positive() }).strict(),
    licenses: z.object({ runtime: z.array(text).min(1), dev: z.array(text).min(1) }).strict(), failSeverities: z.array(z.enum(SEVERITIES)).min(1) }).strict(),
  dependencies: z.record(z.string(), z.unknown()), platform: z.record(z.string(), z.unknown()), acceptedRisks: z.array(z.unknown()) }).strict();

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export const packageName = spec => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
const issues = (error, prefix) => error.issues.map(issue => `${[prefix, ...issue.path].filter(part => part !== '').join('.')}: ${issue.message}`);

/** Parses dependencies.json; entries that fail their own schema are reported and left out, so the other checks still run. */
export function loadRegistry(root, registryFile) {
  if (typeof registryFile !== 'string' || !registryFile) return { registry: null, errors: ['arch.json dependencies.registry must name the registry file'] };
  const file = join(root, registryFile);
  if (!existsSync(file)) return { registry: null, errors: [`${registryFile} is missing (declare every package.json dependency there)`] };
  let raw; try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { return { registry: null, errors: [`invalid JSON: ${error.message}`] }; }
  const top = registrySchema.safeParse(raw);
  if (!top.success) return { registry: null, errors: issues(top.error, '') };
  const errors = [], section = (name, schema) => Object.fromEntries(Object.entries(top.data[name]).flatMap(([key, value]) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return [[key, parsed.data]];
    errors.push(...issues(parsed.error, `${name}.${key}`)); return [];
  }));
  const acceptedRisks = top.data.acceptedRisks.flatMap((value, index) => {
    const parsed = riskSchema.safeParse(value);
    if (parsed.success) return [parsed.data];
    errors.push(...issues(parsed.error, `acceptedRisks.${index}`)); return [];
  });
  return { registry: { ...top.data, dependencies: section('dependencies', dependencySchema), platform: section('platform', platformSchema), acceptedRisks }, errors };
}

/** Owner ids a src file answers to: its unit and its package (a file directly under src/<pkg>/ answers only to the package). */
export function ownerIds(relPath) {
  const parts = relPath.split('/');
  if (parts[0] !== 'src' || parts.length < 3) return [];
  return parts.length >= 5 ? [parts.slice(0, 4).join('/'), `src/${parts[1]}`] : [`src/${parts[1]}`];
}

/** Whether the registry lets the file import the package (runtime kind and an owner covering the file). */
export const ownsImport = (registry, relPath, name) => {
  const entry = registry?.dependencies[name];
  return entry?.kind === 'runtime' && ownerIds(relPath).some(id => entry.owners.includes(id));
};

/** Every module specifier in one source file, including type positions, dynamic import and createRequire; non-literal loads are flagged. */
function specifiers(sourceFile) {
  const out = [];
  const line = node => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const add = (node, argument) => out.push(argument && ts.isStringLiteralLike(argument) ? { spec: argument.text, line: line(node) } : { spec: null, line: line(node) });
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node, node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node, node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require'
      || ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'createRequire')) add(node, node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** The offline gate. `fail(rule, file, message)` / `warn(rule, file, message)` come from lint-arch; `known` holds arch.json unit and package ids. */
export function lintDependencies({ root, registryFile: REGISTRY_FILE, registry, errors, srcFiles, rel, known, fail, warn, today }) {
  for (const error of errors) fail('dependency-registry', REGISTRY_FILE, error);
  if (!registry) return;
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const sections = { runtime: manifest.dependencies ?? {}, dev: manifest.devDependencies ?? {} };
  for (const [kind, declared] of Object.entries(sections)) for (const name of Object.keys(declared)) {
    if (!registry.dependencies[name] && !errors.some(error => error.startsWith(`dependencies.${name}.`) || error.startsWith(`dependencies.${name}:`))) {
      fail('dependency-registry', 'package.json', `${name} is declared in package.json but missing from ${REGISTRY_FILE}`);
    } else if (registry.dependencies[name] && registry.dependencies[name].kind !== kind) {
      fail('dependency-registry', REGISTRY_FILE, `${name} is kind "${registry.dependencies[name].kind}" but package.json declares it in ${kind === 'dev' ? 'devDependencies' : 'dependencies'}`);
    }
  }
  const reviewDays = (entry, label) => {
    const days = (Date.parse(entry.nextReview) - Date.parse(entry.lastReview)) / DAY, limit = registry.policy.reviewIntervalDays[entry.criticality];
    if (days <= 0) fail('dependency-registry', REGISTRY_FILE, `${label} nextReview ${entry.nextReview} is not after lastReview ${entry.lastReview}`);
    else if (days > limit) fail('dependency-registry', REGISTRY_FILE, `${label} review interval ${days} days exceeds the ${entry.criticality} limit of ${limit}`);
    if (entry.nextReview < today) warn('dependency-review', REGISTRY_FILE, `${label} review is overdue (nextReview ${entry.nextReview})`);
  };
  const unitOwners = (entry, label) => { for (const owner of entry.owners) if (!known.has(owner)) fail('dependency-registry', REGISTRY_FILE, `${label} owner ${owner} is not an arch.json unit or package`); };
  for (const [name, entry] of Object.entries(registry.dependencies)) {
    if (!Object.hasOwn(sections[entry.kind], name) && !Object.hasOwn(sections[entry.kind === 'dev' ? 'runtime' : 'dev'], name)) {
      fail('dependency-registry', REGISTRY_FILE, `${name} is registered but package.json does not declare it`);
    }
    if (entry.kind === 'runtime') unitOwners(entry, name);
    else for (const owner of entry.owners) if (!existsSync(join(root, owner))) fail('dependency-registry', REGISTRY_FILE, `${name} owner ${owner} does not exist`);
    if (new Set(entry.owners).size !== entry.owners.length) fail('dependency-registry', REGISTRY_FILE, `${name} lists an owner twice`);
    reviewDays(entry, name);
  }
  for (const [id, entry] of Object.entries(registry.platform)) {
    unitOwners(entry, `platform ${id}`); reviewDays(entry, `platform ${id}`);
    // The registry names what the lock builds and ships; a drift between them is a packaging error, not a review note.
    if (!entry.bundled) continue;
    const lockFile = join(root, entry.bundled.lock);
    let lock; try { lock = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { fail('dependency-registry', REGISTRY_FILE, `platform ${id} bundled lock ${entry.bundled.lock} is not readable JSON`); continue; }
    for (const key of ['version', 'license']) if (lock[key] !== entry.bundled[key]) fail('dependency-registry', REGISTRY_FILE, `platform ${id} bundled ${key} ${entry.bundled[key]} is not the lock's ${lock[key]}`);
    if (JSON.stringify(lock.shipArches) !== JSON.stringify(entry.bundled.shipArches)) fail('dependency-registry', REGISTRY_FILE, `platform ${id} bundled shipArches ${entry.bundled.shipArches} are not the lock's ${lock.shipArches}`);
  }
  const riskIds = new Set();
  for (const risk of registry.acceptedRisks) {
    const label = `accepted risk ${risk.id}`, days = (Date.parse(risk.expires) - Date.parse(risk.decided)) / DAY;
    if (riskIds.has(risk.id)) fail('dependency-registry', REGISTRY_FILE, `${label} is declared twice`);
    riskIds.add(risk.id);
    if (new Set(risk.advisories).size !== risk.advisories.length) fail('dependency-registry', REGISTRY_FILE, `${label} lists an advisory twice`);
    for (const carrier of risk.carriers) {
      const host = carrier === 'tree' ? null : carrier.slice(0, carrier.lastIndexOf('@'));
      if (carrier !== 'tree' && (!host || registry.dependencies[host]?.kind !== 'runtime' || !(registry.dependencies[host].embedded ?? [])
        .some(component => component.name === risk.package && component.version === risk.version))) {
        fail('dependency-registry', REGISTRY_FILE, `${label} carrier ${carrier} is neither "tree" nor a runtime dependency that embeds ${risk.package}@${risk.version}`);
      }
    }
    if (days <= 0) fail('dependency-registry', REGISTRY_FILE, `${label} expires ${risk.expires}, not after its decision ${risk.decided}`);
    else if (days > RISK_WINDOW_DAYS[risk.severity]) fail('dependency-registry', REGISTRY_FILE, `${label} window ${days} days exceeds ${RISK_WINDOW_DAYS[risk.severity]} for ${risk.severity}`);
    if (risk.expires < today) warn('accepted-risk', REGISTRY_FILE, `${label} expired ${risk.expires}; deps-watch fails on its advisories again`);
  }

  const used = new Map();
  for (const file of srcFiles) {
    const path = rel(file);
    const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const { spec, line } of specifiers(sourceFile)) {
      const at = `${path}:${line}`;
      if (spec === null) { fail('external-dynamic', at, 'module loads need a string literal specifier so the dependency gate can see them'); continue; }
      if (spec.startsWith('.') || spec.startsWith('#') || spec.startsWith('node:')) continue;
      const name = packageName(spec);
      if (builtinModules.includes(name)) { fail('external-builtin', at, `${spec}: import Node built-ins with the node: prefix`); continue; }
      const entry = registry.dependencies[name];
      if (Object.hasOwn(sections.dev, name) && !Object.hasOwn(sections.runtime, name)) { fail('external-dev-only', at, `${name} is a devDependency; customer installs do not carry it`); continue; }
      if (!Object.hasOwn(sections.runtime, name) || entry?.kind !== 'runtime') { fail('external-undeclared', at, `${name} must be a package.json dependency with a runtime ${REGISTRY_FILE} entry`); continue; }
      const owner = ownerIds(path).find(id => entry.owners.includes(id));
      if (!owner) { fail('external-owner', at, `${name} may only be imported by [${entry.owners.join(', ')}]`); continue; }
      if (!used.has(name)) used.set(name, new Set());
      for (const id of ownerIds(path)) used.get(name).add(id);
    }
  }
  for (const [name, entry] of Object.entries(registry.dependencies)) {
    if (entry.kind !== 'runtime') continue;
    for (const owner of entry.owners) if (known.has(owner) && !used.get(name)?.has(owner)) fail('external-stale-owner', REGISTRY_FILE, `${name} owner ${owner} no longer imports it`);
    const [scan] = scanEmbedded(root, [name]);
    if (scan.installed === null) continue;
    const key = component => `${component.name}@${component.version ?? '?'}`;
    const live = new Set(scan.embedded.map(key)), declared = new Set((entry.embedded ?? []).map(key));
    for (const component of live) if (!declared.has(component)) fail('external-embedded', REGISTRY_FILE, `${name} embeds undeclared ${component} (bundled code npm audit cannot see; review it and list it)`);
    for (const component of declared) if (!live.has(component)) fail('external-embedded', REGISTRY_FILE, `${name} declares ${component} but the installed sourcemaps no longer embed it`);
  }
}
