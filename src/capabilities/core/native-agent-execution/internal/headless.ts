import { z } from 'zod';
import { persistedInteger, promptFramingAllowanceSchema } from '#domain/index.js';
import { text as argument, positive, envName, flag, args } from './schema-parts.js';
const argumentsSchema = z.array(argument).readonly();
const names = z.array(envName).readonly(), words = z.array(argument).readonly();
const loginEntry = z.string().regex(/^[A-Za-z0-9._-]+$/).refine(value => value !== '.' && value !== '..');
/** Proxy variables are read in both spellings (`HTTPS_PROXY`, `https_proxy`). */
const proxyNames = z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).readonly();
/** S3 headless model step (HEADLESS-0, 2026-10-23): one tool-less, MCP-less turn of the unmodified CLI. Argv, environment, guard expectations and
 * bounds are data; a forbidden flag (fallback model, bare mode, permission bypass, extra config) can never be part of the argv. */
/** How the CLI's own login status is read: `json` fields on stdout (allowlisted), or `status`: the exit code plus one exact line of its output. */
const authSchema = z.union([z.strictObject({ authMethods: words, apiProviders: words, configDirectoryMatch: z.boolean() }).readonly(),
  z.strictObject({ kind: z.literal('status'), stream: z.enum(['stdout', 'stderr']), loggedIn: z.array(z.strictObject({ line: argument, authMethod: argument }).readonly()).min(1).readonly(),
    source: argument }).readonly()]);
/** Line guards by event stream: Claude's init/result fields, or Codex's allowed item types and error-text patterns (quota patterns stay in providers.json). */
const guardsSchema = z.union([z.strictObject({ apiKeySources: words, permissionMode: argument, plugins: z.array(z.strictObject({ name: argument, path: argument }).readonly()).readonly(),
  lengthStopReasons: words, loginErrors: words, creditsErrors: words, loginStatuses: z.array(positive).readonly(), quotaStatuses: z.array(positive).readonly() }).readonly(),
  // `reconnectPatterns`: the CLI's own counted stream-retry notices (error lines), tolerated up to `maxReconnects` per call.
  z.strictObject({ allowedItems: words, loginPatterns: words, errorAllow: z.strictObject({ maxBytes: positive, rules: z.array(z.strictObject({ pattern: argument, errorClass: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u) }).readonly()).readonly(), source: argument }).readonly(), noticePatterns: words, maxNotices: positive, noticeSource: argument, reconnectPatterns: words, maxReconnects: positive, reconnectSource: argument, source: argument }).readonly()]);
export const nativeCliHeadlessSchema = z.strictObject({ schemaVersion: z.literal(1), revision: argument, source: argument,
  /** The profile's protocol family when it is not the event-stream name (a catalog family named before the headless step existed). */
  protocolFamily: argument.optional(),
  args, maxTurns: positive,
  /** `stream`: the CLI has no turn flag; one turn is enforced by the line guard (the call refuses a second turn). Absent: the capability's flag. */
  turnBound: z.literal('stream').optional(),
  /** S3-3 connect: the bounded PATH search for the executable; s3c (owner 2026-10-24): the default login dir is the Brain's own (layout data, not here).
   * `login`: the CLI's own sign-in the person runs in their terminal (argv, SSO switch, bound, inherited and fixed names; never a deny name). */
  connect: z.strictObject({ configDirSource: argument, pathSearchDirectories: positive, pathSearchTimeoutMs: positive,
    maxInFlight: positive, maxInFlightSource: argument }).readonly(), login: z.strictObject({ args: argumentsSchema, ssoFlag: flag.nullable(), timeoutMs: positive,
    env: z.strictObject({ inherit: names, fixed: z.record(envName, z.string().refine(value => !value.includes('\0'))).readonly() }).readonly(),
    source: argument }).readonly(), systemPromptFlag: flag, systemPromptFile: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  /** The prompt-file argv when it is not `<systemPromptFlag> <file>` (`{file}` = the run dir's prompt file; the flag stays the one help must list). */
  systemPromptArgs: argumentsSchema.refine(value => value.some(arg => arg.includes('{file}'))).optional(),
  forbiddenFlags: z.array(flag).min(1).readonly(), promptFramingAllowance: promptFramingAllowanceSchema,
  /** Astra 2875/2878 R1: the only stderr lines (whole, trimmed) an incomplete turn's summary may keep, each stored as its fixed `keep` text with the
   * pattern's named captures (`$<name>`) only; every other line is withheld and counted. */
  stderrAllow: z.strictObject({ rules: z.array(z.strictObject({ pattern: argument, keep: argument }).readonly()).readonly(), source: argument }).readonly(),
  /** `hiddenFlags`: options the CLI accepts but its help does not list, each proven by the parser refusing a bad value (every fragment must appear);
   * `max-turns-capability` = the capability's own hidden-help probe (one source). Every other required flag must be listed by help. */
  preflight: z.strictObject({ versionArgs: argumentsSchema, versionPattern: argument, helpArgs: argumentsSchema, authStatusArgs: argumentsSchema, hiddenFlagsSource: argument,
    hiddenFlags: z.array(z.strictObject({ flag, probe: z.union([z.literal('max-turns-capability'), z.strictObject({ args: argumentsSchema, refusal: z.array(argument).min(1).readonly() }).readonly()]) }).readonly()).max(8).readonly() }).readonly(),
  auth: authSchema,
  env: z.strictObject({ fixed: z.record(envName, z.string().refine(value => !value.includes('\0'))).readonly(), runDir: names,
    configDir: envName, deny: names.refine(value => value.length > 0) }).readonly(),
  guards: guardsSchema,
  /** `stderrSummaryBytes`: the redacted stderr tail kept when the CLI ends before a complete turn (an unknown outcome's evidence, inside the profile's response bound). */
  limits: z.strictObject({ stdinMaxBytes: positive, maxLineBytes: positive, stderrMaxBytes: positive, stderrSummaryBytes: positive, preflightTimeoutMs: positive, preflightOutputBytes: positive,
    killGraceMs: positive, responseFramingBytes: positive }).readonly(),
  /** S3-5: the realm every spawn runs in (bubblewrap): the POSIX shell that sets the process limits, the gateway socket's path inside the realm,
   * the in-realm proxy the CLI is pointed at, the login-dir entries the CLI keeps seeing (every other existing one is masked) and the bounds. */
  isolation: z.strictObject({ source: argument, shell: z.string().startsWith('/'), socketPath: z.string().regex(/^\/run\/[a-z][a-z0-9.-]*\.sock$/),
    proxy: z.strictObject({ host: z.literal('127.0.0.1'), port: persistedInteger().min(1024).max(65535), env: proxyNames.refine(value => value.length > 0), clear: proxyNames }).readonly(),
    configVisible: z.array(loginEntry).readonly(), configVisibleSource: argument,
    /** Existing non-credential state opened read/write by the CLI: bind a bounded private copy, never the host file. */
    configEphemeral: z.strictObject({ files: z.array(loginEntry).min(1).readonly(), maxBytes: positive }).readonly().optional(),
    configMaxEntries: positive,
    /** f5: the CLI's own refresh-lock names in the login dir (a subset of `configVisible`) and Deckent's per-login-dir serialization bounds. */
    refreshLock: z.strictObject({ names: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).readonly(), waitMs: positive, pollMs: positive, staleMs: positive, source: argument }).readonly(),
    limits: z.strictObject({ tmpfsBytes: positive, fileSizeBlocks: positive, fileSizeBlocksSource: argument, openFiles: positive,
      /** f5: per-process CPU (soft; hard = soft + grace) and data bounds, the realm's task bound, set by `limiter` (absolute, util-linux prlimit) inside the
       * realm; the relay samples every `sampleMs` and names a bound that stopped the CLI by its reserved exit code (`attributionPermille` of a bound). */
      // `attributionPermille` is a share of a bound (at most the whole of it); the exit codes are distinct.
      cpuSeconds: positive, cpuGraceSeconds: positive, processes: positive, dataBytes: positive, sampleMs: positive, attributionPermille: positive,
      exits: z.strictObject({ 'cpu-time': positive, processes: positive, memory: positive }).refine(value => new Set(Object.values(value)).size === Object.keys(value).length).readonly(),
      boundsSource: argument, limiter: z.string().startsWith('/'), limiterSource: argument }).readonly() }).readonly(),
}).refine(value => {
  const built = [...Object.keys(value.env.fixed), ...value.env.runDir, value.env.configDir, ...value.isolation.proxy.env, ...value.isolation.proxy.clear];
  const login = [...value.login.env.inherit, ...Object.keys(value.login.env.fixed), value.env.configDir];
  return new Set(built).size === built.length && !built.some(name => value.env.deny.includes(name)) && value.isolation.refreshLock.names.every(name => value.isolation.configVisible.includes(name))
    && (value.isolation.configEphemeral?.files.every(name => value.isolation.configVisible.includes(name) && !value.isolation.refreshLock.names.includes(name)
      && !['auth.json', '.credentials.json', '.claude.json'].includes(name)) ?? true)
    && new Set(login).size === login.length && !login.some(name => value.env.deny.includes(name))
    && !value.args.some(arg => value.forbiddenFlags.some(forbidden => arg === forbidden || arg.startsWith(forbidden + '=')));
}).readonly();
export type NativeCliHeadless = z.infer<typeof nativeCliHeadlessSchema>;
