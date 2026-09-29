import { execFile } from 'node:child_process';
import { access, constants, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';

/**
 * Why a server did not start inside its sandbox view (MCP-SANDBOX-PATHS, 2026-09-29): a path the server needs exists on this machine but the
 * view hides it (`path-hidden`: the command itself or an absolute-path argument, with the link target when it differs), or nothing is hidden
 * but the command is a package runner (downloads and caches under HOME: the view has no network and an empty HOME) or a container client
 * (its daemon socket is outside the view). A diagnosis explains a failure; it never changes the outcome (no fallback to the host).
 */
export type McpSandboxDiagnosis = { readonly kind: 'path-hidden'; readonly role: 'command' | 'argument'; readonly index: number; readonly path: string;
  readonly target?: string } | { readonly kind: 'package-runner' | 'container-daemon'; readonly runner: string };
export type McpStartDiagnosis = { readonly kind: 'sandbox'; readonly diagnosis: McpSandboxDiagnosis } | { readonly kind: 'not-found' };

/** Commands that fetch the server at start (npm/pnpm/bun/uv/pipx runners) and container clients: a hint only, named by the command's own name. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'pipx']);
const CONTAINER_CLIENTS: ReadonlySet<string> = new Set(['docker', 'podman', 'nerdctl']);
/** Bounds of the probe: absolute-path arguments looked at, its deadline and output. */
export const MCP_DIAGNOSE_PATHS_MAX = 16;
const PROBE_TIMEOUT_MS = 5_000;
/** Prints (NUL-separated) every argument that does not exist in the view; runs only our own `/bin/sh` and `test`, never server code. */
const PROBE_SCRIPT = 'for p do [ -e "$p" ] || printf "%s\\0" "$p"; done';

const exists = async (path: string) => { try { await stat(path); return true; } catch { return false; } };
/** The command as execvp finds it for the server: a path (relative to the server's cwd) or the first executable file on the server's PATH. */
async function resolveCommand(command: string, pathVariable: string | undefined, cwd: string): Promise<string | null> {
  if (command.includes('/')) { const path = resolve(cwd, command); return await exists(path) ? path : null; }
  for (const dir of (pathVariable ?? '').split(':').slice(0, 256)) {
    if (!isAbsolute(dir)) continue;
    const candidate = resolve(dir, command);
    try { if ((await stat(candidate)).isFile()) { await access(candidate, constants.X_OK); return candidate; } } catch { /* next */ }
  }
  return null;
}
/** The candidates the view does not show, asked of the same view the server started in (`launcher prefix -- /bin/sh …`): null when the probe fails. */
function hiddenInView(launcher: { readonly file: string; readonly prefix: readonly string[] }, paths: readonly string[], cwd: string): Promise<ReadonlySet<string> | null> {
  return new Promise(done => {
    execFile(launcher.file, [...launcher.prefix, '--', '/bin/sh', '-c', PROBE_SCRIPT, 'sh', ...paths],
      { cwd, env: { PATH: '/usr/bin:/bin' }, timeout: PROBE_TIMEOUT_MS, maxBuffer: 65_536, encoding: 'utf8' },
      (error, stdout) => done(error ? null : new Set(stdout.split('\0').filter(Boolean))));
  });
}

/**
 * The diagnosis of a sandboxed start that failed: the command is resolved on this machine (not found → `not-found`); it and every
 * absolute-path argument that exists here are probed in the same view; the first one the view hides is named. Without a hidden path, a
 * package runner or container client is named. Otherwise null (the SDK's own reason stays). Decided by the view itself, never by the
 * server's stderr (untrusted output).
 */
export async function diagnoseSandboxedStart(launcher: { readonly file: string; readonly prefix: readonly string[] },
  server: { readonly command: string; readonly args: readonly string[]; readonly pathVariable: string | undefined; readonly cwd: string }): Promise<McpStartDiagnosis | null> {
  const command = await resolveCommand(server.command, server.pathVariable, server.cwd);
  if (!command) return { kind: 'not-found' };
  const candidates: { readonly role: 'command' | 'argument'; readonly index: number; readonly path: string }[] = [{ role: 'command', index: -1, path: command }];
  for (const [index, arg] of server.args.entries()) {
    if (candidates.length > MCP_DIAGNOSE_PATHS_MAX) break;
    if (isAbsolute(arg) && await exists(arg)) candidates.push({ role: 'argument', index, path: arg });
  }
  const hidden = await hiddenInView(launcher, candidates.map(candidate => candidate.path), server.cwd);
  const first = hidden && candidates.find(candidate => hidden.has(candidate.path));
  if (first) {
    const target = await realpath(first.path).catch(() => first.path);
    return { kind: 'sandbox', diagnosis: { kind: 'path-hidden', ...first, ...(target !== first.path ? { target } : {}) } };
  }
  const name = basename(server.command);
  if (PACKAGE_RUNNERS.has(name)) return { kind: 'sandbox', diagnosis: { kind: 'package-runner', runner: name } };
  if (CONTAINER_CLIENTS.has(name)) return { kind: 'sandbox', diagnosis: { kind: 'container-daemon', runner: name } };
  return null;
}

/**
 * A diagnosis as the owner may see it: a path that came from a `${VAR}` in the registry template is shown as that template (never an
 * expanded value — the cards' rule), without its link target.
 */
export function displayMcpDiagnosis(diagnosis: McpSandboxDiagnosis, template: { readonly command: string; readonly args?: readonly string[] | undefined }): McpSandboxDiagnosis {
  if (diagnosis.kind !== 'path-hidden') return diagnosis;
  const written = diagnosis.role === 'command' ? template.command : template.args?.[diagnosis.index];
  if (written === undefined || !written.includes('${')) return diagnosis;
  return { kind: 'path-hidden', role: diagnosis.role, index: diagnosis.index, path: written };
}
