import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { globalStateRoot, productResourcePath, resolveProductLayout, type ProductLayout, type ProductResource } from '#platform/index.js';
import { createGlobMatcher, DEFAULT_WORKSPACE_READ_DENY, REPOSITORY_INTERNALS_DENY, type WorkspaceScope } from '#adapters/core/workspace-read/index.js';
import { isDirectoryWriteApprovalFloored, isWriteApprovalFloored, writablePath } from '#adapters/core/workspace-write/index.js';
import type { SandboxWriteCell, ShellSandboxLayout } from '#adapters/core/host-shell/index.js';
import { MCP_PROJECT_REGISTRY_PATH } from '#adapters/core/mcp-client/index.js';

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
export function agentWorkspaceDeny(projectRoot: string, layout: ProductLayout, fullAccess = false): readonly string[] {
  // MODES-3: a full-access turn opens only the repository internals (`.git`: commit, branch, push); credentials and product state stay closed.
  const base = fullAccess ? DEFAULT_WORKSPACE_READ_DENY.filter(pattern => !REPOSITORY_INTERNALS_DENY.includes(pattern)) : DEFAULT_WORKSPACE_READ_DENY;
  // MCP-CLIENT: the project's MCP registry widens authority; the agent never reads or writes it (nor a writer's temporary beside it).
  return Object.freeze([...base, ...agentProductStateDeny(projectRoot, layout), `${MCP_PROJECT_REGISTRY_PATH}*`,
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
 * state root of the configuration and process environments, an existing conventional `~/.deckent` (never created). Credentials: the Core read
 * floor without repository internals. `product` (owner Y, 2026-09-30): registry resources under this and the default layout, the data root, the
 * bootstrap configuration, the MCP registry, the Core floor's `.deckent/` heads — any other existing subdirectory of a sealed root is the project's.
 */
export function agentShellHardFloor(projectRoot: string, layout: ProductLayout, environments: readonly Readonly<Record<string, string | undefined>>[]): NonNullable<ShellSandboxLayout['hardFloor']> {
  const bootstrap = dirname(layout.bootstrapConfigPath), rel = relative(bootstrap, projectRoot);
  const roots = [join(projectRoot, dirname(MCP_PROJECT_REGISTRY_PATH)), layout.root, ...(rel === '' || !rel.startsWith('..') && !isAbsolute(rel) ? [] : [bootstrap])];
  for (const environment of environments) {
    const resolved = globalStateRoot(environment), home = environment['HOME'], conventional = home ? globalStateRoot({ HOME: home }) : null;
    roots.push(...resolved ? [resolved] : [], ...conventional && conventional !== resolved && existsSync(conventional) ? [conventional] : []);
  }
  const credentials = DEFAULT_WORKSPACE_READ_DENY.filter(pattern => !REPOSITORY_INTERNALS_DENY.includes(pattern)).map(createGlobMatcher);
  const inProject = (path: string) => relative(projectRoot, path).split(sep).join('/'), resources = Object.keys(layout.resources) as ProductResource[];
  const products = [...[layout, resolveProductLayout({ projectRoot })].flatMap(each => resources.map(resource => inProject(productResourcePath(each, resource)))),
    inProject(layout.root), inProject(layout.bootstrapConfigPath), MCP_PROJECT_REGISTRY_PATH, ...DEFAULT_WORKSPACE_READ_DENY.filter(pattern => pattern.startsWith(`${dirname(MCP_PROJECT_REGISTRY_PATH)}/`)).map(pattern => pattern.split('/*')[0]!)];
  return Object.freeze({ roots: Object.freeze([...new Set(roots)]), homeDenied: (path: string) => credentials.some(match => match(path)), product: (path: string) =>
    products.some(product => product === path || product.startsWith(`${path}/`) || path.startsWith(`${product}/`)) });
}
/** Project-relative POSIX paths of the product's protected resources inside the project. */
function agentProductStatePaths(projectRoot: string, layout: ProductLayout): readonly string[] {
  return Object.freeze((Object.keys(layout.resources) as ProductResource[]).filter(resource => !AGENT_READABLE_PRODUCT_RESOURCES.includes(resource)).flatMap(resource => {
    const rel = relative(projectRoot, productResourcePath(layout, resource));
    return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? [] : [rel.split(sep).join('/')];
  }));
}
/** The deny patterns of the product's own state: each protected resource, anything under it, its sidecars and a writer's hidden temporary;
 * a shell command naming one of these is refused outright — no approval opens product management (owner F2, Astra 2162). */
export function agentProductStateDeny(projectRoot: string, layout: ProductLayout): readonly string[] {
  return Object.freeze(agentProductStatePaths(projectRoot, layout).flatMap(path => {
    const slash = path.lastIndexOf('/');
    return [`${path}*`, `${path}/**`, `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}*`];
  }));
}

/**
 * The edit path rules for one write-set path: a denied path (`writablePath`), the configuration file (`edit-authority`), the write floor
 * (`edit-floor`), else `edit`. A directory — one removed, or a new parent one (Astra 2182 R3: `src/package.json/` is the floor name,
 * whatever it holds) — is classified by its own name and as a tree (`dir/` denied, `dir/-` on the write floor): the rules for what it holds.
 */
export function classifySandboxWritePath(scope: WorkspaceScope, authority: (rel: string) => boolean, rel: string,
  kind: 'write' | 'delete' | 'rmdir' | 'mkdir'): SandboxWriteCell | 'denied' {
  const directory = kind === 'rmdir' || kind === 'mkdir', lexical = writablePath(scope, rel);
  if (!lexical.ok || lexical.rel !== rel || (directory && scope.denied(`${rel}/`))) return 'denied';
  return authority(rel) ? 'edit-authority' : (directory ? isDirectoryWriteApprovalFloored(rel) : isWriteApprovalFloored(rel)) ? 'edit-floor' : 'edit';
}
