import { existsSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { globalStateRoot, PRODUCT_LAYOUT_REGISTRY, productResourcePath, resolveProductLayout, type ProductLayout, type ProductResource } from '#platform/index.js';
import { createGlobMatcher, createWorkspaceScope, CREDENTIAL_WORKSPACE_DENY, DEFAULT_WORKSPACE_READ_DENY, type WorkspaceScope } from '#adapters/core/workspace-read/index.js';
import { isDirectoryWriteApprovalFloored, isWriteApprovalFloored, isSelfSourceWriteFloored, writablePath } from '#adapters/core/workspace-write/index.js';
import type { SandboxWriteCell, ShellSandboxLayout } from '#adapters/core/host-shell/index.js';
import { MCP_PROJECT_REGISTRY_PATH } from '#adapters/core/mcp-client/index.js';
import { inspectShellRealmSelection, shippedShellSandboxes, type ShellRealmReport } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { DECK_FILE } from '#engine/index.js';
import { agentTurnWriteFloor, isSelfSourceProject } from './self-source.js';

/**
 * The only product resources the agent tools may read (TERM-FEEDBACK-1): the installation's configuration, which the model is told
 * about and which names credentials only by reference (the keys live under `approvals`). Every other resource of the layout is
 * product state or authority (ledger and its sidecars, backups, saved conversations and history, logs, the runtime socket, approvals
 * and their key, previews, audit, policy and bindings, runs, workspaces, scratch, ...) and is never opened to the agent tools; a
 * resource added to the registry is protected until it is listed here.
 */
export const AGENT_READABLE_PRODUCT_RESOURCES: readonly ProductResource[] = Object.freeze(['config']);
/**
 * The Core read floor plus every product resource of this layout inside the project except the readable ones (TL-C D4,
 * TERM-FEEDBACK-1): the resource, anything under it, its sidecars (`ledger.db-wal`, `terminal-history.jsonl.<pid>.tmp`) and a
 * writer's hidden temporary beside it (`.policy.json.<id>.tmp`). The floor names them under the default `.deckent`; a data root
 * moved inside the project (e.g. `.deckent/live-data`) would otherwise leave them readable. The same scope classifies edit and
 * shell paths and feeds both shell sandboxes' deny views, and the composer's `@file` picker uses it too.
 */
export function agentWorkspaceDeny(projectRoot: string, layout: ProductLayout, fullAccess = false, env?: Environment): readonly string[] {
  // MODES-3: a full-access turn opens only the repository internals (`.git`: commit, branch, push); credentials and product state stay closed.
  const base = fullAccess ? CREDENTIAL_WORKSPACE_DENY : DEFAULT_WORKSPACE_READ_DENY;
  // MCP-CLIENT: the project's MCP registry widens authority; the agent never reads or writes it (nor a writer's temporary beside it).
  // PRE-8 v2 (law audit MAJOR 2): `.deck` steers which vault a key is read from; humans edit it, the agent never reads or writes it (full access
  // included). It holds no value, so it stays out of the worker-tree secret gate (a committed `.deck` never refuses a worker).
  return Object.freeze([...base, ...agentProductStateDeny(projectRoot, layout, env), DECK_FILE.fileName, `${DECK_FILE.fileName}.*`, `${MCP_PROJECT_REGISTRY_PATH}*`,
    MCP_PROJECT_REGISTRY_PATH.replace(/[^/]+$/u, name => `.${name}*`)]);
}
/** MODES-3 `edit-authority`: the installation's configuration file inside the project (it decides where policy, bindings and approvals live, the
 * realm and the network), its sidecars and a writer's temporary — never written without the owner's card, full access included. */
export function agentAuthorityPaths(projectRoot: string, layout: ProductLayout): (rel: string) => boolean {
  const rel = relative(projectRoot, productResourcePath(layout, 'config')).split(sep).join('/'), slash = rel.lastIndexOf('/');
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return () => false;
  const matchers = [`${rel}*`, `${rel.slice(0, slash + 1)}.${rel.slice(slash + 1)}*`].map(createGlobMatcher);
  return path => matchers.some(match => match(path));
}
/**
 * OPEN-SANDBOX (owner MODES-3 checkpoint 4): the hard floor of a full-access turn's open shell view (`ShellSandboxLayout.hardFloor`). Roots: the
 * project's `.deckent` (MCP registry's directory), the data root, the bootstrap configuration's directory unless it holds the project, the global
 * state root of the configuration and process environments, the conventional `~/.deckent` (sealed even before it exists, P5a). Credentials: the Core read
 * floor without repository internals. `product` (owner Y, 2026-09-30): registry resources under this and the default layout, the data root, the
 * bootstrap configuration, the MCP registry, the Core floor's `.deckent/` heads — any other existing subdirectory of a sealed root is the project's.
 */
export function agentShellHardFloor(projectRoot: string, layout: ProductLayout, environments: readonly Readonly<Record<string, string | undefined>>[]): NonNullable<ShellSandboxLayout['hardFloor']> {
  const bootstrap = dirname(layout.bootstrapConfigPath), rel = relative(bootstrap, projectRoot);
  const globals = agentGlobalStateRoots(environments);
  const roots = [join(projectRoot, dirname(MCP_PROJECT_REGISTRY_PATH)), layout.root, ...(rel === '' || !rel.startsWith('..') && !isAbsolute(rel) ? [] : [bootstrap]), ...globals];
  const credentials = CREDENTIAL_WORKSPACE_DENY.map(createGlobMatcher);
  const inProject = (path: string) => relative(projectRoot, path).split(sep).join('/'), resources = Object.keys(layout.resources) as ProductResource[];
  // P5a: a global state root's own registry resources (the CLI compile cache, `state/…`) are product paths too when that root lies in the project.
  const layouts = [layout, resolveProductLayout({ projectRoot }), ...globals.map(globalLayout)];
  const products = [...layouts.flatMap(each => resources.map(resource => inProject(productResourcePath(each, resource)))),
    inProject(layout.root), inProject(layout.bootstrapConfigPath), MCP_PROJECT_REGISTRY_PATH, ...DEFAULT_WORKSPACE_READ_DENY.filter(pattern => pattern.startsWith(`${dirname(MCP_PROJECT_REGISTRY_PATH)}/`)).map(pattern => pattern.split('/*')[0]!)];
  return Object.freeze({ roots: Object.freeze([...new Set(roots)]), homeDenied: (path: string) => credentials.some(match => match(path)), product: (path: string) =>
    products.some(product => product === path || product.startsWith(`${path}/`) || path.startsWith(`${product}/`)) });
}
/**
 * Astra 2486 P1: a write set keeps a sealed in-project root (`.deckent`) inside the overlay, so its entries are refused here unless they lie in
 * the owner-Y exception — the root's `docs` subtree (creatable) or another EXISTING non-product, non-link subdirectory; the root's own names
 * and product paths never reach the host from a write set.
 */
export function sealedRootEntryRefused(projectRoot: string, hardFloor: ReturnType<typeof agentShellHardFloor>): (rel: string) => boolean {
  const inside = hardFloor.roots.map(root => relative(projectRoot, root).split(sep).join('/')).filter(rel => rel !== '' && !rel.startsWith('..') && !isAbsolute(rel));
  return rel => inside.some(root => {
    if (rel !== root && !rel.startsWith(`${root}/`)) return false;
    const child = rel.slice(root.length + 1).split('/')[0] ?? '', dir = `${root}/${child}`;
    if (root === '.deckent' && child === 'docs') return false;
    if (!child || rel === dir || hardFloor.product?.(dir)) return true;
    try { const info = lstatSync(join(projectRoot, dir)); return !info.isDirectory(); } catch { return true; }
  });
}
type Environment = Readonly<Record<string, string | undefined>>;
/** The global state roots of the configuration and process environments: each one's resolved root and the conventional `~/.deckent`, which is
 * protected even before it exists (P5a, lead 2026-10-31: nothing can be planted for a later default-root CLI). One derivation for the shell hard
 * floor and the edit/read deny lists. */
function agentGlobalStateRoots(environments: readonly Environment[]): string[] {
  return [...new Set(environments.flatMap(environment => {
    const resolved = globalStateRoot(environment), home = environment['HOME'], conventional = home ? globalStateRoot({ HOME: home }) : null;
    return [...resolved ? [resolved] : [], ...conventional && conventional !== resolved ? [conventional] : []];
  }))];
}
const globalLayout = (root: string) => resolveProductLayout({ projectRoot: root, root, bootstrapConfigPath: join(root, PRODUCT_LAYOUT_REGISTRY.resources.config) });
/** Project-relative POSIX paths of the product's protected resources inside the project. */
function agentProductStatePaths(projectRoot: string, layout: ProductLayout): readonly string[] {
  return Object.freeze((Object.keys(layout.resources) as ProductResource[]).filter(resource => !AGENT_READABLE_PRODUCT_RESOURCES.includes(resource)).flatMap(resource => {
    const rel = relative(projectRoot, productResourcePath(layout, resource));
    return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? [] : [rel.split(sep).join('/')];
  }));
}
/** The deny patterns of the product's own state: each protected resource, anything under it, its sidecars and a writer's hidden temporary;
 * a shell command naming one of these is refused outright — no approval opens product management (owner F2, Astra 2162). P5a: the same for
 * every global state root inside the project (`env` and this process's environment, as the shell hard floor), e.g. its compile cache. */
export function agentProductStateDeny(projectRoot: string, layout: ProductLayout, env: Environment = process.env): readonly string[] {
  const paths = [layout, ...agentGlobalStateRoots([env, process.env]).map(globalLayout)].flatMap(each => agentProductStatePaths(projectRoot, each));
  return Object.freeze([...new Set(paths)].flatMap(path => {
    const slash = path.lastIndexOf('/');
    return [`${path}*`, `${path}/**`, `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}*`];
  }));
}

/**
 * The edit path rules for one write-set path: a denied path (`writablePath`), the configuration file (`edit-authority`), the write floor
 * (`edit-floor`), the additional self-source floor (`edit-self-source`), else `edit`. A directory — one removed, or a new parent one (Astra 2182 R3: `src/package.json/` is the floor name,
 * whatever it holds) — is classified by its own name and as a tree (`dir/` denied, `dir/-` on the write floor): the rules for what it holds.
 */
export function classifySandboxWritePath(scope: WorkspaceScope, authority: (rel: string) => boolean, rel: string,
  kind: 'write' | 'delete' | 'rmdir' | 'mkdir', selfSource = false): SandboxWriteCell | 'denied' {
  const directory = kind === 'rmdir' || kind === 'mkdir', lexical = writablePath(scope, rel);
  if (!lexical.ok || lexical.rel !== rel || (directory && scope.denied(`${rel}/`))) return 'denied';
  return authority(rel) ? 'edit-authority' : (directory ? isDirectoryWriteApprovalFloored(rel) : isWriteApprovalFloored(rel)) ? 'edit-floor' : selfSource && (isSelfSourceWriteFloored(rel) || directory && isSelfSourceWriteFloored(`${rel}/-`)) ? 'edit-self-source' : 'edit';
}

/** The configured data root as a project-relative POSIX path, or undefined when it is the project or lies outside it (`ShellSandboxLayout.dataRoot`). */
export function agentDataRootRel(projectRoot: string, layout: ProductLayout): string | undefined {
  const rel = relative(projectRoot, layout.root);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? undefined : rel.split(sep).join('/');
}
/** SANDBOX-SPAWN (2026-10-18): a turn's shell sandbox layout — one derivation for the turn and doctor's self-test, so doctor runs the view a call gets. */
export function agentShellSandboxLayout(projectRoot: string, layout: ProductLayout, scope: WorkspaceScope, writeFloor: (rel: string) => boolean, fullAccess: boolean, scratchDir: string | null,
  env: Readonly<Record<string, string | undefined>>): ShellSandboxLayout & { readonly hardFloor: NonNullable<ShellSandboxLayout['hardFloor']> } {
  const dataRoot = agentDataRootRel(projectRoot, layout);
  return { project: scope, scratchDir, writeFloor, ...(dataRoot ? { dataRoot } : {}), ...(fullAccess ? { repositoryWritable: true } : {}), hardFloor: agentShellHardFloor(projectRoot, layout, [env, process.env]) };
}
/** Doctor's realm report and sandbox self-test with a standart turn's own layout (no scratch area); the test runs only once every state root exists (the view creates missing ones; doctor writes nothing). */
export async function inspectAgentShellRealm(input: { readonly mode: ShellRealmReport['mode']; readonly stateDir: string | null; readonly projectRoot: string; readonly layout: ProductLayout;
  readonly env: Readonly<Record<string, string | undefined>> }): Promise<ShellRealmReport> {
  const { projectRoot, layout, env } = input, scope = await createWorkspaceScope(projectRoot, agentWorkspaceDeny(projectRoot, layout, false, env));
  const writeFloor = agentTurnWriteFloor(agentAuthorityPaths(projectRoot, layout), false, await isSelfSourceProject(projectRoot));
  const sandbox = agentShellSandboxLayout(projectRoot, layout, scope, writeFloor, false, null, env);
  return inspectShellRealmSelection({ mode: input.mode, stateDir: input.stateDir, project: scope, sandboxes: shippedShellSandboxes(sandbox), ...(sandbox.hardFloor.roots.every(root => existsSync(root)) ? { selfTest: { environment: env } } : {}) });
}
