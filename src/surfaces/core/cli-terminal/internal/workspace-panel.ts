import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { ConfigCommandContext } from '#surfaces/core/config/index.js';
import type { WorkspacePanelPort } from '#surfaces/core/terminal-panels/index.js';
import type { TerminalLaunchContext } from './context.js';

const terminalConfigWrite = async (...args: Parameters<typeof import('#surfaces/core/config/index.js').terminalConfigWrite>) =>
  (await import('#surfaces/core/config/index.js')).terminalConfigWrite(...args);
type Host = Required<Pick<TerminalLaunchContext, 'openProviderWorkspaces'>> & Pick<ConfigCommandContext, 'configApplication' | 'resolveConfigPrincipal' | 'describeRuntimeService'>;

export function workspacePanelPort(root: string, scopeId: string, host: Host, options: ConfigLoadOptions, locale: Locale): WorkspacePanelPort {
  let session: Awaited<ReturnType<Host['openProviderWorkspaces']>> | null = null;
  return {
    async inspect() {
      session = await host.openProviderWorkspaces(root, scopeId, options);
      return session.profiles.map(profile => ({ id: profile.id, label: profile.reference.modelId, detail: profile.workspaceId ?? t('tui.workspace.unselected', {}, locale) }));
    },
    async list(id) { if (!session) throw new Error(t('tui.workspace.changed', {}, locale)); return session.list(id); },
    async apply(id, workspaceId) {
      if (!session) throw new Error(t('tui.workspace.changed', {}, locale));
      const plan = await session.plan(id, workspaceId);
      if (plan.shared.length) throw new Error(t('tui.workspace.shared', {}, locale));
      const lines: string[] = [];
      for (const write of plan.writes) {
        const result = await terminalConfigWrite(root, { action: 'set', keyPath: 'provider_invocation_profiles', layer: write.layer, value: write.value, expect: write.expect }, host, options, locale);
        lines.push(...result.lines);
        if (result.status === 'approval-pending') return { ...result, lines };
      }
      return { status: 'applied', lines: [t('tui.workspace.applied', { id: workspaceId }, locale), ...lines], approvalId: null };
    },
  };
}
