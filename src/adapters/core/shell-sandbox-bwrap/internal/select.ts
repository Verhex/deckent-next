import type { ShellRealmMode } from '#domain/index.js';
import { boundSandboxReason, landlockShellSandbox, nativeShellKernelProbe, probeShellCapabilities, resolveShellRealm, shellLaunchSandboxes, type ShellCapabilities, type ShellRealmResolution,
  type ShellSandbox, type ShellSandboxLayout } from '#adapters/core/host-shell/index.js';
import { selectBubblewrapLauncher } from './launcher.js';
import { bubblewrapShellSandbox } from './realm.js';

/** The shipped sandbox providers in preference order (S9, S11): bubblewrap, then Landlock. The service's default port, the MCP `inspect`
 * starts and doctor all take this one list. */
export const shippedShellSandboxes = (layout: ShellSandboxLayout): readonly ShellSandbox[] => [bubblewrapShellSandbox(layout), landlockShellSandbox(layout)];

/** One resolution as doctor reports it: the realm that runs (`null` = refused, `code` says why) and every provider passed over, and why. */
export interface ShellRealmSelectionView {
  readonly selected: 'bubblewrap' | 'landlock' | 'host' | null;
  readonly marker: string | null;
  readonly notice: string | null;
  readonly code: string | null;
  readonly rejected: readonly { readonly kind: string; readonly reason: string; readonly restricted: boolean }[];
}
/**
 * REALM-NOTICE (doctor): what a shell call in this project gets under the configured realm mode, from the same stateDir, providers and
 * resolver the service uses — so a probe that says `available` while the provider refuses (a launcher inside the project) is visible.
 * `preferSandbox` (host mode only): whether an MCP server in the registry default realm (`sandbox-net` since K4: a sandbox or no start) gets a sandbox from `McpClientPool.open` —
 * the same launch-eligible walk the pool's own launch uses (`shellLaunchSandboxes`, Astra 2188 R8), so a provider usable for one shell
 * command but not a long-lived launch (Landlock: it runs one command at a time) is never reported as the MCP default here while the
 * real open runs on the host. `bubblewrap`/`landlock` below remain the plain host measurement. The measurement is read-only (`place:
 * false`: a bundled copy the service has not placed yet is reported, not written) and taken now in this process — a service that
 * measured earlier keeps its own until it restarts.
 */
export interface ShellRealmReport extends ShellRealmSelectionView {
  readonly schemaVersion: 1;
  readonly mode: ShellRealmMode;
  readonly stateDir: string | null;
  readonly preferSandbox: ShellRealmSelectionView | null;
  readonly bubblewrap: { readonly status: string; readonly launcher: { readonly source: string; readonly path: string; readonly version: string; readonly overlay: boolean } | null;
    readonly rejected: readonly { readonly path: string; readonly reason: string }[]; readonly detail: string | null };
  readonly landlock: ShellCapabilities['landlock'];
}

const viewOf = (resolution: ShellRealmResolution): ShellRealmSelectionView => ({
  selected: resolution.ok ? resolution.realm.kind : null, marker: resolution.ok ? resolution.marker : null, notice: resolution.ok ? resolution.notice : null,
  code: resolution.ok ? null : resolution.code,
  rejected: (resolution.rejected ?? []).map(item => ({ kind: item.kind, reason: boundSandboxReason(item.reason), restricted: item.restricted === true })) });

export async function inspectShellRealmSelection(input: { readonly mode: ShellRealmMode; readonly stateDir: string | null; readonly project: ShellSandboxLayout['project'];
  readonly capabilities?: ShellCapabilities; readonly sandboxes?: readonly ShellSandbox[] }): Promise<ShellRealmReport> {
  const capabilities = input.capabilities ?? await probeShellCapabilities({ platform: process.platform, kernel: nativeShellKernelProbe,
    bubblewrap: signal => selectBubblewrapLauncher({ stateDir: input.stateDir, place: false }, signal) });
  // The layout a turn gives its shell (no conversation scratch area yet: a doctor run has none) with the fail-closed write floor.
  const sandboxes = input.sandboxes ?? shippedShellSandboxes({ project: input.project, scratchDir: null, writeFloor: () => true });
  const { status, launcher, rejected, detail } = capabilities.bubblewrap;
  return { schemaVersion: 1, mode: input.mode, stateDir: input.stateDir, ...viewOf(resolveShellRealm(input.mode, capabilities, sandboxes)),
    // K4: the MCP default is `sandbox-net` — a launch-eligible sandbox or no start (never a host fallback); the field keeps its name (doctor's JSON).
    preferSandbox: input.mode === 'host' ? viewOf(resolveShellRealm('require-sandbox', capabilities, shellLaunchSandboxes(sandboxes))) : null,
    bubblewrap: { status, launcher: launcher && { source: launcher.source, path: launcher.path, version: launcher.version, overlay: launcher.overlay },
      rejected: rejected.map(item => ({ path: item.path, reason: boundSandboxReason(item.reason) })), detail: detail && boundSandboxReason(detail) },
    landlock: capabilities.landlock };
}
