import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { projectInputSchema } from '#engine/index.js';
import { hubOperationSchemas, parseHubOperation, hubOperationWrites, decodeHubBundle, type HubOperation, type HubOperationName } from '#engine/index.js';
import { ErrorRegistry, emit, loadConfig, t, getConfigKnownSecrets, type KnownSecretSnapshot, type ConfigLoadOptions, type ExitCode, type Locale, sha256 } from '#platform/index.js';
import type { ConfigCommandContext } from '#surfaces/core/config/index.js';
import { commandLocale, readJsonInput, type CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { projectApprovalDecisionText } from '#surfaces/core/approval-presentation/index.js';
import { plainText } from '#surfaces/core/terminal-render/index.js';
import { cliMode, askCliCard, resolveCommandScope, scopeLister } from '#surfaces/core/cli-human/index.js';


export interface HubCommandContext extends CliBaseContext, Pick<ConfigCommandContext, 'configChoiceSources'> {
  executeHub?: (root: string, request: HubOperation, options: ConfigLoadOptions, signal?: AbortSignal) => Promise<unknown>;
}
const shown = (text: string, known?: KnownSecretSnapshot) => plainText(projectApprovalDecisionText(text, known).spans);
export function hubCardLines(request: HubOperation, locale: Locale, known?: KnownSecretSnapshot): string[] {
  const input = { ...request.input } as Record<string, unknown>, lines: string[] = [t('hub.card.body', {}, locale)];
  const bundles = 'bundles' in input && Array.isArray(input.bundles) ? input.bundles.map(value => Buffer.from(String(value), 'base64'))
    : request.operation === 'hub.publish' && 'bundle' in request.input.input ? [Buffer.from(JSON.stringify(request.input.input.bundle))] : [];
  if (bundles.length) {
    delete input.bundles; delete input.input;
    for (const bytes of bundles) {
      const bundle = decodeHubBundle(bytes);
      lines.push(sha256(bytes), shown(JSON.stringify(bundle.manifest, null, 2), known), shown(JSON.stringify(bundle.envelope, null, 2), known));
      for (const file of bundle.files) lines.push(shown(file.path, known), shown(Buffer.from(file.bytes).toString('utf8'), known));
    }
  }
  lines.push(shown(JSON.stringify(input, null, 2), known));
  return lines.flatMap(line => line.split('\n'));
}
export function hubResultLines(result: unknown, locale: Locale): string[] {
  const cards = Array.isArray(result) ? result.flatMap(row => row && typeof row === 'object' && Array.isArray(row.cards) ? row.cards : []) : [];
  return [t('hub.output.untrusted', {}, locale), ...cards.map(card => shown(String(card.message))), shown(JSON.stringify(result, null, 2) ?? '')];
}
/** Strict CLI grammar; the operation schema supplies every input type. No secret, path or authority flag crosses the application boundary. */
export function parseHubArguments(argv: readonly string[]) {
  let position = 1, action = argv[position]?.startsWith('-') ? undefined : argv[position++];
  if (argv[0] !== 'hub') throw ErrorRegistry.createError('CLI_USAGE');
  if (action === 'sources') { action = `sources.${argv[position]?.startsWith('-') || !argv[position] ? 'list' : argv[position++]}`; }
  const operation = `hub.${action ?? 'sources.list'}`;
  if (!Object.hasOwn(hubOperationSchemas, operation)) throw ErrorRegistry.createError('CLI_USAGE');
  let input: string | undefined, scope: string | undefined, language: string | undefined;
  let json = false, schema = false, help = false;
  const seen = new Set<string>();
  for (; position < argv.length; position++) {
    const key = argv[position]!;
    if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(key);
    if (key === '--json') json = true;
    else if (key === '--schema') schema = true;
    else if (key === '--help' || key === '-h') help = true;
    else if (key === '--no-color') continue;
    else if (key === '--input' || key === '--scope' || key === '--lang') {
      const value = argv[++position]; if (!value || value.startsWith('-') && !(key === '--input' && value === '-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (key === '--input') input = value; else if (key === '--scope') scope = value; else language = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  return { operation: operation as HubOperationName, input, scope, language, json, schema, help };
}
export async function hubCommand(argv: readonly string[], context: HubCommandContext = {}): Promise<void | ExitCode> {
  const args = parseHubArguments(argv), locale = commandLocale(context, args.language), sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) }, writing = hubOperationWrites(args.operation);
  if (args.help) { emit(t('hub.help', {}, locale), sinks); return; }
  if (args.schema) { emit(projectInputSchema(hubOperationSchemas[args.operation]), { ...sinks, json: true }); return; }
  if (writing && cliMode(context, args.json).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: args.operation } });
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, config = await loadConfig(root, options);
  const raw = args.input ? await readJsonInput(args.input === '-' ? '-' : resolve(root, args.input), config.cli.invocationInputMaxBytes,
    { subject: 'cli.input.subject.hub', limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw ErrorRegistry.createError('CLI_USAGE');
  const value = raw as Record<string, unknown>, configured = (config.terminal as { scopeId?: string } | undefined)?.scopeId;
  const ask = (request: Parameters<typeof askCliCard>[0]) => askCliCard(request, { ...context, locale, signal: AbortSignal.any([AbortSignal.timeout(config.approvals.sessionTtlMs), ...(context.signal ? [context.signal] : [])]) });
  const scope = await resolveCommandScope({ command: 'deckent hub', locale, explicit: args.scope ?? (typeof value.scopeId === 'string' ? value.scopeId : undefined),
    configured, mutating: writing, interactive: cliMode(context, args.json).mode === 'interactive', listScopes: scopeLister(context, root, options), pick: ask });
  if (!scope) return 1;
  if (value.scopeId !== undefined && value.scopeId !== scope.scopeId) throw ErrorRegistry.createError('CLI_USAGE');
  const request = parseHubOperation({ operation: args.operation, input: { schemaVersion: 1, ...value, scopeId: scope.scopeId,
    ...(writing && value.commandId === undefined ? { commandId: randomUUID() } : {}) } });
  if (writing && await ask({ title: t('hub.card.title', { operation: args.operation }, locale),
    body: hubCardLines(request, locale, getConfigKnownSecrets(config)),
    options: [{ id: 'apply', key: 'y', label: t('hub.card.apply', {}, locale) }, { id: 'cancel', key: 'n', label: t('hub.card.cancel', {}, locale) }] }) !== 'apply') return 1;
  if (!context.executeHub) throw ErrorRegistry.createError('HUB_STORE_UNAVAILABLE');
  const result = await context.executeHub(root, request, options, context.signal);
  emit(args.json ? result : hubResultLines(result, locale).join('\n'), { ...sinks, json: args.json });
}
