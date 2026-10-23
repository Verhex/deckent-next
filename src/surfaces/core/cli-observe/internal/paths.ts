import { lstat } from 'node:fs/promises';
import { ErrorRegistry, inspectProductPaths, t, terminalSafeText, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { AdminPathsView } from '#surfaces/core/cli-admin/index.js';
import { cliTableStyle, renderCliTable, type CliTableStyle } from '#surfaces/core/cli-human/index.js';
import type { KernelCall } from './kernel.js';
import registry from './paths.json' with { type: 'json' };

/** The host operation `paths` uses beyond the layout: the real socket, MCP definition files and secret-store files (composition). */
export interface PathsCommandContext { readonly inspectAdminPaths?: (root: string, options: ConfigLoadOptions) => Promise<AdminPathsView>;
  readonly stdout?: unknown; readonly env?: NodeJS.ProcessEnv }
type Inspection = Awaited<ReturnType<typeof inspectProductPaths>>;
type Row = readonly [description: string, path: string, state: string];
const GROUPS = Object.keys(registry.groups) as (keyof typeof registry.groups)[];

const exists = async (path: string, locale: Locale) => await lstat(path).then(() => t('cli.paths.exists', {}, locale), () => t('cli.paths.missing', {}, locale));
const row = async (description: string, path: string, locale: Locale): Promise<Row> => [description, terminalSafeText(path), await exists(path, locale)];
const LISTED = new Set<string>(GROUPS.flatMap(group => registry.groups[group]));
const descriptions = (locale: Locale): Readonly<Record<string, string>> => ({
  config: t('cli.paths.resource.config', {}, locale),
  installationJournal: t('cli.paths.resource.installationJournal', {}, locale),
  policy: t('cli.paths.resource.policy', {}, locale),
  bindings: t('cli.paths.resource.bindings', {}, locale),
  ledger: t('cli.paths.resource.ledger', {}, locale),
  runs: t('cli.paths.resource.runs', {}, locale),
  tasks: t('cli.paths.resource.tasks', {}, locale),
  artifacts: t('cli.paths.resource.artifacts', {}, locale),
  workspaces: t('cli.paths.resource.workspaces', {}, locale),
  integrations: t('cli.paths.resource.integrations', {}, locale),
  brain: t('cli.paths.resource.brain', {}, locale),
  memory: t('cli.paths.resource.memory', {}, locale),
  fileEffects: t('cli.paths.resource.fileEffects', {}, locale),
  treeScanCache: t('cli.paths.resource.treeScanCache', {}, locale),
  scratch: t('cli.paths.resource.scratch', {}, locale),
  autonomyShadow: t('cli.paths.resource.autonomyShadow', {}, locale),
  memoryPurges: t('cli.paths.resource.memoryPurges', {}, locale),
  audit: t('cli.paths.resource.audit', {}, locale),
  approvals: t('cli.paths.resource.approvals', {}, locale),
  approvalPreviews: t('cli.paths.resource.approvalPreviews', {}, locale),
  instructionTrust: t('cli.paths.resource.instructionTrust', {}, locale),
  installationIdentity: t('cli.paths.resource.installationIdentity', {}, locale),
  projectIdentity: t('cli.paths.resource.projectIdentity', {}, locale),
  ledgerBackups: t('cli.paths.resource.ledgerBackups', {}, locale),
  runtimeSocket: t('cli.paths.resource.runtimeSocket', {}, locale),
  runtimeLog: t('cli.paths.resource.runtimeLog', {}, locale),
  locks: t('cli.paths.resource.locks', {}, locale),
  crashes: t('cli.paths.resource.crashes', {}, locale),
  terminalHistory: t('cli.paths.resource.terminalHistory', {}, locale),
  terminalSessions: t('cli.paths.resource.terminalSessions', {}, locale) });
/** A resource's description; a resource added to the layout later (not described here) keeps its own name. */
const describe = (resource: string, locale: Locale) => { const known = descriptions(locale); return Object.hasOwn(known, resource) ? known[resource]! : terminalSafeText(resource); };
const groupTitles = (locale: Locale): Readonly<Record<string, string>> => ({ configuration: t('cli.paths.group.configuration', {}, locale),
  records: t('cli.paths.group.records', {}, locale), security: t('cli.paths.group.security', {}, locale), runtime: t('cli.paths.group.runtime', {}, locale),
  terminal: t('cli.paths.group.terminal', {}, locale), other: t('cli.paths.group.other', {}, locale) });
const columns = (locale: Locale) => [t('cli.paths.column.what', {}, locale), t('cli.paths.column.path', {}, locale), t('cli.paths.column.state', {}, locale)]
  .map((header, index) => ({ header, ...(index === 1 ? {} : { shrink: false }) }));

/** Owner CLI review 2026-10-19 (`paths`): one table per group (configuration, records and data, security, runtime, terminal) with exists/missing. */
async function layoutSection(inspection: Inspection, locale: Locale, style: CliTableStyle, extras: AdminPathsView | null): Promise<string[]> {
  const resources = inspection.resources as Readonly<Record<string, string>>;
  const lines: string[] = [];
  for (const group of [...GROUPS, 'other' as const]) {
    const names = group === 'other' ? Object.keys(resources).filter(name => !LISTED.has(name)) : registry.groups[group].filter(name => resources[name]);
    const rows = await Promise.all(names.map(name => row(describe(name, locale), resources[name]!, locale)));
    if (group === 'configuration' && inspection.bootstrapConfigPath !== resources['config']) rows.unshift(await row(t('cli.paths.bootstrapConfig', {}, locale), inspection.bootstrapConfigPath, locale));
    if (group === 'runtime' && extras?.runtimeSocket) rows.splice(1, 0, await row(t('cli.paths.socketActual', {}, locale), extras.runtimeSocket, locale));
    if (!rows.length) continue;
    lines.push('', groupTitles(locale)[group]!, renderCliTable(columns(locale), rows, style));
  }
  lines.push('', extras?.runtimeSocket ? t('cli.paths.socketWhy', {}, locale) : t('cli.paths.socketUnknown', {}, locale));
  return lines;
}
/** This user's files outside the project: the global root, MCP definitions and the selected secret store's files. */
async function globalSection(global: Inspection | null, locale: Locale, style: CliTableStyle, extras: AdminPathsView | null): Promise<string[]> {
  const rows: Row[] = [];
  if (global) rows.push(await row(t('cli.paths.globalRoot', {}, locale), global.root, locale), await row(t('cli.paths.globalConfig', {}, locale), global.bootstrapConfigPath, locale));
  if (extras?.mcp) rows.push(await row(t('cli.paths.mcpProject', {}, locale), extras.mcp.project, locale), await row(t('cli.paths.mcpPersonal', {}, locale), extras.mcp.personal, locale));
  for (const file of extras?.secretStore.files ?? []) rows.push(await row(t('cli.paths.secretStore', {}, locale), file, locale));
  if (extras && !extras.secretStore.files.length) rows.push([t('cli.paths.secretStore', {}, locale), t('cli.paths.secretStoreNoFile', { store: terminalSafeText(extras.secretStore.store) }, locale), '—']);
  return rows.length ? ['', t('cli.paths.group.global', {}, locale), renderCliTable(columns(locale), rows, style)] : [];
}

/** `deckent paths [--global] [--json]`: the product paths this installation resolves, read-only. `--json` keeps the layout inspection contract. */
export async function pathsCommand(call: KernelCall, context: PathsCommandContext = {}): Promise<void> {
  const { args, root, options, output, locale } = call;
  if (args.dryRun || args.positionals.length !== 1) throw ErrorRegistry.createError('CLI_USAGE');
  const inspection = await inspectProductPaths(root, { ...options, globalOnly: args.global });
  if (args.json) { output(inspection, () => ''); return; }
  const extras = context.inspectAdminPaths ? await context.inspectAdminPaths(root, options).catch(() => null) : null;
  const global = args.global ? null : await inspectProductPaths(root, { ...options, globalOnly: true }).catch(() => null);
  const style = cliTableStyle(context);
  const title = { root: terminalSafeText(inspection.root) };
  const lines = [args.global ? t('cli.paths.titleGlobal', title, locale) : t('cli.paths.title', title, locale),
    ...await layoutSection(inspection, locale, style, args.global ? null : extras), ...await globalSection(global, locale, style, extras)];
  output(inspection, () => lines.join('\n'));
}
