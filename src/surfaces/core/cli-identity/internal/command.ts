import { IDENTITY_PROFILE_LIMITS } from '#domain/index.js';
import type { IdentityProfileListing, IdentityProfilePreview } from '#engine/index.js';
import { ErrorRegistry, emit, resolveLocale, t, type ConfigLoadOptions } from '#platform/index.js';
import { readJsonInput, type CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { renderIdentityPreview, renderIdentityProfiles } from './render.js';
export interface IdentityCommandContext extends CliBaseContext {
  listIdentityProfiles?: (packages: readonly unknown[]) => IdentityProfileListing;
  previewIdentityProfile?: (root: string, input: unknown, packages: readonly unknown[], options: ConfigLoadOptions) => Promise<IdentityProfilePreview>;
}
export async function identityCommand(argv: readonly string[], context: IdentityCommandContext) {
  const env = context.env ?? process.env, values = new Map<string, string>(); let json = false;
  const usage = () => ErrorRegistry.createError('CLI_USAGE', { params: { usage: t('identity.help', {}, resolveLocale(undefined, env)) } });
  const action = argv[1]; if (action !== 'profiles' && action !== 'preview') throw usage();
  const allowed = action === 'profiles' ? ['--lang', '--registry'] : ['--lang', '--registry', '--profile', '--profile-version', '--scope', '--input'];
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--no-color') continue;
    if (!allowed.includes(flag) || values.has(flag)) throw usage();
    const value = argv[++index]; if (!value || value.startsWith('--')) throw usage(); values.set(flag, value);
  }
  const locale = resolveLocale(values.get('--lang'), env); context.onLocale?.(locale);
  const errors = { limit: 'IDENTITY_PREVIEW_LIMIT', invalid: 'IDENTITY_PREVIEW_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'IDENTITY_PREVIEW_UNAVAILABLE' };
  const read = (source: string) => readJsonInput(source, IDENTITY_PROFILE_LIMITS.maxInputBytes, errors, context.stdin);
  const registryPath = values.get('--registry');
  if (registryPath === '-' && values.get('--input') === '-') throw usage();
  const packages = registryPath ? await read(registryPath) : [];
  if (!Array.isArray(packages)) throw ErrorRegistry.createError('IDENTITY_PROFILE_INVALID');
  const sinks = { json, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (action === 'profiles') {
    if (!context.listIdentityProfiles) throw ErrorRegistry.createError('IDENTITY_PREVIEW_UNAVAILABLE');
    emit(context.listIdentityProfiles(packages), { ...sinks, render: result => renderIdentityProfiles(result, locale) }); return;
  }
  const id = values.get('--profile'), scopeId = values.get('--scope'), rawVersion = values.get('--profile-version') ?? '1';
  if (!scopeId || (!id && values.has('--profile-version')) || !/^[1-9][0-9]*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion))) throw usage();
  const source = values.get('--input'), body = source ? await read(source) : { members: [], organization: [], assignments: [], removeBindingIds: [] };
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['members', 'organization', 'assignments', 'removeBindingIds', 'projectScopeIds', 'includeFutureProjects'].includes(key))) {
    throw ErrorRegistry.createError('IDENTITY_PREVIEW_INVALID');
  }
  if (!context.previewIdentityProfile) throw ErrorRegistry.createError('IDENTITY_PREVIEW_UNAVAILABLE');
  const input = { ...body, schemaVersion: 1, ...(id ? { profile: { id, version: Number(rawVersion) } } : {}), scopeId };
  emit(await context.previewIdentityProfile(context.root ?? process.cwd(), input, packages, { env }), { ...sinks, render: result => renderIdentityPreview(result, locale) });
}
